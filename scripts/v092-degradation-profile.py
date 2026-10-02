#!/usr/bin/env python3
# v092-degradation-profile.py — THE DEGRADATION PROFILER.
#
# User spec: "the performance of the app in general is still poor…
# fresh boot of the app the performance is at its best and it is
# noticeably better but it then degrades fast… 30-50% lower frame rate
# when I have my themes set to something crazy with gradients all over,
# especially whilst in a panel… busy panels (settings colors and general
# tabs) are noticeably slower than the sizing and performance tabs."
#
# WHAT THIS RIG MEASURES (the honest baseline before the wave):
#   · a REAL browser (playwright chromium), fresh boot;
#   · Phase 1: default theme idle — the fresh-boot baseline;
#   · Phase 2: THE CRAZY THEME — mesh-gradient overrides on the seven
#     surface vars (bg-app, bg-panel, surface-1..3, border, accent) —
#     the user's "gradients all over" look;
#   · Phase 3: ambient on (dot+line animate) + panel cycling
#     (settings ⇄ colors tab ⇄ general tab ⇄ close) + canvas pokes —
#     the sustained-use loop;
#   · samples every SAMPLE_S seconds: JS heap (used/total), DOM nodes,
#     stylesheet count, iframe count (the tab deck), icon count,
#     DoomalayPerf (fps/longTasks/nodes/layers), DoomProjection stats
#     (paints/motions/rebakes).
#
# THE VERDICT: which metric grows monotonically across the soak —
# the leak/degradation signature, measured not felt.
#
# Run: python3 scripts/v092-degradation-profile.py [engine-port] [minutes]
import json
import sys
import time
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
BASE = f"http://127.0.0.1:{PORT}"
SAMPLE_S = 20

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=25) as r:
        return json.loads(r.read().decode() or "{}")

api("GET", "/api/health")

from playwright.sync_api import sync_playwright

# The sample: one structured read of the page's live state.
SAMPLE_JS = """
() => {
  const P = window.DoomalayPerf || {};
  const PR = (window.DoomProjection && window.DoomProjection.stats) || {};
  const mem = (performance && performance.memory) ? performance.memory : null;
  // fps: a 1200ms rAF window (fresh each sample — no standing meter)
  return new Promise((resolve) => {
    let frames = 0; const t0 = performance.now();
    function cnt() { frames++; if (performance.now() - t0 < 1200) requestAnimationFrame(cnt); }
    requestAnimationFrame(cnt);
    setTimeout(() => {
      const fps = Math.round(frames / ((performance.now() - t0) / 1000));
      resolve({
        fps: fps,
        heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
        heapTotalMB: mem ? Math.round(mem.totalJSHeapSize / 1048576) : -1,
        nodes: document.querySelectorAll('*').length,
        sheets: document.styleSheets.length,
        iframes: document.querySelectorAll('iframe').length,
        icons: document.querySelectorAll('.chatbot').length,
        longTasks: P.longTasks !== undefined ? P.longTasks : -1,
        longWorst: P.longTaskWorst !== undefined ? Math.round(P.longTaskWorst) : -1,
        perfNodes: P.nodes !== undefined ? P.nodes : -1,
        perfLayers: P.layers !== undefined ? P.layers : -1,
        projPaints: PR.paints !== undefined ? PR.paints : -1,
        projMotions: PR.motions !== undefined ? PR.motions : -1,
        projRebakes: PR.rebakes !== undefined ? PR.rebakes : -1,
      });
    }, 1300);
  });
}
"""

# THE CRAZY THEME: mesh gradients on every surface family (the user's
# "gradients all over" — 5-color mesh per var = the heaviest recipe).
def crazy_overrides():
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

def set_state(pg, patch):
    pg.evaluate(
        "patch => window.Settings.setState(patch)", patch)

def open_settings(pg, page):
    pg.evaluate("() => { const b = document.getElementById('settings-btn'); if (b) b.click(); }")
    pg.wait_for_timeout(900)
    pg.evaluate(
        "p => { const t = document.querySelector('.settings-nav .tab[data-page=\"' + p + '\"]'); if (t) t.click(); }",
        page)
    pg.wait_for_timeout(700)

def close_panel(pg):
    pg.evaluate("() => { if (window.Panel && window.Panel.close) window.Panel.close(); }")
    pg.wait_for_timeout(600)

