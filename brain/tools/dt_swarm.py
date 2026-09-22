"""dt_swarm.py — parallel multi-agent fan-out (the "swarm" node).

v0.43 "most capable quick chat" wave, user ask #1 ("Use swarm agents node"):
ONE tool call fans N task prompts out to N sub-agents running concurrently on
the SHARED workspace (same filesystem + .pied memory layer), waits for them,
and merges every answer into a single report the orchestrating model can act
on — instead of the model running sub-tasks one at a time.

Actions: run (fan out + wait + merged report), status (compact summary),
report (full text, optionally one agent), list (recent swarms), help.

State: workspace/.doomalay/swarm/<swarm_id>.json — one JSON file per swarm
holding every agent's FULL result text (tool returns stay <= ~6000 chars and
point here, per dt_spec rule 9). The fan-out rides ctx.spawn — the ONE
sanctioned sub-agent seam (agent_core.spawn_subagent, mirrors the delegate
tool but returns structured dicts). When that seam is missing (offline /
unit tests) the run action degrades to sequential instructions instead of
raising.

Design rule (dt_spec.md): task parsing, report building and state IO live in
plain, thread-free, ctx-free functions (parse_tasks / merge_report /
load_state / save_state / status_summary / report_text / list_swarms / …) so
unit tests need neither strands nor threads. The ThreadPoolExecutor fan-out
lives in _run_swarm + _thread_runner, wired only from build(ctx); _run_swarm
takes an injectable `runner` so tests can fan out serially with a fake spawn.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed  # only _thread_runner spawns threads
from datetime import datetime, timezone
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    """Env-tunable knob: int when parseable, default otherwise (never raises
    — a malformed env value must not take the tool down)."""
    try:
        return int(str(os.environ.get(name, "")).strip())
    except Exception:
        return default


TOOL_NAMES = ["swarm"]

# Fan-out knobs — v0.44 UNBOUNDED SWARM (user spec #2: "let it swarm as
# many agents and sub processes as it wants… no artificial caps").
# The old caps (4 default / 8 hard / 240s) were machine-limits from the
# deadlocking AgentSession era; run_subagent_turn is a lightweight
# fresh-Agent-per-turn path that carries no session-table cost, so the
# ceiling moves to env-tunable defaults an order of magnitude higher.
# DOOMALAY_SWARM_MAX_PARALLEL=0 → truly unbounded (parallel == task count).
DEFAULT_MAX_PARALLEL = 12
MAX_PARALLEL_CAP = _env_int("DOOMALAY_SWARM_MAX_PARALLEL", 64)  # 0 = unbounded
# Per-agent wall budget: spawn_subagent's own default was 150s; deep tasks
# (repo exploration, multi-file builds) legitimately run minutes. The 10s
# floor mirrors spawn_subagent's own clamp.
DEFAULT_TIMEOUT_SECS = 300
TIMEOUT_CAP_SECS = _env_int("DOOMALAY_SWARM_TIMEOUT_CAP", 900)
TIMEOUT_FLOOR_SECS = 10

PREVIEW_CHARS = 120      # ctx.log preview per completion (spec)
TASK_HEADER_CHARS = 80   # per-agent task text shown in report headers (spec)
RESULT_CHARS = 1500      # per-agent body trim in the merged report (spec)
RETURN_CAP = 6000        # whole tool-return budget (dt_spec rule 9)
MAX_TASK_CHARS = 2000    # stored task-text cap — keeps state files sane when
                         # a model pastes a whole file into `tasks`
LIST_LIMIT = 12          # swarms shown by the list action

# swarm ids we mint are always "sw-<hex8>"; the SAME allowlist also gates the
# model-supplied swarm_id before it reaches the filesystem (status/report
# build a path from it) — closes the "../" path-traversal vector the same way
# tools/worktree.py does for agent ids.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# sentinel distinguishing "json.loads raised" from "json.loads returned None"
# (the literal text "null" decodes to None — that's junk input, not the
# line-split recovery path)
_BAD_JSON = object()


def now_iso() -> str:
    """ISO-8601 UTC timestamp (dt_spec house rule)."""
    return datetime.now(timezone.utc).isoformat()


def new_swarm_id() -> str:
    """sw-<hex8>: short enough to quote in chat, unique enough per workspace."""
    return "sw-" + uuid.uuid4().hex[:8]


def _safe_id(user_id: str) -> str:
    """Sanitize a model-supplied id before it becomes a filename.

    Returns "" (rejected) for anything outside [A-Za-z0-9_-]{1,64} or
    containing ".." — the status/report actions would otherwise read
    arbitrary paths via swarm_id="../../…".
    """
    s = (user_id or "").strip()
    if not s or ".." in s or not _ID_RE.match(s):
        return ""
    return s


def _to_int(v, default: int) -> int:
    """Model-proof int coercion: the schema says int, but a sloppy model may
    pass "4" or 4.5 — degrade to the default on garbage, never raise."""
    try:
        return int(v)
    except Exception:
        try:
            return int(float(v))
        except Exception:
            return default


def _preview(s) -> str:
    """Single-line, whitespace-collapsed first 120 chars — keeps the
    swarm_agent_done oplog events one line each."""
    return " ".join(str(s or "").split())[:PREVIEW_CHARS]


def _trim(s, n: int) -> str:
    """Trim to n chars with an explicit pointer to the full text (the state
    file) so the model knows the body was cut, not silently ended."""
    s = str(s or "")
    if len(s) <= n:
        return s
    return s[:n].rstrip() + f" …[+{len(s) - n} chars in state file]"


def _cap_task(s: str) -> str:
    """Cap a single task's STORED text (see MAX_TASK_CHARS)."""
    if len(s) <= MAX_TASK_CHARS:
        return s
    return s[:MAX_TASK_CHARS].rstrip() + " …[task truncated]"


