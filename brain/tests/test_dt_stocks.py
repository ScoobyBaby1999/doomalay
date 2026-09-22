"""test_dt_stocks.py — offline unit tests for brain/tools/dt_stocks.py.

Covers the plain core only: no strands, no network, no engine. The CSV and
HTML fixture strings are copies of the real Stooq body shapes the module's
own self-test lifted live (Sep 2026); the indicator math is hand-computed
here (closed forms, not "whatever the module returns"). The live HTTP layer
runs through the module's OWN injection seam — the docstring explicitly
reserves the module globals _fetch_quote_batch / _fetch_history for tests
to rebind — and every rebinding restores the originals in a finally block
so pytest stays hermetic and order-independent.

Runs standalone (`python3 tests/test_dt_stocks.py`) AND under pytest.
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
import statistics
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# Import the tool module straight from brain/tools/ (no package layout),
# plus the real ToolContext from brain/ so the action chain is exercised
# against the actual registry contract, not a hand-rolled fake.
_BRAIN_DIR = Path(__file__).resolve().parent.parent
_TOOLS_DIR = _BRAIN_DIR / "tools"
for _p in (str(_TOOLS_DIR), str(_BRAIN_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import dt_stocks  # noqa: E402
from dt_registry import ToolContext  # noqa: E402

# ── fixture strings (copied verbatim from dt_stocks.py's self-test) ────────
QUOTE_CSV = """Symbol,Date,Time,Open,High,Low,Close,Volume
aapl.us,2026-09-18,22:00:20,334.77,338.34,330.1833,337,36700225
msft.us,2026-09-18,22:00:21,505.10,508.30,503.20,507.90,21554200
zzzzz.us,No data,,-,-,-,-,-
^ndq,2026-09-18,22:00:22,26725.98,26957.12,26721.15,26952.41,
"""

HIST_CSV = """Date,Open,High,Low,Close,Volume
2026-09-16,332.53,335.48,330.7,332.41,36122400
2026-09-17,334.77,338.34,330.1833,337,36700225
2026-09-18,337.905,338.49,332.53,336.13,86588203
"""

QUOTE_HTML = """<html><head><title>AAPL.US - Apple Inc - U.S. - Stooq</title></head><body>
<span id=aq_msft.us_m1>2026-09-21</span>
<b><span id=aq_aapl.us_c4>337.5360</span></b>
<span id=aq_aapl.us_d3>21 Sep</span>, <span id=aq_aapl.us_t2>17:18</span>
<span id=aq_aapl.us_m2>+1.4060</span> <span id=aq_aapl.us_m3>(+0.42%)</span>
High/Low<br><span id=aq_aapl.us_h>338.2200</span><br><span id=aq_aapl.us_l>333.0500</span>
Open<br><span id=aq_aapl.us_o>335.2800</span> Prev.<br><span id=aq_aapl.us_p>336.1300</span>
Volume<br><span id=aq_aapl.us_v2>8.78m</span> Turnover<br><span id=aq_aapl.us_r2>2.95g</span>
</body></html>"""

SEARCH_HTML = ("<html><head><title>Wyszukiwanie symbolu - Stooq</title></head>"
               "<body></body></html>")

HIST_HTML = """<table class=fth1 id=fth1><thead class=c07><tr align=center id=f13><td>No.</td><td>Date</td><td>Open</td><td>High</td><td>Low</td><td>Close</td><td colspan=2>Change</td><td>Volume</td></tr></thead><tbody class=cbg align=right id=f13>
<tr><td align=center id=t03>10589</td><td nowrap>18 Sep 2026</td><td>337.905</td><td>338.49</td><td>332.53</td><td>336.13</td><td id=c2>-0.26%</td><td id=c2>-0.8700</td><td>86,588,203</td></tr>
<tr><td align=center id=t03>10588</td><td nowrap>17 Sep 2026</td><td>334.77</td><td>338.34</td><td>330.1833</td><td>337</td><td id=c1>+1.38%</td><td id=c1>+4.5900</td><td>36,700,225</td></tr>
<tr><td align=center id=t03>10587</td><td nowrap>16 Sep 2026</td><td>332.53</td><td>335.48</td><td>330.7</td><td>332.41</td><td id=c1>+0.32%</td><td id=c1>+1.0600</td><td>36,122,400</td></tr>
</tbody></table>"""


# ── helpers ───────────────────────────────────────────────────────────────

def _rows(closes: list[float], vols: list[float] | None = None) -> list[dict]:
    """Hand-built ascending history rows (date/ohlc/volume) — same shape
    parse_history_csv emits, so analyze_series tests are independent of the
    module's own _mk_fixture_rows generator."""
    vols = vols or [1000.0] * len(closes)
    d0 = datetime(2026, 6, 1).toordinal()
    return [{"date": datetime.fromordinal(d0 + i).date().isoformat(),
             "open": c, "high": c * 1.001, "low": c * 0.999,
             "close": c, "volume": v}
            for i, (c, v) in enumerate(zip(closes, vols))]


