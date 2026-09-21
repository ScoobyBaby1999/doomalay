"""test_dt_timemgr.py — offline unit tests for brain/tools/dt_timemgr.py.

Runs two ways (dt_spec rule 8):
    python3 brain/tests/test_dt_timemgr.py     ← standalone, exit 0/1
    pytest brain/tests/test_dt_timemgr.py      ← collected as test_* fns

No network, no strands, no engine — every call goes through the plain
functions with a FIXED clock (`now` injected), so "today"/"friday" are
deterministic. NOW is a Wednesday 2025-06-04 10:00:
  today=06-04 · tomorrow=06-05 · friday=06-06 · sunday (week end)=06-08
  monday=06-09 · "next week"=06-11 · "in 2 weeks"=06-18
"""
from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import dt_timemgr as tm  # noqa: E402

NOW = datetime(2025, 6, 4, 10, 0)          # Wednesday
FRI_NOW = datetime(2025, 6, 6, 9, 0)       # a Friday, for the never-past edge


def fresh():
    """Bare-dict state pair — the whole core runs without file IO."""
    return {"tasks": [], "templates": []}, {"active": None,
                                             "sessions": [], "daily": {}}


# ── parse_when: every documented form + garbage → raw passthrough ──────

def test_parse_when_relative_words():
    assert tm.parse_when("today", NOW)["due"] == "2025-06-04"
    assert tm.parse_when("tonight", NOW)["due"] == "2025-06-04"
    assert tm.parse_when("tomorrow", NOW)["due"] == "2025-06-05"
    assert tm.parse_when("tmr", NOW)["due"] == "2025-06-05"
    assert tm.parse_when("yesterday", NOW)["due"] == "2025-06-03"
    assert tm.parse_when("next week", NOW)["due"] == "2025-06-11"
    assert tm.parse_when("next month", NOW)["due"] == "2025-07-04"
    assert tm.parse_when("next year", NOW)["due"] == "2026-06-04"


def test_parse_when_in_units():
    assert tm.parse_when("in 3 days", NOW)["due"] == "2025-06-07"
    assert tm.parse_when("in 2 weeks", NOW)["due"] == "2025-06-18"
    assert tm.parse_when("in a couple of days", NOW)["due"] == "2025-06-06"
    assert tm.parse_when("in one week", NOW)["due"] == "2025-06-11"
    assert tm.parse_when("in 1 month", NOW)["due"] == "2025-07-04"
    # hours produce a datetime due, not a bare date
    assert tm.parse_when("in 3 hours", NOW)["due"] == "2025-06-04T13:00"


def test_parse_when_iso_and_month_day():
    assert tm.parse_when("2025-12-01", NOW)["due"] == "2025-12-01"
    assert tm.parse_when("2025/12/1", NOW)["due"] == "2025-12-01"
    assert tm.parse_when("2025-12-01 14:30", NOW)["due"] == "2025-12-01T14:30"
    assert tm.parse_when("2025-12-01T14:30", NOW)["due"] == "2025-12-01T14:30"
    assert tm.parse_when("dec 1", NOW)["due"] == "2025-12-01"
    assert tm.parse_when("december 1st", NOW)["due"] == "2025-12-01"
    assert tm.parse_when("1 dec", NOW)["due"] == "2025-12-01"
    assert tm.parse_when("dec 1 2026", NOW)["due"] == "2026-12-01"
    # month-day already past this year rolls to next year (calendar behavior)
    assert tm.parse_when("may 5", NOW)["due"] == "2026-05-05"
    assert tm.parse_when("june 30", NOW)["due"] == "2025-06-30"
    # impossible dates are garbage, not crashes
    assert tm.parse_when("2025-02-30", NOW)["parsed"] is False
    assert tm.parse_when("feb 31", NOW)["parsed"] is False


