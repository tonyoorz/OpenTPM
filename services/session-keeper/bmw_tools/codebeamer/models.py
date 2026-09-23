"""Lightweight data structures for evaluating tracker items (issues).

Codebeamer tracker items are large, deeply-nested JSON objects. For an
evaluation it is handy to flatten the fields we most care about into a small
dataclass (accessed as attributes) while still exposing everything else -
including tracker-specific *custom fields* - via ``item[key]`` key access.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Iterator


def _ref_name(value: Any) -> str | None:
    """Extract a human-readable name from a Codebeamer reference object."""
    if isinstance(value, dict):
        return value.get("name")
    return None


def _simplify_values(values: Any) -> Any:
    """Reduce a custom field's ``values`` list to plain, readable data.

    Codebeamer stores custom field values as a list of reference objects
    (e.g. ``[{"id": 879240, "name": "QM"}]``). For evaluation we return the
    bare ``name`` (or scalar) - a single value if there is exactly one,
    otherwise a list.
    """
    if not isinstance(values, list):
        return values
    simplified = [
        v.get("name") if isinstance(v, dict) and "name" in v else v for v in values
    ]
    if len(simplified) == 1:
        return simplified[0]
    return simplified


def _extract_custom_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Map custom field *name* -> simplified value for ``customFields``."""
    result: dict[str, Any] = {}
    for cf in data.get("customFields") or []:
        if not isinstance(cf, dict):
            continue
        name = cf.get("name")
        if name is None:
            continue
        result[name] = _simplify_values(cf.get("values"))
    return result


class _Missing:
    """Sentinel distinguishing 'absent' from a real ``None`` value."""


_MISSING = _Missing()


@dataclass
class Issue:
    """A Codebeamer tracker item.

    Standard fields are exposed as attributes (``issue.description``,
    ``issue.status``, ...). Everything else is reachable via key access:

      * ``issue["ASIL"]``      -> a custom field by name
      * ``issue[1003]``        -> a custom field by its ``fieldId``
      * ``issue["ordinal"]``   -> any raw top-level API field

    The full API payload is always kept on ``issue.raw``.
    """

    id: int
    name: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    tracker_id: int | None = None
    tracker_name: str | None = None
    assigned_to: list[str] = field(default_factory=list)
    created_at: str | None = None
    modified_at: str | None = None
    custom_fields: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> "Issue":
        tracker = data.get("tracker") or {}
        assigned = data.get("assignedTo") or []
        assigned_names = [n for n in (_ref_name(a) for a in assigned) if n]

        return cls(
            id=data["id"],
            name=data.get("name"),
            description=data.get("description"),
            status=_ref_name(data.get("status")),
            priority=_ref_name(data.get("priority")),
            tracker_id=tracker.get("id"),
            tracker_name=tracker.get("name"),
            assigned_to=assigned_names,
            created_at=data.get("createdAt"),
            modified_at=data.get("modifiedAt"),
            custom_fields=_extract_custom_fields(data),
            raw=data,
        )

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------
    @property
    def title(self) -> str | None:
        """Best available human label: the name, else the description.

        Requirement-style trackers often leave ``name`` empty and store the
        text in ``description``, so this is what you usually want to display.
        """
        return self.name or self.description

    # ------------------------------------------------------------------
    # Key access to custom / raw fields
    # ------------------------------------------------------------------
    def __getitem__(self, key: str | int) -> Any:
        value = self._lookup(key)
        if value is _MISSING:
            raise KeyError(key)
        return value

    def __contains__(self, key: object) -> bool:
        return self._lookup(key) is not _MISSING

    def get(self, key: str | int, default: Any = None) -> Any:
        value = self._lookup(key)
        return default if value is _MISSING else value

    def _lookup(self, key: Any) -> Any:
        # 1. custom field by name
        if key in self.custom_fields:
            return self.custom_fields[key]
        # 2. custom field by numeric fieldId
        for cf in self.raw.get("customFields") or []:
            if isinstance(cf, dict) and cf.get("fieldId") == key:
                return _simplify_values(cf.get("values"))
        # 3. any raw top-level API field
        if isinstance(key, str) and key in self.raw:
            return self.raw[key]
        return _MISSING

    def keys(self) -> Iterator[str]:
        """Custom field names available via key access."""
        return iter(self.custom_fields.keys())

    def to_dict(self, *, include_raw: bool = True) -> dict[str, Any]:
        data = asdict(self)
        if not include_raw:
            data.pop("raw", None)
        return data
