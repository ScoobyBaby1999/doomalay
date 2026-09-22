"""dt_workspace.py — act on this chat's CONNECTED cloud workspaces (T7).

User spec v0.44 #3: "allow the user to connect a workspace and then use
quick chat to edit, create, explore, and build on the workspace depending
on the access type". The ENGINE holds the workspace rows + tokens (vault);
this tool bridges the brain to the engine REST surface (workspaces.go) the
same way dt_artifact bridges the artifacts surface — ids only, credentials
never cross into the brain.

REST surface this module bridges (read in full from server/workspaces.go):
    GET    /api/workspaces                          → {"workspaces":[…]}
    GET    /api/workspaces/{id}                     → meta + bound sessions
    POST   /api/workspaces/{id}/token               {token}  → re-probe access
    GET    /api/workspaces/{id}/tree?path=&ref=     → {"entries":[…], "truncated"}
    GET    /api/workspaces/{id}/file?path=&ref=&range=head:N|tail:N|lines:A-B
    GET    /api/workspaces/{id}/readme?ref=
    GET    /api/workspaces/{id}/grep?q=&ref=&limit=&resume=
    GET    /api/workspaces/{id}/view/{issues|pulls|releases|workflows|runs|
                                     commits|branches|discussions}?state=&limit=
    PUT    /api/workspaces/{id}/file                {path, content, message, branch, sha?}
    POST   /api/workspaces/{id}/fork
    POST   /api/workspaces/{id}/clone
    POST   /api/workspaces/create-repo              {kind, name, description,
                                                     license, gitignore, private}
    GET    /api/workspaces/discover?kind=&limit=    → the token account's repos

ACCESS MODEL (user spec: "a difference between read only, partial access,
and full access"):
    read    → tree/ls/read/grep/views only
    partial → + fork (write lands in the user's own copy via PR)
    full    → + write (PUT file = an API commit; no local clone needed —
              this is what makes Android-APK quick chat able to EDIT repos)

State: none — this module is a stateless bridge (engine rows are the truth;
ToolContext.workspaces carries the bound ids). httpx imports lazily
(dt_spec rule 1); tests inject httpx.MockTransport as the seam.
"""
from __future__ import annotations

TOOL_NAMES = ["workspace"]

_TIMEOUT = 30.0    # forge calls proxy provider APIs (GitHub ~1-3s typical)
_READ_CAP = 6000   # dt_spec rule 9: model-facing text ≤ ~6000 chars
_LIST_CAP = 60     # rows shown for list/views before the "+N more" fold

NO_WS = ("no cloud workspace bound to this chat — the user connects one "
         "from the chat header's +workspace pill (or pass url= to act on "
         "any repo by URL where noted)")

HELP = """workspace — act on this chat's CONNECTED cloud repos (any forge).
    Actions:
  list                      the chat's bound workspaces (id, access, branch)
  info ws                   one workspace's card (meta + bound chats)
  tree ws [path] [ref]      repo tree at path (folders + files + sizes)
  ls ws [path] [ref]        directory-style listing (one level)
  read ws path [range]      file content; range: head:80 | tail:40 | lines:10-60
  readme ws [ref]           the repo's README
  grep ws query [ref] [limit]  case-insensitive search across the repo's
                            text files; paginated — resume with the token
                            the result carries (no artificial cap)
  view ws what [state] [limit]  issues|pulls|releases|workflows|runs|
                            commits|branches|discussions
  write ws path content [message] [branch]  API-commit a file (needs
                            full access; the CURRENT sha is fetched for you)
  create ws-ish → create_repo kind name [description] [license] [gitignore]
                            [private] — fresh repo from scratch
  fork ws                   fork into the user's account (partial/read upgrade)
  clone ws                  local blobless clone (needs git on the host)
  discover [kind]           the token account's own repos (clone-and-work)
  attach_token ws token     attach/replace a repo token (upgrades access)
  help                      this sheet
  `ws` = workspace id (12 hex) OR owner/repo OR bare repo name.
  Access: read=browse, partial=+fork/PR, full=+write. Explore ANY repo
  (connected or not) with the explore tool instead."""


# ── plain helpers (no HTTP, no strands) ──────────────────────────────────

def _human_size(n) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def _access_tag(ws: dict) -> str:
    acc = str(ws.get("access") or "read")
    icon = {"read": "👁", "partial": "◐", "full": "✎"}.get(acc, "?")
    return f"{icon} {acc}"


