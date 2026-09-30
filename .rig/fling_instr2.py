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
      const n0 = window.__bakeN || 0, ok0 = window.__bakedOk || 0;
      body.scrollTop = body.scrollHeight - body.clientHeight;
      body.dispatchEvent(new Event('scroll', {bubbles: true}));
      const pills = [];
      document.querySelectorAll('.gr-color').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.height < 2 || r.bottom < 0 || r.top > innerHeight) return;
        const cs = getComputedStyle(el);
        if (cs.backgroundAttachment.indexOf('fixed') === -1) return;
        pills.push({rect: [Math.round(r.x), Math.round(r.y)], att: cs.backgroundAttachment.slice(0,16),
          painted: !!el.__projPainted, by: el.__projBy === undefined ? 'undef' : el.__projBy,
          hasR: !!el.__projR, rootIn: !!(el.__projR && el.__projR.el && el.__projR.el.isConnected)});
      });
      return {bakeN: (window.__bakeN||0) - n0, bakedOk: (window.__bakedOk||0) - ok0,
              unbakedInView: pills.slice(0, 4)};
    }""")
    print("bakeN (fresh seen):", res["bakeN"], "| bakedOk (actually baked):", res["bakedOk"])
    print("unbaked-in-view:", *res["unbakedInView"], sep="\n  ")
    b.close()
