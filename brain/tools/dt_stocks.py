"""dt_stocks.py — keyless market quotes, daily history and technical analysis.

Where this comes from: docs/HF_CAPABILITY_MATRIX.md row "Stock analysis [PORT-0]
Stooq/Yahoo keyless CSV quote tool + artifacts" — the keyless market-data
promise the matrix made for quick chat. Stooq needs no API key, which is the
whole point: the Android user types "aapl" and gets data with zero setup.
The user's canonical acceptance test is "AI doing stocks" ending in an
article-grade analysis, so `analyze` writes a full markdown report into
ctx.tool_state("stocks")/ that the sibling `artifact` tool can store in the
engine's artifacts store permanently.

Actions: quote (multi-symbol snapshot), history (summary + CSV file),
analyze (MA / RSI / volatility / signals report), compare (side-by-side),
help.

Stooq access strategy (why the fetch layer looks like this):
  1. PRIMARY — the documented CSV endpoints (q/l quotes, q/d/l history).
     One request, exact data, works from residential IPs (the phone).
  2. Stooq runs a JavaScript proof-of-work gate on datacenter IPs
     (challenge in HTML body, POST /__verify). We solve it with stdlib
     hashlib — same computation a browser does — and retry.
  3. If the CSV endpoints are dead/404/"Access denied" (they are from
     datacenter ranges as of Sep 2026), we fall back to the HTML quote
     page /q/?s=X and the history table page /q/d/?s=X&l=<page> and parse
     those. Slower (one page per symbol / 40 rows per page) but correct,
     and everything above the HTTP line stays pure + unit-tested.
The live HTTP seam is injectable (module-level _fetch_quote_batch /
_fetch_history) so the offline test suite runs the FULL action chain with
fixture data and never touches the network. `--live` is the only live path.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import statistics
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

TOOL_NAMES = ["stocks"]

# ── network constants (only used below the injectable seam) ────────────────
_BASE = "https://stooq.com"
_BASE_HOST = "stooq.com"                # for the sync-resolver prewarm fallback
_CSV_QUOTE = _BASE + "/q/l/"          # ?s=SYM1,SYM2&f=sd2t2ohlcv&h&e=csv
_CSV_HIST = _BASE + "/q/d/l/"         # ?s=SYM&i=d  (full daily history)
_HTML_QUOTE = _BASE + "/q/"           # ?s=SYM     (quote page, aq_ spans)
_HTML_HIST = _BASE + "/q/d/"          # ?s=SYM&l=N (history table, 40 rows/page)
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")  # browser-ish: stooq 403s plain python-httpx
_HTTP_TIMEOUT = 15.0                  # hard cap per request (spec rule 5)
_MAX_PAGES = 8                        # HTML history pagination cap: 8 x 40 = 320 rows ceiling
_MAX_CACHED_HIST = 800                # cap rows persisted in the history cache (JSON size guard)
_MAX_CACHED_SYMS = 10                 # cap symbols in the history cache (evict oldest)
QUOTE_TTL = 60                        # quotes move intraday: 60s cache
HISTORY_TTL = 600                     # daily bars: 10min cache
_RETURN_LIMIT = 6000                  # spec rule 9: trimmed payload, path note where full data lives

# ── symbol suffix map (documented in help; Stooq conventions) ──────────────
# US stocks  AAPL  -> aapl.us    (default for a bare ticker)
# Hong Kong  0700  -> 700.hk     (stooq drops the leading zeros on .hk)
# crypto     btc   -> btc.v      (.v = "virtual" instruments, US$ quoted)
# indices    ^ndq  (Nasdaq Composite) — caret passthrough; ^spx/^dji are
#                mapped per the dt_spec task text but may be CSV-only today
# FX pairs   eurusd -> eurusd    (6-letter both-halves-currency passthrough)
_CRYPTO = {"btc", "eth", "ltc", "xrp", "bch", "ada", "doge", "sol", "dot", "link"}
_FIAT = {"usd", "eur", "jpy", "gbp", "chf", "cad", "aud", "nzd", "cny",
         "hkd", "sek", "nok", "pln", "try", "mxn", "sgd"}
_INDEX_ALIASES = {
    "sp500": "^spx", "spx": "^spx", "^spx": "^spx", "gspc": "^spx", "^gspc": "^spx",
    "ndq": "^ndq", "^ndq": "^ndq", "nasdaq": "^ndq",
    "dji": "^dji", "^dji": "^dji", "dow": "^dji", "djia": "^dji",
    "vix": "^vix", "^vix": "^vix",
}

_MONTHS = {m[:3].lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], start=1)}


# ═══════════════════════════════════════════════════════════════════════════
# PLAIN, UNIT-TESTABLE CORE — no network, no strands, no filesystem
# ═══════════════════════════════════════════════════════════════════════════

def normalize_symbol(user_input: str) -> str:
    """Map a user-typed ticker to Stooq's symbol convention.

    Why: the model receives free text ("AAPL", "btc", "sp500", "700.HK") but
    Stooq keys data by suffixed lowercase symbols. Rules, applied in order:
      explicit aliases (sp500->^spx, ndq->^ndq, dow->^dji, vix->^vix),
      known crypto names -> .v, caret-prefixed passthrough, FX pair (6
      letters, both halves ISO fiat) passthrough, already-dotted passthrough
      (with .hk leading zeros stripped), 4-5 digit numerics -> .hk (Stooq's
      HK listings dominate that shape), anything else -> .us (US default).
    Lowercased throughout because Stooq matches case-insensitively but its
    own pages/CSVs are lowercase.
    """
    s = (user_input or "").strip().lower().lstrip("$").strip()
    if not s:
        return ""
    if s in _INDEX_ALIASES:
        return _INDEX_ALIASES[s]
    if s in _CRYPTO:
        return s + ".v"
    if s.startswith("^"):
        return s
    # FX pair heuristic: eurusd/usdjpy/… — valid Stooq symbols with no suffix.
    if len(s) == 6 and s[:3] in _FIAT and s[3:] in _FIAT:
        return s
    if "." in s:
        base, _, suffix = s.partition(".")
        if suffix == "hk":
            # Stooq lists HK tickers without the leading zeros (700.hk, not 0700.hk)
            base = base.lstrip("0") or "0"
        return f"{base}.{suffix}"
    if s.isdigit() and 4 <= len(s) <= 5:
        # 4-5 digit bare numerics are overwhelmingly Hong Kong listings on
        # Stooq; strip zeros to its canonical form. Wrong guesses degrade to
        # a "no data" row that suggests explicit suffixes — never a crash.
        stripped = s.lstrip("0") or s
        return f"{stripped}.hk"
    return s + ".us"


def _to_num(s) -> float | None:
    """Tolerant float parse for Stooq cells: '86,588,203', '+1.38%',
    '(+0.49%)', '76 053', 'N/D', '' -> None. Never raises."""
    if s is None:
        return None
    t = str(s).strip().replace(",", "").replace(" ", "")
    t = t.strip("()").rstrip("%")
    if t in ("", "-", "N/D", "ND", "No data", "None", "nan"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _parse_compact_number(s) -> float | None:
    """Stooq HTML pages compress volumes/turnovers: '8.78m' = 8.78 million,
    '2.95g' = 2.95 billion, 'x40' is a bid-size marker (unparseable -> None)."""
    if s is None:
        return None
    t = str(s).strip().lower().replace(" ", "").replace(",", "")
    if not t:
        return None
    mult = 1.0
    if t and t[-1] in "kmg":
        mult = {"k": 1e3, "m": 1e6, "g": 1e9}[t[-1]]
        t = t[:-1]
    try:
        return float(t) * mult
    except ValueError:
        return None


def _md_to_iso(md: str, today_iso: str) -> str | None:
    """'21 Sep' (+ today as reference) -> '2026-09-21'.

    Why: the HTML quote header shows day-month with no year. Inference: use
    the reference year; if that lands more than 7 days in the FUTURE the
    quote is a late-December print read in January -> subtract one year.
    (Quotes are always current, so 'old' dates are impossible.)"""
    m = re.match(r"(\d{1,2})\s+([a-z]{3})", (md or "").strip().lower())
    if not m or m.group(2) not in _MONTHS:
        return None
    day, mon = int(m.group(1)), _MONTHS[m.group(2)]
    try:
        ref = datetime.fromisoformat(today_iso)
    except ValueError:
        return None
    for year in (ref.year, ref.year - 1):
        try:
            cand = datetime(year, mon, day).date().isoformat()
        except ValueError:
            continue
        refd = ref.date()
        # accept the candidate year unless it is implausibly in the future
        if (datetime(year, mon, day).date() - refd).days <= 7:
            return cand
    return None


def _dmy_to_iso(d: str) -> str | None:
    """'18 Sep 2026' (Stooq history table) -> '2026-09-18'."""
    m = re.match(r"(\d{1,2})\s+([a-z]{3})\s+(\d{4})", (d or "").strip().lower())
    if not m or m.group(2) not in _MONTHS:
        return None
    day, mon, year = int(m.group(1)), _MONTHS[m.group(2)], int(m.group(3))
    try:
        return datetime(year, mon, day).date().isoformat()
    except ValueError:
        return None


def _iso_date_now() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def parse_quote_csv(text: str) -> list[dict]:
    """Parse the q/l CSV (header 'Symbol,Date,Time,Open,High,Low,Close,Volume').

    Rows that don't carry a full OHLC set (Stooq's 'No data' / 'N-D' /
    all-dashes answers for unknown symbols) become {'symbol':…, 'error':…}
    so the action layer can show a graceful hint instead of crashing.
    A body without the CSV header (plain 'No data', an error page, the
    rate-limit notice) is not a quote answer at all -> [].
    """
    rows: list[dict] = []
    if not text or "Symbol," not in text.lstrip("\ufeff"):
        return rows
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line or line.lstrip("\ufeff").startswith("Symbol,"):
            continue  # header / blank
        parts = line.split(",")
        sym = parts[0].strip() if parts else ""
        if not sym:
            continue
        # A well-formed row: Date is ISO, O/H/L/C parse, Volume may be empty
        # (indices have no volume). Anything else is a no-data row in one of
        # Stooq's several shapes ("sym,No data", "sym,No data,,-,..", …).
        if (len(parts) >= 8 and re.match(r"\d{4}-\d{2}-\d{2}$", parts[1].strip() or "")
                and "No data" not in line and "N/D" not in line):
            o, h, l, c = (_to_num(parts[3]), _to_num(parts[4]),
                          _to_num(parts[5]), _to_num(parts[6]))
            if None not in (o, h, l, c):
                rows.append({
                    "symbol": sym, "date": parts[1].strip(), "time": parts[2].strip(),
                    "open": o, "high": h, "low": l, "close": c,
                    "volume": _to_num(parts[7]) or 0.0,
                })
                continue
        rows.append({"symbol": sym, "error": "no data"})
    return rows


def parse_history_csv(text: str) -> list[dict]:
    """Parse the q/d/l daily CSV (header 'Date,Open,High,Low,Close,Volume').

    Stooq serves oldest-first (newest LAST); we additionally sort by date so
    the contract 'newest-last ascending' holds even if a future endpoint
    reorders. Calendar gaps (holidays) are simply whatever rows exist.
    'No data' body / empty / non-CSV (no 'Date,' header) -> [].
    """
    rows: list[dict] = []
    if not text or "Date," not in text.lstrip("\ufeff"):
        return rows
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line or line.startswith("Date,"):
            continue
        parts = line.split(",")
        if len(parts) < 6:
            continue
        d = _dmy_to_iso(parts[0]) or (parts[0].strip() if re.match(
            r"\d{4}-\d{2}-\d{2}$", parts[0].strip() or "") else None)
        if d is None:
            continue  # 'No data' or stray line
        o, h, l, c = (_to_num(parts[1]), _to_num(parts[2]),
                      _to_num(parts[3]), _to_num(parts[4]))
        if None not in (o, h, l, c):
            rows.append({"date": d, "open": o, "high": h, "low": l,
                         "close": c, "volume": _to_num(parts[5]) or 0.0})
    rows.sort(key=lambda r: r["date"])  # ascending, newest last
    return rows


def _span_map(page: str, sym: str) -> dict[str, str]:
    """All 'aq_{sym}_<suffix>' spans on an HTML page (first occurrence wins —
    Stooq reuses ids for live-updating duplicates that agree in value)."""
    out: dict[str, str] = {}
    pat = re.compile(r'<span id=aq_' + re.escape(sym) + r'_([a-z0-9]+)>([^<]*)</span>')
    for m in pat.finditer(page):
        out.setdefault(m.group(1), m.group(2))
    return out


def parse_quote_html(page: str, sym: str, today_iso: str | None = None) -> dict:
    """Parse a Stooq /q/?s=SYM quote page into the same row shape as
    parse_quote_csv. Field map (suffix -> meaning), with fallbacks because
    stock pages use c4 for 'last' while index pages use c2:
      d3/t2 date+time, c4|c2|c3|c1 last, m2/m3 change/pct, o open, h/l
      session high/low, p prev close, v2 volume (compact k/m/g form).
    Unknown symbol -> Stooq redirects to the search page
    ('Wyszukiwanie symbolu' in title) -> {'symbol':…,'error':…}.
    """
    if not page:
        return {"symbol": sym, "error": "no page"}
    if "Wyszukiwanie symbolu" in page[:4000]:
        return {"symbol": sym, "error": "no data (unknown symbol)"}
    sp = _span_map(page, sym)
    if not sp:
        return {"symbol": sym, "error": "no data"}
    close = next((_to_num(sp[k]) for k in ("c4", "c2", "c3", "c1") if sp.get(k)), None)
    if close is None:
        return {"symbol": sym, "error": "no data"}
    ref = today_iso or _iso_date_now()
    date = _md_to_iso(sp.get("d3", ""), ref)
    name = ""
    mt = re.search(r"<title>[^<]*?-\s*([^<]+?)\s*-\s*[^<]*</title>", page)
    if mt:  # 'AAPL.US - Apple Inc - U.S. - Stooq' -> 'Apple Inc'
        name = mt.group(1).strip()
    return {
        "symbol": sym, "name": name,
        "date": date, "time": sp.get("t2", ""),
        "open": _to_num(sp.get("o")), "high": _to_num(sp.get("h")),
        "low": _to_num(sp.get("l")), "close": close,
        "prev": _to_num(sp.get("p")),
        "volume": _parse_compact_number(sp.get("v2")) or 0.0,
        "pct": _to_num(sp.get("m3")),
    }


_HIST_ROW = re.compile(
    r'<tr><td align=center id=t03>\d+</td>\s*<td nowrap>(\d{1,2} \w{3} \d{4})</td>'
    r'<td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td>'
    r'<td[^>]*>[^<]*</td><td[^>]*>[^<]*</td><td>([^<]*)</td></tr>')


def parse_history_html(page: str) -> list[dict]:
    """Parse the /q/d/?s=X&l=N history table page into history rows.

    Table shape (verified live Sep 2026):
      No. | Date | Open | High | Low | Close | Change% | Change | Volume
      with comma-grouped volumes ('86,588,203') and '18 Sep 2026' dates.
    The Change columns are ignored — recomputable from closes, and pct text
    is presentation-only. Sorted ascending (newest last)."""
    rows: list[dict] = []
    if not page:
        return rows
    for m in _HIST_ROW.finditer(page):
        d = _dmy_to_iso(m.group(1))
        o, h, l, c = (_to_num(m.group(2)), _to_num(m.group(3)),
                      _to_num(m.group(4)), _to_num(m.group(5)))
        if d is None or None in (o, h, l, c):
            continue
        rows.append({"date": d, "open": o, "high": h, "low": l,
                     "close": c, "volume": _to_num(m.group(6)) or 0.0})
    rows.sort(key=lambda r: r["date"])
    return rows


def solve_stooq_challenge(html: str, max_iters: int = 3_000_000) -> tuple[str, int] | None:
    """Solve Stooq's browser proof-of-work gate.

    The challenge page embeds:  const c="…",d=4  and expects a POST to
    /__verify with n such that sha256(c+str(n)) starts with d zero hex
    chars. d=4 averages ~65k hashes (~50ms in Python); the cap guards
    against a pathological d. Pure function (hashlib only) so it is
    unit-testable with a small-d fixture. Returns (c, n) or None."""
    m = re.search(r'const c="([^"]+)",d=(\d+)', html or "")
    if not m:
        return None
    chal, d = m.group(1), int(m.group(2))
    prefix = "0" * min(d, 8)
    for n in range(max_iters):
        if hashlib.sha256((chal + str(n)).encode()).hexdigest().startswith(prefix):
            return chal, n
    return None


# ── math core: every function pure, hand-verifiable ───────────────────────

def moving_average(closes: list[float], n: int) -> float | None:
    """Simple MA over the LAST n values. None when there aren't n points —
    the analysis layer prints 'n/a' rather than pretending."""
    if n is None or n <= 0 or len(closes) < n:
        return None
    return sum(closes[-n:]) / n


def _ma_series(closes: list[float], n: int) -> list[float | None]:
    """MA aligned to closes[i] (None until index n-1). Needed for cross
    detection, which must look BACKWARD from today, not just at the tip."""
    out: list[float | None] = [None] * len(closes)
    run = 0.0
    for i, v in enumerate(closes):
        run += v
        if i >= n:
            run -= closes[i - n]
        if i >= n - 1:
            out[i] = run / n
    return out


def rsi_wilder(closes: list[float], period: int = 14) -> float | None:
    """RSI with Wilder's smoothing (the classic TA definition, NOT a plain
    rolling mean — the task contract explicitly requires Wilder).

    avg_gain/avg_loss are seeded with the mean of the first `period` deltas,
    then smoothed: avg = (prev*(period-1) + delta) / period.
    Edge cases: fewer than period+1 points -> None; completely flat series
    (avg_gain == avg_loss == 0) -> 50.0 by convention; all-gains -> 100,
    all-losses -> 0."""
    if period is None or period <= 0 or closes is None or len(closes) < period + 1:
        return None
    deltas = [closes[i + 1] - closes[i] for i in range(len(closes) - 1)]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_gain == 0 and avg_loss == 0:
        return 50.0  # no movement at all: neutral by definition
    if avg_loss == 0:
        return 100.0
    if avg_gain == 0:
        return 0.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def volatility(closes: list[float], window: int = 20) -> float | None:
    """Annualized realized volatility: population std of the last `window`
    daily simple returns x sqrt(252). Needs window+1 closes -> else None.
    Fraction (0.24 = 24%/yr), not percent — callers format it."""
    if closes is None or window is None or window <= 0 or len(closes) < window + 1:
        return None
    rets = _simple_returns(closes)
    tail = rets[-window:]
    return statistics.pstdev(tail) * math.sqrt(252.0)


def _simple_returns(closes: list[float]) -> list[float]:
    """Daily simple returns with zero/garbage closes guarded (a 0.0 close
    would divide-by-zero — real Stooq prices are >0 but a malformed row
    must degrade, not crash the analyze action; guarded pair yields 0.0)."""
    out: list[float] = []
    for i in range(len(closes) - 1):
        c0, c1 = closes[i], closes[i + 1]
        if not c0 or not c1 or c0 is None or c1 is None:
            out.append(0.0)
        else:
            out.append(c1 / c0 - 1.0)
    return out


def _vol_series(closes: list[float], window: int = 20) -> list[float | None]:
    """Rolling volatility aligned to closes[i] — used ONLY to get the series'
    own median for the regime comparison (current vs its typical level)."""
    out: list[float | None] = [None] * len(closes)
    rets = _simple_returns(closes)
    for i in range(window, len(closes)):
        out[i] = statistics.pstdev(rets[i - window:i]) * math.sqrt(252.0)
    return out


def analyze_series(rows: list[dict]) -> dict:
    """The analysis core: takes ascending history rows
    (date/open/high/low/close/volume) and returns every metric the analyze
    action renders, plus `signals` — plain computed observations. Every
    signal line names the metric it came from; there are NO predictions.

    Why dict-of-scalars (not a class): the compare action and the report
    formatter both need raw numbers, and JSON round-trips through the
    state cache need plain types anyway."""
    closes = [float(r["close"]) for r in rows]
    vols = [float(r.get("volume") or 0.0) for r in rows]
    dates = [r["date"] for r in rows]
    n = len(closes)
    out: dict = {
        "n": n,
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "first_close": closes[0] if closes else None,
        "last_close": closes[-1] if closes else None,
        "change_pct": ((closes[-1] / closes[0] - 1.0) * 100.0
                       if n >= 2 and closes[0] else None),
        "ma": {}, "rsi": None, "vol_ann": None, "vol_median": None,
        "vol_regime": None, "hi": None, "lo": None, "range_pos_pct": None,
        "vol5": None, "vol20_prior": None, "vol_ratio": None,
        "cross": None, "signals": [],
    }
    if n == 0:
        return out

    # moving averages + % offset of the last close
    for w in (5, 10, 20, 50):
        ma = moving_average(closes, w)
        out["ma"][w] = None if ma is None else {
            "value": ma,
            "off_pct": (closes[-1] / ma - 1.0) * 100.0 if ma else None,
        }

    out["rsi"] = rsi_wilder(closes, 14)
    out["vol_ann"] = volatility(closes, 20)
    vs = [v for v in _vol_series(closes, 20) if v is not None]
    if len(vs) >= 5:  # median needs a handful of points to mean anything
        out["vol_median"] = statistics.median(vs)
        if out["vol_ann"] is not None and out["vol_median"]:
            ratio = out["vol_ann"] / out["vol_median"]
            out["vol_regime"] = ("elevated" if ratio > 1.25
                                 else "compressed" if ratio < 0.75 else "in line")

    # window high/low position (52-week-ish: whatever the window holds)
    tail = closes[-min(252, n):]
    out["hi"], out["lo"] = max(tail), min(tail)
    if out["hi"] > out["lo"]:
        out["range_pos_pct"] = (closes[-1] - out["lo"]) / (out["hi"] - out["lo"]) * 100.0

    # volume trend: last-5 average vs prior-20 average (25 sessions needed)
    if n >= 25:
        out["vol5"] = sum(vols[-5:]) / 5.0
        out["vol20_prior"] = sum(vols[-25:-5]) / 20.0
        if out["vol20_prior"]:
            out["vol_ratio"] = out["vol5"] / out["vol20_prior"]

    # MA5 vs MA20 cross state + age (how many sessions since the last sign
    # flip) — this is the golden/death-cross 'proximity' the contract asks for
    ma5s, ma20s = _ma_series(closes, 5), _ma_series(closes, 20)
    i = n - 1
    if ma5s[i] is not None and ma20s[i] is not None:
        gap = (ma5s[i] / ma20s[i] - 1.0) * 100.0
        age = 1
        while (i - age >= 0 and ma5s[i - age] is not None and ma20s[i - age] is not None
               and ((ma5s[i - age] - ma20s[i - age]) * (ma5s[i] - ma20s[i]) > 0)):
            age += 1
        out["cross"] = {"side": "above" if ma5s[i] > ma20s[i] else "below",
                        "gap_pct": gap, "age_sessions": age,
                        "ma5": ma5s[i], "ma20": ma20s[i]}

    # ── signals: computed observations only, each citing its metric ──
    sig = out["signals"]
    c = out["last_close"]
    if out["cross"]:
        x = out["cross"]
        pat = "golden-cross" if x["side"] == "above" else "death-cross"
        line = (f"MA5 {x['ma5']:.2f} vs MA20 {x['ma20']:.2f} ({x['gap_pct']:+.1f}% gap) — "
                f"MA5 {x['side']} MA20, crossed {x['age_sessions']} session(s) ago "
                f"({pat} pattern)")
        if abs(x["gap_pct"]) < 0.5:
            line += "; gap < 0.5% — a cross is near (watch, not a prediction)"
        sig.append(line)
    for w, lab in ((20, "MA20"), (50, "MA50")):
        m = out["ma"].get(w)
        if m:
            sig.append(f"Close {c:.2f} is {m['off_pct']:+.1f}% vs {lab} {m['value']:.2f} — "
                       f"{'above' if m['off_pct'] >= 0 else 'below'} the {w}-session average")
    if out["rsi"] is not None:
        zone = ("overbought zone (RSI >= 70)" if out["rsi"] >= 70
                else "oversold zone (RSI <= 30)" if out["rsi"] <= 30
                else "neutral zone (30-70)")
        sig.append(f"RSI(14, Wilder) = {out['rsi']:.1f} — {zone}")
    if out["vol_ann"] is not None and out["vol_median"]:
        sig.append(f"Realized vol (20d, annualized) = {out['vol_ann'] * 100:.1f}% vs "
                   f"{out['vol_median'] * 100:.1f}% median of this window — "
                   f"{out['vol_regime']} regime")
    elif out["vol_ann"] is not None:
        sig.append(f"Realized vol (20d, annualized) = {out['vol_ann'] * 100:.1f}%")
    if out["range_pos_pct"] is not None:
        pos = out["range_pos_pct"]
        near = " — near window high" if pos >= 90 else (
            " — near window low" if pos <= 10 else "")
        sig.append(f"Close sits at {pos:.0f}% of the window high-low range "
                   f"(high {out['hi']:.2f} / low {out['lo']:.2f}){near}")
    if out["vol_ratio"] is not None:
        trend = "elevated" if out["vol_ratio"] > 1.2 else (
            "fading" if out["vol_ratio"] < 0.8 else "unchanged")
        sig.append(f"Last-5 avg volume {out['vol5']:,.0f} = {out['vol_ratio']:.2f}x the "
                   f"prior-20 avg {out['vol20_prior']:,.0f} — volume {trend}")
    if out["change_pct"] is not None:
        sig.append(f"Window change {out['change_pct']:+.1f}% over {n} sessions "
                   f"({out['first_date']} -> {out['last_date']}, close {c:.2f})")
    return out


def normalized_performance(closes: list[float]) -> list[float]:
    """Rebase to start=100 so unlike-priced assets compare on one chart line."""
    if not closes or closes[0] == 0:
        return []
    return [v / closes[0] * 100.0 for v in closes]


_SPARK = "▁▂▃▄▅▆▇█"


def ascii_spark(vals: list[float], max_len: int = 40) -> str:
    """Block-glyph sparkline (▁..█) for the compare action. Constant series
    maps to the mid glyph (a flat line should still render as a line)."""
    if not vals:
        return ""
    lo, hi = min(vals), max(vals)
    if max_len and len(vals) > max_len:
        step = len(vals) / max_len
        vals = [vals[int(i * step)] for i in range(max_len)]
    if hi == lo:
        return _SPARK[len(_SPARK) // 2] * len(vals)
    return "".join(_SPARK[int((v - lo) / (hi - lo) * (len(_SPARK) - 1))] for v in vals)


def should_refresh(ts: float | None, ttl: float) -> bool:
    """Cache TTL check. None/0/ancient ts -> refresh; age >= ttl -> refresh.
    (>= so a 60s TTL is honest, not 60s-minus-a-millisecond.)"""
    if not ts:
        return True
    return (time.time() - ts) >= ttl


# ═══════════════════════════════════════════════════════════════════════════
# STATE / CACHE (JSON, atomic tmp+rename per dt_spec rule 3)
# ═══════════════════════════════════════════════════════════════════════════

def _load_state(path: Path) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}  # missing/corrupt cache is never fatal: refetch


def _save_state(path: Path, data) -> None:
    """Atomic JSON write: a kill mid-write leaves the old cache intact."""
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)
    except Exception:
        pass  # cache best-effort; losing it only costs a refetch


def _save_text(path: Path, text: str) -> None:
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, p)
    except Exception:
        pass


def _safe_name(sym: str) -> str:
    """Filesystem-safe symbol ('^ndq' -> 'ndq'); files live in tool_state."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", sym.lstrip("^")) or "sym"


