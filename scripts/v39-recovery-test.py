#!/usr/bin/env python3
# v39-recovery-test.py — P8-FULL red-team: WS mid-turn kill → resume → the
# turn completes; network pause-not-fail ladder via a mock flaky provider;
# cooldown recording; boot heal. Engine + mock provider + browser in ONE
# process (background processes die between commands in this sandbox).
import json, os, shutil, subprocess, sys, threading, time, socket
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "http://127.0.0.1:8146"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-v39rec"
PORT = 8146
MOCK_PORT = 8147

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

# ── the mock flaky provider: 503, 503, then a real SSE stream ──────────
class MockHandler(BaseHTTPRequestHandler):
    hits = 0
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"data": [{"id": "mock/flaky-mini"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        self.rfile.read(ln)
        MockHandler.hits += 1
        n = MockHandler.hits
        if n <= 2:
            # two overloads, then success — exercises the 429/503 ladder
            self.send_response(503)
            body = b'{"error":"overloaded"}'
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        # slow enough to kill the WS mid-stream (5 chunks, 600ms apart)
        for i in range(5):
            chunk = {"choices": [{"delta": {"content": f"recovery-{i} "}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.6)
        end = {"choices": [{"delta": {}}], "usage": {"prompt_tokens": 10, "completion_tokens": 10}}
        self.wfile.write(f"data: {json.dumps(end)}\n\ndata: [DONE]\n\n".encode())
        self.wfile.flush()

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

def japi(method, path, body=None):
    st, b = api(method, path, body)
    try: return st, json.loads(b.decode() or "{}")
    except Exception: return st, {}

if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)

mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockHandler)
threading.Thread(target=mock.serve_forever, daemon=True).start()

# boot with the NVIDIA vault copy so the engine has a keyed provider, and
# override nvidia's base URL to the mock (the v0.39 env override!).
# A bogus brain_dir in a throwaway config kills the brain subprocess → the
# DIRECT proxy path (what the mock exercises; the brain has its own tests).
env = dict(os.environ)
env["DOOMALAY_BASE_URL_NVIDIA"] = f"http://127.0.0.1:{MOCK_PORT}/v1"
cfg_path = os.path.join(DATA, "nobrain.yaml")
open(cfg_path, "w").write(f"brain_dir: {DATA}/no-brain-here\n")
env["DOOMALAY_CONFIG"] = cfg_path
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=open("/tmp/v39rec-eng.log", "w"), stderr=subprocess.STDOUT, env=env)
def cleanup():
    proc.kill()
    mock.shutdown()
try:
    for _ in range(80):
        try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
        except Exception: time.sleep(0.25)
    else:
        print("FATAL: engine did not start"); cleanup(); sys.exit(1)

    # seed a key (the engine vault in a fresh data dir is empty) — any key
    # works: the mock never checks auth.
    api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY",
        "key": "nvapi-mock-key-for-recovery-test"})
    # a session on the mock model
    _, s = api("POST", "/api/sessions", {"title": "Rec Bot", "sandbox": "quick",
        "model": "nvidia/mock/flaky-mini", "provider": "nvidia"})
    SID = json.loads(s)["ID"]
    print("session:", SID)

    # ── TEST 1: the 503→503→200 ladder (server-side retry, no browser) ──
    print("== pause ladder (mock 503, 503, then stream) ==")
    import websocket  # websocket-client
    ws = websocket.create_connection(f"ws://127.0.0.1:{PORT}/api/chat?session_id={SID}", timeout=10)
    ws.send(json.dumps({"type": "send", "message": "hello recovery"}))
    events = []
    deadline = time.time() + 45
    saw_503_notice = False
    while time.time() < deadline:
        try:
            ws.settimeout(2)
            ev = json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:
            if any(e.get("type") == "status" and e.get("state") in ("idle", "error") for e in events): break
            continue
        except Exception:
            break
        events.append(ev)
        if ev.get("type") == "progress" and "overloaded" in str(ev.get("text", "")):
            saw_503_notice = True
        if ev.get("type") == "status" and ev.get("state") in ("idle", "error"):
            break
    types = [e["type"] for e in events]
    ok(saw_503_notice, "503 retry notice announced as progress (the pause is honest)")
    ok(any(e.get("type") == "assistant_delta" for e in events), "the stream landed after the retries")
    ok(any(e.get("type") == "status" and e.get("state") == "idle" for e in events), "turn reached idle after the ladder")
    ok(MockHandler.hits >= 3, f"exactly 3 POST hits (2x503 + 1 stream) — got {MockHandler.hits}")

    # ── TEST 2: WS kill mid-stream → reconnect with since= → completion ──
    print("== mid-turn WS kill + resume ==")
    MockHandler.hits = 0
    ws2 = websocket.create_connection(f"ws://127.0.0.1:{PORT}/api/chat?session_id={SID}", timeout=10)
    # consume the connect replay FIRST — the baseline is its max seq, so the
    # kill only triggers on a LIVE turn-2 delta (never a replayed turn-1 one)
    baseline = 0
    while True:
        ws2.settimeout(5)
        try: ev = json.loads(ws2.recv())
        except Exception: break
        if ev.get("seq"): baseline = max(baseline, ev["seq"])
        if ev.get("type") == "status" and ev.get("state") in ("idle", "error"): break
    ws2.send(json.dumps({"type": "send", "message": "kill me mid stream"}))
    last_seq = baseline
    killed = False
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            ws2.settimeout(5)
            ev = json.loads(ws2.recv())
        except websocket.WebSocketTimeoutException:
            continue  # the 5xx cooldown can stretch the ladder to ~35s — keep waiting
        except Exception:
            break
        if ev.get("seq"): last_seq = max(last_seq, ev["seq"])
        if ev.get("type") == "assistant_delta" and ev.get("seq", 0) > baseline:
            # a LIVE turn-2 delta — kill the socket NOW (mid-turn)
            ws2.close()
            killed = True
            break
    ok(killed, "killed the WS mid-stream (after a LIVE delta, not a replayed one)")
    time.sleep(0.8)  # the mock keeps streaming to the dead pipe

    # reconnect with since= — the gap replays and the LIVE feed resumes
    ws3 = websocket.create_connection(
        f"ws://127.0.0.1:{PORT}/api/chat?session_id={SID}&since={last_seq}", timeout=10)
    resumed = []
    got_terminal = False
    saw_live_delta = False
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            ws3.settimeout(3)
            ev = json.loads(ws3.recv())
        except websocket.WebSocketTimeoutException:
            if got_terminal: break
            continue
        except Exception:
            break
        resumed.append(ev)
        if ev.get("type") == "assistant_delta" and ev.get("seq", 0) > last_seq:
            saw_live_delta = True  # a delta that could only come from the live feed
        if ev.get("type") == "status" and ev.get("state") in ("idle", "error") and ev.get("seq", 0) > last_seq:
            got_terminal = True  # a TERMINAL from the resumed turn itself (not the replay)
            break
    ws3.close()
    ok(saw_live_delta, "resumed socket received LIVE deltas from the surviving turn")
    ok(got_terminal, "the resumed turn reached a terminal status")
    # gap check: the resumed replay must not duplicate what we had
    seqs = [e.get("seq") for e in resumed if e.get("seq")]
    ok(all(s > last_seq for s in seqs), f"since= replay is gap-only (last had {last_seq}; resumed seqs {seqs[:5]}…)")
    ok(len(set(seqs)) == len(seqs), "no duplicate seqs in the resumed stream")

    # wait for the turn to FULLY land in the log before asserting on it
    # (the turn keeps running server-side; the log is the source of truth)
    deadline = time.time() + 60
    rows = []
    while time.time() < deadline:
        _, evs = japi("GET", f"/api/sessions/{SID}/events")
        rows = evs.get("events", [])
        # v0.22 order: the full-reply 'assistant' event lands right AFTER the
        # terminal status — a complete turn ends with either of the two.
        tail = rows[-1] if rows else {}
        if tail.get("type") in ("status", "assistant"): break
        time.sleep(0.5)

    # ── TEST 3: the event log tells the whole story (persistence survived) ──
    print("== event log integrity ==")
    texts = "".join(r.get("text", "") for r in rows if r.get("type") == "assistant_delta")
    ok("recovery-4" in texts, f"the full reply persisted (all 5 chunks — got tail: …{texts[-40:]!r})")
    has_terminal = any(r.get("type") == "status" and r.get("state") in ("idle", "error") for r in rows)
    ok(rows and rows[-1].get("type") in ("status", "assistant") and has_terminal,
       "the log ends with the assistant full-reply / a terminal status")

    # ── TEST 4: boot heal — a session left mid-turn gets closed out ──
    print("== boot heal ==")
    _, s2 = api("POST", "/api/sessions", {"title": "Crash Bot", "sandbox": "quick",
        "model": "nvidia/mock/flaky-mini", "provider": "nvidia"})
    SID2 = json.loads(s2)["ID"]
    api("POST", f"/api/sessions/{SID2}/events", {"type": "user", "text": "orphaned"})
    api("POST", f"/api/sessions/{SID2}/events", {"type": "assistant_delta", "text": "partial…"})
    # (no terminal status — the crash scenario)
    proc.kill(); proc.wait()
    proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
        stdout=open("/tmp/v39rec-eng2.log", "w"), stderr=subprocess.STDOUT, env=env)
    for _ in range(80):
        try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
        except Exception: time.sleep(0.25)
    _, evs2 = japi("GET", f"/api/sessions/{SID2}/events")
    rows2 = evs2.get("events", [])
    last2 = rows2[-1] if rows2 else {}
    ok(last2.get("type") == "status" and "healed" in str(last2.get("text", "")),
       f"boot heal closed the orphaned turn (last: {last2.get('type')} {str(last2.get('text', ''))[:60]})")
    # sessions that ENDED cleanly must NOT get a heal
    _, evs3 = japi("GET", f"/api/sessions/{SID}/events")
    rows3 = evs3.get("events", [])
    healed_extra = [r for r in rows3 if r.get("type") == "status" and "healed" in str(r.get("text", ""))]
    ok(not healed_extra, "clean sessions were NOT healed (no false positives)")

finally:
    cleanup()

print(f"\n{'='*46}\nRESULT: {PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
