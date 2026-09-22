"""dt_hf.py — publish chat results / workspace files / state to the Hugging Face community library.

WHERE THIS COMES FROM
=====================
Ported from the old doomalaysocreate Space's HF dataset layer (lib/
dataset_persistence.py + public_dataset.py + crypto.py). What made sense
inside a chat tool and was kept:

  * token-from-env discipline — HF_TOKEN (or HUGGINGFACE_TOKEN) read INSIDE
    the functions, never at import time, never echoed. Status is only ever
    "set"/"missing" (old app audit rule H4: never log token values);
  * the create_repo(..., exist_ok=True) + upload_file / upload_folder flow —
    exactly how the already-live ScoobyBaby1999/doomalay-superpowers dataset
    was published (folder upload mirroring skills/ + templates/ + jsonl);
  * default repo naming {user}/doomalay-<slug> — generalises that flow;
  * graceful degradation: every failure is an actionable string returned to
    the model ("HF_TOKEN not set — publish unavailable", "upload failed: …"),
    never an exception (old app: "network errors never propagate").

What was SKIPPED because it was tied to the old Space's DB / OAuth app:
per-user OAuth code exchange, Fernet-encrypted token columns, SQLite
persistence, 120s upload schedulers, .brain tarball sync, JSONL
read-modify-write hearts. A chat tool publishes on demand with the
account's ambient token — there is no user DB to sync against.

WHAT THE TOOL DOES
==================
One tool, `hf`, one `action` argument:
  whoami       → username + token-set status ONLY (no email/avatar/orgs)
  list         → user's repos (id, last-modified, private)
  publish      → upload a workspace file / directory / glob to a HF repo
  publish_text → publish generated text (report / csv / jsonl) as one file
  dataset_card → render (and optionally upload) a README dataset card
  exists       → repo existence + URL
  help         → cheat-sheet

State → ctx.tool_state("hf") = workspace/.doomalay/hf/: publishes.jsonl
(append-only publish log) + last_publish.json (full manifest of the last
publish, written atomically so a kill mid-write can't corrupt it).

The HfApi client itself is INJECTED: every network action takes an
`api_factory` param that defaults to `_real_api_factory` (lazy
`from huggingface_hub import HfApi`), so offline tests pass a FakeHfApi
recording calls. Every hub call runs through a thread+join timeout guard.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

TOOL_NAMES = ["hf"]

# ── config ──────────────────────────────────────────────────────────────
MAX_FILE_BYTES = 50 * 1024 * 1024      # per-file cap (LFS territory starts here)
MAX_FILES = 2000                       # manifest cap — beyond this, ask for a narrower path
MAX_MANIFEST_LINES = 50                # lines of the file list shown to the model
MAX_OUTPUT_CHARS = 6000                # dt_spec rule 9: return text ≤ ~6000 chars
HF_BASE = "https://huggingface.co"
REPO_TYPES = ("dataset", "model", "space")

# Timeouts (seconds) for every hub call — dt_spec rule 5. Implemented with a
# daemon thread + join so a hung HTTPS call can never wedge the chat loop.
# A timed-out upload MAY still land later (HF commits are atomic); that is
# harmless — the same manifest re-published is an idempotent overwrite.
TIMEOUT_WHOAMI = 30
TIMEOUT_LIST = 45
TIMEOUT_CREATE = 60
TIMEOUT_UPLOAD = 300                   # folder uploads of many files are slow on mobile nets
TIMEOUT_INFO = 30

# Skip-list applied by gather_files. Dot-rule covers .git/.venv/.doomalay/
# .env/.DS_Store (workspace state + VCS internals never belong in a public
# dataset — ported spirit of the old app's ignore hygiene). Non-dot junk dirs
# and bytecode leftovers follow.
SKIP_DIR_NAMES = {"__pycache__", "node_modules", "venv", "env",
                  "dist", "build", "target", "cache"}
SKIP_SUFFIXES = (".pyc", ".pyo", ".class")

NO_TOKEN_HINT = "(set HF_TOKEN or HUGGINGFACE_TOKEN in the app environment)"

HELP_TEXT = """hf — Hugging Face community-library publishing from chat (doomalay)

Actions:
  whoami                          → HF username + token status (nothing else)
  list [repo_type, limit]         → your datasets/models/spaces (id, modified, private)
  publish [path, repo, repo_type, private, commit_message]
                                  → upload a workspace file, directory, or glob
                                    to a HF repo; default <username>/doomalay-<slug>
  publish_text [name, content, repo]
                                  → publish generated text (report/csv/jsonl)
                                    as a single file at the repo root
  dataset_card [repo, summary, path, upload]
                                  → render a README dataset card; upload=true
                                    also writes it into the repo as README.md
  exists [repo]                   → repo exists? + URL
  help                            → this cheat-sheet

Notes:
  * token: read from HF_TOKEN (or HUGGINGFACE_TOKEN) — never displayed.
  * paths are workspace-relative; paths that escape the workspace are
    rejected (../../etc/passwd style).
  * dotfiles, .git, venv/__pycache__/node_modules, and files >50MB are
    skipped; directories mirror the workspace layout in the repo.
  * repos are public by default (community library) — pass private=true
    for a private one. repo_type: dataset|model|space (default dataset).
  * every failure returns an actionable message, never an exception.
  * state: workspace/.doomalay/hf/ (publishes.jsonl + last_publish.json).