@contextmanager
def _ctx():
    """Fresh ToolContext over a temp workspace (real registry contract:
    state lands in <tmp>/.doomalay/stocks/, ctx.log exists)."""
    tmp = Path(tempfile.mkdtemp(prefix="dt-stocks-test-"))
    try:
        yield ToolContext(workspace=tmp), tmp
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@contextmanager
def _injected(quote=None, history=None):
    """Rebind the module's documented fetch seam; always restore, so one
    test's fake can never leak into another (pytest shares the module)."""
    orig_q, orig_h = dt_stocks._fetch_quote_batch, dt_stocks._fetch_history
    try:
        if quote is not None:
            dt_stocks._fetch_quote_batch = quote
        if history is not None:
            dt_stocks._fetch_history = history
        yield
    finally:
        dt_stocks._fetch_quote_batch = orig_q
        dt_stocks._fetch_history = orig_h


# ── CSV parsing (real Stooq shapes) ───────────────────────────────────────

def test_parse_quote_csv_fixture():
    q = dt_stocks.parse_quote_csv(QUOTE_CSV)
    assert len(q) == 4 and sum(1 for r in q if "error" not in r) == 3
    a = q[0]
    assert a["symbol"] == "aapl.us" and a["date"] == "2026-09-18"
    assert a["time"] == "22:00:20"
    assert a["open"] == 334.77 and a["high"] == 338.34
    assert abs(a["low"] - 330.1833) < 1e-9 and a["close"] == 337.0
    assert a["volume"] == 36700225.0
    m = q[1]
    assert m["symbol"] == "msft.us" and m["close"] == 507.9
    # indices carry no volume cell — must degrade to 0.0, not crash
    assert q[3]["symbol"] == "^ndq" and q[3]["close"] == 26952.41
    assert q[3]["volume"] == 0.0
    # unknown symbols come back as per-symbol error rows, never dropped rows
    assert q[2] == {"symbol": "zzzzz.us", "error": "no data"}


def test_parse_quote_csv_edge_cases():
    assert dt_stocks.parse_quote_csv("") == []               # empty body
    assert dt_stocks.parse_quote_csv("No data") == []        # bare text
    # a body without the CSV header is not a quote answer at all
    assert dt_stocks.parse_quote_csv("<html>Access denied</html>") == []
    assert dt_stocks.parse_quote_csv(
        "Symbol,Date,Time,Open,High,Low,Close,Volume\n") == []  # header only
    # (BOM-prefixed headers are NOT asserted here: the module's own header
    # skip misses a BOM'd line and emits a spurious error row — reported to
    # the orchestrator, not cemented as expected behavior in this suite.)
    # CRLF line endings normalised
    crlf = QUOTE_CSV.replace("\n", "\r\n")
    q = dt_stocks.parse_quote_csv(crlf)
    assert len(q) == 4 and q[0]["symbol"] == "aapl.us"
    # the other no-data shapes Stooq uses
    for bad in ("zzz.us,N/D,,-,-,-,-,-",
                "zzz.us,2026-09-18,22:00,1,2,3,N/D,100",
                "zzz.us",
                "zzz.us,short,row"):
        q = dt_stocks.parse_quote_csv(
            "Symbol,Date,Time,Open,High,Low,Close,Volume\n" + bad + "\n")
        assert len(q) == 1 and q[0]["symbol"] == "zzz.us" and "error" in q[0], bad


def test_parse_history_csv_fixture():
    h = dt_stocks.parse_history_csv(HIST_CSV)
    assert len(h) == 3
    # contract: ascending, newest LAST
    assert [r["date"] for r in h] == ["2026-09-16", "2026-09-17", "2026-09-18"]
    assert h[0]["close"] == 332.41 and h[0]["volume"] == 36122400.0
    assert abs(h[1]["low"] - 330.1833) < 1e-9
    assert h[2]["close"] == 336.13 and h[2]["volume"] == 86588203.0
    assert h[2]["open"] == 337.905 and h[2]["high"] == 338.49


def test_parse_history_csv_edge_cases():
    assert dt_stocks.parse_history_csv("") == []
    assert dt_stocks.parse_history_csv("No data") == []
    assert dt_stocks.parse_history_csv("Exceeded the daily hits limit") == []
    # unordered input is re-sorted to ascending (newest last)
    shuffled = dt_stocks.parse_history_csv(
        "Date,Open,High,Low,Close,Volume\n"
        "2026-09-18,337.905,338.49,332.53,336.13,86588203\n"
        "2026-09-16,332.53,335.48,330.7,332.41,36122400\n")
    assert [r["date"] for r in shuffled] == ["2026-09-16", "2026-09-18"]
    # short rows and N/D closes are skipped, not crashed on
    skip = dt_stocks.parse_history_csv(
        "Date,Open,High,Low,Close,Volume\n"
        "2026-09-19,1\n"
        "2026-09-20,1,2,3,N/D,100\n"
        "2026-09-21,1,2,3,4,5\n")
    assert len(skip) == 1 and skip[0]["date"] == "2026-09-21"
    # '18 Sep 2026' style dates (the HTML table shape) also resolve
    dmy = dt_stocks.parse_history_csv(
        "Date,Open,High,Low,Close,Volume\n18 Sep 2026,1,2,3,4,5\n")
    assert dmy[0]["date"] == "2026-09-18"


# ── symbol normalisation ──────────────────────────────────────────────────

