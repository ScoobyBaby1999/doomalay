// lattice.js — v0.85.2 THE EXTRACTED GRID PAINTER (renderer-path Phase 2:
// "OffscreenCanvas the grid painter into a worker" — PLAN-V085 §A).
//
// Everything renderGrid painted — the parallax background tile painter,
// the pattern samplers (mesh spots, stripes, checkers, sunbursts), the
// v0.83.3 lattice cache (per-cell derived records, spec-cached
// samplers/styles, prerendered glow sprites), the v0.85.1 batcher
// (quantized-color buckets, segments as filled quads), the depth bands,
// the shooting-star shuttle, the over-icons routing and the origin dot —
// moved VERBATIM into this ONE file, parameterized so the SAME code runs:
//   · on the MAIN thread (app.js calls Lattice.render(ctx, ctx2, …) —
//     the fallback path, byte-identical to the pre-worker frame), and
//   · inside the gridworker (importScripts('lattice.js') — the canvas
//     bitmaps arrive via transferControlToOffscreen).
// Zero drift by construction: one file, two hosts.
//
// DOM/Settings reads are GONE from the painter: colors/specs/effect
// params arrive in the P blob (built main-side each frame), the camera
// in cam {ox, oy, scale}. The only environment branch is the CANVAS
// FACTORY (OffscreenCanvas in the worker, document.createElement on the
// main thread) and the TEXTURE loader (fetch→createImageBitmap in the
// worker, Image onload on main — both fire Lattice.onTexReady so the
// host repaints once the bumpmap lands).
//
// Exposes: globalThis.Lattice = { render, onTexReady, lastStats, IN_WORKER,
//                                cheapJSON, ORIGIN_RADIUS }
(function () {
  'use strict';

  var IN_WORKER = (typeof document === 'undefined');
  var ROOT = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined' ? self : globalThis);

  // ── constants (moved from app.js) ─────────────────────────────────
  var GRID_BASE = 48;      // base grid spacing in px (at scale 1, gridSize 1)
  var DOT_RADIUS = 1.4;
  var ORIGIN_RADIUS = 12;   // v0.88.2: 5 → 12 — "make the dot marking the
                            // center of the grid noticeably larger than
                            // any variation a collision can make" (the
                            // collision dots cap at 6.9; they share this
                            // dot's theme colors)
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;

  // ── v0.88 THE CHEAP SPEC STRINGIFIER ─────────────────────────────────
  // Both fingerprints (app.js's lattice/canvas gates + THIS file's fpNow/
  // bgTileKey) used to JSON.stringify the whole spec EVERY frame — and a
  // spec can carry a 100s-of-KB texture dataURL (the appearance page's
  // texture picker), so every resting ambient frame re-serialized it, and
  // every settings event re-serialized FIVE of them (the measured ~133ms
  // setState cascade that made the colors pill unusable). The digest:
  // strings ≥ 160 chars (only dataURLs ever get that long) collapse to
  // '#L:len:fnv32' — the fnv is computed ONCE per distinct string object
  // (a string-keyed Map hit is O(1): V8 caches the string's hash after
  // the first probe, and the SAME dataURL string object flows through
  // every call until the user picks a new texture). Small fields still
  // serialize verbatim, so in-place mutations (a stop color drag) still
  // change the digest — the gate stays HONEST, only the dataURL cost
  // dies. Zero drift: this file defines it, both hosts run it, app.js
  // reads it off the export.
  var LONG_MIN = 160;
  var longCache = new Map();      // dataURL string → '#L:len:fnv32'
  function shortenLong(s) {
    var c = longCache.get(s);
    if (c !== undefined) return c;
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    c = '#L:' + s.length + ':' + h.toString(36);
    if (longCache.size > 64) longCache.clear();   // bounded (a texture re-pick floods it)
    longCache.set(s, c);
    return c;
  }
  function cheapJSON(v) {
    if (v === undefined) return '';
    if (v === null) return 'null';
    try {
      return JSON.stringify(v, function (k, val) {
        if (typeof val === 'string' && val.length >= LONG_MIN) return shortenLong(val);
        return val;
      });
    } catch (e) { return String(v); }
  }

  function mkCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  }

  // ── v0.83.3 THE LATTICE CACHE (moved verbatim) ─────────────────────
  var LC = {
    fp: '', gen: 0,
    cfp: '', cgen: 0,
    dot: new Map(), vline: new Map(), hline: new Map(),
    vseg: new Map(), hseg: new Map(),
    dotC: new Map(), vlineC: new Map(), hlineC: new Map(),
    vsegC: new Map(), hsegC: new Map(),
    dotG: new Map(),                      // v0.85.1 (glow wave): per-dot LIFTED glow hexes
    samplers: new Map(), paints: new Map(), sprites: new Map(),
    hits: 0, misses: 0
  };
  function lcKey(a, b) { return (a + 65536) * 131072 + (b + 65536); }
  function lcClearParams() {
    LC.dot.clear(); LC.vline.clear(); LC.hline.clear(); LC.vseg.clear(); LC.hseg.clear();
    LC.dotC.clear(); LC.vlineC.clear(); LC.hlineC.clear(); LC.vsegC.clear(); LC.hsegC.clear();
    LC.dotG.clear();
  }
  function lcClearColors() {
    LC.dotC.clear(); LC.vlineC.clear(); LC.hlineC.clear(); LC.vsegC.clear(); LC.hsegC.clear();
    LC.dotG.clear();
  }
  function lcSampler(spec, fallbackHex) {
    var k = fallbackHex + '|' + (spec ? JSON.stringify(spec) : '');
    var s = LC.samplers.get(k);
    if (s === undefined) { s = makePatternSampler(spec, fallbackHex); LC.samplers.set(k, s); }
    return s;
  }
  function lcPaint(spec, fallbackHex, gctx, w, h) {
    var k = fallbackHex + '|' + (spec ? JSON.stringify(spec) : '') + '|' + w + 'x' + h;
    var v = LC.paints.get(k);
    if (v === undefined) { v = gridPaint(spec, fallbackHex, gctx, w, h); LC.paints.set(k, v); }
    return v;
  }
  function lcGlowSprite(hexColor) {
    var sp = LC.sprites.get(hexColor);
    if (sp) return sp;
    // v0.85.1: the cap — per-dot glows (gradient/pattern dot specs) mint
    // MANY distinct colors; the sprite map would grow unbounded across a
    // long session. 256 live sprites is ~4MB worst-case; a clear drops
    // them all and the next frame re-mints only what's on screen.
    if (LC.sprites.size > 256) LC.sprites.clear();
    var S = 128, c = mkCanvas(S, S);
    var g = c.getContext('2d');
    var rg = g.createRadialGradient(S / 2, S / 2, S / 2 * (0.35 / 2.6), S / 2, S / 2, S / 2);
    rg.addColorStop(0, hexColor);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    sp = { c: c };
    LC.sprites.set(hexColor, sp);
    return sp;
  }

  // ── v0.85.1 the batcher's color quantizer (moved verbatim) ─────────
  var QUANT_COLORS = new Map();
  function quantColor(c) {
    if (typeof c !== 'string' || c.charAt(0) !== '#') return c;
    var q = QUANT_COLORS.get(c);
    if (q !== undefined) return q;
    var m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c);
    if (!m) { QUANT_COLORS.set(c, c); return c; }
    function lv(hh) { return Math.min(255, Math.round(parseInt(hh, 16) / 17) * 17); }
    function h2(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    q = '#' + h2(lv(m[1])) + h2(lv(m[2])) + h2(lv(m[3]));
    if (QUANT_COLORS.size > 4096) QUANT_COLORS.clear();
    QUANT_COLORS.set(c, q);
    return q;
  }

  // ── the stable per-cell hash (moved verbatim) ──────────────────────
  function hashCell(ix, iy) {
    var h = (ix | 0) * 374761393 + (iy | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 1000000) / 1000000;
  }

  // ── helpers (moved verbatim; gridPaint/bgGradientPass take ctx) ────
  function validStopsOf(spec) {
    if (!spec || !Array.isArray(spec.colors)) return [];
    return spec.colors.filter(function (c) { return HEX_RE.test(c); });
  }
  function shadeHex(hex, amt) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var f = function (v) {
      v = Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
      return Math.max(0, Math.min(255, v));
    };
    return '#' + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
  }
  function rgbaStr(hex, a) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function bgGradientPass(stops, dir, angle, gctx, w, h) {
    if (!gctx) return null;
    if (stops.length < 2 || w <= 0 || h <= 0) return null;
    var g = null;
    var half = Math.hypot(w, h) / 2;
    if (dir === 'h') g = gctx.createLinearGradient(0, 0, w, 0);
    else if (dir === 'v') g = gctx.createLinearGradient(0, 0, 0, h);
    else if (dir === 'diag2') g = gctx.createLinearGradient(0, 0, w, h);
    else if (dir === 'radial') g = gctx.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, half);
    else if (dir === 'swirl') {
      if (typeof gctx.createConicGradient === 'function') {
        g = gctx.createConicGradient(240 * Math.PI / 180, w * 0.55, h * 0.45);
      } else return null;
    } else { // 'diag' + 'auto'
      var ang = (dir === 'auto' || typeof angle !== 'number') ? 135 : angle;
      if (ang === 135) g = gctx.createLinearGradient(0, h, w, 0);
      else {
        var rad = (ang - 135) * Math.PI / 180;
        var c = Math.cos(rad), s = Math.sin(rad);
        var dx = (c + s) / Math.SQRT2, dy = (s - c) / Math.SQRT2;
        g = gctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
      }
    }
    for (var i = 0; i < stops.length; i++) g.addColorStop(i / (stops.length - 1), stops[i]);
    return g;
  }
  function gridPaint(spec, fallbackHex, gctx, w, h) {
    if (!gctx) return fallbackHex;
    if (!spec || !Array.isArray(spec.colors)) {
      const s = String(spec == null ? '' : spec);
      return HEX_RE.test(s) ? s : fallbackHex;
    }
    const stops = spec.colors.filter(function (c) { return HEX_RE.test(c); });
    if (!stops.length) return fallbackHex;
    if (stops.length < 2 || w <= 0 || h <= 0) return stops[0];
    var g = bgGradientPass(stops, spec.dir || 'auto',
      (typeof spec.angle === 'number') ? spec.angle : undefined, gctx, w, h);
    if (!g) return stops[0];
    return g;
  }

  // ── v0.54 THE COLOR SPACE — the pattern sampler (moved verbatim) ───
  var MESH_SPOTS = [
    { x: 20, y: 25, f: 55 }, { x: 80, y: 15, f: 50 },
    { x: 75, y: 80, f: 55 }, { x: 15, y: 85, f: 50 },
    { x: 55, y: 8, f: 45 }, { x: 38, y: 55, f: 50 },
    { x: 92, y: 58, f: 48 }, { x: 8, y: 45, f: 52 }
  ];
  var bgView = { tw: 0, th: 0, zx: 1, px: 0, py: 0 };  // the live parallax camera (sampler feed)
  function makePatternSampler(spec, fallbackHex) {
    var stops = validStopsOf(spec);
    if (stops.length < 2) return null;
    var dir = (spec && spec.dir) || 'auto';
    var angle = (typeof spec.angle === 'number') ? spec.angle : 135;
    var rgb = [];
    for (var i = 0; i < stops.length; i++) {
      var m = /^#([0-9a-fA-F]{6})$/.exec(stops[i]);
      if (m) rgb.push(parseInt(m[1], 16));
    }
    if (rgb.length < 2) return null;

    function h2c(v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    function hexAt(idx) {
      var n = rgb[((idx % rgb.length) + rgb.length) % rgb.length];
      return '#' + h2c((n >> 16) & 255) + h2c((n >> 8) & 255) + h2c(n & 255);
    }
    function sampleRGB(t) {
      t = ((t % 1) + 1) % 1;
      var f = t * (rgb.length - 1);
      var i2 = Math.min(rgb.length - 2, Math.floor(f));
      var tt = f - i2;
      var a = rgb[i2], b = rgb[i2 + 1];
      return [
        ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * tt,
        ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * tt,
        (a & 255) + ((b & 255) - (a & 255)) * tt
      ];
    }
    function hex(c) { return '#' + h2c(c[0]) + h2c(c[1]) + h2c(c[2]); }

    function sweepT(lx, ly, tw, th, ang) {
      if (dir === 'h') return lx / tw;
      if (dir === 'v') return ly / th;
      if (dir === 'diag2') return (lx * tw + ly * th) / (tw * tw + th * th);
      if (dir === 'radial') {
        var rdx = lx - tw / 2, rdy = ly - th * 0.35;
        return Math.sqrt(rdx * rdx + rdy * rdy) / (Math.hypot(tw, th) / 2);
      }
      if (dir === 'swirl') {
        var sa = Math.atan2(ly - th * 0.45, lx - tw * 0.55) * 180 / Math.PI;
        return (sa - 240) / 360;
      }
      var a2 = (dir === 'auto') ? 135 : ang;
      if (a2 === 135) return (lx * tw - ly * th + th * th) / (tw * tw + th * th);
      var rad = (a2 - 135) * Math.PI / 180;
      var c = Math.cos(rad), s = Math.sin(rad);
      var dx = (c + s) / Math.SQRT2, dy = (s - c) / Math.SQRT2;
      return 0.5 + ((lx - tw / 2) * dx + (ly - th / 2) * dy) / Math.hypot(tw, th);
    }

    var meshK = Math.max(4, Math.min(MESH_SPOTS.length, stops.length));
    var meshSpots = [];
    for (var mi = 0; mi < meshK; mi++) {
      var cr;
      if (stops.length <= MESH_SPOTS.length) {
        var pn = parseInt(stops[mi % stops.length].slice(1), 16);
        cr = [(pn >> 16) & 255, (pn >> 8) & 255, pn & 255];
      } else {
        cr = sampleRGB(mi / Math.max(1, meshK - 1));
      }
      meshSpots.push({ x: MESH_SPOTS[mi].x / 100, y: MESH_SPOTS[mi].y / 100,
        f: MESH_SPOTS[mi].f / 100, c: cr });
    }
    function meshHex(lx, ly, tw, th) {
      var t160 = 0.5 + ((lx - tw / 2) * ((Math.cos((160 - 135) * Math.PI / 180) + Math.sin((160 - 135) * Math.PI / 180)) / Math.SQRT2) +
        (ly - th / 2) * ((Math.sin((160 - 135) * Math.PI / 180) - Math.cos((160 - 135) * Math.PI / 180)) / Math.SQRT2)) / Math.hypot(tw, th);
      var bc = sampleRGB(t160);
      var acc = [0, 0, 0], wsum = 0;
      var rmax = Math.max(tw, th);
      for (var si = 0; si < meshSpots.length; si++) {
        var sp = meshSpots[si];
        var dx = lx - sp.x * tw, dy = ly - sp.y * th;
        var d = Math.sqrt(dx * dx + dy * dy);
        var r = sp.f * rmax;
        if (d < r) {
          var w = 1 - d / r;
          w = w * w;
          acc[0] += w * sp.c[0]; acc[1] += w * sp.c[1]; acc[2] += w * sp.c[2];
          wsum += w;
        }
      }
      if (wsum <= 0.0001) return hex(bc);
      var blend = Math.min(1, wsum);
      var sc = [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum];
      return hex([bc[0] * (1 - blend) + sc[0] * blend,
        bc[1] * (1 - blend) + sc[1] * blend,
        bc[2] * (1 - blend) + sc[2] * blend]);
    }

    return function (sx, sy) {
      var tw = bgView.tw || 1024, th = bgView.th || 1024, zx = bgView.zx || 1;
      var tw2 = 2 * tw, th2 = 2 * th;
      var bx = ((sx - bgView.px) % tw2 + tw2) % tw2;
      var by = ((sy - bgView.py) % th2 + th2) % th2;
      if (bx > tw) bx = tw2 - bx;
      if (by > th) by = th2 - by;
      var lx = bx / zx, ly = by / zx;
      var bw = tw / zx, bh = th / zx;
      switch (dir) {
        case 'mesh':
          return meshHex(lx, ly, bw, bh);
        case 'pat-navy': {
          var xr = (lx + ly) / Math.SQRT2;
          return hexAt(Math.floor(xr / 28));
        }
        case 'pat-checker': {
          var cyc = Math.max(2, Math.min(8, rgb.length));
          var cell = Math.floor(lx / 32) + Math.floor(ly / 32);
          return hexAt(((cell % cyc) + cyc) % cyc);
        }
        case 'pat-gingham':
          return hexAt(Math.floor(ly / 40) + Math.floor(lx / 40));
        case 'pat-sunburst': {
          var a = Math.atan2(ly - bh, lx - bw / 2) * 180 / Math.PI;
          var wedge = Math.max(3, Math.round(30 / rgb.length));
          var sector = Math.floor((((a % 360) + 360) % 360) / wedge);
          return hexAt(sector);
        }
        case 'pat-pinstripe':
          return hex(sampleRGB(sweepT(lx, ly, bw, bh, 160)));
        default:
          return hex(sampleRGB(sweepT(lx, ly, bw, bh, angle)));
      }
    };
  }

  // ── the TEXTURE loader (environment-branched) ──────────────────────
  // main: Image + onload → onTexReady (the host repaints). worker:
  // fetch(dataURL) → blob → createImageBitmap → onTexReady (the worker
  // posts tex-ready; the main thread sends the next frame).
  var texCache = {};
  var onTexReadyCb = null;
  function texImageFor(url) {
    if (!url || typeof url !== 'string') return null;
    var e = texCache[url];
    if (e) return (e.ready && !e.dead) ? e.img : null;
    e = { img: null, ready: false, dead: false };
    texCache[url] = e;
    if (IN_WORKER) {
      try {
        fetch(url).then(function (r) { return r.blob(); })
          .then(function (b) { return createImageBitmap(b); })
          .then(function (bm) {
            e.img = bm; e.ready = true;
            bgCache = { key: '', tile: null };   // the tile must rebuild WITH the texture
            if (onTexReadyCb) onTexReadyCb();
          })
          .catch(function () { e.dead = true; });
      } catch (err) { e.dead = true; }
      return null;
    }
    var img = new Image();
    e.img = img;
    img.onload = function () {
      e.ready = true;
      bgCache = { key: '', tile: null };   // the tile must rebuild WITH the texture
      if (onTexReadyCb) onTexReadyCb();
    };
    img.onerror = function () { e.dead = true; };
    img.src = url;
    return null;
  }

  // ── v0.52 THE PARALLAX BACKGROUND (moved verbatim; P.bgP replaces the
  //    Settings read; mkCanvas replaces document.createElement) ───────
  var bgCache = { key: '', tile: null };
  var BG_TILE_MULT = 2;
  function bgTileKey(spec, fallbackHex, tw, th) {
    var s = '';
    try { s = cheapJSON(spec); } catch (e) { s = String(spec); }
    return s + '|' + tw + 'x' + th + '|' + fallbackHex;
  }
  function bgTileFor(spec, fallbackHex, tw, th) {
    var key = bgTileKey(spec, fallbackHex, tw, th);
    if (bgCache.key === key && bgCache.tile) return bgCache.tile;
    var off = mkCanvas(tw, th);
    paintBackgroundInto(off.getContext('2d'), spec, fallbackHex, tw, th);
    bgCache = { key: key, tile: off };
    return off;
  }
  function paintCanvasBackground(gctx, spec, fallbackHex, W, H, BG_P, scale, offsetX, offsetY) {
    var TW = Math.max(16, Math.round(W * BG_TILE_MULT));
    var TH = Math.max(16, Math.round(H * BG_TILE_MULT));
    var tile = bgTileFor(spec, fallbackHex, TW, TH);
    var zx = Math.max(1, 1 + (scale - 1) * BG_P);
    var tw = TW * zx, th = TH * zx;
    var px = ((-offsetX * scale * BG_P) % (2 * tw) + 2 * tw) % (2 * tw);
    var py = ((-offsetY * scale * BG_P) % (2 * th) + 2 * th) % (2 * th);
    bgView = { tw: tw, th: th, zx: zx, px: px, py: py };
    for (var ix = 0; ; ix++) {
      var x0 = px - 2 * tw + ix * tw;
      if (x0 >= W) break;
      var flipX = (ix % 2 === 1);
      for (var iy = 0; ; iy++) {
        var y0 = py - 2 * th + iy * th;
        if (y0 >= H) break;
        var flipY = (iy % 2 === 1);
        gctx.save();
        gctx.translate(flipX ? x0 + tw : x0, flipY ? y0 + th : y0);
        gctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        gctx.drawImage(tile, 0, 0, tw, th);
        gctx.restore();
        if (y0 + th >= H) break;
      }
      if (x0 + tw >= W) break;
    }
  }
  function paintBackgroundInto(gctx, spec, fallbackHex, tw, th) {
    tw = tw || 512; th = th || 512;
    var stops = validStopsOf(spec);
    var dir = (spec && spec.dir) || 'auto';
    var texUrl = (spec && typeof spec.tex === 'string') ? spec.tex : '';
    var texImg = texImageFor(texUrl);
    if (!stops.length && !texImg) {
      gctx.fillStyle = HEX_RE.test(spec == null ? '' : String(spec)) ? String(spec) : fallbackHex;
      if (spec && Array.isArray(spec.colors) && HEX_RE.test(fallbackHex)) gctx.fillStyle = fallbackHex;
      gctx.fillRect(0, 0, tw, th);
      return;
    }
    if (texImg) {
      var ir = texImg.width / texImg.height;
      var vr = tw / th;
      var dw, dh;
      if (ir > vr) { dh = th; dw = th * ir; } else { dw = tw; dh = tw / ir; }
      gctx.drawImage(texImg, (tw - dw) / 2, (th - dh) / 2, dw, dh);
      gctx.globalCompositeOperation = 'color';
    }
    var c = stops.length ? stops : ['#0a0a0b'];
    var c0 = c[0];
    var c1 = c.length > 1 ? c[1] : null;
    var paintPlain = function () {
      var g = bgGradientPass(c, dir, spec && spec.angle, gctx, tw, th);
      gctx.fillStyle = g || c0;
      gctx.fillRect(0, 0, tw, th);
    };
    if (dir === 'mesh') {
      var meshK = Math.max(4, Math.min(MESH_SPOTS.length, c.length));
      var base = c.length > 1 ? c[c.length - 1] : shadeHex(c0, -0.2);
      gctx.fillStyle = bgGradientPass([c0, base], 'diag', 160, gctx, tw, th) || base;
      gctx.fillRect(0, 0, tw, th);
      var rmax = Math.max(tw, th);
      for (var i = 0; i < meshK; i++) {
        var sp = MESH_SPOTS[i];
        var sx = tw * sp.x / 100, sy = th * sp.y / 100;
        var rg = gctx.createRadialGradient(sx, sy, 0, sx, sy, rmax * sp.f / 100);
        rg.addColorStop(0, c[i % c.length]);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        gctx.fillStyle = rg;
        gctx.fillRect(0, 0, tw, th);
      }
    } else if (dir === 'pat-navy') {
      var nc = c.length > 1 ? c : [c[0], shadeHex(c0, -0.18)];
      gctx.fillStyle = nc[0];
      gctx.fillRect(0, 0, tw, th);
      gctx.save();
      gctx.translate(tw / 2, th / 2);
      gctx.rotate(-Math.PI / 4);
      var span = Math.hypot(tw, th);
      var swid = 28 / nc.length;
      for (var nb = 0; nb < nc.length; nb++) {
        gctx.fillStyle = nc[nb];
        for (var b = -span + nb * 28; b < span; b += 28 * nc.length) {
          gctx.fillRect(b, -span, swid, span * 2);
        }
      }
      gctx.restore();
    } else if (dir === 'pat-pinstripe') {
      var p2 = c1 || shadeHex(c0, 0.18);
      gctx.fillStyle = bgGradientPass([c0, c[c.length - 1]], 'diag', 160, gctx, tw, th) || c0;
      gctx.fillRect(0, 0, tw, th);
      gctx.strokeStyle = rgbaStr(c0, 0.35);
      gctx.lineWidth = 1;
      for (var ps2 = 9; ps2 < tw; ps2 += 18) {
        gctx.beginPath();
        gctx.moveTo(ps2, 0);
        gctx.lineTo(ps2, th);
        gctx.stroke();
      }
    } else if (dir === 'pat-gingham') {
      var gEven = [], gOdd = [];
      for (var gi = 0; gi < c.length; gi++) (gi % 2 === 0 ? gEven : gOdd).push(c[gi]);
      if (c.length > 3) {
        if (gEven[gEven.length - 1] === c[c.length - 1]) gEven.pop();
        else if (gOdd[gOdd.length - 1] === c[c.length - 1]) gOdd.pop();
      }
      var gBase = c.length > 3 ? c[c.length - 1]
        : (c.length > 2 ? c[2] : shadeHex(c0, 0.30));
      gctx.fillStyle = gBase;
      gctx.fillRect(0, 0, tw, th);
      for (var hb = 0; hb < gEven.length; hb++) {
        gctx.fillStyle = rgbaStr(gEven[hb], 0.55);
        for (var gy = hb * 80; gy < th; gy += 80 * gEven.length) gctx.fillRect(0, gy, tw, 40);
      }
      for (var vb = 0; vb < gOdd.length; vb++) {
        gctx.fillStyle = rgbaStr(gOdd[vb], 0.35);
        for (var gx = vb * 80; gx < tw; gx += 80 * gOdd.length) gctx.fillRect(gx, 0, 40, th);
      }
    } else if (dir === 'pat-sunburst') {
      var sc = c.length > 1 ? c : [c[0], shadeHex(c0, 0.18)];
      var cx = tw / 2, cy = th;
      var span2 = Math.hypot(tw, th);
      var wedge = Math.max(3, Math.round(30 / sc.length));
      gctx.fillStyle = sc[0];
      gctx.fillRect(0, 0, tw, th);
      for (var a = 0; a < 360; a += wedge) {
        var ri = (a / wedge) % sc.length;
        gctx.fillStyle = sc[ri];
        var r0 = a * Math.PI / 180, r1 = (a + wedge) * Math.PI / 180;
        gctx.beginPath();
        gctx.moveTo(cx, cy);
        gctx.lineTo(cx + Math.cos(r0) * span2, cy + Math.sin(r0) * span2);
        gctx.lineTo(cx + Math.cos(r1) * span2, cy + Math.sin(r1) * span2);
        gctx.closePath();
        gctx.fill();
      }
    } else if (dir === 'pat-checker') {
      var cyc2 = Math.max(2, Math.min(8, c.length));
      for (var cy2 = 0, row = 0; cy2 < th; cy2 += 32, row++) {
        for (var cx2 = 0, col = 0; cx2 < tw; cx2 += 32, col++) {
          gctx.fillStyle = c[((row + col) % cyc2 + cyc2) % cyc2];
          gctx.fillRect(cx2, cy2, 32, 32);
        }
      }
    } else {
      paintPlain();
    }
    if (texImg) {
      gctx.globalCompositeOperation = 'source-over';
    }
  }

  // ── the rolling fps instrument (frame-to-frame arrival cadence) ────
  var lcFps = 0, lcLastT = 0;

  // ══ THE RENDER — the verbatim renderGrid body, parameterized ═══════
  // P: {specs, t, canvasSpec, bgFallback, gridSize, hideLines, hideDots,
  //     scatterL, scatterD, sizeVarL, sizeVarD, rotVarL, rotVarD,
  //     biasL, biasD, animDots, animLines, amp (0..1), bgP (0.08..0.35)}
  // cam: {ox, oy, scale}
  function render(gctx, gctx2, W, H, cam, P) {
    var t0 = performance.now();
    var offsetX = cam.ox, offsetY = cam.oy, scale = cam.scale;
    var t = P.t, specs = P.specs, st = P;

    paintCanvasBackground(gctx, P.canvasSpec, P.bgFallback, W, H, P.bgP, scale, offsetX, offsetY);

    var amp = P.amp;
    var hideLines = !!P.hideLines;
    var hideDots = !!P.hideDots;
    var scatterL = P.scatterL, scatterD = P.scatterD;
    var sizeVarL = P.sizeVarL, sizeVarD = P.sizeVarD;
    var rotVarL = P.rotVarL, rotVarD = P.rotVarD;
    var biasL = P.biasL, biasD = P.biasD;
    var animDots = !!P.animDots;
    var animLines = !!P.animLines;
    var scatterPxL = scatterL * 0.6;
    var scatterPxD = scatterD * 0.6;
    var sizeFracL = sizeVarL / 100 * 3.4;
    var sizeFracD = sizeVarD / 100 * 3.4;
    var effFracL = Math.max(sizeFracL, Math.abs(biasL) / 100 * 1.7);
    var effFracD = Math.max(sizeFracD, Math.abs(biasD) / 100 * 1.7);
    var rotDegL = rotVarL * 0.6;
    var rotDegD = rotVarD * 0.6;
    var bExpL = Math.pow(2, -2.5 * (biasL / 100));
    var bExpD = Math.pow(2, -2.5 * (biasD / 100));
    function warpL(h) { return bExpL === 1 ? h : Math.pow(h, bExpL); }
    function warpD(h) { return bExpD === 1 ? h : Math.pow(h, bExpD); }
    var dotSpec = specs && specs.dotColor;
    var dotFallback = (HEX_RE.test(t.dotColor || '')) ? t.dotColor : '#2e2e3a';
    var lineSpec2 = specs && specs.lineColor;
    var lineFallback2 = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
    var fpNow = [scatterL, scatterD, sizeVarL, sizeVarD, rotVarL, rotVarD,
      biasL, biasD, animDots ? 1 : 0, animLines ? 1 : 0,
      scale.toFixed(4), P.gridSize, hideLines ? 1 : 0, hideDots ? 1 : 0,
      amp.toFixed(4), W, H,
      dotSpec ? cheapJSON(dotSpec) : '', dotFallback,
      lineSpec2 ? cheapJSON(lineSpec2) : '', lineFallback2].join('|');
    if (fpNow !== LC.fp) { LC.fp = fpNow; LC.gen++; lcClearParams(); }
    var cfpNow = fpNow + '|' + offsetX.toFixed(2) + ',' + offsetY.toFixed(2);
    if (cfpNow !== LC.cfp) { LC.cfp = cfpNow; LC.cgen++; lcClearColors(); }
    var animT = performance.now() / 1000;
    var dbgDots = 0, dbgSegs = 0;
    // v0.85.1: the glow twin (the rig proves the per-dot derivation: how
    // many dots glowed this frame + the DISTINCT colors they used — a
    // gradient dot spec must mint >1 color; a solid theme exactly 1).
    var dbgGlow = 0, dbgGlowCols = [];
    var dbgDotSmall = 0, dbgDotBig = 0, dbgLineSmall = 0, dbgLineBig = 0;
    var dbgFullLines = 0;
    var dbgJrMin = Infinity, dbgJrMax = 0, dbgWMin = Infinity, dbgWMax = 0;

    const scaledGrid = GRID_BASE * (P.gridSize || 1) * scale;
    const startX = ((-offsetX * scale) % scaledGrid + scaledGrid) % scaledGrid;
    const startY = ((-offsetY * scale) % scaledGrid + scaledGrid) % scaledGrid;
    const dStartX = startX;
    const dStartY = startY;

    // ── v0.77.9 THE DEPTH-BAND MACHINERY ─────────────────────────────
    var AMP_BANDS = 5;
    var bandSpread = function (k) { return -0.85 + 1.5 * (k / (AMP_BANDS - 1)); };
    var bandPF = function (k) { return 1 + amp * (0.25 + 0.75 * bandSpread(k)); };
    var bandStart = function (off, pf, grid) {
      return ((-off * scale * pf) % grid + grid) % grid;
    };
    var depthT = function (h, sizeFrac) { return sizeFrac > 0.02 ? h : 0.5; };
    var bandOf = function (tt) {
      var k = Math.floor(tt * AMP_BANDS);
      return k < 0 ? 0 : (k >= AMP_BANDS ? AMP_BANDS - 1 : k);
    };
    // v0.83.3: the glow tint derives from the DOT'S OWN solid paint (the
    // light-lifted tone — the v0.77 intent). The old code read ctx.fillStyle
    // at frame start, which was whatever painted LAST the previous frame.
    // v0.85.1 THE GLOW THEME WAVE (user spec: "Larger animated dots that
    // glow in the canvas panel don't follow theme colors nor does their
    // glow"): the spec-scope derivation had a real hole — for a 2+-stop
    // gradient dot color gridPaint returns a CanvasGradient OBJECT, so
    // the string test failed and the glow was NULL: the glow + the lifted
    // tone VANISHED entirely on gradient dot colors; for mesh/pat specs it
    // collapsed to stops[0] — every glow dot painted the FIRST stop while
    // the regular dots sampled the pattern per-dot. THE FIX: the glow
    // derives from each DOT'S OWN COLOR at paint time — the per-cell
    // sampled color (colD, the exact color the dot already paints, cached
    // in LC.dotC) when a sampler is live, else the spec's solid. Per-dot
    // lifted hexes cache in LC.dotG (cleared with the color caches); halo
    // sprites stay per-color (lcGlowSprite, capped). Now the cores AND the
    // halos follow EVERY dot-color source: theme solids, user gradients,
    // mesh, patterns.
    var dotSolidFill = lcPaint(dotSpec, dotFallback, gctx, W, H);
    var specGlowFill = null;
    if (typeof dotSolidFill === 'string' && HEX_RE.test(dotSolidFill)) {
      specGlowFill = shadeHex(dotSolidFill, 0.42);
    }
    var dotSampler = lcSampler(dotSpec, dotFallback);
    var dotRBase = Math.max(0.6, DOT_RADIUS * Math.min(scale, 1.3));

    // ── v0.81.2 THE OVER-ICONS LAYER ────────────────────────────
    var overDotsOn = !!(gctx2 && amp >= 0.5 && effFracD > 0.02);
    var overLinesOn = !!(gctx2 && amp >= 0.5 && effFracL > 0.02);
    var overThreshD = 0.7 * dotRBase * (1 + effFracD);
    var overThreshL = 0.7 * (1 + effFracL);
    var dbgOverDots = 0, dbgOverLines = 0;
    if (gctx2) gctx2.clearRect(0, 0, W, H);

    // ── v0.77 THE SHOOTING-STAR SHUTTLE ──────────────────────────
    function shuttleP(p) {
      var u = ((animT + p.ph) / p.dur) % 2;
      var legFwd = u < 1;
      var s = legFwd ? u : 2 - u;
      var k = legFwd ? p.kF : p.kB;
      var eased = (Math.exp(k * s) - 1) / ((legFwd ? p.ekF : p.ekB) - 1);
      var travel = eased - 0.5;
      return { off: p.dir * p.dist * travel, spd: Math.exp(k * (s - 1)) };
    }
    function shuttleRec(hx, hy) {
      var dur = 1.6 + hashCell(hx + 17, hy + 17) * 2.4;
      var kF = 2.6 + hashCell(hx + 19, hy + 19) * 1.6;
      var kB = 2.2 + hashCell(hx + 21, hy + 21) * 1.6;
      return {
        dur: dur, kF: kF, kB: kB, ekF: Math.exp(kF), ekB: Math.exp(kB),
        dist: 0.8 + hashCell(hx + 23, hy + 23) * 1.2,
        dir: hashCell(hx + 25, hy + 25) < 0.5 ? -1 : 1,
        ph: hashCell(hx + 27, hy + 27) * dur
      };
    }

    // v0.85.1 THE BATCHER (see app.js's pre-extraction comments)
    var segBuckets = new Map();
    var dotBuckets = new Map();
    var dbgBatches = 0;
    var lineBands = amp > 0 ? AMP_BANDS : 1;
    var dbgLineBands = [];
    if (!hideLines) {
     for (var lb = 0; lb < lineBands; lb++) {
      var lPF = lineBands === 1 ? 1 : bandPF(lb);
      var lStartX = lineBands === 1 ? startX : bandStart(offsetX, lPF, scaledGrid);
      var lStartY = lineBands === 1 ? startY : bandStart(offsetY, lPF, scaledGrid);
      var lBandN = 0;
      var lineSpec = specs && specs.lineColor;
      var lineFallback = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
      var lineBandStyle = lcPaint(lineSpec, lineFallback, gctx, W, H);
      gctx.strokeStyle = lineBandStyle;
      gctx.lineWidth = 1;
      var lineSampler = lcSampler(lineSpec, lineFallback);
      var lineIdx = 0;
      var segMode = effFracL > 0 || animLines;
      var baseSegLen = scaledGrid * 1.35;
      for (let x = lStartX; x < W; x += scaledGrid) {
        var ix = Math.round((x + offsetX * scale * lPF) / scaledGrid);
        var LP = LC.vline.get(ix);
        if (LP === undefined) {
          var lwH = warpL(hashCell(ix, 2));
          var rotD = rotDegL * (hashCell(ix, 1) - 0.5) * 2;
          var rr = rotD * Math.PI / 180;
          LP = {
            dx: scatterPxL * (hashCell(ix, 0) - 0.5) * 2,
            lwB: 1 * (1 + effFracL * (lwH - 0.5) * 2),
            band: bandOf(depthT(lwH, effFracL)),
            c: Math.cos(rr), s: Math.sin(rr)
          };
          LC.vline.set(ix, LP);
          if (LC.vline.size > 8192) LC.vline.clear();
        }
        if (lineBands > 1 && LP.band !== lb) continue;
        lBandN++;
        if (LP.lwB < 0.9) dbgLineSmall++; else if (LP.lwB > 1.1) dbgLineBig++;
        var lc = (overLinesOn && !segMode && LP.lwB > overThreshL) ? gctx2 : gctx;
        if (lc === gctx2) dbgOverLines++;
        var tx = x + LP.dx;
        if (!segMode) {
          var colL = LC.vlineC.get(ix);
          if (colL === undefined) { colL = lineSampler ? lineSampler(x, H / 2) : null; LC.vlineC.set(ix, colL); LC.misses++; } else LC.hits++;
          dbgFullLines++;
          var styleL = quantColor(colL || lineBandStyle);
          var lwFull = Math.max(0.3, LP.lwB);
          var pxv = LP.c * lwFull / 2, pyv = LP.s * lwFull / 2;
          var fbk = (lc === gctx2 ? '2|' : '1|') + styleL;
          var fb = segBuckets.get(fbk);
          if (!fb) { fb = { sc: lc, s: styleL, a: 1, ops: [] }; segBuckets.set(fbk, fb); }
          fb.ops.push(tx - pxv, 0 - pyv, tx + pxv, 0 + pyv,
                      (tx - H * LP.s) + pxv, H * LP.c + pyv, (tx - H * LP.s) - pxv, H * LP.c - pyv);
        } else {
          for (let y = lStartY - scaledGrid; y < H + scaledGrid; y += scaledGrid) {
            var iyS = Math.round((y + offsetY * scale * lPF) / scaledGrid);
            var skey = lcKey(ix, iyS);
            var SP = LC.vseg.get(skey);
            if (SP === undefined) {
              SP = {
                len: (animLines && effFracL === 0)
                  ? scaledGrid * (0.30 + hashCell(ix + 31, iyS + 33) * 0.55)
                  : Math.max(scaledGrid * 0.06,
                      (effFracL > 0 ? scaledGrid : baseSegLen) * (1 + effFracL * (warpL(hashCell(ix + 5, iyS)) - 0.5) * 2)),
                w: Math.max(0.12,
                  (animLines ? (0.9 + hashCell(ix + 35, iyS + 37) * 0.9) : 1) *
                  (1 + effFracL * (warpL(hashCell(ix + 9, iyS)) - 0.5) * 2)),
                sh: shuttleRec(ix + 41, iyS + 43)
              };
              LC.vseg.set(skey, SP);
              if (LC.vseg.size > 24576) LC.vseg.clear();
            }
            var segW = SP.w;
            if (segW < 0.9) dbgLineSmall++; else if (segW > 1.1) dbgLineBig++;
            if (segW < dbgWMin) dbgWMin = segW;
            if (segW > dbgWMax) dbgWMax = segW;
            var drift = 0, tal = 1;
            if (animLines) {
              var sh = shuttleP(SP.sh);
              drift = sh.off * scaledGrid;
              tal = 0.42 + 0.58 * sh.spd;
            }
            var sc = (overLinesOn && segW > overThreshL) ? gctx2 : gctx;
            if (sc === gctx2) dbgOverLines++;
            var colS = LC.vsegC.get(skey);
            if (colS === undefined) { colS = lineSampler ? lineSampler(x, y) : null; LC.vsegC.set(skey, colS); LC.misses++; } else LC.hits++;
            var styleS = quantColor(colS || lineBandStyle);
            var aQ = tal < 1 ? Math.round(tal * 10) / 10 : 1;
            var sbk = (sc === gctx2 ? '2|' : '1|') + styleS + '|' + aQ;
            var sb = segBuckets.get(sbk);
            if (!sb) { sb = { sc: sc, s: styleS, a: aQ, ops: [] }; segBuckets.set(sbk, sb); }
            var ly1 = y - SP.len / 2 + drift, ly2 = y + SP.len / 2 + drift;
            var ax1 = tx - ly1 * LP.s, ay1 = ly1 * LP.c;
            var ax2 = tx - ly2 * LP.s, ay2 = ly2 * LP.c;
            var pxs = LP.c * segW / 2, pys = LP.s * segW / 2;
            sb.ops.push(ax1 - pxs, ay1 - pys, ax1 + pxs, ay1 + pys,
                        ax2 + pxs, ay2 + pys, ax2 - pxs, ay2 - pys);
            dbgSegs++;
          }
        }
        lineIdx++;
      }
      for (let y = lStartY; y < H; y += scaledGrid) {
        var iy = Math.round((y + offsetY * scale * lPF) / scaledGrid);
        var HP = LC.hline.get(iy);
        if (HP === undefined) {
          var lw2H = warpL(hashCell(2, iy));
          var rot2D = rotDegL * (hashCell(1, iy) - 0.5) * 2;
          var rr2 = rot2D * Math.PI / 180;
          HP = {
            dy: scatterPxL * (hashCell(0, iy) - 0.5) * 2,
            lwB: 1 * (1 + effFracL * (lw2H - 0.5) * 2),
            band: bandOf(depthT(lw2H, effFracL)),
            c: Math.cos(rr2), s: Math.sin(rr2)
          };
          LC.hline.set(iy, HP);
          if (LC.hline.size > 8192) LC.hline.clear();
        }
        if (lineBands > 1 && HP.band !== lb) continue;
        lBandN++;
        if (HP.lwB < 0.9) dbgLineSmall++; else if (HP.lwB > 1.1) dbgLineBig++;
        var lc2 = (overLinesOn && !segMode && HP.lwB > overThreshL) ? gctx2 : gctx;
        if (lc2 === gctx2) dbgOverLines++;
        var ty = y + HP.dy;
        if (!segMode) {
          var colL2 = LC.hlineC.get(iy);
          if (colL2 === undefined) { colL2 = lineSampler ? lineSampler(W / 2, y) : null; LC.hlineC.set(iy, colL2); LC.misses++; } else LC.hits++;
          dbgFullLines++;
          var styleL2 = quantColor(colL2 || lineBandStyle);
          var lwFull2 = Math.max(0.3, HP.lwB);
          var pxh = -HP.s * lwFull2 / 2, pyh = HP.c * lwFull2 / 2;
          var fbk2 = (lc2 === gctx2 ? '2|' : '1|') + styleL2;
          var fb2 = segBuckets.get(fbk2);
          if (!fb2) { fb2 = { sc: lc2, s: styleL2, a: 1, ops: [] }; segBuckets.set(fbk2, fb2); }
          fb2.ops.push(0 - pxh, ty - pyh, 0 + pxh, ty + pyh,
                       W * HP.c + pxh, ty + W * HP.s + pyh, W * HP.c - pxh, ty + W * HP.s - pyh);
        } else {
          for (let x2 = lStartX - scaledGrid; x2 < W + scaledGrid; x2 += scaledGrid) {
            var ixS = Math.round((x2 + offsetX * scale * lPF) / scaledGrid);
            var hkey = lcKey(ixS, iy);
            var HS = LC.hseg.get(hkey);
            if (HS === undefined) {
              HS = {
                len: (animLines && effFracL === 0)
                  ? scaledGrid * (0.30 + hashCell(ixS + 33, iy + 31) * 0.55)
                  : Math.max(scaledGrid * 0.06,
                      (effFracL > 0 ? scaledGrid : baseSegLen) * (1 + effFracL * (warpL(hashCell(ixS, iy + 5)) - 0.5) * 2)),
                w: Math.max(0.12,
                  (animLines ? (0.9 + hashCell(ixS + 37, iy + 35) * 0.9) : 1) *
                  (1 + effFracL * (warpL(hashCell(ixS, iy + 9)) - 0.5) * 2)),
                sh: shuttleRec(ixS + 47, iy + 49)
              };
              LC.hseg.set(hkey, HS);
              if (LC.hseg.size > 24576) LC.hseg.clear();
            }
            var segW2 = HS.w;
            if (segW2 < 0.9) dbgLineSmall++; else if (segW2 > 1.1) dbgLineBig++;
            if (segW2 < dbgWMin) dbgWMin = segW2;
            if (segW2 > dbgWMax) dbgWMax = segW2;
            var drift2 = 0, tal2 = 1;
            if (animLines) {
              var sh2 = shuttleP(HS.sh);
              drift2 = sh2.off * scaledGrid;
              tal2 = 0.42 + 0.58 * sh2.spd;
            }
            var sc2 = (overLinesOn && segW2 > overThreshL) ? gctx2 : gctx;
            if (sc2 === gctx2) dbgOverLines++;
            var colS2 = LC.hsegC.get(hkey);
            if (colS2 === undefined) { colS2 = lineSampler ? lineSampler(x2, y) : null; LC.hsegC.set(hkey, colS2); LC.misses++; } else LC.hits++;
            var styleS2 = quantColor(colS2 || lineBandStyle);
            var aQ2 = tal2 < 1 ? Math.round(tal2 * 10) / 10 : 1;
            var sbk2 = (sc2 === gctx2 ? '2|' : '1|') + styleS2 + '|' + aQ2;
            var sb2 = segBuckets.get(sbk2);
            if (!sb2) { sb2 = { sc: sc2, s: styleS2, a: aQ2, ops: [] }; segBuckets.set(sbk2, sb2); }
            var lx1 = x2 - HS.len / 2 + drift2, lx2 = x2 + HS.len / 2 + drift2;
            var bx1 = lx1 * HP.c, by1 = ty + lx1 * HP.s;
            var bx2 = lx2 * HP.c, by2 = ty + lx2 * HP.s;
            var pxs2 = -HP.s * segW2 / 2, pys2 = HP.c * segW2 / 2;
            sb2.ops.push(bx1 - pxs2, by1 - pys2, bx1 + pxs2, by1 + pys2,
                         bx2 + pxs2, by2 + pys2, bx2 - pxs2, by2 - pys2);
            dbgSegs++;
          }
        }
      }
      dbgLineBands.push(lBandN);
     }
    }
    // v0.85.1: FLUSH THE SEGMENT BUCKETS
    if (segBuckets.size && segBuckets.size <= 640) {
      segBuckets.forEach(function (bk) {
        var sc = bk.sc;
        sc.fillStyle = bk.s;
        if (bk.a < 1) sc.globalAlpha = bk.a;
        sc.beginPath();
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 8) {
          sc.moveTo(ops[oi], ops[oi + 1]);
          sc.lineTo(ops[oi + 2], ops[oi + 3]);
          sc.lineTo(ops[oi + 4], ops[oi + 5]);
          sc.lineTo(ops[oi + 6], ops[oi + 7]);
          sc.closePath();
        }
        sc.fill();
        if (bk.a < 1) sc.globalAlpha = 1;
        dbgBatches++;
      });
    } else if (segBuckets.size) {
      segBuckets.forEach(function (bk) {
        var sc = bk.sc;
        sc.fillStyle = bk.s;
        if (bk.a < 1) sc.globalAlpha = bk.a;
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 8) {
          sc.beginPath();
          sc.moveTo(ops[oi], ops[oi + 1]);
          sc.lineTo(ops[oi + 2], ops[oi + 3]);
          sc.lineTo(ops[oi + 4], ops[oi + 5]);
          sc.lineTo(ops[oi + 6], ops[oi + 7]);
          sc.closePath();
          sc.fill();
        }
        if (bk.a < 1) sc.globalAlpha = 1;
        dbgBatches++;
      });
    }

    // ── the dot passes ─────────────────────────────────────────────
    var dotBands = amp > 0 ? AMP_BANDS : 1;
    var dbgDotBands = [];
    if (!hideDots) {
     for (var db = 0; db < dotBands; db++) {
      var dPF = dotBands === 1 ? 1 : bandPF(db);
      var dStartX2 = dotBands === 1 ? dStartX : bandStart(offsetX, dPF, scaledGrid);
      var dStartY2 = dotBands === 1 ? dStartY : bandStart(offsetY, dPF, scaledGrid);
      var dBandN = 0;
      gctx.fillStyle = dotSolidFill;
      const dotR = dotRBase;
      for (let x = dStartX2; x < W; x += scaledGrid) {
        for (let y = dStartY2; y < H; y += scaledGrid) {
          var dix = Math.round((x + offsetX * scale * dPF) / scaledGrid);
          var diy = Math.round((y + offsetY * scale * dPF) / scaledGrid);
          var dkey = lcKey(dix, diy);
          var DP = LC.dot.get(dkey);
          if (DP === undefined) {
            var hd = hashCell(dix, diy);
            var hd2 = warpD(hashCell(dix + 7, diy + 7));
            DP = {
              jx: scatterPxD * (hd - 0.5) * 2,
              jy: scatterPxD * (hashCell(dix + 3, diy + 5) - 0.5) * 2,
              jrB: dotR * (1 + effFracD * (hd2 - 0.5) * 2),
              band: bandOf(depthT(hd2, effFracD))
            };
            if (animDots) {
              DP.tsp = 0.5 + hashCell(dix + 21, diy + 21) * 1.8;
              DP.tph = hashCell(dix + 23, diy + 23) * 6.283;
              DP.ospd = (0.25 + hashCell(dix + 27, diy + 27) * 0.9)
                        * (hashCell(dix + 29, diy + 29) < 0.5 ? -1 : 1);
              DP.orR = scaledGrid * (0.06 + 0.08 * hashCell(dix + 31, diy + 31));
            }
            LC.dot.set(dkey, DP);
            if (LC.dot.size > 24576) LC.dot.clear();
          }
          if (dotBands > 1 && DP.band !== db) continue;
          dBandN++;
          var jr = DP.jrB;
          if (jr < dotRBase * 0.9) dbgDotSmall++; else if (jr > dotRBase * 1.1) dbgDotBig++;
          var jrRaw = jr / dotRBase;
          if (jrRaw < dbgJrMin) dbgJrMin = jrRaw;
          if (jrRaw > dbgJrMax) dbgJrMax = jrRaw;
          var dc = (overDotsOn && jr > overThreshD) ? gctx2 : gctx;
          if (dc === gctx2) dbgOverDots++;
          var tox = 0, toy = 0, tal = 1;
          if (animDots) {
            var pulse = Math.sin(animT * DP.tsp + DP.tph);
            jr *= 1 + 0.4 * pulse;
            tal = 0.62 + 0.38 * (0.5 + 0.5 * pulse);
            var orA = animT * DP.ospd + DP.tph;
            tox = Math.cos(orA) * DP.orR; toy = Math.sin(orA) * DP.orR;
          }
          var colD = LC.dotC.get(dkey);
          if (colD === undefined) { colD = dotSampler ? dotSampler(x + DP.jx, y + DP.jy) : null; LC.dotC.set(dkey, colD); LC.misses++; } else LC.hits++;
          var styleD = quantColor(colD || dotSolidFill);
          // v0.85.1 (glow wave): the glow tint is PER-DOT — this dot's
          // lifted color, derived from its OWN paint color (colD when a
          // sampler is live, else the spec solid), cached in LC.dotG with
          // the same invalidation as colD. Gradient/mesh/pattern dot
          // colors now glow in their own per-dot colors (the v0.83.3
          // spec-scope glowFill silently killed the glow on gradient specs
          // and flattened it to stops[0] on patterns).
          var isGlowCand = dotBands > 1 && db === AMP_BANDS - 1 && jr >= dotRBase * 1.6;
          var glowFill = undefined;
          if (isGlowCand) {
            glowFill = LC.dotG.get(dkey);          // undefined | hex | false
            if (glowFill === undefined) {
              var gbase = (typeof colD === 'string' && HEX_RE.test(colD)) ? colD : null;
              if (gbase !== null) glowFill = shadeHex(gbase, 0.42);
              else if (specGlowFill) glowFill = specGlowFill;
              else glowFill = false;               // no derivable color — glow-less
              LC.dotG.set(dkey, glowFill);
            }
            if (!glowFill) glowFill = null;
          }
          var nearGlow = isGlowCand && !!glowFill;
          var cx = x + DP.jx + tox, cy = y + DP.jy + toy;
          var rrD = Math.max(0.15, jr);
          if (nearGlow) {
            dc.fillStyle = glowFill;
            if (tal < 1) dc.globalAlpha = tal;
            if (jr >= 1.6) {
              var spG = lcGlowSprite(glowFill);
              var R = jr * 2.6;
              var ga2 = dc.globalAlpha;
              dc.globalAlpha = ga2 * 0.55;
              dc.drawImage(spG.c, cx - R, cy - R, R * 2, R * 2);
              dc.globalAlpha = ga2;
            }
            dc.beginPath();
            dc.arc(cx, cy, rrD, 0, Math.PI * 2);
            dc.fill();
            if (tal < 1) dc.globalAlpha = 1;
          } else {
            var aQ = tal < 1 ? Math.round(tal * 8) / 8 : 1;
            var dbk = (dc === gctx2 ? '2|' : '1|') + styleD + '|' + aQ;
            var dob = dotBuckets.get(dbk);
            if (!dob) { dob = { dc: dc, s: styleD, a: aQ, ops: [] }; dotBuckets.set(dbk, dob); }
            dob.ops.push(cx, cy, rrD);
          }
          dbgDots++;
          if (nearGlow) {
            dbgGlow++;
            if (dbgGlowCols.indexOf(glowFill) < 0) dbgGlowCols.push(glowFill);
          }
        }
      }
      dbgDotBands.push(dBandN);
     }
    }
    // v0.85.1: FLUSH THE DOT BUCKETS
    if (dotBuckets.size && dotBuckets.size <= 640) {
      dotBuckets.forEach(function (bk) {
        var dc = bk.dc;
        dc.fillStyle = bk.s;
        if (bk.a < 1) dc.globalAlpha = bk.a;
        dc.beginPath();
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 3) {
          var ocx = ops[oi], ocy = ops[oi + 1], orr = ops[oi + 2];
          dc.moveTo(ocx + orr, ocy);
          dc.arc(ocx, ocy, orr, 0, Math.PI * 2);
        }
        dc.fill();
        if (bk.a < 1) dc.globalAlpha = 1;
        dbgBatches++;
      });
    } else if (dotBuckets.size) {
      dotBuckets.forEach(function (bk) {
        var dc = bk.dc;
        dc.fillStyle = bk.s;
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 3) {
          var ocx = ops[oi], ocy = ops[oi + 1], orr = ops[oi + 2];
          if (bk.a < 1) dc.globalAlpha = bk.a;
          dc.beginPath();
          dc.moveTo(ocx + orr, ocy);
          dc.arc(ocx, ocy, orr, 0, Math.PI * 2);
          dc.fill();
        }
        if (bk.a < 1) dc.globalAlpha = 1;
        dbgBatches++;
      });
    }

    // ── the origin dot ────────────────────────────────────────────
    const o = { x: (0 - offsetX) * scale, y: (0 - offsetY) * scale };
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      gctx.fillStyle = lcPaint(specs && specs.originColor, (HEX_RE.test(t.originColor || '')) ? t.originColor : '#4a4a5e', gctx, W, H);
      gctx.beginPath();
      gctx.arc(o.x, o.y, ORIGIN_RADIUS * Math.min(scale, 1.5), 0, Math.PI * 2);
      gctx.fill();
    }

    // ── v0.88.2: THE COLLISION DOTS (tabgroups.js) ─────────────────
    // "colliding two icons together forms a dot, similar to the size
    // and theme coloring for the dot we use to mark the center of the
    // canvas, just slightly smaller or larger — make it vary" — the
    // same origin-color family, a per-dot variation, a soft radius
    // ring (the group bubble — the atoms' shell language). ALWAYS
    // smaller than the origin's 12 (the vr cap is 6.9).
    if (cam.dots && cam.dots.length) {
      var dotFill = lcPaint(specs && specs.originColor, (HEX_RE.test(t.originColor || '')) ? t.originColor : '#4a4a5e', gctx, W, H);
      for (var cdi = 0; cdi < cam.dots.length; cdi++) {
        var cdd = cam.dots[cdi];
        var cdX = (cdd.x - offsetX) * scale, cdY = (cdd.y - offsetY) * scale;
        var ringR = cdd.R * scale;
        if (cdX < -ringR - 20 || cdX > W + ringR + 20 ||
            cdY < -ringR - 20 || cdY > H + ringR + 20) continue;
        // the bubble ring (the connection radius, theme-tinted)
        gctx.globalAlpha = 0.15;
        gctx.strokeStyle = dotFill;
        gctx.lineWidth = Math.max(1, scale);
        gctx.beginPath();
        gctx.arc(cdX, cdY, ringR, 0, Math.PI * 2);
        gctx.stroke();
        gctx.globalAlpha = 1;
        // the dot itself (the varying mark)
        gctx.fillStyle = dotFill;
        gctx.beginPath();
        gctx.arc(cdX, cdY, cdd.vr * Math.min(scale, 1.5), 0, Math.PI * 2);
        gctx.fill();
      }
    }

    // ── the frame instrument (returned; hosts publish) ────────────
    var lcNow = performance.now();
    if (lcLastT) lcFps = lcFps * 0.9 + (1000 / (lcNow - lcLastT)) * 0.1;
    lcLastT = lcNow;
    var stats = {
      dotsPainted: (cam.dots ? cam.dots.length : 0),
      originRadius: ORIGIN_RADIUS,
      stars: 0, dots: dbgDots, segs: dbgSegs, amp: amp,
      dotBands: dbgDotBands, lineBands: dbgLineBands,
      dotStats: { small: dbgDotSmall, big: dbgDotBig, n: dbgDots },
      lineStats: { small: dbgLineSmall, big: dbgLineBig, n: dbgSegs + dbgFullLines },
      weight: { jrMin: dbgJrMin, jrMax: dbgJrMax, wMin: dbgWMin, wMax: dbgWMax,
        effFracD: effFracD, effFracL: effFracL },
      overIcons: { on: !!(overDotsOn || overLinesOn),
        dots: dbgOverDots, lines: dbgOverLines,
        threshD: overDotsOn ? overThreshD : null,
        threshL: overLinesOn ? overThreshL : null },
      camera: { x: offsetX, y: offsetY, scale: scale },
      fps: Math.round(lcFps),
      batches: dbgBatches, buckets: dotBuckets.size + segBuckets.size,
      cache: { gen: LC.gen, colorGen: LC.cgen,
        dot: LC.dot.size, vline: LC.vline.size, hline: LC.hline.size,
        vseg: LC.vseg.size, hseg: LC.hseg.size },
      // v0.85.1 (glow wave): the glow twin — the per-dot derivation contract
      glow: { n: dbgGlow, colors: dbgGlowCols, sprites: LC.sprites.size },
      hits: LC.hits, misses: LC.misses,
      paintMs: Math.round((lcNow - t0) * 10) / 10
    };
    lastStats = stats;
    return stats;
  }
  var lastStats = null;

  ROOT.Lattice = {
    ORIGIN_RADIUS: ORIGIN_RADIUS,
    render: render,
    onTexReady: function (cb) { onTexReadyCb = cb; },
    lastStats: function () { return lastStats; },
    IN_WORKER: IN_WORKER,
    cheapJSON: cheapJSON       // v0.88: the spec digests (app.js's gates)
  };
})();
