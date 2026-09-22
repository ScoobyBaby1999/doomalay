"""dt_timemgr.py — the old "timemanager" web app reborn as the `timemgr` chat tool.

Provenance (user: "the old time manager ... was rich and this app needs to
consume and include every old feature"). The old app (reference/timemanager/)
was a browser dashboard: task sidebar + editor, month calendar, task
templates, an event-log viewer, and a chat tool-use loop. Port map — every
user-visible old feature that maps to a chat tool (pure-DOM concerns skipped):

  old feature (file)                          → timemgr action
  ─────────────────────────────────────────────────────────────────────
  task CRUD + editor (js/tasks.js,            → add / update / complete /
  server.py api_create/update/delete_task)      delete / search
  priority low|medium|high, list sorting       → priority field (+ urgent),
  (js/tasks.js data-priority)                    sort order in every view
  due date field (server.py "date")            → due, natural dates, grouped
  month calendar w/ today marker (js/          → list month=YYYY-MM (text
  calendar.js) + Overdue/Today/… grouping        calendar) + date buckets
  task templates: scan/select/save (js/        → tpl_save / tpl_list /
  tasks.js, server.py api_*_template,            tpl_apply
  backend/templates/*.json)
  chat tools create_task / update_task /       → this whole tool (run_task
  delete_task / list_tasks / templates           now lives in the delegate
  (server.py execute_tool)                       sub-agent seam — not ours)
  event log viewer (js/log.js, /api/log)       → pomodoro log + stats
  "today" semantics (server default date)     → today daily board

New beyond the old app (S3 task spec): status todo|doing|done|deferred,
subtasks, tags, notes, search, pomodoro focus timer, 7-day stats + streak,
natural-language due dates. State persists in
workspace/.doomalay/timemgr/tasks.json (tasks + templates) and pomodoro.json
(active timer + session log + daily focus totals). ALL writes are atomic
(tmp + os.replace) — ported from the old app's oplog atomic_write_json,
which REFERENCE.md explicitly told us to port.

House rules honored (brain/tools/dt_spec.md): no strands import at module
top (only inside build()); build(ctx) never raises; core logic is plain
functions over a bare dict state so tests pass a fixed `now` and need no
SDK, no network, no engine. Errors are strings returned to the model.
"""
from __future__ import annotations

import calendar as _cal
import json
import os
import re
import secrets
from datetime import date, datetime, timedelta, timezone

TOOL_NAMES = ["timemgr"]

MAX_RETURN_CHARS = 6000   # dt_spec rule 9 — the wrapper trims, plain fns don't

PRIORITIES = ("urgent", "high", "medium", "low")
PRIORITY_RANK = {p: i for i, p in enumerate(PRIORITIES)}   # urgent sorts first
STATUSES = ("todo", "doing", "done", "deferred")
OPEN_STATUSES = ("todo", "doing", "deferred")

GROUP_ORDER = ("Overdue", "Today", "Tomorrow", "This week", "Later", "No date")

# 3-letter keys are unique across both sets (mon/tue/wed/thu/fri/sat/sun,
# jan/feb/mar/apr/may/jun/jul/aug/sep/oct/nov/dec) — cheap prefix dispatch.
_WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
_MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
           "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"]
_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
              "Saturday", "Sunday"]

# Words that mean "remove the due date / tags / subtasks" on update+tpl input.
CLEAR_WORDS = ("none", "clear", "-", "never", "unset")

_NUM_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "couple": 2, "few": 3,
              "three": 3, "several": 4, "four": 4, "five": 5, "six": 6,
              "seven": 7, "eight": 8, "nine": 9, "ten": 10, "dozen": 12}


# ═══════════════════════════════════════════════════════════════════
# time helpers — WHY a naive-local `now`: due dates are calendar-day
# concepts on the user's device (the old app used local dates everywhere);
# a UTC "today" would flip mid-evening for Asia/Shanghai users. Stamps
# stored on tasks are still ISO-8601 UTC (house rule) — _date_of converts
# them back to local days for grouping/stats, so both clocks round-trip.
# ═══════════════════════════════════════════════════════════════════

def _stamp(now: datetime) -> str:
    """ISO-8601 UTC stamp. Naive `now` is presumed local (Python semantics)."""
    try:
        if now.tzinfo is None:
            return now.astimezone(timezone.utc).isoformat()
        return now.astimezone(timezone.utc).isoformat()
    except Exception:
        return now.isoformat()          # degenerate clock — keep something