def test_normalize_symbol():
    for inp, want in [
        ("AAPL", "aapl.us"),          # bare ticker -> US default
        ("aapl", "aapl.us"),
        ("  $AAPL ", "aapl.us"),      # case, $ prefix, whitespace tolerated
        ("btc", "btc.v"),             # crypto -> .v
        ("ETH", "eth.v"),
        ("sp500", "^spx"),            # index aliases
        ("spx", "^spx"),
        ("^spx", "^spx"),             # caret passthrough
        ("nasdaq", "^ndq"),
        ("^NDQ", "^ndq"),
        ("dow", "^dji"),
        ("vix", "^vix"),
        ("msft.us", "msft.us"),       # explicit suffix passes through
        ("bp.uk", "bp.uk"),
        ("700.hk", "700.hk"),
        ("0700.hk", "700.hk"),        # stooq HK symbols drop leading zeros
        ("0005.hk", "5.hk"),
        ("0700", "700.hk"),           # 4-5 digit numerics -> HK
        ("9988", "9988.hk"),
        ("eurusd", "eurusd"),         # fx pair passthrough
        ("USDJPY", "usdjpy"),
        ("", ""),                     # garbage never raises
        (None, ""),
    ]:
        got = dt_stocks.normalize_symbol(inp)
        assert got == want, f"normalize_symbol({inp!r}) -> {got!r}, want {want!r}"


def test_split_symbols():
    assert dt_stocks._split_symbols("AAPL, msft; tsla btc", cap=8) == [
        "aapl.us", "msft.us", "tsla.us", "btc.v"]
    assert dt_stocks._split_symbols("aapl AAPL aapl.us", cap=8) == ["aapl.us"]
    assert dt_stocks._split_symbols("", cap=8) == []
    assert dt_stocks._split_symbols(",,, ;", cap=8) == []
    assert dt_stocks._split_symbols(None, cap=8) == []
    assert len(dt_stocks._split_symbols("a b c d e f g h i j", cap=5)) == 5


# ── indicator math (hand-computed) ─────────────────────────────────────────

def test_moving_average_hand_computed():
    # [1..10], window 5 -> mean(6,7,8,9,10) = 8.0 (LAST-n contract)
    assert dt_stocks.moving_average(list(range(1, 11)), 5) == 8.0
    assert dt_stocks.moving_average(list(range(1, 11)), 10) == 5.5
    assert dt_stocks.moving_average([1, 2, 3, 4, 5], 3) == 4.0
    # too few points -> None (the report prints n/a, never pretends)
    assert dt_stocks.moving_average([1, 2, 3], 5) is None
    assert dt_stocks.moving_average([], 2) is None
    assert dt_stocks.moving_average([1, 2], 0) is None
    assert dt_stocks.moving_average([1, 2], -3) is None


def test_ma_series_alignment():
    # MA aligned to closes[i]; None until i = n-1 (cross detection looks
    # BACKWARD, so alignment is part of the contract)
    assert dt_stocks._ma_series([1, 2, 3, 4, 5, 6], 3) == \
        [None, None, 2.0, 3.0, 4.0, 5.0]
    assert dt_stocks._ma_series([1, 2], 5) == [None, None]


def test_rsi_wilder_hand_computed():
    # monotonic up: every delta is a gain -> RSI 100
    assert dt_stocks.rsi_wilder(list(range(100, 115))) == 100.0
    # monotonic down: every delta is a loss -> RSI 0
    assert dt_stocks.rsi_wilder(list(range(115, 100, -1))) == 0.0
    # documented flat convention: avg_gain == avg_loss == 0 -> 50.0
    assert dt_stocks.rsi_wilder([50.0] * 20) == 50.0
    # fewer than period+1 points -> None (graceful, documented)
    assert dt_stocks.rsi_wilder([1, 2, 3], 14) is None
    assert dt_stocks.rsi_wilder([], 14) is None
    assert dt_stocks.rsi_wilder([1.0] * 15, 0) is None

    # period=5, closes [10,11,12,11,12,13]: deltas [+1,+1,-1,+1,+1]
    # seed avg_gain=4/5, avg_loss=1/5, no smoothing steps left ->
    # RS=4 -> RSI = 100 - 100/5 = 80.0 exactly.
    assert dt_stocks.rsi_wilder([10, 11, 12, 11, 12, 13], period=5) == 80.0

    # one extra delta (+1) exercises Wilder smoothing:
    # avg_gain=(0.8*4+1)/5=0.84, avg_loss=(0.2*4+0)/5=0.16 -> RS=5.25
    # -> RSI = 100*5.25/6.25 = 84.0. A PLAIN rolling mean would give
    # gains 5/6 vs losses 1/6 -> RS=5 -> 83.33: the 84.0 proves Wilder.
    assert dt_stocks.rsi_wilder([10, 11, 12, 11, 12, 13, 14], period=5) == 84.0
    # near-50 sanity: alternating closes stay ~neutral
    alt = [100 + (i % 2) for i in range(21)]
    assert abs(dt_stocks.rsi_wilder(alt) - 50.0) < 1.0


