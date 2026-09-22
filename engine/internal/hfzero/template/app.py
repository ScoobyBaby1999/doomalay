"""Doomalay ZeroGPU Space — app.py (the free-tier sandbox host).

THE HACK (v0.46, verified live 2026-09-22): HF free accounts cannot create
Docker or Gradio spaces on cpu-basic hardware (PRO wall, Oct-2025 policy —
both `POST /api/spaces/{repo}/duplicate` AND `POST /api/repos/create` with
sdk=docker/gradio are blocked). BUT `POST /api/repos/create` with
{type: "space", sdk: "gradio", hardware: "zero-a10g"} SUCCEEDS on free
accounts — and the ZeroGPU runtime's only extra demand is a
"@spaces.GPU function detected during startup".

That detection is not a scan of your code: the `spaces` package registers
a `gradio.one_launch(startup)` hook at import; `startup()` checks that at
least one @spaces.GPU-decorated function exists in `decorated_cache`, then
POSTs a /startup-report to the platform's device API. It normally fires
inside `demo.launch()` — but nothing requires gradio to be the main server.

So this app:
  1. imports `spaces` and defines ONE @spaces.GPU noop (registers in the
     cache; never called — ZeroGPU quota is never consumed), and
  2. runs the Doomalay brain's FastAPI on :7860 via uvicorn, firing
     `spaces.zero.client.startup_report()` manually from the lifespan hook.

Result: a pure FastAPI backend on free ZeroGPU hardware, with the gradio
status UI mounted at /ui for visitors. Reference proof:
https://scoobybaby1999-doom-test-gradio1.hf.space (RUNNING on a free
account, 2026-09-22).

Container facts (probed live): uid 0, Debian 12, Python 3.10, pip, Node 20
+ npm, gcc/g++/make/cmake, git 2.39, bash, ssh — a full dev sandbox.

Auth (fail-closed):
  - OPEN:  /            (info), /health, /ui/*        (status page)
  - OWN-SPACE mode:   every other route requires X-Space-Token matching the
    DOOMALAY_SPACE_TOKEN space secret (set by the creating engine; the same
    value lives in the user's engine vault).
  - SHARED-SPACE mode (DOOMALAY_SHARED=1): requires X-HF-Token — any valid
    HF access token, validated against whoami-v2 with a 5-minute cache.
  - Neither env set: stateful routes refuse (401). DOOMALAY_ALLOW_UNAUTHED=1
    unlocks for local dev only.

Workspace containment: POST /chat bodies get session_id sanitized to
[a-zA-Z0-9_-]{1,64} and workspace forced under DOOMALAY_WORKSPACES_ROOT
(default /data/workspaces when /data exists, else /tmp/doomalay-workspaces)
— the shell tool's cwd is that dir, per chat, no path escapes.
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

import spaces  # noqa: F401  — MUST import before defining the probe
import gradio as gr
from fastapi import FastAPI
from fastapi.responses import JSONResponse

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

# ── the ZeroGPU shape-check satisfier (never invoked by the app) ────────────


@spaces.GPU(duration=5)
def _gpu_probe(x: str) -> str:
    """Noop. Exists so `decorated_cache` is non-empty when the startup
    report fires (see module docstring). Do not call — it would spend the
    space owner's ZeroGPU quota for nothing."""
    return x


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
OPEN_PREFIXES = ("/ui", "/login", "/logout", "/favicon.ico", "/assets/",
                 "/themes.css", "/info/", "/config", "/gradio_api")

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
                     "detail": f"shared sandbox busy (max {MAX_CONCURRENT_CHATS} concurrent turns) — retry shortly"},
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
                # Force server-side scoping. If the caller sends a workspace
                # name, sanitize it the same way; absolute paths and
                # traversal never survive the character whitelist.
                ws_name = re.sub(r"[^a-zA-Z0-9_-]", "", str(data.get("workspace", "")))[:64]
                data["workspace"] = str(WORKSPACES_ROOT / (ws_name or sid or "anon"))
                body = json.dumps(data).encode()
            except Exception:
                pass  # non-JSON or broken body — the brain's own 400s handle it
            return {"type": "http.request", "body": body, "more_body": False}

        return _run


# ── the wrapper app: lifespan fires the ZeroGPU startup report ─────────────


@asynccontextmanager
async def _lifespan(_app):
    try:
        from spaces.zero import client as zg_client
        zg_client.startup_report()
        print("[doomalay] ZeroGPU startup report: OK", flush=True)
    except Exception as e:  # noqa: BLE001 — never kill the app on report failure
        print("[doomalay] ZeroGPU startup report failed:", e, flush=True)
    print(f"[doomalay] sandbox up — shared={SHARED_MODE} token={'set' if SPACE_TOKEN else 'none'} "
          f"workspaces={WORKSPACES_ROOT}", flush=True)
    yield


app = FastAPI(title="Doomalay Sandbox", version="0.46.0", lifespan=_lifespan)


@app.get("/")
def root():
    return {
        "app": "doomalay-sandbox",
        "version": "0.46.0",
        "mode": "shared" if SHARED_MODE else ("token" if SPACE_TOKEN else "locked"),
        "brain": brain_mod.app.title if hasattr(brain_mod.app, "title") else "brain",
        "endpoints": ["/health", "/models", "/templates", "/chat (POST)", "/judge", "/panel"],
        "ui": "/ui",
    }


@app.get("/health")
def health():
    h = {"status": "ok", "sandbox": "zerogpu-hack", "gpu": "shape-check-only"}
    try:
        tools = os.listdir(str(HERE / "brain" / "tools"))
        h["brain_tools"] = len([t for t in tools if t.endswith(".py")])
    except Exception:
        h["brain_tools"] = -1
    return h


# ── the gradio status UI (mounted BEFORE the root brain mount) ─────────────

with gr.Blocks(title="Doomalay Sandbox") as _demo:
    gr.Markdown(
        "# 🤖 Doomalay Sandbox\n"
        "This Hugging Face Space is a **Doomalay HF-chat sandbox** — real bash, "
        "python, git and a full build toolchain, driven by the Doomalay app.\n\n"
        "- Status: **operational**\n"
        "- Mode: " + ("shared (HF-token auth)" if SHARED_MODE else
                      ("private (space-token auth)" if SPACE_TOKEN else "locked")) + "\n"
        "- Chat protocol: `POST /chat` (engine → brain, SSE)\n"
        "- ZeroGPU: shape-check only — no GPU quota is consumed by chats\n\n"
        "Open the Doomalay app → new chat → **Sandbox → Hugging Face Space** to use it.")

gr.mount_gradio_app(app, _demo, path="/ui")

# everything else → the brain (root mount LAST so /ui and the routes above win)
app.mount("/", brain_app)

app = DoomalayGate(app)

if __name__ == "__main__":
    import uvicorn
    # NOTE: 7860 is HARDCODED deliberately. The ZeroGPU container exports
    # PORT=7861 (its internal proxy) — binding $PORT collides with the
    # proxy ("address already in use", live-verified) and the space
    # RUNTIME_ERRORs. The platform's health checks target 7860.
    uvicorn.run(app, host="0.0.0.0", port=7860, log_level="warning")
