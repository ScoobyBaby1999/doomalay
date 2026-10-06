#!/usr/bin/env python3
# v107-theme-probe.py — is theme.js healthy at runtime? (U4-U7 triage)
import http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request, shutil
BASE = "http://127.0.0.1:8099"; ENG_PORT = 8078
ROOT = "/home/z/my-project/doomalay"
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v107probe3"; WEB = os.path.join(ROOT, "engine", "internal", "server", "web")
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json"}
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
    def log_message(self, *a): pass
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True); time.sleep(0.5)
proc = subprocess.Popen([ENG, "--port", str(ENG_PORT), "--bind", "127.0.0.1", "--data-dir", DATA, "--open", "false"],
                        stdout=open("/tmp/v107p3.log", "w"), stderr=subprocess.STDOUT)
for _ in range(60):
    try: urllib.request.urlopen(f"http://127.0.0.1:{ENG_PORT}/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8099), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
from playwright.sync_api import sync_playwright
errs = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 420, "height": 800}).new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.on("console", lambda m: errs.append("console:" + m.text[:160]) if m.type == "error" else None)
    pg.goto(BASE, wait_until="domcontentloaded"); pg.wait_for_timeout(2800)
    out = pg.evaluate("""() => ({
      doomTheme: typeof window.DoomTheme,
      hasFallbacks: !!(window.DoomTheme && window.DoomTheme.FALLBACKS),
      shadowTri: getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim(),
      hlTri: getComputedStyle(document.documentElement).getPropertyValue('--highlight-inset-rgb').trim(),
      shInk: getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink').trim(),
      derivedShadow: window.DoomTheme && window.DoomTheme.derivedShadowHex ? window.DoomTheme.derivedShadowHex(Settings.getState()) : null,
      fields: window.DoomTheme && window.DoomTheme.fields ? window.DoomTheme.fields.map(f => f.field) : null
    })""")
    print(json.dumps(out, indent=1))
    print("ERRORS:", json.dumps(errs[:6], indent=1))
    b.close()
proc.terminate()
