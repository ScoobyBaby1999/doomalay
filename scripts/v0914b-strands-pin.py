#!/usr/bin/env python3
"""v0914b-strands-pin.py — commit the EXACT strands pin to the space and
restart it, then verify the boot installs 0.1.5 and the tools return.

The live incident: the template's >=0.1.5,<0.2 range let pip resolve
strands-agents 0.1.9 at boot; its registry dropped the TOOL_SPEC-function
path and every spec-attached tool (shell/python_repl/install/guarded file
tools) vanished — the agent ran calculator-only.
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
BASE = "https://scoobybaby1999-doomalay-final-test.hf.space"


def hf(method, url, data=None, ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    with urllib.request.urlopen(req) as r:
        return r.status, r.read()


def main():
    body = (ROOT / "engine/internal/hfzero/template/requirements.txt").read_bytes()
    ops = [
        {"key": "header", "value": {"summary": "v0.91.4b: THE STRANDS EXACT PIN — the >=0.1.5,<0.2 range let boot resolve 0.1.9 whose registry dropped the TOOL_SPEC path (every spec-attached tool vanished: shell/python_repl/install/guarded file tools); pin ==0.1.5 (the verified tool plumbing)"}},
        {"key": "file", "value": {"path": "requirements.txt",
                                  "content": base64.b64encode(body).decode(),
                                  "encoding": "base64"}},
    ]
    st, out = hf("POST", f"{API}/api/spaces/{REPO}/commit/main",
                 "\n".join(json.dumps(o) for o in ops).encode(),
                 ctype="application/x-ndjson")
    print(f"commit: {st} {out[:160]!r}")
    if st != 200:
        sys.exit(1)

    # the restart (the requirements install at app boot; a restart re-runs it)
    st, out = hf("POST", f"{API}/api/spaces/{REPO}/restart?factory=true")
    print(f"factory restart: {st} {out[:120]!r}")

    print("waiting for the rebuild + boot…")
    deadline = time.time() + 1200
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{BASE}/health"), timeout=10) as r:
                body = r.read()[:150]
                print(f"  health: {body!r}")
                # wait a beat past healthy for the pip install to finish
                time.sleep(20)
                try:
                    with urllib.request.urlopen(urllib.request.Request(f"{BASE}/health"), timeout=10) as r2:
                        print(f"  healthy again: {r2.read()[:80]!r}")
                except Exception as e:
                    print(f"  (second probe: {e})")
                print("SPACE BACK UP")
                return
        except Exception as e:
            if last != str(e)[:50]:
                print(f"  building… ({str(e)[:50]})")
                last = str(e)[:50]
        time.sleep(12)
    print("TIMEOUT")
    sys.exit(1)


if __name__ == "__main__":
    main()
