"""test_dt_journal.py — offline unit tests for tools/dt_journal.py (S4).

Runs BOTH ways (dt_spec rule 8):
    python3 brain/tests/test_dt_journal.py     (standalone, exit 0/1)
    pytest brain/tests/test_dt_journal.py      (plain asserts, no fixtures)

No network, no strands, no engine: every test drives the PLAIN core over
in-memory entry lists, plus `run_action` over a temp JSONL file for the IO
seam. `NOW` is pinned (Sunday 2025-06-15 12:00 UTC) so streaks, ranges,
windows and trend math are deterministic.
"""
from __future__ import annotations

import json
import sys
import tempfile
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Import the module by path so the file runs from any CWD (and so pytest
# collecting brain/tests/ finds it without a package dance).
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "tools"))
import dt_journal as dj  # noqa: E402

NOW = datetime(2025, 6, 15, 12, 0, tzinfo=timezone.utc)   # Sunday
NOW2 = NOW + timedelta(seconds=1)   # a distinct (date, created) key on the same day

try:
    import strands  # noqa: F401
    HAVE_STRANDS = True
except Exception:
    HAVE_STRANDS = False


# ── helpers ─────────────────────────────────────────────────────────────

def _add(entries, d, text="entry text", hh="09", **kw):
    """One well-formed entry on date `d` at hour `hh` (distinct hours give
    same-day entries distinct created stamps so they don't hit the dedup
    key — the same way real writes carry microseconds)."""
    fields = {"text": text, "date": d, "created": f"{d}T{hh}:00:00+00:00"}
    fields.update(kw)
    return dj.add_entry(entries, fields, NOW)[0]


def _history(mood_by_offset, **kw):
    """Entries for {days_back_from_today: mood} — one per day, in order."""
    entries = []
    for off in sorted(mood_by_offset):
        d = (NOW.date() - timedelta(days=off)).isoformat()
        _add(entries, d, text=f"day minus {off}", mood=mood_by_offset[off], **kw)
    return entries


def _week(moods, week_back=0, **kw):
    """A 7-day run (oldest→newest) ending `week_back` weeks before today."""
    return _history({off + 7 * week_back: m
                     for off, m in zip(range(6, -1, -1), moods)}, **kw)


class _Ctx:
    """The ToolContext subset djournal's build() touches (offline fake)."""

    def __init__(self, tmp):
        self.workspace = Path(tmp)

    def tool_state(self, tool):
        d = self.workspace / tool
        d.mkdir(parents=True, exist_ok=True)
        return d

    def log(self, *a, **k):
        pass


def _raises(fn, *a, **kw):
    try:
        fn(*a, **kw)
        return None
    except ValueError as exc:
        return str(exc)


# ── mood normalization ──────────────────────────────────────────────────

def test_mood_scale_numbers():
    assert dj.mood_scale(1) == 1 and dj.mood_scale(5) == 5
    assert dj.mood_scale("3") == 3 and dj.mood_scale("5") == 5
    assert dj.mood_scale(3.6) == 4          # rounding, not truncation
    assert dj.mood_scale("2.4") == 2
    assert dj.mood_scale("3.0") == 3
    assert dj.mood_scale(4.5) == 4          # banker's round — deterministic
    # out-of-range numbers are garbage, never clamped into fake data
    assert dj.mood_scale("0") is None
    assert dj.mood_scale(0) is None
    assert dj.mood_scale("9") is None
    assert dj.mood_scale(-2) is None
    assert dj.mood_scale(float("nan")) is None
    assert dj.mood_scale(float("inf")) is None


def test_mood_scale_words():
    assert dj.mood_scale("great") == 5
    assert dj.mood_scale("GOOD") == 4       # case-insensitive
    assert dj.mood_scale("  Ok ") == 3      # whitespace tolerated
    assert dj.mood_scale("low") == 2
    assert dj.mood_scale("awful") == 1
    assert dj.mood_scale("so-so") == 3
    assert dj.mood_scale("Amazing") == 5


