#!/usr/bin/env python3
# v38-parallel-probe.py — two sessions, two parallel WS turns; B must finish while A still runs.
import json, os, shutil, subprocess, sys, time, threading
import urllib.request
import websocket

BASE = "http://127.0.0.1:8142"
WS = "ws://127.0.0.1:8142/api/chat"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-parprobe"
NVKEY = os.environ.get("NVIDIA_API_KEY", "")
if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
log = open("/tmp/parprobe-eng.log", "w")
proc = subprocess.Popen([ENG, "-open=false", "-port=8142", f"-data-dir={DATA}"], stdout=log, stderr=log)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=30).read()

api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})
SID_A = json.loads(api("POST", "/api/sessions", {"title": "A", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"}))["ID"]
SID_B = json.loads(api("POST", "/api/sessions", {"title": "B", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"}))["ID"]

results = {}
def run(tag, sid, prompt, key):
    ws = websocket.create_connection(WS + "?session_id=" + sid, timeout=300)
    t0 = time.time()
    ws.send(json.dumps({"type": "send", "message": prompt, "effort": "med"}))
    n_think = n_delta = 0
    while True:
        try: ev = json.loads(ws.recv())
        except Exception as e:
            results[key] = {"err": str(e), "t": time.time()-t0}; break
        t = ev.get("type")
        if t == "thinking": n_think += 1
        if t == "assistant_delta": n_delta += 1
        if t == "status" and ev.get("state") in ("idle", "error"):
            results[key] = {"state": ev.get("state"), "t": round(time.time()-t0,1), "think": n_think, "delta": n_delta}
            break
        if time.time() - t0 > 400:
            results[key] = {"state": "timeout", "t": 400, "think": n_think, "delta": n_delta}; break
    ws.close()

ta = threading.Thread(target=run, args=("A", SID_A,
    "Write a detailed 600 word essay about the history of computing, with headings.", "A"))
tb = threading.Thread(target=run, args=("B", SID_B,
    "Count from 1 to 20, one number per line, nothing else.", "B"))
ta.start(); time.sleep(2); tb.start()
ta.join(timeout=420); tb.join(timeout=420)
print("A (long):", results.get("A"))
print("B (short):", results.get("B"))
ok = results.get("A",{}).get("state") == "idle" and results.get("B",{}).get("state") == "idle" \
     and results.get("B",{}).get("t", 999) < results.get("A",{}).get("t", 0)
print("PARALLEL TURNS:", "PASS — B finished while A ran" if ok else "CHECK — see timings")
proc.terminate(); proc.wait()
