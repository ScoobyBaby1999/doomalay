#!/usr/bin/env python3
# v31-browser-test.py — the v0.31 batch verification: THE HUB.
#
# Boots a fresh engine pointed at an IN-PROCESS MOCK HUGGING FACE server
# (python http.server, the v301-tunnel-e2e Forwarder pattern) via
# DOOMALAY_HUB_HF_BASE, then drives the real PWA with Playwright:
#
#   1.  the ◈ hub util pill → the library view (tabs dynamic from the
#       engine's registry: personas + templates).
#   2.  the card grid — default 2 cols (computed gridTemplateColumns),
#       paging math, steppers 1–5 × 3–10, localStorage persistence across
#       reload, and the viewport clamp (≥150px columns).
#   3.  mock items render: name / description / author / ♥ hearts /
#      ⤓ downloads; the PNG-backed card probes the engine's png route.
#   4.  search narrows by NAME, by TAG, and by DESCRIPTION (200ms
#       debounce); the four SORT pills reorder; tag pills filter.
#   5.  item detail — collapsible header, markdown body through the
#       app's formatter, the floating buttons.
#   6.  endorse DISABLED before download → download enables it → endorse
#       fills the heart (+1) → un-endorse mirrors. Downloading a persona
#       IMPORTS it into the chat (persona picker lists it).
#   7.  persona picker hearts — badge state, the API reflects, hearted
#       personas sort to TOP.
#   8.  publish — name-required 400 surfaced, tag cap in the UI, gradient
#       pickers set the design, the 401 connect flow (paste the mock
#       token → auto-publish resumes), the mock HF received the NDJSON
#       commit, and the published item appears (refresh) with its author.
#   9.  the settings text-size slider resizes hub text (computed
#       font-size before/after).
#  10.  zero page errors.
#
# Run: python3 scripts/v31-browser-test.py   (engine must NOT already run)
import base64, hashlib, http.server, json, os, re, shutil, struct, subprocess, sys, threading, time
import urllib.request, urllib.error, urllib.parse, zlib

BASE = "http://127.0.0.1:8099"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine-test")
DATA = "/tmp/doomalay-v31test"
PORT = 8099
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

        if path.endswith("/.git/info/lfs/objects/batch") and path.startswith("/datasets/"):
            repo = path[len("/datasets/"):-len(".git/info/lfs/objects/batch")]
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

        self._json({"error": "not found"}, 404)

    def do_PUT(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path.startswith("/lfs/"):
            oid = path[len("/lfs/"):]
            with LOCK:
                STATE["lfs"][oid] = self._read_body()
            self._send(b"{}", "application/json")
            return
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
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
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
    "title": "V31 Bot", "sandbox": "quick",
    "model": "nvidia/nvidia/nemotron-3-super", "provider": "nvidia"})