def test_parse_when_weekdays_next_never_past():
    # bare weekday: next occurrence, today counts — never in the past
    assert tm.parse_when("friday", NOW)["due"] == "2025-06-06"
    assert tm.parse_when("on friday", NOW)["due"] == "2025-06-06"
    assert tm.parse_when("wednesday", NOW)["due"] == "2025-06-04"  # today
    assert tm.parse_when("monday", NOW)["due"] == "2025-06-09"
    # "next X" is strictly AFTER today
    assert tm.parse_when("next monday", NOW)["due"] == "2025-06-09"
    # THE edge: on a Friday, "friday" = today, "next friday" = +7d
    assert tm.parse_when("friday", FRI_NOW)["due"] == "2025-06-06"
    assert tm.parse_when("next friday", FRI_NOW)["due"] == "2025-06-13"
    assert tm.parse_when("next friday", NOW)["due"] == "2025-06-06"
    # every weekday, both nows: result date must never be before today
    for wd in ("monday", "tuesday", "wednesday", "thursday", "friday",
               "saturday", "sunday"):
        for ref in (NOW, FRI_NOW):
            d = tm.parse_when(wd, ref)
            assert d["parsed"] and d["due"] >= tm._iso_date(ref.date()), wd
            nd = tm.parse_when("next " + wd, ref)
            assert nd["parsed"] and nd["due"] > tm._iso_date(ref.date()), wd


def test_parse_when_garbage_passthrough():
    for junk in ("someday", "when pigs fly", "eventually??", "13 fruit",
                 "next quarter", "", "   ", None):
        r = tm.parse_when(junk, NOW)
        assert r["parsed"] is False and r["due"] is None, junk


# ── add / list / complete / delete round-trip ──────────────────────────

def test_add_list_complete_delete_roundtrip():
    st, _ = fresh()
    # add needs a title (error is a string, never an exception)
    t0, err = tm.add_task(st, {"title": "  "}, NOW)
    assert t0 is None and "title" in err
    t, msg = tm.add_task(st, {"title": "Ship v0.43", "priority": "high",
                              "due": "friday", "tags": "release, v43",
                              "subtasks": "bump version, tag, upload",
                              "notes": "the big one"}, NOW)
    assert t["id"] in msg and t["due"] == "2025-06-06"
    assert t["priority"] == "high" and t["status"] == "todo"
    assert t["tags"] == ["release", "v43"] and len(t["subtasks"]) == 3
    assert t["created"] and t["completed"] is None
    assert len(t["id"]) == 6 and all(c in "0123456789abcdef" for c in t["id"])
    # default priority is medium (old-app default)
    t2, _ = tm.add_task(st, {"title": "chore"}, NOW)
    assert t2["priority"] == "medium" and t2["due"] is None
    # invalid priority → helpful error, state untouched
    _, perr = tm.add_task(st, {"title": "x", "priority": "mega"}, NOW)
    assert perr and "urgent" in perr and len(st["tasks"]) == 2

    out = tm.list_tasks(st, now=NOW)
    assert "Ship v0.43" in out and "chore" in out
    assert "OVERDUE" not in out            # nothing overdue yet
    # complete: stamps completed-at, leaves subtasks alone (spec)
    done_msg = tm.complete_task(st, t["id"], NOW)
    assert done_msg.startswith("Completed") and t["completed"]
    assert t["status"] == "done"
    assert not any(s["done"] for s in t["subtasks"])  # no cascade
    assert "left open" in done_msg          # 3 subtasks still open
    # double-complete is a no-op message
    assert "already" in tm.complete_task(st, t["id"], NOW)
    # done tasks are hidden by default, visible via status=all
    assert "Ship v0.43" not in tm.list_tasks(st, now=NOW)
    assert "Ship v0.43" in tm.list_tasks(st, status="all", now=NOW)
    assert "✓" in tm.list_tasks(st, status="done", now=NOW)
    # delete removes it for real
    dmsg = tm.delete_task(st, t["id"])
    assert dmsg.startswith("Deleted") and len(st["tasks"]) == 1
    assert tm.complete_task(st, t["id"], NOW).startswith("task")
    assert tm.delete_task(st, "zzzzzz").startswith("task")


def test_add_unparsed_due_keeps_raw_and_warns():
    st, _ = fresh()
    t, msg = tm.add_task(st, {"title": "Read Dune", "due": "someday"}, NOW)
    assert t["due"] == "someday" and t.get("due_unparsed") is True
    assert "could not parse" in msg and "someday" in msg
    out = tm.list_tasks(st, now=NOW)
    assert "someday" in out and "⚠" in out
    assert tm.bucket_of("someday", NOW) == "No date"   # never crashes grouping


# ── grouping boundaries: overdue vs today vs tomorrow vs week vs later ──

