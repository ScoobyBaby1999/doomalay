"""dt_skills.py — programmatic skills browser/loader (the `skills` tool).

doomalay ships a methodology library in brain/agent_skills/ (agentskills.io
layout: <name>/SKILL.md with flat name+description frontmatter) — fifteen
superpowers-* skills ported from obra/superpowers plus the pre-existing
conscious and workspace-artifacts skills. The session bootstrap injects only
the one-line index (progressive disclosure — descriptions are trigger-only by
design); THIS tool is the runtime half of that bargain: the model can discover
and load a full methodology mid-conversation, exactly when a task turns out
to need one, without anyone re-writing the system prompt.

Actions (see HELP_TEXT): list / search / read / load / files / loaded / help.
`load` is the key action — it wraps the full SKILL.md body in a
"SKILL LOADED — follow this methodology now" envelope AND appends a line to
workspace/.doomalay/skills_loaded.jsonl so session memory knows which
methodologies this workspace has actually ingested (the log deliberately
lives at the ctx.state_dir() ROOT, not tool_state("skills")/: it is
workspace-level memory, shared with anything else that asks "what has this
workspace loaded", per the S6 contract).

Frontmatter parsing reuses the yaml-free approach proven in
superpowers_bootstrap.build_skills_index (flat key:value + wrapped
continuation lines) — duplicated rather than imported so this tool stays one
self-contained file (dt_spec rule 4: one tool = one file, no cross-imports
into the bootstrap seam).
"""
from __future__ import annotations

import difflib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

TOOL_NAMES = ["skills"]  # primary (only) tool name built below

# Output caps. `read` is browsing (8000 chars + where-to-find note, per the
# S6 spec); `load` is injection — its whole purpose is the FULL body in the
# conversation envelope, so it gets a deliberately generous cap that fits the
# largest real skill (superpowers-subagent-driven-development, 32,785 chars)
# with headroom. Both caps end with a pointer to the on-disk file so nothing
# is silently lost.
READ_MAX = 8000
LOAD_MAX = 40000
SEARCH_TOP = 8            # ranked hits shown for action="search"
SUGGEST_N = 5             # nearest names when resolution finds nothing
MAX_SUPPORT_FILES = 50    # pathological skill dirs can't flood the context

LOADED_LOG_NAME = "skills_loaded.jsonl"
DEFAULT_SKILLS_DIR = Path(__file__).resolve().parent.parent / "agent_skills"

# ---------------------------------------------------------------------------
# Frontmatter parsing (yaml-free, stdlib-only)
# ---------------------------------------------------------------------------

# A SKILL.md frontmatter block is a fenced `---` ... `---` region of flat
# `key: value` lines (name + description, per the agentskills.io spec the
# ported skills follow). Full YAML would pull PyYAML into the Android build
# for two fields, so we parse the flat subset: quoted or bare single-line
# values, plus indented continuation lines for wrapped descriptions. The
# closing fence may end the file (some editors drop the trailing newline).
_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
_KEY_VALUE_RE = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")


def parse_frontmatter(text: str) -> dict[str, str]:
    """Parse the leading ``---`` frontmatter block of a SKILL.md.

    Returns {} when the text has no frontmatter fence. Only the flat
    ``key: value`` subset is supported (deliberate — see module docstring);
    unknown shapes degrade to whatever keys did parse, never an exception,
    because a malformed skill file must never take the agent down.
    """
    m = _FRONTMATTER_RE.match(text or "")
    if not m:
        return {}
    fields: dict[str, str] = {}
    current_key: str | None = None
    for line in m.group(1).splitlines():
        if not line.strip():  # blank line ends any wrapped value
            current_key = None
            continue
        km = _KEY_VALUE_RE.match(line)
        if km:
            current_key = km.group(1)
            fields[current_key] = _strip_quotes(km.group(2))
        elif line.startswith((" ", "\t")) and current_key:
            # continuation of a wrapped value (indented follow-on line)
            fields[current_key] = (fields.get(current_key, "") + " " + line.strip()).strip()
        # a non-indented, non-key line is junk inside the fence: ignored
    return fields


def _strip_quotes(value: str) -> str:
    """Strip one matching pair of surrounding single/double quotes."""
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v


# ---------------------------------------------------------------------------
# Indexing (with a cheap mtime-signature cache)
# ---------------------------------------------------------------------------

# The tool dispatches several actions per turn (list -> search -> load), and
# every action needs the index. Re-reading + re-parsing 17 files each call is
# pure waste, so index_skills caches per directory keyed by a change
# signature: (path, mtime_ns, size) of every <dir>/SKILL.md. One glob + N
# stats per call — and still correct the instant a skill is added, edited,
# or removed. (mtime alone can lie on coarse filesystems; +size makes the
# test-visible invalidation deterministic.)
_INDEX_CACHE: dict[str, tuple[tuple, dict]] = {}
_BODY_CACHE: dict[str, tuple[int, int, str]] = {}


def _dir_signature(root: Path) -> tuple:
    """Cheap change-detector for the index cache (see _INDEX_CACHE note)."""
    items: list[tuple] = []
    try:
        for p in sorted(root.glob("*/SKILL.md")):
            try:
                st = p.stat()
                items.append((str(p), st.st_mtime_ns, st.st_size))
            except OSError:
                items.append((str(p), -1, -1))
    except OSError:  # missing/unreadable dir -> empty signature, empty index
        return tuple()
    return tuple(items)


