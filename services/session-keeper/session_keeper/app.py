"""
FastAPI application for the SSO Session Keeper Service.

Endpoints
---------
- ``GET  /health``               — health check
- ``GET  /tools``                — list registered tools
- ``GET  /sessions``             — list active sessions
- ``POST /sessions/{tool_key}``  — retrieve or create a session (validates credentials)
- ``DELETE /sessions/{tool_key}``— remove a stored session
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

import requests
import urllib3
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from session_keeper.keepalive import keepalive_loop, KEEPALIVE_INTERVAL
from session_keeper.store import SessionStore
from session_keeper.tools import get_tool, list_tools, load_extra_tools

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger("session_keeper.app")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

store = SessionStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_extra_tools()
    task = asyncio.create_task(keepalive_loop(store))
    log.info("Session keeper service started")
    yield
    task.cancel()


app = FastAPI(title="SSO Session Keeper", lifespan=lifespan)


# ------------------------------------------------------------------ #
# Request / response models                                          #
# ------------------------------------------------------------------ #

class LoginRequest(BaseModel):
    username: str
    password: str
    strong_auth: bool = False
    strong_auth_type: str = "mobile"


class SessionResponse(BaseModel):
    tool_key: str
    username: str
    cookies: list
    active: bool


# ------------------------------------------------------------------ #
# Endpoints                                                          #
# ------------------------------------------------------------------ #

@app.get("/health")
async def health():
    return {"status": "ok", "active_sessions": len(store.keys())}


@app.get("/tools")
async def tools():
    return {k: v.to_dict() for k, v in list_tools().items()}


@app.get("/sessions/status")
async def sessions_status():
    """Enriched session list with keepalive state for the web UI."""
    result = []
    for key in store.keys():
        tool_key, username = SessionStore.split_key(key)
        session = store.get_by_composite_key(key)
        ka = store.get_keepalive_status(key)
        stored_at = store.get_stored_at(key)
        result.append({
            "tool_key": tool_key,
            "username": username,
            "active": session is not None,
            "cookie_count": len(list(session.cookies)) if session else 0,
            "stored_at": stored_at,
            "keepalive": {
                "last_ping": ka.last_ping if ka else None,
                "alive": ka.alive if ka else None,
                "error": ka.error if ka else "",
            } if ka else None,
        })
    return {
        "sessions": result,
        "keepalive_interval": KEEPALIVE_INTERVAL,
        "server_time": time.time(),
    }


@app.get("/", response_class=HTMLResponse)
async def web_ui():
    """Serve the session keeper dashboard."""
    return _DASHBOARD_HTML


@app.get("/sessions")
async def list_sessions():
    result = {}
    for key in store.keys():
        tool_key, username = SessionStore.split_key(key)
        session = store.get_by_composite_key(key)
        result[key] = {
            "tool_key": tool_key,
            "username": username,
            "cookie_count": len(list(session.cookies)) if session else 0,
            "active": session is not None,
        }
    return result


@app.post("/sessions/{tool_key}", response_model=SessionResponse)
async def get_or_create_session(tool_key: str, body: LoginRequest):
    """
    Retrieve an existing session if credentials match, or perform a fresh
    login and store the result. This single endpoint replaces the old
    separate GET/POST pattern — credentials are always required.
    """
    # 1. Try to return an existing session for this (tool, user)
    session = store.validate_and_get(tool_key, body.username, body.password)
    if session is not None:
        log.info("Returning cached session for %s/%s", tool_key, body.username)
        return SessionResponse(
            tool_key=tool_key,
            username=body.username,
            cookies=SessionStore._cookies_to_dict(session),
            active=True,
        )

    # 2. No valid session — perform login
    tool_cfg = get_tool(tool_key)
    if tool_cfg is None:
        raise HTTPException(status_code=404, detail=f"Unknown tool '{tool_key}'. Use GET /tools to see available tools.")

    try:
        session = await asyncio.to_thread(
            _do_login,
            tool_cfg.app_url,
            body.username,
            body.password,
            body.strong_auth or tool_cfg.strong_auth,
            body.strong_auth_type or tool_cfg.strong_auth_type,
        )
    except Exception as exc:
        log.error("Login failed for %s/%s: %s", tool_key, body.username, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Login failed: {exc}")

    store.put(tool_key, body.username, body.password, session)
    log.info("Session created for %s/%s", tool_key, body.username)
    return SessionResponse(
        tool_key=tool_key,
        username=body.username,
        cookies=SessionStore._cookies_to_dict(session),
        active=True,
    )


@app.delete("/sessions/{tool_key}")
async def delete_session(tool_key: str, body: LoginRequest):
    """Delete a session — requires valid credentials."""
    session = store.validate_and_get(tool_key, body.username, body.password)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No active session for '{tool_key}/{body.username}' or invalid credentials")
    store.delete(tool_key, body.username)
    return {"detail": f"Session for '{tool_key}/{body.username}' removed"}


# ------------------------------------------------------------------ #
# Login helper                                                       #
# ------------------------------------------------------------------ #

def _do_login(
    app_url: str,
    username: str,
    password: str,
    strong_auth: bool,
    strong_auth_type: str,
) -> requests.Session:
    from bmw_sso import bmw_sso_session

    # Internal BMW tools must be reached directly, never via an HTTP proxy.
    # Docker Desktop may inject proxy env vars that break connectivity.
    session = requests.Session()
    session.trust_env = False

    return bmw_sso_session(
        app_url,
        username=username,
        password=password,
        strong_auth=strong_auth,
        strong_auth_type=strong_auth_type,
        session=session,
    )


# ------------------------------------------------------------------ #
# Dashboard HTML                                                     #
# ------------------------------------------------------------------ #

_DASHBOARD_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SSO Session Keeper</title>
<style>
  :root { --bg: #1a1a2e; --card: #16213e; --accent: #0f3460; --green: #4ecca3; --red: #e94560; --yellow: #f0c929; --text: #eee; --muted: #888; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: var(--muted); font-size: .85rem; margin-bottom: 1.5rem; }
  .stats { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .stat { background: var(--card); border-radius: 8px; padding: 1rem 1.5rem; min-width: 140px; }
  .stat .label { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
  .stat .value { font-size: 1.5rem; font-weight: 700; margin-top: .25rem; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; }
  th { background: var(--accent); text-align: left; padding: .75rem 1rem; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  td { padding: .75rem 1rem; border-top: 1px solid rgba(255,255,255,.05); font-size: .9rem; }
  tr:hover td { background: rgba(255,255,255,.03); }
  .badge { display: inline-block; padding: .15rem .6rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
  .badge-green { background: rgba(78,204,163,.15); color: var(--green); }
  .badge-red { background: rgba(233,69,96,.15); color: var(--red); }
  .badge-yellow { background: rgba(240,201,41,.15); color: var(--yellow); }
  .badge-muted { background: rgba(136,136,136,.15); color: var(--muted); }
  .empty { text-align: center; padding: 3rem; color: var(--muted); }
  .ago { color: var(--muted); font-size: .8rem; }
  .error-text { color: var(--red); font-size: .8rem; }
  .refresh-note { color: var(--muted); font-size: .75rem; margin-top: 1rem; }
</style>
</head>
<body>
<h1>SSO Session Keeper</h1>
<p class="subtitle">Active session dashboard &mdash; auto-refreshes every 10s</p>

<div class="stats">
  <div class="stat"><div class="label">Active Sessions</div><div class="value" id="count">—</div></div>
  <div class="stat"><div class="label">Keepalive Interval</div><div class="value" id="interval">—</div></div>
  <div class="stat"><div class="label">Registered Tools</div><div class="value" id="tools">—</div></div>
</div>

<table>
  <thead><tr><th>Tool</th><th>User</th><th>Session</th><th>Keepalive</th><th>Last Ping</th><th>Created</th></tr></thead>
  <tbody id="rows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
</table>
<p class="refresh-note">Last update: <span id="updated">—</span></p>

<script>
function timeAgo(ts, now) {
  if (!ts) return '—';
  const s = Math.floor(now - ts);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm ago';
}

async function refresh() {
  try {
    const [statusResp, toolsResp] = await Promise.all([
      fetch('/sessions/status'), fetch('/tools')
    ]);
    const data = await statusResp.json();
    const tools = await toolsResp.json();
    const now = data.server_time;

    document.getElementById('count').textContent = data.sessions.length;
    document.getElementById('interval').textContent = data.keepalive_interval + 's';
    document.getElementById('tools').textContent = Object.keys(tools).length;

    const tbody = document.getElementById('rows');
    if (data.sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No active sessions</td></tr>';
    } else {
      tbody.innerHTML = data.sessions.map(s => {
        const sessionBadge = s.active
          ? '<span class="badge badge-green">Active</span>'
          : '<span class="badge badge-red">Inactive</span>';

        let kaBadge;
        if (!s.keepalive) {
          kaBadge = '<span class="badge badge-yellow">Pending</span>';
        } else if (s.keepalive.alive) {
          kaBadge = '<span class="badge badge-green">OK</span>';
        } else {
          kaBadge = '<span class="badge badge-red">Failed</span>';
        }

        const lastPing = s.keepalive && s.keepalive.last_ping
          ? '<span class="ago">' + timeAgo(s.keepalive.last_ping, now) + '</span>'
          : '<span class="ago">—</span>';

        const created = s.stored_at
          ? '<span class="ago">' + timeAgo(s.stored_at, now) + '</span>'
          : '<span class="ago">—</span>';

        const errorRow = s.keepalive && s.keepalive.error
          ? '<br><span class="error-text">' + s.keepalive.error + '</span>'
          : '';

        return '<tr><td>' + s.tool_key + '</td><td>' + s.username + '</td><td>'
          + sessionBadge + '</td><td>' + kaBadge + errorRow + '</td><td>'
          + lastPing + '</td><td>' + created + '</td></tr>';
      }).join('');
    }
    document.getElementById('updated').textContent = new Date().toLocaleTimeString();
  } catch(e) {
    console.error('Refresh failed', e);
  }
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
"""
