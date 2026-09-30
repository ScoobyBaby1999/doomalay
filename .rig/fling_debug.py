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
      const body = document.querySelector('.panel-body');
      // jump to the BOTTOM instantly (the far content was never painted)
      body.scrollTop = body.scrollHeight - body.clientHeight;
      body.dispatchEvent(new Event('scroll', {bubbles: true}));
      const out = [];
      const els = body.querySelectorAll('.color-row-reset, .gr-mini, .gr-dir');
      for (const el of els) {
        const cs = getComputedStyle(el);
        const img = cs.backgroundImage;
        if (!img || img === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
        const cx = r.x + r.width/2, cy = r.y + r.height/2;
        const top = document.elementFromPoint(cx, cy);
        if (!top || (top !== el && !el.contains(top) && !top.contains(el))) continue;
        if (cs.backgroundAttachment !== 'fixed' && (cs.backgroundPosition.indexOf('px') !== -1 || cs.backgroundPosition.indexOf('calc') !== -1)) continue;
        out.push({
          cls: (el.className || '').slice(0, 20),
          painted: !!el.__projPainted, pos: el.__projPos ? String(el.__projPos).slice(0,30) : null,
          by: el.__projBy, hasR: !!el.__projR,
          inlinePos: el.style.backgroundPosition ? el.style.backgroundPosition.slice(0,30) : null,
          computedPos: cs.backgroundPosition.slice(0, 24), att: cs.backgroundAttachment,
          img: img.slice(0, 40)
        });
      }
      return out.slice(0, 6);
    }""")
    for r in res: print(r)
    if not res: print("(none failing at this position)")
    b.close()
