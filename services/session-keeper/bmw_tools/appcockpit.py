"""
BMW Appcockpit client
=====================

Provides :class:`AppcockpitClient` for interacting with the BMW Appcockpit (App Store).

Usage::

    from bmw_tools.appcockpit import AppcockpitClient

    client = AppcockpitClient()
    client.login(username="q123456", password="pin", strong_auth=True)
    apps = client.get_app_list()
"""

import json
import logging
import re
import time
import urllib.parse
from dataclasses import dataclass
from functools import cache, cached_property
from typing import Callable, Dict, Iterator, List, Union

import requests

from bmw_sso import bmw_sso_session
from bmw_tools.models import BackendConfig, BackendEnvironment, Ecu, PU

log = logging.getLogger("bmw_tools.appcockpit")

BASE_URL = "https://appcockpit.bmwgroup.net"

_SMALL_PAYLOAD_THRESHOLD = 500


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

_last_wipe = time.time()
_cached_functions_to_wipe: list = []


def _wipe_caches(timeout: int = 120):
    global _last_wipe
    if time.time() - _last_wipe < timeout:
        return
    _last_wipe = time.time()
    for f in _cached_functions_to_wipe:
        f.cache_clear()


def _wipeable_cache(user_function):
    global _cached_functions_to_wipe
    cached_user_function = cache(user_function)
    _cached_functions_to_wipe.append(cached_user_function)

    def wrapped_function(*args, **kwargs):
        wipe_cache = kwargs.pop("wipe_cache", False)
        if wipe_cache:
            cached_user_function.cache_clear()
        return cached_user_function(*args, **kwargs)

    return wrapped_function


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class TestFleet:
    name: str
    description: str
    id: str
    vins: list

    @classmethod
    def from_json(cls, j: str) -> "TestFleet":
        return cls.from_dict(json.loads(j))

    @classmethod
    def from_dict(cls, d: dict) -> "TestFleet":
        return TestFleet(
            name=d["name"],
            description=d["description"],
            id=d["_id"],
            vins=d["vins"],
        )


@dataclass
class RolloutConfig:
    channel: str
    vin_whitelist: str
    hwds: List[Ecu]
    max_pu: PU
    min_pu: PU
    # Target environment/repository, lowercased: "int", "prod", or "prod_test".
    # A "prod" config with a non-empty vin_whitelist represents the PROD_TEST stage
    # (offered only to whitelisted VINs); a "prod" config with no vin_whitelist is a
    # full PROD release available to all vehicles.
    environment: str
    # State of this individual rollout config, lowercased:
    #   pending  — Config created for release-circle staging, not yet active.
    #              (stage_to_release_circle sends state "PENDING".)
    #   released — Config is live for its environment/channel.
    #              (publish and prod-test send state "RELEASED"; is_prod_release and
    #              get_stable_release require state == "released".)
    # This is distinct from AppstoreVersion.state (the version's lifecycle stage). A
    # version can be in the "rollout_prod" lifecycle stage while its full-PROD config is
    # already "released" — the two describe different things.
    state: str

    @property
    def is_prod_test(self) -> bool:
        # A released prod/stable config restricted to whitelisted VINs is the PROD_TEST
        # stage (inverse of the full-PROD predicate, which requires an empty whitelist).
        return (
            self.environment == "prod"
            and self.channel == "stable"
            and self.state == "released"
            and bool(self.vin_whitelist)
        )

    @classmethod
    def from_dict(cls, d: dict) -> "RolloutConfig":
        return RolloutConfig(
            channel=d["channel"].lower(),
            vin_whitelist=d["vinWhitelist"],
            hwds=[Ecu.from_string(h.lower()) for h in d["hwds"]],
            max_pu=PU.from_string(d["maxPu"]) if d["maxPu"] else PU(3, 99),
            min_pu=PU.from_string(d["minPu"]) if d["minPu"] else PU(3, 0),
            environment=d["repository"].lower(),
            state=d["state"].lower(),
        )

    def to_dict(self) -> dict:
        return {
            "channel": self.channel,
            "vinWhitelist": self.vin_whitelist,
            "hwds": [str(hwd) for hwd in self.hwds],
            "maxPu": str(self.max_pu) if self.max_pu else None,
            "minPu": str(self.min_pu) if self.min_pu else None,
            "repository": self.environment,
            "state": self.state,
        }


