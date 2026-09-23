"""
HTML parsing utilities for the BMW SSO login flow.

These are internal helpers used by the authentication flow to handle:
  - HTML sanitisation
  - Hidden form field extraction (BeautifulSoup-based, regex fallback)
  - Auto-form detection and submission (SAML POST-Binding)
  - JavaScript window.location.replace redirect following
"""
import html
import logging
import re
import urllib.parse

import requests
from bs4 import BeautifulSoup

from bmw_sso._logging import VERBOSE

log = logging.getLogger("SSOSession")


def _sanitize_html(text: str) -> str:
    return html.unescape(text).replace('\n', '').replace('\r', '')


def _parse_html(html_text: str) -> BeautifulSoup:
    """Parse HTML using lxml (fast, tolerant) with html.parser as fallback."""
    try:
        soup = BeautifulSoup(html_text, "lxml")
        log.log(VERBOSE, "_parse_html: parsed %d chars with lxml", len(html_text))
        return soup
    except Exception as exc:
        log.log(VERBOSE, "_parse_html: lxml failed (%s), falling back to html.parser", exc)
        return BeautifulSoup(html_text, "html.parser")


def _get_hidden_inputs(html_text: str) -> dict:
    """
    Extract all hidden <input> fields from an HTML page.

    Uses BeautifulSoup so attribute order, whitespace and quote style never matter.
    Falls back to the original regex approach if parsing yields nothing, to stay
    resilient against edge-cases where the page is not valid HTML at all.
    """
    log.log(VERBOSE, "_get_hidden_inputs: scanning %d chars of HTML", len(html_text))
    soup = _parse_html(html_text)
    result = {}
    for tag in soup.find_all("input", type="hidden"):
        name = tag.get("name") or tag.get("id")
        value = tag.get("value", "")
        if name:
            result[name] = _sanitize_html(value)

    if result:
        log.log(VERBOSE, "_get_hidden_inputs: found fields via BS4: %s", list(result.keys()))
    else:
        log.log(VERBOSE, "_get_hidden_inputs: BS4 found nothing — trying regex fallback")
        # Regex fallback (original behaviour) — keeps working on non-HTML responses
        inputs_by_name_re = re.findall(r'input[^>]*hidden[^>]*name="([^"]+)"[^>]*value="([^"]+)"', html_text)
        named_inputs = {n: _sanitize_html(v) for n, v in inputs_by_name_re}
        inputs_by_id_re = re.findall(r'input[^>]*hidden[^>]*id="([^"]+)".*value="([^"]+)"', html_text)
        id_inputs = {n: _sanitize_html(v) for n, v in inputs_by_id_re}
        result = id_inputs | named_inputs
        if result:
            log.log(VERBOSE, "_get_hidden_inputs: regex fallback found fields: %s", list(result.keys()))
        else:
            log.log(VERBOSE, "_get_hidden_inputs: no hidden inputs found at all")

    return result


def _process_auto_redirect(html_text: str, url: str, session: requests.Session):
    """
    Follow a JavaScript ``window.location.replace`` redirect that ForgeRock emits
    after certain SAML steps.  We look for the pattern in <script> tags only so
    that stray occurrences in attribute values or comments never match.
    """
    log.log(VERBOSE, "_process_auto_redirect: checking for JS redirect at %s", url)
    soup = _parse_html(html_text)
    for script in soup.find_all("script"):
        script_text = script.get_text() or ""
        m = re.search(
            r"window\.location\.replace\s*\(\s*href\s*\+\s*'([^']+)'\s*\+\s*token\s*\)",
            script_text,
        )
        if m:
            new_url = url.split("#")[0] + m.group(1)
            log.debug("_process_auto_redirect: following JS redirect → %s", new_url)
            resp = session.get(new_url, verify=False)
            log.log(VERBOSE, "_process_auto_redirect: got HTTP %d from %s", resp.status_code, resp.url)
            return resp
    log.log(VERBOSE, "_process_auto_redirect: no JS redirect pattern found")
    return None


def _process_auto_form(html_text: str, session: requests.Session, base_url: str = None):
    """
    Detect and submit the first auto-submit HTML form (SAML POST-Binding / SP
    redirect pages).

    BeautifulSoup handles any attribute order, HTML entities in action URLs,
    self-closing tags etc., so this no longer breaks when the IdP tweaks its
    template.  The method defaults to POST when no method attribute is present,
    which matches the SAML POST-Binding specification (section 3.5,
    SAML Bindings 2.0).
    """
    log.log(VERBOSE, "_process_auto_form: scanning for auto-submit form (base_url=%s)", base_url)
    soup = _parse_html(html_text)
    form = soup.find("form")
    if not form:
        log.log(VERBOSE, "_process_auto_form: no <form> found")
        return None

    action = form.get("action", "")
    method = (form.get("method") or "post").lower()

    if not action:
        log.log(VERBOSE, "_process_auto_form: <form> has no action attribute — skipping")
        return None

    # Unescape HTML entities in the action URL (e.g. &amp; → &)
    action = html.unescape(action)

    # Resolve relative URLs
    if base_url and not action.startswith("http"):
        action = urllib.parse.urljoin(base_url, action)

    # Collect ALL hidden inputs (the SAML assertion, RelayState, …)
    form_data = {}
    for tag in form.find_all("input", type="hidden"):
        name = tag.get("name") or tag.get("id")
        value = tag.get("value", "")
        if name:
            form_data[name] = html.unescape(value)

    log.debug(
        "_process_auto_form: submitting form method=%s action=%s fields=%s",
        method.upper(), action, list(form_data.keys()),
    )
    log.log(VERBOSE, "_process_auto_form: form field values: %s",
            {k: v[:80] + "…" if len(v) > 80 else v for k, v in form_data.items()})

    # Include Origin header — required by some OAuth2/OIDP servers (e.g. NetIQ OSP)
    # to properly link authentication contracts to pending OAuth2 grants.
    origin_header = {}
    if base_url:
        parsed_base = urllib.parse.urlparse(base_url)
        origin_header["Origin"] = f"{parsed_base.scheme}://{parsed_base.netloc}"

    if method == "get":
        resp = session.get(action, verify=False, headers=origin_header)
    else:
        resp = session.post(action, data=form_data, verify=False, headers=origin_header)

    log.log(VERBOSE, "_process_auto_form: response HTTP %d, final URL: %s", resp.status_code, resp.url)
    return resp
