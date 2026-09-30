#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800})
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(800)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1400)
    res = pg.evaluate("""() => {
      const tabs = document.querySelectorAll('.settings-nav .tab');
      const out = {count: tabs.length, rules: []};
      tabs.forEach(t => {
        const cs = getComputedStyle(t);
        out.rules.push({cls: t.className, page: t.getAttribute('data-page'),
          img: (cs.backgroundImage||'none').slice(0,60),
          color: cs.color, bgc: cs.backgroundColor});
      });
      // find the border-family rule in the sheets
      out.sheetRule = null;
      for (const sh of document.styleSheets) {
        try {
          for (const r of sh.cssRules) {
            if (r.selectorText && r.selectorText.indexOf('.settings-nav .tab') !== -1 &&
                r.style && r.style.backgroundImage) {
              out.sheetRule = (r.selectorText + ' :: ' + r.style.backgroundImage.slice(0, 80));
            }
          }
        } catch(e) {}
      }
      return out;
    }""")
    print("tab count:", res["count"])
    for r in res["rules"]: print(r)
    print("sheet rule found:", res["sheetRule"])
    b.close()