# ─────────────────────────────────────────────────────────────────────────
# PLAIN CORE — task parsing, report building, state IO.
# No threads, no ctx, no spawn, no strands: everything below is directly
# unit-testable (see brain/tests/test_dt_swarm.py + the __main__ self-test).
# ─────────────────────────────────────────────────────────────────────────

def parse_tasks(raw) -> list[dict]:
    """Normalize any accepted `tasks` input into [{"task": str, "model": str}].

    Accepted shapes (spec):
      - JSON text of an array of strings:  '["a", "b"]'
      - JSON text of an array of objects:  '[{"task": "a", "model": "m"}]'
      - a bare Python list of strings/dicts (internal callers / pre-parsed)
      - a plain multi-line string: one task per non-empty line — this is the
        RECOVERY path for malformed JSON (spec: never fail the whole run
        because the model bracketed the array wrong)
    Non-string / non-dict items are skipped; empty input -> []. The returned
    dicts always carry a "model" key ("" = inherit the run-level default).
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        out: list[dict] = []
        for item in raw:
            if isinstance(item, str):
                s = item.strip()
                if s:
                    out.append({"task": _cap_task(s), "model": ""})
            elif isinstance(item, dict):
                # accept the common aliases a model drifts into; keep it
                # strict enough that garbage keys don't phantom-spawn agents
                t = str(item.get("task") or item.get("prompt")
                        or item.get("description") or "").strip()
                if t:
                    out.append({"task": _cap_task(t),
                                "model": str(item.get("model") or "").strip()})
        return out
    if isinstance(raw, dict):
        # single {"task": ...} object — treat as a 1-element array
        return parse_tasks([raw])
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
        except Exception:
            parsed = _BAD_JSON
        if parsed is _BAD_JSON:
            # malformed JSON -> the documented line-split recovery
            return parse_tasks(s.splitlines())
        if isinstance(parsed, (list, tuple)):
            return parse_tasks(list(parsed))
        if isinstance(parsed, dict):
            return parse_tasks([parsed])
        if isinstance(parsed, str):
            # a bare JSON string ("just do X") — one task per non-empty line
            return parse_tasks(parsed.splitlines())
        return []  # JSON number/bool/null — no sane task interpretation
    return []  # numbers/bools/objects from a duck-typed caller


def save_state(path, data: dict) -> None:
    """Write one swarm state JSON atomically (tmp + os.replace).

    A kill mid-write then leaves either the old or the new file — never a
    truncated JSON — which matters because `run` snapshots state on every
    agent completion (crash post-mortem) and status/report re-read it.
    Raises propagate: callers treat persistence as best-effort.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    os.replace(tmp, p)


