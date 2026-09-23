"""
Offline unit tests for the HTML parsing helpers.

These tests require no credentials and no network access — they only exercise
the helper functions in ``bmw_sso._html_utils`` and ``bmw_sso._auth_flow``.
"""
import re
import unittest

from bs4 import BeautifulSoup

from bmw_sso._auth_flow import _get_yubi_pin, _resolve_choice_index
from bmw_sso._html_utils import _get_hidden_inputs


class TestYubiPin(unittest.TestCase):
    """Tests for :func:`bmw_sso._auth_flow._get_yubi_pin`."""

    def test_string_input(self):
        self.assertEqual(_get_yubi_pin("123456"), "123456")

    def test_int_input(self):
        self.assertEqual(_get_yubi_pin(123456), "123456")

    def test_iterator_input(self):
        self.assertEqual(_get_yubi_pin(x for x in ["123456"]), "123456")

    def test_callable_input(self):
        self.assertEqual(_get_yubi_pin(lambda: "123456"), "123456")

    def test_too_short_raises(self):
        with self.assertRaises(ValueError):
            _get_yubi_pin("123")

    def test_non_numeric_raises(self):
        with self.assertRaises(ValueError):
            _get_yubi_pin("12345a")

    def test_wrong_type_raises(self):
        with self.assertRaises(TypeError):
            _get_yubi_pin(object())  # type: ignore[arg-type]


class TestGetHiddenInputs(unittest.TestCase):
    """Tests for :func:`bmw_sso._html_utils._get_hidden_inputs`."""

    def test_basic(self):
        html_text = """<html><body>
        <form method="POST" action="https://sp.example.com/saml/acs">
          <input type="hidden" name="SAMLResponse" value="PHNhbWxwOlJlc3BvbnNlPg=="/>
          <input type="hidden" name="RelayState" value="some-state"/>
        </form></body></html>"""
        inputs = _get_hidden_inputs(html_text)
        self.assertEqual(inputs["SAMLResponse"], "PHNhbWxwOlJlc3BvbnNlPg==")
        self.assertEqual(inputs["RelayState"], "some-state")

    def test_reversed_attr_order(self):
        """BS4 finds inputs regardless of attribute order; old regex could not."""
        html_text = """<input value="val1" type="hidden" name="key1"/>"""
        inputs = _get_hidden_inputs(html_text)
        self.assertEqual(inputs["key1"], "val1")

    def test_html_entities_in_value(self):
        """HTML entities in values must be decoded (e.g. ``&amp;`` → ``&``)."""
        html_text = """<input type="hidden" name="goto" value="https://app.bmwgroup.net/?a=1&amp;b=2"/>"""
        inputs = _get_hidden_inputs(html_text)
        self.assertEqual(inputs["goto"], "https://app.bmwgroup.net/?a=1&b=2")

    def test_multiline_form(self):
        """Multi-line, indented HTML like real-world IdP pages."""
        html_text = """
        <html>
          <body>
            <form
              action="https://idp.bmwgroup.net/saml2/jsp/idpSSOInit.jsp"
              method="post"
            >
              <input
                type  =  "hidden"
                name  =  "loginUrl"
                value =  "https://auth.bmwgroup.net/auth/XUI/?realm=intranetb2x&amp;goto=https%3A%2F%2Fapp"
              />
              <input type="hidden" name="token" value="abc"/>
            </form>
          </body>
        </html>"""
        inputs = _get_hidden_inputs(html_text)
        self.assertIn("loginUrl", inputs)
        self.assertIn("goto=https%3A%2F%2Fapp", inputs["loginUrl"])
        self.assertEqual(inputs["token"], "abc")


