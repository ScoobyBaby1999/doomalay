"""pm_sidecar.py — THE PRIVATEMODE SIDECAR SPAWNER (v0.91.8).

The brain's agent turns run through litellm (Python), which cannot speak
PM's E2E-encryption protocol (attestation + AES-GCM — implemented in the
official SDK's WASM). pmproxy.mjs (this directory) is a tiny Node shim
that exposes the PLAIN OpenAI-compatible API on loopback and does the
encrypted calls through the vendored SDK — the same architecture as the
app's WebView bridge, moved server-side so HF-space agent chats can use
PrivateMode.

This module lazily ensures the sidecar is running (one spawn per brain
process, node is present on both space flavors — ZeroGPU probe v0.46 and
the Docker image) and returns its base URL. The providers catalog's
privatemodeai entry points at it; model LISTING stays on the real API
(the /v1/models listing is not encrypted).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import urllib.request
from pathlib import Path

_HERE = Path(__file__).resolve().parent
PM_PROXY_PORT = int(os.environ.get("DOOMALAY_PM_PROXY_PORT", "8530"))
PM_PROXY_BASE = f"http://127.0.0.1:{PM_PROXY_PORT}"
# the catalog's chat base_url (litellm api_base after the brain strips the
# trailing /chat/completions) — keep in sync with providers_catalog.json.
PM_PROXY_CHAT_URL = PM_PROXY_BASE + "/v1/chat/completions"

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_ready = False


def _probe(timeout: float = 2.0) -> bool:
    """Is something already answering /healthz on the sidecar port?"""
    try:
        req = urllib.request.Request(PM_PROXY_BASE + "/healthz", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def pm_proxy_chat_url() -> str | None:
    """Ensure the PM sidecar is up; return its chat URL (None when Node is
    unavailable — the caller keeps the catalog URL and the litellm call
    fails honestly with connection refused, which route_judge bounces)."""
    global _proc, _ready
    with _lock:
        if _ready:
            return PM_PROXY_CHAT_URL
        if _probe():
            _ready = True
            return PM_PROXY_CHAT_URL
        node = shutil.which("node")
        if node is None:
            return None
        log = open(os.devnull, "wb")
        proc = subprocess.Popen(
            [node, str(_HERE / "pmproxy.mjs")],
            cwd=str(_HERE),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # survives the request; dies with the container
        )
        # the wasm decompress (5.9MB gz) + boot: give it up to 45s
        import time
        deadline = time.time() + 45
        while time.time() < deadline:
            if proc.poll() is not None:
                return None  # died at boot (missing files / node version)
            if _probe():
                _proc = proc
                _ready = True
                return PM_PROXY_CHAT_URL
            time.sleep(0.5)
        try:
            proc.terminate()
        except Exception:
            pass
        return None


def pm_proxy_running() -> bool:
    """The cheap check (no spawn) — for /health reporting."""
    return _ready or _probe(0.5)
