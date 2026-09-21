"""test_dt_hf.py — offline unit tests for brain/tools/dt_hf.py.

Covers the plain core only: no strands, no network, no real Hugging Face
calls (the orchestrator already proved live upload works — tests never go
near the hub). A FakeHfApi records every create_repo/upload_folder/
upload_file/repo_info call so the exact hub arguments can be asserted.

THE INVARIANT UNDER TEST (hard rule from the task): the HF token NEVER
appears in any recorded hub-call argument or in any tool output string.
The fake api's whoami deliberately returns email + avatar fields — the
tests assert those are dropped too (whoami must surface username + token
status ONLY).

Runs standalone (`python3 tests/test_dt_hf.py`) AND under pytest.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

# Import the tool module straight from brain/tools/ (no package layout);
# brain/ itself goes on the path so dt_registry can be imported for the
# build() test when it is available.
_TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
_BRAIN_DIR = _TOOLS_DIR.parent
for _p in (str(_TOOLS_DIR), str(_BRAIN_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import dt_hf  # noqa: E402

# A FAKE token — obviously not a real credential. Every test that "uses" the
# token threads THIS value through so the leak assertions are meaningful.
FAKE_TOKEN = "hf_fake_token_never_leak_9f3ab2"

ENV_WITH_TOKEN = {"HF_TOKEN": FAKE_TOKEN}
# The alias must work exactly like HF_TOKEN (old app accepted both).
ENV_ALIAS = {"HUGGINGFACE_TOKEN": FAKE_TOKEN}


# ── fixtures ─────────────────────────────────────────────────────────────

class FakeHfApi:
    """Records hub calls; never touches the network.

    whoami returns the fixed user PLUS deliberately sensitive fields
    (email, avatar) — the tool must ignore everything except "name".
    """

    user = "fakeuser"

    def __init__(self):
        self.calls = []

    def whoami(self):
        self.calls.append(("whoami", {}))
        return {
            "name": self.user,
            "email": "private-email-must-not-appear@example.com",
            "avatarUrl": "https://example.com/avatar-must-not-appear.png",
            "auth": {"accessToken": "must-not-appear"},
        }

    def create_repo(self, repo_id, private=None, repo_type=None,
                    exist_ok=None, **kw):
        self.calls.append(("create_repo", {
            "repo_id": repo_id, "private": private,
            "repo_type": repo_type, "exist_ok": exist_ok}))
        return f"https://huggingface.co/datasets/{repo_id}"

    def upload_folder(self, **kw):
        rec = dict(kw)
        # snapshot the staged tree at call time — it is deleted right after
        # the upload, so asserting later needs a copy of the listing.
        try:
            fp = Path(kw["folder_path"])
            rec["_staged_files"] = sorted(
                p.relative_to(fp).as_posix()
                for p in fp.rglob("*") if p.is_file())
        except Exception:
            rec["_staged_files"] = None
        self.calls.append(("upload_folder", rec))
        return SimpleNamespace(
            commit_url=f"https://huggingface.co/datasets/{kw['repo_id']}/commit/abc123")

    def upload_file(self, **kw):
        self.calls.append(("upload_file", dict(kw)))
        return SimpleNamespace(
            commit_url=f"https://huggingface.co/datasets/{kw['repo_id']}/commit/def456")

    def repo_info(self, repo_id, repo_type=None, **kw):
        self.calls.append(("repo_info", {"repo_id": repo_id, "repo_type": repo_type}))
        if "missing" in repo_id:
            raise RuntimeError("404 Repository not found")
        return SimpleNamespace(id=repo_id, private=False)

    def list_datasets(self, author=None, limit=None, **kw):
        self.calls.append(("list_datasets", {"author": author, "limit": limit}))
        return [
            SimpleNamespace(id=f"{author}/ds-alpha",
                            last_modified="2025-04-01T10:00:00Z", private=False),
            SimpleNamespace(id=f"{author}/ds-beta",
                            last_modified="2025-05-02T10:00:00Z", private=True),
        ]

    def list_models(self, author=None, limit=None, **kw):
        self.calls.append(("list_models", {"author": author, "limit": limit}))
        return []

    def list_spaces(self, author=None, limit=None, **kw):
        self.calls.append(("list_spaces", {"author": author, "limit": limit}))
        return []


class CreateBoomApi:
    """create_repo explodes — proves create failures become strings."""

    def whoami(self):
        return {"name": "boomuser"}

    def create_repo(self, **kw):
        raise RuntimeError("hub exploded on create 500")


class UploadBoomApi:
    """create_repo succeeds, uploads explode — the 'upload failed: <msg>' path."""

    def whoami(self):
        return {"name": "boomuser"}

    def create_repo(self, **kw):
        return None

    def upload_file(self, **kw):
        raise RuntimeError("boom 500 during upload")

    def upload_folder(self, **kw):
        raise RuntimeError("boom 500 during folder upload")


def _factory(api):
    """api_factory seam: PROVES the token reaches the factory (the real one
    builds HfApi(token=...)) while everything downstream must never see it."""
    def factory(token):
        assert token == FAKE_TOKEN, "token must be threaded to the api factory"
        return api
    return factory


def _mkws():
    """Temp workspace with a realistic mix of publishable and junk files."""
    tmp = Path(tempfile.mkdtemp(prefix="dt-hf-test-"))
    ws = tmp / "ws"
    (ws / "reports" / "sub").mkdir(parents=True)
    (ws / "reports" / "a.md").write_text("A" * 10, encoding="utf-8")
    (ws / "reports" / "sub" / "b.md").write_text("B" * 20, encoding="utf-8")
    (ws / "root.md").write_text("R", encoding="utf-8")
    (ws / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (ws / ".git").mkdir()
    (ws / ".git" / "config").write_text("cfg", encoding="utf-8")
    (ws / ".venv").mkdir()
    (ws / ".venv" / "lib.py").write_text("v", encoding="utf-8")
    (ws / "__pycache__").mkdir()
    (ws / "__pycache__" / "m.pyc").write_bytes(b"\x00\x01")
    (ws / "node_modules").mkdir()
    (ws / "node_modules" / "pkg.js").write_text("p", encoding="utf-8")
    (ws / ".env").write_text("SECRET=1", encoding="utf-8")
    # a stray bytecode file OUTSIDE __pycache__ — exercises the suffix rule
    (ws / "stray.pyc").write_bytes(b"\x00\x02")
    state = tmp / "state"
    state.mkdir()
    return ws, state, tmp


def _clean(ws_parent_tmp):
    shutil.rmtree(ws_parent_tmp, ignore_errors=True)


def assert_no_token(api, *outputs):
    """THE hard assertion: token in no recorded arg, no output — ever."""
    blob = json.dumps([list(c) for c in api.calls], default=str)
    assert FAKE_TOKEN not in blob, "TOKEN LEAKED into hub call args"
    for out in outputs:
        assert FAKE_TOKEN not in str(out), "TOKEN LEAKED into tool output"


def _calls(api, kind):
    return [c for c in api.calls if c[0] == kind]


# ── safe_slug ────────────────────────────────────────────────────────────

def test_safe_slug():
    assert dt_hf.safe_slug("My Cool Dataset!") == "my-cool-dataset"
    assert dt_hf.safe_slug("  spaced   out  ") == "spaced-out"
    assert dt_hf.safe_slug("ALLCAPS") == "allcaps"
    assert dt_hf.safe_slug("café_résumé") == "cafe-resume"       # NFKD ascii fold
    assert dt_hf.safe_slug("数据") == "dataset"                    # nothing survives
    assert dt_hf.safe_slug("") == "dataset"
    assert dt_hf.safe_slug("---___") == "dataset"
    assert dt_hf.safe_slug("v1.2") == "v1-2"                      # dots gone for repo ids
    assert dt_hf.safe_slug("v1.2.md", allow_dots=True) == "v1.2.md"  # kept for file names
    assert dt_hf.safe_slug("a" * 200) == "a" * 64                 # repo-name length cap


# ── resolve_repo ─────────────────────────────────────────────────────────

def test_resolve_repo_default_naming():
    # the doomalay-superpowers shape: {user}/doomalay-<slug>
    assert dt_hf.resolve_repo("fakeuser", "x") == "fakeuser/doomalay-x"
    assert dt_hf.resolve_repo("fakeuser", "My Set!") == "fakeuser/doomalay-my-set"
    # no double prefix when the name already carries it
    assert dt_hf.resolve_repo("fakeuser", "doomalay-y") == "fakeuser/doomalay-y"
    assert dt_hf.resolve_repo("fakeuser", "doomalay") == "fakeuser/doomalay"
    # fully-qualified ids pass through verbatim
    assert dt_hf.resolve_repo("fakeuser", "other/repo") == "other/repo"
    assert dt_hf.resolve_repo("fakeuser", "ScoobyBaby1999/doomalay-superpowers") \
        == "ScoobyBaby1999/doomalay-superpowers"
    # empty name → bare fallback; empty user → honest "unknown"
    assert dt_hf.resolve_repo("fakeuser", "") == "fakeuser/doomalay"
    assert dt_hf.resolve_repo("", "x") == "unknown/doomalay-x"


# ── gather_files ─────────────────────────────────────────────────────────

def test_gather_files_dir_and_glob():
    ws, _state, tmp = _mkws()
    try:
        # directory mode — mirrors the workspace layout (like the
        # doomalay-superpowers folder upload)
        files = dt_hf.gather_files(ws, "reports")
        assert sorted(r for _, r in files) == ["reports/a.md", "reports/sub/b.md"]
        # abs paths are real workspace files, rels are workspace-relative
        for ab, rel in files:
            assert ab.is_file() and (ws / rel).is_file()

        # glob mode — root-level *.md only matches root.md (fnmatch in the
        # fallback path also matches nested, but Path.glob semantics apply
        # first and both are skip-filtered)
        files = dt_hf.gather_files(ws, "*.md")
        assert sorted(r for _, r in files) == ["root.md"]

        # recursive glob picks up nested + root files
        files = dt_hf.gather_files(ws, "**/*.md")
        rels = sorted(r for _, r in files)
        assert rels == ["reports/a.md", "reports/sub/b.md", "root.md"]

        # single literal file
        files = dt_hf.gather_files(ws, "data.csv")
        assert [r for _, r in files] == ["data.csv"]

        # glob matching a directory expands into it ("repor*" → reports/)
        files = dt_hf.gather_files(ws, "repor*")
        rels = sorted(r for _, r in files)
        assert rels == ["reports/a.md", "reports/sub/b.md"]

        # leading ./ is tolerated
        files = dt_hf.gather_files(ws, "./reports")
        assert len(files) == 2
    finally:
        _clean(tmp)


def test_gather_files_skip_list():
    ws, _state, tmp = _mkws()
    try:
        skipped = []
        files = dt_hf.gather_files(ws, "**/*", skipped)
        rels = [r for _, r in files]
        # .git / .venv / __pycache__ / node_modules / dotfiles never publish
        assert not any(r.startswith(".git") for r in rels)
        assert not any(r.startswith(".venv") for r in rels)
        assert not any("__pycache__" in r for r in rels)
        assert not any(r.startswith("node_modules") for r in rels)
        assert ".env" not in rels
        assert not any(r.endswith(".pyc") for r in rels)
        # …and the reasons are reported for the manifest
        reasons = " ".join(f"{r} {why}" for r, why in skipped)
        assert "dotfile" in reasons and ".git" in reasons
        assert "skip-dir" in reasons and "node_modules" in reasons
        assert "bytecode" in reasons
        # whole-workspace publish has the SAME publishable set (junk pruned
        # earlier in walk mode, filtered at match time in glob mode — the
        # manifest must not care which path was taken)
        rels2 = [r for _, r in dt_hf.gather_files(ws, ".")]
        assert rels == rels2
    finally:
        _clean(tmp)


def test_gather_files_oversize_cap():
    ws, _state, tmp = _mkws()
    try:
        (ws / "big.bin").write_bytes(b"x" * 100)
        saved = dt_hf.MAX_FILE_BYTES          # shrink the cap instead of writing 50MB
        dt_hf.MAX_FILE_BYTES = 10
        try:
            skipped = []
            files = dt_hf.gather_files(ws, "big.bin", skipped)
            assert files == []
            assert skipped and skipped[0][0] == "big.bin" and "oversize" in skipped[0][1]
        finally:
            dt_hf.MAX_FILE_BYTES = saved
    finally:
        _clean(tmp)


def test_gather_files_too_many_guard():
    ws, _state, tmp = _mkws()
    try:
        saved = dt_hf.MAX_FILES
        dt_hf.MAX_FILES = 3
        try:
            try:
                dt_hf.gather_files(ws, "**/*")
                raise AssertionError("cap not enforced")
            except ValueError as exc:
                assert "too many files" in str(exc)
        finally:
            dt_hf.MAX_FILES = saved
    finally:
        _clean(tmp)


def test_path_escape_guard():
    ws, _state, tmp = _mkws()
    try:
        # the spec's literal example must be rejected by the plain core…
        for bad in ("../../etc/passwd", "/etc/passwd", ".."):
            try:
                dt_hf.gather_files(ws, bad)
                raise AssertionError(f"escape not rejected: {bad}")
            except ValueError as exc:
                assert "escapes workspace" in str(exc)
        # …and by the action layer as a returned string (never a raise).
        for env in (ENV_WITH_TOKEN, {}):
            out = dt_hf.run_action("publish", workspace=ws, env=env,
                                   path="../../etc/passwd")
            assert "publish rejected" in out and "escapes workspace" in out, out
            assert FAKE_TOKEN not in out
    finally:
        _clean(tmp)


def test_symlink_escape_guard():
    ws, _state, tmp = _mkws()
    try:
        # a symlink INSIDE the workspace pointing OUT would leak host files
        # through glob mode (Path.glob follows symlinked dirs); the resolve()
        # guards must refuse it.
        os.symlink("/etc/hostname", ws / "evil.txt")
        # literal path: the guard-1 resolve() catches it as a workspace escape
        try:
            dt_hf.gather_files(ws, "evil.txt")
            raise AssertionError("symlink escape not rejected (literal mode)")
        except ValueError as exc:
            assert "escapes workspace" in str(exc)
        # the action layer converts that to a returned string, never a raise
        out = dt_hf.run_action("publish", workspace=ws, env=ENV_WITH_TOKEN,
                               path="evil.txt")
        assert "publish rejected" in out and "escapes workspace" in out
        # glob mode: the per-file guard skips it instead of matching
        for pattern in ("*.txt", "**/*"):
            files = dt_hf.gather_files(ws, pattern)
            assert "evil.txt" not in [r for _, r in files], pattern
    finally:
        _clean(tmp)


# ── publish (folder + single file) ───────────────────────────────────────

def test_publish_folder_fake_api():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish", workspace=ws, state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               path="reports")
        # default repo naming straight from the whoami user + path basename
        cr = _calls(api, "create_repo")
        assert len(cr) == 1
        assert cr[0][1]["repo_id"] == "fakeuser/doomalay-reports"
        assert cr[0][1]["exist_ok"] is True
        assert cr[0][1]["repo_type"] == "dataset"
        assert cr[0][1]["private"] is False

        # folder upload via upload_folder with the filtered manifest staged
        uf = _calls(api, "upload_folder")
        assert len(uf) == 1
        kw = uf[0][1]
        assert kw["repo_id"] == "fakeuser/doomalay-reports"
        assert kw["path_in_repo"] == ""
        assert kw["repo_type"] == "dataset"
        assert "doomalay publish" in kw["commit_message"]
        assert kw["_staged_files"] == ["reports/a.md", "reports/sub/b.md"]

        # output: commit URL + file manifest + state pointer
        assert "fakeuser/doomalay-reports" in out
        assert "https://huggingface.co/datasets/fakeuser/doomalay-reports" in out
        assert "reports/a.md" in out and "reports/sub/b.md" in out
        assert "last_publish.json" in out
        assert_no_token(api, out)
    finally:
        _clean(tmp)


def test_publish_single_file_uses_upload_file():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish", workspace=ws, state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               path="data.csv", private="true",
                               commit_message="custom msg")
        uf = _calls(api, "upload_file")
        assert len(uf) == 1
        kw = uf[0][1]
        # default repo from the path basename ("data.csv" slugs to data-csv);
        # single literal file → upload_file with the workspace-relative
        # path_in_repo and the custom commit message.
        assert kw["repo_id"] == "fakeuser/doomalay-data-csv"
        assert kw["path_in_repo"] == "data.csv"
        assert kw["commit_message"] == "custom msg"
        assert Path(str(kw["path_or_fileobj"])).is_file()
        assert "data.csv" in out
        # private=true honored on repo creation (string "true" coerced)
        cr = _calls(api, "create_repo")
        assert cr[0][1]["private"] is True
        assert "[dataset, private]" in out
        assert_no_token(api, out)
    finally:
        _clean(tmp)


def test_publish_explicit_repo_skips_whoami():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish", workspace=ws, state_dir=state,
                               api_factory=_factory(api), env=ENV_ALIAS,
                               path="reports", repo="otheruser/my-ds")
        assert "otheruser/my-ds" in out
        # qualified repo → no whoami round-trip needed
        assert _calls(api, "whoami") == []
        cr = _calls(api, "create_repo")
        assert cr[0][1]["repo_id"] == "otheruser/my-ds"
        assert_no_token(api, out)   # alias token also never leaks
    finally:
        _clean(tmp)


def test_publish_no_files_and_bad_input():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish", workspace=ws, state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               path=".git")
        assert "no publishable files" in out or "no files matched" in out
        # everything skipped → reasons surfaced, and NO repo was created
        assert _calls(api, "create_repo") == []
        out = dt_hf.run_action("publish", workspace=ws, env=ENV_WITH_TOKEN,
                               path="")
        assert "needs a path" in out
        out = dt_hf.run_action("publish", workspace=ws, env=ENV_WITH_TOKEN,
                               path="reports", repo_type="banana")
        assert "repo_type must be" in out
        out = dt_hf.run_action("publish", workspace=ws, env=ENV_WITH_TOKEN,
                               path="no/such/dir")
        assert "no such file" in out
    finally:
        _clean(tmp)


def test_publish_writes_state():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        dt_hf.run_action("publish", workspace=ws, state_dir=state,
                         api_factory=_factory(api), env=ENV_WITH_TOKEN,
                         path="reports")
        lines = (state / "publishes.jsonl").read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 1
        rec = json.loads(lines[0])
        assert rec["repo"] == "fakeuser/doomalay-reports"
        assert rec["files"] == ["reports/a.md", "reports/sub/b.md"]
        assert rec["action"] == "publish" and rec["file_count"] == 2
        # atomic round-trip through the state helpers
        last = dt_hf._load_state(state / "last_publish.json")
        assert last["repo"] == "fakeuser/doomalay-reports"
        # a second publish appends (append-only log, not overwrite)
        dt_hf.run_action("publish", workspace=ws, state_dir=state,
                         api_factory=_factory(api), env=ENV_WITH_TOKEN,
                         path="root.md")
        lines = (state / "publishes.jsonl").read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 2
        # no credential material in state
        assert FAKE_TOKEN not in (state / "publishes.jsonl").read_text(encoding="utf-8")
        assert FAKE_TOKEN not in (state / "last_publish.json").read_text(encoding="utf-8")
    finally:
        _clean(tmp)


def test_publish_progress_events():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    events = []

    def log(event, **fields):
        events.append((event, fields))
    try:
        dt_hf.run_action("publish", workspace=ws, state_dir=state, log=log,
                         api_factory=_factory(api), env=ENV_WITH_TOKEN,
                         path="reports")
        phases = [f.get("phase") for e, f in events if e == "hf_publish"]
        assert phases == ["start", "repo-ready", "uploaded"]
        start = [f for e, f in events if e == "hf_publish" and f.get("phase") == "start"][0]
        assert start["repo"] == "fakeuser/doomalay-reports" and start["files"] == 2
        # live events carry no token either
        assert FAKE_TOKEN not in json.dumps(events, default=str)
    finally:
        _clean(tmp)


# ── publish_text ─────────────────────────────────────────────────────────

def test_publish_text_args_and_no_token_leak():
    _ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish_text", state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               name="My Analysis!.md", content="# hi\nthere")
        # exactly one upload_file with the slugged name at the repo root
        uf = _calls(api, "upload_file")
        assert len(uf) == 1
        kw = uf[0][1]
        assert kw["path_in_repo"] == "my-analysis.md"
        assert kw["repo_id"] == "fakeuser/doomalay-my-analysis"
        assert kw["repo_type"] == "dataset"
        assert kw["path_or_fileobj"] == b"# hi\nthere"          # bytes payload
        assert "my-analysis.md" in kw["commit_message"]
        # repo auto-created first, public by default
        cr = _calls(api, "create_repo")
        assert cr[0][1]["repo_id"] == "fakeuser/doomalay-my-analysis"
        assert cr[0][1]["exist_ok"] is True and cr[0][1]["private"] is False
        # output points at the file + commit
        assert "blob/main/my-analysis.md" in out and "def456" in out
        # THE hard rule: token in no recorded arg, no output
        assert_no_token(api, out)
    finally:
        _clean(tmp)


def test_publish_text_explicit_repo():
    _ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish_text", state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               name="results.jsonl", content='{"a":1}\n',
                               repo="fakeuser/doomalay-superpowers")
        kw = _calls(api, "upload_file")[0][1]
        assert kw["repo_id"] == "fakeuser/doomalay-superpowers"
        assert kw["path_in_repo"] == "results.jsonl"
        assert_no_token(api, out)
    finally:
        _clean(tmp)


def test_publish_text_needs_name():
    _ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("publish_text", state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               name="", content="x")
        assert "needs a name" in out
        assert _calls(api, "upload_file") == []
    finally:
        _clean(tmp)


# ── dataset_card ─────────────────────────────────────────────────────────

def test_card_frontmatter_shape():
    card = dt_hf.build_card(
        "fakeuser/doomalay-x", "a test summary",
        [("/abs/ign/a.md", "reports/a.md"), "reports/sub/b.md"])
    lines = card.splitlines()
    assert lines[0] == "---"
    # frontmatter block: license mit + tags, closed by a bare ---
    fm_end = next(i for i, l in enumerate(lines[1:], 1) if l.strip() == "---")
    front = "\n".join(lines[:fm_end])
    assert "license: mit" in front
    assert "tags:" in front and "- doomalay" in front
    assert "pretty_name: doomalay-x" in front
    # the four fixed sections
    for sect in ("## What this is", "## Why it exists", "## Structure", "## Usage"):
        assert sect in card
    # structure lists the supplied files; usage loads the repo id
    assert "reports/a.md" in card and "reports/sub/b.md" in card
    assert 'load_dataset("fakeuser/doomalay-x")' in card
    # default summary when none given
    card2 = dt_hf.build_card("fakeuser/doomalay-x")
    assert "doomalay chat" in card2


def test_dataset_card_render_only_is_offline():
    # no token, no api factory → pure render, never fails, never uploads
    ws, _state, tmp = _mkws()
    try:
        out = dt_hf.run_action("dataset_card", workspace=ws, env={},
                               repo="fakeuser/doomalay-x", summary="s",
                               path="reports")
        assert out.startswith("---")
        assert "reports/a.md" in out          # structure from the real path
        assert "NOT uploaded" not in out      # render-only: no complaint
    finally:
        _clean(tmp)


def test_dataset_card_upload():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        out = dt_hf.run_action("dataset_card", workspace=ws, state_dir=state,
                               api_factory=_factory(api), env=ENV_WITH_TOKEN,
                               repo="fakeuser/doomalay-reports", summary="my data",
                               path="reports", upload=True)
        assert out.startswith("---")                       # card text returned
        assert "card uploaded as README.md" in out
        kw = _calls(api, "upload_file")[0][1]
        assert kw["path_in_repo"] == "README.md"
        assert kw["repo_id"] == "fakeuser/doomalay-reports"
        assert b"license: mit" in kw["path_or_fileobj"]    # card bytes uploaded
        assert_no_token(api, out)
    finally:
        _clean(tmp)


# ── whoami / list / exists / help ────────────────────────────────────────

def test_whoami_minimal():
    api = FakeHfApi()
    out = dt_hf.run_action("whoami", api_factory=_factory(api),
                           env=ENV_WITH_TOKEN)
    assert "fakeuser" in out and "token: set" in out
    assert "doomalay-<slug>" in out                       # default-repo hint
    # ONLY username + status — the sensitive whoami fields never surface
    for forbidden in ("private-email", "avatar-must-not-appear", "accessToken",
                      "must-not-appear"):
        assert forbidden not in out, forbidden
    assert_no_token(api, out)


def test_list():
    api = FakeHfApi()
    out = dt_hf.run_action("list", api_factory=_factory(api), env=ENV_WITH_TOKEN)
    assert "fakeuser/ds-alpha" in out and "fakeuser/ds-beta" in out
    assert "2025-04-01" in out and "2025-05-02" in out
    assert "private" in out and "public" in out
    kw = _calls(api, "list_datasets")[0][1]
    assert kw["author"] == "fakeuser" and kw["limit"] == 20
    assert_no_token(api, out)
    # repo_type routing
    out = dt_hf.run_action("list", api_factory=_factory(api),
                           env=ENV_WITH_TOKEN, repo_type="model", limit=5)
    assert _calls(api, "list_models")[0][1]["limit"] == 5
    out = dt_hf.run_action("list", api_factory=_factory(api), env=ENV_WITH_TOKEN,
                           repo_type="spaceship")
    assert "repo_type must be" in out


def test_exists():
    api = FakeHfApi()
    out = dt_hf.run_action("exists", api_factory=_factory(api),
                           env=ENV_WITH_TOKEN, repo="fakeuser/doomalay-reports")
    assert "repo exists" in out
    assert "https://huggingface.co/datasets/fakeuser/doomalay-reports" in out
    out = dt_hf.run_action("exists", api_factory=_factory(api),
                           env=ENV_WITH_TOKEN, repo="fakeuser/missing-thing")
    assert "not found" in out and "publish would create it" in out
    # bare name resolves through the whoami user
    out = dt_hf.run_action("exists", api_factory=_factory(api),
                           env=ENV_WITH_TOKEN, repo="reports")
    assert "fakeuser/doomalay-reports" in out
    out = dt_hf.run_action("exists", api_factory=_factory(api),
                           env=ENV_WITH_TOKEN, repo="")
    assert "needs a repo" in out
    assert_no_token(api, out)


def test_help_and_unknown_action():
    out = dt_hf.run_action("help")
    for verb in ("whoami", "list", "publish", "publish_text",
                 "dataset_card", "exists"):
        assert verb in out, verb
    assert "HF_TOKEN" in out                       # names only, values never
    out = dt_hf.run_action("frobnicate")
    assert "Unknown action" in out
    out = dt_hf.run_action("")
    assert "missing action" in out
    out = dt_hf.run_action(None)
    assert "missing action" in out or "Unknown action" in out


# ── error paths ──────────────────────────────────────────────────────────

def test_missing_token_messages():
    ws, state, tmp = _mkws()
    api = FakeHfApi()
    try:
        for action, extra in (("publish", {"path": "reports"}),
                              ("publish_text", {"name": "x.md", "content": "y"}),
                              ("whoami", {}), ("list", {}), ("exists", {"repo": "a/b"})):
            out = dt_hf.run_action(action, workspace=ws, state_dir=state,
                                   api_factory=_factory(api), env={},
                                   repo_type="dataset", **extra)
            assert "HF_TOKEN not set" in out, (action, out)
            assert "unavailable" in out
        # nothing was recorded — the tool short-circuits before any hub call
        assert api.calls == []
        # the spec's exact wording for the flagship action
        out = dt_hf.run_action("publish", workspace=ws, env={}, path="reports")
        assert out.startswith("HF_TOKEN not set — publish unavailable")
    finally:
        _clean(tmp)


def test_api_exception_returns_error_string():
    _ws, state, tmp = _mkws()
    try:
        # upload explodes → "upload failed: <msg>", never raises
        out = dt_hf.run_action("publish_text", state_dir=state,
                               api_factory=_factory(UploadBoomApi()),
                               env=ENV_WITH_TOKEN,
                               name="x.md", content="y")
        assert "upload failed" in out and "boom 500" in out, out
        assert FAKE_TOKEN not in out
        # folder publish where create_repo explodes → same discipline
        ws, state2, tmp2 = _mkws()
        try:
            out = dt_hf.run_action("publish", workspace=ws, state_dir=state2,
                                   api_factory=_factory(CreateBoomApi()),
                                   env=ENV_WITH_TOKEN,
                                   path="reports")
            assert "create_repo failed" in out and "hub exploded" in out, out
            assert FAKE_TOKEN not in out
        finally:
            _clean(tmp2)
        # a crash inside an action is netted by the dispatcher, redacted
        out = dt_hf.run_action("list", api_factory=lambda t: None, env=ENV_WITH_TOKEN)
        assert "failed" in out or "crashed" in out
        assert FAKE_TOKEN not in out
    finally:
        _clean(tmp)


def test_run_timeout_guard():
    # a hung hub call must come back as (False, TimeoutError), never block
    ok, exc = dt_hf._run_timeout(lambda: time.sleep(1.0), 0.05, "test")
    assert ok is False and isinstance(exc, TimeoutError)
    ok, val = dt_hf._run_timeout(lambda: "fine", 5, "test")
    assert ok is True and val == "fine"


def test_redact_scrubs_token():
    out = dt_hf._redact(f"prefix {FAKE_TOKEN} suffix", [FAKE_TOKEN])
    assert FAKE_TOKEN not in out and "«redacted»" in out
    # empty/None secrets are no-ops
    assert dt_hf._redact("clean", [None, ""]) == "clean"


def test_get_token_env_and_alias():
    assert dt_hf._get_token(ENV_WITH_TOKEN) == FAKE_TOKEN
    assert dt_hf._get_token(ENV_ALIAS) == FAKE_TOKEN          # alias accepted
    assert dt_hf._get_token({}) == ""
    assert dt_hf._get_token({"HF_TOKEN": "  "}) == ""          # whitespace-only = unset
    # HF_TOKEN wins over the alias
    assert dt_hf._get_token({"HF_TOKEN": "a", "HUGGINGFACE_TOKEN": "b"}) == "a"


# ── strands surface ──────────────────────────────────────────────────────

def test_build_never_raises():
    tmp = Path(tempfile.mkdtemp(prefix="dt-hf-build-"))
    try:
        # real ToolContext when dt_registry is importable, namespace otherwise
        try:
            import dt_registry  # noqa: F401
            ctx = dt_registry.ToolContext(workspace=tmp)
        except Exception:
            ctx = SimpleNamespace(workspace=tmp,
                                  tool_state=lambda n: tmp / n,
                                  log=lambda *a, **k: None)
        tools = dt_hf.build(ctx)
        assert isinstance(tools, list)
        # without strands installed (this sandbox) that list is empty; with
        # strands the hf tool registers — either way help must answer offline
        # if the object is directly callable.
        if tools:
            try:
                out = tools[0](action="help")
                assert "whoami" in str(out)
            except TypeError:
                pass        # strands Tool objects have their own call path
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_tool_names_contract():
    # the registry discovers tools via TOOL_NAMES — must stay ["hf"]
    assert dt_hf.TOOL_NAMES == ["hf"]


# ── standalone runner ────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS {name}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {name}: {exc}")
        except Exception as exc:            # noqa: BLE001 — report, don't die
            failed += 1
            print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"{len(tests)} tests, {failed} failed")
    sys.exit(1 if failed else 0)
