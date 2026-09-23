"""
Session persistence — serialize / deserialize requests.Session cookies.

Sessions are stored as JSON files on disk so they survive container restarts
(when backed by a Docker volume).

Each session is keyed by ``(tool_key, username)`` to support multiple users.
A SHA-256 hash of the password is stored alongside so that the API can validate
the caller before returning cookies.
"""

import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional, Tuple

import requests

log = logging.getLogger("session_keeper.store")

# Default storage directory (overridable via SESSION_STORE_DIR env var)
_DEFAULT_STORE_DIR = "/data/sessions"


def _hash_password(password: str) -> str:
    """Return a hex SHA-256 digest for credential validation."""
    return hashlib.sha256(password.encode()).hexdigest()


@dataclass
class KeepaliveStatus:
    """Tracks the last keep-alive result for a session."""
    last_ping: float = 0.0
    alive: bool = True
    error: str = ""


class SessionStore:
    """Thread-safe store that persists session cookies as JSON files.

    Sessions are keyed by a composite ``(tool_key, username)`` tuple.
    """

    def __init__(self, store_dir: Optional[str] = None):
        self._dir = Path(store_dir or os.getenv("SESSION_STORE_DIR", _DEFAULT_STORE_DIR))
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._sessions: Dict[str, requests.Session] = {}
        self._password_hashes: Dict[str, str] = {}
        self._keepalive_status: Dict[str, KeepaliveStatus] = {}
        self._load_all()

    # ------------------------------------------------------------------ #
    # Key helpers                                                        #
    # ------------------------------------------------------------------ #

    @staticmethod
    def make_key(tool_key: str, username: str) -> str:
        """Create a composite storage key from tool and username."""
        return f"{tool_key}::{username}"

    @staticmethod
    def split_key(composite_key: str) -> Tuple[str, str]:
        """Split a composite key back into (tool_key, username)."""
        tool_key, username = composite_key.split("::", 1)
        return tool_key, username

    # ------------------------------------------------------------------ #
    # Public API                                                         #
    # ------------------------------------------------------------------ #

    def get(self, tool_key: str, username: str) -> Optional[requests.Session]:
        """Return a live Session object for *(tool_key, username)*, or ``None``."""
        key = self.make_key(tool_key, username)
        with self._lock:
            return self._sessions.get(key)

    def validate_and_get(self, tool_key: str, username: str, password: str) -> Optional[requests.Session]:
        """Return session only if credentials match. Returns ``None`` otherwise."""
        key = self.make_key(tool_key, username)
        with self._lock:
            stored_hash = self._password_hashes.get(key)
            if stored_hash is None:
                return None
            if stored_hash != _hash_password(password):
                return None
            return self._sessions.get(key)

    def put(self, tool_key: str, username: str, password: str, session: requests.Session) -> None:
        """Store *session* under *(tool_key, username)* and persist to disk."""
        key = self.make_key(tool_key, username)
        with self._lock:
            self._sessions[key] = session
            self._password_hashes[key] = _hash_password(password)
            self._persist(key, username, password, session)

    def delete(self, tool_key: str, username: str) -> bool:
        """Remove a stored session. Returns ``True`` if it existed."""
        key = self.make_key(tool_key, username)
        with self._lock:
            removed = self._sessions.pop(key, None) is not None
            self._password_hashes.pop(key, None)
            path = self._path_for(key)
            if path.exists():
                path.unlink()
            return removed

    def delete_by_key(self, composite_key: str) -> bool:
        """Remove a stored session by composite key. Used by keep-alive."""
        with self._lock:
            removed = self._sessions.pop(composite_key, None) is not None
            self._password_hashes.pop(composite_key, None)
            path = self._path_for(composite_key)
            if path.exists():
                path.unlink()
            return removed

    def keys(self) -> list:
        with self._lock:
            return list(self._sessions.keys())

    def get_by_composite_key(self, composite_key: str) -> Optional[requests.Session]:
        """Get session by composite key. Used by keep-alive."""
        with self._lock:
            return self._sessions.get(composite_key)

    def record_keepalive(self, composite_key: str, alive: bool, error: str = "") -> None:
        """Record the result of a keep-alive ping."""
        with self._lock:
            self._keepalive_status[composite_key] = KeepaliveStatus(
                last_ping=time.time(), alive=alive, error=error,
            )

    def get_keepalive_status(self, composite_key: str) -> Optional[KeepaliveStatus]:
        """Return the last keep-alive status for a session."""
        with self._lock:
            return self._keepalive_status.get(composite_key)

    def get_stored_at(self, composite_key: str) -> Optional[float]:
        """Return the stored_at timestamp from the persisted JSON."""
        path = self._path_for(composite_key)
        if path.exists():
            try:
                data = json.loads(path.read_text())
                return data.get("stored_at")
            except Exception:
                return None
        return None

    def put_by_composite_key(self, composite_key: str, session: requests.Session) -> None:
        """Re-persist session by composite key (keep-alive cookie refresh)."""
        with self._lock:
            self._sessions[composite_key] = session
            # Re-persist with existing metadata
            path = self._path_for(composite_key)
            if path.exists():
                data = json.loads(path.read_text())
                data["cookies"] = self._cookies_to_dict(session)
                data["stored_at"] = time.time()
                path.write_text(json.dumps(data, indent=2))


    # ------------------------------------------------------------------ #
    # Serialization helpers                                              #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _cookies_to_dict(session: requests.Session) -> list:
        """Convert a cookie jar to a JSON-serializable list of dicts."""
        cookies = []
        for cookie in session.cookies:
            cookies.append({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": cookie.secure,
                "expires": cookie.expires,
            })
        return cookies

    @staticmethod
    def _dict_to_session(cookies: list) -> requests.Session:
        """Reconstruct a Session from a list of cookie dicts."""
        session = requests.Session()
        for c in cookies:
            session.cookies.set(
                c["name"],
                c["value"],
                domain=c.get("domain", ""),
                path=c.get("path", "/"),
            )
        return session

    # ------------------------------------------------------------------ #
    # Disk I/O                                                           #
    # ------------------------------------------------------------------ #

    def _path_for(self, composite_key: str) -> Path:
        safe_name = composite_key.replace("/", "_").replace("\\", "_").replace("::", "__")
        return self._dir / f"{safe_name}.json"

    def _persist(self, composite_key: str, username: str, password: str, session: requests.Session) -> None:
        path = self._path_for(composite_key)
        tool_key, _ = self.split_key(composite_key)
        data = {
            "tool_key": tool_key,
            "username": username,
            "password_hash": _hash_password(password),
            "cookies": self._cookies_to_dict(session),
            "stored_at": time.time(),
        }
        path.write_text(json.dumps(data, indent=2))
        log.debug("Persisted session for %s → %s", composite_key, path)

    def _load_all(self) -> None:
        """Load every ``*.json`` file from the store directory."""
        for path in self._dir.glob("*.json"):
            try:
                data = json.loads(path.read_text())
                tool_key = data["tool_key"]
                username = data.get("username", "unknown")
                composite_key = self.make_key(tool_key, username)
                session = self._dict_to_session(data["cookies"])
                self._sessions[composite_key] = session
                if "password_hash" in data:
                    self._password_hashes[composite_key] = data["password_hash"]
                log.info("Loaded persisted session for %s (user=%s)", tool_key, username)
            except Exception:
                log.warning("Failed to load session from %s", path, exc_info=True)
