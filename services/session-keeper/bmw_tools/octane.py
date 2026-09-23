"""
BMW Octane (ALM) client
========================

Provides :class:`OctaneClient` for interacting with Micro Focus ALM Octane.

Usage::

    from bmw_tools.octane import OctaneClient

    client = OctaneClient(base_url="https://octane.bmwgroup.net", space_id="1001", workspace_id="2002")
    client.login(username="q123456", password="pin")
    tickets = client.get_ticket_list({"Status BMW": "New"})
"""

import json
import logging
import math
import time
import urllib.parse
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple, Union

import requests
import urllib3

from bmw_sso import bmw_sso_session

log = logging.getLogger("bmw_tools.octane")

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class OctaneAPIError(Exception):
    pass


class OctaneTicket:
    """Represents a single Octane work item (defect)."""

    def __init__(self, ticket_id: int, fields: dict, client: "OctaneClient"):
        self.id = ticket_id
        self.fields = fields
        self.octane_client = client
        self.client_lock_stamp = int(self.fields["client_lock_stamp"])

    def set_target_release(self, target_release: str) -> Dict:
        target_release_id = self.octane_client.get_release_id(target_release)
        if not target_release_id:
            raise OctaneAPIError(f"Release {target_release} does not exist")
        return self.update(fields={"release": {"type": "release", "id": str(target_release_id)}})

    def set_description(self, description: str) -> Dict:
        return self.update(fields={"description": description})

    def update(self, fields: dict) -> Dict:
        api_endpoint = f"work_items/{self.id}"
        get_params = {"fields": "name,id"}
        update_dict = {}
        for k, v in fields.items():
            nk, nv = self.octane_client.dehumanize_fieldname_and_value(k, v)
            update_dict[nk] = nv
        log.info("Updating %s: %s", self.id, update_dict)

        put_params = {"id": str(self.id), "client_lock_stamp": self.client_lock_stamp}
        put_params.update(update_dict)
        self.client_lock_stamp += 1
        return self.octane_client._make_put_request(api_endpoint, get_params=get_params, put_params=put_params)

    def add_comment(self, html_comment: str) -> Dict:
        return self.octane_client.add_comment(self.id, html_comment)

    @lru_cache(maxsize=None)
    def get_readable_list_entries(self, field_name: str):
        def replace_one(list_node_data, id_val):
            for k, v in list_node_data.items():
                if id_val == v["id"]:
                    return k

        if field_name not in self.fields:
            raise OctaneAPIError(f"Field '{field_name}' not found; available: {list(self.fields.keys())}")
        if not isinstance(self.fields[field_name], dict):
            raise OctaneAPIError(f"Field '{field_name}' is not a list_node: {self.fields[field_name]}")

        field_metadata = self.octane_client.get_field_metadata(field_name)
        list_id = field_metadata["field_type_data"]["targets"][0]["logical_name"]
        list_node_data = self.octane_client.get_list_node(list_id)

        if "data" in self.fields[field_name]:
            return [replace_one(list_node_data, entry["id"]) for entry in self.fields[field_name]["data"]]
        return replace_one(list_node_data, self.fields[field_name]["id"])

    def __repr__(self):
        name = self.fields.get("name", "").strip()
        if name:
            return f"<OctaneTicket {self.id}: {name}>"
        return f"<OctaneTicket {self.id}>"