def test_mood_scale_emoji():
    assert dj.mood_scale("😀") == 5
    assert dj.mood_scale("🔥") == 5
    assert dj.mood_scale("🙂") == 4
    assert dj.mood_scale("👍") == 4
    assert dj.mood_scale("😐") == 3
    assert dj.mood_scale("🙁") == 2
    assert dj.mood_scale("😢") == 1
    assert dj.mood_scale("🙂.") == 4        # first emoji in a mixed string
    assert dj.mood_scale("mood: 😐") == 3


def test_mood_scale_garbage_is_none():
    assert dj.mood_scale("banana") is None
    assert dj.mood_scale("meh?") is None    # punctuation makes it garbage
    assert dj.mood_scale("123abc") is None
    assert dj.mood_scale(None) is None
    assert dj.mood_scale("") is None
    assert dj.mood_scale(True) is None      # bool is an int subclass — rejected
    assert dj.mood_scale([]) is None


def test_mood_warn_in_write_confirmation():
    entries = []
    e = _add(entries, "2025-06-15", text="meh day", mood="banana", energy="11")
    assert e["mood"] is None                # garbage → stored as None
    assert e["energy"] is None
    out = dj._confirm(e, True, entries, NOW, raw_mood="banana", raw_energy="11")
    assert "mood 'banana' not recognized" in out
    assert "energy '11' not recognized" in out
    # a VALID mood on a deduped replay must NOT be blamed (the replay
    # returns an older entry; warnings key off the raw input)
    out = dj._confirm(e, False, entries, NOW, raw_mood="4", raw_energy="")
    assert "not recognized" not in out


# ── add_entry: shape, word count, suffix marker, dedup, validation ───────

def test_add_entry_basic_shape():
    entries = []
    e = _add(entries, "2025-06-10", text="one two three four", mood="good",
             tags="work, focus", highlights="shipped v0.43",
             gratitude="coffee, sun", energy="3")
    assert e["id"] == "2025-06-10"
    assert e["date"] == "2025-06-10"
    assert e["created"] == "2025-06-10T09:00:00+00:00"
    assert e["mood"] == 4
    assert e["tags"] == ["work", "focus"]
    assert e["highlights"] == ["shipped v0.43"]
    assert e["gratitude"] == ["coffee", "sun"]
    assert e["energy"] == 3
    assert e["word_count"] == 4             # computed, never trusted from input
    assert entries == [e]


def test_add_entry_defaults_to_today_and_now():
    entries = []
    e, created = dj.add_entry(entries, {"text": "defaulted"}, NOW)
    assert created is True
    assert e["date"] == "2025-06-15"
    assert e["created"] == NOW.isoformat()
    assert e["mood"] is None and e["energy"] is None
    assert e["tags"] == [] and e["highlights"] == [] and e["gratitude"] == []


def test_add_entry_same_day_suffix_marker():
    entries = []
    _add(entries, "2025-06-10", text="first of the day")
    e2 = _add(entries, "2025-06-10", text="second of the day", hh="10")
    e3 = _add(entries, "2025-06-10", text="third of the day", hh="11")
    assert e2["id"] == "2025-06-10#2"
    assert e3["id"] == "2025-06-10#3"
    assert len(entries) == 3


def test_add_entry_exact_dedup():
    entries = []
    e1 = _add(entries, "2025-06-10", text="original")
    e2, created = dj.add_entry(entries, {
        "text": "replay with different text but same (date, created) key",
        "date": "2025-06-10", "created": "2025-06-10T09:00:00+00:00",
    }, NOW)
    assert created is False                 # idempotent replay — no append
    assert e2 is e1
    assert len(entries) == 1


def test_add_entry_validation_errors():
    assert "text is required" in _raises(dj.add_entry, [], {"text": ""}, NOW)
    assert "text is required" in _raises(dj.add_entry, [], {"text": "   "}, NOW)
    assert "not an ISO date" in _raises(
        dj.add_entry, [], {"text": "x", "date": "junk-date"}, NOW)
    assert "not an ISO datetime" in _raises(
        dj.add_entry, [], {"text": "x", "created": "not-a-time"}, NOW)
    # a garbage mood is NOT a validation error — stored as None + warned
    e = _add([], "2025-06-10", text="fine", mood="zzz")
    assert e["mood"] is None


