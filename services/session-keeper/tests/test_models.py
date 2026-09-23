"""Unit tests for bmw_tools.models (PU, Ecu, BackendEnvironment)."""

import pytest

from bmw_tools.models import PU, BackendConfig, BackendEnvironment, Ecu


class TestPU:
    def test_from_string_slash(self):
        pu = PU.from_string("03/25")
        assert pu.month == 3
        assert pu.year == 2025

    def test_from_string_dash(self):
        pu = PU.from_string("07-24")
        assert pu.month == 7
        assert pu.year == 2024

    def test_from_string_reversed(self):
        pu = PU.from_string("25/11")
        assert pu.month == 11
        assert pu.year == 2025

    def test_from_string_4digit(self):
        pu = PU.from_string("0325")
        assert pu.month == 3
        assert pu.year == 2025

    def test_from_string_invalid_raises(self):
        with pytest.raises(ValueError):
            PU.from_string("12/13")

    def test_from_string_bad_format_raises(self):
        with pytest.raises(ValueError):
            PU.from_string("abc")

    def test_comparison(self):
        assert PU(3, 24) < PU(7, 24)
        assert PU(11, 23) < PU(3, 24)
        assert PU(7, 25) > PU(11, 24)
        assert PU(3, 25) == PU(3, 25)
        assert PU(3, 25) != PU(7, 25)

    def test_to_appcockpit_value(self):
        assert PU(3, 25).to_appcockpit_value() == "03/25"
        assert PU(11, 24).to_appcockpit_value() == "11/24"
        assert PU(3, 2000).to_appcockpit_value() is None
        assert PU(3, 2099).to_appcockpit_value() is None

    def test_str(self):
        assert str(PU(7, 26)) == "07/26"

    def test_hash(self):
        s = {PU(3, 25), PU(3, 25), PU(7, 25)}
        assert len(s) == 2

    def test_eq_none(self):
        assert PU(3, 25) != None  # noqa: E711
        assert not (PU(3, 25) == None)  # noqa: E711


class TestEcu:
    def test_from_string_variants(self):
        assert Ecu.from_string("idc23") == Ecu.IDC23
        assert Ecu.from_string("HU_MGU_N1_IDC") == Ecu.IDC23
        assert Ecu.from_string("IDCEvo25") == Ecu.IDCEvo
        assert Ecu.from_string("IDCEVO25-ANDROID") == Ecu.IDCEvo
        assert Ecu.from_string("cde01") == Ecu.CDE01
        assert Ecu.from_string("rse26") == Ecu.RSE26
        assert Ecu.from_string("unknown") == Ecu.UNKNOWN

    def test_from_string_invalid(self):
        with pytest.raises(ValueError):
            Ecu.from_string("invalid_ecu")

    def test_str(self):
        assert str(Ecu.IDC23) == "idc23"
        assert str(Ecu.IDCEvo) == "idcevo25"


class TestBackendEnvironment:
    def test_from_string(self):
        assert BackendEnvironment.from_string("int") == BackendEnvironment.INT
        assert BackendEnvironment.from_string("prod_test") == BackendEnvironment.PROD_TEST
        assert BackendEnvironment.from_string("prod") == BackendEnvironment.PROD

    def test_from_string_invalid(self):
        with pytest.raises(ValueError):
            BackendEnvironment.from_string("staging")


class TestBackendConfig:
    def test_frozen(self):
        config = BackendConfig(pu=PU(3, 25), hwd=Ecu.IDC23, environment=BackendEnvironment.INT)
        with pytest.raises(Exception):
            config.pu = PU(7, 25)
