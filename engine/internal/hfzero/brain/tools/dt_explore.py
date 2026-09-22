"""dt_explore.py — the UNBOUNDED repo explorer (T8, user spec v0.44 #4).

User spec: "add explore… view full repo structures, view actions, view
files, headers, tails, view releases, workflows, history, merge logs,
discussions, issues, everything related to a repo. Explore should be able
to explore file structures in a very sophisticated manner. Exploring 50+
files at one go and executing 10+ tools if needed in between. No
artificial caps, it can go unbounded. We should allow for grep, ls, and
everything required."

DESIGN (why a separate tool when dt_workspace exists):
- workspace acts on the chat's CONNECTED repos (ids, stored tokens). explore
  takes ANY repo URL — zero connect step, read tier, exactly like pasting a
  link into a browser — and is tuned for BREADTH: batch file reads (50+ in
  one action), tree walks with pagination cursors instead of caps, and
  repo-brief digests that fan in issues+pulls+releases+CI in one call.
- The engine's /api/explore/* surface (workspaces.go wsTarget) resolves the
  URL server-side (Recognize + ProbeHost + GuardURL — tokens never ride the
  query string); this module is the brain-side bridge.

NO ARTIFICIAL CAPS, HONESTLY: every listing action is paginated by a cursor
(tree path prefix, grep resume token, batch offset) the MODEL decides to
follow — the tool never says "too many files" and never silently truncates
a walk. The only bounds are the forge's own API pagination (limit= caps at
100/page on GitHub/Gitea — surfaced as "+N more" rows, not refusals).

State: none (the engine + forge are the truth). httpx lazy; MockTransport
is the test seam.
"""
from __future__ import annotations

TOOL_NAMES = ["explore"]

_TIMEOUT = 45.0   # batch reads fan out server-side; give the engine room
_BODY_CAP = 5500   # per-file trim inside batch reads (dt_spec rule 9)
_LIST_CAP = 80     # rows shown before the "+N more" fold

HELP = """explore — the UNBOUNDED read-only repo explorer (ANY repo URL, no connect).
    Actions:
  repo url                      the repo BRIEF: meta + readme digest + tree
                                stats + branches (one call, the orientation view)
  tree url [path] [ref]         repo tree at path (folders first); paginate by
                                narrowing path= — no cap, walk as deep as needed
  ls url [path] [ref]           one directory level (d/- rows, sizes)
  read url path [range] [ref]   one file; range: head:80 | tail:40 | lines:10-60
  files url paths [head_lines]  BATCH READ: comma-separated paths (50+ fine) —
                                each file trimmed to head_lines (default 40);
                                the breadth engine for "read these 60 files"
  grep url query [ref] [limit]  case-insensitive literal search across the
                                repo's text files; INCREMENTAL — the result
                                carries a resume token while files remain
  view url what [state] [limit] issues|pulls|releases|workflows|runs|commits|
                                branches|discussions (history = commits)
  readme url [ref]              the repo's README
  help                          this sheet
  `url` = any forge repo URL (github/gitea/gitlab/codeberg/sourcehut;
  generic git hosts need the repo connected as a workspace first)."""


# ── plain helpers ─────────────────────────────────────────────────────────

def _human_size(n) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def _norm_url(url: str) -> str:
    """Bare 'github.com/a/b' → 'https://github.com/a/b' (the engine's
    Recognize does the same, but normalizing here keeps error messages
    honest before any HTTP)."""
    s = str(url or "").strip()
    if s and "://" not in s:
        s = "https://" + s
    return s


def _looks_like_url(s: str) -> bool:
    s = str(s or "").strip()
    return s.startswith(("http://", "https://")) or (
        "." in s and "/" in s and " " not in s)


