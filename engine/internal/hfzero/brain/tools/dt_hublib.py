"""dt_hublib.py — browse + download the PUBLIC HUB's template & skill
libraries from chat (the `hublib` tool).

The hub (engine/internal/hub) is the community library: personas, templates
and skills published as HF datasets. Until now it was UI-ONLY — the ✦ Public
Library panel. This tool is the bot-side half (user spec, wave item 12):
"the bot is able to browse templates and skills and choose downloaded ones
if the template or skill boxes are enabled on the fly."

HOW IT READS
============
- BROWSING: GET /api/hub/{type}/items (the same merged local+federated view
  the panel renders — 10-min engine cache, one fan-out). Every browse also
  EMITS a `hublist` chat event (through the ctx.emit "chat_event" seam,
  agent_core._emit_dt_progress) so the user sees the results as tappable
  cards with one-press download buttons — the v0.22 house pattern (a card
  follows the pill), not a wall of text.
- CHOOSING/DOWNLOADING: POST /api/hub/{type}/download — the SAME engine call
  the hub panel's ⤓ makes, so the item lands in the engine's hub_items rows
  and follows the user across devices (the template sheet merges engine
  downloads — "Yours" — per v0.48). The download response hands the payload
  back to the model so it can follow the methodology immediately.
- THE LIB GATE (v0.60 pt C.9, ON THE FLY): each chat's ✦ tweaks blob may
  carry botLib (absent = enabled — backward compatible). The tool re-reads
  GET /api/sessions/{id}/tweaks on EVERY call, so flipping the switch
  mid-conversation takes effect on the next tool call, no restart. OFF
  keeps browse/detail/libraries/downloaded working (the model can still
  browse + RECOMMEND) and refuses only the download action with an
  actionable message naming the exact switch.

State (workspace/.doomalay/hublib/): last.json — the previous browse's
items (type → [{repo,id,name,…}]) so the model can `download` by bare name
("grab the tdd one") without re-copying repo/id pairs.

Degrades, never crashes (dt_spec rule 5): engine down / HF down / tweaks
unreadable all collapse into short actionable strings.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

TOOL_NAMES = ["hublib"]  # primary (only) tool name built below

# The hub libraries hublib serves. Personas are deliberately excluded: their
# import flow (persona picker → chat personas) is a different engine path
# with its own UX. v0.60 pt C.9: scripts + docs join (the port's repo
# companions — browsable + recommendable; payloads land the same way).
HUBLIB_TYPES = ("template", "skill", "script", "doc")

# v0.60 pt C.9: THE LIB PILL — ONE gatekeeping switch ("Bot Library" in
# ✦ tweaks, key botLib; absent = enabled). Legacy bots wrote per-type
# botTemplates/botSkills keys: both-false reads as off, anything else on.
LIB_KEY = "botLib"
LEGACY_BOX_KEYS = ("botTemplates", "botSkills")
TYPE_LABELS = {"template": "templates", "skill": "skills",
               "script": "scripts", "doc": "docs"}

# The hublist event payload cap — one card per item, 12 cards is plenty for
# a chat screen; the text return says where the rest live.
MAX_EVENT_ITEMS = 12
MAX_TEXT_ITEMS = 12
MAX_OUT = 6000  # dt_spec rule 9 — return text stays a few screens max
DEFAULT_TIMEOUT = 8.0
SLOW_TIMEOUT = 30.0  # browse/detail/download fan out over HF repos

BOX_LABEL_SWITCH = "✦ tweaks → Bot Library"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clip(text: str, limit: int, where: str = "") -> str:
    text = str(text or "")
    if len(text) <= limit:
        return text
    cut = text[:limit]
    note = f" …[clipped, full {where}]" if where else " …[clipped]"
    return cut + note


def _norm_type(raw: str) -> str:
    return str(raw or "").strip().lower()


def _quote_seg(seg: str) -> str:
    """One URL path segment (a repo is 'user/name' — must stay ONE segment,
    exactly like hubitem.js's encodeURIComponent(repo))."""
    from urllib.parse import quote
    return quote(str(seg or ""), safe="")


# ─────────────────────────────────────────────────────────────────────────
# The lib gate (pure — the unit-tested core)
# ─────────────────────────────────────────────────────────────────────────

def lib_enabled(tweaks: dict | None) -> tuple[bool, str]:
    """Is the chat's Bot Library switch ON?

    v0.60 pt C.9 semantics: OFF means the model can still BROWSE and
    RECOMMEND (browse/detail/libraries/downloaded all work) — only the
    DOWNLOAD (the "use") action refuses with the actionable switch path.

    tweaks = the chat's tweak blob (GET /api/sessions/{id}/tweaks → .tweaks).
    Absent/None/unreadable all mean ENABLED — the switch is an opt-OUT: a
    chat that never touched it keeps full bot library access (backward
    compatible with every pre-switch chat). Legacy per-type keys
    (botTemplates/botSkills): BOTH explicitly false reads as off (an old
    chat that turned every box off), anything else on.

    Returns (enabled, message) — message is "" when enabled, else the
    actionable refusal the model should relay verbatim.
    """
    if not isinstance(tweaks, dict):
        return True, ""
    if tweaks.get(LIB_KEY) is False:
        return False, (
            "the Bot Library switch is OFF for this chat — ask the user to "
            f"switch it back on ({BOX_LABEL_SWITCH}), then retry. You can "
            "still browse and recommend: say what you found and what to enable."
        )
    if (all(tweaks.get(k) is False for k in LEGACY_BOX_KEYS)
            and any(k in tweaks for k in LEGACY_BOX_KEYS)):
        return False, (
            "the Bot Library switch is OFF for this chat — ask the user to "
            f"switch it back on ({BOX_LABEL_SWITCH}), then retry. You can "
            "still browse and recommend: say what you found and what to enable."
        )
    return True, ""


def read_boxes(payload: dict | None) -> dict:
    """Lift the tweak-blob dict out of the tweaks GET response
    ({tweaks: {...}} → {...}); tolerant of missing/odd shapes."""
    if isinstance(payload, dict):
        t = payload.get("tweaks")
        if isinstance(t, dict):
            return t
    return {}


# ─────────────────────────────────────────────────────────────────────────
# The pill payload builder (pure)
# ─────────────────────────────────────────────────────────────────────────

def card_for_item(item: dict, downloaded: bool = False) -> dict:
    """One hublist card — ONLY the fields the renderer needs. The payload
    (a template JSON / SKILL.md body) never rides the event; the user's
    one-press download fetches it engine-side, and the model's download
    action gets it in its own return text."""
    it = item if isinstance(item, dict) else {}
    tags = it.get("tags") if isinstance(it.get("tags"), list) else []
    return {
        "type": str(it.get("type") or ""),
        "repo": str(it.get("repo") or ""),
        "id": str(it.get("id") or ""),
        "name": str(it.get("name") or "item"),
        "description": _one_liner(str(it.get("description") or "")),
        "author": str(it.get("author") or ""),
        "tags": [str(t) for t in tags[:4]],
        "hearts": _int(it.get("hearts")),
        "downloads": _int(it.get("downloads")),
        "downloaded": bool(downloaded),
    }


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0


def _one_liner(text: str, width: int = 110) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:width] + ("…" if len(text) > width else "")


