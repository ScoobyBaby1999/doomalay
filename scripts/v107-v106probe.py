#!/usr/bin/env python3
# v107-v106probe.py — mimic the v106 §3-2 flow exactly and dump the
# painter's registry state (what are the 3 painted elements?).
import http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request, shutil

BASE = "http://127.0.0.1:8099"; ENG_PORT = 8078
ROOT = "/home/z/my-project/doomalay"
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v107probe2"; WEB = os.path.join(ROOT, "engine", "internal", "server", "web")
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json"}
HOP = {"connection", "keep-alive", "te", "trailers", "transfer-encoding", "upgrade", "host"}

class Mix(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _static(self):
        path = self.path.split("?")[0]
        if path == "/": path = "/index.html"
        fp = os.path.realpath(os.path.join(WEB, path.lstrip("/")))
        if not fp.startswith(os.path.realpath(WEB)) or not os.path.isfile(fp):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        body = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(fp)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(body)
    def _fwd(self, body):
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n) if (body and n) else None
        c = http.client.HTTPConnection("127.0.0.1", ENG_PORT, timeout=90)
        c.request(self.command, self.path, body=data, headers={k: v for k, v in self.headers.items() if k.lower() not in HOP})
        r = c.getresponse(); payload = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() in ("connection", "transfer-encoding"): continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload); c.close()
    def do_GET(self):
        (self._fwd(False) if self.path.startswith(("/api", "/ws")) else self._static())
    def do_POST(self): self._fwd(True)
    def do_PUT(self): self._fwd(True)
    def do_PATCH(self): self._fwd(True)
    def do_DELETE(self): self._fwd(True)
    def do_OPTIONS(self): self._fwd(False)
    def log_message(self, *a): pass

shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True); time.sleep(0.5)
logf = open("/tmp/v107probe2-engine.log", "w")
proc = subprocess.Popen([ENG, "--port", str(ENG_PORT), "--bind", "127.0.0.1", "--data-dir", DATA, "--open", "false"], stdout=logf, stderr=subprocess.STDOUT)
for _ in range(60):
    try: urllib.request.urlopen(f"http://127.0.0.1:{ENG_PORT}/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8099), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 420, "height": 800}, device_scale_factor=2, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(BASE, wait_until="domcontentloaded"); pg.wait_for_timeout(2600)

    def open_chat():
        pg.evaluate("""() => {
          const nb = document.getElementById('dock-new');
          if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
          const cb = document.querySelector('#dock-new-chat');
          if (cb) cb.click();
        }""")
        pg.wait_for_timeout(1600)

    if not pg.evaluate("() => !!document.querySelector('.chatbot')"):
        pg.evaluate("() => { const b = document.getElementById('canvas-empty-btn'); if (b) b.click(); }")
        pg.wait_for_timeout(1800)
    open_chat()
    # seed 300 like v106
    pg.evaluate("""() => {
      const sc = document.querySelector('#chat-scroll') || document.querySelector('.panel-body');
      const mk = (i) => { const row = document.createElement('div');
        row.className = 'msg-row ' + (i % 2 ? 'msg-row-user' : 'msg-row-assistant');
        const bub = document.createElement('div'); bub.className = 'msg-bubble ' + (i % 2 ? 'msg-user' : 'msg-assistant');
        bub.textContent = 'seed ' + i; row.appendChild(bub); return row; };
      for (let i = 0; i < 300; i++) sc.appendChild(mk(i));
    }""")
    pg.wait_for_timeout(600)
    # fields like v106 (surface + accent-1)
    pg.evaluate("""() => {
      const s = Settings.getState();
      const o = Object.assign({}, s.themeOverrides);
      o[s.theme] = Object.assign({}, o[s.theme], {
        '--field-surface': { colors: ['#10101c', '#2a1a4a', '#0e6b6b'], dir: 'auto' },
        '--field-accent-1': { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' }
      });
      Settings.setState({ themeOverrides: o });
    }""")
    pg.wait_for_timeout(500)
    # toggle ON via the SETTINGS page (the v106 §3-2 flow)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1100)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\\'appearance\\']'); if (t) t.click(); }")
    pg.wait_for_timeout(600)
    pg.evaluate("""() => {
      const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
      if (!el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }""")
    pg.wait_for_timeout(800)
    # swap back to the chat like the rig does
    pg.evaluate("""() => {
      const nb = document.getElementById('dock-new');
      if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
      const cb = document.querySelector('#dock-new-chat');
      if (cb) cb.click();
    }""")
    pg.wait_for_timeout(1200)
    out = pg.evaluate("""() => {
      const bub = document.querySelector('.msg-user');
      const cs = bub ? getComputedStyle(bub) : null;
      return {
        chatOpen: document.querySelector('#chat-panel').classList.contains('open'),
        bubbles: document.querySelectorAll('#chat-panel .msg-user').length,
        bubbleVisible: bub ? bub.getBoundingClientRect().width : 0,
        bubbleImg: cs ? cs.backgroundImage.slice(0, 50) : null,
        bubbleAtt: cs ? cs.backgroundAttachment : null,
        bubbleBake: bub ? bub.getAttribute('data-proj-bake') : null,
        bubbleLayer: bub ? bub.hasAttribute('data-proj') : null,
        stats: window.DoomProjection.stats(),
        dataProj: document.querySelectorAll('#chat-panel [data-proj]').length,
        dataBake: document.querySelectorAll('[data-proj-bake]').length,
        doom: document.documentElement.getAttribute('data-doom-proj')
      };
    }""")
    print(json.dumps(out, indent=1))
    b.close()
proc.terminate()
