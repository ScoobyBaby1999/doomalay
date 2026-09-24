// globalsearch.js — v0.41 GLOBAL CHAT SEARCH → v0.52 THE SHARED FIND
// OPTIONS MODULE (the search UI itself merged into chatsview.js).
//
// USER SPEC (v0.52 item 4): the dock's separate ⌕ (search all chats) and
// 💬 (all chats) glyphs served almost the same purpose — they are now ONE
// surface: ChatsView (the all-chats index WITH the live search row on
// top: empty query → the date-bucketed index; typing → live /api/search
// results with <mark>ed snippets, Enter/↑/↓ walking, jump-to-message).
// window.GlobalSearch.open() still works (keys.js + muscle memory) — it
// just opens the merged view.
//
// WHAT STILL LIVES HERE (why this file remains): the SHARED find options
// blob + match predicate every find surface reads —
//   · the in-chat find bar (chatpanel.js) — findOpts() / findMatches()
//   · the merged view's Aa / Exact chips (chatsview.js) — setFindOpts()
//   · localStorage doomalay.find.opts.v1 — one blob, every surface,
//     'doomalay:find-opts' dispatched on change so an open bar recomputes
//
// Exposes: window.GlobalSearch = { open, findOpts, setFindOpts, findMatches }
(function () {
  'use strict';

  var FIND_OPTS_KEY = 'doomalay.find.opts.v1';
  function findOpts() {
    try {
      var v = JSON.parse(localStorage.getItem(FIND_OPTS_KEY));
      return { caseSensitive: !!(v && v.cs), exact: !!(v && v.exact) };
    } catch (e) {
      return { caseSensitive: false, exact: false };
    }
  }
  function setFindOpts(opts) {
    try {
      localStorage.setItem(FIND_OPTS_KEY, JSON.stringify({ cs: !!opts.caseSensitive, exact: !!opts.exact }));
    } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent('doomalay:find-opts', { detail: findOpts() }));
    } catch (e) {}
    return findOpts();
  }

  // The shared match predicate: every occurrence of q in text honoring
  // the toggles → [{idx, len}] (idx is the char index in the ORIGINAL
  // text — lengths are equal, only the casing differs).
  function isWordChar(c) {
    return !!c && /[A-Za-z0-9_]/.test(c);
  }
  function wordBounded(text, at, len) {
    var before = at > 0 ? text.charAt(at - 1) : '';
    var after = at + len < text.length ? text.charAt(at + len) : '';
    return !isWordChar(before) && !isWordChar(after);
  }
  function findMatches(text, q, opts) {
    var t = String(text || ''), needle = String(q || '');
    if (!needle || !t) return [];
    var hay = opts && opts.caseSensitive ? t : t.toLowerCase();
    var nd = opts && opts.caseSensitive ? needle : needle.toLowerCase();
    var out = [], from = 0;
    for (;;) {
      var at = hay.indexOf(nd, from);
      if (at < 0) break;
      if (!(opts && opts.exact) || wordBounded(t, at, needle.length)) {
        out.push({ idx: at, len: needle.length });
      }
      from = at + Math.max(1, needle.length);
    }
    return out;
  }

  // open — the merged surface (v0.52). The view logic lives in
  // chatsview.js; this is a pure delegation so every existing entry
  // point (the keys.js shortcut, any deep link) keeps working.
  function open() {
    if (window.ChatsView && window.ChatsView.open) window.ChatsView.open();
  }

  window.GlobalSearch = { open: open, findOpts: findOpts, setFindOpts: setFindOpts, findMatches: findMatches };
})();
