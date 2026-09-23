"""Reconstruct a Codebeamer tracker's heading outline (structure numbers).

Codebeamer does not store the outline number (e.g. ``6.16.1.3``) as a field.
It is derived from the position of an item among its siblings, walking down
the parent/child tree. On this instance the structural nodes are items of the
**Heading** category; every child (of any category) counts towards the sibling
index, so a heading's number is simply its 1-based position in its parent's
ordered ``children`` list.

``TrackerStructure`` fetches all headings once and computes every heading's
outline number, then offers lookups by number/prefix and helpers to collect
the requirements living underneath a given part of the document.

Example
-------
>>> from bmw_tools.codebeamer import CodebeamerClient, TrackerStructure
>>> client = CodebeamerClient()
>>> client.login("q123456", "pin")
>>> structure = TrackerStructure.from_client(client, 149687819)
>>> structure.outline_of(63413923)
'6.16.1.3'
>>> [h.outline for h in structure.headings_with_prefix('6.16')][:3]
['6.16', '6.16.1', '6.16.1.1']
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:  # avoid a runtime import cycle
    from .client import CodebeamerClient


def outline_sort_key(outline: str) -> tuple[int, ...]:
    """Return a numeric tuple so outline numbers sort naturally (6.2 < 6.10)."""
    return tuple(int(part) for part in outline.split(".") if part)


@dataclass
class HeadingNode:
    """A single heading (structural node) in a tracker."""

    id: int
    name: str | None
    ordinal: int
    parent_id: int | None
    child_ids: list[int] = field(default_factory=list)
    outline: str | None = None


class TrackerStructure:
    """The heading hierarchy of one tracker, with computed outline numbers."""

    def __init__(self, tracker_id: int, headings: dict[int, HeadingNode]):
        self.tracker_id = tracker_id
        self.headings = headings
        self._by_outline: dict[str, HeadingNode] = {}
        self._compute_outlines()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    @classmethod
    def from_client(cls, client: "CodebeamerClient", tracker_id: int) -> "TrackerStructure":
        """Fetch all headings of ``tracker_id`` and build the structure."""
        headings: dict[int, HeadingNode] = {}
        for item in client.iter_headings(tracker_id):
            headings[item["id"]] = HeadingNode(
                id=item["id"],
                name=item.get("name"),
                ordinal=item.get("ordinal") or 0,
                parent_id=(item.get("parent") or {}).get("id"),
                child_ids=[ch["id"] for ch in item.get("children") or []],
            )
        return cls(tracker_id, headings)

    def _compute_outlines(self) -> None:
        # Roots are headings with no parent, ordered by their ordinal.
        roots = sorted(
            (h for h in self.headings.values() if h.parent_id is None),
            key=lambda h: h.ordinal,
        )

        def assign(node: HeadingNode, prefix: str) -> None:
            node.outline = prefix
            self._by_outline[prefix] = node
            # child_ids is the full, ordered children list (all categories),
            # so the 1-based position is exactly the outline index.
            for index, child_id in enumerate(node.child_ids, start=1):
                child = self.headings.get(child_id)
                if child is not None:  # only headings carry the number forward
                    assign(child, f"{prefix}.{index}")

        for index, root in enumerate(roots, start=1):
            assign(root, str(index))

    # ------------------------------------------------------------------
    # Lookups
    # ------------------------------------------------------------------
    def outline_of(self, heading_id: int) -> str | None:
        """Return the outline number of a heading id (or ``None``)."""
        node = self.headings.get(heading_id)
        return node.outline if node else None

    def heading_by_outline(self, outline: str) -> HeadingNode | None:
        """Return the heading with exactly this outline number (or ``None``)."""
        return self._by_outline.get(outline)

    def headings_with_prefix(self, prefix: str) -> list[HeadingNode]:
        """Return the heading with ``prefix`` and all headings nested under it.

        ``'6.16'`` matches ``6.16`` itself plus ``6.16.1``, ``6.16.1.3`` etc.,
        but not ``6.160``. Results are sorted in document order.
        """
        dotted = prefix + "."
        matches = [
            h
            for h in self.headings.values()
            if h.outline is not None
            and (h.outline == prefix or h.outline.startswith(dotted))
        ]
        return sorted(matches, key=lambda h: outline_sort_key(h.outline or "0"))

    def child_outline(self, parent_id: int, child_id: int) -> str | None:
        """Outline number of a direct child (requirement or heading) of a heading.

        Uses the parent heading's ordered ``child_ids`` (which include all
        categories), so it works for requirement children too.
        """
        parent = self.headings.get(parent_id)
        if parent is None or parent.outline is None:
            return None
        try:
            index = parent.child_ids.index(child_id) + 1
        except ValueError:
            return None
        return f"{parent.outline}.{index}"

    # ------------------------------------------------------------------
    # Requirements underneath a part of the document
    # ------------------------------------------------------------------
    def requirement_parent_ids(self, prefix: str) -> list[int]:
        """Heading ids of the ``prefix`` subtree (the parents of its requirements)."""
        return [h.id for h in self.headings_with_prefix(prefix)]

    def iter_requirements_under(
        self,
        client: "CodebeamerClient",
        prefix: str,
        *,
        category: str = "Requirement",
        page_size: int = 100,
    ) -> Iterator[dict[str, Any]]:
        """Yield the requirement items living directly under the ``prefix`` subtree.

        On this tracker every item's *type* is ``Requirement``; the meaningful
        distinction is the *category* (``Heading`` / ``Information`` /
        ``Requirement`` / ``Folder``), so requirements are selected by
        ``category = 'Requirement'``.
        """
        parent_ids = self.requirement_parent_ids(prefix)
        yield from client.iter_items_under(
            self.tracker_id, parent_ids, category=category, page_size=page_size
        )
