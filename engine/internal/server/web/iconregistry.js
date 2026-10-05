// iconregistry.js — v1.01.6 THE ICON REGISTRY + THE ATLAS + 9-SLICE
// (PLAN-V101 §v1.01.3; the user order: "continue with the new 9-slice
// icon atlas").
//
// THE REGISTRY — icon sets become swappable DATA (the Android RRO
// pattern): the builtin Lucide set stays the base; an imported set (the
// official Iconify JSON format — prefix + icons{name:{body}} + optional
// width/height/aliases) layers ON TOP and every IconLib consumer
// (hub cards, pickers, corpus rows) follows with zero call-site
// changes. NO runtime Iconify (offline reality; the JSON is just the
// data format). Sets persist in localStorage, hard-capped.
//
// THE ATLAS — one packed texture for many rastered assets: the vendored
// maxrects-packer bins {key,w,h,draw} rects into a 2048² (clamped)
// canvas, zero overlaps, deterministic layout. The icon-set rasters
// (and the theme's shape assets) join one texture instead of one
// canvas per glyph.
//
// 9-SLICE — the shape-chrome system: DOM side border-image (with the
// radius-safe mask split where corners must round), Pixi side
// NineSliceSprite. A 9-slice asset stretches its EDGES and scales its
// CENTER — a card chrome image survives any size without distortion.
(function () {
  'use strict';

  // ── security caps (untrusted-DATA discipline) ─────────────────────
  var MAX_ICONS = 512;          // per set
  var MAX_BODY = 65536;         // per icon body, chars
  var MAX_NAME = 64;            // per icon name, chars
  var MAX_SETS = 16;            // total imported
  var MAX_STORE = 2 * 1024 * 1024;  // total localStorage payload
  var STORE_KEY = 'doomalay.iconreg.v1';

  // the SVG fragment whitelist — Iconify bodies are path/shape soup.
  // Anything else (script, foreignObject, image, use, event attrs…)
  // is stripped at import; unknown tags are REJECTED (fail the whole
  // icon, never half-render an attack).
  var TAG_OK = { path: 1, circle: 1, rect: 1, ellipse: 1, line: 1,
    polyline: 1, polygon: 1, g: 1, defs: 1, clipPath: 1, title: 1 };
  var ATTR_OK = { d: 1, cx: 1, cy: 1, r: 1, rx: 1, ry: 1, x: 1, x1: 1,
    x2: 1, y: 1, y1: 1, y2: 1, width: 1, height: 1, points: 1,
    transform: 1, opacity: 1, fill: 1, stroke: 1, 'stroke-width': 1,
    'stroke-linecap': 1, 'stroke-linejoin': 1, 'stroke-dasharray': 1,
    'fill-opacity': 1, 'stroke-opacity': 1, 'fill-rule': 1,
    'clip-path': 1, 'clip-rule': 1, id: 1, offset: 1, gradientUnits: 1 };

  function sanitizeBody(body) {
    var b = String(body || '');
    if (!b || b.length > MAX_BODY) return null;
    // no scripts/event handlers/url() refs — whitelist tags first
    var tags = b.match(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g) || [];
    for (var i = 0; i < tags.length; i++) {
      var m = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tags[i]);
      if (!m || !TAG_OK[m[1].toLowerCase()]) return null;
    }
    // strip any attribute outside the whitelist (regex walk per tag)
    var out = b.replace(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\/?>/g,
      function (all, tag, attrs) {
        var kept = '';
        var re = /([a-zA-Z-:]+)\s*=\s*("[^"]*"|'[^']*')/g, am;
        while ((am = re.exec(attrs))) {
          var an = am[1].toLowerCase();
          var av = am[2].slice(1, -1);
          if (!ATTR_OK[an]) continue;
          if (/<|>/i.test(av)) continue;                  // no nested markup
          if (an === 'fill' || an === 'stroke') {
            if (/url\s*\(/i.test(av)) continue;           // no external refs
          }
          kept += ' ' + an + '="' + av.replace(/"/g, '&quot;') + '"';
        }
        return '<' + tag + kept + '>';
      });
    return out;
  }

  function sanitizeName(n) {
    var s = String(n || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return (s.length && s.length <= MAX_NAME) ? s : null;
  }

  // ── the registry state ────────────────────────────────────────────
  var state = { active: '', sets: {} };   // name → {icons, width, height}
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      var p = JSON.parse(raw);
      if (p && typeof p === 'object' && p.sets && typeof p.sets === 'object') {
        state.active = String(p.active || '');
        state.sets = p.sets;
      }
    }
  } catch (e) { /* corrupt store — start clean */ }

  function persist() {
    try {
      var j = JSON.stringify(state);
      if (j.length > MAX_STORE) return { ok: false,
        err: 'set store full (' + Math.round(j.length / 1024) + 'KB > ' +
          Math.round(MAX_STORE / 1024) + 'KB cap)' };
      localStorage.setItem(STORE_KEY, j);
      return { ok: true };
    } catch (e) {
      return { ok: false, err: 'storage rejected: ' + (e && e.message) };
    }
  }

  // importIconify(json, name?) — validate + register an Iconify-JSON
  // set. Returns {ok, name, count} or {ok:false, err}.
  function importIconify(json, wantName) {
    if (!json || typeof json !== 'object') return { ok: false, err: 'not an object' };
    var icons = json.icons;
    if (!icons || typeof icons !== 'object') return { ok: false, err: 'missing icons{}' };
    var names = Object.keys(icons);
    if (!names.length) return { ok: false, err: 'empty icons{}' };
    if (names.length > MAX_ICONS) return { ok: false, err: names.length + ' icons > cap ' + MAX_ICONS };
    var name = sanitizeName(wantName || json.prefix || 'set');
    if (!name) return { ok: false, err: 'bad set name' };
    if (name === 'lucide') return { ok: false, err: '"lucide" is reserved' };
    var clean = {};
    var count = 0;
    for (var i = 0; i < names.length; i++) {
      var iname = sanitizeName(names[i]);
      var entry = icons[names[i]];
      if (!iname || !entry || typeof entry.body !== 'string') continue;
      var body = sanitizeBody(entry.body);
      if (!body) continue;                      // a poisoned icon drops silently
      clean[iname] = { body: body };
      count++;
    }
    // aliases fold onto their targets
    var al = json.aliases || {};
    Object.keys(al).forEach(function (k) {
      var an = sanitizeName(k), t = al[k] && al[k].parent &&
        sanitizeName(al[k].parent);
      if (an && t && clean[t] && !clean[an]) clean[an] = clean[t];
    });
    if (!count) return { ok: false, err: 'no valid icons after sanitize' };
    if (Object.keys(state.sets).length >= MAX_SETS && !state.sets[name]) {
      return { ok: false, err: 'too many sets (cap ' + MAX_SETS + ')' };
    }
    state.sets[name] = {
      icons: clean,
      width: Number(json.width) || 24,
      height: Number(json.height) || 24
    };
    var pr = persist();
    if (!pr.ok) { delete state.sets[name]; return pr; }
    return { ok: true, name: name, count: count };
  }

  function removeSet(name) {
    if (!state.sets[name]) return { ok: false, err: 'no such set' };
    delete state.sets[name];
    if (state.active === name) state.active = '';
    persist();
    return { ok: true };
  }

  function useSet(name) {
    if (name !== '' && !state.sets[name]) return { ok: false, err: 'no such set' };
    state.active = name || '';
    persist();
    return { ok: true };
  }

  function sets() {
    var out = [{ name: 'lucide (builtin)', id: '', builtin: true, count: window.IconLib ? window.IconLib.NAMES.length : 0 }];
    Object.keys(state.sets).forEach(function (k) {
      out.push({ name: k, id: k, count: Object.keys(state.sets[k].icons).length });
    });
    return out;
  }

  function active() { return state.active; }

  // resolve(name) → {body, width, height} | null — the layered lookup
  // (active set → builtin lucide).
  function resolve(name) {
    var n = String(name || '');
    var s = state.sets[state.active];
    if (s && s.icons[n]) return { body: s.icons[n].body, width: s.width, height: s.height };
    return null;
  }

  // THE PATCH — every IconLib.svg render resolves through the registry:
  // the active set's glyph wins, else the builtin (byte-identical to
  // before when no set is active).
  var Lib = (typeof window !== 'undefined') ? window.IconLib : null;
  if (Lib && Lib.svg) {
    var baseSvg = Lib.svg;
    Lib.svg = function (name, size) {
      var r = resolve(name);
      if (r) {
        size = size || 18;
        return '<svg class="icl icl-' + String(name).replace(/[^a-z0-9-]/g, '') +
          '" xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
          '" viewBox="0 0 ' + r.width + ' ' + r.height +
          '" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          r.body + '</svg>';
      }
      return baseSvg(name, size);
    };
    var baseHas = Lib.has;
    Lib.has = function (name) { return !!resolve(name) || baseHas(name); };
  }

  // ── THE ATLAS (maxrects, one texture) ─────────────────────────────
  // pack(entries, opts?) — entries: [{key, w, h, draw(ctx, x, y)}]
  // → { ok, canvas, w, h, map:{key:{x,y,w,h}} } — deterministic, zero
  // overlap (maxrects guarantees it; the rig asserts it).
  function pack(entries, opts) {
    opts = opts || {};
    var MRP = (typeof window !== 'undefined') ? window.MaxRectsPackerLib : null;
    if (!MRP || !MRP.MaxRectsPacker) return { ok: false, err: 'maxrects not vendored' };
    if (!Array.isArray(entries) || !entries.length) return { ok: false, err: 'no entries' };
    if (entries.length > 1024) return { ok: false, err: 'too many entries' };
    var pad = Number(opts.padding) || 0;
    var clamp = Math.min(Number(opts.maxSize) || 2048, 2048);  // 16MB RGBA
    var packer = new MRP.MaxRectsPacker(clamp, clamp, pad,
      { square: true, allowRotation: false });
    var valid = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var w = Math.round(Number(e.w) || 0), h = Math.round(Number(e.h) || 0);
      if (w <= 0 || h <= 0 || w > clamp || h > clamp) continue;
      valid.push({ key: String(e.key || i), w: w, h: h, draw: e.draw });
    }
    if (!valid.length) return { ok: false, err: 'no valid entries' };
    packer.addArray(valid.map(function (e) { return { width: e.w, height: e.h, data: e }; }));
    var bins = packer.bins;
    if (!bins.length) return { ok: false, err: 'packing produced no bins' };
    if (bins.length > 1 && !opts.multiBin) {
      return { ok: false, err: 'overflow: ' + bins.length + ' bins (reduce entries or size)' };
    }
    var bin = bins[0];
    var W = bin.width, H = bin.height;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var map = {};
    var rects = bin.rects || [];
    for (var r = 0; r < rects.length; r++) {
      var rc = rects[r];
      var ent = rc.data;
      if (!ent) continue;
      ctx.save();
      if (typeof ent.draw === 'function') ent.draw(ctx, rc.x, rc.y, rc.width, rc.height);
      ctx.restore();
      map[ent.key] = { x: rc.x, y: rc.y, w: rc.width, h: rc.height };
    }
    return { ok: true, canvas: cv, w: W, h: H, map: map };
  }

  // ── 9-SLICE (the shape-chrome system) ─────────────────────────────
  // nineSlice(el, src, slice, opts) — apply a 9-slice image as a card
  // chrome on a DOM element. slice = [top,right,bottom,left] px in the
  // source. opts: {width: border-width px (default = slice), radius:
  // keep rounded corners via the MASK SPLIT (Chrome clips border-image
  // under border-radius — the element paints its own radius-shaped
  // mask; the research's verified combo)}.
  function nineSlice(el, src, slice, opts) {
    if (!el || !src) return { ok: false, err: 'el + src required' };
    opts = opts || {};
    var s = Array.isArray(slice) && slice.length === 4 ? slice :
      (typeof slice === 'number' ? [slice, slice, slice, slice] : null);
    if (!s) return { ok: false, err: 'slice must be [t,r,b,l] or a number' };
    var w = (opts.width != null) ? opts.width : Math.max(s[0], s[1], s[2], s[3]);
    var u = String(src).replace(/"/g, '%22');
    var st = el.style;
    st.borderImageSource = 'url("' + u + '")';
    st.borderImageSlice = s[0] + ' ' + s[1] + ' ' + s[2] + ' ' + s[3] + ' fill';
    st.borderImageWidth = w + 'px';
    st.borderImageOutset = '0';
    st.borderImageRepeat = 'stretch';
    if (opts.radius) {
      // THE MASK SPLIT — the radius-safe combo: the element keeps its
      // border-radius (a mask shaped by the radius) while border-image
      // paints the chrome (Chrome would otherwise clip the image's
      // corners square against a rounded border-box).
      st.borderRadius = opts.radius;
      st.webkitMaskImage =
        'linear-gradient(#000 0 0)';
      st.maskImage = 'linear-gradient(#000 0 0)';
      st.webkitMaskClip = 'border-box';
      st.maskClip = 'border-box';
    }
    return { ok: true };
  }
  function clearNineSlice(el) {
    if (!el) return;
    var st = el.style;
    ['borderImageSource', 'borderImageSlice', 'borderImageWidth',
     'borderImageOutset', 'borderImageRepeat'].forEach(function (p) { st[p] = ''; });
  }

  // sprite9(tex, slice, w, h) — the Pixi-side twin: a NineSliceSprite
  // from a texture (the canvas member-class shapes). Returns the sprite
  // (the caller adds it to its container).
  function sprite9(PIXI, tex, slice, w, h) {
    if (!PIXI || !PIXI.NineSliceSprite || !tex) return null;
    var s = Array.isArray(slice) && slice.length === 4 ? slice :
      [slice, slice, slice, slice];
    var sp = new PIXI.NineSliceSprite(tex,
      s[3] || 0, s[0] || 0, s[1] || 0, s[2] || 0);   // left, top, right, bottom
    if (w) sp.width = w;
    if (h) sp.height = h;
    return sp;
  }

  window.IconReg = {
    importIconify: importIconify, removeSet: removeSet,
    useSet: useSet, sets: sets, active: active, resolve: resolve,
    _sanitizeBody: sanitizeBody
  };
  window.DoomAtlas = { pack: pack };
  window.DoomChrome = { nineSlice: nineSlice, clearNineSlice: clearNineSlice, sprite9: sprite9 };
})();