def _ws_line(ws: dict) -> str:
    branch = str(ws.get("branch") or ws.get("default_branch") or "")
    br = f" @ {branch}" if branch else ""
    return (f"{ws.get('name')}  [{ws.get('kind')}]  {_access_tag(ws)}{br}  "
            f"id {ws.get('id')}")


def _entry_line(e: dict) -> str:
    if str(e.get("type")) == "tree":
        return f"[dir]  {e.get('path')}/"
    return f"       {e.get('path')}  ({_human_size(e.get('size'))})"


def _tree_text(entries, truncated: bool, path: str, cap: int = 120) -> str:
    dirs = [e for e in entries if str(e.get("type")) == "tree"]
    files = [e for e in entries if str(e.get("type")) != "tree"]
    lines = []
    if path:
        lines.append(f"(under {path.strip('/')}/)")
    for e in dirs[:cap]:
        lines.append(_entry_line(e))
    for e in files[:cap]:
        lines.append(_entry_line(e))
    more = len(entries) - min(len(entries), cap)
    if more > 0:
        lines.append(f"… (+{more} more — narrow with path=)")
    if truncated:
        lines.append("(forge flagged the recursive tree TRUNCATED — "
                     "walk narrower paths for reliable rows)")
    return "\n".join(lines) if lines else "(empty)"


def _clip(s, n) -> str:
    s = str(s or "")
    return s if len(s) <= n else s[:n] + f" …[+{len(s) - n} chars]"


def _valid_range(spec: str) -> str:
    """Normalize a range spec, refusing garbage (engine 400s otherwise)."""
    s = str(spec or "").strip()
    if not s:
        return ""
    for prefix in ("head:", "tail:", "lines:"):
        if s.startswith(prefix):
            rest = s[len(prefix):]
            if rest.replace("-", "").replace(" ", "").isdigit():
                return s
    return ""


# ── WorkspaceClient — the HTTP seam (httpx lazily imported) ─────────────

class WorkspaceClient:
    """Client for the engine's workspaces REST surface. transport is THE
    test seam (httpx.MockTransport); methods never raise — failures come
    back as {"error": "<actionable>"}."""

    def __init__(self, base_url: str, transport=None, timeout: float = _TIMEOUT):
        self.base_url = str(base_url or "http://127.0.0.1:8080").rstrip("/")
        self._transport = transport
        self._timeout = timeout
        self._client = None

    def _http(self):
        import httpx
        if self._client is None:
            kw = {"timeout": self._timeout,
                  "headers": {"Authorization": "Bearer " + _engine_token()}
                  if _engine_token() else {}}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._client = httpx.Client(**kw)
        return self._client

    def _req(self, method: str, path: str, *, params=None, json_body=None) -> dict:
        try:
            r = self._http().request(method, self.base_url + path,
                                     params=params, json=json_body)
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
            return {"error": msg or f"engine HTTP {r.status_code} on {path}",
                    "status": r.status_code}
        return body if isinstance(body, dict) else {}

    # verbs (one per engine route the tool needs)
    def list_all(self):
        return self._req("GET", "/api/workspaces")

    def get(self, wid: str):
        return self._req("GET", f"/api/workspaces/{wid}")

    def tree(self, wid: str, path: str, ref: str):
        p = {}
        if path:
            p["path"] = path
        if ref:
            p["ref"] = ref
        return self._req("GET", f"/api/workspaces/{wid}/tree", params=p)

    def file(self, wid: str, path: str, ref: str, rng: str):
        p = {"path": path}
        if ref:
            p["ref"] = ref
        if rng:
            p["range"] = rng
        return self._req("GET", f"/api/workspaces/{wid}/file", params=p)

    def readme(self, wid: str, ref: str):
        p = {}
        if ref:
            p["ref"] = ref
        return self._req("GET", f"/api/workspaces/{wid}/readme", params=p)

    def grep(self, wid: str, q: str, ref: str, limit: int, resume: str):
        p = {"q": q}
        if ref:
            p["ref"] = ref
        if limit:
            p["limit"] = str(limit)
        if resume:
            p["resume"] = resume
        return self._req("GET", f"/api/workspaces/{wid}/grep", params=p)

    def view(self, wid: str, what: str, state: str, limit: int):
        p = {}
        if state:
            p["state"] = state
        if limit:
            p["limit"] = str(limit)
        return self._req("GET", f"/api/workspaces/{wid}/view/{what}", params=p)

    def put_file(self, wid: str, path: str, content: str, message: str,
                 branch: str, sha: str):
        body = {"path": path, "content": content, "message": message,
                "branch": branch}
        if sha:
            body["sha"] = sha
        return self._req("PUT", f"/api/workspaces/{wid}/file", json_body=body)

    def fork(self, wid: str):
        return self._req("POST", f"/api/workspaces/{wid}/fork")

    def clone(self, wid: str):
        return self._req("POST", f"/api/workspaces/{wid}/clone")

    def create_repo(self, kind: str, name: str, desc: str, license_: str,
                    gitignore: str, private: bool):
        return self._req("POST", "/api/workspaces/create-repo", json_body={
            "kind": kind, "name": name, "description": desc,
            "license": license_, "gitignore": gitignore, "private": private})

    def discover(self, kind: str, limit: int):
        p = {"kind": kind, "limit": str(limit)}
        return self._req("GET", "/api/workspaces/discover", params=p)

    def attach_token(self, wid: str, token: str):
        return self._req("POST", f"/api/workspaces/{wid}/token",
                         json_body={"token": token})