def index_skills(skills_dir: str | Path) -> dict:
    """Scan a skills directory and build the loader index.

    ``skills_dir`` layout: ``<skills_dir>/<skill-name>/SKILL.md``. Returns::

        {"root": str, "entries": [...], "skipped": [{"dir", "reason"}]}

    Each entry: ``name`` (must equal its directory name — the loader
    invariant shared with superpowers_bootstrap; a mismatch is SKIPPED with
    a reason rather than indexed, because two identifiers for one skill
    breaks every downstream resolve/log), ``description`` (trigger-only,
    passed through verbatim — see the SDO note in superpowers_bootstrap),
    ``location`` (SKILL.md path), ``dir`` (skill directory path).

    Dirs with unreadable files, no ``---`` fence, or no ``name`` key land in
    ``skipped`` — never an exception: one broken skill must not blind the
    model to the other sixteen.
    """
    root = Path(skills_dir)
    key = str(root)
    sig = _dir_signature(root)
    cached = _INDEX_CACHE.get(key)
    if cached is not None and cached[0] == sig:
        return cached[1]  # unchanged tree: reuse the parsed index object

    entries: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    if root.is_dir():
        for skill_md in sorted(root.glob("*/SKILL.md")):
            dirname = skill_md.parent.name
            try:
                text = skill_md.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                skipped.append({"dir": dirname, "reason": f"unreadable: {type(exc).__name__}"})
                continue
            fields = parse_frontmatter(text)
            name = (fields.get("name") or "").strip()
            if not name:
                skipped.append({"dir": dirname,
                                "reason": "no usable frontmatter (missing --- fence or name key)"})
                continue
            if name != dirname:
                # Frontmatter name must match its directory (loader
                # invariant); skip rather than guess which identifier the
                # skills tool should resolve against.
                skipped.append({"dir": dirname,
                                "reason": f"frontmatter name {name!r} != directory name (loader invariant)"})
                continue
            entries.append({
                "name": name,
                "description": (fields.get("description") or "").strip(),
                "location": str(skill_md),
                "dir": str(skill_md.parent),
            })
    index = {"root": str(root), "entries": entries, "skipped": skipped}
    _INDEX_CACHE[key] = (sig, index)
    return index


def _reset_index_cache() -> None:
    """Test hook: drop the index + body caches (tests mutate temp trees)."""
    _INDEX_CACHE.clear()
    _BODY_CACHE.clear()


def _entries(index: Any) -> list[dict]:
    """Normalize an index (dict from index_skills OR a bare entry list)."""
    if isinstance(index, dict):
        return index.get("entries") or []
    if isinstance(index, list):
        return index
    return []


def _read_body(path_str: str) -> str:
    """Read a SKILL.md body for search, cached by (mtime_ns, size).

    Search scans FULL bodies (names+descriptions alone miss every
    methodology whose trigger line doesn't name the concept — "tdd" lives in
    the body, not in "Use when writing tests..."). 17 bodies ≈ 560 KB; the
    cache keeps repeated searches from re-reading them. OSError -> "" (the
    entry still scores on name+description; a vanished file must not kill
    the whole search).
    """
    if not path_str:
        return ""
    p = Path(path_str)
    try:
        st = p.stat()
        sig = (st.st_mtime_ns, st.st_size)
    except OSError:
        return ""
    hit = _BODY_CACHE.get(path_str)
    if hit is not None and (hit[0], hit[1]) == sig:
        return hit[2]
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    _BODY_CACHE[path_str] = (sig[0], sig[1], text)
    return text


# ---------------------------------------------------------------------------
# Search (plain scoring: name 3 / description 2 / body 1)
# ---------------------------------------------------------------------------

def search_index(index: Any, query: str, top: int = SEARCH_TOP) -> list[dict]:
    """Keyword-scan names, descriptions AND full bodies; rank by score.

    Terms are lowercased word chunks (letters/digits/-/_), deduped, len>=2
    (single chars are noise that floods every body match). Each term
    contributes its field weight ONCE per skill (substring containment,
    case-insensitive): name +3, description +2, body +1. Returns ALL hits
    sorted by (-score, name); the formatter shows the top ``top``.

    Returns [{"name", "description", "score", "reasons": [field:term +w]}]
    — reasons are per-term so the model can SEE why a skill ranked.
    """
    entries = _entries(index)
    terms = list(dict.fromkeys(
        t for t in re.findall(r"[a-z0-9_-]+", (query or "").lower()) if len(t) >= 2))
    if not terms:
        return []
    results: list[dict[str, Any]] = []
    for e in entries:
        name_l = (e.get("name") or "").lower()
        desc_l = (e.get("description") or "").lower()
        body_l = _read_body(e.get("location") or "").lower()
        score = 0
        reasons: list[str] = []
        for term in terms:
            if term in name_l:
                score += 3
                reasons.append(f"name:{term} +3")
            if term in desc_l:
                score += 2
                reasons.append(f"description:{term} +2")
            if body_l and term in body_l:
                score += 1
                reasons.append(f"body:{term} +1")
        if score > 0:
            results.append({"name": e.get("name") or "", "description": e.get("description") or "",
                            "score": score, "reasons": reasons})
    results.sort(key=lambda r: (-r["score"], r["name"]))
    return results


# ---------------------------------------------------------------------------
# Skill-name resolution (exact > prefix > substring; fuzzy suggestions)
# ---------------------------------------------------------------------------

