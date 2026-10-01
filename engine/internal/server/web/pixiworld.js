// pixiworld.js — v0.85.4 THE PIXIJS WORLD LAYER (renderer-path Phase 3:
// "the icon ceiling" — RESEARCH-V084 §2c/Phase 3, PLAN-V085 §B).
//
// THE GATE, IN CODE: settings worldLayer = 'auto' (default) | 'on' | 'off'.
// auto activates at ≥ 60 canvas entities (the measured DOM icon-layer
// ceiling zone — every .chatbot is a positioned element with its own
// compositor texture; past a few score of them the standing layer cost
// beats any per-icon GPU win) AND a WebGL-capable context. Below the
// threshold it deactivates (the app is destroyed, GPU memory freed;
// re-boot is ~100ms). 'on'/'off' force it either way.
//
// WHAT MOVES TO THE GPU: a new canvas #c3 (fixed, z-index 100 — where
// #chatbots sits; pointer-events:none) hosts a Pixi v8 Application
// (preference 'webgl' — WebGL2 with the v8 fallback chain; init failure
// keeps the DOM path untouched):
//   · every entity as a SPRITE from a texture rasterized ONCE per
//     (icon, appearance fingerprint) — the whole .chatbot look (disc +
//     letter/glyph/custom icon + persona badge band + sandbox chip + the
//     name pill) hand-drawn at 2× into a canvas 2D, anchor (0.5, 0.5) at
//     the element center — the exact DOM layout;
//   · THE ATOM STARS as additive-blend glow sprites (the emitted-light
//     look) with zIndex DEPTH — front stars sort above the disc, back
//     stars below (the v0.84.1 back-and-above occlusion, free via
//     sortableChildren — no evenodd clip needed on this layer); the
//     shell ellipses are Graphics redrawn on layout change only;
//   · per-chat containers scale with the camera (the DOM transform's
//     twin); off-viewport chats cull to visible=false.
//
// WHAT STAYS DOM — everything else, by the plan's law ("The DOM keeps
// the panel, overlays, theme chrome and all input handling"): the
// .chatbot elements become INVISIBLE HIT-TARGETS (#chatbots.pixi3d →
// opacity:0 + will-change:auto — no painted content, no compositor
// texture, taps/drags/long-press/elementFromPoint all unchanged);
// theme tokens resolve main-side (getComputedStyle) and feed the
// rasters — a theme change re-rasterizes every texture live.
//
// THE ATOM FEED + MATH: zero drift — window.AtomCore (atoms.js's pure
// core) supplies starPos/shellLayout/SHELL_R/SHELL_TILT, and
// window.Atoms.countsOf() feeds the counts. The atom pass on #c2 (main
// or worker) is DISABLED while the world layer owns the atoms
// (World3D.atomsOwned()); Pixi's own ticker drives the stars — the main
// rAF loop stops burning atom-only frames entirely.
//
// LAZY: this module is tiny and always loaded; the pixi.min.js bundle
// (vendored, ~828KB / ~250KB gzipped) injects ONLY on first activation —
// boot time is untouched when the layer is off.
//
// Exposes: window.World3D = { sync, evaluate, atomsOwned, pulse,
//                             active, debug }
(function () {
  'use strict';

  var THRESHOLD = 60;      // 'auto' activates at ≥ 60 entities
  var RASTER_SS = 2;       // raster supersample (crisp at zoom ≤ 2)
  var t0 = performance.now() / 1000;

  var S = {
    mode: 'off',           // 'off' | 'auto' | 'on' | 'booting'
    app: null,             // the Pixi Application
    stageRoot: null,       // the world container
    canvas: null,          // #c3
    chats: new Map(),      // entityId → { container, sprite, tex, fp, shells, stars }
    icons: [],             // live entity refs (the ticker reads x/y)
    glowTex: null,         // the additive star texture
    tickerFn: null,
    watcher: 0,            // the 1s appearance watcher interval
    lastError: '',
    renderer: ''
  };

  function entitiesCount() {
    return (window.doomalay && window.doomalay.world) ? window.doomalay.world.entities.length : 0;
  }
  function settingsMode() {
    var st = window.Settings && window.Settings.getState();
    var m = st && st.worldLayer;
    return (m === 'on' || m === 'off') ? m : 'auto';
  }

  // ── theme color helpers (main-side resolution, cached ~1s) ───────
  var colCache = { at: 0 };
  function cssVar(name) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
    catch (e) { return ''; }
  }
  function themeColors() {
    var now = performance.now();
    if (now - colCache.at > 1000 || !colCache.v) {
      colCache.at = now;
      colCache.v = {
        surface2: cssVar('--surface-2') || '#1a1a22',
        text1: cssVar('--text-1') || '#e0e0e8',
        text2: cssVar('--text-2') || '#a8a8b4',
        text3dim: cssVar('--text-3-dim') || '#54545e',
        bgApp: cssVar('--bg-app') || '#0a0a0b',
        ok: cssVar('--ok') || '#34d399',
        surface1: cssVar('--surface-1') || '#14141a',
        accent: cssVar('--accent') || '#a78bfa',
        accent2: cssVar('--accent-2') || '#38bdf8',
        borderStrong: cssVar('--border-strong') || '#34344a'
      };
    }
    return colCache.v;
  }

  // ── image loading cache (family glyphs / custom icons / badges) ──
  var imgCache = {};   // url → {img, ready}
  function imageFor(url) {
    if (!url) return null;
    var e = imgCache[url];
    if (e) return e.ready ? e.img : null;
    e = { img: new Image(), ready: false };
    imgCache[url] = e;
    e.img.onload = function () { e.ready = true; S.dirtyAll = true; };
    e.img.onerror = function () { e.dead = true; };
    e.img.src = url;
    return null;
  }

  // ── THE ICON RASTER — the whole .chatbot look at RASTER_SS ───────
  // Layout twins the DOM: disc 56 + gap 4 + name pill (~19) centered in
  // an ~88×80 element box; anchor (0.5, 0.5) = the element center.
  function appearanceFingerprint(icon) {
    var ring = '';
    try {
      ring = icon._personaRingEl ? String(icon._personaRingEl.style.background || '') : '';
    } catch (e) {}
    return [icon.family, icon.iconIndex, icon.iconCustom ? 1 : 0, icon.iconRev || 0,
            icon.name || '', icon.sandbox || '', icon.radius || 28, ring,
            themeStamp].join('|');
  }
  var themeStamp = 0;

  function rasterIcon(icon) {
    var c = themeColors();
    var R = (typeof icon.radius === 'number' ? icon.radius : 28);   // disc radius @1×
    var DIAM = R * 2;
    var W_ = 88, H_ = DIAM + 4 + 20;
    var cv = document.createElement('canvas');
    cv.width = W_ * RASTER_SS; cv.height = H_ * RASTER_SS;
    var g = cv.getContext('2d');
    g.scale(RASTER_SS, RASTER_SS);
    var cx = W_ / 2, cy = R + 1;                                     // disc center @1×

    // persona badge ring (the annulus twin of the CSS mask band)
    var ringStyle = '';
    try {
      ringStyle = icon._personaRingEl ? String(icon._personaRingEl.style.background || '') : '';
    } catch (e) {}
    if (ringStyle) {
      var ringR = DIAM * 70 / 56 / 2;                                // the CSS 70px band on a 56px disc
      g.save();
      g.beginPath(); g.arc(cx, cy, ringR, 0, Math.PI * 2);
      g.arc(cx, cy, ringR - 7, 0, Math.PI * 2, true);
      g.clip('evenodd');
      paintCSSBackground(g, ringStyle, cx - ringR, cy - ringR, ringR * 2, ringR * 2);
      g.restore();
    }

    // the disc
    var cfg = window.DoomalayConfig || { families: {} };
    var fam = (cfg.families && cfg.families[icon.family]) || {};
    var branded = !!(cfg.families && cfg.families[icon.family] && cfg.families[icon.family].color);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    var discImg = null;
    if (icon.customIconURL) discImg = imageFor(icon.customIconURL());
    else if (icon.iconIndex >= 0 && fam.icons && icon.iconIndex < fam.icons.length) discImg = imageFor(fam.icons[icon.iconIndex]);
    if (discImg) {
      var ir = discImg.width / discImg.height, vr = 1;
      var dw, dh;
      if (ir > vr) { dh = DIAM; dw = DIAM * ir; } else { dw = DIAM; dh = DIAM / ir; }
      g.drawImage(discImg, cx - dw / 2, cy - dh / 2, dw, dh);
    } else {
      g.fillStyle = (icon.family !== 'default' && branded && fam.color) ? fam.color : c.surface2;
      g.fillRect(cx - R, cy - R, DIAM, DIAM);
      // the name letter (the DOM twin: 22px/700/text-1 + shadow)
      g.fillStyle = c.text1;
      g.font = '700 22px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 2; g.shadowOffsetY = 1;
      g.fillText((icon.name || icon.title || '?').charAt(0).toUpperCase(), cx, cy + 1);
      g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
    }
    g.restore();
    // the disc border (2px text-3-dim) + drop shadow
    g.strokeStyle = c.text3dim; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R - 1, 0, Math.PI * 2); g.stroke();

    // sandbox corner chip (20px at the disc's right edge)
    if (icon.sandbox) {
      var bad = (window.ChatIcon && window.ChatIcon.ChatIcon && window.ChatIcon.ChatIcon.SANDBOX_BADGES) || {};
      var glyph = bad[icon.sandbox] || '⚡';
      var bx = cx + R - 10, by = cy + R - 18;
      g.fillStyle = c.surface1;
      g.strokeStyle = c.ok; g.lineWidth = 1.5;
      g.beginPath(); g.arc(bx, by, 10, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = c.text1;
      g.font = '11px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(glyph, bx, by + 0.5);
    }

    // the name pill (max-width 80, ellipsis, text-2 on bg-app 0.92)
    var name = String(icon.name || icon.title || '');
    g.font = '600 12px system-ui, sans-serif';
    var maxW = 76;
    while (name.length > 1 && g.measureText(name).width > maxW - 12) name = name.slice(0, -1);
    if (name !== String(icon.name || '') && name.length) name += '…';
    var tw = Math.min(maxW, g.measureText(name).width + 14);
    var nx = cx - tw / 2, ny = DIAM + 4;
    g.fillStyle = 'rgba(10,10,11,0.92)';
    roundRect(g, nx, ny, tw, 17, 5); g.fill();
    g.fillStyle = c.text2;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, cx, ny + 9);

    return { canvas: cv, w: W_, h: H_, discCx: cx, discCy: cy };
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  // paintCSSBackground — a best-effort raster of the ring's background
  // style (solid hex / linear-gradient / radial-gradient / url(image))
  function paintCSSBackground(g, style, x, y, w, h) {
    var s = String(style || '').trim();
    var mHex = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (mHex) { g.fillStyle = s; g.fillRect(x, y, w, h); return; }
    var mLin = /^linear-gradient\((.*)\)$/.exec(s);
    if (mLin) {
      var stops = mLin[1].split(',').map(function (p) { return p.trim(); });
      var ang = 135;
      var mAng = /^([\d.]+)deg$/.exec(stops[0] || '');
      if (mAng) ang = parseFloat(mAng);
      var cols = stops.filter(function (p) { return /^#/.test(p) || /rgb/.test(p); });
      if (cols.length >= 2) {
        var rad = (ang - 90) * Math.PI / 180;
        var cx0 = x + w / 2 - Math.cos(rad) * w / 2, cy0 = y + h / 2 - Math.sin(rad) * h / 2;
        var cx1 = x + w / 2 + Math.cos(rad) * w / 2, cy1 = y + h / 2 + Math.sin(rad) * h / 2;
        var lg = g.createLinearGradient(cx0, cy0, cx1, cy1);
        for (var i = 0; i < cols.length; i++) lg.addColorStop(i / (cols.length - 1), cols[i]);
        g.fillStyle = lg; g.fillRect(x, y, w, h);
        return;
      }
    }
    var mUrl = /url\(["']?([^"')]+)["']?\)/.exec(s);
    if (mUrl) {
      var img = imageFor(mUrl[1]);
      if (img) g.drawImage(img, x, y, w, h);
      return;
    }
    g.fillStyle = 'rgba(167,139,250,0.9)';   // the accent fallback
    g.fillRect(x, y, w, h);
  }

  // ── the star glow texture (additive) ─────────────────────────────
  function makeGlowTexture(app) {
    var c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    var g = c.getContext('2d');
    var rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 64, 64);
    return PIXI.Texture.from(c);
  }

  // ── theme → pixi colors ──────────────────────────────────────────
  function hexToInt(h) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(String(h || ''));
    return m ? parseInt(m[1], 16) : 0xffffff;
  }
  function atomColors() {
    if (window.Atoms && window.Atoms.colorsFor) {
      var t = window.Atoms.colorsFor();
      if (t && t.accent) return { accent: t.accent, accent2: t.accent2, ring: t.ring };
    }
    var c = themeColors();
    return { accent: c.accent.replace('#', ''), accent2: c.accent2.replace('#', ''), ring: '120,130,140' };
  }

  // ══ THE LAYER ════════════════════════════════════════════════════
  function ensurePixiScript(cb) {
    if (typeof PIXI !== 'undefined') { cb(); return; }
    var s = document.createElement('script');
    s.src = 'vendor/pixi/pixi.min.js';
    s.onload = function () { cb(); };
    s.onerror = function () { S.lastError = 'pixi.min.js failed to load'; S.mode = 'off'; syncChrome(); };
    document.head.appendChild(s);
  }

  function activate() {
    if (S.app || S.mode === 'booting') return;
    S.mode = 'booting';
    ensurePixiScript(function () {
      var cv = document.createElement('canvas');
      cv.id = 'c3';
      cv.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:100';
      document.body.insertBefore(cv, document.getElementById('chatbots'));
      S.canvas = cv;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var app = new PIXI.Application();
      app.init({
        canvas: cv,
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundAlpha: 0,
        antialias: true,
        resolution: dpr,
        autoDensity: true,
        preference: 'webgl',
        powerPreference: 'high-performance'
      }).then(function () {
        S.app = app;
        S.stageRoot = new PIXI.Container();
        app.stage.addChild(S.stageRoot);
        S.glowTex = makeGlowTexture(app);
        try {
          var rt = app.renderer.type;
          S.renderer = (PIXI.RendererType && PIXI.RendererType[rt]) ? String(PIXI.RendererType[rt]).toLowerCase() : 'webgl';
        } catch (e) { S.renderer = 'webgl'; }
        S.mode = settingsMode() === 'on' ? 'on' : 'auto';
        if (settingsMode() === 'off') { deactivate(); return; }
        // the per-frame world update (positions + stars + culling)
        S.tickerFn = function () { updateWorld(); };
        app.ticker.add(S.tickerFn);
        // the 1s appearance watcher (name/persona/icon changes re-raster)
        S.watcher = setInterval(function () { watchAppearances(); }, 1000);
        window.addEventListener('resize', onResize);
        sync();
        syncChrome();
        try { window.DoomalayPerf.world = 'pixi (' + S.renderer + ')'; } catch (e) {}
        // the handover frame: one repaint clears the stale #c2 stars (the
        // worker's atomsOn goes false the moment we own them)
        if (window.doomalay && window.doomalay.repaint) window.doomalay.repaint();
      }).catch(function (err) {
        S.lastError = String(err && err.message || err);
        S.mode = 'off';
        if (cv.parentNode) cv.parentNode.removeChild(cv);
        S.canvas = null;
        syncChrome();
      });
    });
  }

  function deactivate() {
    if (S.app) {
      try {
        if (S.tickerFn) S.app.ticker.remove(S.tickerFn);
        S.app.destroy(true, { children: true, texture: true });
      } catch (e) {}
      S.app = null; S.stageRoot = null; S.glowTex = null; S.tickerFn = null;
    }
    if (S.canvas && S.canvas.parentNode) S.canvas.parentNode.removeChild(S.canvas);
    S.canvas = null;
    if (S.watcher) { clearInterval(S.watcher); S.watcher = 0; }
    window.removeEventListener('resize', onResize);
    S.chats.forEach(function (rec) { unbindFlash(rec.icon); });
    S.chats.clear();
    S.icons = [];
    S.mode = settingsMode();
    syncChrome();
    try { window.DoomalayPerf.world = 'dom icons'; } catch (e) {}
    // the hand-back frame: one repaint restores the #c2 stars (the main
    // loop owns the atoms again — ambientActive wakes on their account)
    if (window.doomalay && window.doomalay.repaint) window.doomalay.repaint();
  }

  function onResize() {
    if (S.app) {
      S.app.renderer.resize(window.innerWidth, window.innerHeight);
    }
  }

  // syncChrome — the DOM side: invisible hit-targets while active
  function syncChrome() {
    var layer = document.getElementById('chatbots');
    if (layer) layer.classList.toggle('pixi3d', !!S.app);
  }

  // bindFlash — the tap pulse twin (the DOM .tapped class is invisible)
  function bindFlash(icon) {
    if (!icon || icon.__w3dFlash) return;
    var orig = icon.flash && icon.flash.bind(icon);
    icon.__w3dFlash = true;
    icon.flash = function () {
      if (orig) orig();
      pulse(icon.id);
    };
  }
  function unbindFlash(icon) {
    if (!icon || !icon.__w3dFlash) return;
    delete icon.__w3dFlash;
    // the original method is restored by the class prototype on next load;
    // the world layer replaces instances only while it owns them
  }

  var pulses = {};   // id → t0
  function pulse(id) { pulses[id] = performance.now(); }

  // ── sync — the entity mirror (add/remove/raster) ─────────────────
  function sync() {
    if (!S.app || !S.stageRoot) return;
    var world = window.doomalay && window.doomalay.world;
    var list = world ? world.entities : [];
    var seen = new Set();
    for (var i = 0; i < list.length; i++) {
      var icon = list[i];
      if (!icon || !icon.el) continue;
      seen.add(icon.id);
      if (!S.chats.has(icon.id)) addChat(icon);
    }
    var removals = [];
    S.chats.forEach(function (rec, id) {
      if (!seen.has(id)) removals.push(id);
    });
    for (var j = 0; j < removals.length; j++) removeChat(removals[j]);
    S.icons = list.slice();
    watchAppearances();
  }

  function addChat(icon) {
    var rec = { icon: icon, container: new PIXI.Container(), sprite: null, tex: null, fp: '',
                shells: null, stars: null, starCount: 0 };
    rec.container.sortableChildren = true;
    S.stageRoot.addChild(rec.container);
    S.chats.set(icon.id, rec);
    rasterChat(rec);
    bindFlash(icon);
  }
  function removeChat(id) {
    var rec = S.chats.get(id);
    if (!rec) return;
    unbindFlash(rec.icon);
    rec.container.destroy({ children: true });
    if (rec.tex) rec.tex.destroy(true);
    S.chats.delete(id);
  }
  function rasterChat(rec) {
    var fp = appearanceFingerprint(rec.icon);
    if (fp === rec.fp && rec.sprite) return;
    rec.fp = fp;
    var r = rasterIcon(rec.icon);
    if (rec.tex) rec.tex.destroy(true);
    rec.tex = PIXI.Texture.from(r.canvas);
    if (!rec.sprite) {
      rec.sprite = new PIXI.Sprite(rec.tex);
      rec.sprite.zIndex = 100;
      rec.container.addChild(rec.sprite);
    } else rec.sprite.texture = rec.tex;
    rec.sprite.anchor.set(0.5, 0.5);
    rec.sprite.width = r.w; rec.sprite.height = r.h;
    rec.discR = r.discCx === undefined ? 28 : (typeof rec.icon.radius === 'number' ? rec.icon.radius : 28);
    rec.rw = r.w; rec.rh = r.h;
    S.dirtyAll = true;
  }
  function watchAppearances() {
    if (!S.app) return;
    var bumped = false;
    S.chats.forEach(function (rec) {
      var fp = appearanceFingerprint(rec.icon);
      if (fp !== rec.fp) { rasterChat(rec); bumped = true; }
    });
    if (bumped) layoutAtoms(true);
  }

  // ── layoutAtoms — shells + star sprites per current counts ───────
  function layoutAtoms(force) {
    if (!S.app) return;
    var counts = (window.Atoms && window.Atoms.countsOf()) || {};
    var AC = window.AtomCore;
    if (!AC) return;
    S.chats.forEach(function (rec, id) {
      var n = (rec.icon.sessionId && counts[rec.icon.sessionId]) || 0;
      if (n === rec.starCount && !force) return;
      rec.starCount = n;
      // clear the old shells/stars
      if (rec.shells) { rec.shells.forEach(function (sh) { sh.destroy(); }); rec.shells = null; }
      if (rec.stars) { rec.stars.forEach(function (st) { st.destroy(); }); rec.stars = null; }
      if (!n) return;
      var layout = AC.shellLayout(n);
      rec.shells = [];
      rec.stars = [];
      for (var L = 0; L < layout.length; L++) {
        var R = AC.SHELL_R[L];
        var tilt = AC.SHELL_TILT[L] || AC.SHELL_TILT[0];
        var a = tilt[0] * Math.PI / 180, b = tilt[1] * Math.PI / 180;
        var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
        var e1x = cb, e1y = sb, e2x = -sb * ca, e2y = cb * ca;
        // the shell ellipse — Graphics, stroked polyline (64 segs)
        var g = new PIXI.Graphics();
        g.zIndex = 40;
        var col = hexToInt(themeColors().borderStrong);
        g.moveTo((e1x) * R, (e1y) * R);
        for (var k = 1; k <= 64; k++) {
          var th = (k / 64) * Math.PI * 2;
          g.lineTo(Math.cos(th) * e1x + Math.sin(th) * e2x,
                   Math.cos(th) * e1y + Math.sin(th) * e2y);
        }
        g.stroke({ width: 0.75, color: col, alpha: 0.35 });
        rec.container.addChild(g);
        rec.shells.push(g);
        // the stars on this shell
        for (var j = 0; j < layout[L]; j++) {
          var sp = new PIXI.Sprite(S.glowTex);
          sp.anchor.set(0.5, 0.5);
          sp.blendMode = 'add';
          sp.zIndex = 150;
          rec.container.addChild(sp);
          rec.stars.push({ sp: sp, L: L, j: j, R: R });
        }
      }
    });
  }

  // ── updateWorld — the ticker: camera, positions, stars, culling ──
  function updateWorld() {
    if (!S.app || !S.stageRoot) return;
    var cam = window.DoomalayDebug && window.DoomalayDebug.camera;
    var ox = cam ? cam.x : 0, oy = cam ? cam.y : 0, sc = cam ? cam.scale : 1;
    var W = window.innerWidth, H = window.innerHeight;
    var t = performance.now() / 1000 - t0;
    var AC = window.AtomCore;
    var cols = null;
    var pad = 130 * sc + 40;
    layoutAtoms(false);
    if (S.dirtyAll) { S.dirtyAll = false; }
    S.chats.forEach(function (rec) {
      var icon = rec.icon;
      var sx = (icon.x - ox) * sc, sy = (icon.y - oy) * sc;
      var onScreen = sx > -pad && sx < W + pad && sy > -pad && sy < H + pad;
      rec.container.visible = onScreen;
      if (!onScreen) return;
      rec.container.x = sx; rec.container.y = sy;
      // v0.88.2: the orbit depth cue rides the mirror too (the grouped
      // tabs' tilted-plane z swings their sprite scale)
      rec.container.scale.set(sc * (icon._orbitScale || 1));
      // the tap pulse (the flash twin)
      var pt = pulses[icon.id];
      if (pt !== undefined) {
        var age = performance.now() - pt;
        if (age > 220) { delete pulses[icon.id]; rec.sprite.alpha = 1; }
        else {
          var k = age / 220;
          rec.sprite.alpha = 1 - 0.35 * Math.sin(k * Math.PI);
        }
      } else if (rec.sprite.alpha !== 1) rec.sprite.alpha = 1;
      // the stars
      if (rec.stars && rec.stars.length && AC) {
        if (!cols) cols = atomColors();
        var accent = hexToInt('#' + String(cols.accent).replace('#', ''));
        var accent2 = hexToInt('#' + String(cols.accent2).replace('#', ''));
        for (var q = 0; q < rec.stars.length; q++) {
          var st = rec.stars[q];
          var p = AC.starPos(icon.id + '|' + st.L + '|' + st.j, st.L, st.R, t);
          st.sp.x = p.x; st.sp.y = p.y;
          st.sp.zIndex = p.z >= 0 ? 150 : 45;
          var rr = Math.max(0.9, p.r);
          st.sp.width = rr * 5.2; st.sp.height = rr * 5.2;
          st.sp.alpha = p.z >= 0 ? 0.95 : 0.5;
          st.sp.tint = (st.L % 2) ? accent2 : accent;
        }
      }
    });
  }

  // ── evaluate — the gate (call on entity-count changes + settings) ─
  function evaluate() {
    var m = settingsMode();
    if (m === 'off') { if (S.app) deactivate(); return; }
    var want = m === 'on' || entitiesCount() >= THRESHOLD;
    if (want && !S.app && S.mode !== 'booting') activate();
    else if (!want && S.app && m === 'auto') deactivate();
  }

  // ── theme re-tint — every raster re-mints (rare, cheap) ──────────
  function onThemeChanged() {
    themeStamp++;
    colCache.at = 0;
    if (S.app) { sync(); layoutAtoms(true); }
  }
  window.addEventListener('doomalay:theme-changed', onThemeChanged);
  window.addEventListener('doomalay:theme-applied', onThemeChanged);
  if (window.Settings && window.Settings.onChange) {
    window.Settings.onChange(function (st) {
      if (st && typeof st.worldLayer !== 'undefined') evaluate();
    });
  }
  // atoms count changes → the shells/stars re-layout rides the ticker's
  // layoutAtoms(false) — it reads countsOf() live; nothing to wire.

  function atomsOwned() { return !!S.app; }

  function debugInfo() {
    var sprites = 0, stars = 0, textures = 0;
    S.chats.forEach(function (rec) {
      if (rec.sprite) sprites++;
      if (rec.stars) stars += rec.stars.length;
      if (rec.tex) textures++;
    });
    return { active: !!S.app, mode: S.mode, renderer: S.renderer,
             threshold: THRESHOLD, entities: entitiesCount(),
             sprites: sprites, textures: textures, stars: stars,
             lastError: S.lastError };
  }

  window.World3D = {
    sync: sync,
    evaluate: evaluate,
    atomsOwned: atomsOwned,
    pulse: pulse,
    active: function () { return !!S.app; },
    debug: function () { return debugInfo(); },
    _layoutAtoms: layoutAtoms
  };
})();
