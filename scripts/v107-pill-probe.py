#!/usr/bin/env python3
# v107-pill-probe.py — one-shot diagnostic: what paints the metadata pills
# under projection ON (the white-pill report reproduction, deep probe).
import http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = "/home/z/my-project/doomalay"
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v107probe"
WEB = os.path.join(ROOT, "engine", "internal", "server", "web")

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json"}
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "host"}

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
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def _fwd(self, body):
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n) if (body and n) else None
        c = http.client.HTTPConnection("127.0.0.1", ENG_PORT, timeout=90)
        c.request(self.command, self.path, body=data,
                  headers={k: v for k, v in self.headers.items() if k.lower() not in HOP})
        r = c.getresponse(); payload = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() in ("connection", "transfer-encoding"): continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload); c.close()
    def do_GET(self):
        (self._fwd(False) if self.path.startswith(("/api", "/ws")) else self._static())
    def do_POST(self): self._fwd(True)
    def do_PUT(self): self._fwd(True)
    def do_PATCH(self): self._fwd(True)
    def do_DELETE(self): self._fwd(True)
    def do_OPTIONS(self): self._fwd(False)
    def log_message(self, *a): pass

import shutil
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
time.sleep(0.5)
logf = open("/tmp/doomalay-v107probe-engine.log", "w")
proc = subprocess.Popen([ENG, "--port", str(ENG_PORT), "--bind", "127.0.0.1",
                         "--data-dir", DATA, "--open", "false"], stdout=logf, stderr=subprocess.STDOUT)
for _ in range(60):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{ENG_PORT}/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8099), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 420, "height": 800}, device_scale_factor=2,
                        has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.wait_for_timeout(2600)
    pg.evaluate("""() => {
      const s = Settings.getState();
      const ov = Object.assign({}, s.themeOverrides);
      ov[s.theme] = Object.assign({}, ov[s.theme], {
        '--field-accent-1': { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' }
      });
      Settings.setState({ themeOverrides: ov });
      Settings.setState({ doomProjection: true });
    }""")
    pg.wait_for_timeout(900)
    pg.evaluate("""() => {
      const strip = document.getElementById('dock-strip');
      const nb = document.getElementById('dock-new');
      if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
      const cb = strip ? strip.querySelector('#dock-new-chat') : null;
      if (cb) cb.click();
    }""")
    pg.wait_for_timeout(1600)
    pg.evaluate("() => { const ch = document.getElementById('header-chevron'); if (ch) ch.click(); }")
    pg.wait_for_timeout(900)
    out = pg.evaluate("""() => {
      const csE = getComputedStyle(document.documentElement);
      const row = document.getElementById('pill-row');
      const pill = row && row.querySelector('#pill-sandbox');
      if (!pill) return { err: 'no pill' };
      const cs = getComputedStyle(pill);
      // which rules match this pill?
      const matched = [];
      try {
        for (const sh of document.styleSheets) {
          let rules; try { rules = sh.cssRules; } catch (e) { continue; }
          for (const r of rules) {
            if (!r.selectorText || !r.style) continue;
            try { if (pill.matches(r.selectorText)) {
              matched.push({ sel: r.selectorText.slice(0, 110),
                bg: (r.style.getPropertyValue('background-color') || '').slice(0, 60),
                bi: (r.style.getPropertyValue('background-image') || '').slice(0, 60),
                imp: r.style.getPropertyPriority('background-color') || '' });
            } } catch (e2) {}
          }
        }
      } catch (e3) {}
      return {
        styleAttr: (pill.getAttribute('style') || '').slice(0, 300),
        accRGB: csE.getPropertyValue('--accent-rgb').trim(),
        accGrad: csE.getPropertyValue('--accent-gradient').trim().slice(0, 40),
        s1grad: csE.getPropertyValue('--surface-1-gradient').trim().slice(0, 30),
        a1gate: document.documentElement.getAttribute('data-a1-grad'),
        doom: document.documentElement.getAttribute('data-doom-proj'),
        computed: { img: cs.backgroundImage.slice(0, 60), color: cs.backgroundColor,
                    att: cs.backgroundAttachment, ink: cs.color },
        matchedCount: matched.length, matched: matched.slice(0, 14),
        stats: window.DoomProjection.stats()
      };
    }""")
    print(json.dumps(out, indent=1))
    b.close()
proc.terminate()