SID = json.loads(sess)["ID"]

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 400, "height": 760})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "c31", "type": "chat", "name": "V31 Bot", "family": "nvidia",
                        "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": "nvidia/nvidia/nemotron-3-super",
                        "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(700)
    pg.mouse.click(120, 200)          # tap the chatbot → panel opens
    pg.wait_for_timeout(1000)
    pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)   # reveal the pills

    def open_hub():
        pg.locator("#util-row .util-btn").nth(3).click()
        pg.wait_for_timeout(1300)    # libraries + items fetch (discovery)

    def card_names():
        return [t.strip() for t in pg.locator(".hub-card-name").all_inner_texts()]

    def search(q, wait=900):
        pg.fill("#hub-search", q)
        pg.wait_for_timeout(wait)     # 200ms debounce + fetch + render

    def sort(key):
        pg.locator(f'[data-sort="{key}"]').click()
        pg.wait_for_timeout(900)

    # ── 1. the hub pill → the library view ─────────────────────────
    print("hub pill + library view")
    utils = pg.locator("#util-row .util-btn")
    ok(utils.count() == 4, "util row: export + tweaks + usage + hub (4 pills)")
    ok("hub" in utils.nth(3).inner_text().lower(), "the hub pill is the 4th util pill")
    open_hub()
    ok(pg.locator("#panel-name").inner_text().strip() == "hub", "the hub view opens on the panel stack")
    ok(pg.locator("#panel-view-back").is_visible(), "the ‹ back bar is present (panel conventions)")
    tabs = [t.strip().lower() for t in pg.locator(".hub-tab").all_inner_texts()]
    ok(len(tabs) == 2, f"tabs are dynamic from the registry (2: {tabs})")
    ok("persona" in tabs[0] and "template" in tabs[1], "persona + template tabs")
    ok(len(card_names()) == 4, "the persona library lists the 4 seeded items")

    # ── 2. the grid — cols + rows + paging ──────────────────────────
    print("grid + paging")
    tracks = pg.evaluate("() => getComputedStyle(document.getElementById('hub-grid')).gridTemplateColumns.split(' ').length")
    ok(tracks == 2, "default grid = 2 columns (computed gridTemplateColumns)")
    ok(pg.locator("#hub-cols-val").inner_text() == "2" and
       pg.locator("#hub-rows-val").inner_text() == "5", "default stepper values 2 × 5")
    ok(pg.locator(".hub-page-line").inner_text().strip() == "page 1/1", "4 items on one 2×5 page")
    # shrink to 1×3 → 3 per page → 2 pages
    pg.locator('[data-step="cols:-1"]').click(); pg.wait_for_timeout(300)
    pg.locator('[data-step="rows:-1"]').click(); pg.wait_for_timeout(300)
    pg.locator('[data-step="rows:-1"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator(".hub-page-line").inner_text().strip() == "page 1/2", "1×3 grid → page 1/2")
    ok(pg.locator(".hub-card").count() == 3, "3 cards on page 1 (cols × rows)")
    pg.locator('[data-page="next"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator(".hub-page-line").inner_text().strip() == "page 2/2", "next → page 2/2")
    ok(pg.locator(".hub-card").count() == 1, "1 card on page 2")
    pg.locator('[data-page="prev"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator(".hub-page-line").inner_text().strip() == "page 1/2", "prev → back to page 1/2")

    # ── 3. grid prefs persist (localStorage doomalay.hubgrid.v1) ────
    print("grid persistence + viewport clamp")
    for _ in range(3): pg.locator('[data-step="cols:1"]').click(); pg.wait_for_timeout(150)
    for _ in range(5): pg.locator('[data-step="rows:1"]').click(); pg.wait_for_timeout(150)
    grid_pref = pg.evaluate("() => JSON.parse(localStorage.getItem('doomalay.hubgrid.v1'))")
    ok(grid_pref == {"cols": 4, "rows": 8}, f"steppers persist 4×8 to localStorage ({grid_pref})")
    pg.reload(); pg.wait_for_timeout(700)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1200)
    pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)
    open_hub()
    ok(pg.locator("#hub-cols-val").inner_text() == "4" and
       pg.locator("#hub-rows-val").inner_text() == "8", "prefs survive reload (steppers 4 × 8)")
    tracks = pg.evaluate("() => getComputedStyle(document.getElementById('hub-grid')).gridTemplateColumns.split(' ').length")
    ok(tracks == 2, "…but the 400px viewport CLAMPS to 2 columns (≥150px columns)")
    pg.set_viewport_size({"width": 900, "height": 900}); pg.wait_for_timeout(600)
    tracks = pg.evaluate("() => getComputedStyle(document.getElementById('hub-grid')).gridTemplateColumns.split(' ').length")
    ok(tracks == 4, "a 900px viewport renders all 4 columns (resize handler)")
    pg.set_viewport_size({"width": 400, "height": 760}); pg.wait_for_timeout(600)

    # ── 4. the mock items render ────────────────────────────────────
    print("mock items render")
    names = card_names()
    for want in ["Star Captain", "Moon Whisperer", "Cosmic Chef", "Void Bard"]:
        ok(want in names, f"card: {want}")
    sc_card = pg.locator(".hub-card", has_text="Star Captain")
    ok("space commander" in sc_card.locator(".hub-card-desc").inner_text(),
       "card sub = the item description")
    ok("by alice" in sc_card.locator(".hub-card-author").inner_text(), "card author line")
    foot = sc_card.locator(".hub-card-foot").inner_text()
    ok("♥ 2" in foot and "⤓ 1" in foot, f"card footer ♥ 2 + ⤓ 1 (federated metrics) ({foot.strip()})")
    pg.wait_for_timeout(800)  # the PNG probe settles
    cc_bg = pg.evaluate("""() => {
      const cards = [...document.querySelectorAll('.hub-card')];
      const c = cards.find(x => x.textContent.includes('Cosmic Chef'));
      return c ? c.querySelector('.hub-card-bg').style.backgroundImage : '';
    }""")
    ok("/api/hub/persona/png/" in cc_bg, "the PNG item probes the engine's png route as its background")

    # ── 5. search (name / tag / description) ────────────────────────
    print("search")
    search("captain")
    ok(card_names() == ["Star Captain"], "search by NAME narrows to Star Captain")
    search("space")
    ok(sorted(card_names()) == ["Cosmic Chef", "Star Captain"], "search by TAG returns the space pair")
    search("galaxy")
    ok(card_names() == ["Cosmic Chef"], "search by DESCRIPTION finds Cosmic Chef")
    search("")
    ok(len(card_names()) == 4, "cleared search → all 4 again")

    # ── 6. sort pills ────────────────────────────────────────────────
    print("sort pills")
    sort("recent")
    ok(card_names() == ["Star Captain", "Cosmic Chef", "Moon Whisperer", "Void Bard"],
       "recent: SC → CC → MW → VB (updatedAt)")
    sort("downloads")
    ok(card_names() == ["Moon Whisperer", "Void Bard", "Star Captain", "Cosmic Chef"],
       "downloads: MW 3 → VB 2 → SC 1 → CC 0")
    sort("hearts")
    ok(card_names() == ["Star Captain", "Moon Whisperer", "Cosmic Chef", "Void Bard"],
       "endorsed: SC 2 → MW 1 → CC/VB 0 (updated tie-break)")
    search("space"); sort("relevant")
    ok(card_names() == ["Star Captain", "Cosmic Chef"],
       "relevant: SC (tag+desc) outranks CC (tag) for 'space'")
    search("")
    ok(len(card_names()) == 4, "back to all 4")

    # ── 7. tag pills ─────────────────────────────────────────────────
    print("tag pills")
    tags = sorted(t.strip().lstrip("#") for t in pg.locator(".hub-pill[data-tag]").all_inner_texts())
    ok(len(tags) == 7, f"tag pills built from the results ({tags})")
    pg.locator('[data-tag="space"]').click(); pg.wait_for_timeout(900)
    ok(sorted(card_names()) == ["Cosmic Chef", "Star Captain"], "tag pill filters to the space pair")
    on = pg.locator('[data-tag="space"]').get_attribute("data-on")
    ok(on == "1", "the active tag pill is highlighted")
    pg.locator('[data-tag="space"]').click(); pg.wait_for_timeout(900)
    ok(len(card_names()) == 4, "tapping the tag again clears the filter")

    # ── 7b. the template tab (modular: switching reloads per type) ──
    print("template tab")
    pg.locator('.hub-tab[data-tab="template"]').click(); pg.wait_for_timeout(1200)
    ok(card_names() == ["Report Outline"], "switching tabs reloads the template library")
    pg.locator(".hub-card", has_text="Report Outline").click(); pg.wait_for_timeout(1300)
    ok(pg.locator(".hi-title").inner_text().strip() == "Report Outline", "template detail opens")
    ok("sections" in pg.locator("#hi-body").inner_text(), "the JSON payload renders (formatted code block)")
    ok(pg.locator("#hi-body pre").count() >= 1, "templates render as a highlighted code block")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(500)
    pg.locator('.hub-tab[data-tab="persona"]').click(); pg.wait_for_timeout(1200)
    ok(len(card_names()) == 4, "back on the persona tab")

    # ── 8. the item detail ───────────────────────────────────────────
    print("item detail")
    pg.locator(".hub-card", has_text="Star Captain").click(); pg.wait_for_timeout(1300)
    ok(pg.locator(".hi-title").inner_text().strip() == "Star Captain", "detail: title")
    ok("space commander" in pg.locator(".hi-desc").inner_text(), "detail: description")
    ok("by alice" in pg.locator(".hi-meta").inner_text(), "detail: author")
    ok(pg.locator(".hi-chip", has_text="#space").count() == 1, "detail: tags as chips")
    counts = pg.locator(".hi-counts").inner_text()
    ok("♥ 2" in counts and "⤓ 1" in counts, f"detail: hearts + downloads ({counts.strip()})")
    ok(pg.locator("#hi-body .fmt").count() >= 1, "the payload renders through the app's markdown pipeline")
    ok("never abandon ship" in pg.locator("#hi-body").inner_text(), "the persona markdown body is visible")
    ok(pg.locator("#hi-dl").is_visible() and pg.locator("#hi-heart").is_visible(),
       "the floating download + endorse buttons are visible")

    # ── 9. endorse requires download ─────────────────────────────────
    print("endorse flow")
    ok(pg.locator("#hi-heart").is_disabled(), "endorse is DISABLED before the download")
    ok("download first" in (pg.locator("#hi-heart").get_attribute("title") or ""),
       "the disabled heart carries the 'download first' tooltip")
    pg.locator("#hi-dl").click(); pg.wait_for_timeout(1800)
    ok(not pg.locator("#hi-heart").is_disabled(), "download enables endorse")
    ok("⤓ 2" in pg.locator(".hi-counts").inner_text(), "the download count bumps (+1 local)")
    pg.locator("#hi-heart").click(); pg.wait_for_timeout(1300)
    ok("on" in (pg.locator("#hi-heart").get_attribute("class") or ""),
       "endorse fills the heart (class .on)")
    ok("♥ 3" in pg.locator(".hi-counts").inner_text(), "hearts +1 after endorsing")
    pg.locator("#hi-heart").click(); pg.wait_for_timeout(1300)
    ok("on" not in (pg.locator("#hi-heart").get_attribute("class") or ""),
       "a second tap UN-endorses")
    ok("♥ 2" in pg.locator(".hi-counts").inner_text(), "hearts back down after un-endorsing")
    pg.locator("#hi-heart").click(); pg.wait_for_timeout(1300)   # leave it endorsed

    # ── 10. the download imported the persona into the chat ─────────
    print("persona import")
    _, s2 = japi("GET", f"/api/sessions/{SID}")
    personas = json.loads(s2.get("Personas") or "[]")
    imported = [p for p in personas if p.get("name") == "Star Captain"]
    ok(len(imported) == 1, "the engine session carries the downloaded persona")
    ok(imported and imported[0].get("mode") == "inactive", "imported personas start INACTIVE (persona_set convention)")
    pg.locator("#panel-view-x").click(); pg.wait_for_timeout(500)   # drop views → chat root
    pg.locator("#pill-persona").click(); pg.wait_for_timeout(900)
    picker = pg.locator(".panel-body").inner_text()
    ok("Star Captain" in picker, "the persona picker lists the imported persona")

    # ── 11. the picker's heart badges + hearted-first sort ───────────
    print("persona picker hearts")
    ok(pg.locator("[data-heart]").count() == 2, "every picker card carries a heart badge")
    ok("on" in (pg.locator('[data-heart]').first.get_attribute("class") or ""),
       "the hub-endorsed persona's badge is filled (♥)")
    _, hearted = japi("GET", "/api/hub/personas/hearted")
    hearted_ids = [p.get("id") for p in (hearted.get("personas") or [])]
    ok(SC_ID in hearted_ids, "GET /api/hub/personas/hearted reflects the hub heart")
    # heart the DEFAULT persona (currently 2nd) — it must jump to TOP
    pg.locator('button[data-persona]', has_text="Default").locator("[data-heart]").click()
    pg.wait_for_timeout(900)
    _, hearted2 = japi("GET", "/api/hub/personas/hearted")
    hearted_ids2 = [p.get("id") for p in (hearted2.get("personas") or [])]
    ok("p_default" in hearted_ids2, "hearting a non-hub persona POSTs to the local heart list")
    first_row = pg.locator("button[data-persona]").first.inner_text()
    ok("Default" in first_row, f"the freshly hearted persona sorts to TOP ({first_row[:30]!r})")

    # ── 12. publish + the HF connect flow ────────────────────────────
    print("publish + connect")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(400)   # back to the chat root
    open_hub()
    pg.locator("#hub-publish").click(); pg.wait_for_timeout(700)
    # name-required 400 surfaces (no client-side blocking — the engine is the truth)
    pg.locator("#hp-publish").click(); pg.wait_for_timeout(900)
    ok("name is required" in pg.locator("#hp-err").inner_text(),
       "the engine's name-required 400 is surfaced inline")
    pg.fill("#hp-name", "Nebula Pilot")
    pg.fill("#hp-desc", "Navigates the nebula with style")
    # tag cap: 16 entered → 15 chips kept
    for i in range(16):
        pg.fill("#hp-tag-in", f"tag{i:02d}")
        pg.press("#hp-tag-in", "Enter")
        pg.wait_for_timeout(120)
    ok(pg.locator(".hp-chip").count() == 15, f"the tag input caps at 15 chips ({pg.locator('.hp-chip').count()})")
    pg.locator('[data-untag="14"]').click(); pg.wait_for_timeout(300)
    ok(pg.locator(".hp-chip").count() == 14, "a chip's ✕ removes it")
    # gradient design: pickers + live preview
    pg.locator('[data-desg="gradient"]').click(); pg.wait_for_timeout(400)
    ok(pg.locator(".hp-color").count() == 2, "the gradient segment shows 2 color inputs")
    pg.locator('[data-color="0"]').evaluate("el => { el.value = '#667eea'; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    pg.locator('[data-color="1"]').evaluate("el => { el.value = '#764ba2'; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    prev = pg.locator("#hp-preview").get_attribute("style") or ""
    ok("#667eea" in prev and "#764ba2" in prev, "the color pickers drive the live preview")
    pg.fill("#hp-payload", "# Nebula Pilot\n\nYou are **Nebula Pilot** — calm among the stars.\n")
    # publish with NO token → 401 → the connect flow (form NOT lost)
    pg.locator("#hp-publish").click(); pg.wait_for_timeout(1200)
    ok(pg.locator("#hc-token").count() == 1, "a 401 swaps to the connect flow (the form survives beneath)")
    ok(pg.locator("#hc-open").count() == 1, "the connect view offers the 'Open Hugging Face' button")
    pg.fill("#hc-token", "definitely-wrong-token")
    pg.locator("#hc-connect").click(); pg.wait_for_timeout(1200)
    ok(pg.locator("#hc-err").inner_text().strip() != "", "a bad token shows an inline error and stays")
    pg.fill("#hc-token", TOKEN)
    pg.locator("#hc-connect").click(); pg.wait_for_timeout(3000)  # connect → auto-publish → item view
    ok(pg.locator(".hi-title").inner_text().strip() == "Nebula Pilot",
       "the connect success auto-resumed the publish → the new item's detail opens")
    ok("by tester" in pg.locator(".hi-meta").inner_text(), "the published item carries the HF author")

    # the endorse in §9 ran PRE-connect (no token yet → the engine skips the
    # HF like by design). Re-endorse while CONNECTED → the like + the heart
    # metric event actually reach the mock HF now.
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(900)   # back to the hub list
    pg.locator(".hub-card", has_text="Star Captain").click(); pg.wait_for_timeout(1400)
    ok(not pg.locator("#hi-heart").is_disabled(), "the downloaded item's endorse stays enabled")
    pg.locator("#hi-heart").click(); pg.wait_for_timeout(1400)   # un-endorse → HF unlike
    pg.locator("#hi-heart").click(); pg.wait_for_timeout(2200)   # re-endorse → HF like + heart metric
    ok("on" in (pg.locator("#hi-heart").get_attribute("class") or ""),
       "re-endorsed while connected (the heart fills again)")

    # the mock HF received everything
    with LOCK:
        created = list(STATE["created"])
        commits = list(STATE["commits"])
        likes = dict(STATE["likes"])
    ok("tester/doomalay-personas" in created, "the engine created the publisher's dataset repo")
    ok("tester/doomalay-metrics" in created, "…and the metrics sidecar repo")
    ok(likes.get(ALICE_REPO) is True, "endorsing while connected LIKES the publisher's repo (HF like recorded)")
    np_id = item_id("Nebula Pilot", "tester")
    lib_commit = [c for c in commits if c[0] == "tester/doomalay-personas"]
    found_meta = None
    for _, body in lib_commit:
        for line in body.strip().split("\n"):
            op = json.loads(line)
            if op.get("key") == "file" and op["value"]["path"] == f"items/{np_id}.json":
                found_meta = json.loads(base64.b64decode(op["value"]["content"]))
    ok(found_meta is not None, "the mock HF received the NDJSON commit with items/<id>.json")
    ok(found_meta and found_meta.get("design", {}).get("colors") == ["#667eea", "#764ba2"],
       "the committed design carries the picked gradient colors")
    ok(found_meta and found_meta.get("author") == "tester" and found_meta.get("name") == "Nebula Pilot",
       "the committed item meta carries the author + name")
    # back → the hub list refreshed (stale) with the status line + the new card
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(1600)
    status = " ".join(pg.locator(".hub-status").inner_text().split())
    ok("connected as tester" in status, f"the hub shows 'HF: connected as tester' ({status.strip()})")
    search("nebula")
    ok(card_names() == ["Nebula Pilot"], "the published item appears in the library (refresh)")
    np_card = pg.locator(".hub-card", has_text="Nebula Pilot")
    ok("by tester" in np_card.locator(".hub-card-author").inner_text(), "…with its author")
    search("")

    # ── 12b. the persona editor's publish pill prefills ─────────────
    print("persona editor → publish prefill")
    pg.locator("#panel-view-x").click(); pg.wait_for_timeout(500)
    pg.locator("#pill-persona").click(); pg.wait_for_timeout(900)
    pg.locator('button[data-persona]', has_text="Star Captain").click(); pg.wait_for_timeout(1500)
    ok(pg.locator("#pe-publish").count() == 1, "the editor action row carries the publish pill")
    pg.locator("#pe-publish").click(); pg.wait_for_timeout(700)
    ok(pg.locator("#hp-name").input_value() == "Star Captain", "the publish form prefills the persona name")
    ok(len(pg.locator("#hp-payload").input_value()) > 40, "…and the persona text as the payload")

    # ── 13. the settings text-size slider resizes hub text ───────────
    print("text-size system")
    pg.locator("#panel-view-x").click(); pg.wait_for_timeout(500)
    open_hub()
    uifs = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--ui-fs').trim()")
    before = pg.evaluate("() => getComputedStyle(document.querySelector('.hub-card-name')).fontSize")
    ok(before == uifs == "14.5px", f"hub card names ride --ui-fs (default 50 → 14.5px, got {before})")
    pg.evaluate("() => window.Settings.setState({uiTextSize: 100})")
    pg.wait_for_timeout(200)
    after = pg.evaluate("() => getComputedStyle(document.querySelector('.hub-card-name')).fontSize")
    ok(after == "17px", f"the settings store write resizes hub text live (17px, got {after})")
    # …and through the REAL settings slider (gear → Sizing page → Text Size)
    pg.locator("#chat-scrim").click(position={"x": 10, "y": 10}); pg.wait_for_timeout(500)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(900)
    pg.locator(".settings-nav .tab", has_text="Sizing").click(); pg.wait_for_timeout(400)
    pg.locator(".settings-section h3", has_text="Text Size").first.click(); pg.wait_for_timeout(300)
    pg.locator('input.app-range[data-setting-key="uiTextSize"]').evaluate(
        "el => { el.value = 25; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    pg.wait_for_timeout(400)
    uifs = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--ui-fs').trim()")
    ok(uifs == "13.3px", f"dragging the General-text slider sets --ui-fs (13.3px, got {uifs})")
    # the settings panel opens FULL — its handle shadows the scrim at (10,10),
    # so close it through the scrim's own click path (the standard close).
    pg.evaluate("() => document.getElementById('chat-scrim').click()"); pg.wait_for_timeout(500)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1200)
    # the dropdown remembers its open state across panel close/reopen —
    # only toggle the header when the pills are actually hidden.
    if not pg.locator("#util-row .util-btn").nth(3).is_visible():
        pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)
    open_hub()
    final = pg.evaluate("() => getComputedStyle(document.querySelector('.hub-card-name')).fontSize")
    ok(final == "13.3px", f"the hub re-opens at the slider's size (13.3px, got {final})")

    # ── 14. zero page errors ─────────────────────────────────────────
    ok(len(errors) == 0, f"no page errors across the whole suite ({len(errors)})")
    if errors: print("   page errors:", errors)
    br.close()

print(f"\n{'='*50}\nTOTAL: {PASS} pass, {FAIL} fail")
try: br.close()
except Exception: pass
srv.shutdown()
proc.kill()
sys.exit(1 if FAIL else 0)
