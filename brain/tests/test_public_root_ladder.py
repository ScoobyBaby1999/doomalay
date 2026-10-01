"""test_public_root_ladder.py — v0.91.4 THE PERSISTENT PUBLIC ROOT.

brain/server.py's _resolve_public_root() is the ladder that decides where
the agent's published work lives (and what the Space's landing page serves
at "/" via the template's _published_index):

  1. $DOOMALAY_PUBLIC_ROOT (explicit override, tests ride this)
  2. /data/public          — persistent storage mounts (when present)
  3. <repo>/public         — COMMITTED to the space repo (survives the
                             free-Space restart — THE persistence path
                             HARNESS.md teaches)
  4. /tmp/doomalay-public  — ephemeral fallback (wiped on restart)

The ladder is exercised by CALLING _resolve_public_root() (it reads the
env at call time) — never by reloading the module (a reload would rebind
PUBLIC_ROOT out from under test_pub_route's fixtures).

Plus the drift guards: both template app.py copies serve the published
index at the Space ROOT (the user's "I only see JSON metadata" report),
and HARNESS.md documents the persistence path.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# NOTE: server is imported LAZILY inside _ladder — a module-level import
# would bind brain_server.PUBLIC_ROOT before test_pub_route's fixture env
# lands (pytest collects in arg order; running this file first would leave
# the pub-route suite serving the wrong root — the live catch).
_REAL_SERVER_FILE = str(Path(__file__).resolve().parent.parent / "server.py")


def _ladder(env=None, data_mount=False, repo_public=False):
    """Call the ladder under controlled conditions; restores everything.

    repo_public builds a REAL fake repo layout under /tmp (Path.is_dir()
    hits os.stat — it cannot be faked by patching os.path.isdir, the live
    catch; the /data check in the module code uses os.path.isdir
    explicitly and IS patchable)."""
    import server as brain_server
    old_env = os.environ.get("DOOMALAY_PUBLIC_ROOT")
    old_isdir = os.path.isdir
    fake_tree = None

    def fake_isdir(p):
        p = str(p)
        if p == "/data":
            return data_mount
        return old_isdir(p)

    try:
        if env is None:
            os.environ.pop("DOOMALAY_PUBLIC_ROOT", None)
        else:
            os.environ["DOOMALAY_PUBLIC_ROOT"] = env
        if repo_public:
            # a REAL fake repo layout: <repo>/public/ exists (Path.is_dir()
            # must see it); the module's __file__ points inside it
            fake_tree = tempfile.mkdtemp(prefix="fake-repo-")
            Path(fake_tree, "brain").mkdir(parents=True)
            Path(fake_tree, "public").mkdir()
            brain_server.__file__ = str(Path(fake_tree, "brain", "server.py"))
        os.path.isdir = fake_isdir
        return brain_server._resolve_public_root(), fake_tree
    finally:
        if old_env is None:
            os.environ.pop("DOOMALAY_PUBLIC_ROOT", None)
        else:
            os.environ["DOOMALAY_PUBLIC_ROOT"] = old_env
        os.path.isdir = old_isdir
        # restore the module's real __file__ (a copied-in module var)
        brain_server.__file__ = _REAL_SERVER_FILE
        if fake_tree:
            import shutil
            shutil.rmtree(fake_tree, ignore_errors=True)


def test_ladder_env_override_wins():
    with tempfile.TemporaryDirectory() as td:
        root, _ = _ladder(env=td, data_mount=True, repo_public=True)
        assert str(root) == td, root


def test_ladder_data_mount():
    root, _ = _ladder(env=None, data_mount=True)
    assert str(root) == "/data/public", root


def test_ladder_repo_public_beats_tmp():
    """A public/ dir COMMITTED to the space repo is the persistent root —
    the branch that makes the agent's work survive free-Space restarts."""
    root, tree = _ladder(env=None, data_mount=False, repo_public=True)
    assert str(root) == str(Path(tree, "public")), root


def test_ladder_tmp_fallback():
    root, _ = _ladder(env=None, data_mount=False, repo_public=False)
    assert str(root) == "/tmp/doomalay-public", root


def test_space_root_serves_published_index_drift_guard():
    """Both space templates (gradio + docker) serve the agent's published
    index.html at the Space ROOT — the JSON info blob is only the
    EMPTY-space default. This is the fix for the user's report: 'the space
    shows only JSON metadata while the game lives one path deeper'."""
    here = Path(__file__).resolve().parent.parent  # brain/
    templates = [
        here.parent / "engine" / "internal" / "hfzero" / "template" / "app.py",
        here.parent / "engine" / "internal" / "hfzero" / "template" / "docker-app.py",
    ]
    for tpl in templates:
        assert tpl.is_file(), f"template missing: {tpl}"
        src = tpl.read_text(encoding="utf-8")
        assert "_published_index" in src, f"{tpl.name}: the root-serving helper is gone"
        assert "FileResponse" in src, f"{tpl.name}: the root must serve the file"
        # the root route consults the published index BEFORE the JSON blob
        root_at = src.index("def root(")
        assert "_idx = _published_index()" in src[root_at:root_at + 400], \
            f"{tpl.name}: the root route must serve the published index"


def test_harness_documents_persistence_path():
    """HARNESS.md must teach the restart-survival move (commit public/ to
    the space repo) — the doc and the ladder cannot drift apart."""
    harness = Path(Path(__file__).resolve().parent.parent) / "HARNESS.md"
    text = harness.read_text(encoding="utf-8")
    assert "MAKING IT SURVIVE RESTARTS" in text, "the persistence section is gone"
    assert "public/" in text
    # the landing-page contract
    assert "landing page" in text
