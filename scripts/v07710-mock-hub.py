#!/usr/bin/env python3
# v07710-mock-hub.py — the bundle-counting mock: a 6-member collection
# (superpowers-count) with a collections/<id>.json manifest + a metrics
# sidecar repo carrying per-user bundle events. Serves the HF-shaped
# endpoints the engine probes (datasets, tree, files) so Collections(),
# DownloadCollectionStream + the manifest resolution all run for real.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO = "mocklib/superpowers-count"
METRICS = "mocklib/doomalay-metrics"

def member(i, hearts=2, downloads=3):
    iid = "skill-count-%06d" % i
    return {
        "id": iid, "type": "skill", "name": "count skill %d" % i,
        "description": "member %d of the counting bundle" % i,
        "author": "mockuser", "repo": REPO,
        "tags": ["superpowers", "counting"],
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-02T00:00:00Z",
        "hearts": hearts, "downloads": downloads,
        "design": {"kind": "gradient", "colors": ["#f59e0b", "#ef4444"], "dir": "mesh"},
        "icon": "", "collection": "superpowers-count", "file": "items/%s.md" % iid,
        "upstream": "the v0.77.10 spec by ScoobyBaby1999",
    }

INDEX = [member(i) for i in range(6)]

MANIFEST = {
    "description": "The counting bundle — six skills that prove ONE user download counts ONCE. A fixture port maintained by mockuser.",
    "upstream": "the v0.77.10 spec by ScoobyBaby1999",
    "by": "mockuser",
}

# per-user bundle events: another-user downloaded + endorsed the bundle once
OTHER_METRICS = "\n".join([
    json.dumps({"op": "download", "target": "collection|superpowers-count", "ts": "2025-02-01T00:00:00Z"}),
    json.dumps({"op": "heart", "target": "collection|superpowers-count", "ts": "2025-02-01T00:00:01Z"}),
    # a DIRECT member download by another user (the member's own +1)
    json.dumps({"op": "download", "target": "%s|skill-count-000000" % REPO, "ts": "2025-02-02T00:00:00Z"}),
]) + "\n"

FILES = {
    "items/index.json": json.dumps(INDEX),
    "collections/superpowers-count.json": json.dumps(MANIFEST),
    "metrics.jsonl": OTHER_METRICS,
}
for i in range(6):
    iid = "skill-count-%06d" % i
    FILES["items/%s.md" % iid] = "# count skill %d\n\nthe body\n" % i
    FILES["items/%s.json" % iid] = json.dumps(INDEX[i])

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
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
            if flt == "doomalay-metrics":
                return self._json([{"id": METRICS, "tags": ["doomalay-metrics"], "likes": 0, "downloads": 0}])
            if flt == "doomalay-skill" or "doomalay-" in search or "superpowers" in search:
                return self._json([
                    {"id": REPO, "tags": ["doomalay-skill"], "likes": 2, "downloads": 7},
                ])
            return self._json([])
        if u.path == "/api/datasets/" + REPO or u.path == "/api/datasets/" + METRICS:
            return self._json({"id": u.path.rsplit("/", 1)[1], "author": "mocklib", "private": False})
        # file resolve (the raw-content endpoint the engine's FetchFile uses)
        for prefix in ("/datasets/" + REPO + "/resolve/main/", "/datasets/" + METRICS + "/resolve/main/"):
            if u.path.startswith(prefix):
                rel = u.path[len(prefix):]
                if rel in FILES:
                    b = FILES[rel].encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json" if rel.endswith(".json") else "text/plain")
                    self.send_header("Content-Length", str(len(b)))
                    self.end_headers()
                    self.wfile.write(b)
                    return
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        tp = u.path.rstrip("/")
        if tp in ("/api/datasets/" + REPO + "/tree/main", "/api/datasets/superpowers-count/tree/main"):
            return self._json([{"type": "file", "path": f, "size": len(v)} for f, v in FILES.items()])
        if tp in ("/api/datasets/" + METRICS + "/tree/main", "/api/datasets/doomalay-metrics/tree/main"):
            return self._json([{"type": "file", "path": "metrics.jsonl", "size": len(FILES["metrics.jsonl"])}])
        if False:
            return self._json([{"type": "file", "path": f, "size": len(v)} for f, v in FILES.items()])
        if u.path == "/api/datasets/" + METRICS + "/tree/main":
            return self._json([{"type": "file", "path": "metrics.jsonl", "size": len(FILES["metrics.jsonl"])}])
        self._json({"error": "not found"}, 404)

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8340
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
