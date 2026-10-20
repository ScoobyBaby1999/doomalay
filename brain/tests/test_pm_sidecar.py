"""test_pm_sidecar.py — v1.44.5 THE PRIVATEMODE ENGINE BRIDGE.

The v0.91.8 Node sidecar (brain/pmproxy.mjs + brain/vendor/pm, a 6MB
wasm) is RETIRED: since v1.44.3 THE WIRE the ENGINE speaks PM's
E2E-encryption protocol itself, and v1.44.5 exposes the plain OpenAI
wire for this co-located brain:

    POST {DOOMALAY_ENGINE_URL}/api/pm/local/v1/chat/completions
    Authorization: Bearer <the vault's PrivateMode key>

pm_sidecar.py is now a resolver (one env read — no Node, no spawn, no
lifecycle: the ENGINE owns the pin, the secret, the renewals).

These pins:
  1. the catalog points PM CHAT at the engine bridge placeholder and
     REQUIRES both the key and DOOMALAY_ENGINE_URL (a standalone space
     brain honestly skips PM at registration — never a silent fallback);
     model LISTING stays on the real API (the /v1/models listing is
     not encrypted);
  2. pm_sidecar resolves the bridge URL from the env; None (honestly)
     when no engine is co-located;
  3. _resolve_open_model + the registry trigger the ensure-hook ONLY
     for PM (a nvidia chat must never pay it);
  4. the retired files STAY retired (the drift guard: no sidecar
     resurrection).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _catalog():
    raw = (Path(__file__).resolve().parent.parent / "providers_catalog.json").read_text()
    # tolerate JSONC section markers
    raw = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("//"))
    return json.loads(raw)


def test_catalog_pm_points_at_engine_bridge():
    pm = next(p for p in _catalog()["providers"] if p["name"] == "privatemodeai")
    assert pm["base_url"] == "{DOOMALAY_ENGINE_URL}/api/pm/local/v1/chat/completions", pm["base_url"]
    # listing stays on the REAL api (not encrypted, no bridge needed)
    assert pm["models_url"] == "https://api.privatemode.ai/v1/models", pm["models_url"]
    requires = pm.get("requires") or []
    assert "PRIVATEMODEAI_API_KEY" in requires and "DOOMALAY_ENGINE_URL" in requires, requires


def test_pm_sidecar_resolves_engine_url(monkeypatch):
    import pm_sidecar
    monkeypatch.setenv("DOOMALAY_ENGINE_URL", "http://127.0.0.1:8099/")
    assert pm_sidecar.pm_proxy_chat_url() == "http://127.0.0.1:8099/api/pm/local/v1/chat/completions"
    assert pm_sidecar.pm_engine_base() == "http://127.0.0.1:8099"
    assert pm_sidecar.pm_proxy_running() is True
    # no co-located engine (a standalone space brain): the honest None
    monkeypatch.delenv("DOOMALAY_ENGINE_URL", raising=False)
    assert pm_sidecar.pm_proxy_chat_url() is None
    assert pm_sidecar.pm_engine_base() is None
    assert pm_sidecar.pm_proxy_running() is False


def test_resolver_hooks_pm_sidecar(monkeypatch):
    """The wrapper ensures the bridge for PM tuples and leaves everyone
    else untouched (a nvidia chat must never pay the hook)."""
    import agent_core
    calls = []
    monkeypatch.setattr(
        agent_core, "_resolve_open_model_inner",
        lambda m: ("openai/glm-latest", "http://127.0.0.1:8080/api/pm/local/v1",
                   "PRIVATEMODEAI_API_KEY", "privatemodeai", None)
        if m.startswith("privatemodeai") else
        ("openai/kimi-k3", "https://integrate.api.nvidia.com/v1",
         "NVIDIA_API_KEY", "nvidia", None), raising=True)
    import pm_sidecar
    monkeypatch.setattr(pm_sidecar, "pm_proxy_chat_url",
                        lambda: calls.append(1) or "http://127.0.0.1:8080/api/pm/local/v1/chat/completions")
    pair = agent_core._resolve_open_model("privatemodeai/glm-latest")
    assert pair[2] == "PRIVATEMODEAI_API_KEY"
    assert len(calls) == 1, "the PM resolution must ensure the bridge"
    agent_core._resolve_open_model("nvidia/kimi-k3")
    assert len(calls) == 1, "a non-PM resolution must NOT touch the bridge"


def test_registry_hooks_pm_sidecar(monkeypatch):
    """make_provider_registry (the /chat + /judge path) ensures the bridge
    when it registers the PM provider — the live-found gap: the first space
    deployment only hooked agent_core's resolver, and the /chat flow never
    touched it."""
    import providers
    import pm_sidecar
    calls = []
    monkeypatch.setattr(pm_sidecar, "pm_proxy_chat_url",
                        lambda: calls.append(1) or "http://127.0.0.1:8080/api/pm/local/v1/chat/completions")
    monkeypatch.setenv("PRIVATEMODEAI_API_KEY", "test-key")
    monkeypatch.setenv("DOOMALAY_ENGINE_URL", "http://127.0.0.1:8080")
    try:
        providers.make_provider_registry()
    finally:
        monkeypatch.delenv("PRIVATEMODEAI_API_KEY", raising=False)
        monkeypatch.delenv("DOOMALAY_ENGINE_URL", raising=False)
    assert len(calls) >= 1, "registering the PM provider must ensure the bridge"


def test_retired_sidecar_stays_retired():
    """The drift guard: the Node sidecar never comes back."""
    brain = Path(__file__).resolve().parent.parent
    assert not (brain / "pmproxy.mjs").exists(), "pmproxy.mjs resurrected"
    assert not (brain / "pm-polyfill.mjs").exists(), "pm-polyfill.mjs resurrected"
    assert not (brain / "vendor" / "pm").exists(), "brain/vendor/pm resurrected"
