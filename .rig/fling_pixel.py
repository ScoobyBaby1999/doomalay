#!/usr/bin/env python3
"""THE definitive flash test: screenshot a pill DURING a fast scroll and AFTER settle —
the pixels must be identical (no transient element-local gradient)."""
from playwright.sync_api import sync_playwright
from PIL import Image
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
    # expand ALL color rows too — max pill population
    pg.evaluate("() => { document.querySelectorAll('[data-color-toggle]').forEach(h => h.click()); return 'rows'; }")
    pg.wait_for_timeout(1600)
    # jump to bottom instantly (far content freshly entering) + screenshot IMMEDIATELY
    pg.evaluate("""() => {
      const body = document.querySelector('.panel-body');
      window.__body = body;
      body.scrollTop = body.scrollHeight - body.clientHeight;
      body.dispatchEvent(new Event('scroll', {bubbles: true}));
      return body.scrollTop;
    }""")
    pg.screenshot(path="/home/z/doomalay/.rig/fling_mid.png")
    pg.wait_for_timeout(700)  # settle
    pg.screenshot(path="/home/z/doomalay/.rig/fling_settled.png")
    a = Image.open("/home/z/doomalay/.rig/fling_mid.png").convert("RGB")
    c = Image.open("/home/z/doomalay/.rig/fling_settled.png").convert("RGB")
    # manual diff
    import numpy as np
    A = np.asarray(a, dtype=int); C = np.asarray(c, dtype=int)
    D = np.abs(A - C).sum(axis=2)
    ys, xs = np.where(D > 24)
    if len(xs) == 0:
        print("IDENTICAL — no flash")
    else:
        print("materially different pixels:", len(xs), "/", 420*800)
        print("bbox:", (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())))
        y0, y1 = int(ys.min()), int(ys.max())
        x0, x1 = int(xs.min()), int(xs.max())
        a.crop((max(0,x0-10), max(0,y0-10), min(420,x1+10), min(800,y1+10))).save("/home/z/doomalay/.rig/fling_diff_crop.png")
        c.crop((max(0,x0-10), max(0,y0-10), min(420,x1+10), min(800,y1+10))).save("/home/z/doomalay/.rig/fling_diff_crop_settled.png")
    b.close()
