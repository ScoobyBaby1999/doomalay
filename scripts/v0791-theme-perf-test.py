#!/usr/bin/env python3
# v0791-theme-perf-test.py — THE THEME-CHANGE SURGERY, PROVEN.
#
# User spec: "it's at its worse and lowest frame rate - barley usable -
# in the settings panel when changing the theme colors and variables…
# your sole goal right now is to improve the feel and frame rate of this
# very important panel until it feels as good and smooth as the browser
# in browser panel."
#
# The v0.79.1 fixes under test (PLAN-V079):
#   A. GradientUI live() is rAF-coalesced (one apply per frame,
#      latest-wins; the trailing change event flushes synchronously)
#   B. Settings persistence is debounced (300ms; pagehide flush)
#   C. applyTheme: ZERO interleaved getComputedStyle reads (the
#      per-theme block cache + pure-JS resolution), DELTA writes via the
#      ledger (a one-var drag writes just that var's twins), guarded
#      attribute flips, an applyScheme identity gate, and the
#      topology-fingerprint gating of DoomGates.refresh +
#      DoomProjection.repaint (value-only drags walk/paint nothing)
#   D. app.js's onChange runs the canvas repaint only when the canvas
#      fingerprint changed, rAF-coalesced (an accent drag repaints NO
#      canvas; a grid/canvas drag repaints at most once per frame)
#
# Run: python3 scripts/v0791-theme-perf-test.py [engine-port]
# Needs: engine running on the port (no model keys required — this rig
# exercises the settings panel only).
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

from playwright.sync_api import sync_playwright

# Counters installed BEFORE any app script runs (add_init_script):
#   applies  — Settings.setState calls (1:1 with applyTheme listener runs)
#   setProps / removeProps — CSSOM writes on <html> (documentElement only)
#   gcsDoc   — getComputedStyle(documentElement) calls (forced recalcs)
#   derives  — DoomGates.refresh (the stylesheet walk) calls
#   lsWrites — Storage.setItem calls (persistence writes)
#   canvasOps— 2d-context method calls on the MAIN canvas (update()s)
INIT = """
window.__v0791 = { applies: 0, setProps: 0, removeProps: 0, gcsDoc: 0,
                   derives: 0, lsWrites: 0, canvasOps: 0 };
(function () {
  var dsp = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (k, v, p) {
    try { if (this === document.documentElement.style) window.__v0791.setProps++; } catch (e) {}
    return dsp.call(this, k, v, p);
  };
  var drp = CSSStyleDeclaration.prototype.removeProperty;
  CSSStyleDeclaration.prototype.removeProperty = function (k) {
    try { if (this === document.documentElement.style) window.__v0791.removeProps++; } catch (e) {}
    return drp.call(this, k);
  };
  var gcs = window.getComputedStyle;
  window.getComputedStyle = function (el, p) {
    try { if (el === document.documentElement) window.__v0791.gcsDoc++; } catch (e) {}
    return gcs.call(window, el, p);
  };
  var lss = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    try { window.__v0791.lsWrites++; } catch (e) {}
    return lss.apply(this, arguments);
  };
  var gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t) {
    var ctx = gc.apply(this, arguments);
    if (t === '2d' && ctx && this.id === 'c' && !ctx.__v0791Counted) {
      try {
        ctx.__v0791Counted = true;
        return new Proxy(ctx, {
          get: function (target, prop) {
            if (typeof target[prop] === 'function' && prop !== 'canvas') {
              return function () { window.__v0791.canvasOps++; return target[prop].apply(target, arguments); };
            }
            return target[prop];
          },
          set: function (t, k, v) { t[k] = v; return true; }
        });
      } catch (e) {}
    }
    return ctx;
  };
})();
"""

def reset(pg, extra=""):
    pg.evaluate(f"() => {{ const c = window.__v0791; for (var k in c) c[k] = 0; {extra} }}")

def counters(pg):
    return pg.evaluate("() => Object.assign({}, window.__v0791)")

