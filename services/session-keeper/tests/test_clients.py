"""Unit tests for bmw_tools client modules (offline, no network)."""

import json

import pytest

from bmw_tools.appcockpit import (
    AppcockpitClient,
    AppstoreApp,
    AppstoreVersion,
    RolloutConfig,
    TestFleet,
)
from bmw_tools.models import BackendConfig, BackendEnvironment, Ecu, PU
from bmw_tools.vps import VehicleData, VpsClient
from bmw_tools.octane import OctaneClient, OctaneTicket, OctaneAPIError


class TestAppcockpitDataClasses:
    def test_testfleet_from_dict(self):
        tf = TestFleet.from_dict({
            "_id": "abc123",
            "name": "My Fleet",
            "description": "Test fleet",
            "vins": ["VIN1", "VIN2"],
        })
        assert tf.id == "abc123"
        assert tf.name == "My Fleet"
        assert len(tf.vins) == 2
        tf = TestFleet.from_dict({
            "_id": "abc123",
            "name": "My Fleet",
            "description": "Test fleet",
            "vins": ["VIN1", "VIN2"],
        })
        assert tf.id == "abc123"
        assert tf.name == "My Fleet"
        assert len(tf.vins) == 2

    def test_rollout_config_from_dict(self):
        rc = RolloutConfig.from_dict({
            "channel": "STABLE",
            "vinWhitelist": None,
            "hwds": ["IDC23"],
            "maxPu": "03/25",
            "minPu": "03/24",
            "repository": "PROD",
            "state": "RELEASED",
        })
        assert rc.channel == "stable"
        assert rc.environment == "prod"
        assert rc.hwds == [Ecu.IDC23]
        assert rc.min_pu == PU(3, 24)
        assert rc.max_pu == PU(3, 25)

    def test_rollout_config_to_dict(self):
        rc = RolloutConfig(
            channel="stable",
            vin_whitelist=None,
            hwds=[Ecu.IDC23],
            max_pu=PU(3, 25),
            min_pu=PU(3, 24),
            environment="prod",
            state="released",
        )
        d = rc.to_dict()
        assert d["channel"] == "stable"
        assert d["hwds"] == ["idc23"]

    def test_appstore_version_from_dict(self):
        v = AppstoreVersion.from_dict({
            "id": "v1",
            "state": "RELEASED",
            "version": "1.2.3",
            "versionCode": "42",
            "rolloutConfigs": [],
        })
        assert v.id == "v1"
        assert v.state == "released"
        assert v.version_code == 42

    @staticmethod
    def _prod_release_config():
        return RolloutConfig(
            channel="stable",
            vin_whitelist=None,
            hwds=[Ecu.IDC23],
            max_pu=PU(3, 25),
            min_pu=PU(3, 24),
            environment="prod",
            state="released",
        )

    @staticmethod
    def _prod_test_config():
        return RolloutConfig(
            channel="stable",
            vin_whitelist=[{"fleet": "fleet1"}],
            hwds=[Ecu.IDC23],
            max_pu=PU(3, 25),
            min_pu=PU(3, 24),
            environment="prod",
            state="released",
        )

    def test_rollout_config_is_prod_test(self):
        assert self._prod_test_config().is_prod_test is True
        assert self._prod_release_config().is_prod_test is False
        int_config = RolloutConfig(
            channel="stable", vin_whitelist=[{"fleet": "fleet1"}], hwds=[Ecu.IDC23],
            max_pu=PU(3, 25), min_pu=PU(3, 24), environment="int", state="released",
        )
        assert int_config.is_prod_test is False

    def test_version_is_prod_test_when_whitelisted(self):
        v = AppstoreVersion(
            id="v1", state="prod_test_release_completed", version="1.0.0",
            version_code=1, rollout_configs=[self._prod_test_config()],
        )
        assert v.is_prod_test is True
        assert v.is_prod_release is False

    def test_version_prod_release_supersedes_prod_test(self):
        v = AppstoreVersion(
            id="v1", state="rollout_prod", version="1.0.0",
            version_code=1,
            rollout_configs=[self._prod_test_config(), self._prod_release_config()],
        )
        assert v.is_prod_release is True
        assert v.is_prod_test is False

    def test_version_is_prod_test_false_without_prod_configs(self):
        v = AppstoreVersion(
            id="v1", state="e2e_release_completed", version="1.0.0",
            version_code=1, rollout_configs=[],
        )
        assert v.is_prod_test is False

    def test_has_prod_rollout_false_when_not_prod_released(self):
        v = AppstoreVersion(
            id="v1", state="rollout_prod", version="1.0.0",
            version_code=1, rollout_configs=[],
        )
        # State is rollout_prod but there is no released prod config.
        assert v.is_prod_release is False
        assert v.has_prod_rollout is False

    def test_has_prod_rollout_true_when_prod_released_and_state_rollout_prod(self):
        v = AppstoreVersion(
            id="v1", state="rollout_prod", version="1.0.0",
            version_code=1, rollout_configs=[self._prod_release_config()],
        )
        assert v.is_prod_release is True
        assert v.has_prod_rollout is True

    def test_has_prod_rollout_false_when_prod_released_but_not_rollout_state(self):
        v = AppstoreVersion(
            id="v1", state="e2e_release_completed", version="1.0.0",
            version_code=1, rollout_configs=[self._prod_release_config()],
        )
        assert v.is_prod_release is True
        assert v.has_prod_rollout is False


        app = AppstoreApp.from_dict({
            "id": "app1",
            "department": "IDC",
            "description": "Test app",
            "name": "MyApp",
            "packageName": "com.test.app",
            "stableReleasesAllowed": True,
            "isUsingCustomSigning": False,
        })
        assert app.package_name == "com.test.app"
        assert app.stable_releases_allowed is True

    def test_version_string_conversion(self):
        assert AppcockpitClient._convert_version_string("1.2.3") == [1, 2, 3]
        assert AppcockpitClient._convert_version_string("1.2.3-beta") == [1, 2, 3]
        assert AppcockpitClient._convert_version_string("invalid") == [0]


