"""pm_sidecar.py — THE PRIVATEMODE ENGINE BRIDGE RESOLVER (v1.44.5).

v0.91.8 ran a Node sidecar here: brain/pmproxy.mjs, a Node shim exposing
the plain OpenAI wire on loopback:8530 and doing PM's E2E-encrypted calls
through the vendored npm SDK (a 6MB wasm). RETIRED — since v1.44.3 THE
WIRE the ENGINE speaks PM's protocol itself (pure Go, the pinned client
in engine/internal/pmstate), and it exposes the plain OpenAI wire for
this co-located brain:

    POST {DOOMALAY_ENGINE_URL}/api/pm/local/v1/chat/completions
    Authorization: Bearer <the vault's PrivateMode key>

The engine injects DOOMALAY_ENGINE_URL before spawning this process
(cmd/doomalay/main.go); it defaults to http://127.0.0.1:8080. The
per-request key rides litellm's normal Authorization header — the bridge
enforces the official proxy's --api-key-fallback=never law (constant-time
exact match against the vault's PM key).

NO Node. NO wasm. NO spawn. One env read. When the engine is not
co-located (an HF-space brain runs standalone), PM is honestly
unavailable: providers.py skips the provider (the catalog's
{DOOMALAY_ENGINE_URL} placeholder requires it) and agent turns route to
other providers — never a silent fallback.
"""
from __future__ import annotations

import os

_DEFAULT_ENGINE_URL = "http://127.0.0.1:8080"
_BRIDGE_PATH = "/api/pm/local/v1/chat/completions"


def _engine_url() -> str | None:
    """The co-located engine's base URL, or None when we run brain-only."""
    return (os.environ.get("DOOMALAY_ENGINE_URL", "") or "").strip().rstrip("/") or None


def pm_proxy_chat_url() -> str | None:
    """The PM chat URL on the engine's local bridge (None = no co-located
    engine — the caller skips PM honestly; kept for the v0.91.8 callers).

    The old contract spawned the Node shim lazily here; the engine bridge
    needs no lifecycle — the ENGINE owns the pin, the secret, the renewals.
    """
    base = _engine_url()
    if base is None:
        return None
    return base + _BRIDGE_PATH


def pm_engine_base() -> str | None:
    """The co-located engine's base URL (litellm appends the wire path).
    agent_core's resolver uses this as the PM chat base; None = no
    co-located engine (the registration gate already skipped PM)."""
    return _engine_url()


def pm_proxy_running() -> bool:
    """The cheap check (no spawn, no probe) — for /health reporting."""
    return _engine_url() is not None
