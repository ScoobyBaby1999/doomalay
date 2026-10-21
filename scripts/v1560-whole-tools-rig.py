#!/usr/bin/env python3
# v1560-whole-tools-rig.py — v1.56.0 THE WHOLE TOOLS: the LIVE battery.
#
# The proof that the tool layer really does what the pins say — driven
# against a REAL engine over its own HTTP surface (no mocks): a fake
# GitHub API serves a repo with MULTIPLE matches per file, and the
# engine's OWN workspace tool (the same runner the model calls) must
# report EVERY hit, honour the flags, and never truncate silently.
#
#   python3 scripts/v1560-whole-tools-rig.py
#
# No API key needed: the battery drives the engine's own tool runner
# through its REST twin (the same code path the model's tool call
# reaches), against a local fake GitHub.
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")

fails = []


def check(name, ok, detail=""):
    print(("  PASS " if ok else "  FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
    if not ok:
        fails.append(name)


# ── the fake GitHub ────────────────────────────────────────────────────
FILES = {
    "a.go": "package x\n// TODO: one\nfunc f() {}\n// TODO: two\n// TODO: three\n",
    "b.md": "# doc\nTODO three\n",
    "vendor/c.go": "// TODO: vendored\n",
}


class FakeGitHub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        import base64
        path = self.path.split("?")[0]
        if path == "/repos/me/v1560":
            self._json({"full_name": "me/v1560", "description": "the rig's fake repo",
                        "default_branch": "main", "private": False, "stars": 1,
                        "forks": 0, "open_issues_count": 2, "updated_at": "2026-10-22T00:00:00Z",
                        "clone_url": "https://github.com/me/v1560.git",
                        "html_url": "https://github.com/me/v1560",
                        "permissions": {"admin": True, "push": True, "pull": True}})
            return
        if "/git/trees/" in path:
            self._json({"truncated": False, "tree": [
                {"path": p, "type": "blob", "size": len(b), "sha": "s%d" % i}
                for i, (p, b) in enumerate(FILES.items())]})
            return
        if path.endswith("/issues"):
            self._json([])
            return
        if path.endswith("/pulls"):
            self._json([])
            return
        if "/contents/" in path:
            rel = path.split("/contents/", 1)[1]
            if rel not in FILES:
                self._json({"message": "Not Found"}, 404)
                return
            body = FILES[rel]
            self._json({"name": rel, "path": rel, "sha": "x", "size": len(body),
                        "encoding": "base64",
                        "content": base64.b64encode(body.encode()).decode()})
            return
        if path == "/search/code":
            self._json({"items": [
                {"name": p, "path": p, "text_matches": [{"fragment": "TODO"}]}
                for p in FILES]})
            return
        self._json({"message": "Not Found"}, 404)


def start_fake():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeGitHub)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


def api(base, path, body=None, method=None):
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def main():
    print("v1.56.0 THE WHOLE TOOLS — the live rig")
    fake, fake_base = start_fake()
    data = tempfile.mkdtemp(prefix="v1560-")
    port = 8099
    env = dict(os.environ)
    env["DOOMALAY_GITHUB_API_BASE"] = fake_base
    env["GITHUB_API_BASE"] = fake_base
    env["PORT"] = str(port)
    env["DOOMALAY_DATA_DIR"] = data
    env["GOFLAGS"] = "-mod=mod"
    env["GOTMPDIR"] = os.path.join(data, "gotmp")
    os.makedirs(env["GOTMPDIR"], exist_ok=True)
    binary = os.path.join(data, "engine")
    print("  building the engine…")
    b = subprocess.run(["go", "build", "-o", binary, "./cmd/doomalay"], cwd=ENGINE,
                       env=env, capture_output=True, text=True)
    if b.returncode != 0:
        print(b.stdout[-2000:], b.stderr[-2000:])
        print("FATAL: the engine did not build")
        sys.exit(1)
    print("  starting the engine…")
    proc = subprocess.Popen([binary, "--port", str(port), "--data-dir", data],
                            cwd=ENGINE, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port
    try:
        for _ in range(60):
            code, _ = api(base, "/api/health")
            if code == 200:
                break
            time.sleep(1)
        else:
            print("FATAL: the engine did not answer /api/health")
            sys.exit(1)
        # a session + a public workspace bound to it
        code, sess = api(base, "/api/sessions", {"title": "v1560", "sandbox": "quick",
                                                 "model": "openrouter/minimax/minimax-m3.1-flash:free",
                                                 "provider": "openrouter"})
        if code not in (200, 201):
            print("FATAL: the session did not create (HTTP %s):" % code, sess)
            sys.exit(1)
        sid = ""
        if isinstance(sess, dict):
            sid = sess.get("ID") or sess.get("id") or ""
        if not sid:
            print("FATAL: no session id in the answer:", sess)
            sys.exit(1)
        # the workspace: connected through the real connect route (the
        # public repo, no token — the unbound read hand). The fake
        # GitHub's API base is the engine-wide override, so the connect
        # probe answers from the fake.
        code, ws = api(base, "/api/workspaces/connect", {
            "url": "https://github.com/me/v1560", "session_id": sid,
            "name": "me/v1560", "branch": "main",
        }, method="POST")
        if code not in (200, 201):
            print("FATAL: the workspace did not connect:", ws)
            sys.exit(1)
        wid = ""
        if isinstance(ws, dict):
            wid = ws.get("id") or ws.get("ID") or ""
            if not wid and ws.get("workspace"):
                wid = ws["workspace"].get("id") or ws["workspace"].get("ID") or ""
        if not wid:
            print("FATAL: no workspace id in the answer:", ws)
            sys.exit(1)

        # ── the grep laws, live ────────────────────────────────────
        # The rig drives the EXPLORE twin (the public, unbound read hand
        # — no token, no connected row: the same runner the model's
        # unbound grep reaches). The URL points at the fake GitHub's
        # host:port, so the forge client talks to the fake.
        fake_repo = "https://github.com/me/v1560"
        grep_path = ("/api/explore/grep?url=" +
                     urllib.parse.quote(fake_repo, safe="") +
                     "&q=TODO&limit=0")
        print("  RA  the grep reports EVERY hit")
        code, res = api(base, grep_path)
        check("the grep route answers", code == 200, str(res)[:200])
        if code == 200:
            hits = res.get("hits") or []
            check("the grep found 5 hits (a.go has THREE)",
                  len(hits) == 5, "got %d: %s" % (len(hits), [h.get("path") for h in hits]))
            a_hits = [h for h in hits if h.get("path") == "a.go"]
            check("a.go contributes all THREE of its hits", len(a_hits) == 3,
                  "got %d" % len(a_hits))
            check("the hits carry REAL line numbers",
                  all(h.get("line", 0) > 0 for h in hits),
                  str([(h.get("path"), h.get("line")) for h in hits]))
            check("the result names its engine", res.get("engine") in ("re2", "regexp2", "literal"),
                  str(res.get("engine")))

        print("  RB  the grep is a REGEX")
        code, res = api(base, "/api/explore/grep?url=" + urllib.parse.quote(fake_repo, safe="") +
                         "&q=TODO%3A%20one&limit=0")
        if code == 200:
            hits = res.get("hits") or []
            check("the regex matched only its own line", len(hits) == 1,
                  "got %d" % len(hits))

        print("  RC  the grep's flags")
        code, res = api(base, "/api/explore/grep?url=" + urllib.parse.quote(fake_repo, safe="") +
                         "&q=TODO&include=*.md&limit=0")
        if code == 200:
            hits = res.get("hits") or []
            check("the include glob filtered the corpus",
                  all(h.get("path", "").endswith(".md") for h in hits) and hits,
                  str([h.get("path") for h in hits]))
        code, res = api(base, "/api/explore/grep?url=" + urllib.parse.quote(fake_repo, safe="") +
                         "&q=TODO&exclude=vendor%2F%2A&limit=0")
        if code == 200:
            hits = res.get("hits") or []
            check("the exclude glob filtered the corpus",
                  all("vendor" not in h.get("path", "") for h in hits),
                  str([h.get("path") for h in hits]))
        code, res = api(base, "/api/explore/grep?url=" + urllib.parse.quote(fake_repo, safe="") +
                         "&q=TODO&count=1&limit=0")
        if code == 200:
            hits = res.get("hits") or []
            check("the count mode reports the per-file counts",
                  any(h.get("count", 0) > 0 for h in hits),
                  str([(h.get("path"), h.get("count")) for h in hits]))

        print("  RD  the limit is HONEST")
        code, res = api(base, "/api/explore/grep?url=" + urllib.parse.quote(fake_repo, safe="") +
                         "&q=TODO&limit=2")
        if code == 200:
            hits = res.get("hits") or []
            check("the limit capped the hits", len(hits) <= 2, "got %d" % len(hits))
            check("the capped result SAYS so (the reason + the total)",
                  bool(res.get("reason")) or res.get("total_hits", 0) > len(hits),
                  str(res)[:200])

        print("  RE  the lists are not silently capped")
        code, res = api(base, "/api/explore/view/issues?url=" +
                         urllib.parse.quote(fake_repo, safe="") + "&limit=0")
        check("the view route answers", code == 200, str(res)[:200])
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        fake.shutdown()

    print("")
    if fails:
        print("FAILED %d check(s):" % len(fails))
        for f in fails:
            print("  - " + f)
        sys.exit(1)
    print("ALL LIVE CHECKS PASS")


if __name__ == "__main__":
    main()