class TestVpsDataClasses:
    def test_vehicle_data_from_vps_dict(self):
        d = {
            "ecu": "MGU_02_A",
            "hwPU": "03/25",
            "swPU": "07/24",
            "swVersion": "24w28.1-1",
            "vin": "WBA12345678901234",
        }
        vd = VehicleData.from_vps_dict(d)
        assert vd.ecu == Ecu.IDC23
        assert vd.hw_pu == PU(3, 25)
        assert vd.sw_pu == PU(7, 24)
        assert vd.vin == "WBA12345678901234"
        assert vd.last_provisioned is None

    def test_vehicle_data_mcp_naming(self):
        d = {
            "ecuName": "IDCEVO25-ANDROID",
            "hwPu": "03/25",
            "swPu": "07/24",
            "swVersion": "1.0",
            "vin": "WBA99999",
        }
        vd = VehicleData.from_vps_dict(d)
        assert vd.ecu == Ecu.IDCEvo

    def test_vps_client_init(self):
        client = VpsClient(environment="int", hub="emea")
        assert "e2e" in client.base_url
        assert "emea" in client.base_url

    def test_vps_client_init_prod(self):
        client = VpsClient(environment="prod", hub="us")
        assert "prod" in client.base_url
        assert "us" in client.base_url

    def test_vps_client_invalid_env(self):
        with pytest.raises(AssertionError):
            VpsClient(environment="staging")

    def test_vps_client_invalid_hub(self):
        with pytest.raises(AssertionError):
            VpsClient(hub="jp")


class TestOctaneClient:
    def test_init(self):
        client = OctaneClient(
            base_url="https://octane.example.com",
            space_id="1001",
            workspace_id="2002",
        )
        assert "1001" in client.api_url
        assert "2002" in client.api_url

    def test_init_with_proxy(self):
        client = OctaneClient(
            base_url="https://octane.example.com",
            space_id="1",
            workspace_id="2",
            proxy="http://proxy:8080",
        )
        assert client.session.proxies["https"] == "http://proxy:8080"

    def test_octane_ticket_repr(self):
        client = OctaneClient("https://x.com", "1", "2")
        ticket = OctaneTicket(12345, {"name": " My Bug ", "client_lock_stamp": "1"}, client)
        assert "12345" in repr(ticket)
        assert "My Bug" in repr(ticket)

    def test_octane_ticket_repr_no_name(self):
        client = OctaneClient("https://x.com", "1", "2")
        ticket = OctaneTicket(99, {"client_lock_stamp": "5"}, client)
        assert "99" in repr(ticket)

    def test_history_to_dict(self):
        history = {
            "data": [
                {
                    "timestamp": "2024-01-15T10:30:00Z",
                    "change_set": [
                        {"field_label": "Status BMW", "value_text": "In Progress"},
                        {"field_label": "Owner", "mode": "REMOVE"},
                    ],
                }
            ]
        }
        result = OctaneClient._history_to_dict(history)
        assert "2024-01-15_10:30:00" in result
        assert result["2024-01-15_10:30:00"]["Status BMW"] == "In Progress"
        assert result["2024-01-15_10:30:00"]["Owner"] == ""


