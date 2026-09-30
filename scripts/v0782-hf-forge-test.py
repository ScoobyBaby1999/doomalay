#!/usr/bin/env python3
# v0782-hf-forge-test.py — THE HF FORGE, AS A USER SEES IT.
#
# User spec: "Hugging Face repos still can't use bash or grep or shell or
# ls." The adapter is live-proven at the API level (curl, the write test);
# THIS rig drives the actual UI the way a user would: open the workspaces
# picker → the connect page → the 🤗 Hugging Face pill → our repos listed
# (discover) → sign-in state shown (the connected hub account) → connect a
# repo by URL from the bar → it appears in the picker with the right kind.
#
# Run:  python3 scripts/v0782-hf-forge-test.py [engine-port]
# Needs: engine running + the hub token connected (POST /api/hub/auth/connect)
import json
import sys
import time
import urllib.request

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8790}"

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=25) as r:
        return json.loads(r.read().decode() or "{}")

api("GET", "/api/health")
hub = api("GET", "/api/hub/auth/status")
assert hub.get("connected"), "hub token not connected on this rig"

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 405, "height": 800})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(1000)

    PASS = FAIL = 0
    def ok(cond, label):
        global PASS, FAIL
        if cond: PASS += 1; print(f"  PASS {label}")
        else:    FAIL += 1; print(f"  FAIL {label}")

    # open the workspaces picker (the UI way: a chat panel's workspace pill
    # needs a chat; the connect overlay opens via the picker entry)
    pg.evaluate("() => window.Workspace.openPicker()")
    pg.wait_for_timeout(900)
    ok(pg.evaluate("() => !!document.querySelector('.wsx')"), "the workspaces picker opened")
    # the connect page
    pg.evaluate("() => document.getElementById('wsx-connect') && document.getElementById('wsx-connect').click()")
    pg.wait_for_timeout(900)
    pills = pg.evaluate("""() => Array.from(document.querySelectorAll('.wsp-pill')).map(p => p.getAttribute('data-k'))""")
    ok("hf" in pills, f"the 🤗 Hugging Face provider pill exists ({pills})")
    # select it
    pg.evaluate("""() => { const el = document.querySelector('.wsp-pill[data-k=\\'hf\\']'); if (el) el.click(); }""")
    pg.wait_for_timeout(4000)
    body_txt = pg.evaluate("() => (document.querySelector('.wsp-sec') || {}).innerText || ''")
    ok("logged in" in body_txt and "ScoobyBaby1999" in body_txt,
       f"the HF section shows the connected hub account ({body_txt[:80]!r})")
    repos = pg.evaluate("""() => document.querySelectorAll('#wsp-repos .wsp-repo').length""")
    ok(repos >= 10, f"our HF repos listed via discover ({repos} rows)")
    pg.screenshot(path="/tmp/rig78/v0782-hf-pill.png")
    # connect our Space by URL (the public bar)
    pg.fill("#wsp-pub-url", "https://huggingface.co/spaces/ScoobyBaby1999/doomalaysocreate")
    pg.evaluate("() => document.getElementById('wsp-pub-go') && document.getElementById('wsp-pub-go').click()")
    pg.wait_for_timeout(3500)
    page_txt = pg.evaluate("() => document.body.innerText")
    ok("doomalaysocreate" in page_txt, "the repo detail page shows the Space")
    pg.screenshot(path="/tmp/rig78/v0782-repo-detail.png")
    # finish the connect (the done button on the detail page)
    pg.evaluate("() => { const d = document.getElementById('wsx-done'); if (d) d.click(); }")
    pg.wait_for_timeout(2500)
    # reopen the picker fresh (the connect flow's back pops the overlay —
    # the picker reloads its rows on open)
    pg.evaluate("() => window.Workspace.openPicker()")
    pg.wait_for_timeout(1200)
    # the workspace row exists with kind hf
    row = pg.evaluate("""() => {
      const rows = Array.from(document.querySelectorAll('.wsx-row'));
      return rows.map(r => r.innerText).filter(t => t.indexOf('doomalaysocreate') >= 0).join(' | ');
    }""")
    ok("doomalaysocreate" in row, f"the Space appears in the picker as a workspace ({row[:90]!r})")
    # the engine API agrees
    wss = api("GET", "/api/workspaces")
    hf_ws = [w for w in wss.get("workspaces", []) if w.get("kind") == "hf"]
    ok(any("doomalaysocreate" in (w.get("name") or "") for w in hf_ws),
       f"the engine lists the HF workspace (kind rows: {[(w.get('kind'), w.get('name')) for w in hf_ws][:3]})")
    ok(not errors, f"zero page errors ({errors[:2]})")

    br.close()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