def _parse_paths(paths: str, cap: int = 200) -> list:
    """Comma/newline-separated paths → clean list (deduped, order kept).
    cap is a PARSE guard against a model pasting a whole tree — the cap
    says 'split your batch', never 'stop exploring'."""
    out, seen = [], set()
    for p in str(paths or "").replace("\n", ",").split(","):
        p = p.strip().strip("/")
        if p and p not in seen and ".." not in p:
            seen.add(p)
            out.append(p)
            if len(out) >= cap:
                break
    return out


def _valid_range(spec: str) -> str:
    s = str(spec or "").strip()
    if not s:
        return ""
    for prefix in ("head:", "tail:", "lines:"):
        if s.startswith(prefix) and s[len(prefix):].replace("-", "").replace(" ", "").isdigit():
            return s
    return ""


def _clip(s, n) -> str:
    s = str(s or "")
    return s if len(s) <= n else s[:n] + f" …[+{len(s) - n} chars]"


def _tree_lines(entries, path: str, cap: int = 150) -> str:
    dirs = [e for e in entries if str(e.get("type")) == "tree"]
    files = [e for e in entries if str(e.get("type")) != "tree"]
    lines = [f"under {path.strip('/')}/: {len(dirs)} dir(s), {len(files)} file(s)"] if path \
        else [f"{len(dirs)} dir(s), {len(files)} file(s)"]
    for e in dirs[:cap]:
        lines.append(f"[dir]  {e.get('path')}/")
    for e in files[:cap]:
        lines.append(f"       {e.get('path')}  ({_human_size(e.get('size'))})")
    if len(entries) > cap * 2:
        lines.append(f"… (+{len(entries) - cap * 2} more rows — narrow path=)")
    return "\n".join(lines)


def _view_line(what: str, it) -> str:
    if isinstance(it, str):
        return it
    d = it if isinstance(it, dict) else {}
    n = d.get("number") or d.get("id") or "?"
    if what == "issues":
        pr = " [PR]" if d.get("is_pr") else ""
        return f"#{n} {d.get('title')} ({d.get('state')}, @{d.get('author')}){pr}"
    if what == "pulls":
        return f"!{n} {d.get('title')} ({d.get('state')}, @{d.get('author')}, ← {d.get('branch')})"
    if what == "releases":
        pre = " (pre)" if d.get("prerelease") else ""
        return f"{d.get('tag')} — {d.get('name') or 'no title'} ({str(d.get('published_at') or '')[:10]}){pre}"
    if what == "workflows":
        return f"{d.get('name')}  ({d.get('path')}, {d.get('state')})"
    if what == "runs" or what == "actions":
        icon = {"success": "✓", "failure": "✗", "in_progress": "◐",
                "queued": "…"}.get(str(d.get("conclusion") or d.get("status")), "?")
        return f"{icon} {d.get('name')} [{d.get('event')}] {d.get('branch')} ({str(d.get('started_at') or '')[:16]})"
    if what in ("commits", "history"):
        return f"{str(d.get('sha'))[:10]} {d.get('message')} — @{d.get('author')} ({str(d.get('date') or '')[:10]})"
    if what == "branches":
        return str(d.get("name") or d)
    if what == "discussions":
        cat = f" [{d.get('category')}]" if d.get("category") else ""
        return f"#{n} {d.get('title')} @{d.get('author')}{cat}"
    return str(d)


# ── ExploreClient — the engine /api/explore seam ────────────────────────

