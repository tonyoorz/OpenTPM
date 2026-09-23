"""
Client helper for retrieving sessions from the Session Keeper Service.

Usage::

    from session_keeper.client import cached_sso_session

    # Transparently gets a cached session or performs a fresh login
    session = cached_sso_session(
        tool_key="appcockpit",
        username="q123456",
        password="pin",
    )

Set the environment variable ``SESSION_KEEPER_URL`` to the service base URL
(default: ``http://localhost:8090``).
"""

import logging
import os
from typing import Optional

import requests

log = logging.getLogger("session_keeper.client")

SESSION_KEEPER_URL = os.getenv("SESSION_KEEPER_URL", "http://localhost:8090")


def _restore_session(cookies: list) -> requests.Session:
    """Build a ``requests.Session`` from the cookie list returned by the API."""
    session = requests.Session()
    for c in cookies:
        session.cookies.set(
            c["name"],
            c["value"],
            domain=c.get("domain", ""),
            path=c.get("path", "/"),
        )
    return session


def get_or_create_session(
    tool_key: str,
    username: str,
    password: str,
    strong_auth: bool = False,
    strong_auth_type: str = "mobile",
) -> Optional[requests.Session]:
    """
    Call the unified POST /sessions/{tool_key} endpoint which returns an
    existing session if credentials match, or performs a login and stores
    the new session. Returns ``None`` if the service is unreachable.
    """
    try:
        resp = requests.post(
            f"{SESSION_KEEPER_URL}/sessions/{tool_key}",
            json={
                "username": username,
                "password": password,
                "strong_auth": strong_auth,
                "strong_auth_type": strong_auth_type,
            },
            timeout=120,  # login can take a while (push notification wait)
        )
        if resp.status_code == 200:
            data = resp.json()
            log.info("Got session for %s/%s from session keeper", tool_key, username)
            return _restore_session(data["cookies"])
        log.warning("Keeper service returned %d: %s", resp.status_code, resp.text)
    except requests.ConnectionError:
        log.debug("Session keeper service not reachable at %s", SESSION_KEEPER_URL)
    except Exception:
        log.warning("Failed to get session for %s/%s from keeper", tool_key, username, exc_info=True)
    return None


def delete_cached_session(tool_key: str, username: str, password: str) -> bool:
    """Delete a stored session from the keeper so the next request re-logs in.

    Used to force a genuine refresh: the keeper's POST endpoint returns a stored
    session without checking its liveness, so a dead session must be removed
    before a new one can be minted. Returns ``True`` if the keeper acknowledged
    the deletion, ``False`` if it was unreachable or reported an error.
    """
    try:
        resp = requests.delete(
            f"{SESSION_KEEPER_URL}/sessions/{tool_key}",
            json={"username": username, "password": password},
            timeout=30,
        )
        if resp.status_code in (200, 404):
            return True
        log.warning("Keeper delete returned %d: %s", resp.status_code, resp.text)
    except requests.ConnectionError:
        log.debug("Session keeper service not reachable at %s", SESSION_KEEPER_URL)
    except Exception:
        log.warning("Failed to delete session for %s/%s from keeper", tool_key, username, exc_info=True)
    return False


def cached_sso_session(
    tool_key: str,
    username: str,
    password: str,
    strong_auth: bool = False,
    strong_auth_type: str = "mobile",
    app_url: Optional[str] = None,
    yubi_key_provider=None,
) -> requests.Session:
    """
    High-level helper: try the keeper service first, fall back to direct login.

    1. Try ``POST /sessions/{tool_key}`` with credentials — service returns
       cached session if valid, or performs a new login.
    2. Fall back to ``bmw_sso_session()`` locally if service is unreachable.
    """
    # 1. Try keeper service (handles both cache lookup and login)
    session = get_or_create_session(tool_key, username, password, strong_auth, strong_auth_type)
    if session is not None:
        return session

    # 2. Fall back to direct local login
    log.info("Falling back to direct bmw_sso_session for %s/%s", tool_key, username)
    from bmw_sso import bmw_sso_session
    from session_keeper.tools import get_tool

    tool_cfg = get_tool(tool_key)
    login_url = app_url or (tool_cfg.app_url if tool_cfg else None)
    if login_url is None:
        raise ValueError(f"No app_url configured for tool '{tool_key}' and none provided")

    return bmw_sso_session(
        login_url,
        username=username,
        password=password,
        strong_auth=strong_auth or (tool_cfg.strong_auth if tool_cfg else False),
        strong_auth_type=strong_auth_type,
        yubi_key_provider=yubi_key_provider,
    )
