"""
BMW Codebeamer (ALM) client
===========================

Provides :class:`CodebeamerClient` for reading and updating tracker items on a
Codebeamer instance.

Authentication follows the same pattern as the other :mod:`bmw_tools` clients:
call :meth:`CodebeamerClient.login` with your BMW credentials.  Codebeamer
itself does not accept the SSO cookie directly — it expects a short-lived
**bearer token** that BMW's ``tokenhelper`` web app issues after a
strong-authenticated (mobile-push) login.  ``login`` performs that SSO login
via :mod:`bmw_sso`, scrapes the token from the returned page and sets it as the
``Authorization`` header.  **Approve the push on your phone** when it appears.

Usage::

    from bmw_tools.codebeamer import CodebeamerClient

    client = CodebeamerClient()
    client.login(username="q123456", password="pin")   # strong-auth push
    me = client.get_current_user()
    print(me["name"])

When you already have a token (e.g. cached in an environment variable), skip
the interactive login::

    client = CodebeamerClient()
    client.login_with_token(existing_token)
"""

import json
import logging
import re
import time
from netrc import netrc
from pathlib import Path
from typing import Any, Iterator, Mapping, Union
from urllib.parse import quote

import requests
import urllib3

from bmw_sso import bmw_sso_session

log = logging.getLogger("bmw_tools.codebeamer")

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://codebeamer.bmwgroup.net/cb"
TOKENHELPER_URL = "https://tokenhelper.azure.cloud.bmw/Home/Prod"

# Codebeamer tokens seen so far are ~27 chars of URL-safe base64. Be generous.
_TOKEN_RE = re.compile(r"[A-Za-z0-9._-]{20,512}")


class CodebeamerError(RuntimeError):
    """Raised when the Codebeamer API returns an error response."""

    def __init__(self, message: str, *, status_code: int | None = None, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class TokenFetchError(CodebeamerError):
    """Raised when the bearer token cannot be retrieved from tokenhelper."""


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------


def _netrc_strong_auth(machine: str = "twofactor.auth") -> tuple[str, str]:
    auth = netrc().authenticators(machine)
    if not auth:
        raise TokenFetchError(
            f"No '{machine}' entry found in ~/.netrc for strong authentication."
        )
    user, _, pin = auth
    return user, pin


def _token_from_json(data: Any) -> str | None:
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, str) and re.search(r"token|bearer", key, re.IGNORECASE):
                return value
        for value in data.values():
            found = _token_from_json(value)
            if found:
                return found
    elif isinstance(data, list):
        for value in data:
            found = _token_from_json(value)
            if found:
                return found
    return None


def _extract_token(html_or_json: str) -> str | None:
    """Best-effort extraction of the bearer token from the tokenhelper page.

    Tries, in order: a JSON body with a token-ish key, an HTML input value,
    an element with a token-ish id/class, and finally the longest token-like
    run on the page.
    """
    text = html_or_json.strip()

    # 1. JSON payload
    if text.startswith("{") or text.startswith("["):
        try:
            data = json.loads(text)
            token = _token_from_json(data)
            if token:
                return token
        except ValueError:
            pass

    # 2. HTML <input ... value="TOKEN"> near a token-ish name/id
    for m in re.finditer(
        r'<input[^>]*(?:id|name)="[^"]*(?:token|bearer)[^"]*"[^>]*value="([^"]+)"',
        text,
        re.IGNORECASE,
    ):
        return m.group(1)

    # 3. An element whose id/class mentions token: <... id="token">VALUE</...>
    for m in re.finditer(
        r'<(\w+)[^>]*(?:id|class)="[^"]*(?:token|bearer)[^"]*"[^>]*>([^<]+)</\1>',
        text,
        re.IGNORECASE,
    ):
        candidate = m.group(2).strip()
        if candidate:
            return candidate

    # 4. Fallback: the longest token-like run (avoids picking short words).
    candidates = [c for c in _TOKEN_RE.findall(text) if len(c) >= 20]
    if candidates:
        return max(candidates, key=len)

    return None


def _scrape_token(
    session: requests.Session,
    url: str = TOKENHELPER_URL,
    *,
    save_page_to: "str | Path | None" = None,
) -> str:
    """GET the tokenhelper page with an authenticated session and return the token."""
    resp = session.get(url, verify=False)
    if save_page_to is not None:
        Path(save_page_to).write_text(resp.text, encoding="utf-8")
    if not resp.ok:
        raise TokenFetchError(
            f"tokenhelper returned HTTP {resp.status_code}", status_code=resp.status_code
        )
    token = _extract_token(resp.text)
    if not token:
        raise TokenFetchError(
            "Authenticated, but could not locate a token on the tokenhelper page. "
            + (
                f"Saved the page to '{save_page_to}' for inspection."
                if save_page_to
                else "Pass save_page_to=... to inspect the page."
            )
        )
    return token