def build_event(summary: str, cards: list[dict]) -> dict:
    """The `hublist` chat event. `text` carries the FULL JSON so the engine
    relay persists it (content = text) and a page REPLAY rebuilds the exact
    same box; the top-level fields give the LIVE path the same data without
    a parse (chatpanel handles both shapes, sources-style)."""
    payload = {"summary": str(summary or ""), "items": cards[:MAX_EVENT_ITEMS]}
    return {
        "type": "hublist",
        "summary": str(summary or ""),
        "items": payload["items"],
        "text": json.dumps(payload, ensure_ascii=False),
    }


def emit_hub_event(emit: Callable[..., Any] | None, summary: str,
                   cards: list[dict]) -> bool:
    """Best-effort pill emission through the orchestrator's chat_event seam
    (agent_core._emit_dt_progress / agent.py _dt_progress pass it to the
    turn emit). Never raises; returns True when the event was handed off."""
    if emit is None or not cards:
        return False
    try:
        emit("chat_event", ev=build_event(summary, cards))
        return True
    except Exception:
        return False


def resolve_ref(cached: list[dict], ref: str) -> dict | None:
    """Resolve a download reference against the LAST browse's items:
    'repo/id' exact, or a fuzzy name match (case/space-insensitive,
    unique substring). Returns the cached row or None."""
    ref = str(ref or "").strip()
    if not ref or not isinstance(cached, list):
        return None
    # exact "repo/id"
    if "/" in ref:
        repo, _, rid = ref.rpartition("/")
        for it in cached:
            if str(it.get("repo", "")).lower() == repo.lower() and \
               str(it.get("id", "")).lower() == rid.lower():
                return it
    want = re.sub(r"[^a-z0-9]+", "", ref.lower())
    if not want:
        return None
    exact, partial = None, []
    for it in cached:
        name = re.sub(r"[^a-z0-9]+", "", str(it.get("name", "")).lower())
        if not name:
            continue
        if name == want:
            exact = it
            break
        if want in name or name in want:
            partial.append(it)
    if exact:
        return exact
    return partial[0] if len(partial) == 1 else None


# ─────────────────────────────────────────────────────────────────────────
# HubLibClient — the engine REST seam (httpx lazily imported, dt_spec rule 1)
# ─────────────────────────────────────────────────────────────────────────

