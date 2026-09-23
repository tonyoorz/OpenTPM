"""
Online integration tests for the BMW SSO session.

Requires:
  - Network access to BMW intranet
  - A ``~/.netrc`` file::

        machine tss.login
            login  q123456
            password <your-tss-password>

        machine twofactor.auth
            login  q123456
            password <your-strong-auth-pin>

  - Strong-auth tests require you to confirm the mobile push notification.

Run via pytest or directly via PyCharm (right-click → Run).
"""
import json
import unittest
from netrc import netrc

import requests

from bmw_sso import BmwIwaAuth, bmw_sso_session


def _load_credentials():
    """Load credentials from ~/.netrc, raising AssertionError on failure."""
    try:
        n = netrc()
    except Exception as e:
        raise AssertionError(f"Could not read ~/.netrc: {e}") from e
    tss_login = n.authenticators("tss.login")
    if not tss_login:
        raise AssertionError(".netrc has no 'tss.login' entry")
    two_factor = n.authenticators("twofactor.auth")
    return {
        "username": tss_login[0],
        "password": tss_login[2],
        "pin": two_factor[2] if two_factor else None,
    }


def _verify_login(session: requests.Session, test_url: str, required_field: str):
    """Assert that *session* can reach *test_url* and the response contains *required_field*."""
    resp = session.get(test_url, verify=False)
    assert resp.status_code == 200, f"Expected HTTP 200, got {resp.status_code}"
    try:
        data = json.loads(resp.text)
    except json.JSONDecodeError:
        raise AssertionError(f"Response is not valid JSON: {resp.text[:500]}")
    assert required_field in data, f"'{required_field}' not found in response: {data}"


class TestSSOWeakAuth(unittest.TestCase):
    """Tests that only require the TSS password (weak / single-factor auth)."""

    @classmethod
    def setUpClass(cls):
        cls.creds = _load_credentials()

    def test_octane_weak_auth(self):
        """Octane should be accessible with weak authentication."""
        username = self.creds["username"]
        session = bmw_sso_session(
            "https://octane-prod.bmwgroup.net",
            username=username,
            password=self.creds["password"],
            strong_auth=False,
        )
        _verify_login(
            session,
            "https://octane-prod.bmwgroup.net/api/shared_spaces",
            "data",
        )

    def test_octane_iwa_auth(self):
        """BmwIwaAuth object should authenticate and give access to Octane."""
        username = self.creds["username"]
        auth = BmwIwaAuth(tss_name=username, tss_password=self.creds["password"])
        target = "https://octane-prod.bmwgroup.net/api/shared_spaces"
        resp = requests.get(target, auth=auth, verify=False)
        self.assertEqual(resp.status_code, 200, f"Expected HTTP 200, got {resp.status_code}")
        data = json.loads(resp.text)
        self.assertIn("data", data, f"'data' not found in response: {data}")


class TestSSOStrongAuth(unittest.TestCase):
    """Tests that require strong authentication (mobile push — confirm on your phone)."""

    @classmethod
    def setUpClass(cls):
        cls.creds = _load_credentials()

    def test_octane_strong_auth(self):
        """Octane with strong auth via the intranetb2x → alpha federated flow."""
        username = self.creds["username"]
        session = bmw_sso_session(
            "https://octane-prod.bmwgroup.net",
            username=username,
            password=self.creds["pin"],
            strong_auth=True,
            strong_auth_type="mobile",
        )
        _verify_login(
            session,
            "https://octane-prod.bmwgroup.net/api/shared_spaces",
            "data",
        )


    def test_swhrl_iwa_auth(self):
        """BmwIwaAuth object should work for SWHRL (strong auth, mobile push)."""
        auth = BmwIwaAuth(tss_name=self.creds["username"], strong_pin=self.creds["pin"])
        resp = requests.get(
            "https://swhrl.bmwgroup.net/webapi/hrlres/build-version",
            auth=auth,
            verify=False,
        )
        self.assertEqual(resp.status_code, 200, f"Expected HTTP 200, got {resp.status_code}")
        data = json.loads(resp.text)
        self.assertIn("version", data, f"'version' not found in SWHRL response: {data}")

    def test_appcockpit_strong_auth(self):
        """AppCockpit should be accessible with strong authentication."""
        username = self.creds["username"]
        session = bmw_sso_session(
            "https://appcockpit.bmwgroup.net/auth/authenticate",
            username=username,
            password=self.creds["pin"],
            strong_auth=True,
            strong_auth_type="mobile",
        )
        _verify_login(
            session,
            "https://appcockpit.bmwgroup.net/api/oap/user-view/user-data",
            "profile",
        )

    def test_vps(self):
        """VPS uses federated auth: intranetb2x → RedirectCallback → alpha realm."""
        session = bmw_sso_session(
            "https://vps-emea-prod.bmwgroup.net/vps-admin/home",
            username=self.creds["username"],
            password=self.creds["pin"],
            strong_auth=True,
            strong_auth_type="mobile",
        )
        session.post("https://vps-emea-prod.bmwgroup.net/vps-admin/vpsproxy/authentication", verify=False)
        resp = session.post(
            "https://vps-emea-prod.bmwgroup.net/vps-admin/vpsproxy/authentication/getCredentials",
            json={"withCredentials": True},
            verify=False,
            allow_redirects=False,
        )
        self.assertEqual(resp.status_code, 200, f"VPS getCredentials failed: {resp.status_code}")
        data = json.loads(resp.text)
        self.assertIn("token", data, f"'token' not found in VPS credentials response: {list(data.keys())}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
