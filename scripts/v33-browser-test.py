#!/usr/bin/env python3
# v33-browser-test.py — the v0.33 batch verification: THE BATCH-10 TWEAKS.
#
# Boots a fresh engine pointed at an IN-PROCESS MOCK HUGGING FACE server
# (the v31 harness) via DOOMALAY_HUB_HF_BASE, then drives the real PWA:
#
#   1. THE PUBLIC LIBRARY — renamed, everything-but-the-grid rides a
#      COLLAPSIBLE header; the search bar sits UNDER it; the library
#      pills are full-row with emoji, personas PURPLE / templates GREEN
#      (theme tints).
#   2. the header folds/expands (chevron, aria, zero-height body).
#   3. THE FILTER ROW — funnel icon + Recent|Downloads|Endorsements|
#      Relevant as divided COLUMNS with a subtext, selected = theme
#      accent, and the sorts actually reorder.
#   4. THE KEYBOARD FIX — typing never replaces the search input node
#      (same DOM node, still focused, results update live).
#   5. THE PILL SYSTEM — .dx-pill: organic radii (less rounded), the
#      sketch offset stroke, theme tints; the chat header pills match.
#   6. item detail regression.
#   7. THE PUBLISH PAGE — 3 collapsible sections, the * in PRIMARY,
#      payload FOCUS mode, the 1-10 color gradient editor (add/remove/
#      caps), random with a RANDOM stop count, the 401 connect flow,
#      the engine round-trips 10 colors, the NDJSON commit carries them.
#   8. THE CROP FLOW — the card image opens the drag-to-crop overlay
#      (aspect frame, drag moves, zoom, apply), publishes as a PNG at
#      full clarity through LFS.
#   9. THE TWEAKS BACKGROUND — color | gradient | image; the shared
#      gradient editor applies live (blob + chat root), min-1 solid,
#      random, the image pipeline intact.
#  10. zero page errors.
#
# Run: python3 scripts/v33-browser-test.py   (engine must NOT already run)

import base64, hashlib, http.server, json, os, re, shutil, struct, subprocess, sys, threading, time
import urllib.request, urllib.error, urllib.parse, zlib

BASE = "http://127.0.0.1:8098"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine-test")
DATA = "/tmp/doomalay-v33test"
PORT = 8098
TOKEN = "hf_test_token_123"   # the only token the mock accepts

# ── the item id, exactly like the engine (kebab-slug + 6-hex sha256) ──
def item_id(name, author):
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "item"
    digest = hashlib.sha256(f"{slug}\x00{author}".encode()).hexdigest()[:6]
    return f"{slug}-{digest}"

# a real 8×8 PNG (blue) for the card-image item
def make_png(rgb=(30, 60, 220)):
    w = h = 8
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b""))

# ── the mock HF hub (in-memory) ──────────────────────────────────────
LOCK = threading.Lock()
STATE = {
    "repos": {},    # repo id → {"tags": [...], "files": {path: bytes}}
    "lfs": {},      # oid → bytes (the presigned bucket)
    "commits": [],  # (repo, ndjson_body_str) in arrival order
    "likes": {},    # repo → True/False by THE user
    "created": [],  # repo ids the engine created
}

def derive_tags(repo):
    """tags live in the README frontmatter — the same way the real hub works"""
    readme = STATE["repos"][repo]["files"].get("README.md")
    if readme is None:
        STATE["repos"][repo]["tags"] = []
        return
    tags, in_front = [], False
    for line in readme.decode(errors="replace").split("\n"):
        if line.strip() == "---":
            if in_front:
                break
            in_front = True
            continue
        if in_front and line.startswith("- "):
            tags.append(line[2:].strip())
    STATE["repos"][repo]["tags"] = tags

def seed_repo(repo, tag, files):
    STATE["repos"][repo] = {"tags": [tag], "files": dict(files)}

# ── the seed data (deterministic: fixed timestamps + counters) ───────
def persona_item(name, author, desc, tags, updated, design):
    iid = item_id(name, author)
    return iid, {
        "id": iid, "type": "persona", "name": name, "description": desc,
        "author": author, "repo": "", "tags": tags,
        "createdAt": updated, "updatedAt": updated, "hearts": 0, "downloads": 0,
        "design": design, "file": f"items/{iid}.md",
    }

SC_ID, SC = persona_item("Star Captain", "alice", "A bold space commander persona",
                         ["space", "hero"], "2026-09-03T00:00:00Z",
                         {"kind": "gradient", "colors": ["#667eea", "#764ba2"]})
MW_ID, MW = persona_item("Moon Whisperer", "alice", "A calm, nocturnal guide",
                         ["night", "calm"], "2026-09-01T00:00:00Z",
                         {"kind": "none", "colors": []})
CC_ID, CC = persona_item("Cosmic Chef", "alice", "Cooks across the galaxy",
                         ["space", "cooking"], "2026-09-02T00:00:00Z",
                         {"kind": "png", "colors": []})
VB_ID, VB = persona_item("Void Bard", "bob", "Songs from the emptiness",
                         ["dark", "music"], "2026-08-30T00:00:00Z",
                         {"kind": "none", "colors": []})

RO_ID = item_id("Report Outline", "tina")
RO_ITEM = {
    "id": RO_ID, "type": "template", "name": "Report Outline",
    "description": "A structured report skeleton", "author": "tina", "repo": "",
    "tags": ["writing"], "createdAt": "2026-09-02T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
    "hearts": 0, "downloads": 0, "design": {"kind": "gradient", "colors": ["#f97316", "#dc2626"]},
    # NOTE: the engine's default template File (items/<id>.json) collides
    # with the item META path (both .json) — an explicit distinct payload
    # path avoids the collision (the engine honors a seeded file field).
    "file": f"items/{RO_ID}-payload.json",
}

