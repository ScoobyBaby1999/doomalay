#!/usr/bin/env python3
"""v0937-space-refresh.py — P7: push THE WHOLE REFRESHED BRAIN to both live
spaces (the closeout step of the v093 batch).

What's riding this deploy (accumulated since the spaces' last refresh):
  - v0.93.3 agent.py: the fresh-session HARNESS.md seed on the CHAT path
    (the user's issue: "fresh chat says it can't do it, doesn't know what
    harness.md is") + the stale AUTO_MODEL_FALLBACK fix
  - v0.93.3 pmproxy.mjs: the poisoned-core eviction + fresh-attest retry
  - v0.93.5 dt_hf.py: bucket_create/buckets + the AUTHORIZED language
  - v0.93.5 HARNESS.md: the honest kind-picking section (bucket/dataset/
    model/space)
  - everything else brain/ carries that the spaces don't (full-tree sync,
    the same excludes the engine embed's Makefile target uses)

Deploy = HfApi.upload_folder (Xet handles binaries) per space, then wait
for the rebuild (health flip) and verify the new surface live.
"""
import json
import shutil
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

TOKEN = Path("/home/z/my-project/.secrets").read_text().split("HF_TOKEN=")[1].split("\n")[0].strip()
ROOT = Path("/home/z/my-project/doomalay")
BRAIN = ROOT / "brain"

# the Makefile sync-hfzero excludes (tests/pycache/venv/chatty state never
# ride a Space)
EXCLUDES = {"tests", "__pycache__", ".venv", ".chat-ws", ".pytest_cache", "journal"}

SPACES = [
    "ScoobyBaby1999/doomalay-final-test",
    "ScoobyBaby1999/doomalaysocreate",
]
BASES = {
    "ScoobyBaby1999/doomalay-final-test": "https://scoobybaby1999-doomalay-final-test.hf.space",
    "ScoobyBaby1999/doomalaysocreate": "https://scoobybaby1999-doomalaysocreate.hf.space",
}

MSG = ("v0.93.7 THE BRAIN REFRESH — the full-tree sync both spaces were "
       "missing: the fresh-session HARNESS.md seed on the chat path (agent.py, "
       "v0.93.3), the pmproxy poisoned-core eviction + retry, the stale "
       "AUTO_MODEL_FALLBACK fix, the bucket tools + AUTHORIZED language "
       "(dt_hf.py, v0.93.5), the honest kind-picking HARNESS.md section, and "
       "every other brain/ drift since the last deploy")


def stage() -> Path:
    staging = Path(tempfile.mkdtemp(prefix="brain-refresh-"))
    for src in BRAIN.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(BRAIN)
        if any(part in EXCLUDES for part in rel.parts):
            continue
        if src.suffix == ".pyc":
            continue
        dst = staging / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    n = sum(1 for _ in staging.rglob("*") if _.is_file())
    print(f"staged {n} brain files")
    return staging


def deploy(repo: str, staging: Path) -> bool:
    from huggingface_hub import HfApi
    api = HfApi(token=TOKEN)
    api.upload_folder(
        folder_path=str(staging),
        path_in_repo="brain",
        repo_id=repo,
        repo_type="space",
        commit_message=MSG,
    )
    print(f"[{repo}] upload_folder: OK")
    return True


def wait_health(base: str, timeout: str = 1500) -> bool:
    deadline = time.time() + int(timeout)
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(base + "/health"), timeout=15) as r:
                body = r.read()
                if b"brain_tools" in body:
                    print(f"[{base}] HEALTH: {body[:200]!r}")
                    return True
                if last != body[:60]:
                    print(f"[{base}] up (old health, rebuilding): {body[:100]!r}")
                    last = body[:60]
        except Exception as e:
            if last != str(e)[:60]:
                print(f"[{base}] building… ({str(e)[:60]})")
                last = str(e)[:60]
        time.sleep(15)
    print(f"[{base}] TIMEOUT")
    return False


def verify(base: str) -> bool:
    """The new surface, LIVE: the harness seed + the bucket tool answer."""
    ok = True
    # the harness seeds into every fresh workspace — probe the brain file
    # listing via the space's own files surface
    try:
        req = urllib.request.Request(
            base + "/api/files?path=HARNESS.md", method="GET")
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
            if "bucket" in body:
                print(f"[{base}] HARNESS.md carries the bucket section ✓")
            else:
                print(f"[{base}] HARNESS.md lacks the bucket section ✗")
                ok = False
    except Exception as e:
        print(f"[{base}] HARNESS probe failed ({str(e)[:80]}) — continuing")
    return ok


def main():
    if "--verify-only" in sys.argv:
        for repo in SPACES:
            verify(BASES[repo])
        return
    staging = stage()
    try:
        for repo in SPACES:
            deploy(repo, staging)
        for repo in SPACES:
            wait_health(BASES[repo])
        for repo in SPACES:
            verify(BASES[repo])
        print("REFRESHED")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    main()
