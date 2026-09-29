#!/usr/bin/env python3
# v074-mock-hub-longname.py — the v071 mock shape + ONE long-named item
# (the marquee repro for the library text-shadow bug) + a short control.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO = "mocklib/superpowers-mock"
LONG = "Superduper Extremely Long Named Skill That Definitely Overflows The Card Name Line For Sure"

INDEX = [
    {
        "id": "skill-long-cccccc", "type": "skill", "name": LONG,
        "description": "the long-name marquee repro - if the name renders only as its shadow the clip broke",
        "author": "mockuser", "repo": REPO,
        "tags": ["superpowers", "testing", "research", "writing", "brainstorm"],
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-02T00:00:00Z",
        "hearts": 3, "downloads": 5,
        "design": {"kind": "gradient", "colors": ["#f59e0b", "#ef4444", "#7c3aed"], "dir": "mesh"},
        "icon": "", "collection": "superpowers-mock", "file": "items/skill-long-cccccc.md"
    },
    {
        "id": "skill-alpha-aaaaaa", "type": "skill", "name": "skill alpha",
        "description": "the short-name control card", "author": "mockuser", "repo": REPO,
        "tags": ["superpowers", "planning"],
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-02T00:00:00Z",
        "hearts": 3, "downloads": 5,
        "design": {"kind": "gradient", "colors": ["#f59e0b", "#ef4444", "#7c3aed"], "dir": "mesh"},
        "icon": "", "collection": "superpowers-mock", "file": "items/skill-alpha-aaaaaa.md"
    },
]

FILES = {
    "items/index.json": json.dumps(INDEX),
    "items/skill-long-cccccc.md": "# long name\n\nthe body\n",
    "items/skill-alpha-aaaaaa.md": "# skill alpha\n\nthe alpha body\n",
}

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write("MOCK %s\n" % (self.path,))
        sys.stderr.flush()
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
        if u.path == "/api/datasets/" + REPO:
            return self._json({"id": REPO, "author": "mockuser", "private": False,
                               "lastModified": "2025-01-03T00:00:00Z", "likes": 2,
                               "downloads": 7, "tags": ["doomalay-skill"]})
        if u.path == "/api/datasets/" + REPO + "/tree/main":
            return self._json([
                {"type": "file", "path": "items/index.json", "size": 900},
                {"type": "file", "path": "items/skill-long-cccccc.md", "size": 40},
                {"type": "file", "path": "items/skill-alpha-aaaaaa.md", "size": 40},
            ])
        if u.path.startswith("/datasets/"):
            fp = u.path.split("/resolve/main/", 1)[-1]
            if fp in FILES:
                b = FILES[fp].encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain" if fp.endswith(".md") else "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
        self._json({"error": "not found"}, 404)

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