def _suggest(q: str, names: list[str], n: int = SUGGEST_N) -> list[str]:
    """Nearest skill names for a typo'd / unknown query (stdlib difflib).

    get_close_matches handles the common typo; when NOTHING clears the
    0.3 cutoff we still show the top-N by ratio — an empty suggestion list
    teaches the model the tool is useless, and it stops calling (same
    reasoning as the bootstrap's degrade-to-hint rule).
    """
    if not names:
        return []
    close = difflib.get_close_matches(q, names, n=n, cutoff=0.3)
    if close:
        return close
    ranked = sorted(names, key=lambda nm: -difflib.SequenceMatcher(None, q, nm).ratio())
    return ranked[:n]


def resolve_skill(index: Any, query: str) -> dict:
    """Resolve a user/model-supplied skill name to one index entry.

    Accepts the name with or without the ``superpowers-`` prefix (the model
    says "brainstorming", the disk says "superpowers-brainstorming" — make
    both work, both directions). Order: exact match > unique prefix match >
    unique substring match; multiple hits -> "ambiguous" WITH the candidate
    entries (the model picks); zero hits -> "none" with nearest-5 name
    suggestions. Returns one of::

        {"status": "ok",        "skill": entry, "resolved_as": name}
        {"status": "ambiguous", "candidates": [entry, ...], "tried": q}
        {"status": "none",      "suggestions": [name, ...], "tried": q}
    """
    entries = _entries(index)
    q = (query or "").strip().lower()
    if not q:
        return {"status": "none", "suggestions": [], "tried": q}
    by_name: dict[str, dict] = {}
    for e in entries:
        nm = (e.get("name") or "").lower()
        if nm:
            by_name[nm] = e
    # prefix-symmetric spelling: "brainstorming" == "superpowers-brainstorming"
    variants = [q]
    if q.startswith("superpowers-"):
        stripped = q[len("superpowers-"):]
        if stripped:
            variants.append(stripped)
    else:
        variants.append("superpowers-" + q)
    variants = list(dict.fromkeys(variants))

    for v in variants:  # 1. exact
        if v in by_name:
            return {"status": "ok", "skill": by_name[v], "resolved_as": by_name[v].get("name", v)}
    prefix = {nm: e for v in variants for nm, e in by_name.items() if nm.startswith(v)}
    if len(prefix) == 1:  # 2. unique prefix
        e = next(iter(prefix.values()))
        return {"status": "ok", "skill": e, "resolved_as": e.get("name", "")}
    if len(prefix) > 1:  # e.g. "superpowers" -> all 15: let the model choose
        return {"status": "ambiguous",
                "candidates": sorted(prefix.values(), key=lambda e: e.get("name") or ""),
                "tried": q}
    subs = {nm: e for v in variants for nm, e in by_name.items() if v in nm}
    if len(subs) == 1:  # 3. unique substring
        e = next(iter(subs.values()))
        return {"status": "ok", "skill": e, "resolved_as": e.get("name", "")}
    if len(subs) > 1:
        return {"status": "ambiguous",
                "candidates": sorted(subs.values(), key=lambda e: e.get("name") or ""),
                "tried": q}
    return {"status": "none", "suggestions": _suggest(q, sorted(by_name)), "tried": q}


def read_target(index: Any, ref: str) -> dict:
    """Resolve a `read` reference: a skill name OR ``<skill>/<relpath>``.

    Supporting files (sub-agent prompt templates etc.) are read by relative
    path so the model can pull exactly the piece a skill tells it to use.
    The relative path is model-supplied free text: backslashes, absolute
    paths, empty and ``..`` segments are rejected, and the joined path is
    re-verified to resolve inside the skill dir — a path-traversal here
    would turn a "methodology browser" into a filesystem reader.
    """
    ref = (ref or "").strip()
    if not ref:
        return {"status": "none", "suggestions": [], "tried": "",
                "message": 'skills read: pass skill= (a skill name, or "<skill>/<relative-path>")'}
    if "/" in ref:
        skill_part, _, rel = ref.partition("/")
        res = resolve_skill(index, skill_part)
        if res["status"] != "ok":
            return res  # ambiguous/none for the skill part: surface as-is
        entry = res["skill"]
        rel = rel.strip().strip("/")
        parts = rel.split("/") if rel else []
        if not rel or "\\" in rel or any(p in ("", "..") for p in parts):
            return {"status": "error",
                    "message": f"skills read: bad relative path {rel!r} (must be a plain path inside the skill dir; no ..)"}
        target = Path(entry["dir"]) / rel
        try:
            inside = target.resolve().is_relative_to(Path(entry["dir"]).resolve())
        except OSError:
            inside = False
        if not inside:
            return {"status": "error",
                    "message": f"skills read: path escapes the skill dir: {rel!r}"}
        if not target.is_file():
            return {"status": "error",
                    "message": (f"skills read: no file {rel!r} in {entry['name']}/ — "
                                f'action="files", skill="{entry["name"]}" lists what exists')}
        return {"status": "ok", "kind": "file", "label": f"{entry['name']}/{rel}",
                "path": str(target), "entry": entry}
    res = resolve_skill(index, ref)
    if res["status"] != "ok":
        return res
    entry = res["skill"]
    return {"status": "ok", "kind": "skill", "label": entry.get("name") or ref,
            "path": entry.get("location") or str(Path(entry.get("dir", "")) / "SKILL.md"),
            "entry": entry}


