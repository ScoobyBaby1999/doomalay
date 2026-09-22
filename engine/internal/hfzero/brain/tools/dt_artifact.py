"""dt_artifact.py — chat-side CRUD over the engine's per-chat artifacts (T6-a).

The engine (engine/internal/server/artifacts.go, v0.17+) stores per-chat
ARTIFACTS: real files the model produces (code, csv, md, docx, zips) that
the user opens/edits/downloads from the artifacts drawer. This tool gives
the chat agent the same power over that drawer the UI has, so "build me an
app" or "analyse these stocks" ends in actual downloadable files, not chat
text. State lives entirely engine-side (files on disk under
DataDir/artifacts/<sessionID>/<aid>) — this module keeps NO local state.

REST surface this module bridges (read in full from artifacts.go +
preview.go + server.go routes(); shapes re-verified live against a running
engine at 127.0.0.1:8080):

    GET    /api/sessions/{id}/artifacts              → {"artifacts":[meta…]}
    POST   /api/sessions/{id}/artifacts              body {name, content, encoding, source} → 201 meta
    GET    /api/sessions/{id}/artifacts/{aid}        → meta + "content" (utf8 text | base64)
    PUT    /api/sessions/{id}/artifacts/{aid}        body {name?, content?} — OMITTED key = unchanged
    DELETE /api/sessions/{id}/artifacts/{aid}        → {"deleted": true}
    GET    /api/sessions/{id}/artifacts/{aid}/download  → raw bytes (attachment)
    GET    /api/sessions/{id}/artifacts/{aid}/preview   → {kind: docx|xlsx|archive|text|binary, …}
    GET    /api/sessions/{id}/artifacts/{aid}/entry?name=<member> → {name, size, text?|binary}
    POST   /api/sessions/{id}/artifacts/{aid}/extract   → {"extracted": n, "from": name}

meta = {id, name, mime, encoding, size, source, created_at, updated_at}.
The {aid} URL segment is an opaque 12-lowercase-hex ID (regex
^[a-f0-9]{12}$ — that check doubles as the engine's path-traversal guard),
NEVER the name; mapping a name to an id requires one list call (the engine
itself does the same in findArtifactByName). Errors are {"error": "<msg>"}
with honest status codes (404 session/artifact not found, 400 bad id/json).

FOLDER SEMANTICS (why mkdir looks odd): the engine has NO folder entity.
An artifact NAME is a path-like label ("src/lib/util.go"); the drawer tree
(web/artifacts.js buildTree) splits names on "/" to derive folders. So
mkdir below drops a "<path>/.keep" placeholder so the folder renders in
the drawer immediately, and folders "exist" only while files live inside
them.

AUTH: server.go authMiddleware trusts loopback when no auth_token is
configured (the default), and the brain subprocess is spawned same-host by
cmd/doomalay/main.go — so plain httpx needs no Authorization header. If
the engine runs with auth_token set, export DOOMALAY_ENGINE_TOKEN in the
brain's env and every call here carries Bearer automatically.

CREATE-vs-UPDATE trap this module closes: POST /artifacts ALWAYS mints a
new id, even for an existing name (duplicate names are legal engine-side).
write/append therefore resolve the name first and PUT the existing
artifact — only falling back to POST when nothing matches.

httpx is imported lazily inside the client (dt_spec rule 1) so this module
imports on a strands-free box; tests inject httpx.MockTransport as the
transport seam.
"""
from __future__ import annotations

import base64
import os
import re

TOOL_NAMES = ["artifact"]

# dt_spec rule 5: every action returns a clean actionable message on
# missing-session / 404 / 5xx instead of raising. This is the exact
# no-session wording the wave contract asks for.
NO_SESSION = ("no chat session bound — this tool needs a chat-bound agent "
              "session (artifacts live per chat at "
              "/api/sessions/{id}/artifacts)")

_TIMEOUT = 20.0   # engine is same-host; 20s covers a big base64 create
_READ_CAP = 6000  # dt_spec rule 9: model-facing text ≤ ~6000 chars
_BODY_CAP = 5500  # room inside the cap for the header + truncation note
_AID_RE = re.compile(r"^[a-f0-9]{12}$")  # mirrors Go artifactIDRe

HELP = """artifact — manage this chat's real downloadable files (engine artifacts).
Actions:
  list [path]              tree of artifacts (folders first); optional folder prefix
  create name content [encoding]  new file (name may be "src/main.py"); bytes→base64 auto
  read name|aid            file content (capped; binary → note + download link)
  write name|aid content   replace content; CREATES the file when missing
  edit name|aid find=... replace=...   SURGICAL patch on an EXISTING artifact
                           (incl. files from earlier turns): unique find/replace,
                           or replace_all=true / count=N for multiples; NO
                           whole-file rewrite — token-cheap for big files.
  edit name|aid lines=5-9 replace=...  splice that line range (inclusive, 1-based)
  edit name|aid after_line=5 content=...  insert after line 5 (before_line=…
                           inserts before; after_line=0 appends at EOF)
  ...any edit form + dry_run=true → preview the diff, change nothing.
  append name content      read-modify-write (smart newline; creates when missing)
  delete name|aid
  rename name new_name     engine sanitizes (collapses "a.docx.doc", drops ../)
  mkdir path               creates "<path>/.keep" so the folder shows in the drawer
  download_url name|aid    full URL the user can open
  preview name|aid         docx/xlsx/archive/text viewer summary
  entry name member        one file inside an archive (member path)
  extract name|aid         unpack every archive member into its own artifact
Names are paths ("src/lib/util.go"); matched case-insensitively by full
name, then basename, then path suffix — ambiguous names list candidates.
ids are 12 hex chars. help → this text."""


# ── plain, unit-testable helpers (no HTTP, no strands) ───────────────────

def parse_line_spec(spec) -> tuple[int, int]:
    """"12-18" | "12" | "12.." → (12, 18) inclusive 1-based, clamped ≥1.

    Accepts the sloppy forms a model produces (" 7 - 9 ", "7..9", "7").
    Returns (0, 0) when unparseable — callers turn that into their own
    actionable message (this helper stays pure and raise-free).
    """
    s = str(spec or "").strip().replace("..", "-")
    if not s:
        return (0, 0)
    parts = [p.strip() for p in s.split("-") if p.strip()]
    if not parts or not all(p.lstrip("+").isdigit() for p in parts):
        return (0, 0)
    start = max(1, int(parts[0]))
    end = max(1, int(parts[1])) if len(parts) > 1 else start
    # "9-5" means 5..9 just as surely as "5-9" — swap, don't collapse
    return (min(start, end), max(start, end))


