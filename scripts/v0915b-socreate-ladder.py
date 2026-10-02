#!/usr/bin/env python3
"""v0915b-socreate-ladder.py — push the v0.91.5b ladder fix (the ephemeral
/data shadowing bug, live-found on socreate) to the space: brain/server.py
only. Small commit → fast rebuild → the root then serves the game that's
already in the image at /app/public/."""
import base64
import json
import time
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
REPO = "ScoobyBaby1999/doomalaysocreate"
TOKEN = Path("/home/z/my-project/.secrets").read_text().split("HF_TOKEN=")[1].split("\n")[0].strip()
SERVER = Path("/home/z/my-project/doomalay/brain/server.py").read_bytes()
assert b'isdir("/data/public")' in SERVER, "the ladder fix is missing from server.py"


def hf(method, url, data=None, ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


ops = [
    {"key": "header", "value": {"summary":
        "v0.91.5b THE LADDER FIX: /data/public wins only when it EXISTS — "
        "free Docker Spaces mount an EPHEMERAL /data (live-found here: the "
        "bare isdir('/data') check resolved PUBLIC_ROOT to a nonexistent "
        "/data/public and 404'd the standing face while the game sat in the "
        "image at /app/public). The repo's committed public/ now serves."}},
    {"key": "file", "value": {"path": "brain/server.py",
                              "content": base64.b64encode(SERVER).decode(),
                              "encoding": "base64"}},
]
payload = "\n".join(json.dumps(o) for o in ops).encode()
st, out = hf("POST", f"{API}/api/spaces/{REPO}/commit/main", payload,
             ctype="application/x-ndjson")
print(f"commit: {st} {out[:160]!r}")
if st != 200:
    raise SystemExit(1)

# wait for the rebuild, then the ROOT must carry the game
base = "https://scoobybaby1999-doomalaysocreate.hf.space"
deadline = time.time() + 1200
last = None
while time.time() < deadline:
    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/"), timeout=15) as r:
            body = r.read()
            if b"Doomalay \xc2\xb7 Evolution" in body or b"Evolution" in body:
                print(f"ROOT SERVES THE GAME ({len(body)} bytes)")
                raise SystemExit(0)
            if last != body[:60]:
                print(f"up, not the game yet: {body[:80]!r}")
                last = body[:60]
    except SystemExit:
        raise
    except Exception as e:
        if last != str(e)[:60]:
            print(f"building… ({str(e)[:60]})")
            last = str(e)[:60]
    time.sleep(15)
print("TIMEOUT")
raise SystemExit(1)
