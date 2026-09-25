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
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import sys
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

HERE = Path(__file__).parent

# ── config (baked for the shared deployment) ────────────────────────────────
SHARED_MODE = True  # this IS the shared space
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
OPEN_PREFIXES = ("/favicon.ico", "/gh/oauth/")  # the broker needs NO HF token —
# it exists precisely for users who haven't connected anything yet

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
    if len(_hf_token_cache) > 4096:
        _hf_token_cache.clear()
    return ok


def _authorized(headers: dict) -> tuple[bool, str]:
    if ALLOW_UNAUTHED:
        return True, ""
    got = headers.get("x-hf-token", "")
    if got and _hf_token_valid(got):
        return True, ""
    return False, "missing/invalid X-HF-Token (connect Hugging Face in the Doomalay app)"


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
        ok, why = _authorized(headers)
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
                await self.app(scope, self._sanitized(receive), send)
            finally:
                _CHAT_SEM["n"] -= 1
            return
        await self.app(scope, receive, send)

    @staticmethod
    def _sanitized(receive):
        """Rewrite the /chat JSON body: sanitize session_id, force a scoped
        server-side workspace (the shell tool's cwd — no path escapes)."""

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
                pass  # the brain's own 400s handle broken bodies
            return {"type": "http.request", "body": body, "more_body": False}

        return _run


# ── the wrapper app ─────────────────────────────────────────────────────────


@asynccontextmanager
async def _lifespan(_app):
    print(f"[doomalay] SHARED sandbox up — workspaces={WORKSPACES_ROOT} "
          f"max_concurrent={MAX_CONCURRENT_CHATS}", flush=True)
    yield


app = FastAPI(title="Doomalay Shared Sandbox", version="0.46.0", lifespan=_lifespan)


@app.get("/", response_class=HTMLResponse)
def root():
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
        tools = os.listdir(str(HERE / "brain" / "tools"))
        h["brain_tools"] = len([t for t in tools if t.endswith(".py")])
    except Exception:
        h["brain_tools"] = -1
    return h


@app.get("/debug/egress")
def debug_egress():
    """Diagnose the container's outbound reachability (open, read-only)."""
    import urllib.request
    targets = [
        ("huggingface.co", "https://huggingface.co/api/whoami-v2"),
        ("nvidia", "https://integrate.api.nvidia.com/v1/models"),
        ("opencode", "https://opencode.ai/zen/v1/models"),
        ("openrouter", "https://openrouter.ai/api/v1/models"),
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


# ── v0.60.2: THE GITHUB APP BROKER (the legacy one-click, ported) ─────────
#
# The user's spec: "complete access over ONE repo, not the entire account"
# and no code entry. This Space brokers the live GitHub APP
# (Iv23li3qm665pDrDO1Nh): the client secret lives ONLY in this Space's env
# (GITHUB_CLIENT_SECRET), the code exchange happens server-side here, and
# the token crosses the browser ONLY as a one-time unguessable grant code
# claimed server-to-server by the user's engine (engine/…/ghbroker.go):
#
#   popup → <engine>/api/gh/oauth/broker/start?origin=<app origin>
#         → /gh/oauth/start?redirect=<origin>      (state nonce, 10-min TTL)
#         → github.com/login/oauth/authorize       (THE user click — the
#           GitHub App screen offers "Only select repositories" = the
#           repo-level grant)
#         → /gh/oauth/callback?code&state          (exchange + /user here)
#         → 302 <origin>/api/gh/oauth/relay?grant=<one-time 48-hex code>
#
# SETUP (one-time): Space Settings → Secrets → GITHUB_CLIENT_ID (defaults
# to the live App below) + GITHUB_CLIENT_SECRET; the GitHub App settings
# get the callback URL https://scoobybaby1999-doomalaysocreate.hf.space/gh/oauth/callback.

GH_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "Iv23li3qm665pDrDO1Nh").strip()
GH_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
GH_CALLBACK = os.environ.get("GH_OAUTH_CALLBACK", "").strip() or \
    "https://scoobybaby1999-doomalaysocreate.hf.space/gh/oauth/callback"

_GH_STATES: dict[str, tuple[str, float]] = {}   # state → (origin, expires)
_GH_GRANTS: dict[str, dict] = {}                # grant → token bundle + expiry


def _gh_purge() -> None:
    now = time.time()
    for k in [k for k, v in _GH_STATES.items() if v[1] < now]:
        _GH_STATES.pop(k, None)
    for k in [k for k, v in _GH_GRANTS.items() if v.get("expires", 0) < now]:
        _GH_GRANTS.pop(k, None)


def _redirect_origin_allowed(origin: str) -> bool:
    """The grant relay may only aim at: loopback installs (the APK /
    desktop engine), RFC1918 private nets (LAN self-hosters), the gateway
    platform (*.space-z.ai) or an *.hf.space front. An arbitrary public
    host must NEVER be reachable via a crafted /gh/oauth/start link —
    that would hand the one-time grant (and its token) to anyone."""
    try:
        u = urllib.parse.urlparse(origin)
    except Exception:
        return False
    if u.scheme not in ("http", "https") or not u.hostname:
        return False
    host = u.hostname.lower().strip("[]")
    if host == "localhost" or host == "::1" or host.startswith("127."):
        return True
    if host.startswith("10.") or host.startswith("192.168."):
        return True
    if host.startswith("172."):
        try:
            if 16 <= int(host.split(".")[1]) <= 31:
                return True
        except Exception:
            pass
    if host.endswith(".space-z.ai") or host.endswith(".hf.space"):
        return True
    return False