def load_state(path) -> dict:
    """Read a swarm state JSON; {} for missing/corrupt/non-object files.

    The state dir is model-writable, so `list`/`status` must never crash on
    a junk or half-written file — {} is the universal "not found" answer.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def new_swarm_state(swarm_id: str, agents: list[dict], max_parallel: int,
                    timeout_per_agent: int, model: str) -> dict:
    """The initial (status='running') swarm record, agents all 'pending'."""
    return {
        "swarm_id": swarm_id,
        "created": now_iso(),
        "finished": "",
        "status": "running",
        "model": model or "",
        "max_parallel": max_parallel,
        "timeout_per_agent": timeout_per_agent,
        "wall_secs": 0.0,
        "total": len(agents),
        "ok": 0,
        "failed": 0,
        "agents": agents,
    }


def _section_head(r: dict) -> str:
    """`## <id> — <task[:80]> [done|error]` (spec shape) + a compact meta tail
    (secs, model) the orchestrator uses to judge retry/cost trade-offs."""
    st = r.get("status") if r.get("status") in ("done", "error") else "error"
    meta = []
    if r.get("secs"):
        try:
            meta.append(f"{float(r['secs']):.1f}s")
        except Exception:
            pass
    if r.get("model"):
        meta.append(str(r["model"]))
    m = f" ({', '.join(meta)})" if meta else ""
    task = str(r.get("task") or "")[:TASK_HEADER_CHARS]
    return f"## {r.get('id', '?')} — {task} [{st}]{m}"


def _body(r: dict) -> str:
    """The agent's answer text (done) or its error message (error)."""
    if r.get("status") == "done":
        text = str(r.get("text") or "")
        if text.strip():
            return text
        # spawn's contract lets a sub-agent finish with no text (findings may
        # still be in the memory layer) — say so instead of a blank section
        return "(no text output — sub-agent finished without a reply; check the memory layer findings)"
    return "error: " + (str(r.get("error") or "").strip() or "(no error detail)")


def _note_line(swarm_id: str, full_path: str = "") -> str:
    """Where the full, untrimmed results live (spec: report must say)."""
    if full_path:
        return (f"Full results: {full_path} "
                f"(re-read with swarm(action='report', swarm_id='{swarm_id}'))")
    return f"Full results: swarm(action='report', swarm_id='{swarm_id}')"


def _assemble(header: str, results: list[dict], budget: int, note: str) -> str:
    parts = [header]
    for r in results:
        parts.append(_section_head(r) + "\n" + _trim(_body(r), budget))
    if note:
        parts.append(note)
    return "\n\n".join(parts)


def _fmt_secs(w) -> str:
    try:
        return f"{float(w):.1f}s"
    except Exception:
        return "?s"