def test_volatility_hand_computed():
    # constant returns -> zero dispersion -> 0.0
    assert abs(dt_stocks.volatility([100.0 * (1.01 ** i) for i in range(25)])) < 1e-9
    # window=2 over [100,110,104.5]: returns +10% and -5%; mean 2.5%,
    # deviations +-7.5% -> pstdev 0.075 -> 0.075*sqrt(252)
    assert abs(dt_stocks.volatility([100, 110, 104.5], window=2)
               - 0.075 * math.sqrt(252)) < 1e-9
    # alternating +/-: [100,110]*10+[100] -> 20 returns (10x +10%,
    # 10x -1/11); mean 1/220, deviation +-21/220 -> pstdev = 21/220
    altc = [100.0, 110.0] * 10 + [100.0]
    assert abs(dt_stocks.volatility(altc) - (21 / 220) * math.sqrt(252)) < 1e-9
    # needs window+1 closes, else None
    assert dt_stocks.volatility([1.0] * 20) is None
    assert dt_stocks.volatility([], 20) is None


def test_period_change_pct():
    # 100 -> 125 over the window: +25.0% exactly
    a = dt_stocks.analyze_series(_rows([100.0, 125.0]))
    assert abs(a["change_pct"] - 25.0) < 1e-9
    assert a["n"] == 2 and a["first_close"] == 100.0 and a["last_close"] == 125.0
    # (a 0.0 close is NOT asserted here: change_pct guards it, but the
    # module's _vol_series divides by closes[i] unguarded and raises —
    # reported to the orchestrator instead of fixed or cemented.)
    # single row / empty input: no change computable, no crash
    assert dt_stocks.analyze_series(_rows([7.0]))["change_pct"] is None
    empty = dt_stocks.analyze_series([])
    assert empty["n"] == 0 and empty["signals"] == []


# ── analyze_series: signals + MA crosses ──────────────────────────────────

def test_analyze_series_signals_cite_metrics():
    # flat 59 @100 then one +10 jump, volume bump at the end: forces the
    # golden cross, RSI-100, near-high range, elevated-volume and window
    # change signals all at once
    rows = _rows([100.0] * 59 + [110.0], vols=[1000.0] * 55 + [5000.0] * 5)
    a = dt_stocks.analyze_series(rows)
    assert a["n"] == 60
    assert a["cross"]["side"] == "above" and a["cross"]["age_sessions"] == 1
    assert abs(a["cross"]["gap_pct"] - (102.0 / 100.5 - 1.0) * 100.0) < 1e-9
    assert a["rsi"] == 100.0
    assert abs(a["range_pos_pct"] - 100.0) < 1e-9
    assert abs(a["vol_ratio"] - 5.0) < 1e-9
    # every signal line must NAME the metric it came from (the contract:
    # computed observations, no vague prose)
    metric_tokens = ("MA5", "MA20", "MA50", "RSI", "vol", "volume",
                     "range", "Window change", "Close")
    assert len(a["signals"]) >= 7, a["signals"]
    for s in a["signals"]:
        assert any(t in s for t in metric_tokens), f"metric-less signal: {s!r}"
    assert any("golden-cross" in s for s in a["signals"])
    assert any("overbought" in s for s in a["signals"])
    assert any("elevated" in s for s in a["signals"])
    assert any("near window high" in s for s in a["signals"])


def test_analyze_series_death_cross_and_oversold():
    # flat 40 @100, slide to 95, then 15 sessions @90: MA5 (90) ends below
    # MA20 (91.75) -> death cross; every delta negative -> RSI 0
    rows = _rows([100.0] * 40 + [99.0, 98.0, 97.0, 96.0, 95.0] + [90.0] * 15)
    a = dt_stocks.analyze_series(rows)
    assert a["cross"]["side"] == "below"
    assert abs(a["cross"]["ma20"] - 91.75) < 1e-9
    assert a["rsi"] == 0.0
    assert any("death-cross" in s for s in a["signals"])
    assert any("oversold" in s for s in a["signals"])


def test_analyze_series_cross_near_warning():
    # MA5 100.4 vs MA20 100.1 -> +0.3% gap: under 0.5% the module adds the
    # 'a cross is near (watch, not a prediction)' note
    rows = _rows([100.0] * 55 + [100.4] * 5)
    a = dt_stocks.analyze_series(rows)
    assert 0 < a["cross"]["gap_pct"] < 0.5
    assert any("cross is near" in s for s in a["signals"])


def test_analyze_series_flat_and_short_windows():
    flat = dt_stocks.analyze_series(_rows([100.0] * 30, vols=[1000.0] * 30))
    assert flat["rsi"] == 50.0
    assert any("neutral" in s for s in flat["signals"])
    for w in (5, 10, 20):
        assert flat["ma"][w] is not None and flat["ma"][w]["off_pct"] == 0.0
    # 30 rows can't know a 50-session average
    assert flat["ma"][50] is None
    # flat window: hi == lo -> range position undefined, not div-by-zero
    assert flat["range_pos_pct"] is None
    # short window: vol needs 21 closes, RSI 15 — 12 rows give neither
    short = dt_stocks.analyze_series(_rows([100.0] * 12))
    assert short["vol_ann"] is None and short["rsi"] is None
    assert short["ma"][50] is None and short["ma"][20] is None
    assert short["ma"][5] is not None


