// globalsearch.js — v0.41 GLOBAL CHAT SEARCH.
//
// The in-chat find bar (chatpanel.js) searches the conversation you're
// looking at. This finds WHICH conversation something lived in: every
// chat's transcript (user + assistant events), case-insensitive
// substring, honoring delete/edit masking — engine side
// GET /api/search?q= (search.go).
//
// UX (the WhatsApp/Telegram pattern):
//   · dock ⌕ glyph → the view rides the MASTER PANEL's stack (the exact
//     pattern the hub uses; a bare canvas gets a host panel first)
//   · live results as you type (200ms debounce), grouped by chat —
//     most recently active first — with <mark> highlighted snippets
//   · tap a result (or Enter for the first) → that chat opens and the
//     matched message scrolls into view with the find-hit pulse
//   · Esc closes; Enter walks; the count chip shows N chats · M hits
//
// Exposes: window.GlobalSearch = { open }
(function () {
  'use strict';

  var DEBOUNCE_MS = 200;
  var seq = 0; // in-flight request guard (stale responses never paint)

  // ── theming: one injected stylesheet, all classes, no inline soup ──
  var styleEl = null;
  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = 'gs-style';
    styleEl.textContent = [
      '.gs-root { padding: 12px 14px 18px; display: flex; flex-direction: column; gap: 10px; }',
      '.gs-searchbox { position: relative; display: flex; align-items: center; }',
      '.gs-searchbox .gs-glyph {',
      '  position: absolute; left: 12px; width: 15px; height: 15px; color: var(--text-3);',
      '  pointer-events: none; transition: color .16s ease; }',
      '.gs-searchbox:focus-within .gs-glyph { color: var(--accent); }',
      '.gs-input {',
      '  width: 100%; box-sizing: border-box;',
      '  padding: 11px 38px 11px 36px;',
      '  font: inherit; font-size: var(--ui-fs); color: var(--text-1);',
      '  background: var(--surface-1);',
      '  border: 1px solid var(--surface-2); border-radius: 12px;',
      '  outline: none; transition: border-color .16s ease, box-shadow .16s ease; }',
      '.gs-input::placeholder { color: var(--text-3); }',
      '.gs-input:focus {',
      '  border-color: rgba(var(--accent-rgb), .55);',
      '  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), .14); }',
      '.gs-count {',
      '  position: absolute; right: 10px; font-size: var(--ui-micro-fs);',
      '  color: var(--text-3); background: var(--surface-2);',
      '  border-radius: 8px; padding: 3px 8px; pointer-events: none;',
      '  transition: opacity .16s ease; }',
      '.gs-count:empty { display: none; }',
      '.gs-hint { font-size: var(--ui-micro-fs); color: var(--text-3); margin: -2px 2px 0; }',
      '.gs-group { border: 1px solid var(--surface-2); border-radius: 12px; overflow: hidden;',
      '  background: var(--surface-1); transition: border-color .16s ease; }',
      '.gs-group:hover { border-color: rgba(var(--accent-rgb), .35); }',
      '.gs-group + .gs-group { margin-top: 10px; }',
      '.gs-chat { display: flex; align-items: center; gap: 8px;',
      '  padding: 10px 12px; border-bottom: 1px solid var(--surface-2);',
      '  background: linear-gradient(180deg, var(--surface-2), transparent); }',
      '.gs-chat-name { flex: 1; min-width: 0; font-size: var(--ui-small-fs);',
      '  font-weight: 600; color: var(--text-1);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.gs-chat-meta { font-size: var(--ui-micro-fs); color: var(--text-3);',
      '  flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.gs-hit { display: block; width: 100%; text-align: left; padding: 9px 12px;',
      '  font: inherit; color: var(--text-2); background: transparent; border: 0;',
      '  cursor: pointer; transition: background .14s ease; }',
      '.gs-hit + .gs-hit { border-top: 1px solid var(--surface-2); }',
      '.gs-hit:hover, .gs-hit:focus-visible { background: rgba(var(--accent-rgb), .10);',
      '  outline: none; }',
      '.gs-hit:active { background: rgba(var(--accent-rgb), .18); }',
      '.gs-hit .gs-role { display: inline-block; font-size: calc(var(--ui-micro-fs) - 1px);',
      '  font-weight: 700; letter-spacing: .04em; text-transform: uppercase;',
      '  color: var(--text-3); margin-right: 6px; vertical-align: baseline; }',
      '.gs-hit.gs-role-user .gs-role { color: var(--notice); }',
      '.gs-hit.gs-role-assistant .gs-role { color: var(--accent); }',
      '.gs-snip { font-size: var(--ui-small-fs); line-height: 1.45; word-break: break-word; }',
      '.gs-snip mark { background: rgba(var(--accent-rgb), .28);',
      '  color: var(--text-1); border-radius: 3px; padding: 0 1px; }',
      '.gs-empty { text-align: center; padding: 26px 14px; color: var(--text-3);',
      '  font-size: var(--ui-small-fs); line-height: 1.5; }',
      '.gs-empty .gs-empty-glyph { display: block; font-size: 22px; margin-bottom: 6px;',
      '  opacity: .75; }',
      '.gs-loading { display: flex; align-items: center; justify-content: center; gap: 8px;',
      '  padding: 18px; color: var(--text-3); font-size: var(--ui-small-fs); }',
      '.gs-spinner { width: 13px; height: 13px; border-radius: 50%;',
      '  border: 2px solid var(--surface-2); border-top-color: var(--accent);',
      '  animation: gs-spin .7s linear infinite; }',
      '@keyframes gs-spin { to { transform: rotate(360deg); } }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .gs-spinner { animation-duration: 1.6s; }',
      '  .gs-hit, .gs-group, .gs-input { transition: none; }',
      '}'
    ].join('\n');
    document.head.appendChild(styleEl);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function relTime(ts) {
    var d = Date.now() - (Number(ts) || 0) * 1000;
    if (d < 0) d = 0;
    var m = Math.round(d / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    var days = Math.round(h / 24);
    if (days < 7) return days + 'd ago';
    return new Date(Number(ts) * 1000).toLocaleDateString();
  }

  // snippet + match_start → HTML with the match <mark>ed. The engine
  // guarantees match_start indexes the first case-insensitive hit of the
  // query inside the snippet.
  function snipHTML(text, matchStart, q) {
    var t = String(text || '');
    var s = Math.max(0, Math.min(t.length, matchStart | 0));
    var e = Math.min(t.length, s + String(q || '').length);
    return esc(t.slice(0, s)) + '<mark>' + esc(t.slice(s, e)) + '</mark>' + esc(t.slice(e));
  }

  function groupHTML(g, q) {
    var hits = '';
    for (var i = 0; i < g.matches.length; i++) {
      var m = g.matches[i];
      hits += '<button class="gs-hit gs-role-' + esc(m.role) + '" data-gs-sid="' + esc(g.session_id) +
        '" data-gs-ei="' + esc(String(m.id)) + '">' +
        '<span class="gs-role">' + esc(m.role === 'user' ? 'you' : 'ai') + '</span>' +
        '<span class="gs-snip">' + snipHTML(m.snippet, m.match_start, q) + '</span>' +
        '</button>';
    }
    return '<div class="gs-group" data-gs-group="' + esc(g.session_id) + '">' +
      '<div class="gs-chat">' +
        '<span class="gs-chat-name">' + esc(g.title || 'Untitled chat') + '</span>' +
        '<span class="gs-chat-meta">' + esc(relTime(g.updated_at)) + '</span>' +
      '</div>' + hits + '</div>';
  }

  function emptyHTML(msg, glyph) {
    return '<div class="gs-empty"><span class="gs-empty-glyph">' + (glyph || '🔍') + '</span>' + esc(msg) + '</div>';
  }

  function open() {
    ensureStyle();
    var panel = (window.ChatPanel && window.ChatPanel.current() || {}).panel;
    var hostReady = panel && panel.isOpen && panel.isOpen();
    var start = function () {
      // panel may have been re-created by the host open — re-resolve
      var p = (window.ChatPanel && window.ChatPanel.current() || {}).panel;
      if (!p) return;
      mountView(p);
    };
    if (!hostReady) {
      // bare canvas (the dock fires with no panel up) — open a host
      // panel first, exactly like the hub does.
      if (!window.doomalay || !window.doomalay.openChatBySession) return;
      Promise.resolve(window.doomalay.openChatBySession(null, {})).then(function (ok) {
        if (!ok) { toastNoHost(); return; }
        setTimeout(start, 60);
      });
      return;
    }
    start();
  }

  function toastNoHost() {
    // no chat exists yet — nothing to search, nothing to host the view
    var t = document.createElement('div');
    t.textContent = 'no chats yet — start a conversation first';
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);' +
      'border-radius:10px;padding:8px 14px;font-size:var(--ui-small-fs);z-index:3600;' +
      'opacity:0;transition:opacity .18s;font-family:inherit';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 250); }, 2100);
  }

  function mountView(panel) {
    var mySeq = ++seq;
    var debounceT = null;

    panel.pushView({
      title: 'search all chats',
      render: function () {
        return '<div class="gs-root">' +
          '<div class="gs-searchbox">' +
            '<svg class="gs-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
              '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.5 15.5 L20.5 20.5"></path></svg>' +
            '<input id="gs-input" class="gs-input" type="text" inputmode="search" autocomplete="off" ' +
              'spellcheck="false" placeholder="Search every conversation…" aria-label="Search all chats">' +
            '<span id="gs-count" class="gs-count" aria-live="polite"></span>' +
          '</div>' +
          '<div id="gs-hint" class="gs-hint">Enter opens the first result · Esc closes</div>' +
          '<div id="gs-results" aria-live="polite">' +
            emptyHTML('Search across every chat — messages and replies.', '🔍') +
          '</div>' +
        '</div>';
      },
      onMount: function () {
        var input = document.getElementById('gs-input');
        var countEl = document.getElementById('gs-count');
        var resultsEl = document.getElementById('gs-results');
        var hintEl = document.getElementById('gs-hint');
        if (!input || !resultsEl) return;
        setTimeout(function () { try { input.focus(); } catch (e) {} }, 80);

        function runSearch() {
          var q = (input.value || '').trim();
          if (q.length < 2) {
            mySeq++; // invalidate in-flight
            countEl.textContent = '';
            resultsEl.innerHTML = emptyHTML('Search across every chat — messages and replies.', '🔍');
            return;
          }
          var thisSeq = ++mySeq;
          resultsEl.innerHTML = '<div class="gs-loading"><span class="gs-spinner"></span>searching…</div>';
          fetch('/api/search?q=' + encodeURIComponent(q))
            .then(function (r) { return r.ok ? r.json() : { error: 'HTTP ' + r.status }; })
            .then(function (d) {
              if (thisSeq !== mySeq) return; // a newer keystroke won
              if (d && d.error) {
                countEl.textContent = '';
                resultsEl.innerHTML = emptyHTML(d.error, '⚠️');
                return;
              }
              var groups = (d && d.results) || [];
              if (!groups.length) {
                countEl.textContent = '0';
                resultsEl.innerHTML = emptyHTML('No chat mentions "' + q + '".', '🦀');
                return;
              }
              var total = 0;
              var html = '';
              for (var i = 0; i < groups.length; i++) total += groups[i].matches.length;
              for (var j = 0; j < groups.length; j++) html += groupHTML(groups[j], d.query || q);
              countEl.textContent = groups.length + (groups.length === 1 ? ' chat' : ' chats') + ' · ' + total;
              resultsEl.innerHTML = html;
              if (hintEl) hintEl.textContent = 'Enter opens the first result · Esc closes';
            })
            .catch(function () {
              if (thisSeq !== mySeq) return;
              resultsEl.innerHTML = emptyHTML('Search failed — is the engine running?', '⚠️');
            });
        }

        input.addEventListener('input', function () {
          clearTimeout(debounceT);
          debounceT = setTimeout(runSearch, DEBOUNCE_MS);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            var first = resultsEl.querySelector('.gs-hit');
            if (first) first.click();
          } else if (e.key === 'Escape') {
            if (panel.popView) panel.popView();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            var f2 = resultsEl.querySelector('.gs-hit');
            if (f2) f2.focus();
          }
        });
        // walk results with ↑/↓ across the whole result set
        resultsEl.addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          var hits = Array.prototype.slice.call(resultsEl.querySelectorAll('.gs-hit'));
          var idx = hits.indexOf(document.activeElement);
          var next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
          if (next < 0) { try { input.focus(); } catch (er) {} return; }
          if (next >= hits.length) next = 0;
          try { hits[next].focus(); } catch (er) {}
        });
        // tap a hit → open that chat + jump to the message. panel.open
        // (inside openChatBySession) tears the search view down itself.
        resultsEl.addEventListener('click', function (e) {
          var hit = e.target.closest && e.target.closest('.gs-hit');
          if (!hit) return;
          var sid = hit.getAttribute('data-gs-sid');
          var ei = hit.getAttribute('data-gs-ei');
          if (!window.doomalay || !window.doomalay.openChatBySession) return;
          try { if (navigator.vibrate) navigator.vibrate(10); } catch (er) {}
          Promise.resolve(window.doomalay.openChatBySession(sid, { ei: ei ? Number(ei) : null }));
        });
      },
      onClose: function () {
        clearTimeout(debounceT);
        mySeq++; // any in-flight response is stale now
      }
    });
  }

  window.GlobalSearch = { open: open };
})();