# ---------------------------------------------------------------------------
# Supporting files
# ---------------------------------------------------------------------------

def support_files(entry: dict) -> list[dict]:
    """List non-SKILL.md files in a skill dir: path, size, first line.

    Recursive (some skills nest prompt templates), hidden entries skipped
    (.DS_Store noise), capped at MAX_SUPPORT_FILES. First line is read from
    the first 4 KB only — a first line that is a 2 MB minified blob must
    not become the tool result.
    """
    d = Path(entry.get("dir") or "")
    out: list[dict[str, Any]] = []
    if not d.is_dir():
        return out
    try:
        paths = [p for p in sorted(d.rglob("*"))
                 if p.is_file() and p.name != "SKILL.md"
                 and not any(part.startswith(".") for part in p.relative_to(d).parts)]
    except OSError:
        return out
    for p in paths[:MAX_SUPPORT_FILES]:
        rel = p.relative_to(d).as_posix()
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        out.append({"path": rel, "size": size, "first_line": _first_line(p)})
    return out


def _first_line(p: Path) -> str:
    """First non-blank line of a file (≤90 chars), '-' if unreadable."""
    try:
        with p.open("rb") as f:
            head = f.read(4096).decode("utf-8", "replace")
    except OSError:
        return "-"
    for line in head.splitlines():
        s = line.strip()
        if s:
            return s[:90]
    return "-"


# ---------------------------------------------------------------------------
# Load-history log (workspace-level memory)
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_loaded(state_dir: str | Path, skill: str, when: str | None = None) -> dict:
    """Append {skill, when} to <state_dir>/skills_loaded.jsonl; return it.

    Single small line written with O_APPEND: one write() call, so a kill
    mid-write can at worst truncate the LAST line (which read_loaded skips)
    — the append-only log never needs the tmp+rename dance of a JSON state
    file, and partial lines can't corrupt earlier entries.
    """
    when = when or _now()
    line = {"skill": skill, "when": when}
    p = Path(state_dir) / LOADED_LOG_NAME
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(line) + "\n")
    return line


def read_loaded(state_dir: str | Path) -> list[dict]:
    """Parse the load log; malformed lines are skipped, never fatal."""
    p = Path(state_dir) / LOADED_LOG_NAME
    if not p.is_file():
        return []
    out: list[dict] = []
    try:
        raw = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue  # truncated tail line from a mid-write kill: drop it
    return out


# ---------------------------------------------------------------------------
# Formatting (plain string builders — unit-testable without any ctx)
# ---------------------------------------------------------------------------

def _clip(text: str, limit: int) -> str:
    """One-line, whitespace-collapsed, hard-clipped description fragment.

    Index rows must stay one line each: a wrapped description would blow the
    17-row index from ~20 lines to 60+ and bury the names.
    """
    s = " ".join((text or "").split())
    if not s:
        return "(no description)"
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def format_list(index: Any, name_filter: str = "") -> str:
    """Grouped index: superpowers-* first (name + one-line description),
    then other skills; counts; the hint that `load` injects the full skill
    (the index is one-liners by design — progressive disclosure)."""
    entries = _entries(index)
    flt = (name_filter or "").strip().lower()
    shown = [e for e in entries if flt in (e.get("name") or "").lower()] if flt else entries
    sp = sorted((e for e in shown if (e.get("name") or "").startswith("superpowers-")),
                key=lambda e: e.get("name") or "")
    others = sorted((e for e in shown if not (e.get("name") or "").startswith("superpowers-")),
                    key=lambda e: e.get("name") or "")
    n_sp_total = sum(1 for e in entries if (e.get("name") or "").startswith("superpowers-"))

    lines = [f"SKILLS — {len(entries)} available "
             f"({n_sp_total} superpowers-* methodology + {len(entries) - n_sp_total} other) "
             f"at {index.get('root', '') if isinstance(index, dict) else ''}"]
    if flt:
        lines.append(f"(filtered by {name_filter!r}: {len(shown)} of {len(entries)} shown)")
    lines.append("")
    if sp:
        lines.append(f"superpowers methodology skills ({len(sp)}):")
        for e in sp:
            lines.append(f"  {e['name']} — {_clip(e.get('description') or '', 140)}")
        lines.append("")
    if others:
        lines.append(f"other skills ({len(others)}):")
        for e in others:
            lines.append(f"  {e['name']} — {_clip(e.get('description') or '', 140)}")
        lines.append("")
    skipped = index.get("skipped") if isinstance(index, dict) else None
    if skipped:
        # Surfaced (not hidden): ops needs to see WHY a dir didn't index.
        lines.append(f"skipped ({len(skipped)} — bad frontmatter / loader invariant):")
        for s in skipped:
            lines.append(f"  {s['dir']}: {s['reason']}")
        lines.append("")
    if not shown:
        lines.append(f"no skills match filter {name_filter!r} — drop it to see all {len(entries)}.")
        lines.append("")
    lines.append('action="load", skill="<name>" injects the FULL skill methodology into the')
    lines.append('conversation — this index is one-liners only. action="search", query="..."')
    lines.append('scans full skill bodies; action="files", skill="<name>" lists supporting files.')
    return "\n".join(lines)


