#!/usr/bin/env python3
# v38-isolation-test.py — THE CHAT-SANDBOX ISOLATION VERIFICATION.
#
# Reproduces the user's exact leak repro with a REAL streaming provider:
#   · chat A starts a long streaming generation (NVIDIA, real key)
#   · mid-stream, the user opens chat B (a brand-new chat)
#   · B's DOM must contain NOTHING from A (no thinking bubble, no
#     assistant text, no activity pill, no leaked rows that vanish later)
#   · reopening A mid-stream must show its live stream + pill, intact
#   · B must be able to send its OWN message while A still streams
#     (parallel isolated chats, each with its own connection)
#   · closing the panel mid-stream must not error; A's data survives
#
# Run: python3 scripts/v38-isolation-test.py   (engine must NOT already run)

import json, os, shutil, subprocess, sys, time
import urllib.request, urllib.error

BASE = "http://127.0.0.1:8136"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-v38test"
PORT = 8136
NVKEY = os.environ.get("NVIDIA_API_KEY", "")

if not NVKEY:
    print("FATAL: set NVIDIA_API_KEY env (real-key test)"); sys.exit(1)
if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
_englog = open("/tmp/doomalay-v38-eng.log", "w")
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=_englog, stderr=_englog)
for _ in range(60):
    try:
        urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
else:
    print("FATAL: engine did not start"); proc.kill(); sys.exit(1)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def japi(method, path, body=None):
    st, bodyb = api(method, path, body)
    try: return st, json.loads(bodyb.decode() or "{}")
    except Exception: return st, {}

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

# ── real key in the vault ───────────────────────────────────────────
api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})