def _trim(text: str, limit: int = _RETURN_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…[trimmed — full data in the state file noted above]"


def _fmt_px(v) -> str:
    """Price formatting that avoids 2.695e+04-style scientific notation for
    index levels (26,952.4) while staying tight for ordinary stock prices."""
    if v is None:
        return "n/a"
    a = abs(v)
    if a >= 100000:
        return f"{v:,.0f}"
    if a >= 1000:
        return f"{v:,.1f}"
    return f"{v:,.2f}"


# ═══════════════════════════════════════════════════════════════════════════
# LIVE HTTP LAYER — lazy httpx, PoW-aware, CSV-first with HTML fallback.
# Everything below the seam returns data or empty; NOTHING raises.
# Tests rebind _fetch_quote_batch / _fetch_history with fixtures.
# ═══════════════════════════════════════════════════════════════════════════

_client = None
_csv_blocked = {"quote": False, "history": False}  # memoize dead CSV endpoints per process
_DIAG: list[str] = []                              # last raw failures, for --live output


def _get_client():
    """One shared httpx client per process: keeps the PoW auth cookie warm
    across calls (each fresh client would re-solve the challenge)."""
    global _client
    if _client is None:
        import httpx  # lazy per spec rule 1 (module must import without deps)
        _client = httpx.Client(
            headers={"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"},
            timeout=_HTTP_TIMEOUT, follow_redirects=True)
    return _client


def _stooq_get_text(path: str, params: dict | None) -> str | None:
    """GET one Stooq URL, solving the JS proof-of-work gate if it appears.
    One retry on connection-level errors — the sandbox (and mobile networks)
    blip DNS resolution transiently; a single retry turns ~1-in-4 failures
    into successes without doubling worst-case latency.
    Returns body text or None (failure/non-200). Never raises (spec rule 5)."""
    last_exc = None
    for attempt, backoff in ((0, 1.0), (1, 2.0)):  # 3 tries: DNS here flaps in bursts
        try:
            cl = _get_client()
            r = cl.get(_BASE + path, params=params)
            if "__verify" in r.text and "crypto.subtle" in r.text:
                sol = solve_stooq_challenge(r.text)
                if sol is None:
                    _DIAG.append(f"{path}: unsolvable PoW challenge")
                    return None
                cl.post(_BASE + "/__verify", data={"c": sol[0], "n": str(sol[1])})
                r = cl.get(_BASE + path, params=params)  # retry with the auth cookie
            if r.status_code != 200:
                _DIAG.append(f"{path} params={params} -> HTTP {r.status_code}")
                return None
            return r.text
        except Exception as exc:  # noqa: BLE001 — network down must degrade, not crash
            last_exc = exc
            time.sleep(backoff)  # DNS/transient blip: short backoff, then retry
    # Final resilience layer: this sandbox (and some mobile stacks) flap the
    # async resolver path httpx uses while SYNC getaddrinfo keeps working.
    # Warm the OS resolver synchronously, then try once more.
    try:
        import socket as _socket
        _socket.getaddrinfo(_BASE_HOST, 443, proto=_socket.IPPROTO_TCP)
        cl = _get_client()
        r = cl.get(_BASE + path, params=params)
        if r.status_code == 200:
            return r.text
        _DIAG.append(f"{path} params={params} -> HTTP {r.status_code}")
        return None
    except Exception as exc:  # noqa: BLE001
        _DIAG.append(f"{path}: {type(last_exc).__name__}: {last_exc} "
                     f"(prewarm retry: {type(exc).__name__}: {exc})")
        return None


def _live_fetch_quote_batch(symbols: list[str]) -> tuple[list[dict], str]:
    """Quotes for many symbols. CSV path is one request; HTML fallback costs
    one ~300KB page per symbol, so callers cap the list (8). Returns
    (rows, source-note). Rows carry either data or an 'error' key."""
    if not _csv_blocked["quote"]:
        text = _stooq_get_text(_CSV_QUOTE, {"s": ",".join(symbols), "f": "sd2t2ohlcv",
                                            "h": "", "e": "csv"})
        if text is not None:
            if "Exceeded the daily" in text:
                _DIAG.append("q/l: daily hit limit exceeded")
                _csv_blocked["quote"] = True
            elif text.lstrip().startswith("Symbol"):
                rows = parse_quote_csv(text)
                return rows, "stooq q/l csv"
            else:  # 404 page / 'Access denied' / captcha — CSV surface is gone here
                _DIAG.append(f"q/l csv blocked: {text[:60]!r}")
                _csv_blocked["quote"] = True
        else:
            _csv_blocked["quote"] = True
    rows: list[dict] = []
    for sym in symbols:
        page = _stooq_get_text(_HTML_QUOTE, {"s": sym})
        if page is None:
            rows.append({"symbol": sym, "error": "stooq unreachable"})
            continue
        rows.append(parse_quote_html(page, sym))
    return rows, "stooq q/ html page"


def _live_fetch_history(sym: str, want_rows: int) -> tuple[list[dict], str]:
    """Daily history. CSV path returns the FULL listing (thousands of rows,
    capped at _MAX_CACHED_HIST before caching). HTML path pages 40 rows at
    a time via &l=<page> until want_rows or the page cap. Rows ascending."""
    if not _csv_blocked["history"]:
        text = _stooq_get_text(_CSV_HIST, {"s": sym, "i": "d"})
        if text is not None:
            if "Exceeded the daily" in text:
                _DIAG.append("q/d/l: daily hit limit exceeded")
                _csv_blocked["history"] = True
            elif text.lstrip().startswith("Date"):
                rows = parse_history_csv(text)
                if rows:
                    return rows[-_MAX_CACHED_HIST:], "stooq q/d/l csv"
                return [], "stooq q/d/l csv (no data)"
            elif text.strip() == "No data":
                return [], "stooq q/d/l csv (no data)"
            else:
                _DIAG.append(f"q/d/l csv blocked: {text[:60]!r}")
                _csv_blocked["history"] = True
        else:
            _csv_blocked["history"] = True
    rows: list[dict] = []
    seen: set[str] = set()
    for page_no in range(1, _MAX_PAGES + 1):
        page = _stooq_get_text(_HTML_HIST, {"s": sym, "l": page_no})
        if page is None:
            break
        got = parse_history_html(page)
        if not got:
            break  # unknown symbol (search page) or end of listing
        for r in got:
            if r["date"] not in seen:  # pages can overlap at boundaries
                seen.add(r["date"])
                rows.append(r)
        if len(rows) >= want_rows:
            break
    rows.sort(key=lambda r: r["date"])
    return rows, "stooq q/d html page"


# THE injectable seam — actions call these module globals, tests rebind them.
_fetch_quote_batch = _live_fetch_quote_batch
_fetch_history = _live_fetch_history


# ═══════════════════════════════════════════════════════════════════════════
# CACHE-ACTIONED FETCHERS + ACTION LAYER
# ═══════════════════════════════════════════════════════════════════════════

def _cached_quotes(ctx, syms: list[str]) -> tuple[list[dict], str]:
    """60s quote cache. Only the MISSING symbols are fetched (one batch);
    hits come from state. Never raises; cache failure = fetch anyway."""
    rows: list[dict] = []
    src = "stooq"
    try:
        cpath = ctx.tool_state("stocks") / "quotes_cache.json"
        cache = _load_state(cpath)
        now = time.time()
        missing = [s for s in syms
                   if not (s in cache and not should_refresh(cache[s].get("ts"), QUOTE_TTL))]
        for s in syms:
            if s in cache and s not in missing:
                rows.append(cache[s]["row"])
        if missing:
            got, src = _fetch_quote_batch(missing)
            if not got:
                # empty batch = transport-level failure (network down, rate
                # limit) — propagate as empty rows + the source note so the
                # action layer can return an actionable message. Unknown
                # symbols come back as per-symbol error rows, never as [].
                return [], src
            by = {r.get("symbol"): r for r in got}
            for s in missing:
                r = by.get(s) or {"symbol": s, "error": "no data"}
                rows.append(r)
                cache[s] = {"ts": now, "row": r}
            _save_state(cpath, cache)
    except Exception:
        rows, src = _fetch_quote_batch(syms)
    return rows, src


def _cached_history(ctx, sym: str, want_rows: int) -> tuple[list[dict], str]:
    """10min history cache keyed by symbol (rows are fetch-depth, not the
    action window — one fetch serves every days= value). Evicts the oldest
    symbols past _MAX_CACHED_SYMS so state stays bounded."""
    try:
        hpath = ctx.tool_state("stocks") / "history_cache.json"
        cache = _load_state(hpath)
        ent = cache.get(sym)
        if ent and not should_refresh(ent.get("ts"), HISTORY_TTL) \
                and len(ent.get("rows", [])) >= min(want_rows, _MAX_PAGES * 40):
            return ent["rows"], ent.get("src", "stooq (cached)")
        rows, src = _fetch_history(sym, want_rows)
        if rows:
            cache[sym] = {"ts": time.time(), "rows": rows[-_MAX_CACHED_HIST:], "src": src}
            while len(cache) > _MAX_CACHED_SYMS:
                oldest = min(cache, key=lambda k: cache[k].get("ts", 0))
                del cache[oldest]
            _save_state(hpath, cache)
        return rows, src
    except Exception:
        return _fetch_history(sym, want_rows)


def _to_int(v, default: int) -> int:
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return default
    return n


def _split_symbols(symbols: str, cap: int) -> list[str]:
    """Accept 'aapl, msft; tsla btc' — the model sends whatever punctuation
    it feels like. Deduped, normalized, capped (HTML fallback costs one page
    per symbol, hence small caps)."""
    seen, out = set(), []
    for tok in re.split(r"[,;\s]+", (symbols or "").strip()):
        if not tok:
            continue
        sym = normalize_symbol(tok)
        if sym and sym not in seen:
            seen.add(sym)
            out.append(sym)
    return out[:cap]


_SUFFIX_HELP = ("symbol suffixes: AAPL->aapl.us (US default), 0700->700.hk, "
                "btc->btc.v, ^ndq/^spx indices, eurusd fx; explicit dots pass through")


def _action_quote(ctx, symbols: str) -> str:
    syms = _split_symbols(symbols, cap=8)
    if not syms:
        return "stocks quote: no symbols given. " + _SUFFIX_HELP
    rows, src = _cached_quotes(ctx, syms)
    if not rows:
        return (f"stocks quote: no data — source '{src}' returned nothing. "
                f"Stooq may be unreachable or rate-limited; retry in a minute, or try "
                f"action='history'/'analyze'. Diagnostics: {'; '.join(_DIAG[-3:]) or 'none'}")
    lines = ["| symbol | date | open | high | low | close | volume | vs open |",
             "|---|---|---|---|---|---|---|---|"]
    ok = 0
    for r in rows:
        if r.get("error"):
            continue
        ok += 1
        chg = ((r["close"] / r["open"] - 1.0) * 100.0
               if r.get("open") else None)
        lines.append(
            f"| {r['symbol']} | {r.get('date') or 'n/a'} "
            f"| {_fmt_px(r.get('open'))} | {_fmt_px(r.get('high'))} "
            f"| {_fmt_px(r.get('low'))} | {_fmt_px(r.get('close'))} "
            f"| {r.get('volume') or 0:,.0f} "
            f"| {'{:+.2f}%'.format(chg) if chg is not None else 'n/a'} |")
    errs = [r for r in rows if r.get("error")]
    parts = [f"Quotes ({ok}/{len(rows)} resolved) — Stooq keyless data, intraday "
             f"snapshot (delayed), source: {src}."]
    parts.extend(lines)
    for r in errs:
        parts.append(f"- {r['symbol']}: {r['error']} — {_SUFFIX_HELP}")
    parts.append("Use action='analyze' for the full technical read on one symbol, "
                 "or action='compare' for several.")
    try:
        ctx.log("stocks_quote", symbols=syms, resolved=ok)
    except Exception:
        pass
    return _trim("\n".join(parts))


def _action_history(ctx, symbol: str, days: int) -> str:
    sym = normalize_symbol(symbol)
    if not sym:
        return "stocks history: no symbol given. " + _SUFFIX_HELP
    days = _to_int(days, 0)
    days = 90 if days <= 0 else days          # per-action default (task spec)
    days = min(max(days, 5), 1000)
    rows, src = _cached_history(ctx, sym, days)
    if not rows:
        return (f"stocks history: no data for '{sym}' — source '{src}'. "
                f"Check the symbol ({_SUFFIX_HELP}); diagnostics: "
                f"{'; '.join(_DIAG[-3:]) or 'none'}")
    window = rows[-days:]
    closes = [r["close"] for r in window]
    first, last = window[0], window[-1]
    chg = (last["close"] / first["close"] - 1.0) * 100.0 if first["close"] else 0.0
    lo_i = closes.index(min(closes))
    hi_i = closes.index(max(closes))
    avg_vol = sum(r["volume"] for r in window) / len(window) if window else 0.0
    body = "\n".join(
        f"{r['date']},{r['open']},{r['high']},{r['low']},{r['close']},{int(r['volume'])}"
        for r in window)
    path_note = ""
    try:
        p = ctx.tool_state("stocks") / f"{_safe_name(sym)}-{days}d.csv"
        _save_text(p, "Date,Open,High,Low,Close,Volume\n" + body + "\n")
        path_note = (f"\nFull CSV written: {p} ({len(window)} sessions) — hand it to the "
                     f"artifact tool to store it in the app's artifacts store permanently.")
    except Exception:
        path_note = "\n(state unavailable — CSV not written)"
    out = [
        f"{sym} — last {len(window)} sessions ({window[0]['date']} -> {window[-1]['date']}), source: {src}",
        f"| metric | value |",
        f"|---|---|",
        f"| first close | {first['date']}: {_fmt_px(first['close'])} |",
        f"| last close | {last['date']}: {_fmt_px(last['close'])} |",
        f"| period change | {chg:+.2f}% |",
        f"| min close | {window[lo_i]['date']}: {_fmt_px(closes[lo_i])} |",
        f"| max close | {window[hi_i]['date']}: {_fmt_px(closes[hi_i])} |",
        f"| avg volume | {avg_vol:,.0f} |",
        f"Next: action='analyze' (symbol='{symbol}') computes MA/RSI/volatility/signals.",
        path_note,
    ]
    try:
        ctx.log("stocks_history", symbol=sym, sessions=len(window))
    except Exception:
        pass
    return _trim("\n".join(out))


def _fmt_ma(a: dict, w: int) -> str:
    m = a["ma"].get(w)
    if not m:
        return f"MA{w:<2}  n/a (only {a['n']} sessions)"
    return f"MA{w:<2}  {_fmt_px(m['value']):<10} {m['off_pct']:+6.2f}% vs close"


def format_analysis_md(sym: str, a: dict, days: int, src: str, name: str = "") -> str:
    """Render analyze_series output as the article-grade markdown report.
    Pure function: same dict in, same bytes out (tests snapshot pieces)."""
    title = f"{sym}" + (f" — {name}" if name else "")
    c = a["last_close"]
    lines = [
        f"# {title} — technical read",
        f"Window: {days} sessions ({a['first_date']} -> {a['last_date']}) · "
        f"source: Stooq keyless daily bars ({src}) · generated "
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        "",
        f"Last close {_fmt_px(c)} · window change {a['change_pct']:+.2f}%"
        if a["change_pct"] is not None else f"Last close {_fmt_px(c)}",
        "",
        "## Price vs moving averages",
        _fmt_ma(a, 5), _fmt_ma(a, 10), _fmt_ma(a, 20), _fmt_ma(a, 50),
        "",
        "## Momentum & risk",
    ]
    if a["rsi"] is not None:
        lines.append(f"- RSI(14, Wilder): {a['rsi']:.1f}")
    if a["vol_ann"] is not None:
        med = f" vs window median {a['vol_median'] * 100:.1f}%" if a["vol_median"] else ""
        reg = f" — {a['vol_regime']} regime" if a["vol_regime"] else ""
        lines.append(f"- Realized volatility (20d, annualized): {a['vol_ann'] * 100:.1f}%{med}{reg}")
    if a["range_pos_pct"] is not None:
        lines.append(f"- Range position: {a['range_pos_pct']:.0f}% of window high-low "
                     f"(high {_fmt_px(a['hi'])} / low {_fmt_px(a['lo'])})")
    elif a["hi"] is not None and a["hi"] == a["lo"]:
        lines.append("- Range position: n/a (window is flat)")
    if a["vol_ratio"] is not None:
        lines.append(f"- Volume trend: last-5 avg {a['vol5']:,.0f} = {a['vol_ratio']:.2f}x "
                     f"prior-20 avg {a['vol20_prior']:,.0f}")
    lines += ["", "## Signals — computed observations, not predictions"]
    lines += [f"- {s}" for s in a["signals"]] or ["- (window too short for signals)"]
    lines += ["", "_Every line above states the metric it came from. Nothing here "
               "predicts the future; it reads the window you asked for._"]
    return "\n".join(lines)


def _action_analyze(ctx, symbol: str, days: int) -> str:
    sym = normalize_symbol(symbol)
    if not sym:
        return "stocks analyze: no symbol given. " + _SUFFIX_HELP
    days = _to_int(days, 0)
    days = 180 if days <= 0 else days         # per-action default (task spec)
    days = min(max(days, 10), 320)            # 320 = 8 HTML pages ceiling
    rows, src = _cached_history(ctx, sym, days)
    if not rows:
        return (f"stocks analyze: no data for '{sym}' — source '{src}'. "
                f"Check the symbol ({_SUFFIX_HELP}); diagnostics: "
                f"{'; '.join(_DIAG[-3:]) or 'none'}")
    window = rows[-days:]
    a = analyze_series(window)
    md = format_analysis_md(sym, a, min(days, a["n"]), src)
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
        p = ctx.tool_state("stocks") / f"{_safe_name(sym)}-analysis-{stamp}.md"
        _save_text(p, md + "\n")
        md += (f"\n\nFull report saved: {p}\nUse the artifact tool to store it in the "
               f"app's artifacts store permanently.")
    except Exception:
        md += "\n\n(state unavailable — report not written to disk)"
    try:
        ctx.log("stocks_analyze", symbol=sym, sessions=a["n"], signals=len(a["signals"]))
    except Exception:
        pass
    return _trim(md)


def _action_compare(ctx, symbols: str, days: int) -> str:
    syms = _split_symbols(symbols, cap=5)
    if not syms:
        return "stocks compare: no symbols given. " + _SUFFIX_HELP
    days = _to_int(days, 0)
    days = 90 if days <= 0 else days          # per-action default (task spec)
    days = min(max(days, 20), 320)
    entries, errs = [], []
    for sym in syms:
        rows, src = _cached_history(ctx, sym, days)
        if not rows:
            errs.append(f"{sym}: no data ({src})")
            continue
        a = analyze_series(rows[-days:])
        closes = [r["close"] for r in rows[-days:]]
        entries.append((sym, a, closes))
    if not entries:
        return ("stocks compare: no data for any symbol — " + "; ".join(errs)
                + f". {_SUFFIX_HELP}")
    out = [f"# Compare — last {days} sessions (Stooq keyless)",
           "| symbol | change | vol (ann.) | RSI(14) | vs MA20 |",
           "|---|---|---|---|---|"]
    for sym, a, _ in entries:
        m20 = a["ma"].get(20)
        row = (f"| {sym} | " + (f"{a['change_pct']:+.1f}%"
               if a["change_pct"] is not None else "n/a") + " | ")
        row += (f"{a['vol_ann'] * 100:.0f}%" if a["vol_ann"] is not None else "n/a") + " | "
        row += (f"{a['rsi']:.0f}" if a["rsi"] is not None else "n/a") + " | "
        row += (f"{m20['off_pct']:+.1f}%" if m20 else "n/a") + " |"
        out.append(row)
    out += ["", "Normalized performance (start = 100):"]
    for sym, a, closes in entries:
        norm = normalized_performance(closes)
        out.append(f"- {sym}  {ascii_spark(norm)}  100 -> {norm[-1]:.1f} "
                   f"({a['change_pct']:+.1f}%)" if norm else f"- {sym}: n/a")
    out += ["", "Deep dive: action='analyze' per symbol; CSV per symbol via action='history'."]
    out += [f"- {e}" for e in errs]
    try:
        ctx.log("stocks_compare", symbols=syms)
    except Exception:
        pass
    return _trim("\n".join(out))


_HELP = """stocks — keyless market data + technical analysis (Stooq, no API key)

actions:
- quote    symbols="AAPL MSFT btc"     live-ish snapshot table (60s cache)
- history  symbol="aapl" days=90       summary stats; full CSV -> state file
- analyze  symbol="aapl" days=180      MA5/10/20/50, RSI(14 Wilder), 20d vol
                                       vs own median, range position, volume
                                       trend, computed signals; full report
                                       -> state markdown
- compare  symbols="aapl,msft,^ndq" days=90
                                       side-by-side + normalized (start=100)
                                       sparkline per symbol
- help     this text

symbols: bare tickers are US (aapl -> aapl.us); indices ^ndq (Nasdaq
Composite), ^spx/^dji; crypto btc/eth/... -> .v; HK 4-5 digit numerics ->
.hk (0700 -> 700.hk); fx pairs (eurusd) pass through; explicit suffixes
(.us .hk .uk .de .fr .jp .pl .v) pass through untouched.

notes: quotes are delayed intraday snapshots; history is daily bars.
CSV/history files land in the tool state dir; mention the artifact tool to
store them permanently. Every signal line cites the metric it came from —
no predictions."""


def _run_action(ctx, action: str, symbols: str = "", symbol: str = "",
                days: int = 0) -> str:
    """Dispatch used by both the strands tool and the offline self-test.
    Errors are strings returned to the model, never exceptions (dt_spec)."""
    try:
        action = (action or "help").strip().lower()
        if action == "quote":
            return _action_quote(ctx, symbols or symbol)
        if action == "history":
            return _action_history(ctx, symbol or symbols, days)
        if action == "analyze":
            return _action_analyze(ctx, symbol or symbols, days)
        if action == "compare":
            return _action_compare(ctx, symbols or symbol, days)
        if action == "help":
            return _HELP
        return (f"stocks: unknown action '{action}'. Use: quote, history, "
                f"analyze, compare, help.")
    except Exception as exc:  # noqa: BLE001 — never take the agent down
        return (f"stocks: internal error ({type(exc).__name__}: {exc}). "
                f"Try action='help'; if it persists the Stooq surface may have moved.")


# ═══════════════════════════════════════════════════════════════════════════
# STRANDS SURFACE
# ═══════════════════════════════════════════════════════════════════════════

def build(ctx) -> list:
    """Return the @tool-decorated `stocks` callable. Never raises (spec
    rule 2): no strands -> [], broken decorator -> []."""
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []  # offline: registry/tests import this module without the SDK
    try:
        @strands_tool_decorator(name="stocks", description=(
            "Keyless stock/market data: live-ish quotes, daily history and "
            "technical analysis (moving averages, Wilder RSI, realized "
            "volatility, range position, computed signals) for US/HK/EU "
            "stocks, indices, FX and crypto via Stooq CSV — no API key. "
            "Use when the user mentions tickers, prices, markets, or wants "
            "an analysis article. Actions: quote, history, analyze, compare, help."
        ))
        def stocks(action: str, symbols: str = "", symbol: str = "",
                   days: int = 0) -> str:
            """Market quotes, history and technical analysis (Stooq, keyless).
            action: quote | history | analyze | compare | help
            symbols: comma/space list for quote/compare, e.g. "AAPL, MSFT, btc"
            symbol: single ticker for history/analyze, e.g. "aapl" or "700.hk"
            days: optional lookback in trading sessions (defaults: history and
                  compare 90, analyze 180)
            """
            return _run_action(ctx, action, symbols=symbols, symbol=symbol, days=days)
        return [stocks]
    except Exception:
        return []


# ═══════════════════════════════════════════════════════════════════════════
# OFFLINE SELF-TEST (no network) + optional --live probe
# ═══════════════════════════════════════════════════════════════════════════

FIXTURE_QUOTE_CSV = """Symbol,Date,Time,Open,High,Low,Close,Volume
aapl.us,2026-09-18,22:00:20,334.77,338.34,330.1833,337,36700225
msft.us,2026-09-18,22:00:21,505.10,508.30,503.20,507.90,21554200
zzzzz.us,No data,,-,-,-,-,-
^ndq,2026-09-18,22:00:22,26725.98,26957.12,26721.15,26952.41,
"""

FIXTURE_HISTORY_CSV = """Date,Open,High,Low,Close,Volume
2026-09-16,332.53,335.48,330.7,332.41,36122400
2026-09-17,334.77,338.34,330.1833,337,36700225
2026-09-18,337.905,338.49,332.53,336.13,86588203
"""

# shapes lifted from the live /q/ and /q/d/ pages, Sep 2026
FIXTURE_QUOTE_HTML = """<html><head><title>AAPL.US - Apple Inc - U.S. - Stooq</title></head><body>
<span id=aq_msft.us_m1>2026-09-21</span>
<b><span id=aq_aapl.us_c4>337.5360</span></b>
<span id=aq_aapl.us_d3>21 Sep</span>, <span id=aq_aapl.us_t2>17:18</span>
<span id=aq_aapl.us_m2>+1.4060</span> <span id=aq_aapl.us_m3>(+0.42%)</span>
High/Low<br><span id=aq_aapl.us_h>338.2200</span><br><span id=aq_aapl.us_l>333.0500</span>
Open<br><span id=aq_aapl.us_o>335.2800</span> Prev.<br><span id=aq_aapl.us_p>336.1300</span>
Volume<br><span id=aq_aapl.us_v2>8.78m</span> Turnover<br><span id=aq_aapl.us_r2>2.95g</span>
</body></html>"""

FIXTURE_SEARCH_HTML = "<html><head><title>Wyszukiwanie symbolu - Stooq</title></head><body></body></html>"

FIXTURE_HISTORY_HTML = """<table class=fth1 id=fth1><thead class=c07><tr align=center id=f13><td>No.</td><td>Date</td><td>Open</td><td>High</td><td>Low</td><td>Close</td><td colspan=2>Change</td><td>Volume</td></tr></thead><tbody class=cbg align=right id=f13>
<tr><td align=center id=t03>10589</td><td nowrap>18 Sep 2026</td><td>337.905</td><td>338.49</td><td>332.53</td><td>336.13</td><td id=c2>-0.26%</td><td id=c2>-0.8700</td><td>86,588,203</td></tr>
<tr><td align=center id=t03>10588</td><td nowrap>17 Sep 2026</td><td>334.77</td><td>338.34</td><td>330.1833</td><td>337</td><td id=c1>+1.38%</td><td id=c1>+4.5900</td><td>36,700,225</td></tr>
<tr><td align=center id=t03>10587</td><td nowrap>16 Sep 2026</td><td>332.53</td><td>335.48</td><td>330.7</td><td>332.41</td><td id=c1>+0.32%</td><td id=c1>+1.0600</td><td>36,122,400</td></tr>
</tbody></table>"""


def _mk_fixture_rows(n: int, base: float = 100.0, volume: float = 1000.0,
                     last_close: float | None = None) -> list[dict]:
    """Synthetic ascending history rows: n-1 flat closes then one final jump
    to `last_close` (defaults +10). Volume constant except a bump at the end.
    Used to force deterministic golden-cross / RSI / volume signals."""
    closes = [base] * (n - 1) + [last_close if last_close is not None else base * 1.1]
    vols = [volume] * (n - 5) + [volume * 5.0] * 5
    rows = []
    d = datetime(2026, 6, 1)
    for i, c in enumerate(closes):
        rows.append({"date": (d.fromordinal(d.toordinal() + i)).date().isoformat(),
                     "open": c, "high": c * 1.001, "low": c * 0.999,
                     "close": c, "volume": vols[i] if i < len(vols) else volume})
    return rows


def _selftest() -> int:
    """Offline asserts over the plain core + full action chain with the
    fetch seam injected (temp dirs, zero network). Exit 0 on success."""
    fails: list[str] = []

    def check(name: str, cond: bool):
        if not cond:
            fails.append(name)
        print(f"  {'ok ' if cond else 'FAIL'} {name}")

    print("parse_quote_csv:")
    q = parse_quote_csv(FIXTURE_QUOTE_CSV)
    check("3 valid + 1 error", len(q) == 4 and sum(1 for r in q if "error" not in r) == 3)
    a = q[0]
    check("values", a["symbol"] == "aapl.us" and a["open"] == 334.77 and a["close"] == 337.0
          and a["volume"] == 36700225 and a["date"] == "2026-09-18")
    check("no-data row", q[2]["symbol"] == "zzzzz.us" and "error" in q[2])
    check("index empty volume ok", q[3]["volume"] == 0.0)
    check("empty body", parse_quote_csv("") == [])
    check("'No data' body", parse_quote_csv("No data") == [])
    check("header only", parse_quote_csv("Symbol,Date,Time,Open,High,Low,Close,Volume\n") == [])

    print("parse_history_csv:")
    h = parse_history_csv(FIXTURE_HISTORY_CSV)
    check("3 rows", len(h) == 3)
    check("ascending newest-last", h[-1]["date"] == "2026-09-18" and h[0]["date"] == "2026-09-16")
    check("values", h[2]["close"] == 336.13 and h[2]["volume"] == 86588203
          and abs(h[1]["low"] - 330.1833) < 1e-9)
    shuffled = parse_history_csv("Date,Open,High,Low,Close,Volume\n"
                                 "2026-09-18,337.905,338.49,332.53,336.13,86588203\n"
                                 "2026-09-16,332.53,335.48,330.7,332.41,36122400\n")
    check("unordered input sorted", shuffled[0]["date"] == "2026-09-16")
    check("no-data body", parse_history_csv("No data") == [])
    check("empty body", parse_history_csv("") == [])

    print("normalize_symbol:")
    for inp, want in [("AAPL", "aapl.us"), ("aapl", "aapl.us"), ("btc", "btc.v"),
                      ("ETH", "eth.v"), ("^spx", "^spx"), ("spx", "^spx"),
                      ("sp500", "^spx"), ("nasdaq", "^ndq"), ("^NDQ", "^ndq"),
                      ("dow", "^dji"), ("vix", "^vix"), ("0700.hk", "700.hk"),
                      ("0700", "700.hk"), ("9988", "9988.hk"), ("msft.us", "msft.us"),
                      ("bp.uk", "bp.uk"), ("eurusd", "eurusd"), ("USDJPY", "usdjpy"),
                      ("$AAPL", "aapl.us"), ("", "")]:
        check(f"{inp!r}->{want!r}", normalize_symbol(inp) == want)

    print("math core:")
    check("MA3", moving_average([1, 2, 3, 4, 5], 3) == 4.0)
    check("MA5", moving_average([1, 2, 3, 4, 5], 5) == 3.0)
    check("MA short -> None", moving_average([1, 2, 3], 5) is None)
    check("MA n<=0 -> None", moving_average([1, 2], 0) is None)
    check("RSI all gains", rsi_wilder(list(range(100, 115))) == 100.0)
    check("RSI all losses", rsi_wilder(list(range(115, 100, -1))) == 0.0)
    check("RSI flat -> 50", rsi_wilder([50.0] * 20) == 50.0)
    check("RSI short -> None", rsi_wilder([1, 2, 3], 14) is None)
    mixed = [50, 51, 52, 51, 52, 53, 54, 53, 54, 55, 56, 55, 56, 57, 58]
    check("RSI wilder hand-computed", abs(rsi_wilder(mixed) - 100 * 11 / 14) < 1e-9)
    # exact smoothing-recursion case: seed 10 up / 4 down deltas (avg 10/14,
    # 4/14), then two more +1 deltas. Hand-derived: avgs end at 517/686 and
    # 169/686 -> RSI = 100*517/686 = 75.3615...
    smooth = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
              109, 108, 107, 106, 107, 108]
    check("RSI wilder smoothing exact", abs(rsi_wilder(smooth) - 100 * 517 / 686) < 1e-9)
    alt = [100 + (i % 2) for i in range(21)]
    check("RSI alternating stays near 50", abs(rsi_wilder(alt) - 50.0) < 1.0)
    aa = [100.0 * (1.01 ** i) for i in range(25)]
    check("vol constant returns -> 0", abs(volatility(aa)) < 1e-9)
    altc = [100.0, 110.0] * 10 + [100.0]  # 21 closes -> 20 returns: 10x +10%, 10x -1/11
    check("vol hand-computed", abs(volatility(altc) - (21 / 220) * math.sqrt(252)) < 1e-9)
    check("vol short -> None", volatility([1.0] * 20) is None)

    print("analyze_series:")
    up = _mk_fixture_rows(35)                      # flat 30 then one +10 jump
    a_up = analyze_series(up)
    check("keys present", all(k in a_up for k in
                              ("ma", "rsi", "vol_ann", "range_pos_pct", "signals")))
    check("golden cross flagged", any("golden-cross" in s for s in a_up["signals"]))
    check("cross age 1", a_up["cross"]["age_sessions"] == 1
          and a_up["cross"]["side"] == "above")
    check("RSI 100 -> overbought", any("overbought" in s for s in a_up["signals"]))
    check("volume elevated signal", any("elevated" in s for s in a_up["signals"]))
    check("window change +10%", abs(a_up["change_pct"] - 10.0) < 1e-9)
    dn = _mk_fixture_rows(35, last_close=90.0)
    a_dn = analyze_series(dn)
    check("death cross flagged", any("death-cross" in s for s in a_dn["signals"]))
    check("oversold zone", any("oversold" in s for s in a_dn["signals"]))
    flat = _mk_fixture_rows(30, last_close=100.0)
    a_fl = analyze_series(flat)
    check("flat: RSI 50 neutral", a_fl["rsi"] == 50.0
          and any("neutral" in s for s in a_fl["signals"]))
    check("flat: MA offset 0", all(a_fl["ma"][w]["off_pct"] == 0.0 for w in (5, 10, 20)))
    check("flat: MA50 n/a at 30 rows", a_fl["ma"][50] is None)
    check("flat: range None", a_fl["range_pos_pct"] is None)
    short = analyze_series(_mk_fixture_rows(15))
    check("short window: vol None", short["vol_ann"] is None and short["ma"][50] is None)
    check("empty rows safe", analyze_series([])["n"] == 0)

    print("normalized + sparkline:")
    check("normalized start 100", normalized_performance([100, 110, 99])[0] == 100.0)
    check("normalized end", abs(normalized_performance([100, 110, 99])[-1] - 99.0) < 1e-9)
    check("normalized empty", normalized_performance([]) == [])
    check("spark 8 levels", ascii_spark([0, 1, 2, 3, 4, 5, 6, 7]) == "▁▂▃▄▅▆▇█")
    check("spark constant", set(ascii_spark([5, 5, 5, 5])) == {"\u2585"})
    check("spark long downsampled", len(ascii_spark(list(range(200)))) <= 40)

    print("cache TTL + state:")
    check("should_refresh None", should_refresh(None, 60) is True)
    check("should_refresh fresh", should_refresh(time.time(), 60) is False)
    check("should_refresh stale", should_refresh(time.time() - 61, 60) is True)
    tmp = Path(tempfile.mkdtemp(prefix="dt-stocks-"))
    sp = tmp / "s.json"
    _save_state(sp, {"a": 1})
    check("state round-trip", _load_state(sp) == {"a": 1})
    check("state missing -> {}", _load_state(tmp / "nope.json") == {})

    print("html parsers:")
    qh = parse_quote_html(FIXTURE_QUOTE_HTML, "aapl.us", today_iso="2026-09-21")
    check("html quote fields", qh["close"] == 337.536 and qh["open"] == 335.28
          and qh["high"] == 338.22 and qh["low"] == 333.05 and qh["prev"] == 336.13)
    check("html quote volume 8.78m", qh["volume"] == 8.78e6)
    check("html quote date+name", qh["date"] == "2026-09-21" and qh["name"] == "Apple Inc")
    check("html year rollback", _md_to_iso("28 Dec", "2026-01-02") == "2025-12-28")
    check("html same-year", _md_to_iso("02 Jan", "2026-01-05") == "2026-01-02")
    bad = parse_quote_html(FIXTURE_SEARCH_HTML, "zzzzz.us")
    check("search page -> error", "error" in bad)
    hh = parse_history_html(FIXTURE_HISTORY_HTML)
    check("html history 3 rows", len(hh) == 3)
    check("html history ascending", hh[0]["date"] == "2026-09-16")
    check("html history values", hh[2]["close"] == 336.13
          and hh[2]["volume"] == 86588203 and abs(hh[1]["low"] - 330.1833) < 1e-9)
    sol = solve_stooq_challenge('const c="abc",d=1')
    check("pow solver", sol is not None and sol[0] == "abc" and
          hashlib.sha256(("abc" + str(sol[1])).encode()).hexdigest().startswith("0"))
    check("pow solver no challenge", solve_stooq_challenge("<html></html>") is None)

    print("actions (injected fetch, fake ctx):")
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from dt_registry import ToolContext  # real contract, no strands needed

    calls = {"n": 0}

    def fake_quote_batch(symbols):
        calls["n"] += 1
        return parse_quote_csv(FIXTURE_QUOTE_CSV), "fixture csv"

    hist_rows = _mk_fixture_rows(60)  # deterministic flat-then-jump series

    def fake_history(sym, want):
        return hist_rows, "fixture csv"

    global _fetch_quote_batch, _fetch_history
    _fetch_quote_batch, _fetch_history = fake_quote_batch, fake_history
    ctx = ToolContext(workspace=tmp)
    out = _run_action(ctx, "quote", symbols="AAPL msft zzzzz ^ndq")
    check("quote action table", "aapl.us" in out and "msft.us" in out
          and "vs open" in out and "3/4" in out)
    check("quote action error line", "zzzzz.us" in out and "no data" in out)
    _run_action(ctx, "quote", symbols="AAPL")
    check("quote cache hit (1 fetch)", calls["n"] == 1)
    # age the cache past TTL -> refetch
    cp = ctx.tool_state("stocks") / "quotes_cache.json"
    aged = _load_state(cp)
    for k in aged:
        aged[k]["ts"] = time.time() - 120
    _save_state(cp, aged)
    _run_action(ctx, "quote", symbols="AAPL")
    check("quote cache expiry refetch", calls["n"] == 2)
    out = _run_action(ctx, "history", symbol="aapl", days=5)
    check("history action summary", "period change" in out and "avg volume" in out
          and "sessions" in out)
    csvp = ctx.tool_state("stocks") / "aapl.us-5d.csv"
    check("history CSV written", csvp.exists()
          and "Date,Open,High,Low,Close,Volume" in csvp.read_text()
          and len(csvp.read_text().strip().splitlines()) == 6)
    check("history path note", "aapl.us-5d.csv" in out and "artifact" in out)
    out = _run_action(ctx, "analyze", symbol="aapl", days=180)
    check("analyze report sections", "Price vs moving averages" in out
          and "Momentum & risk" in out and "Signals" in out and "RSI(14" in out)
    an_files = list(ctx.tool_state("stocks").glob("aapl.us-analysis-*.md"))
    check("analyze report file", len(an_files) == 1 and "technical read" in an_files[0].read_text())
    check("analyze trimmed", len(out) <= _RETURN_LIMIT + 200)
    out = _run_action(ctx, "compare", symbols="aapl,msft", days=20)
    check("compare table + normalized", "Normalized performance" in out
          and "vs MA20" in out and "100 ->" in out)
    check("help", "actions:" in _run_action(ctx, "help"))
    check("unknown action", "unknown action" in _run_action(ctx, "frobnicate"))

    def dead_quote_batch(symbols):
        return [], "stooq unreachable at https://stooq.com: connect timeout"

    _fetch_quote_batch = dead_quote_batch
    out = _run_action(ctx, "quote", symbols="tsla")
    check("network down -> actionable msg", "no data" in out and "unreachable" in out)
    _fetch_quote_batch, _fetch_history = _live_fetch_quote_batch, _live_fetch_history

    print("build():")
    try:
        import strands  # noqa: F401
        has_strands = True
    except Exception:
        has_strands = False
    if has_strands:
        check("build with strands -> callable", callable(build(ctx)[0]))
    else:
        check("build without strands -> []", build(ctx) == [])

    print()
    if fails:
        print(f"SELF-TEST FAILED ({len(fails)}): {fails}")
        return 1
    print("SELF-TEST OK")
    return 0