def test_as_list_forms():
    assert dj._as_list(None) == []
    assert dj._as_list("") == []
    assert dj._as_list("a, b") == ["a", "b"]
    assert dj._as_list("a;b\nc") == ["a", "b", "c"]
    assert dj._as_list("#work, #calm") == ["work", "calm"]   # '#' normalized
    assert dj._as_list([" x ", "", "y"]) == ["x", "y"]


# ── range / period parsing ──────────────────────────────────────────────

def test_parse_range():
    assert dj.parse_range("today", NOW) == (date(2025, 6, 15),) * 2
    assert dj.parse_range("yesterday", NOW) == (date(2025, 6, 14),) * 2
    assert dj.parse_range("2025-06-10", NOW) == (date(2025, 6, 10),) * 2
    assert dj.parse_range("2025-06-01..2025-06-30", NOW) == \
        (date(2025, 6, 1), date(2025, 6, 30))
    assert dj.parse_range("2025-06-01...2025-06-30", NOW) == \
        (date(2025, 6, 1), date(2025, 6, 30))               # '...' tolerated
    assert dj.parse_range("2025-06-30..2025-06-01", NOW) == \
        (date(2025, 6, 1), date(2025, 6, 30))               # reversed → swapped
    assert dj.parse_range("last 7", NOW) == (date(2025, 6, 9), date(2025, 6, 15))
    assert dj.parse_range("last 3 days", NOW) == (date(2025, 6, 13), date(2025, 6, 15))
    assert dj.parse_range("week", NOW) == (date(2025, 6, 9), date(2025, 6, 15))
    assert dj.parse_range("month", NOW) == (date(2025, 5, 17), date(2025, 6, 15))
    assert dj.parse_range("bananas", NOW) is None
    assert dj.parse_range("", NOW) is None
    assert dj.parse_range("2025-13-45", NOW) is None


def test_parse_period():
    assert dj.parse_period("week", NOW) == (date(2025, 6, 9), date(2025, 6, 15), "week")
    assert dj.parse_period("", NOW) == (date(2025, 6, 9), date(2025, 6, 15), "week")
    assert dj.parse_period("month", NOW) == (date(2025, 5, 17), date(2025, 6, 15), "month")
    assert dj.parse_period("last 10", NOW) == (date(2025, 6, 6), date(2025, 6, 15),
                                               "last 10 days")
    assert dj.parse_period("10", NOW) == (date(2025, 6, 6), date(2025, 6, 15),
                                          "last 10 days")
    assert dj.parse_period("year", NOW) is None


# ── read ────────────────────────────────────────────────────────────────

def _read_corpus():
    entries = []
    _add(entries, "2025-06-10", text="river day", mood=4)
    _add(entries, "2025-06-12", text="deep work", mood=3)
    _add(entries, "2025-06-12", text="evening walk", hh="20", mood=4)
    _add(entries, "2025-06-14", text="quiet day", mood=2)
    _add(entries, "2025-06-15", text="shipping day", mood=5)
    return entries


def test_read_entries_target_forms():
    entries = _read_corpus()
    out = dj.read_entries(entries, "today", NOW)
    assert "shipping day" in out and "quiet day" not in out
    out = dj.read_entries(entries, "yesterday", NOW)
    assert "quiet day" in out and "deep work" not in out
    out = dj.read_entries(entries, "2025-06-12", NOW)
    assert "deep work" in out and "evening walk" in out
    assert "2 entries · 2025-06-12" in out                # both same-day ids
    assert "2025-06-12#2" in out
    out = dj.read_entries(entries, "2025-06-09..2025-06-13", NOW)
    assert "river day" in out and "deep work" in out
    assert "quiet day" not in out and "shipping day" not in out
    out = dj.read_entries(entries, "last 3", NOW)         # 06-13..06-15
    assert "quiet day" in out and "shipping day" in out
    assert "river day" not in out


def test_read_entries_errors_and_empty():
    entries = _read_corpus()
    assert "couldn't parse" in dj.read_entries(entries, "bananas", NOW)
    out = dj.read_entries(entries, "2025-05-01", NOW)
    assert "no entries" in out and "action='write'" in out
    out = dj.read_entries([], "today", NOW)
    assert "no entries" in out


