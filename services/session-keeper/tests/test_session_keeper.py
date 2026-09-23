"""Tests for the session keeper store, API, keep-alive, and client wrapper."""

import json
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

from session_keeper.store import SessionStore, _hash_password
from session_keeper.tools import ToolConfig, TOOL_REGISTRY, get_tool, list_tools


# ------------------------------------------------------------------ #
# SessionStore                                                       #
# ------------------------------------------------------------------ #


class TestSessionStore:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.store = SessionStore(store_dir=self.tmpdir)

    def test_put_and_get(self):
        session = requests.Session()
        session.cookies.set("tok", "abc123", domain=".example.com", path="/")
        self.store.put("test_tool", "q123", "pass", session)

        retrieved = self.store.get("test_tool", "q123")
        assert retrieved is not None
        assert retrieved.cookies.get("tok") == "abc123"

    def test_get_missing(self):
        assert self.store.get("nonexistent", "q123") is None

    def test_validate_and_get_correct_password(self):
        session = requests.Session()
        session.cookies.set("tok", "val", domain=".example.com")
        self.store.put("tool_a", "q123", "correct_pass", session)
        result = self.store.validate_and_get("tool_a", "q123", "correct_pass")
        assert result is not None
        assert result.cookies.get("tok") == "val"

    def test_validate_and_get_wrong_password(self):
        session = requests.Session()
        session.cookies.set("tok", "val", domain=".example.com")
        self.store.put("tool_a", "q123", "correct_pass", session)
        result = self.store.validate_and_get("tool_a", "q123", "wrong_pass")
        assert result is None

    def test_validate_and_get_wrong_user(self):
        session = requests.Session()
        session.cookies.set("tok", "val", domain=".example.com")
        self.store.put("tool_a", "q123", "pass", session)
        result = self.store.validate_and_get("tool_a", "q999", "pass")
        assert result is None

    def test_multi_user_isolation(self):
        s1 = requests.Session()
        s1.cookies.set("tok", "user1", domain=".example.com")
        s2 = requests.Session()
        s2.cookies.set("tok", "user2", domain=".example.com")

        self.store.put("appcockpit", "q001", "pass1", s1)
        self.store.put("appcockpit", "q002", "pass2", s2)

        r1 = self.store.validate_and_get("appcockpit", "q001", "pass1")
        r2 = self.store.validate_and_get("appcockpit", "q002", "pass2")
        assert r1.cookies.get("tok") == "user1"
        assert r2.cookies.get("tok") == "user2"

    def test_delete(self):
        session = requests.Session()
        session.cookies.set("tok", "val", domain=".example.com")
        self.store.put("tool_a", "q123", "pass", session)
        assert self.store.delete("tool_a", "q123") is True
        assert self.store.get("tool_a", "q123") is None
        assert self.store.delete("tool_a", "q123") is False

    def test_keys(self):
        s1 = requests.Session()
        s1.cookies.set("a", "1", domain=".a.com")
        s2 = requests.Session()
        s2.cookies.set("b", "2", domain=".b.com")
        self.store.put("alpha", "q1", "p1", s1)
        self.store.put("beta", "q2", "p2", s2)
        assert sorted(self.store.keys()) == ["alpha::q1", "beta::q2"]

    def test_persistence_across_instances(self):
        session = requests.Session()
        session.cookies.set("persist", "yes", domain=".test.com", path="/x")
        self.store.put("persist_tool", "q123", "mypass", session)

        # Create a new store pointed at the same directory
        store2 = SessionStore(store_dir=self.tmpdir)
        retrieved = store2.validate_and_get("persist_tool", "q123", "mypass")
        assert retrieved is not None
        assert retrieved.cookies.get("persist") == "yes"

    def test_persistence_rejects_wrong_password(self):
        session = requests.Session()
        session.cookies.set("persist", "yes", domain=".test.com")
        self.store.put("tool_x", "q123", "realpass", session)

        store2 = SessionStore(store_dir=self.tmpdir)
        assert store2.validate_and_get("tool_x", "q123", "wrongpass") is None

    def test_cookies_to_dict_roundtrip(self):
        session = requests.Session()
        session.cookies.set("c1", "v1", domain=".d.com", path="/p")
        session.cookies.set("c2", "v2", domain=".e.com", path="/q")
        cookies = SessionStore._cookies_to_dict(session)
        restored = SessionStore._dict_to_session(cookies)
        assert restored.cookies.get("c1") == "v1"
        assert restored.cookies.get("c2") == "v2"


# ------------------------------------------------------------------ #
# ToolConfig                                                         #
# ------------------------------------------------------------------ #


class TestToolConfig:
    def test_get_tool(self):
        tool = get_tool("appcockpit")
        assert tool is not None
        assert tool.strong_auth is True
        assert "appcockpit" in tool.keepalive_url

    def test_list_tools(self):
        tools = list_tools()
        assert "appcockpit" in tools
        assert "octane" in tools
        assert "vps_emea_prod" in tools

    def test_to_dict(self):
        tool = get_tool("octane")
        d = tool.to_dict()
        assert d["key"] == "octane"
        assert d["strong_auth"] is False


