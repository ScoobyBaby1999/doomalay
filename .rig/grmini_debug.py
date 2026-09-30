#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800})
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--surface-2': {colors:['#00ff00','#00cc88'],dir:'diag',angle:45}, '--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(900)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1300)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1000)
    pg.evaluate("() => { document.querySelectorAll('.settings-section h3').forEach(h => h.click()); return 'expanded'; }")
    pg.wait_for_timeout(1200)
    res = pg.evaluate("""() => {
      const out = [];
      document.querySelectorAll('.gr-mini').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.height < 2 || r.width < 2) return;
        const row = el.closest('.color-row-collapsed');
        out.push({
          cls: el.className.slice(0, 20),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          rowExpanded: row ? row.classList.contains('expanded') : null,
          rowName: row && row.querySelector('.color-row-name') ? row.querySelector('.color-row-name').textContent.trim().slice(0,16) : '?',
          att: getComputedStyle(el).backgroundAttachment,
          pos: getComputedStyle(el).backgroundPosition.slice(0, 30)
        });
      });
      return out.slice(0, 5);
    }""")
    for r in res: print(r)
    b.close()