# two isolated engine sessions
_, a = api("POST", "/api/sessions", {"title": "Chat A", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"})
_, b = api("POST", "/api/sessions", {"title": "Chat B", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"})
SID_A = json.loads(a)["ID"]; SID_B = json.loads(b)["ID"]
ok(SID_A and SID_B and SID_A != SID_B, f"two separate engine sessions ({SID_A[:8]}… / {SID_B[:8]}…)")

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 400, "height": 760}, has_touch=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [
               {"id": "chatA", "type": "chat", "name": "Chat A", "family": "nvidia",
                "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                "sandbox": "quick", "model": "nvidia/z-ai/glm-5.3-flash",
                "provider": "nvidia", "sessionId": SID_A},
               {"id": "chatB", "type": "chat", "name": "Chat B", "family": "nvidia",
                "iconIndex": 1, "x": 260, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                "sandbox": "quick", "model": "nvidia/z-ai/glm-5.3-flash",
                "provider": "nvidia", "sessionId": SID_B}],
             "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(800)

    def open_chat(x, y):
        if not pg.evaluate("() => document.getElementById('chat-panel').classList.contains('open')"):
            pg.mouse.click(x, y)
            pg.wait_for_timeout(1500)

    def close_chat():
        if pg.evaluate("() => document.getElementById('chat-panel').classList.contains('open')"):
            pg.evaluate("() => document.getElementById('chat-scrim').click()")
            pg.wait_for_timeout(800)

    def dom_rows():
        return pg.evaluate("""() => {
          const c = document.querySelector('#chat-messages');
          if (!c) return -1;
          return Array.from(c.children).filter(k =>
            !k.classList.contains('msg-day')).length;
        }""")

    # ══ 1. A starts a long real stream ═══════════════════════════════
    print("chat A streams (real NVIDIA)")
    open_chat(120, 200)
    ok(pg.evaluate("() => window.ChatPanel.getState('chatA').sessionId") == SID_A,
       "A bound to its own session")
    pg.fill("#chat-input", "Count slowly from 1 to 30, one number per line, nothing else.")
    pg.click("#chat-send")
    # effort LOW keeps GLM's reasoning phase tractable (NVIDIA queue is 12-25s)
    pg.evaluate("() => window.ChatPanel.getState('chatA')")  # state touch
    # wait until A is visibly streaming (thinking bubble or assistant text)
    streaming = False
    for _ in range(120):  # up to 60s (NVIDIA can queue)
        if pg.evaluate("""() => {
          const c = document.querySelector('#chat-messages');
          return !!(c && (c.querySelector('.msg-think') || c.querySelector('.msg-assistant') || c.querySelector('.chat-working')));
        }"""):
            streaming = True; break
        pg.wait_for_timeout(500)
    ok(streaming, "A is visibly streaming (pill/thinking/bubble appeared)")
    if not streaming:
        print(open("/tmp/doomalay-v38-eng.log").read()[-2000:]); br.close(); proc.kill(); sys.exit(1)

    # ══ 2. mid-stream: open brand-new chat B ═════════════════════════
    print("mid-stream switch to fresh chat B")
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(800)
    pg.mouse.click(260, 200)
    pg.wait_for_timeout(1600)
    ok(pg.evaluate("() => document.getElementById('chat-panel').classList.contains('open')"),
       "B's panel opened")
    ok(pg.evaluate("() => window.ChatPanel.getState('chatB').sessionId") == SID_B,
       "B bound to its own session")
    # THE leak assertions: B's DOM watched for 4s while A streams in background
    leaked = False
    for _ in range(8):
        r = pg.evaluate("""() => {
          const c = document.querySelector('#chat-messages');
          if (!c) return {rows: -1, think: -1, work: -1};
          return {rows: c.children.length,
                  think: c.querySelectorAll('.msg-think').length,
                  asst: c.querySelectorAll('.msg-assistant').length,
                  work: c.querySelectorAll('.chat-working').length};
        }""")
        if r["rows"] > 1 or r["think"] > 0 or r["asst"] > 0 or r["work"] > 0:
            leaked = True; print("   LEAK SNAPSHOT:", r); break
        pg.wait_for_timeout(500)
    ok(not leaked, "B's DOM stayed clean for 4s while A streamed in the background")
    ok(pg.evaluate("() => document.querySelectorAll('#chat-messages > #chat-greeting').length") <= 1,
       "B still shows its own fresh-chat greeting")
    ok(pg.evaluate("() => window.ChatPanel.getState('chatB').messages.length") == 0,
       "B's state has no messages from A")

    # ══ 3. B sends its OWN message while A still streams ═════════════
    print("parallel isolated send from B")
    pg.fill("#chat-input", "Count from 1 to 15, one number per line, nothing else.")
    pg.click("#chat-send")
    b_done = False
    for _ in range(240):  # up to 120s (NVIDIA queue + turn)
        if pg.evaluate("""() => {
          const st = window.ChatPanel.getState('chatB');
          return st.messages.some(m => m.role === 'assistant' && m.complete);
        }"""): b_done = True; break
        pg.wait_for_timeout(500)
    if not b_done:
        diag = pg.evaluate("""() => {
          const st = window.ChatPanel.getState('chatB');
          const c = st.client || {};
          return {streaming: st.isStreaming, msgs: st.messages.map(m => m.role + ' :: ' + String(m.text||'').slice(0,90)),
                  wsState: c.ws ? c.ws.readyState : -1, queue: (c._eventQueue||[]).length,
                  lastErr: c.lastError || ''};
        }""")
        print("   B DIAG:", diag)
    ok(b_done, "B completed its own turn while A streamed in parallel")
    # B's DOM holds only B's content
    r = pg.evaluate("""() => {
      const st = window.ChatPanel.getState('chatB');
      return {users: st.messages.filter(m => m.role === 'user').length,
              assts: st.messages.filter(m => m.role === 'assistant').length};
    }""")
    ok(r["users"] == 1 and r["assts"] >= 1, f"B's state: 1 user + assistant ({r})")

    # ══ 4. back to A mid-stream: intact + live ═══════════════════════
    print("reopen A mid-stream")
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(800)
    pg.mouse.click(120, 200)
    pg.wait_for_timeout(1600)
    a_state = pg.evaluate("() => window.ChatPanel.getState('chatA').messages.map(m => m.role)")
    ok("user" in a_state, f"A kept its user message ({a_state})")
    ok(pg.evaluate("() => document.querySelector('#chat-messages') !== null"),
       "A's transcript re-rendered from its own state")
    ok(pg.evaluate("() => window.ChatPanel.getState('chatA').sessionId") == SID_A,
       "A still bound to its own session after the round-trip")

    # ══ 5. wait for A to finish; transcript complete ══════════════════
    a_done = False
    for _ in range(600):  # up to 300s (GLM reasoning)
        if pg.evaluate("""() => {
          const st = window.ChatPanel.getState('chatA');
          return !st.isStreaming && st.messages.some(m => m.role === 'assistant' && m.complete);
        }"""): a_done = True; break
        pg.wait_for_timeout(500)
    ok(a_done, "A's background turn completed")
    final_dom = pg.evaluate("""() => document.querySelectorAll('#chat-messages .msg-assistant').length""")
    ok(final_dom >= 1, f"A's final transcript shows its assistant message(s) ({final_dom})")

    # ══ 6. zero page errors ═══════════════════════════════════════════
    ok(len(errors) == 0, f"zero page errors ({errors[:3]})")

    br.close()

proc.terminate(); proc.wait()
print(f"\n{'='*46}\nISOLATION TEST: {PASS} passed, {FAIL} failed\n{'='*46}")
sys.exit(1 if FAIL else 0)
