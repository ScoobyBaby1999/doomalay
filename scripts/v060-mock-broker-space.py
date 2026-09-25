#!/usr/bin/env python3
"""v0.60.2 red-team mock of the doomalaysocreate Space's /gh/oauth/* surface
(mirrors scripts/shared_app.py exactly — same paths, same JSON shapes).
Serves:
  /gh/oauth/config            → {"configured":true} (CORS *)
  /gh/oauth/start?redirect=…  → 302 github.com/login/oauth/authorize (assert target)
  /gh/oauth/callback          → 302 <engine>/api/gh/oauth/relay?grant=redteam-grant
  /gh/oauth/grants/redteam-grant → one-time {token, login, refresh_token, expires_in}
"""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, quote

ENGINE = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8175"
CLAIMED = {"n": 0}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/gh/oauth/config":
            body = b'{"configured":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        elif u.path == "/gh/oauth/start":
            q = parse_qs(u.query)
            redirect = (q.get("redirect") or [""])[0]
            if not redirect.startswith("http://127.0.0.1") and not redirect.startswith("http://localhost"):
                body = json.dumps({"error": "redirect origin refused"}).encode()
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers(); self.wfile.write(body); return
            self.send_response(302)
            self.send_header("Location", "https://github.com/login/oauth/authorize?client_id=Iv23li3qm665pDrDO1Nh&state=redteam")
            self.end_headers()
        elif u.path == "/gh/oauth/callback":
            self.send_response(302)
            self.send_header("Location", ENGINE + "/api/gh/oauth/relay?grant=redteam-grant")
            self.end_headers()
        elif u.path == "/gh/oauth/grants/redteam-grant":
            CLAIMED["n"] += 1
            if CLAIMED["n"] > 1:
                body = b'{"error":"unknown, expired or already-claimed grant"}'
                self.send_response(410)
            else:
                body = json.dumps({"token": "gho_redteam_123", "login": "redteam_cat",
                                   "refresh_token": "ghr_rt_1", "expires_in": 28800}).encode()
                self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()

HTTPServer((sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1", 8188), H).serve_forever()
