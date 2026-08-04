"""Provider resolution + catalog loading.

Loads brain/catalog/providers.json (the dynamic provider config — no static
model lists on the frontend). Resolves a user-facing model id like
"openrouter/auto" or "openai/gpt-4o" to a LiteLLM model id, base URL,
and the env var holding the API key.

Provider keys are read from os.environ at call time — they arrive via the
X-Env-* headers the Go engine injects on each /chat request.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# 5-minute cache for per-provider /v1/models sync.
_SYNC_CACHE: dict[str, tuple[float, list[dict]]] = {}
_CACHE_TTL_S = 300.0


def load_provider_catalog(path: Path) -> dict[str, Any]:
    """Load catalog/providers.json. Returns {provider_name: config}."""
    with open(path) as f:
        return json.load(f)


def resolve_model(
    user_model: str, user_provider: str, catalog: dict[str, Any]
) -> tuple[str, str, str]:
    """Resolve a user-facing model id to (litellm_model, base_url, env_var).

    Examples:
        ("openrouter/auto", "openrouter", catalog)
            → ("openrouter/auto", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY")
        ("openai/gpt-4o", "openai", catalog)
            → ("openai/gpt-4o", "https://api.openai.com/v1", "OPENAI_API_KEY")
        ("auto", "openrouter", catalog)
            → ("openrouter/auto", "...", "OPENROUTER_API_KEY")
    """
    if user_provider not in catalog:
        raise ValueError(f"unknown provider: {user_provider}")

    cfg = catalog[user_provider]
    env_var = cfg["env_var"]
    base_url = cfg["base_url"]
    # Cloudflare needs the account id substituted in.
    if "{account_id}" in base_url:
        acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        base_url = base_url.replace("{account_id}", acct)

    # If the model already has a provider prefix, use as-is.
    if "/" in user_model:
        litellm_model = user_model
    else:
        # Bare model name — prefix with the LiteLLM provider prefix.
        litellm_model = f"{cfg['litellm_prefix']}/{user_model}"

    return litellm_model, base_url, env_var


def sync_provider_models(
    provider_name: str, cfg: dict[str, Any], force: bool = False
) -> list[dict]:
    """Fetch the provider's /v1/models endpoint. Cached 5 min.

    Returns a list of {id, provider, ...} for the PWA's model picker.
    """
    now = time_time()
    if not force and provider_name in _SYNC_CACHE:
        ts, models = _SYNC_CACHE[provider_name]
        if now - ts < _CACHE_TTL_S:
            return models

    env_var = cfg["env_var"]
    api_key = os.environ.get(env_var, "")
    if not api_key:
        return []

    base_url = cfg["base_url"]
    if "{account_id}" in base_url:
        acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        base_url = base_url.replace("{account_id}", acct)

    import httpx

    try:
        headers = {"Authorization": f"Bearer {api_key}"}
        # GitHub Models uses a different auth header.
        if provider_name == "github-models":
            headers = {"Authorization": f"Bearer {api_key}"}
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(f"{base_url}/models", headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        raise RuntimeError(f"sync {provider_name}: {e}")

    models = []
    raw_models = data.get("data", data.get("models", []))
    for m in raw_models:
        model_id = m.get("id") or m.get("name", "")
        if not model_id:
            continue
        models.append({
            "id": f"{provider_name}/{model_id}",
            "provider": provider_name,
            "label": model_id,
            "raw": m,
        })

    _SYNC_CACHE[provider_name] = (now, models)
    return models


def time_time() -> float:
    """Indirection for testability."""
    import time
    return time.time()