def test_read_entry_card_format():
    entries = []
    _add(entries, "2025-06-14", text="walked far\nthen rested", mood=2,
         tags="walk", highlights="ten thousand steps", gratitude="shade",
         energy="1")
    out = dj.read_entries(entries, "2025-06-14", NOW)
    assert "── 2025-06-14 · Sat 09:00 ──" in out
    assert "mood 🙁 low 2/5 · energy 1/5 · 4 words" in out
    assert "#walk" in out and "ten thousand steps" in out and "shade" in out


# ── search ──────────────────────────────────────────────────────────────

def _search_corpus():
    entries = []
    _add(entries, "2025-06-10",
         text="walked by the river\nhad coffee at the pier",
         mood=4, tags="river, walk", highlights="shipped v0.43",
         gratitude="morning sun")
    _add(entries, "2025-06-11", text="standup about kimi", mood=2, tags="work")
    _add(entries, "2025-06-14", text="kimi deadline crunch", mood=4,
         highlights="kimi plan written")
    return entries


def test_search_in_text_with_context_lines():
    entries = _search_corpus()
    out = dj.search_entries(entries, "river", in_field="text", now=NOW)
    assert "1 matching entry" in out
    assert ">> walked by the river" in out          # the hit line, marked
    assert "   had coffee at the pier" in out       # one context line under it


def test_search_in_tags_and_highlights():
    entries = _search_corpus()
    out = dj.search_entries(entries, "river", in_field="tags", now=NOW)
    assert "tags: #river" in out                       # the MATCHING tag is shown
    assert "standup" not in out
    out = dj.search_entries(entries, "kimi", in_field="highlights", now=NOW)
    assert "kimi plan written" in out
    assert "standup about kimi" not in out          # text field not searched
    out = dj.search_entries(entries, "kimi", in_field="all", now=NOW)
    assert "2 matching entries" in out


def test_search_mood_filter():
    entries = _search_corpus()
    out = dj.search_entries(entries, "kimi", mood="good", now=NOW)
    assert "1 matching entry" in out
    assert "kimi deadline crunch" in out
    assert "standup about kimi" not in out          # mood 2 filtered out
    # an unparseable mood filter WARNS instead of silently narrowing
    out = dj.search_entries(entries, "kimi", mood="banana", now=NOW)
    assert "mood 'banana' not recognized — filter skipped" in out
    assert "2 matching entries" in out


def test_search_date_range_and_misses():
    entries = _search_corpus()
    out = dj.search_entries(entries, "kimi", date_range="2025-06-13..2025-06-15",
                            now=NOW)
    assert "kimi deadline crunch" in out
    assert "standup about kimi" not in out
    assert "no matching entries for 'zzz'" in dj.search_entries(entries, "zzz", now=NOW)
    assert "needs a query" in dj.search_entries(entries, "", now=NOW)
    assert "in_field must be" in dj.search_entries(entries, "kimi",
                                                   in_field="banana", now=NOW)
    assert "couldn't parse date_range" in dj.search_entries(
        entries, "kimi", date_range="junk", now=NOW)


# ── review math ─────────────────────────────────────────────────────────

def test_review_avg_and_trend_up():
    entries = _week([2, 2, 3, 1, 2, 3, 2], week_back=1) + \
        _week([4, 4, 5, 5, 4, 3, 4], week_back=0)
    out = dj.review_summary(entries, "week", NOW)
    assert "Journal review — week (2025-06-09..2025-06-15)" in out
    assert "entries: 7" in out
    assert "avg mood: 4.1/5 ↑ vs previous period (2.1)" in out
    assert "best day: 2025-06-11 (5.0/5)" in out
    assert "worst day: 2025-06-14 (3.0/5)" in out


