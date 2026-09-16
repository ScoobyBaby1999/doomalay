// theme.js — v0.24 THE THEME ENGINE.
//
// User spec: "Let's go over the colors of the entire app, and make sure all
// UI elements use a variable color instead of a hardcoded one... refactor
// the theme tabs in the settings to have more themes, each theme should
// include more contrasting yet adjacent colors with more hues to make the
// entire feel of the app customisable."
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
// Exposes: window.DoomTheme = { themes, apply, effectiveGrid, isLight }

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

  function applyTheme(s) {
    var id = THEMES[s.theme] ? s.theme : 'midnight';
    var t = THEMES[id];

    // 1. the variable palette (CSS cascade does the whole UI)
    document.documentElement.setAttribute('data-theme', id);

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
    var size = (typeof s.chatTextSize === 'number') ? s.chatTextSize : 50;
    document.documentElement.style.setProperty('--chat-fs', (12 + (size / 100) * 12).toFixed(1) + 'px');
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

  // effectiveGrid merges the user's explicit grid picks over the theme's
  // defaults. Stored values that still equal the pre-v0.24 defaults are
  // treated as "never customized" → the theme drives the grid.
  // v0.25 SANITIZATION: only a REAL #rrggbb hex counts as a custom pick.
  // The old code passed ANY stored string through — including CSS-var
  // strings ('var(--bg-app)', written by the old reset button) which are
  // INVALID canvas fillStyles (silently ignored → the grid showed stale
  // colors that matched neither the theme nor the settings).
  function isHexColor(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  }
  function effectiveGrid(s) {
    var t = THEMES[THEMES[s.theme] ? s.theme : 'midnight'];
    var g = {
      bg: (isHexColor(s.bg) && s.bg.toLowerCase() !== LEGACY_GRID.bg) ? s.bg : t.grid.bg,
      lineColor: (isHexColor(s.lineColor) && s.lineColor.toLowerCase() !== LEGACY_GRID.line) ? s.lineColor : t.grid.line,
      dotColor: (isHexColor(s.dotColor) && s.dotColor.toLowerCase() !== LEGACY_GRID.dot) ? s.dotColor : t.grid.dot,
      originColor: (isHexColor(s.originColor) && s.originColor.toLowerCase() !== LEGACY_GRID.origin) ? s.originColor : t.grid.origin
    };
    return g;
  }

  // boot + live-apply
  var Settings = window.Settings;
  if (Settings) {
    Settings.onChange(applyTheme);
    applyTheme(Settings.getState());
  }

  window.DoomTheme = {
    themes: THEMES,
    apply: applyTheme,
    effectiveGrid: effectiveGrid,
    pendingScheme: pendingScheme,
    isLight: function (id) { return !!(THEMES[id] && THEMES[id].light); }
  };
})();