class OctaneClient:
    """Authenticated client for Micro Focus ALM Octane."""

    def __init__(self, base_url: str, space_id: str, workspace_id: str, proxy: str = None):
        self.session = requests.Session()
        self.base_url = base_url
        self.api_url = urllib.parse.urljoin(
            base_url, f"/api/shared_spaces/{space_id}/workspaces/{workspace_id}"
        )
        self.space_id = space_id
        self.workspace_id = workspace_id
        self.octane_user = None
        self._auth_method: Optional[str] = None
        if proxy:
            self.session.proxies.update({"https": proxy})

    # --- Authentication ---

    def login(self, username: str, password: str):
        """Login via BMW SSO (password-based)."""
        self.session = bmw_sso_session(self.base_url, username, password, session=self.session)
        self._auth_method = "sso"
        self._login_creds = {"username": username, "password": password}
        try:
            self.octane_user = self.get_user(username)
        except Exception:
            raise OctaneAPIError("Could not get user data — login probably failed")

    def login_with_api_key(self, client_id: str, client_secret: str):
        """Login via Octane REST API key."""
        sign_in_url = urllib.parse.urljoin(self.base_url, "/authentication/sign_in")
        resp = self.session.post(sign_in_url, json={"client_id": client_id, "client_secret": client_secret}, verify=False)
        if resp.status_code != 200:
            raise OctaneAPIError(f"API-key login failed (HTTP {resp.status_code}): {resp.text[:500]}")

        xsrf = self.session.cookies.get("XSRF_COOKIE", "")
        if xsrf:
            self.session.headers.update({"XSRF-Header": xsrf})

        self._auth_method = "api_key"
        self._login_creds = {"client_id": client_id, "client_secret": client_secret}

        try:
            self.octane_user = self.get_user(client_id)
        except OctaneAPIError:
            self.octane_user = {"id": "0", "name": client_id}
            log.warning("Could not resolve API-key user. Comment-posting may not work.")

    def auto_login(self, creds: dict):
        """
        Unified login — auto-selects best authentication method.

        Checks for API key first (``octane_api_keys`` dict keyed by base-URL,
        or flat ``octane_client_id``/``octane_client_secret``), falls back to SSO.
        """
        client_id, client_secret = "", ""

        # Environment-specific API key
        api_keys_by_env = creds.get("octane_api_keys", {})
        if isinstance(api_keys_by_env, dict):
            base_normalised = self.base_url.rstrip("/").lower()
            for env_url, key_data in api_keys_by_env.items():
                if env_url.rstrip("/").lower() == base_normalised and isinstance(key_data, dict):
                    client_id = key_data.get("client_id", "").strip()
                    client_secret = key_data.get("client_secret", "").strip()
                    break

        # Flat credentials
        if not (client_id and client_secret):
            client_id = creds.get("octane_client_id", "").strip()
            client_secret = creds.get("octane_client_secret", "").strip()

        if client_id and client_secret:
            self.login_with_api_key(client_id, client_secret)
        elif creds.get("username") and creds.get("password"):
            self.login(creds["username"], creds["password"])
        else:
            raise OctaneAPIError(
                "No valid credentials found. Provide either API key or username+password."
            )

    def logout(self):
        if self._auth_method == "api_key":
            self.session.post(urllib.parse.urljoin(self.base_url, "/authentication/sign_out"), verify=False)
        else:
            self.session.get(urllib.parse.urljoin(self.base_url, "/authentication/browser_sign_out"), verify=False)

    def _re_authenticate(self):
        if not hasattr(self, "_login_creds"):
            raise OctaneAPIError("Session expired and no stored credentials for re-authentication")
        log.info("Session expired – re-authenticating...")
        if self._auth_method == "api_key":
            self.login_with_api_key(self._login_creds["client_id"], self._login_creds["client_secret"])
        else:
            self.login(self._login_creds["username"], self._login_creds["password"])

    # --- HTTP helpers ---

    def _get_request_url(self, api_endpoint: str, request_params: Optional[Union[dict, str]] = None) -> str:
        if request_params:
            if isinstance(request_params, dict):
                request_params = urllib.parse.urlencode(request_params)
            return f"{self.api_url}/{api_endpoint}?{request_params}"
        return f"{self.api_url}/{api_endpoint}"

    def _request_with_retry(self, method: str, url: str, max_retries: int = 3, **kwargs) -> requests.Response:
        for attempt in range(1, max_retries + 1):
            try:
                resp = getattr(self.session, method)(url, verify=False, allow_redirects=True, **kwargs)
                return resp
            except requests.exceptions.ConnectionError as e:
                if attempt < max_retries:
                    wait = 5 * attempt
                    log.warning("ConnectionError on %s attempt %d/%d, retrying in %ds: %s",
                                method.upper(), attempt, max_retries, wait, e)
                    time.sleep(wait)
                else:
                    raise

    def _make_get_request(self, api_endpoint: str, request_params=None, _retry_on_401: bool = True) -> dict:
        url = self._get_request_url(api_endpoint, request_params)
        log.debug("GET %s", url)
        resp = self._request_with_retry("get", url)
        if resp.status_code == 401 and _retry_on_401:
            try:
                self._re_authenticate()
                return self._make_get_request(api_endpoint, request_params, _retry_on_401=False)
            except Exception as e:
                log.warning("Re-authentication failed: %s", e)
        if not 200 <= resp.status_code < 400:
            raise OctaneAPIError(f"{resp.status_code} Error: {url} — {resp.content[:500]}")
        return resp.json()

    def _make_post_request(self, api_endpoint: str, get_params=None, post_data=None, _retry_on_401: bool = True) -> dict:
        self.session.headers["Xsrf-Header"] = self.session.cookies.get("XSRF_COOKIE", "")
        url = self._get_request_url(api_endpoint, get_params)
        log.debug("POST %s -> %s", url, post_data)
        resp = self._request_with_retry("post", url, json=post_data)
        if resp.status_code == 401 and _retry_on_401:
            try:
                self._re_authenticate()
                return self._make_post_request(api_endpoint, get_params, post_data, _retry_on_401=False)
            except Exception as e:
                log.warning("Re-authentication failed: %s", e)
        if not 200 <= resp.status_code < 400:
            raise OctaneAPIError(f"{resp.status_code} Error: {url} — {resp.content[:500]}")
        return resp.json()

    def _make_put_request(self, api_endpoint: str, get_params=None, put_params=None, _retry_on_401: bool = True) -> dict:
        self.session.headers["Xsrf-Header"] = self.session.cookies.get("XSRF_COOKIE", "")
        if isinstance(get_params, dict):
            get_params["fetch_single_entity"] = "true"
        url = self._get_request_url(api_endpoint, get_params)
        log.debug("PUT %s -> %s", url, put_params)
        resp = self._request_with_retry("put", url, json=put_params)
        if resp.status_code == 401 and _retry_on_401:
            try:
                self._re_authenticate()
                return self._make_put_request(api_endpoint, get_params, put_params, _retry_on_401=False)
            except Exception as e:
                log.warning("Re-authentication failed: %s", e)
        if not 200 <= resp.status_code < 400:
            raise OctaneAPIError(f"{resp.status_code} Error: {url} — {resp.content[:500]}")
        return resp.json()

    # --- API methods ---

    def get_ticket(self, ticket_id: int, fields: List[str] = None) -> OctaneTicket:
        log.info("Retrieving ticket %s", ticket_id)
        ticket_list = self.get_ticket_list(f"id={ticket_id}", fields=fields or [])
        if len(ticket_list) != 1:
            raise OctaneAPIError(f"Did not get exactly one ticket with id {ticket_id}")
        return ticket_list[0]

    def get_ticket_list(self, query: Union[str, Dict], fields: List[str] = None, limit: int = 100) -> List[OctaneTicket]:
        """
        Get a list of Octane tickets.

        :param query: Octane query string, or dict of {field_name: value} for convenience.
        :param fields: Additional field names to export.
        :param limit: Max tickets to retrieve.
        """
        if fields is None:
            fields = []

        if isinstance(query, dict):
            parts = []
            for k, v in query.items():
                parts.append(self.build_query_for_field(k, v))
            query = ";".join(parts)

        api_endpoint = "work_items"
        export_fields = {"name", "owner", "severity", "author", "id", "phase", "client_lock_stamp"}
        export_fields.update(fields)

        data = []
        page_size = 100
        for n in range(math.ceil(limit / page_size)):
            offset = page_size * n
            request_params = {
                "fields": ",".join(export_fields),
                "limit": min(page_size, limit - page_size * n),
                "offset": offset,
                "query": f"\"(subtype='defect');({query})\"",
            }
            resp = self._make_get_request(api_endpoint, request_params)
            if not resp["data"]:
                break
            data += resp["data"]

        # Humanize list_node fields
        for d in data:
            humanized = {}
            for k, v in d.items():
                if not isinstance(v, dict):
                    continue
                if "total_count" in v and v["total_count"] > 0 and v["data"][0]["type"] == "list_node":
                    hk, hv = self.humanize_fieldname_and_value(k, v)
                    humanized[hk] = hv
                elif "type" in v and v["type"] == "list_node":
                    hk, hv = self.humanize_fieldname_and_value(k, v)
                    humanized[hk] = hv
            d.update(humanized)

        return [OctaneTicket(int(d["id"]), d, self) for d in data]

    def get_ticket_history(self, ticket_id: int) -> Dict[str, dict]:
        entries_per_request = 100
        ticket_history = {}
        for i in range(5000):
            new_entries = self._get_partial_ticket_history(ticket_id, limit=entries_per_request, offset=entries_per_request * i)
            if set(new_entries.keys()).issubset(set(ticket_history.keys())):
                break
            ticket_history.update(new_entries)
        return ticket_history

    def _get_partial_ticket_history(self, ticket_id: int, limit: int = 100, offset: int = 0) -> dict:
        resp = self._make_get_request("history_logs", {
            "query": f"\"entity_id='{ticket_id}';entity_type='defect'\"",
            "limit": limit,
            "offset": offset,
        })
        return self._history_to_dict(resp)

    @staticmethod
    def _history_to_dict(octane_history: dict) -> dict:
        result = {}
        for entry in octane_history["data"]:
            changes = {}
            for change in entry["change_set"]:
                if "mode" in change and change["mode"] == "REMOVE":
                    changes[change["field_label"]] = ""
                elif "value_text" in change:
                    changes[change["field_label"]] = change["value_text"]
                else:
                    changes[change["field_label"]] = change.get("value", "")
            if changes:
                ts = entry["timestamp"].replace("T", "_").replace("Z", "")
                result[ts] = changes
        return result

    def get_user(self, username: str, fields: List[str] = None) -> dict:
        export_fields = {"name", "id"}
        if fields:
            export_fields.update(fields)
        resp = self._make_get_request("workspace_users", {
            "fields": ",".join(export_fields),
            "query": f"\"(name='{username}')\"",
        })
        if len(resp["data"]) != 1:
            raise OctaneAPIError(f"Did not get exactly one user with name {username}: {resp['data']}")
        return resp["data"][0]

    @lru_cache(maxsize=None)
    def get_list_node(self, logical_name: str) -> Dict[str, Any]:
        data = []
        initial = self._make_get_request("list_nodes", {
            "query": f"\"list_root={{logical_name='{logical_name}'}}\"",
            "fields": "id,logical_name,name",
        })
        data.extend(initial["data"])
        total = initial["total_count"]
        while len(data) < total:
            page = self._make_get_request("list_nodes", {
                "query": f"\"list_root={{logical_name='{logical_name}'}}\"",
                "offset": len(data),
                "fields": "id,logical_name,name",
            })
            data.extend(page["data"])
            if not page["data"]:
                break
        return {f["name"]: f for f in data}

    @lru_cache(maxsize=None)
    def get_list_entry_id(self, field_name: str, field_value: str) -> str:
        field_info = self.get_field_metadata(field_name)
        list_id = field_info["field_type_data"]["targets"][0]["logical_name"]
        list_node = self.get_list_node(list_id)
        if field_value not in list_node:
            raise OctaneAPIError(f"'{field_value}' is not a valid entry for {field_name}")
        return list_node[field_value]["id"]

    @lru_cache(maxsize=None)
    def get_entity_fields(self, entity_name: str) -> Dict[str, Any]:
        resp = self._make_get_request("metadata/fields", {
            "query": f"\"entity_name EQ '{entity_name}'\"",
        })
        return {f["name"]: f for f in resp["data"]}

    @lru_cache(maxsize=None)
    def _get_all_field_metadata(self):
        return self._make_get_request("metadata/fields")["data"]

    def get_field_metadata(self, field_name: str) -> dict:
        for field in self._get_all_field_metadata():
            if field_name in [field["label"], field["name"], field["entity_name"]]:
                return field
        raise OctaneAPIError(f"Could not find field with name or label: {field_name}")

    def dehumanize_fieldname_and_value(self, field_name: str, field_value) -> Tuple[str, Any]:
        """Convert human-readable field name/value to Octane API format."""
        def _replace_one(value):
            if field_type == "reference":
                first_target = field["field_type_data"]["targets"][0]
                if first_target["type"] == "list_node" and isinstance(value, str):
                    return {"type": "list_node", "id": self.get_list_entry_id(field_name, value)}
            return value

        field = self.get_field_metadata(field_name)
        field_type = field["field_type"]
        is_list = (
            "field_type_data" in field
            and "multiple" in field["field_type_data"]
            and field["field_type_data"]["multiple"]
        )

        if is_list:
            new_value = {"data": [_replace_one(v) for v in field_value]}
        else:
            new_value = _replace_one(field_value)

        return field["name"], new_value

    def humanize_fieldname_and_value(self, field_name: str, field_value: dict) -> Tuple[str, Any]:
        """Convert Octane API field name/value to human-readable format."""
        def replace_one(list_node_data, id_val):
            for k, v in list_node_data.items():
                if id_val == v["id"]:
                    return k

        field_metadata = self.get_field_metadata(field_name)
        list_id = field_metadata["field_type_data"]["targets"][0]["logical_name"]
        list_node_data = self.get_list_node(list_id)

        if "data" in field_value:
            readable = [replace_one(list_node_data, entry["id"]) for entry in field_value["data"]]
            return field_metadata["label"], readable
        return field_metadata["label"], replace_one(list_node_data, field_value["id"])

    def build_query_for_field(self, field_name: str, field_value: str) -> str:
        """Build an Octane query fragment for a single field."""
        field = self.get_field_metadata(field_name)
        field_type = field["field_type"]

        if field_type == "reference":
            first_target = field["field_type_data"]["targets"][0]
            if first_target["type"] == "list_node":
                list_entry_id = self.get_list_entry_id(field_name, field_value)
                return f"({field['name']}={{id='{list_entry_id}'}})"

        return f"({field['name']}='{field_value}')"

    def get_release_id(self, release_name: str) -> str:
        if not hasattr(self, "_release_ids"):
            resp = self._make_get_request("releases", {"fields": "name,id", "limit": 2000})
            self._release_ids = {r["name"]: r["id"] for r in resp["data"]}
        if release_name in self._release_ids:
            return self._release_ids[release_name]
        raise OctaneAPIError(f"Release '{release_name}' does not exist")

    def add_comment(self, work_item_id: Union[int, str], html_comment: str) -> Dict:
        return self._make_post_request(
            "comments",
            get_params={"fields": "author,creation_time"},
            post_data={"data": [{
                "author": {"type": "workspace_user", "id": self.octane_user["id"]},
                "text": html_comment,
                "owner_work_item": {"type": "work_item", "id": str(work_item_id)},
            }]},
        )

    def get_attachment_list(self, work_item_id: Union[int, str]) -> list:
        resp = self._make_get_request("attachments", {
            "fields": "id,name,last_modified,author,size",
            "query": f"\"(owner_work_item={{id={work_item_id}}})\"",
        })
        return resp["data"]

    def download_attachment(self, attachment_id: Union[int, str], file_name: str):
        url = self._get_request_url(f"attachments/{attachment_id}")
        with open(file_name, "wb") as f:
            f.write(self.session.get(url, verify=False).content)
