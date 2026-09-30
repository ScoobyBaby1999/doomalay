#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1300)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1000)
    pg.evaluate("() => { document.querySelectorAll('.settings-section h3').forEach(h => h.click()); return 'expanded'; }")
    pg.wait_for_timeout(800)
    pg.evaluate("""() => { const h3s = Array.from(document.querySelectorAll('.settings-section h3')); const c = h3s.find(h => /customize/i.test(h.textContent)); if (c) c.click(); return 'open'; }""")
    pg.wait_for_timeout(700)
    pg.evaluate("() => { const head = document.querySelector('[data-color-toggle]'); if (head) head.click(); return 'row'; }")
    pg.wait_for_timeout(900)
    pg.screenshot(path="/home/z/doomalay/.rig/base_look.png")
    b.close()
