#!/usr/bin/env python3
# v071-mock-hub.py — a tiny HuggingFace-compatible mock for the library
# tests (the hub_test.go pattern, standalone): serves ONE skill dataset
# whose items share a collection + carry designs, so the bunch view, the
# badge, and the use-bundle flow render against REAL engine code paths.
#
# Endpoints (the exact ones the engine's hub scan uses):
#   GET /api/datasets?filter=<tag>&limit=100   → repo cards
#   GET /api/datasets?search=<q>&limit=100     → repo cards
#   GET /datasets/<repo>/resolve/main/<path>   → the file
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO = "mocklib/superpowers-mock"

INDEX = [
    {
        "id": "skill-alpha-aaaaaa", "type": "skill", "name": "skill alpha",
        "description": "the alpha methodology", "author": "mockuser",
        "repo": REPO, "tags": ["superpowers", "testing"],
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-02T00:00:00Z",
        "hearts": 3, "downloads": 5,
        "design": {"kind": "gradient", "colors": ["#f59e0b", "#ef4444", "#7c3aed"], "dir": "mesh"},
        "icon": "", "collection": "superpowers-mock", "file": "items/skill-alpha-aaaaaa.md"
    },
    {
        "id": "skill-beta-bbbbbb", "type": "skill", "name": "skill beta",
        "description": "the beta methodology", "author": "mockuser",
        "repo": REPO, "tags": ["superpowers"],
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-03T00:00:00Z",
        "hearts": 1, "downloads": 2,
        "design": {"kind": "gradient", "colors": ["#f59e0b", "#ef4444", "#7c3aed"], "dir": "mesh"},
        "icon": "", "collection": "superpowers-mock", "file": "items/skill-beta-bbbbbb.md"
    }
]

FILES = {
    "items/index.json": json.dumps(INDEX),
    "items/skill-alpha-aaaaaa.md": "# skill alpha\n\nthe alpha body\n",
    "items/skill-beta-bbbbbb.md": "# skill beta\n\nthe beta body\n",
}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, v, status=200):
        b = json.dumps(v).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/datasets":
            flt = (q.get("filter") or [""])[0]
            search = (q.get("search") or [""])[0]
            if flt == "doomalay-skill" or "doomalay-" in search or "superpowers" in search:
                return self._json([{"id": REPO, "tags": ["doomalay-skill"], "likes": 2, "downloads": 7}])
            return self._json([])
        if u.path.startswith("/datasets/") and "/resolve/main/" in u.path:
            repo_file = u.path[len("/datasets/"):]
            path = repo_file.split("/resolve/main/", 1)[1]
            repo = repo_file.split("/resolve/main/", 1)[0]
            if repo == REPO and path in FILES:
                b = FILES[path].encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            return self._json({"error": "not found"}, 404)
        return self._json({"error": "not found"}, 404)

if __name__ == "__main__":
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
