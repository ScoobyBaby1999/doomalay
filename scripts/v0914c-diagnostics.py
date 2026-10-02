#!/usr/bin/env python3
"""v0914c-diagnostics.py — commit the silent-degradation light (health
reports the strands import state + reason) to the space, restart, and
READ the diagnosis. One shot: the import failure reason lands in /health.
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
    files = [
        (ROOT / "engine/internal/hfzero/template/app.py", "app.py"),
        (ROOT / "brain/agent.py", "brain/agent.py"),
    ]
    ops = [{"key": "header", "value": {
        "summary": "v0.91.4c: THE SILENT-DEGRADATION LIGHT — /health reports the strands import state + reason (the no-tools fallback was invisible for an hour)"}}]
    for src, dst in files:
        ops.append({"key": "file", "value": {
            "path": dst, "content": base64.b64encode(src.read_bytes()).decode(),
            "encoding": "base64"}})
    st, out = hf("POST", f"{API}/api/spaces/{REPO}/commit/main",
                 "\n".join(json.dumps(o) for o in ops).encode(),
                 ctype="application/x-ndjson")
    print(f"commit: {st} {out[:150]!r}")
    if st != 200:
        sys.exit(1)

    print("waiting for the rebuild…")
    deadline = time.time() + 900
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{BASE}/health"), timeout=10) as r:
                body = json.loads(r.read())
                print("HEALTH:", json.dumps(body, indent=1))
                if "strands" in body:
                    if body.get("strands"):
                        print("STRANDS OK — the tool path is live")
                    else:
                        print("STRANDS BROKEN — reason:", body.get("strands_error", "?"))
                    return
        except Exception as e:
            if last != str(e)[:50]:
                print(f"  building… ({str(e)[:50]})")
                last = str(e)[:50]
        time.sleep(10)
    print("TIMEOUT")
    sys.exit(1)


if __name__ == "__main__":
    main()
