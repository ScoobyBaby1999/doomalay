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
      const dot = document.querySelector('[data-action="chat-scheme"] i');
      if (!dot) return 'no dot';
      const chain = [];
      let el = dot;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        chain.push({
          tag: el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''),
          pos: cs.position, z: cs.zIndex, pe: cs.pointerEvents,
          cv: cs.contentVisibility, iso: cs.isolation, mix: cs.mixBlendMode,
          op: cs.opacity, filt: (cs.filter !== 'none') ? 'FILTERED' : '',
          bg: (cs.backgroundColor || '').slice(0, 18),
          w: Math.round(el.getBoundingClientRect().width)
        });
        el = el.parentElement;
      }
      return chain;
    }""")
    for r in res: print(r)
    b.close()