def test_bucket_boundaries():
    assert tm.bucket_of("2025-06-03", NOW) == "Overdue"
    assert tm.bucket_of("2025-06-04", NOW) == "Today"
    assert tm.bucket_of("2025-06-05", NOW) == "Tomorrow"
    assert tm.bucket_of("2025-06-06", NOW) == "This week"   # friday
    assert tm.bucket_of("2025-06-08", NOW) == "This week"   # sunday = edge
    assert tm.bucket_of("2025-06-09", NOW) == "Later"       # next monday
    assert tm.bucket_of(None, NOW) == "No date"
    assert tm.bucket_of("", NOW) == "No date"
    assert tm.bucket_of("2025-06-04T23:59", NOW) == "Today"  # time ignored
    assert tm.bucket_of("2025-06-04T00:01", FRI_NOW) == "Overdue"


def test_list_grouping_render():
    st, _ = fresh()
    for title, due in (("old", "2025-06-01"), ("now", "today"),
                       ("soon", "tomorrow"), ("week", "friday"),
                       ("later", "2025-06-20"), ("never", None)):
        tm.add_task(st, {"title": title, "due": due}, NOW)
    out = tm.list_tasks(st, now=NOW)
    # groups appear in fixed order and only when non-empty
    order = [out.find(g) for g in ("OVERDUE", "TODAY", "TOMORROW",
                                   "THIS WEEK", "LATER", "NO DATE")]
    assert all(i >= 0 for i in order) and order == sorted(order)
    assert "counts" not in out.lower()
    assert out.startswith("⌘ 6 open")
    # priority sort inside a group: urgent before medium
    tm.add_task(st, {"title": "urgent overdue", "priority": "urgent",
                     "due": "2025-06-01"}, NOW)
    body = tm.list_tasks(st, now=NOW)
    assert body.find("urgent overdue") < body.find("\nold\n") or \
        body.find("urgent overdue") < body.find("  old")


def test_list_filters():
    st, _ = fresh()
    tm.add_task(st, {"title": "A", "priority": "high", "tags": "work",
                     "due": "today"}, NOW)
    tm.add_task(st, {"title": "B", "priority": "low", "tags": "home",
                     "due": "2025-06-20"}, NOW)
    tm.add_task(st, {"title": "C", "priority": "high"}, NOW)
    assert "A" in tm.list_tasks(st, priority="high", now=NOW)
    assert "B" not in tm.list_tasks(st, priority="high", now=NOW)
    assert "A" in tm.list_tasks(st, tag="work", now=NOW)
    assert "B" not in tm.list_tasks(st, tag="work", now=NOW)
    assert "B" in tm.list_tasks(st, due_before="2025-06-21", now=NOW)
    assert "A" not in tm.list_tasks(st, due_before="2025-06-03",
                                    now=NOW)   # strictly before today
    assert "A" in tm.list_tasks(st, due_before="2025-06-04",
                                  now=NOW)     # on/before cutoff day
    assert "could not parse" in tm.list_tasks(st, due_before="blah",
                                              now=NOW)
    assert "status filter must" in tm.list_tasks(st, status="weird",
                                                 now=NOW)
    assert "No tasks yet" in tm.list_tasks({"tasks": [], "templates": []},
                                           now=NOW)


def test_month_calendar_view():
    st, _ = fresh()
    tm.add_task(st, {"title": "Call mom", "due": "2025-06-06"}, NOW)
    tm.add_task(st, {"title": "Done thing", "due": "2025-06-06"}, NOW)
    tm.complete_task(st, "zzz", NOW) if False else None
    tm.complete_task(st, st["tasks"][1]["id"], NOW)   # done → hidden
    cal = tm.month_calendar(st, "2025-06", NOW)
    assert "June 2025" in cal and "Su Mo Tu We Th Fr Sa" in cal
    assert "4*" in cal          # today marker (old calendar.js port)
    assert "6•" in cal          # task dot on the 6th
    assert "Call mom" in cal and "Done thing" not in cal
    cur = tm.month_calendar(st, "current", NOW)
    assert "June 2025" in cur
    assert "month must" in tm.month_calendar(st, "june", NOW)
    assert "month must" in tm.month_calendar(st, "2025-13", NOW)