def format_search(query: str, results: list[dict], top: int = SEARCH_TOP) -> str:
    """Top-N ranked hits with match reasons (why each skill ranked)."""
    if not results:
        return (f'skills search: no match for {query!r} in names, descriptions or bodies.\n'
                f'Try fewer/different terms, or action="list" to browse the index.')
    shown = results[:top]
    lines = [f"SKILL SEARCH {query!r} — {len(results)} match(es), top {len(shown)} by score",
             "score: name match +3, description +2, body +1 (per search term)", ""]
    for i, r in enumerate(shown, 1):
        lines.append(f"{i}. {r['name']}  (score {r['score']})")
        lines.append(f"   {_clip(r.get('description') or '', 120)}")
        if r.get("reasons"):
            lines.append(f"   matches: {', '.join(r['reasons'][:8])}")
    lines.append("")
    lines.append('action="read", skill="<name>" for the full SKILL.md (8000-char cap);')
    lines.append('action="load", skill="<name>" to inject it as the methodology to follow.')
    return "\n".join(lines)


def format_read(tgt: dict, text: str) -> str:
    """A read result: header + body, hard-capped at READ_MAX with a
    where-to-find note (nothing is silently lost — the model always knows
    the full file's path and that `load` injects all of it)."""
    n = len(text)
    is_skill = tgt.get("kind") == "skill"
    if is_skill:
        header = f"=== SKILL: {tgt['label']} ==="
        footer = (f'action="load", skill="{tgt["entry"].get("name")}" wraps this in the '
                  'follow-it-now envelope and logs the load.')
    else:
        header = f"=== FILE: {tgt['label']} ==="
        footer = ""
    if n > READ_MAX:
        body = text[:READ_MAX]
        note = (f"[…truncated at {READ_MAX}/{n} chars — full file: {tgt['path']};"
                + (' action="load" injects the whole methodology]' if is_skill else "]"))
    else:
        body = text
        note = f"[{n} chars — {tgt['path']}]"
    parts = [header, body, note]
    if footer:
        parts.append(footer)
    return "\n".join(parts)


def build_load_envelope(entry: dict, body: str, files: list[dict], log_note: str) -> str:
    """THE load envelope: full SKILL.md wrapped in an unambiguous mandate.

    Why an envelope at all: returning the bare body reads as "reference
    material you may consult"; the envelope reframes it as "the methodology
    you are now following" — announce it, follow every phase/checklist/gate,
    don't summarize. That framing is the difference between a skill being
    loaded and a skill being USED (the SDO failure mode: models follow the
    gist and skip the body). Supporting files are listed for `read`-ing by
    relative path so the skill can hand the model its own prompt templates.
    """
    name = entry.get("name") or "?"
    n = len(body)
    if n > LOAD_MAX:
        shown = body[:LOAD_MAX]
        trunc = f"\n[…skill body truncated at {LOAD_MAX}/{n} chars — full file: {entry.get('location')}]"
    else:
        shown = body
        trunc = ""
    lines = [
        f"=== SKILL LOADED: {name} ===",
        "",
        "SKILL LOADED — follow this methodology now.",
        f'Announce "Using {name} to <purpose>", then follow the skill below',
        "exactly — every phase, checklist item, and gate. Do not summarize it",
        "or skip steps: a skill's value is the full methodology, not its gist.",
        "",
        f"---8<--- SKILL.md: {name} ({n} chars) ---8<---",
        shown + trunc,
        "---8<--- end SKILL.md ---8<---",
        "",
    ]
    if files:
        lines.append(f'Supporting files in {name}/ (read with action="read", skill="{name}/<path>"):')
        for f in files:
            lines.append(f"  - {f['path']} ({f['size']} bytes) — {_clip(f.get('first_line') or '', 80)}")
    else:
        lines.append(f"{name}/ has no supporting files (SKILL.md only).")
    lines.append("")
    if log_note:
        lines.append(log_note)
    return "\n".join(lines)


def format_files(entry: dict, files: list[dict]) -> str:
    """Supporting-file listing: relative path, size, first line."""
    name = entry.get("name") or "?"
    if not files:
        return (f"skills files: {name}/ has no supporting files — the methodology is all in "
                f'SKILL.md (action="read"/"load", skill="{name}").')
    lines = [f"SUPPORTING FILES — {name}/ ({len(files)}):", ""]
    for f in files:
        lines.append(f"  {f['path']}  ({f['size']} B)  | {f.get('first_line', '-')}")
    lines.append("")
    lines.append(f'read one: action="read", skill="{name}/<path>" — '
                 f'e.g. skill="{name}/{files[0]["path"]}"')
    return "\n".join(lines)


def format_loaded(records: list[dict]) -> str:
    """Load history for this workspace (what + when)."""
    if not records:
        return ('skills loaded: nothing loaded in this workspace yet — '
                'action="load", skill="<name>" records every methodology you inject.')
    lines = [f"SKILLS LOADED in this workspace ({len(records)}):", ""]
    for i, r in enumerate(records, 1):
        lines.append(f"  {i}. {r.get('skill', '?')} — {r.get('when', '?')}")
    lines.append("")
    lines.append(f"(append-only log: <state_dir>/{LOADED_LOG_NAME} — "
                 "re-load a skill to refresh it in context)")
    return "\n".join(lines)