def _engine_token() -> str:
    import os
    return os.environ.get("DOOMALAY_ENGINE_TOKEN", "")


# ── action dispatch (plain — the strands tool is a thin wrapper) ────────

def run_action(ctx, client: WorkspaceClient, action: str, ws: str = "",
               path: str = "", ref: str = "", range_: str = "",
               query: str = "", content: str = "", message: str = "",
               branch: str = "", what: str = "", state: str = "",
               limit: int = 0, kind: str = "github", name: str = "",
               description: str = "", license_: str = "",
               gitignore: str = "", private: bool = False,
               token: str = "", log=None) -> str:
    """All workspace actions as a plain function (tests + self-test run
    without strands). Returns a string, never raises."""
    try:
        return _dispatch(ctx, client, action, ws=ws, path=path, ref=ref,
                         range_=range_, query=query, content=content,
                         message=message, branch=branch, what=what,
                         state=state, limit=limit, kind=kind, name=name,
                         description=description, license_=license_,
                         gitignore=gitignore, private=private, token=token,
                         log=log)
    except Exception as exc:  # noqa: BLE001
        return f"workspace tool error ({action}): {type(exc).__name__}: {exc}"


def _resolve_ws(ctx, ws: str) -> dict:
    """ref → bound workspace row (from ctx.workspaces — the ids the engine
    sent with the turn). Falls back to an engine list scan so a workspace
    bound to ANOTHER chat still works by id (read paths only)."""
    hit = ctx.workspace_by_ref(ws) if ctx is not None else None
    if hit is not None:
        return hit
    if ws:
        return {"id": ws}  # opaque id — the engine will 404 if unknown
    return {}


