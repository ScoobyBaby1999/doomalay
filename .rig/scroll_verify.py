#!/usr/bin/env python3
"""Scroll-flash red-team: fast-scroll the settings body while gradient twins are
live; every pill entering the viewport must be painter-baked DURING the fling
(backgroundAttachment 'scroll' + px position), never raw fixed-attachment."""
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2200)
    pg.evaluate("() => { Settings.setState({themeOverrides:{midnight:{'--surface-2': {colors:['#00ff00','#00cc88'],dir:'diag',angle:45}, '--border': {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45}}}}); return 'set'; }")
    pg.wait_for_timeout(900)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(1300)
    pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return !!t; }")
    pg.wait_for_timeout(1000)
    # expand ALL sections for a long page
    pg.evaluate("""() => { document.querySelectorAll('.settings-section h3').forEach(h => h.click()); return 'expanded'; }""")
    pg.wait_for_timeout(1200)
    # the scroll body: .panel-body (settings views scroll there)
    res = pg.evaluate("""() => {
      const body = document.querySelector('.panel-body');
      if (!body) return {error: 'no body'};
      const stats = window.DoomProjection ? window.DoomProjection.stats : null;
      // FLING simulation: 12 fast jumps, sampling newly-visible pills right after each
      const bad = [];
      const total = 12;
      for (let i = 1; i <= total; i++) {
        body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) * i / total);
        body.dispatchEvent(new Event('scroll', {bubbles: true}));
        // sample the visible pills NOW (mid-fling, before any settle)
        const els = body.querySelectorAll('.settings-nav .tab, .color-row-reset, .gr-color, .gr-mini, input, .ts-chip');
        for (const el of els) {
          const cs = getComputedStyle(el);
          const img = cs.backgroundImage;
          if (!img || img === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight || r.width < 2 || r.height < 2) continue;
          // TRUE visibility: the element (or a descendant) hit-tests at its center —
          // clipped-away (collapsed-row) content doesn't count
          const cx = r.x + r.width/2, cy = r.y + r.height/2;
          const top = document.elementFromPoint(cx, cy);
          if (!top || (top !== el && !el.contains(top) && !top.contains(el))) continue;
          // a gradient-bearing pill mid-viewport must be baked (attachment scroll + px pos)
          if (cs.backgroundAttachment === 'fixed') { bad.push('fixed:' + (el.className||el.tagName)); }
          else {
            const pos = cs.backgroundPosition;
            if (pos.indexOf('px') === -1 && pos.indexOf('calc') === -1) bad.push('unbaked-pos:' + (el.className||el.tagName));
          }
        }
      }
      body.scrollTop = 0;
      body.dispatchEvent(new Event('scroll', {bubbles: true}));
      return {bad: bad.slice(0, 6), scrollH: body.scrollHeight, stats: stats};
    }""")
    pg.wait_for_timeout(600)
    print(res)
    assert not res.get("error"), "no scroll body"
    assert not res["bad"], f"UNBAKED PILLS MID-FLING: {res['bad']}"
    print("SCROLL FLASH RED-TEAM: PASS (all in-view gradient pills baked mid-fling)")
    print("errors:", errs)
    assert not errs
    b.close()
