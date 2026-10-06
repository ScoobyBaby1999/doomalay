#!/usr/bin/env python3
# probe: does the release frame reach the worker after a CDP pinch?
import http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request
BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = "/home/z/my-project/doomalay"
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v110probe"
WEB = os.path.join(ROOT, "engine", "internal", "server", "web")

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".png": "image/png", ".svg": "image/svg+xml", ".mjs": "text/javascript",
        ".woff2": "font/woff2", ".json": "application/json", ".map": "application/json"}
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "host"}

class Mix(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _static(self):
        path = self.path.split("?")[0]
        if path == "/": path = "/index.html"
        fp = os.path.join(WEB, path.lstrip("/"))
        fp = os.path.realpath(fp)
        if not fp.startswith(os.path.realpath(WEB)) or not os.path.isfile(fp):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        ext = os.path.splitext(fp)[1]
        body = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)
    def _fwd(self, body):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if (body and length) else None
        conn = http.client.HTTPConnection("127.0.0.1", ENG_PORT, timeout=90)
        try:
            conn.request(self.command, self.path, body=data,
                         headers={k: v for k, v in self.headers.items() if k.lower() not in HOP})
            r = conn.getresponse(); rb = r.read()
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in HOP: self.send_header(k, v)
            self.send_header("Content-Length", str(len(rb))); self.end_headers()
            if self.command != "HEAD": self.wfile.write(rb)
        except Exception:
            self.send_response(502); self.send_header("Content-Length", "0"); self.end_headers()
        finally: conn.close()
    def do_GET(self):
        if self.path.split("?")[0].startswith("/api/"): self._fwd(None)
        else: self._static()
    def do_HEAD(self): self.do_GET()
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
logf = open("/tmp/doomalay-v110probe.log", "w")
subprocess.Popen([ENG, "--port", str(ENG_PORT), "--bind", "127.0.0.1",
                  "--data-dir", DATA, "--open", "false"], stdout=logf, stderr=subprocess.STDOUT)
for _ in range(60):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{ENG_PORT}/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8099), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 420, "height": 800},
                            device_scale_factor=2, has_touch=True, is_mobile=True)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: print("  [pageerror]", str(e)[:160]))
        pg.goto(BASE, wait_until="domcontentloaded")
        pg.wait_for_timeout(2600)
        # arm a blob watcher + raw touch-event counter
        pg.evaluate("""() => {
          window.__w = [];
          window.__tev = { start: 0, move: 0, end: 0, cancel: 0, endTouches: [] };
          document.addEventListener('touchstart', () => window.__tev.start++, { capture: true, passive: true });
          document.addEventListener('touchmove', () => window.__tev.move++, { capture: true, passive: true });
          document.addEventListener('touchend', (e) => { window.__tev.end++; window.__tev.endTouches.push(e.touches.length); }, { capture: true, passive: true });
          document.addEventListener('touchcancel', () => window.__tev.cancel++, { capture: true, passive: true });
          (function s() {
            const oo = (window.DoomalayDebug && window.DoomalayDebug.oneObject) || null;
            window.__w.push({ t: Math.round(performance.now()),
              hold: oo ? oo.zoomHold : null, gen: oo ? oo.bakeGen : null,
              pend: oo ? oo.pending : null,
              paints: window.DoomalayPerf ? window.DoomalayPerf.paints : null });
            window.__raf = requestAnimationFrame(s);
          })();
        }""")
        time.sleep(0.4)
        cdp = ctx.new_cdp_session(pg)
        cx, cy = 210, 400
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [
            {"x": cx - 60, "y": cy}, {"x": cx + 60, "y": cy}]})
        for i in range(1, 21):
            d = 60 + 55 * i / 20
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
                {"x": cx - d, "y": cy}, {"x": cx + d, "y": cy}]})
            time.sleep(0.016)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        time.sleep(1.6)
        out = pg.evaluate("""() => {
          if (window.__raf) cancelAnimationFrame(window.__raf);
          const w = window.__w;
          return { tev: window.__tev, tail: w.slice(-10),
                   perf: window.DoomalayPerf ? { paints: window.DoomalayPerf.paints,
                     painter: window.DoomalayPerf.painter } : null };
        }""")
        print(json.dumps(out, indent=1))
        b.close()
finally:
    subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
