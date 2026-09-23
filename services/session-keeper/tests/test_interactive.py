"""
Interactive integration tests — require live BMW SSO login.

Run with:  pytest -m interactive --no-header -rN

These tests will trigger the BMW SSO authentication flow, which requires
the user to confirm login (e.g. via mobile push or Yubikey). They are
excluded from the default test run via pytest.ini addopts.
"""

import logging
import os

import pytest

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

# These tests need credentials. They read from environment variables or skip.
# Set BMW_TEST_USERNAME and BMW_TEST_PASSWORD to run.

pytestmark = pytest.mark.interactive


def _get_credentials():
    username = os.environ.get("BMW_TEST_USERNAME")
    password = os.environ.get("BMW_TEST_PASSWORD")
    if not username or not password:
        pytest.skip("BMW_TEST_USERNAME / BMW_TEST_PASSWORD not set")
    return username, password


class TestAppcockpitIntegration:
    """Integration tests for AppcockpitClient (read-only)."""

    def test_login_and_get_app_list(self):
        from bmw_tools.appcockpit import AppcockpitClient

        username, password = _get_credentials()
        client = AppcockpitClient()
        client.login(username=username, password=password, strong_auth=True, strong_auth_type="mobile")

        assert client.is_logged_in()
        apps = client.get_app_list()
        assert len(apps) > 0
        assert apps[0].name  # has a name

    def test_login_and_get_testfleets(self):
        from bmw_tools.appcockpit import AppcockpitClient

        username, password = _get_credentials()
        client = AppcockpitClient()
        client.login(username=username, password=password, strong_auth=True, strong_auth_type="mobile")

        fleets = client.get_testfleets()
        assert len(fleets) > 0
        assert fleets[0].id


class TestVpsIntegration:
    """Integration tests for VpsClient (read-only)."""

    def test_login_and_get_vehicle_data(self):
        from bmw_tools.vps import VpsClient

        username, password = _get_credentials()
        client = VpsClient(environment="prod", hub="emea")
        client.login(username=username, password=password, strong_auth=True, strong_auth_type="mobile")

        # Use a known test VIN — this may need updating
        # Just verify the call doesn't crash; vehicle may not exist
        result = client.get_vehicle_data_for_vin("WBA21EF0805Y27187")
        # Result can be None if vehicle not found, but call should succeed
        assert result is None or result.vin == "WBA21EF0805Y27187"


class TestOctaneIntegration:
    """Integration tests for OctaneClient (read-only)."""

    def test_login_and_get_ticket(self):
        from bmw_tools.octane import OctaneClient

        username, password = _get_credentials()

        # Use INT environment for testing
        client = OctaneClient(
            base_url="https://octane-int.2e2.2e2-2e2.2.2.2.2.2.2.2.2.bmwgroup.net",
            space_id="1001",
            workspace_id="1002",
        )
        client.login(username=username, password=password)

        # Just verify login succeeded
        assert client.octane_user is not None
        assert client.octane_user.get("name")
