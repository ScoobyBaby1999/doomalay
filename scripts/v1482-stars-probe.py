#!/usr/bin/env python3
# v1.48.2 THE LIVE STARS — the live red-team probe (pre-ship gate for the
# phase). The user's report: "When a chat gets a newly added workspace
# (especially if it's not the first created chat) the chat icon needs to be
# moved or refreshed for the orbiting stars to reflect, connecting a
# workspace doesn't send a signal to refresh the icon for the orbitting
# stars to show visually."
#
# THE METHOD: a real engine + a real browser page; TWO chats created the
# real way (the dock's ＋), a session bound to each icon at REST, a REAL
# workspace connected to the SECOND chat (a real GitHub probe + bind),
# then the REAL UI signal fired (the exact 'doomalay:workspaces-changed'
# event workspace.js's bind .then dispatches). The assertion reads the
# WORKER'S OWN honest instrument (window.DoomalayDebug.atoms.stars — the
# star-paint counter of the frame that ran) plus Atoms.countFor — and
# proves the icon NEVER MOVED (x/y byte-identical). The pre-fix flip
# (stash app.js, rebuild): stars stay 0 until the icon is nudged — then
# they appear — the user's exact workaround, convicted live.
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8098"))
BASE = f"http://127.0.0.1:{PORT}"
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
if not GH_TOKEN and os.path.exists("/home/z/keys.env"):
    for ln in open("/home/z/keys.env"):
        if ln.startswith("GITHUB_TOKEN="):
            GH_TOKEN = ln.split("=", 1)[1].strip()
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + ok, FAIL + (not ok)


