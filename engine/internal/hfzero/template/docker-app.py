"""Doomalay Docker Space — app.py (the user's OWN full-toolchain sandbox).

v0.47 (task 9): the "HF Docker sandbox" the engine brick-by-brick builds in
the user's Hugging Face account. Same contract as the ZeroGPU variant
(engine/internal/hfzero/template/app.py) minus the ZeroGPU hack — Docker
Spaces run OUR image on cpu-basic hardware:

  - FULL BUILD TOOLCHAIN (see Dockerfile): gcc/g++/make/cmake, Node 20 +
    npm, Go, Rust, Java 17, ripgrep, git, qemu — compiled langs, package
    installs, everything the quick chat can never do.
  - CPU BASIC HARDWARE: 2 vCPU / 16 GB RAM / ephemeral disk; sleeps after
    48h of inactivity, wakes on the next request (~5 min rebuild).
  - AUTH (fail-closed): every stateful route requires X-Space-Token
    matching the DOOMALAY_SPACE_TOKEN space secret (set by the creating
    engine; the same value lives in the user's engine vault). DOOMALAY_SHARED=1
    switches to X-HF-Token mode (whoami-verified, 5-min cache).
    DOOMALAY_ALLOW_UNAUTHED=1 unlocks for local dev only.
  - WORKSPACE CONTAINMENT: POST /chat bodies get session_id sanitized to
    [a-zA-Z0-9_-]{1,64} and the workspace forced under
    DOOMALAY_WORKSPACES_ROOT (default /data/workspaces when /data exists —
    persistent on storage-backed tiers — else /tmp/doomalay-workspaces).
  - FAIRNESS: MAX_CONCURRENT_CHATS concurrent agent turns (429 beyond).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

HERE = Path(__file__).parent

# ── config ──────────────────────────────────────────────────────────────────
SPACE_TOKEN = os.environ.get("DOOMALAY_SPACE_TOKEN", "").strip()
SHARED_MODE = os.environ.get("DOOMALAY_SHARED", "").strip() in ("1", "true", "yes")
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
brain_app = brain_mod.app  # the brain's FastAPI (health/models/templates/chat/judge/panel)

# ── auth + containment (pure ASGI — streaming-safe) ─────────────────────────

OPEN_PATHS = {"/", "/health"}
OPEN_PREFIXES = ("/ui", "/favicon.ico", "/assets/")

_hf_token_cache: dict[str, tuple[bool, float]] = {}


def _hf_token_valid(token: str) -> bool:
    """Validate an HF access token via whoami-v2 (5-min cache)."""
    now = time.time()
    hit = _hf_token_cache.get(token)
    if hit is not None:
        ok, until = hit
        if now < until:
            return ok
    ok = False
    try:
        import urllib.request
        req = urllib.request.Request(
            "https://huggingface.co/api/whoami-v2",
            headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=10) as r:
            ok = r.status == 200
    except Exception:
        ok = False
    _hf_token_cache[token] = (ok, now + 300)
    if len(_hf_token_cache) > 4096:  # bound the cache
        _hf_token_cache.clear()
    return ok


def _authorized(path: str, headers: dict) -> tuple[bool, str]:
    if ALLOW_UNAUTHED:
        return True, ""
    if SPACE_TOKEN:
        got = headers.get("x-space-token", "")
        if got and _ct_equal(got, SPACE_TOKEN):
            return True, ""
        return False, "missing or invalid X-Space-Token"
    if SHARED_MODE:
        got = headers.get("x-hf-token", "")
        if got and _hf_token_valid(got):
            return True, ""
        return False, "missing/invalid X-HF-Token (connect Hugging Face in the Doomalay app)"
    return False, "space not configured for access (no DOOMALAY_SPACE_TOKEN / shared mode)"


def _ct_equal(a: str, b: str) -> bool:
    """Constant-time compare (tokens are secrets)."""
    import hmac
    return hmac.compare_digest(a.encode(), b.encode())


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
        ok, why = _authorized(path, headers)
        if not ok:
            resp = JSONResponse({"error": "unauthorized", "detail": why}, status_code=401)
            await resp(scope, receive, send)
            return
        if scope["method"] == "POST" and path == "/chat":
            if _CHAT_SEM["n"] >= MAX_CONCURRENT_CHATS:
                resp = JSONResponse(
                    {"error": "overloaded",
                     "detail": f"sandbox busy (max {MAX_CONCURRENT_CHATS} concurrent turns) — retry shortly"},
                    status_code=429)
                await resp(scope, receive, send)
                return
            _CHAT_SEM["n"] += 1
            try:
                await self.app(scope, self._sanitized(receive), send)
            finally:
                _CHAT_SEM["n"] -= 1
            return
        await self.app(scope, receive, send)

    @staticmethod
    def _sanitized(receive):
        """Rewrite the /chat JSON body: sanitize session_id, force a scoped
        server-side workspace. The brain reads request.json() through this
        channel — everything else passes through untouched."""

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
                data["workspace"] = str(WORKSPACES_ROOT / (ws_name or sid or "anon"))
                body = json.dumps(data).encode()
            except Exception:
                pass  # non-JSON or broken body — the brain's own 400s handle it
            return {"type": "http.request", "body": body, "more_body": False}

        return _run


# ── the app ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Doomalay Docker Sandbox", version="0.47.0")


@app.get("/")
def root():
    return {
        "app": "doomalay-sandbox",
        "version": "0.47.0",
        "flavor": "docker",
        "mode": "shared" if SHARED_MODE else ("token" if SPACE_TOKEN else "locked"),
        "brain": brain_mod.app.title if hasattr(brain_mod.app, "title") else "brain",
        "endpoints": ["/health", "/models", "/templates", "/chat (POST)", "/judge", "/panel"],
        "ui": "/ui",
    }


@app.get("/health")
def health():
    h = {"status": "ok", "sandbox": "docker", "hardware": "cpu-basic"}
    try:
        tools = os.listdir(str(HERE / "brain" / "tools"))
        h["brain_tools"] = len([t for t in tools if t.endswith(".py")])
    except Exception:
        h["brain_tools"] = -1
    return h


@app.get("/ui", response_class=HTMLResponse)
def ui():
    mode = ("shared (HF-token auth)" if SHARED_MODE else
            ("private (space-token auth)" if SPACE_TOKEN else "locked"))
    return ("<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>Doomalay Sandbox</title></head><body style='font-family:system-ui,"
            "sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#e8e8ec;"
            "background:#0b0b10'>"
            "<h1>🤖 Doomalay Docker Sandbox</h1>"
            "<p>This Hugging Face Space is a <b>Doomalay HF-chat sandbox</b> — real bash, "
            "python, git, node and a full build toolchain (gcc, go, rust, java), driven "
            "by the Doomalay app.</p>"
            "<ul>"
            "<li>Status: <b>operational</b></li>"
            f"<li>Mode: {mode}</li>"
            "<li>Hardware: 2 vCPU · 16 GB RAM · cpu-basic</li>"
            "<li>Chat protocol: <code>POST /chat</code> (engine → brain, SSE)</li>"
            "</ul>"
            "<p>Open the Doomalay app → new chat → <b>Sandbox → HF Docker sandbox</b> "
            "to use it.</p></body></html>")


# everything else → the brain (root mount LAST so /ui and the routes above win)
app.mount("/", brain_app)

app = DoomalayGate(app)

if __name__ == "__main__":
    import uvicorn
    # 7860: the port HF's proxy targets (Docker Spaces honor app_port in
    # README.md; $PORT is the proxy's own listen port — binding it collides).
    uvicorn.run(app, host="0.0.0.0", port=7860, log_level="warning")
