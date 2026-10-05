// doomprojection.js — v1.03.6 THE DOOM PROJECTION v2 (PLAN-V103 §2).
//
// THE USER SPEC: "re-introduce the doom projection system… we only
// render the 5-6 main gradients when items in the screen need them
// rendered. We render them once not once per element. Just a simple
// gradient projection with a shader or something to only have the
// elements that have it as an associated color reflect the gradient.
// Make the doom projection a toggleable switch in the colors tab."
//
// THE ARCHITECTURE (research-verified, tool-results/v103-research/A):
// ONE fixed fullscreen 2D canvas below every consumer (z 300: above
// the world #c/#chatbots/#c2, below the dock/panel/overlays) —
// background-attachment:fixed, element(), Houdini paint worklets and a
// second WebGL context were all REJECTED with source evidence (the
// Chromium fixed-attachment full-re-raster slow path + the transformed-
// ancestor containing-block split that killed v1; no viewport position
// in Paint Worklets; context loss on Android backgrounding).
//
// Each projected FIELD (surface + accent-1/2/3) rasterizes ONCE per
// theme change into an offscreen bitmap (dpr 1 — gradients are smooth,
// the memory is 1/4). Consumers = the elements whose background rides
// the field twins (the stylesheet crawl + the inline [style*] family).
// The toggle mints an override sheet (background-image: none; the
// OPAQUE Layer-1 family also goes transparent) so the canvas shows
// through. Every frame a consumer moves (drag/scroll/mutation) the
// canvas redraws: clear + one 9-arg drawImage crop per consumer —
// viewport-anchored, so same-variable elements render ONE shared
// continuous field (the doom projection the user described).
//
// The canvas field (the world) stays on the body (one field at root,
// nothing to project); the fmt text track stays local by design; the
// pixiworld pills paint locally (the 56px-invisibility precedent — the
// v1.04 bridge point).
(function () {
  'use strict';

  // the projected fields: [key, the gradient twin var, the field var]
  var FIELDS = [
    ['surface', '--surface-1-gradient', '--field-surface'],
    ['accent-1', '--accent-gradient', '--field-accent-1'],
    ['accent-2', '--accent-2-gradient', '--field-accent-2'],
    ['accent-3', '--accent-3-gradient', '--field-accent-3']
  ];
  // the OPAQUE Layer-1 family — the big surfaces whose solid base must
  // go transparent so the canvas field shows through (the tinted
  // windows keep their rgba bases — they read as frosted glass over
  // the projection)
  var LAYER1_SEL = '#chat-panel, [style*="background:var(--surface-1)"], [style*="background: var(--surface-1)"]';

  var canvas = null, ctx = null;
  var W = 0, H = 0, dpr = 1;
  var bitmaps = {};        // key → canvas (rasterized once)
  var consumers = [];      // [{el, key}]
  var overrideEl = null;   // the <style id="doom-proj-override">
  var obs = null;          // the mutation observer (drags + structure)
  var rafPending = false, collectT = 0, rasterT = 0;
  var on = false;
  var stats = { paints: 0, consumers: 0, rasters: 0 };

  function G() { return window.GradientUI || null; }

  function cssVarRaw(name) {
    try {
      return (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim();
    } catch (e) { return ''; }
  }

  function fieldSpecOf(key) {
    var DT = window.DoomTheme;
    var map = { 'surface': '--field-surface', 'accent-1': '--field-accent-1',
                'accent-2': '--field-accent-2', 'accent-3': '--field-accent-3' };
    try {
      var s = window.Settings.getState();
      var cur = s.theme || 'midnight';
      var ov = (s.themeOverrides && s.themeOverrides[cur]) || {};
      var folded = (DT && DT.foldThemeOverrides) ? DT.foldThemeOverrides(ov) : ov;
      var stored = folded[map[key]];
      if (stored) return stored;
      var hex = (DT && DT.resolvedThemeVar) ? DT.resolvedThemeVar(map[key]) : '';
      return { colors: [/^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex : window.DoomTheme.FALLBACKS.surface], dir: 'auto' };
    } catch (e) { return { colors: [window.DoomTheme.FALLBACKS.surface], dir: 'auto' }; }
  }

  // ── the field rasterizer (the css-family recipes, painted ONCE) ───
  // linear (the angle) · radial (the focal orbit) · mesh (the rotated
  // spots) — the DOM families only; a solid = the flat fill (the
  // projection is field-agnostic: solid themes project a flat field
  // and look byte-identical to the local model).
  function rasterField(key, spec) {
    var g = G();
    var s = (g && g.norm) ? g.norm(spec) : spec;
    var c = (s && s.colors) ? s.colors.filter(function (x) {
      return typeof x === 'string' && x.length;
    }) : [];
    var off = document.createElement('canvas');
    off.width = Math.max(16, Math.round(W));
    off.height = Math.max(16, Math.round(H));
    var x = off.getContext('2d');
    if (!c.length) { bitmaps[key] = off; return off; }
    var stops = c.join(', ');
    var dir = s.dir || 'auto';
    var ang = (typeof s.angle === 'number' && isFinite(s.angle)) ? s.angle : null;
    try {
      if (dir === 'radial') {
        var fx = W / 2, fy = H * 0.35, fr = Math.hypot(W, H) / 2;
        if (ang !== null) {
          var rr = ang * Math.PI / 180;
          fx = W * (50 + 35 * Math.sin(rr)) / 100;
          fy = H * (50 - 35 * Math.cos(rr)) / 100;
        }
        var rg = x.createRadialGradient(fx, fy, 0, fx, fy, fr);
        for (var i = 0; i < c.length; i++) rg.addColorStop(i / (c.length - 1), c[i]);
        x.fillStyle = rg;
      } else if (dir === 'mesh') {
        var MS = [{ x: 20, y: 25, f: 55 }, { x: 80, y: 30, f: 60 }, { x: 35, y: 75, f: 65 },
                  { x: 75, y: 80, f: 55 }, { x: 55, y: 50, f: 50 }, { x: 15, y: 60, f: 45 },
                  { x: 90, y: 55, f: 50 }, { x: 45, y: 15, f: 45 }];
        var k = Math.max(4, Math.min(MS.length, c.length));
        var base = c.length > 1 ? c[c.length - 1] : c[0];
        x.fillStyle = base;
        var rmax = Math.max(W, H);
        var mrot = ang === null ? 0 : ang * Math.PI / 180;
        var mc = Math.cos(mrot), ms = Math.sin(mrot);
        for (var j = 0; j < k; j++) {
          var ox2 = MS[j].x - 50, oy2 = MS[j].y - 50;
          var sx2 = W * (50 + (ox2 * mc - oy2 * ms)) / 100;
          var sy2 = H * (50 + (ox2 * ms + oy2 * mc)) / 100;
          var rg2 = x.createRadialGradient(sx2, sy2, 0, sx2, sy2, rmax * MS[j].f / 100);
          rg2.addColorStop(0, c[j % c.length]);
          rg2.addColorStop(1, 'rgba(0,0,0,0)');
          x.fillStyle = rg2;
          x.fillRect(0, 0, W, H);
        }
        bitmaps[key] = off;
        stats.rasters++;
        return off;
      } else {
        // linear: the angle (0° = top, clockwise; the legacy 135)
        var a2 = ang === null ? 135 : ang;
        var rad = (a2 - 135) * Math.PI / 180;
        var half = Math.hypot(W, H) / 2;
        var co = Math.cos(rad), si = Math.sin(rad);
        var dx = (co + si) / Math.SQRT2, dy = (si - co) / Math.SQRT2;
        var lg = x.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
        for (var i2 = 0; i2 < c.length; i2++) lg.addColorStop(i2 / (c.length - 1), c[i2]);
        x.fillStyle = lg;
      }
      x.fillRect(0, 0, W, H);
    } catch (e) {
      x.fillStyle = c[0];
      x.fillRect(0, 0, W, H);
    }
    bitmaps[key] = off;
    stats.rasters++;
    return off;
  }

  function rasterAll() {
    bitmaps = {};
    for (var i = 0; i < FIELDS.length; i++) rasterField(FIELDS[i][0], fieldSpecOf(FIELDS[i][0]));
  }

  // ── the consumer discovery (the old PROJ's collect, simplified) ────
  // (a) every stylesheet rule whose background-image consumes a twin
  //     var (pseudo-selectors stripped — we track the host elements);
  // (b) the inline [style*] twin family (the pills' JS-injected styles).
  function collectSels() {
    var sels = [];
    var seen = {};
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var rs; try { rs = document.styleSheets[s].cssRules; } catch (e) { continue; }
        for (var i = 0; i < rs.length; i++) {
          var r = rs[i];
          if (!r.selectorText || !r.style) continue;
          var bi = r.style.getPropertyValue('background-image') || '';
          var hit = null;
          for (var f = 0; f < FIELDS.length; f++) {
            if (bi.indexOf('var(' + FIELDS[f][1]) >= 0) { hit = FIELDS[f][0]; break; }
          }
          if (!hit) continue;
          var sel = String(r.selectorText).replace(/::[a-z-]+/g, '');
          if (!sel || seen[sel]) continue;
          seen[sel] = hit;
          sels.push([sel, hit]);
        }
      }
    } catch (e) { /* a crawl never takes the app down */ }
    // the inline twin family (the style-attr spellings the catchers use)
    var INLINE = [
      ['[style*="accent-gradient"]', 'accent-1'],
      ['[style*="accent-2-gradient"]', 'accent-2'],
      ['[style*="accent-3-gradient"]', 'accent-3'],
      ['[style*="surface-1-gradient"]', 'surface']
    ];
    for (var q = 0; q < INLINE.length; q++) {
      if (!seen[INLINE[q][0]]) { seen[INLINE[q][0]] = INLINE[q][1]; sels.push(INLINE[q]); }
    }
    return sels;
  }

  function collectConsumers() {
    var sels = collectSels();
    var out = [];
    var byKey = {};
    sels.forEach(function (pair) {
      var els;
      try { els = document.querySelectorAll(pair[0]); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var id = el.__doomProjId;
        if (id && byKey[id]) { byKey[id].key = pair[1]; continue; }
        el.__doomProjId = 1;
        byKey[el] = { el: el, key: pair[1] };
        out.push(byKey[el]);
      }
    });
    consumers = out;
    stats.consumers = out.length;
    return sels;
  }

  function mintOverride() {
    var sels = collectConsumers();
    var css = '';
    // every consumer: the local gradient window dies (the tinted bases
    // KEEP their rgba colors — frosted glass over the projection)
    var all = sels.map(function (p) { return p[0]; });
    if (all.length) css += 'html[data-doom-proj] ' + all.join(',\nhtml[data-doom-proj] ') +
      ' { background-image: none !important; }\n';
    // the OPAQUE Layer-1 family: the solid base dies too (the canvas
    // shows through)
    css += 'html[data-doom-proj] ' + LAYER1_SEL + ' { background-color: transparent !important; }\n';
    if (!overrideEl) {
      overrideEl = document.createElement('style');
      overrideEl.id = 'doom-proj-override';
      document.head.appendChild(overrideEl);
    }
    overrideEl.textContent = css;
  }

  function dropOverride() {
    if (overrideEl && overrideEl.parentNode) overrideEl.parentNode.removeChild(overrideEl);
    overrideEl = null;
    consumers = [];
  }

  // ── the paint: clear + one 9-arg crop per consumer ────────────────
  function paint() {
    rafPending = false;
    if (!on || !ctx) return;
    ctx.clearRect(0, 0, W, H);
    stats.paints++;
    var n = 0;
    for (var i = 0; i < consumers.length; i++) {
      var c = consumers[i];
      var b = bitmaps[c.key];
      if (!b || !c.el.isConnected) continue;
      var r;
      try { r = c.el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 1 || r.height < 1) continue;
      // viewport-anchored: the consumer shows ITS slice of the shared
      // field (the bitmap is viewport-sized, dpr 1)
      var sx = r.left * b.width / W, sy = r.top * b.height / H;
      var sw = r.width * b.width / W, sh = r.height * b.height / H;
      if (sx + sw <= 0 || sy + sh <= 0 || sx >= b.width || sy >= b.height) continue;
      ctx.drawImage(b, sx, sy, sw, sh, r.left, r.top, r.width, r.height);
      n++;
    }
    stats.consumers = n;
  }

  function mark() {
    if (!on || rafPending) return;
    rafPending = true;
    requestAnimationFrame(paint);
  }

  function scheduleCollect() {
    if (collectT) clearTimeout(collectT);
    collectT = setTimeout(function () {
      collectT = 0;
      if (!on) return;
      mintOverride();
      mark();
    }, 240);
  }

  function scheduleRaster() {
    if (rasterT) clearTimeout(rasterT);
    rasterT = setTimeout(function () {
      rasterT = 0;
      if (!on) return;
      rasterAll();
      mark();
    }, 140);
  }

  // ── enable / disable ─────────────────────────────────────────────
  function ensureCanvas() {
    if (canvas) return true;
    canvas = document.createElement('canvas');
    canvas.id = 'doom-proj';
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:300;' +
      'display:none;touch-action:none';
    // insert after #chatbots (above the world, below the dock/panel)
    var anchor = document.getElementById('chatbots');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(canvas, anchor.nextSibling);
    else document.body.appendChild(canvas);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    resize();
    ctx = canvas.getContext('2d');
    return !!ctx;
  }

  function resize() {
    if (!canvas) return;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.max(16, Math.round(W * dpr));
    canvas.height = Math.max(16, Math.round(H * dpr));
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setEnabled(v) {
    on = !!v;
    try {
      if (on) {
        if (!ensureCanvas()) { on = false; return false; }
        document.documentElement.setAttribute('data-doom-proj', 'on');
        canvas.style.display = 'block';
        rasterAll();
        mintOverride();
        mark();
        wireObservers();
      } else {
        document.documentElement.removeAttribute('data-doom-proj');
        if (canvas) canvas.style.display = 'none';
        dropOverride();
        unwireObservers();
        if (ctx) ctx.clearRect(0, 0, W, H);
      }
    } catch (e) { console.error('doom projection', e); }
    return on;
  }

  // ── the observers (the batched-read/diffed-write discipline) ──────
  function wireObservers() {
    if (obs) return;
    obs = new MutationObserver(function (muts) {
      if (!on) return;
      // a style write on a tracked root = motion (the panel drag rides
      // transform writes); a structural change = re-collect (debounced).
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') { mark(); return; }
      }
      scheduleCollect();
    });
    obs.observe(document.body, {
      attributes: true, attributeFilter: ['style'],
      childList: true, subtree: true
    });
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('doomalay:theme-applied', onTheme);
  }
  function unwireObservers() {
    if (obs) { try { obs.disconnect(); } catch (e) {} obs = null; }
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('doomalay:theme-applied', onTheme);
  }
  function onScroll() { mark(); }
  function onResize() { resize(); rasterAll(); mark(); }
  function onTheme() { scheduleRaster(); scheduleCollect(); }

  // the boot: honor the stored toggle once the DOM is ready + follow
  // every state change (the Colors-tab switch writes doomProjection)
  function syncFromState() {
    try {
      var s = (window.Settings && window.Settings.getState()) || {};
      var want = !!s.doomProjection;
      if (want !== on) setEnabled(want);
    } catch (e) {}
  }
  function boot() {
    syncFromState();
    try {
      if (window.Settings && window.Settings.onChange) window.Settings.onChange(syncFromState);
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else boot();

  // the API (the old stub's names stay: repaint is live again)
  window.DoomProjection = {
    setEnabled: function (v) { return setEnabled(v); },
    enabled: function () { return on; },
    repaint: function () { mark(); },
    poke: function () { scheduleCollect(); },
    motion: function () { mark(); },
    paint: function () { paint(); },
    stats: function () { return Object.assign({ on: on, consumers: consumers.length }, stats); }
  };
})();