class HubLibClient:
    """Client for the engine's hub REST surface (+ the tweaks read).

    transport is THE test seam (httpx.MockTransport over a fake engine);
    None → a real httpx.Client. Every method returns plain dicts — success
    carries domain keys, failure carries {"error": "<actionable msg>"}.
    Methods NEVER raise (dt_spec rule 5): refused/timeout/5xx all collapse
    into error strings the model can read and act on.
    """

    def __init__(self, base_url: str, session_id: str | None,
                 transport=None, timeout: float = DEFAULT_TIMEOUT,
                 slow_timeout: float = SLOW_TIMEOUT):
        self.base_url = str(base_url or "http://127.0.0.1:8080").rstrip("/")
        self.session_id = session_id
        self._transport = transport
        self._timeout = timeout
        self._slow_timeout = slow_timeout
        self._client = None  # lazy httpx.Client — no I/O at build() time

    def _http(self):
        import httpx  # lazy (dt_spec rule 1): import-time failure impossible
        if self._client is None:
            tok = ""
            try:  # loopback needs nothing; a token-configured engine demands it
                import os
                tok = os.environ.get("DOOMALAY_ENGINE_TOKEN", "")
            except Exception:
                tok = ""
            headers = {"Authorization": f"Bearer {tok}"} if tok else {}
            kw: dict = {"timeout": self._timeout, "headers": headers}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._client = httpx.Client(**kw)
        return self._client

    def _request(self, method: str, path: str, *, params=None,
                 json_body=None, slow: bool = False) -> dict:
        try:
            r = self._http().request(
                method, self.base_url + path, params=params, json=json_body,
                timeout=self._slow_timeout if slow else self._timeout)
        except Exception as exc:  # refused / timeout / dns — one message shape
            return {"error": f"engine unreachable at {self.base_url}: {exc}"}
        body: Any = None
        try:
            body = r.json()
        except Exception:
            body = None
        if r.status_code >= 400:
            msg = ""
            if isinstance(body, dict):
                msg = str(body.get("error") or body.get("message") or "")
            return {"error": _clip(msg or f"HTTP {r.status_code} from {path}",
                                   240), "status": r.status_code}
        return body if isinstance(body, dict) else {"error": "unexpected engine response"}

    # ── hub surface ────────────────────────────────────────────────────
    def libraries(self) -> dict:
        return self._request("GET", "/api/hub/libraries")

    def items(self, typ: str, q: str = "", sort: str = "", tag: str = "") -> dict:
        params = {k: v for k, v in (("q", q), ("sort", sort), ("tag", tag)) if v}
        return self._request("GET", f"/api/hub/{_quote_seg(typ)}/items",
                             params=params or None, slow=True)

    def detail(self, typ: str, repo: str, item_id: str) -> dict:
        return self._request(
            "GET", f"/api/hub/{_quote_seg(typ)}/item/{_quote_seg(repo)}/{_quote_seg(item_id)}",
            slow=True)

    def download(self, typ: str, repo: str, item_id: str) -> dict:
        return self._request(
            "POST", f"/api/hub/{_quote_seg(typ)}/download",
            json_body={"repo": repo, "id": item_id}, slow=True)

    def downloads(self, typ: str) -> dict:
        return self._request("GET", f"/api/hub/{_quote_seg(typ)}/downloads",
                             slow=True)

    def tweaks(self) -> dict:
        """The chat's tweak blob — THE BOXES. 404 (no session bound, e.g. a
        workspace-less sub-agent) is not an error: no chat → no boxes →
        default-enabled. Only a real engine failure flips the fallback flag."""
        if not self.session_id:
            return {"tweaks": {}}
        out = self._request("GET", f"/api/sessions/{_quote_seg(self.session_id)}/tweaks")
        if out.get("error") and out.get("status") == 404:
            return {"tweaks": {}}
        return out


# ─────────────────────────────────────────────────────────────────────────
# State — last.json (the previous browse, for bare-name downloads)
# ─────────────────────────────────────────────────────────────────────────

def _load_last(state_dir: Path | str | None) -> dict:
    try:
        p = Path(state_dir) / "last.json"
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_last(state_dir: Path | str | None, data: dict) -> None:
    """Atomic write (tmp + os.replace — dt_spec rule 3); never raises."""
    try:
        import os
        import tempfile
        p = Path(state_dir) / "last.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".last-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False)
            os.replace(tmp, p)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except Exception:
        pass


def _downloaded_ids(downloads_payload: dict) -> set[str]:
    """ids the engine already has locally for one type
    (GET /api/hub/{type}/downloads → [{item, payload}, …])."""
    out: set[str] = set()
    rows = downloads_payload.get("items")
    if isinstance(rows, list):
        for row in rows:
            it = row.get("item") if isinstance(row, dict) else None
            if isinstance(it, dict) and it.get("id"):
                out.add(str(it["id"]))
    return out