def api(path, method="GET", body=None, timeout=90):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    print("v1.48.2 THE LIVE STARS — live probe (real UI, real workspace, worker's own counter)")
    data_dir = tempfile.mkdtemp(prefix="v1482-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v1482-log-", delete=False)
    bin_path = "/tmp/doomalay-v1482-probe"
    r = subprocess.run(
        ["/home/z/sdk/go/bin/go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"),
        env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True,
    )
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)
    eng = subprocess.Popen(
        [bin_path, "--port", str(PORT), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1"},
        stdout=log, stderr=log,
    )
    pw = None
    try:
        for _ in range(60):
            try:
                api("/api/health", timeout=5)
                break
            except Exception:
                time.sleep(0.5)
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page(viewport={"width": 1280, "height": 800})
        page.goto(BASE + "/")
        page.wait_for_function("window.__doomalayReady === true", timeout=30000)
        page.wait_for_timeout(1200)

        # TWO chats the real way — the dock's ＋, twice
        page.evaluate("document.getElementById('dock-new-chat').click()")
        page.wait_for_timeout(400)
        page.evaluate("document.getElementById('dock-new-chat').click()")
        # physics settle — icons truly AT REST (the pre-fix flip needs zero
        # drift: any x/y change would refresh the clones by itself). The
        # dock's ＋ may drop the icon into a tab-group's steering orbit
        # (grouped members skip friction — perpetual motion); detach the
        # SECOND chat's icon and zero its velocity so it truly sleeps.
        page.evaluate(
            """(() => {
                const ch = window.doomalay.world.entities.filter(e => e.type === 'chat');
                // BOTH chats frozen — on-screen corners, alone, asleep. The
                // pre-fix flip needs the WHOLE canvas at rest: any icon's
                // motion changes entitiesSig and re-sends clones for
                // everyone (chat 1 bouncing at the dock cluster masked the
                // bug in the first flip attempt).
                ch[0].x = 600; ch[0].y = 150; ch[0]._orbit = null; ch[0].vx = 0; ch[0].vy = 0;
                ch[1].x = 170; ch[1].y = 150; ch[1]._orbit = null; ch[1].vx = 0; ch[1].vy = 0;
                const fix = (c) => { const r = c.el.getBoundingClientRect(); if (r.left < 60 || r.top < 60) { c.x += (90 - r.left); c.y += (90 - r.top); } };
                fix(ch[0]); fix(ch[1]);
                return true;
            })()""")
        page.wait_for_function(
            """(() => {
                const ch = window.doomalay.world.entities.filter(e => e.type === 'chat');
                return ch.length >= 2 &&
                    ch.every(c => c._asleep === true && c.vx === 0 && c.vy === 0);
            })()""", timeout=20000)
        page.wait_for_timeout(600)
        n = page.evaluate("window.doomalay.world.entities.filter(e => e.type === 'chat').length")
        check("two chats created via the dock's ＋ (at rest)", n >= 2, f"got {n}")
        vis = page.evaluate(
            """(() => {
                const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[1];
                const r = c.el.getBoundingClientRect();
                return [r.left, r.top, r.width, r.height];
            })()""")
        check("the second chat's icon is ON-SCREEN (visible to the painter)",
              vis[0] > 20 and vis[1] > 20 and vis[0] < 1200 and vis[1] < 700,
              f"rect {vis}")

        s1 = api("/api/sessions", "POST", {"provider": "openrouter", "model": "x/y", "title": "one"})["ID"]
        s2 = api("/api/sessions", "POST", {"provider": "openrouter", "model": "x/y", "title": "two"})["ID"]
        page.evaluate(
            """([s1, s2]) => {
                const ch = window.doomalay.world.entities.filter(e => e.type === 'chat');
                ch[0].sessionId = s1; ch[0].save();
                ch[1].sessionId = s2; ch[1].save();
                return ch.length;
            }""", [s1, s2])
        # the binding's save() wakes the icons — re-settle, then prove the
        # canvas is TRULY frozen: asleep + position-stable across 600ms
        page.wait_for_function(
            """(() => {
                const ch = window.doomalay.world.entities.filter(e => e.type === 'chat');
                return ch.length >= 2 && ch.every(c => c._asleep === true && c.vx === 0 && c.vy === 0);
            })()""", timeout=20000)
        p1 = page.evaluate("(() => window.doomalay.world.entities.filter(e => e.type === 'chat').map(c => [c.x, c.y]))()")
        page.wait_for_timeout(600)
        p2 = page.evaluate("(() => window.doomalay.world.entities.filter(e => e.type === 'chat').map(c => [c.x, c.y]))()")
        frozen = all(abs(a[0] - b[0]) < 0.01 and abs(a[1] - b[1]) < 0.01 for a, b in zip(p1, p2))
        check("the canvas is TRULY frozen (positions byte-stable)", frozen,
              f"t0 {p1} t+600ms {p2}")

        # baseline: no workspaces anywhere — zero stars, count 0. Repaint
        # first so an atoms frame lands and DoomalayDebug.atoms exists.
        page.evaluate("window.doomalay.repaint()")
        page.wait_for_timeout(500)
        base = page.evaluate(
            """() => ({
                stars: (window.DoomalayDebug && window.DoomalayDebug.atoms) ? window.DoomalayDebug.atoms.stars : -1,
                count: window.Atoms.countFor(window.doomalay.world.entities.filter(e => e.type === 'chat')[1]),
                entsMsgs: window.DoomalayDebug ? (window.DoomalayDebug.entsMsgs || 0) : -1,
                pos: (() => { const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[1]; return [c.x, c.y]; })()
            })""")
        check("baseline: the second chat paints 0 stars (or the atoms pass is off — "
              "no icon has a count yet)", base["stars"] <= 0, f"stars={base['stars']}")
        check("baseline: the workspace count is 0", base["count"] == 0, f"count={base['count']}")

        # a REAL workspace, connected + bound to the SECOND chat (real GitHub
        # probe; the user's token rides it — the sandbox IP is rate-limited
        # anonymous, and this is exactly the real-user credential path)
        api("/api/workspaces/connect", "POST",
            {"url": "https://github.com/octocat/Hello-World",
             "session_id": s2, "token": GH_TOKEN}, timeout=120)
        check("real workspace connected + bound to chat two (server side)", True)

        # THE REAL UI SIGNAL — the exact event the bind .then fires
        pre_pos = page.evaluate(
            "(() => { const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[1]; return [c.x, c.y]; })()")
        base_ents = page.evaluate("window.DoomalayDebug ? (window.DoomalayDebug.entsMsgs || 0) : 0")
        page.evaluate(
            "(s2) => window.dispatchEvent(new CustomEvent('doomalay:workspaces-changed', { detail: { sessionId: s2 } }))",
            s2)

        # poll the worker's own honest counters (refresh GET → count change
        # → atoms-changed → the FORCED frame → stars painted)
        stars = 0
        count = 0
        ents_msgs = 0
        for _ in range(24):
            time.sleep(0.25)
            st = page.evaluate(
                """() => ({
                    stars: (window.DoomalayDebug && window.DoomalayDebug.atoms) ? window.DoomalayDebug.atoms.stars : -1,
                    count: window.Atoms.countFor(window.doomalay.world.entities.filter(e => e.type === 'chat')[1]),
                    entsMsgs: window.DoomalayDebug ? (window.DoomalayDebug.entsMsgs || 0) : -1
                })""")
            stars, count, ents_msgs = st["stars"], st["count"], st["entsMsgs"]
            if stars > 0 and count == 1:
                break
        check("THE STARS GO LIVE without moving the icon", stars > 0,
              f"stars={stars} count={count}")
        check("the count refreshed (Atoms.countFor = 1)", count == 1, f"count={count}")
        check("the forced frame carried fresh clones (entsMsgs grew)", ents_msgs > base_ents,
              f"{base_ents} → {ents_msgs}")

        pos = page.evaluate(
            "(() => { const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[1]; return [c.x, c.y]; })()")
        moved = abs(pos[0] - pre_pos[0]) > 0.5 or abs(pos[1] - pre_pos[1]) > 0.5
        check("the icon was never moved (x/y unchanged across the signal)", not moved,
              f"pre {pre_pos} post {pos}")

        if stars == 0:
            # the pre-fix flip's diagnosis: the WORKAROUND the user described —
            # moving the icon makes the stars appear (stale clones replaced)
            page.evaluate("(() => { const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[1]; c.x += 40; })()")
            time.sleep(1.5)
            st = page.evaluate(
                "(s2) => ({ stars: (window.DoomalayDebug && window.DoomalayDebug.atoms) ? window.DoomalayDebug.atoms.stars : -1 })", s2)
            if st["stars"] > 0:
                print("    FLIP DIAGNOSIS: stars appeared only AFTER the icon was moved — "
                      "the pre-fix behavior the user reported (stale worker clones)")
    finally:
        try:
            pw.stop()
        except Exception:
            pass
        eng.terminate()
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