def test_today_board():
    st, po = fresh()
    t1, _ = tm.add_task(st, {"title": "late thing", "due": "yesterday"}, NOW)
    tm.add_task(st, {"title": "today thing", "due": "today"}, NOW)
    tm.add_task(st, {"title": "wip thing", "priority": "low"}, NOW)
    tm.update_task(st, st["tasks"][2]["id"], {"status": "doing"}, NOW)
    b = tm.board(st, po, NOW)
    assert b.startswith("TODAY — Wednesday 2025-06-04")
    assert "OVERDUE" in b and "late thing" in b
    assert "DUE TODAY" in b and "today thing" in b
    assert "IN PROGRESS" in b and "wip thing" in b
    # suggestion: highest priority TODO (spec) — overdue medium beats
    # today's medium (priority, then earliest due); the doing task is
    # excluded because the suggestion pool is status=todo
    assert "Next up:" in b
    assert "late thing" in b.split("Next up:")[1]
    assert "wip thing" not in b.split("Next up:")[1]
    assert "Nothing on the plate" in tm.board({"tasks": [], "templates": []},
                                              po, NOW)
    # pomodoro status shows on the board when active
    tm.pomodoro(po, "start", task_id=t1["id"], minutes=25, now=NOW, state=st)
    assert "⏱" in tm.board(st, po, NOW)


# ── update ─────────────────────────────────────────────────────────────

def test_update_partial_fields():
    st, _ = fresh()
    t, _ = tm.add_task(st, {"title": "Old", "priority": "low"}, NOW)
    msg = tm.update_task(st, t["id"], {"title": "New", "priority": "high",
                                       "due": "friday", "tags": "a, b",
                                       "notes": "n"}, NOW)
    assert msg.startswith("Updated") and t["title"] == "New"
    assert t["priority"] == "high" and t["due"] == "2025-06-06"
    assert t["tags"] == ["a", "b"] and t["notes"] == "n"
    # 'none' clears due
    assert "cleared" in tm.update_task(st, t["id"], {"due": "none"}, NOW)
    assert t["due"] is None
    # bad values → error strings
    assert "priority must" in tm.update_task(st, t["id"],
                                             {"priority": "zz"}, NOW)
    assert "status must" in tm.update_task(st, t["id"], {"status": "zz"}, NOW)
    # status=done stamps completed; un-done clears the stamp
    tm.update_task(st, t["id"], {"status": "done"}, NOW)
    assert t["completed"] and t["status"] == "done"
    tm.update_task(st, t["id"], {"status": "todo"}, NOW)
    assert t["completed"] is None
    assert "nothing to update" in tm.update_task(st, t["id"], {}, NOW)
    assert tm.update_task(st, "zzzzzz", {"title": "x"}, NOW).startswith("task")


# ── subtasks ───────────────────────────────────────────────────────────

def test_subtask_ops():
    st, _ = fresh()
    t, _ = tm.add_task(st, {"title": "Lesson", "subtasks": "read, write"}, NOW)
    assert len(t["subtasks"]) == 2
    assert "0/3 done" in tm.sub_add(st, t["id"], "review")
    # by 1-based index
    assert "✓" in tm.sub_done(st, t["id"], "2")
    assert t["subtasks"][1]["done"] is True
    assert t["subtasks"][0]["done"] is False
    # by exact title, case-insensitive
    assert "✓" in tm.sub_done(st, t["id"], "READ")
    assert "already done" in tm.sub_done(st, t["id"], "read")
    # errors: out of range / unknown / no subtasks / needs a key
    assert "out of range" in tm.sub_done(st, t["id"], "9")
    assert "no subtask" in tm.sub_done(st, t["id"], "nap")
    assert "needs" in tm.sub_done(st, t["id"], " ")
    t2, _ = tm.add_task(st, {"title": "Bare"}, NOW)
    assert "no subtasks" in tm.sub_done(st, t2["id"], "1")
    assert "needs" in tm.sub_add(st, t2["id"], " ")
    assert tm.sub_done(st, "zzzzzz", "1").startswith("task")


# ── templates (old app's task templates) ───────────────────────────────

