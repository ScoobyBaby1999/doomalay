"""Doomalay brain — Android (Chaquopy) server using stdlib http.server.

This is the pure-Python version of the brain server for Android. It uses
only the Python standard library (no FastAPI, no pydantic, no uvicorn —
zero C extensions). This lets it run inside Chaquopy's Python interpreter
on Android.

The server runs on a background thread (started from Kotlin via Chaquopy's
Java API). It listens on localhost:9090 and serves the same endpoints as
brain/server.py (the FastAPI version used on PC/Mac/Linux/HF Space):

  GET  /health        — liveness probe
  GET  /models        — provider catalog + sync status
  GET  /templates     — list all templates
  GET  /templates/<id> — get one template
  POST /chat          — run one agent turn (SSE stream)
  POST /judge         — run judge panel (SSE stream)
  GET  /panel         — judge panel config

V0 fixes: fresh agent per turn, no daemon timeout, callback-only events,
tool_use_id pairing, cumulative session_usage.

Usage from Kotlin (Chaquopy):
    Python.start(AndroidPlatform(context))
    val py = Python.getInstance()
    Thread {
        py.getModule("server_android").callAttr("start_server", 9090)
    }.start()
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Brain modules (siblings)
sys.path.insert(0, str(Path(__file__).parent))
from agent import run_turn  # noqa: E402
from providers import (  # noqa: E402
    load_provider_catalog,
    make_provider_registry,
    load_models_catalog,
)

CATALOG = None
TEMPLATES_MODULE = None
PANEL_PATH = Path(__file__).parent / "catalog" / "panel.json"


def _ensure_catalog():
    global CATALOG
    if CATALOG is None:
        CATALOG = load_provider_catalog()
    return CATALOG


def _ensure_templates():
    global TEMPLATES_MODULE
    if TEMPLATES_MODULE is None:
        import templates as tl
        TEMPLATES_MODULE = tl
    return TEMPLATES_MODULE


def _to_jsonable(obj):
    """Recursively convert to JSON-serializable primitives."""
    import dataclasses
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_to_jsonable(x) for x in obj]
    if dataclasses.is_dataclass(obj):
        return {k: _to_jsonable(v) for k, v in dataclasses.asdict(obj).items()}
    if hasattr(obj, "model_dump"):
        return _to_jsonable(obj.model_dump())
    if hasattr(obj, "__dict__"):
        return {k: _to_jsonable(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return str(obj)


class BrainHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the brain server."""

    def log_message(self, format, *args):
        # Suppress default logging (Android logcat handles it).
        pass

    def _send_json(self, status, obj):
        body = json.dumps(_to_jsonable(obj)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self, status, lines):
        """Send SSE stream. `lines` is an iterable of strings (each a data: line)."""
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        for line in lines:
            self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _inject_env_headers(self):
        """Inject provider keys from X-Env-* headers into os.environ."""
        for key, val in self.headers.items():
            if key.lower().startswith("x-env-"):
                env_name = key[6:].upper()
                os.environ[env_name] = val

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/health":
            self._send_json(200, {"status": "ok", "version": "0.2.0", "brain": True})
            return

        if path == "/models":
            self._inject_env_headers()
            catalog = _ensure_catalog()
            models_catalog = load_models_catalog()
            providers_dict = {}
            for entry in catalog:
                name = entry.get("name", "unknown")
                env_var = entry.get("env_var", "")
                if isinstance(env_var, list):
                    env_var = env_var[0] if env_var else ""
                providers_dict[name] = {
                    "env_var": str(env_var),
                    "base_url": entry.get("base_url", ""),
                    "label": entry.get("label", name),
                    "description": entry.get("description", ""),
                    "signup_url": entry.get("signup_url", ""),
                    "free_tier": entry.get("free_tier", False),
                    "color": entry.get("color", "#888"),
                }
            sync_status = []
            all_models = []
            for name, cfg in providers_dict.items():
                env_var = cfg["env_var"]
                has_key = bool(os.environ.get(env_var))
                model_count = 0
                if has_key:
                    for logical, mapping in models_catalog.items():
                        if isinstance(mapping, dict):
                            candidates = mapping.get("candidates", [])
                            if any(c.get("provider") == name for c in candidates):
                                model_count += 1
                    all_models.append({"id": f"{name}/auto", "provider": name, "label": "auto"})
                sync_status.append({"provider": name, "has_key": has_key, "model_count": model_count})
            self._send_json(200, {
                "providers": providers_dict,
                "models": all_models,
                "models_catalog": _to_jsonable(models_catalog),
                "syncStatus": sync_status,
                "totalModels": len(all_models),
            })
            return

        if path == "/templates":
            tl = _ensure_templates()
            raw = getattr(tl, "DEFAULT_TEMPLATES", [])
            self._send_json(200, {"templates": _to_jsonable(raw)})
            return

        if path.startswith("/templates/"):
            template_id = path.split("/")[2]
            tl = _ensure_templates()
            if hasattr(tl, "get_template"):
                t = tl.get_template(template_id)
                if t:
                    self._send_json(200, _to_jsonable(t))
                    return
            for reg_name in ["DEFAULT_TEMPLATES", "TEMPLATE_LIBRARY", "TEMPLATES"]:
                reg = getattr(tl, reg_name, None)
                if reg and isinstance(reg, list):
                    for t in reg:
                        if isinstance(t, dict) and t.get("id") == template_id:
                            self._send_json(200, _to_jsonable(t))
                            return
            self._send_json(404, {"error": f"template {template_id} not found"})
            return

        if path == "/panel":
            try:
                with open(PANEL_PATH) as f:
                    self._send_json(200, json.load(f))
            except Exception:
                self._send_json(200, {"slots": [], "default_panel": []})
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Read body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"detail": "invalid JSON"})
            return

        if path == "/chat":
            self._handle_chat(data)
            return

        if path == "/judge":
            self._handle_judge(data)
            return

        self._send_json(404, {"error": "not found"})

    def _handle_chat(self, data):
        self._inject_env_headers()
        session_id = data.get("session_id", "unknown")
        message = data.get("message", "")
        model = data.get("model", "")
        provider = data.get("provider", "")

        if not message:
            self._send_json(400, {"detail": "message is required"})
            return
        if not model:
            self._send_json(400, {"detail": "model is required"})
            return

        # Resolve model
        registry = make_provider_registry()
        litellm_model = model
        base_url = ""
        env_var = ""
        if "/" in model:
            prov_name, model_name = model.split("/", 1)
            for p in registry:
                if p.name == prov_name:
                    litellm_model = p.models[0] if model_name == "auto" else model
                    base_url = p.url
                    env_var = p.env_var
                    break
        else:
            models_catalog = load_models_catalog()
            if model in models_catalog:
                entry = models_catalog[model]
                candidates = entry.get("candidates", []) if isinstance(entry, dict) else []
                for c in candidates:
                    for p in registry:
                        if p.name == c.get("provider"):
                            litellm_model = c.get("model", model)
                            base_url = p.url
                            env_var = p.env_var
                            break
                    if env_var:
                        break

        if not env_var:
            self._send_json(400, {"detail": f"could not resolve model {model}"})
            return
        if not os.environ.get(env_var):
            self._send_json(401, {"detail": f"no API key for {env_var}"})
            return

        import asyncio

        async def generate():
            async for ev in run_turn(
                session_id=session_id,
                message=message,
                model=litellm_model,
                base_url=base_url,
                env_var=env_var,
                system_prompt=data.get("system_prompt", ""),
                effort=data.get("effort", "med"),
                workspace=data.get("workspace", ""),
                web_search=data.get("web_search", False),
                deep_research=data.get("deep_research", False),
                mode=data.get("mode", "auto"),
                history=data.get("history", []),
            ):
                yield json.dumps(ev)

        def run_async_gen():
            loop = asyncio.new_event_loop()
            try:
                for ev_str in loop.run_until_complete(_collect_async(generate())):
                    yield ev_str
            finally:
                loop.close()

        try:
            self._send_sse(200, run_async_gen())
        except Exception as e:
            traceback.print_exc()
            err = json.dumps({"type": "error", "error": "brain", "message": str(e)})
            self._send_sse(500, [err])

    def _handle_judge(self, data):
        self._inject_env_headers()
        user_input = data.get("input", "")
        template = data.get("template", "critique")
        count = data.get("count", 3)

        import asyncio

        async def generate():
            yield json.dumps({"type": "status", "state": "running", "message": f"Spawning {count} judges..."})
            catalog = _ensure_catalog()
            available = [(n, c) for n, c in [(e.get("name", ""), e) for e in catalog] if os.environ.get(c.get("env_var", "") if isinstance(c.get("env_var"), str) else "")]
            if not available:
                yield json.dumps({"type": "error", "error": "no_keys", "message": "No provider keys available."})
                yield json.dumps({"type": "status", "state": "error"})
                return
            import litellm
            selected = [(available[i % len(available)]) for i in range(count)]
            async def run_one(idx, name, cfg):
                api_key = os.environ.get(cfg.get("env_var", ""), "")
                try:
                    resp = await litellm.acompletion(
                        model=f"{cfg.get('litellm_prefix', name)}/auto",
                        messages=[{"role": "system", "content": f"You are Judge {idx+1}."}, {"role": "user", "content": user_input}],
                        api_key=api_key, api_base=cfg.get("base_url", ""), stream=False,
                    )
                    return {"type": "judge_result", "judge": idx+1, "provider": name, "content": resp.choices[0].message.content}
                except Exception as e:
                    return {"type": "judge_error", "judge": idx+1, "provider": name, "error": str(e)}
            tasks = [run_one(i, n, c) for i, (n, c) in enumerate(selected)]
            results = await asyncio.gather(*tasks)
            for r in results:
                yield json.dumps(r)
            outputs = [r.get("content", "") for r in results if r.get("type") == "judge_result"]
            if outputs:
                merged = "\n\n---\n\n".join(outputs)
                yield json.dumps({"type": "judge_merged", "content": merged})
            yield json.dumps({"type": "status", "state": "idle"})

        def run_async_gen():
            loop = asyncio.new_event_loop()
            try:
                for ev_str in loop.run_until_complete(_collect_async(generate())):
                    yield ev_str
            finally:
                loop.close()

        try:
            self._send_sse(200, run_async_gen())
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {"error": str(e)})


async def _collect_async(async_gen):
    """Collect all items from an async generator into a list."""
    results = []
    async for item in async_gen:
        results.append(item)
    return results


def start_server(port=9090, host="127.0.0.1"):
    """Start the brain HTTP server. Called from Kotlin via Chaquopy.

    This function blocks the calling thread (which should be a background
    thread spawned by Kotlin — NOT the main/UI thread). The server runs
    forever until the app is killed.
    """
    print(f"doomalay brain (android) on http://{host}:{port}", flush=True)
    server = HTTPServer((host, port), BrainHandler)
    server.serve_forever()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    start_server(args.port, args.host)
