#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import numpy as np
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
    pg.evaluate("() => { document.querySelectorAll('[data-color-toggle]').forEach(h => h.click()); return 'rows'; }")
    pg.wait_for_timeout(1600)
    # jump to bottom, screenshot twice WITHOUT settle
    pg.evaluate("""() => { const body = document.querySelector('.panel-body');
      body.scrollTop = body.scrollHeight - body.clientHeight;
      body.dispatchEvent(new Event('scroll', {bubbles: true})); return body.scrollTop; }""")
    pg.screenshot(path="/home/z/doomalay/.rig/mid_a.png")
    pg.screenshot(path="/home/z/doomalay/.rig/mid_b.png")
    pg.wait_for_timeout(800)
    pg.screenshot(path="/home/z/doomalay/.rig/mid_settled.png")
    def diff(f1, f2):
        A = np.asarray(Image.open(f1).convert("RGB"), dtype=int)
        C = np.asarray(Image.open(f2).convert("RGB"), dtype=int)
        D = np.abs(A - C).sum(axis=2)
        return int((D > 24).sum())
    print("mid_a vs mid_b (self-consistency):", diff("/home/z/doomalay/.rig/mid_a.png", "/home/z/doomalay/.rig/mid_b.png"))
    print("mid_a vs settled:", diff("/home/z/doomalay/.rig/mid_a.png", "/home/z/doomalay/.rig/mid_settled.png"))
    b.close()