def test_template_save_list_apply():
    st, _ = fresh()
    # save from an existing task
    t, _ = tm.add_task(st, {"title": "Lesson", "priority": "high",
                            "due": "friday", "tags": "study",
                            "subtasks": "read, write", "notes": "n"}, NOW)
    msg = tm.tpl_save(st, "lesson", from_id=t["id"], now=NOW)
    assert msg.startswith("Template 'lesson' saved")
    tpl = st["templates"][0]
    assert tpl["title"] == "Lesson" and tpl["priority"] == "high"
    assert tpl["due"] == "2025-06-06" and tpl["uses"] == 0
    assert len(tpl["subtasks"]) == 2 and not tpl["subtasks"][0]["done"]
    # inline save + name sanitizing (old api_create_template rule)
    assert "Template 'deep_work'" in tm.tpl_save(
        st, "Deep Work!", fields={"title": "Deep work block",
                                  "priority": "urgent"}, now=NOW)
    names = {x["name"] for x in st["templates"]}
    assert "deep_work" in names            # stripped trailing underscore
    # tpl_list
    lst = tm.tpl_list(st)
    assert "lesson" in lst and "used 0×" in lst
    # apply: fresh task, uses counter, provenance field, subtasks reset
    before = len(st["tasks"])
    applied = tm.tpl_apply(st, "lesson", NOW)
    assert "applied →" in applied and len(st["tasks"]) == before + 1
    assert st["templates"][0]["uses"] == 1
    new_t = st["tasks"][-1]
    assert new_t["template"] == "lesson" and new_t["status"] == "todo"
    assert new_t["due"] == "2025-06-06"      # relative due re-resolved
    assert not any(s["done"] for s in new_t["subtasks"])
    # apply again later in the week: friday re-resolves vs the new now
    applied2 = tm.tpl_apply(st, "lesson", NOW + timedelta(days=2))
    assert st["tasks"][-1]["due"] == "2025-06-06"
    assert "applied →" in applied2
    # missing template errors
    assert "No template" in tm.tpl_apply(st, "nope", NOW)
    empty = {"tasks": [], "templates": []}
    assert "No templates" in tm.tpl_apply(empty, "x", NOW)
    assert "No templates yet" in tm.tpl_list(empty)
    # save validation
    assert "needs a name" in tm.tpl_save(st, "", fields={"title": "x"},
                                         now=NOW)
    assert "needs a title" in tm.tpl_save(st, "x", fields={}, now=NOW)
    # same-name save replaces but keeps the uses counter
    tm.tpl_save(st, "lesson", fields={"title": "Lesson v2"}, now=NOW)
    assert st["templates"][0]["title"] == "Lesson v2"
    assert st["templates"][0]["uses"] == 2
    assert len([x for x in st["templates"] if x["name"] == "lesson"]) == 1


# ── pomodoro: fake clock, computed remaining, capped totals ────────────

def test_pomodoro_fake_clock():
    st, po = fresh()
    t, _ = tm.add_task(st, {"title": "Focus target"}, NOW)
    # start unlinked
    msg = tm.pomodoro(po, "start", minutes=25, now=NOW, state=st)
    assert "Pomodoro started" in msg and po["active"]["minutes"] == 25
    assert po["active"]["epoch"] == NOW.timestamp()
    # computed-on-read: remaining is arithmetic, never a sleeping thread
    stat = tm.pomodoro(po, "status", now=NOW + timedelta(minutes=10))
    assert "15m left of 25m" in stat and "Focus target" not in stat
    # can't start a second one while running
    assert "already running" in tm.pomodoro(po, "start", now=NOW, state=st)
    # stop 40m in → elapsed capped at the planned 25 (no inflation)
    stopped = tm.pomodoro(po, "stop", now=NOW + timedelta(minutes=40))
    assert "25m focused" in stopped and "timer completed" in stopped
    assert po["active"] is None
    assert po["daily"]["2025-06-04"] == 25
    assert len(po["sessions"]) == 1
    s = po["sessions"][0]
    assert s["elapsed"] == 25 and s["finished"] is True and s["minutes"] == 25
    # stop with nothing running
    assert "No pomodoro running" in tm.pomodoro(po, "stop", now=NOW)
    # start linked to a task; stop early → partial, actual minutes counted
    tm.pomodoro(po, "start", task_id=t["id"], minutes=30, now=NOW, state=st)
    stat = tm.pomodoro(po, "status", now=NOW + timedelta(minutes=5))
    assert 'on "Focus target"' in stat
    partial = tm.pomodoro(po, "stop", now=NOW + timedelta(minutes=12))
    assert "12m focused" in partial and "left on the clock" in partial
    assert po["daily"]["2025-06-04"] == 37      # 25 + 12
    # unknown task id → error string
    assert "not found" in tm.pomodoro(po, "start", task_id="zzzzzz",
                                      now=NOW, state=st)
    # bad sub
    assert "sub must be" in tm.pomodoro(po, "pause", now=NOW)
    # log shows sessions + daily + today
    log = tm.pomodoro(po, "log", now=NOW)
    assert "Pomodoro log — 2 sessions" in log
    assert "Focus target" in log and "partial" in log
    assert "Daily focus: 06-04 37m" in log and "Today: 37m total" in log
    # minutes clamped into 1..180
    tm.pomodoro(po, "start", minutes=9999, now=NOW, state=st)
    assert po["active"]["minutes"] == 180
    tm.pomodoro(po, "stop", now=NOW)


