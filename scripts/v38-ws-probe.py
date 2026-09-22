#!/usr/bin/env python3
# v38-ws-probe.py — talk to the engine's /api/chat WS directly, dump every event + timing.
import json, os, shutil, subprocess, sys, time, threading
import urllib.request
import websocket  # pip install websocket-client (check availability)

BASE = "http://127.0.0.1:8141"
WS = "ws://127.0.0.1:8141/api/chat"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-wsprobe"
NVKEY = os.environ.get("NVIDIA_API_KEY", "")
MODEL = sys.argv[1] if len(sys.argv) > 1 else "nvidia/z-ai/glm-5.3-flash"
PROMPT = sys.argv[2] if len(sys.argv) > 2 else "Write a detailed 700 word essay about the history of computing, with headings."

if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
log = open("/tmp/wsprobe-eng.log", "w")
proc = subprocess.Popen([ENG, "-open=false", "-port=8141", f"-data-dir={DATA}"], stdout=log, stderr=log)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=30).read()

api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})
SID = json.loads(api("POST", "/api/sessions", {"title": "probe", "sandbox": "quick",
    "model": MODEL, "provider": "nvidia"}))["ID"]
print(f"session {SID} model {MODEL}")

ws = websocket.create_connection(WS + "?session_id=" + SID, timeout=240)
t0 = time.time()
ws.send(json.dumps({"type": "send", "message": PROMPT, "effort": "med"}))
counts = {}
while True:
    try:
        raw = ws.recv()
    except Exception as e:
        print(f"[{time.time()-t0:7.1f}s] WS closed: {e}")
        break
    try:
        ev = json.loads(raw)
    except Exception:
        print(f"[{time.time()-t0:7.1f}s] non-json: {raw[:120]}"); continue
    t = ev.get("type", "?")
    counts[t] = counts.get(t, 0) + 1
    if t in ("status", "error", "sources", "tool_use", "tool_result") or counts[t] <= 2 or counts[t] % 40 == 0:
        preview = (ev.get("text") or ev.get("message") or json.dumps(ev.get("usage") or ""))[:110]
        print(f"[{time.time()-t0:7.1f}s] {t}: {preview}")
    if t == "status" and ev.get("state") in ("idle", "error"):
        print(f"[{time.time()-t0:7.1f}s] TURN DONE ({ev.get('state')})"); break
    if time.time() - t0 > 300:
        print("ABORT 300s"); break
print("event counts:", counts)
ws.close(); proc.terminate(); proc.wait()
