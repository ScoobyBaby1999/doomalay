"""Doomalay SHARED sandbox — app.py for the community doomalaysocreate Space.

v0.46 UPGRADE ("previously developed HF space — upgraded to function better"):
the legacy monolith (agent_sessions/critique_service/chat_routes, 2026-06)
is replaced by the CURRENT Doomalay brain (the same Strands agent + tool
suite the desktop engine runs), fronted by this gate:

  - AUTH: every stateful route requires X-HF-Token — any valid HF access
    token, verified against whoami-v2 (5-min cache). The engine sends the
    user's own connected HF token. No token → 401 (the legacy space had NO
    auth — this is strictly better).
  - WORKSPACES: per-chat dirs under /data/workspaces/<sanitized-session-id>
    (falls back to /tmp when /data is absent). session_id is whitelisted to
    [a-zA-Z0-9_-]{1,64}; absolute paths and traversal never survive.
  - FAIRNESS: MAX_CONCURRENT_CHATS concurrent agent turns (429 beyond).

This is the SHARED variant of engine/internal/hfzero/template/app.py (the
own-space template) — same brain, same /chat SSE protocol, Docker SDK
instead of the ZeroGPU hack (this Space is grandfathered on Docker).

v0.91.5 refresh (rides the v0.91.3/4/5 waves):
  - THE SPACE'S FACE: the root serves the brain's PUBLIC_ROOT/index.html
    when one is published (the agent's work — a game, a dashboard); the
    static landing below stays the default. /pub is OPEN (same contract
    as the own-space templates).
  - THE SILENT-DEGRADATION LIGHT: /health reports the strands import
    state + the resolved version (the v0.91.4 live incident: the agent
    ran calculator-only for an hour while health kept saying ok).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

HERE = Path(__file__).parent

# ── config (baked for the shared deployment) ────────────────────────────────
SHARED_MODE = True  # this IS the shared space
# v0.75: arm the brain's per-session uid sandbox (brain/sandboxing.py reads
# this — root + shared → workspaces become 0700 uid-owned, subprocess tools
# demote, the strands file tools get path guards). Kill switch:
# DOOMALAY_SANDBOX_ISOLATION=0.
os.environ.setdefault("DOOMALAY_SHARED", "1")
ALLOW_UNAUTHED = os.environ.get("DOOMALAY_ALLOW_UNAUTHED", "").strip() in ("1", "true")
MAX_CONCURRENT_CHATS = int(os.environ.get("DOOMALAY_MAX_CONCURRENT_CHATS", "6"))
_WROOT = Path(os.environ.get(
    "DOOMALAY_WORKSPACES_ROOT",
    "/data/workspaces" if os.path.isdir("/data") else "/tmp/doomalay-workspaces",
))
_WROOT.mkdir(parents=True, exist_ok=True)
WORKSPACES_ROOT = _WROOT.resolve()


# ── the brain (sibling ./brain/server.py, loaded by file path) ──────────────
def _load_brain():
    spec = importlib.util.spec_from_file_location(
        "doomalay_brain_server", str(HERE / "brain" / "server.py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("brain/server.py not found next to app.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["doomalay_brain_server"] = mod
    spec.loader.exec_module(mod)
    return mod


brain_mod = _load_brain()
brain_app = brain_mod.app  # FastAPI: /health /models /templates /chat /judge /panel

# ── auth (pure ASGI — streaming-safe) ───────────────────────────────────────

OPEN_PATHS = {"/", "/health"}
OPEN_PREFIXES = ("/favicon.ico", "/ui", "/pub")

_hf_token_cache: dict[str, tuple[bool, str, float]] = {}


def _hf_token_valid(token: str) -> tuple[bool, str]:
    """Validate an HF access token via whoami-v2 (5-min cache).

    v0.75: returns (ok, username) — the verified identity feeds the
    per-user workspace namespace (ROOT/<user>/<session>) so one user's
    turn can never even NAME another user's workspace.
    """
    now = time.time()
    hit = _hf_token_cache.get(token)
    if hit is not None:
        ok, name, until = hit
        if now < until:
            return ok, name
    ok, name = False, ""
    try:
        import urllib.request
        req = urllib.request.Request(
            "https://huggingface.co/api/whoami-v2",
            headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=10) as r:
            ok = r.status == 200
            if ok:
                who = json.loads(r.read().decode("utf-8", "replace") or "{}")
                name = str(who.get("name") or "")
    except Exception:
        ok, name = False, ""
    _hf_token_cache[token] = (ok, name, now + 300)
    if len(_hf_token_cache) > 4096:
        _hf_token_cache.clear()
    return ok, name


def _authorized(headers: dict) -> tuple[bool, str, str]:
    """(ok, verified-user, why) — the user feeds the workspace namespace."""
    if ALLOW_UNAUTHED:
        return True, "dev", ""
    got = headers.get("x-hf-token", "")
    if got:
        ok, name = _hf_token_valid(got)
        if ok:
            return True, name or "anon", ""
    return False, "", "missing/invalid X-HF-Token (connect Hugging Face in the Doomalay app)"


_CHAT_SEM = {"n": 0}


class DoomalayGate:
    """Auth on stateful routes + /chat body sanitization + concurrency cap."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path in OPEN_PATHS or path.startswith(OPEN_PREFIXES):
            await self.app(scope, receive, send)
            return
        headers = {}
        for k, v in scope.get("headers", []):
            try:
                headers[k.decode("latin-1").lower()] = v.decode("latin-1")
            except Exception:
                pass
        ok, user, why = _authorized(headers)
        if not ok:
            resp = JSONResponse({"error": "unauthorized", "detail": why}, status_code=401)
            await resp(scope, receive, send)
            return
        if scope["method"] == "POST" and path == "/chat":
            if _CHAT_SEM["n"] >= MAX_CONCURRENT_CHATS:
                resp = JSONResponse(
                    {"error": "overloaded",
                     "detail": f"shared sandbox busy (max {MAX_CONCURRENT_CHATS} concurrent turns) — "
                               "create your own space from the app for a private sandbox"},
                    status_code=429)
                await resp(scope, receive, send)
                return
            _CHAT_SEM["n"] += 1
            try:
                await self.app(scope, self._sanitized(receive, user), send)
            finally:
                _CHAT_SEM["n"] -= 1
            return
        await self.app(scope, receive, send)

    @staticmethod
    def _sanitized(receive, user: str = ""):
        """Rewrite the /chat JSON body: sanitize session_id, force a scoped
        server-side workspace (the shell tool's cwd — no path escapes).

        v0.75 SHARED-DISK ISOLATION: the workspace lands under the VERIFIED
        HF username's namespace (ROOT/<user>/<name-or-sid>) and the body
        carries sandbox_user — one user's turn can't name another's
        workspace, and the brain's sandboxing layer (per-session uid
        demotion + tool guards) keys off the same path."""

        async def _run():
            body = b""
            while True:
                msg = await receive()
                if msg["type"] == "http.request":
                    body += msg.get("body", b"")
                    if not msg.get("more_body"):
                        break
                elif msg["type"] == "http.disconnect":
                    return {"type": "http.disconnect"}
            try:
                data = json.loads(body or b"{}")
                sid = re.sub(r"[^a-zA-Z0-9_-]", "", str(data.get("session_id", "")))[:64]
                data["session_id"] = sid or "anon"
                ws_name = re.sub(r"[^a-zA-Z0-9_-]", "", str(data.get("workspace", "")))[:64]
                uname = re.sub(r"[^a-zA-Z0-9_-]", "", str(user or ""))[:32] or "anon"
                data["workspace"] = str(WORKSPACES_ROOT / uname / (ws_name or sid or "anon"))
                data["sandbox_user"] = uname
                body = json.dumps(data).encode()
            except Exception:
                pass  # the brain's own 400s handle broken bodies
            return {"type": "http.request", "body": body, "more_body": False}

        return _run


