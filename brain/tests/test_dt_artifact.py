"""test_dt_artifact.py — offline unit tests for brain/tools/dt_artifact.py.

httpx.MockTransport is THE seam. FakeEngine below re-implements the REST
surface exactly as read from engine/internal/server/artifacts.go +
preview.go + server.go routes(): same routes, same status codes, same JSON
keys, same pointer-semantics PUT ({"name","content"} with omitted keys =
unchanged), same 12-hex aid guard, same per-session 404s, same
sanitizeArtifactName behavior (double-extension collapse, ../-segment
drop). The tests therefore pin the CLIENT to the real engine contract —
not to a fake of its own making.

Run: python3 brain/tests/test_dt_artifact.py    (or: pytest brain/tests)
No network, no strands, no engine.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx

# Load the tool module the same way dt_registry does (file location, no
# package needed) — works standalone AND under pytest.
_TOOL_PATH = Path(__file__).resolve().parents[1] / "tools" / "dt_artifact.py"
_spec = importlib.util.spec_from_file_location("dt_artifact_under_test", _TOOL_PATH)
da = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(da)

# ── Go twins (engine/internal/server/artifacts.go) ────────────────────────

AID_RE = re.compile(r"^[a-f0-9]{12}$")  # Go artifactIDRe
_DOUBLE_EXT = re.compile(
    r"(?i)\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)"
    r"\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)$")

MIMES = {
    ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv", ".json": "application/json", ".py": "text/x-python",
    ".go": "text/x-go", ".png": "image/png", ".zip": "application/zip",
    ".docx": "application/msword", ".xlsx": "application/vnd.ms-excel",
}


def _guess_mime(name: str) -> str:
    ext = name[name.rfind("."):].lower() if "." in name else ""
    return MIMES.get(ext, "application/octet-stream")


def _sanitize(name: str) -> str:
    """Mirror of Go sanitizeArtifactName: strip control chars, backslash→/,
    drop empty/./.. segments, collapse glued double doc extensions,
    blank → artifact.txt. (The >240 front-trim is omitted — never hit.)"""
    name = "".join(ch for ch in str(name or "").strip().replace("\\", "/")
                   if ord(ch) >= 32)
    kept = [s.strip() for s in name.split("/")]
    name = "/".join(s for s in kept if s and s not in (".", ".."))
    if not name:
        return "artifact.txt"
    while _DOUBLE_EXT.search(name):
        name = _DOUBLE_EXT.sub(r".\1", name)
    return name


def _b64decode(s: str) -> bytes:
    # Go base64Decode is tolerant of \n \r space tab
    return base64.b64decode(re.sub(r"[\s]+", "", s or ""))


class FakeEngine:
    """The artifacts REST surface as the Go server actually behaves."""

    def __init__(self, sessions=("s1",)):
        self.sessions = set(sessions)
        self.store: dict = {sid: {} for sid in self.sessions}  # sid→aid→rec
        self.members: dict = {}   # (sid, aid) → {member_path: text}
        self.requests: list = []  # (method, path, json body, params)
        self._n = 0

    # shared write path — mirrors saveArtifactBytes (used by extract)
    def create_artifact(self, sid, name, data: bytes, source="model",
                        encoding="utf8") -> dict:
        self._n += 1
        aid = f"{self._n:012x}"
        meta = {"id": aid, "name": _sanitize(name), "mime": _guess_mime(name),
                "encoding": encoding, "size": len(data), "source": source,
                "created_at": 1.0, "updated_at": 1.0}
        self.store.setdefault(sid, {})[aid] = {"meta": meta, "data": data}
        return meta

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = None
        if request.content and request.method in ("POST", "PUT"):
            body = json.loads(request.content)
        self.requests.append((request.method, request.url.path, body,
                              dict(request.url.params)))
        m = re.match(r"^/api/sessions/([^/]+)/artifacts"
                     r"(?:/([^/]+)(?:/(download|preview|entry|extract))?)?$",
                     request.url.path)
        if not m:
            return httpx.Response(404, json={"error": "not found"})
        sid, aid, tail = m.groups()
        if aid is None:
            if request.method == "GET":
                return self._list(sid)
            if request.method == "POST":
                return self._create(sid, body or {})
        elif tail is None:
            if request.method == "GET":
                return self._get(sid, aid)
            if request.method == "PUT":
                return self._update(sid, aid, body or {})
            if request.method == "DELETE":
                return self._delete(sid, aid)
        elif tail == "download" and request.method == "GET":
            return self._download(sid, aid)
        elif tail == "preview" and request.method == "GET":
            return self._preview(sid, aid)
        elif tail == "entry" and request.method == "GET":
            return self._entry(sid, aid, dict(request.url.params))
        elif tail == "extract" and request.method == "POST":
            return self._extract(sid, aid)
        return httpx.Response(405, json={"error": "method not allowed"})

    # ── handlers, one per Go function ────────────────────────────────
    def _list(self, sid):
        if sid not in self.sessions:            # handleArtifactsList
            return httpx.Response(404, json={"error": "session not found"})
        arts = [r["meta"] for r in self.store.get(sid, {}).values()
                if AID_RE.match(r["meta"]["id"])]
        return httpx.Response(200, json={"artifacts": arts})

    def _create(self, sid, body):
        if sid not in self.sessions:            # handleArtifactsCreate
            return httpx.Response(404, json={"error": "session not found"})
        encoding = str(body.get("encoding") or "").strip().lower()
        if encoding != "base64":
            encoding = "utf8"
        try:
            data = (_b64decode(body.get("content"))
                    if encoding == "base64"
                    else str(body.get("content") or "").encode("utf-8"))
        except Exception:
            return httpx.Response(400, json={"error": "bad base64"})
        meta = self.create_artifact(sid, body.get("name") or "", data,
                                    source=body.get("source") or "",
                                    encoding=encoding)
        return httpx.Response(201, json=meta)   # 201, meta echoed

    def _load(self, sid, aid):
        if not AID_RE.match(aid or ""):
            return None, httpx.Response(400, json={"error": "bad artifact id"})
        rec = self.store.get(sid, {}).get(aid)
        if not rec:
            return None, httpx.Response(404, json={"error": "artifact not found"})
        return rec, None

    def _get(self, sid, aid):
        rec, err = self._load(sid, aid)         # handleArtifactGet
        if err:
            return err
        m = rec["meta"]
        content = (base64.b64encode(rec["data"]).decode()
                   if m["encoding"] == "base64" else rec["data"].decode("utf-8"))
        return httpx.Response(200, json=dict(m, content=content))

    def _update(self, sid, aid, body):
        rec, err = self._load(sid, aid)         # handleArtifactUpdate
        if err:
            return err
        m = rec["meta"]
        # POINTER semantics: only keys PRESENT in the JSON act; a name that
        # is blank-after-trim is ignored (Go checks *body.Name != nil AND
        # TrimSpace != "").
        if "name" in body and str(body["name"] or "").strip():
            m["name"] = _sanitize(str(body["name"]))
            m["mime"] = _guess_mime(m["name"])
        if "content" in body:
            if m["encoding"] == "base64":
                try:
                    rec["data"] = _b64decode(str(body["content"]))
                except Exception:
                    return httpx.Response(400, json={"error": "bad base64"})
            else:
                rec["data"] = str(body["content"]).encode("utf-8")
            m["size"] = len(rec["data"])
        m["updated_at"] = 2.0
        return httpx.Response(200, json=m)

    def _delete(self, sid, aid):
        rec, err = self._load(sid, aid)         # handleArtifactDelete
        if err:
            return err
        self.store[sid].pop(aid)
        return httpx.Response(200, json={"deleted": True})

    def _download(self, sid, aid):
        rec, err = self._load(sid, aid)         # handleArtifactDownload
        if err:
            return err
        fname = rec["meta"]["name"].rsplit("/", 1)[-1]
        return httpx.Response(200, content=rec["data"], headers={
            "Content-Type": rec["meta"]["mime"],
            "Content-Disposition": f'attachment; filename="{fname}"'})

    def _preview(self, sid, aid):
        rec, err = self._load(sid, aid)         # handleArtifactPreview (text/binary paths)
        if err:
            return err
        m = rec["meta"]
        if m["encoding"] == "utf8":
            return httpx.Response(200, json={
                "kind": "text", "name": m["name"], "size": m["size"],
                "text": rec["data"].decode("utf-8")})
        return httpx.Response(200, json={
            "kind": "binary", "name": m["name"], "size": m["size"]})

    def _entry(self, sid, aid, params):
        _, err = self._load(sid, aid)           # handleArtifactEntry
        if err:
            return err
        member = params.get("name", "")
        if not member:
            return httpx.Response(400, json={"error": "missing name"})
        text = self.members.get((sid, aid), {}).get(member)
        if text is None:
            return httpx.Response(
                404, json={"error": f"member not found: {member}"})
        return httpx.Response(200, json={
            "name": member.rsplit("/", 1)[-1], "size": len(text.encode()),
            "text": text})

    def _extract(self, sid, aid):
        rec, err = self._load(sid, aid)         # handleArtifactExtract
        if err:
            return err
        mems = self.members.get((sid, aid))
        if mems is None:
            return httpx.Response(
                400, json={"error": "not a readable archive: no members"})
        for name, text in mems.items():
            base = name.rsplit("/", 1)[-1]      # Go: path.Base(name)
            self.create_artifact(sid, base, text.encode(),
                                 source="extracted", encoding="utf8")
        return httpx.Response(200, json={
            "extracted": len(mems), "from": rec["meta"]["name"]})


def make_client(fake, session="s1", base="http://engine.test"):
    return da.ArtifactClient(base, session,
                             transport=httpx.MockTransport(fake.handler))


def posts(fake):
    return [r for r in fake.requests
            if r[0] == "POST" and r[1].endswith("/artifacts")]


def puts(fake):
    return [r for r in fake.requests
            if r[0] == "PUT" and re.search(r"/artifacts/[a-f0-9]{12}$", r[1])]


# ── tests ─────────────────────────────────────────────────────────────────

def test_tree_lines_folders_first():
    """list → tree: [dir] rows first, natural order, id visible, rollup."""
    fake = FakeEngine()
    c = make_client(fake)
    da.run_action(c, "create", name="README.md", content="r")
    da.run_action(c, "create", name="src/main.py", content="m")
    da.run_action(c, "create", name="src/lib/util.go", content="u")
    out = da.run_action(c, "list")
    assert "3 artifact(s)" in out
    lines = out.splitlines()[1:]
    assert lines[0].startswith("[dir]  src/"), lines
    assert "(2 files" in lines[0] and "2 B" in lines[0]
    assert any(ln.startswith("    util.go") for ln in lines)      # 2 deep
    assert any(ln.startswith("  main.py") for ln in lines)        # 1 deep
    assert any(ln.startswith("README.md") for ln in lines)        # root file
    assert "id 000000000002" in out                               # main.py id
    # folders-first: README (root FILE) renders after the src/ subtree
    assert out.index("README.md") > out.index("main.py")

    # prefix filter narrows the tree (both src/ files, not README)
    sub = da.run_action(c, "list", path="src")
    assert "2 artifact(s) under 'src/'" in sub
    assert "util.go" in sub and "README.md" not in sub


def test_create_body_exact_go_keys():
    """The POST body must carry EXACTLY the keys artifacts.go decodes:
    name, content, encoding, source — nothing more, nothing less."""
    fake = FakeEngine()
    c = make_client(fake)
    out = da.run_action(c, "create", name="report.csv", content="a,b\n1,2\n")
    assert "created report.csv" in out, out
    ps = posts(fake)
    assert len(ps) == 1
    body = ps[0][2]
    assert set(body.keys()) == {"name", "content", "encoding", "source"}, body
    assert body["name"] == "report.csv"
    assert body["content"] == "a,b\n1,2\n"
    assert body["encoding"] == "utf8"
    assert body["source"] == "model"
    # engine echoes full meta (201) — client surfaces id + download path
    meta = fake.store["s1"]["000000000001"]["meta"]
    assert meta["mime"] == "text/csv" and meta["size"] == 8
    assert ("download: http://engine.test/api/sessions/s1/artifacts/"
            "000000000001/download") in out


def test_read_cap_and_binary_note():
    fake = FakeEngine()
    c = make_client(fake)
    da.run_action(c, "create", name="big.txt", content="x" * 7000)
    out = da.run_action(c, "read", name="big.txt")
    assert len(out) <= da._READ_CAP + 10, len(out)
    assert "truncated: 7000 chars" in out
    assert out.count("x") >= 5500                      # real prefix shown

    # binary artifact: bytes → base64 auto on create; read refuses to dump
    png = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
    da.run_action(c, "create", name="logo.png", content=png)
    ps = posts(fake)
    assert ps[-1][2]["encoding"] == "base64"           # auto-detected
    assert ps[-1][2]["content"] == base64.b64encode(png).decode()
    out = da.run_action(c, "read", name="logo.png")
    assert "BINARY" in out and "base64" in out
    assert "download: http://engine.test" in out
    assert "\x89PNG" not in out and "iVBOR" not in out  # no raw payload
    # preview on binary → kind=binary summary with the link
    out = da.run_action(c, "preview", name="logo.png")
    assert "binary" in out and "download:" in out


def test_write_then_update_flow():
    """write on a missing name POSTs (create-if-missing); the second write
    PUTs the SAME artifact — POST never forks a duplicate id."""
    fake = FakeEngine()
    c = make_client(fake)
    out = da.run_action(c, "write", name="notes.md", content="v1")
    assert "created notes.md" in out
    out = da.run_action(c, "write", name="notes.md", content="version two")
    assert "updated notes.md" in out and "id 000000000001" in out

    assert len(posts(fake)) == 1                       # no fork
    ps = puts(fake)
    assert len(ps) == 1
    # pointer semantics: ONLY the key we intend to change is sent
    assert set(ps[0][2].keys()) == {"content"}, ps[0][2]
    assert ps[0][2]["content"] == "version two"
    rec = fake.store["s1"]["000000000001"]
    assert rec["data"] == b"version two"
    assert rec["meta"]["size"] == 11
    assert rec["meta"]["updated_at"] == 2.0            # engine bumped it

    # write by aid: no name resolution, straight PUT
    out = da.run_action(c, "write", aid="000000000001", content="v3")
    assert "updated" in out
    assert puts(fake)[-1][2] == {"content": "v3"}


def test_append_read_modify_write():
    fake = FakeEngine()
    c = make_client(fake)
    da.run_action(c, "create", name="log.txt", content="line1")
    out = da.run_action(c, "append", name="log.txt", content="line2")
    assert "appended" in out
    # smart separator: no trailing newline → one is inserted
    assert fake.store["s1"]["000000000001"]["data"] == b"line1\nline2"
    # existing trailing newline → no double separator
    da.run_action(c, "write", name="log.txt", content="a\n")
    da.run_action(c, "append", name="log.txt", content="b")
    assert fake.store["s1"]["000000000001"]["data"] == b"a\nb"
    # append onto a MISSING file = create it
    out = da.run_action(c, "append", name="fresh.txt", content="first")
    assert "created fresh.txt" in out
    assert fake.store["s1"]["000000000002"]["data"] == b"first"
    # append onto a base64 artifact is refused with guidance
    da.run_action(c, "create", name="b.bin", content=b"\x00\x01")
    out = da.run_action(c, "append", name="b.bin", content="x")
    assert "base64/binary" in out and 'action="write"' in out


def test_name_resolution():
    fake = FakeEngine()
    c = make_client(fake)
    fake.create_artifact("s1", "src/lib/util.go", b"u")
    fake.create_artifact("s1", "other/util.go", b"u2")
    fake.create_artifact("s1", "README.md", b"r")

    # full path, case-insensitive, unique
    rr = c.resolve("src/lib/util.go")
    assert rr["aid"] == "000000000001" and rr["meta"]["name"] == "src/lib/util.go"
    assert c.resolve("SRC/LIB/UTIL.GO")["aid"] == "000000000001"
    # basename, unique
    assert c.resolve("README.md")["aid"] == "000000000003"
    # basename, ambiguous → candidates
    rr = c.resolve("util.go")
    assert "ambiguous" in rr["error"]
    assert "src/lib/util.go" in " ".join(rr["candidates"])
    assert "other/util.go" in " ".join(rr["candidates"])
    # run_action surfaces candidates to the model
    out = da.run_action(c, "read", name="util.go")
    assert "ambiguous" in out and "src/lib/util.go" in out
    # missing → clean error listing what exists (+ missing flag for write)
    rr = c.resolve("nope.txt")
    assert "no artifact matches" in rr["error"] and rr.get("missing")
    assert "README.md" in rr["error"]
    # id-shaped ref resolves directly via the GET route
    rr = c.resolve("000000000002")
    assert rr["aid"] == "000000000002" and rr["meta"]["name"] == "other/util.go"
    # an ambiguous name must NOT let write fork a third file
    out = da.run_action(c, "write", name="util.go", content="x")
    assert "ambiguous" in out
    assert len(fake.store["s1"]) == 3


def test_404_no_session_and_unreachable():
    # bogus session id → the engine's exact "session not found" is surfaced
    fake = FakeEngine(sessions=("s1",))
    c = make_client(fake, session="ghost")
    out = da.run_action(c, "list")
    assert "session not found" in out and "ghost" in out
    # no session bound → the contract's exact message, before any HTTP
    c2 = da.ArtifactClient("http://engine.test", None,
                           transport=httpx.MockTransport(fake.handler))
    assert da.run_action(c2, "list") == da.NO_SESSION
    assert da.run_action(c2, "create", name="x", content="y") == da.NO_SESSION
    # engine down → unreachable, never an exception
    def dead(request):
        raise httpx.ConnectError("connection refused")
    c3 = da.ArtifactClient("http://engine.test", "s1",
                           transport=httpx.MockTransport(dead))
    out = da.run_action(c3, "list")
    assert "engine unreachable" in out and "engine.test" in out
    # artifact-level 404 (session exists, artifact doesn't)
    fake = FakeEngine()
    c4 = make_client(fake)
    out = da.run_action(c4, "delete", name="ghost.txt")
    assert "no artifact matches" in out
    # malformed aid → client-side guard in the engine's own words
    out = da.run_action(c4, "delete", aid="not-an-id!!")
    assert "12" in out and "hex" in out


def test_mkdir_real_semantics():
    """The engine has NO folder entity: names carry the paths. mkdir drops
    a .keep placeholder so the drawer tree renders the folder."""
    fake = FakeEngine()
    c = make_client(fake)
    out = da.run_action(c, "mkdir", path="src/lib")
    assert "src/lib/.keep" in out and "virtual" in out
    ps = posts(fake)
    assert ps[0][2]["name"] == "src/lib/.keep"
    assert ps[0][2]["content"] == "" and ps[0][2]["encoding"] == "utf8"
    # the folder now shows in list
    out = da.run_action(c, "list")
    assert "[dir]  src/" in out and ".keep" in out
    # writing a real file inside grows the same folder
    da.run_action(c, "write", name="src/lib/util.go", content="x")
    out = da.run_action(c, "list", path="src/lib")
    assert "util.go" in out and "2 artifact(s)" in out


def test_download_url_construction():
    fake = FakeEngine()
    c = make_client(fake)
    da.run_action(c, "create", name="dl.txt", content="z")
    out = da.run_action(c, "download_url", name="dl.txt")
    assert out == ("http://engine.test/api/sessions/s1/artifacts/"
                   "000000000001/download")
    out = da.run_action(c, "download_url", aid="000000000001")
    assert out.endswith("/000000000001/download")
    # the route serves raw bytes with attachment disposition — GET proves it
    with httpx.Client(transport=httpx.MockTransport(fake.handler)) as h:
        r = h.get(out)
        assert r.status_code == 200 and r.content == b"z"
        assert "attachment" in r.headers.get("Content-Disposition", "")


def test_rename_delete():
    fake = FakeEngine()
    c = make_client(fake)
    da.run_action(c, "create", name="draft.txt", content="c")
    out = da.run_action(c, "rename", name="draft.txt", new_name="final.docx.doc")
    # PUT body carries EXACTLY the name key (pointer semantics)
    assert set(puts(fake)[0][2].keys()) == {"name"}
    assert puts(fake)[0][2]["name"] == "final.docx.doc"
    # the engine SANITIZES (double-doc-ext collapse) and the tool reports
    # the stored name, not the requested one
    assert "final.docx" in out and "final.docx.doc" not in out.split("→")[1]
    assert fake.store["s1"]["000000000001"]["meta"]["name"] == "final.docx"

    out = da.run_action(c, "delete", name="final.docx")
    assert "deleted final.docx" in out and "permanent" in out
    assert fake.store["s1"] == {}
    out = da.run_action(c, "delete", name="final.docx")
    assert "no artifact matches" in out
    # rename without a target is a clean message, not a crash
    assert "new_name" in da.run_action(c, "rename", name="x")


def test_preview_entry_extract():
    fake = FakeEngine()
    c = make_client(fake)
    da.run_action(c, "create", name="notes.md", content="# hi\nbody")
    out = da.run_action(c, "preview", name="notes.md")
    assert "text preview" in out and "body" in out

    # a fake archive: members registered engine-side (as zip_extract would)
    da.run_action(c, "create", name="bundle.zip", content=b"PK\x03\x04junk")
    aid = f"{fake._n:012x}"  # the id the engine just minted
    fake.members[("s1", aid)] = {"src/index.js": "console.log(1)\n",
                                 "README.txt": "zip readme"}
    out = da.run_action(c, "entry", name="bundle.zip", member="src/index.js")
    assert "index.js" in out and "console.log(1)" in out
    out = da.run_action(c, "entry", name="bundle.zip", member="nope.js")
    assert "member not found" in out
    assert "member=" in da.run_action(c, "entry", name="bundle.zip")

    out = da.run_action(c, "extract", name="bundle.zip")
    assert "extracted 2 member(s) from bundle.zip" in out
    # each member became its own artifact (basename, source=extracted)
    names = {r["meta"]["name"]: r["meta"] for r in fake.store["s1"].values()}
    assert names["index.js"]["source"] == "extracted"
    assert names["README.txt"]["source"] == "extracted"
    out = da.run_action(c, "list")
    assert "index.js" in out and "README.txt" in out


def test_dispatch_help_unknown_and_events():
    fake = FakeEngine()
    c = make_client(fake)
    out = da.run_action(c, "help")
    assert "Actions:" in out and "download_url" in out
    out = da.run_action(c, "bogus")
    assert "unknown action" in out and "help" in out
    # ctx.log progress events fire for mutations (oplog seam)
    events: list = []
    log = lambda event, **kw: events.append((event, kw))  # noqa: E731
    da.run_action(c, "create", name="e.txt", content="x", log=log)
    da.run_action(c, "write", name="e.txt", content="y", log=log)
    da.run_action(c, "delete", name="e.txt", log=log)
    kinds = [e[0] for e in events]
    assert kinds == ["artifact_created", "artifact_written", "artifact_deleted"]
    assert events[0][1]["name"] == "e.txt" and events[0][1]["aid"]


def test_build_never_raises():
    """dt_spec rule 2: build() over a minimal ctx returns tools (strands
    present) or [] (absent) — and never raises either way."""
    ctx = SimpleNamespace(engine_url="http://engine.test",
                          chat_session_id="s1", log=None)
    tools = da.build(ctx)
    try:
        import strands  # noqa: F401
        assert len(tools) == 1 and callable(tools[0])
    except ImportError:
        assert tools == []
    # a ctx missing every attribute still must not raise (rule 2)
    assert isinstance(da.build(SimpleNamespace()), list)
    assert isinstance(da.build(None), (list,))


# ── standalone runner ─────────────────────────────────────────────────────

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
        except Exception as exc:  # noqa: BLE001 — a crash is a failure too
            failed += 1
            print(f"ERROR {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"{len(fns) - failed}/{len(fns)} tests passed")
    sys.exit(1 if failed else 0)