@dataclass
class AppstoreVersion:
    id: str
    # Lifecycle state of a version, lowercased. A version is promoted through the
    # following stages. Each stage builds on the previous one:
    #
    #   1. INT       — Available to all vehicles configured against the integration
    #                  backend. Entry point after upload/processing. In practice the
    #                  state string here is usually "e2e_release_completed" or
    #                  "prod_test_release_completed" ("processing_completed" is rarely
    #                  observed). "prod_test_release_completed" is the most common resting
    #                  state and means the version passed the prod-test but has NOT entered
    #                  the prod release circle yet (is_prod_release is False). Non-stable
    #                  channels such as "canary" and "signoff" also live at the INT stage;
    #                  a freshly uploaded, still-processing version shows "uploaded", and a
    #                  failed one shows "initial_checks_failed".
    #
    #   2. PROD_TEST — The APK is on the PROD environment but is only offered to VINs
    #                  listed in this version's prod-test whitelist. Used to validate on
    #                  PROD with a limited fleet (typically development vehicles).
    #                  (RolloutConfig: environment "prod", channel "stable", with a
    #                  non-empty vinWhitelist — see release_to_prod_test.)
    #
    #   3. RELEASE_CIRCLE — The version is scheduled for a real PROD release. The release
    #                  circle is an evaluation board that checks quality and compliance.
    #                  Once it grants approval the version can advance to PROD.
    #                  (Version states: "release_circle_evaluation" → after approval
    #                  "release_circle_approved" / "qa_passed".)
    #
    #   4. PROD      — The version is available on PROD for all vehicles, but is NOT yet
    #                  offered to any vehicle until a rollout exists. At this point the
    #                  version has a prod/stable/"released" rollout config with no
    #                  vinWhitelist, so is_prod_release becomes True.
    #
    #   5. PROD ROLLOUT — Once an ad-hoc rollout is created, the version is actually
    #                  offered to all PROD vehicles. The rollout step schedules the
    #                  release to specific dates or conditions.
    #                  (Version state: "rollout_prod".)
    #
    # IMPORTANT: the "rollout_prod" state string is NOT a reliable indicator that the
    # version was actually released to PROD. Versions have been observed in state
    # "rollout_prod" whose only prod config is still "release_circle" (never "released"),
    # i.e. is_prod_release is False. The authoritative "published to PROD" signal is
    # is_prod_release (a prod/stable/"released" config with no vinWhitelist), not the
    # top-level state string.
    #
    # Note: the per-version "state" string here and the per-config RolloutConfig.state
    # are distinct concepts (see RolloutConfig.state).
    state: str
    version: str
    version_code: int
    rollout_configs: List[RolloutConfig]
    app: "AppstoreApp | None" = None
    # Direct client link so version details can be fetched even when the version was
    # obtained without a full AppstoreApp (e.g. via AppcockpitClient.get_app_versions).
    _app_id: str | None = None
    _client: "AppcockpitClient | None" = None

    @cached_property
    def version_details(self) -> dict:
        app_id = self.app.id if self.app else self._app_id
        client = self.app.client if self.app else self._client
        assert app_id and client, "Version needs to be linked to an AppcockpitClient"
        return client.get_version_details(app_id, self.id)

    @cached_property
    def release_circle_id(self):
        return self.version_details.get("releaseCircleId")

    @cached_property
    def upload_date(self):
        import dateutil.parser
        upload_event = next(e for e in self.version_details["eventHistory"] if e["event"].lower() == "upload")
        return dateutil.parser.parse(upload_event["timestamp"])

    @cached_property
    def is_prod_release(self) -> bool:
        return any(
            rc.environment == "prod" and rc.state == "released" and not rc.vin_whitelist
            for rc in self.rollout_configs
        )

    @cached_property
    def is_prod_test(self) -> bool:
        # PROD_TEST (lifecycle stage 2): on PROD but only for whitelisted VINs. A full
        # PROD release supersedes prod-test, so it wins when both configs exist.
        return not self.is_prod_release and any(rc.is_prod_test for rc in self.rollout_configs)

    @cached_property
    def has_prod_rollout(self) -> bool:
        """True if this version has an actual PROD rollout (not just released to PROD).

        `is_prod_release` only means the APK is available on PROD; a rollout is what
        actually offers it to vehicles. A rolled-out version reaches the "rollout_prod"
        lifecycle state, so a prod-released version in that state has a rollout — no need
        to query the dedicated rollouts endpoint.
        """
        return self.state == "rollout_prod"

    @classmethod
    def from_dict(cls, d: dict, app: "AppstoreApp | None" = None,
                  app_id: str | None = None,
                  client: "AppcockpitClient | None" = None) -> "AppstoreVersion":
        return AppstoreVersion(
            id=d["id"],
            state=d["state"].lower(),
            version=d["version"],
            version_code=int(d["versionCode"]),
            rollout_configs=[RolloutConfig.from_dict(r) for r in d["rolloutConfigs"]],
            app=app,
            _app_id=app_id,
            _client=client,
        )


