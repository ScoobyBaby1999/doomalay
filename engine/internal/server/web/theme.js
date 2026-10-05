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

  // ── v0.99.3 FIELDMATH — the culori-backed CSS-PARITY core ─────────
  // THE FIELD's DOM derivations live in CSS (color-mix(in oklch, …) in
  // the :root block) — zero JS at paint time. But JS still must KNOW a
  // few derived colors (the -rgb triplets rgba() composition needs, the
  // canvas family tint, the readable-ink gates, the status-bar hex), and
  // those must match what CSS computes: RECTANGULAR OKLAB (the browser's oklch mixes go
  // hue-powerless on near-achromatic pairs and paint warm-gray; oklab
  // is degeneracy-free and the calibration fits are identical — the
  // field pairs are hue-adjacent). OKX (oklab, rectangular) diverges from CSS on hue-distant
  // pairs — culori 4.0.2 (vendored, MIT) interpolates oklch exactly the
  // way color-mix does, so the JS and CSS sides of THE FIELD share one
  // math truth. The byte-pinned HSL recipe helpers (uikit
  // darken/lighten/mixHex — 140 test pins + every saved user gradient)
  // are a DIFFERENT, settled contract and deliberately stay as they are.
  // Resolution: the vendored IIFE defines `var culori` at script scope
  // (browser: window/globalThis; node tests: the harness indirect-evals
  // the file so globalThis.culori appears before theme.js is required).
  var CULORI = (typeof window !== 'undefined' && window.culori) ||
    (typeof globalThis !== 'undefined' && globalThis.culori) || null;
  var FieldMath = (function () {
    if (!CULORI) return null;   // boot survives without culori (OKX paths)
    var interp = CULORI.interpolate;   // ([a,b], 'oklch') → t => color
    var fmt = CULORI.formatHex;         // gamut-clamped '#rrggbb'
    var OKL = 'oklab';
    function normHex(v) {
      var m = /^#?([0-9a-fA-F]{6})$/.exec(String(v == null ? '' : v));
      return m ? ('#' + m[1].toLowerCase()) : null;
    }
    // cssMix(a, b, t) — the JS twin of color-mix(in oklab, a, calc((1-t)*100%) b):
    // rectangular OKLAB interpolation, sRGB gamut clamp — the same
    // computation the :root derivation block performs in CSS.
    // EDGES ARE EXACT PASSTHROUGH (t<=0 → a, t>=1 → b, normalized hex)
    // — the twins' identity contracts hold byte-identical.
    function cssMix(a, b, t) {
      var A = normHex(a), B = normHex(b);
      if (!A || !B) return null;
      if (t <= 0) return A;
      if (t >= 1) return B;
      try {
        var fn = interp([A, B], OKL);
        var out = fn(Math.max(0, Math.min(1, t)));
        return fmt(out) || null;
      } catch (e) { return null; }
    }
    // luminance(hex) — WCAG relative luminance (the on-accent/veil gates
    // are defined in WCAG contrast math; culori ships the same formula).
    function luminance(hex) {
      var A = normHex(hex);
      if (!A) return null;
      try { return CULORI.wcagLuminance(CULORI.parse(A)); }
      catch (e) { return null; }
    }
    return {
      cssMix: cssMix,
      luminance: luminance,
      available: true
    };
  })();

  // v0.56 deriveBorderTwins — RETIRED in v0.99.4: the border is a
  // DERIVED solid now (color-mix of surface+ink in the :root block),
  // so there is no border gradient twin to derive. The v0.56 lesson
  // (patterned recipes are multi-layer values — invalid as border-image)
  // is now enforced by construction: borders can't hold gradients at all.

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

  // ── v0.99.4 THE FIELD SLOT MODEL (the ratified 7-slot set) ────────
  // The 10-customizable-var era is over: surface-2/3, border(+strong),
  // raised-chrome/ring and bg-app are CSS color-mix DERIVATIONS of the
  // fields (index.html :root block — the border/surface fight ends by
  // construction), and accent-4 is theme-carried. What the user edits:
  // the 6 gradient-capable fields + the fmt stops (formatter.js, the
  // text-gradient track). THE DUAL TRACK: text = ink (solids/tints) +
  // fmt (all text gradients); objects = everything else. No var is
  // shared between the tracks.
  //
  // STORAGE: themeOverrides[themeId] keys are FIELD names now. Legacy
  // keys fold on read (foldThemeOverrides below — the lookio loader
  // pattern); the derived-era keys (--bg-app/--surface-2/--surface-3/
  // --border overrides) are DROPPED: those looks now follow the fields,
  // which is the entire point of the rework.
  var LEGACY_FIELD_MAP = {
    '--surface-1': '--field-surface',
    '--text-1': '--field-ink',
    '--bg-panel': '--field-canvas',
    '--accent': '--field-accent-1',
    '--accent-2': '--field-accent-2',
    '--accent-3': '--field-accent-3'
  };
  var FIELDS = [
    { field: '--field-surface', label: 'Surface', suffix: 'surface',
      hint: 'the plate — panels · cards · bubbles' },
    { field: '--field-ink', label: 'Ink', suffix: 'ink', solid: true,
      hint: 'every text color — solid only, tints derive' },
    { field: '--field-canvas', label: 'Canvas', suffix: 'canvas', canvas: true,
      hint: 'the world — the grid canvas · gradients, patterns + textures' },
    { field: '--field-accent-1', label: 'Accent 1', suffix: 'accent-1',
      hint: 'the primary accent · user bubbles' },
    { field: '--field-accent-2', label: 'Accent 2', suffix: 'accent-2',
      hint: 'the adjacent accent' },
    { field: '--field-accent-3', label: 'Accent 3', suffix: 'accent-3',
      hint: 'the third accent' }
  ];
  // The GRADIENT-TWIN ALIASES: gradient twins belong to FIELDS (only a
  // field can hold a gradient), but the consumer-facing var names (the
  // CSS rules + the JS-injected styles spelling var(--accent-gradient)
  // etc. — ~60 consumer sites) keep their historical spellings as pure
  // aliases of the field twins. applyTheme writes BOTH spellings.
  var FIELD_TWIN_ALIAS = {
    '--field-surface': '--surface-1-gradient',
    '--field-accent-1': '--accent-gradient',
    '--field-accent-2': '--accent-2-gradient',
    '--field-accent-3': '--accent-3-gradient'
  };
  var FIELD_RGB = {
    '--field-accent-1': '--accent-rgb',
    '--field-accent-2': '--accent-2-rgb',
    '--field-accent-3': '--accent-3-rgb'
  };
  // The JS-side mirror of the :root color-mix derivation block —
  // culori (polar oklch, shorter hue) so every triplet/tint JS computes
  // is what CSS actually paints. THE CALIBRATED TABLE (v099-calibrate).
  var DERIVED_MIXES = {
    '--surface-2':   ['--field-surface', '--field-ink', 0.05],
    '--surface-3':   ['--field-surface', '--field-ink', 0.11],
    '--border':      ['--field-surface', '--field-ink', 0.13],
    '--border-strong': ['--field-surface', '--field-ink', 0.24],
    '--raised-chrome': ['--field-surface', '--field-ink', 0.05],
    '--raised-ring': ['--field-surface', '--field-ink', 0.16],
    '--bg-app':      ['--field-canvas', '--field-surface', 0.08],
    '--text-2':      ['--field-ink', '--field-surface', 0.26],
    '--text-3':      ['--field-ink', '--field-surface', 0.47],
    '--text-3-dim':  ['--field-ink', '--field-surface', 0.61]
  };
  var TRIPLET_VARS = {
    '--surface-1-rgb': '--field-surface',
    '--surface-2-rgb': '--surface-2',
    '--surface-3-rgb': '--surface-3',
    '--bg-panel-rgb': '--field-canvas',
    '--bg-app-rgb': '--bg-app',
    '--text-2-rgb': '--text-2',
    '--text-3-rgb': '--text-3',
    '--border-rgb': '--border',
    '--accent-rgb': '--field-accent-1',
    '--accent-2-rgb': '--field-accent-2',
    '--accent-3-rgb': '--field-accent-3',
    '--accent-4-rgb': '--accent-4'
  };
  // foldThemeOverrides(raw) → the field-keyed override set. Legacy keys
  // map to their fields (--text-1 gradients degrade to the FIRST COLOR —
  // ink is solid-only now; the fmt field owns text gradients). Derived-era
  // keys (--surface-2/--border/--bg-app/--surface-3/--accent-4) are
  // dropped: those looks follow the fields.
  function foldThemeOverrides(raw) {
    var out = {};
    if (!raw) return out;
    Object.keys(raw).forEach(function (k) {
      if (k.indexOf('--field-') === 0) { out[k] = raw[k]; return; }
      var to = LEGACY_FIELD_MAP[k];
      if (!to) return;   // a dropped derived-era key — dead by design
      if (out[to] !== undefined) return;   // a field key already won
      var v = raw[k];
      if (to === '--field-ink' && v && typeof v === 'object' && Array.isArray(v.colors)) {
        v = v.colors[0];   // ink is SOLID-ONLY: the gradient era's first color
      }
      out[to] = v;
    });
    return out;
  }

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
  var BLOCK_READ_SET = ['--field-surface', '--field-ink', '--field-canvas',
    '--field-accent-1', '--field-accent-2', '--field-accent-3', '--accent-4'];
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
  // v0.99.4: `overrides` here is the FOLDED (field-keyed) set. DERIVED
  // legacy names (--border-strong etc.) resolve through FieldMath — the
  // same mix the :root block performs in CSS.
  function resolvedVar(id, overrides, name) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
      var twins = deriveTwins(overrides[name]);
      if (twins && twins.solid) return twins.solid;
    }
    if (blockCacheId === id && Object.prototype.hasOwnProperty.call(blockCache, name)) {
      return blockCache[name];
    }
    return '';
  }
  // resolvedDerived(id, overrides, name) — the CSS color-mix result of a
  // DERIVED_MIXES entry, in pure JS (culori parity). app.js's canvas
  // fingerprint + the family tint read the derived border-strong here.
  function resolvedDerived(id, overrides, name) {
    var spec = DERIVED_MIXES[name];
    if (!spec || !FieldMath) return '';
    var a = resolvedVar(id, overrides, spec[0]);
    var b = resolvedVar(id, overrides, spec[1]);
    return FieldMath.cssMix(a, b, spec[2]) || '';
  }

  function applyTheme(s) {
    var id = THEMES[s.theme] ? s.theme : 'midnight';
    var t = THEMES[id];
    var docEl = document.documentElement;
    // v0.99.4: the FOLD — legacy override keys become field keys here,
    // at the single read point (saved states + .doomtheme imports keep
    // working; derived-era keys die by design).
    var overrides = foldThemeOverrides(
      (s.themeOverrides && s.themeOverrides[id]) || null);
    var hasOverride = Object.keys(overrides).length > 0;

    // 1. the theme flip is the ONLY path that pays a style read — the
    // fresh [data-theme] block resolves in ONE batched read (cached
    // until the id changes). Same-theme applies (the drags) never read
    // the style system at all.
    setAttr(docEl, 'data-theme', id);
    if (blockCacheId !== id) {
      for (var rk in appliedVars) { docEl.style.removeProperty(rk); }
      appliedVars = {};
      buildBlockCache(docEl, id);
    }

    // 1b. THE FIELD TWINS — the user's customizations, field-keyed.
    // The write set is computed PURE first, then DIFFED against the
    // ledger (a drag on one field writes exactly that field's twin
    // pair; unchanged values write nothing at all).
    //   --field-X          the SOLID (the compat hex every legacy
    //                      color:/border: consumer keeps resolving)
    //   --field-X-gradient the image, or the literal 'none'
    //   + the FIELD_TWIN_ALIAS spelling (--surface-1-gradient /
    //      --accent-N-gradient — the ~60 consumer sites keep their
    //      historical var names as pure aliases of the field twins)
    //   --field-ink is SOLID-ONLY: no gradient twin, never a window —
    //      the fmt field owns text gradients (the dual track).
    var want = {};
    var gradByKey = {};   // field key → isGradient (the topo inputs)
    var i, k;
    for (i = 0; i < FIELDS.length; i++) {
      var F = FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(overrides, F.field)) continue;
      var twins = deriveTwins(overrides[F.field]);
      want[F.field] = twins.solid;
      if (F.solid) continue;             // ink: never a window
      want[F.field + '-gradient'] = twins.grad;
      gradByKey[F.field] = (twins.grad !== 'none');
      var alias = FIELD_TWIN_ALIAS[F.field];
      if (alias) want[alias] = twins.grad;
    }

    // 1c. THE RESOLVED FIELD SET — every derivation below reads THIS,
    // never the style system (v0.79.1's pure-JS contract, now feeding
    // the CSS color-mix mirrors).
    var resolved = {};
    for (i = 0; i < BLOCK_READ_SET.length; i++) {
      k = BLOCK_READ_SET[i];
      resolved[k] = resolvedVar(id, hasOverride ? overrides : null, k);
    }
    var fm = FieldMath;
    function mixOf(name) {
      var spec = DERIVED_MIXES[name];
      if (!spec) return '';
      var a = resolved[spec[0]], b = resolved[spec[1]];
      if (!a || !b) return '';
      if (fm) return fm.cssMix(a, b, spec[2]) || '';
      return OKX.mix(a, b, spec[2]) || '';   // the no-culori approximation
    }
    var derived = {};
    Object.keys(DERIVED_MIXES).forEach(function (dn) {
      var v = mixOf(dn);
      if (v) derived[dn] = v;
    });

    // 1d. THE TRIPLETS — rgba() composition needs 'r,g,b' strings, and
    // CSS can't split a color; JS derives every triplet from the SAME
    // mixes the :root block performs (culori parity). Base themes get
    // the derived values too, so the old static drift (midnight's
    // --text-3-rgb on every theme) is gone.
    Object.keys(TRIPLET_VARS).forEach(function (tv) {
      var src = TRIPLET_VARS[tv];
      var hex = (src.indexOf('--field-') === 0 || src === '--accent-4')
        ? resolved[src] : (derived[src] || '');
      var tri = hexTriplet(hex);
      if (tri) want[tv] = tri;
    });

    // 1e. THE READABLE-INK FAMILY — on-accent for every accent (user
    // bubbles + the accent windows' labels), veil-ink from the surface
    // luminance (the text-shadow ink).
    var ACCENT_FIELDS = ['--field-accent-1', '--field-accent-2',
      '--field-accent-3', '--accent-4'];
    var ON_VAR = { '--field-accent-1': '--on-accent',
      '--field-accent-2': '--on-accent-2',
      '--field-accent-3': '--on-accent-3', '--accent-4': '--on-accent-4' };
    for (i = 0; i < ACCENT_FIELDS.length; i++) {
      var av = ACCENT_FIELDS[i];
      if (/^#[0-9a-fA-F]{6}$/.test(resolved[av])) {
        want[ON_VAR[av]] = onColorFor(resolved[av]);
      }
    }
    var fS = resolved['--field-surface'];
    var inkM = /^#([0-9a-fA-F]{6})$/.exec(fS);
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

    // 1f. BRIGHT-INK GATES — the readable ink for the derived surfaces
    // (a bright surface twin flips the gate so labels stay readable).
    var BRIGHT_VARS = [
      { hex: fS, ink: '--on-surface-1', gate: 'data-bright-s1' },
      { hex: derived['--surface-2'] || fS, ink: '--on-surface-2', gate: 'data-bright-s2' },
      { hex: derived['--bg-app'] || fS, ink: '--on-bg-app', gate: 'data-bright-bg' },
      { hex: derived['--border'] || fS, ink: '--on-border', gate: 'data-bright-border' }
    ];
    var brightGates = {};
    BRIGHT_VARS.forEach(function (B) {
      var bm = /^#([0-9a-fA-F]{6})$/.exec(B.hex || '');
      if (bm) {
        var ink = onColorFor('#' + bm[1]);
        want[B.ink] = ink;
        // dark ink ⇒ the surface is bright ⇒ trip the gate
        brightGates[B.gate] = (ink !== '#ffffff') ? '1' : null;
      } else {
        brightGates[B.gate] = null;
      }
    });

    // 2. chat markdown scheme — the IDENTITY GATE (byte-stable through
    // a theme drag; the scheme + fmt overrides re-apply exactly once).
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

    // ── THE WRITE PHASE — pure diffs against the ledger ──
    for (var wk in want) setVar(docEl, wk, want[wk]);
    for (var dk in appliedVars) if (!(dk in want)) setVar(docEl, dk, null);

    // the root attributes — every flip value-guarded. v0.99.4: the
    // gradient gates are FIELD-owned: data-s1-grad (surface) +
    // data-a1/2/3-grad (accents). data-text-grad is GONE (the title
    // family joins the fmt track in v0.99.5); data-a4/s2/bg/border-grad
    // are GONE (those vars are derived solids — never gradients).
    setAttr(docEl, 'data-s1-grad', gradByKey['--field-surface'] ? '1' : null);
    var A_ATTR = { '--field-accent-1': 'data-a1-grad',
      '--field-accent-2': 'data-a2-grad', '--field-accent-3': 'data-a3-grad' };
    Object.keys(A_ATTR).forEach(function (av) {
      setAttr(docEl, A_ATTR[av], gradByKey[av] ? '1' : null);
    });
    setAttr(docEl, 'data-text-grad', null);
    setAttr(docEl, 'data-a4-grad', null);
    setAttr(docEl, 'data-s2-grad', null);
    setAttr(docEl, 'data-bg-grad', null);
    setAttr(docEl, 'data-border-grad', null);
    Object.keys(brightGates).forEach(function (g) {
      setAttr(docEl, g, brightGates[g]);
    });

    // 4. Android status bar tint — needs a REAL hex (no var() in meta).
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
    //    var() doesn't resolve). v0.99.4: the tint is the DERIVED
    //    border-strong — the same mix CSS paints (culori parity).
    if (window.DoomalayConfig && window.DoomalayConfig.families &&
        window.DoomalayConfig.families.default) {
      var tint = derived['--border-strong'] || resolvedDerived(id, overrides, '--border-strong') || '#4a4a5e';
      if (tint !== lastFamilyTint) {
        window.DoomalayConfig.families.default.color = tint;
        lastFamilyTint = tint;
      }
    }

    // THE TOPOLOGY FINGERPRINT gates the derived gates' re-mint
    // (a value-only change rewrites no selector; a real topology
    // change — a stop added to a solid, a gradient flattened —
    // re-derives exactly once). The painter is retired (v1.01.5):
    // value changes propagate through the CSS vars themselves.
    var topo = [];
    Object.keys(gradByKey).sort().forEach(function (gk) {
      topo.push(gk + ':' + (gradByKey[gk] ? 'g' : 's'));
    });
    topo.push('fmt:' + (docEl.getAttribute('data-fmt-grad') || ''));
    var topoKey = topo.join('|');
    if (topoKey !== lastTopology) {
      lastTopology = topoKey;
      if (window.DoomGates) window.DoomGates.refresh();
    }

    // v1.01.5: THE THEME EVENT — the canvas-side consumers (pixiworld
    // rasters, the arrow hex) re-mint on every apply, COALESCED — see
    // the LOCAL LIGHT block below for the history this fixes.
    scheduleThemeEvent();
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
    // v0.99.4: reads THE FIELD (--field-canvas, after the legacy fold —
    // a saved --bg-panel key still lands here through foldThemeOverrides).
    var overrides = foldThemeOverrides(
      (s.themeOverrides && s.themeOverrides[id]) || null);
    var raw = overrides ? overrides['--field-canvas'] : null;
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

  // v1.01.5: THE THEME EVENT — the one contract the projection painter's
  // retirement must not lose: applyTheme dispatches a COALESCED
  // 'doomalay:theme-applied' (120ms trailing — gradient drags commit at
  // ~11Hz, the event lands once per settle) so the canvas-side consumers
  // re-mint: pixiworld's icon rasters (themeStamp) + app.js's arrow hex.
  // History: these listeners existed since v0.88 but NOBODY EVER
  // DISPATCHED the events — the canvas icons rode stale colors until
  // an unrelated mutation re-rastered them ("the other 50% of the
  // panel follows after I change an unrelated color variable").
  // NOTE: IIFE-scope (NOT inside the HAS_WINDOW block — 'use strict'
  // block-scopes function declarations, and applyTheme calls this from
  // the boot path that runs BEFORE the HAS_WINDOW block below).
  var themeEventTimer = 0;
  function scheduleThemeEvent() {
    if (!HAS_WINDOW) return;
    if (themeEventTimer) return;
    themeEventTimer = setTimeout(function () {
      themeEventTimer = 0;
      try { window.dispatchEvent(new CustomEvent('doomalay:theme-applied')); }
      catch (e) { /* headless harnesses without CustomEvent */ }
    }, 120);
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
      // v0.99.4: the 6 gradient-capable fields (the Colors tab iterates
      // these; the fmt stops ride formatter.js — the text-gradient track)
      fields: FIELDS,
      // v0.99.4 compat: the old name maps to the field set (shape differs —
      // appearance.js migrated; kept one release for stray consumers)
      customizable: FIELDS,
      // v0.45 ITEM 3: the canonical twin derivation — appearance.js's per-chat
      // #chat-root paint + any future consumer reuses THIS one function
      // (the same math formatter.js's fmtTwins mirrors; the node harness
      // asserts the parity).
      deriveTwins: deriveTwins,
      // v0.99.3: the culori-backed CSS-parity math (color-mix(in oklch)
      // in JS — the derivations' single truth with the :root block).
      fieldMath: FieldMath,
      // v0.99.4: the legacy fold (public — lookio + tests share it)
      foldThemeOverrides: foldThemeOverrides,
      // v0.79.1: the pure-JS resolved value of a theme var (override twin
      // or [data-theme] block, from the cache — never the style system).
      // v0.99.4: DERIVED names (--border-strong, --surface-2, --bg-app,
      // --text-3…) resolve through the FieldMath mix — what CSS paints.
      // v0.99.4b: THE ALIAS PROBLEM — @property-registered fields compute
      // to 'rgb(…)' serializations and derived vars keep unevaluated
      // 'color-mix(…)' token streams, so every JS consumer that needs a
      // REAL HEX (canvas paints, Pixi fills, the Kotlin panel, the meta
      // theme-color) resolves HERE instead of getComputedStyle. The
      // alias map covers the legacy names the blocks no longer declare.
      resolvedThemeVar: function (name) {
        var st = (window.Settings && window.Settings.getState()) || {};
        var rid = THEMES[st.theme] ? st.theme : 'midnight';
        var ov = foldThemeOverrides(
          (st.themeOverrides && st.themeOverrides[rid]) || null);
        if (DERIVED_MIXES[name]) {
          return resolvedDerived(rid, ov, name);
        }
        var r = resolvedVar(rid, ov, name);
        if (r) return r;
        var ALIAS = {
          '--text-1': '--field-ink', '--surface-1': '--field-surface',
          '--bg-panel': '--field-canvas',
          '--accent': '--field-accent-1', '--accent-2': '--field-accent-2',
          '--accent-3': '--field-accent-3'
        };
        if (ALIAS[name]) return resolvedVar(rid, ov, ALIAS[name]);
        return '';
      },
      // v1.01.5: themePreview(id) — the theme's OWN field hexes for the
      // quick-switch chip cards (user spec: theme boxes are the ONE
      // surface allowed to show the theme's colors instead of the
      // live user-customized vars — "and should not be white rendered
      // boxes"). Reads the static [data-theme] block straight from the
      // stylesheets (never the live cascade — previews must not follow
      // the user's overrides); THEMES carries the accents + grid.
      themePreview: function (id) {
        var t = THEMES[id];
        if (!t) return null;
        var fields = null;
        try {
          outer: for (var s = 0; s < document.styleSheets.length; s++) {
            var rs; try { rs = document.styleSheets[s].cssRules; } catch (e) { continue; }
            for (var i = 0; i < rs.length; i++) {
              var r = rs[i];
              if (!r.style || !r.selectorText) continue;
              if (String(r.selectorText).trim() !== '[data-theme="' + id + '"]') continue;
              fields = {};
              for (var f = 0; f < BLOCK_READ_SET.length; f++) {
                fields[BLOCK_READ_SET[f]] =
                  String(r.style.getPropertyValue(BLOCK_READ_SET[f]) || '').trim();
              }
              break outer;
            }
          }
        } catch (e) { fields = null; }
        return {
          surface: (fields && fields['--field-surface']) || '#14141a',
          ink: (fields && fields['--field-ink']) || '#e0e0e8',
          canvas: (fields && fields['--field-canvas']) || t.grid.bg || '#101016',
          accents: [t.accent, t.accent2, t.accent3],
          light: !!t.light
        };
      }
    };

    // == v1.01.5 THE LOCAL LIGHT — the projection painter is RETIRED ==
    // (docs/RESEARCH-V102-LOCAL-LIGHT.md). Every gradient window now
    // paints LOCAL (background-attachment: scroll — the element's own
    // border-box), the platform's compositor-friendly path:
    //   * `background-attachment: fixed` resolves against the
    //     transformed-ancestor's box inside the draggable panels (the
    //     CSS containing-block rule) — a SECOND, hidden gradient field
    //     the user saw fighting the applied one ("the panel splits
    //     into two gradients");
    //   * fixed backgrounds ride Chromium's slow path — full-region
    //     re-rasters on every scroll/drag frame ("super laggy with a
    //     gradient"), which is what this 1300-line painter existed to
    //     compensate. The browser's compositor replaces it.
    // ONE paint model, zero JS, one coherent gradient per box — the
    // same call v0.92.1 made for the chatbot chrome and v1.00.2 for
    // the text track, finished for the object track. The theme event
    // itself lives at IIFE scope above (the boot-order scoping bug).
    // The compat stub — legacy callers (perf rigs) no-op; stats stay
    // readable.
    window.DoomProjection = {
      poke: function () {}, motion: function () {},
      repaint: function () {}, paint: function () {},
      stats: { paints: 0, motions: 0, rebakes: 0, baked: 0, retired: 1 }
    };


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
      // v0.99.4: accent-4 is THEME-CARRIED (a static — never a
      // gradient), so its gate never fires; the entry is gone from the
      // scan. The a1..a3 entries stay (they are FIELDS — gradient-capable).
      var ACC = [
        { gate: 'data-a1-grad', varName: '--accent',        rgb: '--accent-rgb',        img: '--accent-gradient',        ink: '--on-accent' },
        { gate: 'data-a2-grad', varName: '--accent-2',      rgb: '--accent-2-rgb',      img: '--accent-2-gradient',      ink: '--on-accent-2' },
        { gate: 'data-a3-grad', varName: '--accent-3',      rgb: '--accent-3-rgb',      img: '--accent-3-gradient',      ink: '--on-accent-3' }
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
      // v0.99.4: surface-2 + bg-app are DERIVED SOLIDS now (never
      // gradients — their twins are never written, their gates never
      // fire); only the SURFACE FIELD owns a gradient twin. The s2/bg
      // entries are gone from the scan.
      var SURF = [
        { gate: 'data-s1-grad', varName: '--surface-1', img: '--surface-1-gradient', inkGate: 'data-bright-s1', ink: '--on-surface-1' }
      ];

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
        var wins, surfWins, protectedSels;
        if (scanMemo) {
          wins = scanMemo.wins; surfWins = scanMemo.surfWins;
          protectedSels = scanMemo.protectedSels;
        } else {
        wins = {};
        for (var i = 0; i < ACC.length; i++) { wins[ACC[i].gate] = []; }
        var surfWins = {};   // SURF[i].gate → [selectors]
        for (var si = 0; si < SURF.length; si++) {
          surfWins[SURF[si].gate] = [];
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
                  // v0.99.5: only 'win' collects — the GLYPH kind is
                  // retired (accent text is the ink track's business).
                  if (kind === 'win' && wins[ACC[a].gate].length < MAX_SEL) {
                    splitSelector(sel).forEach(function (part) { wins[ACC[a].gate].push(part); });
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
                  // v0.99.5: the PLATE-ring minting is RETIRED — hairlines
                  // are DERIVED solids now (no border twin ever exists),
                  // so a minted 3-layer plate would carry a dead third
                  // layer. Filled bordered rules keep their plain solid
                  // border + their fill's window (the surfWins path above).
                  void hasBorderVar;
                }
              }
            })(rules);
          }
        } catch (e) { /* a locked sheet is simply skipped */ }
        scanMemo = { wins: wins, surfWins: surfWins,
          protectedSels: protectedSels };
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
              'color:var(' + A.ink + ')!important;}';
          }
          // v0.99.5: the GLYPH windows are RETIRED — text is the INK
          // track (solids) + the fmt field (gradients); accent glyph
          // clip-windows were the text/accent entanglement the dual
          // track deletes. Lone accent labels keep the solid color.
        }
        // ── v0.77.8: the SURFACE windows + their bright-ink flips ──────
        for (var sw = 0; sw < SURF.length; sw++) {
          var SP = SURF[sw];
          if (surfWins[SP.gate].length) {
            var surfSel = surfWins[SP.gate].map(function (s) {
              return '[' + SP.gate + '] ' + s;
            }).join(',');
            css += surfSel + '{' +
              'background-image:var(' + SP.img + ',none)!important;}';
            // the readable-ink flip when the surface paints bright
            var inkSel = surfWins[SP.gate].map(function (s) {
              return '[' + SP.inkGate + '] ' + s;
            }).join(',');
            css += inkSel + '{color:var(' + SP.ink + ',var(--text-1));text-shadow:none;}';
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
      fieldMath: FieldMath,
      foldThemeOverrides: foldThemeOverrides,
      fields: FIELDS,
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