def test_review_trend_down_and_steady():
    entries = _week([4, 5, 4, 5, 4, 4, 5], week_back=1) + \
        _week([2, 2, 3, 2, 3, 2, 2], week_back=0)
    out = dj.review_summary(entries, "week", NOW)
    assert "avg mood: 2.3/5 ↓ vs previous period (4.4)" in out
    entries = _week([3] * 7, week_back=1) + _week([3] * 7, week_back=0)
    out = dj.review_summary(entries, "week", NOW)
    assert "avg mood: 3.0/5 → vs previous period (3.0)" in out


def test_review_no_previous_period():
    out = dj.review_summary(_week([4, 4, 5]), "week", NOW)
    assert "— no earlier entries to compare" in out


def test_review_distribution_bar_length():
    entries = _week([4, 4, 5, 5, 4, 3, 4])
    out = dj.review_summary(entries, "week", NOW)
    # the bar is EXACTLY 5 columns (one per mood level) — pinned so a
    # mis-sized bar can't silently misalign the legend
    import re
    m = re.search(r"mood distribution: (.{5})  \(", out)
    assert m, out
    assert m.group(1) == "  ▁▅▂"            # counts 1:0 2:0 3:1 4:4 5:2
    assert "(1:0 2:0 3:1 4:4 5:2)" in out


def test_review_tags_highlights_gratitude():
    entries = _week([4, 4, 5, 5, 4, 3, 4], tags="work",
                    highlights="shipped the thing", gratitude="coffee")
    out = dj.review_summary(entries, "week", NOW)
    assert "top tags: #work×7" in out
    assert "shipped the thing" in out
    assert "gratitude items: 7" in out


def test_review_period_parsing_and_empty():
    assert "couldn't parse period 'year'" in dj.review_summary([], "year", NOW)
    out = dj.review_summary(_week([4, 4, 5]), "last 3", NOW)
    assert "Journal review — last 3 days" in out
    out = dj.review_summary([], "week", NOW)
    assert "entries: 0" in out
    assert "no entries in this period" in out
    assert "streak: 0d" in out
    assert "last entry: never" in out


# ── streaks (incl. gaps) ────────────────────────────────────────────────

def test_streaks_gaps_and_grace():
    assert dj.streaks([], NOW) == (0, 0)
    # current run 3 (13th→15th), an older run of 5 with a gap in between
    entries = _history({0: 4, 1: 3, 2: 4, 14: 3, 15: 3, 16: 2, 17: 3, 18: 3})
    assert dj.streaks(entries, NOW) == (3, 5)
    # yesterday-grace: last entry yesterday keeps a streak alive today
    assert dj.streaks(_history({1: 3}), NOW) == (1, 1)
    # stale: nothing today or yesterday → current 0, longest survives
    assert dj.streaks(_history({5: 3, 6: 3}), NOW) == (0, 2)
    # single entry today
    assert dj.streaks(_history({0: 3}), NOW) == (1, 1)
    # two entries on one day count once — day streak, not entry streak
    entries = []
    _add(entries, "2025-06-15", text="a")
    _add(entries, "2025-06-15", text="b", hh="20")
    assert dj.streaks(entries, NOW) == (1, 1)


def test_days_since_last():
    assert dj.days_since_last([], NOW) is None
    assert dj.days_since_last(_history({0: 3}), NOW) == 0
    assert dj.days_since_last(_history({3: 3}), NOW) == 3
    # future-dated entry (clock skew) clamps at 0, no negative nonsense
    assert dj.days_since_last(_history({-2: 3}), NOW) == 0


# ── prompt rotation ─────────────────────────────────────────────────────

def test_prompt_rotation_determinism():
    assert dj.pick_prompt(172) == dj.pick_prompt(172)     # same day → same prompt
    assert dj.pick_prompt(172) != dj.pick_prompt(173)     # next day → next prompt
    assert dj.pick_prompt(173) != dj.pick_prompt(174)
    assert dj.pick_prompt(0) == dj.pick_prompt(45)        # wraps after the list
    assert dj.pick_prompt(-1) == dj.pick_prompt(44)       # Python modulo ≥ 0
    assert dj.pick_prompt(400).startswith("[")


