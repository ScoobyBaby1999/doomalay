#!/usr/bin/env python3
"""v0917-mistral-e2e.py — THE MISTRRAL WAVE e2e rig (user spec: "add minstral
without any static model lists, we want to fetch all their models
dynamically as we do the other provider models").

Proves, against a REAL engine + the mock Mistral API:
  1. the catalog syncs the models LIVE (GET /v1/models → the provider group
     carries ids + the provider's OWN enrichment: max_context_length +
     capabilities{vision,function_calling})
  2. key validation is honest (200 → valid)
  3. a chat turn rides the full translation: auth header, model id, and the
     effort pill (whatever the live OR registry resolves — reported)
  4. THE LIVE VERDICT on the user's real key: api.mistral.ai answers 401
     (the pasted key is rejected — re-copy from console.mistral.ai/api-keys)
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
PORT, MPORT = 8519, 8520
BASE = f"http://127.0.0.1:{PORT}"

PASS = FAIL = 0


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  → {extra}")


def api(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main():
    procs = []

    def kill_all():
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass

    import atexit
    atexit.register(kill_all)

    # 0. THE LIVE VERDICT first — the user's real key against the real API
    print("== the live key verdict ==")
    key = open("/home/z/my-project/.secrets").read().split("MISTRAL_KEY=")[1].split("\n")[0].strip()
    try:
        req = urllib.request.Request("https://api.mistral.ai/v1/models",
                                     headers={"Authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=15) as r:
            live = f"HTTP {r.status} — the key WORKS"
    except urllib.error.HTTPError as e:
        live = f"HTTP {e.code} — the pasted key is REJECTED by api.mistral.ai ({e.read()[:80]!r})"
    except Exception as e:
        live = f"network: {e}"
    print(f"  live api.mistral.ai: {live}")
    key_ok_live = live.startswith("HTTP 200")

    # 1. the mock + the engine (base-url override → the mock)
    procs.append(subprocess.Popen([sys.executable, os.path.join(ROOT, "scripts", "v0917-mistral-mock.py"), str(MPORT)]))
    time.sleep(0.6)
    env = dict(os.environ, DOOMALAY_BASE_URL_MISTRAL=f"http://127.0.0.1:{MPORT}/v1")
    subprocess.run(["rm", "-rf", "/tmp/doomalay-v0917"])
    procs.append(subprocess.Popen([ENG, "--port", str(PORT), "--data-dir", "/tmp/doomalay-v0917"],
                                  env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for _ in range(50):
        try:
            api("/api/health")
            break
        except Exception:
            time.sleep(0.3)
    print("== the engine is up ==")

    # 2. seed the key (the app's keys flow)
    r = api("/api/keys", "POST", {"env_var": "MISTRAL_API_KEY", "provider": "mistral",
                                  "key": "mstrl_mock_key"})
    ck("the mistral key seeds into the vault", r.get("ok") is True, r)

    # 3. THE DYNAMIC CATALOG: refresh → the mistral group carries the mock's
    #    models with the provider's OWN enrichment fields parsed
    cat = api("/api/models?refresh=1")
    groups = {g["name"]: g for g in cat.get("groups", [])}
    mg = groups.get("mistral")
    ck("the mistral group synced LIVE", mg is not None and mg.get("syncedLive"), mg)
    if mg:
        ids = {m["rawId"]: m for m in (mg.get("models") or [])}
        ck("all 4 mock models fetched dynamically", len(ids) == 4, sorted(ids))
        mm = ids.get("mistral-medium-3-5", {})
        ck("mistral-medium-3-5 context parsed (max_context_length)", mm.get("contextLength") == 262144, mm.get("contextLength"))
        ck("mistral-medium-3-5 vision cap parsed (capabilities.vision)", "vision" in (mm.get("capabilities") or []), mm.get("capabilities"))
        ck("mistral-medium-3-5 tools cap parsed (capabilities.function_calling)", "tools" in (mm.get("capabilities") or []), mm.get("capabilities"))
        glm = ids.get("glm-5.3", {})
        ck("glm-5.3 context parsed (1M)", glm.get("contextLength") == 1000000, glm.get("contextLength"))
        eff = mm.get("effortLevels") or []
        print(f"  · effort surface for mistral-medium-3-5 (live OR data): {eff or 'none'} "
              f"default={mm.get('effortDefault')!r} source={mm.get('source')!r}")

    # 4. key validation honest against the mock
    v = api("/api/keys/validate?env_var=MISTRAL_API_KEY")
    ck("validation: the mock key reports valid", v.get("state") == "valid", v)

    # 5. a chat turn through the full translation (mock records the body)
    s = api("/api/sessions", "POST", {"id": "v0917-mistral", "title": "mistral e2e",
                                      "model": "mistral-medium-3-5", "provider": "mistral"})
    ck("the session creates with model mistral/mistral-medium-3-5", s.get("ok", True) is not False, s)
    # the WS turn — reuse the ws_chat.js helper
    ws = subprocess.run(
        ["node", "/home/z/my-project/scripts/ws_chat.js", "v0917-mistral",
         "say ok", "30000"],
        capture_output=True, text=True, timeout=40,
        env=dict(os.environ, WS_PORT=str(PORT)))
    print(f"  · ws turn: rc={ws.returncode} out={ws.stdout.strip()[:120]!r}")
    time.sleep(1.0)
    caps = [json.loads(l) for l in open("/tmp/v0917-mistral-captured.json") if l.strip()]
    ck("the chat turn REACHED the provider (mock captured it)", len(caps) >= 1, len(caps))
    if caps:
        b = caps[-1]["body"]
        ck("the auth header rides (Bearer)", caps[-1]["auth"] == "Bearer mstrl_mock_key", caps[-1]["auth"])
        ck("the model id rides unsullied", b.get("model") == "mistral-medium-3-5", b.get("model"))
        if "reasoning_effort" in b:
            ck("the effort pill translated (top-level reasoning_effort)",
               b.get("reasoning_effort") in ("high", "none", "low", "medium", "max"), b.get("reasoning_effort"))
            print(f"  · reasoning_effort on the wire: {b.get('reasoning_effort')!r}")
        else:
            print("  · no effort param on the wire (the live registry didn't offer one — the 400-safe path)")

    print(f"\nRESULT: {PASS} pass, {FAIL} fail"
          + ("" if FAIL == 0 else "  ← FAILURES"))
    print(f"live-key verdict: {live}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
