#!/usr/bin/env python3
"""v0918-pm-sidecar-test.py — THE PM SIDECAR live rig (the user issue:
'privatemodeai not having any access' — PM-on-the-brain/space was dead
since the original port: the catalog pointed at a localhost Docker proxy
that cannot run on an HF Space).

Proves, against the REAL PM API with the REAL key:
  1. pm_sidecar spawns pmproxy.mjs (Node) and it answers /healthz
  2. /v1/models passthrough (the listing is plain — Bearer rides)
  3. a NON-STREAM encrypted chat through the shim (glm-latest)
  4. a STREAM encrypted chat through the shim
  5. THE BRAIN PATH: _resolve_open_model('privatemodeai/glm-latest') →
     the sidecar base_url → litellm.completion through the shim — the
     exact route a space agent turn takes. PM-ON-THE-SPACE, alive.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

BRAIN = Path("/home/z/my-project/doomalay/brain")
KEY = Path("/home/z/my-project/.secrets").read_text().split("PRIVATEMODE_KEY=")[1].split("\n")[0].strip()
BASE = "http://127.0.0.1:8530"

PASS = FAIL = 0


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  → {extra}")


def main():
    sys.path.insert(0, str(BRAIN))
    os.environ["PRIVATEMODEAI_API_KEY"] = KEY

    import pm_sidecar

    # 1. spawn + health
    t0 = time.time()
    url = pm_sidecar.pm_proxy_chat_url()
    ck("pm_sidecar spawns the Node shim", url == BASE + "/v1/chat/completions",
       f"got {url!r} after {time.time()-t0:.1f}s")
    with urllib.request.urlopen(BASE + "/healthz", timeout=5) as r:
        h = json.loads(r.read())
    ck("the shim answers /healthz", h.get("ok") is True, h)

    # 2. models passthrough
    req = urllib.request.Request(BASE + "/v1/models",
                                 headers={"Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        models = json.loads(r.read())
    ids = [m["id"] for m in models.get("data", [])]
    ck("models passthrough (the real list, no shim crypto needed)",
       "glm-latest" in ids and "kimi-k2.6" in ids, ids[:6])

    # 3. non-stream encrypted chat
    body = json.dumps({
        "model": "glm-latest",
        "messages": [{"role": "user", "content": "Reply with exactly: SIDECAR OK"}],
        "max_tokens": 2000,
    }).encode()
    req = urllib.request.Request(BASE + "/v1/chat/completions", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + KEY,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    text = (resp.get("choices") or [{}])[0].get("message", {}).get("content", "")
    ck("non-stream encrypted chat through the shim", "SIDECAR OK" in text, text[:120])

    # 4. stream encrypted chat
    req = urllib.request.Request(BASE + "/v1/chat/completions", data=json.dumps({
        "model": "glm-latest",
        "messages": [{"role": "user", "content": "Reply with exactly: STREAMED OK"}],
        "stream": True, "max_tokens": 2000,
    }).encode(), method="POST",
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    streamed = ""
    with urllib.request.urlopen(req, timeout=120) as r:
        for line in r:
            line = line.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[6:])
            streamed += (chunk.get("choices") or [{}])[0].get("delta", {}).get("content", "") or ""
    ck("stream encrypted chat through the shim", "STREAMED OK" in streamed, streamed[:120])

    # 5. THE BRAIN PATH: resolve → litellm through the shim
    print("== the brain path (the space agent's route) ==")
    import agent_core
    pair = agent_core._resolve_open_model("privatemodeai/glm-latest")
    ck("the resolver returns the SIDECAR base for PM", pair is not None and "127.0.0.1:8530" in (pair[1] or ""), pair)
    if pair:
        model, base, env, label, extra = pair
        os.environ[env] = KEY
        import litellm
        r = litellm.completion(
            model=model, api_key=os.environ[env], api_base=base,
            messages=[{"role": "user", "content": "Reply with exactly: BRAIN PATH OK"}],
            max_tokens=2000, timeout=120)
        text2 = r.choices[0].message.content or ""
        ck("litellm completion THROUGH the shim (the agent route)",
           "BRAIN PATH OK" in text2, text2[:150])

    print(f"\nRESULT: {PASS} pass, {FAIL} fail" + ("" if FAIL == 0 else "  ← FAILURES"))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