# ── stats: buckets, open-by-priority, streak ───────────────────────────

def test_stats_buckets_and_streak():
    st, po = fresh()
    # backdate: one added+completed 2 days ago, one yesterday, two today
    t1, _ = tm.add_task(st, {"title": "a", "priority": "urgent"}, NOW)
    t2, _ = tm.add_task(st, {"title": "b", "priority": "high"}, NOW)
    t3, _ = tm.add_task(st, {"title": "c", "priority": "low"}, NOW)
    t4, _ = tm.add_task(st, {"title": "d"}, NOW)
    t5, _ = tm.add_task(st, {"title": "e", "priority": "urgent"}, NOW)  # stays open
    t1["created"] = tm._stamp(NOW - timedelta(days=2))
    t2["created"] = tm._stamp(NOW - timedelta(days=1))
    # backdate completions the way complete_task would: stamp + status
    t1["completed"] = tm._stamp(NOW - timedelta(days=2))
    t1["status"] = "done"
    t2["completed"] = tm._stamp(NOW - timedelta(days=1))
    t2["status"] = "done"
    tm.complete_task(st, t3["id"], NOW)
    s = tm.stats_view(st, po, NOW)
    assert "Stats — 2025-06-04 (last 7 days):" in s
    assert "2025-06-04  +3  ✓1" in s      # t3, t4, t5 today; t3 done today
    assert "2025-06-03  +1  ✓1" in s
    assert "2025-06-02  +1  ✓1" in s
    # open-by-priority counts OPEN tasks only: t5 urgent + t4 medium
    assert "urgent 1 · medium 1" in s and "2 open" in s
    # streak: 06-02 → 06-04 consecutive completion days = 3
    assert "Completion streak: 3 days (2025-06-04 → 2025-06-02)" in s
    # today missing from done_days → streak still counts through yesterday
    st2, _ = fresh()
    u, _ = tm.add_task(st2, {"title": "x"}, NOW)
    u["completed"] = tm._stamp(NOW - timedelta(days=1))
    assert "streak: 1 day" in tm.stats_view(st2, po, NOW)
    # empty stats don't crash
    s0 = tm.stats_view({"tasks": [], "templates": []}, po, NOW)
    assert "no task activity" in s0 and "all clear" in s0
    # today's add-count includes t5 (added today, still open)
    assert "2025-06-04  +3  ✓1" in s
    # focus line appears when the pomodoro daily total exists
    po["daily"]["2025-06-04"] = 25
    assert "Focus: 25m today" in tm.stats_view(st, po, NOW)


# ── search ─────────────────────────────────────────────────────────────

def test_search():
    st, _ = fresh()
    tm.add_task(st, {"title": "Buy milk", "tags": "groceries",
                     "notes": "the oat kind"}, NOW)
    tm.add_task(st, {"title": "Call mom"}, NOW)
    assert tm.search_tasks(st, " ", now=NOW).startswith("search needs")
    assert "Buy milk" in tm.search_tasks(st, "MILK", now=NOW)      # title
    assert "Buy milk" in tm.search_tasks(st, "groceries", now=NOW)  # tags
    assert "Buy milk" in tm.search_tasks(st, "oat", now=NOW)       # notes
    assert "Buy milk" in tm.search_tasks(
        st, st["tasks"][0]["id"][:3], now=NOW)                     # id prefix
    assert "Call mom" not in tm.search_tasks(st, "milk", now=NOW)
    assert "No match" in tm.search_tasks(st, "zebra", now=NOW)


# ── state IO: atomic writes, corrupt-file degrade ─────────────────────