def _dispatch(ctx, client: WorkspaceClient, action: str, **kw) -> str:
    action = str(action or "").strip().lower()

    if action in ("help", "?"):
        return HELP

    if action == "list":
        lr = client.list_all()
        if "error" in lr:
            return lr["error"]
        rows = lr.get("workspaces") or []
        if not rows:
            return NO_WS
        bound_ids = {str(w.get("id")) for w in (getattr(ctx, "workspaces", None) or [])}
        lines = [f"{len(rows)} workspace(s) on this engine "
                 f"({'bound to this chat' if bound_ids else 'none bound to this chat'}):"]
        for w in rows[:_LIST_CAP]:
            tag = " ●this-chat" if str(w.get("id")) in bound_ids else ""
            lines.append("  " + _ws_line(w) + tag)
        if len(rows) > _LIST_CAP:
            lines.append(f"  … (+{len(rows) - _LIST_CAP} more)")
        lines.append("Act with: workspace(action='tree', ws='<id or owner/repo>')")
        return "\n".join(lines)

    if action in ("info", "card"):
        if not kw.get("ws"):
            return "info needs ws= (workspace id or owner/repo)"
        row = _resolve_ws(ctx, kw["ws"])
        got = client.get(row.get("id") or kw["ws"])
        if "error" in got:
            return got["error"]
        meta = got.get("meta") or {}
        lines = [
            f"{got.get('name')}  [{got.get('kind')}]  {_access_tag(got)}",
            f"url: {got.get('repo_url')}   branch: {got.get('branch')} (default {got.get('default_branch')})",
        ]
        if meta.get("description"):
            lines.append("desc: " + _clip(meta.get("description"), 200))
        if meta.get("stars") is not None:
            lines.append(f"stars: {meta.get('stars')}  forks: {meta.get('forks')}  "
                         f"open issues: {meta.get('open_issues')}")
        if got.get("bound_sessions"):
            lines.append(f"bound to {len(got['bound_sessions'])} chat(s)")
        if got.get("sandbox_path"):
            lines.append(f"local clone: {got['sandbox_path']}")
        lines.append(f"id {got.get('id')}")
        return "\n".join(lines)

    if action == "tree":
        if not kw.get("ws"):
            return "tree needs ws= (workspace id or owner/repo) [path=] [ref=]"
        row = _resolve_ws(ctx, kw["ws"])
        tr = client.tree(row.get("id") or kw["ws"], kw.get("path", ""),
                         kw.get("ref", ""))
        if "error" in tr:
            return tr["error"]
        entries = tr.get("entries") or []
        return _tree_text(entries, bool(tr.get("truncated")), kw.get("path", ""))

    if action == "ls":
        if not kw.get("ws"):
            return "ls needs ws= [path=] [ref=]"
        row = _resolve_ws(ctx, kw["ws"])
        # one directory: tree of THAT path; entries outside the prefix are
        # dropped client-side so both server-filtered and recursive trees
        # render the same single level
        tr = client.tree(row.get("id") or kw["ws"], kw.get("path", ""),
                         kw.get("ref", ""))
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
                continue  # only the requested level
            kind = "d" if str(e.get("type")) == "tree" else "-"
            sz = "" if str(e.get("type")) == "tree" else "  " + _human_size(e.get("size"))
            rows.append(f"{kind}  {rel}{sz}")
        rows.sort(key=lambda s: (s[0] != "d", s.split("  ")[1] if "  " in s else s))
        if not rows:
            return f"(nothing at {p or 'root'})"
        return "\n".join(rows[:200]) + (f"\n… (+{len(rows) - 200} more)" if len(rows) > 200 else "")

    if action == "read":
        if not kw.get("ws") or not kw.get("path"):
            return "read needs ws= and path= [range=head:80|tail:40|lines:10-60] [ref=]"
        rng = _valid_range(kw.get("range_", ""))
        if kw.get("range_") and not rng:
            return (f"range {kw.get('range_')!r} not understood — use "
                    "head:80 | tail:40 | lines:10-60")
        row = _resolve_ws(ctx, kw["ws"])
        fc = client.file(row.get("id") or kw["ws"], kw["path"],
                         kw.get("ref", ""), rng)
        if "error" in fc:
            return fc["error"]
        if fc.get("binary"):
            return (f"{fc.get('path')} ({_human_size(fc.get('size'))}) is "
                    f"BINARY (base64, {fc.get('size')} B) — read a text file, "
                    f"or view it in the artifacts drawer")
        head = (f"{fc.get('path')} ({fc.get('size')} B"
                f"{', ranged' if rng else ''}):\n")
        return head + _clip(fc.get("content"), 5500)

    if action == "readme":
        if not kw.get("ws"):
            return "readme needs ws= [ref=]"
        row = _resolve_ws(ctx, kw["ws"])
        fc = client.readme(row.get("id") or kw["ws"], kw.get("ref", ""))
        if "error" in fc:
            return fc["error"]
        if fc.get("binary"):
            return f"{fc.get('path')} is binary — {_human_size(fc.get('size'))}"
        return (f"{fc.get('path')}:\n" + _clip(fc.get("content"), 5500))

    if action in ("grep", "search"):
        if not kw.get("ws") or not kw.get("query"):
            return "grep needs ws= and query= [ref=] [limit=] (resume=<token>)"
        row = _resolve_ws(ctx, kw["ws"])
        gr = client.grep(row.get("id") or kw["ws"], kw["query"],
                         kw.get("ref", ""), int(kw.get("limit") or 0),
                         kw.get("resume", ""))
        if "error" in gr:
            return gr["error"]
        hits = gr.get("hits") or []
        if not hits:
            return (f"no matches for {kw['query']!r}"
                    + (f" (scanned {gr.get('scanned')} files)" if gr.get("scanned") else ""))
        lines = [f"{len(hits)} match(es) for {kw['query']!r}:"
                 + (f" scanned {gr.get('scanned')}" if gr.get("scanned") else "")]
        for h in hits[:_LIST_CAP]:
            ln = f":{h.get('line')}" if h.get("line") else ""
            lines.append(f"  {h.get('path')}{ln}  {h.get('snippet', '')[:120]}")
        if len(hits) > _LIST_CAP:
            lines.append(f"  … (+{len(hits) - _LIST_CAP} more — raise limit=)")
        if not gr.get("complete") and gr.get("remaining"):
            lines.append("MORE TO SCAN — continue with resume="
                         f"'{str(gr.get('remaining'))[:2000]}'")
        return "\n".join(lines)

    if action == "view":
        if not kw.get("ws") or not kw.get("what"):
            return ("view needs ws= and what= (issues|pulls|releases|"
                    "workflows|runs|commits|branches|discussions) [state=] [limit=]")
        what = str(kw["what"]).strip().lower()
        if what == "actions":
            what = "runs"
        row = _resolve_ws(ctx, kw["ws"])
        vr = client.view(row.get("id") or kw["ws"], what,
                         kw.get("state", ""), int(kw.get("limit") or 0))
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

    if action in ("write", "create_file", "save"):
        if not kw.get("ws") or not kw.get("path"):
            return ("write needs ws=, path= and content= [message=] "
                    "[branch=] — requires full access")
        if not kw.get("content"):
            return "write needs content= (the file's full new text)"
        row = _resolve_ws(ctx, kw["ws"])
        wid = row.get("id") or kw["ws"]
        acc = str(row.get("access") or "")
        if acc and acc != "full":
            return (f"{row.get('name')} is {acc}-access — writing needs "
                    "full access (attach a token with push rights, or "
                    "fork first: workspace(action='fork', ws=…))")
        # fetch the CURRENT blob sha (PUT needs it for updates; the engine
        # treats "" as a create)
        sha = ""
        fc = client.file(wid, kw["path"], kw.get("branch", "") or "", "")
        if "error" not in fc and fc.get("sha"):
            sha = str(fc.get("sha"))
        wr = client.put_file(wid, kw["path"], kw["content"],
                             kw.get("message", "") or f"doomalay: update {kw['path']}",
                             kw.get("branch", ""), sha)
        if "error" in wr:
            return wr["error"]
        _emit(kw.get("log"), "workspace_file_committed", ws=wid, path=kw["path"],
              branch=wr.get("branch"))
        return (f"committed {kw['path']} to {wr.get('branch')} — "
                f"{wr.get('commit_url') or 'see the repo history'}")

    if action == "create_repo":
        if not kw.get("name"):
            return ("create_repo needs name= [kind=github|gitea|gitlab] "
                    "[description=] [license=mit|apache-2.0|…] "
                    "[gitignore=] [private=true|false]")
        cr = client.create_repo(kw.get("kind", "github"), kw["name"],
                                kw.get("description", ""), kw.get("license_", ""),
                                kw.get("gitignore", ""), bool(kw.get("private")))
        if "error" in cr:
            return cr["error"]
        return (f"created {cr.get('name')} [{cr.get('kind')}] "
                f"({_access_tag(cr)}) — id {cr.get('id')}\n"
                f"{cr.get('repo_url')}  (bind it to this chat from the "
                "+workspace pill, then write with action='write')")

    if action == "fork":
        if not kw.get("ws"):
            return "fork needs ws= (requires a forge token with fork rights)"
        row = _resolve_ws(ctx, kw["ws"])
        fr = client.fork(row.get("id") or kw["ws"])
        if "error" in fr:
            return fr["error"]
        return (f"forked → {fr.get('full_name')}. Connect the fork (the "
                "+workspace pill) to get a full-access workspace.")

    if action == "clone":
        if not kw.get("ws"):
            return "clone needs ws= (local blobless clone; needs git on the host)"
        row = _resolve_ws(ctx, kw["ws"])
        cr = client.clone(row.get("id") or kw["ws"])
        if "error" in cr:
            return cr["error"]
        return (f"cloned to {cr.get('sandbox_path')} — shell there for "
                f"build/test work: cd {cr.get('sandbox_path')}")

    if action == "discover":
        dr = client.discover(kw.get("kind", "github"), int(kw.get("limit") or 0))
        if "error" in dr:
            return dr["error"]
        repos = dr.get("repos") or []
        if not repos:
            return "no repos found for the account token"
        lines = [f"{len(repos)} repo(s) on the account:"]
        for r in repos[:_LIST_CAP]:
            vis = "private" if r.get("private") else "public"
            lines.append(f"  {r.get('name')}  ({vis}, {r.get('default_branch')}) "
                         f"{r.get('web_url')}")
        if len(repos) > _LIST_CAP:
            lines.append(f"  … (+{len(repos) - _LIST_CAP} more)")
        lines.append("connect one: +workspace pill → Cloud Workspace → its URL")
        return "\n".join(lines)

    if action == "attach_token":
        if not kw.get("ws") or not kw.get("token"):
            return "attach_token needs ws= and token= (upgrades access)"
        row = _resolve_ws(ctx, kw["ws"])
        tr = client.attach_token(row.get("id") or kw["ws"], kw["token"])
        if "error" in tr:
            return tr["error"]
        return f"token attached — access is now {tr.get('access')}"

    return f"unknown action {action!r} — use action='help' for the menu"


