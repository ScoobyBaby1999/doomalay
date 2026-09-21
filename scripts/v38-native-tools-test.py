#!/usr/bin/env python3
# v38-native-tools-test.py — NATIVE FUNCTION CALLING red-team: the user's
# exact zip_create repro ("produce a RAR of zip or packed folder containing
# an exercise demonstrating object oriented programming" — previously failed
# with "arguments must be a JSON object" on the ACTION text protocol).
#
# Asserts: structured tool_use pills, valid execution, artifact saved,
# turn completes; plus a native web_search round with pills + sources.
import json, os, shutil, subprocess, sys, time
import urllib.request, urllib.error
import websocket

BASE = "http://127.0.0.1:8151"
WS = "ws://127.0.0.1:8151/api/chat"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-v38nt"
NVKEY = os.environ.get("NVIDIA_API_KEY", "")
MODEL = os.environ.get("NT_MODEL", "nvidia/z-ai/glm-5.3-flash")
if not NVKEY:
    print("FATAL: NVIDIA_API_KEY required"); sys.exit(1)
if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
elog = open("/tmp/v38nt-eng.log", "w")
# NOTE: run from a scratch cwd — the engine auto-spawns the Python brain when
# ./brain + deps resolve relative to cwd; the DIRECT proxy path (native tools)
# is what this test exercises.
CW = "/tmp/doomalay-v38nt-cwd"
os.makedirs(CW, exist_ok=True)
proc = subprocess.Popen([ENG, "-open=false", "-port=8151", f"-data-dir={DATA}"], stdout=elog, stderr=elog, cwd=CW)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})
_, s = api("POST", "/api/sessions", {"title": "NT", "sandbox": "quick", "model": MODEL, "provider": "nvidia"})
SID = json.loads(s)["ID"]
print(f"session {SID} on {MODEL}")

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

def run_turn(sid, prompt, web=False, timeout=300):
    ws = websocket.create_connection(WS + "?session_id=" + sid, timeout=timeout)
    t0 = time.time()
    ws.send(json.dumps({"type": "send", "message": prompt, "effort": "med", "web_search": web}))
    events = []
    while True:
        try: ev = json.loads(ws.recv())
        except Exception as e:
            events.append({"type": "ws_closed", "err": str(e)}); break
        events.append(ev)
        if ev.get("type") == "status" and ev.get("state") in ("idle", "error"):
            break
        if time.time() - t0 > timeout:
            events.append({"type": "test_timeout"}); break
    ws.close()
    return events

# ══ 1. THE ZIP REPRO ════════════════════════════════════════════════════
print("the zip repro (native tools)")
evs = run_turn(SID, os.environ.get("ZIP_PROMPT", "Please produce a zip or packed folder containing an exercise demonstrating object oriented programming."), timeout=int(os.environ.get("ZIP_TIMEOUT", "520")))
types = [e.get("type") for e in evs]
tool_uses = [e for e in evs if e.get("type") == "tool_use"]
tool_results = [e for e in evs if e.get("type") == "tool_result"]
errors = [e for e in evs if e.get("type") == "error"]
json_errors = [e for e in tool_results if "arguments must be a JSON object" in str(e.get("text", ""))]
final_status = [e for e in evs if e.get("type") == "status" and e.get("state") in ("idle", "error")]
asst = "".join(e.get("text", "") for e in evs if e.get("type") == "assistant_delta")

ok(len(tool_uses) > 0, f"tool_use pills emitted ({[t.get('name') for t in tool_uses][:6]})")
ok(len(json_errors) == 0, f"ZERO 'arguments must be a JSON object' errors ({len(json_errors)})")
zip_call = next((t for t in tool_uses if "zip" in str(t.get("name", "")) or "archive" in str(t.get("name", ""))), None)
ok(zip_call is not None, f"a zip/archive tool was called ({zip_call and zip_call.get('name')})")
# timeline diagnostics on failure
if not tool_uses:
    from collections import Counter
    print("   event census:", dict(Counter(types)))
    print("   last 3:", [str(e)[:90] for e in evs[-3:]])
if zip_call:
    print(f"   zip_create summary: {str(zip_call.get('summary'))[:120]}")
for tr in tool_results[:6]:
    print(f"   RESULT {tr.get('name')}: {str(tr.get('text'))[:160]}")
ok(final_status and final_status[-1].get("state") == "idle", f"turn completed idle ({[s.get('state') for s in final_status]})")
ok(len(errors) == 0, f"no error events ({[str(e)[:80] for e in errors][:2]})")

# the artifact actually saved?
st, body = api("GET", f"/api/sessions/{SID}/artifacts")
arts = json.loads(body) if st == 200 else []
names = [a.get("name") for a in (arts if isinstance(arts, list) else arts.get("artifacts", []))]
ok(any(".zip" in str(n) for n in names), f"a .zip artifact exists in the drawer ({names})")
if names:
    print(f"   artifacts: {names}")

# ══ 2. NATIVE WEB SEARCH (pills + sources) ════════════════════════════════
print("native web search")
_, s2 = api("POST", "/api/sessions", {"title": "NT2", "sandbox": "quick", "model": MODEL, "provider": "nvidia"})
SID2 = json.loads(s2)["ID"]
evs2 = run_turn(SID2, "Search the web: what is the Doomalay project on GitHub? Cite sources.", web=True)
t2 = [e.get("type") for e in evs2]
search_pill = any(e.get("type") == "tool_use" and "web_search" in str(e.get("name", "")) for e in evs2)
sources_ev = any(e.get("type") == "sources" for e in evs2)
final2 = [e for e in evs2 if e.get("type") == "status" and e.get("state") in ("idle", "error")]
asst2 = "".join(e.get("text", "") for e in evs2 if e.get("type") == "assistant_delta")
ok(search_pill, "web_search executed via a REAL tool pill (not a black box)")
ok(sources_ev or len(asst2) > 50, f"sources event or substantive answer ({'sources' if sources_ev else len(asst2)} chars)")
ok(final2 and final2[-1].get("state") == "idle", f"web turn completed idle")
errs2 = [e for e in evs2 if e.get("type") == "error"]
ok(len(errs2) == 0, f"no errors in web turn ({[str(e)[:60] for e in errs2][:2]})")

proc.terminate(); proc.wait()
print(f"\n{'='*50}\nNATIVE TOOLS TEST: {PASS} passed, {FAIL} failed\n{'='*50}")
sys.exit(1 if FAIL else 0)