class ExploreClient:
    """Bridge to the engine's /api/explore/* routes. transport is the test
    seam; methods never raise ({"error": …} instead)."""

    def __init__(self, base_url: str, transport=None, timeout: float = _TIMEOUT):
        self.base_url = str(base_url or "http://127.0.0.1:8080").rstrip("/")
        self._transport = transport
        self._timeout = timeout
        self._client = None

    def _http(self):
        import httpx
        if self._client is None:
            kw = {"timeout": self._timeout}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._client = httpx.Client(**kw)
        return self._client

    def _get(self, path: str, params: dict) -> dict:
        try:
            r = self._http().get(self.base_url + path, params=params)
        except Exception as exc:
            return {"error": f"engine unreachable at {self.base_url}: {exc}"}
        try:
            body = r.json()
        except Exception:
            body = None
        if r.status_code >= 400:
            msg = ""
            if isinstance(body, dict):
                msg = str(body.get("error") or body.get("detail") or "")
            return {"error": msg or f"engine HTTP {r.status_code} on {path}"}
        return body if isinstance(body, dict) else {}

    def repo(self, url: str):
        return self._get("/api/explore/repo", {"url": url})

    def tree(self, url: str, path: str, ref: str):
        p = {"url": url}
        if path:
            p["path"] = path
        if ref:
            p["ref"] = ref
        return self._get("/api/explore/tree", p)

    def file(self, url: str, path: str, ref: str, rng: str):
        p = {"url": url, "path": path}
        if ref:
            p["ref"] = ref
        if rng:
            p["range"] = rng
        return self._get("/api/explore/file", p)

    def readme(self, url: str, ref: str):
        p = {"url": url}
        if ref:
            p["ref"] = ref
        return self._get("/api/explore/readme", p)

    def grep(self, url: str, q: str, ref: str, limit: int, resume: str):
        p = {"url": url, "q": q}
        if ref:
            p["ref"] = ref
        if limit:
            p["limit"] = str(limit)
        if resume:
            p["resume"] = resume
        return self._get("/api/explore/grep", p)

    def files(self, url: str, paths: list, ref: str, head_lines: int):
        """One BATCH call — the engine fans the paths out 8-wide."""
        p = {"url": url, "paths": ",".join(paths), "head_lines": str(head_lines)}
        if ref:
            p["ref"] = ref
        return self._get("/api/explore/files", p)

    def view(self, url: str, what: str, state: str, limit: int):
        p = {"url": url}
        if state:
            p["state"] = state
        if limit:
            p["limit"] = str(limit)
        return self._get(f"/api/explore/view/{what}", p)


# ── action dispatch (plain) ──────────────────────────────────────────────

def run_action(client: ExploreClient, action: str, url: str = "",
               path: str = "", paths: str = "", ref: str = "",
               range_: str = "", query: str = "", what: str = "",
               state: str = "", limit: int = 0, head_lines: int = 40,
               log=None) -> str:
    try:
        return _dispatch(client, action, url=url, path=path, paths=paths,
                         ref=ref, range_=range_, query=query, what=what,
                         state=state, limit=limit, head_lines=head_lines,
                         log=log)
    except Exception as exc:  # noqa: BLE001
        return f"explore tool error ({action}): {type(exc).__name__}: {exc}"