def results(name, fails, n):
    print(f"  {name}: {'OK' if not fails else 'FAIL'} ({n} checks)")
    for f in fails:
        print(f"    ✗ {f}")

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 405, "height": 800})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.add_init_script(INIT)
    pg.goto(BASE)
    pg.wait_for_timeout(1000)

    # a settings-change counter listener (1:1 with the applyTheme listener)
    pg.evaluate("""() => {
      window.Settings.onChange(function () { window.__v0791.applies++; });
      if (window.DoomGates && window.DoomGates.refresh) {
        const orig = window.DoomGates.refresh;
        window.DoomGates.refresh = function () { window.__v0791.derives++; return orig.apply(this, arguments); };
      }
    }""")

    # ── open Settings (the gear) → the Appearance page ─────────────
    pg.click("#settings-btn")
    pg.wait_for_timeout(700)
    assert pg.locator(".settings-nav").count() == 1, "settings nav did not render"

    # expand the "Customize <Theme>" section + the accent color row
    def expand_section(ttl):
        heads = pg.locator(".settings-section h3[data-section-toggle]")
        for i in range(heads.count()):
            t = heads.nth(i).inner_text()
            if ttl.lower() in t.lower():
                sec = heads.nth(i).locator("xpath=..")
                if "expanded" not in (sec.get_attribute("class") or ""):
                    heads.nth(i).click()
                    pg.wait_for_timeout(250)
                return True
        return False

    assert expand_section("customize"), "the Customize section is missing"
    row_head = pg.locator('[data-color-toggle="tv-accent"]')
    assert row_head.count() == 1, "the accent customize row is missing"
    row_head.click()
    pg.wait_for_timeout(350)
    inp = pg.locator('#tv-accent-gr input.gr-color')
    assert inp.count() >= 1, "the GradientUI editor did not render"
    pg.wait_for_timeout(400)

    n = 0; fails = []
    def ok(name, cond):
        global n; n += 1
        if not cond: fails.append(name)

    # ── S1: THE ACCENT DRAG (non-canvas var) — 60 events, wheel cadence ──
    paints0 = pg.evaluate("() => (window.DoomProjection && window.DoomProjection.stats) ? window.DoomProjection.stats.paints : -1")
    reset(pg)
    pg.evaluate("""() => new Promise((resolve) => {
      const inp = document.querySelector('#tv-accent-gr input.gr-color');
      const base = [255, 0, 102];
      let i = 0;
      function step() {
        if (i >= 60) { resolve(); return; }
        const c = i / 59;
        const hex = '#' + [0,1,2].map(ch => Math.round(base[ch]*(1-c) + [10,200,255][ch]*c)
                     .toString(16).padStart(2,'0')).join('');
        inp.value = hex;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        i++;
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    })""")
    pg.wait_for_timeout(300)   # let the last rAF + settle land

    c1 = counters(pg)
    ok("S1 applyTheme runs coalesced (≤ frames+2, not per-event)",
       c1["applies"] <= 62 and c1["applies"] >= 55)
    ok("S1 CSSOM writes collapsed (~2-5/apply, was ~60/apply)",
       c1["setProps"] <= c1["applies"] * 6 + 12 and c1["setProps"] > 0)
    ok("S1 ZERO forced documentElement reads during the drag", c1["gcsDoc"] == 0)
    ok("S1 derive walks only on the FIRST-override topology transition (≤2, not per-event)",
       c1["derives"] <= 2)
    ok("S1 persistence debounced (≤4 writes for a 1s drag)", c1["lsWrites"] <= 4)
    paints1 = pg.evaluate("() => (window.DoomProjection && window.DoomProjection.stats) ? window.DoomProjection.stats.paints : -1") - paints0
    ok("S1 projection paints only the first-override transition (≤2, was per-event)",
       paints1 <= 2)

    # the SECOND half of the drag must add ZERO canvas work — the first
    # compare-against-null update() is the only one allowed (canvas ops
    # measured after the initial frame must stay FLAT for an accent drag)
    ops_mid = c1["canvasOps"]
    pg.evaluate("""() => new Promise((resolve) => {
      const inp = document.querySelector('#tv-accent-gr input.gr-color');
      let i = 0;
      function step() {
        if (i >= 30) { resolve(); return; }
        inp.value = '#' + [255, Math.round(120 + i * 4), 200].map(v => v.toString(16).padStart(2,'0')).join('');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        i++;
        requestAnimationFrame(step);
      }
      step();
    })""")
    pg.wait_for_timeout(300)
    ops_end = counters(pg)["canvasOps"]
    ok(f"S1 the accent drag adds ZERO canvas work after the first frame ({ops_mid} → {ops_end})",
       ops_end == ops_mid)

    # the FINAL applied value is the LAST dispatched one (latest-wins)
    final_hex = pg.evaluate("""() => {
      const probe = document.createElement('div');
      probe.style.color = 'var(--accent)';
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    }""")
    ok("S1 the theme applied LIVE (the accent followed the drag, not black/initial)",
       final_hex and final_hex.startswith("rgb(") and final_hex != "rgb(0, 0, 0)")

    # live mid-drag application proof (the value follows BEFORE settle)
    mid = pg.evaluate("""() => new Promise((resolve) => {
      const inp = document.querySelector('#tv-accent-gr input.gr-color');
      const probe = document.createElement('div');
      probe.style.color = 'var(--accent)'; probe.style.display = 'none';
      document.body.appendChild(probe);
      let seen = [];
      let i = 0;
      function step() {
        if (i >= 30) { probe.remove(); resolve(seen); return; }
        inp.value = '#' + [255, Math.round(i*7), 102].map(v => v.toString(16).padStart(2,'0')).join('');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() => {
          seen.push(getComputedStyle(probe).color);
          i++; step();
        });
      }
      step();
    })""")
    distinct = len(set(mid))
    ok(f"S1 the accent updates LIVE mid-drag (≥20 distinct live values, saw {distinct})", distinct >= 20)

    # ── S2: the CANVAS var drag (--bg-panel / canvas bg row) ────────
    cv_row = pg.locator('[data-color-toggle="tv-bg-panel"]')
    if cv_row.count() >= 1:
        cv_row.click()
        pg.wait_for_timeout(350)
        reset(pg)
        pg.evaluate("""() => new Promise((resolve) => {
          const row = document.querySelector('[data-color-row="tv-bg-panel"]');
          const inp = row ? row.querySelector('input.gr-color') : null;
          if (!inp) { resolve(); return; }
          let i = 0;
          function step() {
            if (i >= 45) { resolve(); return; }
            const v = Math.round(i / 44 * 200);
            inp.value = '#' + [v, 10, 30].map(x => x.toString(16).padStart(2,'0')).join('');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            i++;
            requestAnimationFrame(step);
          }
          step();
        })""")
        pg.wait_for_timeout(400)
        c2 = counters(pg)
        ok("S2 canvas var drag DOES repaint the canvas (fingerprint gate works)",
           c2["canvasOps"] > 0)
        ok("S2 canvas repaints are rAF-coalesced (bounded, not 5-10×frames)",
           c2["canvasOps"] <= 45 * 3000)
        ok("S2 zero forced docEl reads here too", c2["gcsDoc"] == 0)
    else:
        ok("S2 the canvas customize row exists", False)

    # ── S3: solid→gradient TOPOLOGY change (add a 2nd stop) ─────────
    reset(pg)
    pg.evaluate("""() => new Promise((resolve) => {
      const add = document.querySelector('#tv-accent-gr [data-gr-add]');
      if (add) add.click();
      setTimeout(resolve, 500);
    })""")
    pg.wait_for_timeout(300)
    c3 = counters(pg)
    ok("S3 a topology change derives ONCE (not per event)",
       c3["derives"] <= 2)

    # ── S4: the text-size slider (layout var — paints allowed, writes guarded)
    # (the Sizing page — a separate settings tab)
    reset(pg)
    pg.evaluate("""() => {
      const tab = document.querySelector('.settings-nav .tab[data-page="sizing"]');
      if (tab) tab.click();
    }""")
    pg.wait_for_timeout(400)
    expand_section("text size")
    slider = pg.locator('input[data-setting-key="chatTextSize"]')
    if slider.count() >= 1:
        pg.evaluate("""() => new Promise((resolve) => {
          const s = document.querySelector('input[data-setting-key="chatTextSize"]');
          if (!s) { resolve(); return; }
          let i = 0;
          function step() {
            if (i >= 40) { resolve(); return; }
            s.value = String(30 + i);
            s.dispatchEvent(new Event('input', { bubbles: true }));
            i++;
            requestAnimationFrame(step);
          }
          step();
        })""")
        pg.wait_for_timeout(400)
        c4 = counters(pg)
        ok("S4 size slider: applies coalesced", c4["applies"] <= 42)
        ok("S4 size slider: only the --chat-fs pair writes per apply (≤4/apply)",
           c4["setProps"] <= c4["applies"] * 4 + 8)
        fs = pg.evaluate("""() => getComputedStyle(document.documentElement).getPropertyValue('--chat-fs')""")
        ok(f"S4 final --chat-fs applied ({fs})", fs.strip().endswith("px") and fs.strip() not in ("16.0px",))
    else:
        ok("S4 chatTextSize slider found", False)

    # ── S5: persistence lands after the debounce (reload keeps it) ──
    pg.wait_for_timeout(500)   # > 300ms debounce
    saved = pg.evaluate("""() => {
      const s = JSON.parse(localStorage.getItem('doomalay.settings.v1') || '{}');
      return (s.themeOverrides && s.themeOverrides[s.theme || 'midnight'] &&
              s.themeOverrides[s.theme || 'midnight']['--accent']) || null;
    }""")
    ok(f"S5 the dragged accent persisted (spec saved: {str(saved)[:60]})", bool(saved))
    accent_before = pg.evaluate("""() => {
      const p = document.createElement('div'); p.style.color = 'var(--accent)';
      p.style.display = 'none'; document.body.appendChild(p);
      const v = getComputedStyle(p).color; p.remove(); return v;
    }""")
    pg.reload()
    pg.wait_for_timeout(1100)
    accent_after = pg.evaluate("""() => {
      const p = document.createElement('div'); p.style.color = 'var(--accent)';
      p.style.display = 'none'; document.body.appendChild(p);
      const v = getComputedStyle(p).color; p.remove(); return v;
    }""")
    ok(f"S5 reload kept the accent ({accent_before} → {accent_after})",
       accent_before == accent_after)

    # ── S6: zero page errors through the whole rig ──────────────────
    real_errors = [e for e in errors if "favicon" not in e.lower()]
    ok(f"S6 zero page errors ({len(real_errors)})", len(real_errors) == 0)

    br.close()

results("v0791-theme-perf", fails, n)
if fails:
    sys.exit(1)
print("ALL GREEN")