class TestProcessAutoForm(unittest.TestCase):
    """Tests for the auto-form detection logic (using BS4 directly)."""

    def test_action_before_method(self):
        """BeautifulSoup finds form regardless of attribute order."""
        html_text = """<html><body>
        <form action="https://idp.example.com/saml" method="post">
          <input type="hidden" name="SAMLRequest" value="abc123"/>
        </form></body></html>"""
        soup = BeautifulSoup(html_text, "lxml")
        form = soup.find("form")
        self.assertIsNotNone(form)
        self.assertEqual(form.get("action"), "https://idp.example.com/saml")
        self.assertEqual((form.get("method") or "post").lower(), "post")
        tag = form.find("input", type="hidden")
        self.assertEqual(tag.get("name"), "SAMLRequest")
        self.assertEqual(tag.get("value"), "abc123")

    def test_no_method_defaults_to_post(self):
        """SAML forms without a method attribute must default to POST (SAML spec §3.5)."""
        html_text = """<html><body>
        <form action="https://idp.example.com/acs">
          <input type="hidden" name="SAMLResponse" value="xyz"/>
        </form></body></html>"""
        soup = BeautifulSoup(html_text, "lxml")
        form = soup.find("form")
        method = (form.get("method") or "post").lower()
        self.assertEqual(method, "post")


class TestProcessAutoRedirect(unittest.TestCase):
    """Tests for the ``window.location.replace`` redirect detection logic."""

    _PATTERN = re.compile(
        r"window\.location\.replace\s*\(\s*href\s*\+\s*'([^']+)'\s*\+\s*token\s*\)"
    )

    def test_matches_inside_script_tag(self):
        """The redirect pattern must be found when it is inside a <script> tag."""
        html_match = """<html><head>
        <script>
          var href = "https://auth.bmwgroup.net/callback";
          var token = "abc";
          window.location.replace(href + '?continue=' + token);
        </script>
        </head></html>"""
        soup = BeautifulSoup(html_match, "lxml")
        found = False
        for script in soup.find_all("script"):
            m = self._PATTERN.search(script.get_text() or "")
            if m:
                self.assertEqual(m.group(1), "?continue=")
                found = True
        self.assertTrue(found, "Pattern not found in script tag")

    def test_does_not_match_outside_script_tag(self):
        """The redirect pattern must NOT match when it appears only in an attribute."""
        html_no_match = """<html><body>
        <div data-redirect="window.location.replace(href + '?x=' + token)"></div>
        </body></html>"""
        soup = BeautifulSoup(html_no_match, "lxml")
        found = any(
            self._PATTERN.search(s.get_text() or "")
            for s in soup.find_all("script")
        )
        self.assertFalse(found, "Pattern should NOT match outside <script> tags")


class TestResolveChoiceIndex(unittest.TestCase):
    """Tests for :func:`bmw_sso._auth_flow._resolve_choice_index`."""

    def test_vps_choices(self):
        """VPS (federated) offers three choices: Password, Yubikey, Mobile."""
        cb = {"output": [{"name": "choices", "value": ["Password", "PIN+Yubikey", "PIN+Mobile Push"]}]}
        self.assertEqual(_resolve_choice_index(cb, "Password"), 0)
        self.assertEqual(_resolve_choice_index(cb, "Yubikey"), 1)
        self.assertEqual(_resolve_choice_index(cb, "Mobile"), 2)

    def test_appcockpit_choices(self):
        """AppCockpit (direct alpha) only offers two choices: Yubikey, Mobile."""
        cb = {"output": [{"name": "choices", "value": ["PIN+Yubikey", "PIN+Mobile Push"]}]}
        self.assertEqual(_resolve_choice_index(cb, "Yubikey"), 0)
        self.assertEqual(_resolve_choice_index(cb, "Mobile"), 1)

    def test_no_match_raises(self):
        cb = {"output": [{"name": "choices", "value": ["PIN+Yubikey", "PIN+Mobile Push"]}]}
        with self.assertRaises(ValueError):
            _resolve_choice_index(cb, "Password")


if __name__ == "__main__":
    unittest.main()
