"""test_dt_workspace.py + test_dt_explore.py — offline unit tests.

httpx.MockTransport is the seam; the fakes re-implement the engine REST
surface exactly as server/workspaces.go serves it (same routes, same JSON
keys, same error shapes). Run: python3 brain/tests/test_dt_workspace.py
No network, no strands, no engine.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import urllib.parse as _u

_HERE = Path(__file__).resolve().parent


def _load(name):
    p = _HERE.parent / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


da_ws = _load("dt_workspace")
da_ex = _load("dt_explore")

WS = {
    "aaaaaaaaaaaa": {"id": "aaaaaaaaaaaa", "name": "ScoobyBaby1999/doomalay",
                     "kind": "github", "host": "github.com",
                     "owner": "ScoobyBaby1999", "repo": "doomalay",
                     "access": "full", "branch": "main",
                     "repo_url": "https://github.com/ScoobyBaby1999/doomalay"},
    "bbbbbbbbbbbb": {"id": "bbbbbbbbbbbb", "name": "octocat/hello",
                     "kind": "gitea", "host": "gitea.com",
                     "owner": "octocat", "repo": "hello",
                     "access": "read", "branch": "master"},
}


def _q(request):
    raw = request.url.query
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return dict(_u.parse_qsl(raw))


def _body(request):
    import json as j
    return j.loads(request.content)


# ── the fake engine (shared by both tool test suites) ────────────────────

def fake_engine(request: httpx.Request) -> httpx.Response:
    import json as j
    q = _q(request)
    path = request.url.path

    # workspace routes
    if path == "/api/workspaces" and request.method == "GET":
        return httpx.Response(200, json={"workspaces": list(WS.values())})
    if path == "/api/workspaces/create-repo":
        b = _body(request)
        return httpx.Response(200, json={"id": "cccccccccccc",
                                         "name": "me/" + b["name"],
                                         "kind": b.get("kind", "github"),
                                         "access": "full",
                                         "repo_url": "https://github.com/me/" + b["name"]})
    if path == "/api/workspaces/discover":
        return httpx.Response(200, json={"repos": [
            {"name": "me/old", "private": False, "default_branch": "main",
             "web_url": "https://github.com/me/old"}]})
    m = path.startswith("/api/workspaces/aaaaaaaaaaaa")
    if m or path.startswith("/api/workspaces/bbbbbbbbbbbb"):
        wid = "aaaaaaaaaaaa" if m else "bbbbbbbbbbbb"
        acc = WS[wid]["access"]
        if path.endswith("/tree"):
            return httpx.Response(200, json={"entries": [
                {"path": "src", "type": "tree", "size": 0, "sha": "t1"},
                {"path": "README.md", "type": "blob", "size": 340, "sha": "b1"},
                {"path": "src/main.py", "type": "blob", "size": 1024, "sha": "b2"},
            ], "truncated": False})
        if path.endswith("/file"):
            if request.method == "PUT":
                if acc != "full":
                    return httpx.Response(403, json={"error": "read-only"})
                b = _body(request)
                assert set(b) <= {"path", "content", "message", "branch", "sha"}
                return httpx.Response(200, json={"committed": True,
                                                 "path": b["path"],
                                                 "branch": b.get("branch") or "main",
                                                 "commit_url": "https://x/commit/1"})
            if q.get("path", "").endswith(".png"):
                return httpx.Response(200, json={"path": q["path"], "size": 900,
                                                 "encoding": "base64", "content": "",
                                                 "binary": True})
            return httpx.Response(200, json={"path": q.get("path"), "size": 340,
                                             "encoding": "utf8",
                                             "content": "# hi\nbody",
                                             "sha": "b1"})
        if path.endswith("/readme"):
            return httpx.Response(200, json={"path": "README.md", "size": 340,
                                             "encoding": "utf8",
                                             "content": "# readme text"})
        if path.endswith("/grep"):
            return httpx.Response(200, json={"hits": [
                {"path": "src/main.py", "line": 3, "snippet": "print('x')"}],
                "scanned": 9, "complete": False, "remaining": "z1.py\nz2.py"})
        if "/view/" in path:
            what = path.rsplit("/", 1)[-1]
            if what == "issues":
                return httpx.Response(200, json={"view": "issues", "items": [
                    {"number": 7, "title": "crash", "state": "open",
                     "author": "u", "is_pr": False}]})
            if what == "runs":
                return httpx.Response(200, json={"view": "runs", "items": [
                    {"name": "ci", "status": "completed", "conclusion": "success",
                     "event": "push", "branch": "main", "started_at": "2026-09-19T10:00:00Z"}]})
            return httpx.Response(200, json={"view": what, "items": []})
        if path.endswith("/fork"):
            return httpx.Response(200, json={"forked": True, "full_name": "me/fork"})
        if path.endswith("/clone"):
            return httpx.Response(200, json={"cloned": True,
                                             "sandbox_path": "/data/ws/x"})
        if path.endswith("/token"):
            return httpx.Response(200, json={"token_set": True, "access": "full"})
        if request.method == "GET" and path.count("/") == 3:
            return httpx.Response(200, json={**WS[wid], "bound_sessions": ["s1"]})
    # 404 the handler default
    if path == "/api/explore/repo":
        return httpx.Response(200, json={
            "host_info": {"kind": "github", "host": "github.com",
                          "owner": "a", "repo": "b"},
            "meta": {"full_name": "a/b", "web_url": "https://github.com/a/b",
                     "default_branch": "main", "description": "d",
                     "stars": 1, "forks": 2, "open_issues": 3,
                     "updated_at": "2026-09-01T00:00:00Z"},
            "access": "read"})
    if path == "/api/explore/readme":
        return httpx.Response(200, json={"path": "README.md", "size": 10,
                                         "encoding": "utf8", "content": "# ab"})
    if path == "/api/explore/tree":
        return httpx.Response(200, json={"entries": [
            {"path": "d", "type": "tree", "size": 0, "sha": "t"},
            {"path": "f.go", "type": "blob", "size": 10, "sha": "b"},
        ], "truncated": True})
    if path == "/api/explore/file":
        return httpx.Response(200, json={"path": q.get("path"), "size": 20,
                                         "encoding": "utf8",
                                         "content": "a\nb\nc", "sha": "s"})
    if path == "/api/explore/files":
        out = []
        for p in [x for x in q.get("paths", "").split(",") if x]:
            out.append({"path": p, "size": 20, "binary": False,
                        "content": "a\nb\nc", "truncated": True})
        return httpx.Response(200, json={"files": out, "asked": len(out)})
    if path == "/api/explore/grep":
        return httpx.Response(200, json={"hits": [
            {"path": "f.go", "line": 2, "snippet": "match here"}],
            "scanned": 5, "complete": True})
    if path.startswith("/api/explore/view/"):
        what = path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={"view": what, "items": [
            {"sha": "fff000111", "message": "m", "author": "u",
             "date": "2026-09-19T00:00:00Z"}] if what == "commits" else []})
    return httpx.Response(404, json={"error": "no route " + path})


def make_ctx():
    return SimpleNamespace(
        workspaces=[WS["aaaaaaaaaaaa"], WS["bbbbbbbbbbbb"]],
        workspace_by_ref=lambda r: next(
            (w for w in WS.values()
             if w["id"] == r or w["name"].lower() == str(r).lower()
             or w["repo"].lower() == str(r).lower()), None),
        log=None)


# ── dt_workspace tests ────────────────────────────────────────────────────

def test_ws_list_and_bound_tag():
    c = da_ws.WorkspaceClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    out = da_ws.run_action(make_ctx(), c, "list")
    assert "2 workspace(s)" in out and "●this-chat" in out, out
    # zero-workspace ctx still lists engine rows
    out = da_ws.run_action(SimpleNamespace(workspaces=[],
                                           workspace_by_ref=lambda r: None,
                                           log=None), c, "list")
    assert "octocat/hello" in out, out


def test_ws_tree_ls_read_readme():
    c = da_ws.WorkspaceClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    ctx = make_ctx()
    out = da_ws.run_action(ctx, c, "tree", ws="doomalay")
    assert "[dir]  src/" in out and "README.md" in out, out
    out = da_ws.run_action(ctx, c, "ls", ws="doomalay", path="src")
    assert "main.py" in out and "README.md" not in out, out
    out = da_ws.run_action(ctx, c, "read", ws="doomalay", path="README.md")
    assert "# hi" in out, out
    out = da_ws.run_action(ctx, c, "read", ws="doomalay", path="x", range_="junk")
    assert "not understood" in out, out
    out = da_ws.run_action(ctx, c, "readme", ws="aaaaaaaaaaaa")
    assert "readme text" in out, out


def test_ws_grep_views():
    c = da_ws.WorkspaceClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    ctx = make_ctx()
    out = da_ws.run_action(ctx, c, "grep", ws="doomalay", query="print")
    assert "src/main.py:3" in out and "MORE TO SCAN" in out, out
    out = da_ws.run_action(ctx, c, "view", ws="doomalay", what="issues")
    assert "#7 crash" in out, out
    out = da_ws.run_action(ctx, c, "view", ws="doomalay", what="actions")  # alias
    assert "✓ ci" in out, out


def test_ws_write_access_gating():
    c = da_ws.WorkspaceClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    ctx = make_ctx()
    # full access → PUT with the fetched sha
    out = da_ws.run_action(ctx, c, "write", ws="doomalay", path="README.md",
                           content="# new", message="up")
    assert "committed README.md" in out, out
    # read access → refused client-side with upgrade guidance
    out = da_ws.run_action(ctx, c, "write", ws="hello", path="a", content="x")
    assert "full access" in out and "fork" in out, out
    # empty content refused
    out = da_ws.run_action(ctx, c, "write", ws="doomalay", path="a")
    assert "content=" in out, out


def test_ws_create_fork_clone_discover_token():
    c = da_ws.WorkspaceClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    ctx = make_ctx()
    out = da_ws.run_action(ctx, c, "create_repo", name="fresh", license_="mit",
                           private=True)
    assert "created me/fresh" in out, out
    out = da_ws.run_action(ctx, c, "fork", ws="doomalay")
    assert "me/fork" in out, out
    out = da_ws.run_action(ctx, c, "clone", ws="doomalay")
    assert "/data/ws/x" in out, out
    out = da_ws.run_action(ctx, c, "discover")
    assert "me/old" in out, out
    out = da_ws.run_action(ctx, c, "attach_token", ws="doomalay", token="ghp_x")
    assert "access is now full" in out, out


def test_ws_error_paths():
    c = da_ws.WorkspaceClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    ctx = make_ctx()
    assert "needs ws=" in da_ws.run_action(ctx, c, "tree")
    assert "unknown action" in da_ws.run_action(ctx, c, "zzz")
    assert "Actions:" in da_ws.run_action(ctx, c, "help")
    # engine unreachable never raises
    dead = da_ws.WorkspaceClient("http://e.test",
                                 transport=httpx.MockTransport(
                                     lambda r: (_ for _ in ()).throw(
                                         httpx.ConnectError("refused"))))
    out = da_ws.run_action(ctx, dead, "list")
    assert "unreachable" in out, out


# ── dt_explore tests ──────────────────────────────────────────────────────

def test_ex_repo_brief():
    c = da_ex.ExploreClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    out = da_ex.run_action(c, "repo", url="github.com/a/b")
    assert "a/b" in out and "stars 1" in out and "# ab" in out, out


def test_ex_tree_ls_read():
    c = da_ex.ExploreClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    out = da_ex.run_action(c, "tree", url="github.com/a/b")
    assert "[dir]  d/" in out and "f.go" in out and "TRUNCATED" in out, out
    out = da_ex.run_action(c, "ls", url="github.com/a/b")
    assert "d" in out and "f.go" in out, out
    out = da_ex.run_action(c, "read", url="github.com/a/b", path="f.go")
    assert "a\nb\nc" in out, out


def test_ex_batch_files():
    c = da_ex.ExploreClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    out = da_ex.run_action(c, "files", url="github.com/a/b",
                           paths="f.go, g.go, h.go")
    assert "3/3" in out and "── f.go" in out, out


def test_ex_grep_and_views():
    c = da_ex.ExploreClient("http://e.test", transport=httpx.MockTransport(fake_engine))
    out = da_ex.run_action(c, "grep", url="github.com/a/b", query="match")
    assert "f.go:2" in out, out
    out = da_ex.run_action(c, "view", url="github.com/a/b", what="history")
    assert "fff000111 m" in out, out
    out = da_ex.run_action(c, "view", url="github.com/a/b", what="issues")
    assert "no issues rows" in out, out


def test_ex_helpers_and_guards():
    assert da_ex._norm_url("a.io/b") == "https://a.io/b"
    assert da_ex._parse_paths("x, y\nx, ,z") == ["x", "y", "z"]
    assert da_ex._parse_paths("../evil, ok") == ["ok"]  # traversal dropped
    assert da_ex._valid_range("lines:1-9") == "lines:1-9"
    assert da_ex._valid_range("x") == ""
    assert "needs url=" in da_ex.run_action(
        da_ex.ExploreClient("http://e.test", transport=httpx.MockTransport(fake_engine)),
        "repo")


def test_ex_build_never_raises():
    # build() must never raise. Offline (no strands) both register nothing;
    # in a FULL env (the E2E venv has strands) they register their tools.
    try:
        import strands  # noqa: F401
        full = True
    except ImportError:
        full = False
    ex = da_ex.build(SimpleNamespace(engine_url="http://e.test", log=None))
    ws = da_ws.build(SimpleNamespace(engine_url="http://e.test",
                                     workspaces=[], log=None))
    if full:
        assert ex and ws
    else:
        assert ex == [] and ws == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {fn.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"{len(fns) - failed}/{len(fns)} tests passed")
    sys.exit(1 if failed else 0)
