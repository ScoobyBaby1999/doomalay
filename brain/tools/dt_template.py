"""dt_template.py — browse + run the doomalay template library from chat.

Two template collections shipped with the app were unreachable from a chat
turn before this tool: the 13 orchestrator stage-JSONs (brain/orchestrator/
templates/*.json — the multi-stage research / audit / superpowers pipelines
the web UI drives) and the user-template catalog (the markdown disciplines
in brain/superpowers_user_templates.json plus the DEFAULT_TEMPLATES stage
flows that templates.py seeds into the /api/templates library). `dtemplate`
indexes both read-only AS DATA and lets the model browse them (`list` /
`show` / `describe`) and execute one (`run`) without ever importing the
orchestrator engine: a run hands the pretty-printed stages (or markdown
body) to ctx.spawn as a brief for a sub-agent to work stage by stage; when
no spawn seam exists the same brief comes back with self-execution
instructions for the current model.

Actions: list | show | describe | run | runs | favorite | favorites | help.
State (workspace/.doomalay/dtemplate/): runs.jsonl — append-only run log
(template, input preview, when, output path, status) — and favorites.json
(starred template ids, atomic tmp+os.replace writes). The deliverable of
each run lands in <state>/runs/<id>-<timestamp>.md.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

TOOL_NAMES = ["dtemplate"]   # primary (only) tool name built below

MAX_OUT = 6000            # dt_spec rule 9: model-facing replies stay small
MAX_RUNS_SHOWN = 20       # `runs` shows the newest slice, not the whole log
_INPUT_PREVIEW = 200      # run log keeps a preview, never the whole input
_RESULT_PREVIEW = 300     # same discipline for the spawn result
_BRIEF_BODY_CAP = 24000   # spawn prompts tolerate a lot, not infinity

# Real asset locations (siblings default the same way — resolve from THIS
# file so tests can point both at temp trees).
DEFAULT_BRAIN_DIR = Path(__file__).resolve().parent.parent
DEFAULT_TEMPLATES_DIR = DEFAULT_BRAIN_DIR / "orchestrator" / "templates"
USER_JSON_NAME = "superpowers_user_templates.json"

# Browsing groups for action="list" — fixed order, heuristic assignment.
GROUP_ORDER = ("Superpowers flows", "Deep research", "Creative", "Audit", "Freeform")

RUNS_LOG = "runs.jsonl"
FAV_FILE = "favorites.json"


# ── tiny shared helpers (pure, no IO) ───────────────────────────────────

def _now() -> str:
    """ISO-8601 UTC (dt_spec style) — one clock discipline everywhere."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts_compact(when: str) -> str:
    """Filename-safe timestamp: 2025-06-15T10:15:30Z → 20250615T101530Z.

    WHY: colons in artifact names break Windows/FAT (the app ships on
    Android) — keep run artifacts portable.
    """
    return re.sub(r"[^0-9A-Za-z]", "", when)


def _slug(text: str) -> str:
    """Name → id: lowercase alphanumerics + hyphens ("Superpowers Plan" →
    "superpowers-plan"). User-template ids are hyphenated on purpose so
    they never collide with the underscored orchestrator file stems."""
    s = re.sub(r"[^0-9A-Za-z]+", "-", str(text or "")).strip("-").lower()
    return s or "template"


def _norm_id(ref: str) -> str:
    """Loose matching key: lowercase alphanumerics only — tolerates the
    model typing spaces, hyphens or underscores for the same template."""
    return re.sub(r"[^0-9a-z]", "", str(ref or "").lower())


def _one_liner(text: str, width: int = 92) -> str:
    """Single-line, single-spaced preview for list rows."""
    line = " ".join(str(text or "").split())
    return line if len(line) <= width else line[: width - 1].rstrip() + "…"


def _cap(text: str, limit: int = MAX_OUT, where: str = "") -> str:
    """Hard reply cap (dt_spec rule 9). The note tells the model where the
    untrimmed payload lives so trimming never loses information silently."""
    text = str(text)
    if len(text) <= limit:
        return text
    cut = max(0, limit - 130)
    note = f"\n…[trimmed {len(text) - cut} chars — full version: {where or 'the tool state files'}]"
    return text[:cut] + note[:130]


# ── state IO (JSON for read-modify-write, JSONL for append-only) ────────