def test_analyze_series_vol_regime():
    # oscillating closes (94..106, period 7) give non-zero rolling vol, so
    # the current-vs-median regime comparison actually computes
    closes = [100 + ((i % 7) - 3) * 2 for i in range(60)]
    a = dt_stocks.analyze_series(_rows([float(c) for c in closes]))
    assert a["vol_median"] is not None and a["vol_median"] > 0
    assert a["vol_regime"] in ("elevated", "compressed", "in line")
    assert any("median" in s for s in a["signals"])


def test_format_analysis_md():
    rows = _rows([100.0] * 59 + [110.0], vols=[1000.0] * 55 + [5000.0] * 5)
    a = dt_stocks.analyze_series(rows)
    md = dt_stocks.format_analysis_md("aapl.us", a, 60, "stooq q/d/l csv",
                                      name="Apple Inc")
    assert md.startswith("# aapl.us — Apple Inc — technical read")
    # 60 rows dated from 2026-06-01 end on 2026-07-30
    assert "Window: 60 sessions (2026-06-01 -> 2026-07-30)" in md
    assert "## Price vs moving averages" in md
    assert "MA5" in md and "MA50" in md
    assert "## Momentum & risk" in md
    assert "- RSI(14, Wilder): 100.0" in md
    assert "## Signals — computed observations, not predictions" in md
    assert any(ln.startswith("- MA5 ") for ln in md.splitlines())
    assert "not predictions" in md  # the no-crystal-ball footer
    # degenerate dict (empty window) renders, never raises
    md0 = dt_stocks.format_analysis_md("x.us", dt_stocks.analyze_series([]), 10, "src")
    assert "technical read" in md0 and "n/a" in md0


# ── compare normalisation + sparkline ─────────────────────────────────────

def test_normalized_performance():
    # approx: 99/100*100 is 99.00000000000001 in IEEE doubles
    got = dt_stocks.normalized_performance([100, 110, 99])
    assert len(got) == 3 and got[0] == 100.0
    assert all(abs(g - w) < 1e-9 for g, w in zip(got, [100.0, 110.0, 99.0]))
    assert dt_stocks.normalized_performance([50, 25]) == [100.0, 50.0]
    assert dt_stocks.normalized_performance([8.0, 16.0, 32.0]) == \
        [100.0, 200.0, 400.0]
    assert dt_stocks.normalized_performance([]) == []
    assert dt_stocks.normalized_performance([0.0, 5.0]) == []  # no div-by-zero


def test_ascii_spark():
    assert dt_stocks.ascii_spark([0, 1, 2, 3, 4, 5, 6, 7]) == "▁▂▃▄▅▆▇█"
    # a flat line still renders as a line (mid glyph, not blanks)
    assert set(dt_stocks.ascii_spark([5, 5, 5, 5])) == {"▅"}
    assert dt_stocks.ascii_spark([]) == ""
    # long series downsample to the 40-glyph budget
    assert len(dt_stocks.ascii_spark([float(i) for i in range(200)])) <= 40


# ── cache TTL + state IO ──────────────────────────────────────────────────

def test_should_refresh_ttl_logic():
    now = time.time()
    assert dt_stocks.should_refresh(None, 60) is True   # never cached
    assert dt_stocks.should_refresh(0, 60) is True      # 0 == never cached
    assert dt_stocks.should_refresh(1.0, 60) is True    # ancient
    assert dt_stocks.should_refresh(now, 60) is False   # fresh
    assert dt_stocks.should_refresh(now - 59.0, 60) is False  # inside TTL
    assert dt_stocks.should_refresh(now - 60.0, 60) is True   # >= TTL boundary
    assert dt_stocks.should_refresh(now - 600, 60) is True


def test_state_io_atomic():
    tmp = Path(tempfile.mkdtemp(prefix="dt-stocks-state-"))
    try:
        p = tmp / "s.json"
        dt_stocks._save_state(p, {"a": 1, "b": [1, 2]})
        assert dt_stocks._load_state(p) == {"a": 1, "b": [1, 2]}
        # atomic write: no .tmp left behind after success
        assert not (tmp / "s.json.tmp").exists()
        # missing / corrupt / non-JSON -> {} (refetch, never fatal)
        assert dt_stocks._load_state(tmp / "nope.json") == {}
        (tmp / "bad.json").write_text("{not json", encoding="utf-8")
        assert dt_stocks._load_state(tmp / "bad.json") == {}
        # text variant (CSV/MD report writer)
        dt_stocks._save_text(tmp / "r.txt", "hello")
        assert (tmp / "r.txt").read_text(encoding="utf-8") == "hello"
        # unwritable target is swallowed (cache is best-effort)
        (tmp / "afile").write_text("x", encoding="utf-8")
        dt_stocks._save_state(tmp / "afile" / "x.json", {"k": 1})  # no raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── tolerant cell parsing / formatting helpers ────────────────────────────

