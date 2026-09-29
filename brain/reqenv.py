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

v0.75 KEY-IN-FLIGHT MINIMIZATION (two new surfaces):

  * X-Keyed-Providers — a comma-separated list of env-var NAMES the user
    has keys for (no values; the engine's /models fan-out). The presence
    set lives in its own ContextVar and only ever makes has_key() True —
    there is no value to leak, misuse, or log.
  * key_source(env_var) — "user" when THIS request carried the value,
    "shared" when it fell back to the space's secret, "" when neither
    (no key at all). The /chat error events carry it so the app can say
    "your key was rejected" vs "the community key is unavailable".
"""
from __future__ import annotations

from contextvars import ContextVar

# Per-request X-Env-* values ({} outside a request — see set_request_env).
_REQ_ENV: ContextVar[dict] = ContextVar("doomalay_req_env", default={})
# Per-request presence-only keyed names (v0.75 — no values ever).
_REQ_KEYED: ContextVar[frozenset] = ContextVar("doomalay_req_keyed", default=frozenset())


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


def extract_keyed(request) -> frozenset:
    """Collect X-Keyed-Providers (presence-only names, v0.75).

    The engine's /models call lists WHICH providers the user has keys for
    so the catalog can show them — the VALUES stay on the device. Names
    are uppercased + whitespace-stripped; anything malformed is dropped.
    """
    names: set[str] = set()
    try:
        raw = request.headers.get("X-Keyed-Providers", "")
        for part in str(raw).split(","):
            part = part.strip().upper()
            if part and re_ok(part):
                names.add(part)
    except Exception:
        pass
    return frozenset(names)


def re_ok(name: str) -> bool:
    """A keyed name must look like an ENV_VAR (letters/digits/underscore)."""
    return all(c.isalnum() or c == "_" for c in name) and name[0].isalpha()


def set_request_env(env: dict, keyed=frozenset()) -> None:
    """Bind this request's X-Env values (and the presence set) for the
    current async context."""
    _REQ_ENV.set(dict(env or {}))
    if keyed:
        _REQ_KEYED.set(frozenset(keyed))
    else:
        _REQ_KEYED.set(frozenset())


def get_request_env() -> dict:
    """The X-Env values of the request serving the CURRENT context."""
    return _REQ_ENV.get()


def get_request_keyed() -> frozenset:
    """The presence-only keyed names of the current request (v0.75)."""
    return _REQ_KEYED.get()


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
    """Key-presence check (str or list env_var, catalog style).

    v0.75: the presence-only keyed set counts too — /models on a shared
    space must show the user's providers WITHOUT their values crossing.
    """
    if not env_var:
        return False
    if isinstance(env_var, (list, tuple)):
        return any(has_key(str(v)) for v in env_var if v)
    env_var = str(env_var)
    req = _REQ_ENV.get()
    if req.get(env_var):
        return True
    if env_var in _REQ_KEYED.get():
        return True
    return bool(os_environ().get(env_var))


def key_source(env_var: str) -> str:
    """WHOSE key is this turn riding? (v0.75 error attribution)

    "user"   — this request carried the value (BYOK: the user's own key)
    "shared" — the space's own secret is backing the turn
    ""       — no key at all (the caller should fail honestly)
    """
    if not env_var:
        return ""
    req = _REQ_ENV.get()
    if req.get(env_var):
        return "user"
    if os_environ().get(env_var, ""):
        return "shared"
    return ""


def os_environ() -> dict:
    """os.environ as a plain dict (isolated for tests)."""
    import os
    return dict(os.environ)
