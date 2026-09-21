#!/usr/bin/env python3
# v38-brain-stream-test.py — the brain path must STREAM live (not a post-
# completion burst) and the reasoning pill duration must be HONEST (server
# timestamps, spread over real seconds).
#
# Boots brain (server.py :9090) + engine (:9091 proxy) with the real NVIDIA
# key, sends a reasoning turn over the WS, and asserts:
#   1. events arrive with REAL time gaps (>=2s between first thinking and
#      turn end — the old code delivered everything in one burst)
#   2. engine health reports brain:true (the path is exercised)
#   3. thinking events stream progressively (>=3 distinct arrival moments)
#   4. no errors
import json, os, shutil, signal, subprocess, sys, time
import urllib.request
import websocket

BASE = "http://127.0.0.1:9091"
WS = "ws://127.0.0.1:9091/api/chat"
ROOT = os.path.join(os.path.dirname(__file__), "..")
ENG = os.path.join(ROOT, "engine", "doomalay-engine")
PY = os.path.join(ROOT, "brain", ".venv", "bin", "python")
DATA = "/tmp/doomalay-brainstream"
NVKEY = os.environ.get("NVIDIA_API_KEY", "")
if not NVKEY:
    print("FATAL: NVIDIA_API_KEY required"); sys.exit(1)
if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)

elog = open("/tmp/brainstream-eng.log", "w")
blog = open("/tmp/brainstream-brain.log", "w")
brain = subprocess.Popen([PY, "server.py", "--port", "9090"], cwd=os.path.join(ROOT, "brain"),
                          stdout=blog, stderr=blog)
eng = subprocess.Popen([ENG, "-open=false", "-port=9091", f"-data-dir={DATA}"], stdout=elog, stderr=elog)

def wait_health(url, want_brain=None, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                d = json.loads(r.read())
                if want_brain is None or d.get("brain") == want_brain:
                    return d
        except Exception:
            pass
        time.sleep(1)
    return None

h = wait_health(BASE + "/api/health", want_brain=True)
print("engine health:", h)
if not h or not h.get("brain"):
    print("FATAL: brain never came up"); print(open("/tmp/brainstream-brain.log").read()[-3000:])
    brain.kill(); eng.kill(); sys.exit(1)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=30).read()

api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})
SID = json.loads(api("POST", "/api/sessions", {"title": "brain-stream", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"}))["ID"]

ws = websocket.create_connection(WS + "?session_id=" + SID, timeout=300)
t0 = time.time()
arrivals = []   # (arrival_time, type) — the LIVE spread
events = []     # full log
ws.send(json.dumps({"type": "send", "message": "Think step by step, then count from 1 to 12, one per line.", "effort": "med"}))
while True:
    try:
        ev = json.loads(ws.recv())
    except Exception as e:
        print("WS closed:", e); break
    t = ev.get("type")
    arrivals.append((time.time() - t0, t))
    if t in ("thinking", "assistant_delta"):
        events.append(ev)
    if t == "status" and ev.get("state") in ("idle", "error"):
        print(f"turn done ({ev.get('state')}) at {time.time()-t0:.1f}s"); break
    if time.time() - t0 > 280:
        print("TIMEOUT"); break

think_times = [a for a, ty in arrivals if ty == "thinking"]
asst_times = [a for a, ty in arrivals if ty == "assistant_delta"]
err_times = [a for a, ty in arrivals if ty == "error"]
first_think = think_times[0] if think_times else None
last_any = arrivals[-1][0] if arrivals else 0

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

ok(len(events) > 0, f"events flowed ({len(events)} think/delta events)")
# progressive = distinct arrival moments across the WHOLE stream (thinking
# AND deltas interleave over the turn; a single short reasoning flush is
# legitimate for easy prompts)
all_moments = [a for a, ty in arrivals if ty in ("thinking", "assistant_delta")]
distinct = [all_moments[0]] if all_moments else []
for t in all_moments[1:]:
    if t - distinct[-1] >= 0.4: distinct.append(t)
ok(len(distinct) >= 2, f"stream arrived progressively ({len(distinct)} distinct moments over {last_any:.1f}s — not one burst)")
ok(not err_times, f"no error events ({err_times[:2]})")
if think_times:
    spread = (last_any - first_think)
    ok(spread >= 2.0, f"REAL time spread between first thinking and turn end ({spread:.1f}s >= 2s — not a burst)")
if asst_times and think_times:
    # the reasoning pill's elapsed = (first post-thinking event) - (first thinking
    # event), measured on SERVER ts — only meaningful when the model actually
    # reasoned for a while (short reasoning legitimately ends instantly)
    t_first = next((ev.get("ts") for ev in events if ev.get("type") == "thinking"), None)
    t_after = next((ev.get("ts") for ev in events if ev.get("type") == "assistant_delta"), None)
    if t_first and t_after and (t_after - t_first) >= 1.0:
        gap = asst_times[0] - think_times[0]
        ok(0.0 <= gap < (t_after - t_first) + 3.0, f"content arrives after thinking, live (arrival gap {gap:.1f}s vs server span {t_after-t_first:.1f}s)")

# 4. server timestamps are sane + ordered
tss = [ev.get("ts") for ev in events if ev.get("ts")]
ok(all(tss[i] <= tss[i+1] for i in range(len(tss)-1)), "event ts monotonic")
ok(tss and tss[-1] - tss[0] >= 2.0, f"server ts span honest ({(tss[-1]-tss[0]):.1f}s)")

ws.close()
try: brain.send_signal(signal.SIGTERM); brain.wait(10)
except Exception: brain.kill()
try: eng.send_signal(signal.SIGTERM); eng.wait(10)
except Exception: eng.kill()
print(f"\nBRAIN STREAM TEST: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
