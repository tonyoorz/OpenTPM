"""
Core authentication-flow helpers for the BMW SSO login.

These are internal functions that handle the ForgeRock AM callback protocol,
the federated SAML redirect via RedirectCallback, Yubikey PIN validation and
the generic callback-iteration loop.

Public surface: none — all names are prefixed with ``_``.
The ``TAN_LIST`` module-level variable may be set by callers to provide a
list/iterator of Yubikey TANs as a convenience alternative to passing
``yubi_key_provider`` every time.
"""
import functools
import json
import logging
import time
import urllib.parse
from typing import Callable, Iterator, Union

import requests

from bmw_sso._html_utils import (
    _get_hidden_inputs,
    _process_auto_form,
    _process_auto_redirect,
)
from bmw_sso._logging import VERBOSE

log = logging.getLogger("SSOSession")

# Module-level TAN list — set this to a list/iterator of Yubikey OTPs so you
# don't have to pass yubi_key_provider every time.
TAN_LIST = None


class AuthenticationError(RuntimeError):
    """
    Raised when the BMW SSO server explicitly rejects the supplied credentials.

    This is distinct from a timeout (``AssertionError``) or a network error.
    It means the server returned a failure message in a ``TextOutputCallback``,
    so there is no point in retrying the same credentials.
    """


def _get_request_url(base_url: str, request_params=None) -> str:
    if isinstance(request_params, dict):
        request_params = urllib.parse.urlencode(request_params)
    return "{}?{}".format(base_url, request_params)


def _parse_get_parameters(url: str) -> dict:
    url_parsed = urllib.parse.urlparse(url)
    get_params = urllib.parse.parse_qs(url_parsed.query)
    return {k: v[0] if isinstance(v, list) else v for k, v in get_params.items()}


def _get_yubi_pin(yubi_key_provider: Union[Callable, Iterator, int, str]) -> str:
    if yubi_key_provider is None:
        yubi_key_provider = TAN_LIST
    if isinstance(yubi_key_provider, (str, int)):
        yubi_pin = str(yubi_key_provider)
    elif hasattr(yubi_key_provider, "__iter__"):
        yubi_pin = next(iter(yubi_key_provider))
    elif callable(yubi_key_provider):
        yubi_pin = yubi_key_provider()
    else:
        raise TypeError("Yubikey provider must be of type int, str, callable, iterator")
    if not isinstance(yubi_pin, str) or len(yubi_pin) != 6 or not yubi_pin.isnumeric():
        raise ValueError(f"yubi_key_provider must provide 6 digits. Provided {yubi_pin}")
    return yubi_pin


def _resolve_choice_index(callback: dict, search_text: str) -> int:
    """
    Resolve a ChoiceCallback to the correct index by matching *search_text*
    against the available choices (case-insensitive substring match).

    Different BMW tools present different choice lists:
      - VPS (federated):      ["Password", "PIN+Yubikey", "PIN+Mobile Push"]
      - AppCockpit (direct):  ["PIN+Yubikey", "PIN+Mobile Push"]

    Instead of hardcoding indices, we match by text so the code works
    regardless of which choices are offered.
    """
    choices = []
    for out in callback.get("output", []):
        if out.get("name") == "choices":
            choices = out["value"]
            break
    search_lower = search_text.lower()
    for i, choice in enumerate(choices):
        if search_lower in choice.lower():
            return i
    raise ValueError(f"No choice matching '{search_text}' found in {choices}")


def _follow_forms_and_redirects(session: requests.Session, resp: requests.Response) -> requests.Response:
    """Follow auto-forms and auto-redirects until no more are found."""
    step = 0
    while resp:
        step += 1
        html_text = resp.text
        current_url = resp.url
        log.log(VERBOSE, "_follow_forms_and_redirects [step %d]: at %s (HTTP %s, %d chars)",
                step, current_url, resp.status_code, len(html_text))
        new_resp = _process_auto_form(html_text, session, base_url=current_url)
        if new_resp:
            log.log(VERBOSE, "_follow_forms_and_redirects [step %d]: followed form → %s", step, new_resp.url)
            resp = new_resp
            continue
        new_resp = _process_auto_redirect(html_text=html_text, url=current_url, session=session)
        if new_resp:
            log.log(VERBOSE, "_follow_forms_and_redirects [step %d]: followed JS redirect → %s", step, new_resp.url)
            resp = new_resp
            continue
        log.log(VERBOSE, "_follow_forms_and_redirects: chain complete after %d step(s), ended at %s",
                step, current_url)
        break
    return resp