ALICE_REPO = "alice/doomalay-personas"
BOB_REPO = "bob/doomalay-personas"
TINA_REPO = "tina/doomalay-templates"
ALICE_METRICS = "alice/doomalay-metrics"
BOB_METRICS = "bob/doomalay-metrics"

seed_repo(ALICE_REPO, "doomalay-persona", {
    "README.md": b"---\ntags:\n- doomalay-persona\n---\n\n# personas\n",
    "items/index.json": json.dumps([SC, MW, CC]).encode(),
    f"items/{SC_ID}.json": json.dumps(SC).encode(),
    f"items/{MW_ID}.json": json.dumps(MW).encode(),
    f"items/{CC_ID}.json": json.dumps(CC).encode(),
    f"items/{SC_ID}.md": b"# Star Captain\n\nYou are **Star Captain**, commander of the Aurora.\n\n- Rule one: never abandon ship\n- Rule two: the crew eats first\n",
    f"items/{MW_ID}.md": b"# Moon Whisperer\n\nYou speak softly and only at night.\n",
    f"items/{CC_ID}.md": b"# Cosmic Chef\n\nYou cook across the galaxy.\n",
    f"items/{CC_ID}.png": make_png(),
})
seed_repo(BOB_REPO, "doomalay-persona", {
    "README.md": b"---\ntags:\n- doomalay-persona\n---\n\n# personas\n",
    "items/index.json": json.dumps([VB]).encode(),
    f"items/{VB_ID}.json": json.dumps(VB).encode(),
    f"items/{VB_ID}.md": b"# Void Bard\n\nYou sing to the void and it sings back.\n",
})
seed_repo(TINA_REPO, "doomalay-template", {
    "README.md": b"---\ntags:\n- doomalay-template\n---\n\n# templates\n",
    "items/index.json": json.dumps([RO_ITEM]).encode(),
    f"items/{RO_ID}.json": json.dumps(RO_ITEM).encode(),
    f"items/{RO_ID}-payload.json": json.dumps(
        {"sections": ["summary", "analysis", "next steps"], "tone": "formal"}, indent=2).encode(),
})
seed_repo(ALICE_METRICS, "doomalay-metrics", {
    "README.md": b"---\ntags:\n- doomalay-metrics\n---\n\n# metrics\n",
    "metrics.jsonl": ("\n".join(json.dumps(e) for e in [
        {"op": "heart", "target": f"{ALICE_REPO}|{SC_ID}", "ts": "2026-09-03T01:00:00Z"},
        {"op": "heart", "target": f"{ALICE_REPO}|{SC_ID}", "ts": "2026-09-03T02:00:00Z"},
        {"op": "heart", "target": f"{ALICE_REPO}|{MW_ID}", "ts": "2026-09-01T02:00:00Z"},
        {"op": "download", "target": f"{ALICE_REPO}|{MW_ID}", "ts": "2026-09-01T03:00:00Z"},
        {"op": "download", "target": f"{ALICE_REPO}|{MW_ID}", "ts": "2026-09-01T04:00:00Z"},
        {"op": "download", "target": f"{ALICE_REPO}|{MW_ID}", "ts": "2026-09-01T05:00:00Z"},
        {"op": "download", "target": f"{ALICE_REPO}|{SC_ID}", "ts": "2026-09-03T03:00:00Z"},
    ]) + "\n").encode(),
})
seed_repo(BOB_METRICS, "doomalay-metrics", {
    "README.md": b"---\ntags:\n- doomalay-metrics\n---\n\n# metrics\n",
    "metrics.jsonl": ("\n".join(json.dumps(e) for e in [
        {"op": "download", "target": f"{BOB_REPO}|{VB_ID}", "ts": "2026-08-30T01:00:00Z"},
        {"op": "download", "target": f"{BOB_REPO}|{VB_ID}", "ts": "2026-08-30T02:00:00Z"},
    ]) + "\n").encode(),
})