class _FakeResponse:
    """Minimal stand-in for :class:`requests.Response` used by the re-auth tests."""

    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        if isinstance(self._body, str):
            # Mirrors requests: parsing a non-JSON body raises
            # "Expecting value: line 1 column 1 (char 0)".
            return json.loads(self._body)
        return self._body


_APP_LIST_BODY = [{
    "id": "app1",
    "department": "IDC",
    "description": "d",
    "name": "n",
    "packageName": "com.test.app",
    "stableReleasesAllowed": True,
    "isUsingCustomSigning": False,
}]


class TestAppcockpitReauth:
    """Regression tests for session re-authentication on expired-login 500s."""

    def test_request_reauths_on_500_when_session_expired(self, monkeypatch):
        """An expired session surfaces /api/android/apps as a 500 with a non-JSON
        body. The client must detect the invalid session via the user-data endpoint
        (clean 401), re-login and retry — instead of letting resp.json() blow up with
        'Expecting value: line 1 column 1 (char 0)'.
        """
        monkeypatch.setattr("bmw_tools.appcockpit.time.sleep", lambda *_a, **_k: None)

        class _ExpiredSession:
            def get(self, url, **kwargs):
                if "user-view/user-data" in url:
                    return _FakeResponse(401, "Unauthorized")
                return _FakeResponse(500, "<html>Internal Server Error</html>")

        class _LiveSession:
            def get(self, url, **kwargs):
                if "user-view/user-data" in url:
                    return _FakeResponse(200, {"user": "q123456"})
                return _FakeResponse(200, _APP_LIST_BODY)

        client = AppcockpitClient()
        client.session = _ExpiredSession()
        monkeypatch.setattr(client, "_re_login",
                            lambda: setattr(client, "session", _LiveSession()))

        apps = client.get_app_list(wipe_cache=True)

        assert len(apps) == 1
        assert apps[0].package_name == "com.test.app"

    def test_request_does_not_reauth_on_500_when_session_valid(self, monkeypatch):
        """A genuine server-side 500 while the session is still valid (user-data
        returns 200) must NOT trigger a re-login — the 500 is passed through.
        """
        monkeypatch.setattr("bmw_tools.appcockpit.time.sleep", lambda *_a, **_k: None)

        relogins = {"count": 0}

        class _ValidButErroringSession:
            def get(self, url, **kwargs):
                if "user-view/user-data" in url:
                    return _FakeResponse(200, {"user": "q123456"})
                return _FakeResponse(500, "boom")

        client = AppcockpitClient()
        client.session = _ValidButErroringSession()
        monkeypatch.setattr(client, "_re_login",
                            lambda: relogins.__setitem__("count", relogins["count"] + 1))

        resp = client.get("/api/android/apps?onlyDeletable=false")

        assert resp.status_code == 500
        assert relogins["count"] == 0

    def test_re_login_via_cached_session_evicts_then_refreshes(self, monkeypatch):
        """When the client logged in through the Session Keeper, _re_login must
        first DELETE the stale cached session (so the keeper mints a new one on the
        next POST) and then refresh through the keeper — never firing a direct,
        interactive push in this process.
        """
        calls = []

        monkeypatch.setattr(
            "session_keeper.client.delete_cached_session",
            lambda tool_key, username, password: calls.append(("delete", tool_key, username)),
        )

        def _fake_cached(tool_key, username, password, **kwargs):
            calls.append(("cached", tool_key, username))
            return object()

        monkeypatch.setattr("session_keeper.client.cached_sso_session", _fake_cached)

        def _fail_direct(*_a, **_k):
            raise AssertionError("_re_login must not fall back to interactive bmw_sso_session")

        monkeypatch.setattr("bmw_tools.appcockpit.bmw_sso_session", _fail_direct)

        client = AppcockpitClient()
        client._username = "q123456"
        client._password = "pin"
        client._strong_auth = True
        client._strong_auth_type = "mobile"
        client._yubi_key_provider = None
        client._use_cached_session = True

        client._re_login()

        assert calls[0][0] == "delete"
        assert calls[1][0] == "cached"

    def test_re_login_direct_when_not_cached(self, monkeypatch):
        """When the client logged in directly (not via the keeper), _re_login uses
        bmw_sso_session and does not touch the keeper.
        """
        called = {"direct": 0}
        monkeypatch.setattr(
            "bmw_tools.appcockpit.bmw_sso_session",
            lambda *_a, **_k: called.__setitem__("direct", called["direct"] + 1) or object(),
        )

        client = AppcockpitClient()
        client._username = "q123456"
        client._password = "pin"
        client._strong_auth = True
        client._strong_auth_type = "mobile"
        client._yubi_key_provider = None
        client._use_cached_session = False

        client._re_login()

        assert called["direct"] == 1