def apply_find_replace(text: str, find: str, replace: str,
                        replace_all: bool = False, count: int = 0) -> tuple[str, int | str]:
    """Find/replace over artifact text. Returns (new_text, n_or_error).

    SAFETY DEFAULT (why this exists): a whole-file rewrite through write=
    costs the model the FULL file in tokens twice (read + rewrite) and
    risks truncation drift on big files. A surgical replace costs only the
    snippet. Default replaces the FIRST occurrence ONLY when the pattern is
    UNIQUE in the file — an ambiguous find is refused with the match count
    so the model widens its context instead of mangling the wrong spot.
    replace_all=true (or count=N) opts out explicitly.
    """
    if not find:
        return (text, "edit needs find= (the exact text to replace)")
    n = text.count(find)
    if n == 0:
        return (text, f"find text not present ({find[:60]!r}…) — read the "
                      f"artifact first and copy the exact span")
    if not replace_all and not count and n > 1:
        return (text, f"find text occurs {n}x — pass replace_all=true, "
                      f"count=<n>, or add surrounding lines to make it unique")
    if replace_all:
        return (text.replace(find, replace), n)
    k = count if (isinstance(count, int) and count > 0) else 1
    return (text.replace(find, replace, min(k, n)), min(k, n))


def apply_line_splice(text: str, start: int, end: int,
                      replacement: str) -> str:
    """Replace lines [start, end] (1-based inclusive) with replacement.

    end past EOF clamps; the replacement keeps its own lines verbatim —
    what the model sends is what lands (no magic separators, same as the
    rest of the file's lines).
    """
    lines = text.split("\n")
    s = max(1, start) - 1
    e = min(end, len(lines))
    if e < s:
        e = s
    repl = replacement.split("\n") if replacement != "" else []
    return "\n".join(lines[:s] + repl + lines[e:])


def apply_insert_at_line(text: str, content: str,
                          after_line: int = 0, before_line: int = 0) -> str:
    """Insert content after (or before) a 1-based line number.

    after_line=0 with before_line=0 == append at EOF. Positions clamp to
    EOF/BOB instead of erroring — an insert can never destroy data, so
    being liberal here is safe.
    """
    lines = text.split("\n")
    new = content.split("\n")
    if after_line and not before_line:
        pos = min(max(1, after_line), len(lines))
        return "\n".join(lines[:pos] + new + lines[pos:])
    if before_line:
        pos = min(max(1, before_line) - 1, len(lines))
        return "\n".join(lines[:pos] + new + lines[pos:])
    return "\n".join(lines + new)


def _diff_summary(old: str, new: str, name: str = "") -> str:
    """Compact unified diff of an edit, capped for the tool return.

    difflib is stdlib; the diff is what lets the model VERIFY its edit
    landed where it intended (same discipline as the repo's superpowers
    TDD skill: show the diff, don't trust the 200).
    """
    import difflib
    diff = list(difflib.unified_diff(
        old.split("\n"), new.split("\n"),
        fromfile=("a/" + name) if name else "old",
        tofile=("b/" + name) if name else "new",
        lineterm=""))
    body = "\n".join(diff)
    if len(body) > _BODY_CAP:
        body = body[:_BODY_CAP] + f"\n… (diff truncated, {len(diff)} lines total)"
    return body or "(no changes)"


def _human_size(n) -> str:
    """1.2 KB / 340 B — compact sizes for tree rows and summaries."""
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def _natural_key(s: str) -> list:
    """Natural sort ("file2" < "file10") — the drawer sorts this way (v0.42)."""
    return [int(p) if p.isdigit() else p.lower()
            for p in re.split(r"(\d+)", s or "")]


def _artifact_line(a: dict, display: str | None = None) -> str:
    """One flat summary row for an artifact meta dict.

    Shows the id: every later action can address the artifact by it, which
    matters when names are ambiguous (duplicate creates are legal).
    """
    name = display if display is not None else str(a.get("name") or "?")
    src = a.get("source") or ""
    tag = f" [{src}]" if src else ""
    return (f"{name}  ({a.get('mime') or '?'}, "
            f"{_human_size(a.get('size'))}, id {a.get('id') or '?'}){tag}")


def _tree_lines(items) -> list:
    """Folders-first tree from FLAT artifact names.

    WHY: the engine has no folder objects — the drawer (web/artifacts.js
    buildTree) splits each artifact name on "/" to derive the tree, so this
    renders exactly what the user sees: [dir] rows (file count + summed
    bytes, like the drawer's folderStats) before file rows, both in
    natural order. File rows show the basename — the folder rows above
    them already carry the path.
    """
    root = {"folders": {}, "files": []}
    for a in items or []:
        parts = [p for p in str(a.get("name") or "").split("/") if p]
        if not parts:
            continue
        node = root
        for seg in parts[:-1]:
            node = node["folders"].setdefault(seg, {"folders": {}, "files": []})
        node["files"].append(a)

    def stats(node):
        # file count = own files + ALL descendants (the drawer's folderStats
        # rolls up the whole subtree); folders themselves are NOT files.
        nf = len(node["files"]) + sum(stats(c)[0] for c in node["folders"].values())
        nb = sum(int(f.get("size") or 0) for f in node["files"]) \
            + sum(stats(c)[1] for c in node["folders"].values())
        return nf, nb

    lines: list = []

    def walk(node, depth):
        for fname in sorted(node["folders"], key=_natural_key):
            child = node["folders"][fname]
            nf, nb = stats(child)
            plural = "s" if nf != 1 else ""
            lines.append("  " * depth +
                         f"[dir]  {fname}/  ({nf} file{plural}, {_human_size(nb)})")
            walk(child, depth + 1)
        for a in sorted(node["files"], key=lambda x: _natural_key(str(x.get("name") or ""))):
            base = str(a.get("name") or "").split("/")[-1]
            lines.append("  " * depth + _artifact_line(a, display=base))

    walk(root, 0)
    return lines


