"""
BMW VPS (Vehicle Provisioning Service) client
==============================================

Provides :class:`VpsClient` for interacting with VPS.

Usage::

    from bmw_tools.vps import VpsClient

    client = VpsClient(environment="int")
    client.login(username="q123456", password="pin", strong_auth=True)
    data = client.get_vehicle_data_for_vin("WBA...")
"""

import base64
import datetime
import json
import logging
import threading
from dataclasses import dataclass
from typing import Callable, Iterator, Optional, Set, Union

import requests

from bmw_sso import bmw_sso_session
from bmw_tools.models import Ecu, PU

log = logging.getLogger("bmw_tools.vps")


@dataclass
class VehicleData:
    ecu: Ecu
    hw_pu: Optional[PU]
    sw_pu: PU
    sw_version: str
    vin: str
    last_provisioned: Optional[datetime.datetime]

    @classmethod
    def from_vps_dict(cls, d: dict) -> "VehicleData":
        mappings = [("swPu", "swPU"), ("hwPu", "hwPU"), ("ecuName", "ecu")]
        if "last_provisioned" not in d:
            d["last_provisioned"] = None
        for k1, k2 in mappings:
            if k1 in d:
                d[k2] = d[k1]
        return VehicleData(
            ecu=Ecu.from_string(d["ecu"]),
            hw_pu=PU.from_string(d["hwPU"]) if d["hwPU"] else None,
            sw_pu=PU.from_string(d["swPU"]),
            sw_version=d["swVersion"],
            vin=d["vin"],
            last_provisioned=d["last_provisioned"],
        )


