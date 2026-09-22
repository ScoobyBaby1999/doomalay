# dt_spec.md — the doomalay custom-tool contract (v0.43 swarm wave)

Read this BEFORE writing any `dt_*.py` tool. It is the binding contract
between the registry (`brain/dt_registry.py`) and every tool module.

## File layout

```
brain/tools/dt_<name>.py     ← THE tool module (you write exactly one)
brain/tests/test_dt_<name>.py ← offline unit test of the plain functions
```

## The module contract

```python
"""dt_<name>.py — <one-line what it does>.

<Short paragraph: where the feature comes from (old app / user request),
what actions the tool exposes, where state persists.>
"""
from __future__ import annotations

TOOL_NAMES = ["<name>"]          # primary tool name(s) built below

# ── plain, unit-testable core (NO strands import up here) ──────────────

def _load_state(path) -> dict: ...          # JSON helpers, pure logic
def _save_state(path, data) -> None: ...
def <verb>(state: dict, ...) -> dict|str: ...

# ── strands surface ────────────────────────────────────────────────────

def build(ctx) -> list:
    """Return @tool-decorated callables built from ctx (never raises)."""
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []                    # offline: register nothing

    @strands_tool_decorator(name="<name>", description=(
        "<2–4 sentences: WHAT it does, WHEN to use it, the action verbs. "
        "Written for the model that decides whether to call it.>"
    ))
    def <name>(action: str, ...) -> str:
        """<arg docs in the docstring — strands uses this for the schema.>"""
        ...
    return [<name>]
```

## Hard rules

1. **No strands at module top.** Import the decorator *inside* `build()`.
   Tests and the registry import your module without the SDK installed.
2. **`build(ctx)` never raises** — wrap the whole body defensively; return
   `[]` when a dependency is missing.
3. **State → `ctx.tool_state("<name>")`** (`workspace/.doomalay/<name>/`).
   JSON for structured state, JSONL for append-only logs. Write atomically
   (tmp file + `os.replace`) so a kill mid-write can't corrupt state.
4. **One tool = one file.** Never edit `agent_core.py`, `dt_registry.py`,
   other dt_* files, the engine, or the web app — the orchestrator owns
   those seams. Your tool runs from YOUR file only.
5. **Degrade, don't crash.** Missing network / missing engine / missing
   spawn seam → return a short actionable message ("engine unreachable at
   {url}: …") instead of raising. Timeouts on every network call.
6. **No secrets in output.** Never print env values; reference names only
   (`HF_TOKEN set` not the token). If your tool NEEDS a secret, read it
   from env inside the function.
7. **Self-test**: `python3 brain/tools/dt_<name>.py` runs offline asserts
   on the plain core (temp dirs, no network, exit 0).
8. **Unit test**: `brain/tests/test_dt_<name>.py` — plain asserts, runs
   via `python3 brain/tests/test_dt_<name>.py` AND pytest. No network, no
   strands, no engine. Cover every action verb + edge cases (empty state,
   unknown action, malformed input).
9. **Return text ≤ ~6000 chars.** Trim long payloads and say where the
   full data lives (state file path or artifact).
10. **Help text**: every tool supports `action="help"` returning a compact
    cheat-sheet of actions + args (the model's first call when unsure).

## ToolContext recap (what ctx gives you)

- `ctx.workspace` (Path), `ctx.workspace_id`, `ctx.chat_session_id`
- `ctx.model`, `ctx.session` (AgentSession backref, may be None)
- `ctx.engine_url` — Go engine base URL (`http://127.0.0.1:<port>`);
  artifacts REST lives at `{engine_url}/api/sessions/{chat_session_id}/artifacts`
- `ctx.skills_dir` — 17 agent_skills dirs (incl. 15 superpowers-*)
- `ctx.templates_dir` — orchestrator stage-JSON templates
- `ctx.spawn(task, model="", wait=True, timeout=150)` — sub-agent seam
  (returns final text, or `{"id":...}` when wait=False; may be None in
  offline tests → degrade to instructions)
- `ctx.emit` / `ctx.log(event, **fields)` — status events (oplog +
  transcript) for progress lines the user sees live
- `ctx.memory` — memory_layer module or None
- `ctx.tool_state("<name>")` — per-tool persistent state dir

## Style

- Match the repo's voice: dense why-comments above functions, full-word
  names, no clever imports. Read `brain/agent_core.py`'s `memory` tool and
  `delegate` tool for the house style of inline @tool definitions.
- Errors are strings returned to the model, not exceptions.
- Timestamps ISO-8601 UTC (`datetime.now(timezone.utc).isoformat()`).
