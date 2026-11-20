"""Unified secret vault backed by OS keyring with safe optional in-memory fallback."""

from __future__ import annotations

import logging
import threading
from typing import Any

from src.settings_store import SystemVault, get_store

logger = logging.getLogger(__name__)


class MemoryVault:
    """In-memory vault for isolated unit tests or environments without OS keyring."""

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self._lock = threading.RLock()

    def get(self, name: str) -> Any:
        with self._lock:
            return self._data.get(name)

    def set(self, name: str, value: Any) -> None:
        with self._lock:
            self._data[name] = value

    def delete(self, name: str) -> None:
        with self._lock:
            self._data.pop(name, None)


class KeyringVault(SystemVault):
    """OS keyring vault that also registers secret names in settings_store."""

    def set(self, name: str, value: Any) -> None:
        super().set(name, value)
        get_store().register_secret(name)


class UnifiedVault:
    """Single vault facade used by connectors, MCP servers, and core services."""

    def __init__(
        self, backend: Any = None, *, allow_memory_fallback: bool = True
    ) -> None:
        self._backend = backend
        self._allow_memory_fallback = allow_memory_fallback
        self._lock = threading.RLock()

    def _ensure_backend(self) -> Any:
        with self._lock:
            if self._backend is not None:
                return self._backend
            try:
                self._backend = KeyringVault()
            except Exception as exc:
                if not self._allow_memory_fallback:
                    raise
                logger.warning(
                    "OS keyring unavailable (%s); using in-memory fallback vault.", exc
                )
                self._backend = MemoryVault()
            return self._backend

    def get(self, name: str) -> Any:
        return self._ensure_backend().get(name)

    def set(self, name: str, value: Any) -> None:
        self._ensure_backend().set(name, value)

    def delete(self, name: str) -> None:
        backend = self._ensure_backend()
        if hasattr(backend, "delete"):
            backend.delete(name)


_default_vault: UnifiedVault | None = None


def get_vault() -> UnifiedVault:
    global _default_vault
    if _default_vault is None:
        _default_vault = UnifiedVault()
    return _default_vault
