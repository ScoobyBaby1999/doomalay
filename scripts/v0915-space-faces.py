#!/usr/bin/env python3
"""v0915-space-faces.py — put a FACE on both live spaces + refresh socreate
to v0.91.5 (the user report: 'when I go on spaces I only see the JSON
metadata — I want to see the actual game on the page').

final-test (gradio ZeroGPU): commit public/index.html (the evolution game)
— the repo tree IS the runtime on gradio SDKs, so brain/server.py's ladder
step 3 (<repo>/public) picks it up and the ROOT route (already carrying
_published_index from v0.91.4) serves it.

socreate (docker, 11 waves stale at v0.80.1): full refresh —
  - app.py            the shared gate + THE SPACE'S FACE + strands health light
  - Dockerfile        + COPY public/ /app/public/ (the ladder's step 3 on
                      docker SDKs — the repo public/ dir must ride the image)
  - requirements.txt  brain/requirements.txt (the exact-pin set)
  - brain/**          the whole current tree (124 files; deletes for the 17+
                      files the waves removed)
  - public/index.html the same game — the shared space's standing face

Every commit to a Space repo auto-rebuilds + restarts (HF spaces-overview).
"""
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
TOKEN = Path("/home/z/my-project/.secrets").read_text().split("HF_TOKEN=")[1].split("\n")[0].strip()
ROOT = Path("/home/z/my-project/doomalay")
PUB = ROOT / "scripts" / "v0915-public"

EXCLUDE_PARTS = {"tests", "__pycache__", ".pytest_cache", "journal", ".chat-ws", ".venv"}


def hf(method, url, data=None, ctype="application/json", ndjson=False):
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": ctype,
    })
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def local_brain_files():
    """The brain tree as (remote_path, local_path) pairs."""
    out = []
    for p in sorted((ROOT / "brain").rglob("*")):
        if not p.is_file():
            continue
        if EXCLUDE_PARTS & set(p.relative_to(ROOT / "brain").parts):
            continue
        out.append((str(p.relative_to(ROOT)), p))
    return out


def remote_tree(repo):
    """All file paths currently in the space repo (recursive)."""
    st, body = hf("GET", f"{API}/api/spaces/{repo}/tree/main?recursive=true")
    return {f["path"] for f in json.loads(body) if f.get("type") == "file"}


def file_op(path, body_bytes):
    return {"key": "file", "value": {
        "path": path,
        "content": base64.b64encode(body_bytes).decode(),
        "encoding": "base64"}}


def delete_op(path):
    # huggingface_hub's wire format: deletedFile (NOT {key:file, operation:delete}
    # — that 400s with "content is required if oldPath is not set")
    return {"key": "deletedFile", "value": {"path": path}}


def commit(repo, summary, ops):
    payload = "\n".join(json.dumps(o) for o in ops).encode()
    st, out = hf("POST", f"{API}/api/spaces/{repo}/commit/main", payload,
                 ctype="application/x-ndjson")
    print(f"[{repo}] commit: {st} ({len(ops)} ops) {out[:160]!r}")
    return st == 200


