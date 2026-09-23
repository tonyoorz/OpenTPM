"""
Keep-alive scheduler — periodically pings each stored session to prevent
SSO session expiry.
"""

import asyncio
import logging
import os
from typing import TYPE_CHECKING

import requests
import urllib3

if TYPE_CHECKING:
    from session_keeper.store import SessionStore

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger("session_keeper.keepalive")

# How often to ping each tool (seconds). Default: 120 (2 minutes).
KEEPALIVE_INTERVAL = int(os.getenv("KEEPALIVE_INTERVAL_SECONDS", "120"))


async def keepalive_loop(store: "SessionStore") -> None:
    """
    Infinite loop that runs in the background.  Every ``KEEPALIVE_INTERVAL``
    seconds it iterates over all stored sessions and hits the keep-alive URL.
    """
    from session_keeper.tools import get_tool

    log.info("Keep-alive loop started (interval=%ds)", KEEPALIVE_INTERVAL)
    while True:
        await asyncio.sleep(KEEPALIVE_INTERVAL)
        for composite_key in store.keys():
            from session_keeper.store import SessionStore as _Store
            tool_key, username = _Store.split_key(composite_key)
            tool_cfg = get_tool(tool_key)
            if tool_cfg is None:
                log.warning("No tool config for '%s' — skipping keep-alive", tool_key)
                continue
            session = store.get_by_composite_key(composite_key)
            if session is None:
                continue
            try:
                alive = await asyncio.to_thread(
                    _ping, session, tool_cfg.keepalive_url
                )
                if alive:
                    log.debug("Keep-alive OK for %s (user=%s)", tool_key, username)
                    store.record_keepalive(composite_key, alive=True)
                    # Re-persist updated cookies (session cookies may have rotated)
                    store.put_by_composite_key(composite_key, session)
                else:
                    log.warning("Keep-alive FAILED for %s (user=%s) — removing session", tool_key, username)
                    store.record_keepalive(composite_key, alive=False, error="Session expired (redirect to login)")
                    store.delete_by_key(composite_key)
            except Exception as exc:
                log.exception("Keep-alive error for %s (user=%s) — removing session", tool_key, username)
                store.record_keepalive(composite_key, alive=False, error=str(exc))
                store.delete_by_key(composite_key)


def _ping(session: requests.Session, url: str) -> bool:
    """
    Hit *url* with the given session. Returns ``True`` if the response
    indicates the session is still valid (no redirect to login page).
    """
    resp = session.get(url, verify=False, allow_redirects=False, timeout=30)
    # A 200 means we're still logged in; a 302 to an auth page means expired.
    if resp.status_code == 200:
        return True
    if resp.status_code in (301, 302, 303, 307, 308):
        location = resp.headers.get("Location", "")
        if "auth" in location.lower() or "login" in location.lower():
            log.info("Session for %s redirected to login: %s", url, location)
            return False
        # Non-auth redirect — follow it to keep cookies alive
        session.get(url, verify=False, allow_redirects=True, timeout=30)
        return True
    log.warning("Unexpected status %d from keep-alive ping to %s", resp.status_code, url)
    return resp.status_code < 400