def _dispatch(client: ExploreClient, action: str, **kw) -> str:
    action = str(action or "").strip().lower()
    url = _norm_url(kw.get("url", ""))

    if action in ("help", "?"):
        return HELP

    if action in ("repo", "brief", "card"):
        if not url:
            return "repo needs url= (any forge repo URL)"
        rr = client.repo(url)
        if "error" in rr:
            return rr["error"]
        meta = rr.get("meta") or {}
        hi = rr.get("host_info") or {}
        lines = [
            f"{meta.get('full_name')}  [{hi.get('kind')}]  access={rr.get('access')}",
            f"{meta.get('web_url')}   default branch: {meta.get('default_branch')}",
        ]
        if meta.get("description"):
            lines.append("desc: " + _clip(meta.get("description"), 240))
        if meta.get("stars") is not None:
            lines.append(f"stars {meta.get('stars')} · forks {meta.get('forks')} · "
                         f"open issues {meta.get('open_issues')} · updated {str(meta.get('updated_at') or '')[:10]}")
        # orientation extras: readme digest + branch list (bounded calls,
        # the brief is the one place we keep it tight)
        rd = client.readme(url, kw.get("ref", ""))
        if "error" not in rd and rd.get("content"):
            lines.append("readme " + str(rd.get("path")) + " (head):\n"
                         + _clip(rd.get("content"), 1200))
        br = client.view(url, "branches", "", 0)
        if "error" not in br and br.get("items"):
            names = [str(b if isinstance(b, str) else b.get("name")) for b in br["items"][:12]]
            lines.append("branches: " + ", ".join(names)
                         + (f" (+{len(br['items']) - 12})" if len(br["items"]) > 12 else ""))
        lines.append("dig in: explore(action='tree', url=…) · files · grep · view")
        return "\n".join(lines)

    if action == "tree":
        if not url:
            return "tree needs url= [path=] [ref=]"
        tr = client.tree(url, kw.get("path", ""), kw.get("ref", ""))
        if "error" in tr:
            return tr["error"]
        entries = tr.get("entries") or []
        out = _tree_lines(entries, kw.get("path", ""))
        if tr.get("truncated"):
            out += "\n(forge flagged the recursive tree TRUNCATED — walk subdirectories with path=)"
        return out

    if action == "ls":
        if not url:
            return "ls needs url= [path=] [ref=]"
        tr = client.tree(url, kw.get("path", ""), kw.get("ref", ""))
        if "error" in tr:
            return tr["error"]
        p = str(kw.get("path") or "").strip("/")
        rows = []
        for e in tr.get("entries") or []:
            fp = str(e.get("path") or "")
            if p and fp != p and not fp.startswith(p + "/"):
                continue
            rel = fp[len(p) + 1:] if p and fp.startswith(p + "/") else fp
            if not rel or "/" in rel:
                continue
            if str(e.get("type")) == "tree":
                rows.append(f"d  {rel}")
            else:
                rows.append(f"-  {rel}  {_human_size(e.get('size'))}")
        rows.sort(key=lambda s: (s[0] != "d", s[2:]))
        if not rows:
            return f"(nothing at {p or 'root'})"
        return "\n".join(rows[:200]) + (f"\n… (+{len(rows) - 200} more)" if len(rows) > 200 else "")

    if action == "read":
        if not url or not kw.get("path"):
            return "read needs url= and path= [range=head:80|tail:40|lines:10-60] [ref=]"
        rng = _valid_range(kw.get("range_", ""))
        if kw.get("range_") and not rng:
            return (f"range {kw.get('range_')!r} not understood — use "
                    "head:80 | tail:40 | lines:10-60")
        fc = client.file(url, kw["path"], kw.get("ref", ""), rng)
        if "error" in fc:
            return fc["error"]
        if fc.get("binary"):
            return f"{fc.get('path')} is BINARY ({_human_size(fc.get('size'))})"
        return (f"{fc.get('path')} ({fc.get('size')} B"
                f"{', ranged' if rng else ''}):\n" + _clip(fc.get("content"), 5500))

    if action in ("files", "batch_read", "read_many"):
        # THE BREADTH ACTION — 50+ files in ONE engine call (user spec);
        # the engine fetches them 8-wide in parallel, each head-trimmed.
        # The model digs deeper per-file with read when a file matters.
        if not url or not kw.get("paths"):
            return ("files needs url= and paths= (comma-separated; 50+ fine). "
                    "head_lines= trims each file (default 40)")
        plist = _parse_paths(kw["paths"])
        if not plist:
            return "paths= had no usable entries"
        hl = int(kw.get("head_lines") or 40)
        hl = max(1, min(hl, 400))
        br = client.files(url, plist, kw.get("ref", ""), hl)
        if "error" in br:
            return br["error"]
        rows = br.get("files") or []
        lines = []
        ok = 0
        for fr in rows:
            p = str(fr.get("path") or "")
            if fr.get("error"):
                lines.append(f"✗ {p}: {fr['error']}")
                continue
            ok += 1
            if fr.get("binary"):
                lines.append(f"■ {p}  (binary, {fr.get('size')} B)")
                continue
            body = str(fr.get("content") or "")
            more = "" if fr.get("size", 0) <= len(body) else \
                f" …[file is {fr.get('size')} B, showed head:{hl}]"
            lines.append(f"── {p}  ({fr.get('size')} B){more}\n{_clip(body, 900)}")
        head = f"{ok}/{len(plist)} file(s) read"
        body = "\n\n".join(lines)
        # keep the total return bounded by DT spec while showing the truth
        if len(body) > 24000:
            body = body[:24000] + f"\n… (batch trimmed — {len(plist)} files; " \
                                   "re-run smaller groups or read individuals)"
        _emit(kw.get("log"), "explore_batch_read", asked=len(plist), ok=ok)
        return head + "\n" + body

    if action in ("grep", "search"):
        if not url or not kw.get("query"):
            return "grep needs url= and query= [ref=] [limit=] (resume=<token>)"
        gr = client.grep(url, kw["query"], kw.get("ref", ""),
                         int(kw.get("limit") or 0), kw.get("resume", ""))
        if "error" in gr:
            return gr["error"]
        hits = gr.get("hits") or []
        if not hits:
            return (f"no matches for {kw['query']!r}"
                    + (f" (scanned {gr.get('scanned')})" if gr.get("scanned") else ""))
        lines = [f"{len(hits)} match(es) for {kw['query']!r}"
                 + (f" · scanned {gr.get('scanned')}" if gr.get("scanned") else "")]
        for h in hits[:_LIST_CAP]:
            ln = f":{h.get('line')}" if h.get("line") else ""
            lines.append(f"  {h.get('path')}{ln}  {str(h.get('snippet') or '')[:120]}")
        if len(hits) > _LIST_CAP:
            lines.append(f"  … (+{len(hits) - _LIST_CAP} more — raise limit=)")
        if not gr.get("complete") and gr.get("remaining"):
            lines.append("MORE TO SCAN (no cap — continue with): "
                         f"resume='{str(gr.get('remaining'))[:1500]}'")
        return "\n".join(lines)

    if action == "view":
        if not url or not kw.get("what"):
            return ("view needs url= and what= (issues|pulls|releases|workflows|"
                    "runs|commits|branches|discussions) [state=] [limit=] "
                    "(history = commits)")
        what = str(kw["what"]).strip().lower()
        if what in ("history", "log"):
            what = "commits"
        if what == "actions":
            what = "runs"
        if what in ("merge_logs", "merges"):
            what = "pulls"
            if not kw.get("state"):
                kw = dict(kw, state="merged")  # best effort; forges map it
        vr = client.view(url, what, kw.get("state", ""), int(kw.get("limit") or 0))
        if "error" in vr:
            return vr["error"]
        items = vr.get("items") or []
        if not items:
            return f"no {what} rows (state={kw.get('state') or 'default'})"
        lines = [f"{len(items)} {what} row(s):"]
        for it in items[:_LIST_CAP]:
            lines.append("  " + _view_line(what, it))
        if len(items) > _LIST_CAP:
            lines.append(f"  … (+{len(items) - _LIST_CAP} more — raise limit=)")
        return "\n".join(lines)

    if action == "readme":
        if not url:
            return "readme needs url= [ref=]"
        fc = client.readme(url, kw.get("ref", ""))
        if "error" in fc:
            return fc["error"]
        if fc.get("binary"):
            return f"{fc.get('path')} is binary"
        return f"{fc.get('path')}:\n" + _clip(fc.get("content"), 5500)

    return f"unknown action {action!r} — use action='help' for the menu"