def test_prompt_pool():
    assert len(dj.PROMPTS) >= 40                          # spec: 40+ prompts
    assert len(dj.PROMPTS) == 45
    cats = {c for c, _ in dj.PROMPTS}
    assert cats == {"reflection", "gratitude", "future-self",
                    "challenge", "relationships"}
    texts = [t for _, t in dj.PROMPTS]
    assert len(set(texts)) == len(texts)                  # no duplicate prompts
    assert all(t.strip() and len(t) < 200 for t in texts)


# ── export ──────────────────────────────────────────────────────────────

def test_export_json_round_trip():
    entries = _read_corpus()
    out = dj.export_entries(entries, "json", now=NOW)
    assert json.loads(out) == entries                     # faithful round-trip


def test_export_json_range_filter():
    entries = _read_corpus()
    out = dj.export_entries(entries, "json", target="2025-06-14..2025-06-15",
                            now=NOW)
    back = json.loads(out)
    assert [e["date"] for e in back] == ["2025-06-14", "2025-06-15"]
    assert back == dj._window_sorted(entries, (date(2025, 6, 14), date(2025, 6, 15)))


def test_export_markdown():
    entries = _read_corpus()
    out = dj.export_entries(entries, "md", target="2025-06-14..2025-06-15", now=NOW)
    assert "## 2025-06-14" in out and "## 2025-06-15" in out
    assert "2025-06-10" not in out and "2025-06-12" not in out
    assert "quiet day" in out
    assert "export format must be md or json" in dj.export_entries(entries, "csv")


# ── empty-state behaviors ───────────────────────────────────────────────

def test_empty_state_actions():
    assert "no entries" in dj.read_entries([], "today", NOW)
    assert "no matching entries" in dj.search_entries([], "anything", now=NOW)
    assert "nothing to chart" in dj.mood_timeline([], now=NOW)
    assert dj.export_entries([], "json", now=NOW) == "[]"
    out = dj.review_summary([], "week", NOW)
    assert "entries: 0" in out and "streak: 0d (longest 0d)" in out


# ── JSONL IO + run_action end-to-end (the strands-free dispatcher) ──────

def test_run_action_write_read_lifecycle():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    p = tmp / dj.STATE_FILE
    out = dj.run_action(p, "help")
    for verb in ("write", "read", "search", "review", "moods", "prompt",
                 "export", "help"):
        assert verb in out
    out = dj.run_action(p, "write", text="first entry\nsecond line",
                        mood="good", tags="test, meta", now=NOW)
    assert "Saved journal entry 2025-06-15" in out
    assert "4 words" in out                                 # "first entry\nsecond line"
    assert "streak: 1d" in out
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["text"] == "first entry\nsecond line"
    # same-day second write → suffix marker + a second JSONL line
    out = dj.run_action(p, "write", text="later that day", now=NOW2)
    assert "2025-06-15#2" in out
    assert len(p.read_text(encoding="utf-8").strip().splitlines()) == 2
    # exact (date, created) replay → idempotent, log does not grow
    out = dj.run_action(p, "write", text="replayed", now=NOW2)
    assert "Already saved" in out
    assert len(p.read_text(encoding="utf-8").strip().splitlines()) == 2
    # read shows both, in write order
    out = dj.run_action(p, "read", target="today", now=NOW)
    assert "first entry" in out and "later that day" in out
    assert out.index("first entry") < out.index("later that day")
    assert "no entries" in dj.run_action(p, "read", target="yesterday", now=NOW)


def test_run_action_all_actions_and_errors():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    p = tmp / dj.STATE_FILE
    dj.run_action(p, "write", text="the river ran quietly", mood="ok",
                  now=NOW)
    assert "1 matching entry" in dj.run_action(p, "search", query="river", now=NOW)
    assert "avg mood: 3.0/5" in dj.run_action(p, "review", now=NOW)
    assert "timeline" in dj.run_action(p, "moods", now=NOW)
    assert dj.run_action(p, "prompt", now=NOW).startswith("[")
    out = dj.run_action(p, "export", fmt="json", now=NOW)
    data = json.loads(out.split("\n\n(export saved")[0])
    assert len(data) == 1 and data[0]["mood"] == 3
    assert (tmp / "export.json").exists()
    out = dj.run_action(p, "export", fmt="md", now=NOW)
    assert "## 2025-06-15" in out and (tmp / "export.md").exists()
    # degrade-don't-crash surface
    assert "unknown action" in dj.run_action(p, "frobnicate", now=NOW)
    assert "text is required" in dj.run_action(p, "write", text=" ", now=NOW)
    assert "not an ISO date" in dj.run_action(p, "write", text="x",
                                             date="whenever", now=NOW)
    out = dj.run_action(p, "write", text="meh", mood="banana", now=NOW2)
    assert "mood 'banana' not recognized" in out
    assert "couldn't parse" in dj.run_action(p, "read", target="soon", now=NOW)
    assert "couldn't parse period" in dj.run_action(p, "review", period="era", now=NOW)


