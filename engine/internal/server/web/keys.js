// keys.js — v0.42 THE GLOBAL KEYBOARD LAYER.
//
// The app had real keyboard support scattered per-surface (Enter sends,
// the find bar walks matches, search views walk results) but no way to
// DISCOVER any of it, and the two bindings every desktop user reaches
// for reflexively did nothing: Ctrl/Cmd+F (find in chat) and a
// command-palette entry point. This module adds:
//
//   · ? (Shift+/)        → the shortcuts overlay — every binding, grouped
//                           by surface, kbd keycap styling (the pattern
//                           Gmail/GitHub use for discoverability)
//   · Ctrl/Cmd + F       → open the live chat's find bar (the natural
//                           binding; suppressed while a view is stacked)
//   · Ctrl/Cmd + K       → global chat search (the command-palette entry)
//
// Guards: plain keys are ignored while typing (inputs / textareas /
// contenteditable); the Ctrl/Cmd combos always fire (browsers don't own
// them in this context — F is preventDefault-ed, K has no default).
//
// Exposes: window.Keys = { openShortcuts, closeShortcuts }
(function () {
  'use strict';

  var overlayEl = null;

  // ── theming ──────────────────────────────────────────────────────────
  var styleEl = null;
  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = 'keys-style';
    styleEl.textContent = [
      '.kb-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.48);',
      '  z-index: 3400; display: flex; align-items: center; justify-content: center;',
      '  opacity: 0; transition: opacity .18s ease; }',
      '.kb-scrim.kb-in { opacity: 1; }',
      '.kb-card { width: min(420px, calc(100vw - 40px)); max-height: min(560px, calc(100vh - 56px));',
      '  background: var(--surface-1); border: 1px solid var(--surface-2);',
      '  border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.5);',
      '  display: flex; flex-direction: column; overflow: hidden;',
      '  transform: translateY(10px) scale(.97); transition: transform .2s cubic-bezier(0.32,0.72,0,1); }',
      '.kb-scrim.kb-in .kb-card { transform: none; }',
      '.kb-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px;',
      '  border-bottom: 1px solid var(--surface-2);',
      '  background: linear-gradient(180deg, var(--surface-2), transparent); }',
      '.kb-title { flex: 1; font-size: calc(var(--ui-fs) + 1px); font-weight: 600; color: var(--text-1); }',
      '.kb-close { background: transparent; border: 1px solid var(--border); color: var(--text-3);',
      '  border-radius: 9px; width: 30px; height: 30px; font-size: 14px; cursor: pointer;',
      '  font-family: inherit; transition: color .14s, border-color .14s; flex-shrink: 0; }',
      '.kb-close:hover, .kb-close:focus-visible { color: var(--text-1); border-color: var(--border-strong);',
      '  outline: none; }',
      '.kb-body { overflow-y: auto; padding: 6px 16px 16px; }',
      '.kb-sec { margin-top: 12px; }',
      '.kb-sec-title { font-size: calc(var(--ui-micro-fs) + .5px); font-weight: 700;',
      '  letter-spacing: .07em; text-transform: uppercase; color: var(--text-2);',
      '  margin: 0 0 8px; }',
      '.kb-row { display: flex; align-items: center; gap: 12px; padding: 7px 0;',
      '  font-size: var(--ui-small-fs); color: var(--text-2); }',
      '.kb-row + .kb-row { border-top: 1px solid var(--surface-2); }',
      '.kb-desc { flex: 1; min-width: 0; }',
      '.kb-keys { display: flex; align-items: center; gap: 4px; flex-shrink: 0;',
      '  min-width: 108px; } /* aligned column — descriptions share a scannable edge */',
      '.kbd { display: inline-flex; align-items: center; justify-content: center;',
      '  min-width: 24px; height: 24px; padding: 0 7px;',
      '  font-size: calc(var(--ui-micro-fs) + .5px); font-weight: 600; color: var(--text-1);',
      '  background: var(--surface-2); border: 1px solid var(--border-strong);',
      '  border-bottom-width: 2px; border-radius: 6px; }',
      '.kb-plus { color: var(--text-3); font-size: 10px; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .kb-scrim, .kb-card { transition: none; }',
      '}'
    ].join('\n');
    document.head.appendChild(styleEl);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function keysHTML(keys) {
    var out = '';
    for (var i = 0; i < keys.length; i++) {
      if (i > 0) out += '<span class="kb-plus">+</span>';
      out += '<kbd class="kbd">' + esc(keys[i]) + '</kbd>';
    }
    return '<span class="kb-keys">' + out + '</span>';
  }

  // altKeysHTML — EQUIVALENT bindings for one action ('Enter' and '↓'
  // both mean next match). Renders compact 'A · B' groups instead of
  // one row per binding — the overlay stays scannable, not a wall.
  function altKeysHTML(groups) {
    var out = '';
    for (var g = 0; g < groups.length; g++) {
      if (g > 0) out += '<span class="kb-plus">·</span>';
      for (var i = 0; i < groups[g].length; i++) {
        if (i > 0) out += '<span class="kb-plus">+</span>';
        out += '<kbd class="kbd">' + esc(groups[g][i]) + '</kbd>';
      }
    }
    return '<span class="kb-keys">' + out + '</span>';
  }

  // the app's real bindings, grouped by surface (kept honest — if a
  // binding changes in its module, change it here too)
  var SECTIONS = [
    { title: 'Global', rows: [
      { keys: ['?'], desc: 'this shortcut list' },
      { keys: ['Ctrl', 'F'], desc: 'find in the open chat' },
      { keys: ['Ctrl', 'K'], desc: 'search every chat' },
      { keys: ['Esc'], desc: 'close the top view / panel' }
    ]},
    { title: 'In chat', rows: [
      { keys: ['Enter'], desc: 'send the message' },
      { keys: ['Shift', 'Enter'], desc: 'new line' },
      { keys: ['Esc'], desc: 'stop a streaming reply' }
    ]},
    { title: 'Find in chat', rows: [
      { alt: [['Enter'], ['↓']], desc: 'next match' },
      { alt: [['Shift', 'Enter'], ['↑']], desc: 'previous match' },
      { keys: ['Esc'], desc: 'close the find bar' }
    ]},
    { title: 'Search all chats', rows: [
      { keys: ['Enter'], desc: 'open the first result' },
      { alt: [['↑'], ['↓']], desc: 'walk the results' },
      { keys: ['Esc'], desc: 'close the search view' }
    ]}
  ];

  function overlayHTML() {
    var secs = '';
    for (var i = 0; i < SECTIONS.length; i++) {
      var rows = '';
      for (var j = 0; j < SECTIONS[i].rows.length; j++) {
        var r = SECTIONS[i].rows[j];
        var keysOut = r.alt ? altKeysHTML(r.alt) : keysHTML(r.keys);
        rows += '<div class="kb-row">' + keysOut +
          '<span class="kb-desc">' + esc(r.desc) + '</span></div>';
      }
      secs += '<div class="kb-sec"><h3 class="kb-sec-title">' + esc(SECTIONS[i].title) + '</h3>' + rows + '</div>';
    }
    return '<div class="kb-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">' +
      '<div class="kb-head">' +
        '<span class="kb-title">Keyboard shortcuts</span>' +
        '<button class="kb-close" aria-label="Close shortcuts">✕</button>' +
      '</div>' +
      '<div class="kb-body">' + secs + '</div>' +
    '</div>';
  }

  function openShortcuts() {
    ensureStyle();
    closeShortcuts();
    overlayEl = document.createElement('div');
    overlayEl.className = 'kb-scrim';
    overlayEl.id = 'kb-overlay';
    overlayEl.innerHTML = overlayHTML();
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) closeShortcuts();
    });
    overlayEl.querySelector('.kb-close').addEventListener('click', closeShortcuts);
    document.body.appendChild(overlayEl);
    requestAnimationFrame(function () { overlayEl.classList.add('kb-in'); });
    try { overlayEl.querySelector('.kb-close').focus(); } catch (e) {}
  }

  function closeShortcuts() {
    if (!overlayEl) return;
    var el = overlayEl;
    overlayEl = null;
    el.classList.remove('kb-in');
    setTimeout(function () { el.remove(); }, 190);
  }

  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' ||
      t.isContentEditable === true;
  }

  // ── the global listener ──────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd+F — find in the live chat (the browser's find would scan
    // UI chrome; ours searches the transcript like the ⌕ button does).
    if (mod && (e.key === 'f' || e.key === 'F')) {
      if (window.ChatPanel && window.ChatPanel.openFind && window.ChatPanel.openFind()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return; // no live chat → let the browser's find be the browser's
    }

    // Ctrl/Cmd+K — the command-palette entry into global chat search.
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      if (overlayEl) { closeShortcuts(); return; }
      if (window.GlobalSearch) window.GlobalSearch.open();
      return;
    }

    // '?' opens the overlay — never while typing (that's a real
    // character), never when a modifier other than Shift is held.
    // Two matching paths: the layout-correct key '?' (what a real
    // keyboard reports) and the physical Slash key + Shift (robust on
    // synthetic/odd layouts where key comes through empty).
    var isQuestion = e.key === '?' ||
      (e.code === 'Slash' && e.shiftKey && e.key !== '/');
    if (isQuestion && !mod && !e.altKey && !isTypingTarget(e.target)) {
      e.preventDefault();
      if (overlayEl) closeShortcuts();
      else openShortcuts();
      return;
    }

    // Esc closes the overlay (the panel/view stacks handle their own).
    if (e.key === 'Escape' && overlayEl) {
      e.preventDefault();
      closeShortcuts();
    }
  }, true); // capture: sees keys before per-surface handlers

  window.Keys = { openShortcuts: openShortcuts, closeShortcuts: closeShortcuts };
})();