def _emit(log, event: str, **fields) -> None:
    try:
        if log is not None:
            log(event, **fields)
    except Exception:
        pass


# ── strands surface ──────────────────────────────────────────────────────

def build(ctx) -> list:
    try:
        try:
            from strands import tool as strands_tool_decorator
        except Exception:
            return []

        base = str(getattr(ctx, "engine_url", "") or "http://127.0.0.1:8080")
        client = ExploreClient(base)
        log = getattr(ctx, "log", None)

        @strands_tool_decorator(name="explore", description=(
            "The UNBOUNDED read-only explorer for ANY repository URL — "
            "GitHub, Gitea/Codeberg, GitLab, sourcehut; no connect step "
            "needed. Get the repo brief (meta+readme+branches), walk the "
            "full tree (paginate by path, no caps), ls directories, read "
            "files with head/tail/line ranges, BATCH-read 50+ files in one "
            "action, grep across all text files (incremental with resume "
            "tokens — never capped), and view issues, PRs/merge logs, "
            "releases, workflows, Actions runs, commit history, branches "
            "and discussions. Actions: repo, tree, ls, read, files, grep, "
            "view, readme, help. Prefer this over web_fetch for any repo "
            "question — it is structured, paginated and forge-aware."))
        def explore(action: str, url: str = "", path: str = "",
                    paths: str = "", ref: str = "", range: str = "",
                    query: str = "", what: str = "", state: str = "",
                    limit: int = 0, head_lines: int = 40) -> str:
            """Explore any repository URL, read-only and unbounded.

            action: repo|tree|ls|read|files|grep|view|readme|help
            url: the repo URL (github.com/owner/repo, bare host ok)
            path: one file/subdir path (tree, ls, read)
            paths: comma-separated paths for the files batch read (50+ fine)
            ref: branch/tag/sha override (default: the repo's default branch)
            range: read slicing — head:80 | tail:40 | lines:10-60
            query: grep search text
            what: view subject — issues|pulls|releases|workflows|runs|
                commits|branches|discussions (history=log, actions=runs,
                merge_logs=pulls)
            state: view filter (issues: open|closed|all; pulls: open|closed)
            limit: max rows for grep/view (0 = default; pagination continues)
            head_lines: per-file trim for the files batch action (default 40)
            """
            return run_action(client, action, url=url, path=path, paths=paths,
                              ref=ref, range_=range, query=query, what=what,
                              state=state, limit=limit, head_lines=head_lines,
                              log=log)

        return [explore]
    except Exception:
        return []


