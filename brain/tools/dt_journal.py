"""dt_journal.py — djournal: the rich doomalay personal journal (S4, v0.43 wave).

The user's old app had a journal that was RICH — moods, tags, daily
highlights, gratitude lists, streaks, retrospective summaries — and the
standing ask for v0.43 is that this app "consume every old feature", not a
minimal subset. strands_tools ships a bare-bones `journal` (a text file with
a datestamp), which agent_core also loads; this tool is the doomalay one, so
its name is `djournal` (the "d" is doomalay) and the two never collide.

Actions: write, read, search, review, moods, prompt, export, help.
  write    append an entry (text + mood + tags + highlights + gratitude +
           energy; word_count computed; same-date repeats get "#2" ids)
  read     one day, a range, or the last N days — formatted entries
  search   full-text/tag/highlight/gratitude search with context lines
  review   week/month/last-N computed summary: avg mood + trend arrow vs the
           previous period, mood distribution bar, top tags, top highlights,
           gratitude count, best/worst day, streaks, days since last entry
  moods    compact one-line-per-day mood timeline with trend words
  prompt   a journaling prompt, rotating deterministically by day-of-year
  export   the whole journal as markdown or JSON (also written to state)

State: workspace/.doomalay/djournal/entries.jsonl — append-only JSONL, one
entry per line. The dedup key is (date, created): an exact key replay is an
idempotent no-op, while a FRESH write on an already-written date appends a
new entry whose id carries a suffix marker ("2025-06-15#2") so multi-entry
days stay distinguishable everywhere. A load-time index (date → entries)
feeds single-date reads. Every action is a plain function over list[dict],
so the entire core is unit-testable with in-memory entries and no strands.
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

TOOL_NAMES = ["djournal"]

STATE_FILE = "entries.jsonl"   # append-only log: one JSON entry per line
MAX_OUT = 6000                 # dt_spec rule 9: model-facing replies stay bounded
_TEXT_SNIP = 700               # per-entry text cap in `read` (long entries live in the file)
_LINE_SNIP = 160               # per-line cap in `search` context output
_TIMELINE_CAP = 60             # `moods` shows ≤ ~2 months; older → trim + note

# ── the mood scale ──────────────────────────────────────────────────────────
# The old journal let people type anything — "4", "😀", "good", "Ok" — and
# stored the mess verbatim, which made any aggregation impossible. Here every
# input normalizes to ONE int 1..5 (None = unusable) so review math, mood
# filters, and timelines never see strings. The five canonical words come
# from the old app's scale; the synonyms and emoji cover how people actually
# type moods. Anything unrecognized → None and the CALLER warns (never guess:
# a silently-wrong mood poisons every average built on it).
_MOOD_WORDS = {
    # 5 — top of the scale
    "great": 5, "amazing": 5, "awesome": 5, "excellent": 5, "wonderful": 5,
    "best": 5, "perfect": 5,
    # 4
    "good": 4, "fine": 4, "happy": 4, "nice": 4, "solid": 4, "better": 4,
    # 3
    "ok": 3, "okay": 3, "meh": 3, "average": 3, "neutral": 3, "soso": 3,
    "so-so": 3, "alright": 3,
    # 2
    "low": 2, "down": 2, "sad": 2, "tired": 2, "sluggish": 2, "rough": 2,
    "mehh": 2, "under": 2,
    # 1
    "awful": 1, "terrible": 1, "horrible": 1, "bad": 1, "worst": 1,
    "drained": 1, "miserable": 1,
}
_MOOD_EMOJI = {
    "🤩": 5, "😍": 5, "🥳": 5, "😄": 5, "😀": 5, "😁": 5, "🔥": 5, "✨": 5,
    "🙂": 4, "😊": 4, "👍": 4, "😌": 4, "😃": 4, "😅": 4,
    "😐": 3, "😑": 3, "🤔": 3, "😬": 3,
    "🙁": 2, "😕": 2, "😔": 2, "😪": 2, "😞": 2, "🙃": 2,
    "😢": 1, "😭": 1, "😩": 1, "😫": 1, "🥲": 1, "☹": 1, "💔": 1,
}
_MOOD_LABELS = {5: "great", 4: "good", 3: "ok", 2: "low", 1: "awful"}
_MOOD_GLYPHS = {5: "😀", 4: "🙂", 3: "😐", 2: "🙁", 1: "😢"}

# Unicode block bar for the review's mood distribution: index 0 renders a
# ZERO count (blank), 1..5 are the spec's ▁▂▃▄▅ scaled to the max bucket.
# len(bar) is always exactly 5 (one column per mood level 1..5).
_BLOCKS = " ▁▂▃▄▅"

# 'last 7' / 'last 7 days' / 'last 7 day' — one grammar shared by read/moods/
# export ranges and review periods, so "last 7" means the same window in all
# of them (off-by-one consistency matters when the user diffs outputs).
_LAST_RE = re.compile(r"^last\s+(\d+)\s*(days?)?$", re.IGNORECASE)


# ── small datetime/list helpers (shared by every action) ───────────────────

def _now_or(now) -> datetime:
    """Fill in `now` and force tz-aware UTC.

    Plain functions take `now` explicitly so tests pin it (deterministic
    streaks/ranges); naive datetimes are treated as UTC per dt_spec rule 11
    (timestamps are ISO-8601 UTC everywhere in the doomalay brain).
    """
    if now is None:
        return datetime.now(timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now


def _parse_iso_dt(s: str) -> datetime | None:
    """Best-effort ISO-8601 datetime parse ('Z' tolerated) → None on garbage.

    Never raises: stored/typed timestamps are untrusted input. Pre-3.11
    fromisoformat rejects trailing 'Z', so it is normalized by hand first
    (the Android brain still runs older Pythons under Chaquopy).
    """
    s = str(s or "").strip()
    if not s:
        return None
    if s[-1] in ("Z", "z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _parse_date_or_none(s: str) -> date | None:
    """ISO date (or full datetime — the date part is taken)."""
    dt = _parse_iso_dt(s)
    return dt.date() if dt is not None else None


def _as_list(v) -> list[str]:
    """tags/highlights/gratitude → clean list[str].

    The tool schema passes comma/newline/semicolon-separated strings (the
    model-friendly form); tests and the JSON export round-trip pass real
    lists. Both end up here. Leading '#' is stripped so "#work" and "work"
    are the same tag — the old app let users type either and dedup broke.
    """
    if v is None:
        return []
    items = v if isinstance(v, (list, tuple)) else re.split(r"[,;\n]", str(v))
    out = []
    for it in items:
        it = str(it).strip().lstrip("#").strip()
        if it:
            out.append(it)
    return out


def mood_scale(mood) -> int | None:
    """Normalize any user-supplied mood to an int 1..5, else None.

    Order matters: numbers beat words beat emoji ("3" is never a word), the
    first emoji in a mixed string wins ("mood: 😀." → 5), and bools are
    rejected explicitly (True is an int subclass and would silently become
    mood 1). Out-of-range numbers ("9", 0) are None — clamping would invent
    data the user never gave.
    """
    if mood is None:
        return None
    if isinstance(mood, bool):
        return None
    if isinstance(mood, (int, float)):
        try:
            return _clamp_mood(round(float(mood)))
        except (ValueError, OverflowError):   # nan / inf
            return None
    s = str(mood).strip()
    if not s:
        return None
    try:
        return _clamp_mood(round(float(s)))
    except (ValueError, OverflowError):
        pass
    low = s.lower()
    if low in _MOOD_WORDS:
        return _MOOD_WORDS[low]
    if s in _MOOD_EMOJI:
        return _MOOD_EMOJI[s]
    for ch in s:                       # first emoji anywhere in the string
        if ch in _MOOD_EMOJI:
            return _MOOD_EMOJI[ch]
    return None


def _clamp_mood(v: int) -> int | None:
    """1..5 or None — the scale has five steps, everything else is noise."""
    return v if 1 <= v <= 5 else None


def _mood_str(v) -> str:
    """'🙂 good 4/5' for a known mood, '—' for absent — used in entry cards."""
    if v is None:
        return "—"
    return f"{_MOOD_GLYPHS.get(v, '?')} {_MOOD_LABELS.get(v, '?')} {v}/5"


# ── write: add_entry (the one mutation in the core) ─────────────────────────

def add_entry(entries: list[dict], fields: dict, now: datetime) -> tuple[dict, bool]:
    """Validate + append one journal entry to an in-memory list.

    Returns (entry, created). created=False means the exact (date, created)
    key already exists in `entries` — a replayed write — and the EXISTING
    entry is returned with the list untouched, which tells the IO layer not
    to append a second JSONL line (idempotent retries per the state
    contract). A same-date write with a FRESH created stamp is not a dup:
    it appends, and its id gets the suffix marker ("2025-06-15#2") so a day
    with several entries stays addressable in read/search/review output.

    Raises ValueError with a human message on structurally bad input (no
    text / unparseable date / unparseable created) — the wrapper converts
    that to an error string; an unparseable MOOD is not an error, it is
    stored as None and warned about at the tool surface.
    """
    text = str(fields.get("text") or "").strip()
    if not text:
        raise ValueError("text is required — a journal entry needs words")

    # date: explicit ISO date (a full datetime is fine, the date part is
    # taken), defaulting to `now`'s UTC date so "today" means the same day
    # in write, read, and review.
    raw_date = fields.get("date")
    if raw_date in (None, ""):
        day = _now_or(now).date()
    else:
        day = _parse_date_or_none(str(raw_date))
        if day is None:
            raise ValueError(f"date '{raw_date}' is not an ISO date (YYYY-MM-DD)")

    raw_created = fields.get("created")
    if raw_created in (None, ""):
        created = _now_or(now)
    else:
        created = _parse_iso_dt(str(raw_created))
        if created is None:
            raise ValueError(f"created '{raw_created}' is not an ISO datetime")
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)

    date_s = day.isoformat()
    created_s = created.isoformat()
    for e in entries:                        # exact (date, created) replay → no-op
        if e.get("date") == date_s and e.get("created") == created_s:
            return e, False

    same_day = sum(1 for e in entries if e.get("date") == date_s)
    entry = {
        "id": date_s if same_day == 0 else f"{date_s}#{same_day + 1}",
        "date": date_s,
        "created": created_s,
        "text": text,
        "mood": mood_scale(fields.get("mood")),
        "tags": _as_list(fields.get("tags")),
        "highlights": _as_list(fields.get("highlights")),
        "gratitude": _as_list(fields.get("gratitude")),
        "energy": mood_scale(fields.get("energy")),
        "word_count": len(text.split()),
    }
    entries.append(entry)
    return entry, True


# ── streaks (global history, not period-scoped) ─────────────────────────────

def streaks(entries, now=None) -> tuple[int, int]:
    """(current, longest) writing streaks, in days.

    `current` counts the consecutive-day run ending today — or ending
    YESTERDAY (grace: an unwritten *today* mid-evening must not zero a
    streak the user is about to extend) — else 0. `longest` is the best run
    anywhere in history. Multiple entries on one day count once: it is a
    DAY streak, not an entry streak. Unparseable stored dates break runs
    instead of crashing (an append-only log must tolerate hand edits).
    """
    now = _now_or(now)
    days = sorted({str(e.get("date")) for e in entries if e.get("date")})
    if not days:
        return 0, 0
    longest = run = 1
    for prev, cur in zip(days, days[1:]):
        run = run + 1 if _day_gap(prev, cur) == 1 else 1   # a gap resets
        longest = max(longest, run)
    ds = set(days)
    today = now.date()
    if today.isoformat() in ds:
        anchor = today
    elif (today - timedelta(days=1)).isoformat() in ds:
        anchor = today - timedelta(days=1)
    else:
        return 0, longest
    current = 0
    d = anchor
    while d.isoformat() in ds:
        current += 1
        d -= timedelta(days=1)
    return current, longest


def _day_gap(a: str, b: str) -> int:
    da, db = _parse_date_or_none(a), _parse_date_or_none(b)
    if da is None or db is None:
        return 999                    # unparseable → break the run, never crash
    return (db - da).days


def days_since_last(entries, now=None) -> int | None:
    """Whole days from the newest entry to `now` (None = journal empty).

    Clamped at 0 so a future-dated entry (clock skew) reports '0d ago'
    instead of a nonsense negative.
    """
    now = _now_or(now)
    days = [str(e.get("date")) for e in entries if e.get("date")]
    if not days:
        return None
    d = _parse_date_or_none(max(days))   # ISO strings sort chronologically
    return max(0, (now.date() - d).days) if d is not None else None


# ── range parsing (read / moods / export / search filter) ───────────────────

def parse_range(spec: str, now) -> tuple[date, date] | None:
    """Parse a date spec into an INCLUSIVE (start, end) window, or None.

    Accepts: 'today', 'yesterday', an ISO date, 'A..B' ('...' tolerated,
    reversed bounds are swapped — friendlier than failing), 'last N'
    (N days ending today), plus 'week'/'month' (rolling 7/30 — same window
    a review shows, so outputs can be cross-read). None means unparseable;
    callers turn that into an error string, never an exception.
    """
    s = str(spec or "").strip()
    if not s:
        return None
    low = s.lower()
    today = _now_or(now).date()
    if low == "today":
        return today, today
    if low == "yesterday":
        y = today - timedelta(days=1)
        return y, y
    if low in ("week", "this week"):
        return today - timedelta(days=6), today
    if low in ("month", "this month"):
        return today - timedelta(days=29), today
    m = _LAST_RE.match(low)
    if m:
        n = max(1, int(m.group(1)))
        return today - timedelta(days=n - 1), today
    if ".." in s:
        a, _, b = s.partition("..")
        b = b.lstrip(".")                  # tolerate 'A...B'
        da, db = _parse_date_or_none(a.strip()), _parse_date_or_none(b.strip())
        if da is not None and db is not None:
            return (da, db) if da <= db else (db, da)
        return None
    d = _parse_date_or_none(s)
    return (d, d) if d is not None else None


def parse_period(period: str, now) -> tuple[date, date, str] | None:
    """review's period grammar → (start, end, label), or None.

    'week' | 'month' | 'last N days' | bare 'N' (also 'last N'). Rolling
    windows ending today, labelled for the header line. Distinct from
    parse_range because review talks in PERIODS (and needs the label for
    'vs previous period' math), while read talks in days/ranges.
    """
    s = str(period or "").strip().lower()
    if s in ("", "week", "weekly", "this week"):
        days, label = 7, "week"
    elif s in ("month", "monthly", "this month"):
        days, label = 30, "month"
    else:
        m = _LAST_RE.match(s)
        if m:
            days = max(1, int(m.group(1)))
            label = f"last {days} days"
        elif s.isdigit():
            days = max(1, int(s))
            label = f"last {days} days"
        else:
            return None
    end = _now_or(now).date()
    return end - timedelta(days=days - 1), end, label


def _entries_in_range(entries, start: date, end: date) -> list[dict]:
    out = []
    for e in entries:
        d = _parse_date_or_none(str(e.get("date", "")))
        if d is not None and start <= d <= end:
            out.append(e)
    return out


# ── read ────────────────────────────────────────────────────────────────────

def _window_sorted(entries, rng: tuple[date, date]) -> list[dict]:
    """Entries inside an inclusive window, oldest-first.

    Sorted by (date, created) so same-day entries read in write order
    (#1 before #2) — JSONL append order is already chronological, but a
    hand-edited or exported-then-merged log might not be.
    """
    return sorted(_entries_in_range(entries, rng[0], rng[1]),
                  key=lambda e: (str(e.get("date", "")), str(e.get("created", ""))))


def _fmt_entry(e: dict) -> str:
    """One entry as a compact card (read + search headers share this shape).

    Long text is snipped per-entry with a pointer to entries.jsonl — the
    file is the source of truth, the chat is a preview.
    """
    d = str(e.get("date", "?"))
    wd = ""
    dd = _parse_date_or_none(d)
    if dd is not None:
        wd = dd.strftime("%a")
    tm = ""
    cd = _parse_iso_dt(str(e.get("created", "")))
    if cd is not None:
        tm = cd.strftime("%H:%M")
    when = " ".join(x for x in (wd, tm) if x)
    parts = [f"── {e.get('id', d)}" + (f" · {when}" if when else "") + " ──"]
    energy = e.get("energy")
    en = f"{energy}/5" if energy else "—"
    parts.append(f"mood {_mood_str(e.get('mood'))} · energy {en} · "
                 f"{e.get('word_count', len(str(e.get('text', '')).split()))} words")
    text = str(e.get("text", ""))
    if len(text) > _TEXT_SNIP:
        text = text[:_TEXT_SNIP] + " …(snipped — full text in entries.jsonl)"
    parts.append(text)
    if e.get("tags"):
        parts.append("tags: " + " ".join(f"#{t}" for t in e["tags"]))
    if e.get("highlights"):
        parts.append("highlights: " + " · ".join(str(h) for h in e["highlights"]))
    if e.get("gratitude"):
        parts.append("gratitude: " + " · ".join(str(g) for g in e["gratitude"]))
    return "\n".join(parts)


def _render_window(window: list[dict], rng: tuple[date, date], spec: str) -> str:
    n = len(window)
    span = str(rng[0]) if rng[0] == rng[1] else f"{rng[0]}..{rng[1]}"
    # show the spec only when it differs from the span (read 'last 7' is
    # more informative than read '2025-06-09..2025-06-15' echoing itself)
    lines = [f"{n} entr{'y' if n == 1 else 'ies'} · {span}"
             + (f" · {spec}" if spec and spec != span else "")]
    for e in window:
        lines.append("")
        lines.append(_fmt_entry(e))
    return "\n".join(lines)


def read_entries(entries, target="", now=None) -> str:
    """read action over an in-memory list: formatted entries for a day/
    range/'last N'. Friendly empty + unparseable messages, never raises."""
    now = _now_or(now)
    spec = str(target or "").strip() or "today"     # 'what did I write' → today
    rng = parse_range(spec, now)
    if rng is None:
        return (f"djournal: couldn't parse date/range '{spec}'. Try a date "
                f"(2025-06-15), today, yesterday, '2025-06-01..2025-06-30', "
                f"or 'last 7'.")
    window = _window_sorted(entries, rng)
    if not window:
        return (f"no entries for {spec} ({rng[0]}..{rng[1]}). Write one: "
                f"djournal(action='write', text='...', mood='...')")
    return _render_window(window, rng, spec)


# ── search ──────────────────────────────────────────────────────────────────

def _text_context(text: str, ql: str, ctx: int = 1) -> list[str]:
    """grep-style context lines: the matching line plus one neighbour each
    side, the hit itself prefixed '>>'. Merged neighbourhoods collapse so a
    dense cluster doesn't repeat lines. The whole point is giving the model
    enough surrounding text to judge relevance without re-reading entries.
    """
    lines = text.splitlines() or [text]
    hit_idx = [i for i, ln in enumerate(lines) if ql in ln.lower()]
    shown: dict[int, str] = {}
    for i in hit_idx:
        for j in range(max(0, i - ctx), min(len(lines), i + ctx + 1)):
            if j not in shown:
                shown[j] = (">> " if j == i else "   ") + lines[j].strip()[:_LINE_SNIP]
    if not shown:                                # single-line text fallback
        return [">> " + text[:_LINE_SNIP]]
    return [shown[j] for j in sorted(shown)]


def _match_entry(e: dict, ql: str, field: str) -> dict[str, Any]:
    """Which parts of an entry match: {'text': [ctx lines], 'tags': [hits], …}.

    Only matched fields appear; {} = no match. 'all' unions the four
    searchable fields (gratitude included — it's real journal content the
    old app's search skipped, which users noticed).
    """
    res: dict[str, Any] = {}
    fields = ("text", "tags", "highlights", "gratitude") if field == "all" else (field,)
    for f in fields:
        if f == "text":
            text = str(e.get("text", ""))
            if ql in text.lower():
                res["text"] = _text_context(text, ql)
        else:
            hits = [str(x) for x in (e.get(f) or []) if ql in str(x).lower()]
            if hits:
                res[f] = hits
    return res


def search_entries(entries, query, in_field="all", mood=None,
                   date_range="", now=None) -> str:
    """search action: case-insensitive substring matching with context lines,
    optional mood filter and date window. Never raises; bad field names and
    unparseable moods produce a warning line instead of silently narrowing
    (a filter the model THINKS applied but didn't is worse than a warning).
    """
    now = _now_or(now)
    q = str(query or "").strip()
    if not q:
        return ("djournal: search needs a query (searches text, tags, "
                "highlights, and gratitude).")
    field_map = {"": "all", "all": "all", "any": "all",
                 "text": "text", "body": "text",
                 "tags": "tags", "tag": "tags",
                 "highlights": "highlights", "highlight": "highlights",
                 "gratitude": "gratitude", "grateful": "gratitude"}
    field = field_map.get(str(in_field or "").strip().lower())
    if field is None:
        return (f"djournal: in_field must be text|tags|highlights|gratitude|"
                f"all, got '{in_field}'.")
    want_mood = None
    mood_warn = ""
    if mood not in (None, ""):
        want_mood = mood_scale(mood)
        if want_mood is None:
            mood_warn = (f"\n(mood '{mood}' not recognized — filter skipped; "
                         f"use 1-5, great/good/ok/low/awful, or an emoji)")
    rng = parse_range(date_range, now) if str(date_range or "").strip() else None
    if str(date_range or "").strip() and rng is None:
        return (f"djournal: couldn't parse date_range '{date_range}'. Try "
                f"'2025-06-01..2025-06-30' or 'last 7'.")
    ql = q.lower()
    blocks = []
    for e in entries:
        if rng is not None:
            d = _parse_date_or_none(str(e.get("date", "")))
            if d is None or not (rng[0] <= d <= rng[1]):
                continue
        if want_mood is not None and e.get("mood") != want_mood:
            continue
        m = _match_entry(e, ql, field)
        if m:
            blocks.append((e, m))
    if not blocks:
        return (f"no matching entries for '{q}' in {field} "
                f"({len(entries)} entr{'y' if len(entries) == 1 else 'ies'} "
                f"searched){mood_warn}")
    head = (f"{len(blocks)} matching entr{'y' if len(blocks) == 1 else 'ies'} "
            f"for '{q}' in {field} · {len(entries)} searched")
    body = [head, mood_warn.strip()] if mood_warn else [head]
    for e, m in blocks:
        body.append("")
        body.append(f"── {e.get('id', e.get('date', '?'))} "
                    f"({_mood_str(e.get('mood'))}) ──")
        for f in ("text", "tags", "highlights", "gratitude"):
            if f in m:
                if f == "text":
                    body.extend(m[f])
                else:
                    body.append(f"{f}: " + ", ".join(f"#{x}" if f == "tags" else x
                                                     for x in m[f]))
    return "\n".join(body)


# ── review ──────────────────────────────────────────────────────────────────

def _bar(counts: list[int]) -> str:
    """Mood distribution as 5 unicode block columns (levels 1..5), heights
    scaled to the busiest level; zero counts render blank. len == 5 always,
    which the tests pin — a mis-sized bar would misalign the legend."""
    mx = max(counts) or 1
    return "".join(_BLOCKS[round(c / mx * 5)] for c in counts)


def review_summary(entries, period="", now=None) -> str:
    """review action: the computed weekly/monthly retrospective.

    Math notes (why each number exists):
    - avg mood is per-ENTRY, not per-day: mood is felt per entry; a day with
      two entries is two data points, and averaging the average would
      under-weight heavy days.
    - trend compares against the previous EQUAL-LENGTH window; ±0.2 is the
      dead zone so float noise and single-notch drift don't fake a trend.
    - streaks + days-since-last are computed over the WHOLE history — a
      weekly review that reset the streak would lie to the user.
    - 'top highlights' pulls from the best-mood entries first: highlights
      from great days are the ones worth re-reading.
    """
    now = _now_or(now)
    parsed = parse_period(period, now)
    if parsed is None:
        return (f"djournal: couldn't parse period '{period}'. Use week, "
                f"month, or 'last N days'.")
    start, end, label = parsed
    window = _entries_in_range(entries, start, end)
    words = sum(int(e.get("word_count") or 0) for e in window)
    lines = [f"Journal review — {label} ({start}..{end})"]
    lines.append(f"entries: {len(window)} · words: {words:,}")

    moods = [e["mood"] for e in window if e.get("mood")]
    if moods:
        avg = sum(moods) / len(moods)
        prev_end = start - timedelta(days=1)
        prev_start = prev_end - (end - start)
        prev_moods = [e["mood"] for e in _entries_in_range(entries, prev_start, prev_end)
                      if e.get("mood")]
        if prev_moods:
            pavg = sum(prev_moods) / len(prev_moods)
            diff = avg - pavg
            arrow = "↑" if diff >= 0.2 else ("↓" if diff <= -0.2 else "→")
            trend = f"{arrow} vs previous period ({pavg:.1f})"
        else:
            trend = "— no earlier entries to compare"
        lines.append(f"avg mood: {avg:.1f}/5 {trend}")
        counts = [sum(1 for m in moods if m == lv) for lv in (1, 2, 3, 4, 5)]
        legend = " ".join(f"{lv}:{n}" for lv, n in zip((1, 2, 3, 4, 5), counts))
        lines.append(f"mood distribution: {_bar(counts)}  ({legend})")
    else:
        lines.append("avg mood: — (no moods recorded this period)")

    tag_counts: Counter = Counter()
    for e in window:
        tag_counts.update(str(t) for t in (e.get("tags") or []))
    if tag_counts:
        lines.append("top tags: " +
                     ", ".join(f"#{t}×{n}" for t, n in tag_counts.most_common(5)))

    highlights: list[str] = []
    for e in sorted(window, key=lambda x: -(x.get("mood") or 0)):
        for h in (e.get("highlights") or []):
            highlights.append(f"  • {h}  ({e.get('date')})")
            if len(highlights) >= 3:
                break
        if len(highlights) >= 3:
            break
    if highlights:
        lines.append("top highlights:")
        lines.extend(highlights)

    grat = sum(len(e.get("gratitude") or []) for e in window)
    lines.append(f"gratitude items: {grat}")

    day_moods: dict[str, list[int]] = {}
    for e in window:
        if e.get("mood"):
            day_moods.setdefault(str(e["date"]), []).append(e["mood"])
    if day_moods:
        avgs = {d: sum(v) / len(v) for d, v in day_moods.items()}
        best = worst = None
        for d in sorted(avgs):               # earliest day wins ties → deterministic
            if best is None or avgs[d] > avgs[best]:
                best = d
            if worst is None or avgs[d] < avgs[worst]:
                worst = d
        lines.append(f"best day: {best} ({avgs[best]:.1f}/5) · "
                     f"worst day: {worst} ({avgs[worst]:.1f}/5)")

    cur, longest = streaks(entries, now)
    dsl = days_since_last(entries, now)
    lines.append(f"streak: {cur}d (longest {longest}d) · "
                 f"last entry: {'never' if dsl is None else f'{dsl}d ago'}")
    if not window:
        lines.append("no entries in this period — write one: "
                     "djournal(action='write', text='...', mood='...')")
    return "\n".join(lines)


# ── moods (compact timeline) ────────────────────────────────────────────────

def mood_timeline(entries, target="", now=None) -> str:
    """moods action: one line per day — date, mood glyph, one-word trend.

    Trend words compare each day's (rounded) average mood to the previous
    day IN THE TIMELINE, so gaps don't fake drops. Days without any mood
    still show (as '·') because knowing you WROTE is half the timeline.
    """
    now = _now_or(now)
    spec = str(target or "").strip() or "last 14"      # two weeks fits a phone
    rng = parse_range(spec, now)
    if rng is None:
        return (f"djournal: couldn't parse range '{target}'. Try "
                f"'2025-06-01..2025-06-30' or 'last 30'.")
    window = _window_sorted(entries, rng)
    if not window:
        return f"no entries {rng[0]}..{rng[1]} — nothing to chart"
    per_day: dict[str, list[int]] = {}
    for e in window:
        per_day.setdefault(str(e["date"]), []).extend(
            [e["mood"]] if e.get("mood") else [])
    lines = [f"mood timeline {rng[0]}..{rng[1]} "
             f"({len(per_day)} day{'s' if len(per_day) != 1 else ''} with entries)"]
    prev = None
    shown = 0
    for d in sorted(per_day):
        ms = per_day[d]
        if shown >= _TIMELINE_CAP:
            lines.append(f"…({len(per_day) - _TIMELINE_CAP} older days trimmed)")
            break
        shown += 1
        if not ms:
            lines.append(f"{d}  ·  no mood")
            continue
        avg = round(sum(ms) / len(ms))
        if prev is None:
            word = "new"
        elif avg > prev:
            word = "up"
        elif avg < prev:
            word = "down"
        else:
            word = "flat"
        prev = avg
        extra = f"  avg {sum(ms) / len(ms):.1f} over {len(ms)}" if len(ms) > 1 else ""
        lines.append(f"{d}  {_MOOD_GLYPHS.get(avg, '·')}  {word}{extra}")
    return "\n".join(lines)


# ── prompt (deterministic daily rotation) ───────────────────────────────────
# 45 prompts, 9 per category, covering the old journal's five prompt
# categories. Rotation is day-of-year modulo the list: the SAME calendar day
# always offers the same prompt (no re-roll spam within a day, and a user
# who journals every breakfast sees the cycle in order), while each prompt
# recurs ~8× a year. Determinism is the feature — pick_prompt(doy) is pure.
PROMPTS: list[tuple[str, str]] = [
    # reflection
    ("reflection", "What did today teach you that yesterday didn't?"),
    ("reflection", "Which hour of today would you relive exactly as it happened — and why that one?"),
    ("reflection", "What did you avoid today, and what did the avoidance cost?"),
    ("reflection", "Where did your attention actually go today? Is that where you wanted it?"),
    ("reflection", "What felt heavier than it needed to today?"),
    ("reflection", "Describe today in one honest sentence, then explain the sentence."),
    ("reflection", "What small thing worked today that you'd never notice on a loud day?"),
    ("reflection", "When did you feel most like yourself today?"),
    ("reflection", "What assumption of yours did today quietly test?"),
    # gratitude
    ("gratitude", "Name three things that went right today — including one nobody else noticed."),
    ("gratitude", "Who made your day easier without knowing it?"),
    ("gratitude", "What part of your body quietly carried you through today?"),
    ("gratitude", "Which ordinary comfort did you enjoy today that millions would call a luxury?"),
    ("gratitude", "What went wrong today that you can still be grateful beside (not for)?"),
    ("gratitude", "Name something you're grateful you said no to this week."),
    ("gratitude", "What did you learn recently that you're glad waited until now?"),
    ("gratitude", "Which place are you glad exists? Describe it small."),
    ("gratitude", "What about today's weather, light, or air would you miss if it changed?"),
    # future-self
    ("future-self", "Write a note to yourself one year from tonight. What should they not forget?"),
    ("future-self", "If next month's you sent one warning back, what would it say?"),
    ("future-self", "What are you building right now that your future self will thank you for?"),
    ("future-self", "Ten years from now, what about today will seem small — and what will matter?"),
    ("future-self", "What habit is your future self currently hoping you start?"),
    ("future-self", "Describe the person you're becoming in three verbs."),
    ("future-self", "What would make tomorrow's you feel genuinely proud of tonight?"),
    ("future-self", "If you could keep only one thing from this month, what would you carry forward?"),
    ("future-self", "What question do you want to be able to answer a year from now?"),
    # challenge
    ("challenge", "What's the hardest conversation you're not having? Write its first sentence."),
    ("challenge", "Where are you tolerating 'fine' when you could have 'good'?"),
    ("challenge", "What would you attempt this week if failure were just data?"),
    ("challenge", "Name one thing you're pretending not to know."),
    ("challenge", "What scared you today — and how much of that fear was borrowed?"),
    ("challenge", "If the obstacle in front of you were a teacher, what's the lesson?"),
    ("challenge", "What's one system in your life that silently broke this month?"),
    ("challenge", "Which comfort is starting to cost more than it gives?"),
    ("challenge", "What would 'doing it scared' look like tomorrow?"),
    # relationships
    ("relationships", "Who did you feel understood by lately? What did they actually do?"),
    ("relationships", "Which relationship deserves more honesty and less politeness?"),
    ("relationships", "Who would call you first with good news — and why them?"),
    ("relationships", "What do people consistently get wrong about you — and is any of it your fault?"),
    ("relationships", "Whose company recharged you this week, and whose drained you? What's the difference?"),
    ("relationships", "Write a two-line thank-you you'll actually send."),
    ("relationships", "Where did you hold a boundary well recently? Where did you leak one?"),
    ("relationships", "What do you miss about someone you still see often?"),
    ("relationships", "Who in your life needs a version of you that's easier to be?"),
]


def pick_prompt(day_of_year: int) -> str:
    """The day's journaling prompt: '[category] text'.

    Pure + deterministic (same day → same prompt, no clock reads here —
    the caller supplies the day-of-year). Python's modulo is non-negative
    even for negative inputs, so a hand-rolled doy can't index-crash.
    """
    cat, text = PROMPTS[day_of_year % len(PROMPTS)]
    return f"[{cat}] {text}"


# ── export ──────────────────────────────────────────────────────────────────

def export_entries(entries, fmt="md", target="", now=None) -> str:
    """export action: the whole (or ranged) journal as markdown or JSON.

    JSON is a faithful round-trip (json.loads(export) == the filtered entry
    list) so a user can move their journal between workspaces; markdown is
    for humans and the artifacts drawer. `target` uses the same range
    grammar as read ('2025-06-01..2025-06-30', 'last 30'); empty = all.
    """
    now = _now_or(now)
    f = str(fmt or "md").strip().lower()
    if f not in ("md", "markdown", "json"):
        return "djournal: export format must be md or json."
    if str(target or "").strip():
        rng = parse_range(target, now)
        if rng is None:
            return (f"djournal: couldn't parse range '{target}'. Try "
                    f"'2025-06-01..2025-06-30' or 'last 30'.")
        window = _window_sorted(entries, rng)
    else:
        window = sorted(entries, key=lambda e: (str(e.get("date", "")),
                                                str(e.get("created", ""))))
    if f == "json":
        return json.dumps(window, ensure_ascii=False, indent=2)
    lines = [f"# doomalay journal export — {len(window)} entries",
             f"generated {now.date().isoformat()} · djournal", ""]
    for e in window:
        d = str(e.get("date", "?"))
        cd = _parse_iso_dt(str(e.get("created", "")))
        tm = cd.strftime("%a %H:%M") if cd is not None else ""
        lines.append(f"## {e.get('id', d)}" + (f" · {tm}" if tm else ""))
        energy = e.get("energy")
        lines.append(f"mood: {_mood_str(e.get('mood'))} · energy: "
                     f"{f'{energy}/5' if energy else '—'} · "
                     f"{e.get('word_count', '?')} words")
        lines.append("text:")
        lines.extend("  " + ln for ln in str(e.get("text", "")).splitlines() or [""])
        if e.get("tags"):
            lines.append("tags: " + ", ".join(f"#{t}" for t in e["tags"]))
        if e.get("highlights"):
            lines.append("highlights: " + " · ".join(str(h) for h in e["highlights"]))
        if e.get("gratitude"):
            lines.append("gratitude: " + " · ".join(str(g) for g in e["gratitude"]))
        lines.append("")
    return "\n".join(lines)


# ── JSONL state IO (the only impure seam; build() wires it) ─────────────────

def load_entries(entries_path) -> list[dict]:
    """Read the append-only JSONL log into a list[dict].

    Corrupt or blank lines are SKIPPED, never fatal: an append-only log's
    whole point is surviving a kill mid-append (a truncated tail line costs
    one entry at most, not the journal). Order is file order = write order.
    """
    entries: list[dict] = []
    p = Path(entries_path)
    if not p.exists():
        return entries
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        return entries
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            entries.append(obj)
    return entries


def index_entries(entries) -> dict[str, list[dict]]:
    """date → entries for that date, in write order.

    Built on every load (cheap: one pass) and used for single-date reads —
    a years-long journal shouldn't linear-scan for 'show me June 3rd' — and
    conceptually documents multi-entry days (the #2, #3 ids).
    """
    idx: dict[str, list[dict]] = {}
    for e in entries:
        idx.setdefault(str(e.get("date", "?")), []).append(e)
    return idx


def load_state(entries_path) -> tuple[list[dict], dict[str, list[dict]]]:
    """Load + index in one step (the dt_spec `_load_state` shape, JSONL form)."""
    entries = load_entries(entries_path)
    return entries, index_entries(entries)


def append_entry(entries_path, entry: dict) -> None:
    """Append one entry as a single JSON line (append-only per dt_spec rule 3).

    One write() call per line keeps a kill mid-append from corrupting more
    than the tail line, which load_entries then skips. No rewrites of the
    file ever happen — history is immutable by design.
    """
    line = json.dumps(entry, ensure_ascii=False)
    with open(entries_path, "a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()


def _atomic_write(path: Path, text: str) -> None:
    """tmp file + os.replace (dt_spec rule 3) so export files can't be torn."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _cap(text: str, where) -> str:
    """dt_spec rule 9: replies stay ≤ MAX_OUT chars; trimmed output points
    at the on-disk source of truth instead of silently ending."""
    if len(text) <= MAX_OUT:
        return text
    note = f"\n…(trimmed at {MAX_OUT} chars — full data: {where})"
    return text[: MAX_OUT - len(note)] + note


# ── the write confirmation ──────────────────────────────────────────────────

def _confirm(entry: dict, created: bool, entries: list, now,
             raw_mood="", raw_energy="") -> str:
    """Human-facing receipt for a write: what got saved + the live streak.

    Mood/energy warnings go HERE (not into add_entry) because the plain core
    stays exception-light — the tool surface is where 'banana' becomes a
    teachable moment. The streak is recomputed AFTER the append so writing
    today's entry immediately shows the extended run.
    """
    cur, longest = streaks(entries, now)
    bits = []
    if entry.get("mood"):
        bits.append(f"mood {_mood_str(entry['mood'])}")
    if entry.get("energy"):
        bits.append(f"energy {entry['energy']}/5")
    if entry.get("tags"):
        bits.append(" ".join(f"#{t}" for t in entry["tags"]))
    lines = [f"{'Saved' if created else 'Already saved'} journal entry "
             f"{entry.get('id', entry.get('date'))} · {entry.get('word_count', 0)} words"
             + (f" · {' · '.join(bits)}" if bits else "")]
    if not created:
        lines.append("(replay of the same write — (date, created) key exists, "
                     "nothing appended)")
    lines.append(f"streak: {cur}d (longest {longest}d)")
    # Warning on the RAW input, not the stored value: a deduped replay
    # returns an OLDER entry whose fields may differ, and comparing against
    # it would blame a perfectly valid mood the replay never stored.
    for raw, what in ((raw_mood, "mood"), (raw_energy, "energy")):
        if str(raw or "").strip() and mood_scale(raw) is None:
            lines.append(f"note: {what} '{raw}' not recognized — saved without "
                         f"it (use 1-5, great/good/ok/low/awful, or an emoji)")
    return "\n".join(lines)


# ── help ────────────────────────────────────────────────────────────────────

HELP = """djournal — the rich doomalay journal (write, read, search, review, moods, prompt, export, help)

write   text (required), mood?, date?, tags?, highlights?, gratitude?, energy?
        → appends an entry (default date: today); same-date repeats get #2, #3 ids
read    target: date | today | yesterday | "2025-01-01..2025-01-31" | "last N"
search  query, in_field? (text|tags|highlights|gratitude|all), mood?, date_range?
review  period? (week | month | "last N days") → entry count, avg mood + trend
        arrow, mood distribution bar, top tags, top highlights, gratitude count,
        best/worst day, streaks, days since last entry
moods   date_range? → compact timeline: one line per day (date, glyph, up/down/flat)
prompt  → today's journaling prompt (45 prompts, rotates by day-of-year)
export  format? (md|json), date_range? → the full journal; also saved to state

mood syntax: 1-5, words (great/good/ok/low/awful), or emoji (😀🙂😐🙁😢).
tags/highlights/gratitude: comma- or newline-separated lists.
state: workspace/.doomalay/djournal/entries.jsonl (append-only JSONL)."""


# ── the IO-wired dispatcher (strands-free; build() + self-test share it) ─────

def run_action(entries_path, action: str, *, text: str = "", date: str = "",
               mood: str = "", tags: str = "", highlights: str = "",
               gratitude: str = "", energy: str = "", query: str = "",
               in_field: str = "all", date_range: str = "", period: str = "",
               target: str = "", fmt: str = "md", now=None,
               on_event: Callable[..., None] | None = None) -> str:
    """Run one djournal action against the JSONL state file.

    This is the seam between the pure core and the disk: load (skipping
    corrupt lines), dispatch to a plain function, append ONLY genuinely new
    writes, cap the reply at MAX_OUT. `on_event` (optional) receives
    progress events (djournal_write) so the user's live status feed sees
    journaling happen — best-effort, never fatal. Every failure mode
    returns a string; nothing here raises to the model.
    """
    now = _now_or(now)
    act = str(action or "").strip().lower()
    entries, idx = load_state(entries_path)   # entries + date index, built on load

    if act in ("write", "add", "log", "new"):
        try:
            entry, created = add_entry(entries, {
                "text": text, "date": date, "created": "",
                "mood": mood, "tags": tags, "highlights": highlights,
                "gratitude": gratitude, "energy": energy,
            }, now)
        except ValueError as exc:
            return f"djournal: {exc}"
        if created:
            append_entry(entries_path, entry)
        if on_event is not None:
            try:
                on_event("djournal_write", date=entry.get("date"),
                         words=entry.get("word_count"), new=created)
            except Exception:
                pass
        return _confirm(entry, created, entries, now,
                        raw_mood=mood, raw_energy=energy)

    if act in ("read", "show", "get", "list"):
        spec = str(target or date or "").strip() or "today"
        rng = parse_range(spec, now)
        if rng is not None and rng[0] == rng[1]:
            # single-date fast path: the load-time index answers without
            # scanning the whole journal (dt_spec: "index built on load")
            window = sorted(idx.get(rng[0].isoformat(), []),
                            key=lambda e: str(e.get("created", "")))
            if window:
                return _cap(_render_window(window, rng, spec), entries_path)
        return _cap(read_entries(entries, spec, now), entries_path)

    if act == "search":
        return _cap(search_entries(entries, query, in_field=in_field,
                                   mood=mood, date_range=date_range, now=now),
                    entries_path)

    if act in ("review", "stats", "summary"):
        return _cap(review_summary(entries, period=period or target or "week",
                                   now=now), entries_path)

    if act in ("moods", "timeline", "mood"):
        return _cap(mood_timeline(entries, target=date_range or target
                                  or "last 14", now=now), entries_path)

    if act in ("prompt", "idea", "spark"):
        p = pick_prompt(now.timetuple().tm_yday)
        return (f"{p}\nwrite your answer with djournal(action='write', "
                f"text='...', mood='...') — one prompt per day, 45 in rotation.")

    if act in ("export", "dump", "backup"):
        out = export_entries(entries, fmt=fmt, target=date_range or target, now=now)
        if out.startswith("djournal:"):        # parse error — nothing to persist
            return out
        p = Path(entries_path).parent / ("export.json"
                                         if fmt.lower().startswith("json") else "export.md")
        try:
            _atomic_write(p, out)
        except OSError as exc:
            return _cap(out + f"\n(warning: could not write {p}: {exc})", p)
        return _cap(out + f"\n\n(export saved to {p})", p)

    if act in ("help", "?", ""):
        return HELP
    return f"djournal: unknown action '{action}'.\n\n" + HELP


# ── strands surface (dt_spec rule 1: decorator imported INSIDE build) ───────

def build(ctx) -> list:
    """Wire the `djournal` strands tool over ctx's state dir.

    Never raises (dt_spec rule 2): no strands → no tools; every failure
    inside a call returns an error STRING (the model reads it, the session
    survives). The state dir is resolved per-CALL (not at build time) so a
    workspace that isn't ready yet can't break agent startup.
    """
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []                      # offline: register nothing

    try:
        @strands_tool_decorator(name="djournal", description=(
            "Rich personal journal: moods, tags, daily highlights, gratitude, "
            "energy, streaks, and rotating journaling prompts. Use whenever the "
            "user wants to record or reflect on their day, search past entries, "
            "or review their week or month (mood trend, top tags, highlights). "
            "Actions: write, read, search, review, moods, prompt, export, help."
        ))
        def djournal(action: str, text: str = "", date: str = "",
                     mood: str = "", tags: str = "", highlights: str = "",
                     gratitude: str = "", energy: str = "", query: str = "",
                     in_field: str = "all", date_range: str = "",
                     period: str = "", target: str = "",
                     format: str = "md") -> str:
            """Journal actions: write|read|search|review|moods|prompt|export|help.
            action: the verb — call action='help' for the full cheat-sheet
            text: entry body (write; required)
            date: ISO date for the entry (write), or the day to read (read)
            mood: 1-5, word (great/good/ok/low/awful), or emoji (write; search filter)
            tags: comma- or newline-separated tags (write)
            highlights: comma- or newline-separated wins of the day (write)
            gratitude: comma- or newline-separated gratitude items (write)
            energy: 1-5 energy level (write)
            query: the text to search for (search)
            in_field: text|tags|highlights|gratitude|all (search, default all)
            date_range: '2025-06-01..2025-06-30' or 'last 7' (search, moods, export)
            period: week|month|'last N days' (review, default week)
            target: date|today|yesterday|'A..B'|'last N' (read)
            format: md|json (export)
            """
            try:
                state = Path(ctx.tool_state("djournal"))
                return run_action(state / STATE_FILE, action, text=text,
                                  date=date, mood=mood, tags=tags,
                                  highlights=highlights, gratitude=gratitude,
                                  energy=energy, query=query, in_field=in_field,
                                  date_range=date_range, period=period,
                                  target=target, fmt=format,
                                  on_event=lambda event, **kw: ctx.log(event, **kw))
            except Exception as exc:   # noqa: BLE001 — errors are strings here
                return f"djournal error: {type(exc).__name__}: {exc}"

        return [djournal]
    except Exception:
        return []


# ── offline self-test (dt_spec rule 7: temp dirs, no network, no strands) ───

if __name__ == "__main__":
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="djournal-"))
    path = tmp / STATE_FILE
    now = datetime(2025, 6, 15, 9, 0, tzinfo=timezone.utc)

    out = run_action(path, "help")
    assert "write" in out and "review" in out and "export" in out

    out = run_action(path, "write", text="first entry, testing the waters",
                     mood="good", tags="test, meta", now=now)
    assert "words" in out and "streak" in out and "good" in out

    # a second write on the SAME date needs a distinct created stamp (in
    # production the stamp carries microseconds, so two real writes never
    # collide on the dedup key) — same key+text below proves the replay case
    out = run_action(path, "write", text="second entry, same day",
                     now=now.replace(microsecond=1))
    assert "#2" in out                                  # same-date suffix marker
    assert len(load_entries(path)) == 2

    # exact (date, created) replay → idempotent no-op, log does not grow
    out = run_action(path, "write", text="replayed write, same stamp",
                     now=now)
    assert "Already saved" in out
    assert len(load_entries(path)) == 2

    out = run_action(path, "read", target="today", now=now)
    assert "first entry" in out and "second entry" in out
    out = run_action(path, "read", target="bananas", now=now)
    assert "couldn't parse" in out

    out = run_action(path, "search", query="waters", now=now)
    assert "waters" in out and "1 matching entry" in out

    out = run_action(path, "review", period="week", now=now)
    assert "avg mood" in out and "streak" in out

    out = run_action(path, "moods", now=now)
    assert "🙂" in out and "timeline" in out

    assert pick_prompt(200) == pick_prompt(200)
    assert pick_prompt(200) != pick_prompt(201)
    out = run_action(path, "prompt", now=now)
    assert "[" in out

    out = run_action(path, "export", fmt="json", now=now)
    rt = json.loads(out.split("\n\n(export saved")[0])
    assert len(rt) == 2 and rt[0]["text"].startswith("first")

    out = run_action(path, "frobnicate", now=now)
    assert "unknown action" in out
    out = run_action(path, "write", text="   ", now=now)
    assert "text is required" in out

    # the strands surface degrades silently on a strands-free box
    class _Ctx:
        workspace = tmp

        def tool_state(self, tool):
            return tmp

        def log(self, *a, **k):
            pass

    tools = build(_Ctx())
    assert isinstance(tools, list)   # [] on a strands-free box; never raises
    print("SELF-TEST OK")
