"""test_dt_template.py — offline unit tests for brain/tools/dt_template.py.

Covers the plain core only: no strands, no network, no engine, no sub-agent
spawn, and NO touching of the real brain/orchestrator/templates tree — a
temp template tree stands in for it (fake orchestrator stage-JSONs, a fake
superpowers_user_templates.json, a fake importable templates.py, plus a
corrupt JSON and a stage-less JSON that must be skipped with warnings, not
crash the index). `run` is exercised through a fake spawn seam that records
its calls; state lives in a temp dir.

Runs standalone (`python3 tests/test_dt_template.py`) AND under pytest.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

# Import the tool module straight from brain/tools/ (no package layout).
_TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

import dt_template as dt  # noqa: E402

# ── fixtures (one canonical fake tree; every test gets a fresh copy) ─────

ALPHA_FLOW = {
    "//": "ALPHA - the alpha flow for testing",
    "task_type": "alpha_flow",
    "task": "<FILL ME IN: thing to alpha>",
    "stages": [
        {"name": "prep", "role": "extractor", "inputs": ["prompt"],
         "instructions": "Extract the alpha targets as JSON."},
        {"name": "work", "role": "generator", "inputs": ["prep"],
         "instructions": "Work each alpha target thoroughly.",
         "fanout": {"over": "prep.targets", "max_parallel": 4}},
        {"name": "check", "role": "verifier", "inputs": ["work"],
         "instructions": "Verify the alpha output."},
    ],
    "output_rules": {"format": "markdown", "required_sections": ["Alpha"]},
}

BETA_FLOW = {
    "task_type": "beta_flow",
    "task": "<FILL ME IN: beta>",
    "stages": [
        {"name": "only", "role": "generator", "inputs": ["prompt"],
         "instructions": "Do the beta thing in one stage."},
    ],
}

USER_TEMPLATES = [
    {"name": "Fake User Template",
     "description": "A fake superpowers discipline for tests",
     "task_type": "fake_user", "task": "do fake things", "kind": "chat",
     "tags": ["superpowers", "fake"], "markdown": "# Fake\n\nDo the fake dance."},
    {"description": "no name — must be skipped, not crash"},
    {"name": "Big User Template",
     "description": "long body for the reply-cap test",
     "task_type": "big_user", "task": "make a big thing", "kind": "chat",
     "tags": ["big"], "markdown": "# Big\n\n" + ("filler line. " * 900)},
]

# Fake importable templates.py: one unique flow + one whose task_type
# duplicates the alpha_flow orchestrator stem (must be deduped away).
FAKE_DEFAULTS_PY = (
    "DEFAULT_TEMPLATES = [\n"
    "    {'name': 'Fake Default', 'description': 'default flow for tests',\n"
    "     'task_type': 'fake_default', 'task': 'fake default task',\n"
    "     'kind': 'chat', 'tags': ['creative'],\n"
    "     'stages': [{'name': 'only', 'role': 'generator', 'inputs': ['prompt'],\n"
    "                 'instructions': 'Do the default thing.'}]},\n"
    "    {'name': 'Clone Of Alpha', 'description': 'duplicate of the orchestrator flow',\n"
    "     'task_type': 'alpha_flow', 'task': 'clone task', 'kind': 'chat',\n"
    "     'tags': [], 'stages': [{'name': 'x', 'role': 'generator',\n"
    "                             'inputs': ['prompt'], 'instructions': 'x'}]},\n"
    "]\n"
)


class Tree:
    """Fresh fake library per test: tdir (orchestrator JSONs), bdir (user
    JSON + fake templates.py), state (tool state dir, created lazily)."""

    def __init__(self, root: Path):
        self.root = root
        self.tdir = root / "tpl"
        self.bdir = root / "brain"
        self.state = root / "state"
        self.tdir.mkdir(parents=True)
        self.bdir.mkdir(parents=True)
        (self.tdir / "alpha_flow.json").write_text(
            json.dumps(ALPHA_FLOW), encoding="utf-8")
        (self.tdir / "beta_flow.json").write_text(
            json.dumps(BETA_FLOW), encoding="utf-8")
        (self.tdir / "broken.json").write_text("{ this is not json", encoding="utf-8")
        (self.tdir / "no_stages.json").write_text(
            json.dumps({"task_type": "empty"}), encoding="utf-8")
        (self.bdir / dt.USER_JSON_NAME).write_text(
            json.dumps(USER_TEMPLATES), encoding="utf-8")
        (self.bdir / "templates.py").write_text(FAKE_DEFAULTS_PY, encoding="utf-8")

    def run(self, action: str, **kw) -> str:
        kw.setdefault("templates_dir", self.tdir)
        kw.setdefault("brain_dir", self.bdir)
        return dt.run_action(action, **kw)


@contextmanager
def tree():
    tmp = Path(tempfile.mkdtemp(prefix="dt-template-test-"))
    try:
        yield Tree(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _fake_spawn(calls: list):
    def spawn(task, model="", wait=True, timeout=150):
        calls.append({"task": task, "model": model, "timeout": timeout})
        return "SPAWN RESULT: the alpha deliverable text."
    return spawn


# ── index ────────────────────────────────────────────────────────────────

def test_index_merges_both_kinds_and_skips_malformed():
    with tree() as t:
        idx = dt.index_templates(t.tdir, t.bdir)
        assert [e["id"] for e in idx["orchestrator"]] == ["alpha_flow", "beta_flow"]
        # 2 seed-JSON entries + the unique fake default; the clone (same
        # task_type as the alpha orchestrator stem) must be deduped away.
        assert sorted(e["id"] for e in idx["user"]) == [
            "big-user-template", "fake-default", "fake-user-template"]
        alpha = idx["orchestrator"][0]
        assert alpha["stage_count"] == 3
        assert alpha["fanout_width"] == 4
        assert alpha["roles"] == ["extractor", "generator", "verifier"]
        assert alpha["description"].startswith("ALPHA")
        # broken.json + no_stages.json + the nameless user entry all skip
        # with warnings — none of them may crash the index.
        warns = " | ".join(idx["warnings"])
        assert "broken.json" in warns and "no_stages.json" in warns
        assert "without a name" in warns
        # beta_flow.json has no "//" description key: the index falls back
        # to a synthesized line instead of an empty string.
        assert idx["orchestrator"][1]["description"].startswith("beta flow pipeline")


def test_missing_dir_empty_index_not_crash():
    with tree() as t:
        idx = dt.index_templates(t.root / "nope", t.root / "nope2")
        assert idx["orchestrator"] == [] and idx["user"] == []
        # missing brain dir → the defaults probe quietly yields nothing
        assert not (t.root / "nope2" / "templates.py").exists()


def test_index_tolerates_no_user_json():
    with tree() as t:
        (t.bdir / dt.USER_JSON_NAME).unlink()
        idx = dt.index_templates(t.tdir, t.bdir)
        assert [e["id"] for e in idx["user"]] == ["fake-default"]


def test_defaults_probe_failure_is_silent():
    with tree() as t:
        (t.bdir / "templates.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")
        idx = dt.index_templates(t.tdir, t.bdir)
        assert sorted(e["id"] for e in idx["user"]) == [
            "big-user-template", "fake-user-template"]


# ── describe / tree_view / brief ────────────────────────────────────────

def test_describe_mentions_stages():
    with tree() as t:
        idx = dt.index_templates(t.tdir, t.bdir)
        d = dt.describe_template(idx["orchestrator"][0])
        assert "Stages: 3" in d and "Produces:" in d and "When to use:" in d
        assert "fan-out" in d and "alpha_flow" in d
        # "<FILL ME IN: …>" is a runner placeholder, never usage guidance
        assert "FILL ME IN" not in d
        d_user = dt.describe_template(idx["user"][0])
        assert "Stages:" in d_user and "markdown" in d_user
        by_id = {e["id"]: e for e in idx["user"]}
        d_def = dt.describe_template(by_id["fake-default"])  # user entry WITH stages
        assert "Stages: 1" in d_def


def test_tree_view_nesting():
    with tree() as t:
        idx = dt.index_templates(t.tdir, t.bdir)
        tv = dt.tree_view(idx["orchestrator"][0])
        assert "alpha_flow — 3 stages" in tv
        assert "1. prep [extractor]  in: prompt" in tv
        assert "work [generator]" in tv
        # nesting: the fan-out branch lives UNDER its stage line
        assert re.search(r"work \[generator\].*\n.*fanout: once per item of "
                         r"prep\.targets \(up to 4 in parallel\)", tv)
        # markdown user template: no pipeline to tree
        tv_md = dt.tree_view(idx["user"][0])
        assert "no stage pipeline" in tv_md


def test_build_run_brief_contents():
    with tree() as t:
        idx = dt.index_templates(t.tdir, t.bdir)
        brief = dt.build_run_brief(idx["orchestrator"][0],
                                   "alpha the widgets", "/out/alpha-run.md")
        assert "alpha the widgets" in brief            # the input
        assert "Stage 1 — prep [extractor]" in brief   # stage instructions
        assert "Extract the alpha targets" in brief
        assert "Work each alpha target" in brief
        assert "/out/alpha-run.md" in brief            # the output path
        assert "stage by stage" in brief               # working discipline
        assert "fanout: once per item of prep.targets" in brief
        brief_md = dt.build_run_brief(idx["user"][0], "fake input", "/out/f.md")
        assert "# Fake" in brief_md and "fake input" in brief_md
        assert "markdown discipline" in brief_md


# ── dispatch: list / show / describe / help ─────────────────────────────

def test_list_groups_and_kind_filter():
    with tree() as t:
        out = t.run("list")
        assert "2 orchestrator pipelines + 3 user templates" in out
        assert "Superpowers flows (1)" in out      # fake-user-template (superpowers tag)
        assert "Creative (1)" in out               # fake-default (creative tag)
        assert "alpha_flow [orchestrator] — ALPHA" in out
        # corrupt file: surfaced as a ⚠ warning line, never as a library row
        assert "⚠ broken.json" in out
        assert "broken.json [orchestrator]" not in out
        out = t.run("list", kind="user")
        assert "fake-user-template" in out and "alpha_flow" not in out
        out = t.run("list", kind="orchestrator")
        assert "alpha_flow" in out and "fake-user-template" not in out
        # unknown kind degrades to the full library with a nudge
        out = t.run("list", kind="wat")
        assert "not orchestrator|user" in out and "alpha_flow" in out


def test_show_tree_and_reply_cap():
    with tree() as t:
        out = t.run("show", id="alpha_flow")
        assert "alpha_flow — orchestrator pipeline, 3 stages" in out
        assert "work [generator]" in out and "fanout" in out
        assert "Extract the alpha targets" not in out   # tree, not instruction dump
        # long markdown body → hard 6000-char cap with a trim note
        out = t.run("show", id="big-user-template")
        assert len(out) <= 6000 and "trimmed" in out
        # user template WITH stages shows the stage list (instructions are
        # the content for one-shot user flows)
        out = t.run("show", id="fake-default")
        assert "Stage 1 — only [generator]" in out
        assert "Do the default thing." in out


def test_help_and_tool_names():
    out = dt.run_action("help")
    assert "actions:" in out and "favorite" in out and "run" in out
    assert dt.TOOL_NAMES == ["dtemplate"]


def test_unknown_action_helpish():
    with tree() as t:
        out = t.run("frobnicate")
        assert "unknown action" in out and "help" in out


# ── favorites ────────────────────────────────────────────────────────────

def test_favorite_toggle_and_persistence():
    with tree() as t:
        r1 = t.run("favorite", id="alpha_flow", state_dir=t.state)
        r2 = t.run("favorite", id="beta_flow", state_dir=t.state)
        assert "marked ★" in r1 and "marked ★" in r2
        assert dt.read_favorites(t.state) == ["alpha_flow", "beta_flow"]
        # persistence: a fresh read of the state file sees the same ids
        assert json.loads((t.state / dt.FAV_FILE).read_text(encoding="utf-8"))["ids"] == \
            ["alpha_flow", "beta_flow"]
        r3 = t.run("favorite", id="alpha_flow", state_dir=t.state)
        assert "unmarked" in r3
        assert dt.read_favorites(t.state) == ["beta_flow"]
        # atomic write leaves no .tmp litter behind
        assert not (t.state / (dt.FAV_FILE + ".tmp")).exists()
        out = t.run("favorites", state_dir=t.state)
        assert "beta_flow" in out and "1" in out
        # unknown id → error string, state untouched
        out = t.run("favorite", id="no-such", state_dir=t.state)
        assert "no template matches" in out
        assert dt.read_favorites(t.state) == ["beta_flow"]


def test_favorite_event_fires():
    events: list[dict] = []

    def on_event(event, **fields):
        events.append({"event": event, **fields})

    with tree() as t:
        t.run("favorite", id="alpha_flow", state_dir=t.state, on_event=on_event)
    assert events and events[0]["event"] == "dtemplate_favorite"
    assert events[0]["template"] == "alpha_flow"


# ── run (fake spawn seam) ────────────────────────────────────────────────

def test_run_with_fake_spawn_records_and_writes_artifact():
    calls: list[dict] = []
    with tree() as t:
        out = t.run("run", id="alpha_flow", input="alpha the widgets",
                    model="test-model", state_dir=t.state,
                    spawn=_fake_spawn(calls))
        assert len(calls) == 1
        task = calls[0]["task"]
        assert "alpha the widgets" in task            # input rides the brief
        assert "Stage 1 — prep [extractor]" in task   # stages ride the brief
        assert calls[0]["model"] == "test-model"
        assert calls[0]["timeout"] == 600             # multi-stage runs get room
        runs = dt.read_runs(t.state)
        assert len(runs) == 1
        rec = runs[0]
        assert rec["template"] == "alpha_flow"
        assert rec["input"] == "alpha the widgets"
        assert rec["status"] == "done"
        assert rec["model"] == "test-model"
        assert rec["when"] and "alpha_flow-" in rec["output"]
        # spawn returned text but never wrote the file → belt+braces wrote it
        artifact = Path(rec["output"])
        assert artifact.is_file()
        assert artifact.read_text(encoding="utf-8") == "SPAWN RESULT: the alpha deliverable text."
        assert "deliverable:" in out and "SPAWN RESULT" in out


def test_run_never_clobbers_subagent_artifact():
    def writing_spawn(task, model="", wait=True, timeout=150):
        m = re.search(r"deliverable to (\S+\.md)", task)
        if m:
            Path(m.group(1)).write_text("WRITTEN BY SUB-AGENT", encoding="utf-8")
        return "returned text differs from the artifact"

    with tree() as t:
        t.run("run", id="alpha_flow", input="second run", state_dir=t.state,
              spawn=writing_spawn)
        runs = dt.read_runs(t.state)
        assert len(runs) == 1
        assert Path(runs[0]["output"]).read_text(encoding="utf-8") == \
            "WRITTEN BY SUB-AGENT"


def test_run_without_seam_self_execution():
    with tree() as t:
        out = t.run("run", id="fake-user-template", input="fake it",
                    state_dir=t.state, spawn=None)
        assert "self-execution mode" in out
        assert "# Fake" in out                    # the template text comes back
        assert "stage by stage" in out            # precise instructions
        runs = dt.read_runs(t.state)
        assert len(runs) == 1 and runs[0]["status"] == "self-execution"


def test_run_requires_input():
    with tree() as t:
        out = t.run("run", id="alpha_flow", input="   ", state_dir=t.state,
                    spawn=_fake_spawn([]))
        assert "give input=" in out
        assert dt.read_runs(t.state) == []


def test_spawn_failure_is_error_string():
    def boom(task, model="", wait=True, timeout=150):
        raise RuntimeError("sub-agent exploded")

    with tree() as t:
        out = t.run("run", id="alpha_flow", input="x", state_dir=t.state,
                    spawn=boom)
        assert out.startswith("dtemplate error:")
        assert "RuntimeError" in out
        runs = dt.read_runs(t.state)
        assert len(runs) == 1 and runs[0]["status"] == "error"


def test_run_events_fire():
    events: list[dict] = []

    def on_event(event, **fields):
        events.append({"event": event, **fields})

    with tree() as t:
        t.run("run", id="alpha_flow", input="x", state_dir=t.state,
              spawn=_fake_spawn([]), on_event=on_event)
    kinds = [(e["event"], e.get("status")) for e in events]
    assert ("dtemplate_run", "start") in kinds
    assert ("dtemplate_run", "done") in kinds


# ── runs history ─────────────────────────────────────────────────────────

def test_runs_log_append_and_history():
    calls: list[dict] = []
    with tree() as t:
        for i in range(3):
            t.run("run", id="alpha_flow", input=f"run number {i}",
                  state_dir=t.state, spawn=_fake_spawn(calls))
        runs = dt.read_runs(t.state)
        assert len(runs) == 3                       # append-only growth
        assert [r["input"] for r in runs] == ["run number 0", "run number 1",
                                              "run number 2"]
        out = t.run("runs", state_dir=t.state)
        assert "3 total" in out and "alpha_flow" in out
        # newest first
        assert out.index("run number 2") < out.index("run number 0")
        # empty state → friendly empty message, no crash
        empty = t.run("runs", state_dir=t.root / "fresh")
        assert "none yet" in empty


def test_runs_tolerates_corrupt_lines():
    with tree() as t:
        t.run("run", id="alpha_flow", input="good run", state_dir=t.state,
              spawn=_fake_spawn([]))
        log = t.state / dt.RUNS_LOG
        log.write_text(log.read_text(encoding="utf-8") + "{ torn json line\n",
                       encoding="utf-8")
        runs = dt.read_runs(t.state)
        assert len(runs) == 1 and runs[0]["input"] == "good run"


# ── resolution + degradation ────────────────────────────────────────────

def test_resolve_ambiguity_and_unknown():
    with tree() as t:
        idx = dt.index_templates(t.tdir, t.bdir)
        # exact ids win first
        e, err = dt.resolve_entry(idx, "alpha_flow")
        assert e is not None and err == ""
        # loose matching still resolves
        e, err = dt.resolve_entry(idx, "Alpha Flow")
        assert e is not None and e["id"] == "alpha_flow"
        # unknown → error string naming the miss
        e, err = dt.resolve_entry(idx, "zzz-nope")
        assert e is None and "no template matches" in err
        # empty ref → actionable prompt
        e, err = dt.resolve_entry(idx, "  ")
        assert e is None and "give id=" in err


def test_ambiguity_between_same_normalized_ids():
    # user "alpha flow" (hyphenated id) vs orchestrator "alpha_flow": a
    # hyphen/space/underscore-insensitive ref must surface BOTH instead of
    # silently picking one
    with tree() as t:
        (t.bdir / dt.USER_JSON_NAME).write_text(json.dumps([
            {"name": "Alpha Flow", "description": "user twin",
             "task_type": "alpha_flow", "task": "t", "kind": "chat",
             "tags": [], "markdown": "# twin"}]), encoding="utf-8")
        out = t.run("show", id="alphaflow")
        assert "ambiguous" in out and "alpha-flow" in out and "alpha_flow" in out


def test_stateless_degrade_messages():
    with tree() as t:
        assert "no state dir wired" in t.run("runs", state_dir=None)
        assert "no state dir wired" in t.run("favorites", state_dir=None)
        assert "no state dir wired" in t.run("favorite", id="alpha_flow",
                                             state_dir=None)
        # browsing actions never create the state dir (lazy-state contract)
        fresh = t.root / "fresh"
        t.run("list", state_dir=fresh)
        t.run("show", id="alpha_flow", state_dir=fresh)
        t.run("describe", id="alpha_flow", state_dir=fresh)
        assert not fresh.exists()


def test_browsing_real_dirs_read_only():
    # dispatch against the REAL library with no state dir: read-only smoke
    # of the default asset paths (no writes anywhere).
    out = dt.run_action("list")
    assert "orchestrator pipelines" in out
    out = dt.run_action("describe", id="research_paper")
    assert "Produces:" in out and "Stages:" in out


# ── pure helpers ─────────────────────────────────────────────────────────

def test_cap_bounds():
    long_text = "x" * 20000
    capped = dt._cap(long_text, 6000, "/some/state/file")
    assert len(capped) <= 6000
    assert "trimmed" in capped and "/some/state/file" in capped
    assert dt._cap("short", 6000) == "short"


def test_categorize_rules():
    def entry(**kw):
        base = {"id": "", "name": "", "task_type": "", "task": "",
                "tpl_kind": "", "tags": []}
        base.update(kw)
        return base

    assert dt.categorize(entry(id="superpowers_plan")) == "Superpowers flows"
    assert dt.categorize(entry(id="research_paper")) == "Deep research"
    assert dt.categorize(entry(id="lesson_plan")) == "Deep research"
    assert dt.categorize(entry(id="design_doc")) == "Deep research"
    assert dt.categorize(entry(id="panel_debate")) == "Creative"
    assert dt.categorize(entry(id="redteam")) == "Audit"
    assert dt.categorize(entry(id="repo_audit")) == "Audit"
    assert dt.categorize(entry(id="freeform")) == "Freeform"
    assert dt.categorize(entry(id="whatever", tags=["superpowers"])) == "Superpowers flows"
    assert dt.categorize(entry(id="generic-thing")) == "Freeform"


def test_build_never_raises_without_strands():
    # strands is absent in this sandbox: build() must return [] (not raise)
    # for any ctx shape, including None.
    assert dt.build(None) == []
    assert dt.build(type("C", (), {})()) == []


def test_output_path_shape():
    p = dt._run_output_path("/state", "alpha_flow", "2025-06-15T10:15:30Z")
    assert p == "/state/runs/alpha_flow-20250615T101530Z.md"
    p_rel = dt._run_output_path(None, "alpha_flow", "2025-06-15T10:15:30Z")
    assert "workspace-relative" in p_rel and "alpha_flow-" in p_rel


# ── standalone runner ────────────────────────────────────────────────────
# (pytest discovers the test_* functions above; this __main__ block runs
# them one by one so `python3 tests/test_dt_template.py` also exits 0/1.)

if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failures: list[str] = []
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS {name}")
        except Exception as exc:  # noqa: BLE001 — report, don't die mid-run
            failures.append(name)
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - len(failures)}/{len(tests)} tests passed")
    if failures:
        raise SystemExit(1)
    print("ALL TESTS PASSED")