"""

SHORT_HELP = ("Actions: whoami, list, publish, publish_text, dataset_card, "
              "exists, help — call action='help' for the cheat-sheet.")


# ── plain, unit-testable core (NO strands / NO hub import up here) ───────

def _now_iso() -> str:
    """ISO-8601 UTC — the house timestamp format (dt_spec Style)."""
    return datetime.now(timezone.utc).isoformat()


def _save_state(path, data) -> None:
    """Atomic JSON write (tmp + os.replace) so a kill mid-write can't corrupt state."""
    p = Path(path)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def _load_state(path) -> dict:
    """JSON read; {} for missing/corrupt files (state is a cache, never a hard dep)."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def safe_slug(name: str, allow_dots: bool = False) -> str:
    """Make a name safe for a HF repo / file path segment.

    Why: model-generated names arrive with spaces, caps, unicode punctuation
    ("My Cool Dataset!") and HF repo ids only tolerate [a-z0-9-_.]. NFKD +
    ascii-ignore folds é→e (café→cafe); everything else collapses to single
    hyphens. allow_dots keeps the extension for FILE names (report.md) while
    repo slugs strip dots. Falls back to "dataset" when nothing survives
    (e.g. pure-CJK input on an ascii fold) so a repo id is never empty.
    """
    text = unicodedata.normalize("NFKD", str(name or ""))
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.lower()
    if not allow_dots:
        text = text.replace(".", "-")
    pattern = r"[^a-z0-9._-]+" if allow_dots else r"[^a-z0-9-]+"
    text = re.sub(pattern, "-", text)
    text = re.sub(r"-{2,}", "-", text)
    if allow_dots:
        # punctuation before an extension must not leave a hyphen hugging
        # the dot ("Analysis!.md" → "analysis-.md" → "analysis.md")
        text = re.sub(r"-+\.", ".", text)
        text = re.sub(r"\.-+", ".", text)
    text = text.strip("-._")
    text = text[:64].rstrip("-._")
    return text or "dataset"


def resolve_repo(default_user: str, name: str) -> str:
    """Final repo id from a (possibly bare) name + the whoami username.

    Rules (mirrors the already-live doomalay-superpowers naming):
      * "owner/repo"        → verbatim (caller knows the target)
      * ""                  → {user}/doomalay        (bare fallback)
      * "doomalay-x"        → {user}/doomalay-x      (no double prefix)
      * anything else       → {user}/doomalay-<slug>
    """
    user = str(default_user or "").strip() or "unknown"
    n = str(name or "").strip()
    if "/" in n:
        parts = [p for p in n.split("/") if p.strip()]
        if len(parts) >= 2:
            return "/".join(parts[:2])     # already qualified — use as-is
    if not n:
        return f"{user}/doomalay"
    slug = safe_slug(n)
    if slug.startswith("doomalay"):
        return f"{user}/{slug}"
    return f"{user}/doomalay-{slug}"


def _repo_url(repo_id: str, repo_type: str) -> str:
    """Web URL of a repo (dataset/model/space live under different paths)."""
    rt = (repo_type or "dataset").strip().lower()
    if rt == "model":
        return f"{HF_BASE}/{repo_id}"
    if rt == "space":
        return f"{HF_BASE}/spaces/{repo_id}"
    return f"{HF_BASE}/datasets/{repo_id}"


def _get_token(env=None) -> str:
    """HF token, read from the environment AT CALL TIME (never import time).

    HF_TOKEN is canonical; HUGGINGFACE_TOKEN accepted as an alias (the old
    app's public_dataset.py accepted both — keep that affordance). The value
    is used for the api client ONLY; it must never appear in any output.
    """
    e = os.environ if env is None else (env or {})
    # v0.48: DOOMALAY_HF_TOKEN first — the engine vault's name for the
    # connect-flow token (remote.go fans it out as X-Env-DOOMALAY_HF_TOKEN);
    # HF_TOKEN / HUGGINGFACE_TOKEN remain as aliases.
    return str(e.get("DOOMALAY_HF_TOKEN", "") or e.get("HF_TOKEN", "")
               or e.get("HUGGINGFACE_TOKEN", "") or "").strip()


def _redact(text: str, secrets) -> str:
    """Belt-and-braces: scrub known secret VALUES out of any error text.

    Why: huggingface_hub exceptions embed URLs and response bodies; a 401
    body never contains the token, but a library repr could. The token
    leaking into the chat transcript would be a real incident — this makes
    it structurally impossible for anything downstream to echo it.
    """
    out = str(text)
    for s in secrets or ():
        s = str(s or "")
        if s and s in out:
            out = out.replace(s, "«redacted»")
    return out


def _no_token_msg(action: str) -> str:
    """The spec's exact actionable shape: 'HF_TOKEN not set — <action> unavailable'."""
    return f"HF_TOKEN not set — {action} unavailable {NO_TOKEN_HINT}"


def _exc_msg(action: str, exc: BaseException, secrets=()) -> str:
    """Exception → short actionable string, redacted + truncated (never raise)."""
    raw = f"{type(exc).__name__}: {exc}"[:400]
    return _redact(f"{action} failed: {raw}", secrets)


def _truthy(v) -> bool:
    """Coerce bool-ish tool args ('true'/'1'/True) — model schemas are best-effort."""
    if isinstance(v, bool):
        return v
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


def _fmt_size(n) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _run_timeout(fn, timeout: float, label: str):
    """Run fn() with a hard wall-clock guard (dt_spec rule 5: timeouts everywhere).

    Daemon thread + join: on timeout we return (False, TimeoutError) while the
    thread dies with the process. A late-completing HF commit is atomic and
    idempotent, so reporting failure early is always safe.
    Returns (True, value) or (False, exception).
    """
    box: dict = {}

    def _wrap():
        try:
            box["ok"], box["val"] = True, fn()
        except BaseException as exc:            # noqa: BLE001 — recorded, surfaced as string
            box["ok"], box["val"] = False, exc

    t = threading.Thread(target=_wrap, daemon=True, name=f"dt-hf-{label}")
    t.start()
    t.join(timeout)
    if "ok" not in box:
        return False, TimeoutError(f"timed out after {timeout:.0f}s")
    return box["ok"], box["val"]


def _real_api_factory(token: str):
    """Default HfApi builder — lazy import so the module loads without the lib."""
    from huggingface_hub import HfApi          # noqa: PLC0415 — lazy by contract
    return HfApi(token=token or None)


def _build_api(api_factory, token: str):
    """Build the hub client; (api, None) or (None, error-string). Never raises."""
    factory = api_factory if api_factory is not None else _real_api_factory
    try:
        return factory(token), None
    except ImportError:
        return None, ("huggingface_hub not installed — HF actions unavailable "
                      "(pip install huggingface_hub)")
    except Exception as exc:
        return None, f"HfApi init failed: {type(exc).__name__}"


def _log(log, event: str, **fields) -> None:
    """Best-effort progress emit (ctx.log → oplog + transcript); never raises."""
    try:
        if log is not None:
            log(event, **fields)
    except Exception:
        pass


# ── file gathering (the workspace → repo manifest) ──────────────────────

def _glob_chars(s: str) -> bool:
    return any(c in s for c in "*?[")


def _dir_name_for_default(path: str) -> str:
    """Derive the default dataset name from a publish path ("reports/" → "reports").

    Globs fall back to their parent dir ("reports/*.md" → "reports");
    the whole workspace (".") becomes "workspace". This feeds
    resolve_repo → {user}/doomalay-<slug> without asking the model to invent
    a name for every publish.
    """
    p = str(path or "").strip().strip("/\\")
    while p.startswith("./"):
        p = p[2:]
    if p in ("", "."):
        return "workspace"
    last = p.split("/")[-1]
    if _glob_chars(last):
        parent = "/".join(p.split("/")[:-1]).strip("/\\")
        if parent and not _glob_chars(parent):
            return parent
        return re.sub(r"[*?\[\].]+", "", last) or "dataset"
    return last


def _skip_reason(rel_parts: tuple) -> str | None:
    """Why a file must NOT be published. None = publish it.

    Dot rule first (any path component starting with "."): .git, .venv,
    .doomalay state, .env secrets, .DS_Store. Then junk dirs, then bytecode.
    The .env case is a privacy MUST: workspace env dumps would leak keys.
    """
    for part in rel_parts:
        if part.startswith("."):
            return f"dotfile ({part})"
    for part in rel_parts[:-1]:
        if part.lower() in SKIP_DIR_NAMES:
            return f"skip-dir ({part})"
    name = rel_parts[-1].lower() if rel_parts else ""
    if any(name.endswith(s) for s in SKIP_SUFFIXES):
        return "bytecode"
    return None


def gather_files(root, path: str, skipped: list | None = None) -> list:
    """Expand a workspace-relative file / directory / glob into [(abs, rel)].

    Guarantees:
      * path resolution guard — the LITERAL path may not escape the workspace
        (Path.resolve + is_relative_to, the spec's hard security rule);
      * per-file guard — a symlink matched by a glob may not point outside
        the workspace (Path.glob follows symlinked dirs, so a workspace
        entry linking to /etc would otherwise leak system files);
      * skip-list (dotfiles, junk dirs, bytecode) + >50MB size cap;
      * deterministic order (sorted by rel) + dedupe;
      * rel paths are workspace-relative so the repo mirrors the workspace
        layout exactly like the doomalay-superpowers folder upload did.

    Raises ValueError on escapes / missing paths / too many files — the
    action layer converts that into a returned string, never an exception.
    Pass skipped=[] to collect (rel, reason) pairs for the report.
    """
    root = Path(root).resolve()
    raw = str(path or "").strip()
    while raw.startswith("./"):
        raw = raw[2:]
    if not raw or raw == ".":
        raw = "."                       # whole-workspace publish
    if raw != ".":
        resolved = (root / raw).resolve()
        if not resolved.is_relative_to(root):
            raise ValueError(f"path escapes workspace: {path}")

    found: dict[str, tuple] = {}

    def _consider(f: Path) -> None:
        """Apply the full guard stack to one candidate file."""
        try:
            fr = f.resolve()
        except OSError:
            return
        if not fr.is_relative_to(root):
            if skipped is not None:
                skipped.append((f.name, "symlink escape"))
            return                        # symlink pointing outside — refuse
        if not fr.is_file():
            return
        rel = fr.relative_to(root).as_posix()
        reason = _skip_reason(tuple(rel.split("/")))
        if reason:
            if skipped is not None:
                skipped.append((rel, reason))
            return
        try:
            if fr.stat().st_size > MAX_FILE_BYTES:
                if skipped is not None:
                    skipped.append((rel, f"oversize >{_fmt_size(MAX_FILE_BYTES)}"))
                return
        except OSError:
            return
        found[str(fr)] = (fr, rel)

    def _walk_into(start: Path) -> None:
        """Walk a directory with in-place pruning of skip dirs/dot dirs."""
        for dirpath, dirnames, filenames in os.walk(start, followlinks=False):
            # prune in place so we never descend into .git / node_modules / …
            dirnames[:] = [d for d in dirnames
                           if not d.startswith(".")
                           and d.lower() not in SKIP_DIR_NAMES]
            for fn in filenames:
                if fn.startswith("."):
                    continue
                _consider(Path(dirpath) / fn)

    if raw != "." and _glob_chars(raw):
        # Glob mode: prefer pathlib semantics; fall back to fnmatch over a
        # guarded walk if the pattern shape upsets Path.glob.
        try:
            matches = sorted(root.glob(raw))
        except Exception:
            matches = []
        if matches:
            for m in matches:
                # A match that IS a junk entry (e.g. "**/*" handing us .git
                # itself) is refused here — recording one skip reason instead
                # of walking a potentially huge .git for nothing.
                mrel = m.relative_to(root)
                reason = _skip_reason(mrel.parts)
                if reason is None and m.is_dir() \
                        and mrel.parts[-1].lower() in SKIP_DIR_NAMES:
                    reason = f"skip-dir ({mrel.parts[-1]})"
                if reason is not None:
                    if skipped is not None:
                        skipped.append((mrel.as_posix(), reason))
                    continue
                if m.is_dir():
                    # a glob that lands on a directory expands into it —
                    # "repor*" matching reports/ should publish its files
                    _walk_into(m)
                else:
                    _consider(m)
        else:
            import fnmatch
            for dirpath, _dirs, filenames in os.walk(root, followlinks=False):
                for fn in filenames:
                    rel = (Path(dirpath) / fn).relative_to(root).as_posix()
                    if fnmatch.fnmatch(rel, raw) or fnmatch.fnmatch(
                            rel.rsplit("/", 1)[-1], raw.rsplit("/", 1)[-1]):
                        _consider(Path(dirpath) / fn)
    elif raw != "." and (root / raw).is_file():
        _consider((root / raw))          # single literal file
    else:
        # Directory walk (explicit dir, glob that matched dirs, or ".").
        start = root if raw == "." else (root / raw)
        if not start.is_dir():
            if raw == ".":
                raise ValueError("workspace is empty or missing")
            raise ValueError(f"no such file or directory under workspace: {path}")
        _walk_into(start)

    files = sorted(found.values(), key=lambda t: t[1])
    if len(files) > MAX_FILES:
        raise ValueError(
            f"too many files: {len(files)} (cap {MAX_FILES}) — publish a narrower path")
    return files


def build_card(repo: str, summary: str = "", files=None) -> str:
    """Render a README.md dataset card (yaml frontmatter + 4 fixed sections).

    Frontmatter: license mit (doomalay's port license for generated data),
    doomalay tags for discoverability, pretty_name. Sections What / Why /
    Structure / Usage per the dt_hf spec. files may be [(abs, rel)] tuples
    (from gather_files), bare rel strings, or Paths. The card is returned as
    TEXT — the caller decides whether to also upload it.
    """
    items = list(files or [])
    repo_id = str(repo or "").strip() or "doomalay-dataset"
    name = repo_id.split("/")[-1]
    rels = []
    for f in items:
        rel = str(f[1]) if isinstance(f, (tuple, list)) and len(f) >= 2 else str(f)
        if rel:
            rels.append(rel)
    shown = [r[:100] for r in rels[:60]]
    structure = "\n".join(f"- `{r}`" for r in shown)
    if not structure:
        structure = "- (files mirror the workspace layout at the repo root)"
    if len(rels) > len(shown):
        structure += f"\n- (+{len(rels) - len(shown)} more — see the repo file browser)"
    what = str(summary or "").strip() or (
        "Artifacts produced during a doomalay chat session — files generated, "
        "analyzed, or refined by the workspace agent at the user's request.")
    url = _repo_url(repo_id, "dataset")
    return f"""---
license: mit
tags:
- doomalay
- chat-artifact
pretty_name: {name}
---

# {name}

## What this is

{what}

## Why it exists

Published from [doomalay](https://github.com/ScoobyBaby1999/doomalay), an
Android AI chat app with a workspace agent. The user asked the chat to share
these results to the Hugging Face community library, and the agent uploaded
them directly via the `hf` tool — the same flow that produced the
doomalay-superpowers skills dataset.

## Structure

{structure}

## Usage

```python
from datasets import load_dataset

ds = load_dataset("{repo_id}")
```

Raw files can be fetched directly:

```bash
hf download {repo_id} --repo-type dataset --local-dir ./{name}
```

Repository: {url}
"""


# ── state persistence (workspace/.doomalay/hf/) ─────────────────────────

def _record_publish(state_dir, record: dict) -> None:
    """Append to publishes.jsonl + atomically refresh last_publish.json.

    The JSONL is the append-only history (dt_spec rule 3); last_publish.json
    is what the tool points the model at when the returned manifest is
    trimmed (rule 9). Records carry repo/file metadata ONLY — never paths
    outside the workspace and never any credential material.
    """
    if not state_dir:
        return
    try:
        d = Path(state_dir)
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "publishes.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        _save_state(d / "last_publish.json", record)
    except Exception:
        pass                            # state is a convenience, never a blocker


def _commit_url(result, repo_id: str, repo_type: str) -> str:
    """Best commit URL from whatever the hub returned (CommitInfo/str/None)."""
    for attr in ("commit_url", "repo_url", "pr_url"):
        v = getattr(result, attr, None) if result is not None and not isinstance(
            result, (str, dict, list)) else None
        if v:
            return str(v)
    if isinstance(result, str) and result.startswith("http"):
        return result
    return _repo_url(repo_id, repo_type)


def _field(item, name: str, default=""):
    """Read a field off a hub info object OR a dict (fakes + real hub both work)."""
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)


