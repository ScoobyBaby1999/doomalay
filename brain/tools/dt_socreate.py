"""dt_socreate.py — the 10x productivity creation loop (goal → plan → execute → critique → iterate).

Reborn from the old doomalaysocreate app ("AI 10x Productivity Loop Forward
Deployed Engineer"): the user states a GOAL, the loop decomposes it into a
PLAN of small steps, EXECUTES them one at a time (each via a surgical
sub-agent when the spawn seam is wired — the parallel fan-out lives in
dt_swarm, this tool stays sequential on purpose), CRITIQUES the accumulated
work against the goal (the old app's judge-panel role, distilled to one
critic sub-agent), and ITERATES until the verdict is done. The old app ran
this as a server pipeline (lib/orchestrator/planner.py + roles.py, the
critique_service judge panel); here it is a chat tool the model drives turn
by turn, with state on disk so a loop survives app restarts.

State layout (ctx.tool_state("socreate") = workspace/.doomalay/socreate/):

    socreate/<id>/socreate.json   session bookkeeping (steps, iterations)
    socreate/<id>/goal.md         THE goal + context + success criteria
    socreate/<id>/plan.md         THE plan (markdown — the real artifact)
    socreate/<id>/critique.md     latest critique (gaps + risk + verdict)
    socreate/<id>/step-<n>.md     sub-agent output for step sN

The markdown files ARE the artifacts: sub-agent briefs point at them, the
model reads and refines them, the critic judges them. socreate.json is just
the bookkeeping that makes status/list cheap and the transitions testable.

Actions: start, plan, execute, mark, critique, iterate, status, list, help.
Plain functions below (start_session, apply_mark, close_iteration,
self_critique_checklist, draft_plan, …) are unit-testable with a temp dir —
no strands, no network, no ctx; build(ctx) wires spawn + the @tool wrapper.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

TOOL_NAMES = ["socreate"]

# ── constants ─────────────────────────────────────────────────────────────
# Why these shapes: the model contract in the wave spec is
# {id, goal, created, iterations:[{n, started, executed, critique, verdict}],
#  status: active|paused|done, files:{goal, plan, critique}} — everything
# below is that contract plus the step registry the transitions need.
_STATE_FILE = "socreate.json"
_SESSION_ID_RE = re.compile(r"^sc-[0-9a-f]{8}$")     # our own ids only —
# an id that fails this never touches the filesystem (path traversal).
_STEP_LINE_RE = re.compile(r"^[-*]\s*\[s(\d+)\]\s*(\S.*)$", re.MULTILINE)
_STEP_STATUSES = ("todo", "doing", "done", "blocked", "skipped")
_MARK_TARGETS = ("done", "blocked", "skipped", "doing")
_VERDICTS = ("improving", "stuck", "done")
_MAX_STEPS = 64          # a plan longer than this is a project, not a step list
_CLIP = 6000             # dt_spec rule 9: keep tool returns ≲ 6k chars
# Closed verb set — validated before session lookup so a typo reports the
# real problem (see the dispatch comment).
_KNOWN_ACTIONS = ("start", "plan", "execute", "mark", "critique",
                  "iterate", "status", "list", "help")

_EMPTY_CRITIQUE = (
    "# Critique\n\n_(no critique yet — run socreate(action='critique', "
    "id='…') once some steps are done)_\n"
)


class SocreateError(ValueError):
    """Contract violation inside the plain core.

    The dispatch layer converts these to plain strings for the model
    (dt_spec: "errors are strings returned, not exceptions") — but plain
    functions raise them so unit tests can pin the exact failure modes.
    """


# ── small shared helpers ──────────────────────────────────────────────────

def _now() -> str:
    """ISO-8601 UTC (dt_spec style) — sortable as a string, so 'latest
    session' never needs date parsing."""
    return datetime.now(timezone.utc).isoformat()


def _clip(text: str, limit: int = _CLIP) -> str:
    """Hard cap a returned payload; say where the rest lives instead of
    silently truncating (the model should know it was clipped)."""
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…(clipped {len(text) - limit} chars — full content is on disk)"