def _norm_prefix(p: str) -> str:
    """Normalize a user-given folder prefix: 'src/', './src', '\\src' → 'src'."""
    s = str(p or "").strip().replace("\\", "/").strip("/")
    while s.startswith("./"):
        s = s[2:]
    return s


def _emit(log, event: str, **fields) -> None:
    """Best-effort ctx.log — oplog/transcript progress line; never fatal."""
    try:
        if log is not None:
            log(event, **fields)
    except Exception:
        pass


def _fmt_err(d: dict) -> str:
    """Error dict → model-facing string, with candidate rows when present."""
    out = str(d.get("error") or "unknown error")
    for c in (d.get("candidates") or [])[:12]:
        out += "\n  - " + str(c)
    return out


# ── ArtifactClient — the HTTP seam (httpx lazily imported) ───────────────

class ArtifactClient:
    """Client for the engine's artifacts REST surface.

    transport is THE test seam: pass httpx.MockTransport to run against a
    fake engine; None → a real httpx.Client. Methods take names/ids and
    return plain dicts — success carries domain keys (created/updated/
    artifacts/meta+content…), failure carries {"error": "<actionable msg>"}
    (plus "candidates"/"status" where they help the model retry). Methods
    NEVER raise: connection refused, timeout, 404, 5xx all collapse into
    error strings the model can read.
    """

    def __init__(self, base_url: str, session_id: str | None,
                 transport=None, timeout: float = _TIMEOUT,
                 token: str | None = None):
        self.base_url = str(base_url or "http://127.0.0.1:8080").rstrip("/")
        self.session_id = session_id
        self._transport = transport
        self._timeout = timeout
        self._token = token
        self._client = None  # lazy httpx.Client — no I/O at build() time

    # ── plumbing ─────────────────────────────────────────────────────
    def _http(self):
        import httpx  # lazy (dt_spec rule 1): import-time failure impossible
        if self._client is None:
            headers = {}
            # Auth: loopback needs nothing by default; a token-configured
            # engine demands Bearer even from localhost (server.go).
            tok = self._token if self._token is not None else \
                os.environ.get("DOOMALAY_ENGINE_TOKEN", "")
            if tok:
                headers["Authorization"] = f"Bearer {tok}"
            kw: dict = {"timeout": self._timeout, "headers": headers}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._client = httpx.Client(**kw)
        return self._client

    def _path(self, aid: str = "") -> str:
        p = f"/api/sessions/{self.session_id}/artifacts"
        return f"{p}/{aid}" if aid else p

    def _request(self, method: str, path: str, *, params=None, json_body=None) -> dict:
        """Single chokepoint: returns {"status","body","text"} or
        {"error": "engine unreachable …"} — never raises."""
        try:
            r = self._http().request(method, self.base_url + path,
                                     params=params, json=json_body)
        except Exception as exc:  # refused / timeout / dns — one message shape
            return {"error": f"engine unreachable at {self.base_url}: {exc}"}
        body = None
        try:
            body = r.json()
        except Exception:
            body = None
        return {"status": r.status_code, "body": body, "text": r.text}

    def _err(self, resp: dict, prefix: str) -> str:
        """HTTP-level failure → actionable message (session 404 gets its own
        hint because the most common cause is the chat being deleted)."""
        if "error" in resp:
            return str(resp["error"])  # transport-level: already actionable
        msg = ""
        if isinstance(resp.get("body"), dict):
            msg = str(resp["body"].get("error") or "")
        if not msg:
            msg = (resp.get("text") or "")[:200] or "no body"
        if resp.get("status") == 404 and "session not found" in msg:
            return (f"{prefix}: engine 404 — session not found (chat session "
                    f"{self.session_id!r} no longer exists; reopen the chat)")
        return f"{prefix}: engine HTTP {resp.get('status')}: {msg}"

    def _ok(self, resp: dict, prefix: str) -> dict | None:
        """200-family check; returns the parsed body or None after _err
        already spoke. Callers branch on None."""
        if "error" in resp:
            return None
        if resp.get("status", 500) >= 400:
            return None
        return resp.get("body") if isinstance(resp.get("body"), dict) else {}

    def _check_aid(self, aid: str) -> str | None:
        # Client-side twin of the Go regex guard — catches malformed ids
        # before the round trip and in the same words the engine would use.
        if not _AID_RE.match(str(aid or "")):
            return (f"bad artifact id {aid!r} — ids are 12 lowercase hex "
                    f"chars; pass the artifact name instead")
        return None

    # ── verbs (one per engine route) ─────────────────────────────────
    def list(self) -> dict:
        if not self.session_id:
            return {"error": NO_SESSION}
        r = self._request("GET", self._path())
        body = self._ok(r, "list artifacts")
        if body is None:
            return {"error": self._err(r, "list artifacts")}
        # Go returns {"artifacts": []} even when the dir doesn't exist yet.
        return {"artifacts": body.get("artifacts") or []}

    def create(self, name: str, content="", encoding: str | None = None,
               source: str = "model") -> dict:
        if not self.session_id:
            return {"error": NO_SESSION}
        # bytes → base64 automatically (binary artifacts are stored
        # base64-side); str → utf8 unless the caller forced base64 (content
        # then must already be base64 text; the engine 400s bad base64 and
        # we surface that verbatim).
        if isinstance(content, (bytes, bytearray)):
            payload = base64.b64encode(bytes(content)).decode("ascii")
            encoding = "base64"
        else:
            payload = "" if content is None else str(content)
            encoding = str(encoding or "utf8").strip().lower() or "utf8"
        body = {"name": str(name or ""), "content": payload,
                "encoding": encoding, "source": str(source or "model")}
        r = self._request("POST", self._path(), json_body=body)
        got = self._ok(r, f"create {name!r}")
        if got is None or not got.get("id"):
            return {"error": self._err(r, f"create {name!r}")}
        return {"created": got, "download_url": self.download_url(got["id"])}

    def get(self, aid: str) -> dict:
        """GET /{aid} → meta + full content (utf8 text | base64 payload)."""
        if not self.session_id:
            return {"error": NO_SESSION}
        bad = self._check_aid(aid)
        if bad:
            return {"error": bad}
        r = self._request("GET", self._path(aid))
        got = self._ok(r, f"read {aid}")
        if got is None or not got.get("id"):
            return {"error": self._err(r, f"read {aid}")}
        return got

    def update(self, aid: str, name: str | None = None,
               content: str | None = None) -> dict:
        """PUT /{aid} — Go decodes {Name *string, Content *string}: an
        OMITTED key means "unchanged". We send exactly the keys we intend
        to change (tests assert the exact body keys) so we never lean on
        the server ignoring nulls."""
        if not self.session_id:
            return {"error": NO_SESSION}
        bad = self._check_aid(aid)
        if bad:
            return {"error": bad}
        body: dict = {}
        if name is not None:
            body["name"] = str(name)
        if content is not None:
            body["content"] = content if isinstance(content, str) else str(content)
        r = self._request("PUT", self._path(aid), json_body=body)
        got = self._ok(r, f"update {aid}")
        if got is None or not got.get("id"):
            return {"error": self._err(r, f"update {aid}")}
        return {"updated": got}

    def delete(self, aid: str) -> dict:
        if not self.session_id:
            return {"error": NO_SESSION}
        bad = self._check_aid(aid)
        if bad:
            return {"error": bad}
        r = self._request("DELETE", self._path(aid))
        got = self._ok(r, f"delete {aid}")
        if got is None:
            return {"error": self._err(r, f"delete {aid}")}
        return {"deleted": True}

    def download_url(self, aid: str) -> str:
        """Pure string build — the route serves raw bytes with
        Content-Disposition, so this URL is for the USER (browser/curl),
        never for JSON parsing."""
        return f"{self.base_url}{self._path(aid)}/download"

    def preview(self, aid: str) -> dict:
        if not self.session_id:
            return {"error": NO_SESSION}
        bad = self._check_aid(aid)
        if bad:
            return {"error": bad}
        r = self._request("GET", self._path(aid) + "/preview")
        got = self._ok(r, f"preview {aid}")
        if got is None:
            return {"error": self._err(r, f"preview {aid}")}
        return got

    def entry(self, aid: str, member: str) -> dict:
        if not self.session_id:
            return {"error": NO_SESSION}
        bad = self._check_aid(aid)
        if bad:
            return {"error": bad}
        r = self._request("GET", self._path(aid) + "/entry",
                          params={"name": str(member or "")})
        got = self._ok(r, f"read entry {member!r}")
        if got is None:
            return {"error": self._err(r, f"read entry {member!r}")}
        return got

    def extract(self, aid: str) -> dict:
        if not self.session_id:
            return {"error": NO_SESSION}
        bad = self._check_aid(aid)
        if bad:
            return {"error": bad}
        r = self._request("POST", self._path(aid) + "/extract")
        got = self._ok(r, f"extract {aid}")
        if got is None:
            return {"error": self._err(r, f"extract {aid}")}
        return got

    def resolve(self, ref: str) -> dict:
        """name-or-aid → {"aid":…, "meta":…}; errors carry candidates.

        WHY list-then-match: the {aid} URL segment is an opaque id, never
        the name, so the ONLY name→id map is the list route. Case-
        insensitive; full name first, then basename, then path suffix;
        ambiguous refs return every candidate so the model retries with
        the full path. An id-shaped ref is probed with a GET first (a file
        legitimately named "abcdef123456" would otherwise be unreachable).
        """
        if not self.session_id:
            return {"error": NO_SESSION}
        ref = str(ref or "").strip()
        if not ref:
            return {"error": "no artifact name or id given"}
        if _AID_RE.match(ref):
            got = self.get(ref)
            if got.get("id"):
                return {"aid": got["id"], "meta": got}
            # fall through: it may be a NAME that happens to look like an id
        lr = self.list()
        if "error" in lr:
            return lr
        arts = lr["artifacts"]
        target = ref.lower().strip("/")

        def names(pred):
            return [a for a in arts if pred(str(a.get("name") or ""))]

        exact = names(lambda n: n.lower() == target)
        if len(exact) == 1:
            return {"aid": exact[0]["id"], "meta": exact[0]}
        if len(exact) > 1:  # duplicate names are legal engine-side (POST mints new ids)
            return {"error": (f"ambiguous: {len(exact)} artifacts are named "
                              f"{ref!r} (duplicate creates) — use the id"),
                    "candidates": [_artifact_line(a) for a in exact]}
        base = names(lambda n: n.rsplit("/", 1)[-1].lower() == target)
        if len(base) == 1:
            return {"aid": base[0]["id"], "meta": base[0]}
        if len(base) > 1:
            return {"error": f"ambiguous name {ref!r} — {len(base)} matches",
                    "candidates": [_artifact_line(a) for a in base]}
        suf = names(lambda n: n.lower().endswith("/" + target))
        if len(suf) == 1:
            return {"aid": suf[0]["id"], "meta": suf[0]}
        if len(suf) > 1:
            return {"error": f"ambiguous name {ref!r} — {len(suf)} matches",
                    "candidates": [_artifact_line(a) for a in suf]}
        avail = [_artifact_line(a) for a in arts][:25]
        tail = (" Existing artifacts:\n  " + "\n  ".join(avail)) if avail \
            else " The artifact drawer is empty."
        return {"error": f"no artifact matches {ref!r} in this chat.{tail}",
                "missing": True}