def _whoami_name(api):
    """(username, None) or (None, error-string) — extracts the NAME only.

    whoami-v2 returns email/avatar/orgs/auth payload too; we keep exactly the
    username because that is all repo naming needs, and the rest is personal
    data with no business in a chat transcript (privacy by minimization).
    """
    ok, val = _run_timeout(lambda: api.whoami(), TIMEOUT_WHOAMI, "whoami")
    if not ok:
        return None, _exc_msg("whoami", val)
    name = str(_field(val, "name", "") or "")
    if not name:
        return None, "whoami returned no username (token valid?)"
    return name, None


# ── action handlers (all plain functions, all return strings) ───────────

def _act_whoami(api_factory, env) -> str:
    token = _get_token(env)
    if not token:
        return _no_token_msg("whoami")
    api, err = _build_api(api_factory, token)
    if err:
        return err
    name, err = _whoami_name(api)
    if err:
        return err
    return (f"HF username: {name}\n"
            f"token: set\n"
            f"default repo: {name}/doomalay-<slug>")


def _act_list(api_factory, env, repo_type: str, limit) -> str:
    rt = str(repo_type or "dataset").strip().lower()
    if rt not in REPO_TYPES:
        return f"repo_type must be one of {'|'.join(REPO_TYPES)} (got {repo_type!r})"
    token = _get_token(env)
    if not token:
        return _no_token_msg("list")
    api, err = _build_api(api_factory, token)
    if err:
        return err
    user, err = _whoami_name(api)
    if err:
        return err
    try:
        lim = max(1, min(int(limit or 20), 100))
    except (TypeError, ValueError):
        lim = 20
    method = getattr(api, {"dataset": "list_datasets",
                           "model": "list_models",
                           "space": "list_spaces"}[rt])
    ok, items = _run_timeout(lambda: list(method(author=user, limit=lim)),
                             TIMEOUT_LIST, "list")
    if not ok:
        return _exc_msg("list", items, [token])
    lines = [f"{len(items)} {rt} repo(s) for {user}:"]
    for it in items[:40]:
        mod = str(_field(it, "last_modified", "") or "?")
        vis = "private" if _field(it, "private", False) else "public"
        lines.append(f"- {_field(it, 'id', '?')}  {mod[:10]}  {vis}")
    if len(items) > 40:
        lines.append(f"(+{len(items) - 40} more — raise limit, max 100)")
    if not items:
        lines.append("(none yet — publish something first)")
    return "\n".join(lines)[:MAX_OUTPUT_CHARS]