class MockHF(http.server.BaseHTTPRequestHandler):
    """The Hugging Face REST surface the hub client uses (hf.go), backed
    by the in-memory STATE above. Paths arrive percent-encoded (repo ids
    ride as ONE %2F-escaped segment) — unquote first."""
    protocol_version = "HTTP/1.1"

    def log_message(self, *a): pass

    # ── helpers ──────────────────────────────────────────────────────
    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length else b""

    def _send(self, data, ctype="application/json", status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, status=200):
        self._send(json.dumps(obj).encode(), "application/json", status)

    def _bearer(self):
        return (self.headers.get("Authorization") or "").replace("Bearer ", "").strip()

    # ── routing ──────────────────────────────────────────────────────
    def do_GET(self):
        sp = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(sp.path)
        q = urllib.parse.parse_qs(sp.query)

        if path == "/api/whoami-v2":
            if self._bearer() != TOKEN:
                self._json({"error": "bad token"}, 401)
            else:
                self._json({"type": "user", "name": "tester"})
            return

        if path == "/api/datasets":
            filt = (q.get("filter") or [""])[0]
            with LOCK:
                out = []
                for rid, repo in STATE["repos"].items():
                    if filt in repo["tags"]:
                        out.append({"id": rid, "author": rid.split("/")[0], "private": False,
                                   "lastModified": "2026-09-03T00:00:00.000Z",
                                   "likes": 0, "downloads": 0, "tags": repo["tags"]})
            self._json(out)
            return

        if path.startswith("/api/datasets/"):
            repo = path[len("/api/datasets/"):]
            with LOCK:
                r = STATE["repos"].get(repo)
                if not r:
                    self._json({"error": "no such repo"}, 404)
                else:
                    self._json({"id": repo, "private": False, "tags": r["tags"],
                                "likes": 0, "downloads": 0})
            return

        m = re.match(r"^/datasets/(.+)/resolve/main/(.+)$", path)
        if m:
            repo, fpath = m.group(1), m.group(2)
            with LOCK:
                r = STATE["repos"].get(repo)
                body = r["files"].get(fpath) if r else None
            if body is None:
                self._json({"error": "no such file"}, 404)
            else:
                ctype = "image/png" if fpath.endswith(".png") else "application/json"
                self._send(body, ctype)
            return

        self._json({"error": "not found"}, 404)

    def do_POST(self):
        sp = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(sp.path)
        body = self._read_body()

        if path == "/api/whoami-v2":  # (the engine uses GET; accept POST too)
            if self._bearer() != TOKEN:
                self._json({"error": "bad token"}, 401)
            else:
                self._json({"type": "user", "name": "tester"})
            return

        if path == "/api/repos/create":
            try:
                req = json.loads(body.decode() or "{}")
            except Exception:
                self._json({"error": "bad json"}, 400)
                return
            if req.get("type") != "dataset" or not req.get("name"):
                self._json({"error": "type and name required"}, 400)
                return
            rid = req.get("name")
            if req.get("organization"):
                rid = req["organization"] + "/" + req["name"]
            with LOCK:
                if rid in STATE["repos"]:
                    self._json({"error": "exists"}, 409)
                    return
                STATE["repos"][rid] = {"tags": [], "files": {}}
                STATE["created"].append(rid)
            self._json({"url": f"/api/datasets/{rid}"})
            return

        if path.endswith("/preupload/main") and path.startswith("/api/datasets/"):
            repo = path[len("/api/datasets/"):-len("/preupload/main")]
            try:
                req = json.loads(body.decode() or "{}")
            except Exception:
                req = {"files": []}
            files = [{"path": f.get("path", ""), "uploadMode": "lfs" if f.get("path", "").endswith(".png") else "regular"}
                     for f in req.get("files", [])]
            self._json({"files": files})
            return

        # NOTE: the repo name abuts ".git" directly (no slash), so a
        # plain endswith("/.git/…") NEVER matches — match the full shape
        m = re.match(r"^/datasets/(.+)\.git/info/lfs/objects/batch$", path)
        if m:
            repo = m.group(1)
            try:
                req = json.loads(body.decode() or "{}")
            except Exception:
                req = {"objects": []}
            base = f"http://127.0.0.1:{MOCK_PORT}"
            objects = [{"oid": o["oid"], "size": o["size"],
                        "actions": {"upload": {"href": f"{base}/lfs/{o['oid']}"}}}
                       for o in req.get("objects", [])]
            self._json({"transfer": "basic", "objects": objects})
            return

        if path.endswith("/commit/main") and path.startswith("/api/datasets/"):
            repo = path[len("/api/datasets/"):-len("/commit/main")]
            with LOCK:
                STATE["commits"].append((repo, body.decode(errors="replace")))
                repo_entry = STATE["repos"].get(repo)
            if repo_entry is None:
                print(f"MOCK404 commit-unknown-repo {repo}")
                self._json({"error": "no such repo"}, 404)
                return
            try:
                for line in body.decode(errors="replace").strip().split("\n"):
                    if not line:
                        continue
                    op = json.loads(line)
                    if op.get("key") == "file":
                        v = op["value"]
                        content = v.get("content", "")
                        if v.get("encoding") == "base64":
                            content = base64.b64decode(content)
                        repo_entry["files"][v["path"]] = content if isinstance(content, bytes) else content.encode()
                    elif op.get("key") == "lfsFile":
                        v = op["value"]
                        with LOCK:
                            repo_entry["files"][v["path"]] = STATE["lfs"].get(v["oid"], b"")
                with LOCK:
                    derive_tags(repo)
            except Exception:
                self._json({"error": "bad ndjson"}, 400)
                return
            self._json({"commitUrl": f"/{repo}/commit/mocksha"})
            return

        if path.endswith("/like") and path.startswith("/api/datasets/"):
            repo = path[len("/api/datasets/"):-len("/like")]
            with LOCK:
                STATE["likes"][repo] = True
            self._json({"liked": True})
            return

        print(f"MOCK404 POST {path}")
        self._json({"error": "not found"}, 404)

    def do_PUT(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path.startswith("/lfs/"):
            oid = path[len("/lfs/"):]
            with LOCK:
                STATE["lfs"][oid] = self._read_body()
            self._send(b"{}", "application/json")
            return
        print(f"MOCK404 PUT {path}")
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path.endswith("/like") and path.startswith("/api/datasets/"):
            repo = path[len("/api/datasets/"):-len("/like")]
            with LOCK:
                STATE["likes"][repo] = False
            self._send(b"{}", "application/json")
            return
        self._json({"error": "not found"}, 404)


# ── boot the mock HF + a fresh engine pointed at it ─────────────────
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockHF)
MOCK_PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
print(f"mock HF on http://127.0.0.1:{MOCK_PORT}")

shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine-test"], capture_output=True)
time.sleep(0.5)
env = dict(os.environ)
env["DOOMALAY_HUB_HF_BASE"] = f"http://127.0.0.1:{MOCK_PORT}"
_englog = open("/tmp/v33-engine.log", "w")
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=_englog, stderr=_englog, env=env)
for _ in range(40):
    try:
        urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
else:
    print("FATAL: engine did not start"); proc.kill(); sys.exit(1)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def japi(method, path, body=None):
    st, bodyb = api(method, path, body)
    try: return st, json.loads(bodyb.decode() or "{}")
    except Exception: return st, {}

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