@dataclass
class Gate1Info:
    id: str
    distribution_types: List[str]

    @classmethod
    def from_dict(cls, d: dict | None) -> "Gate1Info | None":
        if not d:
            return None
        return Gate1Info(
            id=d["id"],
            distribution_types=d.get("distributionTypes") or [],
        )


@dataclass
class AppstoreApp:
    department: str
    description: str
    id: str
    name: str
    package_name: str
    stable_releases_allowed: bool
    custom_signing: bool
    gate1: "Gate1Info | None" = None
    client: "AppcockpitClient | None" = None

    def get_stable_release(self, vehicle_config: BackendConfig, test_fleet_ids: List[str] | None = None) -> AppstoreVersion | None:
        if test_fleet_ids is None:
            test_fleet_ids = []
            if vehicle_config.environment == BackendEnvironment.PROD_TEST:
                if vehicle_config.hwd == Ecu.IDC23:
                    test_fleet_ids = ["63eded6eaa0a1f40e9bc1dcf"]
                elif vehicle_config.hwd == Ecu.IDCEvo:
                    test_fleet_ids = ["66c6f4554762a10756c26470"]

        for version in self.versions:
            if version.state in ["processing_failed"]:
                continue
            for rc in version.rollout_configs:
                if rc.min_pu > vehicle_config.pu or rc.max_pu < vehicle_config.pu:
                    continue
                if rc.channel != "stable" or rc.state != "released":
                    continue
                if vehicle_config.hwd not in rc.hwds:
                    continue
                env_str = {
                    BackendEnvironment.PROD_TEST: "prod",
                    BackendEnvironment.PROD: "prod",
                    BackendEnvironment.INT: "int",
                }[vehicle_config.environment]
                if rc.environment != env_str:
                    continue
                if not rc.vin_whitelist:
                    return version
                else:
                    for entry in rc.vin_whitelist:
                        if "fleet" in entry and entry["fleet"] in test_fleet_ids:
                            return version
        return None

    @cached_property
    def versions(self) -> List[AppstoreVersion]:
        assert self.client, "Can only access versions with a client connection"
        versions = self.client.get_app_versions(self.id)
        for v in versions:
            v.app = self
        return versions

    @cached_property
    def app_owners(self):
        assert self.client, "Can only access app owners with a client connection"
        return self.client.get_app_owners(self.id, include_external=True)

    @classmethod
    def from_dict(cls, d: dict, client: "AppcockpitClient | None" = None) -> "AppstoreApp":
        return AppstoreApp(
            id=d["id"],
            department=d["department"],
            description=d["description"],
            name=d["name"],
            package_name=d["packageName"],
            stable_releases_allowed=d["stableReleasesAllowed"],
            custom_signing=d["isUsingCustomSigning"],
            gate1=Gate1Info.from_dict(d.get("gate1")),
            client=client,
        )


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class AppcockpitClient:
    """Authenticated client for the BMW Appcockpit."""

    session: requests.Session

    def __init__(self):
        self.session = requests.Session()

    # --- Authentication ---

    def login(
        self,
        username: str,
        password: str,
        strong_auth: bool = True,
        strong_auth_type: str = "mobile",
        yubi_key_provider: Union[Callable, Iterator, int, str, None] = None,
    ):
        """Login via BMW SSO."""
        self._username = username
        self._password = password
        self._strong_auth = strong_auth
        self._strong_auth_type = strong_auth_type
        self._yubi_key_provider = yubi_key_provider
        self._use_cached_session = False
        self.session = bmw_sso_session(
            f"{BASE_URL}/auth/authenticate",
            username, password,
            strong_auth, strong_auth_type,
            yubi_key_provider=yubi_key_provider,
        )

    def login_with_cached_session(
        self,
        username: str,
        password: str,
        strong_auth: bool = True,
        strong_auth_type: str = "mobile",
        yubi_key_provider: Union[Callable, Iterator, int, str, None] = None,
    ):
        """Login via the SSO Session Keeper service (with transparent fallback).

        Attempts to retrieve a live, cached session from the Session Keeper
        service (``POST /sessions/appcockpit``).  If the service is unavailable
        or returns an error, falls back to a direct ``bmw_sso_session`` login
        — identical to calling :meth:`login` directly.

        Set the ``SESSION_KEEPER_URL`` environment variable to point at your
        Session Keeper instance (default: ``http://localhost:8090``).

        :param username: TSS username (e.g. ``q123456``).
        :param password: Strong-auth PIN.
        :param strong_auth: Whether to request strong authentication (default: ``True``).
        :param strong_auth_type: ``"mobile"`` or ``"yubikey"`` (default: ``"mobile"``).
        :param yubi_key_provider: Optional YubiKey provider for direct-login fallback.
        """
        from session_keeper.client import cached_sso_session

        self._username = username
        self._password = password
        self._strong_auth = strong_auth
        self._strong_auth_type = strong_auth_type
        self._yubi_key_provider = yubi_key_provider
        self._use_cached_session = True
        self.session = cached_sso_session(
            tool_key="appcockpit",
            username=username,
            password=password,
            strong_auth=strong_auth,
            strong_auth_type=strong_auth_type,
            app_url=f"{BASE_URL}/auth/authenticate",
            yubi_key_provider=yubi_key_provider,
        )

    def _re_login(self):
        if not hasattr(self, "_username"):
            raise RuntimeError("Cannot refresh login — call login() first")
        # Re-trace the original login path. If the client logged in via the
        # Session Keeper, refresh through it too — the keeper hands back a live
        # cached session (or logs in on its side) instead of forcing a new
        # interactive push in this process, which would otherwise hang.
        if getattr(self, "_use_cached_session", False):
            from session_keeper.client import cached_sso_session, delete_cached_session

            # The keeper returns a stored session without checking liveness, so
            # evict the dead one first — otherwise it hands back the same expired
            # cookies and the retry loops.
            delete_cached_session("appcockpit", self._username, self._password)
            self.session = cached_sso_session(
                tool_key="appcockpit",
                username=self._username,
                password=self._password,
                strong_auth=self._strong_auth,
                strong_auth_type=self._strong_auth_type,
                app_url=f"{BASE_URL}/auth/authenticate",
                yubi_key_provider=self._yubi_key_provider,
            )
            return
        self.session = bmw_sso_session(
            f"{BASE_URL}/auth/authenticate",
            self._username, self._password,
            strong_auth=self._strong_auth,
            strong_auth_type=self._strong_auth_type,
            yubi_key_provider=self._yubi_key_provider,
        )

    def is_logged_in(self) -> bool:
        return self.session.get(
            f"{BASE_URL}/api/oap/user-view/user-data", verify=False, allow_redirects=False, timeout=60
        ).status_code == 200

    # --- HTTP helpers ---

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        time.sleep(0.4)
        kwargs.setdefault("timeout", 60)
        url = BASE_URL + path
        resp = getattr(self.session, method)(url, verify=False, allow_redirects=False, **kwargs)
        # An expired session does not always surface as a clean 401: some endpoints
        # (e.g. /api/android/apps) answer with a 500 and a non-JSON body. Confirm the
        # session is actually invalid via the user-data endpoint (which returns a clean
        # 401) before re-authenticating, so genuine server-side 500s are left untouched.
        if resp.status_code == 401 or (resp.status_code in (302, 500) and not self.is_logged_in()):
            log.info("%s %s → %s, re-authenticating…", method.upper(), path, resp.status_code)
            self._re_login()
            resp = getattr(self.session, method)(url, verify=False, **kwargs)
        self._log_response(method.upper(), path, resp)
        return resp

    def get(self, path: str) -> requests.Response:
        return self._request("get", path)

    def post(self, path: str, json: dict = None, data: dict = None, files: dict = None) -> requests.Response:
        return self._request("post", path, json=json, data=data, files=files)

    def put(self, path: str, json: dict = None) -> requests.Response:
        return self._request("put", path, json=json)

    def delete(self, path: str) -> requests.Response:
        return self._request("delete", path)

    @staticmethod
    def _log_response(method: str, path: str, resp: requests.Response):
        body_len = len(resp.text) if resp.text else 0
        if resp.status_code != 200:
            log.warning("%s %s → %s (%d chars): %s", method, path, resp.status_code, body_len, resp.text[:1000] if resp.text else "")
        elif body_len <= _SMALL_PAYLOAD_THRESHOLD:
            log.info("%s %s → %s (%d chars): %s", method, path, resp.status_code, body_len, resp.text)
        else:
            log.info("%s %s → %s (%d chars)", method, path, resp.status_code, body_len)

    # --- API methods ---

    @_wipeable_cache
    def get_app_list(self) -> List[AppstoreApp]:
        resp = self.get("/api/android/apps?onlyDeletable=false")
        return [AppstoreApp.from_dict(d, self) for d in resp.json()]

    @_wipeable_cache
    def get_testfleets(self) -> List[TestFleet]:
        resp = self.get("/api/oap/test-fleet-view/test-fleets/")
        return [TestFleet.from_dict(j) for j in resp.json()["testFleets"]]

    def update_testfleet(self, testfleet: TestFleet):
        testfleet.vins = list(set(testfleet.vins))
        if len(testfleet.vins) > 600:
            exceeded = testfleet.vins[600:]
            log.error("Can only update testfleets with up to 600 VINs. Removed %s", exceeded)
            testfleet.vins = testfleet.vins[:600]
        data = {
            "_id": testfleet.id,
            "name": testfleet.name,
            "description": testfleet.description,
            "vins": [v.upper() for v in testfleet.vins],
        }
        return self.put(f"/api/oap/test-fleet-view/test-fleets/{testfleet.id}", json=data)

    @_wipeable_cache
    def get_app_versions(self, app_id: str) -> List[AppstoreVersion]:
        resp = self.get(f"/api/android/apps/{app_id}/versions/")
        if resp.status_code == 500:
            return []
        version_list = sorted(
            resp.json(),
            key=lambda e: self._convert_version_string(e["version"]),
            reverse=True,
        )
        return [AppstoreVersion.from_dict(v, app_id=app_id, client=self) for v in version_list]

    @_wipeable_cache
    def get_app_owners(self, app_id: str, include_external: bool = False):
        resp = self.get(f"/api/android/apps/{app_id}/team")
        try:
            members = resp.json()["members"]
            if not include_external:
                members = [m for m in members if re.match(r"[qQ]\d{6}", m["qNumber"])]
        except Exception as ex:
            log.error("Failed to parse app owners: %s — %s", ex, resp.text)
            return None
        return members

    @_wipeable_cache
    def get_version_details(self, app_id: str, version_id: str) -> dict:
        return self.get(f"/api/android/apps/{app_id}/versions/{version_id}").json()

    @_wipeable_cache
    def get_version_rollouts(self, app_id: str, version_id: str) -> list[dict]:
        """Return the rollout records for a version (the list the Appcockpit UI shows).

        Rollouts live on a dedicated endpoint, not in ``get_version_details``. Each entry
        wraps a ``rolloutMetadata`` object describing an actual rollout to vehicles.
        """
        resp = self.get(f"/api/android/apps/{app_id}/versions/{version_id}/rollouts")
        if resp.status_code != 200:
            return []
        return resp.json().get("rollouts") or []

    def delete_app_version(self, app_id: str, version_id: str) -> dict:
        resp = self.delete(f"/api/android/apps/{app_id}/versions/{version_id}")
        return {"deleted": resp.status_code == 200}

    def stage_to_release_circle(self, app_id: str, version_id: str, min_pu: PU, max_pu: PU,
                                release_type: str, hwds: List[Ecu],
                                release_circle_regions: List[str] | None = None,
                                release_circle_date: str | None = None,
                                rollouts: List[str] | None = None,
                                homologation: dict | None = None) -> requests.Response:
        if release_circle_date is None:
            from datetime import datetime, timezone
            today = datetime.now(timezone.utc).replace(hour=22, minute=0, second=0, microsecond=0)
            release_circle_date = today.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        payload = {
            "releaseTypeId": release_type,
            "releaseCircleRegions": release_circle_regions or ["EMEA"],
            "releaseCircleDate": release_circle_date,
            "rollouts": rollouts or ["AD_HOC"],
            "homologation": homologation or {
                "relevancy": "NOT_RELEVANT",
                "comment": "Language packages are not relevant for homologation",
            },
            "rolloutConfig": {
                "hwds": [str(h).upper() for h in hwds],
                "minPu": min_pu.to_appcockpit_value(),
                "maxPu": max_pu.to_appcockpit_value(),
                "minSdk": "31",
                "channel": "STABLE",
                "repository": "PROD",
                "state": "PENDING",
                "vinWhitelist": None,
                "extractedVinWhitelist": None,
            },
        }
        return self.post(f"/api/android/apps/{app_id}/versions/{version_id}/releaseCircle", json=payload)

    def download_app(self, app_version: AppstoreVersion, file_path: str, signing: str = "dev") -> None:
        """Download an APK from the Appcockpit.

        :param app_version: The version to download (must be linked to an app).
        :param file_path: Local path to save the APK file.
        :param signing: Signing variant, e.g. ``"dev"`` or ``"prod"``.
        """
        assert app_version.app, "AppstoreVersion must be linked to an AppstoreApp"
        url = f"/api/android/apps/{app_version.app.id}/versions/{app_version.id}/download?signing={signing.upper()}"
        download_url = self.get(url).text
        with open(file_path, "wb") as f:
            f.write(self.session.get(download_url, verify=False).content)

    def upload_apk(self, app_id: str, file_path: str, hwds: List[Ecu], min_pu: PU,
                   max_pu: PU = None, channel: str = "STABLE") -> requests.Response:
        form_data = {
            "hwds": ",".join(str(e).upper() for e in hwds),
            "minPu": min_pu.to_appcockpit_value(),
            "channel": channel,
        }
        if max_pu:
            form_data["maxPu"] = max_pu.to_appcockpit_value()
        with open(file_path, "rb") as f:
            return self.post(f"/api/android/apps/{app_id}/versions", data=form_data, files={"file": f})

    def release_to_prod_test(self, app_id: str, version_id: str, hwds: List[Ecu], min_pu: PU,
                             max_pu: PU = None, test_fleet_ids: List[str] = None,
                             vins: List[str] = None) -> requests.Response:
        json_data = {
            "fleets": test_fleet_ids or [],
            "rolloutConfig": {
                "channel": "STABLE",
                "extractedVinWhitelist": None,
                "hwds": [str(e).upper() for e in hwds],
                "minPu": min_pu.to_appcockpit_value(),
                "mindSdk": 31,
                "repository": "PROD",
                "state": "RELEASED",
                "vinWhitelist": None,
            },
            "vins": vins or [],
        }
        if max_pu:
            json_data["maxPu"] = max_pu.to_appcockpit_value()
        return self.put(f"/api/android/apps/{app_id}/versions/{version_id}/rollout-configs/prod-test", json=json_data)

    def set_stable_releases_allowed(self, app_id: str, allowed: bool) -> requests.Response:
        return self.put(f"/api/android/apps/{app_id}", json={"stableReleaseAllowed": allowed})

    def set_gate1(self, app_id: str, gate1_id: str, distribution_types: List[str]) -> requests.Response:
        payload = {"id": gate1_id, "distributionTypes": distribution_types}
        return self.put(f"/api/android/apps/{app_id}/gate1", json=payload)

    def approve_release_circle(
        self,
        release_circle_id: str,
        release_circle_entity_id: str,
        release_entity: str,
        comment: str,
        release_circle_members: List[str],
    ) -> requests.Response:
        """Approve a release circle evaluation.

        :param release_circle_id: ID of the release circle.
        :param release_circle_entity_id: Entity ID within the release circle.
        :param release_entity: Display name of the release circle entity.
        :param comment: Approval comment.
        :param release_circle_members: List of member email addresses.
        """
        payload = {
            "withCredentials": True,
            "releaseCircleId": release_circle_id,
            "approval": {
                "releaseCircleEntity": release_entity,
                "releaseCircleEntityId": release_circle_entity_id,
                "decision": "APPROVE",
                "comment": comment,
                "user": None,
                "userAllowedToEdit": True,
                "condition": None,
                "members": release_circle_members,
                "attachments": [],
                "style": "approve",
                "editMode": False,
                "deadlineDate": None,
            },
        }
        return self.post("/api/oap/app-detail-view/release-circle/save-approval", json=payload)

    def confirm_release_circle_decision(
        self,
        release_circle_id: str,
        comment: str,
    ) -> requests.Response:
        """Confirm (finalize) a release circle approval decision.

        :param release_circle_id: ID of the release circle.
        :param comment: Decision comment.
        """
        payload = {"decision": "APPROVE", "comment": comment}
        return self.put(f"/api/oap/release-circle/{release_circle_id}/decision", json=payload)

    def publish_app(
        self,
        app_id: str,
        version_id: str,
        min_pu: PU,
        max_pu: PU,
        hwds: List[Ecu] | None = None,
    ) -> requests.Response:
        """Publish an app version to PROD (full deployment, no VIN whitelist).

        :param app_id: Appcockpit app ID.
        :param version_id: Version ID to publish.
        :param min_pu: Minimum PU.
        :param max_pu: Maximum PU.
        :param hwds: Hardware targets (default: ``["IDC23"]``).
        """
        if hwds is None:
            hwds = [Ecu.from_string("idc23")]
        payload = {
            "hwds": [str(h).upper() for h in hwds],
            "minPu": min_pu.to_appcockpit_value(),
            "maxPu": max_pu.to_appcockpit_value(),
            "minSdk": 31,
            "channel": "STABLE",
            "repository": "PROD",
            "state": "RELEASED",
            "vinWhitelist": None,
        }
        return self.post(f"/api/android/apps/{app_id}/versions/{version_id}/deployment/PROD", json=payload)

    def create_adhoc_rollout(
        self,
        app_id: str,
        version_id: str,
    ) -> requests.Response:
        """Create an ad-hoc rollout for a specific app version.

        :param app_id: Appcockpit app ID.
        :param version_id: Version ID to create the rollout for.
        """
        payload = {
            "rolloutType": "AD_HOC",
            "alternativeName": None,
            "oneUpdateRolloutConfigId": None,
        }
        return self.post(f"/api/android/apps/{app_id}/versions/{version_id}/rollouts", json=payload)

    @staticmethod
    def _convert_version_string(version_string: str) -> list:
        try:
            return list(map(int, version_string.split("-")[0].split("_")[0].split(".")))
        except (ValueError, AttributeError):
            return [0]