# ------------------------------------------------------------------ #
# FastAPI endpoints                                                  #
# ------------------------------------------------------------------ #


class TestAPI:
    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path):
        # Patch the store to use a temp directory
        with patch("session_keeper.app.store", SessionStore(store_dir=str(tmp_path))):
            from fastapi.testclient import TestClient
            from session_keeper.app import app
            self.client = TestClient(app)
            yield

    def test_health(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_list_tools(self):
        resp = self.client.get("/tools")
        assert resp.status_code == 200
        assert "appcockpit" in resp.json()

    def test_get_session_not_found(self):
        resp = self.client.post(
            "/sessions/nonexistent",
            json={"username": "q123", "password": "pass"},
        )
        assert resp.status_code == 404

    def test_delete_session_not_found(self):
        resp = self.client.request(
            "DELETE", "/sessions/appcockpit",
            json={"username": "q123", "password": "pass"},
        )
        assert resp.status_code == 404

    def test_create_session_unknown_tool(self):
        resp = self.client.post(
            "/sessions/unknown_tool_xyz",
            json={"username": "q123", "password": "pass"},
        )
        assert resp.status_code == 404

    def test_create_and_get_session(self):
        mock_session = requests.Session()
        mock_session.cookies.set("sso_tok", "mocked", domain=".bmwgroup.net")
        with patch("session_keeper.app._do_login", return_value=mock_session):
            resp = self.client.post(
                "/sessions/appcockpit",
                json={"username": "q123", "password": "pin", "strong_auth": True},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["tool_key"] == "appcockpit"
            assert data["username"] == "q123"
            assert data["active"] is True
            assert any(c["name"] == "sso_tok" for c in data["cookies"])

        # Retrieve with same credentials (should return cached)
        resp = self.client.post(
            "/sessions/appcockpit",
            json={"username": "q123", "password": "pin"},
        )
        assert resp.status_code == 200
        assert any(c["name"] == "sso_tok" for c in resp.json()["cookies"])

    def test_wrong_password_triggers_new_login(self):
        mock_session = requests.Session()
        mock_session.cookies.set("tok", "original", domain=".bmwgroup.net")
        with patch("session_keeper.app._do_login", return_value=mock_session):
            self.client.post(
                "/sessions/appcockpit",
                json={"username": "q123", "password": "correct_pin", "strong_auth": True},
            )

        # Different password → no cached session → triggers new login
        new_session = requests.Session()
        new_session.cookies.set("tok", "new_login", domain=".bmwgroup.net")
        with patch("session_keeper.app._do_login", return_value=new_session):
            resp = self.client.post(
                "/sessions/appcockpit",
                json={"username": "q123", "password": "new_pin", "strong_auth": True},
            )
            assert resp.status_code == 200
            assert any(c["value"] == "new_login" for c in resp.json()["cookies"])

    def test_multi_user_sessions(self):
        s1 = requests.Session()
        s1.cookies.set("tok", "user1_tok", domain=".bmwgroup.net")
        s2 = requests.Session()
        s2.cookies.set("tok", "user2_tok", domain=".bmwgroup.net")

        with patch("session_keeper.app._do_login", return_value=s1):
            self.client.post("/sessions/octane", json={"username": "q001", "password": "p1"})
        with patch("session_keeper.app._do_login", return_value=s2):
            self.client.post("/sessions/octane", json={"username": "q002", "password": "p2"})

        # Each user gets their own session
        r1 = self.client.post("/sessions/octane", json={"username": "q001", "password": "p1"})
        r2 = self.client.post("/sessions/octane", json={"username": "q002", "password": "p2"})
        assert any(c["value"] == "user1_tok" for c in r1.json()["cookies"])
        assert any(c["value"] == "user2_tok" for c in r2.json()["cookies"])

    def test_delete_session(self):
        mock_session = requests.Session()
        mock_session.cookies.set("tok", "val", domain=".bmwgroup.net")
        with patch("session_keeper.app._do_login", return_value=mock_session):
            self.client.post(
                "/sessions/octane",
                json={"username": "q1", "password": "p"},
            )
        resp = self.client.request(
            "DELETE", "/sessions/octane",
            json={"username": "q1", "password": "p"},
        )
        assert resp.status_code == 200

    def test_delete_wrong_credentials(self):
        mock_session = requests.Session()
        mock_session.cookies.set("tok", "val", domain=".bmwgroup.net")
        with patch("session_keeper.app._do_login", return_value=mock_session):
            self.client.post(
                "/sessions/octane",
                json={"username": "q1", "password": "correct"},
            )
        resp = self.client.request(
            "DELETE", "/sessions/octane",
            json={"username": "q1", "password": "wrong"},
        )
        assert resp.status_code == 404


# ------------------------------------------------------------------ #
# Keep-alive _ping                                                   #
# ------------------------------------------------------------------ #


class TestPing:
    def test_ping_200(self):
        from session_keeper.keepalive import _ping

        session = MagicMock()
        resp = MagicMock()
        resp.status_code = 200
        session.get.return_value = resp
        assert _ping(session, "https://example.com/home") is True

    def test_ping_redirect_to_login(self):
        from session_keeper.keepalive import _ping

        session = MagicMock()
        resp = MagicMock()
        resp.status_code = 302
        resp.headers = {"Location": "https://auth.bmwgroup.net/auth/login"}
        session.get.return_value = resp
        assert _ping(session, "https://example.com/home") is False

    def test_ping_redirect_non_auth(self):
        from session_keeper.keepalive import _ping

        session = MagicMock()
        resp_redirect = MagicMock()
        resp_redirect.status_code = 302
        resp_redirect.headers = {"Location": "https://example.com/dashboard"}
        resp_follow = MagicMock()
        resp_follow.status_code = 200
        session.get.side_effect = [resp_redirect, resp_follow]
        assert _ping(session, "https://example.com/home") is True


# ------------------------------------------------------------------ #
# Client wrapper                                                     #
# ------------------------------------------------------------------ #


class TestClient:
    def test_get_or_create_session_unavailable(self):
        from session_keeper.client import get_or_create_session

        # Service not running → should return None gracefully
        result = get_or_create_session("appcockpit", "q123", "pin")
        assert result is None

    def test_cached_sso_session_falls_back(self):
        from session_keeper.client import cached_sso_session

        mock_session = requests.Session()
        mock_session.cookies.set("tok", "local", domain=".bmwgroup.net")
        with patch("session_keeper.client.get_or_create_session", return_value=None), \
             patch("bmw_sso.bmw_sso_session", return_value=mock_session):
            result = cached_sso_session(
                tool_key="appcockpit",
                username="q123",
                password="pin",
                strong_auth=True,
            )
            assert result.cookies.get("tok") == "local"

    def test_cached_sso_session_uses_service(self):
        from session_keeper.client import cached_sso_session

        cached = requests.Session()
        cached.cookies.set("cached_tok", "from_service", domain=".bmwgroup.net")
        with patch("session_keeper.client.get_or_create_session", return_value=cached):
            result = cached_sso_session(
                tool_key="appcockpit",
                username="q123",
                password="pin",
            )
            assert result.cookies.get("cached_tok") == "from_service"


# ------------------------------------------------------------------ #
# Proxy bypass                                                       #
# ------------------------------------------------------------------ #


class TestProxyBypass:
    """Regression: _do_login must not use HTTP proxies for BMW internal tools.

    Docker Desktop injects HTTP_PROXY / HTTPS_PROXY into every container.
    The session keeper connects to internal BMW hosts which are unreachable
    through the proxy → ProxyError / 503 Service Unavailable.
    """

    def test_do_login_creates_session_with_trust_env_false(self):
        """The session passed to bmw_sso_session must have trust_env=False
        so that proxy environment variables are ignored."""
        from session_keeper.app import _do_login

        captured = {}

        def fake_sso_session(*args, **kwargs):
            captured["session"] = kwargs.get("session")
            return kwargs.get("session") or requests.Session()

        with patch("bmw_sso.bmw_sso_session", side_effect=fake_sso_session):
            _do_login("https://example.bmwgroup.net", "q123", "pass", False, "mobile")

        assert captured["session"] is not None, "_do_login must pass a session to bmw_sso_session"
        assert captured["session"].trust_env is False, "session.trust_env must be False to bypass proxy"

    def test_do_login_ignores_proxy_env_vars(self, monkeypatch):
        """Even with proxy env vars set, the login session must not use them."""
        from session_keeper.app import _do_login

        monkeypatch.setenv("HTTP_PROXY", "http://broken-proxy:9999")
        monkeypatch.setenv("HTTPS_PROXY", "http://broken-proxy:9999")

        captured = {}

        def fake_sso_session(*args, **kwargs):
            captured["session"] = kwargs.get("session")
            return kwargs.get("session") or requests.Session()

        with patch("bmw_sso.bmw_sso_session", side_effect=fake_sso_session):
            _do_login("https://vps-emea-prod.bmwgroup.net", "q123", "pass", False, "mobile")

        session = captured["session"]
        # Resolve proxies for the target URL — must be empty
        proxies = session.resolve_redirects.__self__.merge_environment_settings(
            "https://vps-emea-prod.bmwgroup.net", {}, False, False, None
        ) if hasattr(session, "merge_environment_settings") else None
        # Simpler: just verify trust_env is off and no explicit proxy set
        assert session.trust_env is False
        assert not session.proxies