def test_number_and_date_helpers():
    n = dt_stocks._to_num
    assert n("86,588,203") == 86588203.0      # comma-grouped volumes
    assert n("+1.38%") == 1.38                # signed percent cells
    assert n("(+0.49%)") == 0.49              # parenthesised percent
    assert n("76 053") == 76053.0             # thin-space grouping
    assert n("337") == 337.0
    for bad in ("N/D", "ND", "No data", "-", "", None, "x"):
        assert n(bad) is None, bad
    c = dt_stocks._parse_compact_number
    assert c("8.78m") == 8.78e6 and c("2.95g") == 2.95e9 and c("1.5k") == 1500.0
    assert c("123") == 123.0 and c("x40") is None and c("") is None
    # quote-page '21 Sep' needs a reference date; a date >7 days in the
    # future of the reference is a late-December read in January -> -1 year
    assert dt_stocks._md_to_iso("21 Sep", "2026-09-21") == "2026-09-21"
    assert dt_stocks._md_to_iso("28 Dec", "2026-01-02") == "2025-12-28"
    assert dt_stocks._md_to_iso("02 Jan", "2026-01-05") == "2026-01-02"
    assert dt_stocks._md_to_iso("N/D", "2026-01-01") is None
    assert dt_stocks._dmy_to_iso("18 Sep 2026") == "2026-09-18"
    assert dt_stocks._dmy_to_iso("garbage") is None
    # filesystem-safe names for the state dir ('^ndq' can't be a filename)
    assert dt_stocks._safe_name("^ndq") == "ndq"
    assert dt_stocks._safe_name("aapl.us") == "aapl.us"
    assert dt_stocks._safe_name("") == "sym"


def test_trim_and_price_formatting():
    # scientific notation must never reach the model for index levels
    f = dt_stocks._fmt_px
    assert f(26952.41) == "26,952.4"
    assert f(100000) == "100,000"
    assert f(1234.5) == "1,234.5"
    assert f(337.0) == "337.00"
    assert f(None) == "n/a"
    t = dt_stocks._trim
    assert t("short") == "short"                       # untouched
    long_text = "x" * (dt_stocks._RETURN_LIMIT + 500)
    trimmed = t(long_text)
    assert len(trimmed) <= dt_stocks._RETURN_LIMIT + 100
    assert "trimmed" in trimmed                        # says where the rest is


# ── HTML parsers + PoW solver ─────────────────────────────────────────────

def test_parse_quote_html():
    q = dt_stocks.parse_quote_html(QUOTE_HTML, "aapl.us", today_iso="2026-09-21")
    assert q["symbol"] == "aapl.us" and q["name"] == "Apple Inc"
    assert q["close"] == 337.536 and q["open"] == 335.28
    assert q["high"] == 338.22 and q["low"] == 333.05 and q["prev"] == 336.13
    assert q["date"] == "2026-09-21" and q["time"] == "17:18"
    assert q["volume"] == 8.78e6     # '8.78m' compact form
    assert abs(q["pct"] - 0.42) < 1e-9
    # unknown symbol -> stooq redirects to the search page -> error row
    bad = dt_stocks.parse_quote_html(SEARCH_HTML, "zzzzz.us")
    assert "error" in bad and "unknown" in bad["error"]
    # empty page / page without this symbol's spans -> error, not crash
    assert "error" in dt_stocks.parse_quote_html("", "aapl.us")
    assert "error" in dt_stocks.parse_quote_html("<html></html>", "aapl.us")


def test_parse_quote_html_index_and_first_wins():
    # index pages carry 'last' in c2 (stocks use c4) — the fallback map
    idx = ('<span id=aq_^spx_c2>5,906.94</span>'
           '<span id=aq_^spx_d3>18 Sep</span>')
    q = dt_stocks.parse_quote_html(idx, "^spx", today_iso="2026-09-18")
    assert q["close"] == 5906.94
    # duplicate spans: first occurrence wins (stooq reuses ids for
    # live-updating copies that agree in value)
    dup = ('<span id=aq_x.us_c4>1.0</span><span id=aq_x.us_c4>2.0</span>'
           '<span id=aq_x.us_d3>18 Sep</span>')
    assert dt_stocks.parse_quote_html(dup, "x.us", today_iso="2026-09-18")["close"] == 1.0


def test_parse_history_html():
    h = dt_stocks.parse_history_html(HIST_HTML)
    assert len(h) == 3
    assert [r["date"] for r in h] == ["2026-09-16", "2026-09-17", "2026-09-18"]
    assert h[2]["close"] == 336.13 and h[2]["volume"] == 86588203.0
    assert abs(h[1]["low"] - 330.1833) < 1e-9
    assert h[0]["open"] == 332.53 and h[0]["high"] == 335.48
    # garbage / empty pages -> [] (the fetch layer treats that as end-of-list)
    assert dt_stocks.parse_history_html("") == []
    assert dt_stocks.parse_history_html("<html>search page</html>") == []


def test_solve_stooq_challenge():
    for html, d in (('const c="abc",d=1', 1), ('const c="zz",d=2', 2)):
        sol = dt_stocks.solve_stooq_challenge(html)
        assert sol is not None
        chal, n = sol
        digest = hashlib.sha256((chal + str(n)).encode()).hexdigest()
        assert digest.startswith("0" * d), f"solver failed d={d}"
    # no challenge embedded / empty input -> None, never a raise
    assert dt_stocks.solve_stooq_challenge("<html></html>") is None
    assert dt_stocks.solve_stooq_challenge("") is None
    assert dt_stocks.solve_stooq_challenge(None) is None


# ── action chain over the injected fetch seam ─────────────────────────────