def _resolve_ref(client: ArtifactClient, name: str, aid: str) -> dict:
    """Tool-level ref: name wins (it also handles id-shaped names); a bare
    aid is probed so the model gets a real 404, not a silent noop."""
    if name:
        return client.resolve(name)
    if aid:
        got = client.get(aid)
        if "error" in got:
            return got
        return {"aid": aid, "meta": got}
    return {"error": 'no artifact given — pass name= (e.g. "report.md") '
                     "or aid= (12-hex id)"}


def _preview_summary(pv: dict, client: ArtifactClient, aid: str) -> str:
    """Engine preview JSON → compact model-readable text (kind-specific)."""
    kind = str(pv.get("kind") or "?")
    name = str(pv.get("name") or "?")
    size = _human_size(pv.get("size"))
    if kind == "text":
        t = str(pv.get("text") or "")
        body = t[:_BODY_CAP] + (f"\n… (truncated, {len(t)} chars total)"
                                if len(t) > _BODY_CAP else "")
        return f"{name} ({size}) — text preview:\n{body}"
    if kind == "archive":
        ents = pv.get("entries") or []
        rows = [str(e.get("name") if isinstance(e, dict) else e) for e in ents][:30]
        more = f"\n… (+{len(ents) - 30} more)" if len(ents) > 30 else ""
        return (f"{name} ({size}) — {pv.get('format') or 'archive'}, "
                f"{len(ents)} entries:\n" +
                "\n".join("  " + r for r in rows) + more +
                f'\nread one: artifact(action="entry", name="{name}", member="…")')
    if kind == "docx":
        blocks = pv.get("blocks") or []
        texts = [str(b.get("text") or "") for b in blocks if b.get("text")][:40]
        return (f"{name} ({size}) — docx, {len(blocks)} blocks:\n" +
                "\n".join("  " + t for t in texts))
    if kind == "xlsx":
        sheets = pv.get("sheets") or []
        rows = "; ".join(f"{s.get('name')}: {len(s.get('rows') or [])} rows"
                         for s in sheets)
        return f"{name} ({size}) — xlsx: {rows}"
    return (f"{name} ({size}) — binary; no text preview.\n"
            f"download: {client.download_url(aid)}")


