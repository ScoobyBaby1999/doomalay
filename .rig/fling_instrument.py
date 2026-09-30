#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=1)
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--surface-2': {colors:['#00ff00','#00cc88'],dir:'diag',angle:45}, '--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(900)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1300)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1000)
    pg.evaluate("() => { document.querySelectorAll('.settings-section h3').forEach(h => h.click()); return 'expanded'; }")
    pg.wait_for_timeout(1600)
    pg.evaluate("() => { document.querySelectorAll('[data-color-toggle]').forEach(h => h.click()); return 'rows'; }")
    pg.wait_for_timeout(1600)
    res = pg.evaluate("""() => {
      const body = document.querySelector('.panel-body');
      const stats0 = window.DoomProjection ? JSON.stringify(window.DoomProjection.stats) : null;
      // instrument scrollRebake via the stats + pill states before/after
      const pills = [];
      const collect = () => {
        const out = [];
        document.querySelectorAll('.gr-color').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.height < 2 || r.bottom < 0 || r.top > innerHeight) return;
          const cs = getComputedStyle(el);
          out.push({pos: el.__projPos ? String(el.__projPos).slice(0,36) : null,
            by: el.__projBy, painted: !!el.__projPainted,
            inlinePos: el.style.backgroundPosition ? el.style.backgroundPosition.slice(0,36) : null,
            att: cs.backgroundAttachment.slice(0,20)});
        });
        return out.slice(0, 4);
      };
      const before = collect();
      body.scrollTop = body.scrollHeight - body.clientHeight;
      body.dispatchEvent(new Event('scroll', {bubbles: true}));
      const after = collect();
      return {stats0, stats1: window.DoomProjection ? JSON.stringify(window.DoomProjection.stats) : null,
              before, after, paintedCount: (window.DoomProjection && window.DoomProjection._debugPainted) || 'n/a'};
    }""")
    print("stats before:", res["stats0"], "| after:", res["stats1"])
    print("BEFORE jump:", *res["before"], sep="\n  ")
    print("AFTER jump+dispatch:", *res["after"], sep="\n  ")
    pg.screenshot(path="/home/z/doomalay/.rig/fling_mid2.png")
    b.close()
