"""dt_registry.py — the doomalay-tools registry (v0.43 "swarm wave" foundation).

WHAT THIS FILE IS
=================
The single integration seam between the StrandsAdapter (brain/agent_core.py)
and the doomalay custom tool suite (brain/tools/dt_*.py). Every tool module
is DISCOVERED and BUILT at agent-start; a broken module can never take the
agent down (per-module try/except). This is what lets many agents add tools
in parallel without ever touching agent_core.py.

HOW A TOOL MODULE LOOKS
=======================
Each brain/tools/dt_<name>.py must expose:

    TOOL_NAMES = ["<name>", ...]          # for docs/logging
    def build(ctx) -> list                 # returns @tool-decorated callables

Rules (see brain/tools/dt_spec.md for the full contract):
- NO strands import at module top — only inside build() (tests import the
  module without strands installed).
- Core logic lives in plain functions (unit-testable, no SDK).
- build(ctx) must never raise; wrap internals defensively.
- State persists as JSON/JSONL under ctx.state_dir() (workspace/.doomalay/).
- `python3 dt_<name>.py` runs an OFFLINE self-test of the plain functions.

ToolContext (what ctx carries)
==============================
- workspace / workspace_id / chat_session_id — where the agent works
- session — the owning AgentSession backref (may be None in tests)
- model — the resolved model id (string, may be None)
- engine_url — the Go engine's base URL (http://127.0.0.1:<port>) for
  artifacts + engine API calls (set via DOOMALAY_ENGINE_URL, injected by
  cmd/doomalay/main.go before the brain subprocess spawns)
- brain_dir / skills_dir / templates_dir — brain assets on disk
- spawn(task, model, wait, timeout) — THE sub-agent seam: spawns a
  sub-agent sharing this workspace, returns its final text (or status when
  wait=False returns an id + you poll via spawn_status()). Wired in
  agent_core.StrandsAdapter._build_dt_ctx().
- emit(**kw) — log_event-compatible status emitter (oplog + transcript)
- memory — the memory layer module (lazy) for .pied cross-agent state

SELF-TEST
=========
`python3 dt_registry.py` builds a fake ctx over a temp dir, loads every
dt_* module, and reports which modules build (strands not required —
modules with a `build_mock` fallback path still register their names).
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

BRAIN_DIR = Path(__file__).resolve().parent
TOOLS_DIR = BRAIN_DIR / "tools"

# Hard cap — the Strands tool loop degrades past ~60 tools.
MAX_DT_TOOLS = 48


@dataclass
class ToolContext:
    """Everything a dt_* tool may touch. Constructed by StrandsAdapter."""

    workspace: Path
    workspace_id: str | None = None
    chat_session_id: str | None = None
    session: Any = None                 # AgentSession backref (may be None)
    model: str | None = None
    engine_url: str = field(default_factory=lambda: os.environ.get(
        "DOOMALAY_ENGINE_URL", "http://127.0.0.1:8080"))
    brain_dir: Path = field(default_factory=lambda: BRAIN_DIR)
    skills_dir: Path = field(default_factory=lambda: BRAIN_DIR / "agent_skills")
    templates_dir: Path = field(default_factory=lambda: BRAIN_DIR / "orchestrator" / "templates")
    # Sub-agent seam — set by agent_core; tools must tolerate it being None
    # (offline tests) and degrade to instructions instead of raising.
    spawn: Callable[..., Any] | None = None
    spawn_status: Callable[[str], dict] | None = None
    # log_event-compatible emitter: emit(event="...", **fields)
    emit: Callable[..., None] | None = None
    # v0.44 WORKSPACES: the chat's bound cloud repos, engine-side rows —
    # [{id, name, kind, host, owner, repo, url, branch, access,
    #   sandbox_path}] (ids only; tokens live in the engine vault and the
    # tools call the engine REST, like dt_artifact does). Empty in tests
    # and workspace-less chats — tools degrade to actionable messages.
    workspaces: list = field(default_factory=list)
    # Resolved at call time so a missing memory_layer never breaks imports.
    _memory: Any = None

    def workspace_by_ref(self, ref: str) -> dict | None:
        """Resolve a bound workspace by id, owner/repo, name or URL suffix.

        The single name-resolution path every workspace-aware tool shares
        (case-insensitive; suffix match handles 'doomalay' → the full
        'ScoobyBaby1999/doomalay' name).
        """
        if not ref or not self.workspaces:
            return None
        r = str(ref).strip().lower().rstrip("/")
        for ws in self.workspaces:
            if str(ws.get("id", "")).lower() == r:
                return ws
        for ws in self.workspaces:
            name = str(ws.get("name", "")).lower()
            or_slash = f"{str(ws.get('owner', '')).lower()}/{str(ws.get('repo', '')).lower()}"
            if name == r or or_slash == r:
                return ws
        for ws in self.workspaces:
            name = str(ws.get("name", "")).lower()
            if name.endswith("/" + r) or str(ws.get("repo", "")).lower() == r:
                return ws
        return None

    # ── helpers ────────────────────────────────────────────────────────
    def state_dir(self) -> Path:
        """Persistent per-workspace state root: workspace/.doomalay/"""
        d = Path(self.workspace) / ".doomalay"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def tool_state(self, tool: str) -> Path:
        """Per-tool state subdir: workspace/.doomalay/<tool>/"""
        d = self.state_dir() / tool
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def memory(self) -> Any:
        """Lazy memory layer (.pied sanity log) — None when unavailable."""
        if self._memory is None:
            try:
                import memory_layer  # noqa: F401  (brain CWD import)
                self._memory = memory_layer
            except Exception:
                self._memory = False
        return self._memory or None

    def log(self, event: str, **fields: Any) -> None:
        """Best-effort status emit (oplog + transcript); never raises."""
        try:
            if self.emit is not None:
                self.emit(event=event, **fields)
        except Exception:
            pass
        try:
            m = self.memory
            if m is not None:
                m.log_event(self.workspace, "tool", event, fields)
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────
# Loader
# ─────────────────────────────────────────────────────────────────────────

_loaded: dict[str, Any] = {}


def _import_dt_module(path: Path):
    """Import a dt_*.py file as a standalone module (no package needed)."""
    name = f"doomalay_dt_{path.stem}"
    if name in _loaded:
        return _loaded[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"no spec for {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    _loaded[name] = mod
    return mod


def discover() -> list[Path]:
    """All dt_*.py modules, sorted for deterministic tool ordering."""
    if not TOOLS_DIR.exists():
        return []
    return sorted(TOOLS_DIR.glob("dt_*.py"))


def load_doomalay_tools(ctx: ToolContext, strands_tool_decorator=None) -> list:
    """Build every dt_* tool. Broken modules are skipped, never fatal.

    Returns a list ready to extend the StrandsAdapter tools list. When
    strands_tool_decorator is given it is NOT used here — each module
    imports the decorator itself inside build() (so the registry stays
    strands-free and unit-testable).
    """
    tools: list = []
    built: list[str] = []
    failed: dict[str, str] = {}
    for path in discover():
        try:
            mod = _import_dt_module(path)
            built_list = mod.build(ctx)
            if built_list:
                tools.extend(built_list[:MAX_DT_TOOLS])
                names = getattr(mod, "TOOL_NAMES", None) or [path.stem[3:]]
                built.extend(names if isinstance(names, list) else [str(names)])
        except Exception as exc:  # noqa: BLE001 — never fatal by design
            failed[path.stem] = f"{type(exc).__name__}: {exc}"
            traceback.print_exc(file=sys.stderr)
    try:
        ctx.log("dt_tools_loaded", built=built, failed=failed)
    except Exception:
        pass
    return tools


def tool_manifest(ctx: ToolContext | None = None) -> dict:
    """Introspection: names + descriptions of every dt_* module (no strands)."""
    out: dict = {}
    for path in discover():
        try:
            mod = _import_dt_module(path)
            names = getattr(mod, "TOOL_NAMES", None) or [path.stem[3:]]
            doc = (getattr(mod, "__doc__", "") or "").strip().splitlines()
            out[path.stem] = {
                "names": names if isinstance(names, list) else [str(names)],
                "doc": doc[0] if doc else "",
            }
        except Exception as exc:  # noqa: BLE001
            out[path.stem] = {"names": [path.stem[3:]], "error": str(exc)}
    return out


# ─────────────────────────────────────────────────────────────────────────
# Offline self-test
# ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="dt-registry-"))
    ctx = ToolContext(workspace=tmp)
    print(f"workspace: {tmp}")
    print(f"state_dir: {ctx.state_dir()}")
    print(f"engine_url: {ctx.engine_url}")
    print(f"tools_dir: {TOOLS_DIR} ({len(discover())} dt modules)")
    manifest = tool_manifest(ctx)
    for mod, info in manifest.items():
        print(f"  {mod}: names={info['names']} doc={info.get('doc', '')[:60]}"
              + (f" ERROR={info['error']}" if "error" in info else ""))
    # A registry build over fake ctx: modules whose build() needs strands
    # will register nothing here (fine) — but must NOT crash the loader.
    tools = load_doomalay_tools(ctx)
    print(f"loader returned {len(tools)} tools without strands installed")
    print("SELF-TEST OK")