def _format_resolve_failure(res: dict, ref: str) -> str:
    """Render an ambiguous/none/error resolution as a model-facing string."""
    if res.get("message"):
        return res["message"]
    if res.get("status") == "ambiguous":
        cands = res.get("candidates") or []
        lines = [f"skills: {ref!r} is ambiguous — {len(cands)} candidates:"]
        for e in cands[:12]:
            lines.append(f"  - {e.get('name')} — {_clip(e.get('description') or '', 100)}")
        lines.append("Use the full name or a longer prefix.")
        return "\n".join(lines)
    sug = res.get("suggestions") or []
    if sug:
        return (f"skills: no skill matches {ref!r}.\n"
                f"Nearest: {', '.join(sug)}\n"
                f'Or action="search", query="{ref}" to scan skill bodies.')
    return (f"skills: no skill matches {ref!r} and nothing is close. "
            f'action="list" to browse, action="search" to scan bodies.')


HELP_TEXT = """skills — browse + load methodology skills (superpowers-* and friends)

actions:
  list    [filter=<name-substr>]  grouped index (superpowers first) + counts
                                   + skipped-dir diagnostics
  search  query=<terms>           keyword scan: names(+3) descriptions(+2)
                                   full bodies(+1), top 8 with match reasons
  read    skill=<name>            full SKILL.md (8000-char cap + where-to-find)
          skill=<name>/<relpath>  a supporting file from the skill dir
  load    skill=<name>            THE KEY ACTION: injects the full SKILL.md
                                   wrapped in a "SKILL LOADED — follow this
                                   methodology now" envelope AND logs it to
                                   workspace memory (skills_loaded.jsonl)
  files   skill=<name>            supporting files: path, size, first line
  loaded                          what this workspace has loaded + when
  help                            this sheet

skill-name resolution: exact > prefix > substring, with or without the
"superpowers-" prefix ("brainstorming" == "superpowers-brainstorming").
Ambiguous -> candidate list; unknown -> nearest 5 suggestions.

state: append-only <workspace>/.doomalay/skills_loaded.jsonl (workspace-level
memory — every load is recorded with an ISO-8601 UTC timestamp)."""

TOOL_DESCRIPTION = (
    "Browse and inject the workspace's methodology skills (17 dirs: 15 "
    "superpowers-* ported from obra/superpowers, plus conscious and "
    "workspace-artifacts). Use it BEFORE any task that might match a skill "
    "and mid-conversation whenever a methodology becomes relevant. Actions: "
    "'list' (grouped index), 'search' (query; scans names, descriptions and "
    "full bodies with match reasons), 'read' (skill or skill/relative-path; "
    "full text with an 8000-char cap), 'load' (THE key action — injects the "
    "full SKILL.md as the methodology to follow NOW and records it in "
    "workspace memory), 'files' (a skill's supporting files), 'loaded' (this "
    "workspace's load history), 'help'. Skill names resolve fuzzily, with or "
    "without the 'superpowers-' prefix."
)


# ---------------------------------------------------------------------------
# Plain action dispatcher (no ctx, no strands — fully unit-testable)
# ---------------------------------------------------------------------------

def run(action: str, skill: str = "", query: str = "", name_filter: str = "",
        skills_dir: str | Path | None = None, state_dir: str | Path | None = None,
        on_loaded: Callable[[str], None] | None = None) -> str:
    """Run one `skills` action and return the model-facing string.

    This is the whole tool minus the strands decorator: tests (and the
    self-test) drive actions through here. ``skills_dir`` defaults to the
    real brain/agent_skills next to this file; ``state_dir`` is where the
    load log lives (None -> loads still work, just unlogged); ``on_loaded``
    fires (skill-name) after a successful logged load — the strands wrapper
    uses it for ctx.log("skill_loaded") without giving this core a ctx.
    """
    action = (action or "").strip().lower() or "help"
    root = Path(skills_dir) if skills_dir is not None else DEFAULT_SKILLS_DIR
    try:
        index = index_skills(root)
    except Exception as exc:  # index_skills is total; this is belt+braces
        return f"skills error: indexing {root} failed: {type(exc).__name__}: {exc}"
    entries = _entries(index)
    try:
        if action == "help":
            return HELP_TEXT
        if action == "loaded":  # works even with no skills on disk
            if state_dir is None:
                return ("skills loaded: no state dir wired (offline build) — loads are "
                        "not logged; the skill bodies above are still authoritative.")
            return format_loaded(read_loaded(state_dir))
        if not entries:
            return (f"skills: no skills indexed under {root} — expected "
                    f"<name>/SKILL.md subdirectories (superpowers-* + others). "
                    f"action='help' for the sheet.")
        if action == "list":
            return format_list(index, name_filter)
        if action == "search":
            if not (query or "").strip():
                return ('skills search: give query= — e.g. '
                        'action="search", query="debugging tests"')
            return format_search(query, search_index(index, query))
        if action == "read":
            return _action_read(index, skill)
        if action == "load":
            return _action_load(index, skill, state_dir, on_loaded)
        if action == "files":
            return _action_files(index, skill)
        return f"skills: unknown action {action!r} — action='help' lists them."
    except Exception as exc:  # degrade, don't crash (dt_spec rule 5)
        return f"skills error: {type(exc).__name__}: {exc}"


def _action_read(index: Any, ref: str) -> str:
    tgt = read_target(index, ref)
    if tgt.get("status") != "ok":
        return _format_resolve_failure(tgt, ref)
    path = Path(tgt["path"])
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"skills read: cannot read {path}: {type(exc).__name__}"
    return format_read(tgt, text)