def _callback_iteration(session: requests.Session, auth_url: str, auth_bundle: dict = None,
                         responses: dict = None) -> dict:
    if responses is None:
        responses = {}
    if auth_bundle:
        callback_types = [c["type"] for c in auth_bundle["callbacks"]]
        log.debug("Processing callbacks: %s", callback_types)
        log.log(VERBOSE, "_callback_iteration: full auth_bundle IN:\n%s",
                json.dumps(auth_bundle, indent=2, default=str))
        if any(c["type"] == "PollingWaitCallback" for c in auth_bundle["callbacks"]):
            responses = dict(responses)
            # Value 100 seems unusual but is required for the flow to work
            responses["ConfirmationCallback"] = 100
            log.log(VERBOSE, "_callback_iteration: PollingWaitCallback detected — ConfirmationCallback forced to 100")
        for callback in auth_bundle["callbacks"]:
            # Extract prompt/message for logging
            prompt = None
            for out in callback.get("output", []):
                if out.get("name") in ("prompt", "message") and out.get("value", "").strip():
                    prompt = out["value"]
            if callback["type"] == "TextOutputCallback" and prompt:
                log.log(VERBOSE, "  _callback_iteration: TextOutputCallback message: '%s'", prompt)
                if "fail" in prompt.lower() or "incorrect" in prompt.lower() or "invalid" in prompt.lower():
                    log.error("Server reported authentication failure: '%s'", prompt)
                    raise AuthenticationError(f"BMW SSO rejected the credentials: '{prompt}'")

            if callback["type"] in responses:
                response = responses[callback["type"]]
                if callable(responses[callback["type"]]):
                    log.log(VERBOSE, "  _callback_iteration: calling handler for '%s'", callback["type"])
                    response = responses[callback["type"]]()
                if isinstance(responses[callback["type"]], dict):
                    # Match by prompt — used for yubikey mode and multi-password flows
                    prompt_value = callback["output"][0]["value"]
                    if prompt_value in responses[callback["type"]]:
                        response = responses[callback["type"]][prompt_value]
                    else:
                        log.warning(
                            "No dict entry for prompt '%s' in %s responses",
                            prompt_value, callback["type"],
                        )
                # Dynamic ChoiceCallback resolution: match by text instead of index
                if callback["type"] == "ChoiceCallback" and isinstance(response, str):
                    choices = next(
                        (o["value"] for o in callback.get("output", []) if o.get("name") == "choices"),
                        [],
                    )
                    log.log(VERBOSE, "  _callback_iteration: resolving ChoiceCallback '%s' among %s",
                            response, choices)
                    response = _resolve_choice_index(callback, response)
                    log.log(VERBOSE, "  _callback_iteration: resolved ChoiceCallback index → %d", response)
                if "input" in callback:
                    # Mask PasswordCallback values in logs
                    logged_value = "***" if callback["type"] == "PasswordCallback" else repr(response)
                    log.log(VERBOSE, "  _callback_iteration: setting '%s' input to %s (prompt: '%s')",
                            callback["type"], logged_value, prompt or "")
                    callback["input"][0]["value"] = response
                log.debug("  Responded to '%s' (prompt: '%s')", callback["type"], prompt or "")
            else:
                log.debug("  No response for '%s' (prompt: '%s')", callback["type"], prompt or "")
    else:
        log.debug("Initial callback request (no auth_bundle yet)")
        log.log(VERBOSE, "_callback_iteration: sending initial POST to %s", auth_url)

    log.log(VERBOSE, "_callback_iteration: POSTing to %s", auth_url)
    resp_cb = session.post(auth_url, verify=False, json=auth_bundle)
    log.log(VERBOSE, "_callback_iteration: HTTP %d from %s", resp_cb.status_code, resp_cb.url)
    try:
        result = json.loads(resp_cb.content)
    except json.JSONDecodeError:
        log.error("Auth endpoint returned non-JSON response: %s", resp_cb.text[:500])
        log.log(VERBOSE, "_callback_iteration: full non-JSON response body:\n%s", resp_cb.text[:3000])
        return {}

    if "tokenId" in result:
        log.info("Received tokenId — authentication successful")
        log.log(VERBOSE, "_callback_iteration: successUrl=%s", result.get("successUrl"))
    if "successUrl" in result:
        log.debug("Received successUrl: %s", result["successUrl"])
    if "failureUrl" in result:
        log.error("Received failureUrl: %s", result.get("failureUrl"))
        log.log(VERBOSE, "_callback_iteration: full failure response:\n%s",
                json.dumps(result, indent=2, default=str))
    if "errorMessage" in result:
        log.error("Received errorMessage: %s", result.get("errorMessage"))
        log.log(VERBOSE, "_callback_iteration: full error response:\n%s",
                json.dumps(result, indent=2, default=str))
    if "callbacks" in result:
        log.debug("Server requests next callbacks: %s", [c["type"] for c in result["callbacks"]])
        log.log(VERBOSE, "_callback_iteration: full auth_bundle OUT:\n%s",
                json.dumps(result, indent=2, default=str))
    elif "tokenId" not in result and "successUrl" not in result:
        log.warning(
            "Response contains neither 'callbacks' nor 'tokenId'/'successUrl'. Keys: %s",
            list(result.keys()),
        )
        log.log(VERBOSE, "_callback_iteration: unexpected response body:\n%s",
                json.dumps(result, indent=2, default=str))
    return result


