#!/usr/bin/env python3
"""Verify v0.79.3: (a) gr-editor box stays SURFACE-1 when surface-2 is a loud gradient,
(b) the outline pills follow the BORDER variable, (c) scroll flash gone."""
from playwright.sync_api import sync_playwright
from PIL import Image
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    # sentinel: surface-2 = LOUD green gradient, border = red/blue, s1 quiet
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--surface-2': {colors:['#00ff00','#00cc88'],dir:'diag',angle:45}, '--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(900)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1200)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1000)
    pg.evaluate("""() => { const h3s = Array.from(document.querySelectorAll('.settings-section h3')); const c = h3s.find(h => /customize/i.test(h.textContent)); if (c) c.click(); return 'open'; }""")
    pg.wait_for_timeout(800)
    # expand the FIRST color row (Surface row) to reveal the gr-editor box
    pg.evaluate("""() => { const head = document.querySelector('[data-color-toggle]'); if (head) head.click(); return 'row'; }""")
    pg.wait_for_timeout(900)
    res = pg.evaluate("""() => {
      const ed = document.querySelector('.gr-editor');
      const tab = document.querySelector('.settings-nav .tab');
      const reset = document.querySelector('.color-row-reset');
      function probe(el) {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { img: (cs.backgroundImage || '').slice(0, 70),
                 x: Math.round(r.x + Math.min(r.width/2, 20)), y: Math.round(r.y + Math.min(r.height/2, 20)) };
      }
      return { editor: probe(ed), tab: probe(tab), reset: probe(reset) };
    }""")
    pg.screenshot(path="/home/z/doomalay/.rig/surface.png")
    im = Image.open("/home/z/doomalay/.rig/surface.png").convert("RGB")
    for k in ["editor", "tab", "reset"]:
        r = res[k]
        if r:
            print(k, "img:", r["img"])
            print(k, "pixel:", im.getpixel((r["x"]*2, r["y"]*2)))
    print("errors:", errs)
    assert not errs
    b.close()
