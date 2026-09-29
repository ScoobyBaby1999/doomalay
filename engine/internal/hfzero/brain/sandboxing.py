"""sandboxing.py — v0.75 shared-disk isolation (the Phase 3 hardening).

THE RED-TEAM FINDING this module fixes: the community Space's containment
was ONLY the shell's cwd + the session_id whitelist. The shell itself
(``subprocess.run(shell=True, cwd=ws)``) can ``cat`` ANY path on the
container — another user's workspace, /data, anything readable by the
brain's uid — and the in-process strands tools (file_read / file_write /
editor / glob / grep / environment) ran as the SAME root process with
NO path restriction at all, plus strands' ``environment`` tool could
list (and even SET) process env vars — the community keys.

Three layers, all enabled together when the brain runs as root on a
shared space (``DOOMALAY_SHARED=1``, or explicitly via
``DOOMALAY_SANDBOX_ISOLATION=1``; kill switch: ``=0``):

1. PER-USER NAMESPACE — the wrapper scopes every workspace under
   ``ROOT/<verified-hf-username>/<session>`` (see sanitize_chat_body —
   extracted from the wrappers so tests lock it). One user's turn can't
   even NAME another user's workspace without guessing both their HF
   username and the opaque session id.
2. PER-SESSION UID — every workspace gets a deterministic unprivileged
   uid (20000 + HMAC(secret, path) % 40000; the secret lives root-only
   at ``<user-dir>/.uidkey``) and mode 0700. shell / python_repl /
   install / parallel subprocesses demote to that uid (setgid+setuid)
   — a shell can no longer READ another workspace even by absolute
   path, and the in-process strands file tools are guarded to the
   workspace too (agent.py wires guard_tool over them).
3. ENV TRUTH — subprocess envs are secret-stripped (_safe_env) with
   HOME pointed INTO the workspace; the strands ``environment`` tool
   is replaced by a read-only, secret-stripped twin (set/delete
   refused — the process-global write was the v0.72 race reborn).

Residual risk (documented, accepted): the brain process itself still
runs as root between tool calls; anything root does outside these tool
paths is out of scope here. Local (engine-side) brains run as a normal
user → cooperative mode (namespace + guards, no uid) — never worse
than pre-v0.75.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from pathlib import Path

# The uid band: 20000..59999 — above system users, inside the typical
# container's dynamic range. Collisions within it are impossible to
# engineer without the per-user-tree secret (grinding the HMAC needs
# the key, which is 0600-root).
UID_BASE = 20000
UID_SPAN = 40000

# Tool-call parameter names that carry filesystem paths (the guard set —
# anything the LLM can aim at the filesystem).
PATH_PARAM_NAMES = (
    "path", "file_path", "dir_path", "directory", "root_dir",
    "target_dir", "filename", "file",
)

_SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]")


def sanitize_chat_body(body: bytes, wroot, user: str) -> bytes:
    """The /chat body rewrite every wrapper performs (v0.75: + per-user
    namespace + sandbox_user injection). Extracted from the ASGI wrappers
    so the brain tests can lock the exact semantics:

      · session_id  → [a-zA-Z0-9_-]{1,64} (else "anon")
      · workspace   → <wroot>/<user>/<name-or-sid> (name whitelisted the
        same way — traversal and absolute paths never survive)
      · sandbox_user → the verified HF username (informational)

    Returns the ORIGINAL bytes unchanged for non-JSON/broken bodies (the
    brain's own 400s handle those).
    """
    try:
        data = json.loads(body or b"{}")
        if not isinstance(data, dict):
            return body
    except Exception:
        return body
    sid = _SAFE_NAME_RE.sub("", str(data.get("session_id", "")))[:64]
    data["session_id"] = sid or "anon"
    ws_name = _SAFE_NAME_RE.sub("", str(data.get("workspace", "")))[:64]
    user = _SAFE_NAME_RE.sub("", str(user or ""))[:32] or "anon"
    data["workspace"] = str(Path(wroot) / user / (ws_name or sid or "anon"))
    data["sandbox_user"] = user
    return json.dumps(data).encode()


def isolation_enabled() -> bool:
    """True when the uid sandbox should arm: running as root AND a shared
    deployment (DOOMALAY_SHARED=1) or explicitly opted-in
    (DOOMALAY_SANDBOX_ISOLATION=1). ``DOOMALAY_SANDBOX_ISOLATION=0`` is
    the kill switch (own spaces default OFF — one human, their machine,
    unchanged behavior)."""
    if os.environ.get("DOOMALAY_SANDBOX_ISOLATION", "").strip() == "0":
        return False
    if os.environ.get("DOOMALAY_SANDBOX_ISOLATION", "").strip() == "1":
        return os.geteuid() == 0
    return os.geteuid() == 0 and os.environ.get("DOOMALAY_SHARED", "").strip() == "1"


def _uid_key(user_dir: Path) -> bytes:
    """The per-user-tree HMAC secret: root-only file, generated once.
    Persisted under /data → survives restarts (uids stay stable)."""
    key_path = user_dir / ".uidkey"
    try:
        data = key_path.read_bytes()
        if data:
            return data
    except Exception:
        pass
    data = os.urandom(32)
    try:
        user_dir.mkdir(parents=True, exist_ok=True)
        key_path.write_bytes(data)
        os.chmod(key_path, 0o600)  # root-only (the brain is root here)
    except Exception:
        pass
    return data


def sandbox_uid_for(ws_path, key: bytes) -> int:
    """Deterministic per-workspace unprivileged uid (HMAC-keyed — the
    session id alone can't be ground to collide with a victim)."""
    digest = hmac.new(key, str(Path(ws_path).resolve()).encode(), hashlib.sha256).digest()
    return UID_BASE + int.from_bytes(digest[:4], "big") % UID_SPAN


def prepare_workspace(ws) -> dict:
    """Create + lock a workspace directory. Returns the sandbox report:
    ``{"uid": int|None, "mode": "uid"|"cooperative", "user": str}``.
    uid mode: dir owned by the per-session uid, mode 0700 (a restart that
    changes nothing keeps everything; a NEW uid — only possible if the
    secret was regenerated — re-chowns the tree). The parent (per-user)
    dir gets 0711 — traversable by the sandbox uid, NOT listable by the
    others (no session-name enumeration)."""
    ws = Path(ws)
    ws.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(ws.parent, 0o711)  # traverse-only for the namespace dir
    except Exception:
        pass
    if not isolation_enabled():
        try:
            os.chmod(ws, 0o700)  # cooperative mode still tightens
        except Exception:
            pass
        return {"uid": None, "mode": "cooperative", "user": ""}
    user_dir = ws.parent
    key = _uid_key(user_dir)
    uid = sandbox_uid_for(ws, key)
    _chown_tree(ws, uid)
    try:
        os.chmod(ws, 0o700)
    except Exception:
        pass
    return {"uid": uid, "mode": "uid", "user": user_dir.name or ""}


def _chown_tree(root: Path, uid: int) -> None:
    """chown the workspace (top + contents) to the sandbox uid — only
    walked when the top dir isn't already owned by it (restarts are
    free; a fresh secret re-owns in one pass)."""
    try:
        if os.stat(root).st_uid == uid:
            return
    except Exception:
        return
    for dirpath, _dirnames, filenames in os.walk(root):
        try:
            os.chown(dirpath, uid, uid)
        except Exception:
            return
        for f in filenames:
            try:
                os.chown(os.path.join(dirpath, f), uid, uid)
            except Exception:
                pass


def demote(uid: int):
    """The subprocess preexec_fn: drop to the sandbox uid before exec.
    setgroups([]) first (no inherited groups), then gid, then uid."""
    def _pre():
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        os.umask(0o077)
    return _pre


def path_in_workspace(candidate: str, ws) -> bool:
    """Containment check after FULL resolution (symlinks, .., absolute,
    relative, ~-free). The workspace itself is the only legal root."""
    try:
        ws_r = Path(ws).resolve()
        c = Path(str(candidate)).expanduser()
        if not c.is_absolute():
            c = Path(ws).resolve() / c
        c = c.resolve()
        return c == ws_r or ws_r in c.parents
    except Exception:
        return False


def violating_path_arg(params: dict, ws) -> "str | None":
    """The first path-carrying argument that escapes the workspace (or
    None). params = the tool-call input dict (either calling convention
    lands here — the guard normalizes)."""
    for name in PATH_PARAM_NAMES:
        v = params.get(name)
        if isinstance(v, str) and v.strip() and not path_in_workspace(v, ws):
            return v
    return None


def safe_subprocess_env(ws, base=None) -> dict:
    """The subprocess environment: the secret-stripped base (agent.py's
    _safe_env) + HOME inside the workspace (pip --user, npm, git all
    write THERE) + the npm prefix + the honest sandbox markers the
    red-team can assert from inside a turn."""
    env = dict(base if base is not None else os.environ)
    for k in list(env.keys()):
        if any(s in k.upper() for s in ("API_KEY", "TOKEN", "SECRET", "PASSWORD", "PAT")):
            del env[k]
    ws = str(Path(ws))
    env["HOME"] = ws
    env["npm_config_prefix"] = os.path.join(ws, ".npm-global")
    env["DOOMALAY_SANDBOX"] = "1"
    return env


def isolation_report() -> dict:
    """The /health-visible state (the red-team + the suite read it)."""
    try:
        euid = os.geteuid()
    except Exception:
        euid = -1
    return {
        "isolation": "uid" if isolation_enabled() else "cooperative",
        "euid": euid,
        "kill_switch": os.environ.get("DOOMALAY_SANDBOX_ISOLATION", ""),
    }
