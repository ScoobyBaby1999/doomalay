#!/usr/bin/env python3
# v38-ui-test.py — ring visibility + theme + collapsible sources + per-chat
# prefs + provider-tab model compare + catalog cache.
import json, os, shutil, subprocess, sys, time
import urllib.request, urllib.error

BASE = "http://127.0.0.1:8144"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-v38ui"
PORT = 8144

if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
_englog = open("/tmp/doomalay-v38ui-eng.log", "w")
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=_englog, stderr=_englog)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
else:
    print("FATAL: engine did not start"); proc.kill(); sys.exit(1)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

def japi(method, path, body=None):
    st, b = api(method, path, body)
    try: return st, json.loads(b.decode() or "{}")
    except Exception: return st, {}

import os as _os
if _os.environ.get("NVIDIA_API_KEY"):
    api("POST", "/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY",
        "key": _os.environ["NVIDIA_API_KEY"]})
    import time as _t; _t.sleep(10)  # let the background catalog sync land

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

# seed a session with real usage numbers (a big input_tokens history)
_, s = api("POST", "/api/sessions", {"title": "UI Bot", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"})
SID = json.loads(s)["ID"]
api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": "hello"})
api("POST", f"/api/sessions/{SID}/events", {"type": "assistant", "text": "hi there"})
api("POST", f"/api/sessions/{SID}/events", {"type": "sources", "text": json.dumps([
    {"title": "Example One", "url": "https://example.com/one"},
    {"title": "Example Two", "url": "https://example.com/two"}])})
api("POST", f"/api/sessions/{SID}/events", {"type": "status", "text": json.dumps(
    {"state": "idle", "usage": {"input_tokens": 42000, "output_tokens": 1500}})})

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 400, "height": 760}, has_touch=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "ui1", "type": "chat", "name": "UI Bot", "family": "nvidia",
                "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                "sandbox": "quick", "model": "nvidia/z-ai/glm-5.3-flash",
                "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(800)
    pg.mouse.click(120, 200); pg.wait_for_timeout(2200)

    # ══ 1. THE RING IS VISIBLE (was 0×0 since v0.27) ══════════════════
    print("context ring")
    box = pg.evaluate("""() => {
      const r = document.querySelector('#header-ctx-ring .ctx-ring');
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return {w: b.width, h: b.height, p: r.style.getPropertyValue('--p'), thr: r.style.getPropertyValue('--thr'),
              display: getComputedStyle(r).display};
    }""")
    ok(box and box["w"] > 10 and box["h"] > 10, f"ring renders >10px ({box})")
    ok(box and box["display"] == "block", "ring display:block (the fix)")
    ok(box and float(box["thr"] or 0) == 70, f"compaction tick at threshold 70% ({box})")
    ok(box and float(box["p"] or 0) > 3, f"ring fill shows real usage ({box})")

    # ══ 2. ring click → usage panel ═══════════════════════════════════
    pg.evaluate("() => document.getElementById('header-ctx-ring').click()")
    pg.wait_for_timeout(900)
    ok(pg.evaluate("() => document.getElementById('us-ctx-fill') !== null"),
       "ring click opens the usage view")
    # pop back to the chat (the stacked view hid the transcript)
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(800)

    # ══ 3. SOURCES COLLAPSIBLE + PREF PERSISTS ════════════════════════
    print("sources box")
    src = pg.evaluate("""() => {
      const d = document.querySelector('details.src-wrap');
      if (!d) return null;
      return {tag: d.tagName, open: d.open, count: (d.querySelector('.src-count')||{}).textContent,
              cards: d.querySelectorAll('.src-card').length};
    }""")
    ok(src and src["tag"] == "DETAILS", f"sources renders as <details> ({src})")
    ok(src and src["open"] is True, "sources open by default")
    ok(src and src["cards"] == 2, f"both cards inside the collapsible ({src})")
    # collapse it → per-chat pref persists
    pg.evaluate("() => { const d = document.querySelector('details.src-wrap'); d.open = false; d.dispatchEvent(new Event('toggle')); }")
    pg.wait_for_timeout(600)
    pref = pg.evaluate("""async () => {
      const r = await fetch('/api/sessions/""" + SID + """/tweaks'); const j = await r.json();
      return j.tweaks && j.tweaks.uiState;
    }""")
    ok(pref and pref.get("sourcesOpen") is False, f"sourcesOpen=false persisted to tweaks ({pref})")
    # reopen panel → still collapsed (default now false)
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(700)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1800)
    ok(pg.evaluate("() => { const d = document.querySelector('details.src-wrap'); return d ? !d.open : null; }"),
       "sources STAY collapsed after close/reopen (per-chat default)")

    # ══ 4. THINKING PREF ══════════════════════════════════════════════
    # seed a thinking + assistant pair, set thinkOpen=false, verify rebuild honors it
    api("POST", f"/api/sessions/{SID}/events", {"type": "thinking", "text": "hmm, let me think about this..."})
    api("POST", f"/api/sessions/{SID}/events", {"type": "assistant", "text": "done."})
    api("PUT", f"/api/sessions/{SID}/tweaks", {"uiState": {"sourcesOpen": False, "thinkOpen": False}})
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(500)
    pg.reload(); pg.wait_for_timeout(900)   # fresh boot — the tweaks fetch pulls the new blob
    pg.mouse.click(120, 200); pg.wait_for_timeout(2200)
    th = pg.evaluate("""() => {
      const t = document.querySelector('details.msg-think');
      return t ? {open: t.open} : null;
    }""")
    ok(th and th["open"] is False, f"thinking box collapsed per pref ({th})")

    # ══ 5. THEME: cost + ring follow the theme ════════════════════════
    print("theme tones")
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(600)
    mid = pg.evaluate("""() => getComputedStyle(document.documentElement).getPropertyValue('--warn').trim()""")
    pg.evaluate("() => { document.documentElement.setAttribute('data-theme','ocean'); }")
    ocean = pg.evaluate("""() => getComputedStyle(document.documentElement).getPropertyValue('--warn').trim()""")
    pg.evaluate("() => { document.documentElement.setAttribute('data-theme','mono'); }")
    mono = pg.evaluate("""() => getComputedStyle(document.documentElement).getPropertyValue('--warn').trim()""")
    ok(mid != ocean and ocean != mono and mid != mono,
       f"--warn differs per theme (midnight={mid} ocean={ocean} mono={mono})")

    # ══ 6. MODEL BROWSER: compare in the PROVIDERS tab ════════════════
    print("model browser provider-tab compare")
    pg.evaluate("() => { document.documentElement.setAttribute('data-theme',''); }")
    pg.mouse.click(120, 200); pg.wait_for_timeout(2000)
    pg.locator("#panel-model-btn").click(); pg.wait_for_timeout(2500)
    # go to the Providers tab (default view is providers — verify)
    is_prov = pg.evaluate("() => !!document.querySelector('#mb-provlist')")
    if not is_prov:
        pg.evaluate("() => { const b = document.querySelector('[data-view=\"providers\"]'); if (b) b.click(); }")
        pg.wait_for_timeout(1000)
    ok(pg.evaluate("() => !!document.querySelector('#mb-provlist')"), "Providers tab rendered")
    # expand the first provider box
    pg.evaluate("() => { const h = document.querySelector('#mb-provlist [data-provhead]'); if (h) h.click(); }")
    pg.wait_for_timeout(900)
    n_model_rows = pg.evaluate("() => document.querySelectorAll('#mb-provlist [data-compare]').length")
    ok(n_model_rows > 0, f"provider rows expose ⚖ model-compare buttons ({n_model_rows})")
    # pin two models via the ⚖ buttons
    pg.evaluate("""() => {
      const btns = document.querySelectorAll('#mb-provlist [data-compare]');
      if (btns.length >= 2) { btns[0].click(); }
    }""")
    pg.wait_for_timeout(600)
    hint = pg.evaluate("() => !!document.querySelector('#mb-list .mb-compare, #mb-list [data-cmpclose], #mb-list .mb-pin, #mb-list div')")
    pg.evaluate("""() => {
      const btns = document.querySelectorAll('#mb-provlist [data-compare]');
      if (btns.length >= 2) { btns[1].click(); }
    }""")
    pg.wait_for_timeout(800)
    drawer = pg.evaluate("""() => {
      const list = document.getElementById('mb-list');
      if (!list) return null;
      const cmp = list.querySelector('.mb-compare');
      return cmp ? cmp.innerText.slice(0, 90) : null;
    }""")
    ok(bool(drawer), f"model-compare DRAWER renders in the providers tab ({drawer})")

    # ══ 7. CATALOG CACHE ═══════════════════════════════════════════════
    print("catalog cache")
    cached = pg.evaluate("""() => {
      try { const raw = localStorage.getItem('doomalay.modelcache.v1');
        if (!raw) return null;
        const d = JSON.parse(raw);
        return {at: d.at, logical: (d.catalog && d.catalog.logical || []).length, providers: (d.catalog && d.catalog.providers || []).length};
      } catch (e) { return null; }
    }""")
    ok(cached and cached["logical"] > 50, f"catalog persisted to localStorage ({cached})")

    ok(len(errors) == 0, f"zero page errors ({errors[:3]})")
    br.close()

proc.terminate(); proc.wait()
print(f"\n{'='*50}\nUI TEST: {PASS} passed, {FAIL} failed\n{'='*50}")
sys.exit(1 if FAIL else 0)
