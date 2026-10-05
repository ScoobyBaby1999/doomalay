// uikit.js — v0.44 THE SHARED UI KIT: pills, gradients, and the cropper.
//
// THE GRADIENT SPEC v2 (the binding contract every consumer obeys —
// theme.js / appearance.js / tweaks.js / hubpublish.js in Wave 2):
//
//   spec = { colors: ['#rrggbb', …]      1..15 stops (first = the solid)
//            dir:    'auto'|'h'|'v'|'diag'|'diag2'|'radial'|'swirl'|'mesh'
//                  | 'pat-navy'|'pat-pinstripe'|'pat-gingham'
//                  | 'pat-sunburst'|'pat-checker'
//            angle:  0..360 int           optional — meaningful for 'diag'
//            tex:    'data:image/jpeg…'   optional texture dataURL (the
//                                         BOTTOM background-image layer;
//                                         consumers set
//                                         background-blend-mode:color —
//                                         check GradientUI.BLENDED) }
//
//   BACKWARD COMPAT (all still work): a bare '#hex' string, a plain
//   colors ARRAY, and {colors:[…]} with no dir = legacy 1-color/'auto'.
//   GradientUI.norm(v) folds every shape into a valid spec.
//
// THE RECIPES (stops = colors joined with ', '):
//   auto  linear 135°          h  linear 90°           v  linear 180°
//   diag  linear <angle|135>°  diag2 linear 315°       radial circle 50% 35%
//   swirl conic from 240° wrapping back to the first color
//   mesh  4 layered radials over a base linear
//   pat-* repeating patterns: navy / pinstripe / gingham / sunburst /
//         checker (single-color specs synthesize their 2nd stop)
//
// THE TWIN ARCHITECTURE: consumers write var twins per slot —
//   --X = GradientUI.solid(spec)        (compat: canvas fillStyle,
//                                        meta-theme-color, -rgb triplets)
//   --X-gradient = GradientUI.twins(spec).css   (full layer stack or the
//                                        bare hex; consumers add
//                                        background-image:var(--X-gradient))
//   1-color simple specs return the BARE hex from css() so legacy
//   background-color callers keep working untouched.
//
// CropUI v2: pinch-zoom (evCache + focal math), ↻ rotate 90° (baked
// into the source bitmap), double-tap reset. touch-action:none comes
// from the one-time injected <style id="uikit-v2-style"> — index.html
// is NOT touched (the v0.33 .gr-mini look is matched, not duplicated).
//
// Node-testable: nothing at module top-level touches document/window;
// in a browser the kit lands on window.*, under node it exports
// { GradientUI, hexToRgb, darken, lighten, rgba } for the self-test
// script (scripts/test_uikit.js runs the whole contract).
//
// Exposes: window.UIPills, window.GradientUI, window.CropUI