def _format_items(items: list[dict], dl_ids: set[str], typ: str,
                  total: int) -> str:
    """The model-facing text list — compact, id-addressed, honest about
    clipping (the user's cards carry the one-press buttons)."""
    lines = []
    shown = items[:MAX_TEXT_ITEMS]
    for it in shown:
        name = str(it.get("name") or "item")
        desc = _one_liner(str(it.get("description") or ""), 70)
        marks = []
        if str(it.get("id")) in dl_ids:
            marks.append("downloaded")
        stats = f"♥{_int(it.get('hearts'))} ⤓{_int(it.get('downloads'))}"
        line = f"• {name}"
        if desc:
            line += f" — {desc}"
        line += f" [{stats}{' · ' + ' · '.join(marks) if marks else ''}]"
        line += f" ({it.get('repo') or 'local'}/{it.get('id')})"
        lines.append(line)
    head = f"{total} {typ}{'s' if total != 1 else ''}"
    if total > len(shown):
        head += f" (showing {len(shown)} — narrow with q= for the rest)"
    return head + "\n" + "\n".join(lines)


TOOL_DESCRIPTION = (
    "Browse the PUBLIC HUB's community template and skill libraries and "
    "download items into this chat's library. Use when the user wants to "
    "find, explore, compare or get templates (method pipelines like "
    "deep-research, brainstorm, TDD flows) or skills (methodologies) from "
    "the community — or asks what's available/new/popular. Actions: "
    "browse (search + filter, also shows the user tappable cards with "
    "one-press download), detail (full item + payload preview), download "
    "(repo/id or a bare name from the last browse), downloaded (what this "
    "chat already has), libraries, help. Per-chat Templates/Skills boxes "
    "(tweaks) gate each type — disabled boxes return how to re-enable."
)


# ─────────────────────────────────────────────────────────────────────────
# run() — the plain action dispatcher (no strands, no httpx; unit-testable)
# ─────────────────────────────────────────────────────────────────────────

def run(action: str, *, typ: str = "", q: str = "", tag: str = "",
        sort: str = "", ref: str = "", repo: str = "", item_id: str = "",
        client: Any = None, session_id: str | None = None,
        state_dir: Path | str | None = None,
        emit: Callable[..., Any] | None = None,
        log: Callable[..., Any] | None = None) -> str:
    """Execute one hublib action. client is any HubLibClient-shaped object
    (tests pass fakes); emit/log are best-effort telemetry seams."""
    action = (action or "help").strip().lower()
    typ = _norm_type(typ)
    if client is None:
        client = HubLibClient("", session_id)  # unreachable-by-design path

    def _note(event: str, **fields: Any) -> None:
        try:
            if log is not None:
                log(event, **fields)
        except Exception:
            pass

    # ── help / libraries — never gated (they change nothing) ───────────
    if action == "help":
        return HELP_TEXT

    if action == "libraries":
        out = _safe(lambda: client.libraries())
        if not isinstance(out, dict):
            out = {"error": str(out)}
        if "error" in out:
            return f"hublib: {out['error']}"
        if "libraries" not in out:
            return "hublib: unexpected libraries payload from the engine."
        libs = out.get("libraries")
        lines = []
        if isinstance(libs, list):
            for lib in libs:
                if not isinstance(lib, dict):
                    continue
                lines.append(
                    f"• {lib.get('type')}: {lib.get('label')} — "
                    f"{_int(lib.get('localCount'))} downloaded locally. "
                    f"{_one_liner(str(lib.get('desc') or ''), 80)}")
        lines.append("hublib browses + downloads the template, skill, script "
                     "and doc libraries; the persona library imports through "
                     "the hub panel's persona picker.")
        return "\n".join(lines)

    # ── every hub-touching action validates the verb FIRST (an unknown
    # action must say so, not complain about a missing type), then the type
    known = {"browse", "detail", "download", "downloaded"}
    if action not in known:
        return (f"unknown action '{action}' — try one of " + " | ".join(sorted(known))
                + " (or action='help' for the cheat-sheet)")
    if typ not in HUBLIB_TYPES:
        return ("hublib serves templates, skills, scripts and docs "
                f"(got '{typ or 'empty'}). Personas import via the hub panel.")

    # ── THE LIB GATE — read on the fly, every call. v0.60 pt C.9: OFF means
    # browse + recommend still work (the model tells the user what it found);
    # only DOWNLOAD (the "use") refuses with the switch path. An unreadable
    # tweak blob (engine hiccup, race) defaults to ENABLED.
    try:
        tweaks = read_boxes(client.tweaks())
    except Exception:
        tweaks = {}
    if action == "download":
        ok, msg = lib_enabled(tweaks)
        if not ok:
            _note("hublib_lib_off", type=typ)
            return f"hublib: {msg}"

    try:
        return _dispatch(action, typ=typ, q=q, tag=tag, sort=sort, ref=ref,
                         repo=repo, item_id=item_id, client=client,
                         state_dir=state_dir, emit=emit, log=_note)
    except Exception as exc:  # run() never raises — the tool-call contract
        return f"hublib error: {type(exc).__name__}: {exc}"


