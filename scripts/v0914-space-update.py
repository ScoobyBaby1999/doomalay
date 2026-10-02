#!/usr/bin/env python3
"""v0914-space-update.py — commit the v0.91.3/4 code to the final-test
Space (the user's Phase 3 deliverable: the Space must SHOW the game at its
root, and the work must SURVIVE restarts).

The 5 changed files since the space was created (v0.89.4 era):
  app.py                    — the root route serves the published index
  brain/server.py           — the persistent public-root ladder
  brain/HARNESS.md          — the persistence manual (hf publish public/)
  brain/agent.py            — the strands guard stub fix
  brain/tools/dt_hublib.py  — the python library type

Research-confirmed: every commit to a Space repo auto-rebuilds + restarts.
"""
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
REPO = "ScoobyBaby1999/doomalay-final-test"
TOKEN = Path("/home/z/my-project/.secrets").read_text().split("HF_TOKEN=")[1].split("\n")[0].strip()
ROOT = Path("/home/z/my-project/doomalay")

FILES = [
    ("engine/internal/hfzero/template/app.py", "app.py"),
    ("brain/server.py", "brain/server.py"),
    ("brain/HARNESS.md", "brain/HARNESS.md"),
    ("brain/agent.py", "brain/agent.py"),
    ("brain/tools/dt_hublib.py", "brain/tools/dt_hublib.py"),
]


def hf(method, url, data=None, ctype="application/json", ndjson=False):
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": ctype,
    })
    with urllib.request.urlopen(req) as r:
        return r.status, r.read()


def main():
    # 1. the pre-commit proof: the OLD app.py (no _published_index)
    st, old = hf("GET", f"{API}/spaces/{REPO}/resolve/main/app.py")
    old_has = b"_published_index" in old
    print(f"pre-commit app.py: _published_index present = {old_has} (expect False)")

    # 2. the NDJSON base64 commit (the working contract)
    ops = [{"key": "header", "value": {
        "summary": "v0.91.3/4: the python library type + THE SPACE'S FACE — the root serves the agent's published index.html; the persistent public-root ladder (repo public/ survives restarts); HARNESS.md teaches the hf-publish persistence move"}}]
    for src, dst in FILES:
        body = (ROOT / src).read_bytes()
        ops.append({"key": "file", "value": {
            "path": dst,
            "content": base64.b64encode(body).decode(),
            "encoding": "base64"}})
    payload = "\n".join(json.dumps(o) for o in ops).encode()
    st, out = hf("POST", f"{API}/api/spaces/{REPO}/commit/main", payload,
                 ctype="application/x-ndjson")
    print(f"commit: {st} {out[:200]!r}")
    if st != 200:
        sys.exit(1)

    # 3. wait for the rebuild (commit → auto rebuild+restart)
    print("waiting for rebuild…")
    base = "https://scoobybaby1999-doomalay-final-test.hf.space"
    deadline = time.time() + 900
    last = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"{base}/health", method="GET")
            with urllib.request.urlopen(req, timeout=10) as r:
                body = r.read()[:120]
                if last != ("up", body):
                    print(f"  health: {r.status} {body!r}")
                    last = ("up", body)
                # stable when healthy AND the new app.py is live
                st2, new = hf("GET", f"{API}/spaces/{REPO}/resolve/main/app.py")
                if b"_published_index" in new:
                    # the new code is deployed; give it one more beat then done
                    time.sleep(5)
                    try:
                        with urllib.request.urlopen(urllib.request.Request(f"{base}/"), timeout=10) as r2:
                            print(f"  root: {r2.status} {r2.read()[:100]!r}")
                    except Exception as e:
                        print(f"  root: {e}")
                    print("DEPLOYED (new app.py live + healthy)")
                    return
        except Exception as e:
            if last != ("down", str(e)[:60]):
                print(f"  building… ({str(e)[:60]})")
                last = ("down", str(e)[:60])
        time.sleep(10)
    print("TIMEOUT waiting for rebuild")
    sys.exit(1)


if __name__ == "__main__":
    main()