def poke_canvas(pg):
    # a small pan: pointer down on the canvas, move, up (drives physics
    # + projection motions — the real user's touch)
    cv = pg.locator("#c").first
    try:
        box = cv.bounding_box()
        if box:
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            pg.mouse.move(cx, cy)
            pg.mouse.down()
            for i in range(6):
                pg.mouse.move(cx + i * 12, cy + i * 6)
                pg.wait_for_timeout(16)
            pg.mouse.up()
    except Exception:
        pass

results = []
errors = []

def main():
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=[
            "--js-flags=--expose-gc",
        ])
        pg = br.new_page(viewport={"width": 412, "height": 915}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.goto(BASE, wait_until="networkidle")
        pg.wait_for_timeout(1500)
        pg.evaluate("() => localStorage.clear()")
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2000)

        def sample(tag):
            s = pg.evaluate(SAMPLE_JS)
            s["tag"] = tag
            s["t"] = round(time.time())
            results.append(s)
            print(json.dumps(s), flush=True)

        # ── Phase 1: fresh boot, default theme, idle ──────────────
        print("## PHASE 1: fresh boot baseline (60s idle)", flush=True)
        sample("fresh-0s")
        pg.wait_for_timeout(SAMPLE_S * 1000); sample("fresh-20s")
        pg.wait_for_timeout(SAMPLE_S * 1000); sample("fresh-40s")
        pg.wait_for_timeout(SAMPLE_S * 1000); sample("fresh-60s")

        # ── Phase 2: THE CRAZY THEME ──────────────────────────────
        print("## PHASE 2: crazy mesh gradients on 7 surface vars", flush=True)
        set_state(pg, {"themeOverrides": {"midnight": crazy_overrides()}})
        pg.wait_for_timeout(1500)
        sample("grads-just-applied")
        pg.wait_for_timeout(SAMPLE_S * 1000); sample("grads-idle-20s")
        pg.wait_for_timeout(SAMPLE_S * 1000); sample("grads-idle-40s")

        # ── Phase 3: ambient + panel cycling + canvas pokes ───────
        print("## PHASE 3: ambient ON + panel cycling (the sustained-use loop)", flush=True)
        set_state(pg, {"dotAnimate": True, "lineAnimate": True})
        pg.wait_for_timeout(800)

        deadline = time.time() + MINUTES * 60
        cycle = 0
        while time.time() < deadline:
            cycle += 1
            # open settings on COLORS (the busy tab)
            open_settings(pg, "appearance")
            pg.wait_for_timeout(2500)
            # expand the customize section (the gradient editors)
            pg.evaluate("""() => {
              const h3s = Array.from(document.querySelectorAll('.settings-section h3'));
              const c = h3s.find(h => /customize/i.test(h.textContent));
              if (c) c.click();
            }""")
            pg.wait_for_timeout(2500)
            # switch to GENERAL (the other busy tab)
            pg.evaluate("""() => {
              const t = document.querySelector('.settings-nav .tab[data-page="general"]');
              if (t) t.click();
            }""")
            pg.wait_for_timeout(2500)
            # sizing (the smooth tab — control group)
            pg.evaluate("""() => {
              const t = document.querySelector('.settings-nav .tab[data-page="sizing"]');
              if (t) t.click();
            }""")
            pg.wait_for_timeout(1500)
            close_panel(pg)
            poke_canvas(pg)
            sample(f"cycle-{cycle}")
        sample("final")

        # ── gc + final read: does the heap come back after a GC? ──
        pg.evaluate("() => new Promise(r => { if (window.gc) { window.gc(); window.gc(); } setTimeout(r, 400); })")
        sample("post-gc")

        br.close()

    # ── THE VERDICT ────────────────────────────────────────────
    print("\n## SUMMARY")
    first = results[0]
    last_grad = [r for r in results if r["tag"].startswith("cycle-")]
    last = last_grad[-1] if last_grad else results[-1]
    for k in ["fps", "heapMB", "nodes", "sheets", "iframes", "icons",
              "longTasks", "projPaints"]:
        print(f"  {k:12s}: fresh={first[k]!s:>6s}  last={last[k]!s:>6s}  "
              f"delta={last[k] - first[k]:+}")
    print(f"  post-gc heapMB: {results[-1]['heapMB']} "
          f"(fresh was {first['heapMB']})")
    print(f"  page errors: {len([e for e in errors if 'favicon' not in e.lower()])}")
    with open("/tmp/v092-degradation-samples.json", "w") as f:
        json.dump({"samples": results, "errors": errors[:50]}, f, indent=2)
    print("  samples → /tmp/v092-degradation-samples.json")

if __name__ == "__main__":
    main()