def _atomic_write(path: Path, text: str) -> None:
    """tmp file + os.replace — a kill mid-write can never leave a half
    goal.md/plan.md/socreate.json behind (dt_spec rule 3)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _save_state(path: Path, data: dict) -> None:
    """Atomic JSON state write (see _atomic_write for why)."""
    _atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _load_state(path: Path) -> dict:
    """Load a socreate.json; SocreateError (not a traceback) on corruption
    — a corrupt file must degrade to a clean error string, never a crash."""
    path = Path(path)
    if not path.is_file():
        raise SocreateError(f"missing state file: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise SocreateError(f"corrupt state file {path.name}: {exc}") from exc
    if not isinstance(data, dict):
        raise SocreateError(f"corrupt state file {path.name}: not a JSON object")
    return data


def _read_real_critique(path) -> str:
    """Read critique.md, treating the shipped empty stub as absent.

    Why: start() seeds critique.md with a "(no critique yet)" placeholder
    so the artifact slot always exists. Without this guard the stub would
    (a) mask a spawned critic's reply as 'the canonical file', and
    (b) block the self-critique checklist from ever being seeded. The
    stub is a placeholder, not a critique.
    """
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""
    return "" if "no critique yet" in text else text


def new_session_id(state_root) -> str:
    """`sc-` + 8 hex chars; retries on (astronomically unlikely) collision
    so two sessions never share a directory."""
    root = Path(state_root)
    for _ in range(3):
        sid = "sc-" + uuid.uuid4().hex[:8]
        if not (root / sid).exists():
            return sid
    raise SocreateError("could not allocate a session id")


def _fresh_step(n: int, text: str, now: str) -> dict:
    """One step-registry entry. `output`/`preview` stay None/'' until a
    sub-agent (or the model via mark) produces an artifact — the critic
    checklist later flags 'done' steps with no output as paper-done."""
    return {"id": f"s{n}", "text": text, "status": "todo", "note": "",
            "output": None, "preview": "", "at": now, "at_end": None}


# ── plan rendering / parsing (the markdown IS the artifact) ───────────────

# The five-section decomposition is the old app's skeleton distilled:
# know (research) → decide (design) → build (implement, in vertical slices)
# → prove (verify) → finish (polish). Each step is a placeholder with
# guidance, because the FIRST draft is heuristic — the model is expected to
# call action='plan' with its own refined steps before executing anything.
_DRAFT_SECTIONS: list[tuple[str, str, list[str]]] = [
    ("Research", "know before you build", [
        "Map the territory: find what already exists for this goal — read it before inventing anything new.",
        "Extract constraints and non-goals: list the 3 facts that most constrain the design.",
    ]),
    ("Design", "decide before you code", [
        "Draft the approach on one page: architecture, key choices, and what you deliberately will NOT do.",
        "Turn goal.md's success criteria into the cheapest test that proves each one.",
    ]),
    ("Implement", "build in vertical slices", [
        "Build the thinnest end-to-end slice that touches every layer once — walking skeleton first.",
        "Harden the slice: error paths, edge cases, and the failure mode you fear most.",
        "Build the remaining slices one at a time; keep every step shippable on its own.",
    ]),
    ("Verify", "prove it works", [
        "Test as a hostile user: try to break the result on purpose; log every break you find.",
        "Check each success criterion with evidence; mark pass/fail and name the proof.",
    ]),
    ("Polish", "finish strong", [
        "Trim and document the 20% users touch 80% of the time; delete the rest.",
        "Re-read goal.md against what exists — anything missing becomes a step in a refined plan.",
        "Package the result: write a summary + handoff note in the session dir.",
    ]),
]


def draft_plan(goal: str) -> str:
    """Heuristic FIRST-DRAFT plan.md: research → design → implement →
    verify → polish, 12 placeholder steps with refinement guidance.

    Plain and deterministic (no LLM) so `start` works offline and the
    model always has something concrete to push against — the old app's
    planner called an LLM here; in the chat tool the MODEL is the planner,
    this draft is just the scaffold it refines via action='plan'.
    """
    title = (goal or "").strip() or "(unnamed goal)"
    lines = [
        f"# Plan — {title[:100]}",
        "",
        "> HEURISTIC DRAFT (goal → plan → execute → critique → iterate).",
        "> Refine me before executing:",
        "> socreate(action=\"plan\", id=\"…\", steps_json='[\"step 1\", \"step 2\", …]')",
        "> — replace the placeholders with steps you actually intend to run.",
        "",
    ]
    n = 0
    for i, (name, tagline, steps) in enumerate(_DRAFT_SECTIONS, start=1):
        lines.append(f"## {i} · {name} — {tagline}")
        for text in steps:
            n += 1
            lines.append(f"- [s{n}] (placeholder) {text}")
        lines.append("")
    return "\n".join(lines)


def parse_plan_steps(md: str) -> list[str]:
    """Extract step texts from '- [sN] text' lines (both draft + refined
    plan.md render the same shape — one parser, round-trip safe)."""
    return [m.group(2).strip()
            for m in _STEP_LINE_RE.finditer(md or "")]


def render_plan(goal: str, steps: list[str]) -> str:
    """plan.md for a model-refined step list (flat: the model's order IS
    the plan; sections were only scaffolding for the draft)."""
    lines = [
        f"# Plan — {(goal or '').strip()[:100]}",
        "",
        "Steps are `- [sN]`; live statuses live in socreate.json "
        "(socreate(action='status')).",
        "",
        "## Steps",
    ]
    for i, text in enumerate(steps, start=1):
        lines.append(f"- [s{i}] {text}")
    lines.append("")
    return "\n".join(lines)


def render_goal_md(session: dict) -> str:
    """goal.md — goal, context, and the success-criteria template the
    critic later judges against (borrowed from the old app's 'defined
    success criteria' review rubric)."""
    context = (session.get("context") or "").strip() or "_(none provided)_"
    return (
        f"# Goal\n\n{session['goal']}\n\n## Context\n\n{context}\n\n"
        "## Success criteria\n"
        "<!-- the critic judges progress against THIS list — fill it in,\n"
        "     make each criterion binary (true/false, no 'mostly') -->\n\n"
        "- [ ] (criterion 1 — what must be TRUE when this is done)\n"
        "- [ ] (criterion 2)\n"
        "- [ ] (criterion 3)\n\n"
        f"---\nsocreate session {session['id']} · started {session['created']}\n"
    )


# ── session lookup ────────────────────────────────────────────────────────

def find_session(state_root, session_id: str) -> tuple[dict, Path]:
    """Locate + load one session. Raises SocreateError (unknown / corrupt /
    invalid id) — never touches the filesystem with a non-conforming id."""
    sid = str(session_id or "").strip().lower()
    if not _SESSION_ID_RE.match(sid):
        raise SocreateError(
            f"invalid session id: {session_id!r} — ids look like sc-1a2b3c4d; "
            "socreate(action='list') shows every session")
    sdir = Path(state_root) / sid
    if not sdir.is_dir():
        raise SocreateError(
            f"unknown session: {sid} — socreate(action='list') shows every session")
    session = _load_state(sdir / _STATE_FILE)
    if "id" not in session or "goal" not in session:
        raise SocreateError(f"corrupt state for session {sid}: not a socreate session")
    session.setdefault("steps", [])
    session.setdefault("iterations", [])
    session.setdefault("status", "active")
    return session, sdir


def latest_session(state_root):
    """Newest session overall, preferring active ones — the target when
    the model calls status without an id. Corrupt dirs are skipped (they
    must not break 'status', only that session's own actions)."""
    root = Path(state_root)
    if not root.is_dir():
        return None
    best = None
    for d in root.iterdir():
        sp = d / _STATE_FILE
        if not (d.is_dir() and sp.is_file()):
            continue
        try:
            session = _load_state(sp)
        except SocreateError:
            continue
        if "id" not in session:
            continue
        # (active, created, id): active sorts above done/paused, then newest
        key = (session.get("status") == "active",
               str(session.get("created", "")), str(session.get("id", "")))
        if best is None or key > best[0]:
            best = (key, session, d)
    return None if best is None else (best[1], best[2])


# ── step resolution ───────────────────────────────────────────────────────

def resolve_step(session: dict, ref: str) -> dict:
    """'s3' | '3' | 'next' | unique text-prefix → the step dict.

    'next' = first todo step (the loop's natural pointer). Prefix match
    lets the model say step='gather' instead of remembering the id; it
    must be UNIQUE or we refuse rather than guess.
    """
    ref = str(ref or "").strip()
    steps = session.get("steps", [])
    if not steps:
        raise SocreateError("this session has no steps — refine the plan first "
                            "(action='plan', steps_json='[\"…\"]')")
    low = ref.lower()
    if low in ("", "next"):
        for s in steps:
            if s["status"] == "todo":
                return s
        raise SocreateError(
            "no todo steps left — critique (action='critique') then iterate, "
            "or rewrite the plan (action='plan', steps_json=…)")
    # exact id: 's3'
    for s in steps:
        if s["id"].lower() == low:
            return s
    # bare number: '3' → s3
    if low.isdigit():
        want = f"s{int(low)}"
        for s in steps:
            if s["id"] == want:
                return s
    # unique text prefix (case-insensitive)
    hits = [s for s in steps if s["text"].lower().startswith(low)] if len(low) >= 3 else []
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        ids = ", ".join(s["id"] for s in hits)
        raise SocreateError(f"ambiguous step: {ref!r} matches {ids}")
    raise SocreateError(
        f"unknown step: {ref!r} — valid ids: s1..s{len(steps)} "
        f"(or 'next' for the first todo step)")


# ── the plain state transitions (unit-testable, no ctx) ───────────────────

def start_session(state_root, goal: str, context: str = "") -> tuple[dict, str]:
    """Open a session: id dir + goal.md + plan.md draft + critique.md
    stub + socreate.json, all atomic. Returns (session, cheat-sheet)."""
    goal = (goal or "").strip()
    if not goal:
        raise SocreateError("start needs a goal — socreate(action='start', "
                            "goal='what to create', context='optional background')")
    root = Path(state_root)
    root.mkdir(parents=True, exist_ok=True)
    sid = new_session_id(root)
    sdir = root / sid
    sdir.mkdir(parents=True, exist_ok=True)
    now = _now()
    draft_md = draft_plan(goal)
    session = {
        "id": sid, "goal": goal, "context": (context or "").strip(),
        "created": now, "status": "active",
        # 'paused' is part of the model contract but no action sets it yet —
        # reserved so future actions (and old state files) read cleanly.
        "steps": [_fresh_step(i + 1, t, now)
                  for i, t in enumerate(parse_plan_steps(draft_md))],
        "iterations": [{"n": 1, "started": now, "closed": None,
                        "executed": [], "critique": "",
                        "critique_verdict": "", "verdict": "", "note": ""}],
        "files": {"goal": str(sdir / "goal.md"),
                  "plan": str(sdir / "plan.md"),
                  "critique": str(sdir / "critique.md")},
    }
    _atomic_write(sdir / "goal.md", render_goal_md(session))
    _atomic_write(sdir / "plan.md", draft_md)
    _atomic_write(sdir / "critique.md", _EMPTY_CRITIQUE)
    _save_state(sdir / _STATE_FILE, session)
    return session, start_message(session, sdir)


def start_message(session: dict, sdir) -> str:
    """The loop cheat-sheet handed back on start — the model's operating
    manual for the session (10x loop + the 6 verbs + refine-first nudge)."""
    sid = session["id"]
    n_steps = len(session.get("steps", []))
    return (
        f"SESSION {sid} — active, iteration 1\n"
        f"goal: {session['goal'][:200]}\n"
        f"session dir (the real artifacts live here): {sdir}\n"
        f"  goal.md · plan.md · critique.md · step-<n>.md\n\n"
        f"THE 10x LOOP — plan → execute → critique → iterate (until verdict=done)\n"
        f"  1. plan     refine the {n_steps}-step heuristic draft:\n"
        f"              socreate(action=\"plan\", id=\"{sid}\", steps_json='[\"step\", …]')\n"
        f"  2. execute  run ONE step (sub-agent when available):\n"
        f"              socreate(action=\"execute\", id=\"{sid}\", step=\"next\")\n"
        f"  3. mark     self-execution bookkeeping:\n"
        f"              socreate(action=\"mark\", id=\"{sid}\", step=\"s2\", status=\"done\", note=\"…\")\n"
        f"  4. critique gaps + risk + verdict:\n"
        f"              socreate(action=\"critique\", id=\"{sid}\", focus=\"…\")\n"
        f"  5. iterate  close the round (improving|stuck|done):\n"
        f"              socreate(action=\"iterate\", id=\"{sid}\", verdict=\"improving\")\n"
        f"  6. status   the board: socreate(action=\"status\", id=\"{sid}\")\n\n"
        f"plan.md is a HEURISTIC DRAFT — refine it (1) before executing. "
        f"Fill goal.md's success-criteria template: the critic judges "
        f"progress against it.")


def apply_plan(session: dict, sdir, steps: list[str]) -> tuple[dict, str]:
    """Rewrite plan.md + the step registry from a refined step list.

    Statuses reset to todo on purpose: a rewritten plan is a new plan, and
    silently keeping 'done' against changed step text would lie to the
    critic. Iteration history (what WAS executed) survives in iterations.
    """
    if not steps:
        raise SocreateError("steps_json produced no steps — need a non-empty array")
    if len(steps) > _MAX_STEPS:
        raise SocreateError(f"too many steps: {len(steps)} (max {_MAX_STEPS}) — "
                            "split the goal into sessions")
    now = _now()
    session["steps"] = [_fresh_step(i + 1, t, now) for i, t in enumerate(steps)]
    _atomic_write(Path(sdir) / "plan.md", render_plan(session["goal"], steps))
    msg = (f"plan rewritten: {len(steps)} steps (statuses reset to todo — "
           f"history kept in iterations). path: {Path(sdir) / 'plan.md'}\n"
           f"next: socreate(action='execute', step='next') — or critique first.")
    return session, msg


def parse_steps_json(raw: str) -> list[str]:
    """Model-proof steps_json: accepts a JSON array of strings, a list of
    {text|step|title} objects, {'steps': [...]}, and tolerates ```json
    fences. SocreateError (not a traceback) on garbage."""
    text = str(raw or "").strip()
    if text.startswith("```"):          # models love fences; harmless to strip
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SocreateError(
            f"invalid steps_json: {exc} — expected a JSON array like "
            "[\"step 1\", \"step 2\"]") from exc
    if isinstance(data, dict):
        data = data.get("steps")
    if not isinstance(data, list):
        raise SocreateError("invalid steps_json: expected a JSON array of steps")
    steps: list[str] = []
    for item in data:
        if isinstance(item, str):
            s = item.strip()
        elif isinstance(item, dict):
            s = str(item.get("text") or item.get("step")
                    or item.get("title") or "").strip()
        else:
            s = str(item).strip()
        if s:
            steps.append(s)
    if not steps:
        raise SocreateError("steps_json produced no steps — need a non-empty array")
    return steps


def start_step(session: dict, ref: str) -> dict:
    """Mark a step in-progress (todo→doing) with the sequential guard:
    only ONE step may be in flight at a time. Parallel fan-out is
    dt_swarm's job — a creation loop stays sequential so every step sees
    the previous step's output on disk. Re-targeting the step that is
    already 'doing' is allowed (retry), starting a different one is not."""
    step = resolve_step(session, ref)
    others = [s["id"] for s in session.get("steps", [])
              if s["status"] == "doing" and s["id"] != step["id"]]
    if others:
        raise SocreateError(
            f"one step at a time — {', '.join(others)} is already in-progress; "
            f"finish it (action='mark', status='done|blocked|skipped') or "
            f"re-run execute on THAT step")
    step["status"] = "doing"
    step["at"] = _now()
    return step


def apply_mark(session: dict, ref: str, status: str, note: str = "") -> tuple[dict, str]:
    """Manual step bookkeeping: todo|doing|blocked|skipped →
    done|blocked|skipped|doing. 'done' is final (rework = refine the plan
    with new step text); blocked/skipped steps can be revived with doing."""
    status = str(status or "").strip().lower()
    if status not in _MARK_TARGETS:
        raise SocreateError(
            f"invalid mark status: {status!r} (use done|blocked|skipped|doing)")
    step = resolve_step(session, ref)
    cur = step["status"]
    if cur == "done":
        raise SocreateError(
            f"step {step['id']} is done — final; refine the plan "
            f"(action='plan', steps_json=…) if it needs rework")
    if note:
        step["note"] = str(note)
    if cur == status:
        return session, (f"step {step['id']} already {status} — note updated. "
                         + _counts_line(session))
    step["status"] = status
    step["at"] = _now()
    if status == "done":
        step["at_end"] = _now()
        _remember_executed(session, step["id"])
    msg = f"step {step['id']} {cur} → {status}"
    if note:
        msg += f" (note: {str(note)[:150]})"
    return session, msg + "\n" + _counts_line(session)


def record_execution(session: dict, sdir, step: dict, reply_text: str) -> dict:
    """A sub-agent finished the step: capture its artifact (write the reply
    into step-<n>.md if the sub-agent only reported instead of writing),
    mark done, record output path + preview, remember it in the current
    iteration's executed list."""
    n = int(str(step["id"])[1:])
    out = Path(sdir) / f"step-{n}.md"
    if not out.exists() and (reply_text or "").strip():
        # salvage path: brief said "write AND report" — if it only reported,
        # the reply still becomes the artifact so critique has something.
        _atomic_write(out, str(reply_text).rstrip() + "\n")
    if out.exists():
        try:
            step["preview"] = out.read_text(encoding="utf-8")[:200]
        except OSError:
            step["preview"] = ""
        step["output"] = str(out)
    step["status"] = "done"
    step["at"] = _now()
    step["at_end"] = _now()
    _remember_executed(session, step["id"])
    return session


def _remember_executed(session: dict, step_id: str) -> None:
    """Append to the CURRENT iteration's executed list (once) — the
    per-iteration counter that reset on iterate()."""
    if session.get("iterations"):
        executed = session["iterations"][-1].setdefault("executed", [])
        if step_id not in executed:
            executed.append(step_id)


def close_iteration(session: dict, verdict: str = "", note: str = "") -> tuple[dict, str]:
    """Close the open iteration: log verdict + note; bump n and reset the
    per-iteration counters (executed/critique) — unless verdict=done,
    which closes the whole session."""
    verdict = str(verdict or "").strip().lower()
    if not verdict:
        verdict = "improving"
    if verdict not in _VERDICTS:
        raise SocreateError(
            f"invalid verdict: {verdict!r} (use improving|stuck|done)")
    if session.get("status") == "done":
        raise SocreateError("session is already done — start a new one "
                            "(action='start', goal='…')")
    if not session.get("iterations"):
        session["iterations"] = [{"n": 0, "started": _now(), "closed": None,
                                  "executed": [], "critique": "",
                                  "critique_verdict": "", "verdict": "",
                                  "note": ""}]
    it = session["iterations"][-1]
    it["verdict"] = verdict
    it["closed"] = _now()
    if note:
        it["note"] = str(note)
    sid = session["id"]
    if verdict == "done":
        session["status"] = "done"
        n_iters = len(session["iterations"])
        n_steps = len(session.get("steps", []))
        n_done = sum(1 for s in session["steps"] if s["status"] == "done")
        return session, (
            f"session {sid} marked DONE after {n_iters} iteration(s) — "
            f"{n_done}/{n_steps} steps done, verdict logged.\n"
            f"final artifacts: goal.md · plan.md · critique.md in {session['files']['plan'].rsplit('/', 1)[0]}\n"
            f"next goal? socreate(action='start', goal='…')")
    nxt = it["n"] + 1
    session["iterations"].append({"n": nxt, "started": _now(), "closed": None,
                                  "executed": [], "critique": "",
                                  "critique_verdict": "", "verdict": "",
                                  "note": ""})
    return session, (
        f"iteration {it['n']} closed (verdict: {verdict}"
        + (f", note: {str(note)[:150]}" if note else "") + ")\n"
        f"iteration {nxt} open — executed/critique counters reset. "
        f"continue the loop: execute (step='next'), or critique first "
        f"if the plan needs surgery.")


def self_critique_checklist(session: dict, sdir=None) -> str:
    """Offline critic: the coverage/consistency/evidence/risk questions
    WITH the session's current facts filled in (counts, ids, artifacts on
    disk), so the model answers a concrete interrogation instead of
    staring at a generic template. This is the old app's judge panel
    degraded to one string — no panel, no LLM call, just the rubric."""
    steps = session.get("steps", [])
    counts = _step_counts(session)
    goal = str(session.get("goal", ""))
    its = session.get("iterations", [])
    it_n = its[-1]["n"] if its else 0
    by = _ids_by_status(session)
    done_no_output = [s["id"] for s in steps
                      if s["status"] == "done" and not s.get("output")]
    artifacts = ""
    if sdir is not None:
        try:
            artifacts = str(len(list(Path(sdir).glob("step-*.md"))))
        except OSError:
            artifacts = "?"
    state_line = (f"state: {counts['total']} steps — done {counts['done']} · "
                  f"in-progress {counts['doing']} · blocked {counts['blocked']} · "
                  f"skipped {counts['skipped']} · todo {counts['todo']}"
                  + (f" · step artifacts on disk: {artifacts}" if artifacts else ""))
    return (
        f"SELF-CRITIQUE CHECKLIST — session {session.get('id')}, iteration {it_n} "
        f"(no critic sub-agent available — YOU answer these now)\n"
        f"{state_line}\n"
        f"goal: {goal[:200]}\n\n"
        "COVERAGE — goal vs plan\n"
        f"1. Which part of the goal has NO step addressing it? "
        f"(todo steps: {by['todo'] or 'none'})\n"
        "2. goal.md success criteria: name any criterion that no step verifies.\n\n"
        "CONSISTENCY — plan vs outputs\n"
        "3. Does each step output actually match its step text, or did scope "
        "drift? Cite the worst drift.\n"
        f"4. Blocked/skipped steps silently assumed done downstream? "
        f"(blocked: {by['blocked'] or 'none'} / skipped: {by['skipped'] or 'none'})\n\n"
        "EVIDENCE — prove it\n"
        f"5. 'done' steps with no recorded artifact: "
        f"{done_no_output or 'none'} — are they really done?\n"
        "6. What would a hostile user test first to break the result?\n\n"
        "RISK — the trajectory\n"
        "7. The single biggest risk if this loop iterates once more unchanged.\n"
        "8. Verdict for iterate(): improving | stuck | done — pick one, "
        "justify in one line.\n\n"
        "Answer these in your reply (or write answers into critique.md), "
        "then socreate(action='iterate', id='…', verdict='…', note='…').")


# ── boards / listings ─────────────────────────────────────────────────────

def _step_counts(session: dict) -> dict:
    steps = session.get("steps", [])
    return {"total": len(steps),
            **{s: sum(1 for x in steps if x["status"] == s)
               for s in _STEP_STATUSES}}


def _ids_by_status(session: dict) -> dict:
    out = {s: [] for s in _STEP_STATUSES}
    for st in session.get("steps", []):
        out.setdefault(st["status"], []).append(st["id"])
    return out


def _counts_line(session: dict) -> str:
    c = _step_counts(session)
    by = _ids_by_status(session)
    return (f"steps: {c['total']} total — done {c['done']} · "
            f"in-progress {c['doing']}{_ids(by['doing'])} · "
            f"blocked {c['blocked']}{_ids(by['blocked'])} · "
            f"skipped {c['skipped']} · todo {c['todo']}")


def _ids(ids: list) -> str:
    return f" ({', '.join(ids)})" if ids else ""


def suggested_action(session: dict) -> str:
    """The board's 'what now' line — a small state machine so the model
    always has ONE obvious next move (the 10x loop never stalls on
    'what should I do next')."""
    sid = session.get("id", "…")
    if session.get("status") == "done":
        return ("session is DONE — start the next goal: "
                "socreate(action='start', goal='…')")
    by = _ids_by_status(session)
    if by["doing"]:
        return (f"finish in-progress {', '.join(by['doing'])} — execute it "
                f"(re-run or self-execute) then socreate(action='mark', "
                f"id='{sid}', step='{by['doing'][0]}', status='done')")
    if by["blocked"]:
        return (f"unblock or skip {', '.join(by['blocked'])}: "
                f"socreate(action='mark', id='{sid}', step='{by['blocked'][0]}', "
                f"status='done|skipped', note='…')")
    if by["todo"]:
        return (f"socreate(action='execute', id='{sid}', step='next') — "
                f"one step at a time")
    return (f"all steps terminal — socreate(action='critique', id='{sid}') "
            f"then iterate(verdict='improving|stuck|done'); verdict=done "
            f"closes the session")


def status_board(session: dict, sdir) -> str:
    """The active-session board: goal, iteration, step counts, last
    critique verdict, next step + the ONE suggested action."""
    sid = session.get("id", "?")
    c = _step_counts(session)
    by = _ids_by_status(session)
    its = session.get("iterations", [])
    lines = [
        f"session {sid} — {str(session.get('goal', ''))[:160]}",
        f"status: {session.get('status', '?')} · created {session.get('created', '?')}",
        _counts_line(session),
    ]
    if its:
        lines.append("iterations:")
        for it in its[-3:]:                      # last 3 — boards stay scannable
            closed = "closed" if it.get("closed") else "open"
            lines.append(
                f"  {it['n']}: executed {len(it.get('executed', []))} steps · "
                f"{closed} · verdict {it.get('verdict') or '—'}"
                + (f" · critique: {str(it.get('critique', ''))[:80]}" if it.get("critique") else ""))
        last = its[-1]
        cv = last.get("critique_verdict") or (its[-2].get("verdict")
                                              if len(its) > 1 and its[-2].get("verdict") else "")
        if cv:
            lines.append(f"last critique verdict: {cv}")
    todo = [s for s in session.get("steps", []) if s["status"] == "todo"]
    if todo:
        lines.append(f"next step: {todo[0]['id']} — {todo[0]['text'][:100]}")
    elif session.get("status") != "done":
        lines.append("no todo steps — critique + iterate, or refine the plan")
    lines.append(f"SUGGESTED ACTION: {suggested_action(session)}")
    f = session.get("files", {})
    lines.append("files: " + " · ".join(
        f"{k}={v}" for k, v in f.items()) if f else
        f"files: goal.md/plan.md/critique.md in {sdir}")
    return "\n".join(lines)


def list_sessions(state_root) -> str:
    """Every session (newest first); corrupt entries are listed as CORRUPT
    — one bad file must never hide the healthy ones."""
    root = Path(state_root)
    if not root.is_dir():
        return ("no socreate sessions yet — start one: "
                "socreate(action='start', goal='…')")
    rows: list[tuple[str, str]] = []
    for d in root.iterdir():
        sp = d / _STATE_FILE
        if not (d.is_dir() and sp.is_file()):
            continue
        try:
            s = _load_state(sp)
        except SocreateError as exc:
            rows.append((str(d.name), f"CORRUPT ({exc})"))
            continue
        if "id" not in s:
            rows.append((str(d.name), "CORRUPT (not a socreate session)"))
            continue
        steps = s.get("steps", [])
        done = sum(1 for x in steps if x.get("status") == "done")
        rows.append((
            f"{s.get('created', '')}|{s.get('id', d.name)}",
            f"{s.get('id')}  {str(s.get('status', '?')):<7}  "
            f"iter {len(s.get('iterations', []))}  steps {done}/{len(steps)}  "
            f"{str(s.get('goal', ''))[:60]}"))
    if not rows:
        return ("no socreate sessions yet — start one: "
                "socreate(action='start', goal='…')")
    rows.sort(key=lambda r: r[0], reverse=True)
    body = "\n".join(r[1] for r in rows)
    return f"socreate sessions ({len(rows)}) — newest first:\n{body}"


# ── sub-agent briefs (the surgical spawn contracts) ───────────────────────

def subagent_execute_brief(session: dict, sdir, step: dict) -> str:
    """Brief for ONE step's sub-agent. Surgical on purpose: goal.md +
    plan.md for orientation, THE step text, a hard output contract
    (step-<n>.md + a short report), and the workspace-CWD rule — the
    sub-agent shares the parent's filesystem, so it may touch project
    files anywhere but must keep session outputs inside the state dir.
    (Sequential spawns: dt_swarm owns the parallel fan-out.)"""
    n = int(str(step["id"])[1:])
    return (
        f"EXECUTE ONE STEP of a 10x productivity loop "
        f"(goal → plan → execute → critique → iterate).\n"
        f"Your CWD is the SHARED WORKSPACE — you may read/modify project "
        f"files anywhere in it, but keep your SESSION OUTPUTS inside "
        f"{Path(sdir)} (the socreate state dir).\n\n"
        f"READ FIRST (orientation, ~2 min max):\n"
        f"- {Path(sdir) / 'goal.md'} — the goal, context, success criteria\n"
        f"- {Path(sdir) / 'plan.md'} — the full plan (you run ONE step only)\n\n"
        f"YOUR STEP {step['id']}: {step['text']}\n"
        f"(Do NOT start other steps — one surgical step per sub-agent.)\n\n"
        f"OUTPUT CONTRACT:\n"
        f"1. Write your complete output (findings, code, decisions) to "
        f"{Path(sdir) / f'step-{n}.md'} (markdown).\n"
        f"2. Reply with a ≤15-line report: what you produced, where it "
        f"lives, anything blocking.\n")


def subagent_critique_brief(session: dict, sdir, focus: str = "") -> str:
    """Brief for the critic sub-agent — the old app's judge-panel rubric
    (concrete gaps, one risk, binary verdict) distilled into one agent.
    It reads the markdown artifacts AND the real workspace files, then
    writes critique.md; the verdict word feeds the loop's iterate step."""
    it_n = session["iterations"][-1]["n"] if session.get("iterations") else 1
    focus_line = f"FOCUS ESPECIALLY ON: {focus}\n\n" if focus else ""
    return (
        f"You are the CRITIC in a 10x productivity loop "
        f"(session {session['id']}, iteration {it_n}).\n"
        f"Your CWD is the SHARED WORKSPACE — keep your outputs inside "
        f"{Path(sdir)} (the socreate state dir).\n"
        f"Judge the work against the GOAL, not against effort spent.\n\n"
        f"READ:\n"
        f"- {Path(sdir) / 'goal.md'} — goal + success criteria (the bar)\n"
        f"- {Path(sdir) / 'plan.md'} — the current plan\n"
        f"- every {Path(sdir)}/step-*.md that exists — what was produced\n"
        f"- the real project files in the workspace the steps claim to touch\n\n"
        f"{focus_line}"
        f"WRITE your critique to {Path(sdir) / 'critique.md'} with exactly "
        f"three sections:\n"
        f"## Gaps — the 3 most CONCRETE gaps (each: one issue + one fix, "
        f"name the step it concerns)\n"
        f"## Risk — the single biggest risk of the current trajectory\n"
        f"## Verdict — exactly one word: improving | stuck | done\n\n"
        f"Reply with the same three sections as your final answer.\n")


def extract_verdict(text: str) -> str:
    """Pull improving|stuck|done out of a critique. Look near an explicit
    'verdict' marker first (that's the contract), fall back to the last
    standalone occurrence — tail-first because verdicts land at the end."""
    for chunk in (str(text)[-600:], str(text)):
        m = re.search(r"verdict[^\w]{0,40}\b(improving|stuck|done)\b",
                      chunk, re.IGNORECASE)
        if m:
            return m.group(1).lower()
    m = re.search(r"\b(improving|stuck|done)\b", str(text), re.IGNORECASE)
    return m.group(1).lower() if m else ""


# ── help ──────────────────────────────────────────────────────────────────

def help_text() -> str:
    """The model's first call when unsure (dt_spec rule 10)."""
    return (
        "socreate — the 10x productivity creation loop "
        "(goal → plan → execute → critique → iterate)\n"
        "state: workspace/.doomalay/socreate/<id>/{goal.md, plan.md, "
        "critique.md, step-<n>.md} — markdown files are the real artifacts.\n\n"
        "actions (all take id except start/list/help):\n"
        "  start   goal, context?            open a session (draft plan auto-generated)\n"
        "  plan    steps_json?               rewrite plan.md from your steps; no arg = show it\n"
        "  execute step='next'|'sN', model?  run ONE step (sub-agent if wired; else you do it)\n"
        "  mark    step, status, note?       self-execution bookkeeping: done|blocked|skipped|doing\n"
        "  critique focus?                   critic sub-agent (gaps+risk+verdict) or self-checklist\n"
        "  iterate verdict?, note?           close the round; verdict=done closes the session\n"
        "  status  id?                       the board (counts, verdict, next action)\n"
        "  list                            every session\n"
        "  help                            this sheet\n\n"
        "the loop: refine plan → execute steps ONE at a time → critique "
        "against goal.md's success criteria → iterate(verdict) → repeat "
        "until verdict=done. verdict improving = keep going, stuck = "
        "replan, done = close.")


# ── the dispatch core (what the @tool wrapper calls) ──────────────────────

def socreate_action(state_root, action: str, *,
                    session_id: str = "", goal: str = "", context: str = "",
                    steps_json: str = "", step: str = "", status: str = "",
                    note: str = "", focus: str = "", verdict: str = "",
                    model: str = "", spawn=None, **_ignored) -> str:
    """Route one action over state_root (a plain dir — ctx-free and
    unit-testable). NEVER raises: SocreateError and every unexpected
    failure come back as strings (dt_spec: degrade, don't crash)."""
    try:
        root = Path(state_root)
        act = str(action or "").strip().lower()

        # ── start ──────────────────────────────────────────────────────
        if act == "start":
            session, msg = start_session(root, str(goal or ""),
                                         str(context or ""))
            return msg

        if act == "help" or act == "":
            return help_text()

        if act == "list":
            return list_sessions(root)

        # Verb check BEFORE session lookup — a typo'd action should say
        # "unknown action", not "invalid session id" (the model fixes the
        # verb, not the id).
        if act not in _KNOWN_ACTIONS:
            return (f"unknown action: {act!r} — socreate(action='help') "
                    f"for the cheat-sheet")

        # status is the ONE action that may omit the id: it targets the
        # latest active session (the loop's natural 'where am I' call).
        if act == "status" and not str(session_id or "").strip():
            pick = latest_session(root)
            if pick is None:
                return ("no socreate sessions yet — start one: "
                        "socreate(action='start', goal='…')")
            session, sdir = pick
            return status_board(session, sdir)

        # ── everything else needs a session ────────────────────────────
        session, sdir = find_session(root, str(session_id or ""))

        if act == "plan":
            raw = str(steps_json or "").strip()
            if raw:
                session, msg = apply_plan(session, sdir, parse_steps_json(raw))
                _save_state(sdir / _STATE_FILE, session)
                return msg
            # no steps_json → show the current plan (regenerate from the
            # registry if the file was hand-deleted — the artifact and the
            # bookkeeping must never disagree silently)
            ppath = sdir / "plan.md"
            if ppath.is_file():
                md = ppath.read_text(encoding="utf-8")
            else:
                md = render_plan(session["goal"],
                                 [s["text"] for s in session["steps"]])
                _atomic_write(ppath, md)
            return _clip(f"{md}\n(path: {ppath})")

        if act == "execute":
            if session.get("status") == "done":
                return (f"session {session['id']} is DONE — start a new one "
                        f"(action='start', goal='…')")
            ref = str(step or "").strip() or "next"
            st = start_step(session, ref)      # raises on collision → string
            _save_state(sdir / _STATE_FILE, session)
            if spawn is None:
                # Offline degrade: the step is now in-progress; the MODEL
                # is the executor. Point it at the artifacts + the mark
                # verb so bookkeeping stays honest.
                return (f"STEP {st['id']} IN-PROGRESS (self-execution — no "
                        f"sub-agent seam available):\n  {st['text']}\n\n"
                        f"Context: {sdir / 'goal.md'} + {sdir / 'plan.md'}.\n"
                        f"Do the step yourself now, then record it:\n"
                        f"  socreate(action='mark', id='{session['id']}', "
                        f"step='{st['id']}', status='done', "
                        f"note='what you produced + where')\n"
                        f"blocked / not needed? status='blocked'|'skipped' "
                        f"with a note.")
            brief = subagent_execute_brief(session, sdir, st)
            try:
                res = spawn(brief, model=str(model or "").strip(), wait=True)
            except Exception as exc:  # noqa: BLE001 — spawn seam must not crash the tool
                st["note"] = f"spawn failed: {exc}"[:200]
                _save_state(sdir / _STATE_FILE, session)
                return (f"spawn failed on {st['id']}: {exc} — the step stays "
                        f"in-progress; finish it yourself then "
                        f"socreate(action='mark', step='{st['id']}', "
                        f"status='done')")
            if isinstance(res, dict) and res.get("status") == "done":
                text = str(res.get("text", "") or "")
                n = int(str(st["id"])[1:])
                out = sdir / f"step-{n}.md"
                if text.strip() or out.exists():
                    record_execution(session, sdir, st, text)
                    _save_state(sdir / _STATE_FILE, session)
                    return (f"STEP {st['id']} DONE (sub-agent) — output: {out}\n"
                            f"preview: {st.get('preview', '')}\n"
                            f"next: socreate(action='execute', step='next') "
                            f"— or critique when all steps are terminal.")
            # sub-agent errored / produced nothing → blocked, not silent
            err = (res.get("error", "no output") if isinstance(res, dict)
                   else f"unexpected spawn result: {res!r}"[:200])
            st["status"] = "blocked"
            st["note"] = f"sub-agent failed: {err}"[:200]
            _save_state(sdir / _STATE_FILE, session)
            return (f"sub-agent failed on {st['id']}: {err} — step marked "
                    f"blocked. retry socreate(action='execute', "
                    f"step='{st['id']}') or mark it skipped/done yourself.")

        if act == "mark":
            session, msg = apply_mark(session, str(step or ""),
                                      str(status or ""), str(note or ""))
            _save_state(sdir / _STATE_FILE, session)
            return msg

        if act == "critique":
            if session.get("status") == "done":
                return (f"session {session['id']} is DONE — the critic only "
                        f"judges active loops; start a new session instead.")
            focus_s = str(focus or "").strip()
            fallback_note = ""
            if spawn is not None:
                brief = subagent_critique_brief(session, sdir, focus_s)
                try:
                    res = spawn(brief, model="", wait=True)
                except Exception as exc:  # noqa: BLE001
                    res = {"status": "error", "error": str(exc)}
                if isinstance(res, dict) and res.get("status") == "done":
                    body = str(res.get("text", "") or "")
                    cpath = sdir / "critique.md"
                    # the FILE is the canonical artifact: if the sub-agent
                    # wrote critique.md, prefer it over the reply text
                    # (the reply is just a report; the file is what the
                    # next loop turn reads). The shipped empty stub does
                    # NOT count as a critique (see _read_real_critique).
                    disk = _read_real_critique(cpath)
                    if disk and (not body.strip() or len(disk) > len(body)):
                        body = disk
                    if not disk and body.strip():
                        _atomic_write(cpath, body)
                    if not body.strip():
                        body = ("(critic sub-agent returned no text — run "
                                "critique again or self-critique)")
                    v = extract_verdict(body)
                    it = (session["iterations"] or [{}])[-1]
                    it["critique"] = body[:300]
                    it["critique_verdict"] = v
                    _save_state(sdir / _STATE_FILE, session)
                    return _clip(
                        f"CRITIQUE (iteration {it.get('n', '?')}) — verdict: "
                        f"{v or 'unknown'}\n\n{body}\n(path: {cpath})\n"
                        f"next: socreate(action='iterate', verdict="
                        f"'{v or 'improving|stuck|done'}')")
                fallback_note = (
                    "critic sub-agent unavailable ("
                    + str(res.get("error", "no result") if isinstance(res, dict)
                          else "no result")[:160] + ") — ")
            # offline (or failed-spawn) degrade: the self-critique checklist
            checklist = self_critique_checklist(session, sdir)
            cpath = sdir / "critique.md"
            if not _read_real_critique(cpath):
                # seed the stub/absent file only — never clobber a real
                # critique with a question template
                _atomic_write(cpath, checklist)
            it = (session["iterations"] or [{}])[-1]
            it["critique"] = ("(self-checklist issued — answer it in your "
                              "reply or critique.md)")[:300]
            _save_state(sdir / _STATE_FILE, session)
            return _clip(
                f"{fallback_note}SELF-CRITIQUE MODE\n\n{checklist}\n"
                f"(checklist written to {cpath} — answers go in your reply "
                f"or straight into that file)")

        if act == "iterate":
            session, msg = close_iteration(session, str(verdict or ""),
                                           str(note or ""))
            _save_state(sdir / _STATE_FILE, session)
            return msg

        if act == "status":
            return status_board(session, sdir)

        return (f"unknown action: {act!r} — socreate(action='help') for "
                f"the cheat-sheet")

    except SocreateError as exc:
        # contract violations are strings for the model, not exceptions
        return str(exc)
    except Exception as exc:  # noqa: BLE001 — dt_spec rule 5: degrade, don't crash
        return f"socreate error ({type(exc).__name__}): {exc}"


# ── strands surface ───────────────────────────────────────────────────────

def build(ctx) -> list:
    """Return the @tool-decorated socreate callable (or [] offline).

    Never raises (dt_spec rule 2): strands missing → []; ctx broken → [];
    the wrapper itself try/excepts so a tool failure is a string, never a
    dead turn.
    """
    try:
        from strands import tool as strands_tool_decorator  # noqa: import INSIDE build (rule 1)
    except Exception:
        return []                     # offline / no SDK — register nothing

    try:
        state_root = Path(ctx.tool_state("socreate"))
        spawn = getattr(ctx, "spawn", None)
        log = getattr(ctx, "log", None)

        @strands_tool_decorator(name="socreate", description=(
            "Run a 10x productivity creation loop on a goal: plan → "
            "execute (one surgical sub-agent per step) → critique → "
            "iterate until the verdict is done. Use whenever the user "
            "wants to BUILD or CREATE a multi-step deliverable (document, "
            "feature, research, artifact) instead of a one-shot answer. "
            "State persists in workspace/.doomalay/socreate/<id>/ "
            "(goal.md, plan.md, critique.md, step-<n>.md). "
            "Actions: start, plan, execute, mark, critique, iterate, "
            "status, list, help."))
        def socreate(action: str, id: str = "", goal: str = "",
                     context: str = "", steps_json: str = "",
                     step: str = "", status: str = "", note: str = "",
                     focus: str = "", verdict: str = "",
                     model: str = "") -> str:
            """Drive the socreate 10x productivity loop.

            action: start|plan|execute|mark|critique|iterate|status|list|help
            id: session id (sc-xxxxxxxx; required for all but start/list/help)
            goal: the creation goal (action=start)
            context: optional background, goes into goal.md (action=start)
            steps_json: JSON array of step strings — rewrites plan.md (action=plan)
            step: 'next', a step id like 's3', a number, or a step-text prefix (execute/mark)
            status: done|blocked|skipped|doing (action=mark)
            note: outcome note (actions=mark/iterate)
            focus: what the critique should focus on (action=critique)
            verdict: improving|stuck|done (action=iterate)
            model: optional model override for the execute sub-agent
            """
            try:                       # oplog line so the user sees loop
                if log is not None:    # progress live (best-effort only)
                    log("socreate_call", action=str(action)[:40],
                        step=str(step)[:60], goal=str(goal)[:120])
            except Exception:
                pass
            try:
                return socreate_action(
                    state_root, action, session_id=id, goal=goal,
                    context=context, steps_json=steps_json, step=step,
                    status=status, note=note, focus=focus, verdict=verdict,
                    model=model, spawn=spawn)
            except Exception as exc:  # noqa: BLE001 — belt + braces
                return f"socreate error ({type(exc).__name__}): {exc}"

        return [socreate]
    except Exception:
        return []                      # broken ctx → register nothing, never raise


# ── offline self-test (dt_spec rule 7) ────────────────────────────────────

if __name__ == "__main__":
    import sys
    import tempfile

    _fails: list[str] = []

    def _check(name: str, cond: bool) -> None:
        print(("  ok  " if cond else " FAIL ") + name)
        if not cond:
            _fails.append(name)

    tmp = Path(tempfile.mkdtemp(prefix="dt-socreate-"))

    # 1. draft_plan: 5 sections, ≥10 steps, parseable
    md = draft_plan("launch a newsletter")
    for sec in ("Research", "Design", "Implement", "Verify", "Polish"):
        _check(f"draft section {sec}", sec in md)
    draft_steps = parse_plan_steps(md)
    _check("draft has >=10 step placeholders", len(draft_steps) >= 10)
    _check("draft step texts non-empty", all(draft_steps))

    # 2. start_session: files + state shape + cheat-sheet
    session, msg = start_session(tmp, "write a tone guide", "internal docs")
    sdir = tmp / session["id"]
    _check("start made socreate.json", (sdir / "socreate.json").is_file())
    _check("start made goal.md", (sdir / "goal.md").is_file())
    _check("start made plan.md", (sdir / "plan.md").is_file())
    _check("start made critique.md", (sdir / "critique.md").is_file())
    _check("cheat-sheet mentions the loop",
           "plan → execute → critique → iterate" in msg)
    _check("session active, iteration 1",
           session["status"] == "active" and session["iterations"][0]["n"] == 1)
    _check("registry matches draft", len(session["steps"]) == len(draft_steps))
    _check("goal.md carries criteria template",
           "Success criteria" in (sdir / "goal.md").read_text())

    # 3. dispatch: plan round-trip + mark transitions + iterate + status
    m = socreate_action(tmp, "start", goal="g1")
    sid = session["id"]
    m = socreate_action(tmp, "plan", session_id=sid,
                        steps_json='["a", "b", "c"]')
    _check("plan rewrite", "3 steps" in m
           and "- [s1] a" in (sdir / "plan.md").read_text())
    m = socreate_action(tmp, "plan", session_id=sid)
    _check("plan read-back", "gather" not in m and "a" in m)
    m = socreate_action(tmp, "plan", session_id=sid, steps_json='["unclosed')
    _check("bad steps_json is a string error", "invalid steps_json" in m)

    m = socreate_action(tmp, "execute", session_id=sid, step="next")
    _check("offline execute = self-execution",
           "IN-PROGRESS" in m and "self-execution" in m)
    m = socreate_action(tmp, "mark", session_id=sid, step="s1",
                        status="done", note="did it")
    _check("mark done", "s1" in m and "done" in m)
    m = socreate_action(tmp, "mark", session_id=sid, step="s999",
                        status="done")
    _check("unknown step error string", "unknown step" in m)
    m = socreate_action(tmp, "critique", session_id=sid)
    for word in ("COVERAGE", "CONSISTENCY", "EVIDENCE", "RISK"):
        _check(f"checklist has {word}", word in m)
    m = socreate_action(tmp, "iterate", session_id=sid)
    _check("iterate bumps n", "iteration 2" in m)
    session = _load_state(sdir / "socreate.json")
    _check("iteration closed improving",
           session["iterations"][0]["verdict"] == "improving")
    m = socreate_action(tmp, "iterate", session_id=sid, verdict="done")
    session = _load_state(sdir / "socreate.json")
    _check("verdict=done closes session",
           session["status"] == "done" and len(session["iterations"]) == 2)
    m = socreate_action(tmp, "status", session_id=sid)
    _check("board renders on done session", "DONE" in m and "SUGGESTED" in m)

    # 4. corruption + lookups + offline build
    (sdir / "socreate.json").write_text("{oops", encoding="utf-8")
    m = socreate_action(tmp, "status", session_id=sid)
    _check("corrupt state = clean error", "corrupt" in m.lower()
           and "Traceback" not in m)
    m = socreate_action(tmp, "list")
    _check("list survives corruption", "CORRUPT" in m)
    _check("unknown session is a string",
           "unknown session" in socreate_action(
               tmp, "status", session_id="sc-00000000"))
    _check("unknown action is a string",
           "unknown action" in socreate_action(tmp, "bogus"))
    _check("build(ctx) never raises offline", build(None) == [])

    if _fails:
        print(f"\nSELF-TEST FAILED ({len(_fails)}): {_fails}")
        sys.exit(1)
    print("\nSELF-TEST OK")