# ── the wrapper app ─────────────────────────────────────────────────────────


@asynccontextmanager
async def _lifespan(_app):
    print(f"[doomalay] SHARED sandbox up — workspaces={WORKSPACES_ROOT} "
          f"max_concurrent={MAX_CONCURRENT_CHATS}", flush=True)
    yield


app = FastAPI(title="Doomalay Shared Sandbox", version="0.91.5", lifespan=_lifespan)


# ── v0.91.4 THE SPACE'S FACE: the agent's published index is the landing ────
# When the brain's PUBLIC_ROOT carries an index.html (the agent's hf-published
# game/dashboard — persistent via the repo's public/ dir), the space ROOT
# serves IT, not the static landing. Containment + size ride the same rules
# as the /pub route (64MB cap, resolved-and-prefixed).
def _published_index():
    """The agent's published index.html under the brain's PUBLIC_ROOT, or None."""
    try:
        pub = getattr(brain_mod, "PUBLIC_ROOT", None)
        if pub is None:
            return None
        base = pub.resolve()
        cand = (base / "index.html").resolve()
        if cand.is_file() and (cand == base or base in cand.parents):
            if cand.stat().st_size <= 64 * 1024 * 1024:
                return cand
    except Exception:  # noqa: BLE001 — the root must never 500 on pub probing
        return None
    return None


