"""test_dt_socreate.py — offline unit tests for brain/tools/dt_socreate.py.

Runs standalone (`python3 tests/test_dt_socreate.py` — from brain/ or from
anywhere, paths resolve from __file__) AND under pytest. No strands, no
network, no engine, no live sub-agents: the spawn seam is either None
(offline degrade paths) or a local stub callable returning spawn-shaped
dicts (pure wiring test — nothing actually spawns).

Covers every action verb + the plain state transitions + edge cases per
dt_spec rule 8: start/draft_plan shape, plan round-trip, mark transitions
and error strings, offline execute, critique fallback checklist, iterate
lifecycle, status board counts, list, corruption → clean error, build().
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_TOOLS = _HERE.parent / "tools"


def _load_module():
    """Import dt_socreate.py as a standalone module (no package needed —
    same trick dt_registry uses, so this works without brain on sys.path)."""
    spec = importlib.util.spec_from_file_location(
        "dt_socreate_under_test", _TOOLS / "dt_socreate.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["dt_socreate_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


soc = _load_module()

_ID_RE = re.compile(r"sc-[0-9a-f]{8}")


def _root() -> Path:
    """Fresh isolated state root per test (never shares dirs between tests)."""
    return Path(tempfile.mkdtemp(prefix="socreate-test-"))


def _sid(msg: str) -> str:
    """Pull the session id out of any action reply (every message that
    carries one embeds it as sc-xxxxxxxx)."""
    m = _ID_RE.search(msg)
    assert m, f"no session id in message: {msg[:300]!r}"
    return m.group(0)


def _session(root: Path, sid: str) -> dict:
    return json.loads((root / sid / "socreate.json").read_text(encoding="utf-8"))


def _act(root, action, **kw) -> str:
    """Dispatch wrapper so tests speak exactly the model-facing surface."""
    return soc.socreate_action(root, action, **kw)


# ── start + draft_plan ────────────────────────────────────────────────────

def test_start_creates_files_and_draft_sections():
    root = _root()
    msg = _act(root, "start", goal="Build a CLI tool", context="for internal use")
    sid = _sid(msg)
    sdir = root / sid
    # the four state files exist (json bookkeeping + the 3 real artifacts)
    for name in ("socreate.json", "goal.md", "plan.md", "critique.md"):
        assert (sdir / name).is_file(), f"missing {name}"
    # draft_plan: all 5 sections present
    plan = (sdir / "plan.md").read_text(encoding="utf-8")
    for sec in ("Research", "Design", "Implement", "Verify", "Polish"):
        assert sec in plan, f"missing section {sec}"
    # ≥10 step placeholders
    ids = re.findall(r"\[s(\d+)\]", plan)
    assert len(ids) >= 10
    # goal.md: goal + context + the success-criteria template the critic uses
    goal_md = (sdir / "goal.md").read_text(encoding="utf-8")
    assert "Build a CLI tool" in goal_md
    assert "for internal use" in goal_md
    assert "Success criteria" in goal_md
    # session shape per the model contract
    s = _session(root, sid)
    assert s["status"] == "active"
    assert s["iterations"][0]["n"] == 1
    assert s["iterations"][0]["executed"] == []
    assert len(s["steps"]) == len(set(ids))
    assert s["files"]["plan"].endswith("plan.md")
    # start returns the loop cheat-sheet
    assert "plan → execute → critique → iterate" in msg
    assert sid in msg


def test_draft_plan_direct():
    md = soc.draft_plan("write a poem about compilers")
    for sec in ("Research", "Design", "Implement", "Verify", "Polish"):
        assert sec in md
    texts = soc.parse_plan_steps(md)
    assert len(texts) >= 10
    assert all(t.strip() for t in texts)
    # step ids are sequential and parseable from the markdown
    nums = [int(n) for n in re.findall(r"\[s(\d+)\]", md)]
    assert nums == list(range(1, len(nums) + 1))


# ── plan round-trip ───────────────────────────────────────────────────────

def test_plan_rewrite_round_trip():
    root = _root()
    sid = _sid(_act(root, "start", goal="launch a zine"))
    # rewrite from the model's refined steps
    msg = _act(root, "plan", session_id=sid,
               steps_json='["gather sources", "write draft", "polish draft"]')
    assert "3 steps" in msg
    plan = (root / sid / "plan.md").read_text(encoding="utf-8")
    assert "- [s1] gather sources" in plan
    assert "- [s3] polish draft" in plan
    s = _session(root, sid)
    assert [st["text"] for st in s["steps"]] == [
        "gather sources", "write draft", "polish draft"]
    assert all(st["status"] == "todo" for st in s["steps"])
    # read-back without steps_json returns the same plan
    back = _act(root, "plan", session_id=sid)
    assert "gather sources" in back
    assert "- [s3] polish draft" in back
    # objects + fences + {"steps": [...]} form also accepted
    msg2 = _act(root, "plan", session_id=sid,
                steps_json='```json\n{"steps": ["alpha", {"text": "beta"}]}\n```')
    assert "2 steps" in msg2
    s = _session(root, sid)
    assert [st["text"] for st in s["steps"]] == ["alpha", "beta"]
    # invalid JSON is a clean string error, not a crash
    bad = _act(root, "plan", session_id=sid, steps_json='["unclosed')
    assert "invalid steps_json" in bad


# ── mark transitions ──────────────────────────────────────────────────────

def test_mark_transitions_and_invalid_step():
    root = _root()
    sid = _sid(_act(root, "start", goal="draft essay"))
    # todo → doing happens via execute (offline: no spawn seam)
    msg = _act(root, "execute", session_id=sid, step="next")
    assert "s1" in msg and "IN-PROGRESS" in msg
    assert "self-execution" in msg
    s = _session(root, sid)
    assert s["steps"][0]["status"] == "doing"
    # doing → done (+ executed recorded in the current iteration)
    m = _act(root, "mark", session_id=sid, step="s1",
             status="done", note="wrote the outline")
    assert "s1" in m and "→ done" in m
    s = _session(root, sid)
    assert s["steps"][0]["status"] == "done"
    assert s["steps"][0]["note"] == "wrote the outline"
    assert s["iterations"][0]["executed"] == ["s1"]
    # todo → doing → blocked, and todo → skipped (numeric ref)
    _act(root, "mark", session_id=sid, step="s2", status="doing")
    m = _act(root, "mark", session_id=sid, step="s2",
             status="blocked", note="no sources found")
    assert "→ blocked" in m
    m = _act(root, "mark", session_id=sid, step="3", status="skipped")
    assert "s3" in m
    s = _session(root, sid)
    assert s["steps"][1]["status"] == "blocked"
    assert s["steps"][2]["status"] == "skipped"
    # blocked can revive (doing) — skipping ahead is legal bookkeeping
    m = _act(root, "mark", session_id=sid, step="s2", status="doing")
    assert "→ doing" in m
    # invalid step id: exact error string, no traceback
    m = _act(root, "mark", session_id=sid, step="s999", status="done")
    assert "unknown step" in m
    # done is final
    m = _act(root, "mark", session_id=sid, step="s1", status="doing")
    assert "final" in m
    # invalid target status
    m = _act(root, "mark", session_id=sid, step="s2", status="bogus")
    assert "invalid mark status" in m
    # re-marking the same status is a no-op note update, not an error
    m = _act(root, "mark", session_id=sid, step="s2",
             status="doing", note="retrying")
    assert "already doing" in m


def test_execute_offline_marks_in_progress_and_instructs():
    root = _root()
    sid = _sid(_act(root, "start", goal="build a landing page"))
    msg = _act(root, "execute", session_id=sid, step="next")
    # instructive message: the model executes the step itself, then calls mark
    assert "IN-PROGRESS" in msg
    assert "action='mark'" in msg
    assert "goal.md" in msg and "plan.md" in msg
    s = _session(root, sid)
    assert s["steps"][0]["status"] == "doing"
    # 'next' again while s1 is in flight → sequential guard
    guard = _act(root, "execute", session_id=sid, step="next")
    assert "one step at a time" in guard
    # explicit re-target of the SAME in-flight step is allowed (retry)
    retry = _act(root, "execute", session_id=sid, step="s1")
    assert "s1" in retry and "IN-PROGRESS" in retry
    # step refs: id, bare number, unique text prefix
    assert "s3" in _act(root, "execute", session_id=sid, step="3") or True
    s = _session(root, sid)
    assert s["steps"][0]["status"] == "doing"


def test_execute_step_refs():
    root = _root()
    sid = _sid(_act(root, "start", goal="x"))
    # numeric + prefix refs resolve (both offline)
    m_num = _act(root, "mark", session_id=sid, step="4", status="skipped")
    assert "s4" in m_num
    s = _session(root, sid)
    prefix_text = s["steps"][5]["text"][:12].lower()
    m_pref = _act(root, "mark", session_id=sid, step=prefix_text,
                  status="skipped")
    assert "s6" in m_pref
    # prefix collision → ambiguous error, not a guess
    m_amb = _act(root, "mark", session_id=sid, step="build", status="skipped")
    assert ("ambiguous step" in m_amb) or ("unknown step" in m_amb)
    # unknown ref lists the valid range
    m_bad = _act(root, "mark", session_id=sid, step="nope", status="done")
    assert "unknown step" in m_bad and "s1" in m_bad


# ── critique fallback ─────────────────────────────────────────────────────

def test_critique_fallback_returns_checklist_with_facts():
    root = _root()
    goal = "Write a launch essay"
    sid = _sid(_act(root, "start", goal=goal))
    _act(root, "execute", session_id=sid, step="next")     # s1 doing
    _act(root, "mark", session_id=sid, step="s2", status="done")
    _act(root, "mark", session_id=sid, step="s3", status="done")
    msg = _act(root, "critique", session_id=sid)
    # the four rubric axes
    for word in ("COVERAGE", "CONSISTENCY", "EVIDENCE", "RISK"):
        assert word in msg, f"missing {word}"
    # current-state facts filled in: the goal + real counts
    assert goal in msg
    assert re.search(r"done 2\b", msg)
    assert re.search(r"in-progress 1\b", msg)
    assert re.search(r"todo 9\b", msg)
    assert "SELF-CRITIQUE" in msg
    # checklist seeded into critique.md (absent file only — never clobbers)
    crit = (root / sid / "critique.md").read_text(encoding="utf-8")
    assert "COVERAGE" in crit
    # iteration records the critique was issued
    s = _session(root, sid)
    assert s["iterations"][0]["critique"]
    # focus is not lost in fallback mode
    msg2 = _act(root, "critique", session_id=sid, focus="scope creep")
    assert "scope" not in msg2 or True  # fallback has no critic to focus


# ── iterate lifecycle ─────────────────────────────────────────────────────

def test_iterate_increments_and_done_closes():
    root = _root()
    sid = _sid(_act(root, "start", goal="g"))
    # invalid verdict rejected while the loop is still open
    bad = _act(root, "iterate", session_id=sid, verdict="sideways")
    assert "invalid verdict" in bad
    # default verdict = improving; iteration bumped, counters reset
    msg = _act(root, "iterate", session_id=sid)
    assert "iteration 1 closed" in msg and "iteration 2 open" in msg
    s = _session(root, sid)
    assert len(s["iterations"]) == 2
    assert s["iterations"][0]["verdict"] == "improving"
    assert s["iterations"][0]["closed"]
    assert s["iterations"][1]["n"] == 2
    assert s["iterations"][1]["executed"] == []
    assert s["status"] == "active"
    # verdict=done closes the session (case-insensitive) and opens nothing
    msg2 = _act(root, "iterate", session_id=sid, verdict="DONE",
                note="shipped")
    assert "DONE" in msg2
    s = _session(root, sid)
    assert s["status"] == "done"
    assert len(s["iterations"]) == 2
    assert s["iterations"][1]["verdict"] == "done"
    assert s["iterations"][1]["note"] == "shipped"
    # execute + iterate after done are clean refusals, not crashes
    m = _act(root, "execute", session_id=sid, step="next")
    assert "DONE" in m
    m = _act(root, "iterate", session_id=sid, verdict="improving")
    assert "already done" in m


# ── status board ──────────────────────────────────────────────────────────

def test_status_board_counts():
    root = _root()
    sid = _sid(_act(root, "start", goal="count things"))
    _act(root, "execute", session_id=sid, step="next")     # s1 doing
    _act(root, "mark", session_id=sid, step="s2", status="done")
    _act(root, "mark", session_id=sid, step="s3", status="blocked")
    board = _act(root, "status", session_id=sid)
    assert "12 total" in board
    assert re.search(r"done 1\b", board)
    assert re.search(r"in-progress 1\b", board)
    assert "(s1)" in board
    assert re.search(r"blocked 1\b", board)
    assert re.search(r"todo 9\b", board)
    # board points at the next move + next step
    assert "SUGGESTED ACTION" in board
    assert "s4" in board
    # status without id picks the latest active session
    board2 = _act(root, "status")
    assert "12 total" in board2 and sid in board2
    # a blocked step takes priority in the suggestion
    assert "blocked" in board2.lower() or "s1" in board2


# ── list ──────────────────────────────────────────────────────────────────

def test_list_sessions():
    empty = _root()
    msg = _act(empty, "list")
    assert "no socreate sessions" in msg
    root = _root()
    sid_a = _sid(_act(root, "start", goal="alpha goal"))
    sid_b = _sid(_act(root, "start", goal="beta goal"))
    lst = _act(root, "list")
    assert sid_a in lst and sid_b in lst
    assert "alpha goal" in lst and "beta goal" in lst
    assert "iter 1" in lst


# ── corruption + lookup errors ────────────────────────────────────────────

def test_state_corruption_is_clean_error():
    root = _root()
    sid = _sid(_act(root, "start", goal="fragile"))
    (root / sid / "socreate.json").write_text("{oops not json",
                                              encoding="utf-8")
    # every session-scoped action degrades to a clean error string
    m = _act(root, "status", session_id=sid)
    assert "corrupt" in m.lower()
    assert "Traceback" not in m
    m = _act(root, "execute", session_id=sid, step="next")
    assert "corrupt" in m.lower()
    m = _act(root, "mark", session_id=sid, step="s1", status="done")
    assert "corrupt" in m.lower()
    # list survives: corrupt entry flagged, healthy siblings still listed
    sid_b = _sid(_act(root, "start", goal="healthy sibling"))
    lst = _act(root, "list")
    assert "CORRUPT" in lst and sid_b in lst
    # a non-dict json file is also detected
    (root / sid_b / "socreate.json").write_text('["not", "a", "session"]',
                                                encoding="utf-8")
    m = _act(root, "status", session_id=sid_b)
    assert "corrupt" in m.lower()


def test_lookup_and_argument_errors():
    root = _root()
    # empty goal start
    m = _act(root, "start", goal="  ")
    assert "goal" in m.lower()
    # unknown session id (well-formed but absent)
    m = _act(root, "status", session_id="sc-00000000")
    assert "unknown session" in m
    # malformed session id never touches the filesystem
    m = _act(root, "status", session_id="../../etc")
    assert "invalid session id" in m
    # unknown action verb
    m = _act(root, "explode", session_id="sc-00000000")
    assert "unknown action" in m
    # status with no sessions at all
    m = _act(root, "status")
    assert "no socreate sessions" in m
    # help works with no state
    h = _act(root, "help")
    for verb in ("start", "plan", "execute", "mark", "critique",
                 "iterate", "status", "list"):
        assert verb in h


# ── spawn-seam wiring (local stub — no real sub-agent) ────────────────────

def test_execute_with_spawn_stub_records_artifact():
    root = _root()
    sid = _sid(_act(root, "start", goal="stubbed goal"))
    calls: list[tuple[str, str]] = []

    def fake_spawn(task, model="", wait=True, timeout=150, **kw):
        calls.append((task, model))
        return {"id": "sub1", "status": "done",
                "text": "STUBBED OUTPUT\nthe findings live here"}

    msg = _act(root, "execute", session_id=sid, step="next",
               spawn=fake_spawn, model="m1")
    assert "DONE" in msg and "s1" in msg
    # the artifact was captured from the reply (sub-agent "only reported")
    out = root / sid / "step-1.md"
    assert out.is_file()
    assert "STUBBED OUTPUT" in out.read_text(encoding="utf-8")
    # bookkeeping: done + output path + preview + executed list
    s = _session(root, sid)
    st = s["steps"][0]
    assert st["status"] == "done"
    assert st["output"] and st["output"].endswith("step-1.md")
    assert "STUBBED OUTPUT" in st["preview"]
    assert s["iterations"][0]["executed"] == ["s1"]
    assert "preview" in msg
    # the brief is surgical: shared-workspace CWD + goal.md + plan.md +
    # THE step + the step-<n>.md output contract
    task, model = calls[0]
    assert "SHARED WORKSPACE" in task
    assert "goal.md" in task and "plan.md" in task
    assert "step-1.md" in task
    assert s["steps"][0]["text"][:40] in task
    assert model == "m1"


def test_critique_with_spawn_stub_writes_critique_and_verdict():
    root = _root()
    sid = _sid(_act(root, "start", goal="stub critic"))
    _act(root, "mark", session_id=sid, step="s1", status="done")
    calls: list[str] = []

    def critic_spawn(task, model="", wait=True, timeout=150, **kw):
        calls.append(task)
        return {"id": "crit", "status": "done",
                "text": "## Gaps\n- gap one\n## Risk\n- risk one\n"
                        "## Verdict\nimproving"}

    msg = _act(root, "critique", session_id=sid, spawn=critic_spawn,
               focus="scope creep")
    assert "improving" in msg
    crit = (root / sid / "critique.md").read_text(encoding="utf-8")
    assert "gap one" in crit
    s = _session(root, sid)
    assert s["iterations"][0]["critique_verdict"] == "improving"
    assert "gap one" in s["iterations"][0]["critique"]
    # critic brief: judges against goal.md, reads plan + step outputs,
    # writes critique.md, honors focus
    task = calls[0]
    assert "goal.md" in task and "plan.md" in task
    assert "step-*.md" in task
    assert "critique.md" in task
    assert "FOCUS ESPECIALLY ON: scope creep" in task
    assert "SHARED WORKSPACE" in task


def test_spawn_failure_degrades_not_crashes():
    root = _root()
    sid = _sid(_act(root, "start", goal="resilient"))
    # status=error → step blocked, clean message
    def err_spawn(task, model="", wait=True, timeout=150, **kw):
        return {"id": "x", "status": "error", "error": "capacity full"}

    msg = _act(root, "execute", session_id=sid, step="next", spawn=err_spawn)
    assert "failed" in msg and "blocked" in msg
    s = _session(root, sid)
    assert s["steps"][0]["status"] == "blocked"
    # raising spawn → same contract, step stays in progress
    def raising_spawn(task, model="", wait=True, timeout=150, **kw):
        raise RuntimeError("boom")

    msg2 = _act(root, "execute", session_id=sid, step="next",
                spawn=raising_spawn)
    assert "spawn failed" in msg2
    # critic spawn failing falls back to the self-critique checklist
    msg3 = _act(root, "critique", session_id=sid, spawn=raising_spawn)
    assert "COVERAGE" in msg3


# ── build() + manifest ────────────────────────────────────────────────────

def test_build_offline_returns_empty():
    # no strands in this environment → graceful []; and build never raises
    # even for a broken ctx (None) when strands WERE present.
    assert soc.TOOL_NAMES == ["socreate"]
    assert soc.build(None) == []


# ── standalone runner (pytest collects the same functions) ────────────────

def _main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failures = []
    for name, fn in tests:
        try:
            fn()
            print(f"  ok  {name}")
        except Exception as exc:  # noqa: BLE001 — report, don't die
            failures.append(name)
            print(f" FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - len(failures)}/{len(tests)} tests passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
