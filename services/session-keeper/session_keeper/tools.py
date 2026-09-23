"""
Per-tool configuration for the session keeper service.

Each tool entry defines:
- ``app_url``       — the URL used by ``bmw_sso_session`` for login
- ``keepalive_url`` — a lightweight URL hit periodically to keep the session alive
- ``strong_auth``   — whether the tool requires strong authentication
- ``strong_auth_type`` — ``"mobile"`` or ``"yubikey"``

Additional tools can be added by extending ``TOOL_REGISTRY`` or by loading
a user-supplied YAML/JSON config file (see ``load_extra_tools``).
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, Optional

log = logging.getLogger("session_keeper.tools")


class ToolConfig:
    """Configuration for a single tool."""

    def __init__(
        self,
        key: str,
        app_url: str,
        keepalive_url: str,
        strong_auth: bool = False,
        strong_auth_type: str = "mobile",
    ):
        self.key = key
        self.app_url = app_url
        self.keepalive_url = keepalive_url
        self.strong_auth = strong_auth
        self.strong_auth_type = strong_auth_type

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "app_url": self.app_url,
            "keepalive_url": self.keepalive_url,
            "strong_auth": self.strong_auth,
            "strong_auth_type": self.strong_auth_type,
        }


# ------------------------------------------------------------------ #
# Built-in tool definitions                                          #
# ------------------------------------------------------------------ #

TOOL_REGISTRY: Dict[str, ToolConfig] = {
    "appcockpit": ToolConfig(
        key="appcockpit",
        app_url="https://appcockpit.bmwgroup.net/auth/authenticate",
        keepalive_url="https://appcockpit.bmwgroup.net/home",
        strong_auth=True,
    ),
    "vps_emea_prod": ToolConfig(
        key="vps_emea_prod",
        app_url="https://vps-emea-prod.bmwgroup.net/vps-admin/home",
        keepalive_url="https://vps-emea-prod.bmwgroup.net/vps-admin/home",
        strong_auth=True,
    ),
    "vps_emea_int": ToolConfig(
        key="vps_emea_int",
        app_url="https://vps-emea-e2e.bmwgroup.net/vps-admin/home",
        keepalive_url="https://vps-emea-e2e.bmwgroup.net/vps-admin/home",
        strong_auth=True,
    ),
    "vps_us_prod": ToolConfig(
        key="vps_us_prod",
        app_url="https://vps-us-prod.bmwgroup.net/vps-admin/home",
        keepalive_url="https://vps-us-prod.bmwgroup.net/vps-admin/home",
        strong_auth=True,
    ),
    "vps_cn_prod": ToolConfig(
        key="vps_cn_prod",
        app_url="https://vps-cn-prod.bmwgroup.net/vps-admin/home",
        keepalive_url="https://vps-cn-prod.bmwgroup.net/vps-admin/home",
        strong_auth=True,
    ),
    "octane": ToolConfig(
        key="octane",
        app_url="https://octane-prod.bmwgroup.net",
        keepalive_url="https://octane-prod.bmwgroup.net/ui/?p=1002/2001",
        strong_auth=False,
    ),
    "codebeamer": ToolConfig(
        key="codebeamer",
        app_url="https://tokenhelper.azure.cloud.bmw/Home/Prod",
        keepalive_url="https://tokenhelper.azure.cloud.bmw/Home/Prod",
        strong_auth=True,
    ),
}


def get_tool(key: str) -> Optional[ToolConfig]:
    """Return tool config by key, or ``None``."""
    return TOOL_REGISTRY.get(key)


def list_tools() -> Dict[str, ToolConfig]:
    """Return all registered tools."""
    return dict(TOOL_REGISTRY)


def load_extra_tools(path: Optional[str] = None) -> None:
    """
    Load additional tool definitions from a JSON file.

    Expected format::

        [
            {
                "key": "my_tool",
                "app_url": "https://...",
                "keepalive_url": "https://...",
                "strong_auth": true,
                "strong_auth_type": "mobile"
            }
        ]
    """
    config_path = Path(path or os.getenv("SESSION_KEEPER_TOOLS_CONFIG", ""))
    if not config_path.is_file():
        return
    try:
        tools = json.loads(config_path.read_text())
        for entry in tools:
            tc = ToolConfig(**entry)
            TOOL_REGISTRY[tc.key] = tc
            log.info("Loaded extra tool config: %s", tc.key)
    except Exception:
        log.warning("Failed to load extra tools from %s", config_path, exc_info=True)
