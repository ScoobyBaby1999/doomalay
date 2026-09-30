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
    # expand "Customize Midnight" section (holds the color-row banners)
    pg.evaluate("""() => {
      const h3s = Array.from(document.querySelectorAll('.settings-section h3'));
      const cust = h3s.find(h => /customize/i.test(h.textContent));
      if (cust) cust.click();
      return cust ? cust.textContent.trim() : 'not found';
    }""")
    pg.wait_for_timeout(900)
    res = pg.evaluate("""() => {
      const out = [];
      document.querySelectorAll('.color-row-banner').forEach((bn, i) => {
        const r = bn.getBoundingClientRect();
        if (r.width < 1) return;
        const cs = getComputedStyle(bn);
        out.push({
          i, name: (bn.closest('.color-row-collapsed') || {}).querySelector ?
            bn.closest('.color-row-collapsed').querySelector('.color-row-name').textContent.trim().slice(0,18) : '?',
          inline: (bn.style.backgroundImage || bn.style.backgroundColor || '').slice(0, 44),
          computedImg: cs.backgroundImage.slice(0, 44),
          computedColor: cs.backgroundColor,
          mask: (cs.webkitMaskImage !== 'none') ? 'MASKED!' : 'none',
          x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)
        });
      });
      return out.slice(0, 8);
    }""")
    pg.screenshot(path="/home/z/doomalay/.rig/banners.png")
    im = Image.open("/home/z/doomalay/.rig/banners.png").convert("RGB")
    for r in res:
        px = im.getpixel((r["x"]*2, r["y"]*2))
        print(r["name"], "| inline:", r["inline"][:38], "| computedImg:", r["computedImg"][:38], "| mask:", r["mask"], "| pixel:", px)
    # send-button glyph check: open a chat via a chatbot icon
    send = pg.evaluate("""() => {
      // close settings first
      const scrim = document.getElementById('chat-scrim');
      if (scrim) scrim.click();
      return 'closed';
    }""")
    pg.wait_for_timeout(800)
    opened = pg.evaluate("""() => {
      const bots = document.querySelectorAll('#chatbots .chatbot');
      if (bots.length) { bots[0].dispatchEvent(new MouseEvent('click', {bubbles: true})); return bots.length; }
      return 0;
    }""")
    pg.wait_for_timeout(1500)
    sendres = pg.evaluate("""() => {
      const btn = document.getElementById('chat-send');
      if (!btn) return {exists: false};
      const r = btn.getBoundingClientRect();
      const svg = btn.querySelector('svg');
      const lab = btn.querySelector('.sm-lab');
      const cs = getComputedStyle(btn);
      return {exists: true, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        svg: !!svg, label: lab ? lab.textContent : null,
        mask: (cs.webkitMaskImage !== 'none') ? 'MASKED!' : 'none',
        border: cs.borderColor};
    }""")
    print("SEND:", sendres)
    b.close()