def test_run_action_write_confirmation_streak():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    p = tmp / dj.STATE_FILE
    dj.run_action(p, "write", text="two days ago", date="2025-06-13", now=NOW)
    dj.run_action(p, "write", text="yesterday", date="2025-06-14", now=NOW)
    out = dj.run_action(p, "write", text="today extends the run", now=NOW)
    assert "streak: 3d (longest 3d)" in out


def test_run_action_append_only_growth():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    p = tmp / dj.STATE_FILE
    dj.run_action(p, "write", text="day one", date="2025-06-13", now=NOW)
    first = p.read_text(encoding="utf-8").strip()
    dj.run_action(p, "write", text="day two", date="2025-06-14", now=NOW)
    dj.run_action(p, "write", text="day three", date="2025-06-15", now=NOW)
    raw = p.read_text(encoding="utf-8")
    lines = raw.strip().splitlines()
    assert len(lines) == 3
    assert lines[0].strip() == first                       # history never rewritten


def test_load_entries_skips_corrupt_lines():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    p = tmp / dj.STATE_FILE
    good1 = json.dumps({"id": "2025-06-13", "date": "2025-06-13", "created": "x",
                        "text": "a", "mood": 3, "tags": [], "highlights": [],
                        "gratitude": [], "energy": None, "word_count": 1})
    good2 = json.dumps({"id": "2025-06-14", "date": "2025-06-14", "created": "y",
                        "text": "b", "mood": 4, "tags": [], "highlights": [],
                        "gratitude": [], "energy": None, "word_count": 1})
    p.write_text(good1 + "\n{broken json line\n\n" + good2 + "\n",
                 encoding="utf-8")
    entries = dj.load_entries(p)
    assert len(entries) == 2                               # corrupt + blank skipped
    assert [e["date"] for e in entries] == ["2025-06-13", "2025-06-14"]
    idx = dj.index_entries(entries)
    assert set(idx) == {"2025-06-13", "2025-06-14"}
    entries2, idx2 = dj.load_state(p)                      # load + index in one step
    assert entries2 == entries and set(idx2) == set(idx)


def test_output_cap():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    p = tmp / dj.STATE_FILE
    # 12 fat entries: each card is ~750 chars after the per-entry snip, so
    # the READ total (~9k chars) trips the 6000-char reply cap
    for i in range(12):
        dj.run_action(p, "write", text="word " * 200,
                      date=(NOW.date() - timedelta(days=11 - i)).isoformat(),
                      now=NOW.replace(microsecond=i))
    out = dj.run_action(p, "read", target="last 12", now=NOW)
    assert len(out) > dj.MAX_OUT or "trimmed" in out     # cap actually engaged
    assert len(out) <= dj.MAX_OUT
    assert "trimmed" in out and str(p) in out


def test_build_degrades_without_strands():
    tmp = Path(tempfile.mkdtemp(prefix="djournal-test-"))
    tools = dj.build(_Ctx(tmp))
    assert isinstance(tools, list)                         # never raises, returns a list
    if not HAVE_STRANDS:
        assert tools == []                                 # offline: registers nothing
    else:
        assert len(tools) == 1 and tools[0].__name__ == "djournal"
        out = tools[0](action="write", text="through the real decorator")
        assert "Saved journal entry" in out


# ── standalone runner (python3 brain/tests/test_dt_journal.py) ──────────

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    sys.exit(1 if failed else 0)
