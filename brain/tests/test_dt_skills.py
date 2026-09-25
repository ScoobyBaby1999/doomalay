"""test_dt_skills.py — offline unit tests for brain/tools/dt_skills.py.

Covers the plain core only: no strands, no network, no engine, and NO
touching of the real brain/agent_skills tree — a temp skills dir stands in
for it (including one dir with bad frontmatter and one whose frontmatter
name != its directory, both of which must be skipped, not crash).

Runs standalone (`python3 tests/test_dt_skills.py`) AND under pytest.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

# Import the tool module straight from brain/tools/ (no package layout).
_TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

import dt_skills  # noqa: E402

ALPHA_MD = (
    "---\n"
    "name: superpowers-alpha\n"
    "description: Use when doing alpha work - auditing and assembling\n"
    "---\n"
    "\n"
    "# Alpha methodology\n"
    "\n"
    "Audit everything before assembling. Alpha checklist: audit, assemble.\n"
)
BETA_MD = (
    "---\n"
    "name: beta\n"
    "description: Use when beta processing is needed - the wrapped\n"
    "  continuation of the beta description\n"
    "---\n"
    "\n"
    "# Beta methodology\n"
    "\n"
    "Body text mentioning zeta keywords for search tests.\n"
)
GAMMA_MD = (
    "---\n"
    "name: superpowers-gamma\n"
    "description: Use when gamma sweep is required\n"
    "---\n"
    "\n"
    "# Gamma\n"
)


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def make_tree(root: Path) -> Path:
    """A temp agent_skills/ tree: 3 good skills (one with support files,
    one with a wrapped description) + 2 bad dirs (no frontmatter fence;
    frontmatter name != dir name) that must be skipped with reasons."""
    skills = root / "agent_skills"
    _write(skills / "superpowers-alpha" / "SKILL.md", ALPHA_MD)
    _write(skills / "superpowers-alpha" / "prompt-a.md",
           "# Prompt A\n\nUse when delegating alpha work.\n")
    _write(skills / "superpowers-alpha" / "templates" / "deep.md",
           "# Deep template\n\nNested support file body.\n")
    _write(skills / "beta" / "SKILL.md", BETA_MD)
    _write(skills / "superpowers-gamma" / "SKILL.md", GAMMA_MD)
    _write(skills / "superpowers-mismatch" / "SKILL.md",
           "---\nname: totally-different\ndescription: Use when broken\n---\n\nbody\n")
    _write(skills / "broken" / "SKILL.md", "no frontmatter fence here\njust body\n")
    return skills


@contextmanager
def _tree():
    root = Path(tempfile.mkdtemp(prefix="dt-skills-test-"))
    try:
        yield root, make_tree(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ── parse_frontmatter ────────────────────────────────────────────────────

def test_parse_frontmatter_flat():
    fm = dt_skills.parse_frontmatter("---\nname: x\ndescription: y z\n---\nbody")
    assert fm == {"name": "x", "description": "y z"}


def test_parse_frontmatter_quoted_values():
    fm = dt_skills.parse_frontmatter('---\nname: "x"\ndescription: \'y\'\n---\n')
    assert fm == {"name": "x", "description": "y"}


def test_parse_frontmatter_continuation():
    text = "---\nname: beta\ndescription: first half\n  second half\n---\n"
    assert dt_skills.parse_frontmatter(text)["description"] == "first half second half"


def test_parse_frontmatter_blank_line_ends_continuation():
    # an indented line AFTER a blank line belongs to no key and is dropped
    text = "---\nname: x\ndescription: d\n\n  orphan line\nother: o\n---\n"
    assert dt_skills.parse_frontmatter(text) == {"name": "x", "description": "d", "other": "o"}


def test_parse_frontmatter_missing_fence():
    assert dt_skills.parse_frontmatter("name: x\ndescription: y") == {}


def test_parse_frontmatter_fence_not_at_start():
    # the fence must open the file — prose before it means no frontmatter
    assert dt_skills.parse_frontmatter("intro\n---\nname: x\n---\n") == {}


def test_parse_frontmatter_body_after_fence_ignored():
    # a second `name:` in the BODY must not override the frontmatter name
    fm = dt_skills.parse_frontmatter("---\nname: x\n---\nname: y\n")
    assert fm == {"name": "x"}


# ── index_skills ─────────────────────────────────────────────────────────

def test_index_counts_and_invariant_skip():
    with _tree() as (root, skills):
        idx = dt_skills.index_skills(skills)
        names = sorted(e["name"] for e in idx["entries"])
        assert names == ["beta", "superpowers-alpha", "superpowers-gamma"]
        skipped = {s["dir"]: s["reason"] for s in idx["skipped"]}
        # name != dir -> skipped (the loader invariant), with the reason on record
        assert "superpowers-mismatch" in skipped
        assert "!= directory name" in skipped["superpowers-mismatch"]
        # no --- fence -> no parseable name -> skipped
        assert "broken" in skipped
        assert "frontmatter" in skipped["broken"].lower()
        # descriptions ride along verbatim (continuation joined to one line)
        beta = next(e for e in idx["entries"] if e["name"] == "beta")
        assert beta["description"] == ("Use when beta processing is needed - the wrapped"
                                       " continuation of the beta description")
        assert Path(beta["location"]).is_file()


def test_index_cache_hit_and_invalidation():
    with _tree() as (root, skills):
        idx1 = dt_skills.index_skills(skills)
        # unchanged tree: the SAME parsed object comes back (cache hit)
        assert dt_skills.index_skills(skills) is idx1
        # edit a SKILL.md: the (mtime, size) signature changes -> re-index
        _write(skills / "superpowers-alpha" / "SKILL.md",
               ALPHA_MD.replace("auditing and assembling", "brand new description words"))
        idx2 = dt_skills.index_skills(skills)
        assert idx2 is not idx1
        alpha = next(e for e in idx2["entries"] if e["name"] == "superpowers-alpha")
        assert "brand new description" in alpha["description"]


def test_index_missing_dir_is_empty_not_fatal():
    idx = dt_skills.index_skills(Path(tempfile.mkdtemp(prefix="dt-skills-empty-")) / "nope")
    assert idx["entries"] == [] and idx["skipped"] == []


# ── search_index (scoring: name 3 / description 2 / body 1) ──────────────

def test_search_scoring_order_and_reasons():
    with _tree() as (root, skills):
        idx = dt_skills.index_skills(skills)
        res = dt_skills.search_index(idx, "alpha zeta")
        # alpha: term in name(+3) desc(+2) body(+1) = 6; beta: zeta body(+1) = 1
        assert [r["name"] for r in res] == ["superpowers-alpha", "beta"]
        assert res[0]["score"] == 6 and res[1]["score"] == 1
        assert any(r.startswith("name:alpha") for r in res[0]["reasons"])
        assert any(r.startswith("description:alpha") for r in res[0]["reasons"])
        assert any(r.startswith("body:zeta") for r in res[1]["reasons"])
        # zero-score skills are absent, not ranked at 0
        assert all(r["name"] != "superpowers-gamma" for r in res)


def test_search_via_run_renders_reasons():
    with _tree() as (root, skills):
        out = dt_skills.run("search", query="alpha zeta", skills_dir=skills)
        assert "superpowers-alpha" in out and "score 6" in out
        assert "matches:" in out and "body:zeta" in out
        assert "action=\"load\"" in out  # the footer points at the key action


def test_search_no_match_and_empty_query():
    with _tree() as (root, skills):
        out = dt_skills.run("search", query="qqqqzzzz", skills_dir=skills)
        assert "no match" in out
        out2 = dt_skills.run("search", skills_dir=skills)
        assert "query" in out2  # actionable hint, not a crash


# ── resolve_skill ────────────────────────────────────────────────────────

def test_resolve_exact_with_and_without_prefix():
    with _tree() as (root, skills):
        idx = dt_skills.index_skills(skills)
        r1 = dt_skills.resolve_skill(idx, "superpowers-alpha")
        r2 = dt_skills.resolve_skill(idx, "alpha")
        assert r1["status"] == "ok" and r1["resolved_as"] == "superpowers-alpha"
        assert r2["status"] == "ok" and r2["skill"]["name"] == "superpowers-alpha"


def test_resolve_prefix_and_substring():
    with _tree() as (root, skills):
        idx = dt_skills.index_skills(skills)
        # prefix "al" -> unique "superpowers-alpha" (via superpowers-al)
        assert dt_skills.resolve_skill(idx, "al")["status"] == "ok"
        # substring "lph" -> unique superpowers-alpha
        assert dt_skills.resolve_skill(idx, "lph")["status"] == "ok"
        assert dt_skills.resolve_skill(idx, "gamma")["resolved_as"] == "superpowers-gamma"


def test_resolve_ambiguous_lists_candidates():
    with _tree() as (root, skills):
        idx = dt_skills.index_skills(skills)
        r = dt_skills.resolve_skill(idx, "superpowers")
        assert r["status"] == "ambiguous"
        assert [e["name"] for e in r["candidates"]] == ["superpowers-alpha", "superpowers-gamma"]
        # and run() renders the candidate list for the model to pick from
        out = dt_skills.run("load", skill="superpowers", skills_dir=skills, state_dir=root / "state")
        assert "ambiguous" in out and "superpowers-alpha" in out and "superpowers-gamma" in out


def test_resolve_none_gives_suggestions():
    with _tree() as (root, skills):
        idx = dt_skills.index_skills(skills)
        r = dt_skills.resolve_skill(idx, "alpah")  # typo of alpha
        assert r["status"] == "none"
        assert "superpowers-alpha" in r["suggestions"]
        out = dt_skills.run("read", skill="alpah", skills_dir=skills)
        assert "Nearest" in out and "superpowers-alpha" in out


# ── load: envelope + loaded-log append ───────────────────────────────────

def test_load_envelope_content_and_log_append():
    with _tree() as (root, skills):
        state = root / "state"
        out = dt_skills.run("load", skill="alpha", skills_dir=skills, state_dir=state)
        assert "=== SKILL LOADED: superpowers-alpha ===" in out
        assert "SKILL LOADED — follow this methodology now" in out
        assert "Audit everything before assembling" in out       # full body inside
        assert "prompt-a.md" in out                              # supporting files listed
        assert "templates/deep.md" in out
        assert "skills_loaded.jsonl" in out                      # points at the log
        log = state / "skills_loaded.jsonl"
        assert log.is_file()
        lines = [json.loads(l) for l in log.read_text(encoding="utf-8").splitlines() if l.strip()]
        assert len(lines) == 1
        assert lines[0]["skill"] == "superpowers-alpha"
        assert lines[0]["when"]  # ISO-8601 timestamp recorded


def test_load_ambiguous_writes_no_log():
    with _tree() as (root, skills):
        state = root / "state"
        dt_skills.run("load", skill="alpha", skills_dir=skills, state_dir=state)
        out = dt_skills.run("load", skill="superpowers", skills_dir=skills, state_dir=state)
        assert "ambiguous" in out  # unresolved -> no second load
        lines = [l for l in (state / "skills_loaded.jsonl").read_text().splitlines() if l.strip()]
        assert len(lines) == 1


def test_load_without_state_dir_still_envelopes():
    with _tree() as (root, skills):
        out = dt_skills.run("load", skill="beta", skills_dir=skills, state_dir=None)
        assert "SKILL LOADED: beta ===" in out
        assert "not logged" in out  # honest note instead of a silent no-op


def test_run_loaded_lists_history():
    with _tree() as (root, skills):
        state = root / "state"
        empty = dt_skills.run("loaded", skills_dir=skills, state_dir=state)
        assert "nothing loaded" in empty
        dt_skills.run("load", skill="alpha", skills_dir=skills, state_dir=state)
        dt_skills.run("load", skill="gamma", skills_dir=skills, state_dir=state)
        out = dt_skills.run("loaded", skills_dir=skills, state_dir=state)
        assert "superpowers-alpha" in out and "superpowers-gamma" in out
        assert out.index("superpowers-alpha") < out.index("superpowers-gamma")  # load order


def test_on_loaded_callback_fires():
    with _tree() as (root, skills):
        seen: list[str] = []
        dt_skills.run("load", skill="alpha", skills_dir=skills,
                      state_dir=root / "state", on_loaded=seen.append)
        assert seen == ["superpowers-alpha"]


# ── files listing ────────────────────────────────────────────────────────

def test_files_listing_path_size_first_line():
    with _tree() as (root, skills):
        out = dt_skills.run("files", skill="superpowers-alpha", skills_dir=skills)
        assert "prompt-a.md" in out and "templates/deep.md" in out
        assert "# Prompt A" in out              # first line shown
        assert "B)" in out                      # size shown
        assert 'skill="superpowers-alpha/prompt-a.md"' in out  # read-recipe footer


def test_files_when_none():
    with _tree() as (root, skills):
        out = dt_skills.run("files", skill="beta", skills_dir=skills)
        assert "no supporting files" in out


# ── read: full text, cap, supporting files, traversal ────────────────────

def test_read_skill_full_text():
    with _tree() as (root, skills):
        out = dt_skills.run("read", skill="beta", skills_dir=skills)
        assert "=== SKILL: beta ===" in out
        assert "# Beta methodology" in out
        assert "zeta keywords" in out
        assert "truncated" not in out  # small file: no cap applied
        assert "action=\"load\"" in out  # footer hints the load action


def test_read_truncates_at_8000_with_where_to_find_note():
    root = Path(tempfile.mkdtemp(prefix="dt-skills-big-"))
    try:
        skills = root / "agent_skills"
        _write(skills / "big" / "SKILL.md",
               "---\nname: big\ndescription: Use when testing truncation\n---\n\n" + "B" * 9000)
        out = dt_skills.run("read", skill="big", skills_dir=skills)
        # the cap applies to frontmatter+body: most-but-not-all of the 9000
        # B's survive, never more than READ_MAX of them
        assert "[…truncated at 8000/" in out and "full file:" in out
        assert 7000 < out.count("B") < 8001
        assert "B" * 8001 not in out
        assert len(out) < 8000 + 600  # header + notes stay small
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_read_support_file_by_relative_path():
    with _tree() as (root, skills):
        out = dt_skills.run("read", skill="superpowers-alpha/prompt-a.md", skills_dir=skills)
        assert "=== FILE: superpowers-alpha/prompt-a.md ===" in out
        assert "# Prompt A" in out and "Use when delegating alpha work" in out


def test_read_rejects_path_traversal_and_missing_file():
    with _tree() as (root, skills):
        trav = dt_skills.run("read", skill="superpowers-alpha/../beta/SKILL.md", skills_dir=skills)
        assert "bad relative path" in trav
        missing = dt_skills.run("read", skill="superpowers-alpha/nope.md", skills_dir=skills)
        assert "no file" in missing and 'action="files"' in missing


# ── run() dispatch edges ─────────────────────────────────────────────────

def test_run_help_and_unknown_action():
    with _tree() as (root, skills):
        assert dt_skills.run("help", skills_dir=skills) == dt_skills.HELP_TEXT
        assert dt_skills.run("", skills_dir=skills) == dt_skills.HELP_TEXT  # empty -> help
        assert "unknown action" in dt_skills.run("frobnicate", skills_dir=skills)


def test_list_grouping_filter_and_skipped_diagnostics():
    with _tree() as (root, skills):
        out = dt_skills.run("list", skills_dir=skills)
        # superpowers group renders FIRST (process skills before domain skills)
        assert out.index("superpowers methodology skills") < out.index("other skills (1)")
        assert "3 available" in out and "2 superpowers-* methodology + 1 other" in out
        assert "superpowers-alpha" in out and "beta" in out
        # skipped dirs are visible with reasons; their bogus frontmatter name
        # is NOT indexed as a skill (the reason line may quote it — that's ops
        # diagnostics, not an index entry)
        assert "superpowers-mismatch" in out and "broken" in out
        idx = dt_skills.index_skills(skills)
        assert "totally-different" not in {e["name"] for e in idx["entries"]}
        # the progressive-disclosure hint
        assert "load" in out
        # name filter narrows without hiding the totals
        filtered = dt_skills.run("list", name_filter="beta", skills_dir=skills)
        assert "beta" in filtered
        assert "superpowers-alpha" not in filtered and "superpowers-gamma" not in filtered


def test_run_on_missing_skills_dir_degrades():
    root = Path(tempfile.mkdtemp(prefix="dt-skills-none-"))
    try:
        out = dt_skills.run("list", skills_dir=root / "does-not-exist")
        assert "no skills indexed" in out
        assert "skills error" not in out  # a message, never an exception
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_build_offline_returns_empty_and_never_raises():
    # build() must never raise. Offline (no strands) it registers nothing;
    # a ctx without skills_dir must also degrade to [] — and in a FULL env
    # (the E2E venv has strands) a real skills_dir registers the tool.
    import types
    try:
        import strands  # noqa: F401
        full = True
    except ImportError:
        full = False
    assert dt_skills.build(types.SimpleNamespace(skills_dir=None)) == []
    with _tree() as (root, skills):
        out = dt_skills.build(types.SimpleNamespace(skills_dir=str(skills)))
        assert (len(out) == 1) if full else (out == [])


# ── standalone runner ────────────────────────────────────────────────────

def _run_all() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS {name}")
        except Exception as exc:  # noqa: BLE001 — report, keep running
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_all())
