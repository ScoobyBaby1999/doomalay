"""Doomalay brain — the AI layer.

A minimal FastAPI service that the Go engine proxies to. Listens on
localhost only (never exposed directly). Three endpoints:

  GET  /health       — liveness probe (the Go engine polls this on startup)
  GET  /models       — returns the provider catalog + sync status (dynamic)
  POST /chat         — runs one agent turn, streams SSE events back

The brain is intentionally thin: it loads provider keys from the
X-Env-* headers the Go engine injects (never from a file on disk), builds
a Strands Agent per turn (V0 fix: fresh agent per turn, never reuse), and
streams events back. Persistence is the Go engine's job — the brain only
emits events, it doesn't write to the DB.

Phase 1 scope: chat with cloud LLMs (no local tools, no panel). Tools,
panel, templates, memory, etc. land in later phases.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# Brain modules (siblings).
sys.path.insert(0, str(Path(__file__).parent))
from agent import run_turn  # noqa: E402
from providers import (  # noqa: E402
    load_provider_catalog,
    resolve_model,
    sync_provider_models,
)

app = FastAPI(title="Doomalay Brain", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # localhost only — engine handles external CORS
    allow_methods=["*"],
    allow_headers=["*"],
)

CATALOG_PATH = Path(__file__).parent / "catalog" / "providers.json"


@app.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0", "brain": True}


@app.get("/models")
def list_models(refresh: bool = False, request: Request = None):
    """Return the provider catalog + per-provider sync status.

    Dynamic — no static model lists on the frontend. Each provider's
    /v1/models endpoint is polled (cached for 5 min, refresh=true forces).

    Provider keys arrive as X-Env-<ENV_VAR> headers (the Go engine injects
    them from the secrets vault on every request).
    """
    catalog = load_provider_catalog(CATALOG_PATH)
    # Inject provider keys from headers into os.environ (per-request, scoped).
    # The Go engine sends X-Env-OPENROUTER_API_KEY: sk-..., etc.
    # Starlette lowercases header names, so we uppercase before setting env.
    if request is not None:
        for h_name, h_val in request.headers.items():
            if h_name.lower().startswith("x-env-"):
                env_name = h_name[6:].upper()  # strip "X-Env-" + uppercase
                os.environ[env_name] = h_val
    sync_status = []
    all_models = []
    for provider_name, cfg in catalog.items():
        env_var = cfg["env_var"]
        has_key = bool(os.environ.get(env_var))
        model_count = 0
        if has_key:
            try:
                models = sync_provider_models(provider_name, cfg, force=refresh)
                model_count = len(models)
                all_models.extend(models)
            except Exception as e:
                sync_status.append({
                    "provider": provider_name,
                    "has_key": True,
                    "model_count": 0,
                    "error": str(e),
                })
                continue
        sync_status.append({
            "provider": provider_name,
            "has_key": has_key,
            "model_count": model_count,
        })
    return {
        "providers": catalog,
        "models": all_models,
        "syncStatus": sync_status,
        "totalModels": len(all_models),
    }


@app.post("/chat")
async def chat(request: Request):
    """Run one agent turn. Streams SSE events back.

    The Go engine reads the SSE stream, persists each event to chat_events
    (V0 fix: backend-writes-events-as-it-emits), and forwards each event
    to the PWA over WebSocket.

    Body:
        { "session_id", "message", "model", "provider", "effort",
          "mode", "system_prompt", "web_search", "deep_research" }

    Provider keys arrive as X-Env-<ENV_VAR> headers (set by the Go engine
    from the secrets vault). We inject them into os.environ for the
    LiteLLM call — they never touch the filesystem.
    """
    body = await request.json()
    session_id = body.get("session_id", "unknown")
    message = body.get("message", "")
    model = body.get("model", "")
    provider = body.get("provider", "")

    # Inject provider keys from headers into os.environ (per-request, scoped).
    # The Go engine sends X-Env-OPENROUTER_API_KEY: sk-..., etc.
    for h_name, h_val in request.headers.items():
        if h_name.lower().startswith("x-env-"):
            env_name = h_name[6:].upper()  # strip "X-Env-" + uppercase
            os.environ[env_name] = h_val

    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    # Resolve the LiteLLM model id (e.g. "openrouter/auto" → "openrouter/openai/gpt-4o").
    catalog = load_provider_catalog(CATALOG_PATH)
    try:
        litellm_model, base_url, env_var = resolve_model(model, provider, catalog)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"model resolution: {e}")

    if not os.environ.get(env_var):
        raise HTTPException(
            status_code=401,
            detail=f"no API key set for {env_var} (provider {provider})",
        )

    async def event_stream():
        """Yield SSE events: data: {json}\n\n"""
        try:
            async for ev in run_turn(
                session_id=session_id,
                message=message,
                model=litellm_model,
                base_url=base_url,
                env_var=env_var,
                system_prompt=body.get("system_prompt", ""),
                effort=body.get("effort", "med"),
            ):
                yield f"data: {json.dumps(ev)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            traceback.print_exc()
            err_ev = {"type": "error", "error": "brain", "message": str(e)}
            yield f"data: {json.dumps(err_ev)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    print(f"doomalay brain on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