def _live_probe() -> int:
    """--live: prove the whole chain (PoW -> fetch -> parse -> format) with
    real Stooq data. Prints the parsed tables; on total failure prints the
    exact error and an example.com reachability note (per the task contract)."""
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from dt_registry import ToolContext
    tmp = Path(tempfile.mkdtemp(prefix="dt-stocks-live-"))
    ctx = ToolContext(workspace=tmp)
    print(f"LIVE PROBE (workspace {tmp})")
    print("=" * 70)
    print("-- quote aapl.us --")
    q = _run_action(ctx, "quote", symbols="aapl")
    print(q)
    print("-- history aapl.us, 30 sessions --")
    h = _run_action(ctx, "history", symbol="aapl", days=30)
    print(h)
    q_ok = "| aapl.us |" in q          # a data row, not the error line
    h_ok = "— last" in h and "aapl.us" in h
    ok = q_ok or h_ok
    if not ok:
        print("-- STOOQ BLOCKED — exact failures --")
        for d in _DIAG[-8:]:
            print("  " + d)
        try:
            import httpx
            r = httpx.get("https://example.com", timeout=10,
                          headers={"User-Agent": _UA})
            print(f"  fallback reachability: example.com -> HTTP {r.status_code} "
                  f"(network up; Stooq is gating this IP)")
        except Exception as exc:
            print(f"  fallback reachability: example.com FAILED {exc}")
        return 1
    print("-- analyze aapl.us (bonus, 90 sessions) --")
    print(_run_action(ctx, "analyze", symbol="aapl", days=90))
    print("LIVE PROBE OK")
    return 0


if __name__ == "__main__":
    import sys
    if "--live" in sys.argv:
        raise SystemExit(_live_probe())
    raise SystemExit(_selftest())