def _handle_redirect_callback(session: requests.Session, auth_bundle: dict, responses: dict,
                               auth_url: str) -> dict:
    """
    Handle a RedirectCallback from a ForgeRock authentication tree.

    BMW's intranetb2x realm delegates authentication to the alpha realm via a
    SAML redirect.  The flow is:

    1. Follow the redirect URL to the alpha realm.
    2. If the alpha realm requires login, complete the inner auth tree
       (username → auth method choice → password).
    3. Follow the SAML assertion chain back to auth.bmwgroup.net.
    4. Re-query the outer auth_url — it should now return tokenId/successUrl.
    """
    redirect_callback = next(
        c for c in auth_bundle["callbacks"] if c["type"] == "RedirectCallback"
    )
    outputs = {o["name"]: o["value"] for o in redirect_callback["output"]}
    redirect_url = outputs.get("redirectUrl")
    redirect_method = outputs.get("redirectMethod", "GET").upper()

    if not redirect_url:
        log.error("RedirectCallback has no redirectUrl")
        log.log(VERBOSE, "_handle_redirect_callback: callback outputs: %s", outputs)
        return auth_bundle

    log.debug("Following RedirectCallback to federated realm")
    log.log(VERBOSE, "_handle_redirect_callback: redirectUrl=%s method=%s", redirect_url, redirect_method)

    # Step 1: Follow the redirect URL to alpha realm
    log.log(VERBOSE, "_handle_redirect_callback [step 1]: fetching redirect URL")
    if redirect_method == "GET":
        resp = session.get(redirect_url, verify=False, allow_redirects=True)
    else:
        resp = session.post(redirect_url, verify=False, allow_redirects=True)
    log.log(VERBOSE, "_handle_redirect_callback [step 1]: HTTP %d, landed at %s", resp.status_code, resp.url)

    # Step 2: Process any auto-forms (SAML SP pages) to reach the login page
    log.log(VERBOSE, "_handle_redirect_callback [step 2]: following forms/redirects")
    resp = _follow_forms_and_redirects(session, resp)
    log.log(VERBOSE, "_handle_redirect_callback [step 2]: chain ended at %s", resp.url if resp else "None")

    # Step 3: Check if we need to authenticate at the alpha realm
    inner_hidden_inputs = _get_hidden_inputs(resp.text)
    inner_auth_base = None
    inner_get_params = {}

    if inner_hidden_inputs and "loginUrl" in inner_hidden_inputs:
        inner_login_url = inner_hidden_inputs["loginUrl"]
        log.debug("Inner realm login detected")
        log.log(VERBOSE, "_handle_redirect_callback [step 3]: loginUrl=%s", inner_login_url)
        inner_get_params = _parse_get_parameters(inner_login_url)
        parsed_inner = urllib.parse.urlparse(inner_login_url)
        inner_auth_base = (
            f"{parsed_inner.scheme}://{parsed_inner.netloc}"
            f"/auth/json/realms/root/realms/alpha/authenticate"
        )
    elif "emea.prod.alpha.sso.bmwgroup.com" in resp.url:
        log.debug("Inner realm login detected via URL")
        log.log(VERBOSE, "_handle_redirect_callback [step 3]: alpha realm via URL=%s", resp.url)
        inner_get_params = _parse_get_parameters(resp.url)
        inner_auth_base = (
            "https://emea.prod.alpha.sso.bmwgroup.com"
            "/auth/json/realms/root/realms/alpha/authenticate"
        )
    else:
        log.log(VERBOSE, "_handle_redirect_callback [step 3]: no inner login page — "
                "hidden inputs=%s, URL=%s", list(inner_hidden_inputs.keys()), resp.url if resp else "None")

    if not inner_auth_base:
        log.debug("No inner login needed (already authenticated)")
        if resp and resp.url:
            landing_params = _parse_get_parameters(resp.url)
            log.log(VERBOSE, "_handle_redirect_callback: landing URL params: %s", list(landing_params.keys()))
            if "responsekey" in landing_params:
                log.debug("Found responsekey from completed SAML redirect")
                separator = "&" if "?" in auth_url else "?"
                outer_auth_url = f"{auth_url}{separator}responsekey={landing_params['responsekey']}"
                log.log(VERBOSE, "_handle_redirect_callback: outer_auth_url=%s", outer_auth_url)
                return _callback_iteration(session, outer_auth_url, None)
        return None

    if "realm" in inner_get_params:
        del inner_get_params["realm"]
    if "AMAuthCookie" not in inner_get_params:
        inner_get_params["AMAuthCookie"] = ""

    inner_auth_url = _get_request_url(inner_auth_base, request_params=inner_get_params)
    log.log(VERBOSE, "_handle_redirect_callback: inner_auth_url=%s", inner_auth_url)

    # Inner auth responses: copy the outer responses so username, PIN, and
    # polling behaviour carry over.
    inner_responses = dict(responses)
    inner_responses["ConfirmationCallback"] = 0  # Always "NEXT" in the inner realm

    # Run inner callback loop (username → choice → poll for push → PIN → tokenId)
    log.log(VERBOSE, "_handle_redirect_callback: starting inner callback loop")
    inner_bundle = _callback_iteration(session, inner_auth_url)
    inner_max = 40
    inner_iter = 0
    while inner_bundle and "callbacks" in inner_bundle:
        inner_iter += 1
        inner_max -= 1
        cb_types = [c["type"] for c in inner_bundle["callbacks"]]
        log.log(VERBOSE, "_handle_redirect_callback: inner iter %d — callbacks: %s", inner_iter, cb_types)
        if inner_max < 0:
            log.error(
                "Inner auth exceeded max iterations. Last bundle:\n%s",
                json.dumps(inner_bundle, indent=2, default=str)[:3000],
            )
            raise AssertionError(
                "Could not go through inner (alpha) auth callbacks — "
                "timed out waiting for push confirmation?"
            )
        inner_bundle = _callback_iteration(session, inner_auth_url, inner_bundle, inner_responses)
    log.debug("Inner auth completed after %d iteration(s)", inner_iter)
    log.log(VERBOSE, "_handle_redirect_callback: inner result keys: %s", list(inner_bundle.keys()))

    # Step 4: Inner auth succeeded — complete the SAML chain via successUrl.
    inner_success_url = inner_bundle.get("successUrl")
    log.log(VERBOSE, "_handle_redirect_callback [step 4]: inner successUrl=%s", inner_success_url)
    if inner_success_url:
        log.debug("Following successUrl to complete SAML chain")
        resp = session.get(inner_success_url, verify=False, allow_redirects=True)
        log.log(VERBOSE, "_handle_redirect_callback [step 4]: successUrl HTTP %d, at %s",
                resp.status_code, resp.url)
        resp = _follow_forms_and_redirects(session, resp)
        if resp:
            log.debug("SAML chain ended at: %s", resp.url)

    # If SAML chain didn't reach auth.bmwgroup.net, re-follow the original redirect URL.
    if not resp or "auth.bmwgroup.net" not in (resp.url or ""):
        log.debug("SAML chain did not reach auth.bmwgroup.net, re-following redirect URL")
        log.log(VERBOSE, "_handle_redirect_callback: current URL=%s", resp.url if resp else "None")
        if redirect_method == "GET":
            resp = session.get(redirect_url, verify=False, allow_redirects=True)
        else:
            resp = session.post(redirect_url, verify=False, allow_redirects=True)
        log.log(VERBOSE, "_handle_redirect_callback: re-follow HTTP %d, at %s", resp.status_code, resp.url)
        resp = _follow_forms_and_redirects(session, resp)
        if resp:
            log.debug("Re-follow SAML chain ended at: %s", resp.url)

    log.debug("RedirectCallback handling complete")

    # Re-query the outer auth URL, including any responsekey from the SAML redirect.
    outer_auth_url = auth_url
    if resp and resp.url:
        landing_params = _parse_get_parameters(resp.url)
        log.log(VERBOSE, "_handle_redirect_callback: final landing params: %s", list(landing_params.keys()))
        if "responsekey" in landing_params:
            log.debug("Found responsekey from SAML redirect completion")
            separator = "&" if "?" in auth_url else "?"
            outer_auth_url = f"{auth_url}{separator}responsekey={landing_params['responsekey']}"
            log.log(VERBOSE, "_handle_redirect_callback: outer_auth_url=%s", outer_auth_url)
    log.log(VERBOSE, "_handle_redirect_callback: re-querying outer endpoint: %s", outer_auth_url)
    return _callback_iteration(session, outer_auth_url, None)