(function () {
  'use strict';

  // esc() is PURE (node-safe — the old div.innerHTML trick needed a
  // DOM; this is the identical escape set, no document required).
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  // ══ injected styles (once, DOM-guarded — index.html stays put) ═══
  // The v2 editor controls (dir pills / pattern row / angle / texture)
  // and the crop stage's touch-action ship with the kit. Injected on
  // load, idempotent by #uikit-v2-style, skipped entirely under node.
  (function injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('uikit-v2-style')) return;
    var css = [
      // live preview bar — v0.54 polish: taller, even radius
      '.gr-preview-bar{height:40px;border-radius:12px;margin-bottom:10px;',
      'border:1px solid var(--border);background-repeat:no-repeat;',
      'background-size:cover;background-position:center;flex-shrink:0;',
      'box-shadow:inset 0 0 0 1px rgba(var(--highlight-inset-rgb),0.04)}',
      // shared row wrapper for the v2 control rows
      '.gr-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.gr-row-pat{margin-top:6px}',
      '.gr-row-label{font-size:var(--ui-micro-fs);color:var(--text-3);',
      'font-weight:700;letter-spacing:.05em;text-transform:uppercase;',
      'margin-right:2px;user-select:none}',
      // dir + pattern pills — v0.54: the active state is the app's
      // accent tint (matching .dx-pill[data-on]) instead of flat surface
      // v0.91.2: NATIVE — the fill + ring ride the --raised-chrome vars
      // (a plain var(--surface-2) fill here fed the GATES border-plate
      // auto-window, re-projecting every dir pill under gradient twins)
      '.gr-dir{border:1px solid var(--raised-ring);background-color:var(--raised-chrome);',
      'color:var(--text-3);border-radius:9px;padding:4px 10px;',
      'font-size:calc(var(--ui-small-fs) - 2px);min-height:30px;',
      'font-family:inherit;cursor:pointer;line-height:1.2;',
      'transition:border-color .15s,color .15s,background .15s;',
      'touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
      '.gr-dir:hover{border-color:var(--border-strong);color:var(--text-2)}',
      '.gr-dir[data-on="1"]{border-color:var(--accent);',
      'background:rgba(var(--accent-rgb),0.14);color:var(--text-1);',
      'font-weight:600}',
      // the angle row (only rendered for dir === 'diag')
      '.gr-row-angle{gap:8px}',
      '.gr-angle{flex:1;min-width:110px;accent-color:var(--accent)}',
      '.gr-angle-val{font-size:var(--ui-micro-fs);color:var(--text-2);',
      'font-weight:700;font-variant-numeric:tabular-nums;min-width:38px;',
      'text-align:right}',
      // the texture row (40px thumb + pick/remove)
      '.gr-tex-thumb{display:inline-block;width:40px;height:40px;',
      'border-radius:10px;border:1px solid var(--border);',
      'background-size:cover;background-position:center;',
      'background-repeat:no-repeat;flex-shrink:0}',
      // pinch-zoom needs the browser's gestures switched OFF here
      '.crop-stage{touch-action:none}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'uikit-v2-style';
    st.textContent = css;
    (document.head || document.getElementsByTagName('head')[0] || document.documentElement)
      .appendChild(st);
  })();

  // ══ UIPills — the modular pill system (unchanged v0.33) ═══════════
  //
  // Every pill in the app routes through here so they share ONE visual
  // language (the CSS lives in index.html's .dx-pill block). Pills are
  // compact — "as little as possible without compromising visuals" —
  // and theme-aware through CSS variables, never hardcoded colors.
  var UIPills = {
    // pill(opts) → '<button class="dx-pill …" …>…</button>'
    //   opts.label   visible text (required)
    //   opts.icon    optional prefix glyph (emoji or html) — rendered
    //                inside its own span so emoji + text align
    //   opts.on      selected state → data-on="1"
    //   opts.tone    'persona' | 'template' — the selected state tints
    //                purple / green (theme-dependent); default = accent
    //   opts.cls     extra classes ('dx-pill--sm' etc.)
    //   opts.attrs   {name: value} extra attributes (data-sort=…)
    pill: function (opts) {
      opts = opts || {};
      var attrs = '';
      Object.keys(opts.attrs || {}).forEach(function (k) {
        attrs += ' ' + k + '="' + escAttr(opts.attrs[k]) + '"';
      });
      var cls = 'dx-pill' + (opts.cls ? ' ' + opts.cls : '');
      if (opts.tone) attrs += ' data-tone="' + escAttr(opts.tone) + '"';
      if (opts.on) attrs += ' data-on="1"';
      if (opts.id) attrs += ' id="' + escAttr(opts.id) + '"';
      return '<button type="button" class="' + cls.trim() + '"' + attrs + '>' +
        (opts.icon ? '<span class="dx-pill-ico">' + opts.icon + '</span>' : '') +
        '<span class="dx-pill-label">' + esc(opts.label || '') + '</span>' +
        '</button>';
    },

    // chip(label, opts) → a non-interactive tag chip. opts.rm is an
    // attribute string for the remove button ('data-untag="3"') — omit
    // it for plain display chips (the item detail's tags).
    chip: function (label, opts) {
      opts = opts || {};
      return '<span class="dx-chip">' + esc(label) +
        (opts.rm ? '<button type="button" class="dx-chip-x" ' + opts.rm +
          ' title="remove" aria-label="remove">✕</button>' : '') +
        '</span>';
    }
  };

  // ══ GradientUI v2 — the full gradient system ═════════════════════
  //
  // One editor, every consumer. MIN 1 color (a single stop = a solid
  // fill), MAX 15. The caller owns the SPEC OBJECT; wire() mutates it
  // in place (colors.splice/push, dir=, angle=, tex=) and calls back.
  var MAX_COLORS = 15;
  var DEFAULT_COLORS = ['#38bdf8', '#a78bfa'];
  var VALID_DIRS = ['auto', 'h', 'v', 'diag', 'diag2', 'radial', 'swirl', 'mesh',
    'pat-navy', 'pat-pinstripe', 'pat-gingham', 'pat-sunburst', 'pat-checker'];
  // 1-color simple dirs are the legacy passthrough: css() hands back
  // the bare hex so background-color callers never see a gradient.
  var SIMPLE_DIRS = { auto: 1, h: 1, v: 1, diag: 1, diag2: 1, radial: 1 };

  // the editor's style + pattern pill sets (label, data-gr-dir)
  var DIR_STYLES = [
    ['auto', '⤢ auto'], ['h', '→ h'], ['v', '↓ v'], ['diag', '↗ diag'],
    ['diag2', '↖ diag2'], ['radial', '◎ radial'], ['swirl', '🌀 swirl'],
    ['mesh', '✦ mesh']
  ];
  var DIR_PATTERNS = [
    ['pat-navy', 'navy'], ['pat-pinstripe', 'pinstripe'],
    ['pat-gingham', 'gingham'], ['pat-sunburst', 'sunburst'],
    ['pat-checker', 'checker']
  ];

  // ── color helpers (pure — exported under node for the tests) ─────
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) {
      var v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * v).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var m = hex.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: s * 100, l: l * 100 };
  }

  // amt = percentage points of the HSL L channel, clamped to 0..100.
  // Unparseable hexes pass through untouched (total functions).
  function darken(hex, amt) {
    var rgb = hexToRgb(hex);
    if (!rgb) return hex;
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return hslToHex(hsl.h, hsl.s, Math.max(0, Math.min(100, hsl.l - amt)));
  }
  function lighten(hex, amt) {
    var rgb = hexToRgb(hex);
    if (!rgb) return hex;
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return hslToHex(hsl.h, hsl.s, Math.max(0, Math.min(100, hsl.l + amt)));
  }
  function rgba(hex, a) {
    var rgb = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
    var av = String(Math.round(a * 1000) / 1000).replace(/^0\./, '.');
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + av + ')';
  }

  // v0.54: linear hex interpolation (mesh long-palette spot sampling + the
  // canvas patternColorAt's shared geometry). Pure, total: bad hexes pass a
  // through unchanged (same contract as darken/lighten).
  function mixHex(a, b, t) {
    var ra = hexToRgb(a), rb = hexToRgb(b);
    if (!ra || !rb) return a;
    t = Math.max(0, Math.min(1, t));
    function h2(v) {
      var s = Math.round(v).toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    return '#' + h2(ra.r + (rb.r - ra.r) * t) +
      h2(ra.g + (rb.g - ra.g) * t) + h2(ra.b + (rb.b - ra.b) * t);
  }

  // v0.54: the MESH spot table — the first four are the original v0.44 pins
  // (selftests pin them byte-for-byte); entries 5–8 widen the field for
  // longer palettes so EVERY stop lands on a spot. Shared with app.js's
  // canvas painter (paintBackgroundInto mirrors it) so the background art
  // and the dot/line sampling agree.
  var MESH_SPOTS = [
    { x: 20, y: 25, f: 55 }, { x: 80, y: 15, f: 50 },
    { x: 75, y: 80, f: 55 }, { x: 15, y: 85, f: 50 },
    { x: 55, y: 8, f: 45 }, { x: 38, y: 55, f: 50 },
    { x: 92, y: 58, f: 48 }, { x: 8, y: 45, f: 52 }
  ];

  // v0.54: sample a palette as ONE hex at t∈[0,1] (across all stops).
  function paletteAt(colors, t) {
    if (!colors || !colors.length) return '#000000';
    if (colors.length === 1) return colors[0];
    t = Math.max(0, Math.min(1, t));
    var f = t * (colors.length - 1);
    var i = Math.min(colors.length - 2, Math.floor(f));
    return mixHex(colors[i], colors[i + 1], f - i);
  }

  var GradientUI = {
    MAX: MAX_COLORS,

    // consumers check this before opting into background-blend-mode
    BLENDED: true,

    // ── norm(v) → always a valid spec (pure; copies, never mutates) ─
    //   '#aabbcc'            → {colors:['#aabbcc'], dir:'auto'}
    //   ['#a','#b']          → {colors:[…],         dir:'auto'}
    //   {colors,dir,angle,tex} → sanitized copy
    //   anything else        → the fallback spec
    norm: function (v) {
      var colors = null;
      if (typeof v === 'string' && v.charAt(0) === '#') colors = [v];
      else if (Array.isArray(v)) colors = v.slice();
      else if (v && typeof v === 'object' && Array.isArray(v.colors)) {
        colors = v.colors.slice();
      }
      if (colors) {
        colors = colors.filter(function (x) {
          return typeof x === 'string' && x.length > 0;
        });
      }
      if (!colors || !colors.length) {
        colors = DEFAULT_COLORS.slice();
      }
      if (colors.length > MAX_COLORS) colors = colors.slice(0, MAX_COLORS);
      var spec = { colors: colors, dir: 'auto' };
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (VALID_DIRS.indexOf(v.dir) >= 0) spec.dir = v.dir;
        if (typeof v.angle === 'number' && isFinite(v.angle)) {
          spec.angle = Math.max(0, Math.min(360, Math.round(v.angle)));
        }
        if (typeof v.tex === 'string' && v.tex.length) spec.tex = v.tex;
      }
      return spec;
    },

    // ── css(v, opts) → the background-image value ─────────────────
    // 1 color + a simple dir + no tex → the BARE hex (legacy callers
    // paint with background-color). Everything else → the recipe
    // string; a tex appends ', url("<tex>")' as the bottom layer (a
    // 1-color simple dir becomes a flat 2-stop gradient underneath).
    //
    // v0.54 (user spec: "some items don't follow colors as well as
    // others… mesh, checkers… changing the options doesn't seem to
    // affect the coloring"): every PATTERN recipe now consumes the FULL
    // palette (stops 5–15 no longer ignored) and css() takes
    // opts.scale — a px multiplier for the repeating recipes so small
    // previews (the collapsed-row banner, 64×18) can show several
    // pattern periods instead of one clipped cell.
    css: function (v, opts) {
      opts = opts || {};
      var scale = (typeof opts.scale === 'number' && isFinite(opts.scale)
        && opts.scale > 0) ? opts.scale : 1;
      function px(n) { return Math.max(1, Math.round(n * scale)); }
      var s = GradientUI.norm(v);
      var c = s.colors;
      var dir = s.dir;
      var hasTex = !!s.tex;
      var multi = c.length > 1;

      if (!multi && !hasTex && SIMPLE_DIRS[dir]) return c[0];

      var stops = c.join(', ');
      if (!multi && SIMPLE_DIRS[dir]) stops = c[0] + ', ' + c[0]; // flat layer

      var layer;
      switch (dir) {
        case 'h':
          layer = 'linear-gradient(90deg, ' + stops + ')';
          break;
        case 'v':
          layer = 'linear-gradient(180deg, ' + stops + ')';
          break;
        case 'diag':
          layer = 'linear-gradient(' +
            (typeof s.angle === 'number' ? s.angle : 135) +
            'deg, ' + stops + ')';
          break;
        case 'diag2':
          layer = 'linear-gradient(315deg, ' + stops + ')';
          break;
        case 'radial': {
          // v1.03.5 THE UNIVERSAL ANGLE — the radial focal ORBITS the
          // angle ray (0° = top, clockwise — the same convention as the
          // linear slider). Layerless: a pure position recipe, no minted
          // pseudo, no transform. No angle → the pinned 50% 35%.
          if (typeof s.angle === 'number' && isFinite(s.angle)) {
            var frr = s.angle * Math.PI / 180;
            var fx = 50 + 35 * Math.sin(frr);
            var fy = 50 - 35 * Math.cos(frr);
            layer = 'radial-gradient(circle at ' + fx.toFixed(1) + '% ' + fy.toFixed(1) + '%, ' + stops + ')';
          } else {
            layer = 'radial-gradient(circle at 50% 35%, ' + stops + ')';
          }
          break;
        }
        case 'swirl': {
          // the closing stop wraps the conic sweep back to the first
          // color; a single color gets a lightened 2nd stop first
          var sw = multi ? stops : (c[0] + ', ' + lighten(c[0], 25));
          layer = 'conic-gradient(from 240deg at 55% 45%, ' + sw + ', ' + c[0] + ')';
          break;
        }
        case 'mesh': {
          // v0.54: the spot count follows the palette (4–8), spots cycle
          // the FULL palette, and palettes longer than the table sample
          // by interpolation — every stop lands on the art.
          // v1.03.5: the angle ROTATES the spot constellation around the
          // box center (clockwise from north — the slider's convention).
          var k = Math.max(4, Math.min(MESH_SPOTS.length, c.length));
          var parts = [];
          for (var i = 0; i < k; i++) {
            var mcol = (c.length <= MESH_SPOTS.length)
              ? c[i % c.length]
              : paletteAt(c, i / (k - 1));
            // v1.03.5: the angle ROTATES the spot constellation around
            // the box center (clockwise from north — the slider's
            // convention). No angle → the pinned legacy positions.
            var mAt = MESH_SPOTS[i].x + '% ' + MESH_SPOTS[i].y + '%';
            if (typeof s.angle === 'number' && isFinite(s.angle)) {
              var mrot = s.angle * Math.PI / 180;
              var mx = MESH_SPOTS[i].x - 50, my = MESH_SPOTS[i].y - 50;
              mAt = (50 + (mx * Math.cos(mrot) - my * Math.sin(mrot))).toFixed(1) + '% ' +
                    (50 + (mx * Math.sin(mrot) + my * Math.cos(mrot))).toFixed(1) + '%';
            }
            parts.push('radial-gradient(at ' + mAt + ', ' + mcol + ' 0px, transparent ' +
              MESH_SPOTS[i].f + '%)');
          }
          var base = c.length > 1 ? c[c.length - 1] : darken(c[0], 20);
          parts.push('linear-gradient(' + base + ')');
          layer = parts.join(', ');
          break;
        }
        case 'pat-navy': {
          // v0.54: stripes cycle ALL stops (period = n·stripeWidth).
          // seg() keeps the historical '0' (no unit) for the zero bound —
          // the selftests pin the 2-color string byte-for-byte.
          function seg(v) { return v === 0 ? '0' : v + 'px'; }
          var nc = c.length > 1 ? c : [c[0], darken(c[0], 18)];
          var swid = px(14);
          var nstops = [];
          for (var ni = 0; ni < nc.length; ni++) {
            nstops.push(nc[ni] + ' ' + seg(ni * swid) + ' ' + seg((ni + 1) * swid));
          }
          layer = 'repeating-linear-gradient(45deg, ' + nstops.join(', ') + ')';
          break;
        }
        case 'pat-pinstripe': {
          var ps = px(18);
          // v1.03.5: the angle rotates the stripes (θ=0 keeps the
          // classic vertical bands — the gradient axis rides 90°+θ;
          // θ=90 → horizontal).
          var pAng = 90 + ((typeof s.angle === 'number' && isFinite(s.angle)) ? s.angle : 0);
          if (c.length <= 2) {
            var p2 = c.length > 1 ? c[1] : lighten(c[0], 18);
            layer = 'repeating-linear-gradient(' + pAng + 'deg, transparent 0 ' + ps + 'px, ' +
              rgba(c[0], 0.35) + ' ' + ps + 'px ' + (ps + 1) + 'px), ' +
              'linear-gradient(160deg, ' + c[0] + ', ' + p2 + ')';
          } else {
            // v0.54: each palette stop (from the 2nd on) gets its own
            // thin stripe layer, offset so the stripes interleave — the
            // base sweeps first → last. Capped at 6 stripe layers.
            var stripes = [];
            for (var pi = 1; pi < c.length && pi <= 6; pi++) {
              var poff = ps + (pi - 1) * (ps + 1);
              stripes.push('repeating-linear-gradient(' + pAng + 'deg, transparent 0 ' +
                poff + 'px, ' + rgba(c[pi], 0.35) + ' ' + poff + 'px ' +
                (poff + 1) + 'px)');
            }
            layer = stripes.join(', ') + ', linear-gradient(160deg, ' +
              c[0] + ', ' + c[c.length - 1] + ')';
          }
          break;
        }
        case 'pat-gingham': {
          // v0.54: horizontal bands cycle the EVEN stops, vertical the
          // ODD stops (≤3 stops = the original exact recipe: c0 bands, c1
          // bands, base c2), base = the last stop once the palette
          // outgrows the classic trio.
          var band = px(40);
          var evenC = [c[0]], oddC = [c.length > 1 ? c[1] : c[0]];
          if (c.length > 3) {
            evenC = []; oddC = [];
            for (var gi = 0; gi < c.length; gi++) {
              (gi % 2 === 0 ? evenC : oddC).push(c[gi]);
            }
            // the last stop IS the base — keep it out of the band cycles
            if (evenC[evenC.length - 1] === c[c.length - 1]) evenC.pop();
            else if (oddC[oddC.length - 1] === c[c.length - 1]) oddC.pop();
          }
          function bandLayer(axis, list, alpha) {
            if (list.length <= 1) {
              return 'repeating-linear-gradient(' + axis + 'deg, ' +
                rgba(list[0] || c[0], alpha) + ' 0 ' + band + 'px, transparent ' +
                band + 'px ' + (band * 2) + 'px)';
            }
            var bs = [];
            for (var bi = 0; bi < list.length; bi++) {
              bs.push(rgba(list[bi], alpha) + ' ' + (bi * band) + 'px ' +
                ((bi + 1) * band) + 'px');
            }
            return 'repeating-linear-gradient(' + axis + 'deg, ' + bs.join(', ') + ')';
          }
          var gBase = c.length > 3 ? c[c.length - 1]
            : (c.length > 2 ? c[2] : lighten(c[0], 30));
          layer = bandLayer(0, evenC, 0.55) + ', ' + bandLayer(90, oddC, 0.35) +
            ', linear-gradient(' + gBase + ')';
          break;
        }
        case 'pat-sunburst': {
          // v0.54: rays cycle ALL stops — the wedge shrinks as the
          // palette grows (2 stops keep the pinned 15° rays).
          var sc = c.length > 1 ? c : [c[0], lighten(c[0], 18)];
          var wedge = Math.max(3, Math.round(30 / sc.length));
          var rays = [];
          for (var si = 0; si < sc.length; si++) {
            rays.push(sc[si] + ' ' + (si * wedge) + 'deg ' + ((si + 1) * wedge) + 'deg');
          }
          layer = 'repeating-conic-gradient(from 0deg at 50% 100%, ' + rays.join(', ') + ')';
          break;
        }
        case 'pat-checker': {
          // v0.49 FIX (the reported "checker doesn't work"): the old recipe
          // appended `0 0 / 32px 32px` — position/size are only legal in the
          // background SHORTHAND, not in background-image, so every
          // var-twin consumer (`background-image: var(--X-gradient)`) saw an
          // INVALID declaration and dropped it — nothing painted, anywhere.
          // The fix: a self-tiling SVG data-URL. It is valid in
          // background-image AND border-image AND <img>/canvas, and tiles by
          // default (background-repeat: repeat) — no size companion needed.
          // v0.49.1: SINGLE-QUOTED url — consumers paste css() into HTML
          // style="..." attributes, where a double-quoted url would
          // terminate the attribute (live-caught in the browser redteam).
          //
          // v0.54: >2 stops make a QUILT — an n×n cell tile cycling the
          // palette ((i+j) % n) so every stop appears and the tile stays
          // seamless (period = n cells). Cycle capped at 8 stops (a 15-stop
          // checker would need a 240px tile; stops 9+ read as noise at
          // 16px cells anyway). ≤2 stops = the classic pinned 32px tile.
          var cell = Math.max(4, Math.round(16 * scale));
          var cyc = Math.max(2, Math.min(8, c.length));
          var kA = c[0];
          var kB = c.length > 1 ? c[1] : darken(c[0], 18);
          var T = cell * cyc;
          var svg;
          if (c.length <= 2) {
            svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + T + '" height="' + T + '">' +
              '<rect width="' + T + '" height="' + T + '" fill="' + kA + '"/>' +
              '<rect width="' + cell + '" height="' + cell + '" fill="' + kB + '"/>' +
              '<rect x="' + cell + '" y="' + cell + '" width="' + cell + '" height="' + cell + '" fill="' + kB + '"/>' +
              '</svg>';
          } else {
            var rects = '<rect width="' + T + '" height="' + T + '" fill="' + kA + '"/>';
            for (var qi = 0; qi < cyc; qi++) {
              for (var qj = 0; qj < cyc; qj++) {
                if ((qi + qj) % cyc === 0) continue; // the base rect covers i+j ≡ 0
                rects += '<rect x="' + (qi * cell) + '" y="' + (qj * cell) +
                  '" width="' + cell + '" height="' + cell +
                  '" fill="' + c[(qi + qj) % cyc] + '"/>';
              }
            }
            svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + T + '" height="' + T + '">' +
              rects + '</svg>';
          }
          layer = "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
          break;
        }
        default: // 'auto'
          // v1.03.5: the angle is CONTINUOUS for the linear family (0° =
          // to top, clockwise — the slider writes it directly; the
          // legacy 135° default holds when no angle is stored).
          layer = 'linear-gradient(' +
            (typeof s.angle === 'number' && isFinite(s.angle) ? s.angle : 135) +
            'deg, ' + stops + ')';
      }
      // v0.49.1: single-quoted url layers — css() flows into HTML
      // style="..." attributes (tweaks preview, hub publish), where a
      // double-quoted url would terminate the attribute.
      if (hasTex) layer += ", url('" + s.tex + "')";
      return layer;
    },

    // ── solid(v) → the derived solid hex (the FIRST color) ──────────
    // canvas fillStyle, meta-theme-color, and the -rgb triplet
    // derivation all consume this.
    solid: function (v) {
      return GradientUI.norm(v).colors[0];
    },

    // ── twins(v) → the var-twin pair consumers write to CSS vars ────
    //   --X        = twins.solid  (compat hex)
    //   --X-gradient = twins.css  (full stack or the bare hex)
    twins: function (v) {
      return {
        solid: GradientUI.norm(v).colors[0],
        css: GradientUI.css(v)
      };
    },

    // random(n) → array of hex stops. n omitted → a RANDOM count
    // (2–15): the walk stays hue-adjacent (≤ ~200° span) with S/L
    // inside the readable bands, so even 15 stops read as one
    // tasteful sweep. COLORS ONLY — the dir is never touched here so
    // callers that chose a style keep it (the ↻ button rerolls colors).
    random: function (n) {
      var count = (typeof n === 'number' && n >= 1)
        ? Math.max(1, Math.min(MAX_COLORS, Math.round(n)))
        : (2 + Math.floor(Math.random() * (MAX_COLORS - 1)));
      if (count === 1) return [hslToHex(Math.floor(Math.random() * 360),
        60 + Math.floor(Math.random() * 21), 50)];
      var base = Math.floor(Math.random() * 360);
      var span = 40 + Math.floor(Math.random() * 160); // 40°..200°
      var s1 = 60 + Math.floor(Math.random() * 21);    // 60–80%
      var l1 = 45 + Math.floor(Math.random() * 21);    // 45–65%
      var out = [];
      for (var i = 0; i < count; i++) {
        var t = i / (count - 1);
        out.push(hslToHex(base + span * t, s1, l1 + (t * 8)));
      }
      return out;
    },

    // ── textureFromFile(file, maxEdge) → Promise<dataURL> ──────────
    // The shared texture pipeline (Wave-2 agents reuse it for their
    // own uploads): downscale to ≤ maxEdge on the long edge (default
    // 512), re-encode JPEG q0.8 → dataURL.
    textureFromFile: function (file, maxEdge) {
      return new Promise(function (resolve, reject) {
        if (!file) { reject(new Error('no file')); return; }
        var maxE = (typeof maxEdge === 'number' && maxEdge > 0) ? maxEdge : 512;
        var url = '';
        try { url = URL.createObjectURL(file); } catch (e) { reject(e); return; }
        var img = new Image();
        img.onload = function () {
          try {
            var dataURL = downscaleToDataURL(img, maxE, 'image/jpeg', 0.8);
            try { URL.revokeObjectURL(url); } catch (e2) {}
            if (dataURL) resolve(dataURL);
            else reject(new Error('could not encode'));
          } catch (err) {
            try { URL.revokeObjectURL(url); } catch (e2) {}
            reject(err);
          }
        };
        img.onerror = function () {
          try { URL.revokeObjectURL(url); } catch (e) {}
          reject(new Error('not readable'));
        };
        img.src = url;
      });
    },

    // ── editor(pfx, v, opts) → the editor markup ────────────────────
    // v is a spec (or any legacy shape — norm'd for RENDERING only;
    // the caller's live spec is mutated by wire(), not here).
    //   opts.noTex  hide the texture row (small surfaces)
    //   opts.noDir  hide the style + pattern rows (small surfaces)
    //   opts.randomBtn === false  hide the ↻ button (v0.33 carry-over)
    // Layout, in order: live preview bar · swatches · tools · style
    // row · pattern row · angle (diag only) · texture row.
    editor: function (pfx, v, opts) {
      opts = opts || {};
      var spec = GradientUI.norm(v);
      var c = spec.colors;

      // 1 — the live preview bar (style straight from css(spec))
      var cssVal = GradientUI.css(spec);
      var pvStyle = cssVal.charAt(0) === '#'
        ? ('background-color:' + cssVal)
        : ('background-image:' + cssVal);
      var preview = '<div class="gr-preview-bar" role="img" aria-label="gradient preview" style="' +
        escAttr(pvStyle) + '"></div>';

      // 2 — the swatches
      var sw = '';
      for (var i = 0; i < c.length; i++) {
        sw += '<span class="gr-swatch">' +
          '<input type="color" class="gr-color" data-gr="' + i + '" value="' + escAttr(c[i]) + '"' +
          ' aria-label="gradient color ' + (i + 1) + '">' +
          (c.length > 1
            ? '<button type="button" class="gr-rm" data-gr-rm="' + i + '" title="remove this color" aria-label="remove color ' + (i + 1) + '">✕</button>'
            : '') +
          '</span>';
      }

      // 3 — the tools row (＋ / ⤨ / ↻ / count)
      var tools =
        '<div class="gr-tools">' +
          '<button type="button" class="gr-mini" data-gr-add="1"' +
            (c.length >= MAX_COLORS ? ' disabled' : '') + '>＋ color</button>' +
          '<button type="button" class="gr-mini" data-gr-shuffle="1">⤨ shuffle</button>' +
          (opts.randomBtn !== false
            ? '<button type="button" class="gr-mini" data-gr-random="1">↻ random</button>' : '') +
          '<span class="gr-count">' + c.length + ' / ' + MAX_COLORS + '</span>' +
        '</div>';

      // 4 + 5 — the style + pattern rows (mutually exclusive: only
      // the pill matching spec.dir carries data-on)
      function dirPills(list) {
        var out = '';
        for (var j = 0; j < list.length; j++) {
          out += '<button type="button" class="gr-mini gr-dir" data-gr-dir="' +
            escAttr(list[j][0]) + '"' +
            (spec.dir === list[j][0] ? ' data-on="1"' : '') + '>' +
            list[j][1] + '</button>';
        }
        return out;
      }
      var styleList = opts.slim
        ? [['auto','linear'], ['radial','radial']]   // v0.99.6: the field pickers slim to 2 styles
        : DIR_STYLES;
      var styleRow = opts.noDir ? '' :
        '<div class="gr-row gr-row-dir">' + dirPills(styleList) + '</div>';
      var patRow = (opts.noDir || opts.slim) ? '' :    // v0.99.6: patterns are canvas-family only
        '<div class="gr-row gr-row-pat">' +
          '<span class="gr-row-label">patterns</span>' + dirPills(DIR_PATTERNS) +
        '</div>';

      // 6 — the angle slider (diag only; 135 is the default)
      var ang = (typeof spec.angle === 'number') ? spec.angle : 135;
      var angleRow = (spec.dir === 'diag' || (opts.slim && spec.dir !== 'radial')) ?
        '<div class="gr-row gr-row-angle">' +
          '<span class="gr-row-label">angle</span>' +
          '<input type="range" min="0" max="360" step="5" class="gr-angle" data-gr-angle="1" value="' + ang + '" aria-label="gradient angle">' +
          '<span class="gr-angle-val" data-gr-angle-val="1">' + ang + '°</span>' +
        '</div>' : '';

      // 7 — the texture row (pick + hidden input + thumb + remove)
      var texRow = opts.noTex ? '' :
        '<div class="gr-row gr-row-tex">' +
          '<button type="button" class="gr-mini" data-gr-tex-pick="1">📷 texture</button>' +
          '<input type="file" accept="image/*" data-gr-tex-file="1" style="display:none">' +
          (spec.tex
            ? '<span class="gr-tex-thumb" data-gr-tex-thumb="1" role="img" aria-label="texture preview" style="background-image:url(\'' +
                escAttr(spec.tex) + '\')"></span>' +
              '<button type="button" class="gr-mini" data-gr-tex-rm="1">✕ remove texture</button>'
            : '') +
        '</div>';

      return (
        '<div class="gr-editor" id="' + escAttr(pfx) + '-gr">' +
          preview +
          '<div class="gr-swatches">' + sw + '</div>' +
          tools +
          styleRow +
          patRow +
          angleRow +
          texRow +
          (c.length >= MAX_COLORS
            ? '<div class="gr-cap">' + MAX_COLORS + ' colors is the maximum</div>' : '') +
        '</div>'
      );
    },

    // ── wire(el, h) — h = { spec, live, rebuild } ────────────────────
    // The spec object is MUTATED IN PLACE by the editor:
    //   spec.colors splice/push on add/remove/shuffle/random
    //   spec.dir    on pill tap (style or pattern — one dir namespace)
    //   spec.angle  on the slider (live, not a shape change)
    //   spec.tex    on texture pick/remove
    // live()    fires on value changes (color value / angle)
    // rebuild() fires on shape changes (add/remove/shuffle/random/
    //           dir/texture)
    // LEGACY BRIDGE: h.colors instead of h.spec is still accepted —
    // it becomes {colors: h.colors, dir:'auto', _legacy:true} and the
    // ORIGINAL ARRAY keeps being mutated, so v0.33 callers work
    // un-migrated (a dir pill tap will simply not survive their
    // re-render — they render from the array — which is the accepted
    // transitional behavior until Wave 2 moves them to specs).
    wire: function (el, h) {
      if (!el || !h) return;
      var spec;
      if (h.spec && typeof h.spec === 'object') spec = h.spec;
      else if (h.colors) spec = { colors: h.colors, dir: 'auto', _legacy: true };
      else return;

      // floor the spec to usable, IN PLACE (never swap the array —
      // legacy callers hold the reference)
      if (!Array.isArray(spec.colors)) spec.colors = [];
      if (!spec.colors.length) spec.colors.push(DEFAULT_COLORS[0], DEFAULT_COLORS[1]);
      if (spec.colors.length > MAX_COLORS) spec.colors.length = MAX_COLORS;
      var colors = spec.colors;

      // ── v0.79.1: mark the editor's own COSMETIC chrome ───────────
      // paintPreview/paintBanner rewrite these elements' background
      // per live tick; the projection painter's MutationObserver treats
      // any untracked style-attr change as a full-paint trigger — 30
      // wasted full paints per color drag (the "8fps" settings panel).
      // These elements are decorative literals (never var()-projected
      // windows) — flagging them keeps the painter deaf to their
      // repainting.
      el.querySelectorAll('.gr-preview-bar').forEach(function (pv) { pv.__projCosmetic = true; });
      var bannerHost = el.closest ? el.closest('.color-row-collapsed') : null;
      if (bannerHost) {
        var bn = bannerHost.querySelector('.color-row-banner');
        if (bn) bn.__projCosmetic = true;
      }

      // the editor's own live preview bar
      function paintPreview() {
        var pv = el.querySelector('.gr-preview-bar');
        if (!pv) return;
        var cssVal = GradientUI.css(spec);
        if (cssVal.charAt(0) === '#') {
          pv.style.backgroundImage = '';
          pv.style.backgroundColor = cssVal;
        } else {
          pv.style.backgroundColor = '';
          pv.style.backgroundImage = cssVal;
        }
      }

      // v0.54: the sibling collapsed-row banner (appearance.js rows +
      // the tweaks view that reuses its builders) — repaints with the
      // TRUE pattern at banner scale, on EVERY live change AND right
      // before each rebuild (so even callers that don't re-render show
      // the fresh pattern immediately). Rows that DO re-render rebuild
      // the banner from the stored spec anyway — both paths agree.
      function paintBanner() {
        var row = el.closest ? el.closest('.color-row-collapsed') : null;
        if (!row) return;
        var b = row.querySelector('.color-row-banner');
        if (!b) return;
        var cssVal = GradientUI.css(spec, { scale: 0.28 });
        if (cssVal.charAt(0) === '#') {
          b.style.backgroundImage = '';
          b.style.backgroundColor = cssVal;
        } else {
          b.style.backgroundColor = '';
          b.style.backgroundImage = cssVal;
        }
      }

      // ── v0.79.1: rAF-COALESCED LIVE UPDATES ──────────────────
      // The native color wheel + the angle slider fire `input` up to
      // ~120×/s; each live() used to run the FULL setState cascade
      // (JSON+localStorage + applyTheme's CSSOM writes + gates + a
      // canvas repaint) PER EVENT — the "barely usable 8fps" theme
      // drag (PLAN-V079 §A). Coalesce: ONE live per animation frame,
      // latest-wins (the spec is mutated in place, so the rAF reads
      // the freshest value). The trailing `change` (wheel close /
      // slider release) flushes synchronously so the terminal value
      // always lands even if the rAF was cancelled.
      //
      // v0.88 THE COMMIT THROTTLE (~11Hz + trailing): the preview bar
      // + banner still repaint per rAF (cosmetic, local canvas paint —
      // the finger stays glued), but the h.live() COMMIT — the full
      // setState cascade: applyTheme + the canvas fingerprint + the
      // repaint + the worker P post — rides a 90ms throttle while the
      // drag runs, with a trailing timer guaranteeing the terminal
      // value. 60 commits/s → ~11 commits/s, each cheaper than before
      // (the v0.88 fingerprints + the observer filter took the rest).
      var liveRaf = 0;
      var liveLast = 0, liveTimer = 0;
      function paintCosmetic() { paintPreview(); paintBanner(); }
      function commitLive() {
        liveLast = performance.now();
        if (h.live) h.live();
      }
      function scheduleLive() {
        if (liveRaf) return;
        liveRaf = requestAnimationFrame(function () {
          liveRaf = 0;
          paintCosmetic();
          var since = performance.now() - liveLast;
          if (since >= 90) commitLive();
          else if (!liveTimer) {
            liveTimer = setTimeout(function () {
              liveTimer = 0;
              commitLive();
            }, 90 - since);      // the trailing edge — the freshest value lands
          }
        });
      }
      function flushLive() {
        if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
        paintCosmetic();
        commitLive();
      }

      // swatch values
      el.querySelectorAll('.gr-color').forEach(function (inp) {
        inp.addEventListener('input', function () {
          colors[parseInt(inp.getAttribute('data-gr'), 10) || 0] = inp.value;
          scheduleLive();
        });
        inp.addEventListener('change', function () {
          colors[parseInt(inp.getAttribute('data-gr'), 10) || 0] = inp.value;
          flushLive();
        });
      });

      // remove (min 1 — the ✕ hides at 1)
      el.querySelectorAll('[data-gr-rm]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (colors.length <= 1) return;
          colors.splice(parseInt(b.getAttribute('data-gr-rm'), 10) || 0, 1);
          paintBanner();
          if (h.rebuild) h.rebuild();
        });
      });

      // add
      var add = el.querySelector('[data-gr-add]');
      if (add) add.addEventListener('click', function () {
        if (colors.length >= MAX_COLORS) return;
        colors.push(GradientUI.random(1)[0]);
        paintBanner();
        if (h.rebuild) h.rebuild();
      });

      // shuffle — same count, new hues
      var shuf = el.querySelector('[data-gr-shuffle]');
      if (shuf) shuf.addEventListener('click', function () {
        var r = GradientUI.random(colors.length);
        for (var i = 0; i < r.length; i++) colors[i] = r[i];
        paintBanner();
        if (h.rebuild) h.rebuild();
      });

      // random — a NEW random count (colors only; the dir is kept)
      var rnd = el.querySelector('[data-gr-random]');
      if (rnd) rnd.addEventListener('click', function () {
        var r = GradientUI.random();
        colors.length = 0;
        for (var i = 0; i < r.length; i++) colors.push(r[i]);
        paintBanner();
        if (h.rebuild) h.rebuild();
      });

      // style + pattern pills — one dir namespace, mutually exclusive
      // by construction (only one pill can match spec.dir at a time)
      el.querySelectorAll('.gr-dir').forEach(function (b) {
        b.addEventListener('click', function () {
          var d = b.getAttribute('data-gr-dir');
          if (!d || d === spec.dir) return;
          spec.dir = d;
          paintBanner();
          if (h.rebuild) h.rebuild();
        });
      });

      // the angle slider — a VALUE change (live, not a shape change)
      var ang = el.querySelector('[data-gr-angle]');
      if (ang) ang.addEventListener('input', function () {
        spec.angle = Math.max(0, Math.min(360,
          Math.round(parseFloat(ang.value) || 0)));
        var val = el.querySelector('[data-gr-angle-val]');
        if (val) val.textContent = spec.angle + '°';
        scheduleLive();
      });
      if (ang) ang.addEventListener('change', flushLive);

      // texture pick → downscale ≤512 long edge, JPEG q0.8 → dataURL
      var pick = el.querySelector('[data-gr-tex-pick]');
      var file = el.querySelector('[data-gr-tex-file]');
      if (pick && file) {
        pick.addEventListener('click', function () { file.click(); });
        file.addEventListener('change', function () {
          var f = file.files && file.files[0];
          file.value = '';                      // allow re-picking same file
          if (!f) return;
          GradientUI.textureFromFile(f, 512).then(function (dataURL) {
            spec.tex = dataURL;
            if (h.rebuild) h.rebuild();
          }, function () {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('uikit: texture not readable');
            }
          });
        });
      }

      // texture remove
      var rmTex = el.querySelector('[data-gr-tex-rm]');
      if (rmTex) rmTex.addEventListener('click', function () {
        spec.tex = null;
        if (h.rebuild) h.rebuild();
      });
    },

    // ── _selftest() → {ok, failures:[…]} ────────────────────────────
    // Pure-function assertions only (node or browser): norm / css /
    // solid / twins / random / helpers / single-color pattern
    // synthesis / backward compat. scripts/test_uikit.js runs this
    // plus the markup-level checks.
    _selftest: function () {
      var failures = [];
      function ok(name, cond) { if (!cond) failures.push(name); }
      function eq(name, got, want) {
        if (got !== want) failures.push(name + ' (got ' + JSON.stringify(got) +
          ', want ' + JSON.stringify(want) + ')');
      }
      var G = GradientUI;

      // norm — shapes + fallbacks
      var n1 = G.norm('#aabbcc');
      eq('norm.hex.colors', n1.colors.join(), '#aabbcc');
      eq('norm.hex.dir', n1.dir, 'auto');
      eq('norm.array.len', G.norm(['#a', '#b']).colors.length, 2);
      eq('norm.obj.dir', G.norm({ colors: ['#a'], dir: 'swirl' }).dir, 'swirl');
      ['norm.null', 'norm.undefined', 'norm.emptyObj', 'norm.emptyColors',
        'norm.garbageColors'].forEach(function (nm) {
        var input = nm === 'norm.null' ? null :
          nm === 'norm.undefined' ? undefined :
          nm === 'norm.emptyObj' ? {} :
          nm === 'norm.emptyColors' ? { colors: [] } : { colors: 'nope' };
        var got = G.norm(input);
        eq(nm, got.colors.join(), DEFAULT_COLORS.join());
        eq(nm + '.dir', got.dir, 'auto');
      });
      eq('norm.badDir', G.norm({ colors: ['#a'], dir: 'zzz' }).dir, 'auto');
      eq('norm.cap15', G.norm({ colors: (function () {
        var a = []; for (var i = 0; i < 20; i++) a.push('#000000'); return a;
      })() }).colors.length, 15);
      eq('norm.dropNonStrings', G.norm({ colors: ['#a', 7, null, '#b'] }).colors.join(), '#a,#b');
      var nA = G.norm({ colors: ['#a'], dir: 'diag', angle: 45 });
      eq('norm.angle45', nA.angle, 45);
      eq('norm.angleClamp', G.norm({ colors: ['#a'], angle: 999 }).angle, 360);
      eq('norm.angleZero', G.norm({ colors: ['#a'], angle: 0 }).angle, 0);
      ok('norm.angleDrop', G.norm({ colors: ['#a'], angle: 'x' }).angle === undefined);
      eq('norm.texKept', G.norm({ colors: ['#a'], tex: 'data:image/png;base64,Q' }).tex,
        'data:image/png;base64,Q');
      ok('norm.texDrop', G.norm({ colors: ['#a'], tex: 5 }).tex === undefined);

      // css — recipes
      eq('css.oneColorPassthrough', G.css('#aabbcc'), '#aabbcc');
      eq('css.oneColorH', G.css({ colors: ['#aabbcc'], dir: 'h' }), '#aabbcc');
      eq('css.oneColorRadial', G.css({ colors: ['#aabbcc'], dir: 'radial' }), '#aabbcc');
      eq('css.legacyArray', G.css(['#a', '#b']), 'linear-gradient(135deg, #a, #b)');
      eq('css.legacyObj', G.css({ colors: ['#a', '#b'] }), 'linear-gradient(135deg, #a, #b)');
      eq('css.auto', G.css({ colors: ['#a', '#b'], dir: 'auto' }), 'linear-gradient(135deg, #a, #b)');
      eq('css.h', G.css({ colors: ['#a', '#b'], dir: 'h' }), 'linear-gradient(90deg, #a, #b)');
      eq('css.v', G.css({ colors: ['#a', '#b'], dir: 'v' }), 'linear-gradient(180deg, #a, #b)');
      eq('css.diagDefault', G.css({ colors: ['#a', '#b'], dir: 'diag' }), 'linear-gradient(135deg, #a, #b)');
      eq('css.diagAngle', G.css({ colors: ['#a', '#b'], dir: 'diag', angle: 45 }), 'linear-gradient(45deg, #a, #b)');
      eq('css.diagAngleZero', G.css({ colors: ['#a', '#b'], dir: 'diag', angle: 0 }), 'linear-gradient(0deg, #a, #b)');
      eq('css.diag2', G.css({ colors: ['#a', '#b'], dir: 'diag2' }), 'linear-gradient(315deg, #a, #b)');
      eq('css.radial', G.css({ colors: ['#a', '#b'], dir: 'radial' }), 'radial-gradient(circle at 50% 35%, #a, #b)');
      eq('css.swirl', G.css({ colors: ['#a', '#b'], dir: 'swirl' }), 'conic-gradient(from 240deg at 55% 45%, #a, #b, #a)');
      var sw1 = G.css({ colors: ['#aabbcc'], dir: 'swirl' });
      eq('css.swirl1', sw1, 'conic-gradient(from 240deg at 55% 45%, #aabbcc, ' +
        lighten('#aabbcc', 25) + ', #aabbcc)');
      var mesh = G.css({ colors: ['#aabbcc', '#ccbbaa'], dir: 'mesh' });
      eq('css.mesh', mesh,
        'radial-gradient(at 20% 25%, #aabbcc 0px, transparent 55%), ' +
        'radial-gradient(at 80% 15%, #ccbbaa 0px, transparent 50%), ' +
        'radial-gradient(at 75% 80%, #aabbcc 0px, transparent 55%), ' +
        'radial-gradient(at 15% 85%, #ccbbaa 0px, transparent 50%), ' +
        'linear-gradient(#ccbbaa)');
      eq('css.mesh1Base', G.css({ colors: ['#aabbcc'], dir: 'mesh' }),
        'radial-gradient(at 20% 25%, #aabbcc 0px, transparent 55%), ' +
        'radial-gradient(at 80% 15%, #aabbcc 0px, transparent 50%), ' +
        'radial-gradient(at 75% 80%, #aabbcc 0px, transparent 55%), ' +
        'radial-gradient(at 15% 85%, #aabbcc 0px, transparent 50%), ' +
        'linear-gradient(' + darken('#aabbcc', 20) + ')');
      eq('css.navy', G.css({ colors: ['#aabbcc', '#ccbbaa'], dir: 'pat-navy' }),
        'repeating-linear-gradient(45deg, #aabbcc 0 14px, #ccbbaa 14px 28px)');
      var navy1 = G.css({ colors: ['#aabbcc'], dir: 'pat-navy' });
      eq('css.navy1', navy1, 'repeating-linear-gradient(45deg, #aabbcc 0 14px, ' +
        darken('#aabbcc', 18) + ' 14px 28px)');
      eq('css.pinstripe', G.css({ colors: ['#aabbcc', '#ccbbaa'], dir: 'pat-pinstripe' }),
        'repeating-linear-gradient(90deg, transparent 0 18px, rgba(170,187,204,.35) 18px 19px), ' +
        'linear-gradient(160deg, #aabbcc, #ccbbaa)');
      eq('css.gingham', G.css({ colors: ['#aabbcc', '#ccbbaa', '#123456'], dir: 'pat-gingham' }),
        'repeating-linear-gradient(0deg, rgba(170,187,204,.55) 0 40px, transparent 40px 80px), ' +
        'repeating-linear-gradient(90deg, rgba(204,187,170,.35) 0 40px, transparent 40px 80px), ' +
        'linear-gradient(#123456)');
      eq('css.sunburst', G.css({ colors: ['#aabbcc', '#ccbbaa'], dir: 'pat-sunburst' }),
        'repeating-conic-gradient(from 0deg at 50% 100%, #aabbcc 0deg 15deg, #ccbbaa 15deg 30deg)');
      // v0.49: the checker is a self-tiling SVG data-URL (position/size
      // suffixes are invalid in background-image — the old bug)
      eq('css.checker', G.css({ colors: ['#aabbcc', '#ccbbaa'], dir: 'pat-checker' }),
        "url('data:image/svg+xml," + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
          '<rect width="32" height="32" fill="#aabbcc"/>' +
          '<rect width="16" height="16" fill="#ccbbaa"/>' +
          '<rect x="16" y="16" width="16" height="16" fill="#ccbbaa"/></svg>') + "')");
      ok('css.checkerSingleColor', G.css({ colors: ['#aabbcc'], dir: 'pat-checker' })
        .indexOf("url('data:image/svg+xml") === 0);
      ok('css.checkerNoShorthandSuffix', G.css({ colors: ['#a', '#b'], dir: 'pat-checker' })
        .indexOf(' 0 0 / ') < 0);

      // v0.54 — the FULL-PALETTE pattern recipes (user spec: mesh/checkers
      // must follow the colors). Every stop lands on the art now.
      eq('css.mesh5', G.css({ colors: ['#a', '#b', '#c', '#d', '#e'], dir: 'mesh' }),
        'radial-gradient(at 20% 25%, #a 0px, transparent 55%), ' +
        'radial-gradient(at 80% 15%, #b 0px, transparent 50%), ' +
        'radial-gradient(at 75% 80%, #c 0px, transparent 55%), ' +
        'radial-gradient(at 15% 85%, #d 0px, transparent 50%), ' +
        'radial-gradient(at 55% 8%, #e 0px, transparent 45%), ' +
        'linear-gradient(#e)');
      var mesh10 = G.css({ colors: ['#a', '#b', '#c', '#d', '#e', '#f', '#g',
        '#h', '#i', '#j'], dir: 'mesh' });
      ok('css.mesh10.eightSpots', (mesh10.match(/radial-gradient\(/g) || []).length === 8);
      ok('css.mesh10.baseLast', mesh10.slice(-19) === 'linear-gradient(#j)');
      eq('css.navy3', G.css({ colors: ['#a', '#b', '#c'], dir: 'pat-navy' }),
        'repeating-linear-gradient(45deg, #a 0 14px, #b 14px 28px, #c 28px 42px)');
      eq('css.sunburst3', G.css({ colors: ['#a', '#b', '#c'], dir: 'pat-sunburst' }),
        'repeating-conic-gradient(from 0deg at 50% 100%, #a 0deg 10deg, #b 10deg 20deg, #c 20deg 30deg)');
      eq('css.gingham5', G.css({
        colors: ['#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee'], dir: 'pat-gingham'
      }),
        'repeating-linear-gradient(0deg, rgba(170,170,170,.55) 0px 40px, rgba(204,204,204,.55) 40px 80px), ' +
        'repeating-linear-gradient(90deg, rgba(187,187,187,.35) 0px 40px, rgba(221,221,221,.35) 40px 80px), ' +
        'linear-gradient(#eeeeee)');
      var pin3 = G.css({ colors: ['#a', '#b', '#c'], dir: 'pat-pinstripe' });
      ok('css.pinstripe3.twoStripeLayers',
        (pin3.match(/repeating-linear-gradient/g) || []).length === 2);
      ok('css.pinstripe3.baseSweep',
        pin3.indexOf('linear-gradient(160deg, #a, #c)') >= 0);
      var quilt = G.css({ colors: ['#a', '#b', '#c'], dir: 'pat-checker' });
      ok('css.quilt3.tile48', quilt.indexOf(encodeURIComponent('width="48"')) >= 0);
      ok('css.quilt3.sevenRects', (decodeURIComponent(quilt).match(/<rect /g) || []).length === 7);
      ok('css.quilt3.cycled', decodeURIComponent(quilt).indexOf('fill="#c"') >= 0);

      // v0.54 — opts.scale shrinks the repeating recipes' px constants
      // (the collapsed-row banner previews at ~0.28).
      eq('css.scale.navy', G.css({ colors: ['#a', '#b'], dir: 'pat-navy' }, { scale: 0.5 }),
        'repeating-linear-gradient(45deg, #a 0 7px, #b 7px 14px)');
      ok('css.scale.checker', G.css({ colors: ['#a', '#b'], dir: 'pat-checker' }, { scale: 0.5 })
        .indexOf(encodeURIComponent('width="16"')) >= 0);
      eq('css.scale.ignoredByGradients', G.css({ colors: ['#a', '#b'], dir: 'h' }, { scale: 0.5 }),
        'linear-gradient(90deg, #a, #b)');

      // tex layering
      eq('css.tex', G.css({ colors: ['#aabbcc', '#ccbbaa'], dir: 'auto', tex: 'data:image/jpeg;base64,ZZ==' }),
        'linear-gradient(135deg, #aabbcc, #ccbbaa), url(\'data:image/jpeg;base64,ZZ==\')');
      eq('css.tex1Color', G.css({ colors: ['#aabbcc'], dir: 'auto', tex: 'data:image/png;base64,Q' }),
        "linear-gradient(135deg, #aabbcc, #aabbcc), url('data:image/png;base64,Q')");

      // solid + twins
      eq('solid.first', G.solid(['#112233', '#445566']), '#112233');
      eq('solid.hex', G.solid('#ff0000'), '#ff0000');
      eq('solid.fallback', G.solid(null), DEFAULT_COLORS[0]);
      eq('solid.pattern', G.solid({ colors: ['#abc'], dir: 'pat-checker' }), '#abc');
      var tw = G.twins({ colors: ['#aabbcc', '#ccbbaa'], dir: 'h' });
      eq('twins.solid', tw.solid, '#aabbcc');
      eq('twins.css', tw.css, 'linear-gradient(90deg, #aabbcc, #ccbbaa)');
      var tw2 = G.twins('#aabbcc');
      ok('twins.bare', tw2.solid === '#aabbcc' && tw2.css === '#aabbcc');

      // helpers
      eq('darken.gray', darken('#ffffff', 50), '#808080');
      eq('lighten.gray', lighten('#000000', 50), '#808080');
      eq('darken.clamp', darken('#ffffff', 150), '#000000');
      eq('lighten.clamp', lighten('#000000', 150), '#ffffff');
      eq('darken.garbage', darken('#a', 20), '#a');
      eq('rgba.fmt', rgba('#38bdf8', 0.35), 'rgba(56,189,248,.35)');
      var hr = hexToRgb('#38bdf8');
      ok('hexToRgb', hr && hr.r === 56 && hr.g === 189 && hr.b === 248);
      var h3 = hexToRgb('#abc');
      ok('hexToRgb.3digit', h3 && h3.r === 170 && h3.g === 187 && h3.b === 204);
      ok('hexToRgb.invalid', hexToRgb('zz') === null);

      // random bounds
      ok('random.n', G.random(3).length === 3 && G.random(3).every(function (x) {
        return /^#[0-9a-f]{6}$/.test(x);
      }));
      eq('random.one', G.random(1).length, 1);
      eq('random.cap', G.random(99).length, MAX_COLORS);
      var boundsOk = true;
      for (var r = 0; r < 60; r++) {
        var len = G.random().length;
        if (len < 2 || len > MAX_COLORS) { boundsOk = false; break; }
      }
      ok('random.bounds2to15', boundsOk);

      // constants
      eq('MAX', G.MAX, 15);
      eq('BLENDED', G.BLENDED, true);

      return { ok: failures.length === 0, failures: failures };
    }
  };

  // the shared canvas downscale helper (tweaks.js's pipeline, made
  // local): ≤ maxEdge on the long edge, re-encode, return the dataURL
  // ('' on failure). Used by textureFromFile.
  function downscaleToDataURL(img, maxEdge, type, quality) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return '';
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(img, 0, 0, w, h, 0, 0, cw, ch);
    var dataURL = '';
    try { dataURL = cv.toDataURL(type, quality); } catch (e) { dataURL = ''; }
    if (!dataURL || dataURL.indexOf('base64,') < 0) return '';
    return dataURL;
  }

  // ══ CropUI v2 — pinch-zoom + rotate drag-to-crop overlay ═════════
  //
  // The image sits UNDER a fixed-aspect crop frame (the card's). The
  // user drags it around (pan), pinch-zooms (two pointers, zoom
  // around the live midpoint, 1–8×), rotates 90° (baked into the
  // source bitmap), double-taps to reset; apply() crops the frame's
  // region from the ORIGINAL pixels — never stretched, re-encoded at
  // up to maxEdge on the long edge.
  var CropUI = (function () {
    var st = null; // the live overlay state

    function close() {
      if (!st) return;
      try { if (st.url) URL.revokeObjectURL(st.url); } catch (e) {}
      if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
      document.removeEventListener('keydown', onKey, true);
      st = null;
    }

    function onKey(e) {
      if (!st) return;
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter') { e.stopPropagation(); apply(); }
    }

    function cancel() {
      var cb = st && st.onCancel;
      close();
      if (cb) cb();
    }

    // v0.77.4 THE ORIGINAL-RESOLUTION CONTRACT (user spec: "let's not
    // decompress the image if possible and keep it at the resolution it
    // came"): the crop renders at FULL source resolution — no maxEdge
    // downscale — and re-encodes ONCE. The format ladder honors the
    // caller's byte budget (the engine's upload caps) in quality steps
    // before it ever touches resolution, and only downscale-programs as
    // the LAST resort: PNG (lossless, alpha) → JPEG 0.92 → JPEG 0.85 →
    // progressive ×0.85 shrinks. When the frame covers the WHOLE
    // un-rotated image the ORIGINAL bytes pass through untouched — zero
    // recompression, the exact file the user picked.
    function encodeLadder(cv, budget, lockMime) {
      // lockMime ("image/png") — the hub publish contract: icons + card
      // art must BE PNG (the engine validates the magic bytes and the
      // 64KB icon cap); the ladder stays on the locked format and can
      // only shrink, never re-format.
      var tries = (lockMime === 'image/png')
        ? [{ mime: 'image/png', q: null }]
        : [
            { mime: 'image/png', q: null },
            { mime: 'image/jpeg', q: 0.92 },
            { mime: 'image/jpeg', q: 0.85 }
          ];
      var best = null, i;
      var over = function (url) { return !!budget && (url.length * 0.75) > budget; };
      for (i = 0; i < tries.length; i++) {
        var url = '';
        try {
          url = (tries[i].q == null) ? cv.toDataURL(tries[i].mime)
                                     : cv.toDataURL(tries[i].mime, tries[i].q);
        } catch (e) { url = ''; }
        if (url && url.indexOf('base64,') >= 0) {
          best = { url: url, mime: tries[i].mime };
          if (!over(url)) return best;
        }
      }
      // still over budget — shrink reluctantly, quality first
      var k = 1;
      while (best && over(best.url) && k > 0.4) {
        k *= 0.85;
        var c2 = document.createElement('canvas');
        c2.width = Math.max(1, Math.round(cv.width * k));
        c2.height = Math.max(1, Math.round(cv.height * k));
        c2.getContext('2d').drawImage(cv, 0, 0, c2.width, c2.height);
        try {
          best = { url: (lockMime === 'image/png') ? c2.toDataURL('image/png')
                                                   : c2.toDataURL('image/jpeg', 0.85),
                   mime: lockMime || 'image/jpeg' };
        }
        catch (e) { break; }
      }
      return best;
    }

    function apply() {
      if (!st || !st.img) return;
      var f = st.frame;                 // the frame rect (CSS px)
      var s = st.cover * st.zoom;       // px per source pixel
      var sx = Math.max(0, Math.min(st.nat.w, -st.x / s));
      var sy = Math.max(0, Math.min(st.nat.h, -st.y / s));
      var sw = Math.min(st.nat.w - sx, f.w / s);
      var sh = Math.min(st.nat.h - sy, f.h / s);
      // capture everything the async passthrough needs NOW — the user
      // can cancel while the FileReader is in flight (st goes null)
      var S = {
        img: st.img, nat: { w: st.nat.w, h: st.nat.h },
        rot: st.rot || 0, srcBlob: st.srcBlob || null,
        maxBytes: st.maxBytes || 0, maxEdge: st.maxEdge || 0,
        format: st.format || '',
        onDone: st.onDone, onErr: st.onErr
      };
      // v0.77.4: the PASSTHROUGH — an un-rotated (mod 360°) crop that
      // covers the whole source is the original file, byte for byte
      // (a format lock still re-encodes: the engine's PNG contract)
      var full = ((S.rot % 4) === 0 && S.srcBlob &&
        (!S.format || S.srcBlob.type === S.format) &&
        sx <= 0.5 && sy <= 0.5 && sw >= S.nat.w - 0.5 && sh >= S.nat.h - 0.5);
      var done = function (b64, w, h, mime) {
        if (!st) return;                 // canceled mid-flight — no callback
        var cb = S.onDone;
        close();
        if (cb) cb(b64, { width: w, height: h, mime: mime || 'image/png' });
      };
      var encodeAndDone = function () {
        if (!st) return;                 // canceled mid-FileReader
        var cw = Math.max(1, Math.round(sw));
        var ch = Math.max(1, Math.round(sh));
        // a soft edge cap survives for callers that NEED one (the hub
        // icon's 64KB PNG contract); the default path ignores it
        var softCap = S.maxEdge || 0;
        if (softCap > 0 && Math.max(sw, sh) > softCap) {
          var kk = softCap / Math.max(sw, sh);
          cw = Math.max(1, Math.round(sw * kk));
          ch = Math.max(1, Math.round(sh * kk));
        }
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(S.img, sx, sy, sw, sh, 0, 0, cw, ch);
        var enc = encodeLadder(cv, S.maxBytes, S.format || '');
        if (!enc) {
          if (S.onErr) S.onErr('could not encode the crop');
          return;
        }
        done(enc.url.slice(enc.url.indexOf('base64,') + 7), cw, ch, enc.mime);
      };
      if (full) {
        var fr = new FileReader();
        fr.onload = function () {
          var u = String(fr.result || '');
          var at = u.indexOf('base64,');
          if (at >= 0) {
            done(u.slice(at + 7), S.nat.w, S.nat.h,
              (S.srcBlob && S.srcBlob.type) || 'image/png');
          } else {
            encodeAndDone();   // unreadable → the normal path
          }
        };
        fr.onerror = encodeAndDone;
        try { fr.readAsDataURL(S.srcBlob); return; } catch (e) { /* fall through */ }
      }
      encodeAndDone();
    }

    // position + clamp the image under the frame
    function place() {
      if (!st) return;
      var dw = st.nat.w * st.cover * st.zoom;
      var dh = st.nat.h * st.cover * st.zoom;
      st.x = Math.max(st.frame.w - dw, Math.min(0, st.x));
      st.y = Math.max(st.frame.h - dh, Math.min(0, st.y));
      st.imgEl.style.width = dw + 'px';
      st.imgEl.style.height = dh + 'px';
      st.imgEl.style.transform = 'translate(' + st.x + 'px,' + st.y + 'px)';
    }

    function reset() {
      if (!st) return;
      st.zoom = 1;
      var dw = st.nat.w * st.cover;
      var dh = st.nat.h * st.cover;
      st.x = (st.frame.w - dw) / 2;
      st.y = (st.frame.h - dh) / 2;
      var z = st.el.querySelector('.crop-zoom');
      if (z) z.value = '1';
      place();
    }

    // fit the fixed-aspect frame into the stage — deterministic: the
    // fit box is measured + sized in JS, then the image clamps to it
    function measure() {
      if (!st || !st.el) return;
      var sr = st.el.querySelector('.crop-stage').getBoundingClientRect();
      var fw = Math.max(60, sr.width), fh = fw / st.aspect;
      if (fh > sr.height) { fh = Math.max(60, sr.height); fw = fh * st.aspect; }
      var fit = st.el.querySelector('.crop-fit');
      fit.style.width = fw + 'px';
      fit.style.height = fh + 'px';
      st.frame = { w: fw, h: fh };
      st.cover = Math.max(fw / st.nat.w, fh / st.nat.h);
      place();
    }

    // rotate 90° ↻ — v0.77.4: the rotation bakes into a FULL-FIDELITY
    // canvas (the crop source — zero re-encode; the old path baked a
    // JPEG 0.9 copy and every rotate cost a lossy generation BEFORE the
    // crop even ran). The <img> display copy is a small JPEG of that
    // canvas (≤720px — preview-only, never the output). st.rot counts
    // quarter-turns so apply() knows the passthrough is off.
    function rotate90() {
      if (!st || !st.img) return;
      var w = st.nat.h, h = st.nat.w;    // dimensions swap
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      ctx.translate(w / 2, h / 2);
      ctx.rotate(Math.PI / 2);           // 90° clockwise
      ctx.drawImage(st.img, -st.nat.w / 2, -st.nat.h / 2);
      var disp = '';
      try {
        var k = Math.min(1, 720 / Math.max(w, h));
        if (k < 1) {
          var dc = document.createElement('canvas');
          dc.width = Math.max(1, Math.round(w * k));
          dc.height = Math.max(1, Math.round(h * k));
          dc.getContext('2d').drawImage(cv, 0, 0, dc.width, dc.height);
          disp = dc.toDataURL('image/jpeg', 0.85);
        } else {
          disp = cv.toDataURL('image/jpeg', 0.85);
        }
      } catch (e) { disp = ''; }
      if (!disp) {
        if (st.onErr) st.onErr('could not rotate');
        return;
      }
      if (st.url) {
        try { URL.revokeObjectURL(st.url); } catch (e) {}
        st.url = '';
      }
      st.img = cv;                       // apply() draws from this — lossless
      st.rot = (st.rot || 0) + 1;
      st.nat = { w: w, h: h };
      st.imgEl.src = disp;               // display-only preview
      measure();
      reset();
    }

    function open(opts) {
      if (st) close();
      opts = opts || {};
      var aspect = (typeof opts.aspect === 'number' && opts.aspect > 0) ? opts.aspect : 1.5;

      var gotImg = function (img, url) {
        st = {
          el: null, img: img, url: url || '',
          nat: { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height },
          aspect: aspect,
          // v0.77.4: maxEdge is now a SOFT cap callers may opt into (the
          // hub icon's 64KB PNG marker contract); maxBytes is the wire
          // budget the encode ladder honors (quality first, resolution
          // LAST); format locks the ladder when the server demands PNG
          maxEdge: opts.maxEdge || 0,
          maxBytes: opts.maxBytes || 0,
          format: opts.format || '',
          rot: 0,
          srcBlob: opts.file || opts.blob || null,
          zoom: 1, x: 0, y: 0, frame: { w: 0, h: 0 }, cover: 1,
          onDone: opts.onDone || null, onCancel: opts.onCancel || null,
          onErr: opts.onErr || null
        };
        if (!st.nat.w || !st.nat.h) { if (opts.onErr) opts.onErr('not readable'); close(); return; }
        build();
      };

      // the source: a File/Blob, a data URL, or an already-loaded Image
      if (opts.img) { gotImg(opts.img, ''); return; }
      var src = opts.file || opts.blob || opts.src;
      if (!src) { if (opts.onErr) opts.onErr('nothing to crop'); return; }
      var url = (typeof src === 'string') ? src : URL.createObjectURL(src);
      var img = new Image();
      img.onload = function () { gotImg(img, typeof src === 'string' ? '' : url); };
      img.onerror = function () {
        if (typeof src !== 'string') URL.revokeObjectURL(url);
        if (opts.onErr) opts.onErr('not readable');
      };
      img.src = url;
    }

    function build() {
      var el = document.createElement('div');
      el.className = 'crop-ui';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'crop the image');
      el.innerHTML =
        '<div class="crop-top">' +
          '<button type="button" class="crop-btn crop-x" aria-label="cancel">✕</button>' +
          '<div class="crop-title">drag to crop</div>' +
          '<button type="button" class="crop-btn crop-ok" aria-label="apply crop">apply ✓</button>' +
        '</div>' +
        '<div class="crop-stage">' +
          '<div class="crop-fit">' +
            '<img class="crop-img" alt="" draggable="false">' +
            '<div class="crop-frame"></div>' +
          '</div>' +
        '</div>' +
        '<div class="crop-ctl">' +
          '<button type="button" class="crop-btn" data-crop-reset="1" title="reset" aria-label="reset">↺</button>' +
          '<button type="button" class="crop-btn" data-crop-rotate="1" title="rotate 90°" aria-label="rotate 90 degrees">↻</button>' +
          '<input type="range" class="crop-zoom" min="1" max="8" step="0.01" value="1" aria-label="zoom">' +
          '<span class="crop-hint">drag or pinch · zoom slider · ↻ rotates</span>' +
        '</div>';
      document.body.appendChild(el);
      st.el = el;
      st.frameEl = el.querySelector('.crop-frame');
      st.imgEl = el.querySelector('.crop-img');
      st.fitEl = el.querySelector('.crop-fit');
      st.imgEl.src = st.url || st.img.src;

      // wire the buttons
      el.querySelector('.crop-x').addEventListener('click', cancel);
      el.querySelector('.crop-ok').addEventListener('click', apply);
      el.querySelector('[data-crop-reset]').addEventListener('click', function () { reset(); });
      el.querySelector('[data-crop-rotate]').addEventListener('click', function () { rotate90(); });
      el.querySelector('.crop-zoom').addEventListener('input', function (e) {
        var oldZ = st.zoom;
        st.zoom = parseFloat(e.target.value) || 1;
        // zoom around the frame's center
        var cx = st.frame.w / 2, cy = st.frame.h / 2;
        st.x = cx + (st.x - cx) * (st.zoom / oldZ);
        st.y = cy + (st.y - cy) * (st.zoom / oldZ);
        place();
      });
      el.querySelector('.crop-stage').addEventListener('dblclick', function () { reset(); });

      // drag + PINCH (pointer events cover touch + mouse). evCache is
      // the W3C pattern: push on pointerdown, update IN PLACE by
      // pointerId on pointermove, remove on up/cancel/out/leave. Two
      // pointers = pinch-zoom around the CURRENT midpoint; one = pan.
      var stage = el.querySelector('.crop-stage');
      var evCache = [];
      var drag = null;
      var pinch = null;   // { d: previous two-pointer distance }
      var lastTap = null; // { t, x, y } — double-tap reset

      function evFind(id) {
        for (var i = 0; i < evCache.length; i++) {
          if (evCache[i].id === id) return i;
        }
        return -1;
      }
      function evDist() {
        var a = evCache[0], b = evCache[1];
        var dx = a.x - b.x, dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
      }

      stage.addEventListener('pointerdown', function (e) {
        if (!st) return;
        var i = evFind(e.pointerId);
        if (i >= 0) evCache.splice(i, 1);   // stale duplicate guard
        evCache.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
        if (evCache.length === 1) {
          drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: st.x, oy: st.y };
        } else {
          drag = null;                        // second finger → pinch
          pinch = { d: evDist() };
        }
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        stage.classList.add('grabbing');
        e.preventDefault();
      });

      stage.addEventListener('pointermove', function (e) {
        if (!st) return;
        var i = evFind(e.pointerId);
        if (i < 0) return;                    // untracked hover
        evCache[i].x = e.clientX;
        evCache[i].y = e.clientY;
        if (evCache.length >= 2) {
          // pinch: k = distNow / distPrev, focal = current midpoint
          // (frame-local so the math matches st.x/st.y's space)
          var d = evDist();
          if (pinch && pinch.d > 1 && d > 1) {
            var k = d / pinch.d;
            var r = st.fitEl.getBoundingClientRect();
            var a = evCache[0], b = evCache[1];
            var p = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
            var oldZ = st.zoom;
            var newZ = Math.max(1, Math.min(8, oldZ * k));
            var keff = oldZ > 0 ? newZ / oldZ : 1;  // respect the clamp
            st.x = p.x - (p.x - st.x) * keff;
            st.y = p.y - (p.y - st.y) * keff;
            st.zoom = newZ;
            var zs = st.el.querySelector('.crop-zoom');
            if (zs) zs.value = String(newZ);
            place();
          }
          pinch = { d: d };
        } else if (drag && e.pointerId === drag.id) {
          st.x = drag.ox + (e.clientX - drag.x);
          st.y = drag.oy + (e.clientY - drag.y);
          place();
        }
      });

      var release = function (e) {
        if (!st) return;                       // overlay already closed
        var i = evFind(e.pointerId);
        if (i < 0) return;
        // double-tap reset: second tap within 300ms and 25px
        if (e.type === 'pointerup') {
          var now = (e.timeStamp && isFinite(e.timeStamp) && e.timeStamp > 0)
            ? e.timeStamp : Date.now();
          if (lastTap && (now - lastTap.t) <= 300 &&
              Math.abs(e.clientX - lastTap.x) < 25 &&
              Math.abs(e.clientY - lastTap.y) < 25) {
            lastTap = null;
            reset();
          } else {
            lastTap = { t: now, x: e.clientX, y: e.clientY };
          }
        }
        evCache.splice(i, 1);
        if (evCache.length === 0) {
          drag = null;
          pinch = null;
          stage.classList.remove('grabbing');
        } else if (evCache.length === 1) {
          // the remaining finger continues as a pan
          var rp = evCache[0];
          drag = { id: rp.id, x: rp.x, y: rp.y, ox: st.x, oy: st.y };
          pinch = null;
        } else {
          pinch = { d: evDist() };
        }
      };
      stage.addEventListener('pointerup', release);
      stage.addEventListener('pointercancel', release);
      // v0.77.4 THE DEAD-DRAG FIX: pointerout/pointerleave are GONE.
      // pointerdown calls setPointerCapture(stage) — per the Pointer
      // Events spec the browser then fires a pointerout at the PREVIOUS
      // target (.crop-img) which BUBBLES to the stage, and the old
      // listeners released the pointer IMMEDIATELY after down: every
      // pointermove hit the untracked-hover guard and drag never moved
      // (mouse or touch; only the zoom slider worked — the user's exact
      // report). With capture held, up/cancel are the only releases
      // that matter (the W3C evCache pattern).

      document.addEventListener('keydown', onKey, true);
      st._onResize = function () { if (st) { measure(); reset(); } };
      window.addEventListener('resize', st._onResize);

      // first layout
      requestAnimationFrame(function () {
        if (!st) return;
        measure();
        reset();
      });
    }

    // measure() needs the resize listener torn down with the overlay
    var _close = close;
    close = function () {
      if (st && st._onResize) window.removeEventListener('resize', st._onResize);
      _close();
    };

    return {
      open: open,
      close: function () { if (st) cancel(); },
      isOpen: function () { return !!st; }
    };
  })();


  // ── v1.00.5: THE ONE TOAST ─────────────────────────────────────
  // Eight per-screen toast implementations (hub, lookio, hubitem,
  // hubpublish, persona, templatesheet, artifacts, chatsview — each
  // minted its own fixed div with byte-identical CSS) collapse into
  // this one. The screen-local `toast()` names stay as thin delegates
  // (zero call-site churn); every toast rides the SAME themed element
  // + timer stack. window.toast aliases it for the bare-global
  // callers (appearance.js's window.toast checks).
  var toastEl = null, toastTimer = 0;
  function DoomToast(msg, opts) {
    opts = opts || {};
    try {
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement('div');
        toastEl.id = 'doom-toast';
        toastEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
          'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
          'border-radius:10px;font-size:var(--ui-small-fs);z-index:3450;opacity:0;transition:opacity 0.2s;pointer-events:none';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.opacity = '1';
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0; }
      if (!opts.hold) {
        toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, opts.ms || 1900);
      }
    } catch (e) { /* a toast never takes the app down */ }
  }

  // ── exports: browser globals, or the node module path for the
  // self-test script (nothing above touches document/window at load
  // time except the guarded style injection) ──
  if (typeof window !== 'undefined') {
    window.UIPills = UIPills;
    window.GradientUI = GradientUI;
    window.CropUI = CropUI;
    window.DoomToast = DoomToast;
    if (!window.toast) window.toast = DoomToast;   // the bare-global callers
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      GradientUI: GradientUI,
      // the GradientSpec helpers (pure, test-critical)
      hexToRgb: hexToRgb,
      darken: darken,
      lighten: lighten,
      rgba: rgba
    };
  }
})();