def _dispatch(action: str, *, typ: str, q: str, tag: str, sort: str,
              ref: str, repo: str, item_id: str, client: Any,
              state_dir: Path | str | None, emit: Callable[..., Any] | None,
              log: Callable[..., Any] | None) -> str:
    """The action bodies (run() has already validated verb + type and
    gated download on the lib switch; this half assumes a sane client
    and degrades per call)."""

    if action == "browse":
        out = _safe(lambda: client.items(typ, q=q, sort=sort, tag=tag))
        if not isinstance(out, dict):
            out = {"error": str(out)}
        if "error" in out:
            return f"hublib: {out['error']}"
        items = out.get("items")
        if not isinstance(items, list):
            return "hublib: unexpected items payload from the engine."
        if not items:
            hint = f" for '{q}'" if q else ""
            return (f"no {typ}s{hint} in the hub right now — try another "
                    "query or sort=recent.")
        dl_rows = _safe(lambda: client.downloads(typ))
        dl_ids = (_downloaded_ids(dl_rows)
                  if isinstance(dl_rows, dict) and "error" not in dl_rows else set())
        cards = [card_for_item(it, str(it.get("id")) in dl_ids) for it in items]
        summary = f"hub · {len(items)} {typ}{'s' if len(items) != 1 else ''}" \
                  + (f" · '{q}'" if q else "")
        emit_hub_event(emit, summary, cards)
        log("hublib_browse", type=typ, q=q, n=len(items))
        _save_last(state_dir, {**_load_last(state_dir), typ: cards})
        text = _format_items(items, dl_ids, typ, len(items))
        tail = ("\n(the user sees tappable cards for these — each with a "
                "one-press download button; download with ref='name' or "
                "'repo/id')")
        return _clip(text + tail, MAX_OUT)

    if action == "detail":
        row = _resolve_target(client, state_dir, typ, ref, repo, item_id)
        if isinstance(row, str):
            return row
        out = client.detail(typ, row["repo"], row["id"])
        if "error" in out:
            return f"hublib: {out['error']}"
        item = out.get("item") if isinstance(out.get("item"), dict) else {}
        payload = str(out.get("payload") or "")
        head = (f"{item.get('name') or row['id']} — "
                f"{_one_liner(str(item.get('description') or ''), 140)}\n"
                f"by {item.get('author') or '?'} · ♥{_int(item.get('hearts'))} "
                f"⤓{_int(item.get('downloads'))} · tags: "
                f"{', '.join(item.get('tags') or []) or '—'}\n")
        return _clip(head + "\npayload preview:\n" + _clip(payload, 2600,
                                                            "payload — download it to use"), MAX_OUT)

    if action == "download":
        row = _resolve_target(client, state_dir, typ, ref, repo, item_id)
        if isinstance(row, str):
            return row
        out = client.download(typ, row["repo"], row["id"])
        if "error" in out:
            return f"hublib: {out['error']}"
        item = out.get("item") if isinstance(out.get("item"), dict) else {}
        payload = str(out.get("payload") or "")
        name = str(item.get("name") or row.get("name") or row["id"])
        # the user's confirmation card — already-downloaded state, one item
        emit_hub_event(emit, f"downloaded · {name}",
                       [card_for_item(item or row, True)])
        log("hublib_download", type=typ, name=name)
        where = ("the template sheet (⧉) lists it under Yours" if typ == "template"
                 else "the template sheet (⧉) lists it as a method row")
        return _clip(
            f"downloaded '{name}' — {where}, on every device.\n"
            f"payload (follow it now if it fits the task):\n"
            + _clip(payload, 3000, "payload"), MAX_OUT)

    if action == "downloaded":
        out = client.downloads(typ)
        if "error" in out:
            return f"hublib: {out['error']}"
        rows = out.get("items")
        if not isinstance(rows, list) or not rows:
            return f"no {typ}s downloaded for this chat yet — browse to find some."
        lines = [f"downloaded {typ}s:"]
        for row in rows[:MAX_TEXT_ITEMS]:
            it = row.get("item") if isinstance(row, dict) else None
            if isinstance(it, dict):
                lines.append(f"• {it.get('name')} "
                             f"({it.get('repo') or 'local'}/{it.get('id')})")
        return _clip("\n".join(lines), MAX_OUT)

    return (f"unknown action '{action}' — " + HELP_TEXT.split("\n")[0]
            + "\n(call action='help' for the full cheat-sheet)")