@app.get("/gh/oauth/config")
def gh_oauth_config():
    """The panel's probe — CORS-open boolean, no secret material."""
    return JSONResponse({"configured": bool(GH_CLIENT_ID and GH_CLIENT_SECRET)},
                        headers={"Access-Control-Allow-Origin": "*"})


@app.get("/gh/oauth/start")
def gh_oauth_start(redirect: str = ""):
    if not (GH_CLIENT_ID and GH_CLIENT_SECRET):
        return JSONResponse({
            "error": "broker not configured",
            "detail": "Space Settings → Secrets → set GITHUB_CLIENT_ID=" + GH_CLIENT_ID
                      + " and GITHUB_CLIENT_SECRET=<the App's secret>, then redeploy",
        }, status_code=503)
    origin = redirect.strip()
    if not _redirect_origin_allowed(origin):
        return JSONResponse({
            "error": "redirect origin refused",
            "detail": "the relay target must be the app's loopback/LAN/gateway origin",
        }, status_code=400)
    _gh_purge()
    state = secrets.token_hex(16)
    _GH_STATES[state] = (origin, time.time() + 600)
    params = urllib.parse.urlencode({
        "client_id": GH_CLIENT_ID,
        "redirect_uri": GH_CALLBACK,
        "state": state,
    })
    return RedirectResponse("https://github.com/login/oauth/authorize?" + params)


@app.get("/gh/oauth/callback")
def gh_oauth_callback(code: str = "", state: str = "",
                      error: str = "", error_description: str = ""):
    _gh_purge()
    ent = _GH_STATES.pop(state, None)
    origin = ent[0] if ent else ""
    if not origin:
        return HTMLResponse(
            "<h3>unknown or expired sign-in state</h3><p>close this window and "
            "press the sign-in button in the Doomalay app again.</p>",
            status_code=400)
    if error:
        desc = error_description or error
        return RedirectResponse(origin + "/api/gh/oauth/relay?error=" + urllib.parse.quote(desc))
    if not code:
        return RedirectResponse(origin + "/api/gh/oauth/relay?error=missing%20authorization%20code")
    # the exchange — the secret NEVER leaves this process
    try:
        data = urllib.parse.urlencode({
            "client_id": GH_CLIENT_ID,
            "client_secret": GH_CLIENT_SECRET,
            "code": code,
            "redirect_uri": GH_CALLBACK,
        }).encode()
        req = urllib.request.Request(
            "https://github.com/login/oauth/access_token", data=data,
            headers={"Accept": "application/json", "User-Agent": "doomalay-broker"})
        with urllib.request.urlopen(req, timeout=20) as r:
            tok = json.loads(r.read().decode() or "{}")
    except Exception as e:
        return RedirectResponse(origin + "/api/gh/oauth/relay?error=" +
                                urllib.parse.quote("exchange failed: " + str(e)[:140]))
    if not tok.get("access_token"):
        err = tok.get("error_description") or tok.get("error") or "exchange returned no token"
        return RedirectResponse(origin + "/api/gh/oauth/relay?error=" + urllib.parse.quote(str(err)))
    # who signed in (best-effort — must not fail the flow)
    login = ""
    try:
        rq = urllib.request.Request(
            "https://api.github.com/user",
            headers={"Authorization": "Bearer " + tok["access_token"],
                     "User-Agent": "doomalay-broker"})
        with urllib.request.urlopen(rq, timeout=15) as r:
            login = str(json.loads(r.read().decode() or "{}").get("login", ""))
    except Exception:
        pass
    grant = secrets.token_hex(24)  # 192-bit one-time code, 5-min TTL
    _GH_GRANTS[grant] = {
        "token": tok["access_token"],
        "login": login,
        "refresh_token": str(tok.get("refresh_token", "") or ""),
        "expires_in": int(tok.get("expires_in", 0) or 0),
        "expires": time.time() + 300,
    }
    return RedirectResponse(origin + "/api/gh/oauth/relay?grant=" + grant)


@app.get("/gh/oauth/grants/{code}")
def gh_oauth_grant(code: str):
    """One-time claim — the user's ENGINE fetches this server-to-server."""
    _gh_purge()
    g = _GH_GRANTS.pop(code, None)
    if not g:
        return JSONResponse({"error": "unknown, expired or already-claimed grant"},
                            status_code=410)
    return JSONResponse({
        "token": g["token"],
        "login": g["login"],
        "refresh_token": g["refresh_token"],
        "expires_in": g["expires_in"],
    })


# everything else → the brain (root mount LAST so the routes above win)
app.mount("/", brain_app)

app = DoomalayGate(app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")), log_level="warning")