class VpsClient:
    """Authenticated client for the BMW Vehicle Provisioning Service."""

    SP21_ECUs = {"MGU_02_A"}
    EES25_ECUs = {"IDCEVO25-ANDROID"}

    def __init__(self, environment: str = "int", hub: str = "emea"):
        assert environment.lower() in ["int", "prod"], "Only int and prod are valid environments"
        assert hub.lower() in ["emea", "us", "cn"], "Only emea, us, cn are valid hubs"

        self.base_url = f"https://vps-{hub.lower()}-{environment.replace('int', 'e2e')}.bmwgroup.net"
        self.session = requests.Session()
        self._login_lock = threading.Lock()

    # --- Authentication ---

    def login(
        self,
        username: str,
        password: str,
        strong_auth: bool = True,
        strong_auth_type: str = "mobile",
        trigger_login_flow: bool = True,
        yubikey_provider: Union[Callable, Iterator, int, str, None] = None,
    ):
        """Login via BMW SSO. VPS requires strong authentication."""
        with self._login_lock:
            self._username = username
            self._password = password
            self._strong_auth = strong_auth
            self._strong_auth_type = strong_auth_type
            self._yubikey_provider = yubikey_provider
            if trigger_login_flow:
                try:
                    log.info("Logging in to %s as %s (strong_auth=%s, type=%s)",
                             self.base_url, username, strong_auth, strong_auth_type)
                    self.session = bmw_sso_session(
                        self._url("vps-admin/home"), username, password,
                        strong_auth, strong_auth_type, yubi_key_provider=yubikey_provider,
                    )
                    self.session.post(self._url("vps-admin/vpsproxy/authentication"), verify=False)
                    self._get_credentials()
                    log.info("Login successful")
                except Exception as e:
                    log.error("Login failed: %s", e, exc_info=True)
                    raise

    def _re_login(self):
        with self._login_lock:
            if not hasattr(self, "_username"):
                raise RuntimeError("Cannot re-login — call login() first")
            try:
                log.info("Re-logging in to %s", self.base_url)
                self.session = bmw_sso_session(
                    self._url("vps-admin/home"), self._username, self._password,
                    self._strong_auth, self._strong_auth_type,
                    yubi_key_provider=self._yubikey_provider,
                )
                self.session.post(self._url("vps-admin/vpsproxy/authentication"), verify=False)
                self._get_credentials()
                log.info("Re-login successful")
            except Exception as e:
                log.error("Re-login failed: %s", e, exc_info=True)
                raise

    def _get_credentials(self):
        resp = self.session.post(
            self._url("vps-admin/vpsproxy/authentication/getCredentials"),
            json={"withCredentials": True}, verify=False, allow_redirects=False,
        )
        if resp.status_code == 200:
            self._token = resp.json()["token"]
            self.session.headers.update({"Authorization": f"Bearer {self._token}"})
        return resp

    # --- HTTP helpers ---

    def _url(self, endpoint: str) -> str:
        if endpoint.startswith("/"):
            endpoint = endpoint[1:]
        return f"{self.base_url}/{endpoint}"

    def _get(self, endpoint: str) -> requests.Response:
        url = self._url(endpoint)
        resp = self.session.get(url, verify=False)
        if "auth.bmwgroup.net" in resp.url or resp.status_code in [403, 401]:
            self._re_login()
            resp = self.session.get(url, verify=False)
        return resp

    def _post(self, endpoint: str, json_data: dict) -> requests.Response:
        url = self._url(endpoint)
        resp = self.session.post(url, json=json_data, verify=False)
        if "auth.bmwgroup.net" in resp.url or resp.status_code in [403, 401]:
            self._re_login()
            resp = self.session.post(url, json=json_data, verify=False)
        return resp

    # --- API methods ---

    def get_vehicle_data_for_vin(self, vin: str, ecu: str = "MGU_02_A") -> Optional[VehicleData]:
        if ecu in self.SP21_ECUs:
            return self._get_vehicle_data_joynr(vin, ecu)
        else:
            return self._get_vehicle_data_mcp(vin, ecu)

    def _get_vehicle_data_mcp(self, vin: str, ecu: str = "IDCEVO25-ANDROID") -> Optional[VehicleData]:
        payload = {
            "startRow": 0, "endRow": 1,
            "rowGroupCols": [], "valueCols": [], "pivotCols": [],
            "pivotMode": False, "groupKeys": [],
            "filterModel": {
                "vin": {"filterType": "text", "type": "equals", "filter": vin.upper()},
                "ecuName": {"filterType": "text", "type": "equals", "filter": ecu},
                "latestEcuStatus": {"filterType": "text", "type": "equals", "filter": "PROVISIONED"},
            },
            "sortModel": [{"sort": "desc", "colId": "latestTimestamp"}],
        }

        resp = self._post("vps-admin/vpsproxy/vps-history/sessions", payload)
        if resp.status_code != 200:
            return None
        session_list = resp.json()["rowData"]
        if not session_list:
            return None

        resp = self._get(f"vps-admin/vpsproxy/vps-history/sessions/{session_list[0]['vehicleSessionId']}/vehicledata")
        if resp.status_code != 200:
            return None
        vehicle_data = resp.json()

        ecu_data = [d for d in vehicle_data["ecuInfos"] if d["ecuName"] == ecu]
        if not ecu_data:
            return None
        ecu_data = ecu_data[0]
        ecu_data["vin"] = vin.upper()

        try:
            ecu_data["last_provisioned"] = datetime.datetime.strptime(
                session_list[0]["createTimestamp"].split(".")[0], "%Y-%m-%dT%H:%M:%S"
            )
        except (KeyError, ValueError):
            pass

        return VehicleData.from_vps_dict(ecu_data)

    def _get_vehicle_data_joynr(self, vin: str, ecu: str = "MGU_02_A") -> Optional[VehicleData]:
        encoded_vin = base64.b64encode(vin.upper().encode()).decode()
        url = (
            f"vps-admin/vpsproxy/vps-archive/monitoringProvisioning"
            f"?pageNo=1&searchString={encoded_vin}&sortField=lastUpdateDate&sortOrder=-1&paramString="
        )
        resp = self._get(url)
        if resp.status_code != 200:
            return None
        workflows = resp.json()["workflowList"]
        workflows = [
            wf for wf in workflows
            if "svdsEcu" in wf and wf["svdsEcu"] == ecu and wf["provisioningStatus"] == "PROVISIONED"
        ]
        if not workflows:
            return None

        session_id = workflows[0]["sessionId"]
        resp = self.session.get(self._url(f"vps-admin/vpsproxy/vps-archive/workflowVehicleData/{session_id}"), verify=False)
        vps_data = resp.json()

        try:
            vps_data["last_provisioned"] = datetime.datetime.strptime(
                workflows[0]["createDate"].split(".")[0], "%Y-%m-%dT%H:%M:%S"
            )
        except (KeyError, ValueError):
            pass

        return VehicleData.from_vps_dict(vps_data)

    def get_all_ecus(self, vin: str) -> Set[str]:
        """Get all SVDS ECUs associated with a VIN (SP21/Joynr only)."""
        ecus: Set[str] = set()
        encoded_vin = base64.b64encode(vin.upper().encode()).decode()
        url = (
            f"vps-admin/vpsproxy/vps-archive/monitoringProvisioning"
            f"?pageNo=1&searchString={encoded_vin}&sortField=lastUpdateDate&sortOrder=-1&paramString="
        )
        resp = self._get(url)
        if resp.status_code != 200:
            return ecus
        for wf in resp.json()["workflowList"]:
            if "svdsEcu" in wf:
                ecus.add(wf["svdsEcu"])
        return ecus