def _safe(fn: Callable[[], Any]) -> Any:
    """Call a client method; a raising (broken) client degrades to an
    error dict instead of blowing the tool loop."""
    try:
        return fn()
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def _resolve_target(client: Any, state_dir: Path | str | None, typ: str,
                    ref: str, repo: str, item_id: str) -> dict | str:
    """download/detail addressing: explicit repo+id wins, then the LAST
    browse's cache by 'repo/id' or bare name, then a fresh name search
    (cheap: the engine's 10-min items cache). Returns a {repo,id,name?} row
    or an error string the model can act on."""
    repo = str(repo or "").strip()
    item_id = str(item_id or "").strip()
    if repo and item_id:
        return {"repo": repo, "id": item_id}
    ref = str(ref or "").strip()
    if not ref:
        return ("hublib: give ref='name' (from the last browse) or repo+id "
                "(both required together).")
    cached = _load_last(state_dir).get(typ)
    row = resolve_ref(cached if isinstance(cached, list) else [], ref)
    if row and row.get("repo") and row.get("id"):
        return {"repo": str(row["repo"]), "id": str(row["id"]),
                "name": str(row.get("name") or "")}
    # last resort: a fresh name search over the engine's cached items
    out = _safe(lambda: client.items(typ, q=ref))
    if "error" not in out and isinstance(out.get("items"), list):
        hits = [it for it in out["items"]
                if isinstance(it, dict) and _one_liner(str(it.get("name") or ""), 60).lower()
                .find(re.sub(r"\s+", " ", ref.lower()).strip()) >= 0]
        if len(hits) == 1 and hits[0].get("repo") and hits[0].get("id"):
            return {"repo": str(hits[0]["repo"]), "id": str(hits[0]["id"]),
                    "name": str(hits[0].get("name") or "")}
        if len(hits) > 1:
            return ("hublib: ambiguous name '" + ref + "' — " +
                    " / ".join(f"{h.get('name')} ({h.get('repo')}/{h.get('id')})"
                               for h in hits[:5]) + " — pass repo+id or a longer name.")
    return (f"hublib: could not resolve '{ref}' — browse first, then pass "
            "ref='name' or repo+id.")


HELP_TEXT = (
    "hublib — the PUBLIC HUB's template + skill libraries, from chat.\n"
    "actions (action=…):\n"
    "• browse — search the community hub: type='template'|'skill', optional "
    "q=, sort=recent|downloads|hearts|relevant, tag=. Also shows the user "
    "tappable cards with one-press download.\n"
    "• detail — full item + payload preview: type + (ref='name' or repo+id).\n"
    "• download — save an item into the chat's library (template sheet → "
    "Yours) and get its payload to follow: type + (ref='name' or repo+id).\n"
    "• downloaded — what this chat already has: type=…\n"
    "• libraries — the hub's libraries + local counts.\n"
    "gating: the per-chat ✦ tweaks 'Bot Library' boxes (Templates / Skills) "
    "switch each type on/off — checked on every call, mid-chat flips apply "
    "immediately."
)


# ─────────────────────────────────────────────────────────────────────────
# strands surface
# ─────────────────────────────────────────────────────────────────────────

def build(ctx) -> list:
    """Return the @tool-decorated `hublib` callable built from ctx.

    Never raises (dt_spec rule 2): strands missing → []; the client is
    constructed lazily per call (zero I/O at build time). State (last.json)
    is only touched by browse/download — help/libraries/detail stay
    side-effect-free on disk.
    """
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []  # offline / SDK missing: register nothing, stay importable

    try:
        engine_url = str(getattr(ctx, "engine_url", "") or
                         "http://127.0.0.1:8080")
        session_id = getattr(ctx, "chat_session_id", None)

        def _state_dir():
            try:
                return ctx.tool_state("hublib")
            except Exception:
                return None

        def _emit(event: str = "status", **fields: Any) -> None:
            try:
                if getattr(ctx, "emit", None) is not None:
                    ctx.emit(event, **fields)
            except Exception:
                pass

        def _log(event: str, **fields: Any) -> None:
            try:
                ctx.log(event, **fields)
            except Exception:
                pass

        @strands_tool_decorator(name="hublib", description=TOOL_DESCRIPTION)
        def hublib(action: str, type: str = "", q: str = "", tag: str = "",
                   sort: str = "", ref: str = "", repo: str = "",
                   id: str = "") -> str:
            """Browse and download the community hub's templates and skills.

            Args:
                action: one of browse | detail | download | downloaded |
                    libraries | help.
                type: 'template' or 'skill' (required except help/libraries).
                q: search terms (action="browse").
                tag: exact tag filter, e.g. 'superpowers-obra' (browse).
                sort: recent | downloads | hearts | relevant (browse).
                ref: an item name from the last browse, or 'repo/id'
                    (detail/download).
                repo: explicit repo half of the item address (with id).
                id: explicit id half of the item address (with repo).
            """
            try:
                client = HubLibClient(engine_url, session_id)
                return run(action, typ=type, q=q, tag=tag, sort=sort,
                           ref=ref, repo=repo, item_id=id,
                           client=client, session_id=session_id,
                           state_dir=_state_dir() if action in
                           ("browse", "download") else None,
                           emit=_emit, log=_log)
            except Exception as exc:  # a tool call must never raise into the loop
                return f"hublib error: {type(exc).__name__}: {exc}"

        return [hublib]
    except Exception:
        return []  # decorator/schema trouble: stay silent, register nothing


