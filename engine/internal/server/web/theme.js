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
// vars: the consumers of these vars are static CSS rules that can't
// safely switch background-blend-mode:color per-var — texture is a
// chat-background / hub-design feature (tweaks.js / hubpublish.js).
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
      accent: '#a78bfa', accent2: '#38bdf8', accent3: '#f472b6',
      grid: { bg: '#0a0a0b', line: '#131318', dot: '#2e2e3a', origin: '#4a4a5e' } },
    nebula:   { label: 'Nebula',   scheme: 'berry',  light: false,
      accent: '#c084fc', accent2: '#22d3ee', accent3: '#f0abfc',
      grid: { bg: '#0b0912', line: '#171225', dot: '#2e2748', origin: '#413463' } },
    ember:    { label: 'Ember',    scheme: 'sunset', light: false,
      accent: '#fb923c', accent2: '#fbbf24', accent3: '#fb7185',
      grid: { bg: '#0f0a08', line: '#1f150d', dot: '#3a2c1b', origin: '#57401f' } },
    forest:   { label: 'Forest',   scheme: 'forest', light: false,
      accent: '#4ade80', accent2: '#2dd4bf', accent3: '#a3e635',
      grid: { bg: '#080d0a', line: '#12241a', dot: '#213528', origin: '#2f4a37' } },
    ocean:    { label: 'Ocean',    scheme: 'ocean',  light: false,
      accent: '#38bdf8', accent2: '#7dd3fc', accent3: '#818cf8',
      grid: { bg: '#070b10', line: '#101c28', dot: '#1f3341', origin: '#2b4759' } },
    rose:     { label: 'Rose',     scheme: 'rose',   light: false,
      accent: '#f472b6', accent2: '#fb7185', accent3: '#e879f9',
      grid: { bg: '#100a0d', line: '#20141b', dot: '#3a2833', origin: '#523744' } },
    mono:     { label: 'Mono',     scheme: 'mono',   light: false,
      accent: '#d4d4d4', accent2: '#a8a8a8', accent3: '#8a8a8a',
      grid: { bg: '#0a0a0a', line: '#161616', dot: '#282828', origin: '#3d3d3d' } },
    solar:    { label: 'Solar',    scheme: 'solar',  light: false,
      accent: '#fbbf24', accent2: '#67e8f9', accent3: '#a5b4fc',
      grid: { bg: '#060810', line: '#101828', dot: '#1f2a42', origin: '#2e3d5e' } },
    paper:    { label: 'Paper',    scheme: 'paper',  light: true,
      accent: '#b45309', accent2: '#0e7490', accent3: '#be185d',
      grid: { bg: '#f4f1ea', line: '#e0d8c8', dot: '#c9bda6', origin: '#a3906c' } },
    frost:    { label: 'Frost',    scheme: 'frost',  light: true,
      accent: '#4f6ef7', accent2: '#0891b2', accent3: '#c026d3',
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

  // the customizable variables (v0.26 theme customization) and their
  // -rgb triplet partners (auto-derived when overridden)
  var RGB_PAIRS = {
    '--accent': '--accent-rgb', '--accent-2': '--accent-2-rgb', '--accent-3': '--accent-3-rgb',
    '--ok': '--ok-rgb', '--warn': '--warn-rgb', '--err': '--err-rgb'
  };
  var CUSTOMIZABLE = [
    { var: '--bg-app', label: 'App background', rgb: false },
    { var: '--bg-panel', label: 'Panel background', rgb: false },
    { var: '--surface-1', label: 'Surface (cards)', rgb: false },
    { var: '--surface-2', label: 'Surface raised', rgb: false },
    { var: '--border', label: 'Borders', rgb: false },
    { var: '--text-1', label: 'Primary text', rgb: false },
    { var: '--accent', label: 'Accent 1', rgb: true },
    { var: '--accent-2', label: 'Accent 2', rgb: true },
    { var: '--accent-3', label: 'Accent 3', rgb: true }
  ];

  function applyTheme(s) {
    var id = THEMES[s.theme] ? s.theme : 'midnight';
    var t = THEMES[id];

    // 1. the variable palette (CSS cascade does the whole UI)
    document.documentElement.setAttribute('data-theme', id);

    // 1b. v0.26: the user's CUSTOMIZATIONS for this theme — inline CSS
    // vars beat the [data-theme] block. Applied AFTER the data-theme set;
    // any vars left over from a previous theme's overrides are cleared
    // first (inline styles never fall back otherwise).
    var docEl = document.documentElement;
    var overrides = (s.themeOverrides && s.themeOverrides[id]) || null;
    var prevKeys = docEl._themeOverrideKeys || [];
    prevKeys.forEach(function (k) { docEl.style.removeProperty(k); });
    docEl._themeOverrideKeys = [];
    if (overrides) {
      Object.keys(overrides).forEach(function (k) {
        // v0.44: the override value may be a hex (legacy) or a gradient
        // spec — deriveTwins folds both into the var-TWIN pair and
        // setProperty writes --X (solid) + --X-gradient (image or 'none';
        // consumer rules in index.html layer it over the solid).
        var twins = deriveTwins(overrides[k]);
        docEl.style.setProperty(k, twins.solid);
        docEl.style.setProperty(k + '-gradient', twins.grad);
        docEl._themeOverrideKeys.push(k, k + '-gradient');
        // auto-derive the -rgb triplet (rgba() composition needs it) —
        // ALWAYS from the SOLID twin (a gradient's stops can't compose
        // rgba(); the first color is the canonical tint, v0.26 contract)
        var pair = RGB_PAIRS[k];
        var triplet = hexTriplet(twins.solid);
        if (pair && triplet) {
          docEl.style.setProperty(pair, triplet);
          docEl._themeOverrideKeys.push(pair);
        }
      });
    }

    // 2. chat markdown scheme — only when the user hasn't pinned their own
    //    (a non-default scheme OR any per-slot override = pinned)
    if (window.Formatter) {
      if (!isChatSchemePinned(s)) {
        window.Formatter.applyScheme(t.scheme, s.fmtOverrides || null);
      } else {
        window.Formatter.applyScheme(s.chatScheme || 'teal', s.fmtOverrides || null);
      }
    }

    // 3. text sizes — chat (0-100 slider → 12-24px), general + small
    //    v0.34: --chat-scale rides the chat slider — a unitless ratio of
    //    the chat font to its 16px default (0.75…1.5). Everything INSIDE
    //    the message scope (bubble padding, code cards, thinking strips,
    //    artifact cards, icons) multiplies its px by it, so the whole
    //    conversation scales as ONE piece: no more text that grows while
    //    its bubbles, code and spacing stay put (the "wonky formatting").
    var size = (typeof s.chatTextSize === 'number') ? s.chatTextSize : 50;
    document.documentElement.style.setProperty('--chat-fs', (12 + (size / 100) * 12).toFixed(1) + 'px');
    document.documentElement.style.setProperty('--chat-scale', ((12 + (size / 100) * 12) / 16).toFixed(3));
    var ui = (typeof s.uiTextSize === 'number') ? s.uiTextSize : 50;   // 0-100 → 12-17px
    document.documentElement.style.setProperty('--ui-fs', (12 + (ui / 100) * 5).toFixed(1) + 'px');
    var sm = (typeof s.smallTextSize === 'number') ? s.smallTextSize : 50; // 0-100 → 9.5-15px
    document.documentElement.style.setProperty('--ui-small-fs', (9.5 + (sm / 100) * 5.5).toFixed(1) + 'px');

    // 4. Android status bar tint — needs a REAL hex (no var() in meta)
    var meta = document.getElementById('meta-theme-color');
    if (meta) {
      meta.setAttribute('content', effectiveGrid(s).bg);
    }

    // 5. re-tint the default chatbot family so canvas-drawn arrows/icons
    //    follow the theme (the family color is drawn on <canvas>, where
    //    var() doesn't resolve — it needs a real hex)
    if (window.DoomalayConfig && window.DoomalayConfig.families &&
        window.DoomalayConfig.families.default) {
      window.DoomalayConfig.families.default.color = cssVar('--border-strong') || '#4a4a5e';
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

  // boot + live-apply (browser only — the node path skips straight to
  // the module.exports below)
  var HAS_WINDOW = (typeof window !== 'undefined');
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
      pendingScheme: pendingScheme,
      isLight: function (id) { return !!(THEMES[id] && THEMES[id].light); },
      customizable: CUSTOMIZABLE,
      // v0.44: the canonical twin derivation — appearance.js's per-chat
      // #chat-root paint + any future consumer reuses THIS one function
      // (the same math formatter.js's fmtTwins mirrors; the node harness
      // asserts the parity).
      deriveTwins: deriveTwins
    };
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
      hexTriplet: hexTriplet,
      gridSpecFor: gridSpecFor,
      effectiveGridSpecs: effectiveGridSpecs,
      effectiveGrid: effectiveGrid,
      isHexColor: isHexColor
    };
  }
})();