def fetch_codebeamer_token(
    username: str | None = None,
    password: str | None = None,
    *,
    url: str = TOKENHELPER_URL,
    strong_auth_type: str = "mobile",
    save_page_to: "str | Path | None" = None,
) -> str:
    """Authenticate via BMW SSO (strong/mobile) and return the Codebeamer token.

    :param username: Q-number. Defaults to the ``twofactor.auth`` netrc login.
    :param password: Strong-auth PIN. Defaults to the ``twofactor.auth`` netrc password.
    :param url: The tokenhelper page URL.
    :param strong_auth_type: ``"mobile"`` or ``"yubikey"``.
    :param save_page_to: Optional path to dump the fetched page for inspection.
    :raises TokenFetchError: if login fails or no token can be extracted.
    """
    if username is None or password is None:
        username, password = _netrc_strong_auth()

    try:
        session = bmw_sso_session(
            url,
            username=username,
            password=password,
            strong_auth=True,
            strong_auth_type=strong_auth_type,
        )
    except Exception as exc:  # surface any SSO failure uniformly
        raise TokenFetchError(
            f"BMW SSO login failed ({type(exc).__name__}: {exc}). "
            "Did you approve the push on your phone in time?"
        ) from exc

    return _scrape_token(session, url, save_page_to=save_page_to)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class CodebeamerClient:
    """Read/write client for a Codebeamer instance."""

    session: requests.Session

    def __init__(
        self,
        base_url: str = BASE_URL,
        timeout: float = 30.0,
        tokenhelper_url: str = TOKENHELPER_URL,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.tokenhelper_url = tokenhelper_url
        self.token: str | None = None
        self.session = requests.Session()
        self.session.headers.setdefault("Accept", "application/json")
        # SSL verification is disabled: the internal Codebeamer instance uses a
        # corporate CA that Python does not trust by default.
        self.session.verify = False

    # --- Authentication ---

    def login(
        self,
        username: str,
        password: str,
        strong_auth: bool = True,
        strong_auth_type: str = "mobile",
        yubi_key_provider: "Union[callable, int, str, None]" = None,
    ):
        """Login via BMW SSO and fetch a Codebeamer bearer token.

        Codebeamer requires strong authentication (mobile push by default) —
        approve the push on your phone when it appears.
        """
        self._username = username
        self._password = password
        self._strong_auth = strong_auth
        self._strong_auth_type = strong_auth_type
        self._yubi_key_provider = yubi_key_provider
        sso_session = bmw_sso_session(
            self.tokenhelper_url,
            username,
            password,
            strong_auth,
            strong_auth_type,
            yubi_key_provider=yubi_key_provider,
        )
        self._apply_token(_scrape_token(sso_session, self.tokenhelper_url))

    def login_with_netrc(self, machine: str = "twofactor.auth", **kwargs):
        """Login using credentials stored in ``~/.netrc`` (default ``twofactor.auth``)."""
        username, password = _netrc_strong_auth(machine)
        self.login(username, password, **kwargs)

    def login_with_token(self, token: str):
        """Use a pre-fetched bearer token instead of an interactive login.

        No credentials are stored, so an expired token (HTTP 401) is *not*
        refreshed automatically — fetch a new token and call this again.
        """
        self._apply_token(token)

    def login_with_cached_session(
        self,
        username: str,
        password: str,
        strong_auth: bool = True,
        strong_auth_type: str = "mobile",
        yubi_key_provider: "Union[callable, int, str, None]" = None,
    ):
        """Login via the SSO Session Keeper service (with transparent fallback).

        Retrieves a live, cached tokenhelper session from the Session Keeper
        service and scrapes the bearer token from it.  Falls back to a direct
        strong-auth login when the service is unavailable — identical to
        calling :meth:`login`.

        Set the ``SESSION_KEEPER_URL`` environment variable to point at your
        Session Keeper instance (default: ``http://localhost:8090``).
        """
        from session_keeper.client import cached_sso_session

        self._username = username
        self._password = password
        self._strong_auth = strong_auth
        self._strong_auth_type = strong_auth_type
        self._yubi_key_provider = yubi_key_provider
        sso_session = cached_sso_session(
            tool_key="codebeamer",
            username=username,
            password=password,
            strong_auth=strong_auth,
            strong_auth_type=strong_auth_type,
            app_url=self.tokenhelper_url,
            yubi_key_provider=yubi_key_provider,
        )
        self._apply_token(_scrape_token(sso_session, self.tokenhelper_url))

    def _re_login(self) -> str:
        if not hasattr(self, "_username"):
            raise CodebeamerError(
                "Cannot refresh token — call login() first (login_with_token() "
                "does not store credentials for an automatic refresh)."
            )
        log.info("Refreshing Codebeamer token via BMW SSO")
        sso_session = bmw_sso_session(
            self.tokenhelper_url,
            self._username,
            self._password,
            self._strong_auth,
            self._strong_auth_type,
            yubi_key_provider=self._yubi_key_provider,
        )
        return self._apply_token(_scrape_token(sso_session, self.tokenhelper_url))

    def refresh_token(self) -> str:
        """Fetch a new bearer token and apply it to the session."""
        return self._re_login()

    def _apply_token(self, token: str) -> str:
        self.token = token
        self.session.headers["Authorization"] = f"Bearer {token}"
        return token

    # --- HTTP helpers ---

    @property
    def api_v3(self) -> str:
        return f"{self.base_url}/api/v3"

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        base: str | None = None,
        _allow_relogin: bool = True,
    ) -> Any:
        """Perform a single HTTP request and return the parsed JSON body.

        ``path`` is appended to ``base`` (defaults to the V3 API root).
        Raises :class:`CodebeamerError` on non-2xx responses.  When the client
        was authenticated via :meth:`login` and the token has expired, a single
        401 triggers an automatic token refresh and retry.
        """
        root = base if base is not None else self.api_v3
        url = f"{root}/{path.lstrip('/')}"

        started = time.perf_counter()
        response = self.session.request(
            method,
            url,
            params=params,
            json=json,
            timeout=self.timeout,
            verify=False,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        log.info("%s %s -> %s (%.0f ms)", method, url, response.status_code, elapsed_ms)

        if response.status_code == 401 and _allow_relogin and hasattr(self, "_username"):
            log.info("Received HTTP 401 — refreshing token and retrying once")
            self._re_login()
            return self.request(
                method, path, params=params, json=json, base=base, _allow_relogin=False
            )

        if not response.ok:
            self._raise_for_response(response)

        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return response.text

    @staticmethod
    def _raise_for_response(response: requests.Response) -> None:
        payload: Any
        try:
            payload = response.json()
            message = payload.get("message") if isinstance(payload, dict) else payload
        except ValueError:
            payload = response.text
            message = response.text[:500]
        raise CodebeamerError(
            f"HTTP {response.status_code} for {response.request.method} "
            f"{response.url}: {message}",
            status_code=response.status_code,
            payload=payload,
        )

    # --- Users ---

    def get_current_user(self) -> dict[str, Any]:
        """Return the authenticated user (also a quick connectivity check)."""
        return self.request("GET", "users/current")

    def get_user(self, user_id: int) -> dict[str, Any]:
        return self.request("GET", f"users/{user_id}")

    # --- Projects & trackers ---

    def get_projects(self) -> list[dict[str, Any]]:
        """List projects visible to the authenticated user."""
        return self.request("GET", "projects")

    def get_project(self, project_id: int) -> dict[str, Any]:
        return self.request("GET", f"projects/{project_id}")

    def get_trackers(self, project_id: int) -> list[dict[str, Any]]:
        """List trackers belonging to a project."""
        return self.request("GET", f"projects/{project_id}/trackers")

    def get_tracker(self, tracker_id: int) -> dict[str, Any]:
        return self.request("GET", f"trackers/{tracker_id}")

    # --- Tracker items (issues) ---

    def get_tracker_items_page(
        self, tracker_id: int, *, page: int = 1, page_size: int = 25
    ) -> dict[str, Any]:
        """Return one page of item references for a tracker.

        Response shape (V3): ``{"page", "pageSize", "total", "itemRefs": [...]}``.
        """
        return self.request(
            "GET",
            f"trackers/{tracker_id}/items",
            params={"page": page, "pageSize": page_size},
        )

    def iter_tracker_items(
        self, tracker_id: int, *, page_size: int = 50, max_items: int | None = None
    ) -> Iterator[dict[str, Any]]:
        """Yield item references for a tracker, transparently paging.

        Stops after ``max_items`` references if provided.
        """
        page = 1
        yielded = 0
        while True:
            result = self.get_tracker_items_page(
                tracker_id, page=page, page_size=page_size
            )
            refs = result.get("itemRefs") or result.get("items") or []
            if not refs:
                break
            for ref in refs:
                yield ref
                yielded += 1
                if max_items is not None and yielded >= max_items:
                    return
            total = result.get("total", 0)
            if page * page_size >= total:
                break
            page += 1

    def get_item(self, item_id: int) -> dict[str, Any]:
        """Return the full tracker item (issue) by id."""
        return self.request("GET", f"items/{item_id}")

    def get_item_fields(self, item_id: int) -> Any:
        """Return the field definitions/values for an item."""
        return self.request("GET", f"items/{item_id}/fields")

    def get_item_relations(self, item_id: int) -> Any:
        """Return incoming/outgoing relations for an item."""
        return self.request("GET", f"items/{item_id}/relations")

    def get_tracker_field(self, tracker_id: int, field_id: int) -> dict[str, Any]:
        """Return one field's definition (incl. choice ``options``) for a tracker."""
        return self.request("GET", f"trackers/{tracker_id}/fields/{field_id}")

    def update_item_fields(
        self,
        item_id: int,
        field_values: "list[dict[str, Any]]",
        *,
        quiet_mode: bool = False,
    ) -> Any:
        """Update selected custom/standard fields of an item (partial update).

        ``field_values`` is a list of Codebeamer ``FieldValue`` objects, e.g.::

            [{"fieldId": 1042, "name": "Customer Status Panasonic",
              "type": "ChoiceFieldValue",
              "values": [{"id": 3, "type": "ChoiceOptionReference"}]}]

        Only the listed fields are changed. ``quiet_mode`` suppresses
        notifications / history when ``True``.
        """
        return self.request(
            "PUT",
            f"items/{item_id}/fields",
            params={"quietMode": "true" if quiet_mode else "false"},
            json={"fieldValues": field_values},
        )

    def query_items(
        self, cbql: str, *, page: int = 1, page_size: int = 25
    ) -> dict[str, Any]:
        """Run a cbQL query and return a page of full tracker items.

        Example ``cbql``: ``"tracker.id IN (123) AND status.name = 'Open'"``.
        Response shape: ``{"page", "pageSize", "total", "items": [...]}``.
        """
        return self.request(
            "POST",
            "items/query",
            json={"page": page, "pageSize": page_size, "queryString": cbql},
        )

    def iter_query(
        self, cbql: str, *, page_size: int = 100, max_items: int | None = None
    ) -> Iterator[dict[str, Any]]:
        """Yield all full items matching a cbQL query, transparently paging."""
        page = 1
        yielded = 0
        while True:
            result = self.query_items(cbql, page=page, page_size=page_size)
            items = result.get("items") or []
            if not items:
                break
            for item in items:
                yield item
                yielded += 1
                if max_items is not None and yielded >= max_items:
                    return
            if page * page_size >= result.get("total", 0):
                break
            page += 1

    def iter_headings(
        self, tracker_id: int, *, page_size: int = 500
    ) -> Iterator[dict[str, Any]]:
        """Yield all ``Heading`` items of a tracker (the structural nodes).

        Each item includes ``parent``, ``ordinal`` and ``children`` so the
        outline hierarchy can be reconstructed (see :class:`TrackerStructure`).
        """
        yield from self.iter_query(
            f"tracker.id IN ({tracker_id}) AND category = 'Heading'",
            page_size=page_size,
        )

    def iter_items_under(
        self,
        tracker_id: int,
        parent_ids: "list[int]",
        *,
        category: str | None = None,
        item_type: str | None = None,
        page_size: int = 100,
        chunk_size: int = 50,
    ) -> Iterator[dict[str, Any]]:
        """Yield items whose direct parent is one of ``parent_ids``.

        Optionally filter by ``category`` (e.g. ``'Requirement'``... note that
        on this instance the item *type* is ``Requirement`` while ``Heading``
        is a category) or ``item_type``. ``parent_ids`` is chunked so the
        generated cbQL stays within server limits.
        """
        if not parent_ids:
            return
        extra = ""
        if item_type is not None:
            extra += f" AND type IN ('{item_type}')"
        if category is not None:
            extra += f" AND category = '{category}'"
        for start in range(0, len(parent_ids), chunk_size):
            chunk = parent_ids[start : start + chunk_size]
            ids_csv = ",".join(str(pid) for pid in chunk)
            cbql = f"tracker.id IN ({tracker_id}) AND parentId IN ({ids_csv}){extra}"
            yield from self.iter_query(cbql, page_size=page_size)

    # --- Legacy REST helper (matches the curl sample from the task) ---

    def legacy_get(self, path: str, *, params: Mapping[str, Any] | None = None) -> Any:
        """GET against the legacy ``/rest`` API, e.g. ``legacy_get('user/2')``."""
        base = f"{self.base_url}/rest"
        return self.request("GET", quote(path), params=params, base=base)
