// chatsview.js — v0.52 THE ALL-CHATS INDEX + GLOBAL SEARCH, MERGED.
//
// USER SPEC (v0.52 item 4): "Try to merge the search all chats and all
// chats icons in the canvas panel extra options… since they serve almost
// the same purpose and can be merged without too much alteration to
// both." The dock now has ONE 💬 glyph; this view IS both surfaces:
//
//   · empty query  → the v0.42 all-chats index: every session, most
//     recently active first, date sections (Today / Yesterday / Previous
//     7 days / Older), one-line previews, provider badges
//   · typing       → the v0.41 global search: live results (200ms
//     debounce) from GET /api/search?q= grouped by chat with <mark>ed
//     snippets, Enter opens the first hit, ↑/↓ walk, Esc closes
//   · the Aa / Exact chips (v0.42) ride the input — the SHARED find
//     options blob globalsearch.js owns (the in-chat find bar reads the
//     same state)
//
// PICK MODE (v0.52 item 5): ChatsView.openPicker(onPick) renders the
// same surface, but tapping a row calls onPick({session_id, title, …})
// instead of opening the chat — the public library's chat pill uses this
// to connect a chat to the library.
//
// The view still rides the MASTER PANEL's stack (panel.js pushView — the
// house pattern; a bare canvas gets a host panel first, exactly like
// search + the hub always did).
//
// Exposes: window.ChatsView = { open, openPicker }
(function () {
  'use strict';

  var PROVIDER_COLORS = {
    nvidia: '#76B900', openai: '#10A37F', anthropic: '#D97706',
    openrouter: '#7C3AED', opencode: '#00D9A0', privatemodeai: '#9333EA',
    cloudflare: '#F38020', groq: '#F55036', together: '#0F6FFF',
    mistral: '#FF7000', deepseek: '#4D6BFE'
  };

  var DEBOUNCE_MS = 200;
  var seq = 0; // in-flight search guard (stale responses never paint)

  // ── theming: one injected stylesheet, all classes, no inline soup ──
  var styleEl = null;
  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = 'cv-style';
    styleEl.textContent = [
      '.cv-root { padding: 12px 14px 18px; display: flex; flex-direction: column; gap: 10px; }',
      '.cv-count { font-size: var(--ui-micro-fs); color: var(--text-3); margin: -2px 2px 0; }',
      // v0.52: the merged search row (the globalsearch pattern, cv-ified)
      '.cv-searchrow { display: flex; align-items: stretch; gap: 8px; }',
      '.cv-searchbox { position: relative; display: flex; align-items: center; flex: 1; min-width: 0; }',
      '.cv-searchbox .cv-glyph {',
      '  position: absolute; left: 12px; width: 15px; height: 15px; color: var(--text-3);',
      '  pointer-events: none; transition: color .16s ease; }',
      '.cv-searchbox:focus-within .cv-glyph { color: var(--accent); }',
      '.cv-input {',
      '  width: 100%; box-sizing: border-box;',
      '  padding: 11px 38px 11px 36px;',
      '  font: inherit; font-size: var(--ui-fs); color: var(--text-1);',
      '  background: var(--surface-1);',
      '  border: 1px solid var(--surface-2); border-radius: 12px;',
      '  outline: none; transition: border-color .16s ease, box-shadow .16s ease; }',
      '.cv-input::placeholder { color: var(--text-3); }',
      '.cv-input:focus {',
      '  border-color: rgba(var(--accent-rgb), .55);',
      '  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), .14); }',
      '.cv-count-chip {',
      '  position: absolute; right: 10px; font-size: var(--ui-micro-fs);',
      '  color: var(--text-3); background: var(--surface-2);',
      '  border-radius: 8px; padding: 3px 8px; pointer-events: none; }',
      '.cv-count-chip:empty { display: none; }',
      '.cv-opts { display: flex; gap: 6px; flex-shrink: 0; }',
      '.cv-chip {',
      '  min-width: 44px; min-height: 44px; padding: 0 10px; margin: 0;',
      '  font: inherit; font-size: var(--ui-small-fs); font-weight: 700;',
      '  color: var(--text-3); background: var(--surface-1);',
      '  border: 1px solid var(--surface-2); border-radius: 12px; cursor: pointer;',
      '  transition: border-color .16s ease, color .16s ease, background .16s ease; }',
      '.cv-chip:hover { border-color: var(--border-strong); }',
      '.cv-chip[aria-pressed="true"] {',
      '  color: var(--accent); background: rgba(var(--accent-rgb), .12);',
      '  border-color: rgba(var(--accent-rgb), .55); }',
      '.cv-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
      '.cv-chip .cv-chip-sub { display: block; font-size: calc(var(--ui-micro-fs) - 1px);',
      '  font-weight: 600; color: var(--text-3); margin-top: 1px; }',
      '.cv-chip[aria-pressed="true"] .cv-chip-sub { color: var(--accent); }',
      '.cv-hint { font-size: var(--ui-micro-fs); color: var(--text-3); margin: -2px 2px 0; }',
      '.cv-section { border: 1px solid var(--surface-2); border-radius: 12px; overflow: hidden;',
      '  background: var(--surface-1); transition: border-color .16s ease; }',
      '.cv-section:hover { border-color: rgba(var(--accent-rgb), .35); }',
      '.cv-section + .cv-section { margin-top: 10px; }',
      '.cv-section-title { display: flex; align-items: center; gap: 8px; padding: 9px 12px;',
      '  font-size: calc(var(--ui-micro-fs) + 0.5px); font-weight: 700; letter-spacing: .07em;',
      '  text-transform: uppercase; color: var(--text-2);',
      '  background: linear-gradient(180deg, var(--surface-2), transparent);',
      '  border-bottom: 1px solid var(--surface-2); }',
      '.cv-section-title .cv-sec-count { margin-left: auto; font-weight: 500;',
      '  letter-spacing: 0; color: var(--text-3); background: var(--surface-2);',
      '  border-radius: 999px; padding: 1px 8px; }',
      '.cv-row { display: block; width: 100%; text-align: left; padding: 10px 12px;',
      '  font: inherit; color: var(--text-2); background: transparent; border: 0;',
      '  cursor: pointer; transition: background .14s ease; }',
      '.cv-row + .cv-row { border-top: 1px solid var(--surface-2); }',
      '.cv-row:hover, .cv-row:focus-visible { background: rgba(var(--accent-rgb), .10); outline: none; }',
      '.cv-row:active { background: rgba(var(--accent-rgb), .18); }',
      '.cv-topline { display: flex; align-items: baseline; gap: 8px; }',
      '.cv-name { flex: 1; min-width: 0; font-size: var(--ui-small-fs); font-weight: 600;',
      '  color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.cv-time { font-size: var(--ui-micro-fs); color: var(--text-3); flex-shrink: 0; }',
      '.cv-preview { font-size: var(--ui-small-fs); color: var(--text-3); line-height: 1.5;',
      '  margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.cv-preview .cv-role { display: inline-block; font-size: calc(var(--ui-micro-fs) - 1px);',
      '  font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-right: 6px; }',
      '.cv-preview.cv-role-user .cv-role { color: var(--notice); }',
      '.cv-preview.cv-role-assistant .cv-role { color: var(--accent); }',
      '.cv-meta { display: flex; align-items: center; gap: 5px; margin-top: 7px;',
      '  font-size: calc(var(--ui-micro-fs) - 0.5px); color: var(--text-3); flex-wrap: wrap; }',
      '.cv-badge { display: inline-flex; align-items: center; gap: 5px;',
      '  background: var(--surface-2); border-radius: 999px; padding: 2px 8px;',
      '  max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.cv-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }',
      '.cv-tag { background: rgba(var(--accent-rgb), .14); color: var(--accent);',
      '  border-radius: 999px; padding: 2px 8px; font-weight: 600; }',
      '.cv-nmsgs { margin-left: auto; flex-shrink: 0; }',
      // search result hits (grouped by chat, marked snippets)
      '.cv-hit { display: block; width: 100%; text-align: left; padding: 9px 12px;',
      '  font: inherit; color: var(--text-2); background: transparent; border: 0;',
      '  cursor: pointer; transition: background .14s ease; }',
      '.cv-hit + .cv-hit { border-top: 1px solid var(--surface-2); }',
      '.cv-hit:hover, .cv-hit:focus-visible { background: rgba(var(--accent-rgb), .10); outline: none; }',
      '.cv-hit .cv-role { display: inline-block; font-size: calc(var(--ui-micro-fs) - 1px);',
      '  font-weight: 700; letter-spacing: .04em; text-transform: uppercase;',
      '  color: var(--text-3); margin-right: 6px; vertical-align: baseline; }',
      '.cv-hit.cv-role-user .cv-role { color: var(--notice); }',
      '.cv-hit.cv-role-assistant .cv-role { color: var(--accent); }',
      '.cv-snip { font-size: var(--ui-small-fs); line-height: 1.45; word-break: break-word; }',
      '.cv-snip mark { background: rgba(var(--accent-rgb), .28);',
      '  color: var(--text-1); border-radius: 3px; padding: 0 1px; }',
      '.cv-empty { text-align: center; padding: 26px 14px; color: var(--text-3);',
      '  font-size: var(--ui-small-fs); line-height: 1.5; }',
      '.cv-empty .cv-empty-glyph { display: block; font-size: 22px; margin-bottom: 6px; opacity: .75; }',
      '.cv-loading { display: flex; align-items: center; justify-content: center; gap: 8px;',
      '  padding: 18px; color: var(--text-3); font-size: var(--ui-small-fs); }',
      '.cv-spinner { width: 13px; height: 13px; border-radius: 50%;',
      '  border: 2px solid var(--surface-2); border-top-color: var(--accent);',
      '  animation: cv-spin .7s linear infinite; }',
      '@keyframes cv-spin { to { transform: rotate(360deg); } }',
      // staggered section entrance — the index slides in like a ledger
      '@keyframes cv-rise { from { opacity: 0; transform: translateY(7px); }',
      '  to { opacity: 1; transform: none; } }',
      '.cv-section { animation: cv-rise .26s cubic-bezier(0.32, 0.72, 0, 1) both; }',
      '.cv-section:nth-child(1) { animation-delay: .02s; }',
      '.cv-section:nth-child(2) { animation-delay: .07s; }',
      '.cv-section:nth-child(3) { animation-delay: .12s; }',
      '.cv-section:nth-child(4) { animation-delay: .17s; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .cv-spinner { animation-duration: 1.6s; }',
      '  .cv-section, .cv-row, .cv-input { animation: none; transition: none; }',
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

  // "nvidia/openai/gpt-oss-20b" → "gpt-oss-20b" (the badge stays short)
  function shortModel(m) {
    var s = String(m || '');
    var i = s.lastIndexOf('/');
    return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
  }

  function providerColor(p) {
    return PROVIDER_COLORS[String(p || '').toLowerCase()] || 'var(--text-3)';
  }

  // date bucket: 0 today · 1 yesterday · 2 previous 7 days · 3 older
  function bucketOf(ts) {
    var d = new Date((Number(ts) || 0) * 1000);
    var now = new Date();
    var startOf = function (x) { x.setHours(0, 0, 0, 0); return x; };
    var t = startOf(d).getTime();
    var today = startOf(new Date()).getTime();
    if (t === today) return 0;
    if (t === today - 86400000) return 1;
    if (t > today - 7 * 86400000) return 2;
    return 3;
  }
  var BUCKET_TITLES = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

  function rowHTML(c, pickMode, connectedSid) {
    var preview = '';
    if (c.preview) {
      preview = '<div class="cv-preview cv-role-' + esc(c.preview_role || 'user') + '">' +
        '<span class="cv-role">' + esc(c.preview_role === 'assistant' ? 'ai' : 'you') + '</span>' +
        esc(c.preview) + '</div>';
    } else {
      preview = '<div class="cv-preview" style="opacity:.6">no messages yet</div>';
    }
    var tag = '';
    if (c.sandbox && c.sandbox !== 'quick') {
      tag = '<span class="cv-tag">' + esc(c.sandbox) + '</span>';
    }
    // pick mode: show which chat is currently connected
    var mark = (pickMode && connectedSid && c.session_id === connectedSid)
      ? '<span class="cv-tag" style="background:rgba(var(--ok-rgb),0.14);color:var(--ok)">✓ connected</span>' : '';
    return '<button class="cv-row" data-cv-sid="' + esc(c.session_id) + '" data-cv-title="' + escAttr(c.title || '') + '">' +
      '<div class="cv-topline">' +
        '<span class="cv-name">' + esc(c.title || 'Untitled chat') + '</span>' +
        '<span class="cv-time">' + esc(relTime(c.updated_at)) + '</span>' +
      '</div>' + preview +
      '<div class="cv-meta">' +
        '<span class="cv-badge" title="' + esc(c.model || '') + '">' +
          '<span class="cv-dot" style="background:' + providerColor(c.provider) + '"></span>' +
          esc(shortModel(c.model) || c.provider || '—') +
        '</span>' + tag + mark +
        '<span class="cv-nmsgs">' + esc(String(c.msg_count || 0)) + ' msg' + (c.msg_count === 1 ? '' : 's') + '</span>' +
      '</div>' +
    '</button>';
  }

  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function sectionHTML(title, chats, pickMode, connectedSid) {
    var rows = '';
    for (var i = 0; i < chats.length; i++) rows += rowHTML(chats[i], pickMode, connectedSid);
    return '<div class="cv-section">' +
      '<div class="cv-section-title">' + esc(title) +
        '<span class="cv-sec-count">' + chats.length + '</span>' +
      '</div>' + rows + '</div>';
  }

  function emptyHTML(msg, glyph) {
    return '<div class="cv-empty"><span class="cv-empty-glyph">' + (glyph || '💬') + '</span>' + esc(msg) + '</div>';
  }

  function renderChats(listEl, countEl, chats, pickMode, connectedSid) {
    if (!chats.length) {
      countEl.textContent = '';
      listEl.innerHTML = emptyHTML(pickMode
        ? 'No conversations yet — there is nothing to connect.'
        : 'No conversations yet — tap a chatbot on the canvas to start one.', '💬');
      return;
    }
    var buckets = [[], [], [], []];
    for (var i = 0; i < chats.length; i++) {
      buckets[bucketOf(chats[i].updated_at)].push(chats[i]);
    }
    var html = '';
    for (var b = 0; b < 4; b++) {
      if (buckets[b].length) html += sectionHTML(BUCKET_TITLES[b], buckets[b], pickMode, connectedSid);
    }
    countEl.textContent = chats.length + (chats.length === 1 ? ' chat' : ' chats');
    listEl.innerHTML = html;
  }

  // ── the search-result painters (globalsearch.js's pattern, in cv- classes) ──

  // shared find options + predicate live in globalsearch.js — the in-chat
  // find bar reads the same blob, so the chips stay in sync everywhere.
  function findOpts() {
    return (window.GlobalSearch && window.GlobalSearch.findOpts)
      ? window.GlobalSearch.findOpts() : { caseSensitive: false, exact: false };
  }
  function setFindOpts(o) {
    return (window.GlobalSearch && window.GlobalSearch.setFindOpts)
      ? window.GlobalSearch.setFindOpts(o) : o;
  }
  function findMatches(text, q, opts) {
    return (window.GlobalSearch && window.GlobalSearch.findMatches)
      ? window.GlobalSearch.findMatches(text, q, opts) : [];
  }

  function snipHTML(text, matchStart, q, opts) {
    var t = String(text || '');
    var s = Math.max(0, Math.min(t.length, matchStart | 0));
    var e = Math.min(t.length, s + String(q || '').length);
    if (opts && (opts.caseSensitive || opts.exact)) {
      var hits = findMatches(t, q, opts);
      if (hits.length) { s = hits[0].idx; e = s + hits[0].len; }
      else { s = e = 0; }
    }
    return esc(t.slice(0, s)) + '<mark>' + esc(t.slice(s, e)) + '</mark>' + esc(t.slice(e));
  }

  function groupHTML(g, q, opts) {
    var hits = '';
    for (var i = 0; i < g.matches.length; i++) {
      var m = g.matches[i];
      hits += '<button class="cv-hit cv-role-' + esc(m.role) + '" data-cv-sid="' + esc(g.session_id) +
        '" data-cv-ei="' + esc(String(m.id)) + '" data-cv-title="' + escAttr(g.title || '') + '">' +
        '<span class="cv-role">' + esc(m.role === 'user' ? 'you' : 'ai') + '</span>' +
        '<span class="cv-snip">' + snipHTML(m.snippet, m.match_start, q, opts) + '</span>' +
        '</button>';
    }
    return '<div class="cv-section" data-cv-group="' + esc(g.session_id) + '">' +
      '<div class="cv-section-title">' +
        '<span class="cv-name">' + esc(g.title || 'Untitled chat') + '</span>' +
        '<span class="cv-time">' + esc(relTime(g.updated_at)) + '</span>' +
      '</div>' + hits + '</div>';
  }

  // ── open (browse mode) / openPicker (connect mode) ──────────────────

  function open() { openWith(null); }

  function openPicker(onPick) { openWith({ onPick: onPick }); }

  function openWith(mode) {
    ensureStyle();
    var panel = (window.ChatPanel && window.ChatPanel.current() || {}).panel;
    var hostReady = panel && panel.isOpen && panel.isOpen();
    var start = function () {
      // panel may have been re-created by the host open — re-resolve
      var p = (window.ChatPanel && window.ChatPanel.current() || {}).panel;
      if (!p) return;
      mountView(p, mode);
    };
    if (!hostReady) {
      // No live panel. The index is SELF-SUFFICIENT: if the engine has
      // ANY session, host the view on the most recent one (materializing
      // its icon exactly like a search jump does). Zero sessions is the
      // only honest "no chats yet".
      if (!window.doomalay || !window.doomalay.openChatBySession) return;
      fetch('/api/chats')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var chats = (d && d.chats) || [];
          if (chats.length) {
            return Promise.resolve(window.doomalay.openChatBySession(chats[0].session_id, {}));
          }
          return Promise.resolve(window.doomalay.openChatBySession(null, {})); // any icon
        })
        .then(function (ok) {
          if (!ok) { toastNoHost(); return; }
          setTimeout(start, 60);
        })
        .catch(function () { toastNoHost(); });
      return;
    }
    start();
  }

  function toastNoHost() {
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

  function mountView(panel, mode) {
    var pickMode = !!(mode && mode.onPick);
    var onPick = pickMode ? mode.onPick : null;
    var connectedSid = (mode && mode.connectedSid) || '';
    var mySeq = ++seq;
    var debounceT = null;

    panel.pushView({
      title: pickMode ? 'pick a chat' : 'all chats',
      render: function () {
        var o = findOpts();
        return '<div class="cv-root">' +
          '<div class="cv-searchrow">' +
            '<div class="cv-searchbox">' +
              '<svg class="cv-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
                '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.5 15.5 L20.5 20.5"></path></svg>' +
              '<input id="cv-input" class="cv-input" type="text" inputmode="search" autocomplete="off" ' +
                'spellcheck="false" placeholder="' + (pickMode ? 'Search or pick a chat to connect…' : 'Search every conversation…') +
                '" aria-label="Search all chats">' +
              '<span id="cv-count-chip" class="cv-count-chip" aria-live="polite"></span>' +
            '</div>' +
            '<div class="cv-opts" role="group" aria-label="Match options">' +
              '<button id="cv-opt-aa" class="cv-chip" type="button" aria-pressed="' + (o.caseSensitive ? 'true' : 'false') + '" ' +
                'title="Case-sensitive matching" aria-label="Case-sensitive matching">Aa' +
                '<span class="cv-chip-sub">case</span></button>' +
              '<button id="cv-opt-exact" class="cv-chip" type="button" aria-pressed="' + (o.exact ? 'true' : 'false') + '" ' +
                'title="Whole-word exact match" aria-label="Whole-word exact match">Exact' +
                '<span class="cv-chip-sub">word</span></button>' +
            '</div>' +
          '</div>' +
          '<div id="cv-count" class="cv-count" aria-live="polite"></div>' +
          '<div id="cv-list">' +
            '<div class="cv-loading"><span class="cv-spinner"></span>loading chats…</div>' +
          '</div>' +
        '</div>';
      },
      onMount: function () {
        var input = document.getElementById('cv-input');
        var countEl = document.getElementById('cv-count');
        var chipEl = document.getElementById('cv-count-chip');
        var listEl = document.getElementById('cv-list');
        var aaBtn = document.getElementById('cv-opt-aa');
        var exBtn = document.getElementById('cv-opt-exact');
        if (!listEl || !countEl) return;

        function paintChips(o) {
          if (aaBtn) aaBtn.setAttribute('aria-pressed', o.caseSensitive ? 'true' : 'false');
          if (exBtn) exBtn.setAttribute('aria-pressed', o.exact ? 'true' : 'false');
        }
        function chipTap(key) {
          var o = findOpts();
          o[key] = !o[key];
          paintChips(setFindOpts(o));
          clearTimeout(debounceT);
          runSearch();
        }
        if (aaBtn) aaBtn.addEventListener('click', function () { chipTap('caseSensitive'); });
        if (exBtn) exBtn.addEventListener('click', function () { chipTap('exact'); });
        paintChips(findOpts());

        // ── the index (empty query) ───────────────────────────────────
        var chatsCache = null;
        function loadIndex() {
          fetch('/api/chats')
            .then(function (r) { return r.ok ? r.json() : { error: 'HTTP ' + r.status }; })
            .then(function (d) {
              if (!d || d.error) {
                countEl.textContent = '';
                listEl.innerHTML = emptyHTML(d && d.error ? d.error : 'Could not load chats.', '⚠️');
                return;
              }
              chatsCache = (d && d.chats) || [];
              renderChats(listEl, countEl, chatsCache, pickMode, connectedSid);
            })
            .catch(function () {
              countEl.textContent = '';
              listEl.innerHTML = emptyHTML('Could not load chats — is the engine running?', '⚠️');
            });
        }
        loadIndex();

        // ── the live search (typing) ──────────────────────────────────
        function runSearch() {
          var q = (input && input.value || '').trim();
          var opts = findOpts();
          if (q.length < 2) {
            mySeq++; // invalidate in-flight
            if (chipEl) chipEl.textContent = '';
            if (chatsCache) renderChats(listEl, countEl, chatsCache, pickMode, connectedSid);
            else loadIndex();
            return;
          }
          var thisSeq = ++mySeq;
          listEl.innerHTML = '<div class="cv-loading"><span class="cv-spinner"></span>searching…</div>';
          countEl.textContent = '';
          fetch('/api/search?q=' + encodeURIComponent(q))
            .then(function (r) { return r.ok ? r.json() : { error: 'HTTP ' + r.status }; })
            .then(function (d) {
              if (thisSeq !== mySeq) return; // a newer keystroke won
              if (d && d.error) {
                if (chipEl) chipEl.textContent = '';
                listEl.innerHTML = emptyHTML(d.error, '⚠️');
                return;
              }
              var groups = (d && d.results) || [];
              // the engine is case-insensitive substring ONLY — post-filter
              // on the snippets with the shared predicate when a toggle is on
              if (opts.caseSensitive || opts.exact) {
                groups = groups.map(function (g) {
                  var kept = g.matches.filter(function (m) {
                    return findMatches(m.snippet, d.query || q, opts).length > 0;
                  });
                  return {
                    session_id: g.session_id, title: g.title, model: g.model,
                    provider: g.provider, updated_at: g.updated_at, matches: kept
                  };
                }).filter(function (g) { return g.matches.length > 0; });
              }
              if (!groups.length) {
                if (chipEl) chipEl.textContent = '0';
                listEl.innerHTML = emptyHTML('No chat mentions "' + q + '"' +
                  (opts.caseSensitive || opts.exact ? ' with these match options' : '') + '.', '🦀');
                return;
              }
              var total = 0;
              var html = '';
              for (var i = 0; i < groups.length; i++) total += groups[i].matches.length;
              for (var j = 0; j < groups.length; j++) html += groupHTML(groups[j], d.query || q, opts);
              if (chipEl) chipEl.textContent = groups.length + (groups.length === 1 ? ' chat' : ' chats') + ' · ' + total;
              listEl.innerHTML = html;
            })
            .catch(function () {
              if (thisSeq !== mySeq) return;
              listEl.innerHTML = emptyHTML('Search failed — is the engine running?', '⚠️');
            });
        }

        if (input) input.addEventListener('input', function () {
          clearTimeout(debounceT);
          debounceT = setTimeout(runSearch, DEBOUNCE_MS);
        });
        if (input) input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            var first = listEl.querySelector('.cv-hit') || listEl.querySelector('.cv-row');
            if (first) first.click();
          } else if (e.key === 'Escape') {
            if (panel.popView) panel.popView();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            var f2 = listEl.querySelector('.cv-hit');
            if (f2) f2.focus();
          }
        });
        // walk results with ↑/↓ across the whole result set
        listEl.addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          var rows = Array.prototype.slice.call(listEl.querySelectorAll('.cv-hit, .cv-row'));
          var idx = rows.indexOf(document.activeElement);
          var next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
          if (next < 0) { try { if (input) input.focus(); } catch (er) {} return; }
          if (next >= rows.length) next = 0;
          try { rows[next].focus(); } catch (er) {}
        });

        // tap a row / hit → open that chat (or HAND IT TO the picker).
        // openChatBySession materializes an icon for icon-less sessions.
        listEl.addEventListener('click', function (e) {
          var hit = e.target.closest && (e.target.closest('.cv-hit') || e.target.closest('.cv-row'));
          if (!hit) return;
          var sid = hit.getAttribute('data-cv-sid');
          var title = hit.getAttribute('data-cv-title') || '';
          if (!sid) return;
          try { if (navigator.vibrate) navigator.vibrate(10); } catch (er) {}
          if (pickMode && onPick) {
            if (panel.popView) panel.popView();
            onPick({ session_id: sid, title: title });
            return;
          }
          if (!window.doomalay || !window.doomalay.openChatBySession) return;
          var ei = hit.getAttribute('data-cv-ei');
          Promise.resolve(window.doomalay.openChatBySession(sid, { ei: ei ? Number(ei) : null }));
        });
      },
      onClose: function () {
        clearTimeout(debounceT);
        mySeq++; // any in-flight response is stale now
      }
    });
  }

  window.ChatsView = { open: open, openPicker: openPicker };
})();
