#!/usr/bin/env python3
"""Reproduce: (a) chat-scheme chips invisible except selected, (b) color-row banners black — with a live border gradient."""
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    # set a border gradient override (the user's live state)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(800)
    # open settings -> appearance page
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1200)
    # navigate to appearance tab
    pg.evaluate("""() => { const t = document.querySelector('.settings-nav .tab[data-page="appearance"]'); if (t) t.click(); return !!t; }""")
    pg.wait_for_timeout(1200)
    res = pg.evaluate("""() => {
      const out = {chips: [], banners: []};
      document.querySelectorAll('[data-action="chat-scheme"]').forEach(ch => {
        const dot = ch.querySelector('i');
        const cs = dot ? getComputedStyle(dot) : null;
        out.chips.push({
          label: ch.textContent.trim().slice(0, 20),
          dotBg: cs ? cs.backgroundColor : null,
          labelColor: getComputedStyle(ch).color
        });
      });
      document.querySelectorAll('.color-row-banner').forEach(bn => {
        out.banners.push({
          inlineBg: bn.style.backgroundImage.slice(0, 60) || bn.style.backgroundColor,
          computedImg: getComputedStyle(bn).backgroundImage.slice(0, 60),
          mask: (getComputedStyle(bn).webkitMaskImage || getComputedStyle(bn).maskImage || '').slice(0, 40)
        });
      });
      return out;
    }""")
    print("CHIPS:", *res["chips"], sep="\n  ")
    print("BANNERS:", *res["banners"][:6], sep="\n  ")
    # pixel probe: first non-selected chip dot
    px = pg.evaluate("""() => {
      const ch = document.querySelector('[data-action="chat-scheme"]:not([style*="surface-3"])');
      if (!ch) return null;
      const dot = ch.querySelector('i');
      const r = dot.getBoundingClientRect();
      return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)};
    }""")
    pg.screenshot(path="/home/z/doomalay/.rig/theme_repro.png")
    if px:
        from PIL import Image
        im = Image.open("/home/z/doomalay/.rig/theme_repro.png").convert("RGB")
        print("chip dot pixel:", im.getpixel((px["x"]*2, px["y"]*2)), "(truth = the dot's own color)")
    print("errors:", errs)
    b.close()
