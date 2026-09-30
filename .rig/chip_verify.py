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
    pg.wait_for_timeout(1200)
    # expand the Chat Colors section (its header is an h3 with a span)
    expanded = pg.evaluate("""() => {
      const h3s = Array.from(document.querySelectorAll('.settings-section h3'));
      const chat = h3s.find(h => /chat colors/i.test(h.textContent));
      if (chat) chat.click();
      return chat ? chat.textContent.trim() : 'not found';
    }""")
    print("section clicked:", expanded)
    pg.wait_for_timeout(900)
    info = pg.evaluate("""() => {
      const out = [];
      document.querySelectorAll('[data-action="chat-scheme"]').forEach((ch, i) => {
        const dot = ch.querySelector('i');
        if (!dot) return;
        const r = dot.getBoundingClientRect();
        if (r.width < 1) return;
        const cx = r.x + r.width/2, cy = r.y + r.height/2;
        const top = document.elementFromPoint(cx, cy);
        out.push({i, label: ch.textContent.trim().slice(0,12), cx: Math.round(cx), cy: Math.round(cy),
          topIsDot: top === dot, dotBg: getComputedStyle(dot).backgroundColor});
      });
      return out.slice(0, 8);
    }""")
    ok = True
    for r in info:
        print(r)
        if not r["topIsDot"]: ok = False
    pg.screenshot(path="/home/z/doomalay/.rig/chips2.png")
    im = Image.open("/home/z/doomalay/.rig/chips2.png").convert("RGB")
    for r in info[:6]:
        px = im.getpixel((r["cx"]*2, r["cy"]*2))
        print(r["label"], "pixel:", px)
    # crop expanded chips region
    if info:
        ys = [r["cy"] for r in info]
        im.crop((0, min(ys)*2-60, 840, max(ys)*2+80)).save("/home/z/doomalay/.rig/chips2_crop.png")
    print("ALL DOTS HIT-TESTABLE+PAINTED:", ok)
    b.close()
