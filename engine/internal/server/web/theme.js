// theme.js — v0.44 THE THEME ENGINE.
//
// User spec: "Let's go over the colors of the entire app, and make sure all
// UI elements use a variable color instead of a hardcoded one... refactor
// the theme tabs in the settings to have more themes, each theme should
// include more contrasting yet adjacent colors with more hues to make the
// entire feel of the app customisable."
//
// v0.44 GLOBAL COLOR SYSTEM — every customizable var is a GRADIENT SPEC
// (uikit.js GradientUI): themeOverrides[cur][var] may hold
// {colors:[1..15], dir, angle?} instead of a hex. applyTheme writes the
// VAR-TWIN pair per override (see index.html's v0.44 block):
//   --X           = GradientUI.solid(spec)  — the first color, so every
//                    legacy color:/border:/canvas consumer keeps working
//   --X-gradient  = the full background-image value, or the literal
//                    'none' when the spec paints solid (1-color, simple
//                    dir, no pattern) — a bare hex is NOT a valid
//                    background-image, 'none' is the explicit no-op
//   --X-rgb       = derived from the SOLID hex (rgba composition needs
//                    the triplet; always from twins.solid — the old
//                    hex-only regex path is gone)
// TEXTURE (spec.tex) may ride in STORAGE but is NEVER applied on theme
// CSS vars: the consumers of these vars are static CSS rules that can't
// safely switch background-blend-mode:color per-var. v0.49 EXCEPTION:
// the CANVAS BACKGROUND (--bg-panel override) keeps its tex in storage —
// app.js's canvas renderer paints it with a real 'color' composite pass
// (canvasBgSpec returns the RAW spec; deriveTwins still strips tex for
// the CSS twins, which --bg-panel no longer has anyway).
// GRID colors follow the same spec upgrade: Settings bg/lineColor/
// dotColor/originColor may hold spec objects (legacy hexes still work —
// norm() folds them); effectiveGridSpecs(s) resolves the specs for
// app.js's canvas renderer, effectiveGrid(s) keeps the SOLID-hex contract
// for the meta theme-color tint + any legacy consumer.
//
// Everything visual now flows through semantic CSS variables (see the
// :root + [data-theme] blocks in index.html). This module:
//   · applies the selected theme (data-theme on <html>)
//   · pairs each theme with a recommended CHAT markdown scheme (user can
//     still override per-slot — the advanced formatting)
//   · resolves GRID colors: the user's explicit picks win; otherwise the
//     theme's grid defaults (legacy default values = "never customized")
//   · applies the three text-size variables (chat / general / small)
//   · keeps the Android status-bar tint (meta theme-color) in sync
//   · re-tints the default chatbot family color from the theme
//
// Exposes: window.DoomTheme = { themes, apply, effectiveGrid,
//            effectiveGridSpecs, isLight, customizable } — and a node
// module path with the PURE twin/spec helpers (scripts/test_theme_twins.js)

