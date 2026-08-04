"""Doomalay brain — full-capability AI layer.

Endpoints (all localhost-only, called by the Go engine):
  GET  /health        — liveness probe
  GET  /models        — provider catalog + sync status (dynamic)
  GET  /templates     — list all templates (sophisticated roles + dynamic variables)
  GET  /templates/<id> — get one template's full definition
  POST /chat          — run one agent turn, streams SSE events back
  POST /judge         — run the multi-model judge panel (fan-out + merge)
  GET  /panel         — judge panel config
  POST /panel         — update judge panel config

The brain is the maximal-capability AI layer: Strands agent with the full
tool suite (shell, files, editor, web_search, web_fetch, http_request,
calculator, memory, delegate, agent_panel, git, glob, grep, think, journal,
memorize, slug, retrieve, current_time, env), the multi-model judge panel
(critique_service), the template library (14 multi-stage templates with
sophisticated roles + dynamic variables), the .pied memory layer, effort
detection, pricing, the scheduler.

Persistence is the Go engine's job — the brain only emits events, it never
writes to the DB. Provider keys arrive as X-Env-* headers (never from disk).
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
    make_provider_registry,
    load_models_catalog,
    load_reasoning_catalog,
    load_benchmarks,
)

app = FastAPI(title="Doomalay Brain", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # localhost only
    allow_methods=["*"],
    allow_headers=["*"],
)

CATALOG_PATH = Path(__file__).parent / "catalog" / "providers_catalog.json"
TEMPLATES_PATH = Path(__file__).parent / "templates.py"
PANEL_PATH = Path(__file__).parent / "catalog" / "panel.json"


@app.get("/health")
def health():
    return {"status": "ok", "version": "0.2.0", "brain": True, "strands": _check_strands()}


def _check_strands() -> bool:
    try:
        import strands  # noqa: F401
        return True
    except ImportError:
        return False


@app.get("/models")
def list_models(refresh: bool = False, request: Request = None):
    """Return the provider catalog + per-provider sync status.

    Uses the full providers.py: load_provider_catalog() for the catalog,
    make_provider_registry() for the live provider list (only providers
    with keys set are registered).
    """
    # Inject provider keys from headers.
    if request is not None:
        for h_name, h_val in request.headers.items():
            if h_name.lower().startswith("x-env-"):
                env_name = h_name[6:].upper()
                os.environ[env_name] = h_val

    catalog = load_provider_catalog()  # list of dicts (from providers_catalog.json)
    models_catalog = load_models_catalog()  # logical → (provider, model) mapping

    # Build the providers dict (keyed by provider name) for the PWA.
    providers_dict = {}
    for entry in catalog:
        name = entry.get("name", entry.get("provider", "unknown"))
        env_var = entry.get("env_var", "")
        # env_var can be a list — take the first for the PWA display.
        if isinstance(env_var, list):
            env_var = env_var[0] if env_var else ""
        providers_dict[name] = {
            "env_var": str(env_var),
            "base_url": entry.get("base_url", ""),
            "litellm_prefix": entry.get("litellm_prefix", name),
            "label": entry.get("label", name),
            "description": entry.get("description", ""),
            "signup_url": entry.get("signup_url", ""),
            "free_tier": entry.get("free_tier", False),
            "color": entry.get("color", "#888888"),
        }

    # Build the sync status (which providers have keys).
    sync_status = []
    all_models = []
    for name, cfg in providers_dict.items():
        env_var = cfg["env_var"]
        # env_var can be a string or a list (the old catalog format allows multiple).
        if isinstance(env_var, list):
            has_key = any(os.environ.get(str(v)) for v in env_var)
            env_var_str = str(env_var[0]) if env_var else ""
        else:
            env_var_str = str(env_var)
            has_key = bool(os.environ.get(env_var_str))
        model_count = 0
        if has_key:
            # Count models from the models_catalog for this provider.
            for logical, mapping in models_catalog.items():
                if isinstance(mapping, dict):
                    candidates = mapping.get("candidates", [])
                    if any(c.get("provider") == name for c in candidates):
                        model_count += 1
            # Add a model entry for the provider's default.
            all_models.append({
                "id": f"{name}/auto",
                "provider": name,
                "label": "auto",
            })
        sync_status.append({
            "provider": name, "has_key": has_key, "model_count": model_count,
            "env_var": env_var_str,
        })

    return {
        "providers": providers_dict,
        "models": all_models,
        "models_catalog": _to_jsonable(models_catalog),
        "syncStatus": sync_status,
        "totalModels": len(all_models),
    }


# ── Templates ──────────────────────────────────────────────────────────────

@app.get("/templates")
def list_templates():
    """List all templates (sophisticated roles + dynamic variables)."""
    try:
        import templates as tl
        raw = None
        if hasattr(tl, "DEFAULT_TEMPLATES"):
            raw = tl.DEFAULT_TEMPLATES
        elif hasattr(tl, "TEMPLATE_LIBRARY"):
            raw = tl.TEMPLATE_LIBRARY
        elif hasattr(tl, "TEMPLATES"):
            raw = tl.TEMPLATES
        elif hasattr(tl, "list_default_templates"):
            raw = tl.list_default_templates()
        else:
            raw = _scan_templates(tl)
        # Force-convert to plain JSON-serializable dicts.
        out = _to_jsonable(raw)
        return {"templates": out}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"templates": [], "error": str(e)}


@app.get("/templates/{template_id}")
def get_template(template_id: str):
    """Get one template's full definition (roles, stages, dynamic variables)."""
    try:
        import templates as tl
        if hasattr(tl, "get_template"):
            t = tl.get_template(template_id)
            if t:
                return _to_jsonable(t)
        # Fallback: search the registry.
        for reg_name in ["DEFAULT_TEMPLATES", "TEMPLATE_LIBRARY", "TEMPLATES"]:
            reg = getattr(tl, reg_name, None)
            if reg and isinstance(reg, dict) and template_id in reg:
                return _to_jsonable(reg[template_id])
            if reg and isinstance(reg, list):
                for t in reg:
                    if isinstance(t, dict) and t.get("id") == template_id:
                        return _to_jsonable(t)
        raise HTTPException(status_code=404, detail=f"template {template_id} not found")
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"templates module not loaded: {e}")


