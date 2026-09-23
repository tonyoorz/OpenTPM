"""
BMW Codebeamer (ALM) client
===========================

Read/write client for a Codebeamer instance, plus helpers to flatten tracker
items (:class:`Issue`), reconstruct heading outlines (:class:`TrackerStructure`)
and extract supplier/customer review fields.

Usage::

    from bmw_tools.codebeamer import CodebeamerClient

    client = CodebeamerClient()
    client.login(username="q123456", password="pin")   # strong-auth push
    print(client.get_current_user()["name"])
"""

from .client import (
    BASE_URL,
    TOKENHELPER_URL,
    CodebeamerClient,
    CodebeamerError,
    TokenFetchError,
    fetch_codebeamer_token,
)
from .models import Issue
from .review_fields import (
    CompanyReview,
    ReviewField,
    build_review_matrix,
    collect_companies,
    extract_review_fields,
    index_review_fields,
    parse_review_field_name,
)
from .structure import HeadingNode, TrackerStructure, outline_sort_key

__all__ = [
    "BASE_URL",
    "TOKENHELPER_URL",
    "CodebeamerClient",
    "CodebeamerError",
    "TokenFetchError",
    "fetch_codebeamer_token",
    "Issue",
    "TrackerStructure",
    "HeadingNode",
    "outline_sort_key",
    "ReviewField",
    "CompanyReview",
    "extract_review_fields",
    "build_review_matrix",
    "collect_companies",
    "index_review_fields",
    "parse_review_field_name",
]