def _parse_dt(ts: str):
    """Parse an ISO stamp (aware or naive); None when unreadable."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def _date_of(ts) -> date | None:
    """ISO stamp → LOCAL calendar date (stats/grouping must bucket on the
    day the user lived, not the UTC day)."""
    dt = _parse_dt(ts) if isinstance(ts, str) else ts
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone()            # aware → local wall clock
    return dt.date()


def _iso_date(d: date) -> str:
    return d.isoformat()


def _shift_month(d: date, n: int) -> date:
    """d + n months, clamping the day (Jan 31 + 1 → Feb 28)."""
    y, m = d.year, d.month - 1 + n
    y, m = y + m // 12, m % 12 + 1
    return date(y, m, min(d.day, _cal.monthrange(y, m)[1]))


def _word_num(w: str) -> int | None:
    """'3' / 'a' / 'couple of' / 'three' → int; None when unrecognized."""
    w = str(w).strip().lower()
    w = re.sub(r"^(a|an)\s+", "", w)
    w = re.sub(r"\s+of$", "", w)
    if w.isdigit():
        return int(w)
    return _NUM_WORDS.get(w)


# ═══════════════════════════════════════════════════════════════════
# parse_when — the natural-date parser (plain, `now` injected)
# ═══════════════════════════════════════════════════════════════════

def parse_when(text, now: datetime) -> dict:
    """Parse a due-date phrase into {"due": iso, "parsed": True} or
    {"due": None, "parsed": False}.

    WHY the fallback contract: the caller keeps the raw string on the task
    and warns the user instead of guessing — a silently wrong due date is
    worse than an unparsed one (old app's chat never validated dates at
    all; this is the fix). Supported forms:

      today | tonight | tomorrow | tmr | tom | yesterday
      next week | next month | next year
      in 3 days / in a couple of weeks / in 2 months / in 3 hours
      friday | on friday | next friday      (next occurrence; NEVER past —
                                             bare weekday counts today,
                                             "next X" is strictly after today)
      2025-12-01 | 2025-12-01 14:30 | 2025-12-01T14:30 | 2025/12/01
      dec 1 | december 1st | 1 dec | dec 1 2026
                                             (month-day already past rolls
                                             to next year, like a calendar)
    """
    if text is None:
        return {"due": None, "parsed": False}
    s = str(text).strip().lower()
    if not s:
        return {"due": None, "parsed": False}
    today = now.date()

    # 1) explicit ISO date / datetime — the model's native format
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})"
                 r"(?:[t\s]+(\d{1,2}):(\d{2}))?$", s)
    if m:
        try:
            d = date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return {"due": None, "parsed": False}   # 2025-02-30 → garbage
        if m[4] is not None:
            return {"due": f"{_iso_date(d)}T{int(m[4]):02d}:{m[5]}",
                    "parsed": True}
        return {"due": _iso_date(d), "parsed": True}

    # 2) plain relative words
    rel = {"today": 0, "tonight": 0, "tomorrow": 1, "tmr": 1, "tom": 1,
           "yesterday": -1, "next week": 7, "next month": None,
           "next year": None}
    if s in rel:
        if s == "next month":
            return {"due": _iso_date(_shift_month(today, 1)), "parsed": True}
        if s == "next year":
            return {"due": _iso_date(_shift_month(today, 12)), "parsed": True}
        return {"due": _iso_date(today + timedelta(days=rel[s])),
                "parsed": True}

    # 3) "in N unit(s)" — N may be a numeral or a word ("a couple of")
    m = re.match(r"^in\s+(.+?)\s+(days?|weeks?|months?|hours?|hrs?)$", s)
    if m:
        n = _word_num(m[1])
        if n is None:
            return {"due": None, "parsed": False}
        unit = m[2]
        if unit.startswith("hour") or unit.startswith("hr"):
            t = (now + timedelta(hours=n)).replace(second=0, microsecond=0)
            return {"due": t.strftime("%Y-%m-%dT%H:%M"), "parsed": True}
        if unit.startswith("week"):
            n *= 7
        elif unit.startswith("month"):
            return {"due": _iso_date(_shift_month(today, n)), "parsed": True}
        return {"due": _iso_date(today + timedelta(days=n)), "parsed": True}

    # 4) weekday names, optional "on"/"next". Bare "friday" counts today
    #    (never past); "next friday" is the next one STRICTLY after today
    #    (today-is-friday → +7). Documented, deterministic, never retro.
    m = re.match(r"^(?:on\s+)?(next\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*$",
                 s)
    if m:
        ahead = (_WEEKDAYS[m[2]] - today.weekday()) % 7
        if m[1] and ahead == 0:
            ahead = 7
        return {"due": _iso_date(today + timedelta(days=ahead)),
                "parsed": True}

    # 5) month-day forms: "dec 1", "december 1st 2026", "1 dec"
    m = (re.match(r"^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?"
                  r"(?:\s+(\d{4}))?$", s)
         or re.match(r"^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?"
                     r"(?:\s+(\d{4}))?$", s))
    if m:
        if m.re.pattern.startswith("^([a-z]"):
            mon_tok, day_s, year = m[1], m[2], m[3]
        else:
            day_s, mon_tok, year = m[1], m[2], m[3]
        mon = _MONTHS.get(mon_tok[:3])
        if mon:
            day = int(day_s)
            y = int(year) if year else today.year
            # No explicit year + the date already passed → next year, the
            # way every calendar app resolves "dec 1" said in December.
            if not year:
                try:
                    if date(today.year, mon, day) < today:
                        y = today.year + 1
                except ValueError:
                    return {"due": None, "parsed": False}
            try:
                d = date(y, mon, day)
            except ValueError:
                return {"due": None, "parsed": False}
            return {"due": _iso_date(d), "parsed": True}

    return {"due": None, "parsed": False}      # garbage → raw passthrough


def _due_date(due) -> date | None:
    """Date part of a stored due value; None for absent/unparseable."""
    if not due:
        return None
    s = str(due)
    d = _parse_dt(s)
    if d is not None:
        return d.date()
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


# ═══════════════════════════════════════════════════════════════════
# state IO — atomic (tmp + os.replace), ported from the old app's
# oplog.atomic_write_json (REFERENCE.md P0 ask). A kill mid-write can
# never leave a half-file. Corrupt JSON degrades to the default state —
# the old app fell back to localStorage the same way.
# ═══════════════════════════════════════════════════════════════════

def _load_state(path, default: dict) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            # merge so a file missing new keys (older version) still works
            merged = dict(default)
            merged.update(data)
            for k, v in default.items():
                merged.setdefault(k, v)
            return merged
    except Exception:
        pass
    return dict(default)


def _save_state(path, data: dict) -> None:
    p = str(path)
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, p)               # atomic on POSIX — same filesystem


TASKS_DEFAULT = {"tasks": [], "templates": []}
POMO_DEFAULT = {"active": None, "sessions": [], "daily": {}}


# ═══════════════════════════════════════════════════════════════════
# task helpers
# ═══════════════════════════════════════════════════════════════════

def new_id(state) -> str:
    """6-hex id (old app used ms-epoch ints; hex reads better in chat and
    can't collide across devices). Retries on the astronomically rare dup."""
    ids = {t.get("id") for t in state.get("tasks", [])}
    for _ in range(8):
        i = secrets.token_hex(3)
        if i not in ids:
            return i
    return secrets.token_hex(4)


def resolve_task(state, tid):
    """Exact id, or a unique prefix (models typo). Returns (task, error)."""
    tid = str(tid or "").strip().lower()
    if not tid:
        return None, "which task? pass id= (see list)"
    tasks = state.get("tasks", [])
    for t in tasks:
        if str(t.get("id", "")).lower() == tid:
            return t, None
    hits = [t for t in tasks if str(t.get("id", "")).lower().startswith(tid)]
    if len(hits) == 1:
        return hits[0], None
    if len(hits) > 1:
        return None, ("id '%s' is ambiguous: %s" %
                      (tid, ", ".join(t["id"] for t in hits[:5])))
    return None, "task '%s' not found — try list or search first" % tid


def _norm_priority(v):
    """'' → medium (old-app default); invalid → (None, helpful error)."""
    p = str(v or "").strip().lower()
    if not p:
        return "medium", None
    if p in PRIORITIES:
        return p, None
    if p == "p0":
        return "urgent", None
    if p == "p1":
        return "high", None
    if p == "p2":
        return "low", None
    return None, "priority must be one of: %s (got '%s')" % (", ".join(PRIORITIES), p)


def _norm_status(v):
    s = str(v or "").strip().lower()
    if not s:
        return "todo", None
    if s in STATUSES:
        return s, None
    if s == "open":
        return "todo", None
    if s == "wip" or s == "progress":
        return "doing", None
    if s == "cancelled" or s == "canceled":
        return "deferred", None
    return None, "status must be one of: %s (got '%s')" % (", ".join(STATUSES), s)


def _as_tags(v) -> list:
    """tags arrive as list (dispatch) or comma/newline string (chat)."""
    if not v:
        return []
    if isinstance(v, str):
        parts = re.split(r"[,\n]", v)
    elif isinstance(v, (list, tuple)):
        parts = v
    else:
        parts = [v]
    out = []
    for p in parts:
        p = str(p).strip().lstrip("#").strip()
        if p:
            out.append(p)
    return out


def _as_subtasks(v) -> list:
    """subtasks: list of strings (spec) or dicts, or comma/newline text.
    Always normalized to [{"title": str, "done": bool}] — the old app never
    had subtasks; this shape is the S3 spec's."""
    if not v:
        return []
    if isinstance(v, str):
        parts = [p for p in re.split(r"[\n,]", v)]
    elif isinstance(v, (list, tuple)):
        parts = list(v)
    else:
        return []
    out = []
    for p in parts:
        if isinstance(p, dict):
            title = str(p.get("title") or p.get("name") or "").strip()
            done = bool(p.get("done") or p.get("completed"))
        else:
            title, done = str(p).strip(), False
        if title:
            out.append({"title": title, "done": done})
    return out


def bucket_of(due, now: datetime) -> str:
    """Which list bucket a due date lands in. Unparseable dues fall into
    'No date' (kept raw + flagged in the line, never crash the view)."""
    d = _due_date(due)
    if d is None:
        return "No date"
    today = now.date()
    if d < today:
        return "Overdue"
    if d == today:
        return "Today"
    if d == today + timedelta(days=1):
        return "Tomorrow"
    if d <= today + timedelta(days=(6 - today.weekday())):
        return "This week"           # calendar week, Mon–Sun
    return "Later"


def list_grouping(tasks, now: datetime) -> dict:
    """tasks → {bucket: [sorted tasks]}. Sort: priority, then earliest due
    (undated last), then oldest — the old app sorted by priority alone;
    due-ordering is the chat-native upgrade."""
    out = {g: [] for g in GROUP_ORDER}
    for t in tasks:
        out[bucket_of(t.get("due"), now)].append(t)
    for g in GROUP_ORDER:
        out[g].sort(key=_sort_key)
    return out


def _sort_key(t):
    d = _due_date(t.get("due"))
    return (PRIORITY_RANK.get(t.get("priority", "medium"), 2),
            d.isoformat() if d else "9999-12-31",
            str(t.get("created") or ""))


def _due_label(due, now: datetime) -> str:
    """'due 2025-06-06 (tomorrow)' / 'due "someday" ⚠' / ''."""
    if not due:
        return ""
    d = _due_date(due)
    if d is None:
        return 'due "%s" ⚠' % due           # unparsed raw kept verbatim
    diff = (d - now.date()).days
    if diff < 0:
        ctx = "%dd late" % -diff
    elif diff == 0:
        ctx = "today"
    elif diff == 1:
        ctx = "tomorrow"
    elif diff < 14:
        ctx = "in %dd" % diff
    else:
        ctx = d.isoformat()
    tm = ""
    s = str(due)
    if "T" in s:
        tm = " " + s.split("T")[1][:5]
    elif " " in s:
        tm = " " + s.split(" ")[1][:5]
    return "due %s%s (%s)" % (d.isoformat(), tm, ctx)


def _fmt_task(t, now: datetime, with_notes: bool = False) -> str:
    """One dense chat line per task (old sidebar row + editor fields)."""
    tid = t.get("id", "?")
    title = str(t.get("title") or "Untitled")
    if len(title) > 48:
        title = title[:46] + "…"
    if t.get("status") == "done":
        line = "%s ✓ %s" % (tid, title)
        cd = _date_of(t.get("completed"))
        if cd:
            line += " — completed %s" % _iso_date(cd)
        line += " [%s]" % t.get("priority", "medium")
        return line
    line = "%s  %s  [%s]" % (tid, title, t.get("priority", "medium"))
    dl = _due_label(t.get("due"), now)
    if dl:
        line += "  " + dl
    st = t.get("status")
    if st in ("doing", "deferred"):
        line += "  · %s" % st
    subs = t.get("subtasks") or []
    if subs:
        line += "  · %d/%d sub" % (sum(1 for s in subs if s.get("done")),
                                   len(subs))
    tags = t.get("tags") or []
    if tags:
        line += "  " + " ".join("#" + g for g in tags[:6])
    if with_notes and t.get("notes"):
        n = str(t["notes"])
        line += "  — " + (n[:60] + "…" if len(n) > 60 else n)
    return line


def _counts(state) -> str:
    """Shared counts tail: '3 open, 2 done'."""
    tasks = state.get("tasks", [])
    open_n = sum(1 for t in tasks if t.get("status") != "done")
    return "%d open, %d done" % (open_n, len(tasks) - open_n)


def _open_tasks(state):
    return [t for t in state.get("tasks", []) if t.get("status") != "done"]


# ═══════════════════════════════════════════════════════════════════
# actions — plain functions; every one mutates `state` in place and
# returns a string (or (task, string) for add/apply). All take `now`.
# ═══════════════════════════════════════════════════════════════════

def add_task(state, fields: dict, now: datetime):
    """Create a task (old api_create_task + tasks.js addTask). Returns
    (task, msg) — (None, error-string) on bad input. due: '' → undated
    (the old app defaulted to today; the today board's suggestion line
    now surfaces undated work instead, so 'No date' is a real bucket)."""
    title = str(fields.get("title") or "").strip()
    if not title:
        return None, ('add needs a title — e.g. action="add" '
                      'title="Ship v0.43" priority="high" due="friday"')
    pri, err = _norm_priority(fields.get("priority"))
    if err:
        return None, err
    due_raw = str(fields.get("due") or "").strip()
    due, unparsed = None, False
    if due_raw and due_raw.lower() not in CLEAR_WORDS:
        r = parse_when(due_raw, now)
        if r["parsed"]:
            due = r["due"]
        else:
            due, unparsed = due_raw, True      # keep raw + warn (contract)
    task = {
        "id": new_id(state),
        "title": title,
        "priority": pri,
        "due": due,
        "tags": _as_tags(fields.get("tags")),
        "subtasks": _as_subtasks(fields.get("subtasks")),
        "notes": str(fields.get("notes") or ""),
        "status": "todo",
        "created": _stamp(now),
        "completed": None,
    }
    if unparsed:
        task["due_unparsed"] = True
    state.setdefault("tasks", []).append(task)
    msg = 'Added %s "%s" [%s]' % (task["id"], title, pri)
    dl = _due_label(due, now)
    if dl:
        msg += " " + dl
    if task["tags"]:
        msg += " · %d tag%s" % (len(task["tags"]),
                                "s" if len(task["tags"]) != 1 else "")
    if task["subtasks"]:
        msg += " · %d subtask%s" % (len(task["subtasks"]),
                                    "s" if len(task["subtasks"]) != 1 else "")
    msg += " — %s" % _counts(state)
    if unparsed:
        msg += ('\n⚠ could not parse due date "%s" — kept verbatim. '
                'Try: today, tomorrow, friday, next week, in 3 days, '
                '2025-12-01, dec 1.' % due_raw)
    return task, msg


def list_tasks(state, status: str = "", priority: str = "", tag: str = "",
               due_before: str = "", limit: int = 50,
               now: datetime | None = None) -> str:
    """Grouped task list (old sidebar, upgraded): Overdue / Today /
    Tomorrow / This week / Later / No date + counts header. Default view
    is OPEN tasks — the old app had no done-state so 'everything' was
    open; done shows up via status='done' or 'all'."""
    now = now or datetime.now()
    status = (status or "").strip().lower()
    if status and status not in ("open", "all") + STATUSES:
        return "status filter must be one of: open, all, %s" % ", ".join(STATUSES)
    if priority and priority.lower() not in PRIORITIES:
        return "priority filter must be one of: %s" % ", ".join(PRIORITIES)
    tasks = state.get("tasks", [])
    sel = [t for t in tasks if t.get("status") != "done"]
    if status == "all":
        sel = list(tasks)
    elif status in STATUSES:
        sel = [t for t in tasks if t.get("status") == status]
    if priority:
        sel = [t for t in sel if t.get("priority") == priority.lower()]
    if tag:
        tg = tag.strip().lstrip("#").lower()
        sel = [t for t in sel if any(str(g).lower() == tg
                                     for g in (t.get("tags") or []))]
    if due_before:
        r = parse_when(due_before, now)
        cutoff = _due_date(r["due"]) if r["parsed"] else None
        if cutoff is None:
            return 'could not parse due_before "%s" — try 2025-06-06 or friday' % due_before
        # unparsed dues can't be compared — excluded, flagged in the footer
        sel = [t for t in sel
               if _due_date(t.get("due")) is not None
               and _due_date(t.get("due")) <= cutoff]

    groups = list_grouping(sel, now)
    all_open = _open_tasks(state)
    over = sum(1 for t in all_open if bucket_of(t.get("due"), now) == "Overdue")
    tod = sum(1 for t in all_open if bucket_of(t.get("due"), now) == "Today")
    done_n = len(tasks) - len(all_open)
    head = "⌘ %d open · %d overdue · %d due today · %d done" % (
        len(all_open), over, tod, done_n)
    filt = []
    if status:
        filt.append("status=%s" % status)
    if priority:
        filt.append("priority=%s" % priority)
    if tag:
        filt.append("tag=%s" % tag.lstrip("#"))
    if due_before:
        filt.append("due_before=%s" % due_before)
    if filt:
        head += "  (filter: %s)" % " ".join(filt)

    try:
        limit = max(1, min(200, int(limit)))
    except (TypeError, ValueError):
        limit = 50

    if not sel:
        if not tasks:
            return head + "\nNo tasks yet — add one: action=\"add\" title=\"...\""
        return head + "\nNo tasks match this filter."
    lines = [head]
    shown = 0
    for g in GROUP_ORDER:
        if not groups[g]:
            continue
        lines.append("%s (%d)" % (g.upper(), len(groups[g])))
        for t in groups[g]:
            if shown >= limit:
                lines.append("  … +%d more (raise limit=, currently %d)"
                             % (len(sel) - shown, limit))
                return "\n".join(lines)
            lines.append("  " + _fmt_task(t, now))
            shown += 1
    if any(t.get("due_unparsed") for t in sel):
        lines.append('⚠ some due dates are unparsed text (shown with ⚠) — '
                     'update id= due=friday to fix')
    return "\n".join(lines)


def month_calendar(state, ym: str, now: datetime | None = None) -> str:
    """Text month calendar — direct port of js/calendar.js: month grid,
    tasks on their due days, today highlighted. Sunday-first columns and
    'day cell + task' rendering match the old grid; done tasks hidden
    (the old app had no done concept — every task it showed was open)."""
    now = now or datetime.now()
    ym = (ym or "").strip().lower()
    if ym in ("", "current", "this month", "now"):
        y, m = now.year, now.month
    else:
        mm = re.match(r"^(\d{4})-(\d{1,2})$", ym)
        if not mm:
            return 'month must look like YYYY-MM (e.g. 2025-06) or "current"'
        y, m = int(mm[1]), int(mm[2])
        if not 1 <= m <= 12:
            return "month must be 1–12, got %d" % m
    tasks = _open_tasks(state)
    by_day: dict[str, list] = {}
    for t in tasks:
        d = _due_date(t.get("due"))
        if d and d.year == y and d.month == m:
            by_day.setdefault(_iso_date(d), []).append(t)
    first_wd = date(y, m, 1).isoweekday() % 7      # Sun=0 like JS getDay()
    ndays = _cal.monthrange(y, m)[1]
    today = now.date()
    lines = ["%s %d — %d open task%s on %d day%s" % (
        _MONTH_NAMES[m - 1], y, len(sum(by_day.values(), [])),
        "s" if len(sum(by_day.values(), [])) != 1 else "",
        len(by_day), "s" if len(by_day) != 1 else "")]
    lines.append("Su Mo Tu We Th Fr Sa   (* today · • has tasks)")
    row = ["   "] * first_wd
    for day in range(1, ndays + 1):
        d = date(y, m, day)
        mark = "*" if d == today else ("•" if _iso_date(d) in by_day else " ")
        row.append("%2d%s" % (day, mark))
        if len(row) == 7:
            lines.append(" ".join(row))
            row = []
    if row:
        row += ["   "] * (7 - len(row))
        lines.append(" ".join(row))
    # day cells held task titles in the old app; text keeps the grid compact
    # and lists the titles below, one line per task, capped to stay sane.
    shown = 0
    for day_s in sorted(by_day):
        for t in sorted(by_day[day_s], key=_sort_key):
            if shown >= 40:
                lines.append("  … +%d more this month" %
                             (sum(len(v) for v in by_day.values()) - shown))
                return "\n".join(lines)
            lines.append("  %s ▸ %s" % (day_s, _fmt_task(t, now)))
            shown += 1
    if not by_day:
        lines.append("  no open tasks this month")
    return "\n".join(lines)


def board(state, pomo: dict, now: datetime | None = None) -> str:
    """The daily board (old app's implicit 'today' view, formalized):
    overdue + due today + in-progress + a suggestion line (highest
    priority todo) + pomodoro status if active."""
    now = now or datetime.now()
    groups = list_grouping(_open_tasks(state), now)
    over = len(groups["Overdue"])
    tod = len(groups["Today"])
    doing = [t for t in state.get("tasks", []) if t.get("status") == "doing"]
    lines = ["TODAY — %s %s · %d open · %d overdue · %d due today" % (
        _DAY_NAMES[now.weekday()], _iso_date(now.date()),
        sum(len(v) for v in groups.values()), over, tod)]
    shown_ids = set()
    for g, label in (("Overdue", "OVERDUE"), ("Today", "DUE TODAY")):
        if groups[g]:
            lines.append("%s (%d)" % (label, len(groups[g])))
            for t in groups[g]:
                lines.append("  " + _fmt_task(t, now))
                shown_ids.add(t["id"])
    # in-progress section: doing tasks not already listed above
    doing_left = [t for t in doing if t["id"] not in shown_ids]
    if doing_left:
        lines.append("IN PROGRESS (%d)" % len(doing_left))
        for t in sorted(doing_left, key=_sort_key):
            lines.append("  " + _fmt_task(t, now))
    # suggestion: highest-priority TODO (spec) — prio, then due, then oldest
    todos = [t for t in state.get("tasks", []) if t.get("status") == "todo"]
    if todos:
        best = sorted(todos, key=_sort_key)[0]
        dl = _due_label(best.get("due"), now) or "no date"
        lines.append('▶ Next up: %s "%s" [%s] — %s' % (
            best["id"], best.get("title"), best.get("priority"), dl))
    elif not lines[1:]:
        lines.append("Nothing on the plate. Add one: action=\"add\" "
                     "title=\"…\" due=\"today\" priority=\"high\"")
    focus_today = int(pomo.get("daily", {}).get(_iso_date(now.date()), 0))
    if focus_today:
        lines.append("Focus today: %dm" % focus_today)
    a = pomo.get("active")
    if a:
        lines.append(_pomo_line(a, now))
    return "\n".join(lines)


def update_task(state, tid, fields: dict, now: datetime) -> str:
    """Partial update (old api_update_task only touched provided fields —
    same contract). due/tags/subtasks accept 'none' to clear. status=done
    stamps completed; leaving done clears the stamp (stats read the span)."""
    t, err = resolve_task(state, tid)
    if err:
        return err
    changed = []
    if str(fields.get("title") or "").strip():
        t["title"] = str(fields["title"]).strip()
        changed.append("title")
    if str(fields.get("priority") or "").strip():
        pri, perr = _norm_priority(fields["priority"])
        if perr:
            return perr
        t["priority"] = pri
        changed.append("priority=%s" % pri)
    if "due" in fields and str(fields.get("due") or "").strip():
        raw = str(fields["due"]).strip()
        if raw.lower() in CLEAR_WORDS:
            t["due"] = None
            t.pop("due_unparsed", None)
            changed.append("due cleared")
        else:
            r = parse_when(raw, now)
            if r["parsed"]:
                t["due"] = r["due"]
                t.pop("due_unparsed", None)
            else:
                t["due"] = raw            # keep raw + warn (parse contract)
                t["due_unparsed"] = True
            changed.append("due %s" % t["due"])
    if "tags" in fields and str(fields.get("tags") or "").strip():
        raw = str(fields["tags"]).strip()
        t["tags"] = [] if raw.lower() in CLEAR_WORDS else _as_tags(raw)
        changed.append("tags")
    if "subtasks" in fields and str(fields.get("subtasks") or "").strip():
        raw = str(fields["subtasks"]).strip()
        t["subtasks"] = ([] if raw.lower() in CLEAR_WORDS
                         else _as_subtasks(raw))
        changed.append("subtasks")
    if "notes" in fields and str(fields.get("notes") or "").strip():
        t["notes"] = str(fields["notes"])
        changed.append("notes")
    if str(fields.get("status") or "").strip():
        st, serr = _norm_status(fields["status"])
        if serr:
            return serr
        t["status"] = st
        changed.append("status=%s" % st)
        if st == "done" and not t.get("completed"):
            t["completed"] = _stamp(now)
        elif st != "done":
            t["completed"] = None       # un-done → span restarts cleanly
    if not changed:
        return ("nothing to update — pass title / priority / due / tags / "
                "subtasks / notes / status")
    return 'Updated %s "%s": %s — %s' % (t["id"], t.get("title"),
                                         ", ".join(changed), _counts(state))


def complete_task(state, tid, now: datetime) -> str:
    """Mark done + record completed-at (spec: completes NOTHING else —
    subtasks and any running pomodoro are left alone, the old app had no
    cascade either)."""
    t, err = resolve_task(state, tid)
    if err:
        return err
    if t.get("status") == "done":
        return 'task %s "%s" is already completed (%s)' % (
            t["id"], t.get("title"), _date_of(t.get("completed")))
    t["status"] = "done"
    t["completed"] = _stamp(now)
    subs = t.get("subtasks") or []
    left = sum(1 for s in subs if not s.get("done"))
    msg = 'Completed %s "%s" — %s' % (t["id"], t.get("title"), _counts(state))
    if left:
        msg += " · %d subtask(s) left open" % left
    return msg


def delete_task(state, tid) -> str:
    """Remove a task outright (old deleteTask + api_delete_task)."""
    t, err = resolve_task(state, tid)
    if err:
        return err
    state["tasks"] = [x for x in state.get("tasks", []) if x is not t]
    return 'Deleted %s "%s" — %s' % (t["id"], t.get("title"), _counts(state))


def search_tasks(state, query: str, limit: int = 30,
                 now: datetime | None = None) -> str:
    """Substring search over title / tags / notes (+ id prefix — models
    half-type ids). Case-insensitive, grouped like list."""
    now = now or datetime.now()
    q = str(query or "").strip().lower()
    if not q:
        return 'search needs a query — it scans title, tags, notes and ids'
    try:
        limit = max(1, min(100, int(limit)))
    except (TypeError, ValueError):
        limit = 30
    hits = []
    for t in state.get("tasks", []):
        hay = " ".join([str(t.get("title") or ""),
                        str(t.get("notes") or ""),
                        " ".join(str(g) for g in (t.get("tags") or []))]).lower()
        if q in hay or str(t.get("id", "")).lower().startswith(q):
            hits.append(t)
    if not hits:
        return 'No match for "%s" (%s).' % (query, _counts(state))
    groups = list_grouping(hits, now)
    lines = ['Search "%s": %d match%s' % (query, len(hits),
                                          "es" if len(hits) != 1 else "")]
    shown = 0
    for g in GROUP_ORDER:
        if not groups[g]:
            continue
        lines.append("%s (%d)" % (g.upper(), len(groups[g])))
        for t in groups[g]:
            if shown >= limit:
                lines.append("  … +%d more (raise limit=)" % (len(hits) - shown))
                return "\n".join(lines)
            lines.append("  " + _fmt_task(t, now, with_notes=True))
            shown += 1
    return "\n".join(lines)


def sub_add(state, tid, title: str) -> str:
    """Append a subtask {title, done:False} (S3 feature — checklist rows
    inside the old editor's content box, now first-class)."""
    t, err = resolve_task(state, tid)
    if err:
        return err
    title = str(title or "").strip()
    if not title:
        return "sub_add needs the subtask title="
    t.setdefault("subtasks", []).append({"title": title, "done": False})
    subs = t["subtasks"]
    return 'Added subtask "%s" to %s "%s" — %d/%d done' % (
        title, t["id"], t.get("title"),
        sum(1 for s in subs if s.get("done")), len(subs))


def sub_done(state, tid, index_or_title) -> str:
    """Check off a subtask by 1-based index or by (sub)title match."""
    t, err = resolve_task(state, tid)
    if err:
        return err
    subs = t.get("subtasks") or []
    if not subs:
        return 'task %s has no subtasks — add one with sub_add' % t["id"]
    key = str(index_or_title or "").strip()
    if not key:
        return "sub_done needs index= (1-based) or the subtask title"
    hit = None
    if key.isdigit():
        i = int(key)
        if 1 <= i <= len(subs):
            hit = subs[i - 1]
        else:
            return "index %d out of range — %s has %d subtask(s)" % (
                i, t["id"], len(subs))
    else:
        k = key.lower()
        exact = [s for s in subs if s["title"].lower() == k]
        part = [s for s in subs if k in s["title"].lower()]
        hit = (exact or part or [None])[0]
    if hit is None:
        listing = "; ".join(
            "%d) %s" % (i + 1, s["title"]) for i, s in enumerate(subs))
        return ('no subtask %r on %s — subtasks: %s'
                % (key, t["id"], listing))
    if hit.get("done"):
        return 'subtask "%s" on %s is already done' % (hit["title"], t["id"])
    hit["done"] = True
    return '✓ %s subtask "%s" done (%d/%d)' % (
        t["id"], hit["title"],
        sum(1 for s in subs if s.get("done")), len(subs))


# ── templates (old app: backend/templates/*.json + scanTemplates + the
# chat create/delete/get_template tools; here they're task blueprints:
# reusable field bundles, applied to spawn fresh tasks) ────────────────

def _tpl_fields_from(t: dict) -> dict:
    """Copy the reusable fields off a task (no id/status/stamps)."""
    return {
        "title": t.get("title") or "",
        "priority": t.get("priority") or "medium",
        "due": t.get("due") or "",
        "tags": list(t.get("tags") or []),
        "subtasks": [{"title": s.get("title", ""), "done": False}
                     for s in (t.get("subtasks") or [])],
        "notes": t.get("notes") or "",
    }


def tpl_save(state, name, from_id="", fields: dict | None = None,
             now: datetime | None = None) -> str:
    """Save a template from an existing task (from_id) or inline fields.
    Same-name save replaces (old app wrote the same filename)."""
    name = str(name or "").strip().lower()
    # safe filename rule ported from old api_create_template
    name = re.sub(r"[^a-z0-9_-]+", "_", name).strip("_") if name else ""
    if not name:
        return "tpl_save needs a name (letters/numbers/dash/underscore)"
    fields = dict(fields or {})
    if str(from_id or "").strip():
        t, err = resolve_task(state, from_id)
        if err:
            return err
        fields.update({k: v for k, v in _tpl_fields_from(t).items() if v})
    title = str(fields.get("title") or "").strip()
    if not title:
        return ("tpl_save needs a title — inline (title=…) or from_id=<task "
                "to copy>")
    pri, perr = _norm_priority(fields.get("priority"))
    if perr:
        return perr
    tpl = {
        "name": name,
        "title": title,
        "priority": pri,
        "due": str(fields.get("due") or "").strip() or None,
        "tags": _as_tags(fields.get("tags")),
        "subtasks": _as_subtasks(fields.get("subtasks")),
        "notes": str(fields.get("notes") or ""),
        "created": _stamp(now or datetime.now()),
        "uses": 0,
    }
    tpls = state.setdefault("templates", [])
    replaced = False
    for i, existing in enumerate(tpls):
        if str(existing.get("name", "")).lower() == name:
            tpl["uses"] = int(existing.get("uses") or 0)  # keep the counter
            tpls[i] = tpl
            replaced = True
            break
    if not replaced:
        tpls.append(tpl)
    msg = "Template '%s' saved: \"%s\" [%s]" % (name, title, pri)
    if tpl["due"]:
        msg += " due %s" % tpl["due"]
    if tpl["subtasks"]:
        msg += " · %d subtasks" % len(tpl["subtasks"])
    if tpl["tags"]:
        msg += " · %d tags" % len(tpl["tags"])
    if replaced:
        msg += " (replaced existing)"
    msg += " — %d template(s)" % len(tpls)
    return msg


def tpl_list(state) -> str:
    tpls = state.get("templates") or []
    if not tpls:
        return ("No templates yet — tpl_save name=… from_id=<task> (or "
                "inline fields). Old app shipped freeform / structured_lesson"
                " / research_paper; yours live in tasks.json.")
    lines = ["Templates (%d):" % len(tpls)]
    for tpl in sorted(tpls, key=lambda x: x.get("name", "")):
        row = "  %s — \"%s\" [%s]" % (tpl.get("name"), tpl.get("title"),
                                      tpl.get("priority", "medium"))
        if tpl.get("due"):
            row += " due %s" % tpl["due"]
        subs = tpl.get("subtasks") or []
        if subs:
            row += " · %d subtasks" % len(subs)
        row += " · used %d×" % int(tpl.get("uses") or 0)
        lines.append(row)
    return "\n".join(lines)


def tpl_apply(state, name, now: datetime):
    """Instantiate a template as a fresh task. Relative dues re-resolve
    against TODAY at apply time — a 'friday' template used on Wednesday
    is due this Friday, not the dead date it was saved with."""
    name = str(name or "").strip().lower()
    tpls = state.get("templates") or []
    hit = next((x for x in tpls if str(x.get("name", "")).lower() == name),
               None)
    if hit is None:
        if not tpls:
            return "No templates saved yet — tpl_save first"
        return "No template '%s' — have: %s" % (
            name, ", ".join(str(x.get("name")) for x in tpls))
    fields = {
        "title": hit.get("title"),
        "priority": hit.get("priority"),
        "due": hit.get("due") or "",
        "tags": list(hit.get("tags") or []),
        "subtasks": [dict(s) for s in (hit.get("subtasks") or [])],
        "notes": hit.get("notes") or "",
    }
    task, msg = add_task(state, fields, now)
    if task is None:
        return msg
    task["template"] = hit.get("name")      # provenance, like the old
    hit["uses"] = int(hit.get("uses") or 0) + 1   # tpl-select field on tasks
    return "Template '%s' applied → %s" % (hit.get("name"), msg)


# ── pomodoro (new in S3; fills the old app's missing focus feature) ──

def _pomo_line(a: dict, now: datetime) -> str:
    """Computed-on-read status: we store start epoch + minutes and never
    sleep — remaining is arithmetic at render time, so a dead process
    'running' for days still reports sanely."""
    elapsed = (now.timestamp() - float(a["epoch"])) / 60.0
    remaining = float(a["minutes"]) - elapsed
    started = _parse_dt(a.get("start"))
    hhmm = started.strftime("%H:%M") if started else "?"
    if remaining > 0:
        return "⏱ pomodoro: %dm left of %dm on \"%s\" (started %s)" % (
            int(round(remaining)), a["minutes"],
            a.get("task_title") or "unlinked", hhmm)
    return ("⏱ pomodoro: done — over by %dm on \"%s\" (started %s) — "
            "say pomodoro sub=stop to log it" % (
                int(round(-remaining)), a.get("task_title") or "unlinked",
                hhmm))


def pomodoro(pomo: dict, sub: str, task_id="", minutes=25,
             now: datetime | None = None, state: dict | None = None) -> str:
    """start (task_id?, minutes=25) / status / stop / log. Timer state is
    {active, sessions[], daily{date: minutes}} — session log keeps the
    old log.js event-viewer spirit (timestamps + durations per row)."""
    now = now or datetime.now()
    sub = (sub or "status").strip().lower()
    try:
        minutes = max(1, min(180, int(minutes)))
    except (TypeError, ValueError):
        minutes = 25
    active = pomo.get("active")

    if sub == "start":
        if active:
            return ("pomodoro already running — %s\nsay pomodoro sub=stop "
                    "to log it first" % _pomo_line(active, now))
        a = {"task_id": "", "task_title": "", "start": _stamp(now),
             "epoch": now.timestamp(), "minutes": minutes}
        if str(task_id or "").strip():
            t, err = (resolve_task(state, task_id) if state
                      is not None else (None, "no task list loaded"))
            if err:
                return err
            if t is None:
                return ("task '%s' not found — start with no task_id, or "
                        "list first" % task_id)
            a["task_id"], a["task_title"] = t["id"], t.get("title", "")
        pomo["active"] = a
        return ('⏱ Pomodoro started: %dm on "%s". Check with pomodoro '
                "sub=status; stop logs the session." % (
                    minutes, a["task_title"] or "unlinked"))

    if sub == "status":
        if not active:
            today = int(pomo.get("daily", {}).get(_iso_date(now.date()), 0))
            return ("No pomodoro running. Today's focus: %dm. Start: "
                    "pomodoro sub=start id=<task> minutes=25." % today)
        return _pomo_line(active, now)

    if sub == "stop":
        if not active:
            return "No pomodoro running."
        raw = (now.timestamp() - float(active["epoch"])) / 60.0
        # Cap elapsed at the planned length: a forgotten overnight timer
        # must not inflate "daily focus" — focus means scheduled focus.
        elapsed = max(0, min(raw, float(active["minutes"])))
        elapsed_i = int(round(elapsed))
        day = _iso_date(now.date())      # attributed to the stop-day
        pomo.setdefault("sessions", []).append({
            "start": active.get("start"), "stop": _stamp(now),
            "minutes": active["minutes"], "elapsed": elapsed_i,
            "task_id": active.get("task_id", ""),
            "task_title": active.get("task_title", ""),
            "finished": raw >= float(active["minutes"]),
        })
        pomo.setdefault("daily", {})
        pomo["daily"][day] = int(pomo["daily"].get(day, 0)) + elapsed_i
        pomo["active"] = None
        today = pomo["daily"].get(day, 0)
        note = ("timer completed" if raw >= float(active["minutes"])
                else "%dm left on the clock" % int(round(
                    float(active["minutes"]) - raw)))
        return ('⏱ Stopped: %dm focused on "%s" (%s). Today: %dm total '
                        "(%d session%s logged)." % (
                            elapsed_i, active.get("task_title") or "unlinked",
                            note, today, len(pomo["sessions"]),
                            "s" if len(pomo["sessions"]) != 1 else ""))

    if sub == "log":
        lines = []
        if active:
            lines.append(_pomo_line(active, now))
        sessions = pomo.get("sessions") or []
        lines.append("Pomodoro log — %d session%s (last 10, newest first)" % (
            len(sessions), "s" if len(sessions) != 1 else ""))
        if not sessions:
            lines.append("  none yet — pomodoro sub=start id=<task>")
        for s in reversed(sessions[-10:]):
            st = _parse_dt(s.get("start"))
            sp = _parse_dt(s.get("stop"))
            span = "%s→%s" % (st.strftime("%m-%d %H:%M") if st else "?",
                              sp.strftime("%H:%M") if sp else "?")
            lines.append('  %s  %2dm  "%s"  %s' % (
                span, int(s.get("elapsed") or 0),
                s.get("task_title") or "unlinked",
                "completed" if s.get("finished") else "partial"))
        daily = pomo.get("daily") or {}
        if daily:
            recent = sorted(daily)[-7:]
            lines.append("Daily focus: " + " · ".join(
                "%s %dm" % (d[5:], daily[d]) for d in recent))
        today = int(daily.get(_iso_date(now.date()), 0))
        lines.append("Today: %dm total" % today)
        return "\n".join(lines)

    return ("pomodoro sub must be start | status | stop | log "
            "(got '%s')" % sub)


# ── stats (the old app had no analytics; log.js showed raw events —
# this is the chat-native digest of the same activity stream) ─────────

def stats_view(state, pomo: dict, now: datetime | None = None) -> str:
    """7-day added/completed counts, open-by-priority, completion-day
    streak, focus totals. Computed from task stamps — nothing tracked."""
    now = now or datetime.now()
    today = now.date()
    tasks = state.get("tasks", [])
    days = [today - timedelta(days=i) for i in range(6, -1, -1)]
    added = {d: 0 for d in days}
    done = {d: 0 for d in days}
    done_days = set()
    for t in tasks:
        cd = _date_of(t.get("created"))
        if cd in added:
            added[cd] += 1
        if t.get("completed"):
            dd = _date_of(t["completed"])
            if dd in done:
                done[dd] += 1
            if dd:
                done_days.add(dd)
    lines = ["Stats — %s (last 7 days):" % _iso_date(today)]
    rows = [d for d in days if added[d] or done[d]]
    if rows:
        for d in rows:
            lines.append("  %s  +%d  ✓%d" % (_iso_date(d), added[d], done[d]))
    else:
        lines.append("  no task activity in the last 7 days")
    open_t = _open_tasks(state)
    byp = {p: 0 for p in PRIORITIES}
    for t in open_t:
        byp[t.get("priority", "medium")] = byp.get(
            t.get("priority", "medium"), 0) + 1
    lines.append("Open by priority: " + " · ".join(
        "%s %d" % (p, byp[p]) for p in PRIORITIES if byp[p])
        + (" — %d open" % len(open_t) if open_t else " — all clear ✓"))
    # streak: consecutive completion-days ending today (or yesterday —
    # today isn't 'broken' until midnight)
    d = today
    if d not in done_days:
        d = today - timedelta(days=1)
    streak = 0
    while d in done_days:
        streak += 1
        d -= timedelta(days=1)
    if streak:
        lines.append("Completion streak: %d day%s (%s → %s)" % (
            streak, "s" if streak != 1 else "",
            _iso_date(today if today in done_days
                      else today - timedelta(days=1)),
            _iso_date((today if today in done_days
                       else today - timedelta(days=1))
                      - timedelta(days=streak - 1))))
    else:
        lines.append("Completion streak: 0 — complete a task today to "
                     "start one")
    daily = pomo.get("daily") or {}
    today_f = int(daily.get(_iso_date(today), 0))
    week_f = sum(v for k, v in daily.items()
                 if _iso_date(today - timedelta(days=6)) <= k
                 <= _iso_date(today))
    if today_f or week_f:
        lines.append("Focus: %dm today · %dm last 7d" % (today_f, week_f))
    return "\n".join(lines)


def help_text() -> str:
    """Compact cheat-sheet — the model's first call when unsure
    (dt_spec rule 10)."""
    return """timemgr — task & time manager (old timemanager app, reborn)
Actions (action=…):
  add        title, priority?(urgent|high|medium|low), due?, tags?(comma),
             subtasks?(comma list), notes?
  list       status?(todo|doing|done|deferred|open|all), priority?, tag?,
             due_before?, limit?, month?("YYYY-MM" → calendar view)
  today      daily board: overdue · due today · in progress · next up · pomodoro
  update     id + any add-field (due/tags/subtasks "none" clears them)
  complete   id (subtasks untouched; completed-at recorded)
  delete     id
  search     query (scans title, tags, notes, ids)
  sub_add    id, title
  sub_done   id, index (1-based) or subtask title
  tpl_save   name, from_id?(copy an existing task) or inline fields
  tpl_list   show saved templates
  tpl_apply  name → new task (relative dues re-resolve today)
  pomodoro   sub=start|status|stop|log; start: id?, minutes?=25
  stats      7-day add/complete counts, open by priority, streak, focus
  help       this sheet
Due-date words: today, tomorrow, yesterday, friday, next friday, next week,
next month, in 3 days, in 2 weeks, in 3 hours, 2025-12-01, dec 1, dec 1 2026.
Unparsed text is kept verbatim and flagged ⚠ (never guessed).
State: workspace/.doomalay/timemgr/tasks.json + pomodoro.json"""


# ═══════════════════════════════════════════════════════════════════
# dispatch — one entry point; the strands wrapper (and tests) call it.
# Mutates tasks_state / pomo_state in place; returns a string ALWAYS.
# ═══════════════════════════════════════════════════════════════════

def dispatch(tasks_state: dict, pomo_state: dict, action: str,
             args: dict | None, now: datetime | None = None) -> str:
    now = now or datetime.now()
    a = str(action or "").strip().lower()
    args = args or {}

    if a in ("", "help", "?"):
        return help_text()
    if a in ("add", "new", "create"):
        task, msg = add_task(tasks_state, args, now)
        return msg
    if a in ("list", "ls"):
        if str(args.get("month") or "").strip():
            return month_calendar(tasks_state, str(args["month"]), now)
        return list_tasks(
            tasks_state, status=str(args.get("status") or ""),
            priority=str(args.get("priority") or ""),
            tag=str(args.get("tag") or ""),
            due_before=str(args.get("due_before") or ""),
            limit=args.get("limit", 50), now=now)
    if a == "today":
        return board(tasks_state, pomo_state, now)
    if a in ("update", "edit"):
        return update_task(tasks_state, args.get("id"),
                           {k: v for k, v in args.items() if k != "id"}, now)
    if a in ("complete", "done"):
        return complete_task(tasks_state, args.get("id"), now)
    if a in ("delete", "del", "rm"):
        return delete_task(tasks_state, args.get("id"))
    if a in ("search", "find"):
        return search_tasks(tasks_state, args.get("query"),
                            limit=args.get("limit", 30), now=now)
    if a == "sub_add":
        return sub_add(tasks_state, args.get("id"), args.get("title"))
    if a in ("sub_done", "sub_check"):
        return sub_done(tasks_state, args.get("id"), args.get("index"))
    if a == "tpl_save":
        return tpl_save(tasks_state, args.get("name"),
                        from_id=str(args.get("from_id") or ""),
                        fields=args, now=now)
    if a in ("tpl_list", "templates"):
        return tpl_list(tasks_state)
    if a in ("tpl_apply", "tpl_use"):
        return tpl_apply(tasks_state, args.get("name"), now)
    if a == "stats":
        return stats_view(tasks_state, pomo_state, now)
    if a in ("pomodoro", "pomo", "timer") or a.split("_")[0] in (
            "pomodoro", "pomo", "timer"):
        # accept "pomodoro" + sub=… AND "pomodoro_start"-style verbs
        sub = str(args.get("sub") or "")
        if not sub and "_" in a:
            sub = a.split("_", 1)[1]
        return pomodoro(pomo_state, sub, task_id=str(args.get("id") or ""),
                        minutes=args.get("minutes", 25), now=now,
                        state=tasks_state)
    return "Unknown action '%s' — say action=help for the cheat-sheet." % a


# ═══════════════════════════════════════════════════════════════════
# strands surface — decorator imported INSIDE build() (dt_spec rule 1),
# the whole body wrapped so build() can never raise (rule 2).
# ═══════════════════════════════════════════════════════════════════

def build(ctx) -> list:
    try:
        try:
            from strands import tool as strands_tool_decorator
        except Exception:
            return []                     # offline: register nothing

        state_dir = ctx.tool_state("timemgr")
        tasks_path = state_dir / "tasks.json"
        pomo_path = state_dir / "pomodoro.json"

        @strands_tool_decorator(name="timemgr", description=(
            "Personal task and time manager — the old timemanager app "
            "reborn as a chat tool. Tasks with priority, natural-language "
            "due dates ('friday', 'in 3 days', '2025-12-01'), subtasks, "
            "tags, notes, reusable templates, a pomodoro focus timer, a "
            "daily board and 7-day stats with streaks. Use whenever the "
            "user mentions tasks, todos, deadlines, plans for today, "
            "focus sessions or progress. Actions: add, list, today, "
            "update, complete, delete, search, sub_add, sub_done, "
            "tpl_save, tpl_list, tpl_apply, pomodoro, stats, help."
        ))
        def timemgr(action: str, id: str = "", title: str = "",
                    priority: str = "", due: str = "", tags: str = "",
                    subtasks: str = "", notes: str = "", status: str = "",
                    query: str = "", index: str = "", name: str = "",
                    from_id: str = "", sub: str = "", minutes: int = 25,
                    limit: int = 50, tag: str = "", due_before: str = "",
                    month: str = "") -> str:
            """Manage tasks, due dates, subtasks, templates and pomodoros.
            action: add|list|today|update|complete|delete|search|sub_add|
                    sub_done|tpl_save|tpl_list|tpl_apply|pomodoro|stats|help
            id: short task id (also the pomodoro-start task)
            title: task/subtask/template title
            priority: urgent|high|medium|low
            due: natural date (today, tomorrow, friday, next week,
                 in 3 days, 2025-12-01, dec 1) or ISO datetime
            tags: comma-separated tag list
            subtasks: comma-separated subtask titles
            notes: free text
            status: todo|doing|done|deferred (update) or filter (list)
            query: search text
            index: subtask number (1-based) or title (sub_done)
            name: template name (tpl_save/tpl_apply)
            from_id: task id to copy into a template (tpl_save)
            sub: pomodoro subaction: start|status|stop|log
            minutes: pomodoro length (default 25)
            limit: max rows for list/search
            tag: single-tag filter (list)
            due_before: date cutoff filter (list)
            month: "YYYY-MM" calendar view (list)
            """
            try:
                tasks_state = _load_state(tasks_path, TASKS_DEFAULT)
                pomo_state = _load_state(pomo_path, POMO_DEFAULT)
                args = {}
                for k, v in (("id", id), ("title", title),
                             ("priority", priority), ("due", due),
                             ("tags", tags), ("subtasks", subtasks),
                             ("notes", notes), ("status", status),
                             ("query", query), ("index", index),
                             ("name", name), ("from_id", from_id),
                             ("sub", sub), ("tag", tag),
                             ("due_before", due_before), ("month", month)):
                    if v not in ("", None):
                        args[k] = v
                args["minutes"] = minutes
                args["limit"] = limit
                out = dispatch(tasks_state, pomo_state, action, args,
                               now=datetime.now())
                _save_state(tasks_path, tasks_state)
                _save_state(pomo_path, pomo_state)
                try:
                    ctx.log("timemgr", action=action,
                            ok=not out.startswith("Unknown action"))
                except Exception:
                    pass
                if len(out) > MAX_RETURN_CHARS:      # dt_spec rule 9
                    out = out[:MAX_RETURN_CHARS] + (
                        "\n… trimmed — full state: %s" % tasks_path)
                return out
            except Exception as exc:                 # degrade, never crash
                return "timemgr error: %s: %s" % (type(exc).__name__, exc)

        return [timemgr]
    except Exception:
        return []                         # missing seam → register nothing


# ═══════════════════════════════════════════════════════════════════
# offline self-test (dt_spec rule 7): python3 tools/dt_timemgr.py
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import tempfile
    from pathlib import Path

    NOW = datetime(2025, 6, 4, 10, 0)          # a Wednesday

    # parse_when — every documented form + garbage passthrough
    assert parse_when("today", NOW)["due"] == "2025-06-04"
    assert parse_when("tomorrow", NOW)["due"] == "2025-06-05"
    assert parse_when("friday", NOW)["due"] == "2025-06-06"
    assert parse_when("next friday", NOW)["due"] == "2025-06-06"
    assert parse_when("monday", NOW)["due"] == "2025-06-09"
    assert parse_when("next week", NOW)["due"] == "2025-06-11"
    assert parse_when("in 3 days", NOW)["due"] == "2025-06-07"
    assert parse_when("in 2 weeks", NOW)["due"] == "2025-06-18"
    assert parse_when("in a couple of days", NOW)["due"] == "2025-06-06"
    assert parse_when("2025-12-01", NOW)["due"] == "2025-12-01"
    assert parse_when("2025-12-01 14:30", NOW)["due"] == "2025-12-01T14:30"
    assert parse_when("dec 1", NOW)["due"] == "2025-12-01"
    assert parse_when("dec 1 2026", NOW)["due"] == "2026-12-01"
    assert parse_when("1 dec", NOW)["due"] == "2025-12-01"
    assert parse_when("may 5", NOW)["due"] == "2026-05-05"   # past → roll
    assert parse_when("yesterday", NOW)["due"] == "2025-06-03"
    assert parse_when("in 3 hours", NOW)["due"] == "2025-06-04T13:00"
    for garbage in ("someday", "when pigs fly", "next quarter", ""):
        assert parse_when(garbage, NOW)["parsed"] is False, garbage
    print("parse_when OK")

    # add / list / complete / delete round-trip over a bare dict
    st = {"tasks": [], "templates": []}
    t1, m1 = add_task(st, {"title": "Ship v0.43", "priority": "high",
                           "due": "friday", "tags": "release, v43",
                           "subtasks": "bump version, tag, upload",
                           "notes": "the big one"}, NOW)
    assert t1 and t1["due"] == "2025-06-06" and t1["id"] in m1
    add_task(st, {"title": "Overdue thing", "due": "yesterday"}, NOW)
    add_task(st, {"title": "Tomorrow thing", "due": "tomorrow"}, NOW)
    add_task(st, {"title": "Undated"}, NOW)
    out = list_tasks(st, now=NOW)
    assert "OVERDUE" in out and "TODAY" not in out
    assert "TOMORROW" in out and "No task" not in out
    assert complete_task(st, t1["id"], NOW).startswith("Completed")
    assert delete_task(st, t1["id"]).startswith("Deleted")
    assert len(st["tasks"]) == 3
    print("add/list/complete/delete OK")

    # subtasks + templates
    t2, _ = add_task(st, {"title": "Lesson", "subtasks": "read, write"}, NOW)
    assert sub_add(st, t2["id"], "review").endswith("0/3 done")
    assert "✓" in sub_done(st, t2["id"], "2")
    assert "✓" in sub_done(st, t2["id"], "read")
    assert tpl_save(st, "lesson", from_id=t2["id"], now=NOW).startswith(
        "Template 'lesson' saved")
    applied = tpl_apply(st, "lesson", NOW)
    assert "applied →" in applied and st["templates"][0]["uses"] == 1
    print("subtasks/templates OK")

    # pomodoro with a fake clock
    po = {"active": None, "sessions": [], "daily": {}}
    assert "Pomodoro started" in pomodoro(po, "start", minutes=25, now=NOW,
                                          state=st)
    stat = pomodoro(po, "status", now=NOW + timedelta(minutes=10))
    assert "15m left of 25m" in stat, stat
    stopped = pomodoro(po, "stop", now=NOW + timedelta(minutes=40))
    assert "25m focused" in stopped            # capped at planned length
    assert po["daily"]["2025-06-04"] == 25 and len(po["sessions"]) == 1
    assert "No pomodoro running" in pomodoro(po, "stop", now=NOW)
    print("pomodoro OK")

    # stats + dispatch + state IO
    s = stats_view(st, po, NOW)
    assert "Open by priority" in s and "streak" in s.lower()
    assert dispatch(st, po, "bogus", {}, NOW).startswith("Unknown action")
    tmp = Path(tempfile.mkdtemp(prefix="dt-timemgr-")) / "t.json"
    _save_state(tmp, st)
    assert _load_state(tmp, TASKS_DEFAULT)["tasks"] == st["tasks"]
    print("stats/dispatch/state-io OK")

    # build() without strands must return [] (never raise)
    class _FakeCtx:
        workspace = Path(tempfile.mkdtemp())

        def tool_state(self, tool):
            d = self.workspace / ".doomalay" / tool
            d.mkdir(parents=True, exist_ok=True)
            return d

    assert build(_FakeCtx()) == []
    print("build() offline OK")
    print("SELF-TEST OK")
