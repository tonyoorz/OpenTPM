"""
Public API of the BMW SSO package.

The two names you normally need are:

* :func:`bmw_sso_session` — create a logged-in :class:`requests.Session`
* :class:`BmwIwaAuth` — a ``requests`` auth object for use with any request
"""
import functools
import json
import logging
import time
import urllib.parse
from netrc import netrc
from typing import Callable, Dict, Iterator, Union

import requests

from bmw_sso._auth_flow import (
    _callback_iteration,
    _follow_forms_and_redirects,
    _get_request_url,
    _get_yubi_pin,
    _handle_redirect_callback,
    _parse_get_parameters,
)
from bmw_sso._html_utils import (
    _get_hidden_inputs,
    _process_auto_form,
    _process_auto_redirect,
)
from bmw_sso._logging import VERBOSE

log = logging.getLogger("SSOSession")


def bmw_sso_session(
    app_url: str,
    username: str,
    password: str,
    strong_auth: bool = False,
    strong_auth_type: str = "mobile",
    yubi_key_provider: Union[Callable, Iterator, int, str] = None,
    session: requests.Session = None,
) -> requests.Session:
    """
    Create a :class:`requests.Session` that is already authenticated via BMW
    SSO and can access internal BMW APIs.

    :param app_url:
        URL of the app you want to reach. It must redirect to the SSO login page
        when accessed without a session cookie.
    :param username:
        Your Q-number (e.g. ``q123456``).
    :param password:
        Your TSS password (weak auth) or strong-auth PIN (mobile / yubikey).
    :param strong_auth:
        Whether to use strong authentication. Some applications require it,
        others do not support it.
    :param strong_auth_type:
        ``"mobile"`` (default) or ``"yubikey"``. Only used when *strong_auth*
        is ``True``.
    :param yubi_key_provider:
        Yubikey OTP — an ``int``, ``str``, a callable or an iterator that
        provides the next six-digit OTP.  Only used when *strong_auth_type* is
        ``"yubikey"``.
    :param session:
        An existing :class:`requests.Session` to reuse.  A new one is created
        when ``None`` (the default).
    :return:
        The session in a logged-in state.
    """
    base_url = "https://auth.bmwgroup.net/auth/json/realms/root/realms/intranetb2x/authenticate"
    if "appcockpit" in app_url:
        base_url = "https://emea.prod.alpha.sso.bmwgroup.com/auth/json/realms/root/realms/alpha/authenticate"

    log.log(VERBOSE, "bmw_sso_session: app_url=%s strong_auth=%s strong_auth_type=%s base_url=%s",
            app_url, strong_auth, strong_auth_type, base_url)

    if session is None:
        session = requests.Session()
        log.log(VERBOSE, "bmw_sso_session: created new requests.Session")
    else:
        log.log(VERBOSE, "bmw_sso_session: reusing provided session (cookies: %s)",
                list(session.cookies.keys()))

    # ------------------------------------------------------------------ #
    # Step 1 — open the app and get redirected to the SSO login page      #
    # ------------------------------------------------------------------ #
    log.debug("Step 1: Opening app URL: %s", app_url)
    resp = session.get(app_url, allow_redirects=True, verify=False)
    redirected_app_url = resp.url
    log.log(VERBOSE, "Step 1: HTTP %d, final URL after redirects: %s", resp.status_code, redirected_app_url)
    log.log(VERBOSE, "Step 1: response headers: %s", dict(resp.headers))

    # ------------------------------------------------------------------ #
    # Step 2 — parse SSO auth URL parameters                             #
    # ------------------------------------------------------------------ #
    log.debug("Step 2: Parsing SSO parameters")

    # Check if Step 1 landed directly on a ForgeRock JSON authenticate endpoint
    initial_auth_bundle = None
    try:
        initial_json = json.loads(resp.text)
        if "authId" in initial_json and "callbacks" in initial_json:
            # Direct JSON endpoint — derive base_url and params from the URL
            parsed_redirect = urllib.parse.urlparse(redirected_app_url)
            base_url = f"{parsed_redirect.scheme}://{parsed_redirect.netloc}{parsed_redirect.path}"
            get_params = _parse_get_parameters(redirected_app_url)
            initial_auth_bundle = initial_json
            log.log(VERBOSE, "Step 2: landed on direct JSON auth endpoint: %s", base_url)
    except (json.JSONDecodeError, ValueError, KeyError):
        pass

    if initial_auth_bundle is None:
        resp = _process_auto_form(resp.text, session, base_url=redirected_app_url)
        if resp:
            log.log(VERBOSE, "Step 2: auto-form followed → %s (HTTP %d)", resp.url, resp.status_code)
            hidden_inputs = _get_hidden_inputs(resp.text)
            log.log(VERBOSE, "Step 2: hidden inputs found: %s", list(hidden_inputs.keys()))
        else:
            log.log(VERBOSE, "Step 2: no auto-form found on initial page")
            hidden_inputs = {}
        if resp and hidden_inputs and "loginUrl" in hidden_inputs:
            login_url = hidden_inputs["loginUrl"]
            log.log(VERBOSE, "Step 2: loginUrl from hidden inputs: %s", login_url)
            get_params = _parse_get_parameters(login_url)
            # Derive base_url from the loginUrl host + realm parameter
            parsed_login = urllib.parse.urlparse(login_url)
            realm_name = get_params.get("realm", "/intranetb2x").strip("/")
            base_url = (
                f"{parsed_login.scheme}://{parsed_login.netloc}"
                f"/auth/json/realms/root/realms/{realm_name}/authenticate"
            )
            log.log(VERBOSE, "Step 2: derived base_url from loginUrl: %s (realm=%s)", base_url, realm_name)
        else:
            log.log(VERBOSE, "Step 2: no loginUrl — using goto fallback: %s", redirected_app_url)
            get_params = {"goto": redirected_app_url}

    if strong_auth and "authIndexType" not in get_params:
        get_params.update({"authIndexType": "service", "authIndexValue": "strongAuth4000Service"})
        log.log(VERBOSE, "Step 2: injected strong-auth params into get_params")
    if "realm" in get_params:
        log.log(VERBOSE, "Step 2: dropping 'realm' param (was: %s)", get_params["realm"])
        del get_params["realm"]
    if "AMAuthCookie" not in get_params:
        get_params["AMAuthCookie"] = ""
    auth_url = _get_request_url(base_url, request_params=get_params)
    log.debug("Constructed auth_url: %s", auth_url)

    # ------------------------------------------------------------------ #
    # Step 3 — callback iterations (ForgeRock AM authentication tree)    #
    # ------------------------------------------------------------------ #
    log.debug("Step 3: Callback iterations")
    if strong_auth and strong_auth_type == "yubikey":
        choice_text = "Yubikey"
    elif strong_auth:  # mobile (default)
        choice_text = "Mobile"
    else:
        choice_text = "Password"
    log.log(VERBOSE, "Step 3: auth mode=%s choice_text='%s'", strong_auth_type if strong_auth else "weak", choice_text)

    responses: dict = {
        "NameCallback": username,
        "PasswordCallback": str(password),
        "ChoiceCallback": choice_text,
        # swhrl requires a string "0"; all other apps accept an integer 0
        "ConfirmationCallback": "0" if "swhrl" in app_url else 0,
        "PollingWaitCallback": functools.partial(time.sleep, 10),
    }
    log.log(VERBOSE, "Step 3: responses map keys: %s (PasswordCallback masked)", list(responses.keys()))

    if initial_auth_bundle is not None:
        auth_bundle = initial_auth_bundle
        log.log(VERBOSE, "Step 3: using initial auth_bundle from direct JSON endpoint")
    else:
        auth_bundle = _callback_iteration(session, auth_url)

    if strong_auth_type == "yubikey":
        responses["PasswordCallback"] = {
            "AEP PIN": str(password),
            "HOTP (Yubikey)": _get_yubi_pin(yubi_key_provider),
        }
        log.log(VERBOSE, "Step 3: yubikey mode — PasswordCallback set to dict with 'AEP PIN' and 'HOTP (Yubikey)'")

    max_iterations = 40
    iteration = 0
    while auth_bundle and "callbacks" in auth_bundle:
        iteration += 1
        max_iterations -= 1
        callback_types = [c["type"] for c in auth_bundle["callbacks"]]
        log.log(VERBOSE, "Step 3 [iter %d]: callbacks=%s (remaining budget: %d)",
                iteration, callback_types, max_iterations)
        if max_iterations < 0:
            log.error(
                "Exceeded max callback iterations. Last auth_bundle:\n%s",
                json.dumps(auth_bundle, indent=2, default=str)[:3000],
            )
            raise AssertionError(
                "Could not go through BMW auth callbacks — "
                "timed out waiting for push confirmation?"
            )

        if "RedirectCallback" in callback_types:
            log.log(VERBOSE, "Step 3 [iter %d]: handling RedirectCallback", iteration)
            auth_bundle = _handle_redirect_callback(session, auth_bundle, responses, auth_url)
            if auth_bundle is None:
                log.log(VERBOSE, "Step 3 [iter %d]: RedirectCallback returned None — re-polling auth_url", iteration)
                auth_bundle = _callback_iteration(session, auth_url, auth_bundle)
        else:
            auth_bundle = _callback_iteration(session, auth_url, auth_bundle, responses)

    log.debug("Outer callback loop finished after %d iteration(s)", iteration)
    log.log(VERBOSE, "Step 3: final auth_bundle keys: %s", list(auth_bundle.keys()) if auth_bundle else "None")

    # ------------------------------------------------------------------ #
    # Step 4 — follow redirects to establish the session cookie          #
    # ------------------------------------------------------------------ #
    log.debug("Step 4: Following redirects to establish session")

    # Determine the starting URL for the redirect chain.
    # For OAuth2/OIDC apps (e.g. Octane via NetIQ OSP), the initial SAML
    # submission in Step 2 corrupted the OAuth2 session state.  We need to
    # clear the app-domain cookies and re-GET the app URL so a fresh OAuth2
    # grant is initiated — the IdP will immediately return an assertion
    # (no re-authentication needed) and the OSP will deliver the OAuth2 code.
    # For legacy apps using ForgeRock SSO agents, we use the goto-based
    # approach which redirects the user back to the app with valid cookies.
    success_url = auth_bundle.get("successUrl") if auth_bundle else None
    redirect_url_parsed = urllib.parse.urlparse(redirected_app_url)
    redirect_get_params = urllib.parse.parse_qs(redirect_url_parsed.query)

    if "goto" in redirect_get_params:
        # Legacy apps: follow the goto URL
        redirected_app_url = redirect_get_params["goto"][0]
        log.log(VERBOSE, "Step 4: resolved 'goto' param → %s", redirected_app_url)
        resp = session.get(redirected_app_url, verify=False)
    elif success_url and success_url.startswith("http"):
        # OIDC/SAML apps: clear corrupted OAuth2 state and re-start fresh
        app_netloc = urllib.parse.urlparse(app_url).netloc
        log.log(VERBOSE, "Step 4: OIDC flow detected — clearing cookies for %s and re-GETting app", app_netloc)
        for c in list(session.cookies):
            if app_netloc in (c.domain or "").lstrip("."):
                session.cookies.clear(c.domain, c.path, c.name)
        resp = session.get(app_url, allow_redirects=True, verify=False)
    else:
        log.log(VERBOSE, "Step 4: GET %s", redirected_app_url)
        resp = session.get(redirected_app_url, verify=False)
    log.log(VERBOSE, "Step 4: HTTP %d, at %s", resp.status_code, resp.url)
    step4_iter = 0
    while resp:
        step4_iter += 1
        html_text = resp.text
        current_url = resp.url
        log.log(VERBOSE, "Step 4 [iter %d]: processing URL %s (%d chars)", step4_iter, current_url, len(html_text))
        new_resp = _process_auto_redirect(html_text=html_text, url=current_url, session=session)
        if new_resp:
            log.log(VERBOSE, "Step 4 [iter %d]: JS redirect → %s", step4_iter, new_resp.url)
            resp = new_resp
            html_text = resp.text
            current_url = resp.url
        new_resp = _process_auto_form(html_text=html_text, session=session, base_url=current_url)
        if new_resp:
            log.log(VERBOSE, "Step 4 [iter %d]: form submitted → %s (HTTP %d)",
                    step4_iter, new_resp.url, new_resp.status_code)
        resp = new_resp

    log.log(VERBOSE, "Step 4: done after %d iteration(s). Session cookies: %s",
            step4_iter, list(session.cookies.keys()))
    log.info("SSO login flow complete")
    return session