def _view_line(what: str, it: dict) -> str:
    n = it.get("number") or it.get("id") or "?"
    if what == "issues":
        pr = " [PR]" if it.get("is_pr") else ""
        return f"#{n} {it.get('title')} ({it.get('state')}, @{it.get('author')}){pr}"
    if what == "pulls":
        return f"!{n} {it.get('title')} ({it.get('state')}, @{it.get('author')}, ← {it.get('branch')})"
    if what == "releases":
        pre = " (pre)" if it.get("prerelease") else ""
        return f"{it.get('tag')} — {it.get('name') or 'no title'} ({it.get('published_at', '')[:10]}){pre}"
    if what == "workflows":
        return f"{it.get('name')}  ({it.get('path')}, {it.get('state')})"
    if what == "runs":
        icon = {"success": "✓", "failure": "✗", "in_progress": "◐",
                "queued": "…", "": "?"}.get(str(it.get("conclusion") or it.get("status")), "?")
        return f"{icon} {it.get('name')} [{it.get('event')}] {it.get('branch')} ({it.get('started_at', '')[:16]})"
    if what == "commits":
        return f"{str(it.get('sha'))[:10]} {it.get('message')} — @{it.get('author')} ({it.get('date', '')[:10]})"
    if what == "branches":
        return f"{it if isinstance(it, str) else it.get('name')}"
    if what == "discussions":
        cat = f" [{it.get('category')}]" if it.get("category") else ""
        return f"#{n} {it.get('title')} @{it.get('author')}{cat}"
    return str(it)


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
        client = WorkspaceClient(base)
        log = getattr(ctx, "log", None)
        n_ws = len(getattr(ctx, "workspaces", None) or [])

        @strands_tool_decorator(name="workspace", description=(
            "Act on this chat's CONNECTED cloud workspaces — real repos on "
            "GitHub, Gitea/Codeberg, GitLab, sourcehut or any git host. "
            "Browse (tree/ls/read with head/tail/line ranges, readme, grep), "
            "inspect everything (issues, PRs, releases, Actions runs, "
            "workflows, commits, branches, discussions), and WRITE when "
            "access allows (file writes are API commits — full access), "
            "fork, clone locally, create a fresh repo from scratch, or "
            "discover the account's repos. Actions: list, info, tree, ls, "
            "read, readme, grep, view, write, create_repo, fork, clone, "
            "discover, attach_token, help. `ws` = id or owner/repo."
            + (f" This chat has {n_ws} bound workspace(s)."
               if n_ws else
               " No workspace is bound to this chat yet — the user connects "
               "one via the +workspace pill; use explore for raw URLs.")))
        def workspace(action: str, ws: str = "", path: str = "",
                      ref: str = "", range: str = "", query: str = "",
                      content: str = "", message: str = "",
                      branch: str = "", what: str = "", state: str = "",
                      limit: int = 0, kind: str = "github", name: str = "",
                      description: str = "", license: str = "",
                      gitignore: str = "", private: bool = False,
                      token: str = "") -> str:
            """Work with this chat's connected cloud repos.

            action: list|info|tree|ls|read|readme|grep|view|write|
                create_repo|fork|clone|discover|attach_token|help
            ws: workspace id (12 hex) OR owner/repo OR bare repo name
            path: file/subdirectory path (tree, ls, read, write)
            ref: branch/tag/sha override (defaults to the workspace branch)
            range: read slicing — head:80 | tail:40 | lines:10-60
            query: grep search text
            content: full new file text for write
            message: commit message for write (default: doomalay: update <path>)
            branch: target branch for write (default: the workspace branch)
            what: view subject — issues|pulls|releases|workflows|runs|
                commits|branches|discussions
            state: filter for views (issues: open|closed|all; pulls: open|closed)
            limit: max rows for grep/view/discover (0 = default)
            kind: forge for create_repo/discover (github|gitea|gitlab)
            name: repo name for create_repo
            description: repo description for create_repo
            license: license key for create_repo (mit, apache-2.0, gpl-3.0…)
            gitignore: gitignore template for create_repo (Go, Python…)
            private: create the repo private (default false)
            token: forge token for attach_token
            """
            return run_action(ctx, client, action, ws=ws, path=path, ref=ref,
                              range_=range, query=query, content=content,
                              message=message, branch=branch, what=what,
                              state=state, limit=limit, kind=kind, name=name,
                              description=description, license_=license,
                              gitignore=gitignore, private=private,
                              token=token, log=log)

        return [workspace]
    except Exception:
        return []


