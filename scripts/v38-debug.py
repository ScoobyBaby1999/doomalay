#!/usr/bin/env python3
# v38-debug.py — one real NVIDIA turn, print the actual error bubble text.
import json, os, shutil, subprocess, sys, time
import urllib.request, urllib.error

BASE = "http://127.0.0.1:8137"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-v38dbg"
PORT = 8137
NVKEY = os.environ.get("NVIDIA_API_KEY", "")
if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
log = open("/tmp/doomalay-v38dbg.log", "w")
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"], stdout=log, stderr=log)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NVKEY})
_, a = api("POST", "/api/sessions", {"title": "Dbg", "sandbox": "quick",
    "model": "nvidia/llama-3.1-nemotron-70b-instruct", "provider": "nvidia"})
SID = json.loads(a)["ID"]

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 400, "height": 760}, has_touch=True)
    pg = ctx.new_page()
    msgs = []
    pg.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "dbg", "type": "chat", "name": "Dbg", "family": "nvidia",
                "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                "sandbox": "quick", "model": "nvidia/llama-3.1-nemotron-70b-instruct",
                "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(800)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1600)
    pg.fill("#chat-input", "Say hello in one sentence.")
    pg.click("#chat-send")
    for _ in range(90):
        if pg.evaluate("""() => {
          const st = window.ChatPanel.getState('dbg');
          return !st.isStreaming && st.messages.some(m => m.role==='assistant' && m.complete);
        }"""): break
        pg.wait_for_timeout(1000)
    out = pg.evaluate("""() => {
      const st = window.ChatPanel.getState('dbg');
      return st.messages.map(m => ({role: m.role, text: (m.text||'').slice(0, 300)}));
    }""")
    print(json.dumps(out, indent=1))
    print("CONSOLE:", [m for m in msgs if "error" in m.lower()][:5])
    br.close()
proc.terminate(); proc.wait()
