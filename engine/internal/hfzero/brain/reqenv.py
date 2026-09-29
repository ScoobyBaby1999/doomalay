"""reqenv.py — the per-request environment (v0.72: BYOK on shared spaces).

The engine sends the user's vault entries as X-Env-<NAME> headers on every
/chat, /models and /judge call to a space (engine/internal/brain/remote.go
applyAuth). On the user's OWN space that is fine. On the SHARED community
space it is "bring your own key": many users, one process — and the old
injection (`os.environ[name] = value`) was PROCESS-GLOBAL:

  * two concurrent turns RACE (user B's key overwrites user A's mid-turn),
  * injected keys never leave os.environ, so user B's keyless turn would
    silently use user A's leftover key.

The fix: X-Env values live in a per-request dict, resolved per request —
the user's key when present, the space's own secret (os.environ — the
community public keys) as the fallback. This module carries the values
that tools read AT CALL TIME (dt_hf's HF token) via a ContextVar, which
propagates through the request's async context (the SSE generator, the
strands agent, and asyncio.to_thread tool calls). Anything reading outside
a request context gets {} and falls back to os.environ — never worse than
the pre-v0.72 behavior.
"""
from __future__ import annotations

from contextvars import ContextVar

# Per-request X-Env-* values ({} outside a request — see set_request_env).
_REQ_ENV: ContextVar[dict] = ContextVar("doomalay_req_env", default={})


def extract(request) -> dict:
    """Collect the X-Env-* headers of a request into a fresh dict.

    Header names are uppercased after the "x-env-" strip so the lookup keys
    match provider env_var spellings exactly (PRIVATEMODEAI_API_KEY etc.).
    Never writes to os.environ — the whole point.
    """
    out: dict[str, str] = {}
    try:
        for h_name, h_val in request.headers.items():
            if h_name.lower().startswith("x-env-"):
                out[h_name[6:].upper()] = h_val
    except Exception:
        pass
    return out


def set_request_env(env: dict) -> None:
    """Bind this request's X-Env values for the current async context."""
    _REQ_ENV.set(dict(env or {}))


def get_request_env() -> dict:
    """The X-Env values of the request serving the CURRENT context."""
    return _REQ_ENV.get()


def resolve_key(env_var: str) -> str:
    """BYOK resolution order: the user's own key (per-request) first, then
    the space's own secret (os.environ — the community public keys)."""
    if not env_var:
        return ""
    req = _REQ_ENV.get()
    if req.get(env_var):
        return str(req[env_var])
    return str(os_environ().get(env_var, ""))


def has_key(env_var) -> bool:
    """Key-presence check (str or list env_var, catalog style)."""
    if not env_var:
        return False
    if isinstance(env_var, (list, tuple)):
        return any(has_key(str(v)) for v in env_var if v)
    return bool(resolve_key(str(env_var)))


def os_environ() -> dict:
    """os.environ as a plain dict (isolated for tests)."""
    import os
    return dict(os.environ)