# ── offline self-test (dt_spec rule 7) ───────────────────────────────────

if __name__ == "__main__":
    import types
    import httpx

    WSDIR = {
        "aaaaaaaaaaaa": {"id": "aaaaaaaaaaaa", "name": "ScoobyBaby1999/doomalay",
                         "kind": "github", "host": "github.com",
                         "owner": "ScoobyBaby1999", "repo": "doomalay",
                         "access": "full", "branch": "main"},
        "bbbbbbbbbbbb": {"id": "bbbbbbbbbbbb", "name": "octocat/hello",
                         "kind": "gitea", "host": "gitea.com",
                         "owner": "octocat", "repo": "hello",
                         "access": "read", "branch": "master"},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _j
        path = request.url.path
        if path == "/api/workspaces" and request.method == "GET":
            return httpx.Response(200, json={"workspaces": list(WSDIR.values())})
        m = "/api/workspaces/aaaaaaaaaaaa"
        if path.startswith(m):
            if "/tree" in path:
                return httpx.Response(200, json={"entries": [
                    {"path": "src", "type": "tree", "size": 0, "sha": "t1"},
                    {"path": "README.md", "type": "blob", "size": 340, "sha": "b1"},
                    {"path": "src/main.py", "type": "blob", "size": 1024, "sha": "b2"},
                ], "truncated": False})
            if "/file" in path:
                if request.method == "PUT":
                    body = _j.loads(request.content)
                    assert set(body) <= {"path", "content", "message", "branch", "sha"}, body
                    return httpx.Response(200, json={"committed": True,
                        "path": body["path"], "branch": body.get("branch") or "main",
                        "commit_url": "https://github.com/x/y/commit/abc"})
                return httpx.Response(200, json={"path": "README.md", "size": 340,
                    "encoding": "utf8", "content": "# hello\nworld", "sha": "b1"})
            if "/readme" in path:
                return httpx.Response(200, json={"path": "README.md", "size": 340,
                    "encoding": "utf8", "content": "# doomalay rocks"})
            if "/grep" in path:
                return httpx.Response(200, json={"hits": [
                    {"path": "src/main.py", "line": 3, "snippet": "print('hi')"}],
                    "scanned": 12, "complete": True})
            if "/view/issues" in path:
                return httpx.Response(200, json={"view": "issues", "items": [
                    {"number": 1, "title": "bug", "state": "open", "author": "u", "is_pr": False}]})
            if request.method == "GET" and path == m:
                return httpx.Response(200, json={**WSDIR["aaaaaaaaaaaa"],
                    "bound_sessions": ["s1"], "repo_url": "https://github.com/ScoobyBaby1999/doomalay"})
            if path == m + "/fork":
                return httpx.Response(200, json={"forked": True, "full_name": "me/doomalay"})
        # engine-side access guard for the READ-only workspace
        if path.startswith("/api/workspaces/bbbbbbbbbbbb/file") and request.method == "PUT":
            return httpx.Response(403, json={"error": "read-only"})
        if path == "/api/workspaces/create-repo":
            body = _j.loads(request.content)
            return httpx.Response(200, json={"id": "cccccccccccc", "name": "me/" + body["name"],
                "kind": body.get("kind", "github"), "access": "full",
                "repo_url": "https://github.com/me/" + body["name"]})
        if path == "/api/workspaces/discover":
            return httpx.Response(200, json={"repos": [
                {"name": "me/old", "private": False, "default_branch": "main",
                 "web_url": "https://github.com/me/old"}]})
        if path == "/api/workspaces/aaaaaaaaaaaa/clone":
            return httpx.Response(200, json={"cloned": True, "sandbox_path": "/data/workspaces/x"})
        return httpx.Response(404, json={"error": "not found: " + path})

    client = WorkspaceClient("http://eng.test", transport=httpx.MockTransport(handler))
    ctx = types.SimpleNamespace(
        workspaces=[WSDIR["aaaaaaaaaaaa"], WSDIR["bbbbbbbbbbbb"]],
        workspace_by_ref=lambda r: next(
            (w for w in [WSDIR["aaaaaaaaaaaa"], WSDIR["bbbbbbbbbbbb"]]
             if w["id"] == r or w["name"].lower() == str(r).lower()
             or w["repo"].lower() == str(r).lower()), None),
        log=None)

    # helpers
    assert _human_size(7000) == "6.8 KB" and _human_size(100) == "100 B"
    assert _valid_range("head:80") == "head:80" and _valid_range("lines:1-9") == "lines:1-9"
    assert _valid_range("junk") == "" and _valid_range("") == ""
    assert _access_tag(WSDIR["aaaaaaaaaaaa"]) == "✎ full"
    # list shows both + the bound tag (both rows ARE in ctx.workspaces)
    out = run_action(ctx, client, "list")
    assert "2 workspace(s)" in out and "ScoobyBaby1999/doomalay" in out, out
    assert out.count("●this-chat") == 2, out
    # info by name
    out = run_action(ctx, client, "info", ws="doomalay")
    assert "ScoobyBaby1999/doomalay" in out and "stars" not in out, out
    # tree
    out = run_action(ctx, client, "tree", ws="ScoobyBaby1999/doomalay")
    assert "[dir]  src/" in out and "README.md" in out, out
    # ls filters to one level
    out = run_action(ctx, client, "ls", ws="doomalay", path="src")
    assert "main.py" in out and "README.md" not in out, out
    # read + ranges
    out = run_action(ctx, client, "read", ws="doomalay", path="README.md")
    assert "# hello" in out, out
    out = run_action(ctx, client, "read", ws="doomalay", path="README.md", range_="bogus")
    assert "not understood" in out, out
    # readme
    out = run_action(ctx, client, "readme", ws="doomalay")
    assert "doomalay rocks" in out, out
    # grep
    out = run_action(ctx, client, "grep", ws="doomalay", query="print")
    assert "src/main.py:3" in out, out
    # view
    out = run_action(ctx, client, "view", ws="doomalay", what="issues")
    assert "#1 bug" in out, out
    # write (full access) — carries the fetched sha
    out = run_action(ctx, client, "write", ws="doomalay", path="README.md",
                     content="# new", message="update readme")
    assert "committed README.md" in out, out
    # write on read-only refused client-side with the upgrade hint
    out = run_action(ctx, client, "write", ws="hello", path="a.txt", content="x")
    assert "full access" in out and "fork" in out, out
    # create_repo
    out = run_action(ctx, client, "create_repo", name="fresh", license_="mit")
    assert "created me/fresh" in out and "full" in out, out
    # fork + clone + discover
    out = run_action(ctx, client, "fork", ws="doomalay")
    assert "forked → me/doomalay" in out, out
    out = run_action(ctx, client, "clone", ws="doomalay")
    assert "/data/workspaces/x" in out, out
    out = run_action(ctx, client, "discover")
    assert "me/old" in out, out
    # no ws given
    out = run_action(ctx, client, "tree")
    assert "needs ws=" in out, out
    # help
    assert "Actions:" in run_action(ctx, client, "help")

    # ctx without workspaces — list falls back to the engine rows
    ctx0 = types.SimpleNamespace(workspaces=[], workspace_by_ref=lambda r: None, log=None)
    out = run_action(ctx0, client, "list")
    assert "2 workspace(s)" in out, out

    # build() without strands registers nothing and never raises
    assert build(types.SimpleNamespace(engine_url="http://eng.test",
                                       workspaces=[], log=None)) == []
    print("dt_workspace SELF-TEST OK")