def wait_healthy(base, want_marker=None, marker_url="/health", timeout=1500):
    """Poll until the rebuilt space answers + (optionally) carries a marker."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(base + marker_url, method="GET")
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read()
                if want_marker is None or want_marker.encode() in body:
                    print(f"[{base}] healthy + marker present")
                    return body
                if last != ("up", body[:80]):
                    print(f"[{base}] up, marker not yet: {body[:120]!r}")
                    last = ("up", body[:80])
        except Exception as e:
            if last != ("down", str(e)[:70]):
                print(f"[{base}] building… ({str(e)[:70]})")
                last = ("down", str(e)[:70])
        time.sleep(15)
    print(f"[{base}] TIMEOUT")
    return None


def update_final_test():
    repo = "ScoobyBaby1999/doomalay-final-test"
    game = (PUB / "index.html").read_bytes()
    assert b"Evolution" in game
    ops = [{"key": "header", "value": {"summary":
        "v0.91.5: THE GAME AT THE ROOT — public/index.html (the evolution sim) "
        "committed to the repo: the ladder's step 3 (<repo>/public) is the "
        "persistence path, the root's _published_index serves it. The space's "
        "face is the agent's work, and it SURVIVES restarts."}}]
    ops.append(file_op("public/index.html", game))
    return commit(repo, "", ops)


def update_socreate():
    repo = "ScoobyBaby1999/doomalaysocreate"
    remote = remote_tree(repo)
    ops = [{"key": "header", "value": {"summary":
        "v0.91.5 refresh (was v0.80.1, 11 waves stale): THE SPACE'S FACE — the "
        "root serves the agent's published index.html + the strands health light "
        "in /health + /pub open (same contract as the own-space templates) + the "
        "full current brain tree (the python library, the hub rate-limit ride, "
        "the no-timer watchdog fixes, the answer-force nudge, the drift pins) + "
        "Dockerfile COPY public/ (the ladder's persistence step on docker SDKs) "
        "+ the standing game face in public/"}}]

    # 1. the app + the face + the dockerfile + the pins
    ops.append(file_op("app.py", (PUB / "socreate-app.py").read_bytes()))
    ops.append(file_op("public/index.html", (PUB / "index.html").read_bytes()))
    dockerfile = (ROOT / "engine" / "internal" / "hfzero" / "template" / "docker-Dockerfile").read_text()
    # socreate keeps its own WORKSPACES_ROOT (/tmp on the free tier) and root
    # requirements.txt — graft ONLY the public/ COPY onto its own Dockerfile.
    graft = ("# v0.91.5: the persistent public root rides the image (the ladder's\n"
             "# step 3 — the repo's public/ dir is the space's surviving face)\n"
             "COPY public/ /app/public/\n\n")
    anchor = "COPY app.py /app/app.py"
    assert anchor in dockerfile, "docker template drifted — anchor missing"
    socreate_dockerfile = dockerfile.replace(anchor, graft + anchor)
    ops.append(file_op("Dockerfile", socreate_dockerfile.encode()))
    ops.append(file_op("requirements.txt", (ROOT / "brain" / "requirements.txt").read_bytes()))

    # 2. the whole current brain tree
    wanted = set()
    for rel, p in local_brain_files():
        ops.append(file_op(rel, p.read_bytes()))
        wanted.add(rel)

    # 3. deletes: remote brain files the waves removed (never touch app.py,
    #    README.md, Dockerfile, requirements.txt, public/ — handled above)
    keep = {"app.py", "README.md", "Dockerfile", "requirements.txt", "public/index.html"}
    stale = {p for p in remote if p.startswith("brain/") and p not in wanted}
    for p in sorted(stale):
        ops.append(delete_op(p))
    print(f"[{repo}] {len(wanted)} brain files up, {len(stale)} stale deleted "
          f"(remote had {len(remote)})")
    return commit(repo, "", ops)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    ok = True
    if which in ("final-test", "both"):
        ok &= update_final_test()
    if which in ("socreate", "both"):
        ok &= update_socreate()
    if not ok:
        sys.exit(1)

    # verification: the final-test root must serve the GAME after rebuild
    if which in ("final-test", "both"):
        body = wait_healthy("https://scoobybaby1999-doomalay-final-test.hf.space",
                            want_marker="Evolution", marker_url="/")
        if body is None:
            sys.exit(1)

    # verification: socreate /health must report the strands light after rebuild
    if which in ("socreate", "both"):
        body = wait_healthy("https://scoobybaby1999-doomalaysocreate.hf.space",
                            want_marker="strands", marker_url="/health")
        if body is None:
            sys.exit(1)
        print("socreate health:", body[:300])
        try:
            req = urllib.request.Request("https://scoobybaby1999-doomalaysocreate.hf.space/")
            with urllib.request.urlopen(req, timeout=20) as r:
                head = r.read()[:120]
                print("socreate root:", r.status, head)
        except Exception as e:
            print("socreate root:", e)
    print("DONE")


if __name__ == "__main__":
    main()