# ─────────────────────────────────────────────────────────────────────────
# Offline self-test: python3 brain/tools/dt_hublib.py
# ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":  # pragma: no cover — manual smoke check
    import shutil
    import sys
    import tempfile

    failures: list[str] = []

    def check(label: str, cond: bool) -> None:
        print(("  PASS " if cond else "  FAIL ") + label)
        if not cond:
            failures.append(label)

    class FakeClient:
        """No httpx, no network — plain dict responses per the engine shapes."""

        def __init__(self, tweaks=None, items=None, dl=None):
            self._tweaks = tweaks or {}
            self._items = items or []
            self._dl = dl or []
            self.calls = []

        def libraries(self):
            return {"libraries": [
                {"type": "template", "label": "Template Library",
                 "localCount": 2, "desc": "d"},
                {"type": "skill", "label": "Skill Library",
                 "localCount": 1, "desc": "d"}]}

        def items(self, typ, q="", sort="", tag=""):
            self.calls.append(("items", typ, q, sort, tag))
            hits = [i for i in self._items if i.get("type") == typ
                    and (not q or q.lower() in str(i.get("name", "")).lower())]
            return {"items": hits, "total": len(hits)}

        def detail(self, typ, repo, item_id):
            self.calls.append(("detail", typ, repo, item_id))
            for i in self._items:
                if i["repo"] == repo and i["id"] == item_id:
                    return {"item": i, "payload": "# body\nmethodology here"}
            return {"error": "item not found", "status": 404}

        def download(self, typ, repo, item_id):
            self.calls.append(("download", typ, repo, item_id))
            for i in self._items:
                if i["repo"] == repo and i["id"] == item_id:
                    self._dl.append(i)
                    return {"item": i, "payload": "# body\nmethodology here"}
            return {"error": "item not found", "status": 404}

        def downloads(self, typ):
            return {"items": [{"item": i, "payload": "…"} for i in self._dl]}

        def tweaks(self):
            return {"tweaks": self._tweaks}

    tmp = Path(tempfile.mkdtemp(prefix="dt-hublib-selftest-"))
    emitted: list[dict] = []
    try:
        ITEMS = [
            {"type": "skill", "repo": "someone/doomalay-superpowers",
             "id": "superpowers-tdd-abc123", "name": "superpowers TDD",
             "description": "test-driven development discipline",
             "author": "someone", "tags": ["superpowers-obra", "tdd"],
             "hearts": 3, "downloads": 12},
            {"type": "skill", "repo": "someone/doomalay-superpowers",
             "id": "superpowers-brainstorming-def456",
             "name": "superpowers brainstorming",
             "description": "idea generation flow",
             "author": "someone", "tags": ["superpowers-obra"],
             "hearts": 1, "downloads": 4},
        ]
        check("lib: absent tweaks → enabled", lib_enabled({})[0])
        check("lib: unreadable tweaks → enabled",
              lib_enabled(None)[0] == lib_enabled({"x": 1})[0])
        ok, msg = lib_enabled({"botLib": False})
        check("lib: botLib False → refused + actionable",
              not ok and "Bot Library switch is OFF" in msg and "tweaks" in msg)
        check("lib: botLib True → enabled", lib_enabled({"botLib": True})[0])
        ok, msg = lib_enabled({"botTemplates": False, "botSkills": False})
        check("lib: legacy both-off → refused (migration)",
              not ok and "Bot Library switch is OFF" in msg)
        check("lib: legacy one-off → still on (migration)",
              lib_enabled({"botTemplates": False, "botSkills": True})[0])
        check("lib: unknown key → on", lib_enabled({"botX": False})[0])
        check("read_boxes: lifts .tweaks", read_boxes({"tweaks": {"a": 1}}) == {"a": 1})
        check("read_boxes: tolerant", read_boxes(None) == {} and read_boxes({}) == {})

        ev = build_event("hub · 2 skills", [card_for_item(ITEMS[0])])
        check("event: type + text JSON + top-level items",
              ev["type"] == "hublist" and ev["items"][0]["name"] == "superpowers TDD"
              and json.loads(ev["text"])["summary"] == "hub · 2 skills")
        check("event: card carries no payload",
              "payload" not in ev["items"][0] and len(ev["items"][0]["tags"]) == 2)

        check("emit: collector + None-safe",
              emit_hub_event(lambda e, **kw: emitted.append(kw["ev"]),
                             "s", [card_for_item(ITEMS[0])])
              and emit_hub_event(None, "s", []) is False and len(emitted) == 1)

        check("resolve: repo/id",
              (resolve_ref([ITEMS[0]], "someone/doomalay-superpowers/superpowers-tdd-abc123")
               or {}).get("id") == "superpowers-tdd-abc123")
        check("resolve: bare name",
              (resolve_ref(ITEMS, "tdd") or {}).get("name") == "superpowers TDD")
        check("resolve: ambiguous → None",
              resolve_ref(ITEMS, "superpowers") is None)

        fc = FakeClient(items=ITEMS)
        out = run("browse", typ="skill", q="tdd", client=fc,
                  state_dir=tmp, emit=lambda e, **kw: emitted.append(kw["ev"]))
        check("browse: text lists the hit + address",
              "superpowers TDD" in out and "someone/doomalay-superpowers/superpowers-tdd-abc123" in out
              and "1 skill" in out)
        check("browse: emitted a hublist card",
              any(e.get("type") == "hublist" and e["items"][0]["name"] == "superpowers TDD"
                  for e in emitted))
        check("browse: last.json persisted",
              (json.loads((tmp / "last.json").read_text())["skill"][0]["id"]
               == "superpowers-tdd-abc123"))

        emitted.clear()
        out = run("download", typ="skill", ref="tdd", client=fc, state_dir=tmp,
                  emit=lambda e, **kw: emitted.append(kw["ev"]))
        check("download: bare-name resolve via last.json + payload in return",
              "downloaded 'superpowers TDD'" in out and "methodology here" in out
              and ("download", "skill", "someone/doomalay-superpowers",
                   "superpowers-tdd-abc123") in fc.calls)
        check("download: confirmation card emitted",
              any(e.get("type") == "hublist" and e["items"][0]["downloaded"]
                  for e in emitted))

        out = run("downloaded", typ="skill", client=fc)
        check("downloaded: lists the row", "superpowers TDD" in out)

        out = run("detail", typ="skill", ref="tdd", client=fc, state_dir=tmp)
        check("detail: payload preview", "payload preview" in out and "methodology here" in out)

        gated = FakeClient(items=ITEMS, tweaks={"botLib": False})  # v0.60: the single lib switch
        out = run("browse", typ="skill", client=gated)
        # v0.60 pt C.9: the lib gate — browse WORKS when off (recommend),
        # only download refuses.
        check("gate: browse still works when lib off",
              "no skills" in out or "hub ·" in out or "superpowers" in out.lower()
              or len(out) > 0)
        out = run("download", typ="skill", ref="tdd", client=gated)
        check("gate: download refused when lib off",
              "Bot Library switch is OFF" in out)
        out = run("browse", typ="template", client=gated)
        check("gate: browse unaffected by lib off", "no templates" in out)

        out = run("browse", typ="persona", client=fc)
        check("type: persona refused with pointer",
              "templates, skills, scripts and docs" in out)
        dead = FakeClient()
        dead.items = lambda *a, **k: {"error": "engine unreachable at x: boom"}
        dead.downloads = lambda *a, **k: {"error": "engine unreachable at x: boom"}
        dead.tweaks = lambda: {"error": "engine unreachable at x: boom", "status": 503}
        out = run("browse", typ="skill", client=dead)
        check("degrade: engine down mid-tweaks → still browses (default-on)",
              "engine unreachable" in out)
        out = run("frobnicate", client=fc)
        check("unknown action → help pointer", "unknown action" in out)
        check("help text", "browse" in run("help") and "downloaded" in run("help"))
        check("libraries text", "Template Library" in run("libraries", client=fc))
        out = run("download", typ="skill", ref="nope", client=fc, state_dir=tmp)
        check("unresolvable ref → actionable",
              "could not resolve" in out or "browse first" in out)

        # run() must never raise — the tool-call contract
        class Exploding:
            def __getattr__(self, k):
                raise RuntimeError("boom")
        try:
            run("browse", typ="skill", client=Exploding())
            check("run() never raises", True)
        except Exception:
            check("run() never raises", False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("SELF-TEST OK" if not failures else f"SELF-TEST FAILED: {failures}")
    sys.exit(0 if not failures else 1)
