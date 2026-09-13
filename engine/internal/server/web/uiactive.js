// uiactive.js — the MODULAR active-state indicator (v0.13).
//
// One shared mechanism for "this thing is active/connected/selected":
//   UIActive.mark(el, accentColor)  → green check-dot + accent ring + glow
//   UIActive.unmark(el)             → back to neutral
//
// Works on ANY element (provider cards, tabs, model rows, provider dots…)
// by toggling the `dd-active` class. The accent color is passed as a CSS
// custom property, so the provider's own color tints the ring while the
// check-dot stays semantic green (#34d399 = connected/active).
//
// The CSS is injected ONCE (idempotent) — no per-element inline styles to
// keep in sync, one place to restyle the whole app's active language.

(function () {
  'use strict';

  var CSS_ID = 'dd-active-styles';
  var GREEN = '#34d399';

  function ensureStyles() {
    if (document.getElementById(CSS_ID)) return;
    var style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent =
      // The active container: accent ring (the element's --dd-accent) +
      // a soft glow. Border color crossfades for the iPhone feel.
      '.dd-active {' +
      '  border-color: var(--dd-accent, ' + GREEN + ') !important;' +
      '  box-shadow: 0 0 0 1px var(--dd-accent, ' + GREEN + '), 0 2px 14px -4px var(--dd-accent, ' + GREEN + ') !important;' +
      '  background: linear-gradient(180deg, rgba(52,211,153,0.05), rgba(20,20,26,0)) !important;' +
      '}' +
      // The status dot: 9px circle, bottom-… floating at the card's top-right
      // corner ring. Green fill + white check glyph when checked.
      '.dd-active-dot {' +
      '  position:relative; display:inline-flex; align-items:center; justify-content:center;' +
      '  width:18px; height:18px; border-radius:50%; flex-shrink:0;' +
      '  background:' + GREEN + '; color:#06251a; font-size:11px; font-weight:800;' +
      '  box-shadow:0 0 0 3px rgba(52,211,153,0.18);' +
      '  margin-left:6px; line-height:1;' +
      '}' +
      // Tab-style active (segmented controls): underline sweep + label color.
      '.dd-active-tab { color:#e0e0e8 !important; position:relative; }' +
      '.dd-active-tab::after {' +
      '  content:""; position:absolute; left:12%; right:12%; bottom:-4px; height:2.5px;' +
      '  border-radius:2px; background:var(--dd-accent, ' + GREEN + ');' +
      '  animation:dd-tab-sweep 0.28s cubic-bezier(0.32,0.72,0,1);' +
      '}' +
      '@keyframes dd-tab-sweep { from { left:45%; right:45%; opacity:0 } to { left:12%; right:12%; opacity:1 } }' +
      // Live-sync pulse (model browser provider dot).
      '.dd-live-dot { width:8px; height:8px; border-radius:50%; background:' + GREEN + '; flex-shrink:0; box-shadow:0 0 6px rgba(52,211,153,0.6); }' +
      '.dd-live-dot.dd-stale { background:#f59e0b; box-shadow:0 0 6px rgba(245,158,11,0.5); }';
    document.head.appendChild(style);
  }

  // mark() flags an element as active with an accent color. If label is a
  // string, a green check-dot with that text (or ✓) is appended inline —
  // call mark(el, color, {dot: true}) for the dot, or pass your own node.
  function mark(el, accentColor, opts) {
    if (!el) return;
    ensureStyles();
    el.classList.add('dd-active');
    if (accentColor) el.style.setProperty('--dd-accent', accentColor);
    else el.style.removeProperty('--dd-accent');
    if (opts && opts.dot) {
      if (!el.querySelector(':scope > .dd-active-dot')) {
        var dot = document.createElement('span');
        dot.className = 'dd-active-dot';
        dot.textContent = '✓';
        dot.title = 'Connected';
        el.appendChild(dot);
      }
    }
  }

  // markTab() flags a tab/segmented-control label as the active one.
  function markTab(el, accentColor) {
    if (!el) return;
    ensureStyles();
    el.classList.add('dd-active-tab');
    if (accentColor) el.style.setProperty('--dd-accent', accentColor);
  }

  function unmark(el) {
    if (!el) return;
    el.classList.remove('dd-active');
    el.classList.remove('dd-active-tab');
    el.style.removeProperty('--dd-accent');
    var dot = el.querySelector(':scope > .dd-active-dot');
    if (dot) dot.remove();
  }

  // dotHTML() returns the inline badge HTML for template-built cards.
  function dotHTML(title) {
    return '<span class="dd-active-dot" title="' + (title || 'Connected') + '">✓</span>';
  }

  window.UIActive = {
    mark: mark,
    markTab: markTab,
    unmark: unmark,
    dotHTML: dotHTML,
    GREEN: GREEN
  };

  // Inject styles immediately — modelbrowser.js and providers.js use the
  // dd-active / dd-live-dot classes in raw HTML before any mark() call.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureStyles);
  } else {
    ensureStyles();
  }
})();
