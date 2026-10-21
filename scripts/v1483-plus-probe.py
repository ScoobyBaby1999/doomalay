#!/usr/bin/env python3
# v1.48.3 THE DIRECT PLUS — the live red-team probe (pre-ship gate for the
# phase). The user's ask: "in the chat metadata when the workspace overlay
# screen is open, we have a + arrow right of each row, currently, when
# pressed, it expands the row to show the Include in this chat, open in
# drawer, ext pills. Even tho clicking the row itself also does this.
# Pressing the + should add it to the chat directly. Instead of user
# presses + then also has to press include in this chat."
#
# THE METHOD: a real engine + a real browser page; one chat with a bound
# session; a REAL workspace connected globally (NOT bound to the chat —
# the row renders the ＋ badge); the REAL picker opened via the exposed
# openPicker (the same API the chat-header pill calls); then a REAL DOM
# click on the ＋ badge. Assert: the workspace IS bound to the chat after
# ONE press, the row re-rendered to '✓ in chat', and the row's action
# panel STAYS CLOSED (the badge never expands — that's the row body's
# behavior, and the expanded "add to this chat" pill is no longer needed).
# The pre-fix flip (stashed build): the badge click just EXPANDS the row
# (acts visible) and the workspace is NOT bound — two presses to add.
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8097"))
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


def api(path, method="GET", body=None, timeout=120):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"__status": e.code, "__body": e.read().decode()[:200]}


def main():
    print("v1.48.3 THE DIRECT PLUS — live probe (real picker, real badge click, one press)")
    data_dir = tempfile.mkdtemp(prefix="v1483-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v1483-log-", delete=False)
    bin_path = "/tmp/doomalay-v1483-probe"
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
        page.wait_for_timeout(800)

        # one chat the real way, session bound
        page.evaluate("document.getElementById('dock-new-chat').click()")
        page.wait_for_timeout(600)
        sid = api("/api/sessions", "POST", {"provider": "openrouter", "model": "x/y", "title": "plus"})["ID"]
        page.evaluate(
            """(sid) => {
                const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[0];
                c.sessionId = sid; c.save(); return true;
            }""", sid)

        # a REAL workspace, connected GLOBALLY (no session_id — the row will
        # render the ＋ badge: not in this chat)
        ws = api("/api/workspaces/connect", "POST",
                 {"url": "https://github.com/octocat/Hello-World", "token": GH_TOKEN})
        if "__status" in ws:
            print("FATAL: workspace connect failed:", ws)
            sys.exit(1)
        wsid = ws.get("id") or ws.get("ID")
        check("real workspace connected (global, unbound)", True, f"id {wsid[:10]}…")

        # the REAL picker — the same API the chat-header pill calls
        page.evaluate("(sid) => window.Workspace.openPicker(sid, null)", sid)
        page.wait_for_function(
            "(wsid) => !!document.querySelector('[data-wsid=\"' + wsid + '\"]')",
            arg=wsid, timeout=15000)
        # flip-aware badge locator: the fixed badge carries data-plus; the
        # pre-fix badge is the same span without it (the class is stable)
        page.wait_for_function(
            """(wsid) => {
                const row = document.querySelector('[data-wsid="' + wsid + '"]');
                return !!row && !!row.querySelector('.wsx-badge.read');
            }""", arg=wsid, timeout=15000)
        row_state = page.evaluate(
            """(wsid) => {
                const row = document.querySelector('[data-wsid="' + wsid + '"]');
                const acts = document.getElementById('wsx-acts-' + wsid);
                return {
                    hasPlus: !!row.querySelector('[data-plus]'),
                    dim: row.className.indexOf('dim') >= 0,
                    actsDisplay: acts ? acts.style.display : 'missing'
                };
            }""", wsid)
        check("the row renders the ＋ badge (dim, not in chat)", row_state["dim"],
              json.dumps(row_state))
        check("the action panel starts CLOSED", row_state["actsDisplay"] == "none",
              f"display={row_state['actsDisplay']}")

        # ONE press on the ＋ badge — the real DOM click (either spelling)
        page.evaluate(
            """(wsid) => {
                const row = document.querySelector('[data-wsid="' + wsid + '"]');
                const badge = row.querySelector('[data-plus]') || row.querySelector('.wsx-badge.read');
                badge.click(); return true;
            }""", wsid)
        page.wait_for_timeout(900)  # the bind POST + the re-render

        bound = api(f"/api/sessions/{sid}/workspaces")
        ids = [w.get("id") or w.get("ID") for w in (bound if isinstance(bound, list) else bound.get("workspaces", []))]
        check("ONE PRESS binds: the workspace is now in the chat's workspaces",
              wsid in ids, f"bound ids {[str(i)[:10] for i in ids]}")

        after = page.evaluate(
            """(wsid) => {
                const row = document.querySelector('[data-wsid="' + wsid + '"]');
                const acts = document.getElementById('wsx-acts-' + wsid);
                return {
                    badge: row.querySelector('.wsx-badge') ? row.querySelector('.wsx-badge').textContent : '',
                    inChatBadge: !!row.querySelector('.wsx-badge.inchat'),
                    actsDisplay: acts ? acts.style.display : 'missing'
                };
            }""", wsid)
        check("the row re-rendered to '✓ in chat'", after["inChatBadge"] or "in chat" in after["badge"],
              json.dumps(after))
        check("the row did NOT expand (the badge is not the row body)",
              after["actsDisplay"] == "none", f"acts display={after['actsDisplay']}")

        # the feedback loop: the chat's workspace count (server truth)
        check("the feedback loop: the chat's workspace count is 1", len(ids) == 1, f"count={len(ids)}")
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