def _act_publish(workspace, state_dir, log, api_factory, env, path: str,
                 repo: str, repo_type: str, private, commit_message: str) -> str:
    # 1. input validation + workspace-escape guard FIRST — bad input must be
    #    rejected before we even look at the token (fail fast, fail local:
    #    a path violation is a security matter, not an availability matter).
    rt = str(repo_type or "dataset").strip().lower()
    if rt not in REPO_TYPES:
        return f"repo_type must be one of {'|'.join(REPO_TYPES)} (got {repo_type!r})"
    if not workspace:
        return "publish needs a workspace (tool misconfigured — no ctx.workspace)"
    ws = Path(workspace)
    if not str(path or "").strip():
        return "publish needs a path (workspace-relative file, directory, or glob)"

    # 2. gather + guard BEFORE any network call — bad input must never
    #    half-create a repo on the hub.
    skipped: list = []
    try:
        files = gather_files(ws, path, skipped)
    except ValueError as exc:
        return f"publish rejected: {exc}"
    if not files:
        if skipped:
            detail = "; ".join(f"{r} — {why}" for r, why in skipped[:8])
            return (f"no publishable files matched '{path}' — skipped: {detail} "
                    f"(dotfiles, junk dirs, and files >50MB are never uploaded)")
        return f"no files matched '{path}' (nothing there)"

    # 3. token gate — only after local validation, right before network.
    token = _get_token(env)
    if not token:
        return _no_token_msg("publish")

    # 4. repo id — explicit qualified repo skips the whoami round-trip.
    api, err = _build_api(api_factory, token)
    if err:
        return err
    repo_arg = str(repo or "").strip()
    user = None
    if "/" not in repo_arg:
        user, err = _whoami_name(api)
        if err:
            return (f"{err}\n(tip: pass an explicit repo='user/name' to skip whoami)")
        repo_id = resolve_repo(user, repo_arg or _dir_name_for_default(path))
    else:
        repo_id = resolve_repo(user or "x", repo_arg)
    priv = _truthy(private)
    total = sum(f.stat().st_size for f, _ in files)
    msg = (str(commit_message or "").strip()
           or f"doomalay publish: {path} ({len(files)} files)")

    _log(log, "hf_publish", phase="start", repo=repo_id, repo_type=rt,
         files=len(files), private=priv)

    # 5. create the repo (exist_ok — re-publishing must be idempotent).
    ok, res = _run_timeout(lambda: api.create_repo(
        repo_id=repo_id, repo_type=rt, private=priv, exist_ok=True),
        TIMEOUT_CREATE, "create_repo")
    if not ok:
        return _exc_msg("create_repo", res, [token])
    _log(log, "hf_publish", phase="repo-ready", repo=repo_id)

    # 6. upload. Single literal file → upload_file; dir/glob → stage the
    #    FILTERED manifest into a temp dir and upload_folder it, so the repo
    #    contents match the manifest exactly (upload_folder's own ignore
    #    patterns would not know about our workspace-relative layout).
    stage = None
    try:
        single = (len(files) == 1 and not _glob_chars(str(path).strip().strip("./"))
                  and (ws / str(path).strip()).is_file())
        if single:
            abs_path, rel = files[0]
            ok, res = _run_timeout(lambda: api.upload_file(
                path_or_fileobj=str(abs_path), path_in_repo=rel,
                repo_id=repo_id, repo_type=rt, commit_message=msg),
                TIMEOUT_UPLOAD, "upload")
        else:
            stage = Path(tempfile.mkdtemp(
                prefix="hf-stage-",
                dir=(str(state_dir) if state_dir and Path(state_dir).exists() else None)))
            for abs_path, rel in files:
                dst = stage / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(abs_path, dst)
            ok, res = _run_timeout(lambda: api.upload_folder(
                repo_id=repo_id, folder_path=str(stage), path_in_repo="",
                repo_type=rt, commit_message=msg),
                TIMEOUT_UPLOAD, "upload")
        if not ok:
            return _redact(f"upload failed: {type(res).__name__}: {res}"[:400], [token])
        url = _commit_url(res, repo_id, rt)
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)   # staging is disposable

    _log(log, "hf_publish", phase="uploaded", repo=repo_id, commit=url,
         files=len(files), bytes=total)

    # 7. state + report.
    rels = [rel for _, rel in files]
    _record_publish(state_dir, {
        "ts": _now_iso(), "action": "publish", "repo": repo_id,
        "repo_type": rt, "private": priv, "commit_message": msg,
        "files": rels[:500], "file_count": len(files), "bytes": total,
        "skipped": len(skipped), "path": str(path),
    })

    lines = [f"published {len(files)} file(s), {_fmt_size(total)} → {repo_id} "
             f"[{rt}, {'private' if priv else 'public'}]",
             f"commit: {url}"]
    if skipped:
        lines.append(f"skipped {len(skipped)}: " +
                     "; ".join(f"{r} ({why})" for r, why in skipped[:8]))
    lines.append("files:")
    for rel in rels[:MAX_MANIFEST_LINES]:
        lines.append(f"  - {rel}")
    if len(rels) > MAX_MANIFEST_LINES:
        lines.append(f"  (+{len(rels) - MAX_MANIFEST_LINES} more)")
    if state_dir:
        lines.append(f"full manifest: {Path(state_dir) / 'last_publish.json'}")
    out = "\n".join(lines)
    if len(out) > MAX_OUTPUT_CHARS:
        out = out[:MAX_OUTPUT_CHARS] + "\n…(trimmed)"
    return out