# ── action dispatch (plain — the strands tool is a thin wrapper) ─────────

def run_action(client: ArtifactClient, action: str, name: str = "",
               content="", new_name: str = "", aid: str = "", path: str = "",
               member: str = "", encoding: str = "", find: str = "",
               replace: str = "", replace_all: bool = False, count: int = 0,
               lines: str = "", after_line: int = 0, before_line: int = 0,
               dry_run: bool = False, log=None) -> str:
    """All artifact actions as a plain function so tests (and the module
    self-test) run without strands. Returns a string, never raises."""
    try:
        return _dispatch(client, action, name=name, content=content,
                         new_name=new_name, aid=aid, path=path,
                         member=member, encoding=encoding, find=find,
                         replace=replace, replace_all=replace_all, count=count,
                         lines=lines, after_line=after_line,
                         before_line=before_line, dry_run=dry_run, log=log)
    except Exception as exc:  # noqa: BLE001 — the model reads this, not a stack
        return f"artifact tool error ({action}): {type(exc).__name__}: {exc}"


def _dispatch(client: ArtifactClient, action: str, name: str, content,
              new_name: str, aid: str, path: str, member: str,
              encoding: str, find: str, replace: str, replace_all: bool,
              count: int, lines: str, after_line: int, before_line: int,
              dry_run: bool, log) -> str:
    action = str(action or "").strip().lower()

    if action in ("help", "?"):
        return HELP
    if action == "list":
        lr = client.list()
        if "error" in lr:
            return lr["error"]
        pref = _norm_prefix(path)
        if pref:
            low = pref.lower() + "/"
            arts = [a for a in lr["artifacts"]
                    if str(a.get("name") or "").lower().startswith(low)]
        else:
            arts = lr["artifacts"]
        where = f" under '{pref}/'" if pref else ""
        if not arts:
            return (f"0 artifacts{where} in this chat — create one: "
                    f'artifact(action="create", name="report.md", content="…")')
        out = (f"{len(arts)} artifact(s){where} in this chat:\n"
               + "\n".join(_tree_lines(arts)))
        # huge trees stay under the 6000-char return cap (dt_spec rule 9)
        return out[:_READ_CAP] + "\n… (tree truncated — narrow with path=)" \
            if len(out) > _READ_CAP else out

    if action == "create":
        nm = (name or path or "").strip()
        if not nm:
            return 'create needs name= (may include folders, e.g. "src/main.py")'
        cr = client.create(nm, content, encoding=encoding or None)
        if "error" in cr:
            return cr["error"]
        m = cr["created"]
        _emit(log, "artifact_created", name=m.get("name"), aid=m.get("id"),
              size=m.get("size"))
        return (f"created {m.get('name')} ({m.get('mime')}, "
                f"{m.get('size')} B, id {m.get('id')})\n"
                f"download: {cr['download_url']}")

    if action == "read":
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        got = client.get(rr["aid"])
        if "error" in got:
            return got["error"]
        text = str(got.get("content") or "")
        # utf8-labeled but NUL-riddled payload (a mislabeled binary) is
        # still not text the model should echo — same treatment as base64.
        if got.get("encoding") == "base64" or "\x00" in text[:4000]:
            return (f"{got.get('name')} ({got.get('mime')}, "
                    f"{_human_size(got.get('size'))}, id {got.get('id')}) is "
                    f"BINARY — payload is base64 and not shown inline.\n"
                    f"download: {client.download_url(rr['aid'])}\n"
                    f'viewer: artifact(action="preview", name="{got.get("name")}")')
        head = (f"{got.get('name')} ({got.get('mime')}, {got.get('size')} B, "
                f"id {got.get('id')}):\n")
        if len(text) <= _BODY_CAP:
            return head + text
        return head + text[:_BODY_CAP] + \
            f"\n… (truncated: {len(text)} chars total — download or fetch in parts)"

    if action == "write":
        if not (name or aid):
            return "write needs name= (or aid=) and content="
        if content is None or str(content) == "":
            return "write needs content= (use create for a fresh empty file)"
        if name:
            rr = client.resolve(name)
            if "error" in rr:
                # create-if-missing — but ONLY on a clean miss; an
                # ambiguous ref must not silently fork into a 3rd file.
                if not rr.get("missing"):
                    return _fmt_err(rr)
                cr = client.create(name, content, encoding=encoding or None)
                if "error" in cr:
                    return cr["error"]
                m = cr["created"]
                _emit(log, "artifact_created", name=m.get("name"),
                      aid=m.get("id"), size=m.get("size"))
                return (f"created {m.get('name')} ({m.get('size')} B, "
                        f"id {m.get('id')})\n"
                        f"download: {cr['download_url']}")
            target = rr["aid"]
        else:
            target = str(aid)
        upd = client.update(target, content=str(content))
        if "error" in upd:
            return upd["error"]
        m = upd["updated"]
        _emit(log, "artifact_written", name=m.get("name"), aid=m.get("id"),
              size=m.get("size"))
        return (f"updated {m.get('name')} → {m.get('size')} B "
                f"(id {m.get('id')})\n"
                f"download: {client.download_url(m.get('id'))}")

    if action == "edit":
        # v0.44 (user spec #1): SURGICAL edits on existing artifacts —
        # find/replace, line splices, inserts — including files created in
        # EARLIER turns (resolve by name works across turns; the drawer's
        # editor can then open the updated file). Token-cheap: only the
        # changed span crosses the wire, not the whole file.
        if not (name or aid):
            return ("edit needs name= (or aid=) of an EXISTING artifact plus "
                    "one of: find=/replace=, lines=/replace=, or "
                    "after_line=/before_line=/content=")
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        got = client.get(rr["aid"])
        if "error" in got:
            return got["error"]
        if got.get("encoding") == "base64" or "\x00" in str(got.get("content") or "")[:4000]:
            return (f"{got.get('name')} is a binary/base64 artifact — edit "
                    f"can't patch it in place; use action='write' with the "
                    f"full base64 payload, or download → edit → re-create.")
        old = str(got.get("content") or "")
        mode = ""
        new_text = old
        note = ""
        # ORDERING: `replace` is shared by two modes — the find/replace
        # branch is gated on find= (non-empty), the splice branch on lines=,
        # so lines=+replace= never falls into find/replace with empty find.
        if find:
            mode = "find/replace"
            new_text, res = apply_find_replace(old, find, replace,
                                               replace_all=replace_all,
                                               count=count)
            if isinstance(res, str):
                return res  # actionable error, not an exception
            note = f"{res} occurrence(s) replaced"
        elif lines:
            s, e = parse_line_spec(lines)
            if not s:
                return (f'lines= not understood ({lines!r}) — use "5-9", '
                        f'"7", or "7..")')
            mode = f"splice lines {s}-{e}"
            new_text = apply_line_splice(old, s, e, str(replace if replace else content))
            note = "line range replaced"
        elif after_line or before_line:
            if not str(content or "").strip():
                return "insert needs content= (the lines to insert)"
            where = f"after line {after_line}" if after_line else f"before line {before_line}"
            mode = f"insert {where}"
            new_text = apply_insert_at_line(old, str(content),
                                            after_line=after_line,
                                            before_line=before_line)
            note = "inserted"
        else:
            return ('edit needs one of: find=+replace=, lines=+replace= (or '
                    'content=), or after_line=/before_line=+content=')
        if new_text == old:
            return (f"{got.get('name')}: edit produced NO change ({mode}) — "
                    f"check the find text / line range against the file.")
        diff = _diff_summary(old, new_text, str(got.get("name") or ""))
        if dry_run:
            return (f"DRY RUN — {got.get('name')} would change ({mode}):") + "\n" + diff
        upd = client.update(rr["aid"], content=new_text)
        if "error" in upd:
            return upd["error"]
        m = upd["updated"]
        _emit(log, "artifact_edited", name=m.get("name"), aid=m.get("id"),
              mode=mode, size=m.get("size"))
        head = (f"edited {m.get('name')} ({mode}, {note}) → "
                f"{m.get('size')} B (id {m.get('id')})\n")
        return head + diff

    if action == "append":
        if not (name or aid):
            return "append needs name= (or aid=) and content="
        if name:
            rr = client.resolve(name)
            if "error" in rr:
                if not rr.get("missing"):  # ambiguous/other error → surface
                    return _fmt_err(rr)
                # first append onto a nonexistent file == create it
                cr = client.create(name, content)
                if "error" in cr:
                    return cr["error"]
                m = cr["created"]
                _emit(log, "artifact_created", name=m.get("name"),
                      aid=m.get("id"))
                return f"created {m.get('name')} ({m.get('size')} B, id {m.get('id')})"
            target = rr["aid"]
        else:
            target = str(aid)
        got = client.get(target)
        if "error" in got:
            return got["error"]
        if got.get("encoding") == "base64":
            return (f"{got.get('name')} is a base64/binary artifact — append "
                    f'can\'t merge text into it; use action="write" with the '
                    f"full base64 payload.")
        cur = str(got.get("content") or "")
        # smart separator: appending "a line" to "line1" (no trailing \n)
        # should not glue "line1a line" — but never fights a model that
        # carries its own newlines.
        sep = "" if (not cur or cur.endswith("\n")
                     or str(content).startswith("\n")) else "\n"
        upd = client.update(target, content=cur + sep + str(content))
        if "error" in upd:
            return upd["error"]
        m = upd["updated"]
        _emit(log, "artifact_appended", name=m.get("name"), aid=m.get("id"),
              size=m.get("size"))
        return (f"appended → {m.get('name')} is now {m.get('size')} B "
                f"(id {m.get('id')})")

    if action == "delete":
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        d = client.delete(rr["aid"])
        if "error" in d:
            return d["error"]
        _emit(log, "artifact_deleted", name=rr["meta"].get("name"),
              aid=rr["aid"])
        return (f"deleted {rr['meta'].get('name')} "
                f"(id {rr['aid']}) — permanent, drawer updates on next open")

    if action == "rename":
        if not str(new_name or "").strip():
            return "rename needs name= (or aid=) and new_name="
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        upd = client.update(rr["aid"], name=str(new_name).strip())
        if "error" in upd:
            return upd["error"]
        m = upd["updated"]
        _emit(log, "artifact_renamed", name=rr["meta"].get("name"),
              new_name=m.get("name"), aid=m.get("id"))
        # the engine echoes the SANITIZED name (sanitizeArtifactName
        # collapses "a.docx.doc"→"a.docx", drops ../, trims >240) — show
        # the stored name, not the requested one, so the model isn't
        # surprised next turn.
        return (f"renamed {rr['meta'].get('name')} → {m.get('name')} "
                f"(id {m.get('id')})")

    if action == "mkdir":
        p = _norm_prefix(path or name)
        if not p:
            return ('mkdir needs path= (folders are name prefixes here — '
                    'e.g. "src/lib")')
        # Engine folders are VIRTUAL (name prefixes only) — a placeholder
        # file is the only way to make one render in the drawer before any
        # real file lands inside it.
        keep = p + "/.keep"
        cr = client.create(keep, "", source="model")
        if "error" in cr:
            return cr["error"]
        _emit(log, "artifact_mkdir", path=p, aid=cr["created"].get("id"))
        return (f"folder {p}/ ready — placeholder {keep} "
                f"(id {cr['created'].get('id')}, 0 B). Engine folders are "
                f"virtual name prefixes: write files under \"{p}/…\" and the "
                f'drawer tree grows them; delete the .keep once real files '
                f"exist "
                f'(artifact(action="delete", name="{keep}")).')

    if action == "download_url":
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        return client.download_url(rr["aid"])

    if action == "preview":
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        pv = client.preview(rr["aid"])
        if "error" in pv:
            return pv["error"]
        return _preview_summary(pv, client, rr["aid"])

    if action == "entry":
        if not str(member or "").strip():
            return ('entry needs member= (a path inside the archive, e.g. '
                    '"src/index.js")')
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        e = client.entry(rr["aid"], str(member))
        if "error" in e:
            return e["error"]
        if e.get("binary"):
            return (f"{e.get('name')} ({_human_size(e.get('size'))}) — binary "
                    f"member; download the archive and unpack locally: "
                    f"{client.download_url(rr['aid'])}")
        t = str(e.get("text") or "")
        flag = " (engine-truncated at 256 KB)" if e.get("truncated") else ""
        body = t[:_BODY_CAP] + (f"\n… (truncated, {len(t)} chars)"
                                if len(t) > _BODY_CAP else "")
        return f"{e.get('name')} ({e.get('size')} B){flag}:\n{body}"

    if action == "extract":
        rr = _resolve_ref(client, name, aid)
        if "error" in rr:
            return _fmt_err(rr)
        ex = client.extract(rr["aid"])
        if "error" in ex:
            return ex["error"]
        _emit(log, "artifact_extracted", from_name=ex.get("from"),
              extracted=ex.get("extracted"))
        return (f"extracted {ex.get('extracted')} member(s) from "
                f"{ex.get('from')} — each is now its own artifact; "
                f'artifact(action="list") to see them')

    return f'unknown action {action!r} — use action="help" for the menu'


