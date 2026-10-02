#!/usr/bin/env python3
"""v0918-space-deploy.py — push THE PM SIDECAR files to both live spaces
(the user's exact flow: PM models must work on the HF chats)."""
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
TOKEN = Path("/home/z/my-project/.secrets").read_text().split("HF_TOKEN=")[1].split("\n")[0].strip()
ROOT = Path("/home/z/my-project/doomalay")

import sys
FILES = [
    "brain/pmproxy.mjs",
    "brain/pm_sidecar.py",
    "brain/agent_core.py",
] + ([] if len(sys.argv) > 1 else [])


def hf(method, url, data=None, ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def commit(repo):
    """ONE commit with all files — huggingface_hub routes the 5.9MB wasm
    binary through the Xet/LFS protocol (the raw NDJSON commit API rejects
    binary files with 'Please use xet to store binary files')."""
    import shutil
    import tempfile
    staging = Path(tempfile.mkdtemp(prefix="pm-deploy-"))
    for rel in FILES:
        dst = staging / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)
    from huggingface_hub import HfApi
    api = HfApi(token=TOKEN)
    api.upload_folder(
        folder_path=str(staging / "brain"),  # NB: staging/brain, NOT staging (the nested brain/brain/ bug, live-caught)
        path_in_repo="brain",
        repo_id=repo,
        repo_type="space",
        commit_message="v0.91.8 THE PRIVATEMODE SIDECAR — pmproxy.mjs + pm_sidecar.py + "
                       "the vendored SDK + the catalog entry + the resolver hook + the "
                       "/health light (PM chat on the space is ALIVE)",
    )
    shutil.rmtree(staging, ignore_errors=True)
    print(f"[{repo}] upload_folder: OK")
    return True


def wait_health(base, timeout=1500):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(base + "/health"), timeout=15) as r:
                body = r.read()
                if b'"pm_sidecar"' in body:
                    print(f"[{base}] HEALTH: {body[:220]!r}")
                    return body
                if last != body[:60]:
                    print(f"[{base}] up (old health, rebuilding): {body[:100]!r}")
                    last = body[:60]
        except Exception as e:
            if last != str(e)[:60]:
                print(f"[{base}] building… ({str(e)[:60]})")
                last = str(e)[:60]
        time.sleep(15)
    print(f"[{base}] TIMEOUT")
    return None


def main():
    ok = True
    for repo in ("ScoobyBaby1999/doomalay-final-test",
                 "ScoobyBaby1999/doomalaysocreate"):
        ok &= commit(repo)
    if not ok:
        sys.exit(1)
    for base in ("https://scoobybaby1999-doomalay-final-test.hf.space",
                 "https://scoobybaby1999-doomalaysocreate.hf.space"):
        wait_health(base)
    print("DEPLOYED")


if __name__ == "__main__":
    main()
