"""Doomalay brain — full-capability AI layer.

Endpoints (all localhost-only, called by the Go engine):
  GET  /health        — liveness probe
  GET  /models        — provider catalog + sync status (dynamic)
  GET  /templates     — list the whole template library (v0.44: orchestrator
                       stage-JSONs + superpowers user templates + the
                       DEFAULT_TEMPLATES flows, merged + deduped)
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
from fastapi.responses import FileResponse, StreamingResponse

# Brain modules (siblings).
sys.path.insert(0, str(Path(__file__).parent))
from agent import run_turn  # noqa: E402
import reqenv  # noqa: E402  — v0.72: per-request BYOK (X-Env-* as values, never global env writes)
import redact  # noqa: E402  — v0.75: in-flight redaction at every error sink
import provider_health  # noqa: E402  — v1.10.2: the black-hole pre-flight guard

# v0.43 — stranded-coroutine watchdog (KEEP): every strands run_async loop
# registers itself here; a global thread dumps any task still pending after
# 50s so cross-loop deadlocks show their AWAITING stack (thread dumps alone
# only ever showed "parked in asyncio.run" — this is how the sub-agent
# deadlock was diagnosed). Zero overhead when turns behave.
_ALL_LOOPS: "list[object]" = []
_LOOPS_LOCK = __import__("threading").Lock()


def _install_loop_watchdog() -> None:  # noqa: D401 — side-effecting patch
    try:
        import strands._async as _sa
        import asyncio as _aio
        import traceback as _tb
        import time as _time
        _orig = _sa.run_async

        def run_async_watched(async_func):
            def execute():
                loop_holder: "dict[str, object]" = {}
                with _LOOPS_LOCK:
                    _ALL_LOOPS.append(loop_holder)

                async def _main():
                    loop_holder["loop"] = _aio.get_running_loop()
                    return await async_func()

                async def _dump_later():
                    await _aio.sleep(50)
                    loop = loop_holder.get("loop")
                    if loop is None:
                        return
                    pending = [t for t in _aio.all_tasks(loop)
                               if t is not _aio.current_task()]
                    if not pending:
                        return
                    print(f"\n=== WATCHDOG: loop {id(loop)} still has "
                          f"{len(pending)} pending tasks after 50s ===",
                          file=sys.stderr, flush=True)
                    for t in pending:
                        st = t.get_stack()
                        if st:
                            print(f"--- task {t.get_name()} ---",
                                  file=sys.stderr, flush=True)
                            # st[0]=oldest/outermost; st[-1]=newest/innermost
                            # await — printing FROM it walks f_back up the
                            # whole chain (printing st[0] alone showed only
                            # one frame, which is how this bug hid).
                            _tb.print_stack(f=st[-1], file=sys.stderr)
                    print("=== WATCHDOG END ===", file=sys.stderr, flush=True)

                async def _wrapped():
                    _aio.ensure_future(_dump_later())
                    return await _main()

                return _aio.run(_wrapped())

            def _wrapped_sync():
                token = _sa._RUN_ASYNC_BRIDGE.set(True)
                try:
                    return execute()
                finally:
                    _sa._RUN_ASYNC_BRIDGE.reset(token)

            import concurrent.futures as _cf
            import contextvars as _cv
            with _cf.ThreadPoolExecutor() as _ex:
                ctx = _cv.copy_context()
                fut = _ex.submit(ctx.run, _wrapped_sync)
                return fut.result()

        _sa.run_async = run_async_watched
        import strands.agent.agent as _agent_mod
        _agent_mod.run_async = run_async_watched
    except Exception:
        pass


_install_loop_watchdog()

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
    # v0.91.8: the PM sidecar light — PM-on-the-space was DEAD since the
    # original port (the catalog pointed at a localhost proxy that never
    # ran); now /health says whether the Node shim is actually answering.
    pm_sidecar_ok = False
    try:
        import pm_sidecar
        pm_sidecar_ok = pm_sidecar.pm_proxy_running()
    except Exception:
        pm_sidecar_ok = False
    return {"status": "ok", "version": "0.2.0", "brain": True,
            "strands": _check_strands(), "pm_sidecar": pm_sidecar_ok}


# ── v0.89.3 THE PUBLIC ROOT — serving what the agent builds ─────────────
# The agent (and only the agent, via its shell/file tools) writes static
# files here; they are served OPENLY (no space token) at /pub/<file> so
# the user can VIEW what the agent built in a browser — dashboards,
# simulations, games. This is the "turn the Space into a viewable app"
# primitive documented in brain/HARNESS.md. Safe by construction: static
# file types only, resolved-and-prefixed (no traversal), no listing.
# v0.91.4 THE PERSISTENT PUBLIC ROOT — candidates in priority order:
#   1. DOOMALAY_PUBLIC_ROOT (explicit override, tests ride this)
#   2. /data/public          — persistent storage mounts (when it EXISTS)
#   3. <repo>/public         — a public/ dir COMMITTED to the space repo
#                              (persistent by construction: restarts rebuild
#                              from the repo — the agent commits its game
#                              here via the HF API to survive restarts)
#   4. /tmp/doomalay-public  — the ephemeral fallback (wiped on restart)
def _resolve_public_root() -> Path:
    env = os.environ.get("DOOMALAY_PUBLIC_ROOT")
    if env:
        return Path(env)
    # v0.91.5b: /data/public wins only when it EXISTS. Live-found on
    # doomalaysocreate (free Docker Space): HF mounts an EPHEMERAL /data —
    # the bare isdir("/data") check resolved the root to a nonexistent
    # /data/public and shadowed the repo's committed public/ (the standing
    # face served 404 while the game sat in the image at /app/public).
    # On persistent tiers the agent's first publish mkdirs /data/public,
    # so a REAL /data/public still wins exactly as before.
    if os.path.isdir("/data/public"):
        return Path("/data/public")
    repo_pub = Path(__file__).resolve().parent.parent / "public"
    if repo_pub.is_dir():
        return repo_pub
    return Path("/tmp/doomalay-public")


PUBLIC_ROOT = _resolve_public_root()

_PUB_MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
    ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
    ".wasm": "application/wasm", ".xml": "application/xml",
    ".pdf": "application/pdf", ".woff": "font/woff", ".woff2": "font/woff2",
}
_PUB_MAX_BYTES = 64 * 1024 * 1024  # 64 MB per file — a game, not a dataset


@app.get("/pub/{rel:path}", include_in_schema=False)
def pub_serve(rel: str):
    """Serve a static file from PUBLIC_ROOT (open route, no token).

    `/pub/` and `/pub/<dir>/` resolve to that directory's index.html when
    present (the space's viewable landing page). Traversal is impossible:
    the resolved path must stay under PUBLIC_ROOT.
    """
    rel_clean = (rel or "").strip().strip("/")
    base = PUBLIC_ROOT.resolve()
    # bare /pub/ or a directory path → index.html
    candidate = (base / rel_clean).resolve() if rel_clean else base
    try:
        if candidate.is_dir():
            candidate = (candidate / "index.html").resolve()
        # containment: resolved path must live under the public root
        if candidate != base and base not in candidate.parents:
            raise HTTPException(status_code=404, detail="not found")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="not found")
        if candidate.stat().st_size > _PUB_MAX_BYTES:
            raise HTTPException(status_code=413, detail="file too large")
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=404, detail="not found")
    mime = _PUB_MIME.get(candidate.suffix.lower(), "application/octet-stream")
    return FileResponse(candidate, media_type=mime)


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
    # v0.72 BYOK: per-request key presence — the user's own X-Env keys
    # (shared spaces) OR the space's own secrets. Never a global env write.
    # v0.75: X-Keyed-Providers (presence-only names, no values) counts
    # too — the engine's minimized /models fan-out rides this.
    req_env = reqenv.extract(request) if request is not None else {}
    req_keyed = reqenv.extract_keyed(request) if request is not None else frozenset()
    reqenv.set_request_env(req_env, req_keyed)

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
        # v0.75: reqenv.has_key covers the three surfaces — this
        # request's X-Env values, the presence-only keyed set, and the
        # space's own secrets.
        if isinstance(env_var, list):
            has_key = reqenv.has_key([str(v) for v in env_var if v])
            env_var_str = str(env_var[0]) if env_var else ""
        else:
            env_var_str = str(env_var)
            has_key = reqenv.has_key(env_var_str)
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
#
# v0.44 TEMPLATE PILL (user spec: "change the deep research pill entirely to
# a template pill where user can select templates and browse the library,
# with the deep research being one of the default templates"): the index
# grew beyond templates.py's DEFAULT_TEMPLATES. The library now merges
# THREE sources, each tolerant (corrupt/missing → skip + warn, never 500):
#
#   1. DEFAULT_TEMPLATES (templates.py)            → kind "flow"
#   2. brain/orchestrator/templates/*.json (13)    → kind "orchestrator"
#      (stage-JSON pipelines; descriptions come from the "//" comment keys)
#   3. brain/superpowers_user_templates.json (5)   → kind "user"
#      (markdown disciplines)
#
# Dedup rule (mirrors tools/dt_template.py index_templates): a flow/user
# entry whose task_type/id matches an orchestrator stem IS the same
# pipeline — listed once. User ids are hyphenated ("superpowers-plan") so
# they never collide with the underscored orchestrator stems.
#
# Entry shape (one for all three kinds):
#   {id, name, description, task_type, kind, stage_count, tags,
#    stages?: [{name, role, instructions, fanout?}], markdown?: "..."}


def _tpl_first_comment_line(data: dict) -> str:
    """Orchestrator JSONs describe themselves in "//", "//1", … comment
    keys (dict order = file order) — first one's first line, else ""."""
    for key, val in data.items():
        if key.startswith("//") and isinstance(val, str):
            line = val.strip().splitlines()[0].strip() if val.strip() else ""
            if line:
                return line
    return ""


def _tpl_slug(name: str) -> str:
    """Name → id: lowercase alphanumerics + hyphens ("Superpowers Plan" →
    "superpowers-plan"). Hyphenated on purpose so user ids never collide
    with the underscored orchestrator file stems (dt_template's rule)."""
    import re as _re
    s = _re.sub(r"[^0-9A-Za-z]+", "-", str(name or "")).strip("-").lower()
    return s or "template"


def _tpl_stage_shape(st: dict) -> dict:
    """One stage normalized to the index shape (name/role/instructions/
    fanout — inputs + max_tokens stay in the source files, the index
    doesn't need them)."""
    out = {
        "name": str(st.get("name") or ""),
        "role": str(st.get("role") or ""),
        "instructions": str(st.get("instructions") or ""),
    }
    fo = st.get("fanout")
    if isinstance(fo, dict):
        out["fanout"] = {
            "over": str(fo.get("over") or ""),
            "max_parallel": fo.get("max_parallel", 1),
        }
    return out


def _scan_orchestrator_templates():
    """brain/orchestrator/templates/*.json → index entries (kind
    "orchestrator"). Pure DATA — the orchestrator engine is never imported
    (dt_template's hard rule, kept here). Returns (entries, warnings)."""
    root = Path(__file__).resolve().parent
    tdir = root / "orchestrator" / "templates"
    out, warnings = [], []
    if not tdir.is_dir():
        return out, warnings
    for path in sorted(tdir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except Exception as exc:  # corrupt JSON → skip + warn
            warnings.append(f"{path.name}: unreadable JSON ({type(exc).__name__}) — skipped")
            continue
        if not isinstance(data, dict):
            warnings.append(f"{path.name}: not a JSON object — skipped")
            continue
        stages = [s for s in data.get("stages") or [] if isinstance(s, dict)]
        if not stages:
            warnings.append(f"{path.name}: no stages[] — not an orchestrator template, skipped")
            continue
        task_type = str(data.get("task_type") or path.stem)
        desc = _tpl_first_comment_line(data)
        if not desc:
            desc = f"{task_type.replace('_', ' ')} pipeline with {len(stages)} stages"
        out.append({
            "id": path.stem,
            "kind": "orchestrator",
            "name": str(data.get("name") or path.stem),
            "task_type": task_type,
            "description": desc,
            "stage_count": len(stages),
            "stages": [_tpl_stage_shape(st) for st in stages],
            "tags": [],
        })
    return out, warnings


def _scan_user_templates():
    """brain/superpowers_user_templates.json → index entries (kind "user",
    markdown disciplines). Returns (entries, warnings)."""
    root = Path(__file__).resolve().parent
    upath = root / "superpowers_user_templates.json"
    out, warnings = [], []
    if not upath.is_file():
        return out, warnings
    try:
        data = json.loads(upath.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        warnings.append(f"{upath.name}: unreadable JSON ({type(exc).__name__}) — skipped")
        return out, warnings
    if not isinstance(data, list):
        warnings.append(f"{upath.name}: expected a list — skipped")
        return out, warnings
    for raw in data:
        if not isinstance(raw, dict) or not str(raw.get("name", "")).strip():
            warnings.append(f"{upath.name}: entry without a name — skipped")
            continue
        name = str(raw["name"]).strip()
        stages = [s for s in raw.get("stages") or [] if isinstance(s, dict)]
        out.append({
            "id": _tpl_slug(name),
            "kind": "user",
            "name": name,
            "task_type": str(raw.get("task_type") or _tpl_slug(name)),
            "description": str(raw.get("description") or raw.get("task") or name),
            "stage_count": len(stages),
            "stages": [_tpl_stage_shape(st) for st in stages],
            "markdown": str(raw.get("markdown") or ""),
            "tags": [str(t) for t in raw.get("tags") or [] if str(t).strip()],
        })
    return out, warnings


def _default_flow_entries():
    """templates.py's DEFAULT_TEMPLATES normalized to the index shape
    (kind "flow"; id = task_type). Import is best-effort — a broken
    templates.py just means no flow entries (the JSON sources carry the
    same pipelines). Returns (entries, warnings) like its siblings."""
    out = []
    try:
        import templates as tl
        raw = getattr(tl, "DEFAULT_TEMPLATES", None)
        if not isinstance(raw, list):
            return out, []
        for r in raw:
            if not isinstance(r, dict) or not str(r.get("name", "")).strip():
                continue
            stages = [s for s in r.get("stages") or [] if isinstance(s, dict)]
            out.append({
                "id": str(r.get("task_type") or _tpl_slug(r["name"])),
                "kind": "flow",
                "name": str(r["name"]),
                "task_type": str(r.get("task_type") or _tpl_slug(r["name"])),
                "description": str(r.get("description") or r.get("task") or r["name"]),
                "stage_count": len(stages),
                "stages": [_tpl_stage_shape(st) for st in stages],
                "markdown": str(r.get("markdown") or ""),
                "tags": [str(t) for t in r.get("tags") or [] if str(t).strip()],
            })
    except Exception:
        out = []
    return out, []


def _merged_template_index():
    """The whole library view: orchestrator + user + flow, deduped.
    Returns (entries, warnings). Order: orchestrator, user, flow (stable;
    the frontend groups by kind/tags anyway)."""
    orch, warnings = _scan_orchestrator_templates()
    user, uwarn = _scan_user_templates()
    warnings += uwarn
    flow, _ = _default_flow_entries()

    # dt_template's dedup: a flow entry whose task_type matches an
    # orchestrator stem is the SAME pipeline — listed once.
    orch_stems = {e["id"] for e in orch}
    used_ids = set(orch_stems)
    entries = list(orch)
    for e in user:
        if e["id"] in used_ids:
            warnings.append(f"user template {e['id']}: duplicate id — skipped")
            continue
        used_ids.add(e["id"])
        entries.append(e)
    for e in flow:
        if e["id"] in used_ids or e["task_type"] in orch_stems:
            continue  # same pipeline, already listed from the JSON source
        used_ids.add(e["id"])
        entries.append(e)
    return entries, warnings


def _find_extra_template(template_id: str):
    """One template from the three-file sources (orchestrator/user/flow).
    EXACT id match first (so the hyphenated user ids stay distinct from
    the underscored orchestrator stems), then a loose alphanumeric match
    (the frontend and the model both type both shapes). Returns the entry
    dict or None."""
    entries, _ = _merged_template_index()

    def _norm(s: str) -> str:
        return "".join(ch for ch in str(s).lower() if ch.isalnum())

    want = str(template_id or "").strip()
    if not want:
        return None
    for e in entries:  # exact first — ids are the contract
        if e["id"] == want:
            return e
    nwant = _norm(want)
    if not nwant:
        return None
    for e in entries:
        if _norm(e["id"]) == nwant or _norm(e.get("task_type") or "") == nwant:
            return e
    return None


@app.get("/templates")
def list_templates():
    """List the whole template library (v0.44: orchestrator stage-JSONs +
    superpowers user templates + the DEFAULT_TEMPLATES flows, merged and
    deduped; warnings ride along so a corrupt file is visible, not
    fatal)."""
    try:
        entries, warnings = _merged_template_index()
        out = {
            "templates": entries,
            "total": len(entries),
        }
        if warnings:
            out["warnings"] = warnings
        return out
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"templates": [], "error": str(e)}


@app.get("/templates/{template_id}")
def get_template(template_id: str):
    """Get one template's full definition (v0.44: searched across ALL
    three sources first — orchestrator JSONs, user markdown templates,
    DEFAULT flows — then templates.py's DB-backed get_template for
    user-created/downloaded rows)."""
    try:
        hit = _find_extra_template(template_id)
        if hit is not None:
            return _to_jsonable(hit)
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
        raise HTTPException(status_code=404, detail=redact.redact(f"template {template_id} not found"))
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
        raise HTTPException(status_code=500, detail=redact.redact(str(e)))


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

    # v0.72 BYOK: per-request keys (the user's own on shared spaces) —
    # never a global env write (the old injection raced concurrent turns).
    req_env = reqenv.extract(request)
    reqenv.set_request_env(req_env, reqenv.extract_keyed(request))

    async def event_stream():
        try:
            async for ev in _run_judge_panel(user_input, template, count, session_id):
                if isinstance(ev, dict) and ev.get("type") in ("error", "judge_error"):
                    redact.redact_dict(ev)
                    ev.setdefault("key_source", "user" if req_env else "shared")
                yield f"data: {json.dumps(ev)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            traceback.print_exc()
            err_ev = {"type": "error", "error": "judge", "message": redact.redact(str(e)),
                      "key_source": "user" if req_env else "shared"}
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
        if reqenv.has_key(cfg["env_var"]):
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
        # v0.72 BYOK: req_env (this request's own keys) first, space secret fallback.
        api_key = reqenv.resolve_key(cfg["env_var"])
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
          "workspace", "history",
          "template_id", "template_brief"  # v0.44: informational — the
          # METHOD TEMPLATE block is already prepended to system_prompt
          # by the engine's handleTurn. }

    Provider keys arrive as X-Env-<ENV_VAR> headers.

    v0.72 BYOK: those headers are PER-REQUEST values (the user's own key
    on shared spaces), resolved here — req_env first, the space's own
    os.environ secret (the community public keys) as the fallback. They
    are NEVER written into os.environ: that write was process-global and
    raced concurrent shared-space users (B's key overwrote A's mid-turn;
    B's keyless turn silently used A's leftover). The resolved key is
    threaded explicitly into run_turn; call-time tool lookups ride
    reqenv's ContextVar (set below — same async context as the SSE
    generator + the strands agent's tool calls).
    """
    body = await request.json()
    session_id = body.get("session_id", "unknown")
    message = body.get("message", "")
    model = body.get("model", "")
    provider = body.get("provider", "")

    # v0.72: per-request env — the user's own keys (BYOK), never a global write.
    req_env = reqenv.extract(request)
    reqenv.set_request_env(req_env, reqenv.extract_keyed(request))

    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    # Resolve the model via the provider registry.
    # model can be "openrouter/auto" or a logical name like "glm-5.2".
    # v0.38: the registry resolves env_var + api_key from the X-Env-* headers
    # (make_provider_registry reads os.environ AFTER the header injection
    # above). litellm needs the provider PREFIX STRIPPED (the engine sends
    # "nvidia/z-ai/glm-5.3-flash"; NVIDIA's own model id is "z-ai/glm-5.3-flash")
    # and the openai-compatible client is forced in agent.py via base_url.
    registry = make_provider_registry()
    litellm_model = model
    base_url = ""
    env_var = ""

    # If the model has a provider prefix (e.g. "openrouter/auto"), find that provider.
    if "/" in model:
        prov_name, model_name = model.split("/", 1)
        for p in registry:
            if p.name == prov_name:
                if model_name == "auto":
                    # v0.44 QA FIX (live redteam): the engine resolves
                    # "<provider>/auto" to a concrete model BEFORE the turn
                    # reaches us — but a stale session (or a direct brain
                    # caller) can still land here, and p.models was an
                    # EMPTY tuple for nvidia (stale providers_catalog.json)
                    # → IndexError → 500 "provider error". Fall back to the
                    # known-good quick models (the engine's FALLBACK_MODELS
                    # philosophy — resilience, not discovery; the live
                    # catalog remains the primary mechanism) and fail with
                    # an actionable 400 when even that's impossible.
                    # v0.93.3: the fallbacks refresh to the LIVE model sets
                    # (kimi-k2.6 was EOL'd by PM — a direct /chat with
                    # privatemodeai/auto died 404 "model kimi-k2.6 not
                    # found", live-reproduced on the shared space; the
                    # engine normally resolves auto BEFORE the turn, but a
                    # stale session or direct brain caller still lands here).
                    AUTO_MODEL_FALLBACK = {
                        "nvidia": "z-ai/glm-5.3-flash",
                        "privatemodeai": "glm-latest",
                        "opencode": "big-pickle",
                        "openrouter": "auto",  # OpenRouter natively routes auto
                    }
                    if p.models:
                        litellm_model = p.models[0]
                    elif prov_name in AUTO_MODEL_FALLBACK:
                        litellm_model = AUTO_MODEL_FALLBACK[prov_name]
                    else:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"model 'auto' could not be resolved for "
                                f"{prov_name} (provider catalog is empty — "
                                "pick a specific model in the model browser)"
                            ),
                        )
                else:
                    litellm_model = model_name
                base_url = p.url
                env_var = p.env_var if hasattr(p, "env_var") else ""
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
        # v0.75.5+: the raw-HTTP twin of the SSE choke points — the model
        # string is fully request-controlled and phase-4's contract is
        # "every error sink" (a key-shaped model id must not reflect back).
        raise HTTPException(status_code=400, detail=redact.redact(f"could not resolve model {model} (provider {provider})"))

    # v0.76.6 THE LIST ENV_VAR FIX (live-found: github-models 500s on EVERY
    # /chat): the catalog allows env_var as a LIST of alternates
    # (github-models: ["GITHUB_TOKEN", "GH_TOKEN"]) — req_env.get(<list>)
    # is a TypeError: unhashable type, and the 500 ate the whole turn.
    # Normalize ONCE here; every consumer below (key lookup, attribution,
    # error events) speaks the same names.
    _env_names = [str(v) for v in env_var] if isinstance(env_var, list) else [str(env_var)]
    _env_names = [n for n in _env_names if n]
    env_var = _env_names[0] if _env_names else str(env_var)

    # v0.72 BYOK: the user's own key (X-Env header) first; the space's own
    # secret (os.environ — the community public keys) as the fallback.
    api_key = ""
    for _n in _env_names:
        api_key = req_env.get(_n) or os.environ.get(_n, "")
        if api_key:
            env_var = _n  # the name that actually resolved (attribution truth)
            break
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail=redact.redact(f"no API key set for {' / '.join(_env_names)} (provider {provider})"),
        )

    # v0.75 ERROR ATTRIBUTION: whose key is this turn riding? Every error
    # event the stream emits carries it — the app then says "your key was
    # rejected" vs "the community key is unavailable" instead of a bare
    # 401 the user can't act on.
    key_source = "user" if req_env.get(env_var) else "shared"

    # v1.10.2 THE BLACK-HOLE GUARD (brain side, D1): pre-flight the
    # provider's reachability from THIS sandbox before the first model
    # call — a stalling provider (live-observed: NVIDIA from HF egress,
    # 2026-10-06) would otherwise sit silent for the per-call 86400s
    # timeout while the heartbeats say "still working". The probe is
    # 15s, cached (ok 10 min / stall 30 min), only on Spaces, and NEVER
    # cancels a running turn (the v0.80.1 no-kill directive holds). A
    # stall streams ONE honest error event — no day-long hang, no tokens.
    _probe_provider = prov_name if prov_name else provider
    _stall_msg = provider_health.check(_probe_provider, base_url, api_key, litellm_model)
    if _stall_msg:
        async def _stall_stream():
            yield "data: " + json.dumps({
                "type": "error", "error": "provider_stalled",
                "message": redact.redact(_stall_msg),
                "provider": _probe_provider, "model": model,
                "key_source": key_source, "env_var": env_var,
            }) + "\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(
            _stall_stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def event_stream():
        try:
            async for ev in run_turn(
                session_id=session_id,
                message=message,
                model=litellm_model,
                base_url=base_url,
                env_var=env_var,
                # v0.72 BYOK: the per-request key resolved above (the user's
                # own when present, else the space's secret). Explicit — no
                # os.environ read inside the turn, no cross-user races.
                api_key=api_key,
                system_prompt=body.get("system_prompt", ""),
                effort=body.get("effort", "med"),
                workspace=body.get("workspace", ""),
                web_search=body.get("web_search", True),  # v0.45 ITEM 2: default-on
                deep_research=body.get("deep_research", False),
                mode=body.get("mode", "auto"),
                history=body.get("history", []),
                workspaces=body.get("workspaces", []),
                # v0.52 THE 3 PILLS: per-chat auto-search toggles (the
                # [template|+] / [skills|+] label press) — gate the
                # dtemplate/skills tools + their system-prompt lines.
                template_auto=body.get("template_auto", False),
                skills_auto=body.get("skills_auto", False),
                # v0.60 pt C.9: THE LIB PILL — the single gatekeeping flag.
                lib_auto=body.get("lib_auto", False),
                # v0.68: the effective tweaks gates (None-safe — old
                # engines don't send them).
                bot_lib=body.get("bot_lib"),
                bot_dl=body.get("bot_dl"),
            ):
                if isinstance(ev, dict) and ev.get("type") == "error":
                    # v0.75: the attribution + the honest provider name —
                    # every error the turn produces (auth, provider 401/403,
                    # internal) carries the same marker. The message is
                    # REDACTED in flight (a provider that echoes the auth
                    # header, a tool that prints a key — nothing survives).
                    redact.redact_dict(ev)
                    ev.setdefault("key_source", key_source)
                    ev.setdefault("env_var", env_var)
                yield f"data: {json.dumps(ev)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            traceback.print_exc()
            err_ev = {
                "type": "error", "error": "brain", "message": redact.redact(str(e)),
                "key_source": key_source, "env_var": env_var,
            }
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
