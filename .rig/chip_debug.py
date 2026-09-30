#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(800)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1200)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1500)
    res = pg.evaluate("""() => {
      const chips = document.querySelectorAll('[data-action="chat-scheme"]');
      const out = [];
      chips.forEach((ch, i) => {
        const dot = ch.querySelector('i');
        const cs = dot ? getComputedStyle(dot) : null;
        const ccs = getComputedStyle(ch);
        out.push({
          i: i, label: ch.textContent.trim().slice(0, 14),
          style: ch.getAttribute('style').slice(0, 90),
          chipMask: (ccs.webkitMaskImage || 'none').slice(0, 30),
          dotExists: !!dot,
          dotBg: cs ? cs.backgroundColor : null,
          dotMask: cs ? (cs.webkitMaskImage || 'none').slice(0, 30) : null,
          dotOpacity: cs ? cs.opacity : null,
          dotDisplay: cs ? cs.display : null,
          dotVis: cs ? cs.visibility : null,
          rect: dot ? JSON.stringify(dot.getBoundingClientRect()) : null
        });
      });
      return out.slice(0, 3);
    }""")
    for r in res: print(r)
    b.close()
