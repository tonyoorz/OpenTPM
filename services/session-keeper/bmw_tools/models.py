"""Domain models shared across BMW tool clients."""

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class PU:
    """Programming Unit — represents a month/year combination (e.g. 03/25)."""

    month: int
    year: int

    def __init__(self, month: int, year: int):
        self.month = int(month)
        if year < 2000:
            year = year + 2000
        self.year = int(year)

    @classmethod
    def from_string(cls, string: str) -> "PU":
        """Parse PU from various formats: mm/yy, yy/mm, mm-yy, yy-mm, mmyy, yymm."""
        parts = string.replace("/", "-").split("-")
        if len(parts) == 1 and len(string) == 4:
            parts = [string[0:2], string[2:4]]
        if len(parts) != 2:
            raise ValueError(f"Cannot parse PU from '{string}': format must be mm/yy, yy/mm, mm-yy, yy-mm, mmyy, or yymm")
        p1 = int(parts[0])
        p2 = int(parts[1])
        if p1 in [3, 7, 11]:
            return PU(p1, p2)
        if p2 in [3, 7, 11]:
            return PU(p2, p1)
        raise ValueError(f"Cannot parse PU from '{string}': one part must be in [3, 7, 11]")

    def to_appcockpit_value(self) -> Optional[str]:
        if self.year in [2000, 2099]:
            return None
        return str(self.month).zfill(2) + "/" + str(self.year - 2000).zfill(2)

    def __str__(self):
        return str(self.month).zfill(2) + "/" + str(self.year - 2000).zfill(2)

    def __repr__(self):
        return f"PU({self.month}, {self.year})"

    def __lt__(self, other):
        return (self.year, self.month) < (other.year, other.month)

    def __le__(self, other):
        return (self.year, self.month) <= (other.year, other.month)

    def __gt__(self, other):
        return (self.year, self.month) > (other.year, other.month)

    def __ge__(self, other):
        return (self.year, self.month) >= (other.year, other.month)

    def __eq__(self, other):
        if other is None:
            return False
        return (self.year, self.month) == (other.year, other.month)

    def __ne__(self, other):
        if other is None:
            return True
        return (self.year, self.month) != (other.year, other.month)

    def __hash__(self):
        return self.year * 100 + self.month


class BackendEnvironment(Enum):
    OFFLINE = -1
    INT = 0
    PROD_TEST = 1
    PROD = 2

    @staticmethod
    def from_string(environment: str) -> "BackendEnvironment":
        match environment.lower():
            case "int":
                return BackendEnvironment.INT
            case "prod_test":
                return BackendEnvironment.PROD_TEST
            case "prod":
                return BackendEnvironment.PROD
        raise ValueError(f"Unknown environment: {environment}")


class Ecu(Enum):
    UNKNOWN = -1
    IDC23 = 0
    IDCEvo = 1
    CDE01 = 2
    RSE26 = 3

    def __str__(self):
        return {
            Ecu.UNKNOWN: "unknown",
            Ecu.IDC23: "idc23",
            Ecu.IDCEvo: "idcevo25",
            Ecu.CDE01: "cde01",
            Ecu.RSE26: "rse26",
        }[self]

    @staticmethod
    def from_string(ecu_name: str) -> "Ecu":
        lower = ecu_name.lower()
        if lower in ["idc23", "hu_mgu_n1_idc", "mgu_02_a"]:
            return Ecu.IDC23
        if lower.startswith("idcevo"):
            return Ecu.IDCEvo
        if lower == "cde01":
            return Ecu.CDE01
        if lower == "rse26":
            return Ecu.RSE26
        if lower == "unknown":
            return Ecu.UNKNOWN
        raise ValueError(f"Unknown ECU name: {ecu_name}")


@dataclass(frozen=True)
class BackendConfig:
    pu: PU
    hwd: Ecu
    environment: BackendEnvironment = BackendEnvironment.OFFLINE