def test_state_io_roundtrip_and_corrupt():
    tmp = Path(tempfile.mkdtemp(prefix="dt-timemgr-test-"))
    p = tmp / "tasks.json"
    st, _ = fresh()
    tm.add_task(st, {"title": "persisted", "due": "friday"}, NOW)
    tm._save_state(p, st)
    assert not (tmp / "tasks.json.tmp").exists()      # tmp cleaned up
    loaded = tm._load_state(p, tm.TASKS_DEFAULT)
    assert loaded["tasks"][0]["title"] == "persisted"
    assert json.loads(p.read_text(encoding="utf-8"))["tasks"] == st["tasks"]
    # defaults merged in when keys are missing (forward compat)
    p2 = tmp / "partial.json"
    p2.write_text('{"tasks": []}', encoding="utf-8")
    assert tm._load_state(p2, tm.TASKS_DEFAULT)["templates"] == []
    # corrupt file → default state, no crash (old-app localStorage fallback)
    p3 = tmp / "bad.json"
    p3.write_text("{not json", encoding="utf-8")
    assert tm._load_state(p3, tm.POMO_DEFAULT) == dict(tm.POMO_DEFAULT)
    # missing file → default
    assert tm._load_state(tmp / "missing.json", tm.POMO_DEFAULT)["active"] is None


# ── dispatch + help: the seams the strands wrapper calls ───────────────

def test_dispatch_end_to_end():
    st, po = fresh()
    out = tm.dispatch(st, po, "help", {}, NOW)
    assert out.startswith("timemgr —") and "pomodoro" in out
    assert tm.dispatch(st, po, "", {}, NOW).startswith("timemgr —")
    # unknown action is a string, never an exception
    assert tm.dispatch(st, po, "explode", {}, NOW).startswith("Unknown action")
    # full chat-shaped flow through dispatch (as the model would call it)
    r = tm.dispatch(st, po, "add", {"title": "Ship it", "priority": "urgent",
                                    "due": "today", "subtasks": "bump, tag"},
                    NOW)
    tid = st["tasks"][0]["id"]
    assert "Added" in r and tid in r
    assert tm.dispatch(st, po, "sub_done", {"id": tid, "index": "1"},
                       NOW).startswith("✓")
    assert "pomodoro" in tm.dispatch(st, po, "pomodoro_start",
                                     {"id": tid}, NOW)
    assert "pomodoro" in tm.dispatch(
        st, po, "pomodoro", {"sub": "status"},
        NOW + timedelta(minutes=10))
    tm.dispatch(st, po, "pomodoro", {"sub": "stop"}, NOW + timedelta(minutes=30))
    assert "TODAY —" in tm.dispatch(st, po, "today", {}, NOW)
    assert "June 2025" in tm.dispatch(st, po, "list", {"month": "2025-06"},
                                      NOW)
    assert "Stats —" in tm.dispatch(st, po, "stats", {}, NOW)
    assert "Deleted" in tm.dispatch(st, po, "delete", {"id": tid}, NOW)
    assert len(st["tasks"]) == 0 and po["active"] is None
    assert po["daily"]["2025-06-04"] == 25


def test_task_id_resolution():
    st, _ = fresh()
    t1, _ = tm.add_task(st, {"title": "one"}, NOW)
    tm.add_task(st, {"title": "two"}, NOW)
    # exact id resolves
    got, err = tm.resolve_task(st, t1["id"])
    assert got is t1 and err is None
    # unique prefix resolves (models half-type ids)
    got, err = tm.resolve_task(st, t1["id"][:3])
    assert got is t1 and err is None
    # empty / unknown / ambiguous are error strings
    assert tm.resolve_task(st, "")[1]
    assert "not found" in tm.resolve_task(st, "zzzzzz")[1]
    assert "ambiguous" not in tm.resolve_task(st, "")[1]


# ── standalone runner (pytest collects the same test_* fns) ────────────

if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS %s" % name)
        except AssertionError as exc:
            failed += 1
            print("FAIL %s: %s" % (name, exc))
        except Exception as exc:  # noqa: BLE001 — surface crashes loudly
            failed += 1
            print("ERROR %s: %s: %s" % (name, type(exc).__name__, exc))
    print("%d/%d passed" % (len(tests) - failed, len(tests)))
    sys.exit(1 if failed else 0)
