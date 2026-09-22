"""dt_rtsearch.py — rtsearch: the real-time iterative web-search research loop.

v0.43 "most capable quick chat" wave — the user asked for a real-time search
LOOP, not a one-shot lookup: decompose the question into sub-queries, then
rounds of search → fetch → read → refine until every sub-query has at least
one good page behind it (or rounds run out), then synthesize a sourced brief.

Actions: `research` (the loop), `search` (one-shot freshness check), `fetch`
(one URL → extracted main text), `report` (replay a stored brief), `help`.
Full JSON of every run persists in workspace/.doomalay/rtsearch/research.json.

TESTABILITY CONTRACT: the loop core `research_loop()` takes INJECTED
callables — `run_search(query, n) -> list[{title,url,snippet}]` and
`fetch_page(url) -> str` — so all loop logic (decompose / refine / coverage /
dedup / synthesis / SSRF guard) is plain and unit-testable offline. The live
backends (lazy duckduckgo_search|ddgs, lazy httpx, BeautifulSoup) are only
the defaults, imported INSIDE the functions: this module's top level is
stdlib-only and imports cleanly with nothing installed.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

TOOL_NAMES = ["rtsearch"]

# Bounded history: 20 runs is already a lot of research for one chat thread,
# and the whole state file is re-serialized on every store — keep it cheap.
_MAX_RECORDS = 20

# Browser-ish UA: many sites 403 bare httpx clients; the doomalay suffix keeps
# us identifiable in server logs (house convention from tools/web.py).
_BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 doomalay-rtsearch/1.0")

# Fetch/return size ceilings. 12000 chars of page text is ~3k tokens of context
# for the model; the tool-return contract (dt_spec rule 9) caps at ~6000.
_FETCH_TEXT_MAX = 12000
_RETURN_MAX = 6000

# ── tuning constants (plain data the loop logic rotates through) ──────────

# Qualifiers rotated onto uncovered sub-queries each round, per the task
# contract: a reworded query attacks a different search index angle.
REFINEMENT_QUALIFIERS = ("latest 2025", "news", "guide", "vs alternatives")

# Opinion/connector filler that search engines ignore anyway; stripping it
# keeps the sub-queries tight and makes the vs-splits fall out cleanly.
STOPWORDS = frozenset("""
a an the is are was were be been being am do does did doing have has had having
will would should could can may might must shall of for to in on at by with from
as into about over after before between out against during without within along
across behind beyond plus versus vs and or nor but if then than that this these
those it its they them their we our you your i me my he she his her him us mine
yours what which who whom when where why how whose
best better worst good great top compare comparison versus
""".split())

_WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+#-]*")
_SPLIT_RE = re.compile(r"\b(vs\.?|versus|and|or)\b", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


class RtBackendError(RuntimeError):
    """Search backend missing/not importable — degrades to a clean message."""


class RtBlockedError(RuntimeError):
    """URL rejected by the SSRF guard before any network call."""


# ── plain helpers ──────────────────────────────────────────────────────────

def _clamp(v, lo, hi, default):
    """Coerce model-supplied ints (strands sometimes hands us strings)."""
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _collapse_ws(s: str) -> str:
    return _WS_RE.sub(" ", s or "").strip()


# ── SSRF guard (plain, host-literal only — see its docstring) ─────────────

def is_public_http_url(url) -> bool:
    """SSRF guard — True only for http(s) URLs whose HOST LITERAL is public.

    Blocks: non-http(s) schemes (file://, gopher://, data:), empty hosts,
    localhost/127.0.0.0-8, the RFC1918 blocks (10/8, 192.168/16, 172.16-31),
    link-local 169.254/16 (cloud metadata!), 0.0.0.0/8, CGNAT 100.64/10, and
    the IPv6 equivalents (::, ::1, fc00::/7, fe80::/10, ::ffff:127.0.0.1).

    Deliberately LITERAL (no DNS resolution) so it stays a pure function that
    unit-tests offline — a rebinding host like 127.0.0.1.nip.io therefore
    passes this check, but the live fetcher ALSO re-validates every redirect
    hop through here, and the model-facing risk is bounded by page text only.
    Numeric-but-not-dotted hosts ("127.1", "2130706433") are conservatively
    rejected: browsers resolve those to loopback and so might httpx.
    """
    try:
        p = urllib.parse.urlsplit(str(url or "").strip())
    except ValueError:
        return False
    if p.scheme not in ("http", "https"):
        return False
    try:
        host = (p.hostname or "").lower().rstrip(".")
    except ValueError:  # malformed bracket in netloc
        return False
    if not host:
        return False
    if (host == "localhost" or host.endswith((".localhost", ".local",
                                              ".internal", ".lan", ".home.arpa"))):
        return False
    if ":" in host:  # IPv6 literal (urlsplit already stripped the brackets)
        if host == "::" or host == "::1":
            return False
        if host.startswith("::ffff:"):  # IPv4-mapped — recurse on the quad
            return _ipv4_octets_ok(host[7:].split("."))
        # fe80::/10 link-local, fc00::/7 unique-local
        if re.match(r"^fe[89ab]", host) or re.match(r"^f[cd]", host):
            return False
        return True  # global IPv6 (2001:...) — allowed
    parts = host.split(".")
    if len(parts) == 4 and all(q.isdigit() for q in parts):
        return _ipv4_octets_ok(parts)
    if all(ch in "0123456789." for ch in host):  # "127.1" / "2130706433" tricks
        return False
    return True


def _ipv4_octets_ok(octets) -> bool:
    if len(octets) != 4:
        return False
    try:
        o = [int(q) for q in octets]
    except (TypeError, ValueError):
        return False
    if any(q < 0 or q > 255 for q in o):
        return False
    if o[0] in (0, 10, 127):                     # this-network, private, loopback
        return False
    if o[0] == 192 and o[1] == 168:              # RFC1918
        return False
    if o[0] == 169 and o[1] == 254:              # link-local + cloud metadata
        return False
    if o[0] == 172 and 16 <= o[1] <= 31:         # RFC1918
        return False
    if o[0] == 100 and 64 <= o[1] <= 127:        # CGNAT — treat as internal
        return False
    return True


# ── decomposition + refinement (plain heuristics, NO LLM) ─────────────────

def _key_terms(clause: str) -> str:
    """Strip stopwords/punctuation, keep token order — a tight search query."""
    toks = [t for t in _WORD_RE.findall(clause or "")
            if t.lower() not in STOPWORDS]
    return " ".join(toks)


def decompose_question(question: str, max_subqueries: int = 4) -> list:
    """Split a question into 2-4 sub-queries.

    Comparison questions ("A vs B", "A or B", "A and B") split on the
    connector: the first two clauses yield a combined comparison query plus
    one key-terms query per clause, so the loop covers both sides AND the
    head-to-head. Extra clauses become their own sub-queries (capped at 4).
    A single-clause question still gets 2 angles: key terms + "overview" —
    the loop is only interesting with something to refine.
    """
    q = _collapse_ws(question or "").rstrip("?!.").strip()
    if not q:
        return []
    parts = _SPLIT_RE.split(q)
    clauses = [c.strip(" ,;:") for c in parts[0::2]]
    conns = [c.lower() for c in parts[1::2]]
    clauses = [c for c in clauses if c]
    subs: list = []
    if len(clauses) >= 2:
        conn = "vs" if conns and conns[0] in ("vs", "vs.", "versus") else (conns[0] if conns else "and")
        subs.append(f"{_key_terms(clauses[0])} {conn} {_key_terms(clauses[1])}".strip())
        subs.extend(_key_terms(c) for c in clauses)
    else:
        terms = _key_terms(clauses[0]) if clauses else ""
        if not terms:  # all stopwords ("what is best?") — keep the raw words
            terms = clauses[0] if clauses else q
        subs = [terms, f"{terms} overview"]
    # dedup (identical sides of a "kagi vs kagi") + cap, always ≥1
    out: list = []
    for s in subs:
        if s and s not in out:
            out.append(s)
    if len(out) == 1:
        out.append(f"{out[0]} overview")
    return out[:max_subqueries]


def refine_query(base: str, attempt: int) -> str:
    """Reword an uncovered sub-query by rotating a qualifier onto it.

    `attempt` is 1-based (set after each failed round), so round 2 searches
    "… latest 2025", round 3 "… news", round 4 "… vs alternatives", then it
    wraps — past 4 rounds the loop is over anyway (rounds cap).
    """
    q = (REFINEMENT_QUALIFIERS[(attempt - 1) % len(REFINEMENT_QUALIFIERS)]
         if attempt > 0 else "")
    return f"{base} {q}".strip() if q else base


# ── text extraction + excerpts (plain; BeautifulSoup lives behind a lazy import) ──

def extract_text(html_text: str, max_chars: int = _FETCH_TEXT_MAX) -> str:
    """Main text from an HTML page: BeautifulSoup, nav/script/style removed.

    "html.parser" (stdlib-backed) on purpose — lxml is in requirements but
    not guaranteed in every runtime that imports this module.
    """
    if not html_text:
        return ""
    try:
        from bs4 import BeautifulSoup
    except Exception:  # noqa: BLE001 — fall back to the web.py-style regex strip
        t = re.sub(r"<(script|style|noscript|nav|header|footer|aside)[^>]*>.*?</\1>",
                   " ", html_text, flags=re.DOTALL | re.IGNORECASE)
        t = re.sub(r"<[^>]+>", " ", t)
        return _collapse_ws(t)[:max_chars]
    try:
        soup = BeautifulSoup(html_text, "html.parser")
        for tag in soup(["script", "style", "noscript", "nav", "header",
                         "footer", "aside", "iframe", "form", "svg"]):
            tag.decompose()
        return _collapse_ws(soup.get_text(" "))[:max_chars]
    except Exception:  # noqa: BLE001 — a mangled page must not kill the loop
        return _collapse_ws(re.sub(r"<[^>]+>", " ", html_text))[:max_chars]


def pick_excerpt(text: str, max_chars: int = 400) -> str:
    """A ≤400-char key excerpt: first complete sentences, cut at a word edge."""
    t = _collapse_ws(text)
    if not t:
        return ""
    out, total = [], 0
    for s in re.split(r"(?<=[.!?])\s+", t):
        if total + len(s) + 1 > max_chars - 1 or len(out) >= 3:
            break
        out.append(s)
        total += len(s) + 1
    res = " ".join(out) if out else t[:max_chars - 1]
    if len(res) > max_chars - 1:
        res = res[:max_chars - 1].rsplit(" ", 1)[0] or res[:max_chars - 1]
    if len(t) > len(res):
        res += "…"
    return res


def _normalize_results(raw) -> list:
    """Coerce backend/fake search rows to {title,url,snippet}; SSRF-filter.

    Accepts duckduckgo_search's title/href/body aliases as well as the
    canonical title/url/snippet so both live and fake rows feed one shape.
    """
    out = []
    for r in raw or []:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or r.get("href") or "").strip()
        if not is_public_http_url(url):
            continue  # a file:// or 127.x result from a poisoned index: skip
        out.append({
            "title": _collapse_ws(str(r.get("title") or ""))[:160] or url,
            "url": url,
            "snippet": _collapse_ws(str(r.get("snippet") or r.get("body") or ""))[:400],
        })
    return out


# ── THE LOOP (injected backends — the testability core) ────────────────────

def research_loop(question, rounds=2, max_results=6, fetch_per_round=3,
                  run_search=None, fetch_page=None, on_round=None,
                  fetch_min_chars=200, deadline_s=None) -> dict:
    """The iterative research loop. Pure logic over INJECTED callables.

    run_search(query, n) -> list[{title,url,snippet}]
    fetch_page(url) -> str (main text; short/empty text == bad fetch)

    Per round: search every pending sub-query → note fresh hits (seen-URL
    set) → round-robin-fetch the top `fetch_per_round` eligible pages → mark
    covered sub-queries (≥1 good fetch) → reword the uncovered ones. Stops
    when everything is covered or rounds run out. on_round(round, queries,
    results, fetched) fires after each round for ctx.log progress lines.
    """
    if run_search is None:
        run_search = live_search       # lazy inside: importing stays cheap
    if fetch_page is None:
        fetch_page = live_fetch
    rounds = _clamp(rounds, 1, 4, 2)
    max_results = _clamp(max_results, 1, 10, 6)
    fetch_per_round = _clamp(fetch_per_round, 1, 5, 3)

    bases = decompose_question(question)
    slots = [{"base": b, "query": b, "covered": False, "excerpt": "",
              "src": 0, "attempts": 0, "hits": 0} for b in bases]
    sources = []            # numbered [n] citations, fetch order
    seen_urls = set()       # every URL any search ever returned (coverage notes)
    fetched_urls = set()    # URLs we attempted (success or fail — never retried)
    rounds_log, search_errors = [], []
    backend_error, stopped = "", ""
    t0 = time.monotonic()

    for rnd in range(1, rounds + 1):
        pending = [i for i, s in enumerate(slots) if not s["covered"]]
        if not pending:
            break  # all sub-queries have ≥1 good page — research complete
        if deadline_s and time.monotonic() - t0 > deadline_s:
            stopped = "deadline"
            break

        # 1) SEARCH every pending sub-query (covered ones are dropped — that
        #    IS the "drop sub-queries that got ≥1 good fetch" rule).
        pools, new_hits, new_total, failed = {}, {}, 0, 0
        for i in pending:
            s = slots[i]
            try:
                raw = run_search(s["query"], max_results) or []
            except RtBackendError as e:
                failed += 1
                if not backend_error:
                    backend_error = str(e)
                continue
            except Exception as e:  # noqa: BLE001 — one flaky query ≠ dead round
                failed += 1
                search_errors.append(f"{s['query']}: {type(e).__name__}")
                continue
            norm = _normalize_results(raw)
            for r in norm:
                if r["url"] not in seen_urls:  # fresh hit for coverage notes
                    seen_urls.add(r["url"])
                    s["hits"] += 1
                    new_total += 1
                    new_hits[i] = new_hits.get(i, 0) + 1
            pools[i] = [r for r in norm if r["url"] not in fetched_urls]

        # 2) FETCH: round-robin one page per pending sub-query first, so a
        # single fat result list can't starve the other sub-queries. The
        # `picked` set also dedups WITHIN the round — different sub-queries
        # routinely surface the same top URL, and one page only needs one
        # claimant (the slot whose search returned it first).
        queues = {i: list(pools.get(i, [])) for i in pending}
        cands, picked = [], set()
        while len(cands) < fetch_per_round:
            took = False
            for i in pending:
                while queues[i]:
                    r = queues[i].pop(0)
                    if r["url"] in fetched_urls or r["url"] in picked:
                        continue
                    cands.append((i, r))
                    picked.add(r["url"])
                    took = True
                    break
                if len(cands) >= fetch_per_round:
                    break
            if not took:
                break
        fetched_now = []
        for i, r in cands:
            fetched_urls.add(r["url"])
            fetched_now.append(r["url"])
            try:
                text = fetch_page(r["url"]) or ""
            except Exception:  # noqa: BLE001 — dead page: mark attempted, move on
                text = ""
            text = text.strip() if isinstance(text, str) else ""
            if len(text) >= fetch_min_chars:
                excerpt = pick_excerpt(text)
                slots[i]["covered"] = True
                slots[i]["excerpt"] = excerpt
                slots[i]["src"] = len(sources) + 1
                sources.append({"n": len(sources) + 1, "title": r["title"],
                                "url": r["url"], "snippet": r["snippet"],
                                "fetched_at": _now_iso(), "excerpt": excerpt})

        rounds_log.append({
            "round": rnd,
            "queries": [slots[i]["query"] for i in pending],
            "results": new_total,                    # fresh URLs discovered
            "hits": {slots[i]["base"]: new_hits.get(i, 0) for i in pending},
            "fetched": fetched_now,
            "covered_after": [s["base"] for s in slots if s["covered"]],
        })
        if on_round:
            try:
                on_round(rnd, rounds_log[-1]["queries"], new_total, fetched_now)
            except Exception:  # noqa: BLE001 — logging must never break research
                pass

        # 3) The whole backend is dead (every query failed, nothing fetched)
        #    → bail out now instead of burning identical rounds.
        if failed == len(pending) and not fetched_now and backend_error:
            break

        # 4) REFINEMENT: reword every sub-query still uncovered, rotating the
        #    qualifier so the next round attacks a different search angle.
        for s in slots:
            if not s["covered"]:
                s["attempts"] += 1
                s["query"] = refine_query(s["base"], s["attempts"])

    return {
        "question": question,
        "rounds_run": len(rounds_log),
        "stopped": stopped,
        "slots": slots,
        "sources": sources,
        "gaps": [s["base"] for s in slots if not s["covered"]],
        "rounds_log": rounds_log,
        "search_errors": search_errors[:8],
        "backend_error": backend_error,
    }


# ── synthesis (plain) ──────────────────────────────────────────────────────

def synthesize_brief(question, slots, sources, rounds_run,
                     max_chars: int = _RETURN_MAX) -> str:
    """Plain-text brief: findings with [n] markers, sources, gaps.

    Excerpts are ≤400 chars (spec); the whole brief is squeezed under the
    tool-return ceiling by shrinking the per-finding excerpt budget first —
    full excerpts always live in the state JSON.
    """
    covered = [s for s in slots if s["covered"]]
    gaps = [s for s in slots if not s["covered"]]
    budget = 400
    if covered:
        budget = max(120, min(400, (max_chars - 700) // len(covered)))
    lines = [f"RESEARCH BRIEF — {_collapse_ws(question)}",
             f"rounds run: {rounds_run} | sub-queries covered: "
             f"{len(covered)}/{len(slots)} | pages fetched: {len(sources)}",
             "",
             "FINDINGS"]
    if not covered:
        lines.append("  (nothing covered — see GAPS)")
    for s in covered:
        exc = (s.get("excerpt") or "")[:budget]
        mark = f" [{s['src']}]" if s.get("src") else ""
        lines.append(f"• {s['base']}")
        lines.append(f"  {exc}{mark}")
    if gaps:
        lines += ["", "GAPS"]
        for s in gaps:
            lines.append(f"  not covered: {s['base']} (last tried: {s['query']})")
    lines += ["", "SOURCES"]
    if not sources:
        lines.append("  (no pages successfully fetched)")
    for r in sources:
        lines.append(f"  [{r['n']}] {r['title']} — {r['url']} (fetched {r['fetched_at']})")
    brief = "\n".join(lines)
    if len(brief) > max_chars:  # last-resort hard cut at a line boundary
        brief = brief[:max_chars]
        cut = brief.rfind("\n")
        brief = brief[:cut if cut > max_chars // 2 else max_chars]
        brief += "\n…[brief truncated — full data in rtsearch state (research.json)]"
    return brief


# ── state (JSON, atomic writes) ────────────────────────────────────────────

def _state_file(state_dir) -> Path:
    return Path(state_dir) / "research.json"


def _load_state(path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {"records": {}, "order": []}
    except (OSError, ValueError):
        return {"records": {}, "order": []}


def _save_state(path, data: dict) -> None:
    """Atomic (tmp + os.replace) so a kill mid-write can't corrupt history."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def store_research(state_dir, record: dict) -> str:
    """Persist a run; returns its id. Keeps the newest _MAX_RECORDS runs."""
    p = _state_file(state_dir)
    st = _load_state(p)
    rid = record.get("id") or f"r{uuid.uuid4().hex[:8]}"
    record["id"] = rid
    st.setdefault("records", {})[rid] = record
    order = [x for x in st.get("order", []) if x in st["records"]]
    order.append(rid)
    st["order"] = order[-_MAX_RECORDS:]
    for old in order[:-_MAX_RECORDS]:
        st["records"].pop(old, None)
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    _save_state(p, st)
    return rid


def load_research(state_dir, research_id: str) -> dict | None:
    st = _load_state(_state_file(state_dir))
    return st.get("records", {}).get((research_id or "").strip())


def recent_research(state_dir, n: int = 8) -> list:
    st = _load_state(_state_file(state_dir))
    out = []
    for rid in reversed(st.get("order", [])[-n:]):
        rec = st.get("records", {}).get(rid)
        if rec:
            out.append({
                "id": rid, "question": rec.get("question", ""),
                "created_at": rec.get("created_at", ""),
                "covered": rec.get("covered_count", 0),
                "subqueries": len(rec.get("slots", [])),
                "sources": len(rec.get("sources", [])),
            })
    return out


# ── live backends (lazy imports only) ──────────────────────────────────────

def _import_ddgs():
    """ddgs (the maintained rename) first, then duckduckgo_search — else None.

    v0.43 live-QA finding: duckduckgo-search 7.3.0 IMPORTS cleanly but its
    queries die at runtime with curl_cffi "BuilderError: Invalid
    impersonate: edge_101" (a version-skew bug in that pinned release), so
    the import-order swap is not cosmetic — ddgs must win. Callers still
    degrade cleanly when neither is present.
    """
    try:
        from ddgs import DDGS  # noqa: F401
        return DDGS
    except Exception:
        try:
            from duckduckgo_search import DDGS  # noqa: F401
            return DDGS
        except Exception:
            return None


def live_search(query, n):
    """DDG text search → [{title,url,snippet}]. Raises RtBackendError when
    neither duckduckgo_search nor ddgs is importable (the clean-degrade path)."""
    DDGS = _import_ddgs()
    if DDGS is None:
        raise RtBackendError(
            "search backend not installed — pip install duckduckgo-search "
            "(or `ddgs`); offline runtimes should use action='fetch' on known URLs")
    out = []
    try:
        results = DDGS().text(query, max_results=n) or []
    except Exception as exc:
        # runtime backend failure (rate limit, impersonate skew, network) —
        # retry ONCE with the alternate import before giving up.
        alt = None
        try:
            from duckduckgo_search import DDGS as AltDDGS  # noqa: F401
            alt = AltDDGS
        except Exception:
            try:
                from ddgs import DDGS as AltDDGS  # noqa: F401
                alt = AltDDGS
            except Exception:
                alt = None
        if alt is not None:
            try:
                results = alt().text(query, max_results=n) or []
            except Exception:
                raise RtBackendError(f"search backend failed: {exc}") from exc
        else:
            raise RtBackendError(f"search backend failed: {exc}") from exc
    for r in results:
        out.append({"title": str(r.get("title") or ""),
                    "url": str(r.get("href") or r.get("url") or ""),
                    "snippet": str(r.get("body") or r.get("snippet") or "")})
    return out


def live_fetch(url, timeout=15):
    """GET one page → extracted main text. SSRF-guarded, redirects re-guarded.

    Redirects are followed MANUALLY (follow_redirects=False) so a 302 can't
    bounce us onto an internal/cloud-metadata host between hops — the same
    pattern as tools/web.py's web_fetch, re-checked via is_public_http_url.
    """
    if not is_public_http_url(url):
        raise RtBlockedError("blocked non-public or non-http(s) URL (SSRF guard)")
    import httpx  # lazy: module top must stay stdlib-only
    current = str(url)
    for _hop in range(4):
        if not is_public_http_url(current):
            raise RtBlockedError(f"redirect to non-public host: {current[:120]}")
        r = httpx.get(current, timeout=timeout, follow_redirects=False,
                      headers={"User-Agent": _BROWSER_UA})
        if r.status_code in (301, 302, 303, 307, 308):
            loc = r.headers.get("location")
            if not loc:
                raise RtFetchHttpError("redirect without location")
            current = str(urllib.parse.urljoin(current, loc))
            continue
        if r.status_code >= 400:
            raise RtFetchHttpError(f"HTTP {r.status_code}")
        text = extract_text(r.text)
        if not text:
            raise RtFetchHttpError("page had no extractable text")
        return text
    raise RtFetchHttpError("too many redirects")


class RtFetchHttpError(RuntimeError):
    """Fetch failed at the HTTP layer — surfaced as a string, never raised out."""


# ── action bodies (plain; the strands tool is a thin adapter) ──────────────

def help_text() -> str:
    return (
        "rtsearch — real-time iterative web research loop (v0.43).\n"
        "Actions:\n"
        "  research question=<q> [rounds=2 max_results=6 fetch_per_round=3 timeout=15]\n"
        "      Decomposes q into 2-4 sub-queries, then loops: search → fetch top\n"
        "      pages → extract text → drop covered sub-queries → reword the rest\n"
        "      (latest 2025 / news / guide / vs alternatives) → stop when covered\n"
        "      or rounds exhausted. Returns a brief with [n] source markers and a\n"
        "      GAPS section; full JSON goes to state. Rounds cap 4.\n"
        "  search query=<q> [max_results=6] — one-shot search, no loop (quick\n"
        "      freshness check).\n"
        "  fetch url=<u> [max_chars=6000 timeout=15] — one URL → extracted main\n"
        "      text (SSRF-guarded: public http(s) hosts only).\n"
        "  report [research_id=<id>] — replay a stored brief; empty id lists the\n"
        "      most recent runs.\n"
        "  help — this text.\n"
        "Round progress streams as rtsearch_round events (oplog + transcript).")


def run_research(state_dir, question, rounds=2, max_results=6, fetch_per_round=3,
                 timeout=15, log=None, run_search=None, fetch_page=None,
                 overall_timeout=240) -> str:
    """action=research body: clamp params → loop → persist → brief (≤6000)."""
    question = _collapse_ws(question)
    if not question:
        return "rtsearch: empty question — call action='research' with question='...'"
    rounds = _clamp(rounds, 1, 4, 2)
    max_results = _clamp(max_results, 1, 10, 6)
    fetch_per_round = _clamp(fetch_per_round, 1, 5, 3)
    timeout = _clamp(timeout, 5, 60, 15)
    if fetch_page is None:
        fetch_page = lambda u: live_fetch(u, timeout=timeout)  # noqa: E731

    def on_round(rnd, queries, results, fetched):
        if log:
            log("rtsearch_round", round=rnd, queries=queries,
                results=results, fetched=fetched)

    out = research_loop(question, rounds=rounds, max_results=max_results,
                        fetch_per_round=fetch_per_round, run_search=run_search,
                        fetch_page=fetch_page, on_round=on_round,
                        deadline_s=overall_timeout)
    if out.get("backend_error"):
        # Missing dependency is the expected offline case: say it once,
        # actionable, and DO NOT save an empty record for it.
        return (f"rtsearch: {out['backend_error']}. No research was run — "
                "install the backend or use action='fetch' on known URLs.")

    brief = synthesize_brief(question, out["slots"], out["sources"],
                             out["rounds_run"])
    rid = store_research(state_dir, {
        "id": f"r{uuid.uuid4().hex[:8]}",
        "question": question,
        "created_at": _now_iso(),
        "params": {"rounds": rounds, "max_results": max_results,
                   "fetch_per_round": fetch_per_round, "timeout": timeout},
        "rounds_run": out["rounds_run"],
        "stopped": out["stopped"],
        "slots": out["slots"],
        "sources": out["sources"],
        "gaps": out["gaps"],
        "rounds_log": out["rounds_log"],
        "search_errors": out["search_errors"],
        "covered_count": sum(1 for s in out["slots"] if s["covered"]),
        "brief": brief,
    })
    if log:
        try:
            log("rtsearch_done", id=rid, rounds=out["rounds_run"],
                covered=f"{len(out['slots']) - len(out['gaps'])}/{len(out['slots'])}",
                sources=len(out["sources"]))
        except Exception:  # noqa: BLE001
            pass
    tail = (f"\n\nresearch_id: {rid} — full JSON in state "
            f"({_state_file(state_dir)}); replay with action='report' "
            f"research_id='{rid}'")
    room = _RETURN_MAX - len(tail) - 2
    if len(brief) > room:
        brief = brief[:room].rsplit("\n", 1)[0] + "\n…[truncated]"
    return brief + tail


def do_search(query, max_results=6, search_fn=None) -> str:
    """action=search body: one query through the live backend, no loop."""
    query = _collapse_ws(query)
    if not query:
        return "rtsearch: empty query — call action='search' with query='...'"
    n = _clamp(max_results, 1, 10, 6)
    try:
        results = _normalize_results((search_fn or live_search)(query, n))
    except RtBackendError as e:
        return f"rtsearch: {e}"
    except Exception as e:  # noqa: BLE001 — network hiccup → short string
        return f"rtsearch: search failed ({type(e).__name__}) — retry or use fetch"
    if not results:
        return f"rtsearch: no results for '{query[:80]}'"
    lines = [f"rtsearch: {len(results)} results for '{query[:80]}'"]
    for i, r in enumerate(results[:n], 1):
        lines.append(f"{i}. {r['title'][:120]} — {r['url']}")
        if r["snippet"]:
            lines.append(f"   {r['snippet'][:220]}")
    return "\n".join(lines)[:_RETURN_MAX]


def do_fetch(url, timeout=15, max_chars=6000, fetch_fn=None) -> str:
    """action=fetch body: one SSRF-guarded URL → capped extracted text.

    Capped at 6000 (dt_spec rule 9: tool returns stay ~≤6000 chars; the full
    page text an agent wants beyond that belongs in a workspace artifact)."""
    url = (url or "").strip()
    if not url:
        return "rtsearch: empty url — call action='fetch' with url='https://...'"
    if not is_public_http_url(url):
        return (f"rtsearch: refused {url[:120]} — only public http(s) URLs are "
                "fetched (SSRF guard blocks localhost/private/link-local hosts)")
    timeout = _clamp(timeout, 5, 60, 15)
    cap = _clamp(max_chars, 500, 6000, 6000)
    try:
        # injected fetch_page keeps the loop's single-arg contract; only the
        # live backend takes the timeout kwarg
        text = fetch_fn(url) if fetch_fn is not None else live_fetch(url, timeout=timeout)
        text = str(text or "").strip()
    except RtBlockedError as e:
        return f"rtsearch: {e}"
    except Exception as e:  # noqa: BLE001 — dead page → actionable string
        return f"rtsearch: fetch failed for {url[:80]}: {type(e).__name__}"
    if not text:
        return f"rtsearch: no extractable text at {url[:80]}"
    if len(text) > cap:
        return text[:cap] + f"\n…[truncated at {cap} chars]"
    return text


def do_report(state_dir, research_id="") -> str:
    """action=report body: brief from state (or the recent-runs list)."""
    rid = (research_id or "").strip()
    if not rid:
        items = recent_research(state_dir)
        if not items:
            return ("rtsearch: no research runs stored yet — start one with "
                    "action='research' question='...'")
        lines = ["rtsearch research runs (most recent first):"]
        for it in items:
            lines.append(f"  {it['id']}  {it['question'][:60]}  "
                         f"({it['created_at'][:10]}, {it['covered']}/"
                         f"{it['subqueries']} covered, {it['sources']} sources)")
        lines.append("full brief: action='report' research_id='<id>'")
        return "\n".join(lines)
    rec = load_research(state_dir, rid)
    if not rec:
        return (f"rtsearch: no research found with id '{rid}' — call report "
                "with no research_id to list recent runs")
    brief = rec.get("brief") or "(stored run has no brief)"
    out = f"rtsearch report {rid} — {rec.get('question', '')[:80]}\n\n{brief}"
    if len(out) > _RETURN_MAX:
        out = out[:_RETURN_MAX] + "…[truncated]"
    return out


def dispatch_action(state_dir, action="help", log=None, run_search=None,
                    fetch_page=None, question="", query="", url="",
                    research_id="", rounds=2, max_results=6,
                    fetch_per_round=3, timeout=15, max_chars=6000) -> str:
    """Plain dispatcher behind the strands tool — every action verb lands here,
    so the tests exercise exactly what the model-facing tool does."""
    a = (action or "help").strip().lower()
    if a == "research":
        return run_research(state_dir, question, rounds=rounds,
                            max_results=max_results,
                            fetch_per_round=fetch_per_round, timeout=timeout,
                            log=log, run_search=run_search, fetch_page=fetch_page)
    if a == "search":
        return do_search(query, max_results=max_results, search_fn=run_search)
    if a == "fetch":
        return do_fetch(url, timeout=timeout, max_chars=max_chars,
                        fetch_fn=fetch_page)
    if a == "report":
        return do_report(state_dir, research_id)
    if a == "help":
        return help_text()
    return (f"rtsearch: unknown action '{a}'. Use: research, search, fetch, "
            "report, help (try action='help').")


# ── strands surface ────────────────────────────────────────────────────────

def _ctx_logger(ctx):
    def _log(event, **fields):
        try:
            ctx.log(event, **fields)   # ToolContext.log is already never-raise
        except Exception:              # noqa: BLE001 — progress is best-effort
            pass
    return _log


def build(ctx) -> list:
    """Return the strands-decorated rtsearch tool. NEVER raises; [] offline
    (no strands / no ctx) so the registry loader stays bulletproof."""
    tools = []
    try:
        try:
            from strands import tool as strands_tool_decorator
        except Exception:
            return []  # offline sandbox: registry tolerates empty builds
        state_dir = ctx.tool_state(TOOL_NAMES[0])
        _log = _ctx_logger(ctx)

        @strands_tool_decorator(name="rtsearch", description=(
            "Real-time iterative web research loop. Use whenever the answer "
            "needs CURRENT web facts (news, prices, releases, comparisons): it "
            "decomposes the question into sub-queries, then runs rounds of "
            "search → fetch → read → refine until every sub-query is covered, "
            "and returns a sourced brief with [n] markers plus an explicit "
            "gaps section. Actions: research (run the loop), search (one-shot "
            "query), fetch (one URL → text), report (replay a stored brief), "
            "help."))
        def rtsearch(action: str = "help", question: str = "", query: str = "",
                     url: str = "", research_id: str = "", rounds: int = 2,
                     max_results: int = 6, fetch_per_round: int = 3,
                     timeout: int = 15, max_chars: int = 6000) -> str:
            """Run the real-time search research loop.
            action: research | search | fetch | report | help
            question: the question to research (action=research)
            query: single search query, no loop (action=search)
            url: page to fetch (action=fetch)
            research_id: run id from a prior research (action=report; empty lists runs)
            rounds: loop rounds, 1-4 (default 2)
            max_results: search results per sub-query, 1-10 (default 6)
            fetch_per_round: pages read per round, 1-5 (default 3)
            timeout: per-request HTTP timeout seconds, 5-60 (default 15)
            max_chars: text cap for action=fetch (default 6000)
            """
            try:
                return dispatch_action(
                    state_dir, action=action, log=_log, question=question,
                    query=query, url=url, research_id=research_id,
                    rounds=rounds, max_results=max_results,
                    fetch_per_round=fetch_per_round, timeout=timeout,
                    max_chars=max_chars)
            except Exception as e:  # noqa: BLE001 — errors are strings (spec)
                return f"rtsearch error: {type(e).__name__}: {e}"

        tools.append(rtsearch)
    except Exception:
        return []  # no ctx / broken ctx: register nothing, never raise
    return tools


# ── offline self-test (python3 brain/tools/dt_rtsearch.py) ────────────────

if __name__ == "__main__":
    import sys
    import tempfile

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # for dt_registry

    def _ok(name, cond):
        assert cond, f"SELF-TEST FAILED: {name}"
        print(f"  ok: {name}")

    tmp = Path(tempfile.mkdtemp(prefix="rtsearch-"))

    # SSRF guard truth table (private/link-local/non-http blocked; public ok)
    _ok("ssrf blocks loopback", not is_public_http_url("http://127.0.0.1:8080/x"))
    _ok("ssrf blocks 10/8", not is_public_http_url("http://10.1.2.3/"))
    _ok("ssrf blocks 192.168", not is_public_http_url("http://192.168.0.9/a"))
    _ok("ssrf blocks 169.254 metadata", not is_public_http_url("http://169.254.169.254/latest/meta-data"))
    _ok("ssrf blocks 172.16-31", not is_public_http_url("http://172.16.0.1/") and not is_public_http_url("http://172.31.255.255/"))
    _ok("ssrf allows 172.32", is_public_http_url("http://172.32.0.1/"))
    _ok("ssrf blocks localhost", not is_public_http_url("http://localhost/") and not is_public_http_url("http://api.localhost/x"))
    _ok("ssrf blocks file://", not is_public_http_url("file:///etc/passwd"))
    _ok("ssrf blocks ftp", not is_public_http_url("ftp://example.com/x"))
    _ok("ssrf blocks ipv6 loopback", not is_public_http_url("https://[::1]/x") and not is_public_http_url("http://[::ffff:127.0.0.1]/"))
    _ok("ssrf allows https", is_public_http_url("https://example.com/a?b=c"))
    _ok("ssrf allows public ipv4", is_public_http_url("http://8.8.8.8/dns"))

    # decomposition: a vs-question splits into 2-4 non-empty sub-queries
    subs = decompose_question("Kagi vs DuckDuckGo for privacy and pricing in 2025")
    _ok("decompose count 2-4", 2 <= len(subs) <= 4)
    _ok("decompose keeps a comparison sub", any(" vs " in s for s in subs))
    _ok("decompose covers both sides", any("kagi" in s.lower() for s in subs) and any("duckduckgo" in s.lower() for s in subs))
    _ok("decompose no stopword-only subs", all(_key_terms(s) for s in subs))
    _ok("decompose single clause ≥2", len(decompose_question("how does kubernetes autoscaling work")) >= 2)
    _ok("decompose never empty", len(decompose_question("what is the best")) >= 2)

    # fakes: recording backends, no network
    log_events = []

    def fake_search_factory(script):
        calls = []
        def run_search(query, n):
            calls.append((query, n))
            if isinstance(script, Exception):
                raise script
            return script
        return run_search, calls

    def fake_fetch_factory(body, calls):
        def fetch_page(url):
            calls.append(url)
            return body(url)
        return fetch_page, calls

    # loop runs exactly `rounds` times when coverage never completes
    script = [{"title": f"t{i}", "url": f"https://ex{i}.com/a", "snippet": "s"} for i in range(3)]
    rs, calls = fake_search_factory(script)
    rf, fcalls = fake_fetch_factory(lambda u: "short", [])
    out = research_loop("kagi vs duckduckgo pricing", rounds=3, run_search=rs,
                        fetch_page=rf, on_round=lambda r, q, n, f: log_events.append((r, q, n, f)),
                        fetch_min_chars=200)
    _ok("loop runs all rounds when uncovered", out["rounds_run"] == 3)
    _ok("loop searches every pending subquery each round",
        len(calls) == 3 * len(out["slots"]))
    _ok("round progress emitted per round", len(log_events) == 3)
    _ok("uncovered → gaps", len(out["gaps"]) == len(out["slots"]))

    # loop stops after round 1 when everything is covered
    log_events.clear()
    rs, _ = fake_search_factory(script)
    rf, fcalls = fake_fetch_factory(lambda u: "Sentence one is long enough. " * 30, [])
    out = research_loop("kagi vs duckduckgo pricing", rounds=4, run_search=rs,
                        fetch_page=rf, on_round=lambda r, q, n, f: log_events.append((r, q, n, f)))
    _ok("loop stops early when covered", out["rounds_run"] == 1 and not out["gaps"])
    _ok("all slots covered", all(s["covered"] for s in out["slots"]))
    _ok("progress fired once", len(log_events) == 1)

    # refinement rotates qualifiers on uncovered sub-queries
    rs, _ = fake_search_factory([])   # zero results → nothing ever covered
    rf, fcalls = fake_fetch_factory(lambda u: "x" * 500, [])
    out = research_loop("rust vs golang performance", rounds=3, run_search=rs, fetch_page=rf)
    r2 = [q for q in out["rounds_log"][1]["queries"]]
    r3 = [q for q in out["rounds_log"][2]["queries"]]
    _ok("round-2 queries reworded with qualifier 1",
        all(q.endswith("latest 2025") for q in r2))
    _ok("round-3 queries rotate to qualifier 2",
        all(q.endswith("news") for q in r3))

    # seen-URL dedup: repeated results are never re-fetched
    rs, _ = fake_search_factory(script)
    rf, fcalls = fake_fetch_factory(lambda u: "short", [])  # bad fetches
    research_loop("kagi vs duckduckgo", rounds=3, run_search=rs, fetch_page=rf)
    _ok("each URL fetched at most once", len(fcalls) == len(set(fcalls)))

    # synthesis: markers, gaps, excerpts ≤400, brief ≤6000
    def picky_search(query, n):
        if "kagi" in query.lower() and "vs" not in query.lower():
            return [{"title": "Kagi FAQ", "url": "https://kagi.example/faq", "snippet": "kagi"}]
        return [{"title": "DDG", "url": "https://ddg.example/about", "snippet": "ddg"}]
    rf, _ = fake_fetch_factory(lambda u: "x" * 600 if "kagi" in u else "tiny", [])
    out = research_loop("kagi vs duckduckgo privacy", rounds=2,
                        run_search=picky_search, fetch_page=rf, fetch_min_chars=200)
    brief = synthesize_brief(out["question"], out["slots"], out["sources"], out["rounds_run"])
    _ok("brief has source marker", "[1]" in brief)
    _ok("brief has SOURCES + fetched-at", "SOURCES" in brief and "fetched" in brief)
    _ok("brief lists gaps", "not covered:" in brief)
    _ok("excerpts ≤ 400", all(len(s["excerpt"]) <= 400 for s in out["sources"]))
    _ok("brief ≤ 6000", len(brief) <= 6000)
    _ok("pick_excerpt caps long text", len(pick_excerpt("word " * 900)) <= 400)

    # state round-trip through the action layer (offline fakes injected)
    def ok_search(query, n):
        return [{"title": "T", "url": "https://a.example/x", "snippet": "s"}]
    rf, _ = fake_fetch_factory(lambda u: "Sentence one. " * 40, [])
    logs = []
    out_txt = run_research(tmp, "kagi vs duckduckgo pricing", rounds=2,
                           run_search=ok_search, fetch_page=rf,
                           log=lambda e, **f: logs.append((e, f)))
    _ok("run_research returns brief + id", "RESEARCH BRIEF" in out_txt and "research_id:" in out_txt)
    _ok("rtsearch_round logged with round/queries/results/fetched",
        any(e == "rtsearch_round" and "round" in f and "queries" in f and "results" in f and "fetched" in f for e, f in logs))
    _ok("rtsearch_done logged", any(e == "rtsearch_done" for e, _ in logs))
    rid = out_txt.split("research_id: ")[1].split(" ")[0].strip()
    rep = do_report(tmp, rid)
    _ok("report round-trips the brief", "RESEARCH BRIEF" in rep and rid in rep)
    _ok("report lists runs when id empty", "rtsearch research runs" in do_report(tmp))
    _ok("report unknown id degrades", "no research found" in do_report(tmp, "rzzzzzzz"))
    _ok("state file is valid JSON", isinstance(json.loads((_state_file(tmp)).read_text()), dict))

    # history stays bounded
    for i in range(_MAX_RECORDS + 2):
        run_research(tmp, f"q number {i}", rounds=1, run_search=ok_search,
                     fetch_page=rf)
    st = _load_state(_state_file(tmp))
    _ok("history capped", len(st["order"]) <= _MAX_RECORDS and len(st["records"]) <= _MAX_RECORDS)

    # backend-missing degrade: monkeypatch the lazy importer (offline-safe)
    _orig_ddgs = _import_ddgs
    globals()["_import_ddgs"] = lambda: None
    try:
        msg = do_search("anything")
        _ok("missing backend → clean message", "duckduckgo-search" in msg and "pip install" in msg)
        rl = research_loop("kagi vs ddg", rounds=2, run_search=None, fetch_page=lambda u: "x" * 300)
        _ok("loop bails with backend_error", rl["backend_error"] != "" and rl["rounds_run"] == 1)
    finally:
        globals()["_import_ddgs"] = _orig_ddgs

    # action dispatch edges
    _ok("help lists actions", all(v in help_text() for v in ("research", "search", "fetch", "report")))
    _ok("unknown action degrades", "unknown action" in dispatch_action(tmp, action="blast"))
    _ok("empty question degrades", "empty question" in dispatch_action(tmp, action="research"))
    _ok("empty query degrades", "empty query" in dispatch_action(tmp, action="search", query=" "))
    _ok("fetch blocks private url", "refused" in do_fetch("http://127.0.0.1:9/x"))
    _ok("fetch blocks file://", "refused" in do_fetch("file:///etc/passwd"))
    _ok("fetch with fake fn caps text",
        len(do_fetch("https://example.com/a", fetch_fn=lambda u: "z" * 9000)) <= 6100)

    # build(): no strands installed → [] and never raises
    import dt_registry  # stdlib-only; safe offline
    fake_ctx = dt_registry.ToolContext(workspace=Path(tempfile.mkdtemp(prefix="rtctx-")))
    _ok("build() offline returns []", build(fake_ctx) == [])
    _ok("build(None) never raises", build(None) == [])

    print("SELF-TEST OK")
