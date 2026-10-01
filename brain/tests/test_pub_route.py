"""test_pub_route.py — v0.89.3 the PUBLIC ROOT (/pub) contract.

The agent writes static files to PUBLIC_ROOT; they serve OPENLY at
/pub/<file> (the "turn the Space into a viewable app" primitive from
brain/HARNESS.md). This pins:
  (1) an html file serves with the html mime type;
  (2) a bare /pub/ (and /pub/<dir>/) resolves to index.html;
  (3) traversal is IMPOSSIBLE (.. escapes → 404, never the filesystem);
  (4) missing files 404 (no listing, no hints);
  (5) unknown extensions still serve (octet-stream), oversized refuse.

Runs fully offline: imports brain/server.py with a temp PUBLIC_ROOT via
DOOMALAY_PUBLIC_ROOT (no strands, no engine).
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fastapi  # noqa: F401  (server imports it)
from fastapi.testclient import TestClient

TMP = tempfile.mkdtemp(prefix="doomalay-pub-")
os.environ["DOOMALAY_PUBLIC_ROOT"] = TMP

import server as brain_server  # noqa: E402  (after the env is set)

client = TestClient(brain_server.app)


def _write(rel: str, content: bytes) -> None:
    p = Path(TMP) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)


def test_pub_serves_html_with_mime():
    _write("hello.html", b"<h1>hello evolution</h1>")
    r = client.get("/pub/hello.html")
    assert r.status_code == 200, r.status_code
    assert r.headers["content-type"].startswith("text/html")
    assert b"hello evolution" in r.content


def test_pub_root_and_dir_resolve_to_index():
    _write("index.html", b"<title>the landing</title>")
    r = client.get("/pub/")
    assert r.status_code == 200
    assert b"the landing" in r.content
    _write("game/index.html", b"<canvas id='world'></canvas>")
    r = client.get("/pub/game/")
    assert r.status_code == 200
    assert b"world" in r.content


def test_pub_traversal_is_impossible():
    secret = Path(TMP).parent / "doomalay-pub-secret.txt"
    secret.write_text("must never serve")
    try:
        for path in ("/pub/../doomalay-pub-secret.txt",
                     "/pub/%2e%2e/doomalay-pub-secret.txt",
                     "/pub/..%2fdoomalay-pub-secret.txt"):
            r = client.get(path, follow_redirects=False)
            assert r.status_code in (404, 400), (path, r.status_code)
            assert b"must never serve" not in r.content
    finally:
        secret.unlink()


def test_pub_missing_404_no_listing():
    r = client.get("/pub/nope-does-not-exist.html")
    assert r.status_code == 404
    r = client.get("/pub/game/missing.js")
    assert r.status_code == 404


def test_pub_unknown_ext_and_mime_map():
    _write("data.bin", b"\x00\x01\x02")
    r = client.get("/pub/data.bin")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    _write("app.js", b"console.log(1)")
    r = client.get("/pub/app.js")
    assert r.headers["content-type"].startswith("text/javascript")


def test_pub_oversize_refuses():
    big = Path(TMP) / "big.bin"
    big.write_bytes(b"x" * (brain_server._PUB_MAX_BYTES + 1))
    r = client.get("/pub/big.bin")
    assert r.status_code == 413
    big.unlink()


def test_pub_is_open_and_harness_rides_the_package():
    # the space package carries the manual that DOCUMENTS /pub — the doc
    # and the route cannot drift apart.
    harness = Path(brain_server.__file__).parent / "HARNESS.md"
    assert harness.is_file(), "brain/HARNESS.md must exist"
    assert "/pub/<file>" in harness.read_text(encoding="utf-8")