# seed: one session (model already selected → the gatelock renders filled)
st, sess = api("POST", "/api/sessions", {
    "title": "V33 Bot", "sandbox": "quick",
    "model": "nvidia/nvidia/nemotron-3-super", "provider": "nvidia"})
SID = json.loads(sess)["ID"]

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 400, "height": 760})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    _badresp = []
    pg.on("response", lambda r: _badresp.append(f"{r.status} {r.url}") if r.status >= 400 else None)
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "c33", "type": "chat", "name": "V33 Bot", "family": "nvidia",
                        "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": "nvidia/nvidia/nemotron-3-super",
                        "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(700)

    # ── helpers ──────────────────────────────────────────────────────
    def open_hub():
        if pg.evaluate("() => document.getElementById('chat-panel').classList.contains('open')"):
            pg.evaluate("() => document.getElementById('chat-scrim').click()")
            pg.wait_for_timeout(600)
        if pg.locator("#dock-strip").is_hidden():
            pg.locator("#dock-toggle").click(); pg.wait_for_timeout(300)
        pg.locator("#dock-library").click()
        pg.wait_for_timeout(1300)

    def card_names():
        return [t.strip() for t in pg.locator(".hub-card-name").all_inner_texts()]

    def search(q, wait=900):
        pg.fill("#hub-search", q)
        pg.wait_for_timeout(wait)

    def sort(key):
        pg.locator(f'[data-sort="{key}"]').click()
        pg.wait_for_timeout(900)

    def hex_of(css):
        css = (css or "").strip()
        if css.startswith("#") and len(css) >= 7:
            return tuple(int(css[i:i + 2], 16) for i in (1, 3, 5))
        m = re.findall(r"\d+", css)
        return tuple(int(x) for x in m[:3]) if len(m) >= 3 else None

    # ══ 1. THE PUBLIC LIBRARY (tweaks 4 + 6) ═════════════════════════
    print("the public library header")
    open_hub()
    ok(pg.locator("#panel-name").inner_text().strip() == "public library",
       "the view title reads 'public library' (renamed from 'hub')")
    ok(pg.locator(".pub-title").inner_text().strip() == "Public Library",
       "the in-view title carries 'Public Library'")
    ok(pg.locator(".pub-sub").inner_text().strip() == "Browse the community for:",
       "the 'Browse the community for:' subtext sits above the pills")
    libs = pg.locator(".hub-libpill[data-lib]")
    ok(libs.count() == 2, f"the registry drives 2 full-row library pills ({libs.count()})")
    texts = [t.lower() for t in libs.all_inner_texts()]
    ok("personas" in texts[0] and "templates" in texts[1],
       f"the pills read Personas / Templates (plural, {texts})")
    ok("🎭" in pg.locator('.hub-libpill[data-lib="persona"]').inner_text() and
       "🧩" in pg.locator('.hub-libpill[data-lib="template"]').inner_text(),
       "the pills carry their emoji glyphs (🎭 persona / 🧩 template)")
    # the selected PERSONA pill tints PURPLE (theme-dependent)
    person_tint = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--persona-tint').trim()")
    sel_col = pg.evaluate("""() => getComputedStyle(document.querySelector('.hub-libpill[data-lib="persona"][data-on="1"]')).color""")
    ok(hex_of(sel_col) == hex_of(person_tint),
       f"the selected persona pill rides the PURPLE tone ({sel_col} vs {person_tint})")
    # the pill engulfs its whole row
    roww = pg.evaluate("""() => {
      const lib = document.querySelector('.hub-librow');
      const pill = document.querySelector('.hub-libpill');
      return { row: lib.clientWidth, pill: pill.getBoundingClientRect().width };
    }""")
    ok(roww["pill"] >= roww["row"] * 0.92,
       f"the library pill engulfs its row ({roww['pill']}px of {roww['row']}px)")
    # the count chip shows on the active pill
    ok("4" in pg.locator('.hub-libpill[data-lib="persona"]').inner_text(),
       "the active pill carries the item count (4 seeded)")
    # the search bar sits UNDER the header
    under = pg.evaluate("""() => {
      const h = document.querySelector('.pub-head').getBoundingClientRect();
      const s = document.getElementById('hub-search').getBoundingClientRect();
      return s.top >= h.bottom - 1;
    }""")
    ok(under, "the search bar sits under the header")
    ok(len(card_names()) == 4, "the 4 seeded personas render")

    # the TEMPLATE pill tints GREEN when selected
    pg.locator('.hub-libpill[data-lib="template"]').click(); pg.wait_for_timeout(1200)
    tmpl_tint = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--template-tint').trim()")
    sel_col2 = pg.evaluate("""() => getComputedStyle(document.querySelector('.hub-libpill[data-lib="template"][data-on="1"]')).color""")
    ok(hex_of(sel_col2) == hex_of(tmpl_tint),
       f"the selected template pill rides the GREEN tone ({sel_col2} vs {tmpl_tint})")
    ok(len(card_names()) == 1 and card_names()[0] == "Report Outline",
       "switching to Templates lists the seeded template")
    pg.locator('.hub-libpill[data-lib="persona"]').click(); pg.wait_for_timeout(1200)

    # ══ 2. THE COLLAPSIBLE HEADER (tweak 4) ══════════════════════════
    print("the collapsible header")
    chev0 = pg.locator(".pub-chev").inner_text().strip()
    pg.locator("#pub-head-toggle").click(); pg.wait_for_timeout(350)
    ok(pg.locator("#pub-head.folded").count() == 1, "tapping the bar folds the header")
    ok(chev0 == "▾" and pg.locator(".pub-chev").inner_text().strip() == "▸",
       "the chevron flips ▾ → ▸")
    ok(pg.locator("#pub-head-toggle").get_attribute("aria-expanded") == "false",
       "aria-expanded tracks the fold")
    body_h = pg.evaluate("() => document.querySelector('.pub-head-body').getBoundingClientRect().height")
    ok(body_h == 0, f"the folded body collapses to zero height ({body_h}px)")
    ok(pg.locator("#hub-search").is_visible(), "the search bar stays visible under the folded header")
    ok(pg.locator(".hub-fcol").first.is_visible(), "the filter row stays visible")
    ok(len(card_names()) == 4, "the grid stays put while folded")
    pg.locator("#pub-head-toggle").click(); pg.wait_for_timeout(350)
    ok(pg.locator("#pub-head.folded").count() == 0, "tapping again expands the header")
    ok(pg.locator("#hub-publish").is_visible(), "the publish button returns with the expansion")

    # ══ 3. THE FILTER ROW (tweak 7) ═════════════════════════════════
    print("the filter columns")
    ok(pg.locator(".hub-funnel svg").count() == 1, "the funnel icon sits left of the columns")
    cols = [t.strip().lower() for t in pg.locator(".hub-fcol").all_inner_texts()]
    ok(cols == ["recent", "downloads", "endorsements", "relevant"],
       f"the columns read Recent | Downloads | Endorsements | Relevant ({cols})")
    ok(pg.locator("#hub-fsub").inner_text().strip() == "newest updates first",
       "the filter subtext explains the active filter")
    acc2 = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim()")
    on_col = pg.evaluate("""() => getComputedStyle(document.querySelector('.hub-fcol[data-on="1"]')).color""")
    ok(hex_of(on_col) == hex_of(acc2),
       f"the selected column carries the theme accent ({on_col} vs {acc2})")
    ok(pg.evaluate("""() => getComputedStyle(document.querySelectorAll('.hub-fcol')[1]).borderLeftWidth""") == "1px",
       "the columns are divided (not pills)")
    # the filters WORK
    ok(card_names() == ["Star Captain", "Cosmic Chef", "Moon Whisperer", "Void Bard"],
       f"recent = newest first ({card_names()})")
    sort("downloads")
    ok(card_names() == ["Moon Whisperer", "Void Bard", "Star Captain", "Cosmic Chef"],
       f"downloads reorders the grid ({card_names()})")
    ok(pg.locator("#hub-fsub").inner_text().strip() == "most downloaded first",
       "the subtext follows the filter")
    sort("recent")

    # ══ 4. THE KEYBOARD-SAFE SEARCH (tweak 5) ════════════════════════
    print("search without losing the keyboard")
    pg.fill("#hub-search", "")
    pg.locator("#hub-search").click()
    same_node = pg.evaluate("""() => {
      window.__hubSearchNode = document.getElementById('hub-search');
      return window.__hubSearchNode === document.activeElement;
    }""")
    ok(same_node, "the search input takes focus")
    pg.keyboard.type("star", delay=90)
    pg.wait_for_timeout(1100)   # debounce + fetch + surgical render
    still = pg.evaluate("() => window.__hubSearchNode === document.getElementById('hub-search')")
    ok(still, "typing NEVER replaces the input node (the keyboard stays up)")
    ok(pg.evaluate("() => document.activeElement === window.__hubSearchNode"),
       "the input is still focused after the results landed")
    ok(card_names() == ["Star Captain"], f"the results narrowed live ({card_names()})")
    pg.keyboard.type("zz", delay=90)     # 'starzz' → nothing
    pg.wait_for_timeout(1100)
    ok(pg.locator(".hub-empty").count() == 1 and "starzz" in pg.locator(".hub-empty").inner_text(),
       "the empty state names the failed query")
    ok(pg.evaluate("() => document.activeElement === window.__hubSearchNode"),
       "focus survives even the empty state")
    search("")
    ok(len(card_names()) == 4, "clearing restores all 4")

    # ══ 5. THE PILL SYSTEM (tweak 3) ════════════════════════════════
    print("the shared pill system")
    tags = sorted(t.strip().lstrip("#") for t in pg.locator(".dx-pill[data-tag]").all_inner_texts())
    ok(len(tags) == 7, f"the tag pills route through the shared system ({tags})")
    pr = pg.evaluate("""() => {
      const el = document.querySelector('.dx-pill[data-tag]');
      const cs = getComputedStyle(el);
      return { r: cs.borderRadius, sh: cs.boxShadow };
    }""")
    ok(pr["r"] and pr["r"] != "999px" and len(re.findall(r"px", pr["r"])) >= 2,
       f"pills are LESS rounded — organic multi-corner radii ({pr['r']})")
    ok(pr["sh"] and pr["sh"] != "none", f"the sketch offset stroke paints ({pr['sh'][:40]}…)")
    # selecting a tag pill tints it with the theme accent
    pg.locator('[data-tag="space"]').click(); pg.wait_for_timeout(900)
    on_tag = pg.evaluate("""() => getComputedStyle(document.querySelector('.dx-pill[data-tag="space"]')).color""")
    ok(hex_of(on_tag) == hex_of(acc2), f"a selected tag pill carries the theme accent ({on_tag})")
    ok(card_names() == ["Star Captain", "Cosmic Chef"], f"the tag filter works ({card_names()})")
    pg.locator('[data-tag="space"]').click(); pg.wait_for_timeout(900)
    # (the chat header pills join the same language — checked in §9, once
    #  the chat root is actually visible again)

    # ══ 6. item detail regression (the cards still open) ════════════
    print("item detail")
    pg.locator(".hub-card").first.click(); pg.wait_for_timeout(900)
    ok(pg.locator(".hi-title").inner_text().strip() == "Star Captain", "the detail opens from the card")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(500)

    # ══ 7. THE PUBLISH PAGE (tweaks 8 + the 10-color gradient) ══════
    print("publish — sections, focus, gradient")
    pg.locator("#hub-publish").click(); pg.wait_for_timeout(700)
    ok(pg.locator(".hp-sec").count() == 3, "the form carries 3 collapsible sections")
    titles = [t.lower() for t in pg.locator(".hp-sec-title").all_inner_texts()]
    ok(any("essentials" in t for t in titles) and any("card design" in t for t in titles) and
       any("payload" in t for t in titles), f"the sections read essentials/design/payload ({titles})")
    star = pg.evaluate("() => getComputedStyle(document.querySelector('.hp-star')).color")
    accent = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
    ok(hex_of(star) == hex_of(accent), f"the * next to Name rides the PRIMARY color ({star} vs {accent})")
    # sections fold
    pg.locator('[data-fold="details"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator("#hp-sec-details.folded").count() == 1, "the essentials section folds")
    ok(not pg.locator("#hp-name").is_visible(), "…hiding the name input")
    pg.locator('[data-fold="details"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator("#hp-name").is_visible(), "…and unfolds back")
    # FOCUS MODE
    pre = pg.evaluate("() => document.getElementById('hp-payload').getBoundingClientRect().height")
    pg.locator("#hp-focus").click(); pg.wait_for_timeout(350)
    post = pg.evaluate("() => document.getElementById('hp-payload').getBoundingClientRect().height")
    ok(post >= pre + 60, f"focus grows the payload to own the screen ({pre:.0f} → {post:.0f}px)")
    ok(not pg.locator("#hp-sec-details").is_visible(), "the other sections hide in focus mode")
    ok(pg.locator("#hp-publish").is_visible(), "the publish button stays reachable in focus")
    pg.locator("#hp-focus").click(); pg.wait_for_timeout(350)
    ok(pg.locator("#hp-sec-details").is_visible(), "leaving focus restores the sections")
    # the gradient editor — 2 → 10, remove, live preview
    pg.fill("#hp-name", "Gradient Bloom")
    pg.fill("#hp-desc", "Ten colors of dawn")
    pg.locator('[data-desg="gradient"]').click(); pg.wait_for_timeout(400)
    ok(pg.locator(".gr-color").count() == 2, "the gradient editor starts from the familiar pair")
    for _ in range(8):
        pg.locator('[data-gr-add]').click(); pg.wait_for_timeout(150)
    ok(pg.locator(".gr-color").count() == 10, "＋ grows the gradient to 10 colors")
    ok(pg.locator('[data-gr-add]').is_disabled(), "the ＋ caps at 10 (disabled)")
    ok(pg.locator(".gr-count").inner_text().strip() == "10 / 10", "the count reads 10 / 10")
    ok(pg.locator(".gr-rm").count() == 10, "every swatch carries its remove ✕")
    pg.locator('[data-gr-rm="9"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator(".gr-color").count() == 9, "✕ removes a color (9 left)")
    pg.locator('[data-gr-add]').click(); pg.wait_for_timeout(300)
    ok(pg.locator(".gr-color").count() == 10, "back to 10")
    pg.locator('.gr-color[data-gr="0"]').evaluate("el => { el.value = '#667eea'; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    pg.locator('.gr-color[data-gr="1"]').evaluate("el => { el.value = '#764ba2'; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    prev = pg.locator("#hp-preview").get_attribute("style") or ""
    ok("#667eea" in prev and "#764ba2" in prev, "the color pickers drive the live preview")
    ok("linear-gradient" in prev and prev.count("#") >= 10, f"the preview carries all 10 stops ({prev.count('#')} colors)")
    pg.fill("#hp-payload", "# Gradient Bloom\n\nYou are **Gradient Bloom**.\n")
    # RANDOM = a random STOP COUNT (seed Math.random → deterministic)
    pg.evaluate("() => { let i = 0; Math.random = () => [0.999, 0.42, 0.7, 0.1, 0.55, 0.85, 0.3, 0.95, 0.5, 0.65][i++ % 10]; }")
    pg.locator('[data-gr-random]').click(); pg.wait_for_timeout(400)
    n_colors = pg.locator(".gr-color").count()
    ok(n_colors == 10,
       f"↻ random regenerates a RANDOM-COUNT gradient (got {n_colors} colors)")
    # publish → 401 → the connect flow (the form survives)
    pg.locator("#hp-publish").click(); pg.wait_for_timeout(1200)
    ok(pg.locator("#hc-token").count() == 1, "a 401 stacks the connect flow over the intact form")
    pg.fill("#hc-token", TOKEN)
    pg.locator("#hc-connect").click(); pg.wait_for_timeout(3000)
    ok(pg.locator(".hi-title").inner_text().strip() == "Gradient Bloom",
       "connect success auto-published → the detail opens")
    ok("by tester" in pg.locator(".hi-meta").inner_text(), "the published item carries the HF author")
    # the engine kept ALL the stops (the 3→10 cap raise)
    _, items = japi("GET", "/api/hub/persona/items?refresh=1")
    mine = [i for i in items.get("items", []) if i.get("name") == "Gradient Bloom"]
    ok(len(mine) == 1 and len(mine[0].get("design", {}).get("colors", [])) == n_colors,
       f"the engine round-trips the {n_colors}-color gradient (was capped at 3)")
    # the mock HF received the NDJSON commit with the design
    gb_id = mine[0]["id"]
    commit_json = None
    with LOCK:
        for repo, nd in reversed(STATE["commits"]):
            if repo == "tester/doomalay-personas":
                for line in nd.strip().split("\n"):
                    op = json.loads(line)
                    if op.get("key") == "file" and op["value"]["path"] == f"items/{gb_id}.json":
                        commit_json = json.loads(base64.b64decode(op["value"]["content"]))
                if commit_json: break
    ok(commit_json and len(commit_json.get("design", {}).get("colors", [])) == n_colors,
       "the NDJSON commit carries the full gradient to Hugging Face")

    # ══ 8. THE CROP FLOW (tweak 1) ══════════════════════════════════
    print("publish — the drag-to-crop image")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(400)
    open_hub()
    pg.locator("#hub-publish").click(); pg.wait_for_timeout(700)
    pg.fill("#hp-name", "Cropped Vista")
    pg.fill("#hp-payload", "# Cropped Vista\n\nA cropped view.\n")
    pg.locator('[data-desg="image"]').click(); pg.wait_for_timeout(400)
    ok(pg.locator(".crop-ui").count() == 0, "no crop overlay until an image is picked")
    # a real 400×330 PNG (taller than the 1.5 frame → vertical slack to drag)
    def make_png_wide(path, w=400, h=330, rgb=(40, 120, 90)):
        raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
        def chunk(tag, data):
            c = struct.pack(">I", len(data)) + tag + data
            return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        png = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))
        open(path, "wb").write(png)
        return path
    wide_path = make_png_wide("/tmp/v33-crop.png")
    pg.locator("#hp-file").set_input_files(wide_path)
    pg.wait_for_timeout(1000)
    ok(pg.locator(".crop-ui").count() == 1, "picking an image opens the crop overlay")
    fit = pg.evaluate("""() => {
      const f = document.querySelector('.crop-fit').getBoundingClientRect();
      return { w: f.width, h: f.height };
    }""")
    ok(abs(fit["w"] / fit["h"] - 1.5) < 0.05, f"the crop frame holds the card's aspect ({fit['w']:.0f}×{fit['h']:.0f})")
    t0 = pg.evaluate("() => document.querySelector('.crop-img').style.transform")
    ok(t0 and t0 != "", f"the image is placed under the frame (transform {t0[:40]}…)")
    # DRAG it (vertical slack: 400×330 in a 1.5 frame → the y axis moves)
    stage = pg.locator(".crop-stage")
    box = stage.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    pg.mouse.move(cx, cy); pg.mouse.down()
    pg.mouse.move(cx + 40, cy - 60, steps=12)
    pg.mouse.up()
    pg.wait_for_timeout(300)
    t1 = pg.evaluate("() => document.querySelector('.crop-img').style.transform")
    ok(t1 != t0, f"dragging moves the image under the frame ({t0} → {t1})")
    # ZOOM with the slider
    w0 = pg.evaluate("() => document.querySelector('.crop-img').getBoundingClientRect().width")
    pg.locator(".crop-zoom").evaluate("el => { el.value = 2; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    pg.wait_for_timeout(250)
    w1 = pg.evaluate("() => document.querySelector('.crop-img').getBoundingClientRect().width")
    ok(w1 > w0 * 1.5, f"the zoom slider grows the image ({w0:.0f} → {w1:.0f}px)")
    # APPLY — the crop is taken from the ORIGINAL pixels
    pg.locator(".crop-ok").click(); pg.wait_for_timeout(900)
    ok(pg.locator(".crop-ui").count() == 0, "apply closes the overlay")
    pv = pg.locator("#hp-preview").get_attribute("style") or ""
    ok("data:image/png;base64" in pv, "the preview shows the cropped PNG")
    ok(pg.locator(".hp-imgmeta").count() == 1, "the meta line confirms the cropped image")
    # publish (already connected — no 401 this time)
    pg.locator("#hp-publish").click(); pg.wait_for_timeout(2500)
    if pg.locator(".hi-title").count() == 0:
        print("DEBUG hp-err:", repr(pg.locator("#hp-err").inner_text()))
        print("DEBUG view title:", pg.locator("#panel-name").inner_text())
        print("DEBUG body:", pg.evaluate("() => document.getElementById('panel-body').innerHTML.slice(0, 300)"))
        print("DEBUG pub btn:", pg.locator("#hp-publish").inner_text() if pg.locator("#hp-publish").count() else "GONE")
        print("DEBUG commits:", len(__import__("json").dumps([r for r, _ in STATE["commits"]])))
        import json as _j
        with LOCK:
            print("DEBUG commit repos:", [r for r, _ in STATE["commits"]])
        print("DEBUG bad responses:", _badresp[-10:])
    ok(pg.locator(".hi-title").inner_text().strip() == "Cropped Vista",
       "the cropped item publishes → the detail opens")
    _, items2 = japi("GET", "/api/hub/persona/items?refresh=1")
    cv = [i for i in items2.get("items", []) if i.get("name") == "Cropped Vista"]
    ok(cv and cv[0].get("design", {}).get("kind") == "png", "the design rides the PNG")
    st_png, png_bytes = api("GET", f"/api/hub/persona/png/tester%2Fdoomalay-personas/{cv[0]['id']}")
    ok(st_png == 200 and png_bytes[:4] == b"\x89PNG", "the png route serves the cropped bytes")
    ok(len(png_bytes) > 1000, f"the cropped PNG carries real resolution ({len(png_bytes)} bytes, not an 8×8 stub)")
    with LOCK:
        lfs_n = len(STATE["lfs"])
    ok(lfs_n >= 1, f"the mock HF received the PNG through LFS ({lfs_n} object)")

    # ══ 9. THE TWEAKS BACKGROUND (tweak 2) ══════════════════════════
    print("tweaks — the background gradient")
    pg.evaluate("() => document.getElementById('chat-scrim').click()"); pg.wait_for_timeout(600)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1000)
    # the chat header pills joined the shared pill language (tweak 3)
    pill_row_r = pg.evaluate("""() => {
      const el = document.querySelector('#pill-row button, #pill-row .pill-artifacts');
      return { r: getComputedStyle(el).borderRadius, sh: getComputedStyle(el).boxShadow };
    }""")
    ok(pill_row_r["r"] != "999px" and len(re.findall(r"px", pill_row_r["r"])) >= 2,
       f"the chat header pills are organic too ({pill_row_r['r']})")
    ok(pill_row_r["sh"] != "none", "the chat header pills carry the sketch stroke")
    if not pg.locator("#util-row .util-btn").first.is_visible():
        pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)
    pg.locator('#util-row .util-btn', has_text="tweaks").click(); pg.wait_for_timeout(900)
    pg.locator('h3[data-section-toggle]', has_text="Background").click(); pg.wait_for_timeout(400)
    ok(pg.locator("[data-bgmode]").count() == 3, "the Background segment carries color / gradient / image")
    ok(pg.evaluate("() => typeof window.ChatTweaks.setBgGradient === 'function'"),
       "ChatTweaks exposes setBgGradient")
    pg.locator('[data-bgmode="gradient"]').click(); pg.wait_for_timeout(350)
    ok(pg.locator("#tw-gr").count() == 1, "the gradient mode reveals the shared editor")
    ok(pg.locator("#tw-gr .gr-color").count() == 2, "it drafts the familiar pair")
    pg.locator('[data-gr-add]').click(); pg.wait_for_timeout(350)
    ok(pg.locator("#tw-gr .gr-color").count() == 3, "＋ adds a third color")
    # the section SURVIVED the rebuild (no fold-up mid-edit)
    ok(pg.locator("#tw-gr .gr-color").first.is_visible(),
       "the section stays expanded across the editor's rebuilds")
    # live apply to the chat root
    pg.locator('.gr-color[data-gr="0"]').evaluate("el => { el.value = '#1a2b3c'; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    pg.wait_for_timeout(600)
    bgi = pg.evaluate("() => window.ChatPanel.getState('c33')._chatRootEl.style.backgroundImage")
    ok("linear-gradient" in (bgi or "") and "rgb(26, 43, 60)" in (bgi or ""),
       f"the gradient paints behind the chat ({bgi[:60]}…)")  # CSSOM serializes #1a2b3c → rgb()
    _, tw = japi("GET", f"/api/sessions/{SID}/tweaks")
    bg = tw.get("tweaks", {}).get("bg", {})
    ok(bg.get("type") == "gradient" and len(bg.get("colors", [])) == 3,
       f"the engine blob carries the 3-color gradient ({bg})")
    ok("gradient is set" in pg.locator("#tweaks-bg-status").inner_text(), "the status line confirms the gradient")
    # remove to ONE color → a solid fill
    pg.locator('[data-gr-rm="2"]').click(); pg.wait_for_timeout(300)
    pg.locator('[data-gr-rm="1"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator("#tw-gr .gr-color").count() == 1, "colors can be removed down to 1")
    ok(pg.locator("#tw-gr .gr-rm").count() == 0, "the last ✕ hides at the 1-color minimum")
    bgc = pg.evaluate("() => window.ChatPanel.getState('c33')._chatRootEl.style.backgroundColor")
    bgi2 = pg.evaluate("() => window.ChatPanel.getState('c33')._chatRootEl.style.backgroundImage")
    ok(bgc == "rgb(26, 43, 60)" and bgi2 == "",
       f"a single stop renders as a SOLID fill (bg {bgc}, image {bgi2!r})")
    # the random button varies the count
    pg.locator('[data-gr-random]').click(); pg.wait_for_timeout(400)
    _, tw2 = japi("GET", f"/api/sessions/{SID}/tweaks")
    ok(tw2.get("tweaks", {}).get("bg", {}).get("type") == "gradient" and
       len(tw2.get("tweaks", {}).get("bg", {}).get("colors", [])) >= 1,
       "↻ random regenerates the background gradient")
    # the IMAGE pipeline still works alongside
    pg.locator('[data-bgmode="image"]').click(); pg.wait_for_timeout(300)
    img_path = "/tmp/v33-bg.png"
    with open(img_path, "wb") as f:
        f.write(make_png())
    pg.locator("#tweaks-bg-file").set_input_files(img_path)
    pg.wait_for_timeout(1500)
    ok("an image is set" in pg.locator("#tweaks-bg-status").inner_text(),
       "the image pipeline still works next to the gradient")
    bgi3 = pg.evaluate("() => window.ChatPanel.getState('c33')._chatRootEl.style.backgroundImage")
    ok("background?v=" in (bgi3 or ""), f"the image sets the rev-cache-busted URL ({bgi3[:50]}…)")
    pg.locator("#tweaks-bg-remove").click(); pg.wait_for_timeout(800)
    ok("nothing set" in pg.locator("#tweaks-bg-status").inner_text(), "removing clears the background again")

    # ══ 10. zero page errors ════════════════════════════════════════
    ok(len(errors) == 0, f"no page errors across the whole suite ({len(errors)})")
    if errors: print("   page errors:", errors)
    br.close()

print(f"\n{'='*50}\nTOTAL: {PASS} pass, {FAIL} fail")
try: br.close()
except Exception: pass
srv.shutdown()
proc.kill()
sys.exit(1 if FAIL else 0)
