"""
bmw_sso — BMW SSO session helper
=================================

Quick start::

    from bmw_sso import bmw_sso_session

    session = bmw_sso_session(
        "https://some-bmw-app.bmwgroup.net",
        username="q123456",
        password="your-tss-password",
    )
    resp = session.get("https://some-bmw-app.bmwgroup.net/api/...", verify=False)

For strong authentication::

    session = bmw_sso_session(
        "https://some-bmw-app.bmwgroup.net",
        username="q123456",
        password="your-strong-auth-pin",
        strong_auth=True,
        strong_auth_type="mobile",   # or "yubikey"
    )

Using the auth object::

    from bmw_sso import BmwIwaAuth
    import requests

    auth = BmwIwaAuth(tss_name="q123456", tss_password="your-tss-password")
    resp = requests.get("https://some-bmw-app.bmwgroup.net/api/...", auth=auth, verify=False)
"""

from bmw_sso._auth_flow import TAN_LIST, AuthenticationError
from bmw_sso._logging import VERBOSE, configure_file_logging
from bmw_sso.session import BmwIwaAuth, bmw_sso_session

__all__ = ["bmw_sso_session", "BmwIwaAuth", "TAN_LIST", "AuthenticationError", "VERBOSE", "configure_file_logging"]
