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

  // v0.77.7 mixHex(a, b, t) → the linear blend a·(1−t)+b·t as a hex —
  // the secondary-text derivation's only math (kept beside hexTriplet).
  function mixHex(a, b, t) {
    var ma = /^#([0-9a-fA-F]{6})$/.exec(String(a));
    var mb = /^#([0-9a-fA-F]{6})$/.exec(String(b));
    if (!ma || !mb) return null;
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var ca = parseInt(ma[1].slice(i * 2, i * 2 + 2), 16);
      var cb = parseInt(mb[1].slice(i * 2, i * 2 + 2), 16);
      var v = Math.round(ca + (cb - ca) * t);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  // v0.77.7 avgStops(colors) → the mean of a palette (the representative
  // tone of a gradient for derivations — the first stop can be an outlier).
  function avgStops(colors) {
    if (!colors || !colors.length) return null;
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < colors.length; i++) {
      var m = /^#([0-9a-fA-F]{6})$/.exec(String(colors[i]));
      if (!m) continue;
      r += parseInt(m[1].slice(0, 2), 16);
      g += parseInt(m[1].slice(2, 4), 16);
      b += parseInt(m[1].slice(4, 6), 16);
      n++;
    }
    if (!n) return null;
    var hex = function (v) { v = Math.round(v / n); return (v < 16 ? '0' : '') + v.toString(16); };
    return '#' + hex(r) + hex(g) + hex(b);
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
    // v0.49: gradient TEXT — when the --text-1 override paints a real
    // gradient, flag the root so index.html's [data-text-grad] rules
    // clip the prominent titles/headings to it (v0.67: the pass now
    // extends to body text + labels — every text-1 consumer is a
    // window when the user paints Primary text as a field).
    var textGrad = false;
    // v0.77.7: the --text-1 override's raw spec + solid twin — the
    // secondary-text derivation reads them after the loop.
    var text1Spec = null, twinsText1Solid = '';
    // v0.67: per-accent gradient gates — [data-aN-grad] on the root
    // while accent N's twin is a real image. index.html's EVERY-WINDOW
    // pass converts the remaining accent-TINTED pills/badges/labels
    // into windows on that accent's viewport projection (the v0.66
    // model, completed). Solid accents never trip the gates → every
    // base theme renders byte-identical to v0.66.
    var accGrad = { '--accent': false, '--accent-2': false,
      '--accent-3': false, '--accent-4': false };
    if (overrides) {
      Object.keys(overrides).forEach(function (k) {
        // v0.44: the override value may be a hex (legacy) or a gradient
        // spec — deriveTwins folds both into the var-TWIN pair and
        // setProperty writes --X (solid) + --X-gradient (image or 'none';
        // consumer rules in index.html layer it over the solid).
        // v0.56: --border uses the SINGLE-LAYER sweep twin (patterns are
        // multi-layer values — invalid as border-image and leaky in the
        // radius-safe double-background rules; see deriveBorderTwins).
        var twins = (k === '--border')
          ? deriveBorderTwins(overrides[k])
          : deriveTwins(overrides[k]);
        docEl.style.setProperty(k, twins.solid);
        docEl.style.setProperty(k + '-gradient', twins.grad);
        docEl._themeOverrideKeys.push(k, k + '-gradient');
        // v0.57: --border-strong rides the SAME sweep as --border when the
        // user overrides it (same family of color → same underlying field;
        // the chatbot icon tiles + badges follow the palette). No twin is
        // written when the border is solid (base themes stay flat).
        if (k === '--border' && twins.grad !== 'none') {
          docEl.style.setProperty('--border-strong-gradient', twins.grad);
          docEl._themeOverrideKeys.push('--border-strong-gradient');
        }
        if (k === '--text-1') {
          // v0.77.7: the secondary-text derivation's inputs — the RAW
          // spec (for the average stop) + the solid twin (the fallback).
          text1Spec = overrides[k];
          twinsText1Solid = twins.solid;
        }
        if (k === '--text-1' && twins.grad !== 'none') textGrad = true;
        if (accGrad.hasOwnProperty(k) && twins.grad !== 'none') accGrad[k] = true;
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
    if (textGrad) docEl.setAttribute('data-text-grad', '1');
    else docEl.removeAttribute('data-text-grad');
    // v0.67: publish the per-accent gates (see accGrad above).
    var A_ATTR = { '--accent': 'data-a1-grad', '--accent-2': 'data-a2-grad',
      '--accent-3': 'data-a3-grad', '--accent-4': 'data-a4-grad' };
    Object.keys(A_ATTR).forEach(function (av) {
      if (accGrad[av]) docEl.setAttribute(A_ATTR[av], '1');
      else docEl.removeAttribute(A_ATTR[av]);
    });

    // v0.57: --bg-panel-rgb — derived EVERY apply (base themes included):
    // the scrim family (overlay scrim, chat scrim, media viewers) composes
    // rgba(var(--bg-panel-rgb), α) so the veils darken the AUTHENTIC canvas
    // color instead of leaking the user's overlay-background var.
    var panelTriplet = hexTriplet(
      getComputedStyle(docEl).getPropertyValue('--bg-panel'));
    if (panelTriplet) {
      docEl.style.setProperty('--bg-panel-rgb', panelTriplet);
      docEl._themeOverrideKeys.push('--bg-panel-rgb');
    }
    // v0.65 FIX: --on-accent derived for BASE THEMES too. It used to stay
    // the static :root #ffffff unless the user overrode Accent 1 — so
    // light accents (Mono's #d4d4d4) painted WHITE text on a light bubble
    // = invisible user messages. Read the RESOLVED --accent (theme block
    // or override twin — overrides write the solid before this runs) and
    // derive the readable ink by luminance, exactly like the old override
    // path did (same onColorFor contract).
    var accResolved = String(getComputedStyle(docEl)
      .getPropertyValue('--accent') || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(accResolved)) {
      docEl.style.setProperty('--on-accent', onColorFor(accResolved));
      docEl._themeOverrideKeys.push('--on-accent');
    }
    // v0.66: --on-accent-N for EVERY accent (not just Accent 1). The
    // projection rework makes pills/windows that RENDER accent-N's own
    // field, so their labels need the same readable-ink derivation the
    // user bubbles have always had (--on-accent). All four read their
    // RESOLVED solid twin (theme block or override — overrides were
    // written above, so this sees the user's palette). Naming follows
    // the --on-accent convention: --on-accent-2 / -3 / -4.
    var ON_VAR = { '--accent-2': '--on-accent-2',
      '--accent-3': '--on-accent-3', '--accent-4': '--on-accent-4' };
    Object.keys(ON_VAR).forEach(function (av) {
      var v = String(getComputedStyle(docEl).getPropertyValue(av) || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        docEl.style.setProperty(ON_VAR[av], onColorFor(v));
        docEl._themeOverrideKeys.push(ON_VAR[av]);
      }
    });
    // v0.57→v0.65 FIX: --veil-ink — the layer system's veil direction.
    // It used to derive from the RESOLVED TEXT color's luminance, which
    // sounded right but had a fatal case: a dark Primary-text override on
    // a dark theme flipped the veils to WHITE — every Layer-2/3 card and
    // pill then painted a 36-48% WHITE wash over dark surfaces (the theme
    // suite's live repro: the model-gate pills turned opaque milky-white
    // "boxes"; the user's "changing the primary text color turns the pill
    // opaque white" report). The veil's job is to calm the SURFACE it
    // paints ON — so the direction now follows the RESOLVED SURFACE
    // luminance: dark surfaces → BLACK ink (dark themes keep today's
    // exact look), light surfaces → WHITE ink (paper/frost keep theirs).
    // A dark-text-on-dark-surfaces user choice no longer washes the UI.
    var s1 = String(getComputedStyle(docEl)
      .getPropertyValue('--surface-1') || '').trim();
    // v0.77.7 THE SECONDARY-TEXT DERIVATION — user report: "the
    // description of what the row does seems to not follow any theme
    // color and remains grey. Same as most text when the rows are
    // expanded." Base themes hand-tune their text-2/3/3-dim triplets,
    // so a user-painted Primary text left the hints + descriptions on
    // the theme's grey. When --text-1 carries an override, the
    // secondary tones now DERIVE from it — blends toward the resolved
    // surface-1 (the surface descriptions sit on), keeping the
    // 1 > 2 > 3 hierarchy while following the customized palette. A
    // gradient's AVERAGE stop is the representative tone (the first
    // stop can be an outlier).
    if (text1Spec) {
      var t1Tone = avgStops(text1Spec.colors) ||
        (/^#[0-9a-fA-F]{6}$/.test(twinsText1Solid || '') ? twinsText1Solid : null);
      var t1Mix = mixHex(t1Tone, s1, 0.38);
      if (t1Tone && t1Mix) {
        docEl.style.setProperty('--text-2', t1Mix);
        docEl.style.setProperty('--text-3', mixHex(t1Tone, s1, 0.62) || t1Mix);
        docEl.style.setProperty('--text-3-dim', mixHex(t1Tone, s1, 0.76) || t1Mix);
        docEl._themeOverrideKeys.push('--text-2', '--text-3', '--text-3-dim');
        // the rgb triplets (rgba composition users) stay consistent
        var t2Tri = hexTriplet(t1Mix);
        if (t2Tri) {
          docEl.style.setProperty('--text-2-rgb', t2Tri);
          docEl._themeOverrideKeys.push('--text-2-rgb');
        }
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
      docEl.style.setProperty('--veil-ink', (s1Lum > 0.45) ? '#ffffff' : '#000000');
      docEl.style.setProperty('--veil-ink-rgb', (s1Lum > 0.45) ? '255, 255, 255' : '0, 0, 0');
      docEl._themeOverrideKeys.push('--veil-ink', '--veil-ink-rgb');
    }

    // v0.74: BRIGHT-SURFACE INK GATES. User report (the settings colors
    // wave): "Surface raised … any color that is bright looks horrible."
    // The projection model paints what the user chose — a bright
    // surface-2 makes every Layer-3 pill a bright window, and the light
    // --text-1/2 ink that reads beautifully on the dark base themes is
    // invisible on it. The accents already solved this exact problem
    // with --on-accent-N (v0.66): derive the readable ink from the
    // RESOLVED solid twin and gate a flip rule. The gates only fire
    // when the user actually paints a BRIGHT surface (luminance >
    // 0.45) — every base theme leaves them unset and renders
    // byte-identical.
    var BRIGHT_VARS = [
      { v: '--surface-1', ink: '--on-surface-1', gate: 'data-bright-s1' },
      { v: '--surface-2', ink: '--on-surface-2', gate: 'data-bright-s2' },
      { v: '--bg-app',    ink: '--on-bg-app',    gate: 'data-bright-bg' }
    ];
    BRIGHT_VARS.forEach(function (B) {
      var resolved = String(getComputedStyle(docEl).getPropertyValue(B.v) || '').trim();
      var bm = /^#([0-9a-fA-F]{6})$/.exec(resolved);
      if (bm) {
        var hex = '#' + bm[1];
        var ink = onColorFor(hex);
        docEl.style.setProperty(B.ink, ink);
        docEl._themeOverrideKeys.push(B.ink);
        // dark ink ⇒ the surface is bright ⇒ trip the gate
        if (ink !== '#ffffff') docEl.setAttribute(B.gate, '1');
        else docEl.removeAttribute(B.gate);
      } else {
        docEl.removeAttribute(B.gate);
      }
    });

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

    // 4. Android status bar tint — needs a REAL hex (no var() in meta).
    //    v0.49: prefers the CANVAS background solid (the canvas is the
    //    top-of-screen surface); falls back to the grid bg hex.
    var meta = document.getElementById('meta-theme-color');
    if (meta) {
      var cbSpec = canvasBgSpec(s);
      var cbHex = (cbSpec && Array.isArray(cbSpec.colors)) ? solidOf(cbSpec, '') : '';
      meta.setAttribute('content', isHexColor(cbHex) ? cbHex : effectiveGrid(s).bg);
    }

    // 5. re-tint the default chatbot family so canvas-drawn arrows/icons
    //    follow the theme (the family color is drawn on <canvas>, where
    //    var() doesn't resolve — it needs a real hex)
    if (window.DoomalayConfig && window.DoomalayConfig.families &&
        window.DoomalayConfig.families.default) {
      window.DoomalayConfig.families.default.color = cssVar('--border-strong') || '#4a4a5e';
    }

    // v0.67: after the gates/twins land, re-anchor every projection
    // window (the painter derives its selectors from the stylesheets
    // + the fresh gradient twins — see window.DoomProjection below).
    if (window.DoomProjection) window.DoomProjection.poke();
    // v0.70: the DERIVED GATES — every accent-painted class in the
    // stylesheets becomes a window/glyph on that accent's field (the
    // systematic accuracy pass; see window.DoomGates below). Runs after
    // the twins so the injected rules resolve against the live palette.
    if (window.DoomGates) window.DoomGates.refresh();
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
      deriveTwins: deriveTwins
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
        var els = document.querySelectorAll(
          '#chat-panel, #connect-overlay, .chatbot, .hub-sheet, .tpl-sheet');
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
      function motionTick() {
        for (var i = 0; i < rootReg.length; i++) {
          var R = rootReg[i];
          var M = readMatrix(R.el);
          if (M.translateOnly) setVars(R, -M.tx, -M.ty);
          else { setVars(R, 0, 0); dirty = true; }
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

      function paint() {
        if (!SEL) collect();
        if (!SEL) return;
        syncRoots();
        var vw = window.innerWidth, vh = window.innerHeight;
        var size = vw + 'px ' + vh + 'px';
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
              var img = getComputedStyle(el).backgroundImage;
              if (!img || img === 'none') continue;   // a solid twin — nothing to anchor
              el.__projPainted = true;
            }
            var r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || r.bottom < -60 || r.top > vh + 60) continue;
            // the translation-invariant base: strip the root's CURRENT
            // translation so the per-frame vars can re-add it
            reads.push({ el: el, R: R,
              bx: M.translateOnly ? (-r.left + M.tx) : -r.left,
              by: M.translateOnly ? (-r.top + M.ty) : -r.top,
              pos: fmtCalc('--proj-tx', M.translateOnly ? (-r.left + M.tx) : -r.left) + ' ' +
                   fmtCalc('--proj-ty', M.translateOnly ? (-r.top + M.ty) : -r.top) });
          }
        }
        // ── WRITE PHASE (only what changed — a no-op bake writes
        //    nothing, fires no MutationObserver, settles at once) ──
        var keep = [];
        for (var w = 0; w < reads.length; w++) {
          var it = reads[w];
          if (it.el.__projPos !== it.pos) {
            it.el.style.backgroundPosition = it.pos;
            it.el.__projPos = it.pos;
          }
          if (it.el.style.backgroundSize !== size) it.el.style.backgroundSize = size;
          if (it.el.style.backgroundAttachment !== 'scroll') it.el.style.backgroundAttachment = 'scroll';
          keep.push(it.el);
        }
        // clear every previously-painted element that lost its anchor this
        // pass — it left the transformed scopes, went offscreen, or its
        // gradient twin reverted to solid. The CSS state owns it again
        // (byte-identical to the no-gradient look; re-painted on return).
        for (var p = 0; p < painted.length; p++) {
          var el2 = painted[p];
          if (!el2.isConnected || keep.indexOf(el2) !== -1) continue;
          el2.style.removeProperty('background-position');
          el2.style.removeProperty('background-size');
          el2.style.removeProperty('background-attachment');
          el2.__projPainted = false;
          el2.__projPos = null;
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
        if (hadRoot && movingRoot === 0 && !dirty && movingLayout === 0) paint();
        if (dirty || movingRoot > 0 || movingLayout > 0) schedule();
      }
      function mark() { dirty = true; schedule(); }
      function motion() { movingRoot = 3; schedule(); }
      // movingLayout — the LAYOUT window: any transition on a property
      // that can move element boxes (grid-template-rows un-collapses,
      // height, width…) repaints per frame while it animates; cosmetic
      // transitions (opacity, color, box-shadow…) only mark once.
      var MOVER_RE = /^(transform|all|grid-template-rows|grid-template-columns|height|max-height|min-height|width|max-width|min-width|top|left|right|bottom|margin[^ ]*|padding[^ ]*|flex-basis|font-size|inset[^ ]*|translate)$/;

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
          // a root's OWN style write where only transform/translate
          // changed is the glide driver (writeY) — the motion path
          // covers it; anything else is a real change → full paint.
          if (muts.length && rootReg.length) {
            full = false;
            for (var i = 0; i < muts.length; i++) {
              var m = muts[i];
              if (m.type !== 'attributes' || m.attributeName !== 'style' ||
                  !m.target || m.target.__projTracked !== true) { full = true; break; }
              var now = m.target.getAttribute('style') || '';
              var old = m.oldValue || '';
              var strip = function (s) {
                return s.replace(/(^|;)\s*(transform|translate)\s*:[^;]*/g, ';');
              };
              if (strip(now) !== strip(old)) { full = true; break; }
            }
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
      document.addEventListener('scroll', mark, true);
      window.addEventListener('resize', function () { SEL = null; mark(); });
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
          } else {
            mark();                 // cosmetic — one repaint at the end settles it
          }
        }, true);
      });
      ['transitionend', 'transitioncancel'].forEach(function (ev) {
        document.addEventListener(ev, mark, true);
      });

      return {
        poke: mark,             // app.js's physics tick calls this per frame
        motion: motion,         // v0.74: the CHEAP per-frame path (writeY rides it)
        repaint: function () { SEL = null; paint(); },
        paint: paint
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
      var ACC = [
        { gate: 'data-a1-grad', varName: '--accent',        rgb: '--accent-rgb',        img: '--accent-gradient',        ink: '--on-accent' },
        { gate: 'data-a2-grad', varName: '--accent-2',      rgb: '--accent-2-rgb',      img: '--accent-2-gradient',      ink: '--on-accent-2' },
        { gate: 'data-a3-grad', varName: '--accent-3',      rgb: '--accent-3-rgb',      img: '--accent-3-gradient',      ink: '--on-accent-3' },
        { gate: 'data-a4-grad', varName: '--accent-4',      rgb: '--accent-4-rgb',      img: '--accent-4-gradient',      ink: '--on-accent-4' }
      ];
      var MAX_SEL = 400;   // pathological-sheet guard

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
        var wins = {}, glyphs = {};
        for (var i = 0; i < ACC.length; i++) { wins[ACC[i].gate] = []; glyphs[ACC[i].gate] = []; }
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
                if (sel.indexOf('[data-a') !== -1 || sel.indexOf('[data-text-grad]') !== -1 ||
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
                    wins[ACC[a].gate].push(sel);
                  } else if (kind === 'glyph' && glyphs[ACC[a].gate].length < MAX_SEL) {
                    glyphs[ACC[a].gate].push(sel);
                  }
                }
              }
            })(rules);
          }
        } catch (e) { /* a locked sheet is simply skipped */ }

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
                  n.id !== 'doom-derived-gates') { derive(); return; }
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
      gridSpecFor: gridSpecFor,
      effectiveGridSpecs: effectiveGridSpecs,
      effectiveGrid: effectiveGrid,
      canvasBgSpec: canvasBgSpec,
      onColorFor: onColorFor,
      isHexColor: isHexColor
    };
  }
})();