def merge_report(swarm_id: str, results: list, wall_secs,
                 full_path: str = "", per_agent_chars: int = RESULT_CHARS,
                 max_chars: int = RETURN_CAP) -> str:
    """Build the merged text report for a finished (or partial) swarm.

    Header line (swarm id, N tasks, ok/failed counts, wall time), then one
    `## <id> — <task[:80]> [done|error]` section per agent with the body
    trimmed to ~1500 chars, then the note pointing at the state file. If the
    whole thing exceeds max_chars (8 agents x 1500 does), a second pass
    squeezes every body to (cap - fixed overhead)/N — the state file always
    carries the full text, so nothing is lost. Plain: no ctx, no threads.
    """
    results = [r for r in results if isinstance(r, dict)]
    n = len(results)
    ok = sum(1 for r in results if r.get("status") == "done")
    header = (f"Swarm {swarm_id} — {n} task{'s' if n != 1 else ''}: "
              f"{ok} ok, {n - ok} failed, {_fmt_secs(wall_secs)} wall")
    note = _note_line(swarm_id, full_path)
    text = _assemble(header, results, per_agent_chars, note)
    if max_chars and n and len(text) > max_chars:
        # global squeeze (dt_spec rule 9): re-trim every body so 8 chatty
        # agents still fit the ~6000-char tool-return budget
        fixed = (len(header) + len(note)
                 + sum(len(_section_head(r)) for r in results)
                 + 2 * (n + 2))          # the "\n\n" separators + slack
        budget = max(120, (max_chars - fixed) // n)
        text = _assemble(header, results, budget, note)
        if len(text) > max_chars:
            # pathological edge (hundreds of agents): hard stop, still honest
            text = text[:max_chars - 60].rstrip() \
                + "\n…[report truncated — full text in state file]"
    return text


def status_summary(state: dict, full_path: str = "") -> str:
    """Compact one-line-per-agent summary for the status action."""
    agents = [a for a in (state.get("agents") or []) if isinstance(a, dict)]
    ok = state.get("ok")
    if ok is None:
        ok = sum(1 for a in agents if a.get("status") == "done")
    total = state.get("total") or len(agents)
    sid = state.get("swarm_id") or "?"
    lines = [
        (f"Swarm {sid} — {total} task{'s' if total != 1 else ''}: "
         f"{ok} ok, {max(0, total - ok)} failed, "
         f"{_fmt_secs(state.get('wall_secs') or 0.0)} wall "
         f"({state.get('status') or '?'})"),
    ]
    if state.get("created"):
        lines.append(f"created {state['created']}"
                     + (f" · finished {state['finished']}" if state.get("finished") else ""))
    for a in agents:
        st = a.get("status") if a.get("status") in ("done", "error") else "pending"
        secs = ""
        if a.get("secs"):
            try:
                secs = f" {_fmt_secs(a['secs'])}"
            except Exception:
                pass
        tail = _preview(a.get("text") or a.get("error"))
        lines.append(f"  {a.get('id', '?')} [{st}]{secs} — {tail}" if tail
                     else f"  {a.get('id', '?')} [{st}]")
    if full_path:
        lines.append(f"state: {full_path}")
    out = "\n".join(lines)
    if len(out) > RETURN_CAP:            # 8 agents x short lines can't hit
        out = out[:RETURN_CAP - 60] + "\n…[truncated]"   # this, but be safe
    return out


def report_text(state: dict, agent: str = "", full_path: str = "") -> str:
    """Full text for the report action: one agent (untrimmed to the return
    cap) or the whole merged report rebuilt from state."""
    agents = [a for a in (state.get("agents") or []) if isinstance(a, dict)]
    sid = state.get("swarm_id") or "?"
    want = (agent or "").strip()
    if want:
        for r in agents:
            if str(r.get("id")) == want:
                text = _section_head(r) + "\n" + _body(r)
                if len(text) > RETURN_CAP:
                    text = _trim(text, RETURN_CAP)
                return text
        ids = ", ".join(str(a.get("id")) for a in agents) or "(none)"
        return (f"swarm: agent {want!r} not in swarm {sid}. "
                f"Agents: {ids}")
    return merge_report(sid, agents, state.get("wall_secs") or 0.0,
                        full_path=full_path)


def list_swarms(state_dir, limit: int = LIST_LIMIT) -> list[dict]:
    """Newest-first swarm rows from the state dir (by file mtime — the
    filesystem's truth, immune to clock skew in the JSON). Corrupt or
    foreign *.json files are skipped, never raised on: the dir is
    model-writable, so one junk file must not break the list action."""
    out: list[dict] = []
    d = Path(state_dir)
    try:
        paths = sorted(d.glob("*.json"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except Exception:
        return out
    for p in paths:
        s = load_state(p)
        if not s.get("swarm_id"):
            continue
        agents = s.get("agents") or []
        out.append({
            "id": s.get("swarm_id"),
            "created": s.get("created") or "",
            "total": s.get("total") or len(agents),
            "ok": s.get("ok"),
            "failed": s.get("failed"),
            "status": s.get("status") or "?",
            "wall_secs": s.get("wall_secs") or 0.0,
            "path": str(p),
        })
        if len(out) >= limit:
            break
    return out


def format_swarm_list(rows: list[dict], state_dir: str) -> str:
    """Text for the list action (id, when, N tasks, counts, status)."""
    if not rows:
        return (f"No swarms yet in {state_dir}. Start one: "
                "swarm(action='run', tasks='[\"task one\", \"task two\"]')")
    lines = [f"{len(rows)} swarm(s) in {state_dir} (newest first):"]
    for r in rows:
        when = str(r.get("created") or "")[:19].replace("T", " ")
        lines.append(f"  {r.get('id')}  {when}  {r.get('total')} task(s)  "
                     f"{r.get('ok')}/{r.get('total')} ok  {r.get('status')}")
    lines.append("Details: swarm(action='status', swarm_id='<id>') "
                 "or action='report'.")
    return "\n".join(lines)


HELP_TEXT = (
    "swarm — parallel sub-agent fan-out on the shared workspace.\n"
    "Actions:\n"
    "  run     tasks=JSON array of strings or {\"task\", \"model\"} objects "
    "(plain multi-line text also works: one task per non-empty line);\n"
    "          max_parallel=12 (env DOOMALAY_SWARM_MAX_PARALLEL, default 64, "
    "0 = unbounded — one worker per task), timeout_per_agent=300 (cap 900), "
    "model=\"\" = default model for agents without their own.\n"
    "          Blocks until every agent finishes; returns a merged report "
    "(per-agent text trimmed, full text in state).\n"
    "  status  swarm_id=sw-xxxxxxxx — compact summary from state.\n"
    "  report  swarm_id=sw-xxxxxxxx [agent=aN] — full text, or one agent.\n"
    "  list    recent swarms in this workspace.\n"
    "  help    this sheet.\n"
    "Notes: agents share this workspace + memory layer; every completion "
    "logs a swarm_agent_done event; results persist under "
    ".doomalay/swarm/<swarm_id>.json — quote that path instead of pasting "
    "huge outputs back into chat. Sub-agents keep the swarm tool too "
    "(nested fan-out up to DOOMALAY_SWARM_DEPTH, default 6)."
)


# ─────────────────────────────────────────────────────────────────────────
# WIRING LAYER — everything below touches ctx.spawn and (by default) the
# ThreadPoolExecutor. Only build(ctx) / handle() reach this from the agent;
# tests inject a serial `runner` to exercise _run_swarm thread-free.
# ─────────────────────────────────────────────────────────────────────────

def _spawn_one(spawn_fn, idx: int, task: str, model: str, timeout: float) -> dict:
    """Call the spawn seam ONCE and normalize whatever comes back.

    The seam contract (agent_core.spawn_subagent) is "returns a dict, never
    raises" — but a broken seam raises anyway (CapacityError, adapter bugs),
    and some adapters return bare text. Both are folded into the canonical
    result shape so the fan-out loop only ever sees well-formed dicts.
    """
    label = f"a{idx + 1}"
    t0 = time.time()
    err = ""
    res = None
    try:
        res = spawn_fn(task, model=model, wait=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 — CapacityError etc.
        err = f"spawn raised: {type(exc).__name__}: {exc}"
    secs = round(time.time() - t0, 1)
    out = {"id": label, "spawn_id": "", "task": task, "model": model or "",
           "status": "error", "text": "", "error": err, "preview": "",
           "secs": secs}
    if isinstance(res, dict):
        out["spawn_id"] = str(res.get("id") or "")
        st = str(res.get("status") or "")
        if st == "done":
            out["status"] = "done"
            out["text"] = str(res.get("text") or "")
        elif st == "error":
            out["error"] = err or str(res.get("error")
                                     or "sub-agent turn ended in error")
        else:
            # running/unknown leaked through the wait=True contract — surface
            # it verbatim instead of guessing (the model can retry that task)
            out["error"] = err or f"unexpected spawn status {st!r}"
    elif res is not None:
        # a seam that returns plain text (not the dict contract) — accept it
        # as the agent's answer rather than discarding real work
        out["status"] = "done"
        out["text"] = str(res)
    out["preview"] = _preview(out["text"] or out["error"])
    return out


def _thread_runner(spawn_fn, calls: list[tuple], max_parallel: int,
                   on_result) -> None:
    """Default fan-out engine: one worker thread per in-flight sub-agent,
    capped at max_parallel (and never more threads than tasks). max_parallel
    <= 0 means UNBOUNDED — one thread per task, the v0.44 spec ("no
    artificial caps"); ThreadPoolExecutor still pools the OS threads behind
    the scenes but every task starts immediately. This is the ONLY function
    in the module that creates threads; as_completed feeds each finished
    agent to on_result so state + logs update live."""
    workers = len(calls) if max_parallel <= 0 else max(1, min(max_parallel, len(calls)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_spawn_one, spawn_fn, *c): c for c in calls}
        for fut in as_completed(futs):
            call = futs[fut]
            try:
                res = fut.result()
            except Exception as exc:  # noqa: BLE001 — belt-and-braces
                res = _spawn_one(None, call[0], call[1], call[2], call[3])
                res["status"] = "error"
                res["error"] = f"worker raised: {type(exc).__name__}: {exc}"
                res["preview"] = _preview(res["error"])
            on_result(call[0], res)


def _safe_log(ctx, event: str, **fields) -> None:
    """ctx.log is documented never-raise, but ctx may be a test double —
    one more belt so a logging hiccup can't kill a fan-out mid-flight."""
    try:
        ctx.log(event, **fields)
    except Exception:
        pass


def _run_swarm(ctx, tasks_arg, max_parallel, timeout_per_agent, model: str,
               runner=None) -> str:
    """The run action's engine: parse -> clamp -> fan out -> merge.

    Never raises: empty input, a missing spawn seam, per-agent spawn errors
    (CapacityError etc.) and even a broken executor all come back as text
    the model can act on. `runner` defaults to the ThreadPoolExecutor engine
    and is injectable so unit tests can fan out serially (no threads) with a
    fake spawn.
    """
    parsed = parse_tasks(tasks_arg)
    if not parsed:
        return ("swarm run: no tasks parsed. Pass tasks as a JSON array of "
                "strings (or {\"task\": …, \"model\": …} objects), or one "
                "task per line. Example: swarm(action='run', "
                "tasks='[\"summarize the README\", \"list all TODOs\"]').")
    spawn_fn = getattr(ctx, "spawn", None)
    if spawn_fn is None:
        # OFFLINE DEGRADE (dt_spec rule 5): no sub-agent backend in this
        # session — tell the model exactly what to do instead: run the tasks
        # itself, sequentially, in order. Never raise, never pretend.
        lines = [f"swarm run: sub-agent spawn seam unavailable in this "
                 f"session — {len(parsed)} task(s) parsed but NOT dispatched.",
                 "Run them yourself sequentially (one at a time, in this "
                 "order), or via the delegate tool per task if available, "
                 "then merge the results:"]
        for i, t in enumerate(parsed[:8]):
            lines.append(f"  {i + 1}. {t['task'][:120]}")
        if len(parsed) > 8:
            lines.append(f"  … (+{len(parsed) - 8} more)")
        return "\n".join(lines)

    # clamp the knobs (the model may pass strings / nonsense / over-cap).
    # v0.44: cap==0 (DOOMALAY_SWARM_MAX_PARALLEL=0) means UNBOUNDED —
    # every task gets its own worker immediately.
    raw_mp = _to_int(max_parallel, DEFAULT_MAX_PARALLEL)
    mp = raw_mp if (MAX_PARALLEL_CAP <= 0 or raw_mp <= 0) else \
        max(1, min(MAX_PARALLEL_CAP, raw_mp))
    to = max(TIMEOUT_FLOOR_SECS,
             min(TIMEOUT_CAP_SECS, _to_int(timeout_per_agent, DEFAULT_TIMEOUT_SECS)))
    swarm_id = new_swarm_id()
    state_dir = Path(ctx.tool_state("swarm"))
    state_path = state_dir / f"{swarm_id}.json"

    started = time.time()
    agents = [{"id": f"a{i + 1}", "spawn_id": "", "task": t["task"],
               "model": t["model"] or (model or ""), "status": "pending",
               "text": "", "error": "", "preview": "", "secs": 0.0}
              for i, t in enumerate(parsed)]
    state = new_swarm_state(swarm_id, agents, mp, to, model or "")
    try:
        # running snapshot FIRST: if the brain dies mid-run, status/list can
        # still show what was in flight (post-mortem, dt_spec rule 3)
        save_state(state_path, state)
    except Exception:
        pass

    results: dict[int, dict] = {}

    def _on_result(idx: int, res: dict) -> None:
        results[idx] = res                      # in-memory: always
        try:                                    # persistence: best-effort
            state["agents"][idx] = res
            state["ok"] = sum(1 for a in state["agents"]
                              if a.get("status") == "done")
            state["failed"] = state["total"] - state["ok"]
            save_state(state_path, state)
        except Exception:
            pass
        _safe_log(ctx, "swarm_agent_done", agent=res.get("id"),
                  ok=(res.get("status") == "done"), preview=res.get("preview", ""),
                  spawn_id=res.get("spawn_id", ""))

    calls = [(i, t["task"], (t["model"] or model or ""), to)
             for i, t in enumerate(parsed)]
    try:
        engine = runner or _thread_runner
        engine(spawn_fn, calls, mp, _on_result)
    except Exception as exc:  # noqa: BLE001 — executor machinery itself died
        # salvage: whatever finished is kept, the rest are marked aborted so
        # the merged report still accounts for every dispatched task
        for i, t in enumerate(parsed):
            if i not in results:
                r = dict(agents[i])
                r["status"] = "error"
                r["error"] = f"swarm aborted: {type(exc).__name__}: {exc}"
                r["preview"] = _preview(r["error"])
                _on_result(i, r)

    wall = time.time() - started
    state["status"] = "done"
    state["wall_secs"] = round(wall, 1)
    state["finished"] = now_iso()
    try:
        save_state(state_path, state)
    except Exception:
        pass
    _safe_log(ctx, "swarm_done", swarm=swarm_id, ok=state.get("ok", 0),
              failed=state.get("failed", 0), wall=state.get("wall_secs", 0.0))
    ordered = [results[i] for i in range(len(parsed))]
    return merge_report(swarm_id, ordered, wall, full_path=str(state_path))


def handle(ctx, action: str, tasks: str = "", swarm_id: str = "",
           agent: str = "", max_parallel=DEFAULT_MAX_PARALLEL,
           timeout_per_agent=DEFAULT_TIMEOUT_SECS, model: str = "") -> str:
    """Action dispatch for the swarm tool — plain callable so tests drive the
    SAME path the strands-decorated tool drives (no SDK needed). Returns
    strings, never raises on bad input; run is the only thread-touching path
    (via _run_swarm's default runner)."""
    action = (action or "").strip().lower()
    if action == "run":
        return _run_swarm(ctx, tasks, max_parallel, timeout_per_agent,
                          (model or "").strip())
    if action in ("status", "report"):
        sid = _safe_id(swarm_id)
        if not sid:
            return ("swarm: pass a swarm_id (e.g. sw-1a2b3c4d — find them "
                    "with swarm(action='list')).")
        state_dir = Path(ctx.tool_state("swarm"))
        # the model sometimes drops the "sw-" prefix; try the minted form
        # first, then the raw id, before declaring the swarm unknown
        cands = [sid] if sid.startswith("sw-") else [f"sw-{sid}", sid]
        path = None
        for c in cands:
            p = state_dir / f"{c}.json"
            if p.exists():
                path = p
                break
        if path is None:
            return (f"swarm: no state for {sid} in this workspace. "
                    "Try swarm(action='list').")
        state = load_state(path)
        if not state:
            return (f"swarm: state file for {sid} is unreadable "
                    f"({path}). Try swarm(action='list').")
        if action == "status":
            return status_summary(state, full_path=str(path))
        return report_text(state, agent=agent, full_path=str(path))
    if action == "list":
        state_dir = Path(ctx.tool_state("swarm"))
        rows = list_swarms(state_dir)
        return format_swarm_list(rows, str(state_dir))
    if action in ("help", ""):
        return HELP_TEXT
    return (f"swarm: unknown action {action!r}. "
            "Use run, status, report, list or help.\n" + HELP_TEXT)


# ─────────────────────────────────────────────────────────────────────────
# strands surface — the registry (dt_registry.load_doomalay_tools) calls
# build(ctx); NO strands import above this line (dt_spec rule 1).
# ─────────────────────────────────────────────────────────────────────────

def build(ctx) -> list:
    """Return the @tool-decorated swarm callable built from ctx.

    Never raises (dt_spec rule 2): no strands -> []; every call inside the
    tool is wrapped so a tool error returns a message, not an exception.
    """
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []                      # offline: register nothing
    try:
        @strands_tool_decorator(name="swarm", description=(
            "Fan out independent sub-tasks to parallel sub-agents that share "
            "this workspace and memory, then get ONE merged report with every "
            "agent's answer. Use it whenever several self-contained prompts "
            "could run at once (research N options, review N files, draft N "
            "variants) instead of running them one by one. Actions: "
            "run(tasks, max_parallel<=8, timeout_per_agent<=240, model), "
            "status(swarm_id), report(swarm_id, agent?), list, help."
        ))
        def swarm(action: str, tasks: str = "", swarm_id: str = "",
                  agent: str = "", max_parallel: int = DEFAULT_MAX_PARALLEL,
                  timeout_per_agent: int = DEFAULT_TIMEOUT_SECS,
                  model: str = "") -> str:
            """Run parallel sub-agent fan-outs (swarms) on this workspace.
            action: run | status | report | list | help
            tasks: (run) JSON array of task strings or {"task", "model"}
                   objects; plain multi-line text works too (one task per
                   non-empty line)
            swarm_id: (status/report) swarm id like sw-1a2b3c4d
            agent: (report, optional) one agent id (a1, a2, …) for its full text
            max_parallel: (run) concurrent agents — default 4, hard cap 8
            timeout_per_agent: (run) seconds per agent — default 120, cap 240
            model: (run) default model for agents that don't set their own
            """
            try:
                return handle(ctx, action, tasks=tasks, swarm_id=swarm_id,
                              agent=agent, max_parallel=max_parallel,
                              timeout_per_agent=timeout_per_agent,
                              model=model)
            except Exception as exc:  # noqa: BLE001 — tools return errors
                return (f"swarm: internal error: {type(exc).__name__}: {exc}. "
                        "Try swarm(action='help').")
        return [swarm]
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────
# Offline self-test (dt_spec rule 7): plain core only — no strands, no
# threads, no ctx, no network. `python3 brain/tools/dt_swarm.py` exits 0.
# brain/tests/test_dt_swarm.py covers the ctx/runner seams in addition.
# ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="dt-swarm-selftest-"))

    # parse_tasks — JSON array of strings
    t1 = parse_tasks('["alpha", "beta"]')
    assert t1 == [{"task": "alpha", "model": ""}, {"task": "beta", "model": ""}], t1
    # object array (per-task model + missing model)
    t2 = parse_tasks('[{"task": "x", "model": "m1"}, {"task": "y"}]')
    assert t2 == [{"task": "x", "model": "m1"}, {"task": "y", "model": ""}], t2
    # plain multi-line string (also the malformed-JSON recovery)
    t3 = parse_tasks("line one\nline two\n\n  line three  ")
    assert [x["task"] for x in t3] == ["line one", "line two", "line three"], t3
    # malformed JSON -> line recovery, never an exception
    t4 = parse_tasks('["oops, "truncated')
    assert len(t4) == 1 and "truncated" in t4[0]["task"], t4
    # bare JSON string / single object
    assert parse_tasks('"just this"') == [{"task": "just this", "model": ""}]
    assert parse_tasks('{"task": "solo", "model": "m"}') == \
        [{"task": "solo", "model": "m"}]
    # empty / junk shapes
    assert parse_tasks("") == [] and parse_tasks("   ") == [] and parse_tasks(None) == []
    assert parse_tasks("[1, 2, null]") == []
    assert parse_tasks("null") == [] and parse_tasks("123") == []
    # oversized task text is capped (state files stay sane)
    big = parse_tasks('["' + "Z" * 5000 + '"]')
    assert len(big[0]["task"]) < MAX_TASK_CHARS + 60 and "truncated" in big[0]["task"]
    # id hygiene
    assert new_swarm_id().startswith("sw-") and len(new_swarm_id()) == 11
    assert _safe_id("sw-ab12cd34") == "sw-ab12cd34"
    assert _safe_id("../../etc/passwd") == "" and _safe_id("") == ""
    assert _safe_id("sw x") == ""

    # save/load round-trip (atomic write, unicode-safe)
    p = tmp / "sw-self0001.json"
    data = {"swarm_id": "sw-self0001", "agents": [{"id": "a1", "text": "ünïcödé ✓"}]}
    save_state(p, data)
    assert load_state(p) == data
    assert load_state(tmp / "missing.json") == {}
    (tmp / "junk.json").write_text("{not json", encoding="utf-8")
    assert load_state(tmp / "junk.json") == {}
    assert load_state(p) and not (tmp / f"sw-self0001.json.{os.getpid()}.tmp").exists()

    # merge_report — mixed done/error, header counts, trimming, note line
    results = [
        {"id": "a1", "task": "ok task", "status": "done", "text": "answer one",
         "error": "", "secs": 1.2, "model": ""},
        {"id": "a2", "task": "boom task", "status": "error", "text": "",
         "error": "spawn failed: CapacityError: no worker capacity",
         "secs": 0.1, "model": ""},
        {"id": "a3", "task": "long task " * 20, "status": "done",
         "text": "Z" * 5000, "error": "", "secs": 9.9, "model": "kimi"},
    ]
    rep = merge_report("sw-self0001", results, 12.34, full_path=str(p))
    assert rep.startswith("Swarm sw-self0001 — 3 tasks: 2 ok, 1 failed, 12.3s wall"), rep[:90]
    assert "## a1 — ok task [done]" in rep
    assert "## a2 — boom task [error]" in rep and "CapacityError" in rep
    assert "answer one" in rep and f"Full results: {p}" in rep
    assert "…[+" in rep and "3500 chars in state file" in rep   # a3 trimmed
    assert len(rep) < RETURN_CAP
    # global squeeze: 8 chatty agents still fit the return budget
    many = [dict(results[0], id=f"a{i}", task=f"t{i}",
                 text="Y" * 4000) for i in range(1, 9)]
    rep8 = merge_report("sw-squeeze01", many, 5.0)
    assert len(rep8) <= RETURN_CAP, len(rep8)

    # status / report / list over a state file
    st = new_swarm_state("sw-self0002", results, 4, 120, "")
    st["status"] = "done"
    st["wall_secs"] = 12.3
    st["finished"] = now_iso()
    p2 = tmp / "sw-self0002.json"
    save_state(p2, st)
    sm = status_summary(st, full_path=str(p2))
    assert sm.startswith("Swarm sw-self0002") and "a1 [done]" in sm and "a2 [error]" in sm
    single = report_text(st, agent="a2")
    assert single.startswith("## a2 — boom task [error]") and "CapacityError" in single
    assert "not in swarm" in report_text(st, agent="a9")
    full = report_text(st)
    assert full.startswith("Swarm sw-self0002") and "answer one" in full
    rows = list_swarms(tmp)
    ids = [r["id"] for r in rows]
    assert "sw-self0001" in ids and "sw-self0002" in ids, ids
    txt = format_swarm_list(rows, str(tmp))
    assert "swarm(s) in" in txt and "sw-self0001" in txt
    assert "No swarms yet" in format_swarm_list([], str(tmp))

    # help mentions every action verb (the model's first call when unsure)
    for verb in ("run", "status", "report", "list", "help"):
        assert verb in HELP_TEXT

    print(f"workspace: {tmp}")
    print("SELF-TEST OK")