# ── strands surface ──────────────────────────────────────────────────────

def build(ctx) -> list:
    """Return the @tool-decorated artifact callable. Never raises; []
    when strands is unavailable (dt_spec rules 1–2). The ArtifactClient is
    constructed here (zero I/O — httpx connects lazily per request) and
    closed over with ctx.engine_url + ctx.chat_session_id."""
    try:
        try:
            from strands import tool as strands_tool_decorator
        except Exception:
            return []  # offline: register nothing

        base = str(getattr(ctx, "engine_url", "") or "http://127.0.0.1:8080")
        sid = getattr(ctx, "chat_session_id", None)
        client = ArtifactClient(base, sid)
        log = getattr(ctx, "log", None)

        @strands_tool_decorator(name="artifact", description=(
            "Create and manage the real downloadable artifacts (files, "
            "folders-by-path, zips/docx/xlsx) of THIS chat via the doomalay "
            "engine. Use it whenever the user wants a produced file — an "
            "app's source files, a CSV/JSON analysis, a markdown report, a "
            "zip — or to fix, rename, delete, inspect, or link one for "
            "download. EDITING is first-class: action='edit' patches an "
            "EXISTING artifact surgically (find/replace, line splices, "
            "inserts, dry_run) — including files created in earlier turns — "
            "without rewriting the whole file. Actions: list, create, read, "
            "write, edit, append, delete, rename, mkdir, download_url, "
            "preview, entry, extract, help. Address artifacts by name (paths "
            "like 'src/main.py') or id."))
        def artifact(action: str, name: str = "", content: str = "",
                     new_name: str = "", aid: str = "", path: str = "",
                     member: str = "", encoding: str = "", find: str = "",
                     replace: str = "", replace_all: bool = False,
                     count: int = 0, lines: str = "", after_line: int = 0,
                     before_line: int = 0, dry_run: bool = False) -> str:
            """Manage this chat's downloadable artifact files.

            action: list|create|read|write|edit|append|delete|rename|mkdir|
                download_url|preview|entry|extract|help
            name: artifact name/path ("report.md", "src/main.py"); matched
                case-insensitively by full name, basename, or suffix
            content: file text for create/write/append; the lines to insert
                for insert-style edits (auto base64 for bytes on create)
            new_name: new name/path for rename
            aid: artifact id (12 hex chars) as an alternative to name
            path: folder prefix for list; folder path for mkdir
            member: path of a file inside an archive (for entry)
            encoding: "" (auto) | "utf8" | "base64"
            find: edit — exact text span to replace (must be unique unless
                replace_all/count; add surrounding lines to disambiguate)
            replace: edit — the replacement text (for find/replace and
                lines= splices)
            replace_all: edit — replace EVERY occurrence of find
            count: edit — replace the first N occurrences
            lines: edit — 1-based line range to splice, e.g. "5-9" or "7"
            after_line: edit — insert content AFTER this line (1-based)
            before_line: edit — insert content BEFORE this line
            dry_run: edit — preview the diff without writing
            """
            return run_action(client, action, name=name, content=content,
                              new_name=new_name, aid=aid, path=path,
                              member=member, encoding=encoding, find=find,
                              replace=replace, replace_all=replace_all,
                              count=count, lines=lines,
                              after_line=after_line,
                              before_line=before_line, dry_run=dry_run,
                              log=log)

        return [artifact]
    except Exception:
        return []