def _action_load(index: Any, skill: str, state_dir: str | Path | None,
                 on_loaded: Callable[[str], None] | None) -> str:
    res = resolve_skill(index, skill)
    if res.get("status") != "ok":
        return _format_resolve_failure(res, skill)
    entry = res["skill"]
    when = _now()
    try:
        body = Path(entry["location"]).read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"skills load: cannot read {entry.get('location')}: {type(exc).__name__}"
    files = support_files(entry)
    if state_dir is not None:
        try:
            append_loaded(state_dir, entry["name"], when)
            log_note = (f"Loaded at {when} — logged to {Path(state_dir) / LOADED_LOG_NAME} "
                        f'(action="loaded" shows this workspace\'s history).')
        except OSError as exc:
            # Body delivered even when the log write fails: the envelope is
            # the point; the log is memory, and a failed memory write must
            # not fail the methodology injection.
            log_note = (f"Loaded at {when} — log write failed ({type(exc).__name__}); "
                        "the skill body above is still authoritative.")
    else:
        log_note = f"Loaded at {when} — not logged (no state dir wired)."
    if on_loaded is not None:
        try:
            on_loaded(entry["name"])
        except Exception:
            pass  # a status-callback failure never blocks the load result
    return build_load_envelope(entry, body, files, log_note)


def _action_files(index: Any, skill: str) -> str:
    res = resolve_skill(index, skill)
    if res.get("status") != "ok":
        return _format_resolve_failure(res, skill)
    return format_files(res["skill"], support_files(res["skill"]))


# ---------------------------------------------------------------------------
# Strands surface
# ---------------------------------------------------------------------------

def build(ctx) -> list:
    """Return the @tool-decorated `skills` callable built from ctx.

    Never raises (dt_spec rule 2): strands missing -> []; ctx missing
    skills_dir -> []. The state dir is resolved lazily PER CALL and only for
    load/loaded — casual list/search/read calls must not create workspace
    directories just because the model browsed the index.
    """
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []  # offline / SDK missing: register nothing, stay importable
    try:
        skills_root = Path(ctx.skills_dir)
    except Exception:
        return []

    def _state_dir():
        try:
            return ctx.state_dir()
        except Exception:
            return None

    try:
        @strands_tool_decorator(name="skills", description=TOOL_DESCRIPTION)
        def skills(action: str, skill: str = "", query: str = "", filter: str = "") -> str:
            """Browse and load the workspace's methodology skills.

            Args:
                action: one of list | search | read | load | files | loaded | help.
                skill: skill name for read/load/files; for read also
                    "<skill>/<relative-path>" to fetch a supporting file.
                    Names resolve with or without the "superpowers-" prefix.
                query: search terms (action="search") — scanned over names,
                    descriptions and full skill bodies.
                filter: optional name-substring filter (action="list").
            """
            try:
                state = None
                if (action or "").strip().lower() in ("load", "loaded"):
                    state = _state_dir()

                def _on_loaded(name: str) -> None:
                    # oplog + transcript line so the user sees methodology
                    # loads live (ctx.log is best-effort by contract).
                    try:
                        ctx.log("skill_loaded", skill=name)
                    except Exception:
                        pass

                return run(action=action, skill=skill, query=query, name_filter=filter,
                           skills_dir=skills_root, state_dir=state, on_loaded=_on_loaded)
            except Exception as exc:  # a tool call must never raise into the loop
                return f"skills error: {type(exc).__name__}: {exc}"

        return [skills]
    except Exception:
        return []  # decorator/schema trouble: stay silent, register nothing