def _act_publish_text(state_dir, log, api_factory, env, name: str,
                      content: str, repo: str, repo_type: str,
                      private, commit_message: str) -> str:
    token = _get_token(env)
    if not token:
        return _no_token_msg("publish_text")
    rt = str(repo_type or "dataset").strip().lower()
    if rt not in REPO_TYPES:
        return f"repo_type must be one of {'|'.join(REPO_TYPES)} (got {repo_type!r})"
    name = str(name or "").strip()
    if not name:
        return "publish_text needs a name (e.g. 'analysis.md', 'report.csv')"
    content = str(content or "")
    # File name keeps its extension (report.md); the default REPO name is
    # slugged from it without the extension (doomalay-report, not -report-md).
    slug = safe_slug(name, allow_dots=True)
    repo_slug = safe_slug(str(name).rsplit(".", 1)[0] if "." in name else name)

    api, err = _build_api(api_factory, token)
    if err:
        return err
    repo_arg = str(repo or "").strip()
    user = None
    if "/" not in repo_arg:
        user, err = _whoami_name(api)
        if err:
            return f"{err}\n(tip: pass an explicit repo='user/name' to skip whoami)"
        repo_id = resolve_repo(user, repo_arg or repo_slug)
    else:
        repo_id = resolve_repo(user or "x", repo_arg)
    priv = _truthy(private)
    msg = (str(commit_message or "").strip()
           or f"doomalay: add {slug} (published from chat)")

    _log(log, "hf_publish", phase="start", kind="text", name=slug, repo=repo_id)

    ok, res = _run_timeout(lambda: api.create_repo(
        repo_id=repo_id, repo_type=rt, private=priv, exist_ok=True),
        TIMEOUT_CREATE, "create_repo")
    if not ok:
        return _exc_msg("create_repo", res, [token])

    data = content.encode("utf-8")
    ok, res = _run_timeout(lambda: api.upload_file(
        path_or_fileobj=data, path_in_repo=slug,
        repo_id=repo_id, repo_type=rt, commit_message=msg),
        TIMEOUT_UPLOAD, "upload")
    if not ok:
        return _redact(f"upload failed: {type(res).__name__}: {res}"[:400], [token])
    url = _commit_url(res, repo_id, rt)
    file_url = f"{_repo_url(repo_id, rt)}/blob/main/{slug}"

    _log(log, "hf_publish", phase="uploaded", kind="text", repo=repo_id,
         name=slug, commit=url, bytes=len(data))
    _record_publish(state_dir, {
        "ts": _now_iso(), "action": "publish_text", "repo": repo_id,
        "repo_type": rt, "private": priv, "files": [slug],
        "file_count": 1, "bytes": len(data),
    })
    return (f"published {slug} ({_fmt_size(len(data))}) → {repo_id} "
            f"[{rt}, {'private' if priv else 'public'}]\n"
            f"file: {file_url}\n"
            f"commit: {url}")


def _act_dataset_card(workspace, state_dir, log, api_factory, env, repo: str,
                      summary: str, path: str, upload, repo_type: str,
                      private, commit_message: str) -> str:
    # Structure section: if the caller passed a workspace path, list the REAL
    # files it would publish; a bad path degrades to a generic structure
    # (rendering a card must not depend on the filesystem being tidy).
    files: list = []
    if str(path or "").strip() and workspace:
        try:
            files = gather_files(workspace, path)
        except ValueError:
            files = []
    card = build_card(repo, summary, files)
    # dt_spec rule 9: the RETURNED text is capped; the UPLOADED card stays
    # complete (shown is only the chat-visible preview).
    shown = card if len(card) <= MAX_OUTPUT_CHARS else (
        card[:MAX_OUTPUT_CHARS]
        + "\n…(card preview trimmed — pass a narrower path for the full structure)")

    if not _truthy(upload):
        return shown

    # Optional write-back: publish the card as README.md into the repo.
    token = _get_token(env)
    if not token:
        return shown + f"\n\n(card NOT uploaded — {_no_token_msg('publish')})"
    rt = str(repo_type or "dataset").strip().lower()
    if rt not in REPO_TYPES:
        return shown + "\n\n(card NOT uploaded — repo_type must be dataset|model|space)"
    api, err = _build_api(api_factory, token)
    if err:
        return shown + f"\n\n(card NOT uploaded — {err})"
    repo_arg = str(repo or "").strip()
    user = None
    if "/" not in repo_arg:
        user, err = _whoami_name(api)
        if err:
            return shown + f"\n\n(card NOT uploaded — {err})"
        repo_id = resolve_repo(user, repo_arg or "dataset-card")
    else:
        repo_id = resolve_repo(user or "x", repo_arg)
    priv = _truthy(private)
    _log(log, "hf_publish", phase="start", kind="card", repo=repo_id)
    ok, res = _run_timeout(lambda: api.create_repo(
        repo_id=repo_id, repo_type=rt, private=priv, exist_ok=True),
        TIMEOUT_CREATE, "create_repo")
    if not ok:
        return shown + f"\n\n(card NOT uploaded — {_exc_msg('create_repo', res, [token])})"
    msg = (str(commit_message or "").strip() or f"doomalay: dataset card for {repo_id}")
    ok, res = _run_timeout(lambda: api.upload_file(
        path_or_fileobj=card.encode("utf-8"), path_in_repo="README.md",
        repo_id=repo_id, repo_type=rt, commit_message=msg),
        TIMEOUT_UPLOAD, "upload")
    if not ok:
        return shown + f"\n\n(card NOT uploaded — {_redact(f'upload failed: {res}', [token])})"
    url = _commit_url(res, repo_id, rt)
    _log(log, "hf_publish", phase="uploaded", kind="card", repo=repo_id, commit=url)
    _record_publish(state_dir, {
        "ts": _now_iso(), "action": "dataset_card", "repo": repo_id,
        "repo_type": rt, "files": ["README.md"], "file_count": 1,
        "bytes": len(card), "private": priv,
    })
    return shown + f"\n\n— card uploaded as README.md → {url}"


def _act_exists(api_factory, env, repo: str, repo_type: str) -> str:
    token = _get_token(env)
    if not token:
        return _no_token_msg("exists")
    rt = str(repo_type or "dataset").strip().lower()
    if rt not in REPO_TYPES:
        return f"repo_type must be one of {'|'.join(REPO_TYPES)} (got {repo_type!r})"
    repo_arg = str(repo or "").strip()
    if not repo_arg:
        return "exists needs a repo (e.g. 'user/doomalay-x')"
    api, err = _build_api(api_factory, token)
    if err:
        return err
    user = None
    if "/" not in repo_arg:
        user, err = _whoami_name(api)
        if err:
            return err
        repo_id = resolve_repo(user, repo_arg)
    else:
        repo_id = repo_arg
    ok, info = _run_timeout(
        lambda: api.repo_info(repo_id=repo_id, repo_type=rt),
        TIMEOUT_INFO, "repo_info")
    url = _repo_url(repo_id, rt)
    if ok:
        return f"repo exists: {repo_id}\nURL: {url}"
    # Distinguish 404 (a clean "not yet") from real failures (auth/net) so the
    # model knows whether publish would just create it.
    name = type(info).__name__
    text = f"{name}: {info}"
    if "404" in text or "NotFound" in name or "not found" in text.lower():
        return f"repo not found: {repo_id} — publish would create it\nURL (would be): {url}"
    return _exc_msg("exists", info, [token])



def _norm_repo(repo: str) -> str:
    """v0.48: normalize a repo id — strip whitespace/slashes, keep the
    classic `user/name` (or bare name) shape. Returns "" when empty."""
    r = str(repo or "").strip().strip("/")
    if r.startswith("spaces/"):
        r = r[len("spaces/"):]
    return r


def _slugify_name(text: str) -> str:
    """Repo-name-safe slug (lowercase, [a-z0-9-])."""
    txt = unicodedata.normalize("NFKD", str(text or "")).encode(
        "ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", txt).strip("-")[:48]


# ── v0.48 task 7: SPACE MANAGEMENT (raw HF REST — the same API the engine
# uses). This is what gives the sandbox bot FULL control of its own Space:
# create, commit files (edit the Dockerfile / README / app), restart, pause,
# secrets, logs, read/list files, runtime snapshot.
# ----------------------------------------------------------------------------

_HF_BASE = "https://huggingface.co"