# ── offline self-test (dt_spec rule 7) ───────────────────────────────────

if __name__ == "__main__":
    import types

    # 1) pure helpers — no httpx, no network
    arts = [
        {"id": "aaaaaaaaaaaa", "name": "README.md", "mime": "text/markdown",
         "encoding": "utf8", "size": 340, "source": "model"},
        {"id": "bbbbbbbbbbbb", "name": "src/main.py", "mime": "text/x-python",
         "encoding": "utf8", "size": 1024, "source": "model"},
        {"id": "cccccccccccc", "name": "src/lib/util.go", "mime": "text/x-go",
         "encoding": "utf8", "size": 99, "source": "model"},
    ]
    lines = _tree_lines(arts)
    assert lines[0].startswith("[dir]  src/"), lines  # folders first
    assert "(2 files" in lines[0] and "1.1 KB" in lines[0]
    assert any("util.go" in ln and "id cccccccccccc" in ln for ln in lines)
    assert any("README.md" in ln and "id aaaaaaaaaaaa" in ln for ln in lines)
    assert "  " in lines[-2]  # nested file indented under its folder
    assert _human_size(7000) == "6.8 KB" and _human_size(100) == "100 B"
    assert _norm_prefix("./src/") == "src" and _norm_prefix("\\x\\") == "x"
    assert _natural_key("f10") > _natural_key("f2")

    # 2) HTTP round trip over httpx.MockTransport — shapes per artifacts.go
    import httpx

    store: dict = {}      # aid → {meta, text} — the fake session drawer
    seq = [0]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/artifacts"):
            import json as _j
            body = _j.loads(request.content)
            # exact create-body keys the Go handler decodes
            assert set(body.keys()) == {"name", "content", "encoding", "source"}, body
            seq[0] += 1
            meta = {"id": f"{seq[0]:012x}", "name": body["name"],
                    "mime": "text/plain", "encoding": body["encoding"],
                    "size": len(body["content"].encode()),
                    "source": body["source"], "created_at": 1.0,
                    "updated_at": 1.0}
            store[meta["id"]] = {"meta": meta, "text": body["content"]}
            return httpx.Response(201, json=meta)
        if request.method == "GET" and request.url.path.endswith("/artifacts"):
            return httpx.Response(200, json={"artifacts":
                                             [v["meta"] for v in store.values()]})
        m = re.search(r"/artifacts/([a-f0-9]{12})$", request.url.path)
        if m and request.method == "GET":
            v = store.get(m.group(1))
            if not v:
                return httpx.Response(404, json={"error": "artifact not found"})
            out = dict(v["meta"], content=v["text"])
            return httpx.Response(200, json=out)
        if m and request.method == "PUT":
            import json as _j
            v = store.get(m.group(1))
            if not v:
                return httpx.Response(404, json={"error": "artifact not found"})
            body = _j.loads(request.content)
            if "content" in body:
                v["text"] = body["content"]
                v["meta"]["size"] = len(body["content"].encode())
            return httpx.Response(200, json=v["meta"])
        if m and request.method == "DELETE":
            if m.group(1) not in store:
                return httpx.Response(404, json={"error": "artifact not found"})
            store.pop(m.group(1))
            return httpx.Response(200, json={"deleted": True})
        return httpx.Response(404, json={"error": "not found"})

    client = ArtifactClient("http://eng.test", "s1",
                            transport=httpx.MockTransport(handler))
    out = run_action(client, "create", name="hello.txt", content="hi")
    assert "created hello.txt" in out and "id 000000000001" in out, out
    out = run_action(client, "list")
    assert "hello.txt" in out and "1 artifact" in out, out
    out = run_action(client, "read", name="hello.txt")
    assert out.endswith("hi"), out
    out = run_action(client, "append", name="hello.txt", content="there")
    assert "appended" in out
    out = run_action(client, "read", name="hello.txt")
    assert out.endswith("hi\nthere"), out  # smart separator fired

    # v0.44 — the EDIT action (surgical patches on existing artifacts)
    # pure helpers first
    assert parse_line_spec("5-9") == (5, 9) and parse_line_spec("7") == (7, 7)
    assert parse_line_spec(" 3 .. 5 ") == (3, 5) and parse_line_spec("x") == (0, 0)
    t = "alpha\nbeta\ngamma\nbeta"
    nt, n = apply_find_replace(t, "beta", "BETA")          # ambiguous → refused
    assert nt == t and isinstance(n, str) and "2x" in n, n
    nt, n = apply_find_replace(t, "beta", "BETA", replace_all=True)
    assert nt == "alpha\nBETA\ngamma\nBETA" and n == 2
    nt, n = apply_find_replace(t, "gamma", "G")             # unique → ok
    assert nt.count("G") == 1 and n == 1
    nt, n = apply_find_replace(t, "nope", "x")
    assert isinstance(n, str) and "not present" in n
    assert apply_line_splice(t, 2, 3, "X\nY") == "alpha\nX\nY\nbeta"
    assert apply_line_splice(t, 2, 99, "") == "alpha"       # end clamps at EOF
    assert apply_insert_at_line(t, "NEW", after_line=1) == "alpha\nNEW\nbeta\ngamma\nbeta"
    assert apply_insert_at_line(t, "NEW", before_line=1) == "NEW\nalpha\nbeta\ngamma\nbeta"
    assert apply_insert_at_line(t, "END") == t + "\nEND"
    assert "-beta" in _diff_summary(t, t.replace("beta", "BETA", 1), "t.txt")
    # through the dispatcher: unique find/replace
    out = run_action(client, "edit", name="hello.txt", find="there", replace="world")
    assert "edited hello.txt" in out and "+world" in out and "-there" in out, out
    out = run_action(client, "read", name="hello.txt")
    assert out.endswith("hi\nworld"), out
    # ambiguous find → refused with count, file UNCHANGED
    out = run_action(client, "create", name="two.txt", content="same\nsame")
    out = run_action(client, "edit", name="two.txt", find="same", replace="x")
    assert "2x" in out, out
    out = run_action(client, "read", name="two.txt")
    assert out.endswith("same\nsame"), out
    # replace_all + line splice + insert + dry_run
    out = run_action(client, "edit", name="two.txt", find="same", replace="diff",
                     replace_all=True)
    assert "2 occurrence" in out, out
    out = run_action(client, "edit", name="two.txt", lines="1", replace="first")
    assert "splice lines 1-1" in out, out
    out = run_action(client, "edit", name="two.txt", after_line=1, content="inserted")
    assert "insert after line 1" in out, out
    out = run_action(client, "read", name="two.txt")
    assert "inserted" in out, out
    out = run_action(client, "edit", name="two.txt", find="inserted", replace="zzz",
                     dry_run=True)
    assert "DRY RUN" in out, out
    out = run_action(client, "read", name="two.txt")
    assert "inserted" in out and "zzz" not in out, out  # nothing written

    out = run_action(client, "delete", name="hello.txt")
    assert "deleted hello.txt" in out
    out = run_action(client, "list")
    assert "two.txt" in out and "hello.txt" not in out, out  # hello gone, two.txt survives

    # no-session guard fires before any HTTP
    nosess = ArtifactClient("http://eng.test", None,
                            transport=httpx.MockTransport(handler))
    assert run_action(nosess, "list") == NO_SESSION

    # build() without strands registers nothing and never raises
    fake_ctx = types.SimpleNamespace(engine_url="http://eng.test",
                                     chat_session_id="s1", log=None)
    assert build(fake_ctx) == []

    # help is the model's first call
    assert "Actions:" in run_action(client, "help")
    print("dt_artifact SELF-TEST OK")