def test_action_quote_table_and_cache():
    calls = {"n": 0}

    def fake(symbols):
        calls["n"] += 1
        return dt_stocks.parse_quote_csv(QUOTE_CSV), "fixture csv"

    with _ctx() as (ctx, tmp), _injected(quote=fake):
        out = dt_stocks._run_action(ctx, "quote", symbols="AAPL msft zzzzz ^ndq")
        assert "aapl.us" in out and "msft.us" in out and "vs open" in out
        assert "3/4 resolved" in out          # 3 data rows + 1 error row
        assert "fixture csv" in out           # source note surfaced
        assert "| 337.00 |" in out            # price formatting in the table
        # error rows carry the suffix hint, never a bare failure
        assert "zzzzz.us" in out and "no data" in out and "suffixes" in out
        # every requested symbol got cached (incl. the error row)
        cache = json.loads(
            (tmp / ".doomalay" / "stocks" / "quotes_cache.json").read_text())
        assert set(cache) == {"aapl.us", "msft.us", "zzzzz.us", "^ndq"}
        assert "error" in cache["zzzzz.us"]["row"]
        # second quote inside the 60s TTL -> served from cache, 0 new fetches
        dt_stocks._run_action(ctx, "quote", symbols="AAPL msft")
        assert calls["n"] == 1
        # age the stamps past QUOTE_TTL -> refetch
        for k in cache:
            cache[k]["ts"] = time.time() - 120
        (tmp / ".doomalay" / "stocks" / "quotes_cache.json").write_text(
            json.dumps(cache), encoding="utf-8")
        dt_stocks._run_action(ctx, "quote", symbols="AAPL")
        assert calls["n"] == 2


def test_action_quote_partial_cache_miss():
    seen: list[list[str]] = []

    def fake(symbols):
        seen.append(list(symbols))
        return dt_stocks.parse_quote_csv(QUOTE_CSV), "fixture csv"

    with _ctx() as (ctx, _), _injected(quote=fake):
        dt_stocks._run_action(ctx, "quote", symbols="aapl")   # primes cache
        out = dt_stocks._run_action(ctx, "quote", symbols="aapl msft")
        # only the MISSING symbol was fetched (one batch, not two)
        assert seen == [["aapl.us"], ["msft.us"]]
        # cached aapl + freshly fetched msft both resolve
        assert "2/2 resolved" in out and "msft.us" in out


def test_action_history_summary_and_csv():
    rows = _rows([100.0] * 59 + [110.0], vols=[1000.0] * 55 + [5000.0] * 5)

    def fake(sym, want):
        return rows, "fixture csv"

    with _ctx() as (ctx, tmp), _injected(history=fake):
        out = dt_stocks._run_action(ctx, "history", symbol="aapl", days=5)
        assert "aapl.us" in out and "5 sessions" in out
        assert "+10.00%" in out            # 100 -> 110 over the 5-row window
        assert "5,000" in out              # avg volume: window = the 5x5000 block
        assert "fixture csv" in out
        # full CSV written to state + the artifact-tool handoff note
        csv = tmp / ".doomalay" / "stocks" / "aapl.us-5d.csv"
        body = csv.read_text(encoding="utf-8")
        assert body.startswith("Date,Open,High,Low,Close,Volume")
        assert len(body.strip().splitlines()) == 6      # header + 5 rows
        assert "aapl.us-5d.csv" in out and "artifact" in out
        # days clamped into [5, 1000] and file name follows the clamp
        dt_stocks._run_action(ctx, "history", symbol="aapl", days=99999)
        assert (tmp / ".doomalay" / "stocks" / "aapl.us-1000d.csv").exists()
        # garbage days falls back to the 90-session default, not a crash
        dt_stocks._run_action(ctx, "history", symbol="aapl", days="abc")
        assert (tmp / ".doomalay" / "stocks" / "aapl.us-90d.csv").exists()
        # no-symbol guard
        no = dt_stocks._run_action(ctx, "history", symbol="")
        assert "no symbol given" in no and "suffixes" in no


def test_action_analyze_report():
    rows = _rows([100.0] * 59 + [110.0], vols=[1000.0] * 55 + [5000.0] * 5)

    def fake(sym, want):
        return rows, "fixture csv"

    with _ctx() as (ctx, tmp), _injected(history=fake):
        out = dt_stocks._run_action(ctx, "analyze", symbol="aapl")  # default 180
        assert "aapl.us — technical read" in out
        assert "## Price vs moving averages" in out
        assert "## Momentum & risk" in out
        assert "## Signals" in out
        assert "RSI(14, Wilder): 100.0" in out
        assert "golden-cross" in out and "overbought" in out
        assert "not predictions" in out
        # the article-grade report is persisted for the artifact tool
        reports = list((tmp / ".doomalay" / "stocks").glob("aapl.us-analysis-*.md"))
        assert len(reports) == 1 and "technical read" in reports[0].read_text()
        assert "Full report saved" in out
        # spec rule 9: the returned text stays bounded
        assert len(out) <= dt_stocks._RETURN_LIMIT + 200


