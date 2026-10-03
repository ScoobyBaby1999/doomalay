// lattice.js — v0.97 THE ONE-OBJECT LATTICE (PLAN-V097, the canvas wave).
//
// v0.85.2 THE EXTRACTED GRID PAINTER (renderer-path Phase 2:
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

  // v0.97: the hosts tell the painter their DPR (tile bake resolution).
  // app.js (main mode, applyBitmapResize) and gridworker.js (init/resize)
  // both call Lattice.setDpr — the pattern fill auto-compensates for any
  // mismatch, so this only tunes SHARPNESS, never geometry.
  var TL_DPR = 1;
  function setDpr(d) { if (isFinite(d) && d > 0) TL_DPR = Math.min(d, 2); }

  // ── v0.83.3 THE LATTICE CACHE (moved verbatim) ─────────────────────
  var LC = {
    fp: '', gen: 0,
    cfp: '', cgen: 0, colFp: '',   // v0.94.1: colFp — the spec-only color fingerprint (pan/zoom-stable)
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
    // v0.94.1: the COLOR caches no longer clear with the params — see the
    // colFp split below (colors are world-anchored: pan/zoom-stable).
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
    function lv(hh) { return Math.min(255, Math.round(parseInt(hh, 16) / 4) * 4); } // v0.89.7: 64 levels (was 17-step — gradient banding)
    function h2(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    q = '#' + h2(lv(m[1])) + h2(lv(m[2])) + h2(lv(m[3]));
    if (QUANT_COLORS.size > 16384) QUANT_COLORS.clear(); // v0.89.7: 64-level colors mint more entries
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

  // ══ v0.97 THE ONE-OBJECT LATTICE (PLAN-V097) ═══════════════════════
  // The user's ask: "make every individual dot and line in the grid act
  // as one object, or possibly two… fake the math, fake the parallax…
  // make them all render as more of a static background when it is not."
  // THE ROOT CAUSE this kills: the legacy render re-walks EVERY visible
  // cell on EVERY ambient frame (~1,100 dots + up to ~2,900 segments on a
  // 1080×2400 phone) — the per-cell cost is why spacing the grid apart
  // visibly doubled the frame rate.
  // THE DESIGN: the lattice bakes ONCE into per-(band × kind) TILES
  // (MEGA grid cells per side — the per-cell hashes become tile-local =
  // periodic by construction, the blessed "fake"); every frame after
  // that is ONE pattern fill per tile (createPattern + fillRect — the
  // GPU-backed repeating primitive; web-research verdict: NO second
  // WebGL context on a phone that caps at 8). Parallax survives EXACTLY
  // (each band is one object moving at its own bandPF — "all dots as one
  // object, all lines as another"), and the animation is the ILLUSION:
  //   · the dot sea BREATHES — two checker-parity groups drawn with
  //     counter-phase global alpha (one sin() per frame, not 1,100);
  //   · HERO FIREFLIES — the glow-candidate cells (top band, jr ≥ 1.6×
  //     base) are excluded from the bake while animDots is on and drawn
  //     live (pulse + tiny orbit + halo, capped) — a handful of real
  //     movers sells "not static";
  //   · colors sample at a MIRROR-FOLDED tile position (seamless tile
  //     repetition for EVERY spec — the samplers already mirror-fold at
  //     bgView; the fold moves that guarantee to tile granularity);
  //   · segments DRAW WRAPPED (a quad crossing a tile edge is drawn
  //     again at ±tileSize — complete coverage, zero double-draw);
  //   · full-line mode (no variation, no line animation) stays
  //     IMMEDIATE (≈40 quads, ≤2 fills) — the v0723 source contracts
  //     and the exact full-line look ride the legacy code, kept intact
  //     below as renderLegacy (also the runtime fallback:
  //     ROOT.__doomalayLatticeLegacy = true A/Bs the two paths live).
  // Zoom: tiles bake at the current scale; a mid-gesture scale delta
  // scales the pattern (soft, transient — the fill auto-compensates),
  // the rebake lands 150ms after settle. Params churn (slider drags):
  // the same 150ms debounce — the worker bakes, the main thread never
  // pays it. TEMPO = the global slow-down (the user's other ask).
  var TEMPO = 0.5;
  var TL = { fp: '', tiles: null, pendP: null, pendCam: null, bakeT: 0,
             gen: 0, cellRecords: 0, legacyFails: 0 };

  // v0.98 THE PARITY PERIOD-INTERLEAVE (the tiling kill) + THE ZOOM FIX.
  // ZOOM: the tile pair no longer derives from the zoom — it comes from
  // the budget + params at a REFERENCE spacing (scale 1), so the
  // constellation (every hashCell input) is zoom-stable. All bake
  // geometry is world-proportional (jitter + radius carry the bake
  // scale), so the mid-gesture `ps` stretch is EXACT and a rebake never
  // pops. Rebakes trigger on a 1.25x raster quantum (sharpness only) —
  // never on identity.
  // TILING: dots split by WORLD PARITY — (dx+dy) even -> layer A at M_A
  // cells, odd -> layer B at M_B cells (both even => parity survives
  // mod-M: world-anchored AND tile-local-computable). Joint period =
  // lcm(M_A,M_B) cells — 80 cells at the default pair (10,16), wider
  // than any phone screen. The fill count is UNCHANGED (the animDots
  // checker groups ARE the parity layers — B just gets a different
  // period now; with animDots off both layers draw at alpha 1). Lines
  // interleave the same way: verticals by column parity, horizontals
  // by row parity.
  var TL_PAIRS = [[10, 16], [8, 14], [6, 10], [4, 6]];
  var TL_BUDGET = 96 * 1024 * 1024;   // was 40MB — the pair needs the room
  function tlLcm(a, b) { var g = a, t = b; while (t) { var x = g % t; g = t; t = x; } return (a / g) * b; }
  function tlRasterQ(r) {
    if (!(r > 0.01)) r = 0.01;
    return Math.max(0, Math.round(Math.log(r) / Math.log(1.25)));
  }

  function tlFingerprint(P, rq, pair, bgKey) {
    var cj = cheapJSON;
    return [P.scatterL, P.scatterD, P.sizeVarL, P.sizeVarD, P.rotVarL, P.rotVarD,
      P.biasL, P.biasD, P.animDots ? 1 : 0, P.animLines ? 1 : 0, P.gridSize,
      P.hideLines ? 1 : 0, P.hideDots ? 1 : 0, P.amp.toFixed(4),
      P.specs && P.specs.dotColor ? cj(P.specs.dotColor) : '', P.t.dotColor,
      P.specs && P.specs.lineColor ? cj(P.specs.lineColor) : '', P.t.lineColor,
      cj(P.canvasSpec), P.bgFallback, rq, pair[0], pair[1], bgKey,
      Math.round(TL_DPR * 10)].join('|');
  }

  // tlPickPair — the budget ladder at the REFERENCE spacing (scale 1 —
  // zoom-stable by construction). Returns the pair + the reference
  // raster (device px per CSS px at scale 1) + the occupancy slots.
  function tlPickPair(P, spacingRef) {
    var amp = P.amp;
    var effFracL = Math.max(P.sizeVarL / 100 * 3.4, Math.abs(P.biasL) / 100 * 1.7);
    var effFracD = Math.max(P.sizeVarD / 100 * 3.4, Math.abs(P.biasD) / 100 * 1.7);
    var segMode = effFracL > 0 || !!P.animLines;
    var overDotsOn = !!(amp >= 0.5 && effFracD > 0.02);
    var overLinesOn = !!(amp >= 0.5 && effFracL > 0.02);
    var bExpL = Math.pow(2, -2.5 * (P.biasL / 100));
    var bExpD = Math.pow(2, -2.5 * (P.biasD / 100));
    function warpL(h) { return bExpL === 1 ? h : Math.pow(h, bExpL); }
    function warpD(h) { return bExpD === 1 ? h : Math.pow(h, bExpD); }
    function depthT(h, sf) { return sf > 0.02 ? h : 0.5; }
    function bandOf(tt) { var k = Math.floor(tt * 5); return k < 0 ? 0 : (k >= 5 ? 4 : k); }
    var dotKinds = P.hideDots ? 0 : 2;
    var lineKinds = (P.hideLines || !segMode) ? 0 : 2;
    var overDotKinds = (overDotsOn && !P.hideDots) ? 2 : 0;
    var overLineKinds = (overLinesOn && segMode && !P.hideLines) ? 2 : 0;
    var chosen = TL_PAIRS[TL_PAIRS.length - 1], chosenR = 0, chosenSlots = 0;
    for (var pi = 0; pi < TL_PAIRS.length; pi++) {
      var MA = TL_PAIRS[pi][0], MB = TL_PAIRS[pi][1];
      var dbs = {}, lbs = {};
      for (var q = 0; q < MA; q++) {
        lbs[bandOf(depthT(warpL(hashCell(q, 2)), effFracL))] = 1;
        lbs[bandOf(depthT(warpL(hashCell(2, q)), effFracL))] = 1;
      }
      for (var qx = 0; qx < MA; qx++) for (var qy = 0; qy < MA; qy++)
        dbs[bandOf(depthT(warpD(hashCell(qx + 7, qy + 7)), effFracD))] = 1;
      var nd = 0, nl = 0;
      for (var kb = 0; kb < 5; kb++) { if (dbs[kb]) nd++; if (lbs[kb]) nl++; }
      if (amp <= 0) { nd = Math.min(1, nd); nl = Math.min(1, nl); }
      var slots = nd * (dotKinds + overDotKinds) + nl * (lineKinds + overLineKinds);
      if (!slots) return { pair: [4, 6], Rref: TL_DPR, slots: 0, cells: 12 };
      var units = (slots / 2) * (MA * MA + MB * MB);
      var Rref = Math.sqrt(TL_BUDGET / (4 * spacingRef * spacingRef * units));
      chosen = TL_PAIRS[pi]; chosenR = Rref; chosenSlots = slots;
      if (Rref >= 0.75) break;   // the biggest period we can afford readably
    }
    return { pair: chosen, Rref: Math.max(0.4, chosenR), slots: chosenSlots,
             cells: tlLcm(chosen[0], chosen[1]) };
  }

  // tlCurrentFp — the per-frame gate: pick + effective raster + the
  // fingerprint (raster-quantized, pair-stamped, bg-view-stamped).
  function tlCurrentFp(P, cam) {
    var spacingRef = GRID_BASE * (P.gridSize || 1);
    var pick = tlPickPair(P, spacingRef);
    var R = Math.max(0.35, Math.min(TL_DPR, pick.Rref / Math.max(0.05, cam.scale)));
    var bgKey = Math.round(bgView.tw) + 'x' + Math.round(bgView.th) + '@' + (bgView.zx || 1).toFixed(3);
    var rq = tlRasterQ(R);
    return { pick: pick, R: R, rq: rq,
             fp: tlFingerprint(P, rq, pick.pair, bgKey) };
  }

  // tlBake — builds every (band × kind) tile for the current params.
  // Returns the tile SET record (also stored on TL.tiles).
  function tlBake(P, cam) {
    var tb0 = performance.now();
    var scaleQ = cam.scale;
    var t = P.t, specs = P.specs;
    var spacingQ = GRID_BASE * (P.gridSize || 1) * scaleQ;
    var cur = tlCurrentFp(P, cam);
    var pick = cur.pick, R = cur.R, rq = cur.rq, fp = cur.fp;
    var MA = pick.pair[0], MB = pick.pair[1];
    if (TL.fp === fp && TL.tiles) return TL.tiles;

    var amp = P.amp;
    var scatterPxL = P.scatterL * 0.6, scatterPxD = P.scatterD * 0.6;
    var sizeFracL = P.sizeVarL / 100 * 3.4;
    var sizeFracD = P.sizeVarD / 100 * 3.4;
    var effFracL = Math.max(sizeFracL, Math.abs(P.biasL) / 100 * 1.7);
    var effFracD = Math.max(sizeFracD, Math.abs(P.biasD) / 100 * 1.7);
    var rotDegL = P.rotVarL * 0.6;
    var bExpL = Math.pow(2, -2.5 * (P.biasL / 100));
    var bExpD = Math.pow(2, -2.5 * (P.biasD / 100));
    function warpL(h) { return bExpL === 1 ? h : Math.pow(h, bExpL); }
    function warpD(h) { return bExpD === 1 ? h : Math.pow(h, bExpD); }
    var dotSpec = specs && specs.dotColor;
    var dotFallback = (HEX_RE.test(t.dotColor || '')) ? t.dotColor : '#2e2e3a';
    var lineSpec = specs && specs.lineColor;
    var lineFallback = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
    var dotSampler = lcSampler(dotSpec, dotFallback);
    var lineSampler = lcSampler(lineSpec, lineFallback);
    var dotRBaseQ = Math.max(0.6, DOT_RADIUS * scaleQ);   // v0.98: proportional (self-similar zoom; legacy keeps the 1.3 clamp)
    var AMP_BANDS = 5;
    var animDots = !!P.animDots, animLines = !!P.animLines;
    var segMode = effFracL > 0 || animLines;
    var overDotsOn = !!(amp >= 0.5 && effFracD > 0.02);
    var overLinesOn = !!(amp >= 0.5 && effFracL > 0.02);
    var overThreshD = 0.7 * dotRBaseQ * (1 + effFracD);
    var overThreshL = 0.7 * (1 + effFracL);
    function bandPF(k) { return 1 + amp * (0.25 + 0.75 * (-0.85 + 1.5 * (k / (AMP_BANDS - 1)))); }
    function depthT(h, sizeFrac) { return sizeFrac > 0.02 ? h : 0.5; }
    function bandOf(tt) { var k = Math.floor(tt * AMP_BANDS); return k < 0 ? 0 : (k >= AMP_BANDS ? AMP_BANDS - 1 : k); }

    var T = { fp: fp, M: MA, MA: MA, MB: MB, cells: pick.cells, R: R,
              scaleQ: scaleQ, spacingQ: spacingQ, list: [],
              heroes: [], cellRecords: 0, gen: ++TL.gen, bakeMs: 0 };

    // mkTile(ML) — the tile for ONE parity layer at M = ML cells/side,
    // rasterized at the budget-capped R (device px per CSS px).
    function mkTile(ML) {
      var DL = Math.max(8, Math.ceil(ML * spacingQ * R));
      var cv = mkCanvas(DL, DL);
      var g = cv.getContext('2d');
      g.scale(R, R);
      return { canvas: cv, g: g, D: DL, M: ML, n: 0, small: 0, big: 0,
               jrMin: Infinity, jrMax: 0, wMin: Infinity, wMax: 0,
               glowN: 0, glowCols: [] };
    }
    function foldSample(sampler, a, b, jx, jy) {
      if (!sampler) return null;
      // v0.98: the identity window — the mirror fold made every tile's
      // color field symmetric (a recognizable repetition signature). A
      // dot/segment is a discrete object: its color needs no seam
      // guarantee, just a window into the field.
      return sampler(a * spacingQ + jx, b * spacingQ + jy);
    }
    // drawWrapped — the seamless-tile primitive: an item crossing an edge
    // is drawn AGAIN shifted by ±tileSize (complete coverage, and no
    // pixel is ever painted twice — the periodic copies are disjoint).
    function drawWrapped(g, TS, bbox, x0, y0, draw) {
      var xs = [x0], ys = [y0];
      if (x0 + bbox.r > TS) xs.push(x0 - TS);
      if (x0 + bbox.l < 0) xs.push(x0 + TS);
      if (y0 + bbox.b > TS) ys.push(y0 - TS);
      if (y0 + bbox.t < 0) ys.push(y0 + TS);
      for (var i = 0; i < xs.length; i++)
        for (var j = 0; j < ys.length; j++) draw(xs[i], ys[j]);
    }

    // ── THE DOT WALK (per band, per group) ────────────────────────────
    // v0.97.1: the firefly budget — at high variation EVERY top-band dot
    // clears the 1.6× glow bar; without a per-tile budget the whole band
    // minted as heroes and the runtime cap (40) VANISHED the rest (the
    // v097 rig's band-4-zero catch). The biggest HERO_PER_TILE per tile
    // animate live; the remainder bake static (with their glow).
    var HERO_PER_TILE = 5;
    for (var band = 0; band < (amp > 0 ? AMP_BANDS : 1); band++) {
      var topBand = (amp > 0) && band === AMP_BANDS - 1;
      // (a) the hero pre-pass: candidates, then the biggest few win
      var heroCands = [], Tj = { jrMin: Infinity, jrMax: 0 };
      for (var gi = 0; gi < 2; gi++) {
        var Mh = gi === 0 ? MA : MB;
        for (var px = 0; px < Mh; px++) for (var py = 0; py < Mh; py++) {
          if (((px + py) & 1) !== gi) continue;
          var phd2 = warpD(hashCell(px + 7, py + 7));
          if (amp > 0 && bandOf(depthT(phd2, effFracD)) !== band) continue;
          // the weight ratio rides the UNFLOORED radius (the legacy twin —
          // v0831 pins jrMin <= 0.05: the raw spread goes negative before
          // the draw-side 0.15 floor)
          var praw = (1 + effFracD * (phd2 - 0.5) * 2);
          if (praw < Tj.jrMin) Tj.jrMin = praw;
          if (praw > Tj.jrMax) Tj.jrMax = praw;
          // v0.97.1: the hero candidate bar rides the FLOORED radius (the
          // draw's own size — a negative raw spread must not mint heroes)
          var pjr = Math.max(0.15, dotRBaseQ * praw);
          if (animDots && topBand && pjr >= dotRBaseQ * 1.6)
            heroCands.push({ dx: px, dy: py, jr: pjr, L: gi });
        }
      }
      heroCands.sort(function (a, b) { return b.jr - a.jr; });
      var heroSet = {}, heroesHere = [];
      for (var hci = 0; hci < heroCands.length && hci < HERO_PER_TILE * 2; hci++) {
        var hc = heroCands[hci];
        heroSet[hc.L + ':' + hc.dx + ',' + hc.dy] = 1;
        var hjx = scatterPxD * (hashCell(hc.dx, hc.dy) - 0.5) * 2 * scaleQ;
        var hjy = scatterPxD * (hashCell(hc.dx + 3, hc.dy + 5) - 0.5) * 2 * scaleQ;
        var hcol = foldSample(dotSampler, hc.dx, hc.dy, hjx, hjy) || dotFallback;
        var hgb = (HEX_RE.test(hcol)) ? hcol : null;
        heroesHere.push({ tx: hc.dx, ty: hc.dy, jx: hjx, jy: hjy, jr: hc.jr,
          M: hc.L === 0 ? MA : MB,
          over: !!(overDotsOn && hc.jr > overThreshD),
          col: hcol, glow: hgb ? shadeHex(hgb, 0.42) : null,
          tsp: 0.5 + hashCell(hc.dx + 21, hc.dy + 21) * 1.8,
          tph: hashCell(hc.dx + 23, hc.dy + 23) * 6.283,
          ospd: (0.25 + hashCell(hc.dx + 27, hc.dy + 27) * 0.9) * (hashCell(hc.dx + 29, hc.dy + 29) < 0.5 ? -1 : 1),
          orR: spacingQ * (0.06 + 0.08 * hashCell(hc.dx + 31, hc.dy + 31)) });
      }
      for (var hh = 0; hh < heroesHere.length; hh++) heroesHere[hh].pf = (amp > 0) ? bandPF(band) : 1;
      T.heroes.push.apply(T.heroes, heroesHere);
      T.jrMin = Tj.jrMin; T.jrMax = Tj.jrMax;
      // (b) the group tile walk (the chosen fireflies stay live)
      for (var gi = 0; gi < 2; gi++) {
        var ML = gi === 0 ? MA : MB;
        var TS = ML * spacingQ;
        var tile = mkTile(ML), overTile = overDotsOn ? mkTile(ML) : null;
        var g = tile.g;
        for (var dx = 0; dx < ML; dx++) for (var dy = 0; dy < ML; dy++) {
          var hd = hashCell(dx, dy);
          var hd2 = warpD(hashCell(dx + 7, dy + 7));
          // legacy parity: at amp<=0 the single band renders EVERY dot
          // (the band filter only exists when there are 5 bands)
          if (amp > 0 && bandOf(depthT(hd2, effFracD)) !== band) continue;
          if (((dx + dy) & 1) !== gi) continue;
          if (heroSet[gi + ':' + dx + ',' + dy]) continue;      // the live fireflies
          var jrB = dotRBaseQ * (1 + effFracD * (hd2 - 0.5) * 2);
          var jx = scatterPxD * (hd - 0.5) * 2 * scaleQ;
          var jy = scatterPxD * (hashCell(dx + 3, dy + 5) - 0.5) * 2 * scaleQ;
          var isOver = overDotsOn && jrB > overThreshD;
          var tgt = isOver ? overTile : tile;
          if (!tgt) continue;
          var gg = tgt.g;
          var rr = Math.max(0.15, jrB);
          var colD2 = foldSample(dotSampler, dx, dy, jx, jy) || dotFallback;
          var cxp = dx * spacingQ + jx, cyp = dy * spacingQ + jy;
          var ext = rr + ((topBand && jrB >= dotRBaseQ * 1.6) ? jrB * 2.6 : 0);
          var styleD = colD2;
          // the static glow: halo sprite + lifted core color, per-dot —
          // baked for every glow-class dot that did NOT win a firefly slot
          if (topBand && jrB >= dotRBaseQ * 1.6) {
            var gbase = (HEX_RE.test(colD2)) ? colD2 : null;
            var glowFill = gbase ? shadeHex(gbase, 0.42) : null;
            if (glowFill) {
              if (jrB >= 1.6) {
                var spG = lcGlowSprite(glowFill);
                var Rg = jrB * 2.6;   // v0.98: renamed — 'R' is the bake raster now
                drawWrapped(gg, TS, { l: -Rg, r: Rg, t: -Rg, b: Rg }, cxp, cyp, function (wx, wy) {
                  gg.globalAlpha = 0.55;
                  gg.drawImage(spG.c, wx - Rg, wy - Rg, Rg * 2, Rg * 2);
                  gg.globalAlpha = 1;
                });
              }
              tgt.glowN++;
              if (tgt.glowCols.indexOf(glowFill) < 0) tgt.glowCols.push(glowFill);
              styleD = glowFill;
            }
          }
          var fillStyle = styleD;
          drawWrapped(gg, TS, { l: -ext, r: ext, t: -ext, b: ext }, cxp, cyp, function (wx, wy) {
            gg.fillStyle = fillStyle;
            gg.beginPath(); gg.arc(wx, wy, rr, 0, Math.PI * 2); gg.fill();
          });
          tgt.n++;
          if (rr < dotRBaseQ * 0.9) tgt.small++; else if (rr > dotRBaseQ * 1.1) tgt.big++;
        }
        // push ONLY the tiles with content (an empty transparent tile
        // would still cost a full-screen GPU fill for nothing)
        var pf = (amp > 0) ? bandPF(band) : 1;
        if (tile.n > 0) T.list.push({ kind: gi === 0 ? 'dotsA' : 'dotsB', band: band, pf: pf, over: false, tile: tile });
        if (overTile && overTile.n > 0) T.list.push({ kind: gi === 0 ? 'dotsA' : 'dotsB', band: band, pf: pf, over: true, tile: overTile });
        T.cellRecords += tile.n + (overTile ? overTile.n : 0);
      }
    }

    // ── THE SEGMENT WALK (per band; segMode only) ─────────────────────
    if (segMode && !P.hideLines) {
      for (var lband = 0; lband < (amp > 0 ? AMP_BANDS : 1); lband++) {
        var lpf = (amp > 0) ? bandPF(lband) : 1;
        var baseSegLen = spacingQ * 1.35;
        for (var gi = 0; gi < 2; gi++) {
          var ML = gi === 0 ? MA : MB;
          var TS = ML * spacingQ;
          var tile = mkTile(ML), overTile = overLinesOn ? mkTile(ML) : null;
          var g = tile.g, drew = false;
          // vertical segments: columns tx, rows ty (bands come from the
          // COLUMN hash — hashCell(tx, 2), the legacy vline band twin)
          for (var vx = 0; vx < ML; vx++) {
            if ((vx & 1) !== gi) continue;
            var lwH = warpL(hashCell(vx, 2));
            var vBand = bandOf(depthT(lwH, effFracL));
            var rotD = rotDegL * (hashCell(vx, 1) - 0.5) * 2;
            var rr2 = rotD * Math.PI / 180;
            var LP = { dx: scatterPxL * (hashCell(vx, 0) - 0.5) * 2, c: Math.cos(rr2), s: Math.sin(rr2) };
            if (amp > 0 && vBand !== lband) continue;   // legacy parity: no filter at 1 band
            for (var vy = 0; vy < ML; vy++) {
              var SP = {
                len: (animLines && effFracL === 0)
                  ? spacingQ * (0.30 + hashCell(vx + 31, vy + 33) * 0.55)
                  : Math.max(spacingQ * 0.06,
                      (effFracL > 0 ? spacingQ : baseSegLen) * (1 + effFracL * (warpL(hashCell(vx + 5, vy)) - 0.5) * 2)),
                w: Math.max(0.12,
                  (animLines ? (0.9 + hashCell(vx + 35, vy + 37) * 0.9) : 1) *
                  (1 + effFracL * (warpL(hashCell(vx + 9, vy)) - 0.5) * 2))
              };
              var segW = SP.w;
              var isOver = overLinesOn && segW > overThreshL;
              var tgt = isOver ? overTile : tile;
              if (!tgt) continue;
              var gg = tgt.g;
              var colS = foldSample(lineSampler, vx, vy, 0, 0) || lineFallback;
              var txL = vx * spacingQ + LP.dx;
              var ly1 = vy * spacingQ - SP.len / 2, ly2 = vy * spacingQ + SP.len / 2;
              var ax1 = txL - ly1 * LP.s, ay1 = ly1 * LP.c;
              var ax2 = txL - ly2 * LP.s, ay2 = ly2 * LP.c;
              var pxs = LP.c * segW / 2, pys = LP.s * segW / 2;
              var bb = { l: -Math.abs(pxs) - Math.abs(ly1 * LP.s) - Math.abs(ly2 * LP.s),
                         r: Math.abs(pxs) + Math.abs(ly1 * LP.s) + Math.abs(ly2 * LP.s),
                         t: -Math.abs(pys) - Math.abs(ly2 * LP.c) - Math.abs(ly1 * LP.c) - SP.len,
                         b: Math.abs(pys) + Math.abs(ly2 * LP.c) + Math.abs(ly1 * LP.c) + SP.len };
              var fillStyle = colS;
              drawWrapped(gg, TS, bb, ax1, ay1, function (wx, wy) {
                gg.fillStyle = fillStyle;
                gg.beginPath();
                gg.moveTo(wx - pxs, wy - pys);
                gg.lineTo(wx + pxs, wy + pys);
                gg.lineTo((wx - (ly2 - ly1) * LP.s) + pxs, (wy + (ly2 - ly1) * LP.c) + pys);
                gg.lineTo((wx - (ly2 - ly1) * LP.s) - pxs, (wy + (ly2 - ly1) * LP.c) - pys);
                gg.closePath();
                gg.fill();
              });
              tgt.n++;
              if (segW < 0.9) tgt.small++; else if (segW > 1.1) tgt.big++;
              if (segW < tgt.wMin) tgt.wMin = segW;
              if (segW > tgt.wMax) tgt.wMax = segW;
              drew = true;
            }
          }
          // horizontal segments: rows iy, columns ix (band from hashCell(2, iy))
          for (var hy = 0; hy < ML; hy++) {
            if ((hy & 1) !== gi) continue;
            var lwH2 = warpL(hashCell(2, hy));
            var hBand = bandOf(depthT(lwH2, effFracL));
            var rot2D = rotDegL * (hashCell(1, hy) - 0.5) * 2;
            var rr3 = rot2D * Math.PI / 180;
            var HP = { dy: scatterPxL * (hashCell(0, hy) - 0.5) * 2, c: Math.cos(rr3), s: Math.sin(rr3) };
            if (amp > 0 && hBand !== lband) continue;   // legacy parity: no filter at 1 band
            for (var hx = 0; hx < ML; hx++) {
              var HS = {
                len: (animLines && effFracL === 0)
                  ? spacingQ * (0.30 + hashCell(hx + 33, hy + 31) * 0.55)
                  : Math.max(spacingQ * 0.06,
                      (effFracL > 0 ? spacingQ : baseSegLen) * (1 + effFracL * (warpL(hashCell(hx, hy + 5)) - 0.5) * 2)),
                w: Math.max(0.12,
                  (animLines ? (0.9 + hashCell(hx + 37, hy + 35) * 0.9) : 1) *
                  (1 + effFracL * (warpL(hashCell(hx, hy + 9)) - 0.5) * 2))
              };
              var segW2 = HS.w;
              var isOver2 = overLinesOn && segW2 > overThreshL;
              var tgt2 = isOver2 ? overTile : tile;
              if (!tgt2) continue;
              var gg2 = tgt2.g;
              var colS2 = foldSample(lineSampler, hx, hy, 0, 0) || lineFallback;
              var tyL = hy * spacingQ + HP.dy;
              var lx1 = hx * spacingQ - HS.len / 2, lx2 = hx * spacingQ + HS.len / 2;
              var bx1 = lx1 * HP.c, by1 = tyL + lx1 * HP.s;
              var bx2 = lx2 * HP.c, by2 = tyL + lx2 * HP.s;
              var pxs2 = -HP.s * segW2 / 2, pys2 = HP.c * segW2 / 2;
              var bb2 = { l: -HS.len - Math.abs(pxs2), r: HS.len + Math.abs(pxs2),
                          t: -Math.abs(pys2), b: Math.abs(pys2) };
              var fillStyle2 = colS2;
              drawWrapped(gg2, TS, bb2, bx1, by1, function (wx, wy) {
                gg2.fillStyle = fillStyle2;
                gg2.beginPath();
                gg2.moveTo(wx - pxs2, wy - pys2);
                gg2.lineTo(wx + pxs2, wy + pys2);
                gg2.lineTo((wx + (lx2 - lx1) * HP.c) + pxs2, (wy + (lx2 - lx1) * HP.s) + pys2);
                gg2.lineTo((wx + (lx2 - lx1) * HP.c) - pxs2, (wy + (lx2 - lx1) * HP.s) - pys2);
                gg2.closePath();
                gg2.fill();
              });
              tgt2.n++;
              if (segW2 < 0.9) tgt2.small++; else if (segW2 > 1.1) tgt2.big++;
              if (segW2 < tgt2.wMin) tgt2.wMin = segW2;
              if (segW2 > tgt2.wMax) tgt2.wMax = segW2;
              drew = true;
            }
          }
          if (tile.n > 0) T.list.push({ kind: 'lines', band: lband, pf: lpf, over: false, tile: tile });
          if (overTile && overTile.n > 0) T.list.push({ kind: 'lines', band: lband, pf: lpf, over: true, tile: overTile });
          T.cellRecords += tile.n + (overTile ? overTile.n : 0);
        }
      }
    }

    T.bakeMs = performance.now() - tb0;
    TL.fp = fp;
    TL.tiles = T;
    TL.cellRecords = T.cellRecords;   // v0.97.1: the instrument read TL, not T
    return T;
  }

  // tlBakeTiles — the entry: returns the current set, baking synchronously
  // on FIRST use (boot parity: the old first frame cost exactly this once)
  // and debouncing REPLACEMENT bakes 150ms (slider drags, pinch settles —
  // the interim frames render with the current tiles).
  function tlBakeTiles(P, cam) {
    if (TL.tiles && TL.fp) {
      var fp = tlCurrentFp(P, cam).fp;
      if (fp !== TL.fp) {
        // v0.97.1 FIX — the trailing debounce must NOT re-arm itself every
        // frame (the ambient frames kept resetting the 150ms clock, so a
        // rebake NEVER fired and the app rendered the stale tile set
        // forever — the classic self-arming debounce bug, caught by the
        // v097 rig's mesh worst case). The clock starts at the FIRST
        // mismatch; later frames only refresh the payload (bake whatever
        // is newest when it fires; convergence re-arms if still stale).
        TL.pendP = P; TL.pendCam = { ox: cam.ox, oy: cam.oy, scale: cam.scale };
        if (!TL.bakeT) {
          TL.bakeT = setTimeout(function () {
            TL.bakeT = 0;
            var p = TL.pendP, c = TL.pendCam;
            TL.pendP = null; TL.pendCam = null;
            if (p && c) {
              try { tlBake(p, c); }
              catch (e) {
                // v0.97.1: a worker-side bake throw is INVISIBLE (the boot
                // onerror is a settled no-op) — stash it for the instrument
                TL.bakeError = String(e && e.message || e);
                try { if (typeof console !== 'undefined') console.warn('doomalay: tile rebake failed:', TL.bakeError); } catch (e2) {}
              }
            }
          }, 150);
        }
        return TL.tiles;
      }
      return TL.tiles;
    }
    return tlBake(P, cam);
  }

  // tlFill — THE one-object draw: one pattern fill paints an entire band.
  // The pattern's user-unit = its own pixel; scaling by Tcss/D maps the
  // tile onto exactly M grid cells at the CURRENT scale (any bake-scale
  // mismatch auto-compensates — only sharpness changes).
  function tlFill(gc, tile, phx, phy, Tcss, alpha, W, H) {
    if (!tile.pat || tile.patCtx !== gc) {
      tile.pat = gc.createPattern(tile.canvas, 'repeat');
      tile.patCtx = gc;
    }
    var k = Tcss / tile.D;
    gc.save();
    if (alpha < 1) gc.globalAlpha = alpha;
    gc.translate(phx, phy);
    gc.scale(k, k);
    gc.fillStyle = tile.pat;
    gc.fillRect(-phx / k, -phy / k, W / k, H / k);
    gc.restore();
  }

  // ══ THE RENDER — the v0.97 dispatcher ══════════════════════════════
  function render(gctx, gctx2, W, H, cam, P) {
    if (ROOT.__doomalayLatticeLegacy) return renderLegacy(gctx, gctx2, W, H, cam, P);
    try {
      return renderTiled(gctx, gctx2, W, H, cam, P);
    } catch (e) {
      TL.legacyFails++;
      TL.lastError = String(e && e.message || e) + ' @ ' + String(e && e.stack || '').split('\n')[1];
      try { if (typeof console !== 'undefined' && TL.legacyFails < 3) console.warn('doomalay: one-object lattice fell back to legacy:', e && e.message, e && e.stack); } catch (e2) {}
      TL.tiles = null; TL.fp = '';
      return renderLegacy(gctx, gctx2, W, H, cam, P);
    }
  }

  function renderTiled(gctx, gctx2, W, H, cam, P) {
    var t0 = performance.now();
    var offsetX = cam.ox, offsetY = cam.oy, scale = cam.scale;
    var t = P.t, specs = P.specs;

    paintCanvasBackground(gctx, P.canvasSpec, P.bgFallback, W, H, P.bgP, scale, offsetX, offsetY);

    var amp = P.amp;
    var scatterPxL = P.scatterL * 0.6, scatterPxD = P.scatterD * 0.6;
    var sizeFracL = P.sizeVarL / 100 * 3.4;
    var sizeFracD = P.sizeVarD / 100 * 3.4;
    var effFracL = Math.max(sizeFracL, Math.abs(P.biasL) / 100 * 1.7);
    var effFracD = Math.max(sizeFracD, Math.abs(P.biasD) / 100 * 1.7);
    var rotDegL = P.rotVarL * 0.6;
    var bExpL = Math.pow(2, -2.5 * (P.biasL / 100));
    function warpL(h) { return bExpL === 1 ? h : Math.pow(h, bExpL); }
    var hideLines = !!P.hideLines;
    var hideDots = !!P.hideDots;
    var animDots = !!P.animDots;
    var animLines = !!P.animLines;
    var dotSpec = specs && specs.dotColor;
    var dotFallback = (HEX_RE.test(t.dotColor || '')) ? t.dotColor : '#2e2e3a';
    var lineSpec2 = specs && specs.lineColor;
    var lineFallback2 = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
    var fpNow = [P.scatterL, P.scatterD, P.sizeVarL, P.sizeVarD, P.rotVarL, P.rotVarD,
      P.biasL, P.biasD, animDots ? 1 : 0, animLines ? 1 : 0,
      P.gridSize, hideLines ? 1 : 0, hideDots ? 1 : 0,
      amp.toFixed(4), W, H,
      dotSpec ? cheapJSON(dotSpec) : '', dotFallback,
      lineSpec2 ? cheapJSON(lineSpec2) : '', lineFallback2].join('|');
    if (fpNow !== LC.fp) { LC.fp = fpNow; LC.gen++; lcClearParams(); }
    var colFp = [dotSpec ? cheapJSON(dotSpec) : '', dotFallback,
                 lineSpec2 ? cheapJSON(lineSpec2) : '', lineFallback2].join('|');
    if (colFp !== LC.colFp) { LC.colFp = colFp; LC.cgen++; lcClearColors(); }
    var animT = performance.now() / 1000 * TEMPO;    // v0.97: the tempo slow-down
    var dbg = { dots: 0, segs: 0, fullLines: 0, batches: 0, buckets: 0,
      dotBands: [], lineBands: [], dotSmall: 0, dotBig: 0, lineSmall: 0, lineBig: 0,
      jrMin: Infinity, jrMax: 0, wMin: Infinity, wMax: 0,
      glow: 0, glowCols: [], overDots: 0, overLines: 0 };
    var dotRBase = Math.max(0.6, DOT_RADIUS * Math.min(scale, 1.3));
    var segMode = effFracL > 0 || animLines;
    var overDotsOn = !!(gctx2 && amp >= 0.5 && effFracD > 0.02);
    var overLinesOn = !!(gctx2 && amp >= 0.5 && effFracL > 0.02);
    var overThreshD = 0.7 * dotRBase * (1 + effFracD);
    var overThreshL = 0.7 * (1 + effFracL);
    var AMP_BANDS = 5;
    var bandPF = function (k) { return 1 + amp * (0.25 + 0.75 * (-0.85 + 1.5 * (k / (AMP_BANDS - 1)))); };
    if (gctx2) gctx2.clearRect(0, 0, W, H);

    var nBandsArr = amp > 0 ? AMP_BANDS : 1;
    for (var zb = 0; zb < nBandsArr; zb++) { dbg.dotBands.push(0); dbg.lineBands.push(0); }

    // ── FULL-LINE MODE (no variation, no line animation): the immediate
    // pass, lifted from the legacy renderer — ≈40 quads, ≤2 fills, and
    // the v0723 source contracts live in the legacy copy below.
    if (!hideLines && !segMode) {
      var lineBands = amp > 0 ? AMP_BANDS : 1;
      var segBuckets = new Map();
      var lineBandStyle = lcPaint(lineSpec2, lineFallback2, gctx, W, H);
      gctx.strokeStyle = lineBandStyle;
      gctx.lineWidth = 1;
      var lineSampler = lcSampler(lineSpec2, lineFallback2);
      var startX = ((-offsetX * scale) % (GRID_BASE * (P.gridSize || 1) * scale) + (GRID_BASE * (P.gridSize || 1) * scale)) % (GRID_BASE * (P.gridSize || 1) * scale);
      var startY = ((-offsetY * scale) % (GRID_BASE * (P.gridSize || 1) * scale) + (GRID_BASE * (P.gridSize || 1) * scale)) % (GRID_BASE * (P.gridSize || 1) * scale);
      var scaledGrid = GRID_BASE * (P.gridSize || 1) * scale;
      function depthT(h, sizeFrac) { return sizeFrac > 0.02 ? h : 0.5; }
      function bandOf(tt) { var k = Math.floor(tt * AMP_BANDS); return k < 0 ? 0 : (k >= AMP_BANDS ? AMP_BANDS - 1 : k); }
      for (var lb = 0; lb < lineBands; lb++) {
        var lPF = lineBands === 1 ? 1 : bandPF(lb);
        var lStartX = lineBands === 1 ? startX : (((-offsetX * scale * lPF) % scaledGrid + scaledGrid) % scaledGrid);
        var lStartY = lineBands === 1 ? startY : (((-offsetY * scale * lPF) % scaledGrid + scaledGrid) % scaledGrid);
        var lBandN = 0;
        for (var x = lStartX; x < W; x += scaledGrid) {
          var ix = Math.round((x + offsetX * scale * lPF) / scaledGrid);
          var LP = LC.vline.get(ix);
          if (LP === undefined) {
            var lwH = warpL(hashCell(ix, 2));
            var rotD = rotDegL * (hashCell(ix, 1) - 0.5) * 2;
            var rrd = rotD * Math.PI / 180;
            LP = { dx: scatterPxL * (hashCell(ix, 0) - 0.5) * 2,
                   lwB: 1 * (1 + effFracL * (lwH - 0.5) * 2),
                   band: bandOf(depthT(lwH, effFracL)),
                   c: Math.cos(rrd), s: Math.sin(rrd) };
            LC.vline.set(ix, LP);
            if (LC.vline.size > 8192) LC.vline.clear();
          }
          if (lineBands > 1 && LP.band !== lb) continue;
          lBandN++;
          if (LP.lwB < 0.9) dbg.lineSmall++; else if (LP.lwB > 1.1) dbg.lineBig++;
          var lc = (overLinesOn && LP.lwB > overThreshL) ? gctx2 : gctx;
          if (lc === gctx2) dbg.overLines++;
          var tx = x + LP.dx;
          var colL = LC.vlineC.get(ix);
          if (colL === undefined) { colL = lineSampler ? lineSampler(x + offsetX * scale * lPF, H / 2 + offsetY * scale * lPF) : null; LC.vlineC.set(ix, colL); LC.misses++; } else LC.hits++;
          dbg.fullLines++;
          var styleL = quantColor(colL || lineBandStyle);
          var lwFull = Math.max(0.3, LP.lwB);
          var pxv = LP.c * lwFull / 2, pyv = LP.s * lwFull / 2;
          var fbk = (lc === gctx2 ? '2|' : '1|') + styleL;
          var fb = segBuckets.get(fbk);
          if (!fb) { fb = { sc: lc, s: styleL, a: 1, ops: [] }; segBuckets.set(fbk, fb); }
          fb.ops.push(tx - pxv, 0 - pyv, tx + pxv, 0 + pyv,
                      (tx - H * LP.s) + pxv, H * LP.c + pyv, (tx - H * LP.s) - pxv, H * LP.c - pyv);
          if (LP.lwB < dbg.wMin) dbg.wMin = LP.lwB;
          if (LP.lwB > dbg.wMax) dbg.wMax = LP.lwB;
        }
        for (var y = lStartY; y < H; y += scaledGrid) {
          var iy = Math.round((y + offsetY * scale * lPF) / scaledGrid);
          var HP = LC.hline.get(iy);
          if (HP === undefined) {
            var lw2H = warpL(hashCell(2, iy));
            var rot2D = rotDegL * (hashCell(1, iy) - 0.5) * 2;
            var rr2d = rot2D * Math.PI / 180;
            HP = { dy: scatterPxL * (hashCell(0, iy) - 0.5) * 2,
                   lwB: 1 * (1 + effFracL * (lw2H - 0.5) * 2),
                   band: bandOf(depthT(lw2H, effFracL)),
                   c: Math.cos(rr2d), s: Math.sin(rr2d) };
            LC.hline.set(iy, HP);
            if (LC.hline.size > 8192) LC.hline.clear();
          }
          if (lineBands > 1 && HP.band !== lb) continue;
          lBandN++;
          if (HP.lwB < 0.9) dbg.lineSmall++; else if (HP.lwB > 1.1) dbg.lineBig++;
          var lc2 = (overLinesOn && HP.lwB > overThreshL) ? gctx2 : gctx;
          if (lc2 === gctx2) dbg.overLines++;
          var ty = y + HP.dy;
          var colL2 = LC.hlineC.get(iy);
          if (colL2 === undefined) { colL2 = lineSampler ? lineSampler(W / 2 + offsetX * scale * lPF, y + offsetY * scale * lPF) : null; LC.hlineC.set(iy, colL2); LC.misses++; } else LC.hits++;
          dbg.fullLines++;
          var styleL2 = quantColor(colL2 || lineBandStyle);
          var lwFull2 = Math.max(0.3, HP.lwB);
          var pxh = -HP.s * lwFull2 / 2, pyh = HP.c * lwFull2 / 2;
          var fbk2 = (lc2 === gctx2 ? '2|' : '1|') + styleL2;
          var fb2 = segBuckets.get(fbk2);
          if (!fb2) { fb2 = { sc: lc2, s: styleL2, a: 1, ops: [] }; segBuckets.set(fbk2, fb2); }
          fb2.ops.push(0 - pxh, ty - pyh, 0 + pxh, ty + pyh,
                       W * HP.c + pxh, ty + W * HP.s + pyh, W * HP.c - pxh, ty + W * HP.s - pyh);
          if (HP.lwB < dbg.wMin) dbg.wMin = HP.lwB;
          if (HP.lwB > dbg.wMax) dbg.wMax = HP.lwB;
        }
        dbg.lineBands[lb] = (dbg.lineBands[lb] || 0) + lBandN;
      }
      segBuckets.forEach(function (bk) {
        var sc = bk.sc;
        sc.fillStyle = bk.s;
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
        dbg.batches++; dbg.buckets++;
      });
    }

    // ── THE ONE-OBJECT TILES ──────────────────────────────────────────
    var T = tlBakeTiles(P, cam);
    var ps = T.scaleQ ? (scale / T.scaleQ) : 1;
    var spacingNow = GRID_BASE * (P.gridSize || 1) * scale;
    var dprSnap = TL_DPR || 1;
    // the BREATH: two checker-parity groups, counter-phase — the shimmer
    // that replaces 1,100 per-dot sin() evaluations
    var breathA = animDots ? (0.62 + 0.38 * (0.5 + 0.5 * Math.sin(animT * 1.6))) : 1;
    var breathB = animDots ? (0.62 + 0.38 * (0.5 + 0.5 * Math.sin(animT * 1.6 + Math.PI))) : 1;
    // v0.98: per-layer periods — each parity layer phase-wraps at its own
    // tile size (the interleave); coverage stats follow the layer.

    for (var li = 0; li < T.list.length; li++) {
      var bt = T.list[li];
      if (bt.kind === 'lines' && (hideLines || !segMode)) continue;
      if (bt.kind !== 'lines' && hideDots) continue;
      var gc = bt.over ? gctx2 : gctx;
      if (!gc) continue;
      var bpf = bt.pf;
      var Tcss = bt.tile.M * spacingNow;   // v0.98: the layer's own period
      var bx = -(offsetX * scale * bpf), by = -(offsetY * scale * bpf);
      var phx = ((bx % Tcss) + Tcss) % Tcss;
      var phy = ((by % Tcss) + Tcss) % Tcss;
      phx = Math.round(phx * dprSnap) / dprSnap;
      phy = Math.round(phy * dprSnap) / dprSnap;
      var alpha = bt.kind === 'dotsA' ? breathA : (bt.kind === 'dotsB' ? breathB : 1);
      tlFill(gc, bt.tile, phx, phy, Tcss, alpha, W, H);
      dbg.batches++;
      var nxL = Math.ceil(W / Tcss) + 1, nyL = Math.ceil(H / Tcss) + 1;
      var cov = nxL * nyL * bt.tile.n;
      var reps = nxL * nyL;
      if (bt.kind === 'lines') {
        dbg.segs += cov;
        dbg.lineBands[bt.band] = (dbg.lineBands[bt.band] || 0) + cov;
        dbg.lineSmall += bt.tile.small * reps; dbg.lineBig += bt.tile.big * reps;
        if (bt.tile.wMin < dbg.wMin) dbg.wMin = bt.tile.wMin;
        if (bt.tile.wMax > dbg.wMax) dbg.wMax = bt.tile.wMax;
        if (bt.over) dbg.overLines += cov;
      } else {
        dbg.dots += cov;
        dbg.dotBands[bt.band] = (dbg.dotBands[bt.band] || 0) + cov;
        dbg.dotSmall += bt.tile.small * reps; dbg.dotBig += bt.tile.big * reps;
        if (bt.tile.jrMin < dbg.jrMin) dbg.jrMin = bt.tile.jrMin;
        if (bt.tile.jrMax > dbg.jrMax) dbg.jrMax = bt.tile.jrMax;
        dbg.glow += bt.tile.glowN * reps;
        for (var gcx = 0; gcx < bt.tile.glowCols.length; gcx++)
          if (dbg.glowCols.indexOf(bt.tile.glowCols[gcx]) < 0) dbg.glowCols.push(bt.tile.glowCols[gcx]);
        if (bt.over) dbg.overDots += cov;
      }
    }

    // ── THE HERO FIREFLIES (animDots only — the few real movers) ──────
    // v0.97.1: the band-level weight range (heroes included) feeds the
    // instrument — the tiles alone miss the biggest dots at high variation
    if (T.jrMin < dbg.jrMin) dbg.jrMin = T.jrMin;
    if (T.jrMax > dbg.jrMax) dbg.jrMax = T.jrMax;
    var heroCount = 0;
    if (!hideDots && T.heroes.length) {
      var HERO_CAP = 40;
      for (var hi = 0; hi < T.heroes.length && heroCount < HERO_CAP; hi++) {
        var h = T.heroes[hi];
        var hbx = -(offsetX * scale * h.pf), hby = -(offsetY * scale * h.pf);
        var hbT = (h.M || T.MA) * spacingNow;   // v0.98: the hero's own layer period
        var k0x = Math.floor((-hbx - 120) / hbT), k1x = Math.floor((W - hbx + 120) / hbT);
        var k0y = Math.floor((-hby - 120) / hbT), k1y = Math.floor((H - hby + 120) / hbT);
        for (var kx = k0x; kx <= k1x && heroCount < HERO_CAP; kx++) {
          for (var ky = k0y; ky <= k1y && heroCount < HERO_CAP; ky++) {
            var gx = (kx * (h.M || T.MA) + h.tx) * spacingNow + h.jx * ps + hbx;   // v0.98: proportional jitter (×ps)
            var gy = (ky * (h.M || T.MA) + h.ty) * spacingNow + h.jy * ps + hby;
            var pulse = Math.sin(animT * h.tsp + h.tph);
            var jr = h.jr * (1 + 0.4 * pulse) * ps;   // ps: the bake→runtime scale
            var orA = animT * h.ospd + h.tph;
            var hx2 = gx + Math.cos(orA) * h.orR * ps;
            var hy2 = gy + Math.sin(orA) * h.orR * ps;
            if (hx2 < -20 || hx2 > W + 20 || hy2 < -20 || hy2 > H + 20) continue;
            var tal = 0.62 + 0.38 * (0.5 + 0.5 * pulse);
            var hgc = (h.over ? gctx2 : gctx);   // v0.98: the bake-stable layer assignment
            if (!hgc) continue;
            hgc.save();
            hgc.globalAlpha = tal;
            if (h.glow && jr >= 1.6) {
              var spG = lcGlowSprite(h.glow);
              var R = jr * 2.6;
              hgc.globalAlpha = tal * 0.55;
              hgc.drawImage(spG.c, hx2 - R, hy2 - R, R * 2, R * 2);
              hgc.globalAlpha = tal;
            }
            hgc.fillStyle = h.glow || h.col;
            hgc.beginPath();
            hgc.arc(hx2, hy2, Math.max(0.15, jr), 0, Math.PI * 2);
            hgc.fill();
            hgc.restore();
            heroCount++;
            dbg.glow++;
            if (dbg.glowCols.indexOf(h.glow || h.col) < 0) dbg.glowCols.push(h.glow || h.col);
          }
        }
      }
    }

    // ── the origin dot (verbatim) ────────────────────────────────────
    const o = { x: (0 - offsetX) * scale, y: (0 - offsetY) * scale };
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      gctx.fillStyle = lcPaint(specs && specs.originColor, (HEX_RE.test(t.originColor || '')) ? t.originColor : '#4a4a5e', gctx, W, H);
      gctx.beginPath();
      gctx.arc(o.x, o.y, ORIGIN_RADIUS * Math.min(scale, 1.5), 0, Math.PI * 2);
      gctx.fill();
    }

    // ── the frame instrument (the rigs' contract, unchanged shape) ────
    var lcNow = performance.now();
    if (lcLastT) lcFps = lcFps * 0.9 + (1000 / (lcNow - lcLastT)) * 0.1;
    lcLastT = lcNow;
    var stats = {
      dotsPainted: (cam.dots ? cam.dots.length : 0),
      originRadius: ORIGIN_RADIUS,
      stars: 0, dots: dbg.dots, segs: dbg.segs, amp: amp,
      dotBands: dbg.dotBands, lineBands: dbg.lineBands,
      dotStats: { small: dbg.dotSmall, big: dbg.dotBig, n: dbg.dots },
      lineStats: { small: dbg.lineSmall, big: dbg.lineBig, n: dbg.segs + dbg.fullLines },
      weight: { jrMin: dbg.jrMin === Infinity ? 0 : dbg.jrMin, jrMax: dbg.jrMax,
        wMin: dbg.wMin === Infinity ? 0 : dbg.wMin, wMax: dbg.wMax,
        effFracD: effFracD, effFracL: effFracL },
      overIcons: { on: !!(overDotsOn || overLinesOn),
        dots: dbg.overDots, lines: dbg.overLines,
        threshD: overDotsOn ? overThreshD : null,
        threshL: overLinesOn ? overThreshL : null },
      camera: { x: offsetX, y: offsetY, scale: scale },
      fps: Math.round(lcFps),
      batches: dbg.batches, buckets: dbg.buckets + T.list.length,
      cache: { gen: LC.gen, colorGen: LC.cgen,
        dot: TL.cellRecords, vline: LC.vline.size, hline: LC.hline.size,
        vseg: T.M * T.M, hseg: T.M * T.M },
      // v0.97: the one-object instrument — the rigs can prove the mode
      oneObject: { tiles: T.list.length, mega: T.MA, megaA: T.MA, megaB: T.MB,
                   pairCells: T.cells, raster: Math.round((T.R || 1) * 100) / 100,
                   heroes: heroCount, bakeGen: T.gen, tileMs: Math.round(T.bakeMs || 0),
                   bakeError: TL.bakeError || null },
      glow: { n: dbg.glow, colors: dbg.glowCols, sprites: LC.sprites.size },
      hits: LC.hits, misses: LC.misses,
      paintMs: Math.round((lcNow - t0) * 10) / 10
    };
    lastStats = stats;
    return stats;
  }

  // ══ THE LEGACY RENDER (pre-v0.97, byte-identical behavior) ════════
  // The verbatim renderGrid body, parameterized:
  // P: {specs, t, canvasSpec, bgFallback, gridSize, hideLines, hideDots,
  //     scatterL, scatterD, sizeVarL, sizeVarD, rotVarL, rotVarD,
  //     biasL, biasD, animDots, animLines, amp (0..1), bgP (0.08..0.35)}
  // cam: {ox, oy, scale}
  function renderLegacy(gctx, gctx2, W, H, cam, P) {
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
    // v0.94.1: THE WORLD-ANCHORED COLOR CACHE — the color fingerprint is
    // the SPEC ONLY (dot/line color sources). The old fingerprint embedded
    // offsetX/offsetY (and scale, via fpNow's param clear wiping the color
    // maps too), so ANY finger motion wiped dotC/vlineC/hlineC/vsegC/hsegC
    // and every visible cell re-sampled its color on the next frame
    // (~1,100 dots + up to ~2,900 segments per frame on a 1080x2400
    // viewport — the rig measured a 98% miss rate during pan). Colors are
    // now sampled in PARALLAX-WORLD space (the same space the param caches
    // already key on — see dix/diy), so a cell's color is a property of its
    // WORLD location: pure pan and zoom NEVER invalidate it. The visual:
    // the color field rides the world (the same anchoring model as the bg
    // tiles + the parallax bands) instead of swimming under a viewport-
    // fixed field; at rest the two are pixel-identical.
    var colFp = [dotSpec ? cheapJSON(dotSpec) : '', dotFallback,
                 lineSpec2 ? cheapJSON(lineSpec2) : '', lineFallback2].join('|');
    if (colFp !== LC.colFp) { LC.colFp = colFp; LC.cgen++; lcClearColors(); }
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
          if (colL === undefined) { colL = lineSampler ? lineSampler(x + offsetX * scale * lPF, H / 2 + offsetY * scale * lPF) : null; LC.vlineC.set(ix, colL); LC.misses++; } else LC.hits++;   // v0.94.1: world-anchored
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
            if (colS === undefined) { colS = lineSampler ? lineSampler(x + offsetX * scale * lPF, y + offsetY * scale * lPF) : null; LC.vsegC.set(skey, colS); LC.misses++; } else LC.hits++;   // v0.94.1: world-anchored
            var styleS = quantColor(colS || lineBandStyle);
            var aQ = tal < 1 ? Math.round(tal * 100) / 100 : 1; // v0.89.7: 100 alpha levels (was 10 — the stair-stepping shimmer on fading lines)
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
          if (colL2 === undefined) { colL2 = lineSampler ? lineSampler(W / 2 + offsetX * scale * lPF, y + offsetY * scale * lPF) : null; LC.hlineC.set(iy, colL2); LC.misses++; } else LC.hits++;   // v0.94.1: world-anchored
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
            if (colS2 === undefined) { colS2 = lineSampler ? lineSampler(x2 + offsetX * scale * lPF, y + offsetY * scale * lPF) : null; LC.hsegC.set(hkey, colS2); LC.misses++; } else LC.hits++;   // v0.94.1: world-anchored
            var styleS2 = quantColor(colS2 || lineBandStyle);
            var aQ2 = tal2 < 1 ? Math.round(tal2 * 100) / 100 : 1; // v0.89.7: same — 10-level alpha was visible banding
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
          if (colD === undefined) { colD = dotSampler ? dotSampler(x + offsetX * scale * dPF + DP.jx, y + offsetY * scale * dPF + DP.jy) : null; LC.dotC.set(dkey, colD); LC.misses++; } else LC.hits++;   // v0.94.1: sampled in parallax-world space — pan-stable per cell
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
            var aQ = tal < 1 ? Math.round(tal * 100) / 100 : 1; // v0.89.7: 100 alpha levels (was 8 — the pulsing dots stepped through 8 visible brightness jumps per cycle: THE nauseating shimmer)
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

    // ── v0.88.2→v0.90.1: THE COLLISION DOTS moved to #c2 ──────────
    // The orbit stars MOVE now (the weighty centroid chase in
    // tabgroups.js) — a full-frame #c1 paint can't follow them. They
    // paint per frame on the over-icons layer (atoms.js AtomCore.paintDots
    // — the atom pass's cheap frame covers them) and v0.90.2 adds the
    // nebula sphere there. The lattice keeps ONLY the origin dot here.
    // (cam.dots still rides the payload for the stats twin below.)

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
    renderLegacy: renderLegacy,     // v0.97: the A/B switch (also the fallback)
    setDpr: setDpr,                 // v0.97: the hosts report their DPR (tile bake sharpness)
    onTexReady: function (cb) { onTexReadyCb = cb; },
    // v0.97.1: the hosts ask after every frame — a pending debounced rebake
    // means THIS frame rendered stale tiles; the host schedules ONE
    // follow-up frame to land the fresh bake (without it, the last stale
    // frame sat on the bitmap forever once the ambient loop rested —
    // the mesh→plain parity catch).
    rebakePending: function () { return !!TL.bakeT; },
    lastStats: function () { return lastStats; },
    IN_WORKER: IN_WORKER,
    cheapJSON: cheapJSON,       // v0.88: the spec digests (app.js's gates)
    // v0.97: the one-object debug twin (the rigs' proof of mode + memory)
    oneObject: function () {
      return {
        active: !!(TL.tiles && TL.fp),
        tiles: TL.tiles ? TL.tiles.list.length : 0,
        mega: TL.tiles ? TL.tiles.M : 0,
        heroes: TL.tiles ? TL.tiles.heroes.length : 0,
        bakeGen: TL.gen,
        pending: !!TL.bakeT,
        legacyFails: TL.legacyFails,
        legacy: !!ROOT.__doomalayLatticeLegacy,
        lastError: TL.lastError || null,
        bakeError: TL.bakeError || null
      };
    }
  };
})();