def _scan_templates(module):
    """Scan a module for template-like objects (fallback)."""
    out = []
    for name in dir(module):
        obj = getattr(module, name)
        if isinstance(obj, dict) and ("id" in obj or "name" in obj or "stages" in obj):
            out.append(obj)
        elif isinstance(obj, list) and all(isinstance(x, dict) for x in obj):
            out.extend(obj)
    return out


def _to_jsonable(obj):
    """Recursively convert an object to JSON-serializable primitives.

    Handles dataclasses, Pydantic models, objects with __dict__, etc.
    """
    import dataclasses
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_to_jsonable(x) for x in obj]
    if dataclasses.is_dataclass(obj):
        return {k: _to_jsonable(v) for k, v in dataclasses.asdict(obj).items()}
    if hasattr(obj, "model_dump"):  # Pydantic v2
        return _to_jsonable(obj.model_dump())
    if hasattr(obj, "dict"):  # Pydantic v1
        try:
            return _to_jsonable(obj.dict())
        except Exception:
            pass
    if hasattr(obj, "__dict__"):
        return {k: _to_jsonable(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return str(obj)


# ── Judge Panel ────────────────────────────────────────────────────────────

@app.get("/panel")
def get_panel():
    """Get the judge panel config."""
    try:
        with open(PANEL_PATH) as f:
            return json.load(f)
    except Exception:
        return {"slots": [], "default_panel": []}


@app.post("/panel")
def update_panel(config: dict):
    """Update the judge panel config."""
    try:
        with open(PANEL_PATH, "w") as f:
            json.dump(config, f, indent=2)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/judge")
async def judge(request: Request):
    """Run the multi-model judge panel — fan out to N diverse models + merge.

    Body: { "input": "...", "template": "critique", "count": 3, "chat_session_id": "..." }
    Returns SSE stream of each judge's output + the final merged result.
    """
    body = await request.json()
    user_input = body.get("input", "")
    template = body.get("template", "critique")
    count = body.get("count", 3)
    session_id = body.get("chat_session_id", "unknown")

    # Inject provider keys from headers.
    for h_name, h_val in request.headers.items():
        if h_name.lower().startswith("x-env-"):
            env_name = h_name[6:].upper()
            os.environ[env_name] = h_val

    async def event_stream():
        try:
            async for ev in _run_judge_panel(user_input, template, count, session_id):
                yield f"data: {json.dumps(ev)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            traceback.print_exc()
            err_ev = {"type": "error", "error": "judge", "message": str(e)}
            yield f"data: {json.dumps(err_ev)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run_judge_panel(user_input: str, template: str, count: int, session_id: str):
    """Fan out to N diverse models + merge the results.

    Uses the scheduler (ported from scheduler.py) to pick models, and merge.py
    to combine outputs.
    """
    yield {"type": "status", "state": "running", "message": f"Spawning {count} judges…"}

    catalog = load_provider_catalog(CATALOG_PATH)
    available_providers = []
    for name, cfg in catalog.items():
        if os.environ.get(cfg["env_var"]):
            available_providers.append((name, cfg))

    if not available_providers:
        yield {"type": "error", "error": "no_keys", "message": "No provider keys available for the judge panel."}
        yield {"type": "status", "state": "error"}
        return

    # Pick `count` diverse models (round-robin across providers).
    selected = []
    for i in range(count):
        name, cfg = available_providers[i % len(available_providers)]
        # Pick the first model from this provider (or a default).
        model_id = f"{cfg['litellm_prefix']}/auto"
        selected.append((name, cfg, model_id))

    # Run each judge in parallel.
    import asyncio
    import litellm

    async def run_one(idx: int, provider_name: str, cfg: dict, model_id: str):
        api_key = os.environ.get(cfg["env_var"], "")
        system_prompt = f"You are Judge {idx + 1} ({provider_name}). Review the following input critically and provide your assessment."
        try:
            response = await litellm.acompletion(
                model=model_id,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_input},
                ],
                api_key=api_key,
                api_base=cfg["base_url"],
                stream=False,
            )
            content = response.choices[0].message.content
            yield_event = {
                "type": "judge_result",
                "judge": idx + 1,
                "provider": provider_name,
                "model": model_id,
                "content": content,
            }
            return yield_event
        except Exception as e:
            return {
                "type": "judge_error",
                "judge": idx + 1,
                "provider": provider_name,
                "error": str(e),
            }

    tasks = [run_one(i, name, cfg, mid) for i, (name, cfg, mid) in enumerate(selected)]
    results = await asyncio.gather(*tasks)

    for ev in results:
        yield ev

    # Merge (best-effort — uses merge.py if available).
    try:
        from merge import merge_outputs
        outputs = [r.get("content", "") for r in results if r.get("type") == "judge_result"]
        if outputs:
            merged = merge_outputs(outputs, template=template)
            yield {"type": "judge_merged", "content": merged}
    except Exception:
        # Fallback: concatenate.
        outputs = [r.get("content", "") for r in results if r.get("type") == "judge_result"]
        if outputs:
            merged = "\n\n---\n\n".join(outputs)
            yield {"type": "judge_merged", "content": merged}

    yield {"type": "status", "state": "idle"}