def _hf_rest(method, api_path, token, body=None, ctype="application/json",
             timeout=30):
    """Raw HF REST call -> (status, text). NEVER raises; token never logged."""
    import urllib.request, urllib.error
    url = api_path if api_path.startswith("http") else _HF_BASE + api_path
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(url, method=method.upper())
    req.add_header("Authorization", "Bearer " + (token or ""))
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, data, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as exc:                       # network etc.
        return 0, f"{type(exc).__name__}: {exc}"


def _space_snapshot(raw: str) -> str:
    """Compact runtime snapshot from a /api/spaces/{repo} JSON body."""
    try:
        d = json.loads(raw)
    except Exception:
        return raw[:400]
    rt = d.get("runtime") or {}
    hw = (rt.get("hardware") or {})
    bits = [
        f"repo: {d.get('id', '?')}",
        f"sdk: {d.get('sdk', '?')}",
        f"stage: {rt.get('stage', '?')}",
        f"hardware: {hw.get('current') or hw.get('requested') or '?'}",
    ]
    err = rt.get("errorMessage")
    if err:
        bits.append(f"error: {err[:200]}")
    doms = [x.get("domain") for x in (rt.get("domains") or []) if x.get("domain")]
    if doms:
        bits.append("url: https://" + doms[0])
    return "\n".join(bits)


def _act_space(api_factory, env, repo: str) -> str:
    """One space's runtime snapshot (stage / hardware / quota error / URL)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space")
    repo = _norm_repo(repo)
    if not repo:
        return "space: missing ? repo=user/name"
    st, raw = _hf_rest("GET", f"/api/spaces/{repo}", token)
    if st != 200:
        return _redact(f"space lookup failed (HTTP {st}): {raw[:300]}", [token])
    return _space_snapshot(raw)


def _act_spaces(api_factory, env, limit: int) -> str:
    """List the account's Spaces with live runtime stages."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("spaces")
    who = _hf_rest("GET", "/api/whoami-v2", token)
    if who[0] != 200:
        return _redact(f"whoami failed (HTTP {who[0]}): {who[1][:200]}", [token])
    try:
        user = json.loads(who[1]).get("name", "")
    except Exception:
        return "spaces: could not parse whoami"
    st, raw = _hf_rest("GET", f"/api/spaces?author={user}&limit=100", token)
    if st != 200:
        return _redact(f"list spaces failed (HTTP {st}): {raw[:300]}", [token])
    try:
        rows = json.loads(raw) or []
    except Exception:
        return "spaces: could not parse the list"
    out = []
    for sp in rows[:max(1, min(int(limit or 20), 100))]:
        out.append(f"- {sp.get('id')} (sdk {sp.get('sdk', '?')}, "
                   f"{'private' if sp.get('private') else 'public'})")
    return f"{len(rows)} space(s) under {user}:\n" + "\n".join(out) if out \
        else f"no spaces under {user}"


def _act_space_create(api_factory, env, repo: str, sdk: str, private: bool) -> str:
    """Create a Space. Defaults to sdk=static — the free path on every
    account (commit a README with sdk:docker + a Dockerfile afterwards to
    convert it to a Docker Space, HF's own README-sdk field semantics)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_create")
    name = _slugify_name(repo or "") or f"doomalay-{_slugify_name(datetime.now(timezone.utc).strftime('%H%M%S'))}"
    if "/" in repo:
        name = repo.split("/", 1)[1]
    body = {"type": "space", "name": name,
            "sdk": (sdk or "static").strip().lower() or "static",
            "private": bool(private)}
    st, raw = _hf_rest("POST", "/api/repos/create", token, body)
    if st != 200 and "already exists" not in raw and "already created" not in raw:
        return _redact(f"space_create failed (HTTP {st}): {raw[:300]}", [token])
    try:
        url = json.loads(raw).get("url", f"https://huggingface.co/spaces/-/{name}")
    except Exception:
        url = f"https://huggingface.co/spaces/-/{name}"
    note = ("created" if st == 200 else "already exists")
    tip = (" Tip: commit README.md with `sdk: docker` + a Dockerfile to flip "
           "it into a full Docker Space." if body["sdk"] == "static" else "")
    return f"space {note}: {url}{tip}"


def _act_space_commit(api_factory, env, repo: str, files_json: str,
                      commit_message: str) -> str:
    """Commit files to a Space (one NDJSON commit — the engine's own flow).
    files_json: [{"path": "README.md", "content": "..."}, ...] — this is how
    the bot edits its own Dockerfile / README / app code."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_commit")
    repo = _norm_repo(repo)
    if not repo:
        return "space_commit: missing ? repo=user/name"
    try:
        files = json.loads(files_json or "[]")
        if not isinstance(files, list) or not files:
            raise ValueError("empty file list")
    except Exception as exc:
        return f"space_commit: files_json must be a JSON list of {{path, content}} — {exc}"
    lines = [json.dumps({"key": "header", "value": {
        "summary": commit_message or "doomalay agent commit",
        "description": "committed by the doomalay hf tool"}})]
    import base64
    for f in files[:200]:
        p = str(f.get("path", "")).strip()
        c = f.get("content", "")
        if not p:
            continue
        lines.append(json.dumps({"key": "file", "value": {
            "path": p,
            "content": base64.b64encode(str(c).encode()).decode(),
            "encoding": "base64"}}))
    st, raw = _hf_rest("POST", f"/api/spaces/{repo}/commit/main", token,
                       ("\n".join(lines) + "\n").encode(),
                       ctype="application/x-ndjson", timeout=120)
    if st != 200:
        return _redact(f"space_commit failed (HTTP {st}): {raw[:300]}", [token])
    try:
        d = json.loads(raw)
        return f"committed {len(files)} file(s) to {repo}: {d.get('commitUrl', '')}"
    except Exception:
        return f"committed {len(files)} file(s) to {repo}"


def _act_space_files(api_factory, env, repo: str) -> str:
    """List a Space's files (root of main)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_files")
    repo = _norm_repo(repo)
    st, raw = _hf_rest("GET", f"/api/spaces/{repo}/tree/main", token)
    if st != 200:
        return _redact(f"space_files failed (HTTP {st}): {raw[:300]}", [token])
    try:
        rows = json.loads(raw) or []
        return "\n".join(f"- {r.get('path', '?')} ({r.get('type', '?')})"
                          for r in rows[:100]) or "(empty)"
    except Exception:
        return "space_files: could not parse the tree"


def _act_space_read(api_factory, env, repo: str, path: str) -> str:
    """Read one file from a Space (raw)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_read")
    repo = _norm_repo(repo)
    path = (path or "").strip().lstrip("/")
    if not path:
        return "space_read: missing path"
    st, raw = _hf_rest("GET", f"/spaces/{repo}/raw/main/{path}", token,
                       timeout=30)
    if st != 200:
        return _redact(f"space_read failed (HTTP {st}): {raw[:300]}", [token])
    return raw[:20000]


