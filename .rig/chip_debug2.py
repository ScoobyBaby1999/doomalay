#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
from PIL import Image
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(800)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1200)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1500)
    info = pg.evaluate("""() => {
      // probe EVERY chip's dot with elementFromPoint
      const out = [];
      document.querySelectorAll('[data-action="chat-scheme"]').forEach((ch, i) => {
        const dot = ch.querySelector('i');
        if (!dot) return;
        const r = dot.getBoundingClientRect();
        const cx = r.x + r.width/2, cy = r.y + r.height/2;
        const top = document.elementFromPoint(cx, cy);
        out.push({i, label: ch.textContent.trim().slice(0,12),
          cx: Math.round(cx), cy: Math.round(cy),
          topEl: top ? (top.tagName + '.' + (top.className||'') ).slice(0, 30) : 'null',
          topIsDot: top === dot});
      });
      return out.slice(0, 6);
    }""")
    for r in info: print(r)
    pg.screenshot(path="/home/z/doomalay/.rig/chips.png")
    im = Image.open("/home/z/doomalay/.rig/chips.png").convert("RGB")
    for r in info[:4]:
        print(r["label"], "pixel:", im.getpixel((r["cx"]*2, r["cy"]*2)))
    # crop the chip rows region for VLM
    im.crop((0, 780, 840, 1000)).save("/home/z/doomalay/.rig/chips_crop.png")
    b.close()
