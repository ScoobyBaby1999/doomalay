"""test_dt_rtsearch.py — offline unit tests for brain/tools/dt_rtsearch.py.

Everything runs against INJECTED fakes (recording run_search / fetch_page
callables) — no network, no strands, no engine, per the dt_spec contract.
Run either way:
    python3 brain/tests/test_dt_rtsearch.py     (standalone asserts)
    pytest brain/tests/test_dt_rtsearch.py      (same checks as test_* fns)
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

BRAIN = Path(__file__).resolve().parent.parent
for _p in (str(BRAIN), str(BRAIN / "tools")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import dt_rtsearch as rt  # noqa: E402
import dt_registry  # noqa: E402  (stdlib-only; safe offline)


# ── fakes ──────────────────────────────────────────────────────────────────

def make_search(script_or_exc, calls=None):
    """run_search(query, n) fake: records calls, returns fixture results
    (script_or_exc: list of result dicts, or an Exception to raise)."""
    calls = calls if calls is not None else []

    def run_search(query, n):
        calls.append((query, n))
        if isinstance(script_or_exc, Exception):
            raise script_or_exc
        return list(script_or_exc)

    return run_search, calls


def make_fetch(body_or_map, calls=None):
    """fetch_page(url) fake: records URLs; body_or_map is either a callable
    url->str or a plain string returned for every URL."""
    calls = calls if calls is not None else []

    def fetch_page(url):
        calls.append(url)
        if callable(body_or_map):
            return body_or_map(url)
        return body_or_map

    return fetch_page, calls


GOOD_TEXT = "Kagi is a paid search engine. It blocks trackers by default. " * 12  # >200 chars
SCRIPT3 = [{"title": f"t{i}", "url": f"https://ex{i}.com/a", "snippet": f"s{i}"}
           for i in range(3)]


def tmp_state_dir():
    return Path(tempfile.mkdtemp(prefix="rtsearch-test-"))


# ── decomposition ──────────────────────────────────────────────────────────

def test_decompose_vs_question():
    subs = rt.decompose_question("Kagi vs DuckDuckGo for privacy and pricing in 2025")
    assert 2 <= len(subs) <= 4
    # the head-to-head stays one sub-query, both sides get their own
    assert any(" vs " in s for s in subs)
    assert any("kagi" in s.lower() and "vs" not in s.lower() for s in subs)
    assert any("duckduckgo" in s.lower() for s in subs)
    assert all(s.strip() for s in subs)


def test_decompose_and_or_connectors():
    subs = rt.decompose_question("rust or golang performance")
    assert 2 <= len(subs) <= 4
    assert any(" or " in s for s in subs)  # connector survives into combined
    assert any("rust" in s.lower() for s in subs)
    assert any("golang" in s.lower() for s in subs)


def test_decompose_single_clause_two_angles():
    subs = rt.decompose_question("how does kubernetes autoscaling work")
    assert len(subs) == 2
    assert subs[0] == "kubernetes autoscaling work"
    assert subs[1].endswith("overview")


def test_decompose_strips_stopwords_and_never_empty():
    subs = rt.decompose_question("What is the best?")
    assert len(subs) >= 2  # all-stopword question still yields queries
    # every word strips to a stopword → the raw clause is kept verbatim
    assert all(s.strip() for s in subs)
    assert "best" in subs[0].lower()
    assert rt._key_terms("Kagi for privacy") == "Kagi privacy"  # stopwords gone
    assert rt.decompose_question("") == []


def test_decompose_caps_at_four():
    subs = rt.decompose_question("a vs b and c or d plus e")
    assert len(subs) <= 4


# ── SSRF guard ─────────────────────────────────────────────────────────────

def test_ssrf_guard_blocks_private_and_non_http():
    blocked = [
        "http://127.0.0.1:8080/x", "http://127.8.8.8/",           # loopback
        "http://10.0.0.1/", "http://10.255.255.255/a",            # 10/8
        "http://192.168.1.1/", "http://192.168.0.0/",             # 192.168/16
        "http://169.254.169.254/latest/meta-data",                 # metadata
        "http://172.16.0.1/", "http://172.31.255.255/",            # 172.16-31
        "http://100.64.0.1/",                                      # CGNAT
        "http://0.0.0.0/", "http://0.1.2.3/",                      # 0/8
        "http://localhost/", "http://api.localhost/x", "http://foo.local/",
        "https://[::1]/x", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/",
        "http://[fe80::1]/", "http://[::]/",
        "file:///etc/passwd", "ftp://example.com/x", "gopher://x", "data:text/html,x",
        "", "not a url", "http://", "http://127.1/", "http://2130706433/",
    ]
    for u in blocked:
        assert not rt.is_public_http_url(u), f"should block {u!r}"


def test_ssrf_guard_allows_public():
    allowed = [
        "https://example.com/a?b=c", "http://example.org/",
        "https://duckduckgo.com/html/?q=x", "http://8.8.8.8/dns",
        "https://[2001:db8::1]/", "http://172.32.0.1/", "http://172.15.0.1/",
        "http://93.184.216.34/", "https://example.com:8443/path",
    ]
    for u in allowed:
        assert rt.is_public_http_url(u), f"should allow {u!r}"


def test_ssrf_guard_rejects_userinfo_trick():
    # https://evil@127.0.0.1/ — urlsplit().hostname is still the loopback
    assert not rt.is_public_http_url("https://evil@127.0.0.1/x")
    assert not rt.is_public_http_url("https://evil@example.com@10.0.0.1/")


# ── the loop ───────────────────────────────────────────────────────────────

def test_loop_runs_exactly_rounds_when_uncovered():
    rs, calls = make_search(SCRIPT3)
    rf, fcalls = make_fetch("short")  # < fetch_min_chars → never a good fetch
    events = []

    def on_round(rnd, queries, results, fetched):
        events.append((rnd, queries, results, fetched))

    out = rt.research_loop("kagi vs duckduckgo pricing", rounds=3,
                           run_search=rs, fetch_page=rf, on_round=on_round,
                           fetch_min_chars=200)
    assert out["rounds_run"] == 3            # nothing covered → all rounds used
    assert len(events) == 3
    assert [e[0] for e in events] == [1, 2, 3]
    assert out["gaps"] == [s["base"] for s in out["slots"]]
    # every pending sub-query is searched every round (none were dropped)
    n_slots = len(out["slots"])
    assert len(calls) == 3 * n_slots
    assert all(c[1] == 6 for c in calls)    # max_results default clamped


def test_loop_stops_early_when_covered():
    rs, _ = make_search(SCRIPT3)
    rf, fcalls = make_fetch(GOOD_TEXT)
    events = []

    def on_round(rnd, queries, results, fetched):
        events.append(rnd)

    out = rt.research_loop("kagi vs duckduckgo pricing", rounds=4,
                           run_search=rs, fetch_page=rf, on_round=on_round)
    assert out["rounds_run"] == 1           # round 1 covered everything
    assert events == [1]
    assert not out["gaps"]
    assert all(s["covered"] for s in out["slots"])
    assert all(s["src"] >= 1 for s in out["slots"])  # each has a [n] citation
    assert len(out["sources"]) == len(out["slots"])


def test_loop_clamps_rounds_and_results():
    calls = []
    rs, _ = make_search(SCRIPT3, calls)
    rf, _ = make_fetch(GOOD_TEXT)
    out = rt.research_loop("a vs b", rounds=99, max_results=999,
                           fetch_per_round=99, run_search=rs, fetch_page=rf)
    assert out["rounds_run"] <= 4           # rounds capped at 4 (covered r1 anyway)
    assert all(n <= 10 for _, n in calls)   # max_results capped at 10
    assert all(n >= 1 for _, n in calls)


def test_refinement_rotates_qualifiers():
    rs, _ = make_search([])                 # zero results → nothing covered
    rf, fcalls = make_fetch(GOOD_TEXT)
    out = rt.research_loop("rust vs golang performance", rounds=3,
                           run_search=rs, fetch_page=rf)
    assert out["rounds_run"] == 3
    assert fcalls == []                     # nothing to fetch without results
    r2 = out["rounds_log"][1]["queries"]
    r3 = out["rounds_log"][2]["queries"]
    assert all(q.endswith("latest 2025") for q in r2)
    assert all(q.endswith("news") for q in r3)
    assert all(q in ("rust vs golang performance latest 2025",
                     "rust latest 2025", "golang performance latest 2025") for q in r2)
    # covered rule: refinement only touches uncovered sub-queries
    assert all(rt.refine_query("base", a).startswith("base ") for a in (1, 2, 3, 4))
    assert rt.refine_query("base", 5).endswith("latest 2025")  # rotation wraps


def test_refinement_drops_covered_subqueries():
    # the bare "kagi" sub-query gets a good fetch, the others get nothing →
    # round 2 must search ONLY the uncovered slots, qualifiers attached
    calls = []

    def picky(query, n):
        calls.append(query)
        if query.strip().lower() == "kagi":
            return [{"title": "Kagi", "url": "https://kagi.example/x",
                     "snippet": "s"}]
        return []

    rf, _ = make_fetch(GOOD_TEXT)
    out = rt.research_loop("kagi vs duckduckgo pricing", rounds=2,
                           run_search=picky, fetch_page=rf)
    round2 = out["rounds_log"][1]["queries"]
    assert "kagi" not in round2                          # dropped: covered
    assert len(round2) == len(out["slots"]) - 1
    assert all(q.endswith("latest 2025") for q in round2)  # uncovered: reworded


def test_seen_url_dedup():
    # same 3 URLs every round; failed fetches are never retried and repeat
    # discoveries are not re-counted as fresh hits
    rs, _ = make_search(SCRIPT3)
    rf, fcalls = make_fetch("tiny")
    out = rt.research_loop("kagi vs duckduckgo", rounds=3,
                           run_search=rs, fetch_page=rf)
    assert len(fcalls) == 3 and len(set(fcalls)) == 3    # each URL once, ever
    assert out["rounds_run"] == 3
    assert out["rounds_log"][0]["results"] == 3         # all fresh in round 1
    assert out["rounds_log"][1]["results"] == 0         # rounds 2-3: seen URLs
    assert out["rounds_log"][2]["results"] == 0
    assert sum(s["hits"] for s in out["slots"]) == 3     # counted once total


def test_within_round_url_dedup_one_claimant():
    # all sub-queries return the SAME top URL: one fetch, one claimant slot
    same = [{"title": "T", "url": "https://same.example/x", "snippet": "s"}]
    rs, _ = make_search(same)
    rf, fcalls = make_fetch(GOOD_TEXT)
    out = rt.research_loop("kagi vs ddg", rounds=1, run_search=rs, fetch_page=rf)
    assert fcalls == ["https://same.example/x"]
    assert sum(1 for s in out["slots"] if s["covered"]) == 1


def test_fetch_min_chars_threshold():
    rs, _ = make_search(SCRIPT3)
    rf, _ = make_fetch("x" * 199)         # just under the 200 default
    out = rt.research_loop("kagi vs ddg", rounds=1, run_search=rs, fetch_page=rf)
    assert not any(s["covered"] for s in out["slots"])


def test_search_exception_degrades_not_crashes():
    rs, _ = make_search(RuntimeError("backend exploded"))
    rf, fcalls = make_fetch(GOOD_TEXT)
    out = rt.research_loop("kagi vs ddg", rounds=2, run_search=rs, fetch_page=rf)
    assert out["rounds_run"] == 2
    assert fcalls == []                   # nothing to fetch
    assert out["search_errors"] or out["rounds_run"]


def test_backend_error_bails_after_round_one():
    rs, _ = make_search(rt.RtBackendError("search backend not installed — x"))
    rf, _ = make_fetch(GOOD_TEXT)
    out = rt.research_loop("kagi vs ddg", rounds=4, run_search=rs, fetch_page=rf)
    assert out["backend_error"] != ""
    assert out["rounds_run"] == 1         # no point repeating a dead backend


# ── synthesis ──────────────────────────────────────────────────────────────

def _partial_cover_run():
    """kagi side gets a good page; ddg side never does → 1 covered, gaps."""
    def picky(query, n):
        if "kagi" in query.lower() and "vs" not in query.lower():
            return [{"title": "Kagi FAQ", "url": "https://kagi.example/faq",
                     "snippet": "kagi privacy"}]
        return [{"title": "DDG", "url": "https://ddg.example/about", "snippet": "ddg"}]

    rf, _ = make_fetch(lambda u: GOOD_TEXT if "kagi" in u else "tiny")
    return rt.research_loop("kagi vs duckduckgo privacy", rounds=2,
                            run_search=picky, fetch_page=rf, fetch_min_chars=200)


def test_synthesis_source_markers_and_gaps():
    out = _partial_cover_run()
    brief = rt.synthesize_brief(out["question"], out["slots"], out["sources"],
                                out["rounds_run"])
    assert "RESEARCH BRIEF" in brief
    assert "[1]" in brief                                  # excerpt carries its [n]
    assert "SOURCES" in brief and "https://kagi.example/faq" in brief
    assert "fetched" in brief                              # fetched-at timestamps
    assert "GAPS" in brief
    assert "not covered:" in brief and "duckduckgo" in brief
    # the [n] in FINDINGS matches a numbered entry in SOURCES
    src_lines = [l for l in brief.splitlines() if l.strip().startswith("[1]")]
    assert src_lines


def test_brief_char_caps():
    long_text = ("Sentence with plenty of words in it here now. " * 200)
    out = rt.research_loop("kagi vs ddg privacy", rounds=2,
                           run_search=lambda q, n: [
                               {"title": "T", "url": f"https://x{i}.example/a",
                                "snippet": "s"} for i in range(2)],
                           fetch_page=lambda u: long_text, fetch_min_chars=200)
    assert all(len(s["excerpt"]) <= 400 for s in out["sources"])
    brief = rt.synthesize_brief(out["question"], out["slots"], out["sources"],
                                out["rounds_run"])
    assert len(brief) <= 6000
    assert len(rt.pick_excerpt("word " * 900)) <= 400
    assert len(rt.pick_excerpt("")) == 0


def test_excerpts_prefer_complete_sentences():
    text = "One complete sentence here. Two sentences follow along nicely. Plus dross"
    exc = rt.pick_excerpt(text, max_chars=60)
    assert exc.endswith("…") and "dross" not in exc


# ── state + action layer ───────────────────────────────────────────────────

def test_state_round_trip_and_report():
    d = tmp_state_dir()
    logs = []
    rs, _ = make_search([{"title": "T", "url": "https://a.example/x",
                          "snippet": "s"}])
    rf, _ = make_fetch(GOOD_TEXT)
    out_txt = rt.run_research(d, "kagi vs duckduckgo pricing", rounds=2,
                              run_search=rs, fetch_page=rf,
                              log=lambda e, **f: logs.append((e, f)))
    assert "RESEARCH BRIEF" in out_txt and "research_id:" in out_txt
    assert len(out_txt) <= 6000
    # round progress events carry the exact spec fields
    rounds = [f for e, f in logs if e == "rtsearch_round"]
    assert rounds and all(set(("round", "queries", "results", "fetched")) <= set(f)
                          for f in rounds)
    assert any(e == "rtsearch_done" for e, _ in logs)
    rid = out_txt.split("research_id: ")[1].split(" ")[0].strip()

    st = json.loads((d / "research.json").read_text(encoding="utf-8"))
    assert rid in st["records"] and st["order"][-1] == rid
    rec = st["records"][rid]
    assert rec["question"] == "kagi vs duckduckgo pricing"
    assert rec["sources"] and rec["slots"] and "brief" in rec

    rep = rt.do_report(d, rid)
    assert "RESEARCH BRIEF" in rep and rid in rep and len(rep) <= 6100
    assert "rtsearch research runs" in rt.do_report(d)          # empty id → list
    assert "no research found" in rt.do_report(d, "rnope")      # unknown id


def test_state_atomic_and_bounded():
    d = tmp_state_dir()
    p = d / "research.json"
    rs, _ = make_search([])
    rf, _ = make_fetch(GOOD_TEXT)
    for i in range(rt._MAX_RECORDS + 4):
        rt.run_research(d, f"question number {i}", rounds=1,
                        run_search=rs, fetch_page=rf)
    st = rt._load_state(p)
    assert len(st["order"]) <= rt._MAX_RECORDS
    assert len(st["records"]) <= rt._MAX_RECORDS
    assert set(st["records"]) == set(st["order"])               # no orphans
    assert not (d / "research.json.tmp").exists()               # atomic replace
    # malformed state file degrades to empty, never crashes
    p.write_text("{not json", encoding="utf-8")
    assert rt._load_state(p) == {"records": {}, "order": []}
    assert "no research runs stored yet" in rt.do_report(d)


def test_actions_search_and_fetch_offline():
    d = tmp_state_dir()
    # search with injected backend: formatted rows
    msg = rt.do_search("kagi pricing", max_results=3,
                       search_fn=lambda q, n: [
                           {"title": "Kagi", "url": "https://kagi.example/faq",
                            "snippet": "pricing page"}])
    assert "1. Kagi — https://kagi.example/faq" in msg
    assert "pricing page" in msg
    # SSRF-bad results are filtered out of search output
    msg2 = rt.do_search("x", search_fn=lambda q, n: [
        {"title": "Bad", "url": "http://127.0.0.1/x", "snippet": "s"},
        {"title": "Ok", "url": "https://ok.example/a", "snippet": "s"}])
    assert "127.0.0.1" not in msg2 and "ok.example" in msg2
    assert "empty query" in rt.do_search("   ")
    # fetch action: guard + cap + fake backend
    assert "refused" in rt.do_fetch("http://10.0.0.1/x")
    assert "refused" in rt.do_fetch("file:///etc/passwd")
    assert "empty url" in rt.do_fetch("")
    out = rt.do_fetch("https://example.com/a", fetch_fn=lambda u: "z" * 9000)
    assert len(out) <= 6100 and "truncated" in out
    out2 = rt.do_fetch("https://example.com/a", fetch_fn=lambda u: "short page")
    assert out2 == "short page"
    assert "fetch failed" in rt.do_fetch(
        "https://example.com/a", fetch_fn=lambda u: (_ for _ in ()).throw(RuntimeError("boom")))


def test_missing_backend_clean_message():
    # patch the lazy DDG importer → the live search path degrades to a clean,
    # actionable string instead of an ImportError traceback
    orig = rt._import_ddgs
    rt._import_ddgs = lambda: None
    try:
        msg = rt.do_search("anything")
        assert "duckduckgo-search" in msg and "pip install" in msg
        rl = rt.research_loop("kagi vs ddg", rounds=3, run_search=None,
                              fetch_page=lambda u: GOOD_TEXT)
        assert rl["backend_error"] != "" and rl["rounds_run"] == 1
        rr = rt.run_research(tmp_state_dir(), "kagi vs ddg", rounds=2,
                             run_search=None, fetch_page=lambda u: GOOD_TEXT)
        assert "search backend not installed" in rr and "No research was run" in rr
        assert "research_id" not in rr                  # no junk record saved
    finally:
        rt._import_ddgs = orig


def test_dispatch_help_and_unknown():
    d = tmp_state_dir()
    h = rt.dispatch_action(d, action="help")
    for verb in ("research", "search", "fetch", "report", "help"):
        assert verb in h
    assert "unknown action" in rt.dispatch_action(d, action="explode")
    assert "empty question" in rt.dispatch_action(d, action="research")
    assert "empty query" in rt.dispatch_action(d, action="search", query="")
    # full action surface through the same dispatcher the strands tool uses
    rs, _ = make_search([{"title": "T", "url": "https://a.example/x", "snippet": "s"}])
    rf, _ = make_fetch(GOOD_TEXT)
    out = rt.dispatch_action(d, action="research", question="kagi vs ddg",
                             rounds="2", run_search=rs, fetch_page=rf)
    assert "RESEARCH BRIEF" in out                       # string rounds coerced


def test_build_offline_returns_empty_and_never_raises():
    ctx = dt_registry.ToolContext(workspace=Path(tempfile.mkdtemp(prefix="rtctx-")))
    assert rt.build(ctx) == []          # strands not installed here
    assert rt.build(None) == []         # broken ctx must not raise either


def test_registry_manifest_lists_rtsearch():
    man = dt_registry.tool_manifest()
    assert "dt_rtsearch" in man
    assert man["dt_rtsearch"]["names"] == ["rtsearch"]
    assert "loop" in man["dt_rtsearch"]["doc"].lower()
    # the registry loader builds nothing offline but never crashes
    ctx = dt_registry.ToolContext(workspace=Path(tempfile.mkdtemp(prefix="rtload-")))
    tools = dt_registry.load_doomalay_tools(ctx)
    assert isinstance(tools, list)


# ── standalone runner ──────────────────────────────────────────────────────

def _all_tests():
    return [(n, f) for n, f in sorted(globals().items())
            if n.startswith("test_") and callable(f)]


if __name__ == "__main__":
    failed = 0
    for name, fn in _all_tests():
        try:
            fn()
            print(f"  ok: {name}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL: {name}: {e}")
        except Exception as e:  # noqa: BLE001 — a crash is a failure too
            failed += 1
            print(f"  ERROR: {name}: {type(e).__name__}: {e}")
    print(f"{'ALL TESTS PASSED' if not failed else f'{failed} FAILURES'} "
          f"({len(_all_tests())} tests)")
    sys.exit(0 if not failed else 1)