class BmwIwaAuth(requests.auth.AuthBase):
    """
    A ``requests`` auth object that transparently handles BMW SSO login.

    The same :class:`BmwIwaAuth` instance can be used for multiple requests to
    the same host — cookies are cached per host so the SSO flow only runs once.

    .. note::
        This auth object does not support all BMW internal tools because each
        tool has a slightly different SSO flow.

    Example::

        from bmw_sso import BmwIwaAuth
        weak_auth = BmwIwaAuth(tss_name="q123456", tss_password="secret")
        resp = requests.get("https://some-bmw-app.bmwgroup.net/api", auth=weak_auth, verify=False)
    """

    # Maps netloc → cookie dict so the SSO flow only runs once per host
    cookies: Dict[str, Dict[str, str]] = {}

    def __init__(
        self,
        tss_name: str = None,
        tss_password: str = None,
        strong_pin: str = None,
        yubi_code: Callable = None,
    ):
        """
        :param tss_name:
            Q-number.  When omitted the ``tss.login`` entry in ``~/.netrc`` is
            used (and all other parameters must be omitted too).
        :param tss_password:
            Weak-auth password.  Mutually exclusive with *strong_pin*.
        :param strong_pin:
            Strong-auth PIN for mobile push.  Mutually exclusive with
            *tss_password*.
        :param yubi_code:
            Callable that returns the next Yubikey OTP (e.g. ``input``).
            Requires *strong_pin*.
        """
        # Per-instance session cache — maps netloc → authenticated Session.
        self._sessions: Dict[str, requests.Session] = {}
        if not tss_name:
            if any([tss_password, strong_pin, yubi_code]):
                raise ValueError("If tss_name is not given, no other arguments are allowed")
            n = netrc()
            tss_name, _, tss_password = n.authenticators("tss.login")
        if bool(tss_password) + bool(strong_pin) != 1:
            raise ValueError("Either tss_password or strong_pin must be provided (not both)")
        if yubi_code and not strong_pin:
            raise ValueError("yubi_code requires strong_pin to be provided")

        self.tss_name = tss_name
        if tss_password:
            self.auth_type = "weak"
            self.tss_password = tss_password
        if strong_pin:
            self.auth_type = "mobile"
            self.strong_auth = True
            self.pin = strong_pin
        if yubi_code:
            self.auth_type = "yubi"
            self.strong_auth = True
            self.yubi_code = yubi_code

    def __call__(self, r: requests.PreparedRequest) -> requests.PreparedRequest:
        base_url = urllib.parse.urlsplit(r.url).netloc
        if base_url not in self._sessions:
            login_session = requests.Session()
            # Use the app root URL (not the API endpoint) so Step 4 of bmw_sso_session
            # completes the full OAuth2/SAML redirect chain and all cookies are set.
            parsed = urllib.parse.urlsplit(r.url)
            app_root = f"{parsed.scheme}://{parsed.netloc}"
            if self.auth_type == "weak":
                bmw_sso_session(
                    app_root, session=login_session,
                    username=self.tss_name, password=self.tss_password,
                )
            elif self.auth_type == "mobile":
                bmw_sso_session(
                    app_root, session=login_session,
                    username=self.tss_name, password=self.pin,
                    strong_auth=True, strong_auth_type="mobile",
                )
            elif self.auth_type == "yubi":
                bmw_sso_session(
                    app_root, session=login_session,
                    username=self.tss_name, password=self.pin,
                    strong_auth=True, strong_auth_type="yubikey",
                )
            self._sessions[base_url] = login_session
        r.prepare_cookies(self._sessions[base_url].cookies)
        return r
