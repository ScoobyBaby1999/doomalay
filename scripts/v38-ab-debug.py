#!/usr/bin/env python3
# v38-ab-debug.py — reproduce the A->B switch send flow with instrumentation.
import json, os, shutil, subprocess, sys, time
import urllib.request

BASE = "http://127.0.0.1:8143"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-abdbg"
NVKEY = os.environ.get("NVIDIA_API_KEY", "")
if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
log = open("/tmp/abdbg-eng.log", "w")
proc = subprocess.Popen([ENG, "-open=false", "-port=8143", f"-data-dir={DATA}"], stdout=log, stderr=log)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=30).read()

api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})
a = api("POST", "/api/sessions", {"title": "A", "sandbox": "quick", "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"})
b = api("POST", "/api/sessions", {"title": "B", "sandbox": "quick", "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"})
SID_A = json.loads(a)["ID"]; SID_B = json.loads(b)["ID"]

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 400, "height": 760}, has_touch=True)
    pg = ctx.new_page()
    console = []
    pg.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [
               {"id": "chatA", "type": "chat", "name": "A", "family": "nvidia", "iconIndex": 0,
                "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28, "sandbox": "quick",
                "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia", "sessionId": SID_A},
               {"id": "chatB", "type": "chat", "name": "B", "family": "nvidia", "iconIndex": 1,
                "x": 260, "y": 200, "vx": 0, "vy": 0, "radius": 28, "sandbox": "quick",
                "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia", "sessionId": SID_B}],
             "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(800)

    pg.mouse.click(120, 200); pg.wait_for_timeout(1600)
    pg.fill("#chat-input", "Count from 1 to 30 slowly, one per line.")
    pg.click("#chat-send")
    # wait for streaming
    for _ in range(60):
        if pg.evaluate("() => { const c = document.querySelector('#chat-messages'); return !!(c && (c.querySelector('.msg-think')||c.querySelector('.chat-working'))); }"):
            break
        pg.wait_for_timeout(500)
    print("A streaming. switching to B...")
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(900)
    pg.mouse.click(260, 200)
    pg.wait_for_timeout(1800)
    # instrument B's client BEFORE sending
    diag = pg.evaluate("""() => {
      const st = window.ChatPanel.getState('chatB');
      if (!st || !st.client) return {err: 'no client'};
      const c = st.client;
      return {wsState: c.ws ? c.ws.readyState : 'null', connState: c.state,
              queue: c._eventQueue.length, sessionId: st.sessionId};
    }""")
    print("B client diag:", diag)
    pg.fill("#chat-input", "Count from 1 to 10.")
    pg.click("#chat-send")
    # watch B's client for 30s, print raw WS frames arriving
    pg.evaluate("""() => {
      const st = window.ChatPanel.getState('chatB');
      window.__frames = [];
      if (st && st.client && st.client.ws) {
        const orig = st.client.ws.onmessage;
        st.client.ws.addEventListener('message', e => window.__frames.push(e.data.slice(0, 90)));
      }
    }""")
    for i in range(60):
        d = pg.evaluate("""() => {
          const st = window.ChatPanel.getState('chatB');
          const c = st.client;
          return {streaming: st.isStreaming, msgs: st.messages.map(m=>m.role),
                  wsState: c.ws ? c.ws.readyState : -1, queue: c._eventQueue.length,
                  frames: (window.__frames||[]).length};
        }""")
        if i % 6 == 0: print(f"[{i*0.5:.1f}s]", d)
        if d["msgs"] and "assistant" in d["msgs"]: print("B GOT ASSISTANT:", d); break
        pg.wait_for_timeout(500)
    fr = pg.evaluate("() => (window.__frames||[]).slice(0,12)")
    print("first frames:", fr)
    print("console errors:", [c for c in console if "error" in c.lower()][:8])
    br.close()
proc.terminate(); proc.wait()
