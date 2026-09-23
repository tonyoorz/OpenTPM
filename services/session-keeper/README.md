# bmw-tools

A Python package that provides:

1. **`bmw_sso`** — BMW intranet Single Sign-On (SSO) session management
2. **`bmw_tools`** — Authenticated clients for BMW internal tools (Appcockpit, VPS, Octane)
3. **`session_keeper`** — A session-caching service that keeps SSO sessions alive, eliminating repeated re-authentication

Handles the ForgeRock AM callback protocol, federated SAML redirects, mobile
push authentication and Yubikey OTP.

---

## Installation

```bash
# From the repository root (editable install — recommended during development)
pip install -e ".[all]"

# Minimal (SSO only)
pip install -e .

# With test dependencies
pip install -e ".[all,test]"
```

### With session keeper service

```bash
pip install -e ".[session-keeper]"
```

---

## Quick start

### SSO session (low-level)

```python
from bmw_sso import bmw_sso_session

session = bmw_sso_session(
    "https://octane-prod.bmwgroup.net",
    username="q123456",
    password="your-tss-password",
)
resp = session.get("https://octane-prod.bmwgroup.net/api/...", verify=False)
```

### Appcockpit client

```python
from bmw_tools.appcockpit import AppcockpitClient

client = AppcockpitClient()
client.login(username="q123456", password="strong-pin", strong_auth=True)

apps = client.get_app_list()
for app in apps:
    print(app.name, app.package_name)
```

### VPS client

```python
from bmw_tools.vps import VpsClient

client = VpsClient(environment="prod", hub="emea")
client.login(username="q123456", password="strong-pin", strong_auth=True)

data = client.get_vehicle_data_for_vin("WBA21EF0805Y27187")
print(data.sw_pu, data.sw_version)
```

### Octane client

```python
from bmw_tools.octane import OctaneClient

client = OctaneClient(
    base_url="https://octane-prod.bmwgroup.net",
    space_id="1001",
    workspace_id="2002",
)
client.login(username="q123456", password="your-tss-password")

tickets = client.get_ticket_list({"Status BMW": "New"}, limit=10)
for t in tickets:
    print(t)
```

### Using API key (Octane)

```python
client.login_with_api_key(client_id="my_api_key", client_secret="secret")
```

---

## Strong authentication

```python
session = bmw_sso_session(
    "https://swhrl.bmwgroup.net",
    username="q123456",
    password="your-strong-auth-pin",
    strong_auth=True,
    strong_auth_type="mobile",   # confirm push on your phone
)
```

### Strong authentication — Yubikey

```python
session = bmw_sso_session(
    "https://appcockpit.bmwgroup.net/auth/authenticate",
    username="q123456",
    password="your-strong-auth-pin",
    strong_auth=True,
    strong_auth_type="yubikey",
    yubi_key_provider=input,   # or a lambda / iterator
)
```

### Reusable auth object (for use with `requests`)

```python
from bmw_sso import BmwIwaAuth
import requests

auth = BmwIwaAuth(tss_name="q123456", tss_password="your-tss-password")
resp = requests.get("https://some-bmw-app.bmwgroup.net/api/...", auth=auth, verify=False)
```

### Credentials from `~/.netrc`

```python
# ~/.netrc
# machine tss.login
#     login  q123456
#     password <tss-password>
# machine twofactor.auth
#     login  q123456
#     password <strong-auth-pin>

from bmw_sso import BmwIwaAuth
auth = BmwIwaAuth()   # reads tss.login from ~/.netrc automatically
```

---

## Supported applications

| Application  | URL                                           | Auth type    |
|-------------|-----------------------------------------------|--------------|
| AppCockpit  | `https://appcockpit.bmwgroup.net`             | Strong       |
| Octane      | `https://octane-prod.bmwgroup.net`            | Weak / Strong |
| SWHRL       | `https://swhrl.bmwgroup.net`                  | Strong       |
| VPS         | `https://vps-emea-prod.bmwgroup.net/vps-admin`| Strong       |

---

## Running the tests

```bash
# Offline tests only (no credentials required)
pytest tests/test_html_parsing.py -v

# All tests (offline + online; needs .netrc; strong-auth tests require mobile push)
pytest -v

# Manual / broken tests (run explicitly)
pytest tests/test_sso_manual.py -v
```