def _load_json(path: Path, default: Any) -> Any:
    """Read JSON or return default — corrupt/missing state degrades to a
    fresh start instead of bricking the tool (old-app localStorage rule)."""
    try:
        raw = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _save_state(path: Path, data: Any) -> None:
    """Atomic JSON write: tmp + os.replace so a kill mid-write can never
    leave a half-written favorites file behind (dt_spec rule 3)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def read_runs(state_dir: str | Path) -> list[dict]:
    """Run history from runs.jsonl; torn/corrupt lines are skipped, not
    fatal (an append interrupted by a kill must not erase history)."""
    path = Path(state_dir) / RUNS_LOG
    if not path.is_file():
        return []
    runs: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            if isinstance(rec, dict):
                runs.append(rec)
        except Exception:
            continue
    return runs


def _append_run(state_dir: str | Path, record: dict) -> str:
    """Append one run record; returns "" on success, a warning otherwise —
    a failed log write must not fail the run itself."""
    path = Path(state_dir) / RUNS_LOG
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return ""
    except OSError as exc:
        return f"log write failed ({type(exc).__name__})"


def read_favorites(state_dir: str | Path) -> list[str]:
    """Starred template ids (order = star order)."""
    data = _load_json(Path(state_dir) / FAV_FILE, {})
    ids = data.get("ids") if isinstance(data, dict) else None
    return [i for i in ids if isinstance(i, str)] if isinstance(ids, list) else []


def write_favorites(state_dir: str | Path, ids: list[str]) -> None:
    """Persist the favorites list (atomic — see _save_state)."""
    _save_state(Path(state_dir) / FAV_FILE, {"ids": list(ids)})


# ── plain, unit-testable core: the index ────────────────────────────────
# WHY a hand-rolled index instead of importing the orchestrator: the
# orchestrator module drags in the whole pipeline engine; the tool only
# ever needs the template JSONs AS DATA (dt_spec hard rule: never import
# code you were only supposed to read).

_DEFAULTS_CACHE: dict[str, list[dict]] = {}


def _load_default_templates(brain_dir: Path) -> list[dict]:
    """DEFAULT_TEMPLATES from brain/templates.py, imported SAFELY.

    templates.py is ~2000 lines of /api/templates service code that pulls
    in db/favorites/public_dataset — the seed JSON is the required source
    and this probe is best-effort gravy (task spec: "if importable
    safely"). Result is cached per brain_dir so a chat session never
    re-execs the module on every dtemplate call. NEVER raises.
    """
    key = str(brain_dir)
    if key in _DEFAULTS_CACHE:
        return _DEFAULTS_CACHE[key]
    tpls: list[dict] = []
    path = brain_dir / "templates.py"
    if path.is_file():
        added = str(brain_dir) not in sys.path
        if added:
            sys.path.insert(0, str(brain_dir))  # templates.py does `import db`
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "doomalay_dt_template_defaults", path)
            if spec is not None and spec.loader is not None:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                raw = getattr(mod, "DEFAULT_TEMPLATES", None)
                if isinstance(raw, list):
                    tpls = [t for t in raw if isinstance(t, dict)]
        except Exception:
            tpls = []          # not importable here — JSON seed is enough
        finally:
            if added:
                try:
                    sys.path.remove(str(brain_dir))
                except ValueError:
                    pass
    _DEFAULTS_CACHE[key] = tpls
    return tpls


def _first_comment_line(data: dict) -> str:
    """Orchestrator JSONs carry their human description in "//", "//1", …
    comment keys (dict order = file order); take the first one's first
    line. Returns "" when the file has none (3 of the 13 real ones)."""
    for key, val in data.items():
        if key.startswith("//") and isinstance(val, str):
            line = val.strip().splitlines()[0].strip() if val.strip() else ""
            if line:
                return line
    return ""


def _stage_facts(stages: list[dict]) -> tuple[list[str], int]:
    """(unique roles in stage order, widest fan-out max_parallel)."""
    roles: list[str] = []
    width = 0
    for st in stages:
        role = str(st.get("role", "")).strip()
        if role and role not in roles:
            roles.append(role)
        fo = st.get("fanout")
        if isinstance(fo, dict):
            try:
                width = max(width, int(fo.get("max_parallel", 1) or 1))
            except (TypeError, ValueError):
                width = max(width, 1)
    return roles, width


def index_templates(templates_dir: str | Path | None,
                    brain_dir: str | Path | None) -> dict:
    """Merge the two collections into one index — the tool's whole view.

    Returns {"orchestrator": [entry…], "user": [entry…], "warnings": [str…]}.
    Robust by contract: missing dirs → empty lists (never an exception),
    unreadable/corrupt files → skip + warn, entries without a name/stages →
    skip + warn. Orchestrator entries keep their parsed stages so every
    later action (show/describe/run) works off the index alone.
    """
    warnings: list[str] = []
    tdir = Path(templates_dir) if templates_dir is not None else DEFAULT_TEMPLATES_DIR
    bdir = Path(brain_dir) if brain_dir is not None else DEFAULT_BRAIN_DIR

    # ── kind="orchestrator": one entry per stage-JSON, id = file stem ──
    orch: list[dict] = []
    if tdir.is_dir():
        for path in sorted(tdir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            except Exception as exc:
                warnings.append(f"{path.name}: unreadable JSON ({type(exc).__name__}) — skipped")
                continue
            if not isinstance(data, dict):
                warnings.append(f"{path.name}: not a JSON object — skipped")
                continue
            stages = [s for s in data.get("stages") or [] if isinstance(s, dict)]
            if not stages:
                warnings.append(f"{path.name}: no stages[] — not an orchestrator template, skipped")
                continue
            roles, width = _stage_facts(stages)
            task_type = str(data.get("task_type") or path.stem)
            # Description ladder: "//" first line → same-flow DEFAULT entry
            # → synthesized. Keeps all 13 real files describable.
            desc = _first_comment_line(data)
            if not desc:
                for d in _load_default_templates(bdir):
                    if str(d.get("task_type", "")) == task_type and d.get("description"):
                        desc = str(d["description"])
                        break
            if not desc:
                desc = f"{task_type.replace('_', ' ')} pipeline with {len(stages)} stages"
            orch.append({
                "id": path.stem,
                "kind": "orchestrator",
                "name": str(data.get("name") or path.stem),
                "task_type": task_type,
                "task": str(data.get("task") or ""),
                "description": desc,
                "stages": stages,
                "stage_count": len(stages),
                "roles": roles,
                "fanout_width": width,
                "output_rules": data.get("output_rules") if isinstance(data.get("output_rules"), dict) else {},
                "path": str(path),
            })

    # ── kind="user": markdown disciplines + DEFAULT stage flows ───────
    user: list[dict] = []
    used_ids = {e["id"] for e in orch}
    ujson = bdir / USER_JSON_NAME
    if ujson.is_file():
        data = _load_json(ujson, None)
        if not isinstance(data, list):
            if data is not None:
                warnings.append(f"{USER_JSON_NAME}: expected a list — skipped")
        else:
            for raw in data:
                if not isinstance(raw, dict) or not str(raw.get("name", "")).strip():
                    warnings.append(f"{USER_JSON_NAME}: entry without a name — skipped")
                    continue
                entry = _user_entry(raw, source="user_json", path=str(ujson))
                if entry["id"] in used_ids:
                    warnings.append(f"{USER_JSON_NAME}: duplicate id {entry['id']} — skipped")
                    continue
                used_ids.add(entry["id"])
                user.append(entry)

    # DEFAULT_TEMPLATES probe (best-effort, cached). Skip entries whose
    # task_type is already an orchestrator stem: research_paper etc. exist
    # in both places but they are the SAME pipeline — listing a flow twice
    # would just confuse the model picking an id.
    orch_types = {e["task_type"] for e in orch}
    for raw in _load_default_templates(bdir):
        if not str(raw.get("name", "")).strip():
            continue
        if str(raw.get("task_type", "")) in orch_types:
            continue
        entry = _user_entry(raw, source="defaults", path=str(bdir / "templates.py"))
        if entry["id"] in used_ids:
            continue
        used_ids.add(entry["id"])
        user.append(entry)

    return {"orchestrator": orch, "user": user, "warnings": warnings}


def _user_entry(raw: dict, source: str, path: str) -> dict:
    """Normalize a user-template record (seed JSON or DEFAULT_TEMPLATES):
    both carry name/description/task_type/task/kind/tags plus a markdown
    body OR a stages list — everything downstream reads one shape."""
    name = str(raw.get("name", "")).strip()
    stages = [s for s in raw.get("stages") or [] if isinstance(s, dict)]
    roles, width = _stage_facts(stages)
    tags = [str(t) for t in raw.get("tags") or [] if str(t).strip()]
    return {
        "id": _slug(name),
        "kind": "user",
        "name": name,
        "task_type": str(raw.get("task_type") or _slug(name)),
        "task": str(raw.get("task") or ""),
        "tpl_kind": str(raw.get("kind") or ""),   # chat/deepresearch/judge/custom
        "description": str(raw.get("description") or raw.get("task") or name),
        "tags": tags,
        "markdown": str(raw.get("markdown") or ""),
        "stages": stages,
        "stage_count": len(stages),
        "roles": roles,
        "fanout_width": width,
        "output_rules": raw.get("output_rules_obj") if isinstance(raw.get("output_rules_obj"), dict) else {},
        "source": source,
        "path": path,
    }


def categorize(entry: dict) -> str:
    """Pick a browsing group for action="list".

    Heuristic on id/name/task_type/task/kind/tags (separators normalized)
    — checked in priority order: superpowers flows first (the branded
    disciplines), then research-shaped, then creative, then audit; the
    freeform bucket is the catch-all so every template lands somewhere.
    """
    parts = [str(entry.get(k) or "") for k in ("id", "name", "task_type", "task", "tpl_kind")]
    parts += [str(t) for t in entry.get("tags") or []]
    hay = re.sub(r"[_\-]+", " ", " ".join(parts).lower())
    if "superpower" in hay:
        return "Superpowers flows"
    for w in ("research", "paper", "lesson", "deep", "fact check", "factcheck",
              "compare", "design doc", "design", "summary"):
        if w in hay:
            return "Deep research"
    for w in ("debate", "panel", "creative", "story", "writing",
              "brainstorm", "translation"):
        if w in hay:
            return "Creative"
    for w in ("redteam", "red team", "audit", "verify", "verification",
              "judge", "critique", "review", "debug"):
        if w in hay:
            return "Audit"
    return "Freeform"


# ── formatting (pure functions over index entries) ──────────────────────

def format_list(index: dict, kind: str = "") -> str:
    """Grouped one-liners + counts. kind=orchestrator|user hides the other
    half; an unknown kind is not fatal — it falls back to everything with a
    nudge (the model should never be stranded by a bad filter value)."""
    orch = index.get("orchestrator") or []
    user = index.get("user") or []
    kw = (kind or "").strip().lower()
    note = ""
    if kw and kw not in ("orchestrator", "user"):
        note = f"(kind={kind!r} is not orchestrator|user — showing everything)\n"
        kw = ""
    picked = ([e for e in orch if kw != "user"] + [e for e in user if kw != "orchestrator"])
    if kw == "orchestrator":
        head = f"dtemplate — {len(orch)} orchestrator pipelines (user templates hidden)"
    elif kw == "user":
        head = f"dtemplate — {len(user)} user templates (orchestrator pipelines hidden)"
    else:
        head = (f"dtemplate library — {len(orch) + len(user)} templates "
                f"({len(orch)} orchestrator pipelines + {len(user)} user templates)")

    groups: dict[str, list[dict]] = {}
    for e in picked:
        groups.setdefault(categorize(e), []).append(e)
    lines = [head, note.rstrip()] if note else [head]
    for w in index.get("warnings") or []:
        lines.append(f"  ⚠ {w}")
    for group in GROUP_ORDER:
        entries = groups.get(group)
        if not entries:
            continue
        lines.append("")
        lines.append(f"{group} ({len(entries)}):")
        for e in entries:
            lines.append(f"  {e['id']} [{e.get('kind')}] — {_one_liner(e.get('description'))}")
    for group in sorted(g for g in groups if g not in GROUP_ORDER):
        # unreachable with the current heuristics; kept so a future rule
        # change can never silently drop templates from the listing
        lines.append("")
        lines.append(f"{group} ({len(groups[group])}):")
        for e in groups[group]:
            lines.append(f"  {e['id']} [{e.get('kind')}] — {_one_liner(e.get('description'))}")
    if not picked:
        lines.append("")
        lines.append("  (no templates indexed — nothing readable was found)")
    return _cap("\n".join(lines), MAX_OUT, "the template JSONs on disk")


def tree_view(entry: dict) -> str:
    """Per-stage {name, role, inputs, fanout} tree — the orchestrator shape
    the task spec pins for action="show". Fan-out stages get an indented
    child line (that's the nesting: parallel branches live UNDER their
    stage). Markdown-only user templates report having no pipeline."""
    stages = [s for s in entry.get("stages") or [] if isinstance(s, dict)]
    if not stages:
        return (f"{entry.get('id')} — user template: one guided markdown "
                f"discipline (no stage pipeline to tree)")
    roles = entry.get("roles") or []
    head = f"{entry.get('id')} — {len(stages)} stage{'s' if len(stages) != 1 else ''}"
    if roles:
        head += f", roles: {', '.join(roles)}"
    lines = [head]
    for i, st in enumerate(stages):
        last = i == len(stages) - 1
        branch = "└─" if last else "├─"
        inputs = ", ".join(str(x) for x in (st.get("inputs") or [])) or "—"
        lines.append(f"{branch} {i + 1}. {st.get('name', '?')} [{st.get('role', '?')}]  in: {inputs}")
        fo = st.get("fanout")
        if isinstance(fo, dict):
            try:
                mp = int(fo.get("max_parallel", 1) or 1)
            except (TypeError, ValueError):
                mp = 1
            pad = "      " if last else "│     "
            lines.append(f"{pad}└─ fanout: once per item of {fo.get('over', '?')} "
                         f"(up to {mp} in parallel)")
    return "\n".join(lines)


def describe_template(entry: dict) -> str:
    """Plain-English card: Produces / When to use / stage count + fan-out
    width. The orchestrator `task` fields are "<FILL ME IN: …>" placeholders
    for the RUNNER, not usage guidance — never show those raw."""
    stages = [s for s in entry.get("stages") or [] if isinstance(s, dict)]
    tid = entry.get("id", "?")
    label = entry.get("name") or entry.get("task_type") or tid
    lines = [f"{tid} — {label} ({entry.get('kind')} template)"]
    lines.append(f"Produces: {_one_liner(entry.get('description'), 400)}")
    when = str(entry.get("task") or "").strip()
    if not when or when.startswith("<FILL ME IN"):
        when = f"the user asks for a {str(entry.get('task_type') or tid).replace('_', ' ')} deliverable"
    tags = ", ".join(entry.get("tags") or [])
    lines.append(f"When to use: {when}" + (f" (tags: {tags})" if tags else ""))
    if stages:
        width = entry.get("fanout_width") or 0
        if width:
            fan = f"widest fan-out {width} parallel branches"
            fan_stages = [str(s.get("name")) for s in stages if isinstance(s.get("fanout"), dict)]
            if fan_stages:
                fan += f" at {', '.join(fan_stages)}"
        else:
            fan = "no parallel fan-out (single-track pipeline)"
        lines.append(f"Stages: {len(stages)} (roles: {', '.join(entry.get('roles') or [])}); {fan}.")
    else:
        lines.append("Stages: none — the body is one guided markdown prompt; "
                     "run it and the model works the discipline step by step.")
    return "\n".join(lines)


def _pretty_stages(entry: dict) -> str:
    """Full stage dump for run briefs and user-template `show`: every
    instruction verbatim (the sub-agent executes from THIS text — the
    orchestrator engine is never imported), inputs, fan-out shape, and the
    output rules when present."""
    stages = [s for s in entry.get("stages") or [] if isinstance(s, dict)]
    if not stages:
        md = str(entry.get("markdown") or "")
        return f"TEMPLATE BODY (markdown discipline — follow it exactly):\n{md}"
    out: list[str] = []
    for i, st in enumerate(stages, 1):
        out.append(f"Stage {i} — {st.get('name', '?')} [{st.get('role', '?')}]")
        out.append(f"  instructions: {st.get('instructions', '')}")
        inputs = ", ".join(str(x) for x in (st.get("inputs") or [])) or "—"
        out.append(f"  inputs: {inputs}")
        fo = st.get("fanout")
        if isinstance(fo, dict):
            out.append(f"  fanout: once per item of {fo.get('over', '?')} "
                       f"(up to {fo.get('max_parallel', 1)} in parallel)")
    rules = entry.get("output_rules") or {}
    if isinstance(rules, dict) and rules.get("format"):
        req = rules.get("required_sections")
        extra = f"; required sections: {', '.join(req)}" if isinstance(req, list) and req else ""
        tone = f"; tone: {rules['tone']}" if rules.get("tone") else ""
        out.append(f"Output format: {rules['format']}{extra}{tone}.")
    return "\n".join(out)


def build_run_brief(entry: dict, input_text: str, output_path: str) -> str:
    """The single prompt handed to ctx.spawn (or back to the model when no
    seam exists). Contract per the task spec: the pretty-printed stages (or
    markdown body), the input, stage-by-stage working instructions, and the
    exact deliverable path."""
    body = _pretty_stages(entry)[:_BRIEF_BODY_CAP]
    n = entry.get("stage_count") or 0
    shape = f"{n} stages" if n else "guided markdown discipline"
    return (
        "Execute this multi-stage template on the input below.\n"
        "Work stage by stage, show each stage's output, then write the final "
        f"deliverable to {output_path}.\n\n"
        f"INPUT:\n{input_text}\n\n"
        f"TEMPLATE {entry.get('id', '?')} ({shape}):\n{body}"
    )


# ── id resolution ───────────────────────────────────────────────────────

def _entries(index: dict) -> list[dict]:
    return list(index.get("orchestrator") or []) + list(index.get("user") or [])


def resolve_entry(index: dict, ref: str) -> tuple[dict | None, str]:
    """id → entry. Exact id first (case-insensitive), then display name,
    then the loose normalized key. Normalized hits are usually the
    superpowers twins (user markdown `superpowers-brainstorm` vs
    orchestrator `superpowers_brainstorm`) — ambiguous refs get both ids
    back instead of a silent wrong pick."""
    ref = (ref or "").strip()
    if not ref:
        return None, ('dtemplate: give id= — e.g. action="show", id="research_paper" '
                      "(action=\"list\" shows every id).")
    entries = _entries(index)
    low = ref.lower()
    for e in entries:
        if str(e.get("id", "")).lower() == low:
            return e, ""
    for e in entries:
        if str(e.get("name", "")).lower() == low:
            return e, ""
    norm = _norm_id(ref)
    hits = [e for e in entries if _norm_id(e.get("id")) == norm]
    if len(hits) == 1:
        return hits[0], ""
    if len(hits) > 1:
        ids = ", ".join(f"{e['id']} ({e.get('kind')})" for e in hits)
        return None, (f"dtemplate: {ref!r} is ambiguous — exact ids: {ids}. "
                      "Hyphenated ids are user markdown disciplines, underscored "
                      "ids are orchestrator pipelines.")
    return None, f"dtemplate: no template matches {ref!r} — action='list' shows the library."


# ── action bodies ───────────────────────────────────────────────────────

def _action_show(index: dict, ref: str) -> str:
    entry, err = resolve_entry(index, ref)
    if err:
        return err
    if entry.get("kind") == "orchestrator":
        # orchestrator: the pinned per-stage {name, role, fanout} tree
        rules = entry.get("output_rules") or {}
        rule_line = ""
        if isinstance(rules, dict) and rules.get("format"):
            req = rules.get("required_sections")
            rule_line = (f"\noutput: format {rules['format']}"
                         + (f", sections {', '.join(req)}" if isinstance(req, list) and req else ""))
        header = (f"{entry['id']} — orchestrator pipeline, {entry['stage_count']} stages "
                  f"(task_type {entry['task_type']}){rule_line}")
        body = tree_view(entry)
        where = f"the source JSON {entry.get('path')}"
    else:
        # user: markdown body OR the stage list (instructions included —
        # user flows are one-shot content the model runs directly)
        tags = ", ".join(entry.get("tags") or [])
        header = (f"{entry['id']} — user template"
                  + (f" ({entry.get('tpl_kind')})" if entry.get("tpl_kind") else "")
                  + (f", tags: {tags}" if tags else "")
                  + f" — {entry.get('description', '')}")
        body = _pretty_stages(entry)
        where = f"the source file {entry.get('path')}"
    return _cap(f"{header}\n\n{body}", MAX_OUT, where)


def _action_favorite(index: dict, state_dir: str | Path, ref: str,
                     on_event: Callable[..., None] | None) -> str:
    entry, err = resolve_entry(index, ref)
    if err:
        return err
    fid = entry["id"]
    favs = read_favorites(state_dir)
    if fid in favs:
        favs.remove(fid)
        state = "unmarked"
    else:
        favs.append(fid)
        state = "marked ★"
    try:
        write_favorites(state_dir, favs)
    except Exception as exc:
        return f"dtemplate error: favorites write failed: {type(exc).__name__}: {exc}"
    _fire(on_event, "dtemplate_favorite", template=fid, state=state)
    return (f"dtemplate favorite: {fid} {state} — {len(favs)} favorite(s) now "
            '("favorites" lists them).')


def _run_output_path(state_dir: str | Path | None, tid: str, when: str) -> str:
    """Deliverable path: <state>/runs/<id>-<ts>.md. The id is sanitized
    defensively but NOT re-slugged — file stems (alpha_flow) must survive
    verbatim so the log's output names match the ids the model typed.
    Without a state dir the path stays workspace-relative and says so — a
    missing seam degrades to a precise instruction, never to a fabricated
    absolute path."""
    safe = re.sub(r"[^0-9A-Za-z._-]", "-", str(tid)) or "template"
    fname = f"{safe}-{_ts_compact(when)}.md"
    if state_dir is not None:
        return str(Path(state_dir) / "runs" / fname)
    return f"runs/{fname} (workspace-relative — no state dir wired)"


def _action_run(index: dict, state_dir: str | Path | None,
                spawn: Callable[..., Any] | None,
                on_event: Callable[..., None] | None,
                ref: str, input_text: str, model: str) -> str:
    entry, err = resolve_entry(index, ref)
    if err:
        return err
    tid = entry["id"]
    if not (input_text or "").strip():
        return ('dtemplate run: give input= — e.g. action="run", '
                'id="research_paper", input="essay on X, 6 sections"')
    input_clean = input_text.strip()
    when = _now()
    out_path = _run_output_path(state_dir, tid, when)
    # The sub-agent must be able to WRITE the deliverable path: create the
    # runs/ directory up front — a seam that writes blindly would otherwise
    # fail on the missing parent dir and lose the artifact entirely.
    if state_dir is not None:
        try:
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # spawn may still return text; belt+braces below persists it
    brief = build_run_brief(entry, input_clean, out_path)
    _fire(on_event, "dtemplate_run", template=tid, status="start", output=out_path)

    record = {"template": tid,
              "input": input_clean[:_INPUT_PREVIEW],
              "when": when,
              "output": out_path,
              "status": "self-execution",
              "model": model or ""}

    if spawn is None:
        # No sub-agent seam (offline build / spawn not wired): hand the
        # SAME brief back with self-execution instructions. The orchestrator
        # is still never imported — the current model works the stages.
        if state_dir is not None:
            _append_run(state_dir, record)
        _fire(on_event, "dtemplate_run", template=tid, status="self-execution")
        return _cap(
            "dtemplate run (self-execution mode — no sub-agent seam available):\n"
            "Execute the template below yourself: work stage by stage, show each "
            "stage's output in this conversation, and write the final deliverable "
            f"to {out_path}.\n\n{brief}",
            MAX_OUT, f"the template source {entry.get('path')}")

    try:
        try:
            result = spawn(brief, model=(model or ""), wait=True, timeout=600)
        except TypeError:
            # older spawn seam without a timeout kwarg — retry without it
            result = spawn(brief, model=(model or ""))
    except Exception as exc:
        record["status"] = "error"
        if state_dir is not None:
            _append_run(state_dir, record)
        _fire(on_event, "dtemplate_run", template=tid, status="error")
        return (f"dtemplate error: sub-agent run failed for {tid}: "
                f"{type(exc).__name__}: {exc}")

    result_text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)

    # Belt+braces artifact: the sub-agent was told to write the deliverable,
    # but a seam that only RETURNS text would leave the recorded path
    # dangling — a run log that lies is worse than one written late. Only
    # write when the file is genuinely absent (never clobber sub-agent work).
    if state_dir is not None:
        try:
            op = Path(out_path)
            op.parent.mkdir(parents=True, exist_ok=True)
            if not op.exists() and result_text.strip():
                op.write_text(result_text, encoding="utf-8")
        except OSError:
            pass  # the spawn text is still returned below — nothing is lost

    record["status"] = "done"
    record["result"] = result_text[:_RESULT_PREVIEW]
    warn = _append_run(state_dir, record) if state_dir is not None else ""
    _fire(on_event, "dtemplate_run", template=tid, status="done", output=out_path)
    head = f"dtemplate run: {tid} executed via sub-agent — deliverable: {out_path}"
    if warn:
        head += f" ({warn})"
    tail = _cap(result_text, MAX_OUT - len(head) - 4, out_path)
    return _cap(f"{head}\n\n{tail}", MAX_OUT, out_path)


def format_runs(runs: list[dict], limit: int = MAX_RUNS_SHOWN) -> str:
    """Newest-first history slice (the JSONL keeps everything)."""
    if not runs:
        return ('dtemplate runs: none yet — action="run", id=…, input=… '
                "executes a template and logs it here.")
    recent = list(reversed(runs))[:limit]
    lines = [f"dtemplate runs — {len(runs)} total, newest first (showing {len(recent)}):"]
    for r in recent:
        lines.append(f"- {r.get('when', '?')} {r.get('template', '?')} "
                     f"[{r.get('status', '?')}] → {r.get('output', '?')}")
        inp = " ".join(str(r.get("input") or "").split())
        if inp:
            lines.append(f"    input: {inp[:120]}")
    return "\n".join(lines)


def format_favorites(index: dict, favs: list[str]) -> str:
    if not favs:
        return ('dtemplate favorites: none yet — action="favorite", '
                'id="research_paper" toggles one.')
    by_id = {e["id"]: e for e in _entries(index)}
    lines = [f"dtemplate favorites — {len(favs)}:"]
    for fid in favs:
        e = by_id.get(fid)
        if e is None:
            lines.append(f"- {fid} — (no longer in the library)")
        else:
            lines.append(f"- {fid} [{e.get('kind')}] — {_one_liner(e.get('description'))}")
    return "\n".join(lines)


def _fire(on_event: Callable[..., None] | None, event: str, **fields: Any) -> None:
    """Best-effort status event (oplog + transcript live feed); a broken
    emitter must never fail the action that produced the result."""
    if on_event is None:
        return
    try:
        on_event(event, **fields)
    except Exception:
        pass


# ── plain action dispatcher (no ctx, no strands — unit-testable) ─────────

def run_action(action: str, id: str = "", input: str = "", kind: str = "",
               model: str = "", templates_dir: str | Path | None = None,
               brain_dir: str | Path | None = None,
               state_dir: str | Path | None = None,
               spawn: Callable[..., Any] | None = None,
               on_event: Callable[..., None] | None = None) -> str:
    """Run one `dtemplate` action and return the model-facing string.

    The whole tool minus the strands decorator: tests (and the self-test)
    drive every action through here. templates_dir/brain_dir default to the
    real brain assets next to this file; state_dir is only honored by the
    state-writing actions (browsing never creates workspace directories);
    spawn is the sub-agent seam — None degrades `run` to self-execution.
    """
    action = (action or "").strip().lower() or "help"
    root = Path(templates_dir) if templates_dir is not None else DEFAULT_TEMPLATES_DIR
    broot = Path(brain_dir) if brain_dir is not None else DEFAULT_BRAIN_DIR
    try:
        index = index_templates(root, broot)
    except Exception as exc:  # index_templates is total; belt+braces anyway
        return f"dtemplate error: indexing {root} failed: {type(exc).__name__}: {exc}"
    try:
        if action == "help":
            return HELP_TEXT
        if action == "list":
            return format_list(index, kind)
        if action == "show":
            return _action_show(index, id)
        if action == "describe":
            entry, err = resolve_entry(index, id)
            return err or describe_template(entry)  # type: ignore[arg-type]
        if action == "runs":
            if state_dir is None:
                return ("dtemplate runs: no state dir wired (offline build) — runs "
                        "are not logged here; executed templates still produced output.")
            return _cap(format_runs(read_runs(state_dir)), MAX_OUT, "runs.jsonl")
        if action == "favorites":
            if state_dir is None:
                return ("dtemplate favorites: no state dir wired (offline build) — "
                        "favorites cannot persist here.")
            return format_favorites(index, read_favorites(state_dir))
        if action == "favorite":
            if state_dir is None:
                return ("dtemplate favorite: no state dir wired (offline build) — "
                        "cannot persist favorites here.")
            return _action_favorite(index, state_dir, id, on_event)
        if action == "run":
            return _action_run(index, state_dir, spawn, on_event, id, input, model)
        return f"dtemplate: unknown action {action!r} — action='help' lists them."
    except Exception as exc:  # degrade, don't crash (dt_spec rule 5)
        return f"dtemplate error: {type(exc).__name__}: {exc}"


# ── strands surface ─────────────────────────────────────────────────────

TOOL_DESCRIPTION = (
    "Browse and run the doomalay template library: 13 multi-stage orchestrator "
    "pipelines (research papers, red-team audits, repo audits, superpowers "
    "brainstorm/plan/TDD/debug/verify flows, design docs, lesson plans, panel "
    "debates, freeform) plus user markdown templates. Use it when the user wants "
    "a structured multi-stage deliverable or asks what templates/flows exist. "
    "Actions: list (grouped ids + one-liners, optional kind=orchestrator|user), "
    "show (stage tree or markdown body), describe (what it produces, when to use, "
    "stage count + fan-out), run (execute a template on an input via a sub-agent "
    "and write the deliverable to runs/<id>-<ts>.md), runs (history), "
    "favorite/favorites (star + list), help."
)

HELP_TEXT = """dtemplate — browse + run the template library (orchestrator pipelines + user templates)

actions:
  list [kind=orchestrator|user]   grouped one-liners + counts (start here)
  show id=…                       full template: per-stage {name, role, fanout} tree
                                  (orchestrator) or markdown body / stage list (user)
  describe id=…                   plain-English: what it produces, when to use,
                                  stage count + fan-out width
  run id=… input=… [model=…]      execute: sub-agent works the stages and writes
                                  runs/<id>-<ts>.md; no seam → self-execution brief
  runs                            run history (newest 20)
  favorite id=…                   toggle ★ on a template
  favorites                       list ★ templates
  help                            this sheet

ids: orchestrator = file stems (research_paper, redteam, repo_audit,
superpowers_plan, …); user = slugified names (superpowers-brainstorm, …).
Hyphenated id → markdown discipline; underscored id → multi-stage pipeline.
runs/favorites persist in workspace/.doomalay/dtemplate/."""


def build(ctx) -> list:
    """Return the @tool-decorated `dtemplate` callable built from ctx.

    Never raises (dt_spec rule 2): strands missing → []; ctx without the
    asset dirs → []. State is resolved lazily PER CALL and only for the
    state-writing actions — a casual `list`/`show`/`describe` must not
    create workspace directories just because the model browsed.
    """
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []  # offline / SDK missing: register nothing, stay importable
    try:
        templates_root = Path(ctx.templates_dir)
        brain_root = Path(ctx.brain_dir)
    except Exception:
        return []

    def _state_dir():
        try:
            return ctx.tool_state("dtemplate")
        except Exception:
            return None

    def _spawn(task, model="", wait=True, timeout=600):
        # Thin pass-through so the plain core never sees ctx. The retry
        # without `timeout` tolerates an older spawn seam signature.
        try:
            return ctx.spawn(task, model=model, wait=wait, timeout=timeout)
        except TypeError:
            return ctx.spawn(task, model=model, wait=wait)

    # None when no seam is wired — the plain core then degrades `run` to
    # the self-execution brief instead of raising.
    spawn_seam = _spawn if getattr(ctx, "spawn", None) is not None else None

    try:
        @strands_tool_decorator(name="dtemplate", description=TOOL_DESCRIPTION)
        def dtemplate(action: str, id: str = "", input: str = "",
                      kind: str = "", model: str = "") -> str:
            """Browse and run the doomalay template library from chat.

            Args:
                action: one of list | show | describe | run | runs |
                    favorite | favorites | help.
                id: template id (show/describe/run/favorite). Orchestrator
                    ids are file stems (research_paper, redteam,
                    superpowers_plan…); user ids are slugified names
                    (superpowers-brainstorm…). action="list" shows them all.
                input: the work to execute, used as the template's prompt
                    (action="run").
                kind: optional action="list" filter — orchestrator | user.
                model: optional model id for the sub-agent (action="run");
                    empty = the session default.
            """
            try:
                a = (action or "").strip().lower()
                state = None
                if a in ("run", "runs", "favorite", "favorites"):
                    state = _state_dir()

                def _on_event(event, **fields):
                    # oplog + transcript line so the user sees template runs
                    # live (ctx.log is best-effort by contract).
                    try:
                        ctx.log(event, **fields)
                    except Exception:
                        pass

                return run_action(action=action, id=id, input=input, kind=kind,
                                  model=model, templates_dir=templates_root,
                                  brain_dir=brain_root, state_dir=state,
                                  spawn=spawn_seam if a == "run" else None,
                                  on_event=_on_event)
            except Exception as exc:  # a tool call must never raise into the loop
                return f"dtemplate error: {type(exc).__name__}: {exc}"

        return [dtemplate]
    except Exception:
        return []  # decorator/schema trouble: stay silent, register nothing


# ─────────────────────────────────────────────────────────────────────────
# Offline self-test: python3 tools/dt_template.py
# Part 1 exercises the plain core against a TEMP tree (fake orchestrator
# JSON + fake user JSON + a fake importable templates.py, plus corrupt
# files that must be skipped with warnings). Part 2 is READ-ONLY against
# the REAL brain assets — it prints the true library counts (13
# orchestrator + N user) without writing any state anywhere.
# ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":  # pragma: no cover — manual smoke check
    import shutil
    import tempfile

    failures: list[str] = []

    def check(label: str, cond: bool) -> None:
        print(("  PASS " if cond else "  FAIL ") + label)
        if not cond:
            failures.append(label)

    print("dt_template self-test — part 1: plain core over a temp template tree")
    tmp = Path(tempfile.mkdtemp(prefix="dt-template-selftest-"))
    try:
        tdir = tmp / "tpl"
        bdir = tmp / "brain"
        (tdir).mkdir(parents=True, exist_ok=True)
        (bdir).mkdir(parents=True, exist_ok=True)

        # Fake orchestrator stage-JSON: 3 stages, one fan-out stage, a "//"
        # description, output rules — everything the index must lift out.
        (tdir / "alpha_flow.json").write_text(json.dumps({
            "//": "ALPHA - the alpha flow for self-testing",
            "task_type": "alpha_flow",
            "task": "<FILL ME IN: thing to alpha>",
            "stages": [
                {"name": "prep", "role": "extractor", "inputs": ["prompt"],
                 "instructions": "Extract the alpha targets as JSON."},
                {"name": "work", "role": "generator", "inputs": ["prep"],
                 "instructions": "Work each alpha target.",
                 "fanout": {"over": "prep.targets", "max_parallel": 4}},
                {"name": "check", "role": "verifier", "inputs": ["work"],
                 "instructions": "Verify the alpha output."},
            ],
            "output_rules": {"format": "markdown", "required_sections": ["Alpha"]},
        }), encoding="utf-8")
        # Corrupt + stage-less files: skip with warnings, never crash.
        (tdir / "broken.json").write_text("{ this is not json", encoding="utf-8")
        (tdir / "no_stages.json").write_text(json.dumps({"task_type": "x"}), encoding="utf-8")

        # Fake user templates: one markdown discipline + one nameless entry
        # that must be skipped; plus a big body to prove the reply cap.
        big_md = "# Big\n\n" + ("filler line for cap testing. " * 600)
        (bdir / USER_JSON_NAME).write_text(json.dumps([
            {"name": "Fake User Template", "description": "A fake superpowers discipline",
             "task_type": "fake_user", "task": "do fake things", "kind": "chat",
             "tags": ["superpowers", "fake"], "markdown": "# Fake\n\nDo the fake dance."},
            {"description": "no name — must be skipped"},
            {"name": "Big User Template", "description": "long body for the cap test",
             "task_type": "big_user", "task": "make a big thing", "kind": "chat",
             "tags": ["big"], "markdown": big_md},
        ]), encoding="utf-8")
        # Fake importable templates.py → DEFAULT_TEMPLATES probe path.
        (bdir / "templates.py").write_text(
            "DEFAULT_TEMPLATES = [{\n"
            "    'name': 'Fake Default', 'description': 'default flow for tests',\n"
            "    'task_type': 'fake_default', 'task': 'fake default task',\n"
            "    'kind': 'chat', 'tags': ['creative'],\n"
            "    'stages': [{'name': 'only', 'role': 'generator', 'inputs': ['prompt'],\n"
            "                'instructions': 'Do the default thing.'}],\n"
            "}]\n", encoding="utf-8")

        idx = index_templates(tdir, bdir)
        check("index merges both kinds (1 orchestrator)",
              len(idx["orchestrator"]) == 1 and idx["orchestrator"][0]["id"] == "alpha_flow")
        check("index merges both kinds (3 user: json×2 + defaults×1)",
              len(idx["user"]) == 3 and {e["id"] for e in idx["user"]} ==
              {"fake-user-template", "big-user-template", "fake-default"})
        check("malformed files skipped with warnings (≥3)",
              len(idx["warnings"]) >= 3)
        alpha = idx["orchestrator"][0]
        check("orchestrator entry facts (stages/roles/fanout/desc)",
              alpha["stage_count"] == 3 and alpha["fanout_width"] == 4
              and "extractor" in alpha["roles"]
              and alpha["description"].startswith("ALPHA"))

        # Missing dirs → empty index, not a crash.
        empty = index_templates(tmp / "nope", tmp / "nope2")
        check("missing dirs → empty index",
              empty["orchestrator"] == [] and empty["user"] == [])

        d = describe_template(alpha)
        check("describe mentions stages + produces + when-to-use",
              "Stages: 3" in d and "Produces:" in d and "When to use:" in d
              and "fan-out" in d)
        d_user = describe_template(idx["user"][0])
        check("describe for markdown template still mentions stages",
              "Stages:" in d_user and "markdown" in d_user)

        tv = tree_view(alpha)
        check("tree_view nesting (branch glyphs + fanout child)",
              "├─" in tv and "└─" in tv and "fanout: once per item of prep.targets" in tv
              and "work [generator]" in tv)

        brief = build_run_brief(alpha, "alpha the widgets", "/out/alpha-run.md")
        check("build_run_brief: input + stage instructions + output path",
              "alpha the widgets" in brief and "Stage 1 — prep [extractor]" in brief
              and "Extract the alpha targets" in brief
              and "/out/alpha-run.md" in brief and "stage by stage" in brief)
        brief_md = build_run_brief(idx["user"][0], "fake input", "/out/fake.md")
        check("build_run_brief for markdown body",
              "# Fake" in brief_md and "fake input" in brief_md)

        state = tmp / "state"
        out = run_action("show", id="alpha_flow", templates_dir=tdir, brain_dir=bdir)
        check("show orchestrator = tree (name/role, no instruction dump)",
              "alpha_flow — orchestrator pipeline, 3 stages" in out and "work [generator]" in out)
        out = run_action("show", id="big-user-template", templates_dir=tdir, brain_dir=bdir)
        check("show caps long bodies at 6000 with a trim note",
              len(out) <= 6000 and "trimmed" in out)
        out = run_action("list", templates_dir=tdir, brain_dir=bdir)
        check("list groups + counts",
              "Superpowers flows (1)" in out and "Creative (1)" in out
              and "1 orchestrator pipelines + 3 user templates" in out)
        out = run_action("list", kind="user", templates_dir=tdir, brain_dir=bdir)
        check("list kind=user hides orchestrator",
              "fake-user-template" in out and "alpha_flow" not in out)
        out = run_action("describe", id="alpha_flow", templates_dir=tdir, brain_dir=bdir)
        check("dispatch describe works", "Produces: ALPHA" in out)

        # favorites toggle + persistence across a fresh read
        r1 = run_action("favorite", id="alpha_flow", templates_dir=tdir,
                        brain_dir=bdir, state_dir=state)
        r2 = run_action("favorite", id="fake-user-template", templates_dir=tdir,
                        brain_dir=bdir, state_dir=state)
        check("favorite toggles on + persists",
              "marked ★" in r1 and "marked ★" in r2
              and read_favorites(state) == ["alpha_flow", "fake-user-template"])
        r3 = run_action("favorite", id="alpha_flow", templates_dir=tdir,
                        brain_dir=bdir, state_dir=state)
        check("favorite toggles off",
              "unmarked" in r3 and read_favorites(state) == ["fake-user-template"])
        out = run_action("favorites", templates_dir=tdir, brain_dir=bdir, state_dir=state)
        check("favorites lists the starred template",
              "fake-user-template" in out and "1" in out)
        out = run_action("favorite", id="no-such-template", templates_dir=tdir,
                         brain_dir=bdir, state_dir=state)
        check("favorite unknown id → error string",
              "no template matches" in out)

        # run via a fake spawn seam: records + artifact belt+braces
        calls: list[dict] = []

        def fake_spawn(task, model="", wait=True, timeout=150):
            calls.append({"task": task, "model": model, "timeout": timeout})
            return "STAGE OUTPUT: the alpha deliverable text."

        out = run_action("run", id="alpha_flow", input="alpha the widgets",
                         model="test-model", templates_dir=tdir, brain_dir=bdir,
                         state_dir=state, spawn=fake_spawn)
        runs = read_runs(state)
        check("run spawns with brief (input + path + model)",
              len(calls) == 1 and "alpha the widgets" in calls[0]["task"]
              and calls[0]["model"] == "test-model" and calls[0]["timeout"] == 600)
        check("run records the log entry (template/input/when/output/status)",
              len(runs) == 1 and runs[0]["template"] == "alpha_flow"
              and runs[0]["status"] == "done" and runs[0]["input"] == "alpha the widgets"
              and runs[0]["when"] and "alpha_flow-" in runs[0]["output"])
        check("run result returned + artifact written (belt+braces)",
              "STAGE OUTPUT" in out and "deliverable:" in out
              and Path(runs[0]["output"]).is_file())
        out = run_action("runs", templates_dir=tdir, brain_dir=bdir, state_dir=state)
        check("runs action lists history", "1 total" in out and "alpha_flow" in out)

        # sub-agent wrote its own artifact → never clobbered
        def writing_spawn(task, model="", wait=True, timeout=150):
            m = re.search(r"deliverable to (\S+\.md)", task)
            if m:
                Path(m.group(1)).write_text("WRITTEN BY SUB-AGENT", encoding="utf-8")
            return "returned text differs"

        run_action("run", id="alpha_flow", input="second run",
                   templates_dir=tdir, brain_dir=bdir, state_dir=state,
                   spawn=writing_spawn)
        runs = read_runs(state)
        check("sub-agent artifact never clobbered + log appends",
              len(runs) == 2 and Path(runs[1]["output"]).read_text(encoding="utf-8")
              .startswith("WRITTEN BY SUB-AGENT"))

        # no seam → self-execution instructions, logged as such
        out = run_action("run", id="fake-user-template", input="fake it",
                         templates_dir=tdir, brain_dir=bdir, state_dir=state)
        runs = read_runs(state)
        check("run without seam → self-execution brief",
              "self-execution mode" in out and "# Fake" in out
              and runs[-1]["status"] == "self-execution")
        out = run_action("run", id="alpha_flow", input="   ",
                         templates_dir=tdir, brain_dir=bdir, state_dir=state)
        check("run without input → actionable error", "give input=" in out)

        out = run_action("frobnicate", templates_dir=tdir, brain_dir=bdir)
        check("unknown action → help-ish pointer",
              "unknown action" in out and "help" in out)
        out = run_action("help")
        check("help returns the cheat-sheet", "actions:" in out and "favorite" in out)
        out = run_action("show", id="alpha flow", templates_dir=tdir, brain_dir=bdir)
        check("loose id resolution (spaces)",
              "orchestrator pipeline" in out)
        out = run_action("show", id="zzz-unknown", templates_dir=tdir, brain_dir=bdir)
        check("unknown id → error string", "no template matches" in out)

        # browsing must never create the state dir (lazy-state contract)
        fresh = tmp / "fresh-state"
        run_action("list", templates_dir=tdir, brain_dir=bdir, state_dir=fresh)
        run_action("show", id="alpha_flow", templates_dir=tdir, brain_dir=bdir,
                   state_dir=fresh)
        check("browsing actions never create state dirs", not fresh.exists())

        check("build() never raises without strands ([]) ",
              build(None) == [])
        check("TOOL_NAMES contract", TOOL_NAMES == ["dtemplate"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\ndt_template self-test — part 2: REAL library counts (read-only)")
    real = index_templates(DEFAULT_TEMPLATES_DIR, DEFAULT_BRAIN_DIR)
    n_orch = len(real["orchestrator"])
    n_user = len(real["user"])
    groups: dict[str, int] = {}
    for e in real["orchestrator"] + real["user"]:
        groups[categorize(e)] = groups.get(categorize(e), 0) + 1
    for w in real["warnings"]:
        print(f"  ⚠ {w}")
    for g in GROUP_ORDER:
        if groups.get(g):
            print(f"  {g}: {groups[g]}")
    print(f"  orchestrator ids: {', '.join(e['id'] for e in real['orchestrator'])}")
    print(f"  user ids: {', '.join(e['id'] for e in real['user'])}")
    print(f"REAL index: {n_orch} orchestrator + {n_user} user templates "
          f"({n_orch + n_user} total)")
    check("real orchestrator count >= 13 (the shipped pipelines)", n_orch >= 13)
    check("real user count >= 5 (the superpowers markdown set)", n_user >= 5)

    print()
    if failures:
        print(f"SELF-TEST FAILED: {len(failures)} check(s)")
        raise SystemExit(1)
    print("SELF-TEST OK")