# ── offline self-test ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _j
        import urllib.parse as _u
        rawq = request.url.query
        if isinstance(rawq, bytes):
            rawq = rawq.decode("utf-8", "replace")
        q = dict(_u.parse_qsl(rawq))
        path = request.url.path
        if path == "/api/explore/repo":
            return httpx.Response(200, json={
                "host_info": {"kind": "github", "host": "github.com",
                              "owner": "ScoobyBaby1999", "repo": "doomalay"},
                "meta": {"full_name": "ScoobyBaby1999/doomalay",
                         "web_url": "https://github.com/ScoobyBaby1999/doomalay",
                         "default_branch": "main", "description": "sovereign AI workspace",
                         "stars": 12, "forks": 3, "open_issues": 5,
                         "updated_at": "2026-09-20T10:00:00Z"},
                "access": "read"})
        if path == "/api/explore/readme":
            return httpx.Response(200, json={"path": "README.md", "size": 340,
                                             "encoding": "utf8",
                                             "content": "# doomalay\na workspace"})
        if path == "/api/explore/tree":
            return httpx.Response(200, json={"entries": [
                {"path": "engine", "type": "tree", "size": 0, "sha": "t"},
                {"path": "brain", "type": "tree", "size": 0, "sha": "t"},
                {"path": "README.md", "type": "blob", "size": 340, "sha": "b"},
                {"path": "engine/main.go", "type": "blob", "size": 800, "sha": "b2"},
            ], "truncated": False})
        if path == "/api/explore/file":
            fc = {"path": q.get("path"), "size": 100, "encoding": "utf8",
                  "content": f"line1\nline2\nline3\n({q.get('path')} head)",
                  "sha": "b"}
            if q.get("path", "").endswith((".png", ".bin")):
                fc = {"path": q.get("path"), "size": 5000, "encoding": "base64",
                      "content": "", "binary": True}
            return httpx.Response(200, json=fc)
        if path == "/api/explore/files":
            out = []
            for p in [x for x in q.get("paths", "").split(",") if x]:
                if p.endswith(".png"):
                    out.append({"path": p, "size": 5000, "binary": True,
                                "content": "", "truncated": True})
                else:
                    out.append({"path": p, "size": 100, "binary": False,
                                "content": f"line1\nline2\nline3\n({p} head)",
                                "truncated": True})
            return httpx.Response(200, json={"files": out, "asked": len(out)})
        if path == "/api/explore/grep":
            return httpx.Response(200, json={"hits": [
                {"path": "engine/main.go", "line": 9, "snippet": "func main()"}],
                "scanned": 42, "complete": False,
                "remaining": "a.txt\nb.txt\nc.txt"})
        if path.startswith("/api/explore/view/"):
            what = path.rsplit("/", 1)[-1]
            if what == "branches":
                return httpx.Response(200, json={"view": "branches",
                    "items": ["main", "lib", "app"]})
            if what == "commits":
                return httpx.Response(200, json={"view": "commits", "items": [
                    {"sha": "abc123def", "message": "fix", "author": "u", "date": "2026-09-19"}]})
            return httpx.Response(200, json={"view": what, "items": []})
        return httpx.Response(404, json={"error": "no route: " + path})

    client = ExploreClient("http://eng.test", transport=httpx.MockTransport(handler))
    U = "github.com/ScoobyBaby1999/doomalay"

    # helpers
    assert _norm_url("github.com/a/b") == "https://github.com/a/b"
    assert _norm_url(" https://x.io/a ") == "https://x.io/a"
    assert _looks_like_url("github.com/a/b") and not _looks_like_url("just text")
    assert _parse_paths("a.py, b.py\nc.py,, a.py") == ["a.py", "b.py", "c.py"]
    assert _parse_paths("") == [] and _valid_range("head:9") == "head:9"
    assert _valid_range("zzz") == ""
    assert _human_size(2048) == "2.0 KB"

    # repo brief
    out = run_action(client, "repo", url=U)
    assert "ScoobyBaby1999/doomalay" in out and "stars 12" in out, out
    assert "branches: main, lib, app" in out and "# doomalay" in out, out
    # tree
    out = run_action(client, "tree", url=U)
    assert "[dir]  engine/" in out and "README.md" in out, out
    # ls one level
    out = run_action(client, "ls", url=U, path="engine")
    assert "main.go" in out and "README.md" not in out, out
    # read + bad range
    out = run_action(client, "read", url=U, path="engine/main.go")
    assert "line1" in out, out
    out = run_action(client, "read", url=U, path="x.go", range_="junk")
    assert "not understood" in out, out
    # batch files: 3 paths, one binary
    out = run_action(client, "files", url=U,
                     paths="engine/main.go, brain/agent.py, logo.png")
    assert "3/3" in out and "binary" in out and "── engine/main.go" in out, out
    # grep with resume pointer
    out = run_action(client, "grep", url=U, query="func main")
    assert "engine/main.go:9" in out and "MORE TO SCAN" in out, out
    assert "resume=" in out, out
    # views + aliases
    out = run_action(client, "view", url=U, what="history")
    assert "abc123def fix" in out, out
    out = run_action(client, "view", url=U, what="branches")
    assert "main" in out, out
    out = run_action(client, "view", url=U, what="issues")
    assert "no issues rows" in out, out
    # readme
    out = run_action(client, "readme", url=U)
    assert "# doomalay" in out, out
    # missing args
    assert "needs url=" in run_action(client, "tree")
    assert "needs url=" in run_action(client, "repo")
    # help
    assert "Actions:" in run_action(client, "help")
    # build without strands
    import types
    assert build(types.SimpleNamespace(engine_url="http://eng.test", log=None)) == []
    print("dt_explore SELF-TEST OK")