---

## Logging

The package uses Python's standard `logging` module under the logger name
`SSOSession`.  To enable debug output in your application:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
# or just for this package:
logging.getLogger("SSOSession").setLevel(logging.DEBUG)
```

---

## Package layout

```
bmw_sso/
  __init__.py        Public API re-exports
  session.py         bmw_sso_session() + BmwIwaAuth class
  _auth_flow.py      ForgeRock AM callback loop, redirect handling
  _html_utils.py     HTML parsing helpers (BS4 + regex fallback)
session_keeper/
  __init__.py        Package init
  app.py             FastAPI application (endpoints)
  store.py           Session persistence (JSON on disk)
  keepalive.py       Background keep-alive scheduler
  tools.py           Per-tool configuration registry
  client.py          Client wrapper (cached_sso_session)
  __main__.py        Entry point (python -m session_keeper)
  docker/
    Dockerfile.session_keeper
docker-compose.yml   Docker Compose for the session keeper service
tests/
  test_html_parsing.py   Offline unit tests (no credentials needed)
  test_sso.py            Online integration tests
  test_session_keeper.py Session keeper unit tests
  test_sso_manual.py     Broken / manual tests (not collected by default)
pyproject.toml
README.md
```

---

## Session Keeper Service

The session keeper is a long-running service that caches BMW SSO sessions and
keeps them alive in the background.  It solves two pain points:

- **No repeated logins** — especially with strong auth (mobile push), logging
  in takes 10-30 seconds and requires user interaction.  The keeper performs
  the login once and hands out the cached cookies on subsequent requests.
- **Survives restarts** — sessions are persisted to disk as JSON files.  When
  backed by a Docker volume the cache survives container restarts so you don't
  need to re-authenticate every time you redeploy.

### How it works

```
┌──────────┐         POST /sessions/appcockpit         ┌────────────────┐
│  Client  │ ────────────────────────────────────────►  │ Session Keeper │
│ (your    │  { username, password, strong_auth: true } │   (FastAPI)    │
│  app)    │ ◄────────────────────────────────────────  │                │
└──────────┘       { cookies, active: true }            └───────┬────────┘
                                                                │
                                              ┌─────────────────┤
                                              │  Background      │
                                              │  keep-alive loop │
                                              │  (every 2 min)   │
                                              └────────┬─────────┘
                                                       │  GET keepalive_url
                                                       ▼
                                              ┌─────────────────┐
                                              │  BMW SSO / Tool  │
                                              │  (AppCockpit,    │
                                              │   VPS, Octane…)  │
                                              └─────────────────┘
```

1. A client calls `POST /sessions/{tool_key}` with credentials.
2. If a cached session exists **and** the credentials match, the stored cookies
   are returned immediately — no SSO round-trip.
3. If no valid session exists, the service performs the full SSO login flow
   (ForgeRock callbacks, strong auth, SAML redirects) and stores the result.
4. A background asyncio task pings each session's keep-alive URL every
   **2 minutes** (configurable via `KEEPALIVE_INTERVAL_SECONDS`).  This
   prevents BMW SSO from expiring the session due to inactivity.
5. If a keep-alive ping fails (redirect to login page, HTTP error), the
   session is automatically removed and a fresh login is required on the next
   request.

### Multi-user support

Sessions are keyed by `(tool_key, username)`.  Multiple users can maintain
independent sessions for the same tool simultaneously.  Credentials are
validated on every request using a stored SHA-256 password hash — a request
with the wrong password will trigger a new login rather than return another
user's session.

### Running the service

```bash
# Via Docker Compose (recommended)
cd BmwLogin
docker compose up --build

# Or directly (requires the session-keeper extra)
pip install -e ".[session-keeper]"
python -m session_keeper
```

The service listens on port **8090** by default.

### Docker deployment

The included `docker-compose.yml` provides a production-ready setup:

```yaml
services:
  session-keeper:
    build:
      context: .
      dockerfile: docker/Dockerfile.session_keeper
    ports:
      - "8090:8090"
    volumes:
      - session_data:/data/sessions   # persists sessions across restarts
    environment:
      - KEEPALIVE_INTERVAL_SECONDS=120
      - SESSION_STORE_DIR=/data/sessions
