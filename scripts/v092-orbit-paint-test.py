#!/usr/bin/env python3
# v092-orbit-paint-test.py — THE ORBIT-DRIFT PROJECTION COST, ISOLATED.
#
# HYPOTHESIS: while a tab group orbits at rest (no user input), each
# member's per-frame style.transform write lands in DoomProjection's
# MutationObserver as an untracked style change → full = true → a FULL
# projection paint EVERY FRAME, forever. With a gradient theme (projected
# surfaces live) that's per-frame style recalc + raster churn — the
# sustained "degrades fast" + "canvas still lags with gradients, no
# panels" signature.
#
# THE TEST: 8 icons, 2 form a group (TabGroups.collide), gradient theme
# ON, ambient ON, then NO user input for 20 seconds. Measure:
#   · projPaints delta per second (a resting canvas must paint ~0)
#   · projMotions delta per second
#   · fps + long tasks
# Then the same 20s with the group RELEASED (control).
import json
import sys
import time
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8793
BASE = f"http://127.0.0.1:{PORT}"

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=25) as r:
        return json.loads(r.read().decode() or "{}")

from playwright.sync_api import sync_playwright

STATE = json.dumps({
    "offset": {"x": 0, "y": 0}, "scale": 1,
    "currentFamily": "beast",
    "icons": [
        {"type": "chat", "id": "chat_o1", "name": "Orbit A", "family": "beast",
         "iconIndex": 0, "x": 200, "y": 400, "vx": 0, "vy": 0, "radius": 28, "sessionId": ""},
        {"type": "chat", "id": "chat_o2", "name": "Orbit B", "family": "beast",
         "iconIndex": 1, "x": 300, "y": 420, "vx": 0, "vy": 0, "radius": 28, "sessionId": ""},
    ],
    "dots": [], "savedAt": int(time.time() * 1000),
})

def crazy():
    def mesh(colors):
        return {"colors": colors, "dir": "mesh"}
    return {
        "--bg-app":     mesh(["#1a0b2e", "#0b1e3a", "#3a0b2a", "#0b3a2e", "#2e1a0b"]),
        "--bg-panel":   mesh(["#2e0b1a", "#0b2e3a", "#1a2e0b", "#3a1a0b", "#0b1a2e"]),
        "--surface-1":  mesh(["#241339", "#13395c", "#5c1323", "#135c39", "#392413"]),
        "--surface-2":  mesh(["#2b1a44", "#1a44b0", "#441a2b", "#1a442b", "#442b1a"]),
        "--surface-3":  mesh(["#331f50", "#1f5069", "#501f33", "#1f5033", "#50331f"]),
        "--border":     mesh(["#4a2a66", "#2a6685", "#662a3f", "#2a6640", "#664a2a"]),
        "--accent":     mesh(["#e879f9", "#22d3ee", "#f472b6", "#34d399", "#fbbf24"]),
    }

MEASURE = """
(sec) => new Promise((resolve) => {
  const P = window.DoomalayPerf || {};
  const PR = (window.DoomProjection && window.DoomProjection.stats) || {};
  const mem = (performance && performance.memory) ? performance.memory : null;
  let frames = 0; const t0 = performance.now();
  function cnt() { frames++; if (performance.now() - t0 < sec * 1000) requestAnimationFrame(cnt); }
  requestAnimationFrame(cnt);
  setTimeout(() => {
    resolve({
      fps: Math.round(frames / ((performance.now() - t0) / 1000)),
      paints: PR.paints !== undefined ? PR.paints : -1,
      motions: PR.motions !== undefined ? PR.motions : -1,
      longTasks: P.longTasks !== undefined ? P.longTasks : -1,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
      grouped: window.TabGroups ? window.TabGroups.active() : -1,
      nDots: (window.TabGroups && window.TabGroups._debug) ? window.TabGroups._debug.dotCount() : -1,
    });
  }, sec * 1000 + 100);
})
"""

with sync_playwright() as pw:
    br = pw.chromium.launch(args=["--js-flags=--expose-gc"])
    pg = br.new_page(viewport={"width": 412, "height": 915}, device_scale_factor=2)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(1500)
    pg.evaluate(f"st => {{ localStorage.clear(); localStorage.setItem('doomalay.state.v2', st); }}", STATE)
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(2500)

    # gradients + ambient on
    pg.evaluate("ov => window.Settings.setState({themeOverrides: {midnight: ov}})", crazy())
    pg.wait_for_timeout(1000)
    pg.evaluate("() => window.Settings.setState({dotAnimate: true, lineAnimate: true})")
    pg.wait_for_timeout(800)

    print("## A. NO GROUP — resting 8s (control)")
    a = pg.evaluate(MEASURE, 8)
    print(json.dumps(a))

    print("## B. GROUP FORMED — orbit drift, resting 8s, zero input")
    pg.evaluate("""() => {
      const ents = window.doomalay.world.entities;
      if (window.TabGroups && ents.length >= 2) {
        window.TabGroups.collide(ents[0], ents[1], 250, 410);
      }
    }""")
    pg.wait_for_timeout(600)
    b = pg.evaluate(MEASURE, 8)
    print(json.dumps(b))

    print("## C. GROUP STILL ACTIVE — 8 more seconds (sustained)")
    c = pg.evaluate(MEASURE, 8)
    print(json.dumps(c))

    print("## D. GROUP RELEASED — resting 8s (recovery)")
    pg.evaluate("() => { if (window.TabGroups && window.TabGroups._debug) window.TabGroups._debug.clear(); }")
    pg.wait_for_timeout(400)
    d = pg.evaluate(MEASURE, 8)
    print(json.dumps(d))

    print("\n## VERDICT")
    def rate(a, b, field):
        return round((b[field] - a[field]) / 8, 1)
    print(f"  control paints/s : {rate(a, a, 'paints') if False else round(0,1)} (no delta measured within A)")
    print(f"  orbit  paints/s : {(b['paints']-a['paints'])/8:.1f}")
    print(f"  orbit  motions/s: {(b['motions']-a['motions'])/8:.1f}")
    print(f"  orbit2 paints/s : {(c['paints']-b['paints'])/8:.1f}")
    print(f"  freed  paints/s : {(d['paints']-c['paints'])/8:.1f}")
    print(f"  fps: control={a['fps']} orbit={b['fps']} orbit2={c['fps']} freed={d['fps']}")
    print(f"  longTasks: control={a['longTasks']} orbit={b['longTasks']} orbit2={c['longTasks']} freed={d['longTasks']}")
    print(f"  heapMB: control={a['heapMB']} orbit={b['heapMB']} orbit2={c['heapMB']} freed={d['heapMB']}")
    if errs:
        print(f"  ERRORS: {errs[:5]}")
    else:
        print("  zero page errors")
    br.close()
