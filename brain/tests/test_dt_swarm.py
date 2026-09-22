"""test_dt_swarm.py — offline unit tests for brain/tools/dt_swarm.py.

dt_spec rules: NO strands, NO threads, NO network. The plain core
(parse_tasks / merge_report / load_state / save_state / status_summary /
report_text / list_swarms / format_swarm_list) is exercised directly; the
run action is covered through handle() with a fake ctx whose spawn is None
(offline degrade) and through _run_swarm with a FAKE spawn + a SERIAL
runner — the runner seam is injectable exactly so tests can fan out
thread-free while production uses the ThreadPoolExecutor.

Fake ctx: dt_registry.ToolContext over a tempdir workspace, spawn=None
(the same shape agent_core builds offline). Events are captured by
pointing ctx.emit at a list.

Runs standalone:  cd brain && python3 tests/test_dt_swarm.py   (exit 0)
Runs under pytest: pytest brain/tests/test_dt_swarm.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# module under test lives in brain/tools; dt_registry in brain/ — resolve
# from THIS file so the suite works from any CWD (pytest rootdir included)
BRAIN = Path(__file__).resolve().parents[1]
for _p in (str(BRAIN), str(BRAIN / "tools")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import dt_registry  # noqa: E402  (ToolContext — the real one, per spec)
import dt_swarm     # noqa: E402  (module under test)

try:
    import strands  # noqa: F401
    HAS_STRANDS = True
except Exception:
    HAS_STRANDS = False

# knob constants mirrored from the module (asserted below so a spec change
# in dt_swarm.py can't silently drift past these tests)
MAX_PAR = dt_swarm.MAX_PARALLEL_CAP
TIME_CAP = dt_swarm.TIMEOUT_CAP_SECS


# ── helpers ──────────────────────────────────────────────────────────────

def _make_ctx(events=None):
    """Fresh ToolContext over a temp workspace, spawn=None (offline).

    Returns (ctx, tmpdir_obj); the caller OWNS the TemporaryDirectory and
    must d.cleanup() it — plain try/finally keeps the tests pytest-free
    (no fixtures) so the standalone runner can execute them verbatim.
    """
    d = tempfile.TemporaryDirectory(prefix="dt-swarm-test-")
    ctx = dt_registry.ToolContext(workspace=Path(d.name), spawn=None)
    if events is not None:
        ctx.emit = lambda **kw: events.append(dict(kw))
    return ctx, d


def _fake_spawn(outbox):
    """A spawn seam with the agent_core contract: dict out, never raise —
    except the one task that simulates a raising seam (CapacityError)."""
    def spawn(task, model="", wait=True, timeout=150, **kw):
        outbox.append({"task": task, "model": model,
                       "wait": wait, "timeout": timeout})
        if "boom" in task:
            raise RuntimeError("CapacityError: no worker capacity")
        if "quiet" in task:
            return {"id": "ff00aa01", "status": "done", "text": ""}
        return {"id": "ff00aa02", "status": "done",
                "text": f"did: {task}"}
    return spawn


def _serial_runner(spawn_fn, calls, max_parallel, on_result):
    """Thread-free stand-in for dt_swarm._thread_runner: identical
    (spawn_fn, calls, max_parallel, on_result) contract, sequential
    execution. Lives HERE (not in the module) so production code never
    carries test-only paths."""
    for c in calls:
        on_result(c[0], dt_swarm._spawn_one(spawn_fn, *c))


def _finished_state(sid, agents, **over):
    st = dt_swarm.new_swarm_state(sid, agents, 4, 120, "")
    st["status"] = "done"
    st["ok"] = sum(1 for a in agents if a.get("status") == "done")
    st["failed"] = len(agents) - st["ok"]
    st["wall_secs"] = 1.5
    st["finished"] = dt_swarm.now_iso()
    st.update(over)
    return st


# ── parse_tasks ──────────────────────────────────────────────────────────

def test_parse_tasks_json_array():
    out = dt_swarm.parse_tasks('["alpha", "beta", "gamma"]')
    assert out == [{"task": "alpha", "model": ""},
                   {"task": "beta", "model": ""},
                   {"task": "gamma", "model": ""}]


def test_parse_tasks_object_array():
    out = dt_swarm.parse_tasks('[{"task": "x", "model": "m1"}, '
                               '{"task": "y"}, '
                               '{"prompt": "z"}, '
                               '{"description": "d"}, '
                               '{"nada": 1}, '
                               '5, null]')
    assert out == [{"task": "x", "model": "m1"},
                   {"task": "y", "model": ""},
                   {"task": "z", "model": ""},
                   {"task": "d", "model": ""}]
    # a bare dict arg (internal caller) behaves like a 1-element array
    assert dt_swarm.parse_tasks({"task": "solo", "model": "m"}) == \
        [{"task": "solo", "model": "m"}]
    # non-string model is stringified, empty stays empty
    assert dt_swarm.parse_tasks([{"task": "a", "model": 5}]) == \
        [{"task": "a", "model": "5"}]


def test_parse_tasks_multiline_string():
    out = dt_swarm.parse_tasks("  line one \nline two\n\n   \nline three  ")
    assert [t["task"] for t in out] == ["line one", "line two", "line three"]
    assert all(t["model"] == "" for t in out)


def test_parse_tasks_malformed_json_recovers():
    # truncated array bracket → the documented recovery: one task per line
    out = dt_swarm.parse_tasks('["oops, "truncated')
    assert len(out) == 1 and "truncated" in out[0]["task"]
    # pure garbage is still just lines — never an exception
    out2 = dt_swarm.parse_tasks("no brackets here\nsecond task")
    assert [t["task"] for t in out2] == ["no brackets here", "second task"]
    # brace junk
    out3 = dt_swarm.parse_tasks("{{{not json at all")
    assert len(out3) == 1


def test_parse_tasks_empty_and_junk():
    assert dt_swarm.parse_tasks("") == []
    assert dt_swarm.parse_tasks("   ") == []
    assert dt_swarm.parse_tasks(None) == []
    assert dt_swarm.parse_tasks("[]") == []
    assert dt_swarm.parse_tasks("null") == []      # decodes to None, not lines
    assert dt_swarm.parse_tasks("123") == []
    assert dt_swarm.parse_tasks("[1, 2, null]") == []
    assert dt_swarm.parse_tasks(42) == []
    # bare JSON string → line-split (a one-line prompt is one task)
    assert dt_swarm.parse_tasks('"just this"') == \
        [{"task": "just this", "model": ""}]


def test_parse_tasks_caps_oversized_task():
    big = dt_swarm.parse_tasks('["' + "Z" * 5000 + '"]')
    assert len(big) == 1
    assert len(big[0]["task"]) < dt_swarm.MAX_TASK_CHARS + 60
    assert "task truncated" in big[0]["task"]


# ── state IO ─────────────────────────────────────────────────────────────

def test_save_load_state_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "sw-round0001.json"
        data = {"swarm_id": "sw-round0001",
                "agents": [{"id": "a1", "text": "ünïcödé ✓ trimmed later",
                            "secs": 1.25}],
                "nested": {"k": [1, 2, {"deep": True}]}}
        dt_swarm.save_state(p, data)
        assert dt_swarm.load_state(p) == data
        # atomic: no tmp leftovers next to the file
        leftovers = [x.name for x in Path(d).iterdir()
                     if x.name.endswith(".tmp")]
        assert leftovers == [], leftovers
        # overwrite in place works (state snapshots on every completion)
        data["agents"][0]["status"] = "done"
        dt_swarm.save_state(p, data)
        assert dt_swarm.load_state(p)["agents"][0]["status"] == "done"


def test_load_state_tolerates_missing_and_corrupt():
    with tempfile.TemporaryDirectory() as d:
        assert dt_swarm.load_state(Path(d) / "nope.json") == {}
        junk = Path(d) / "junk.json"
        junk.write_text("{not json at all", encoding="utf-8")
        assert dt_swarm.load_state(junk) == {}
        arr = Path(d) / "arr.json"
        arr.write_text("[1, 2, 3]", encoding="utf-8")   # valid JSON, not an object
        assert dt_swarm.load_state(arr) == {}


# ── merge_report ─────────────────────────────────────────────────────────

def _mixed_results():
    return [
        {"id": "a1", "spawn_id": "s1", "task": "ok task", "model": "",
         "status": "done", "text": "answer one", "error": "",
         "preview": "answer one", "secs": 1.2},
        {"id": "a2", "spawn_id": "s2", "task": "boom task", "model": "",
         "status": "error", "text": "",
         "error": "spawn failed: CapacityError: no worker capacity",
         "preview": "", "secs": 0.1},
        {"id": "a3", "spawn_id": "s3", "task": "long task " * 20,
         "model": "kimi", "status": "done", "text": "Z" * 5000,
         "error": "", "preview": "", "secs": 9.9},
    ]


def test_merge_report_mixed_done_and_error():
    p = "/tmp/state/sw-mixed001.json"
    rep = dt_swarm.merge_report("sw-mixed001", _mixed_results(), 12.34,
                                full_path=p)
    # header: swarm id, N tasks, ok/failed counts, wall time (spec shape)
    assert rep.startswith(
        "Swarm sw-mixed001 — 3 tasks: 2 ok, 1 failed, 12.3s wall"), rep[:90]
    # per-agent section header: ## <id> — <task[:80]> [done|error] (spec)
    assert "## a1 — ok task [done]" in rep
    assert "## a2 — boom task [error]" in rep
    assert "## a3 — " in rep and rep.index("## a3 — ") + 4 + 80 < \
        rep.index("[done]", rep.index("## a3"))  # task capped at 80 chars
    assert "answer one" in rep
    assert "CapacityError" in rep                # error text surfaced
    assert "kimi" in rep                          # model meta
    # note where the full results live (spec)
    assert f"Full results: {p}" in rep
    assert "action='report'" in rep


def test_merge_report_trims_each_agent():
    rep = dt_swarm.merge_report("sw-trim0001", _mixed_results(), 5.0,
                                full_path="/tmp/x.json")
    # a3's 5000-char body trimmed to ~1500 with an explicit pointer
    assert "…[+3500 chars in state file]" in rep
    assert len(rep) < dt_swarm.RETURN_CAP


def test_merge_report_global_squeeze():
    # 8 chatty agents × 1500 chars would blow the ~6000-char return budget —
    # the squeeze pass must bring the whole report back under the cap
    many = [{"id": f"a{i}", "task": f"task {i}", "model": "",
             "status": "done", "text": "Y" * 4000, "error": "",
             "preview": "", "secs": 1.0} for i in range(1, 9)]
    rep = dt_swarm.merge_report("sw-squeeze01", many, 5.0)
    assert len(rep) <= dt_swarm.RETURN_CAP, len(rep)
    assert rep.startswith("Swarm sw-squeeze01 — 8 tasks: 8 ok, 0 failed")
    assert "state file" in rep                     # trim marker present
    # the full merged report is also correct for 0 / 1 agents
    empty = dt_swarm.merge_report("sw-none0001", [], 0.0)
    assert "0 tasks: 0 ok, 0 failed" in empty
    one = dt_swarm.merge_report("sw-one00001", many[:1], 1.0)
    assert "1 task:" in one                        # singular, no crash


def test_merge_report_note_without_path():
    rep = dt_swarm.merge_report("sw-note0001", _mixed_results()[:1], 1.0)
    assert "Full results: swarm(action='report'" in rep


# ── ids & misc plain helpers ─────────────────────────────────────────────

def test_id_helpers():
    sid = dt_swarm.new_swarm_id()
    assert sid.startswith("sw-") and len(sid) == 11
    assert dt_swarm._safe_id("sw-ab12cd34") == "sw-ab12cd34"
    assert dt_swarm._safe_id("ab12cd34") == "ab12cd34"
    # traversal + junk rejected before they ever reach the filesystem
    assert dt_swarm._safe_id("../../etc/passwd") == ""
    assert dt_swarm._safe_id("a/b") == ""
    assert dt_swarm._safe_id("sw x") == ""
    assert dt_swarm._safe_id("") == ""
    assert dt_swarm._safe_id(None) == ""
    assert dt_swarm._to_int("4", 4) == 4
    assert dt_swarm._to_int(4.0, 9) == 4
    assert dt_swarm._to_int("4.5", 9) == 4
    assert dt_swarm._to_int("garbage", 9) == 9
    assert len(dt_swarm._preview("line1\nline2  gap " * 20)) <= 120


# ── status / report / list (plain) ───────────────────────────────────────

def test_status_summary_running_and_done():
    agents = _mixed_results()
    running = dt_swarm.new_swarm_state("sw-run00001",
                                       [{"id": "a1", "spawn_id": "", "task": "t",
                                         "model": "", "status": "pending",
                                         "text": "", "error": "",
                                         "preview": "", "secs": 0.0}], 4, 120, "")
    sm = dt_swarm.status_summary(running)
    assert "(running)" in sm and "a1 [pending]" in sm
    done = _finished_state("sw-done0001", agents)
    sm2 = dt_swarm.status_summary(done, full_path="/tmp/sw-done0001.json")
    assert "2 ok, 1 failed" in sm2   # _mixed_results: 2 done + 1 error
    assert "a1 [done]" in sm2 and "a2 [error]" in sm2
    assert "created" in sm2 and "state: /tmp/sw-done0001.json" in sm2


def test_report_text_full_and_single_agent():
    agents = _mixed_results()
    st = _finished_state("sw-rep00001", agents)
    full = dt_swarm.report_text(st, full_path="/tmp/sw-rep00001.json")
    assert full.startswith("Swarm sw-rep00001 — 3 tasks: 2 ok, 1 failed")
    assert "answer one" in full and "CapacityError" in full
    one = dt_swarm.report_text(st, agent="a2")
    assert one.startswith("## a2 — boom task [error]")
    assert "CapacityError" in one and "## a1" not in one
    # unknown agent → helpful list of the real ids
    miss = dt_swarm.report_text(st, agent="a9")
    assert "not in swarm" in miss and "a1" in miss and "a2" in miss


def test_list_swarms_newest_first_and_junk_skipped():
    with tempfile.TemporaryDirectory() as d:
        dpath = Path(d)
        for sid in ("sw-old00001", "sw-new00001"):
            dt_swarm.save_state(dpath / f"{sid}.json",
                                _finished_state(sid, []))
        # deterministic order: filesystem mtime is the sort key
        os.utime(dpath / "sw-old00001.json", (1000, 1000))
        os.utime(dpath / "sw-new00001.json", (2000, 2000))
        (dpath / "junk.json").write_text("{oops", encoding="utf-8")
        rows = dt_swarm.list_swarms(dpath)
        assert [r["id"] for r in rows] == ["sw-new00001", "sw-old00001"]
        assert rows[0]["status"] == "done"
        txt = dt_swarm.format_swarm_list(rows, str(dpath))
        assert "2 swarm(s) in" in txt and "sw-new00001" in txt
        assert "No swarms yet" in dt_swarm.format_swarm_list([], str(dpath))


# ── handle(): the same dispatch the strands tool drives ──────────────────

def test_handle_help_and_unknown_action():
    ctx, d = _make_ctx()
    try:
        h = dt_swarm.handle(ctx, "help")
        for verb in ("run", "status", "report", "list", "help"):
            assert verb in h, verb
        assert "max_parallel" in h and "sw-" in h
        u = dt_swarm.handle(ctx, "explode")
        assert "unknown action" in u and "run" in u
        assert dt_swarm.handle(ctx, "") == h   # empty action → help
    finally:
        d.cleanup()


def test_handle_run_empty_tasks():
    ctx, d = _make_ctx()
    try:
        for bad in ("", "[]", "   ", "null"):
            out = dt_swarm.handle(ctx, "run", tasks=bad)
            assert "no tasks" in out, (bad, out)
    finally:
        d.cleanup()


def test_handle_run_offline_degrades_without_spawn():
    # ctx.spawn is None (offline/tests) → actionable message, never a raise,
    # and no swarm state is created for a run that never dispatched
    ctx, d = _make_ctx()
    try:
        out = dt_swarm.handle(ctx, "run", tasks='["t one", "t two"]')
        assert "spawn seam unavailable" in out
        assert "sequentially" in out              # the actionable instruction
        assert "t one" in out and "t two" in out  # the parsed task list
        assert not list(ctx.tool_state("swarm").glob("sw-*.json"))
    finally:
        d.cleanup()


def test_handle_status_report_list_roundtrip():
    events: list = []
    ctx, d = _make_ctx(events)
    try:
        # seed a finished swarm exactly the way _run_swarm persists one
        agents = [
            {"id": "a1", "spawn_id": "aa000001", "task": "first task",
             "model": "", "status": "done", "text": "result text one",
             "error": "", "preview": "result text one", "secs": 1.0},
            {"id": "a2", "spawn_id": "aa000002", "task": "second task",
             "model": "", "status": "error", "text": "",
             "error": "spawn failed: boom", "preview": "", "secs": 0.5},
        ]
        p = Path(ctx.tool_state("swarm")) / "sw-test0001.json"
        dt_swarm.save_state(p, _finished_state("sw-test0001", agents))

        sm = dt_swarm.handle(ctx, "status", swarm_id="sw-test0001")
        assert "1 ok, 1 failed" in sm and "a1 [done]" in sm
        assert str(p) in sm
        rep = dt_swarm.handle(ctx, "report", swarm_id="sw-test0001")
        assert "result text one" in rep
        assert "## a2 — second task [error]" in rep
        one = dt_swarm.handle(ctx, "report", swarm_id="sw-test0001", agent="a1")
        assert one.startswith("## a1 — first task [done]")
        # the model sometimes drops the "sw-" prefix — tolerated
        assert "result text one" in dt_swarm.handle(ctx, "report",
                                                    swarm_id="test0001")
        # unknown + traversal ids never reach the filesystem
        assert "no state" in dt_swarm.handle(ctx, "status",
                                             swarm_id="sw-nosuch01")
        assert "swarm_id" in dt_swarm.handle(ctx, "status",
                                             swarm_id="../../etc/passwd")
        lst = dt_swarm.handle(ctx, "list")
        assert "1 swarm(s) in" in lst and "sw-test0001" in lst
    finally:
        d.cleanup()


# ── _run_swarm with a FAKE spawn + serial runner (still no threads) ──────

def test_run_swarm_serial_fake_spawn():
    events: list = []
    calls: list = []
    ctx, d = _make_ctx(events)
    try:
        ctx.spawn = _fake_spawn(calls)
        out = dt_swarm._run_swarm(ctx, '["alpha", "boom now", "quiet one"]',
                                  4, 60, "base-model", runner=_serial_runner)
        # merged report: header counts + per-agent sections
        assert out.startswith("Swarm sw-")
        assert "3 tasks: 2 ok, 1 failed" in out
        assert "did: alpha" in out
        assert "CapacityError" in out               # raising seam → per-agent error
        assert "no text output" in out              # done-with-empty-text surfaced
        # the seam saw the run-level model + timeout, wait=True
        assert [c["model"] for c in calls] == ["base-model"] * 3
        assert all(c["timeout"] == 60 and c["wait"] is True for c in calls)
        # state file: full detail, final status done
        files = list(Path(ctx.tool_state("swarm")).glob("sw-*.json"))
        assert len(files) == 1
        st = dt_swarm.load_state(files[0])
        assert st["status"] == "done" and st["total"] == 3
        assert st["ok"] == 2 and st["failed"] == 1
        assert st["finished"] and isinstance(st["wall_secs"], float)
        assert [a["id"] for a in st["agents"]] == ["a1", "a2", "a3"]
        assert st["agents"][1]["status"] == "error"
        assert st["agents"][0]["spawn_id"] == "ff00aa02"
        # live events: one swarm_agent_done per completion + final swarm_done
        done_ev = [e for e in events if e.get("event") == "swarm_agent_done"]
        assert [e["agent"] for e in done_ev] == ["a1", "a2", "a3"]
        assert [e["ok"] for e in done_ev] == [True, False, True]
        assert all(len(e.get("preview", "")) <= 120 for e in done_ev)
        assert any(e.get("event") == "swarm_done" for e in events)
    finally:
        d.cleanup()


def test_run_swarm_dict_error_never_raises():
    # a seam that RETURNS an error dict (spawn_subagent's CapacityError path)
    ctx, d = _make_ctx()
    try:
        ctx.spawn = lambda task, model="", wait=True, timeout=150, **kw: {
            "id": "err00001", "status": "error",
            "error": "spawn failed: CapacityError: no worker capacity"}
        out = dt_swarm._run_swarm(ctx, '["x"]', 4, 60, "",
                                  runner=_serial_runner)
        assert "1 failed" in out and "spawn failed: CapacityError" in out
        st = dt_swarm.load_state(
            next(Path(ctx.tool_state("swarm")).glob("sw-*.json")))
        assert st["agents"][0]["spawn_id"] == "err00001"
    finally:
        d.cleanup()


def test_run_swarm_per_task_model_and_clamps():
    calls: list = []
    ctx, d = _make_ctx()
    try:
        ctx.spawn = _fake_spawn(calls)
        out = dt_swarm._run_swarm(
            ctx,
            '[{"task": "special", "model": "m-over"}, {"task": "plain"}]',
            "99", "999", "", runner=_serial_runner)
        assert "2 tasks: 2 ok, 0 failed" in out
        models = {c["task"]: c["model"] for c in calls}
        assert models["special"] == "m-over"    # per-task model wins
        assert models["plain"] == ""            # empty → spawn default
        # knobs clamped: 99→8 workers, 999s→240s (spec caps)
        assert all(c["timeout"] == TIME_CAP for c in calls)
        st = dt_swarm.load_state(
            next(Path(ctx.tool_state("swarm")).glob("sw-*.json")))
        assert st["max_parallel"] == MAX_PAR
        assert st["timeout_per_agent"] == TIME_CAP
    finally:
        d.cleanup()


def test_run_swarm_seven_tasks_line_recovery():
    # malformed JSON input (no brackets) still fans out line-per-task
    calls: list = []
    ctx, d = _make_ctx()
    try:
        ctx.spawn = _fake_spawn(calls)
        out = dt_swarm._run_swarm(ctx, "one\ntwo\nthree\nfour\nfive\nsix\nseven",
                                  4, 60, "", runner=_serial_runner)
        assert "7 tasks: 7 ok, 0 failed" in out
        assert len(calls) == 7
    finally:
        d.cleanup()


# ── build() + registry integration ───────────────────────────────────────

def test_build_offline_never_raises():
    ctx, d = _make_ctx()
    try:
        res = dt_swarm.build(ctx)
        assert isinstance(res, list)     # [] offline; [swarm] with the SDK
        if not HAS_STRANDS:
            assert res == []
    finally:
        d.cleanup()


def test_registry_manifest_and_loader_clean():
    # my module must appear in the dt_registry manifest and must not break
    # the loader (the orchestrator's integration seam — dt_spec rule 4)
    ctx, d = _make_ctx()
    try:
        manifest = dt_registry.tool_manifest(ctx)
        assert "dt_swarm" in manifest, sorted(manifest)
        info = manifest["dt_swarm"]
        assert info["names"] == ["swarm"]
        assert "error" not in info
        tools = dt_registry.load_doomalay_tools(ctx)
        assert isinstance(tools, list)   # never raises, whatever sibling
        # modules are doing                                  
    finally:
        d.cleanup()


# ── standalone runner (dt_spec rule 8): python3 tests/test_dt_swarm.py ──
if __name__ == "__main__":
    failed = []
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as exc:  # noqa: BLE001 — report, keep going
            failed.append((name, exc))
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - len(failed)}/{len(tests)} tests passed")
    if failed:
        raise SystemExit(1)
    print("ALL TESTS PASSED")