@app.get("/", response_class=HTMLResponse)
def root():
    _idx = _published_index()
    if _idx is not None:
        return FileResponse(_idx, media_type="text/html; charset=utf-8")
    return """<!doctype html><html><head><meta charset="utf-8"><title>Doomalay Sandbox</title>
<style>body{font-family:system-ui,sans-serif;background:#0e0e12;color:#e8e8ef;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.c{max-width:560px;padding:40px;border:1px solid #2a2a35;border-radius:16px;background:#15151c}
h1{margin:0 0 8px;font-size:22px}p{color:#9a9ab0;line-height:1.6;margin:8px 0}
code{background:#22222c;padding:2px 6px;border-radius:6px;font-size:13px}
.b{display:inline-block;margin-top:14px;padding:4px 10px;border-radius:999px;
border:1px solid #2f6f4f;color:#7fe0a8;font-size:12px}</style></head><body><div class="c">
<h1>&#129302; Doomalay Sandbox <span class="b">operational</span></h1>
<p>This Hugging Face Space is the <b>shared Doomalay HF-chat sandbox</b> — a real
Linux sandbox with bash, python, git, node, go, rust and a full build toolchain,
driven by the Doomalay app.</p>
<p>Use it from the app: <b>new chat &rarr; Sandbox &rarr; Hugging Face Space &rarr;
Shared</b>. Auth rides your own HF connection — no setup.</p>
<p><code>POST /chat</code> (engine &rarr; brain, SSE) &middot; per-chat workspaces &middot;
ephemeral storage</p>
</div></body></html>"""


@app.get("/health")
def health():
    h = {"status": "ok", "sandbox": "shared", "mode": "hf-token-auth"}
    try:
        h["isolation"] = "uid" if os.geteuid() == 0 else "cooperative"
    except Exception:
        h["isolation"] = "unknown"
    try:
        tools = os.listdir(str(HERE / "brain" / "tools"))
        h["brain_tools"] = len([t for t in tools if t.endswith(".py")])
    except Exception:
        h["brain_tools"] = -1
    # v0.91.4 THE SILENT-DEGRADATION LIGHT: when strands fails to import,
    # /chat turns fall to the no-tools direct path QUIETLY (live-found: the
    # agent claimed "calculator only" for an hour while health said ok).
    # Surface the strands state + the import reason (type+msg only).
    try:
        ag = sys.modules.get("agent")  # server.py imports it as top-level
        if ag is None:
            aspec = importlib.util.spec_from_file_location(
                "doomalay_health_agent", str(HERE / "brain" / "agent.py"))
            ag = importlib.util.module_from_spec(aspec)
            aspec.loader.exec_module(ag)
        h["strands"] = bool(getattr(ag, "_HAS_STRANDS", False))
        err = getattr(ag, "STRANDS_IMPORT_ERROR", "")
        if err:
            h["strands_error"] = err[:300]
        try:
            import importlib.metadata as _im
            h["strands_version"] = _im.version("strands-agents")
        except Exception:
            h["strands_version"] = "?"
    except Exception as e:  # noqa: BLE001 — diagnostics must never 500 health
        h["strands"] = False
        h["strands_error"] = f"agent import failed: {type(e).__name__}"

    # v0.91.8: the PM sidecar light (the brain's own /health is shadowed by
    # this route on the space — the light must live HERE to be visible)
    try:
        import pm_sidecar as _pms
        h["pm_sidecar"] = _pms.pm_proxy_running()
    except Exception:
        h["pm_sidecar"] = False
    return h


@app.get("/debug/egress")
def debug_egress():
    """Diagnose the container's outbound reachability (open, read-only)."""
    import urllib.request
    targets = [
        ("huggingface", "https://huggingface.co/api/whoami-v2"),
        ("nvidia", "https://integrate.api.nvidia.com/v1/models"),
        ("opencode", "https://opencode.ai/zen/v1/models"),
        ("openrouter", "https://openrouter.ai/api/v1/models"),
        ("mistral", "https://api.mistral.ai/v1/models"),
        ("pypi", "https://pypi.org/simple/"),
        ("github", "https://api.github.com"),
    ]
    out = {}
    for name, url in targets:
        t0 = time.time()
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=12) as r:
                out[name] = {"ok": True, "status": r.status, "ms": int((time.time() - t0) * 1000)}
        except Exception as e:
            out[name] = {"ok": False, "error": str(e)[:120], "ms": int((time.time() - t0) * 1000)}
    return {"egress": out}


# everything else → the brain (root mount LAST so the routes above win)
app.mount("/", brain_app)

app = DoomalayGate(app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")), log_level="warning")
