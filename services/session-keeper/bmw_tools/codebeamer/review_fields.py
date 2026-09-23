"""Extract supplier/customer review fields from tracker items.

Requirement items on the C_HIP tracker carry custom fields whose names follow
the pattern ``"<party> <kind> <company>"`` where:

  * *party*   is ``Supplier`` or ``Customer``
  * *kind*    is ``Status`` (a choice, e.g. *Agreed*) or ``Comment`` (wiki text)
  * *company* is a free-form supplier/customer name (e.g. *Bosch*, *Panasonic*)

This module parses those field names and pulls out the value plus the numeric
``fieldId`` (needed later to write updates back). ``build_review_matrix``
groups them per company so a requirement can be rendered as a table of
Supplier/Customer Status/Comment per company.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# "Supplier Status Bosch", "Customer Comment LG", ...
_NAME_RE = re.compile(
    r"^(?P<party>Supplier|Customer)\s+(?P<kind>Status|Comment)\s+(?P<company>\S.*?)\s*$",
    re.IGNORECASE,
)

PARTIES = ("Supplier", "Customer")
KINDS = ("Status", "Comment")


@dataclass
class ReviewField:
    """A single parsed review custom field."""

    party: str  # "Supplier" | "Customer"
    kind: str  # "Status" | "Comment"
    company: str
    field_id: int | None
    value: Any  # choice name(s) for Status, wiki text for Comment
    raw: dict

    @property
    def slot(self) -> str:
        """Canonical key such as ``'supplier_status'``."""
        return f"{self.party.lower()}_{self.kind.lower()}"


@dataclass
class CompanyReview:
    """The four review slots for one company on one requirement."""

    company: str
    supplier_status: Any = None
    supplier_comment: Any = None
    customer_status: Any = None
    customer_comment: Any = None
    # slot -> fieldId, so values can be written back later.
    field_ids: dict[str, int | None] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "company": self.company,
            "supplier_status": self.supplier_status,
            "supplier_comment": self.supplier_comment,
            "customer_status": self.customer_status,
            "customer_comment": self.customer_comment,
            "field_ids": dict(self.field_ids),
        }


def parse_review_field_name(name: str | None) -> tuple[str, str, str] | None:
    """Parse a field name into ``(party, kind, company)`` or ``None``.

    ``party`` and ``kind`` are normalised to title case; ``company`` keeps its
    original casing/spacing.
    """
    if not name:
        return None
    m = _NAME_RE.match(name)
    if not m:
        return None
    return m.group("party").capitalize(), m.group("kind").capitalize(), m.group("company").strip()


def _field_value(cf: dict) -> Any:
    """Simplify a custom-field payload to a scalar (or list for multi-choice)."""
    value = cf.get("value")
    if value is not None:
        return value
    values = cf.get("values")
    if values:
        names = [v.get("name") if isinstance(v, dict) else v for v in values]
        names = [n for n in names if n is not None]
        if not names:
            return None
        return names[0] if len(names) == 1 else names
    return None


def extract_review_fields(item: dict) -> list[ReviewField]:
    """Return all Supplier/Customer Status/Comment fields present on ``item``."""
    result: list[ReviewField] = []
    for cf in item.get("customFields") or []:
        parsed = parse_review_field_name(cf.get("name"))
        if parsed is None:
            continue
        party, kind, company = parsed
        result.append(
            ReviewField(
                party=party,
                kind=kind,
                company=company,
                field_id=cf.get("fieldId"),
                value=_field_value(cf),
                raw=cf,
            )
        )
    return result


def build_review_matrix(item: dict) -> dict[str, CompanyReview]:
    """Group the review fields of ``item`` by company."""
    matrix: dict[str, CompanyReview] = {}
    for rf in extract_review_fields(item):
        review = matrix.setdefault(rf.company, CompanyReview(company=rf.company))
        setattr(review, rf.slot, rf.value)
        review.field_ids[rf.slot] = rf.field_id
    return matrix


def collect_companies(items: Iterable[dict]) -> list[str]:
    """Return the sorted set of company names seen across ``items``."""
    companies: set[str] = set()
    for item in items:
        for rf in extract_review_fields(item):
            companies.add(rf.company)
    return sorted(companies)


def index_review_fields(item_fields: dict) -> dict[tuple[str, str, str], dict]:
    """Map ``(party, kind, company)`` -> field metadata from an item's fields.

    ``item_fields`` is the response of ``GET /items/{id}/fields`` (with
    ``editableFields`` / ``readOnlyFields``). Unlike an item's ``customFields``
    list, this enumerates *every* review field of the tracker, including the
    ones that are currently empty, so writes can target a company/slot even
    when the requirement has no value yet.
    """
    index: dict[tuple[str, str, str], dict] = {}
    for editable, key in ((True, "editableFields"), (False, "readOnlyFields")):
        for f in item_fields.get(key) or []:
            parsed = parse_review_field_name(f.get("name"))
            if parsed is None:
                continue
            index[parsed] = {
                "field_id": f.get("fieldId"),
                "editable": editable,
                "type": f.get("type"),
                "name": f.get("name"),
            }
    return index
