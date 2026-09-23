# BMW SSO Session Keeper

OpenTPM includes the BMW SSO `session-keeper` service under `services/session-keeper`.
It performs the BMW SSO flow, stores per-user Octane sessions in the Docker-managed
`session-keeper-data` volume, and exposes only the internal Compose address
`http://session-keeper:8090` to the OpenTPM API.

Run the BMW deployment from the repository root:

```bash
docker compose -f deploy-compose.yml up --build -d
```

The deployment builds both `opentpm-api:local` and `opentpm-session-keeper:local`
from the checked-out source. `BMW_SSO_ENABLED` defaults to `true`; set it to `false`
in `.env` to disable BMW SSO.

Do not commit or copy between machines any of these local credential or session
artifacts:

- `services/session-keeper/.env`
- `services/session-keeper/.netrc`
- `services/session-keeper/cookie.txt`
- `services/session-keeper/login_info.txt`
- Docker volume `session-keeper-data`

Each user signs in with their own BMW credentials through OpenTPM. The session keeper
persists only Docker-volume session data so restarts do not immediately require a new
BMW SSO flow.

Verify the internal service without exposing its port publicly:

```bash
docker compose -f deploy-compose.yml exec session-keeper python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8090/health').read().decode())"
```