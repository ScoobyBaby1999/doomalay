#!/usr/bin/env python3
# v1045-mix-serve.py — the v1045 red-team's on-disk static server
# (the v106/v107 forwarder pattern: static from disk, /api + /ws proxied
# to the engine). Usage: v1045-mix-serve.py <port> <engine-port> <webdir>
import http.client, http.server, os, sys, threading

PORT = int(sys.argv[1]); ENG_PORT = int(sys.argv[2]); WEB = os.path.abspath(sys.argv[3])
MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
        ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
        ".woff2": "font/woff2", ".json": "application/json", ".map": "application/json",
        ".wasm": "application/wasm"}
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "host"}

class Mix(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _static(self):
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"
        fp = os.path.realpath(os.path.join(WEB, path.lstrip("/")))
        if not fp.startswith(os.path.realpath(WEB)) or not os.path.isfile(fp):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        body = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(fp)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
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
            if k.lower() in ("connection", "transfer-encoding"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        c.close()
    def do_GET(self):
        (self._fwd(False) if self.path.startswith(("/api", "/ws")) else self._static())
    def do_HEAD(self): self.do_GET()
    def do_POST(self): self._fwd(True)
    def do_PUT(self): self._fwd(True)
    def do_PATCH(self): self._fwd(True)
    def do_DELETE(self): self._fwd(True)
    def do_OPTIONS(self): self._fwd(False)
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
print(f"mix up on :{PORT} (engine :{ENG_PORT}, web {WEB})")
import signal
signal.pause()
