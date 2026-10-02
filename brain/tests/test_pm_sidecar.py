"""test_pm_sidecar.py — v0.91.8 THE PRIVATEMODE SIDECAR.

PM-on-the-brain was DEAD since the original port: the catalog's PM
base_url pointed at localhost:8080 — PM's local Docker proxy, which
cannot run inside an HF Space (and never ran on the desktop either).
The fix: brain/pmproxy.mjs — a Node OpenAI-compatible shim doing the
E2E-encrypted calls through the vendored SDK (the same architecture as
the app's WebView bridge), spawned lazily by pm_sidecar.py.

These pins:
  1. the catalog points PM CHAT at the sidecar (and model LISTING at the
     real API — the /v1/models listing is not encrypted);
  2. pm_sidecar degrades honestly when Node is absent (None, no crash);
  3. _resolve_open_model triggers the ensure-hook ONLY for PM models;
  4. the vendored SDK files are byte-identical to the engine's web vendor
     (one source of truth — the drift guard);
  5. pmproxy.mjs parses under node (skip when node is absent).
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _catalog():
    raw = (Path(__file__).resolve().parent.parent / "providers_catalog.json").read_text()
    # tolerate JSONC section markers
    import re
    raw = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
    return json.loads(raw)


def test_catalog_pm_points_at_sidecar():
    pm = next(p for p in _catalog()["providers"] if p["name"] == "privatemodeai")
    assert pm["base_url"] == "http://127.0.0.1:8530/v1/chat/completions", pm["base_url"]
    # listing stays on the REAL api (not encrypted, no sidecar needed)
    assert pm["models_url"] == "https://api.privatemode.ai/v1/models", pm["models_url"]
    assert "pmproxy.mjs" in (pm.get("note") or "")


def test_pm_sidecar_no_node_returns_none(monkeypatch):
    import pm_sidecar
    monkeypatch.setattr(shutil, "which", lambda name: None)
    monkeypatch.setattr(pm_sidecar, "_probe", lambda *a, **k: False)
    assert pm_sidecar.pm_proxy_chat_url() is None


def test_resolver_hooks_pm_sidecar(monkeypatch):
    """The wrapper ensures the sidecar for PM tuples and leaves everyone
    else untouched (a nvidia chat must never pay the spawn)."""
    import agent_core
    calls = []
    monkeypatch.setattr(
        agent_core, "_resolve_open_model_inner",
        lambda m: ("openai/glm-latest", "http://127.0.0.1:8530/v1",
                   "PRIVATEMODEAI_API_KEY", "privatemodeai", None)
        if m.startswith("privatemodeai") else
        ("openai/kimi-k3", "https://integrate.api.nvidia.com/v1",
         "NVIDIA_API_KEY", "nvidia", None), raising=True)
    import pm_sidecar
    monkeypatch.setattr(pm_sidecar, "pm_proxy_chat_url",
                        lambda: calls.append(1) or "http://127.0.0.1:8530/v1/chat/completions")
    pair = agent_core._resolve_open_model("privatemodeai/glm-latest")
    assert pair[2] == "PRIVATEMODEAI_API_KEY"
    assert len(calls) == 1, "the PM resolution must ensure the sidecar"
    agent_core._resolve_open_model("nvidia/kimi-k3")
    assert len(calls) == 1, "a non-PM resolution must NOT touch the sidecar"


def test_vendored_pm_sdk_synced_with_engine():
    """brain/vendor/pm must be byte-identical to the engine's web vendor —
    one SDK version everywhere (the app bridge AND the sidecar)."""
    brain_pm = Path(__file__).resolve().parent.parent / "vendor" / "pm"
    engine_pm = (Path(__file__).resolve().parent.parent.parent
                 / "engine" / "internal" / "server" / "web" / "vendor" / "pm")
    if not engine_pm.is_dir():
        return  # the embedded brain tree — the engine web dir isn't a sibling
    for f in ("privatemode-ai.js", "wasm.js", "wasm_exec.js", "errors.js",
              "privatemode.wasm.gz"):
        a, b = brain_pm / f, engine_pm / f
        assert a.is_file(), f"brain/vendor/pm/{f} missing"
        assert b.is_file(), f"engine web vendor/pm/{f} missing"
        assert a.read_bytes() == b.read_bytes(), f"{f}: the SDK copies DRIFTED"


def test_pmproxy_mjs_parses():
    node = shutil.which("node")
    if not node:
        return  # no node in this environment (CI containers may omit it)
    brain = Path(__file__).resolve().parent.parent
    r = subprocess.run([node, "--check", str(brain / "pmproxy.mjs")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, f"pmproxy.mjs does not parse: {r.stderr[:300]}"