def test_action_compare_side_by_side():
    def fake(sym, want):
        if sym == "aapl.us":
            return _rows([100.0] * 29 + [110.0]), "fixture csv"
        if sym == "msft.us":
            return _rows([200.0] * 29 + [180.0]), "fixture csv"
        return [], "fixture: no data"

    with _ctx() as (ctx, _), _injected(history=fake):
        out = dt_stocks._run_action(ctx, "compare", symbols="aapl,msft,zzzz",
                                    days=20)
        assert "last 20 sessions" in out
        assert "| aapl.us | +10.0% |" in out
        assert "| msft.us | -10.0% |" in out
        assert "vs MA20" in out
        # normalised performance block: start=100 + sparkline + end value
        assert "Normalized performance (start = 100)" in out
        assert "100 -> 110.0" in out and "100 -> 90.0" in out
        assert "▁" in out and "█" in out
        # the unknown symbol is reported as a per-symbol miss, not a failure
        assert "zzzz.us" in out and "no data" in out
        # every symbol dead -> actionable message with the suffix help
        with _injected(history=lambda s, w: ([], "stooq unreachable")):
            dead = dt_stocks._run_action(ctx, "compare", symbols="aapl")
            assert "no data for any symbol" in dead and "suffixes" in dead


def test_cached_history_evicts_oldest():
    def fake(sym, want):
        # 30 rows per symbol, distinct closes so entries differ
        return _rows([100.0 + hash(sym) % 50] * 29 + [200.0]), "fixture csv"

    with _ctx() as (ctx, tmp), _injected(history=fake):
        for i in range(12):
            dt_stocks._cached_history(ctx, f"s{i}.us", 30)
        cache = json.loads(
            (tmp / ".doomalay" / "stocks" / "history_cache.json").read_text())
        # bounded at _MAX_CACHED_SYMS with the OLDEST symbols evicted
        assert len(cache) == dt_stocks._MAX_CACHED_SYMS
        assert "s0.us" not in cache and "s1.us" not in cache
        assert "s11.us" in cache


def test_dispatch_unknown_action_and_help():
    with _ctx() as (ctx, _):
        out = dt_stocks._run_action(ctx, "frobnicate")
        assert "unknown action" in out and "frobnicate" in out
        assert "quote, history, analyze, compare, help" in out  # help-ish
        # empty / None action degrades to the help cheat-sheet
        for act in ("", None, "help", "HELP"):
            h = dt_stocks._run_action(ctx, act)
            assert "actions:" in h and "quote" in h and "analyze" in h
        # case-insensitive verbs reach the real actions
        with _injected(quote=lambda s: (dt_stocks.parse_quote_csv(QUOTE_CSV),
                                        "fixture csv")):
            assert "aapl.us" in dt_stocks._run_action(ctx, "QUOTE", symbols="aapl")


def test_network_unavailable_is_actionable():
    # dead transport: the module's own contract for this shape is
    # ([], source-note) — the action must return an actionable string
    def dead_quotes(symbols):
        return [], "stooq unreachable at https://stooq.com: connect timeout"

    def dead_history(sym, want):
        return [], "stooq unreachable at https://stooq.com: connect timeout"

    with _ctx() as (ctx, _):
        with _injected(quote=dead_quotes, history=dead_history):
            q = dt_stocks._run_action(ctx, "quote", symbols="tsla")
            assert "no data" in q and "unreachable" in q
            assert "retry" in q            # tells the model what to do next
            h = dt_stocks._run_action(ctx, "history", symbol="tsla")
            assert "no data" in h and "Check the symbol" in h
            a = dt_stocks._run_action(ctx, "analyze", symbol="tsla")
            assert "no data" in a and "Check the symbol" in a


def test_actions_never_raise_on_garbage_input():
    def fake(sym, want):
        return _rows([100.0] * 59 + [110.0]), "fixture csv"

    with _ctx() as (ctx, _), _injected(history=fake):
        # errors are strings returned to the model, never exceptions
        outs = [
            dt_stocks._run_action(ctx, "quote", symbols=None),
            dt_stocks._run_action(ctx, "quote", symbols=""),
            dt_stocks._run_action(ctx, "history", symbol=None, days=None),
            dt_stocks._run_action(ctx, "analyze", symbol="", days="not-a-number"),
            dt_stocks._run_action(ctx, "compare", symbols="  ,,, "),
            # a non-string symbols arg trips the crash-net, still a string
            dt_stocks._run_action(ctx, "quote", symbols=123),
        ]
        for o in outs:
            assert isinstance(o, str) and o, o
        assert "no symbols given" in outs[0]
        assert "internal error" in outs[5]


# ── strands surface ───────────────────────────────────────────────────────

def test_tool_names_contract():
    assert dt_stocks.TOOL_NAMES == ["stocks"]


def test_build_offline_returns_empty_and_never_raises():
    try:
        import strands  # noqa: F401
        have_strands = True
    except Exception:
        have_strands = False
    with _ctx() as (ctx, _):
        if have_strands:
            tools = dt_stocks.build(ctx)
            assert tools and callable(tools[0])
        else:
            # offline: registers nothing, per the spec's no-strands rule
            assert dt_stocks.build(ctx) == []
    # junk contexts must not raise either (build is wrapped defensively)
    import types
    for junk in (None, object(), types.SimpleNamespace()):
        res = dt_stocks.build(junk)
        assert isinstance(res, list)


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