(function () {
  'use strict';

  // theme id → meta (label, grid palette, default chat scheme, light?,
  // accent hexes for swatch previews — the live values live in CSS)
  var THEMES = {
    midnight: { label: 'Midnight', scheme: 'teal',   light: false,
      accent: '#a78bfa', accent2: '#38bdf8', accent3: '#f472b6', accent4: '#34d399',
      grid: { bg: '#0a0a0b', line: '#131318', dot: '#2e2e3a', origin: '#4a4a5e' } },
    nebula:   { label: 'Nebula',   scheme: 'berry',  light: false,
      accent: '#c084fc', accent2: '#22d3ee', accent3: '#f0abfc', accent4: '#fbbf24',
      grid: { bg: '#0b0912', line: '#171225', dot: '#2e2748', origin: '#413463' } },
    ember:    { label: 'Ember',    scheme: 'sunset', light: false,
      accent: '#fb923c', accent2: '#fbbf24', accent3: '#fb7185', accent4: '#2dd4bf',
      grid: { bg: '#0f0a08', line: '#1f150d', dot: '#3a2c1b', origin: '#57401f' } },
    forest:   { label: 'Forest',   scheme: 'forest', light: false,
      accent: '#4ade80', accent2: '#2dd4bf', accent3: '#a3e635', accent4: '#fb923c',
      grid: { bg: '#080d0a', line: '#12241a', dot: '#213528', origin: '#2f4a37' } },
    ocean:    { label: 'Ocean',    scheme: 'ocean',  light: false,
      accent: '#38bdf8', accent2: '#7dd3fc', accent3: '#818cf8', accent4: '#fb7185',
      grid: { bg: '#070b10', line: '#101c28', dot: '#1f3341', origin: '#2b4759' } },
    rose:     { label: 'Rose',     scheme: 'rose',   light: false,
      accent: '#f472b6', accent2: '#fb7185', accent3: '#e879f9', accent4: '#38bdf8',
      grid: { bg: '#100a0d', line: '#20141b', dot: '#3a2833', origin: '#523744' } },
    mono:     { label: 'Mono',     scheme: 'mono',   light: false,
      accent: '#d4d4d4', accent2: '#a8a8a8', accent3: '#8a8a8a', accent4: '#6e6e6e',
      grid: { bg: '#0a0a0a', line: '#161616', dot: '#282828', origin: '#3d3d3d' } },
    solar:    { label: 'Solar',    scheme: 'solar',  light: false,
      accent: '#fbbf24', accent2: '#67e8f9', accent3: '#a5b4fc', accent4: '#fb7185',
      grid: { bg: '#060810', line: '#101828', dot: '#1f2a42', origin: '#2e3d5e' } },
    paper:    { label: 'Paper',    scheme: 'paper',  light: true,
      accent: '#b45309', accent2: '#0e7490', accent3: '#be185d', accent4: '#4d7c0f',
      grid: { bg: '#f4f1ea', line: '#e0d8c8', dot: '#c9bda6', origin: '#a3906c' } },
    frost:    { label: 'Frost',    scheme: 'frost',  light: true,
      accent: '#4f6ef7', accent2: '#0891b2', accent3: '#c026d3', accent4: '#ea580c',
      grid: { bg: '#eef2f7', line: '#dbe3ec', dot: '#c2cfdd', origin: '#93a7c0' } }
  };

  // the pre-v0.24 grid defaults — a stored settings object that still
  // matches these means "the user never customized the grid" → follow theme
  var LEGACY_GRID = { bg: '#0a0a0b', line: '#131318', dot: '#2e2e3a', origin: '#4a4a5e' };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ── v0.44 PURE GRADIENT-TWIN HELPERS (node-testable) ────────────
  //
  // deriveTwins(raw) → the var-twin pair for ONE theme var override:
  //   { solid: '#rrggbb',          the first color (the compat hex)
  //     css:   '<background-image>' (GradientUI recipe, tex stripped),
  //     grad:  css or the literal 'none'  — what --X-gradient gets };
  //   a solid spec yields grad 'none' (a bare hex is not a valid
  //   background-image). Falls back to the legacy plain-string path
  //   (solid = the value, grad 'none') when GradientUI isn't loaded.
  function deriveTwins(raw) {
    var G = (typeof window !== 'undefined') ? window.GradientUI : null;
    if (G && G.norm) {
      var spec = G.norm(raw);
      if (spec.tex) delete spec.tex;   // theme vars never paint texture
      var solid = spec.colors[0];
      var css = G.css(spec);
      return { solid: solid, css: css, grad: (css === solid) ? 'none' : css };
    }
    // legacy / no-uikit fallback: a plain string stays the solid; a
    // spec degrades to its first color (never a '[object Object]' paint)
    var v = (raw && typeof raw === 'object' && Array.isArray(raw.colors) && raw.colors[0])
      ? raw.colors[0] : raw;
    var s = String(v == null ? '' : v);
    return { solid: s, css: s, grad: 'none' };
  }

  // hexTriplet(hex) → 'r,g,b' for rgba() composition, or null when the
  // string isn't a real 6-digit hex (total function — callers fall back).
  function hexTriplet(hex) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(String(hex == null ? '' : hex));
    if (!m) return null;
    var h = m[1];
    return parseInt(h.slice(0, 2), 16) + ',' +
      parseInt(h.slice(2, 4), 16) + ',' +
      parseInt(h.slice(4, 6), 16);
  }

  // v0.91.1 OKX — THE PERCEPTUAL CORE (the v0.89.8 research's Track 1
  // foundation). OKLab/OKLCH (Björn Ottosson's public-domain color space,
  // the same math culori ships) as ~90 dependency-free lines — the repo
  // has no build step, so a vendored 40KB UMD would buy nothing over the
  // formulas themselves. Every JS-side derivation (tints, shades, palette
  // averages — the secondary-text chain, later the canvas shades) mixes
  // in OKLab: perceptually even steps, no muddy rgb midpoints between
  // distant hues. The DOM side's derivations go CSS-NATIVE (color-mix in
  // oklch — v0.91.2) — this module is the JS twin of that engine for the
  // places JS must KNOW a color (canvas paints, exports, tests).
  var OKX = (function () {
    function hexToRgb(h) {
      if (h.charAt(0) === '#') h = h.slice(1);
      return [parseInt(h.slice(0, 2), 16) / 255,
              parseInt(h.slice(2, 4), 16) / 255,
              parseInt(h.slice(4, 6), 16) / 255];
    }
    // norm(any) → '#rrggbb' or null (6-digit only — same contract as the
    // old mixHex/avgStops parsers)
    function norm(v) {
      var m = /^#?([0-9a-fA-F]{6})$/.exec(String(v == null ? '' : v));
      return m ? ('#' + m[1].toLowerCase()) : null;
    }
    function rgbToHex(r, g, b) {
      var f = function (v) {
        v = Math.round(Math.min(1, Math.max(0, v)) * 255);
        return (v < 16 ? '0' : '') + v.toString(16);
      };
      return '#' + f(r) + f(g) + f(b);
    }
    // sRGB transfer (the 0.04045/0.0031308 thresholds — IEC sRGB)
    function s2l(c) { return (c <= 0.04045) ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function l2s(c) { return (c <= 0.0031308) ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
    var CB = Math.cbrt || function (x) { return Math.pow(x, 1 / 3); };
    // linear sRGB → OKLab (Ottosson's matrices)
    function linToLab(r, g, b) {
      var l = CB(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      var m = CB(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      var s = CB(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
    }
    // OKLab → linear sRGB (clamped at the transfer — UI colors sit well
    // inside sRGB; the clamp only bites out-of-gamut interpolations)
    function labToLin(L, a, bb) {
      var l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
      var m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
      var s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
      var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
      return [ 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    }
    function hexToLab(hex) {
      var c = hexToRgb(hex);
      if (isNaN(c[0]) || isNaN(c[1]) || isNaN(c[2])) return null;
      return linToLab(s2l(c[0]), s2l(c[1]), s2l(c[2]));
    }
    function labToHex(L, a, b) {
      var lin = labToLin(L, a, b);
      return rgbToHex(l2s(lin[0]), l2s(lin[1]), l2s(lin[2]));
    }
    return {
      // mix(a, b, t) in OKLab — the perceptual blend. EDGES ARE EXACT
      // PASSTHROUGH (t<=0 → a, t>=1 → b, normalized '#rrggbb'): the twins'
      // identity contracts hold byte-identical, and intermediate t
      // carries the evenness.
      mix: function (a, b, t) {
        var A = norm(a), B = norm(b);
        if (!A || !B) return null;
        if (t <= 0) return A;
        if (t >= 1) return B;
        var la = hexToLab(A), lb = hexToLab(B);
        return labToHex(la[0] + (lb[0] - la[0]) * t,
                        la[1] + (lb[1] - la[1]) * t,
                        la[2] + (lb[2] - la[2]) * t);
      },
      // avg(colors) — the OKLab mean (the representative tone of a
      // palette; rgb means gray out between complementary hues). A single
      // valid color returns ITSELF, byte-exact.
      avg: function (colors) {
        if (!colors || !colors.length) return null;
        var L = 0, a = 0, b = 0, n = 0, last = null;
        for (var i = 0; i < colors.length; i++) {
          var hx = norm(colors[i]);
          if (!hx) continue;
          var lab = hexToLab(hx);
          if (!lab) continue;
          L += lab[0]; a += lab[1]; b += lab[2]; n++; last = hx;
        }
        if (!n) return null;
        if (n === 1) return last;
        return labToHex(L / n, a / n, b / n);
      },
      // luminance stays WCAG sRGB (contrast math is defined there)
      luminance: function (hex) {
        var hx = norm(hex);
        if (!hx) return null;
        var c = hexToRgb(hx);
        var lin = function (v) { return (v <= 0.03928) ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
      },
      _hexToLab: hexToLab, _labToHex: labToHex   // the test oracles' door
    };
  })();

  // v0.77.7 mixHex(a, b, t) — v0.91.1: routes through OKX (OKLab-space
  // blend; edges byte-exact passthrough). The secondary-text derivation's
  // only math (kept beside hexTriplet).
  function mixHex(a, b, t) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(String(a)) || !/^#?[0-9a-fA-F]{6}$/.test(String(b))) return null;
    return OKX.mix(a, b, t);
  }

  // v0.77.7 avgStops(colors) — v0.91.1: the OKLab mean of a palette (the
  // representative tone of a gradient for derivations — the first stop
  // can be an outlier, and an rgb mean grays out between distant hues).
  function avgStops(colors) {
    return OKX.avg(colors);
  }

  // v0.56 deriveBorderTwins(raw) — the BORDER-SAFE twin. Root cause (user
  // report: "outlines don't follow the gradient and display the first
  // color" + "changing the borders option changes the entire scrollable
  // box"): patterned recipes (mesh / checker / gingham / navy…) are
  // MULTI-LAYER background-image values — invalid as a border-image
  // (browsers drop the whole declaration → the solid stays) and, in the
  // radius-safe double-background rules, the extra layers cycle the
  // background-clip list and paint the WHOLE element. The border twin is
  // therefore ALWAYS a single layer: a linear sweep of the full palette
  // (the spec's angle when set, else 135°). Solid specs → 'none' (the
  // plain border-color path, exactly as before).
  function deriveBorderTwins(raw) {
    var G = (typeof window !== 'undefined') ? window.GradientUI : null;
    var spec = (G && G.norm) ? G.norm(raw)
      : { colors: [String(raw == null ? '' : raw)], dir: 'auto' };
    if (spec.tex) delete spec.tex;
    var solid = spec.colors[0];
    if (spec.colors.length < 2) return { solid: solid, css: solid, grad: 'none' };
    var angle = (typeof spec.angle === 'number' && isFinite(spec.angle))
      ? spec.angle : 135;
    var css = 'linear-gradient(' + angle + 'deg, ' + spec.colors.join(', ') + ')';
    return { solid: solid, css: css, grad: css };
  }

  function isChatSchemePinned(s) {
    return !!((s.chatScheme && s.chatScheme !== 'teal') ||
      (s.fmtOverrides && Object.keys(s.fmtOverrides).length > 0));
  }

  // pendingScheme — what formatter.js should boot with (it loads after
  // theme.js but applies the scheme exactly once at load; later changes
  // come through applyTheme, when Formatter exists).
  function pendingScheme() {
    var s = Settings ? Settings.getState() : null;
    if (!s) return 'teal';
    if (isChatSchemePinned(s)) return s.chatScheme || 'teal';
    var id = THEMES[s.theme] ? s.theme : 'midnight';
    return THEMES[id].scheme;
  }

  // v0.26→v0.49: the customizable variables and their -rgb triplet
  // partners (auto-derived when overridden). v0.49 SEMANTIC REWORK
  // (user spec): "Panel background" is now CANVAS BACKGROUND — it drives
  // the infinite grid canvas (app.js renderGrid), not any DOM panel;
  // "App background" is now OVERLAY BACKGROUND — overlay screens,
  // collapsible headers, scrims and sticky bars. Panels/cards/bubbles
  // are SURFACES (--surface-1). `hint` rides to the settings row.
  var RGB_PAIRS = {
    '--accent': '--accent-rgb', '--accent-2': '--accent-2-rgb', '--accent-3': '--accent-3-rgb',
    '--accent-4': '--accent-4-rgb',
    '--ok': '--ok-rgb', '--warn': '--warn-rgb', '--err': '--err-rgb',
    '--bg-app': '--bg-app-rgb', '--surface-1': '--surface-1-rgb', '--surface-2': '--surface-2-rgb',
    '--bg-panel': '--bg-panel-rgb'
  };
  var CUSTOMIZABLE = [
    { var: '--bg-panel', label: 'Canvas background', rgb: false,
      hint: 'the infinite grid canvas · gradients, patterns + textures', canvas: true },
    { var: '--bg-app', label: 'Overlay background', rgb: false,
      hint: 'overlay screens · collapsible headers · scrims' },
    { var: '--surface-1', label: 'Surface', rgb: false,
      hint: 'panels · cards · bubbles' },
    { var: '--surface-2', label: 'Surface raised', rgb: false,
      hint: 'inputs · hover · raised cards' },
    { var: '--border', label: 'Borders', rgb: false,
      hint: 'hairlines + outlines' },
    { var: '--text-1', label: 'Primary text', rgb: false,
      hint: 'body text · gradients paint the titles' },
    { var: '--accent', label: 'Accent 1', rgb: true, hint: 'the primary accent · user bubbles' },
    { var: '--accent-2', label: 'Accent 2', rgb: true, hint: 'the adjacent accent' },
    { var: '--accent-3', label: 'Accent 3', rgb: true, hint: 'the third accent' },
    // v0.63 (user spec): the FOURTH accent — library categories (scripts)
    // and workspace providers (sourcehut) ride it.
    { var: '--accent-4', label: 'Accent 4', rgb: true, hint: 'the fourth accent · scripts + providers' }
  ];

  // ── v0.79.1: THE APPLIED-VALUE LEDGER + PURE-JS VAR RESOLUTION ──
  // The theme-drag surgery (PLAN-V079 §C). applyTheme used to
  // remove-then-set ~30–60 root CSSOM properties and read 9–10
  // resolved values via interleaved getComputedStyle calls PER INPUT
  // EVENT — each read a forced full-document style recalc after the
  // writes above it (the style-system edition of layout thrashing;
  // web.dev/forced-sync-layout). The ledger makes every write a
  // value-diff (a one-var drag writes exactly that var's 2–3
  // properties), and the [data-theme] block cache resolves every
  // previously-read variable in PURE JS (the block is static CSS —
  // one batched read per theme SWITCH, zero during drags).
  var appliedVars = {};    // CSS var → live inline value on <html>
  var appliedAttrs = {};   // attribute → live value on <html> (null = absent)
  var blockCacheId = null; // the theme id the block cache was read for
  var blockCache = {};     // [data-theme] block values (the read set below)
  var BLOCK_READ_SET = ['--bg-panel', '--bg-app', '--surface-1', '--surface-2',
    '--accent', '--accent-2', '--accent-3', '--accent-4', '--border-strong'];
  var lastFmtKey = null;   // the applyScheme identity gate
  var lastTopology = null;  // the gate/painter topology fingerprint
  var lastMetaColor = '';   // the meta theme-color value guard
  var lastFamilyTint = '';  // the canvas family tint guard

  function setVar(docEl, k, v) {
    if (v === null || v === undefined) {
      if (k in appliedVars) { docEl.style.removeProperty(k); delete appliedVars[k]; }
      return;
    }
    if (appliedVars[k] === v) return;      // byte-identical — no invalidation
    docEl.style.setProperty(k, v);
    appliedVars[k] = v;
  }
  // setAttr returns true when the attribute actually flipped.
  function setAttr(docEl, name, v) {
    var cur = appliedAttrs[name];
    if (v === null || v === undefined) {
      if (cur !== null && cur !== undefined) {
        docEl.removeAttribute(name);
        appliedAttrs[name] = null;
        return true;
      }
      return false;
    }
    if (cur === v) return false;
    docEl.setAttribute(name, v);
    appliedAttrs[name] = v;
    return true;
  }
  // buildBlockCache — v0.83.4 THE STATIC-RULES READ: the [data-theme]
  // blocks are STATIC CSS in index.html, so the read set resolves from
  // document.styleSheets' cssRules — a plain DOM read with ZERO style
  // system involvement. The old getComputedStyle ran right after the
  // data-theme attr flip invalidated the ENTIRE document — one read,
  // but a forced FULL synchronous recalc per theme switch (~100ms at
  // the settings page's DOM size; the bulk of the "themes tab is barely
  // functional" report). Precedence mirrors the cascade for custom
  // properties on <html>: the [data-theme="x"] declaration wins over
  // :root's; a var missing from both is absent (resolvedVar's ''
  // fallback — same result the computed read produced). Falls back to
  // the computed read only when the rules aren't readable.
  var staticThemeRules = null;
  function readStaticThemeVars(id) {
    if (!staticThemeRules) {
      staticThemeRules = { root: {}, themes: {} };
      try {
        var collect = function (rule, into) {
          for (var i = 0; i < BLOCK_READ_SET.length; i++) {
            var k = BLOCK_READ_SET[i];
            var v = rule.style.getPropertyValue(k);
            if (v) into[k] = v.trim();
          }
        };
        for (var si = 0; si < document.styleSheets.length; si++) {
          var rules;
          try { rules = document.styleSheets[si].cssRules; } catch (e) { continue; }
          if (!rules) continue;
          for (var ri = 0; ri < rules.length; ri++) {
            var r = rules[ri];
            if (!r || !r.style) continue;
            var sel = String(r.selectorText || '');
            if (sel === ':root' || sel === 'html') {
              collect(r, staticThemeRules.root);
            } else {
              var m = sel.match(/^\[data-theme=["']?([\w-]+)["']?\]$/);
              if (m) {
                if (!staticThemeRules.themes[m[1]]) staticThemeRules.themes[m[1]] = {};
                collect(r, staticThemeRules.themes[m[1]]);
              }
            }
          }
        }
      } catch (e) { staticThemeRules = null; }
    }
    var t = staticThemeRules || null;
    if (!t) return null;   // rules unreadable → the computed fallback
    var out = {};
    for (var rk in t.root) out[rk] = t.root[rk];
    var th = t.themes[id];
    if (th) for (var tk in th) out[tk] = th[tk];
    return out;
  }
  function buildBlockCache(docEl, id) {
    var fromRules = readStaticThemeVars(id);
    if (fromRules) {
      blockCache = fromRules;
      blockCacheId = id;
      return;
    }
    // fallback: the ONE batched computed-style read (rules unreadable)
    blockCache = {};
    blockCacheId = id;
    try {
      var cs = getComputedStyle(docEl);
      for (var i = 0; i < BLOCK_READ_SET.length; i++) {
        blockCache[BLOCK_READ_SET[i]] = String(cs.getPropertyValue(BLOCK_READ_SET[i]) || '').trim();
      }
    } catch (e) { /* keep the empty cache — callers fall back */ }
  }
  // resolvedVar — the value applyTheme is ABOUT to make live, in pure JS:
  // the override's solid twin when the user customized the var, else the
  // theme block's value (from the cache). This is exactly what the old
  // getComputedStyle reads returned, without touching the style system.
  function resolvedVar(id, overrides, name) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
      var twins = (name === '--border') ? deriveBorderTwins(overrides[name])
                                        : deriveTwins(overrides[name]);
      if (twins && twins.solid) return twins.solid;
    }
    if (blockCacheId === id && Object.prototype.hasOwnProperty.call(blockCache, name)) {
      return blockCache[name];
    }
    return '';
  }

  function applyTheme(s) {
    var id = THEMES[s.theme] ? s.theme : 'midnight';
    var t = THEMES[id];
    var docEl = document.documentElement;
    var overrides = (s.themeOverrides && s.themeOverrides[id]) || null;

    // 1. the variable palette (CSS cascade does the whole UI).
    // v0.79.1: the theme flip is the ONLY path that pays a style read —
    // the previous theme's inline overrides clear and the fresh
    // [data-theme] block resolves in ONE batched computed-style read
    // (cached until the id changes again). Same-theme applies (the
    // drags — the "barely usable 8fps" report) never read the style
    // system at all: every resolved value comes from the cache or the
    // override twins, computed in pure JS.
    setAttr(docEl, 'data-theme', id);
    if (blockCacheId !== id) {
      for (var rk in appliedVars) { docEl.style.removeProperty(rk); }
      appliedVars = {};
      buildBlockCache(docEl, id);
    }

    // 1b. v0.26: the user's CUSTOMIZATIONS for this theme — inline CSS
    // vars beat the [data-theme] block. v0.79.1: the DESIRED inline set
    // is computed PURE first (no interleaved reads), then DIFFED against
    // the ledger — a drag on one var writes exactly that var's
    // properties; unchanged values write nothing at all (the old
    // remove-all-then-set-all was an invalidation storm per event).
    var want = {};
    var gradByKey = {};   // override key → isGradient (the topo inputs)
    var textGrad = false;
    // v0.77.7: the --text-1 override's raw spec + solid twin — the
    // secondary-text derivation reads them after the loop.
    var text1Spec = null, twinsText1Solid = '';
    // v0.67: per-accent gradient gates — [data-aN-grad] on the root
    // while accent N's twin is a real image (see the gates in index.html).
    var accGrad = { '--accent': false, '--accent-2': false,
      '--accent-3': false, '--accent-4': false };
    if (overrides) {
      Object.keys(overrides).forEach(function (k) {
        // v0.44: the override value may be a hex (legacy) or a gradient
        // spec — deriveTwins folds both into the var-TWIN pair and the
        // write below lands --X (solid) + --X-gradient (image or 'none';
        // consumer rules in index.html layer it over the solid).
        // v0.56: --border uses the SINGLE-LAYER sweep twin (patterns are
        // multi-layer values — invalid as border-image and leaky in the
        // radius-safe double-background rules; see deriveBorderTwins).
        var twins = (k === '--border')
          ? deriveBorderTwins(overrides[k])
          : deriveTwins(overrides[k]);
        want[k] = twins.solid;
        want[k + '-gradient'] = twins.grad;
        gradByKey[k] = (twins.grad !== 'none');
        // v0.57: --border-strong rides the SAME sweep as --border when the
        // user overrides it (no twin when the border is solid — base
        // themes stay flat).
        if (k === '--border' && twins.grad !== 'none') {
          want['--border-strong-gradient'] = twins.grad;
        }
        if (k === '--text-1') {
          // v0.77.7: the secondary-text derivation's inputs — the RAW
          // spec (for the average stop) + the solid twin (the fallback).
          text1Spec = overrides[k];
          twinsText1Solid = twins.solid;
          if (twins.grad !== 'none') textGrad = true;
        }
        if (accGrad.hasOwnProperty(k) && twins.grad !== 'none') accGrad[k] = true;
        // auto-derive the -rgb triplet (rgba() composition needs it) —
        // ALWAYS from the SOLID twin (a gradient's stops can't compose
        // rgba(); the first color is the canonical tint, v0.26 contract)
        var pair = RGB_PAIRS[k];
        var triplet = hexTriplet(twins.solid);
        if (pair && triplet) want[pair] = triplet;
      });
    }

    // v0.57: --bg-panel-rgb — derived EVERY apply (base themes included):
    // the scrim family composes rgba(var(--bg-panel-rgb), α). v0.79.1:
    // resolvedVar is the pure-JS equivalent of the old getComputedStyle
    // read (override twin or theme block — never the style system).
    var panelTriplet = hexTriplet(resolvedVar(id, overrides, '--bg-panel'));
    if (panelTriplet) want['--bg-panel-rgb'] = panelTriplet;
    // v0.65 FIX: --on-accent derived for BASE THEMES too (light accents
    // need readable ink on the user bubbles).
    var accResolved = resolvedVar(id, overrides, '--accent');
    if (/^#[0-9a-fA-F]{6}$/.test(accResolved)) {
      want['--on-accent'] = onColorFor(accResolved);
    }
    // v0.66: --on-accent-N for EVERY accent (the projection rework makes
    // pills/windows that RENDER accent-N's own field, so their labels
    // need the same readable-ink derivation the user bubbles have).
    var ON_VAR = { '--accent-2': '--on-accent-2',
      '--accent-3': '--on-accent-3', '--accent-4': '--on-accent-4' };
    Object.keys(ON_VAR).forEach(function (av) {
      var v = resolvedVar(id, overrides, av);
      if (/^#[0-9a-fA-F]{6}$/.test(v)) want[ON_VAR[av]] = onColorFor(v);
    });
    // v0.57→v0.65 FIX: --veil-ink follows the RESOLVED SURFACE
    // luminance (dark surfaces → BLACK ink, light → WHITE).
    var s1 = resolvedVar(id, overrides, '--surface-1');
    // v0.77.7 THE SECONDARY-TEXT DERIVATION — when --text-1 carries an
    // override, the secondary tones DERIVE from it (blends toward the
    // resolved surface-1, keeping the 1 > 2 > 3 hierarchy).
    if (text1Spec) {
      var t1Tone = avgStops(text1Spec.colors) ||
        (/^#[0-9a-fA-F]{6}$/.test(twinsText1Solid || '') ? twinsText1Solid : null);
      var t1Mix = mixHex(t1Tone, s1, 0.38);
      if (t1Tone && t1Mix) {
        want['--text-2'] = t1Mix;
        want['--text-3'] = mixHex(t1Tone, s1, 0.62) || t1Mix;
        want['--text-3-dim'] = mixHex(t1Tone, s1, 0.76) || t1Mix;
        // the rgb triplets (rgba composition users) stay consistent
        var t2Tri = hexTriplet(t1Mix);
        if (t2Tri) want['--text-2-rgb'] = t2Tri;
      }
    }
    var inkM = /^#([0-9a-fA-F]{6})$/.exec(s1);
    if (inkM) {
      var s1Lum = (function (h) {
        var r = parseInt(h.slice(0, 2), 16) / 255;
        var g = parseInt(h.slice(2, 4), 16) / 255;
        var b = parseInt(h.slice(4, 6), 16) / 255;
        var lin = function (c) { return (c <= 0.03928) ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      })(inkM[1]);
      want['--veil-ink'] = (s1Lum > 0.45) ? '#ffffff' : '#000000';
      want['--veil-ink-rgb'] = (s1Lum > 0.45) ? '255, 255, 255' : '0, 0, 0';
    }

    // v0.74: BRIGHT-SURFACE INK GATES — derive the readable ink from the
    // RESOLVED solid and gate a flip rule (fires only when the user
    // paints a BRIGHT surface; base themes leave the gates unset).
    var BRIGHT_VARS = [
      { v: '--surface-1', ink: '--on-surface-1', gate: 'data-bright-s1' },
      { v: '--surface-2', ink: '--on-surface-2', gate: 'data-bright-s2' },
      { v: '--bg-app',    ink: '--on-bg-app',    gate: 'data-bright-bg' },
      // v0.79.3: the BORDER family — the outline-pill group (settings
      // tabs, search bars, reset pills, kbd, util buttons) now rides the
      // border variable (the user's "assign less variables to surface
      // raised and assign them to border"); a bright border twin gets
      // the same readable-ink derivation the surfaces have.
      { v: '--border',    ink: '--on-border',    gate: 'data-bright-border' }
    ];
    var brightGates = {};
    BRIGHT_VARS.forEach(function (B) {
      var resolved = resolvedVar(id, overrides, B.v);
      var bm = /^#([0-9a-fA-F]{6})$/.exec(resolved);
      if (bm) {
        var hex = '#' + bm[1];
        var ink = onColorFor(hex);
        want[B.ink] = ink;
        // dark ink ⇒ the surface is bright ⇒ trip the gate
        brightGates[B.gate] = (ink !== '#ffffff') ? '1' : null;
      } else {
        brightGates[B.gate] = null;
      }
    });

    // 2. chat markdown scheme — v0.79.1: the IDENTITY GATE. The scheme
    // + fmt overrides are byte-stable through a theme drag; the old
    // unconditional applyScheme re-wrote ~15 root properties + flipped
    // data-fmt-grad PER INPUT EVENT for nothing.
    if (window.Formatter) {
      var pinned = isChatSchemePinned(s);
      var schemeName = pinned ? (s.chatScheme || 'teal') : t.scheme;
      var fmtKey = schemeName + '|' + JSON.stringify(s.fmtOverrides || null);
      if (fmtKey !== lastFmtKey) {
        window.Formatter.applyScheme(schemeName, s.fmtOverrides || null);
        lastFmtKey = fmtKey;
      }
    }

    // 3. text sizes — chat (0-100 slider → 12-24px), general + small
    // (v0.34: --chat-scale rides the chat slider so the whole
    // conversation scales as ONE piece).
    var size = (typeof s.chatTextSize === 'number') ? s.chatTextSize : 50;
    want['--chat-fs'] = (12 + (size / 100) * 12).toFixed(1) + 'px';
    want['--chat-scale'] = ((12 + (size / 100) * 12) / 16).toFixed(3);
    var ui = (typeof s.uiTextSize === 'number') ? s.uiTextSize : 50;   // 0-100 → 12-17px
    want['--ui-fs'] = (12 + (ui / 100) * 5).toFixed(1) + 'px';
    var sm = (typeof s.smallTextSize === 'number') ? s.smallTextSize : 50; // 0-100 → 9.5-15px
    want['--ui-small-fs'] = (9.5 + (sm / 100) * 5.5).toFixed(1) + 'px';

    // ── THE WRITE PHASE (v0.79.1) — pure diffs against the ledger ──
    for (var wk in want) setVar(docEl, wk, want[wk]);
    for (var dk in appliedVars) if (!(dk in want)) setVar(docEl, dk, null);

    // the root attributes — every flip value-guarded (an attribute set
    // to the value it already has was still an invalidation).
    setAttr(docEl, 'data-text-grad', textGrad ? '1' : null);
    var A_ATTR = { '--accent': 'data-a1-grad', '--accent-2': 'data-a2-grad',
      '--accent-3': 'data-a3-grad', '--accent-4': 'data-a4-grad' };
    Object.keys(A_ATTR).forEach(function (av) {
      setAttr(docEl, A_ATTR[av], accGrad[av] ? '1' : null);
    });
    // v0.77.8: the SURFACE + BORDER gates — same gradByKey inputs the
    // override loop already derived (no re-derivation).
    var S_ATTR = { '--surface-1': 'data-s1-grad', '--surface-2': 'data-s2-grad',
      '--bg-app': 'data-bg-grad' };
    Object.keys(S_ATTR).forEach(function (sv) {
      setAttr(docEl, S_ATTR[sv], gradByKey[sv] ? '1' : null);
    });
    setAttr(docEl, 'data-border-grad', gradByKey['--border'] ? '1' : null);
    Object.keys(brightGates).forEach(function (g) {
      setAttr(docEl, g, brightGates[g]);
    });

    // 4. Android status bar tint — needs a REAL hex (no var() in meta).
    //    v0.79.1: value-guarded (a drag re-set the same content attr
    //    per event; now only on a real change).
    var meta = document.getElementById('meta-theme-color');
    if (meta) {
      var cbSpec = canvasBgSpec(s);
      var cbHex = (cbSpec && Array.isArray(cbSpec.colors)) ? solidOf(cbSpec, '') : '';
      var mc = isHexColor(cbHex) ? cbHex : effectiveGrid(s).bg;
      if (mc !== lastMetaColor) {
        meta.setAttribute('content', mc);
        lastMetaColor = mc;
      }
    }

    // 5. re-tint the default chatbot family so canvas-drawn arrows/icons
    //    follow the theme (the family color is drawn on <canvas>, where
    //    var() doesn't resolve — it needs a real hex). v0.79.1: resolved
    //    in pure JS + value-guarded.
    if (window.DoomalayConfig && window.DoomalayConfig.families &&
        window.DoomalayConfig.families.default) {
      var tint = resolvedVar(id, overrides, '--border-strong') || '#4a4a5e';
      if (tint !== lastFamilyTint) {
        window.DoomalayConfig.families.default.color = tint;
        lastFamilyTint = tint;
      }
    }

    // v0.67→v0.79.1: the TOPOLOGY FINGERPRINT gates the painter + the
    // derived gates. The projection anchors and the derived gate CSS
    // are GEOMETRY/STYLESHEET facts — a value-only change (a hue shift,
    // an angle tweak inside the same gradient-ness, a stop recolor)
    // moves no box and rewrites no selector, so the full re-anchor the
    // old code paid per input event buys nothing. The fingerprint
    // covers: the override KEY SET with each var's solid↔gradient
    // state, and the fmt-grad slots. A real topology change (a stop
    // added to a solid, a gradient flattened to one color, a theme
    // switch that changes gradient-ness) re-anchors exactly once.
    // v0.83.4: the bare theme ID is GONE from the key — a base→base
    // flip changes no gradient-ness (both all-solid), yet the id
    // mismatch fired DoomProjection.repaint + DoomGates.refresh on
    // EVERY theme tap, and repaint's layout reads ran right after the
    // var writes invalidated the whole document → a forced synchronous
    // FULL recalc inside the click handler (~60ms at the settings
    // page's DOM — the heart of the "themes tab is barely functional"
    // report). Value changes cascade naturally at the next paint; the
    // painter only needs re-anchoring when the WINDOW SET changes.
    var topo = [];
    Object.keys(gradByKey).sort().forEach(function (gk) {
      topo.push(gk + ':' + (gradByKey[gk] ? 'g' : 's'));
    });
    topo.push('fmt:' + (docEl.getAttribute('data-fmt-grad') || ''));
    var topoKey = topo.join('|');
    if (topoKey !== lastTopology) {
      lastTopology = topoKey;
      // re-anchor every projection window + re-derive the gates (the
      // painter's selector set may have gained/lost gradient windows)
      if (window.DoomProjection) window.DoomProjection.repaint();
      if (window.DoomGates) window.DoomGates.refresh();
    }
  }

  // effectiveGridSpecs merges the user's explicit grid picks over the
  // theme's defaults — v0.44: every value resolves to a gradient SPEC
  // (app.js's canvas renderer consumes these). Stored values that still
  // equal the pre-v0.24 defaults are treated as "never customized" →
  // the theme drives the grid.
  // v0.25 SANITIZATION (kept): only a REAL #rrggbb hex counts as a custom
  // pick. The old code passed ANY stored string through — including
  // CSS-var strings ('var(--bg-app)', written by the old reset button)
  // which are INVALID canvas fillStyles (silently ignored → the grid
  // showed stale colors that matched neither the theme nor the settings).
  // v0.44: a stored {colors,dir,angle} object (or a plain colors ARRAY —
  // the legacy uikit shape) is a CUSTOM spec and wins over the theme.
  function isHexColor(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  }
  function isSpecValue(v) {
    if (Array.isArray(v)) return v.length > 0;
    return !!(v && typeof v === 'object' && Array.isArray(v.colors) && v.colors.length > 0);
  }
  // gridSpecFor — pure: stored value → the effective spec for one key.
  //   spec (object or array) → passed through verbatim (norm'd lazily by
  //   the consumers — storage keeps what the user set)
  //   custom hex             → a 1-color spec (the hex IS the palette)
  //   legacy/default/other   → the theme's 1-color spec
  function gridSpecFor(stored, legacyDefault, themeDefault) {
    if (isSpecValue(stored)) return stored;
    if (isHexColor(stored) && stored.toLowerCase() !== legacyDefault) {
      return { colors: [stored], dir: 'auto' };
    }
    return { colors: [themeDefault], dir: 'auto' };
  }
  function effectiveGridSpecs(s) {
    var t = THEMES[THEMES[s.theme] ? s.theme : 'midnight'];
    return {
      bg: gridSpecFor(s.bg, LEGACY_GRID.bg, t.grid.bg),
      lineColor: gridSpecFor(s.lineColor, LEGACY_GRID.line, t.grid.line),
      dotColor: gridSpecFor(s.dotColor, LEGACY_GRID.dot, t.grid.dot),
      originColor: gridSpecFor(s.originColor, LEGACY_GRID.origin, t.grid.origin)
    };
  }

  // solidOf — pure: the first REAL hex in a spec's colors (canvas
  // fillStyle / meta theme-color need a valid #rrggbb; spec stops are
  // user data — norm() guarantees strings but not hex format).
  function solidOf(spec, fallback) {
    var cs = (spec && Array.isArray(spec.colors)) ? spec.colors : [];
    for (var i = 0; i < cs.length; i++) {
      if (isHexColor(cs[i])) return cs[i];
    }
    return fallback;
  }

  // effectiveGrid keeps the LEGACY HEX contract (v0.24): the solid twin
  // of each grid spec — the meta theme-color tint and any pre-v0.44
  // consumer keep reading hexes from here.
  function effectiveGrid(s) {
    var sp = effectiveGridSpecs(s);
    var t = THEMES[THEMES[s.theme] ? s.theme : 'midnight'];
    return {
      bg: solidOf(sp.bg, t.grid.bg),
      lineColor: solidOf(sp.lineColor, t.grid.line),
      dotColor: solidOf(sp.dotColor, t.grid.dot),
      originColor: solidOf(sp.originColor, t.grid.origin)
    };
  }

  // v0.45 ITEM 3 → v0.49 REWORK: canvasBgSpec — the resolved gradient
  // spec for the CANVAS background. The user spec: "The panel background
  // color should be the one to determine the canvas background, not the
  // app background setting" — so the canvas reads the --bg-panel
  // OVERRIDE (raw spec, texture included — the canvas can paint it) and
  // falls back to the theme's grid bg when the user hasn't customized.
  // (The old appBgSpec read --bg-app; it survives as an alias for one
  // release so any stray consumer keeps working.)
  function canvasBgSpec(s) {
    var id = THEMES[s.theme] ? s.theme : 'midnight';
    var t = THEMES[id];
    var overrides = (s.themeOverrides && s.themeOverrides[id]) || null;
    var raw = overrides ? overrides['--bg-panel'] : null;
    if (raw) {
      // a stored spec (object/array) or a hex — norm via GradientUI if present
      if (typeof raw === 'object') return raw;
      if (isHexColor(raw)) return { colors: [raw], dir: 'auto' };
    }
    return { colors: [t.grid.bg], dir: 'auto' };
  }

  // v0.49: onColorFor(hex) — white or near-black, whichever stays readable
  // on the given fill (relative luminance, the WCAG-ish quick check).
  function onColorFor(hex) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(String(hex == null ? '' : hex));
    if (!m) return '#ffffff';
    var h = m[1];
    var r = parseInt(h.slice(0, 2), 16) / 255;
    var g = parseInt(h.slice(2, 4), 16) / 255;
    var b = parseInt(h.slice(4, 6), 16) / 255;
    var lin = function (c) { return (c <= 0.03928) ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return (L > 0.45) ? '#10131a' : '#ffffff';
  }

  // boot + live-apply (browser only — the node path skips straight to
  // the module.exports below)
  var HAS_WINDOW = (typeof window !== 'undefined');
  var HAS_DOM = HAS_WINDOW && (typeof document !== 'undefined') &&
    !!(document.documentElement) && (typeof document.addEventListener === 'function');
  var Settings = HAS_WINDOW ? window.Settings : null;
  if (Settings) {
    Settings.onChange(applyTheme);
    applyTheme(Settings.getState());
  }

  if (HAS_WINDOW) {
    window.DoomTheme = {
      themes: THEMES,
      apply: applyTheme,
      effectiveGrid: effectiveGrid,
      effectiveGridSpecs: effectiveGridSpecs,
      canvasBgSpec: canvasBgSpec,
      appBgSpec: canvasBgSpec,   // v0.49 alias (old name, same contract)
      onColorFor: onColorFor,
      pendingScheme: pendingScheme,
      isLight: function (id) { return !!(THEMES[id] && THEMES[id].light); },
      customizable: CUSTOMIZABLE,
      // v0.45 ITEM 3: the canonical twin derivation — appearance.js's per-chat
      // #chat-root paint + any future consumer reuses THIS one function
      // (the same math formatter.js's fmtTwins mirrors; the node harness
      // asserts the parity).
      deriveTwins: deriveTwins,
      // v0.79.1: the pure-JS resolved value of a theme var (override twin
      // or [data-theme] block, from the cache — never the style system).
      // app.js's canvas fingerprint reads the family tint through it.
      resolvedThemeVar: function (name) {
        var st = (window.Settings && window.Settings.getState()) || {};
        var rid = THEMES[st.theme] ? st.theme : 'midnight';
        return resolvedVar(rid,
          (st.themeOverrides && st.themeOverrides[rid]) || null, name);
      }
    };

    // ══ v0.67 THE TRANSFORM-PROOF PROJECTION PAINTER ══════════════
    // THE ROOT CAUSE this whole wave fixes: `background-attachment:
    // fixed` is viewport-anchored ONLY outside transformed ancestors —
    // and the chat panel is an ALWAYS-TALL SHEET that carries a
    // PERMANENT transform (v0.42), so every gradient inside it (every
    // pill, card, bubble, text clip — the entire UI except the canvas)
    // rendered ELEMENT-SIZED: each object squeezed the whole viewport
    // gradient into its own little box ("every object follows the
    // gradient in its own weird way or not at all" — the user's exact
    // report). The painter re-anchors each window by hand:
    //     background-size: <viewport>px <viewport>px
    //     background-position: -<el.viewportLeft>px -<el.viewportTop>px
    //     background-attachment: scroll   (element-relative, deterministic)
    // which is mathematically identical to a fixed attachment — the
    // element displays exactly the viewport region it covers — and is
    // immune to transforms. Elements OUTSIDE transformed roots keep
    // the real fixed attachment (the canvas chatbots) untouched.
    // The selector set is derived FROM THE STYLESHEETS (every rule
    // with a fixed attachment or a *-gradient var image), so the
    // painter can never drift from the CSS — including styles the
    // modules inject at runtime (re-collected when <style> nodes
    // appear).
    //
    // ══ v0.74 THE TWO-SPEED PAINTER (the panel-FPS wave) ═══════════
    // User report: "using [the panel] feels slow and it moves in a very
    // glitchy and low fps manner… at rest it's fine." Root cause: the
    // v0.72.3c stale-window fix poked the painter on EVERY writeY —
    // and poke() ran the FULL paint: per transformed root a
    // querySelectorAll(MEGA-SELECTOR), then PER ELEMENT a
    // getComputedStyle (style recalc!), a getBoundingClientRect
    // (layout read) and a style write, interleaved read-write per
    // element (layout thrash). On a phone with a hundred windows in
    // the sheet that is 30-50ms of JS per frame — the panel glide
    // itself became the jank.
    // THE FIX — decompose the anchor. Every window inside a
    // TRANSLATION-ONLY root satisfies
    //     viewportLeft = baseLeft + rootTx
    // so the painter bakes the translation-INVARIANT constant per
    // element ONCE (at full-paint time) and writes
    //     background-position:
    //       calc(var(--proj-tx, 0px) + <Bx>px) calc(var(--proj-ty, 0px) + <By>px)
    // where --proj-tx/--proj-ty live on the ROOT, updated per frame in
    // ONE CSSOM rule write ([data-proj-root="N"]{--proj-tx:…}) — the
    // browser moves every window in that root with a single style
    // recalc, no JS per element, no layout reads at all.
    //   · motion()  — the cheap per-frame path (writeY rides it): read
    //     each root's matrix, write its two vars. Non-translation
    //     matrices (chatbot scale under zoom ≠ 1) fall back to a full
    //     paint for that frame — never wrong, just dearer.
    //   · paint()   — the full path (scroll / resize / DOM change /
    //     theme apply / layout transitions): batched READ phase (all
    //     gCS + gBCR first — no interleaved writes, no thrash) then a
    //     write phase that only touches elements whose bake changed.
    // The MutationObserver learned to tell the panel's own transform
    // writes (root style, transform-only → motion) from real DOM
    // changes (→ full), and layout-property transitions
    // (grid-template-rows un-collapses, height animations) now hold
    // the per-frame repaint window open — the "surface raised bleeds
    // into its scroll box whenever a setting un-collapses" report:
    // windows kept pre-animation anchors for the whole 280ms unfold.
    var PROJ = (function () {
      if (!HAS_DOM) return null;   // the node harness mounts a stub window — no DOM, no painter
      var SEL = null;             // the compiled projection selector
      var painted = [];           // elements carrying painter styles
      var rootReg = [];           // tracked transformed roots: {el, key, rule}
      var varSheet = null;        // the CSSOM sheet holding the per-root var rules
      var rootSet = null;         // Set of root elements (rebuilt with rootReg)
      var nextKey = 0;
      var dirty = false, movingRoot = 0, movingLayout = 0, rafId = 0;
      // v0.78.3: memoEpoch — bumped by repaint()/theme swaps; solid-twin
      // memos live for one epoch (no cross-theme staleness).
      var memoEpoch = 0;
      var writeEpoch = 0;                       // v0.78.3: painter self-write guard
      var stats = { paints: 0, motions: 0,   // v0.78.3: the rig reads these
        rebakes: 0, baked: 0 };              // v0.79.3: the scroll-path counters
      var STYLE_RE = /var\(--[a-z0-9-]*gradient/;

      // ── the root registry: keys + one CSSOM rule per root ──────
      // The vars are written through CSSOM (styleEl.sheet rules), NOT
      // inline setProperty on the root: CSSOM mutations bypass the
      // MutationObserver, so the painter never re-triggers itself.
      function ensureVarSheet() {
        if (varSheet && varSheet.isConnected) return;
        varSheet = document.createElement('style');
        varSheet.id = 'doom-proj-vars';
        document.head.appendChild(varSheet);
        // rebuild the rules for any roots registered before the sheet
        for (var i = 0; i < rootReg.length; i++) ensureRule(rootReg[i]);
      }
      function ensureRule(R) {
        if (R.rule) return;
        try {
          varSheet.sheet.insertRule('[data-proj-root="' + R.key + '"]{' +
            '--proj-tx:0px;--proj-ty:0px;}', varSheet.sheet.cssRules.length);
          R.rule = varSheet.sheet.cssRules[varSheet.sheet.cssRules.length - 1];
        } catch (e) { R.rule = null; }
      }
      function syncRoots() {
        ensureVarSheet();
        var found = [];
        // v0.92.1 THE ORBIT REST: .chatbot LEAVES the root registry —
        // the icon chrome (disc, name pill, sandbox badge) went LOCAL
        // (scroll attachment, index.html v0.92.1); nothing inside a
        // .chatbot carries a projected window anymore, so an icon's
        // per-frame transform drift must not open motion windows (each
        // window close fired a settle paint — the measured self-
        // sustaining ~30 paints/s + ~92 motion ticks/s while any tab
        // group orbited; RESEARCH-V092's orbit rig). The REAL scopes
        // stay: the panel, the connect overlay, the hub + template
        // sheets — their glides keep the motion path they were designed
        // for.
        var els = document.querySelectorAll(
          '#chat-panel, #connect-overlay, .hub-sheet, .tpl-sheet');
        var keep = [];
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var t = '';
          try { t = getComputedStyle(el).transform; } catch (e) {}
          if (!t || t === 'none') continue;   // untransformed: CSS fixed attachment already works
          found.push(el);
          var R = null;
          for (var r = 0; r < rootReg.length; r++) {
            if (rootReg[r].el === el) { R = rootReg[r]; break; }
          }
          if (!R) {
            R = { el: el, key: nextKey++, rule: null };
            el.setAttribute('data-proj-root', String(R.key));
            ensureRule(R);
          }
          keep.push(R);
        }
        // roots that lost their transform/spot: drop the attribute + rule
        for (var d = 0; d < rootReg.length; d++) {
          if (found.indexOf(rootReg[d].el) === -1) {
            rootReg[d].el.removeAttribute('data-proj-root');
          }
        }
        rootReg = keep;
      }

      // readMatrix — the computed transform as {tx, ty, translateOnly}
      // matrix3d (translate3d serializes as matrix3d in Chromium)
      // collapses to translation-only when the linear part is identity.
      function readMatrix(el) {
        var t = '';
        try { t = getComputedStyle(el).transform; } catch (e) {}
        if (!t || t === 'none') return { tx: 0, ty: 0, translateOnly: true };
        var m = /matrix3d\(([^)]+)\)/.exec(t);
        if (m) {
          var v3 = m[1].split(',').map(parseFloat);
          if (v3.length === 16 &&
              v3[0] === 1 && v3[1] === 0 && v3[4] === 0 && v3[5] === 1) {
            return { tx: v3[12], ty: v3[13], translateOnly: true };
          }
          return { tx: 0, ty: 0, translateOnly: false };
        }
        m = /matrix\(([^)]+)\)/.exec(t);
        if (m) {
          var v = m[1].split(',').map(parseFloat);
          if (v[0] === 1 && v[1] === 0 && v[2] === 0 && v[3] === 1) {
            return { tx: v[4], ty: v[5], translateOnly: true };
          }
          return { tx: 0, ty: 0, translateOnly: false };
        }
        return { tx: 0, ty: 0, translateOnly: false };
      }

      function setVars(R, x, y) {
        if (!R.rule) return;
        try {
          R.rule.style.setProperty('--proj-tx', x + 'px');
          R.rule.style.setProperty('--proj-ty', y + 'px');
        } catch (e) {}
      }

      // motionTick — the CHEAP path: one CSSOM var write per root.
      // A non-translation matrix (scale/rotate) can't ride the
      // decomposition → flag a full paint (correct, just dearer).
      // v0.78.3c: ALSO true-up tracked scrollers — Chromium's scroll
      // ANCHORING adjusts scrollTop silently while containers resize
      // (the panel stretch), with NO scroll event; without this the
      // baked constants drift by the anchoring delta mid-glide (the
      // A5b 33-66px regressions).
      function motionTick() {
        for (var i = 0; i < rootReg.length; i++) {
          var R = rootReg[i];
          var M = readMatrix(R.el);
          if (M.translateOnly) setVars(R, -M.tx, -M.ty);
          else { setVars(R, 0, 0); dirty = true; }
        }
        for (var si = 0; si < trackedScrollers.length; si++) {
          var tsc = trackedScrollers[si];
          if (!tsc || !tsc.isConnected) continue;
          var nowS2 = tsc.scrollTop || 0;
          var lastS2 = tsc.__projSy || 0;
          if (nowS2 !== lastS2) {
            tsc.__projSy = nowS2;
            scrollRebake(tsc, nowS2 - lastS2);
          }
        }
      }

      function collect() {
        var sels = [];
        try {
          for (var s = 0; s < document.styleSheets.length; s++) {
            var sheet = document.styleSheets[s];
            var rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }
            (function walk(rs) {
              for (var i = 0; i < rs.length; i++) {
                var r = rs[i];
                // NOTE: modern Chromium gives EVERY CSSStyleRule a
                // cssRules list (CSS nesting) — only recurse when it
                // actually has children, and never skip the rule itself.
                if (r.cssRules && r.cssRules.length) walk(r.cssRules);
                if (!r.style || !r.selectorText) continue;
                var att = r.style.getPropertyValue('background-attachment');
                var img = r.style.getPropertyValue('background-image') || '';
                if ((att && att.indexOf('fixed') !== -1) || STYLE_RE.test(img)) {
                  // drop pseudo-elements (::after etc) — they never match
                  sels.push(r.selectorText.replace(/::[a-z-]+/g, ''));
                }
              }
            })(rules);
          }
        } catch (e) { /* a locked sheet is simply skipped */ }
        SEL = sels.length ? sels.join(',') : null;
      }

      function num(v) { return (Math.round(v * 10) / 10); }
      function fmtCalc(varName, b) {
        // calc(var(--proj-tx, 0px) + Bpx) with sign-aware formatting
        return 'calc(var(' + varName + ', 0px) ' + (b < 0 ? '- ' : '+ ') +
          Math.abs(num(b)) + 'px)';
      }
      // v0.78.3c: the Y anchor is PLAIN again — the scroll path adjusts
      // baked constants incrementally (scrollRebake), not via a var: a
      // var on the nearest scroller is unsound (flex footers and sticky
      // zones read a scroller they never scroll with — the mid-glide
      // drifts). Arithmetic re-bake, zero layout reads.
      function fmtCalcY(b) {
        return 'calc(var(--proj-ty, 0px) ' + (b < 0 ? '- ' : '+ ') +
          Math.abs(num(b)) + 'px)';
      }
      // v0.78.3d: BOTTOM-ANCHORED elements (the input zone below the
      // flex:1 scroller) track the panel WINDOW, not the sheet: their
      // viewport position moves by translate − Δ(visible height). Their
      // bake compensates with the live --panel-vis-h (identical to the
      // flat bake at rest — the var cancels; during the stretch it tracks).
      function fmtCalcYVis(b) {
        return 'calc(var(--proj-ty, 0px) ' + (b < 0 ? '- ' : '+ ') +
          Math.abs(num(b)) + 'px - var(--panel-vis-h, 0px))';
      }

      // ══ v0.94.3 TRACK 2 — THE TRANSFORM-CARRIED GRADIENT LAYERS ══
      // The repo's own RESEARCH-V092 endgame: "the background on its OWN
      // layer, moved with transform (compositor-only, no repaint)". The
      // legacy bake parked the gradient ON the element as a vw×vh
      // background-position: calc(var(--proj-tx)+B) — every motion tick
      // the var write style-recalced EVERY painted window and each
      // background-position change REPAINTED + RE-RASTERED its gradient
      // (the rig: the 60Hz panel drag ran at 15fps with 78-320 long
      // tasks — the raster storm). Track 2 moves each window's gradient
      // to a generated ::before LAYER (its own compositor layer via
      // will-change:transform) whose per-frame compensation rides a
      // TRANSFORM consuming the same --proj-tx/--proj-ty vars: style
      // recalc still happens (the vars cascade), but every consumer now
      // resolves to a compositor transform — ZERO repaints, ZERO rasters
      // during panel motion. Geometry is IDENTICAL to the legacy bake:
      //   legacy: field origin = elementLeft + (var + B)      = 0 (viewport)
      //   layer:  field origin = layerLeft + B + transform(var) = 0
      // (the transform carries the var with the SAME sign — the layer
      // inherits the root's translate, so +var cancels it exactly).
      // Everything else (the read phase, the scroller tracking, the
      // bottom-anchored --panel-vis-h compensation, scrollRebake's
      // arithmetic) is untouched; only the WRITE side changes — and it
      // writes CSSOM rules on OUR OWN stylesheet, so the MutationObserver
      // never sees a single painter write (the whole __projWriteEpoch
      // dance becomes layer-path-inert).
      // FALLBACK: elements that already use ::before/::after, paint with
      // background-clip:text, or are static WITH positioned descendants
      // (adding position:relative would re-anchor them) keep TODAY's
      // inline bake — both paths coexist, the survey says the fallback
      // set is empty on the chat panel (0/30 conflicted).
      var L2 = (function () {
        var sheetEl = null, sheet = null;
        var nextId = 1;
        function ensure() {
          if (sheetEl && sheetEl.isConnected) return true;
          try {
            sheetEl = document.createElement('style');
            sheetEl.id = 'proj-layer-styles';
            document.head.appendChild(sheetEl);
            sheet = sheetEl.sheet;
            return !!sheet;
          } catch (e) { return false; }
        }
        // eligibility — memoized (el.__projL2ok: 2|1|0; 2 = ::after rider,
        // 1 = ::before rider, 0 = fallback).
        // v0.94.4: TRACK 2 IS LIVE. The v0.94.3 dormancy is resolved — the
        // "later sibling's layer paints over earlier elements" was NOT a
        // stacking-context bug at all: the epoch RE-MINT (theme flip /
        // gate-CSS injection → repaint()) snapshotted elements whose own
        // gradient OUR base rule had already suppressed → it minted DEAD
        // layers (background-image: none), the suppressed elements went
        // see-through, and whatever raw background sat behind (the panel
        // root's own transform-squeezed fixed gradient, the surviving
        // !important twins) showed through — reading exactly like a
        // stacking overrun. Three fixes below (lift-read-restore in
        // snapshot, !important suppression, contain:paint) + the runtime
        // kill-switch. L2_ON defaults TRUE; window.__doomalayL2 = false
        // is the device-class escape hatch (low-memory WebViews bail to
        // the legacy bake — oversized composited layers cost GPU memory).
        var L2_ON = (window.__doomalayL2 !== false);
        function ok(el, snap) {
          if (!L2_ON) return (el.__projL2ok = 0);
          if (el.__projL2ok !== undefined) return el.__projL2ok;
          var good = 0;
          try {
            var beforeFree = getComputedStyle(el, '::before').content === 'none';
            var afterFree = getComputedStyle(el, '::after').content === 'none';
            if (!beforeFree && !afterFree) return (el.__projL2ok = 0);
            if (snap.clip === 'text') return (el.__projL2ok = 0);
            // the base rule clips the oversized layer with clip-path — an
            // element whose own shadow paints outside the box would lose it
            if (snap.shadow && snap.shadow !== 'none') return (el.__projL2ok = 0);
            // v0.94.4: an element with its OWN clip-path shape (the hub
            // bundle flag's polygon) must not have it overridden by the
            // base rule's inset() — it rides the legacy bake instead.
            if (snap.clipPath && snap.clipPath !== 'none') return (el.__projL2ok = 0);
            if (snap.position === 'static') {
              // position:relative is only safe without positioned descendants
              var kids = el.querySelectorAll('*');
              for (var k = 0; k < kids.length; k++) {
                var kp = getComputedStyle(kids[k]).position;
                if (kp === 'absolute' || kp === 'fixed') return (el.__projL2ok = 0);
              }
            }
            good = beforeFree ? 1 : 2;   // prefer ::before; ::after when taken
          } catch (e) { good = 0; }
          return (el.__projL2ok = good);
        }
        // the read phase's extra computed reads for layer candidates.
        // v0.94.4: THE LIFT-READ-RESTORE — an element already riding its
        // layer carries OUR suppression (background-image:none !important)
        // on its base rule; a plain read would snapshot 'none' and the
        // epoch re-mint would paint a DEAD layer over a suppressed
        // element (the v0.94.3 "stacking bug" — actually self-
        // cannibalization). The suppression lifts for the read and
        // restores right after; both are CSSOM writes on OUR OWN rule —
        // the MutationObserver never sees them, and background-image has
        // zero layout cost, so the lift can't thrash.
        function snapshot(el) {
          var L = el.__projL2, lift = false;
          try {
            if (L && L.base) {
              try {
                // stamp FIRST — the lift's own attr mutation must read as
                // painter-owned even if this element was quiet last paint
                el.__projWriteEpoch = writeEpoch;
                L.base.style.removeProperty('background-image');
                el.style.removeProperty('background-image');
                lift = true;
              } catch (e0) {}
            }
            var cs = getComputedStyle(el);
            var out = {
              position: cs.position,
              image: cs.backgroundImage,
              color: cs.backgroundColor,
              repeat: cs.backgroundRepeat,
              radius: cs.borderRadius,
              clip: cs.backgroundClip,
              shadow: cs.boxShadow,
              clipPath: cs.clipPath,
              ovfX: cs.overflowX,
              bt: parseFloat(cs.borderTopWidth) || 0,
              br: parseFloat(cs.borderRightWidth) || 0,
              bb: parseFloat(cs.borderBottomWidth) || 0,
              bl: parseFloat(cs.borderLeftWidth) || 0
            };
            if (lift) {
              L.base.style.setProperty('background-image', 'none', 'important');
              el.style.setProperty('background-image', 'none', 'important');
            }
            return out;
          } catch (e) {
            try {
              if (lift && L && L.base) {
                L.base.style.setProperty('background-image', 'none', 'important');
                el.style.setProperty('background-image', 'none', 'important');
              }
            } catch (e1) {}
            return null;
          }
        }
        // bake/patch — returns true when the element rides the layer path.
        // snap is required only for MINTS (fresh elements) and EPOCH RE-MINTS
        // (theme flips); position-only patches (scrolls, settles, carries)
        // run snap-less. pseudo: 1 = ::before, 2 = ::after.
        function bake(el, snap, bx, by, size, vis, epoch, pseudo) {
          if (!ensure()) return false;
          var L = el.__projL2;
          var fresh = !L, stale = !!L && el.__projL2Epoch !== epoch;
          if ((fresh || stale) && !snap) return false;
          if (fresh || stale) {
            if (fresh) {
              var ps = (pseudo === 2) ? '::after' : '::before';
              var id = 'pl' + (nextId++);
              try { el.setAttribute('data-proj', id); } catch (e) { return false; }
              var i1, i2;
              try {
                i1 = sheet.insertRule('[data-proj="' + id + '"]' + ps + ' {}', sheet.cssRules.length);
                i2 = sheet.insertRule('[data-proj="' + id + '"] {}', sheet.cssRules.length);
              } catch (e) { try { el.removeAttribute('data-proj'); } catch (e2) {} return false; }
              var br = sheet.cssRules[i1], base = sheet.cssRules[i2];
              L = el.__projL2 = { id: id, br: br, base: base, pos: null, size: null, vis: null, bl: snap.bl, bt: snap.bt };
              // base — the suppression + the geometry contract
              var bs = base.style;
              bs.isolation = 'isolate';          // keeps z-index:-1 above the parent's paint
              if (snap.position === 'static') bs.position = 'relative';
              // v0.94.4: !important — the gradient TWIN rules (index.html's
              // [style*="background:var(--surface-2)"] etc.) carry their own
              // !important image declarations; a plain 'none' lost to them.
              // Our sheet is appended last in document order, so at equal
              // (0,1,0)+important WE win — but see the INLINE suppression
              // below for the twins that out-specify us.
              bs.setProperty('background-image', 'none', 'important');
              bs.setProperty('background-color', 'transparent', 'important');
              // v0.94.4b: THE INLINE SUPPRESSION — the gate twins reach
              // (0,2,0)+ specificity with their own !important gradients
              // ([data-a1-grad] [style*="color:var(--accent)"] on the model
              // pills, [data-s2-grad] … on the composer buttons) and NO
              // attribute rule of ours can out-specify an ID-matched twin.
              // The element's inline style + !important beats EVERY
              // selector at any specificity (only a later inline-important
              // could — nothing writes those). Inline writes are observer-
              // invisible via the writeEpoch stamp — the same dance the
              // legacy bake has ridden since v0.78.3. Cleared on drop()
              // and on every legacy fallthrough.
              try {
                el.style.setProperty('background-image', 'none', 'important');
                el.style.setProperty('background-color', 'transparent', 'important');
                el.__projWriteEpoch = writeEpoch;   // painter-owned — the observer skips it
              } catch (e3) {}
              // v0.94.4: paint containment — the oversized pseudo (its box
              // extends 110vh up / 90vh+20px down) would otherwise extend
              // every scrollable ancestor's scrollHeight (the rig measured
              // the transcript scroller at 3511px vs 3029 — a 482px void the
              // auto-scroll drowned in) AND turn every layered element into
              // a findScroller() false positive (scrollHeight > clientHeight
              // on plain bubbles). contain:paint clips the pseudo to the
              // element's box — zero scroll-overflow contribution, and the
              // element itself becomes a stacking context (already isolated)
              // at no extra cost. ONLY for overflow:visible bases (the
              // v0.94.4 attempt to include overflow:hidden elements
              // (.panel-body) REGRESSED the open/resize/settle scenarios
              // on the rig — paint containment implies layout containment,
              // and isolating a container that the panel stretch animates
              // re-layouts it expensively; a hidden-overflow base's own
              // clip already covers its pseudo's painting, and its
              // scrollHeight inflation (481→741 in the rig) only matters
              // to programmatic scrollTop nobody performs).
              if (snap.ovfX === 'visible') bs.contain = 'paint';
              // v0.94.3c: THE OVERSIZE GEOMETRY — the pseudo's box must
              // STILL COVER the element's box at every panel translate:
              // the transform slides the whole box by var(-T), so the box
              // extends 110vh UP (the panel's max travel + the stretch) and
              // a 20px skirt sideways. The element clips it with clip-path
              // (paint-only — no layout, no scroll side effects).
              bs.clipPath = 'inset(0' +
                (snap.radius && snap.radius !== 'none' ? ' round ' + snap.radius : '') + ')';
              // the layer itself — oversized, viewport-anchored field.
              // Coverage math: the pseudo is viewport-FROZEN (transform =
              // -T) while the element slides +T beneath it — the RELATIVE
              // motion is 2T — so the box extends 110vh UP (the open
              // direction) and 90vh + 20px DOWN (the hide direction + the
              // stretch), 40px sideways. Tiles raster on demand — the box
              // size costs nothing until painted.
              var s = br.style;
              s.setProperty('content', '""');
              s.position = 'absolute';
              s.top = 'calc(-110vh - ' + snap.bt + 'px)';
              s.left = 'calc(-40px - ' + snap.bl + 'px)';
              s.right = 'calc(-40px - ' + snap.br + 'px)';
              s.bottom = 'calc(-90vh - 20px - ' + snap.bb + 'px)';
              s.zIndex = '-1';
              s.pointerEvents = 'none';
            }
            // (re)mint the decorative props (first mint + every epoch/theme flip)
            var d = L.br.style;
            d.backgroundImage = snap.image;
            d.backgroundColor = snap.color;
            d.backgroundRepeat = snap.repeat;
            el.__projL2Epoch = epoch;
          }
          if (L.vis !== vis) {
            L.vis = vis;
            L.br.style.transform = 'translate3d(calc(var(--proj-tx, 0px)),' +
              ' calc(var(--proj-ty, 0px)' + (vis ? ' - var(--panel-vis-h, 0px)' : '') + '), 0)';
            L.br.style.willChange = 'transform';
          }
          if (L.size !== size) { L.size = size; L.br.style.backgroundSize = size; }
          // v0.94.3c: the field is anchored to the VIEWPORT ORIGIN inside the
          // OVERSIZED box: pos = the TOP/LEFT margins + border + the legacy
          // constant — the pseudo's origin (element box − the margin) plus
          // this pos lands the vw×vh field at (0,0) viewport — invariant
          // under the transform. The border offsets are stored on L at mint
          // (patches run snap-less).
          var posX = 'calc(40px ' + ((L.bl + (bx || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bl + (bx || 0)) * 100) / 100) + 'px)';
          var posY = 'calc(110vh ' + ((L.bt + (by || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bt + (by || 0)) * 100) / 100) + 'px)';
          var pos = posX + ' ' + posY;
          if (L.pos !== pos) { L.pos = pos; L.br.style.backgroundPosition = pos; }
          return true;
        }
        // scrollRebake's arithmetic write — the rule position, not inline
        function rebake(el) {
          var L = el.__projL2;
          if (!L) return false;
          var posX = 'calc(40px ' + ((L.bl + (el.__projBx || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bl + (el.__projBx || 0)) * 100) / 100) + 'px)';
          var posY = 'calc(110vh ' + ((L.bt + (el.__projBy || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bt + (el.__projBy || 0)) * 100) / 100) + 'px)';
          var pos = posX + ' ' + posY;
          if (L.pos !== pos) { L.pos = pos; L.br.style.backgroundPosition = pos; }
          return true;
        }
        function drop(el) {
          var L = el.__projL2;
          if (!L) return false;
          try {
            var rules = sheet.cssRules;
            var needle = '[data-proj="' + L.id + '"]';
            for (var i = rules.length - 1; i >= 0; i--) {
              if ((rules[i].selectorText || '').indexOf(needle) !== -1) sheet.deleteRule(i);
            }
            el.removeAttribute('data-proj');
          } catch (e) {}
          // v0.94.4b: clear the INLINE suppression — the CSS state owns the
          // element again (byte-identical to the no-gradient look)
          try {
            el.style.removeProperty('background-image');
            el.style.removeProperty('background-color');
            el.__projWriteEpoch = writeEpoch;   // painter-owned removal
          } catch (e4) {}
          el.__projL2 = undefined;
          return true;
        }
        function resizeAll(size) {
          if (!sheet) return;
          try {
            var rules = sheet.cssRules;
            for (var i = 0; i < rules.length; i++) {
              var sel = rules[i].selectorText || '';
              if (sel.indexOf('::before') !== -1) rules[i].style.backgroundSize = size;
            }
          } catch (e) {}
        }
        return { ok: ok, snapshot: snapshot, bake: bake, rebake: rebake, drop: drop, resizeAll: resizeAll };
      })();


      // v0.78.3: scroll containers. The nearest scrollable ancestor's
      // scrollTop is subtracted at bake time (B is scroll-origin
      // relative); the live offset rides --proj-sy on a per-scroller CSS
      // rule (rule writes never trip the MutationObserver — same trick as
      // the root vars). Cached per element (parents don't move).
      function findScroller(el, stopAt) {
        var p = el.parentElement;
        while (p && p !== stopAt) {
          if (p.nodeType === 1 && p.scrollHeight > p.clientHeight + 1) return p;
          p = p.parentElement;
        }
        return null;
      }
      var scrollRules = [];
      function scrollerRule(el) {
        for (var i = 0; i < scrollRules.length; i++) {
          if (scrollRules[i].el === el) return scrollRules[i];
        }
        ensureVarSheet();   // v0.78.3: the same sheet the root rules ride
        var rec = { el: el, rule: null };
        try {
          var idx = varSheet.sheet.insertRule(
            '[data-proj-sy="' + scrollRules.length + '"] { --proj-sy: 0px; }',
            varSheet.sheet.cssRules.length);
          rec.rule = varSheet.sheet.cssRules[idx];
          el.setAttribute('data-proj-sy', String(scrollRules.length));
        } catch (e) {}
        scrollRules.push(rec);
        return rec;
      }

      function paint() {
        if (!SEL) collect();
        if (!SEL) return;
        syncRoots();
        var vw = window.innerWidth, vh = window.innerHeight;
        var size = vw + 'px ' + vh + 'px';
        var epoch = memoEpoch;
        stats.paints++;   // v0.78.3: rig counter
        for (var rr = 0; rr < rootReg.length; rr++) rootReg[rr].bRect = undefined;
        // ── READ PHASE (batched — no writes between reads) ────────
        var reads = [];
        for (var ri = 0; ri < rootReg.length; ri++) {
          var R = rootReg[ri];
          var els;
          try { els = R.el.querySelectorAll(SEL); } catch (e) { SEL = null; return; }
          var M = readMatrix(R.el);
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!el.__projPainted) {
              // v0.78.3: memoized-solid skip — no getComputedStyle for the
              // (majority) solid twins on every paint; the epoch clears
              // the memo on repaint/theme swaps.
              if (el.__projNoneEpoch === epoch) continue;
              // v0.94.4 (C3): ONE computed read, BOTH properties — the old
              // two-call probe (image, then attachment) forced two style
              // flushes per element per first-encounter paint; on the
              // open of a long transcript that was 120+ flushes under
              // 6× CPU throttle (the panel-open long tasks).
              var pcs = getComputedStyle(el);
              var img = pcs.backgroundImage;
              if (!img || img === 'none') { el.__projNoneEpoch = epoch; continue; }
              // v0.92.1: the projection model is FIXED-ATTACHMENT windows
              // only. An element whose computed attachment carries no
              // 'fixed' opted out (the icon chrome's LOCAL gradients —
              // scroll attachment). It never enters the painted set, so a
              // SEL match via a gradient var() can never resurrect the
              // per-motion re-anchor churn. Memoized with the same epoch
              // (a theme flip bumps memoEpoch + re-collects).
              if (pcs.backgroundAttachment.indexOf('fixed') === -1) { el.__projNoneEpoch = epoch; continue; }
              el.__projPainted = true;
            }
            var r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || r.bottom < -60 || r.top > vh + 60) {
              // v0.79.3: OFFSCREEN elements stay PAINTED (carry, no
              // re-bake). The v0.78.3 cleanup dropped them + stripped
              // their baked styles — so every pill scrolling back into
              // view fell back to the raw CSS fixed-attachment gradient
              // (element-local inside the transformed root) until the
              // 150ms post-scroll settle paint: the "for an instant
              // paints the full gradient into a single pill" flash
              // (the user's report). Carried elements keep their baked
              // position/size; scrollRebake keeps their Y constant true
              // while they scroll (they're in `painted`); the settle
              // paint re-validates on real changes. Zero-size/hidden
              // elements carry too — their styles are inert while
              // unrendered, and the attribute-mutation observer re-paints
              // when they reappear.
              // v0.79.4: the carry still reads the rect HERE — keep the
              // NUMERIC constants true for carried elements (content-
              // visibility un-rendering shifts far-offscreen rows
              // SILENTLY: the placeholder/real height delta lands on
              // their geometry with no scroll event, so arithmetic-only
              // maintenance rots the constants — the v0783 rig measured
              // −51/−74px on far-offscreen rows after a long scroll,
              // and scrolling back up rode the rotted math = the
              // misplaced-gradient flash reborn). The STYLE stays as-is
              // (offscreen, inert); the constants land fresh so the
              // arithmetic back in stays true.
              el.__projR = R;   // v0.79.3: the newcomer bake needs the root
              el.__projCarry = true;
              reads.push({ el: el, R: R, carry: true,
                bx: M.translateOnly ? (-r.left + M.tx) : -r.left,
                by: M.translateOnly ? (-r.top + M.ty) : -r.top });
              continue;
            }
            // v0.78.3c: bake FLAT (the current viewport position) — the
            // scroll path re-bakes constants incrementally (scrollRebake)
            // on scroll events AND on silent scroll-anchoring drift
            // (motionTick's true-up). Paint-time: discover + track this
            // element's owner scroller so the true-up covers scrollers
            // that never fired a scroll event yet (fresh panels).
            var sco = el.__projScOwner;
            if (sco === undefined) {
              sco = findScroller(el, R.el.parentElement);
              el.__projScOwner = sco;
            }
            if (sco && trackedScrollers.length < 12) {
              var knownSc = false;
              for (var k = 0; k < trackedScrollers.length; k++) {
                if (trackedScrollers[k] === sco) { knownSc = true; break; }
              }
              if (!knownSc) trackedScrollers.push(sco);
            }
            var sTop = 0;
            // v0.78.3d: bottom-anchored detection — not inside a scroller,
            // but hugging the panel window's bottom edge (the input zone
            // + activity row under the flex:1 scroller).
            var visForm = false;
            // v0.78.3e — the unified window-anchored rule. The stretch
            // sizes .panel-body; its flex:1 scroller child follows it.
            // (a) outside any scroller + hugging the body bottom (the
            //     chat input zone below the scroller), or
            // (b) inside a NON-body scroller with slack (empty chat: the
            //     end elements ride the box bottom), or
            // (c) absolute + non-auto bottom whose offset parent's bottom
            //     edge IS the body bottom (#chat-jump).
            // Elements scrolling in .panel-body ITSELF (settings views)
            // are content-anchored — always flat.
            if (R.bodyEl === undefined) {
              R.bodyEl = R.el.querySelector('.panel-body') || null;
            }
            var inChildScroller = !!(sco && R.bodyEl && sco !== R.bodyEl);
            if (!sco || (inChildScroller && sco.scrollHeight <= sco.clientHeight + 1)) {
              if (R.bodyEl) {
                var br = R.bodyEl.getBoundingClientRect();
                if (br.bottom > -1e9 && br.bottom - r.bottom < 48) visForm = true;
              }
            }
            if (!visForm) {
              // v0.78.3d: absolute + non-auto bottom, anchored to a
              // container whose BOTTOM EDGE IS the stretch window's bottom
              // (the flex:1 scroller / the body itself — #chat-jump rides
              // bottom: inputbar+14). Absolute elements anchored to
              // CONTENT rows (settings color rows) are flat — their
              // anchor doesn't move with the window.
              var absBot = el.__projAbsBot;
              if (absBot === undefined) {
                try {
                  var pcs = getComputedStyle(el);
                  absBot = (pcs.position === 'absolute' && pcs.bottom !== 'auto') ? 1 : 0;
                } catch (perr) { absBot = 0; }
                el.__projAbsBot = absBot;
              }
              if (absBot && R.bodyEl && (!sco || inChildScroller)) {
                var opr = null;
                try { opr = el.offsetParent ? el.offsetParent.getBoundingClientRect() : null; } catch (oerr) {}
                if (opr && R.bRect === undefined) {
                  R.bRect = R.bodyEl.getBoundingClientRect();
                }
                if (opr && R.bRect && Math.abs(opr.bottom - R.bRect.bottom) < 2) visForm = true;
              }
            }
            // the translation-invariant base: strip the root's CURRENT
            // translation so the per-frame vars can re-add it
            var flatBy = M.translateOnly ? (-r.top + M.ty - sTop) : (-r.top - sTop);
            var yB = flatBy, yCalc = fmtCalcY(flatBy);
            if (visForm) {
              // compensate: runtime = var(--proj-ty) + (flatB + V0) - var(--panel-vis-h)
              var v0 = R.visH0;
              if (v0 === undefined) {
                var hv = '';
                try { hv = getComputedStyle(R.el).getPropertyValue('--panel-vis-h'); } catch (herr) {}
                v0 = parseFloat(hv) || 0;
                R.visH0 = v0;
              }
              yB = flatBy + v0;
              yCalc = fmtCalcYVis(yB);
            }
            reads.push({ el: el, R: R,
              bx: M.translateOnly ? (-r.left + M.tx) : -r.left,
              by: yB,
              pos: fmtCalc('--proj-tx', M.translateOnly ? (-r.left + M.tx) : -r.left) + ' ' + yCalc,
              // v0.94.3: the Track-2 candidate snapshot — computed reads stay
              // in the READ phase (batched, layout-clean). Taken only when a
              // mint or an epoch re-mint is due; fallback-flagged elements
              // skip the reads entirely.
              vis: visForm,
              snap: (el.__projL2ok === 0) ? null :
                ((el.__projL2 && el.__projL2Epoch === epoch) ? null : L2.snapshot(el)) });
            el.__projR = R;   // v0.79.3: the newcomer bake needs the root
          }
        }
        // ── WRITE PHASE (only what changed — a no-op bake writes
        //    nothing, fires no MutationObserver, settles at once) ──
        // v0.78.3: writeEpoch — elements this paint touched carry it; the
        // observer skips THEIR style mutations (the painter's own writes
        // re-triggering the observer was a self-sustaining paint loop:
        // bake → observer → mark → paint → bake…).
        var wep = ++writeEpoch;
        var keep = [];
        for (var w = 0; w < reads.length; w++) {
          var it = reads[w];
          // v0.79.3: the carry entries (offscreen/hidden) — no style
          // writes; they only STAY painted. v0.79.4: their numeric
          // constants still TRUE-UP (the rect was read anyway — a pure
          // JS field write, no style touch, no observer trigger), so the
          // silent content-visibility shifts can't rot the arithmetic;
          // and the STYLE lands from the trued constants too (writeEpoch-
          // stamped — the observer never sees the painter's own write) —
          // the v0783 rig's at-rest anchor check reads the STYLES of
          // offscreen carried elements, and arithmetic-from-rot was the
          // 130-588px drift.
          if (it.carry) {
            if (it.bx !== undefined) {
              it.el.__projBx = it.bx;
              it.el.__projBy = it.by;
              if (it.el.__projL2 && L2.rebake(it.el)) {   // v0.94.3: the rule position — no layout style write
                /* layered carry — constants trued, rule patched */
              } else {
                var cpos = fmtCalc('--proj-tx', it.bx) + ' ' + fmtCalcY(it.by);
                if (it.el.__projPos !== cpos || !it.el.style.backgroundSize) {
                  // v0.94.3: carried elements must ALSO carry the size+
                  // attachment (an element that layered once, dropped, and
                  // re-carried would otherwise bake position-only — the
                  // gradient renders at AUTO size = the misplaced-field bug)
                  it.el.style.backgroundPosition = cpos;
                  it.el.style.backgroundSize = size;
                  it.el.style.backgroundAttachment = 'scroll';
                  // v0.94.4b: a carried element that fell back to legacy
                  // must shed any stale INLINE suppression — the legacy
                  // bake paints via the element's OWN background-image.
                  it.el.style.removeProperty('background-image');
                  it.el.style.removeProperty('background-color');
                  it.el.__projPos = cpos;
                  it.el.__projWriteEpoch = wep;   // painter-owned — the observer skips it
                }
              }
            }
            keep.push(it.el);
            continue;
          }
          // v0.94.3: TRACK 2 FIRST — the transform-carried layer path
          // (compositor-only motion; falls back to the legacy inline bake
          // for conflicted elements — both paths coexist). An element that
          // already rides its layer (fresh epoch) patches its rule position
          // from the fresh constants — it NEVER falls through to the legacy
          // inline write (the fallthrough left the layer stale by the
          // scroll/motion delta — the misplaced-field visual bug).
          var layered = false;
          it.el.__projBx = it.bx;
          it.el.__projBy = it.by;
          if (it.el.__projL2 && it.el.__projL2Epoch === epoch) {
            layered = true;
            L2.rebake(it.el);
          } else if (it.snap && L2.ok(it.el, it.snap)) {
            layered = L2.bake(it.el, it.snap, it.bx, it.by, size, it.vis, epoch, it.el.__projL2ok);
          }
          if (layered) {
            // clear any legacy inline bake this element carried from before
            // the layer path existed (style-attr mutations — epoch-stamped
            // so the observer never sees the painter's own writes)
            if (it.el.__projPos !== undefined) {
              it.el.style.removeProperty('background-position');
              it.el.style.removeProperty('background-size');
              it.el.style.removeProperty('background-attachment');
              it.el.__projPos = undefined;
              it.el.__projWriteEpoch = wep;
            }
          } else {
            // v0.94.4b: the legacy fallthrough — clear any stale INLINE
            // suppression first (the legacy bake paints via the element's
            // OWN background-image; the inline none would blank it).
            // removeProperty on an absent decl fires no mutation record.
            it.el.style.removeProperty('background-image');
            it.el.style.removeProperty('background-color');
            if (it.el.__projPos !== it.pos) {
              it.el.style.backgroundPosition = it.pos;
              it.el.__projPos = it.pos;
            }
            if (it.el.style.backgroundSize !== size) it.el.style.backgroundSize = size;
            if (it.el.style.backgroundAttachment !== 'scroll') it.el.style.backgroundAttachment = 'scroll';
            it.el.__projWriteEpoch = wep;
          }
          it.el.__projCarry = false;   // v0.79.4: in-view bake clears the carry
          keep.push(it.el);
        }
        // clear every previously-painted element that lost its anchor this
        // pass — it left the transformed scopes or was removed from the
        // DOM (v0.79.3: offscreen elements are CARRIED, never stripped —
        // see the carry note in the read phase). The CSS state owns the
        // dropped ones again (byte-identical to the no-gradient look).
        for (var p = 0; p < painted.length; p++) {
          var el2 = painted[p];
          if (!el2.isConnected || keep.indexOf(el2) !== -1) continue;
          // v0.94.3: the layer path drops its generated rules (the CSS
          // state owns the element again — byte-identical to the
          // no-gradient look); the legacy path strips inline styles.
          if (L2.drop(el2)) continue;
          el2.style.removeProperty('background-position');
          el2.style.removeProperty('background-size');
          el2.style.removeProperty('background-attachment');
          el2.__projPainted = false;
          el2.__projPos = null;
          el2.__projScOwner = undefined;   // re-discover on re-entry
          el2.__projAbsBot = undefined;
        }
        painted = keep;
        motionTick();   // the vars land current right after the bake
      }

      function schedule() {
        if (!rafId) rafId = requestAnimationFrame(run);
      }
      function run() {
        rafId = 0;
        var hadRoot = movingRoot > 0;
        if (dirty || movingLayout > 0) {
          paint();
          dirty = false;
          if (movingLayout > 0) movingLayout--;
        } else if (movingRoot > 0) {
          motionTick();
        }
        if (movingRoot > 0) movingRoot--;
        // settle: when a motion window closes, one final full paint
        // re-validates every anchor at rest (cheap insurance — most
        // bakes are no-ops and write nothing).
        // v0.78.3: NOT during a live gesture — a drag's smoothing loop
        // pauses (catches the finger) between pointer moves, and every
        // such micro-pause fired a full settle paint (the mid-drag paint
        // storm). One deferred retry lands the settle after the gesture
        // truly ends.
        if (hadRoot && movingRoot === 0 && !dirty && movingLayout === 0) {
          if (window.__doomalayGestureAt &&
              performance.now() - window.__doomalayGestureAt < 200) {
            if (!gestRetry) gestRetry = setTimeout(gestRetryFn, 240);
          } else {
            paint();
          }
        }
        if (dirty || movingRoot > 0 || movingLayout > 0) schedule();
      }
      var gestRetry = 0;
      function gestRetryFn() {
        gestRetry = 0;
        if (window.__doomalayGestureAt &&
            performance.now() - window.__doomalayGestureAt < 200) {
          gestRetry = setTimeout(gestRetryFn, 240);   // still gesturing — wait
        } else {
          mark();   // the gesture truly ended — the ONE settle paint
        }
      }
      function mark() { dirty = true; schedule(); }
      function motion() { movingRoot = 3; schedule(); stats.motions++; }
      // movingLayout — the LAYOUT window: any transition on a property
      // that can move element boxes (grid-template-rows un-collapses,
      // height, width…) repaints per frame while it animates; cosmetic
      // transitions (opacity, color, box-shadow…) only mark once.
      var MOVER_RE = /^(transform|all|grid-template-rows|grid-template-columns|height|max-height|min-height|width|max-width|min-width|top|left|right|bottom|margin[^ ]*|padding[^ ]*|flex-basis|font-size|inset[^ ]*|translate)$/;

      // ── v0.79.1: THE VALUE-VAR FILTER ─────────────────────
      // A style-attribute diff on the THEME ROOTS (<html> via applyTheme/
      // applyScheme, #chat-root via paintChatFmtTwins) that touches ONLY
      // non-layout CUSTOM PROPERTIES is a theme/fmt VALUE write — colors
      // and background images cannot move a box, so the projection
      // anchors (geometry facts) stay valid and the SEL set (a stylesheet
      // fact) is unchanged. The old observer full-painted PER THEME DRAG
      // EVENT for this (the "barely usable 8fps" settings panel). The
      // layout-affecting custom props (the text sizes) still paint.
      var LAYOUT_CP = { '--chat-fs': 1, '--chat-scale': 1, '--ui-fs': 1, '--ui-small-fs': 1 };
      function parseStyleAttrFor(s, out) {
        var parts = String(s || '').split(';');
        for (var i = 0; i < parts.length; i++) {
          var c = parts[i].indexOf(':');
          if (c < 0) continue;
          var k = parts[i].slice(0, c).replace(/^\s+|\s+$/g, '');
          if (k) out[k] = parts[i].slice(c + 1).replace(/^\s+|\s+$/g, '');
        }
      }
      function styleDiffOnlyValueVars(oldS, newS) {
        if (oldS === newS) return true;
        var a = {}, b = {};
        parseStyleAttrFor(oldS, a);
        parseStyleAttrFor(newS, b);
        for (var k in a) {
          if (!(k in b) || a[k] !== b[k]) {
            if (!(k.charAt(0) === '-' && !LAYOUT_CP[k])) return false;
          }
        }
        for (var k2 in b) {
          if (!(k2 in a) || a[k2] !== b[k2]) {
            if (!(k2.charAt(0) === '-' && !LAYOUT_CP[k2])) return false;
          }
        }
        return true;
      }

      // ── the triggers ──
      if (typeof MutationObserver === 'function') {
        var mo = new MutationObserver(function (muts) {
          var full = true;
          // a new stylesheet re-derives the projection selector set
          for (var i = 0; i < muts.length; i++) {
            var mm = muts[i];
            if (mm.type !== 'childList') continue;
            for (var j = 0; j < mm.addedNodes.length; j++) {
              var nn = mm.addedNodes[j];
              if (nn.nodeType === 1 && (nn.tagName === 'STYLE' || nn.tagName === 'LINK') &&
                  nn.id !== 'doom-proj-vars' && nn.id !== 'doom-derived-gates') {
                SEL = null;
              }
            }
          }
          // v0.79.1: VALUE NOISE, filtered FIRST. Theme/fmt VALUE writes
          // on the theme roots (<html> via applyTheme/applyScheme,
          // #chat-root via paintChatFmtTwins) touch only non-layout
          // custom properties — colors and images cannot move a box and
          // never change the stylesheet-derived SEL — so they need
          // neither a paint nor a motion. The old observer full-painted
          // PER THEME-DRAG EVENT for these (the "barely usable 8fps"
          // settings panel), even with no transformed roots registered.
          var kept = [];
          for (var vi = 0; vi < muts.length; vi++) {
            var vm = muts[vi];
            if (vm.type === 'attributes' && vm.attributeName === 'style' &&
                vm.target && (vm.target === document.documentElement ||
                              vm.target.id === 'chat-root') &&
                styleDiffOnlyValueVars(vm.oldValue || '',
                  vm.target.getAttribute('style') || '')) {
              continue;   // a value-only custom-prop write — nothing moved
            }
            // v0.79.1: flagged COSMETIC chrome (the GradientUI editor's
            // own preview bar + row banner repaint per live tick) — a
            // decorative literal background, never a projected window;
            // the painter must stay deaf to it.
            if (vm.type === 'attributes' && vm.attributeName === 'style' &&
                vm.target && vm.target.__projCosmetic === true) {
              continue;
            }
            // v0.88: COSMETIC childList writes — the perf HUD chip's
            // textContent (2/s), the Performance page's value spans (1/s),
            // any __projCosmetic-flagged element whose children swap:
            // none of these move a box or touch a projected window, but
            // the old filter let them fall through to `full = true` → a
            // FULL projection paint per HUD tick (the colors-pill drag's
            // hidden second cascade).
            if (vm.type === 'childList' && vm.target &&
                vm.target.__projCosmetic === true) {
              continue;
            }
            kept.push(vm);
          }
          if (!kept.length) return;         // pure value noise — done
          muts = kept;
          // a root's OWN style write where only transform/translate
          // changed is the glide driver (writeY) — the motion path
          // covers it; anything else is a real change → full paint.
          // v0.78.3: during a panel GESTURE (drag/spring/rise), the
          // dependent inline-style cascade (the --panel-vis-h stretch
          // reflows #chat-input's autogrow, #chat-jump's bottom…) is
          // drag noise on UNTRACKED elements — motion-grade, with the
          // settle paint at gesture end re-validating every anchor.
          var gest = window.__doomalayGestureAt &&
            (performance.now() - window.__doomalayGestureAt < 200);
          if (muts.length && rootReg.length) {
            full = false;
            // v0.92.1: motionWorthy — the mutations that genuinely need the
            // motion window (the glide driver's tracked-root transform
            // writes, the gesture cascade). A batch whose every mutation
            // was SKIPPED (painter-owned epoch writes, v0.92.1's inert
            // orbit transforms) needs NOTHING: not mark, not motion — the
            // old `else motion()` kept a 90/s motion window alive from pure
            // orbit noise, and every window close fired the settle paint
            // (the self-sustaining 30 paints/s — RESEARCH-V092's rig).
            var motionWorthy = 0;
            for (var i = 0; i < muts.length; i++) {
              var m = muts[i];
              if (gest && m.type === 'attributes' && m.attributeName === 'style') {
                motionWorthy++;
                continue;   // gesture cascade — rides motion()
              }
              if (m.type === 'attributes' && m.attributeName === 'style' &&
                  m.target && m.target.__projWriteEpoch === writeEpoch) {
                continue;   // the painter's OWN write — never self-trigger
              }
              // v0.92.1 ORBIT NOISE: a style write on an element that is
              // NEITHER a tracked projection root NOR a painted window,
              // whose old→new diff is PURE transform/translate, cannot
              // move any box but its own (transform never affects
              // sibling/descendant layout) and holds no window to
              // re-anchor — provably inert for the painter. THE measured
              // root of the sustained gradient lag: the tab groups' orbit
              // drift writes each member's style.transform EVERY frame;
              // with the disc + name now LOCAL (index.html v0.92.1 — the
              // icon carries no painted window anymore), these writes
              // used to classify as `full` (an untracked style change)
              // → a FULL projection paint per frame, ~30/s forever while
              // a group exists (RESEARCH-V092's orbit rig: 25-31
              // paints/s + 92 motions/s vs 0.4/0.1 at rest). Skip them
              // entirely — no mark, no motion. A write that also touches
              // anything else (z-index, size, custom props…) falls
              // through to the conservative full paint as before.
              if (m.type === 'attributes' && m.attributeName === 'style' &&
                  m.target && m.target.__projTracked !== true &&
                  m.target.__projPainted !== true) {
                var on92 = m.target.getAttribute('style') || '';
                var oo92 = m.oldValue || '';
                var inert92 = function (s) {
                  return s.replace(/(^|;)\s*(transform|translate)\s*:[^;]*/g, ';');
                };
                if (inert92(on92) === inert92(oo92)) {
                  continue;   // pure transform on an inert element — skip
                }
              }
              if (m.type !== 'attributes' || m.attributeName !== 'style' ||
                  !m.target || m.target.__projTracked !== true) { full = true; break; }
              motionWorthy++;
              var now = m.target.getAttribute('style') || '';
              var old = m.oldValue || '';
              var strip = function (s) {
                // v0.78.3: --panel-vis-h joins the motion set — the drag/
                // spring/duck stretch writes it per frame on the panel
                // root; it rides motion() (writeY already calls it) and the
                // settle paint at gesture end re-validates.
                return s.replace(/(^|;)\s*(transform|translate|--panel-vis-h)\s*:[^;]*/g, ';');
              };
              if (strip(now) !== strip(old)) { full = true; break; }
            }
            if (!full && !motionWorthy) return;   // pure inert noise — nothing
          }
          if (full) mark(); else motion();
        });
        mo.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['style', 'class'], attributeOldValue: true
        });
        // keep the tracked flag on registry elements current
        var flagSync = function () {
          for (var i = 0; i < rootReg.length; i++) rootReg[i].el.__projTracked = true;
        };
        var origSync = syncRoots;
        syncRoots = function () { origSync(); flagSync(); };
      }
      var trackedScrollers = [];
      document.addEventListener('scroll', function (e) {
        // v0.78.3c: THE SCROLL PATH — an INCREMENTAL re-bake: elements
        // painted inside the scrolling element get their baked Y constant
        // shifted by the scroll delta (pure arithmetic + style writes, no
        // layout reads, no SEL walk, no getComputedStyle). Elements NOT
        // inside the scroller never move and never adjust. A debounced
        // settle paint anchors newcomers once scrolling stops.
        var t = e.target;
        if (t && t.nodeType === 1) {
          var known = false;
          for (var ti = 0; ti < trackedScrollers.length; ti++) {
            if (trackedScrollers[ti] === t) { known = true; break; }
          }
          if (!known && trackedScrollers.length < 12) trackedScrollers.push(t);
        }
        if (!t || t.nodeType !== 1) { mark(); scrollSettle(); return; }
        var nowS = t.scrollTop || 0;
        var lastS = t.__projSy || 0;
        t.__projSy = nowS;
        if (nowS !== lastS) scrollRebake(t, nowS - lastS);
        scrollSettle();
      }, true);
      function scrollRebake(sc, dS) {
        if (!painted.length || !dS) return;
        var wep = ++writeEpoch;
        // v0.79.3: NEWCOMERS — carried elements that were never baked
        // on-screen (they entered the DOM — or first met the painter —
        // while offscreen). Scrolling them into view raw was the
        // full-gradient-in-a-pill flash; they get a targeted on-the-spot
        // bake here (bounded: a handful of reads per fling frame, never
        // the full SEL walk).
        var fresh = [];
        for (var i = 0; i < painted.length; i++) {
          var el = painted[i];
          if (!el.isConnected || !sc.contains(el)) continue;
          // v0.79.4: a CARRIED element scrolling back into view bakes
          // FRESH — its constants may have silently drifted while it was
          // offscreen (content-visibility un-rendering; see the carry
          // note in paint's read phase), and the arithmetic-from-rot was
          // the misplaced-gradient flash on re-entry.
          if (el.__projBy === undefined || el.__projCarry === true) { fresh.push(el); continue; }
          // v0.78.3c: sticky/fixed descendants DON'T move with the scroll
          // content — the sticky chat input inside #chat-scroll was being
          // adjusted by the clamp delta and drifted (the A5b regression).
          // (getComputedStyle(el).position is style-only — no layout.)
          var pos_ = el.__projPosType;
          if (pos_ === undefined) {
            try { pos_ = getComputedStyle(el).position; } catch (pe) { pos_ = 'static'; }
            el.__projPosType = pos_;
          }
          if (pos_ === 'sticky' || pos_ === 'fixed') continue;
          el.__projBy += dS;
          // v0.94.3: the layer path patches its RULE — no inline style
          if (el.__projL2 && L2.rebake(el)) continue;
          var pos = fmtCalc('--proj-tx', el.__projBx) + ' ' + fmtCalcY(el.__projBy);
          if (el.__projPos !== pos) {
            // v0.94.4b: shed any stale INLINE suppression (a dropped layer
            // leaves none — drop clears it — but belt-and-braces for any
            // element that fell back without a drop)
            el.style.removeProperty('background-image');
            el.style.removeProperty('background-color');
            el.style.backgroundPosition = pos;
            el.__projPos = pos;
            el.__projWriteEpoch = wep;   // painter-owned — the observer skips it
          }
        }
        if (fresh.length) {
          stats.rebakes += fresh.length;
          bakeNewcomers(fresh, wep);
        }
      }
      // v0.79.3: the targeted newcomer bake — the same math paint() uses,
      // for the elements that just scrolled into view unbaked. The root
      // matrices are read once per root per call; gBCR is post-scroll
      // so the bake lands true for THIS scroll position. IN-VIEW
      // newcomers bake unconditionally (a big jump can surface a hundred
      // at once — the reads are layout-clean after a scroll, one batch);
      // OFFSCREEN newcomers are skipped (their event comes later).
      function bakeNewcomers(list, wep) {
        var vw = window.innerWidth, vh = window.innerHeight;
        var size = vw + 'px ' + vh + 'px';
        var matrixCache = {};
        var n = 0;
        for (var i = 0; i < list.length && n < 400; i++) {
          var el = list[i];
          if (!el.isConnected) continue;
          el.__projCarry = false;   // v0.79.4: baking fresh — the carry is over
          var r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || r.bottom < -60 || r.top > vh + 60) continue;
          var R = el.__projR;
          if (!R || !rootReg || rootReg.indexOf(R) === -1) continue;   // root gone — settle paint handles it
          var M = matrixCache[R.key];
          if (!M) { M = matrixCache[R.key] = readMatrix(R.el); }
          var bx = M.translateOnly ? (-r.left + M.tx) : -r.left;
          var by = M.translateOnly ? (-r.top + M.ty) : -r.top;
          el.__projBx = bx; el.__projBy = by;
          // v0.94.3: newcomer bakes ride the layer path when eligible
          var snapN = (el.__projL2ok === 0) ? null :
            ((el.__projL2 && el.__projL2Epoch === memoEpoch) ? null : L2.snapshot(el));
          // v0.94.3: an ALREADY-LAYERED element (fresh epoch) rides its
          // layer — patch the rule position from the fresh constants and
          // NEVER the legacy inline path (the fallthrough was leaving the
          // layer's position stale by the scroll delta — the visual bug).
          if (el.__projL2 && el.__projL2Epoch === memoEpoch) {
            L2.rebake(el);
            el.__projR = R;
            n++;
            continue;
          }
          if (snapN && L2.ok(el, snapN) && L2.bake(el, snapN, bx, by, size, false, memoEpoch, el.__projL2ok)) {
            // clear any legacy inline bake the element carried (carried
            // elements bake legacy until they scroll into view)
            if (el.__projPos !== undefined) {
              el.style.removeProperty('background-position');
              el.style.removeProperty('background-size');
              el.style.removeProperty('background-attachment');
              el.__projPos = undefined;
              el.__projWriteEpoch = wep;
            }
            el.__projR = R;
            n++;
            continue;
          }
          var pos = fmtCalc('--proj-tx', bx) + ' ' + fmtCalcY(by);
          // v0.94.4b: the legacy fallthrough — shed any stale INLINE
          // suppression first (it would blank the element's own gradient).
          el.style.removeProperty('background-image');
          el.style.removeProperty('background-color');
          if (el.__projPos !== pos) {
            el.style.backgroundPosition = pos;
            el.__projPos = pos;
            el.__projWriteEpoch = wep;
          }
          if (el.style.backgroundSize !== size) el.style.backgroundSize = size;
          if (el.style.backgroundAttachment !== 'scroll') el.style.backgroundAttachment = 'scroll';
          el.__projWriteEpoch = wep;
          el.__projR = R;
          n++;
        }
        stats.baked += n;
      }
      var settleTimer = 0;
      function scrollSettle() {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(function () { settleTimer = 0; mark(); }, 150);
      }
      // v0.94.4 (D1): THE RESIZE WAVE — a resize burst (Android inset
      // animations fire one per frame) used to null SEL (a full stylesheet
      // re-walk — every rule of every sheet — on EVERY event) + paint
      // unbatched. SEL depends on stylesheets only, never on viewport
      // size: it stays. The re-bake rides the same 150ms debounce the
      // scroll settle uses — one paint at the end of the burst (the bake
      // constants re-read vw/vh fresh per paint anyway). The layer
      // resizeAll is equally bursty (a CSSOM write per rule) — same
      // debounce.
      var resizeTimer = 0;
      window.addEventListener('resize', function () {
        if (resizeTimer) return;
        resizeTimer = setTimeout(function () {
          resizeTimer = 0;
          L2.resizeAll(window.innerWidth + 'px ' + window.innerHeight + 'px');
          mark();
        }, 150);
      });
      // CSS transitions don't fire attribute mutations (computed values
      // interpolate) — the transform rides need explicit tracking.
      // v0.74: LAYOUT properties (the un-collapse grid animations) hold
      // the per-frame repaint window too; ROOT transforms ride motion().
      ['transitionrun', 'transitionstart'].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
          var pn = (e.propertyName || '');
          var onRoot = e.target && e.target.__projTracked === true;
          if (MOVER_RE.test(pn)) {
            if (onRoot && (pn === 'transform' || pn === 'all' || pn === 'translate')) {
              motion();
            } else {
              movingLayout = 5; mark();   // a layout animation — full repaints per frame
            }
          }
          // v0.78.3: COSMETIC transitions (background, color, opacity,
          // border-radius, box-shadow…) no longer paint MID-FLIGHT —
          // they can't move a box, so the anchors can't go stale;
          // transitionend still settles anything discrete (a gradient
          // swap flips at midpoint and lands there).
        }, true);
      });
      ['transitionend', 'transitioncancel'].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
          // v0.78.3: background-position is the PAINTER'S OWN property —
          // elements with a decorative background-position transition
          // (#chat-jump's gradient slide) re-bake per panel-drag frame, and
          // every restart's transitionend used to mark() a full paint (29
          // paints per drag on the rig — the "8fps" panel). Painter-owned
          // noise never re-anchors.
          if (/^background-position/.test(e.propertyName || '')) return;
          // v0.79.1: COSMETIC transition ends never re-anchor. Anchors are
          // GEOMETRY facts — a transition that ends on background-color,
          // border colors, color, box-shadow or opacity cannot have moved
          // a box, so settling it bought a full paint for nothing. The
          // live case: the GradientUI dir pills are accent-tinted, so a
          // theme-color drag restarts their background/border transitions
          // per frame — every end was a mark() (30 paints per drag, the
          // settings panel's residual jank). Only GEOMETRY movers (the
          // MOVER_RE set: height, grid-rows, transform…) still settle.
          if (!MOVER_RE.test(e.propertyName || '')) return;
          // during a live gesture the whole transition set is drag
          // cascade — the post-gesture retry settles everything once.
          if (window.__doomalayGestureAt &&
              performance.now() - window.__doomalayGestureAt < 200) return;
          mark();
        }, true);
      });

      return {
        poke: mark,             // app.js's physics tick calls this per frame
        motion: motion,         // v0.74: the CHEAP per-frame path (writeY rides it)
        repaint: function () { SEL = null; memoEpoch++; paint(); },
        paint: paint,
        stats: stats            // v0.78.3: {paints, motions} — the perf rig
      };
    })();
    window.DoomProjection = PROJ || { poke: function(){}, motion: function(){}, repaint: function(){}, paint: function(){} };

    // ══ v0.70 THE DERIVED GATES ════════════════════════════════════
    // The systematic half of the accuracy wave (user spec: "Just have
    // each variable cast its gradient/color/image and have only the
    // objects render the color/gradient/image background they are
    // assigned to"). The v0.67 gates hand-LISTED a few dozen classes;
    // every accent-tinted class the list missed stayed a flat quiet
    // pill no matter what the user painted ("most pills in the app
    // don't follow their assigned gradient"). Instead of maintaining a
    // list, the gates are now DERIVED from the stylesheets themselves
    // (the same walk PROJ.collect does): every STATIC rule that paints
    // an accent — a background/background-color of var(--accent-N) or
    // rgba(var(--accent-N-rgb),…), a border ring of the same with no
    // background of its own (the OUTLINE pills), or a lone
    // color: var(--accent-N) label (the ACCENT GLYPHS) — becomes a
    // window/glyph on that accent's viewport projection, automatically,
    // including styles the modules inject at runtime. Solid accents
    // never trip a gate (the [data-aN-grad] attributes stay unset), so
    // every base theme renders byte-identical to before.
    //
    // Skips (deliberate):
    // · any selector with a pseudo-class/:not() — dynamic states and
    //   pseudo-elements can't be matched statically (hover tints stay
    //   tints; ::before glyphs stay as-is);
    // · the gate/catcher rules themselves (selectors starting with
    //   [data-a, [data-text-grad] or containing [style*=);
    // · indirection vars (--wsp-*, --hub-tone-*) — those families carry
    //   their own explicitly-scoped rules in index.html;
    // · glyphs on filled elements — background-clip:text clips EVERY
    //   layer, so a glyph recipe on an element with its own fill would
    //   eat the fill (the v0.67 exclusion, kept);
    // · outline windows on elements with a NON-accent background (a
    //   surface card with an accent ring keeps its surface fill).
    var GATES = (function () {
      if (!HAS_DOM) return null;
      var styleEl = null, lastCSS = '', observer = null;
      // v0.83.4 THE SCAN MEMO — the two stylesheet walks below build
      // tables that depend ONLY on the stylesheets' CONTENTS, never on
      // the theme's values (the gate selectors are identical for every
      // base theme; only the vars' VALUES differ, and those cascade at
      // paint time, not in the stylesheet). The walk was re-run per
      // theme flip — ~40ms of rule scanning at the app's sheet count,
      // a third of the "themes tab is barely functional" cost — while
      // the MutationObserver below already fires on exactly the event
      // that changes the facts (an injected <style>/<link>). Cleared
      // there; rebuilt here on the next refresh.
      var scanMemo = null;
      var ACC = [
        { gate: 'data-a1-grad', varName: '--accent',        rgb: '--accent-rgb',        img: '--accent-gradient',        ink: '--on-accent' },
        { gate: 'data-a2-grad', varName: '--accent-2',      rgb: '--accent-2-rgb',      img: '--accent-2-gradient',      ink: '--on-accent-2' },
        { gate: 'data-a3-grad', varName: '--accent-3',      rgb: '--accent-3-rgb',      img: '--accent-3-gradient',      ink: '--on-accent-3' },
        { gate: 'data-a4-grad', varName: '--accent-4',      rgb: '--accent-4-rgb',      img: '--accent-4-gradient',      ink: '--on-accent-4' }
      ];
      var MAX_SEL = 400;   // pathological-sheet guard

      // v0.77.8: THE SURFACE + BORDER FAMILIES — the derived-gate model
      // extends past the accents. Every variable gets the same contract:
      // ONE viewport-projected field; every consumer is a window on it.
      //   · SURF — a stylesheet rule with a plain opaque fill of
      //     var(--surface-1 | --surface-2 | --bg-app) becomes a window
      //     on that variable's field when its twin is live (the
      //     "surface raised still doesn't work" coverage gaps — the
      //     hand-listed Layer-3 rules missed fills the list never knew).
      //   · BORDER — a rule with a var(--border) border becomes a
      //     projected RING **only when it carries a FILL** (the PLATE
      //     stack: window + plate + ring — radius-safe, content-safe,
      //     painter-anchored). v0.79.2: the OUTLINE mask ring is RETIRED
      //     — a mask hides everything inside the padding-box (children
      //     AND text), so the v0.77.8 auto-ring rendered every
      //     text-bearing outline pill as its border alone (the
      //     chat-scheme chips' dots+labels went invisible; #chat-send's
      //     glyph vanished once a border gradient went live; the
      //     .color-row-banner's inline preview was clobbered). Outline
      //     rules keep their solid border-color — the border variable's
      //     solid twin, still theme-following — and their content
      //     always paints.
      var SURF = [
        { gate: 'data-s1-grad', varName: '--surface-1', img: '--surface-1-gradient', inkGate: 'data-bright-s1', ink: '--on-surface-1' },
        { gate: 'data-s2-grad', varName: '--surface-2', img: '--surface-2-gradient', inkGate: 'data-bright-s2', ink: '--on-surface-2' },
        { gate: 'data-bg-grad', varName: '--bg-app',    img: '--bg-app-gradient',    inkGate: 'data-bright-bg', ink: '--on-bg-app' }
      ];
      var BORDER_GATE = 'data-border-grad';

      // splitSelector — a grouped selector ('.a, .b') into its parts, so
      // EVERY part carries its own gate prefix (the v0.70 lesson, now
      // applied at the source: CSSOM keeps groups as ONE selectorText).
      function splitSelector(sel) {
        return String(sel).split(',').map(function (s) { return s.trim(); })
          .filter(function (s) { return !!s; });
      }

      function ruleAccent(spec, r) {
        // → 'win' | 'glyph' | null for ONE accent config
        var col = (r.style.getPropertyValue('color') || '').trim();
        var bg = (r.style.getPropertyValue('background-color') || '') + ' ' +
                 (r.style.getPropertyValue('background') || '') + ' ' +
                 (r.style.getPropertyValue('background-image') || '');
        var bd = (r.style.getPropertyValue('border-color') || '') + ' ' +
                 (r.style.getPropertyValue('border') || '');
        var bgAcc = bg.indexOf('var(' + spec.varName + ')') !== -1 ||
                    bg.indexOf('rgba(var(' + spec.rgb + ')') !== -1 ||
                    bg.indexOf('rgba(var(' + spec.rgb + ',') !== -1;
        var bdAcc = bd.indexOf('rgba(var(' + spec.rgb + ')') !== -1 ||
                    bd.indexOf('rgba(var(' + spec.rgb + ',') !== -1;
        var colAcc = new RegExp('^var\\(' + spec.varName.replace(/-/g, '\\-') +
          '(\\s*,[^)]*)?\\)$').test(col);
        var hasFill = !!r.style.getPropertyValue('background-color') ||
                      !!r.style.getPropertyValue('background') ||
                      !!r.style.getPropertyValue('background-image');
        if (bgAcc) return 'win';                       // a tint/fill of this accent
        if (colAcc && !hasFill) return 'glyph';        // a lone accent label
        if (bdAcc && !hasFill) return 'win';           // an outline pill (ring only)
        return null;
      }

      function derive() {
        var wins, glyphs, surfWins, borderPlate, protectedSels;
        if (scanMemo) {
          wins = scanMemo.wins; glyphs = scanMemo.glyphs;
          surfWins = scanMemo.surfWins; borderPlate = scanMemo.borderPlate;
          protectedSels = scanMemo.protectedSels;
        } else {
        wins = {}; glyphs = {};
        for (var i = 0; i < ACC.length; i++) { wins[ACC[i].gate] = []; glyphs[ACC[i].gate] = []; }
        var surfWins = {};   // SURF[i].gate → [selectors]
        var borderPlate = { };  // plate rings keyed by fill var
        for (var si = 0; si < SURF.length; si++) {
          surfWins[SURF[si].gate] = [];
          borderPlate[SURF[si].varName] = [];
        }
        var protectedSels = {};   // selectors already carrying a plate/window/ring stack
        try {
          // ── pass 1: the PROTECTED set (rules that already manage their
          // own projection — plates, windows, border-image, the catchers)
          for (var s = 0; s < document.styleSheets.length; s++) {
            var rulesP;
            try { rulesP = document.styleSheets[s].cssRules; } catch (e) { continue; }
            (function walkP(rs) {
              for (var i = 0; i < rs.length; i++) {
                var r = rs[i];
                if (r.cssRules && r.cssRules.length) walkP(r.cssRules);
                if (!r.style || !r.selectorText) continue;
                var st = r.style;
                var img = st.getPropertyValue('background-image') || '';
                var bim = st.getPropertyValue('border-image') ||
                          st.getPropertyValue('border-image-source') || '';
                if (/var\(--[a-z0-9-]*gradient/.test(img) ||
                    img.indexOf('linear-gradient(var(') !== -1 || bim.indexOf('var(') !== -1) {
                  splitSelector(r.selectorText).forEach(function (part) { protectedSels[part] = true; });
                }
              }
            })(rulesP);
          }
        } catch (e) { /* a locked sheet is simply skipped */ }

        try {
          for (var s = 0; s < document.styleSheets.length; s++) {
            var rules;
            try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
            (function walk(rs) {
              for (var i = 0; i < rs.length; i++) {
                var r = rs[i];
                if (r.cssRules && r.cssRules.length) walk(r.cssRules);   // @media & friends
                if (!r.style || !r.selectorText) continue;
                var sel = r.selectorText;
                if (sel.indexOf(':') !== -1) continue;                   // pseudo/:not()/hover — skip
                if (sel.indexOf('[data-a') !== -1 || sel.indexOf('[data-s') !== -1 ||
                    sel.indexOf('[data-border-grad') !== -1 ||
                    sel.indexOf('[data-text-grad]') !== -1 ||
                    sel.indexOf('[style*=') !== -1) continue;            // the gate/catcher rules
                // v0.70 final: the EXPLICIT families — index.html owns
                // these with tone/prov-SCOPED gate rules (a derived BASE
                // rule would over-fire across the scopes: the default-
                // tone .hub-libpill base would window template/skill/
                // script pills on accent-2; a .wsp rule's accent
                // spelling is a provider-sync FALLBACK, not an
                // assignment). Skip the whole selector family.
                if (sel.indexOf('.hub-libpill') !== -1 || sel.indexOf('.wsp') !== -1 ||
                    sel.indexOf('.wsx-') !== -1 || sel.indexOf('hub-tone') !== -1 ||
                    sel.indexOf('--wsp') !== -1) continue;
                // v0.79.2: THE EDITOR-PREVIEW EXCEPTION — the GradientUI
                // preview surfaces (the collapsed-row banner + the live
                // preview bar) paint the USER'S OWN inline gradient;
                // deriving any gate treatment for them would clobber the
                // very thing they exist to show (the v0.77.8 walker ring
                // painted every banner with the border field + a mask —
                // "banners … always black", the user's report). The
                // index.html plate comment already documented the
                // exception; the walker now honors it too.
                if (sel.indexOf('.color-row-banner') !== -1 ||
                    sel.indexOf('.gr-preview-bar') !== -1) continue;
                // …and any rule whose VALUES ride the --wsp indirection
                // vars (the provider theme sync) — same reason.
                var st = r.style;
                var raw = (st.getPropertyValue('color') || '') + ' ' +
                  (st.getPropertyValue('background-color') || '') + ' ' +
                  (st.getPropertyValue('background') || '') + ' ' +
                  (st.getPropertyValue('background-image') || '') + ' ' +
                  (st.getPropertyValue('border-color') || '') + ' ' +
                  (st.getPropertyValue('border') || '');
                if (raw.indexOf('var(--wsp') !== -1) continue;
                for (var a = 0; a < ACC.length; a++) {
                  var kind = ruleAccent(ACC[a], r);
                  if (kind === 'win' && wins[ACC[a].gate].length < MAX_SEL) {
                    splitSelector(sel).forEach(function (part) { wins[ACC[a].gate].push(part); });
                  } else if (kind === 'glyph' && glyphs[ACC[a].gate].length < MAX_SEL) {
                    splitSelector(sel).forEach(function (part) { glyphs[ACC[a].gate].push(part); });
                  }
                }
                // v0.77.8: the SURFACE + BORDER derivation
                var stX = r.style;
                var bgShorthand = stX.getPropertyValue('background') || '';
                var bgCol = stX.getPropertyValue('background-color') || '';
                var bgImgX = stX.getPropertyValue('background-image') || '';
                var bdX = (stX.getPropertyValue('border-color') || '') + ' ' +
                          (stX.getPropertyValue('border') || '');
                var hasBorderVar = bdX.indexOf('var(--border)') !== -1;
                var parts = splitSelector(sel).filter(function (p) { return !protectedSels[p]; });
                if (parts.length) {
                  var fillVar = null;
                  // v0.91.2: values carrying color-mix( are SELF-DERIVING
                  // (the browser derives them natively from the vars —
                  // color-mix(in oklch, var(--surface-2), …)). They are
                  // not plain fills and must never become projected
                  // windows — the whole point of the native Layer-3
                  // chrome is leaving the projection fan-out.
                  var selfDeriving = (bgCol + ' ' + bgShorthand).indexOf('color-mix(') !== -1;
                  for (var sf = 0; sf < SURF.length && !selfDeriving; sf++) {
                    var vn = SURF[sf].varName;
                    var isFill = (bgCol === 'var(' + vn + ')') ||
                      (bgShorthand === 'var(' + vn + ')') ||
                      (/^var\(--surface-1\)\s*$/.test(bgShorthand) && vn === '--surface-1');
                    // the exact opaque-fill forms (rgba tints are NOT windows)
                    if (!isFill && bgShorthand.indexOf('var(' + vn + ')') !== -1 &&
                        bgShorthand.indexOf('rgba(') === -1 && !bgImgX) {
                      isFill = true;   // e.g. 'var(--surface-2) no-repeat' — still a plain fill
                    }
                    if (isFill) { fillVar = vn; break; }
                  }
                  if (fillVar && !bgImgX) {
                    for (var sf2 = 0; sf2 < SURF.length; sf2++) {
                      if (SURF[sf2].varName === fillVar &&
                          surfWins[SURF[sf2].gate].length < MAX_SEL) {
                        parts.forEach(function (p) { surfWins[SURF[sf2].gate].push(p); });
                        break;
                      }
                    }
                  }
                  if (hasBorderVar) {
                    var bgEmpty = !bgCol && !bgShorthand && !bgImgX;
                    // 'transparent'/'none' fills are outlines too (the
                    // #chat-send pattern: background:transparent)
                    var bgVoid = bgEmpty ||
                      (/^(transparent|none)\s*$/i.test(bgCol) && !bgShorthand && !bgImgX) ||
                      (/^(transparent|none)\s*$/i.test(bgShorthand) && !bgCol && !bgImgX);
                    if (fillVar) {
                      if (borderPlate[fillVar].length < MAX_SEL) {
                        parts.forEach(function (p) { borderPlate[fillVar].push(p); });
                      }
                    }
                    // v0.79.2: outline (bgVoid) rules derive NOTHING — the
                    // mask ring is retired (it hid children AND text
                    // inside the padding-box: the chat-scheme chips, the
                    // send-mode glyph, every text-bearing outline pill).
                    // They keep their solid border-color — the border
                    // variable's solid twin, still theme-following.
                    void bgVoid;
                  }
                }
              }
            })(rules);
          }
        } catch (e) { /* a locked sheet is simply skipped */ }
        scanMemo = { wins: wins, glyphs: glyphs, surfWins: surfWins,
          borderPlate: borderPlate, protectedSels: protectedSels };
        }

        var css = '';
        for (var a = 0; a < ACC.length; a++) {
          var A = ACC[a];
          // v0.70 final: EVERY selector carries its own gate prefix —
          // '[gate] ' + join(',') would leave selectors 2..N UNGATED
          // (their color:var(--on-accent-N) would fire on SOLID themes,
          // the "stained white" regression reborn).
          var gateSel = function (list) {
            return list.map(function (s) { return '[' + A.gate + '] ' + s; }).join(',');
          };
          if (wins[A.gate].length) {
            css += gateSel(wins[A.gate]) + '{' +
              'background-image:var(' + A.img + ',none)!important;' +
              'background-attachment:fixed!important;' +
              'color:var(' + A.ink + ')!important;}';
          }
          if (glyphs[A.gate].length) {
            css += gateSel(glyphs[A.gate]) + '{' +
              'background-image:var(' + A.img + ',none)!important;' +
              'background-attachment:fixed!important;' +
              '-webkit-background-clip:text!important;background-clip:text!important;' +
              'color:transparent!important;}';
          }
        }
        // ── v0.77.8: the SURFACE windows + their bright-ink flips ──────
        for (var sw = 0; sw < SURF.length; sw++) {
          var SP = SURF[sw];
          if (surfWins[SP.gate].length) {
            var surfSel = surfWins[SP.gate].map(function (s) {
              return '[' + SP.gate + '] ' + s;
            }).join(',');
            css += surfSel + '{' +
              'background-image:var(' + SP.img + ',none)!important;' +
              'background-attachment:fixed!important;}';
            // the readable-ink flip when the surface paints bright
            var inkSel = surfWins[SP.gate].map(function (s) {
              return '[' + SP.inkGate + '] ' + s;
            }).join(',');
            css += inkSel + '{color:var(' + SP.ink + ',var(--text-1));text-shadow:none;}';
          }
        }
        // ── v0.77.8→v0.79.2: the BORDER rings ────────────────────────
        // (a) the OUTLINE mask ring is RETIRED (it hid children AND
        //     text inside the padding-box — see the derivation note);
        //     outline rules keep their solid border-color.
        // (b) the PLATE rings — a filled bordered rule gets the v0.72
        //     stack DERIVED for it: its own fill's window + the opaque
        //     plate + the border ring (clips + fixed attachment). The
        //     fill variable IS the plate variable — derivable by
        //     definition.
        for (var pp = 0; pp < SURF.length; pp++) {
          var PV = SURF[pp];
          if (borderPlate[PV.varName].length) {
            var plateSel = borderPlate[PV.varName].map(function (s) {
              return '[' + BORDER_GATE + '] ' + s;
            }).join(',');
            css += plateSel + '{' +
              'background-image:var(' + PV.img + ',none),' +
                'linear-gradient(var(' + PV.varName + '),var(' + PV.varName + ')),' +
                'var(--border-gradient,none);' +
              'background-origin:padding-box,padding-box,border-box;' +
              'background-clip:padding-box,padding-box,border-box;' +
              'background-attachment:fixed,fixed,fixed;}';
          }
        }
        if (css !== lastCSS) {
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'doom-derived-gates';
            document.head.appendChild(styleEl);
          }
          styleEl.textContent = css;
          lastCSS = css;
          // the painter's selector cache must learn the newly-gated
          // elements (they carry *-gradient images now)
          if (window.DoomProjection) window.DoomProjection.repaint();
        }
      }

      // re-derive when modules inject styles at runtime (hub, workspace,
      // chatpanel inject <style> nodes on first open)
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.type !== 'childList') continue;
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (n.nodeType === 1 && (n.tagName === 'STYLE' || n.tagName === 'LINK') &&
                  n.id !== 'doom-derived-gates') { scanMemo = null; derive(); return; }
            }
          }
        });
        observer.observe(document.head, { childList: true, subtree: true });
      }

      // the first derivation (late in theme.js's boot — applyTheme's
      // initial call ran before DoomGates existed; every later apply
      // re-derives through the applyTheme hook)
      derive();

      return { refresh: derive };
    })();
    window.DoomGates = GATES || { refresh: function(){} };
  }
  // the node self-test path (scripts/test_theme_twins.js): the PURE
  // spec/twin logic, no DOM anywhere near it. deriveTwins reads
  // window.GradientUI at CALL time, so the harness can mount uikit's
  // node exports on a stub window — or drop it to test the legacy
  // no-uikit fallback.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      themes: THEMES,
      legacyGrid: LEGACY_GRID,
      deriveTwins: deriveTwins,
      deriveBorderTwins: deriveBorderTwins,
      hexTriplet: hexTriplet,
      OKX: OKX,
      gridSpecFor: gridSpecFor,
      effectiveGridSpecs: effectiveGridSpecs,
      effectiveGrid: effectiveGrid,
      canvasBgSpec: canvasBgSpec,
      onColorFor: onColorFor,
      isHexColor: isHexColor
    };
  }
})();