# ── Chat (the main endpoint) ───────────────────────────────────────────────

@app.post("/chat")
async def chat(request: Request):
    """Run one agent turn. Streams SSE events back.

    The Go engine reads the SSE stream, persists each event to chat_events
    (V0 fix: backend-writes-events-as-it-emits), and forwards each event to
    the PWA over WebSocket.

    Body:
        { "session_id", "message", "model", "provider", "effort",
          "mode", "system_prompt", "web_search", "deep_research",
          "workspace", "history" }

    Provider keys arrive as X-Env-<ENV_VAR> headers.
    """
    body = await request.json()
    session_id = body.get("session_id", "unknown")
    message = body.get("message", "")
    model = body.get("model", "")
    provider = body.get("provider", "")

    # Inject provider keys from headers.
    for h_name, h_val in request.headers.items():
        if h_name.lower().startswith("x-env-"):
            env_name = h_name[6:].upper()
            os.environ[env_name] = h_val

    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    # Resolve the model via the provider registry.
    # model can be "openrouter/auto" or a logical name like "glm-5.2".
    registry = make_provider_registry()
    litellm_model = model
    base_url = ""
    env_var = ""

    # If the model has a provider prefix (e.g. "openrouter/auto"), find that provider.
    if "/" in model:
        prov_name, model_name = model.split("/", 1)
        for p in registry:
            if p.name == prov_name:
                litellm_model = f"{p.models[0]}" if model_name == "auto" else model
                base_url = p.url
                env_var = p.env_var
                break
    else:
        # Logical model name — look it up in the models catalog.
        models_catalog = load_models_catalog()
        if model in models_catalog:
            entry = models_catalog[model]
            candidates = entry.get("candidates", []) if isinstance(entry, dict) else []
            for c in candidates:
                prov_name = c.get("provider")
                for p in registry:
                    if p.name == prov_name:
                        litellm_model = c.get("model", model)
                        base_url = p.url
                        env_var = p.env_var
                        break
                if env_var:
                    break

    if not env_var:
        raise HTTPException(status_code=400, detail=f"could not resolve model {model} (provider {provider})")

    if not os.environ.get(env_var):
        raise HTTPException(
            status_code=401,
            detail=f"no API key set for {env_var} (provider {provider})",
        )

    async def event_stream():
        try:
            async for ev in run_turn(
                session_id=session_id,
                message=message,
                model=litellm_model,
                base_url=base_url,
                env_var=env_var,
                system_prompt=body.get("system_prompt", ""),
                effort=body.get("effort", "med"),
                workspace=body.get("workspace", ""),
                web_search=body.get("web_search", False),
                deep_research=body.get("deep_research", False),
                mode=body.get("mode", "auto"),
                history=body.get("history", []),
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