```

> **Proxy note:** Docker Desktop may inject corporate proxy env vars
> (`HTTP_PROXY` / `HTTPS_PROXY`) into containers.  BMW internal tools are
> only reachable **without** a proxy.  The docker-compose file clears these
> variables automatically.  The service also creates login sessions with
> `trust_env=False` as a safety net.

### API endpoints

| Method   | Path                    | Description                                  |
|----------|-------------------------|----------------------------------------------|
| `GET`    | `/health`               | Health check (returns active session count)   |
| `GET`    | `/tools`                | List all registered tools and their config    |
| `GET`    | `/sessions`             | List active sessions (tool, user, cookie count) |
| `POST`   | `/sessions/{tool_key}`  | Get or create a session (credentials required) |
| `DELETE` | `/sessions/{tool_key}`  | Remove a stored session (credentials required) |

#### `POST /sessions/{tool_key}` — request body

```json
{
    "username": "q123456",
    "password": "strong-auth-pin",
    "strong_auth": true,
    "strong_auth_type": "mobile"
}
```

#### `POST /sessions/{tool_key}` — response

```json
{
    "tool_key": "appcockpit",
    "username": "q123456",
    "cookies": [
        { "name": "iPlanetDirectoryPro", "value": "…", "domain": ".bmwgroup.net", "path": "/" }
    ],
    "active": true
}
```

### Using the client wrapper

The `cached_sso_session()` helper provides a transparent fallback — it tries
the keeper service first and falls back to a direct `bmw_sso_session()` call
if the service is unreachable:

```python
from session_keeper.client import cached_sso_session

session = cached_sso_session(
    tool_key="appcockpit",
    username="q123456",
    password="strong-pin",
    strong_auth=True,
)

# Use the session like any requests.Session
resp = session.get("https://appcockpit.bmwgroup.net/api/...", verify=False)
```

Set the `SESSION_KEEPER_URL` environment variable to point to the service
(default: `http://localhost:8090`).

### Registering custom tools

Additional tools can be registered by providing a JSON config file:

```bash
export SESSION_KEEPER_TOOLS_CONFIG=/path/to/extra_tools.json
```

```json
[
    {
        "key": "my_internal_tool",
        "app_url": "https://my-tool.bmwgroup.net/login",
        "keepalive_url": "https://my-tool.bmwgroup.net/home",
        "strong_auth": true,
        "strong_auth_type": "mobile"
    }
]
```

### Built-in tools

| Tool Key         | App URL                             | Keep-alive URL       | Strong Auth |
|------------------|-------------------------------------|----------------------|-------------|
| `appcockpit`     | `appcockpit.bmwgroup.net`           | `/home`              | Yes         |
| `vps_emea_prod`  | `vps-emea-prod.bmwgroup.net`        | `/vps-admin/home`    | Yes         |
| `vps_emea_int`   | `vps-emea-e2e.bmwgroup.net`         | `/vps-admin/home`    | Yes         |
| `vps_us_prod`    | `vps-us-prod.bmwgroup.net`          | `/vps-admin/home`    | Yes         |
| `vps_cn_prod`    | `vps-cn-prod.bmwgroup.net`          | `/vps-admin/home`    | Yes         |
| `octane`         | `octane-prod.bmwgroup.net`          | `/ui/?p=1002/2001`   | No          |

### Configuration

| Env Variable                   | Default             | Description                                   |
|-------------------------------|---------------------|-----------------------------------------------|
| `SESSION_STORE_DIR`           | `/data/sessions`    | Directory for persisted session JSON files     |
| `SESSION_KEEPER_URL`          | `http://localhost:8090` | Service URL (used by the client wrapper)   |
| `KEEPALIVE_INTERVAL_SECONDS`  | `120`               | Seconds between keep-alive pings               |
| `SESSION_KEEPER_TOOLS_CONFIG` | —                   | Path to JSON file with extra tool definitions  |
| `LOG_LEVEL`                   | `INFO`              | Logging level for the service                  |
