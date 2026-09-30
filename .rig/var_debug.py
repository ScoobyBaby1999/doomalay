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
    res = pg.evaluate("""() => {
      const el = document.querySelector('.gr-mini');
      const root = el.closest('[data-proj-root]');
      const cs = getComputedStyle(el);
      const rs = getComputedStyle(root || document.documentElement);
      // resolve manually
      const sheet = document.getElementById('doom-proj-vars');
      return {
        rootAttr: root ? root.getAttribute('data-proj-root') : null,
        rootTag: root ? root.tagName + '#' + (root.id||'') : null,
        projTxEl: cs.getPropertyValue('--proj-tx'),
        projTyEl: cs.getPropertyValue('--proj-ty'),
        projTxRoot: rs.getPropertyValue('--proj-tx'),
        sheetRules: sheet ? Array.from(sheet.sheet.cssRules).map(r => r.cssText.slice(0, 70)) : null,
        inlinePos: el.style.backgroundPosition,
        computedPos: cs.backgroundPosition,
        // substitute manually to see if valid
        manual: cs.backgroundPosition
      };
    }""")
    for k, v in res.items(): print(k, ":", v)
    b.close()