def _act_space_restart(api_factory, env, repo: str, factory: bool) -> str:
    """Restart / wake a Space (factory=true rebuilds the container)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_restart")
    repo = _norm_repo(repo)
    fac = "true" if factory else "false"
    st, raw = _hf_rest("POST", f"/api/spaces/{repo}/restart?factory={fac}",
                       token, body={}, timeout=60)
    if st not in (200, 201, 202):
        return _redact(f"space_restart failed (HTTP {st}): {raw[:300]}", [token])
    return (f"restart requested for {repo} (factory={fac}) — "
            "first boot after sleep takes ~1-5 min")


def _act_space_pause(api_factory, env, repo: str) -> str:
    """Pause a Space (frees the account's cpu-basic slot for another)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_pause")
    repo = _norm_repo(repo)
    st, raw = _hf_rest("POST", f"/api/spaces/{repo}/pause", token, body={},
                       timeout=60)
    if st not in (200, 201, 202):
        return _redact(f"space_pause failed (HTTP {st}): {raw[:300]}", [token])
    return f"paused {repo} — the account's cpu-basic slot is free for another space"


def _act_space_secret(api_factory, env, repo: str, key: str, value: str) -> str:
    """Set a Space secret (never read one back — values are write-only)."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_secret")
    repo = _norm_repo(repo)
    key = (key or "").strip()
    if not key:
        return "space_secret: missing key (values are write-only — set only)"
    st, raw = _hf_rest("POST", f"/api/spaces/{repo}/secrets", token,
                       {"key": key, "value": value or ""}, timeout=30)
    if st != 200:
        return _redact(f"space_secret failed (HTTP {st}): {raw[:300]}", [token])
    return f"secret '{key}' set on {repo} (values can never be read back)"


def _act_space_logs(api_factory, env, repo: str, log_type: str,
                    tail: int) -> str:
    """Fetch the tail of a Space's run or build logs."""
    token = _get_token(env)
    if not token:
        return _no_token_msg("space_logs")
    repo = _norm_repo(repo)
    lt = "build" if str(log_type).lower() == "build" else "run"
    n = max(10, min(int(tail or 100), 500))
    st, raw = _hf_rest("GET", f"/api/spaces/{repo}/logs/{lt}?tail={n}",
                       token, timeout=30)
    if st != 200:
        return _redact(f"space_logs failed (HTTP {st}): {raw[:300]}", [token])
    out = raw
    if lt == "run" and not out.strip():
        out = "(run log empty — the space may be sleeping or just built)"
    return out[-15000:]


# ── dispatcher: the single entry the strands surface calls ──────────────

def run_action(action, *, workspace=None, state_dir=None, log=None,
               api_factory=None, env=None, path: str = "", repo: str = "",
               name: str = "", content: str = "", repo_type: str = "dataset",
               private=False, commit_message: str = "", summary: str = "",
               limit: int = 20, upload=False, files_json: str = "",
               key: str = "", value: str = "", tail: int = 100,
               factory=False, sdk: str = "static") -> str:
    """Route an action. NEVER raises — every failure is an actionable string.

    api_factory/env are the two injection seams that keep this unit-testable
    offline: tests pass a FakeHfApi factory and an explicit env dict so no
    real token and no network can ever be touched.
    """
    action = str(action or "").strip().lower()
    try:
        if action == "help":
            return HELP_TEXT
        if action == "whoami":
            return _act_whoami(api_factory, env)
        if action == "list":
            return _act_list(api_factory, env, repo_type, limit)
        if action == "publish":
            return _act_publish(workspace, state_dir, log, api_factory, env,
                                path, repo, repo_type, private, commit_message)
        if action == "publish_text":
            return _act_publish_text(state_dir, log, api_factory, env, name,
                                     content, repo, repo_type, private,
                                     commit_message)
        if action == "dataset_card":
            return _act_dataset_card(workspace, state_dir, log, api_factory, env,
                                     repo, summary, path, upload, repo_type,
                                     private, commit_message)
        if action == "exists":
            return _act_exists(api_factory, env, repo, repo_type)
        # v0.48 task 7 — space management (full control of the user's
        # Spaces: create, commit/edit files, restart, pause, secrets, logs)
        if action == "space":
            return _act_space(api_factory, env, repo)
        if action == "spaces":
            return _act_spaces(api_factory, env, limit)
        if action == "space_create":
            return _act_space_create(api_factory, env, repo, sdk, private)
        if action == "space_commit":
            return _act_space_commit(api_factory, env, repo, files_json,
                                     commit_message)
        if action == "space_files":
            return _act_space_files(api_factory, env, repo)
        if action == "space_read":
            return _act_space_read(api_factory, env, repo, path)
        if action == "space_restart":
            return _act_space_restart(api_factory, env, repo, factory)
        if action == "space_pause":
            return _act_space_pause(api_factory, env, repo)
        if action == "space_secret":
            return _act_space_secret(api_factory, env, repo, key, value)
        if action == "space_logs":
            return _act_space_logs(api_factory, env, repo, log_type, tail)
        if not action:
            return f"hf: missing action — {SHORT_HELP}"
        return f"Unknown action: {action!r}. {SHORT_HELP}"
    except Exception as exc:            # noqa: BLE001 — the model never sees a traceback
        # Last-resort net: redact the live token in case some library repr
        # embedded it in the exception text.
        return _redact(
            f"hf {action or '?'} crashed: {type(exc).__name__}: {exc}"[:400],
            [_get_token(env)])


# ── strands surface ─────────────────────────────────────────────────────

def build(ctx) -> list:
    """Return the @tool-decorated `hf` callable built from ctx (never raises).

    strands is imported INSIDE build (contract rule 1) so tests, dt_registry
    and offline environments can import this module freely.
    """
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []                        # offline: register nothing
    try:
        _ws = Path(getattr(ctx, "workspace", "."))
        _state = None
        try:
            _state = ctx.tool_state("hf")            # workspace/.doomalay/hf/
        except Exception:
            _state = None                             # state optional — degrade
        _log_fn = getattr(ctx, "log", None)

        @strands_tool_decorator(name="hf", description=(
            "The Hugging Face toolkit — publish chat results, workspace files, "
            "or generated reports to the community library AND fully manage "
            "the account's Spaces (create, edit files like the Dockerfile / "
            "README / app, restart, pause, secrets, logs). Use it whenever "
            "the user asks to upload/publish/share to HuggingFace, manage "
            "their Space, or check their repos. Library actions: whoami, "
            "list, publish, publish_text, dataset_card, exists. Space "
            "actions: spaces (list), space (runtime snapshot), space_create "
            "(static is free everywhere — commit README sdk:docker + "
            "Dockerfile to flip it to Docker), space_commit (edit files), "
            "space_files, space_read, space_restart, space_pause, "
            "space_secret (write-only), space_logs, help. The token is read "
            "from the environment and never displayed."
        ))
        def hf(action: str, path: str = "", repo: str = "", name: str = "",
                content: str = "", repo_type: str = "dataset",
                private: bool = False, commit_message: str = "",
                summary: str = "", limit: int = 20, upload: bool = False,
                files_json: str = "", key: str = "", value: str = "",
                tail: int = 100, factory: bool = False,
                sdk: str = "static") -> str:
            """Publish to the Hugging Face library + manage Spaces.
            action: whoami | list | publish | publish_text | dataset_card | exists | spaces | space | space_create | space_commit | space_files | space_read | space_restart | space_pause | space_secret | space_logs | help
            path: workspace-relative file/dir/glob (publish) OR the file path inside a Space (space_read)
            repo: HF repo id; default <username>/doomalay-<slug>
            name: file name for publish_text (slugged, extension kept)
            content: the text to publish (publish_text)
            repo_type: dataset | model | space (default dataset)
            private: create as a private repo (default False — the community library is public)
            commit_message: custom commit message
            summary: dataset-card one-liner (dataset_card)
            limit: max repos/spaces to list (default 20)
            upload: for dataset_card — also upload the card into the repo as README.md
            files_json: space_commit — JSON list [{"path": "...", "content": "..."}]
            key / value: space_secret — the secret name + its value (write-only)
            tail: space_logs — how many lines (default 100)
            factory: space_restart — rebuild the container from scratch
            sdk: space_create — gradio | static | docker (default static — free on every account)
            """
            return run_action(action, workspace=_ws, state_dir=_state, log=_log_fn,
                              path=path, repo=repo, name=name, content=content,
                              repo_type=repo_type, private=private,
                              commit_message=commit_message, summary=summary,
                              limit=limit, upload=upload, files_json=files_json,
                              key=key, value=value, tail=factory and 100 or tail,
                              factory=factory, sdk=sdk)

        return [hf]
    except Exception:
        return []                        # contract rule 2 — build never raises


# ── offline self-test (dt_spec rule 7) ──────────────────────────────────

if __name__ == "__main__":
    import sys
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="dt-hf-selftest-"))
    ws = tmp / "ws"
    (ws / "reports" / "sub").mkdir(parents=True)
    (ws / "reports" / "a.md").write_text("A", encoding="utf-8")
    (ws / "reports" / "sub" / "b.md").write_text("B", encoding="utf-8")
    (ws / "root.md").write_text("R", encoding="utf-8")
    (ws / ".git").mkdir()
    (ws / ".git" / "config").write_text("x", encoding="utf-8")
    (ws / "notvenv").mkdir()
    (ws / "notvenv" / "junk.pyc").write_bytes(b"\x00\x01")
    state = tmp / "state"
    state.mkdir()

    class _SelfFakeApi:
        """Records every hub call so asserts can inspect the exact args."""

        def __init__(self):
            self.calls = []

        def whoami(self):
            self.calls.append(("whoami", {}))
            return {"name": "selftestuser"}

        def create_repo(self, repo_id, private=None, repo_type=None, exist_ok=None, **kw):
            self.calls.append(("create_repo", {"repo_id": repo_id, "private": private,
                                               "repo_type": repo_type, "exist_ok": bool(exist_ok)}))
            return "https://huggingface.co/datasets/" + repo_id

        def upload_folder(self, **kw):
            self.calls.append(("upload_folder", dict(kw)))
            return None

        def upload_file(self, **kw):
            self.calls.append(("upload_file", dict(kw)))
            return None

        def repo_info(self, repo_id, repo_type=None, **kw):
            self.calls.append(("repo_info", {"repo_id": repo_id, "repo_type": repo_type}))
            raise RuntimeError("404 not found")

        def list_datasets(self, author=None, limit=None, **kw):
            self.calls.append(("list_datasets", {"author": author, "limit": limit}))
            return [{"id": f"{author}/one", "last_modified": "2025-01-02T03:04:05Z", "private": False}]
    fake = _SelfFakeApi()

    FAKE_TOKEN = "hf_selftest_secret_token"

    # safe_slug — spaces / caps / unicode / empties / dots
    assert safe_slug("My Cool Dataset!") == "my-cool-dataset"
    assert safe_slug("café_Résumé!!") == "cafe-resume"
    assert safe_slug("ABC") == "abc"
    assert safe_slug("") == "dataset"
    assert safe_slug("v1.2") == "v1-2"
    assert safe_slug("v1.2.md", allow_dots=True) == "v1.2.md"

    # resolve_repo — default naming contract
    assert resolve_repo("user", "x") == "user/doomalay-x"
    assert resolve_repo("user", "doomalay-y") == "user/doomalay-y"
    assert resolve_repo("user", "a/b") == "a/b"
    assert resolve_repo("user", "") == "user/doomalay"

    # gather_files — dir mode, glob mode, skip rules, escapes
    rels = sorted(r for _, r in gather_files(ws, "reports"))
    assert rels == ["reports/a.md", "reports/sub/b.md"], rels
    rels = sorted(r for _, r in gather_files(ws, "*.md"))
    assert rels == ["root.md"], rels
    skipped = []
    rels = sorted(r for _, r in gather_files(ws, "**/*", skipped))
    assert "root.md" in rels and "reports/sub/b.md" in rels
    assert not any(r.startswith(".git") for r in rels)           # dot dirs skipped
    assert not any(r.endswith(".pyc") for r in rels)             # bytecode skipped
    assert any("junk.pyc" in s[0] for s in skipped)
    try:
        gather_files(ws, "../../etc/passwd")
        raise AssertionError("escape not rejected")
    except ValueError:
        pass
    # oversize via a shrunk cap (avoids writing a real 50MB file)
    _saved_cap = MAX_FILE_BYTES
    globals()["MAX_FILE_BYTES"] = 1
    (ws / "reports" / "big.bin").write_bytes(b"xxxx")
    assert "reports/big.bin" not in [r for _, r in gather_files(ws, "reports")]
    globals()["MAX_FILE_BYTES"] = _saved_cap
    (ws / "reports" / "big.bin").unlink()

    # publish (folder) via fake api — repo naming + upload_folder + no token leak
    out = run_action("publish", workspace=ws, state_dir=state, api_factory=lambda t: fake,
                     env={"HF_TOKEN": FAKE_TOKEN}, path="reports")
    assert "doomalay-reports" in out, out
    kinds = [c[0] for c in fake.calls]
    assert "create_repo" in kinds and "upload_folder" in kinds, kinds
    cr = [c for c in fake.calls if c[0] == "create_repo"][-1][1]
    assert cr["repo_id"] == "selftestuser/doomalay-reports" and cr["exist_ok"] is True
    assert FAKE_TOKEN not in out
    rec = _load_state(state / "last_publish.json")
    assert rec.get("repo") == "selftestuser/doomalay-reports"

    # publish_text — upload_file args + slug
    fake.calls.clear()
    out = run_action("publish_text", state_dir=state, api_factory=lambda t: fake,
                     env={"HF_TOKEN": FAKE_TOKEN}, name="My Report.md", content="hello")
    uf = [c for c in fake.calls if c[0] == "upload_file"]
    assert uf and uf[0][1]["path_in_repo"] == "my-report.md", out
    assert uf[0][1]["repo_id"] == "selftestuser/doomalay-my-report"
    assert uf[0][1]["path_or_fileobj"] == b"hello"
    assert FAKE_TOKEN not in out and FAKE_TOKEN not in json.dumps(
        [c for c in fake.calls], default=str)

    # missing token — the spec's exact actionable message
    out = run_action("publish", workspace=ws, env={}, path="reports")
    assert "HF_TOKEN not set — publish unavailable" in out, out

    # api exception → error string (never raises)
    class _Boom:
        def whoami(self):
            return {"name": "u"}

        def create_repo(self, **kw):
            return None

        def upload_file(self, **kw):
            raise RuntimeError("boom 500")

    out = run_action("publish_text", state_dir=state, api_factory=lambda t: _Boom(),
                     env={"HF_TOKEN": FAKE_TOKEN}, name="x.md", content="y")
    assert "upload failed" in out and "boom 500" in out, out

    # card frontmatter shape
    card = build_card("selftestuser/doomalay-x", "test summary",
                      [(ws / "reports" / "a.md", "reports/a.md")])
    assert card.startswith("---\n")
    assert "license: mit" in card and "tags:" in card and "- doomalay" in card
    for sect in ("## What this is", "## Why it exists", "## Structure", "## Usage"):
        assert sect in card, sect
    assert "reports/a.md" in card and "load_dataset" in card

    # exists + list + help + unknown action
    out = run_action("exists", api_factory=lambda t: fake, env={"HF_TOKEN": FAKE_TOKEN},
                     repo="selftestuser/doomalay-reports")
    assert "not found" in out
    out = run_action("list", api_factory=lambda t: fake, env={"HF_TOKEN": FAKE_TOKEN})
    assert "selftestuser/one" in out
    out = run_action("frobnicate")
    assert "Unknown action" in out

    # build() must return a list and never raise — with strands absent (this
    # sandbox) it registers nothing; on-device it registers the hf tool.
    _fake_ctx = type("C", (), {"workspace": ws,
                               "tool_state": lambda self, n: state,
                               "log": lambda *a, **k: None})()
    assert isinstance(build(_fake_ctx), list)

    shutil.rmtree(tmp, ignore_errors=True)
    print("dt_hf SELF-TEST OK")
    sys.exit(0)