# ---------------------------------------------------------------------------
# Offline self-test: python3 tools/dt_skills.py
# Part 1 exercises the plain core against a TEMP tree; part 2 runs
# READ-ONLY against the REAL ctx.skills_dir (loads write only to a temp
# state dir — the real workspace filesystem is never touched).
# ---------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover — manual smoke check
    import shutil
    import sys
    import tempfile

    failures: list[str] = []

    def check(label: str, cond: bool) -> None:
        print(("  PASS " if cond else "  FAIL ") + label)
        if not cond:
            failures.append(label)

    def _write(p: Path, text: str) -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    print("dt_skills self-test — part 1: plain core over a temp skills tree")
    tmp = Path(tempfile.mkdtemp(prefix="dt-skills-selftest-"))
    try:
        skills = tmp / "agent_skills"
        _write(skills / "superpowers-alpha" / "SKILL.md",
               "---\nname: superpowers-alpha\n"
               "description: Use when doing alpha work - auditing and assembling\n---\n\n"
               "# Alpha methodology\n\nAudit everything before assembling.\n")
        _write(skills / "superpowers-alpha" / "prompt-a.md",
               "# Prompt A\n\nUse when delegating alpha work.\n")
        _write(skills / "superpowers-alpha" / "templates" / "deep.md",
               "# Deep template\n")
        _write(skills / "beta" / "SKILL.md",
               "---\nname: beta\ndescription: Use when beta processing - the wrapped\n"
               "  continuation half\n---\n\n# Beta\n\nBody mentions zeta only here.\n")
        _write(skills / "superpowers-gamma" / "SKILL.md",
               "---\nname: superpowers-gamma\ndescription: Use when gamma sweep is required\n---\n\n# Gamma\n")
        _write(skills / "superpowers-mismatch" / "SKILL.md",
               "---\nname: totally-different\ndescription: Use when broken\n---\n\nbody\n")
        _write(skills / "broken" / "SKILL.md", "no frontmatter fence here\n")

        fm = parse_frontmatter("---\nname: n\ndescription: first\n  second\n---\nbody")
        check("parse_frontmatter flat + continuation",
              fm == {"name": "n", "description": "first second"})
        check("parse_frontmatter missing fence -> {}",
              parse_frontmatter("name: x\n") == {})

        idx = index_skills(skills)
        names = sorted(e["name"] for e in idx["entries"])
        check("index: 3 entries, invariant skips 2",
              names == ["beta", "superpowers-alpha", "superpowers-gamma"]
              and {s["dir"] for s in idx["skipped"]} == {"superpowers-mismatch", "broken"})

        res = search_index(idx, "alpha zeta")
        check("search scoring order (name+desc+body=6 beats body=1)",
              [r["name"] for r in res] == ["superpowers-alpha", "beta"]
              and res[0]["score"] == 6 and res[1]["score"] == 1)

        check("resolve exact w/o prefix",
              resolve_skill(idx, "alpha")["resolved_as"] == "superpowers-alpha")
        check("resolve prefix", resolve_skill(idx, "al")["status"] == "ok")
        check("resolve substring", resolve_skill(idx, "lph")["status"] == "ok")
        amb = resolve_skill(idx, "superpowers")
        check("resolve ambiguous -> candidates",
              amb["status"] == "ambiguous"
              and [e["name"] for e in amb["candidates"]] == ["superpowers-alpha", "superpowers-gamma"])
        check("resolve none -> suggestions",
              resolve_skill(idx, "alpah")["suggestions"] == ["superpowers-alpha"])

        state = tmp / "state"
        env = run("load", skill="alpha", skills_dir=skills, state_dir=state)
        log = state / LOADED_LOG_NAME
        log_lines = [json.loads(l) for l in log.read_text().splitlines()] if log.is_file() else []
        check("load envelope + log append",
              "SKILL LOADED — follow this methodology now" in env
              and "Audit everything" in env and "prompt-a.md" in env
              and len(log_lines) == 1 and log_lines[0]["skill"] == "superpowers-alpha"
              and bool(log_lines[0]["when"]))
        check("loaded lists history",
              "superpowers-alpha" in run("loaded", skills_dir=skills, state_dir=state))
        check("files listing",
              "templates/deep.md" in run("files", skill="superpowers-alpha", skills_dir=skills)
              and "no supporting files" in run("files", skill="beta", skills_dir=skills))
        check("help + unknown action",
              run("help") == HELP_TEXT and "unknown action" in run("frobnicate", skills_dir=skills))
        check("read support file by relpath",
              "# Prompt A" in run("read", skill="superpowers-alpha/prompt-a.md", skills_dir=skills))
        check("read rejects traversal",
              "bad relative path" in run("read", skill="superpowers-alpha/../beta/SKILL.md",
                                         skills_dir=skills))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("part 2: REAL skills dir via dt_registry.ToolContext (read-only)")
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import dt_registry  # stdlib-only; gives us the REAL ctx shape
    real_tmp = Path(tempfile.mkdtemp(prefix="dt-skills-real-"))
    try:
        ctx = dt_registry.ToolContext(workspace=real_tmp)
        idx = index_skills(ctx.skills_dir)
        n = len(idx["entries"])
        n_sp = sum(1 for e in idx["entries"] if e["name"].startswith("superpowers-"))
        n_other = n - n_sp
        print(f"  real index: {n} skills ({n_sp} superpowers-* + {n_other} other, "
              f"{len(idx['skipped'])} skipped) at {ctx.skills_dir}")
        check("real: 17 skills indexed", n == 17)
        check("real: 15 superpowers + 2 other", n_sp == 15 and n_other == 2)
        biggest = max(idx["entries"], key=lambda e: len(_read_body(e["location"])))
        print(f"  largest skill: {biggest['name']} ({len(_read_body(biggest['location']))} chars)")
        print("  real action=list:")
        print("\n".join("    " + ln for ln in
                        run("list", skills_dir=ctx.skills_dir, state_dir=ctx.state_dir()).splitlines()))
        res = search_index(idx, "brainstorm")
        print("  real search 'brainstorm': "
              + "; ".join(f"{r['name']} ({r['score']})" for r in res[:3]))
        check("real search 'brainstorm' top hit is superpowers-brainstorming",
              bool(res) and res[0]["name"] == "superpowers-brainstorming")
        out = run("read", skill="superpowers-using-superpowers", skills_dir=ctx.skills_dir)
        check("real read superpowers-using-superpowers",
              out.startswith("=== SKILL: superpowers-using-superpowers ==="))
        print("  real read superpowers-using-superpowers (first 500 chars):")
        print("\n".join("    " + ln for ln in out[:500].splitlines()))
        env = run("load", skill="brainstorming", skills_dir=ctx.skills_dir, state_dir=ctx.state_dir())
        check("real load envelope (log -> temp state dir only)",
              "SKILL LOADED: superpowers-brainstorming" in env
              and "SKILL LOADED — follow this methodology now" in env)
        print(f"  real load envelope: {len(env)} chars; log at "
              f"{ctx.state_dir() / LOADED_LOG_NAME} (temp — real FS untouched)")
    finally:
        shutil.rmtree(real_tmp, ignore_errors=True)

    print("SELF-TEST OK" if not failures else f"SELF-TEST FAILED: {failures}")
    sys.exit(0 if not failures else 1)
