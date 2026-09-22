// chatsview.js — v0.42 THE ALL-CHATS INDEX.
//
// The canvas shows chats as icons — but icons get deleted while their
// sessions live on, deep-research chats never materialize one until
// jumped to, and "which conversations do I even have?" was scroll-hunt
// across the canvas. This is the browse surface: every session, most
// recently active first, each with a one-line preview of where it left
// off — the WhatsApp/Telegram sidebar pattern adapted to the canvas.
//
// UX:
//   · dock 💬 glyph → the view rides the MASTER PANEL's stack (the
//     exact pattern global search + the hub use; a bare canvas gets a
//     host panel first)
//   · date sections: Today / Yesterday / Previous 7 days / Older
//   · row = chat name + provider badge + one-line preview + relative
//     time + visible message count; tapping opens that chat
//     (openChatBySession materializes an icon when missing)
//   · fresh data on every open; loading / empty / error states
//
// Exposes: window.ChatsView = { open }
(function () {
  'use strict';

  var PROVIDER_COLORS = {
    nvidia: '#76B900', openai: '#10A37F', anthropic: '#D97706',
    openrouter: '#7C3AED', opencode: '#00D9A0', privatemodeai: '#9333EA',
    cloudflare: '#F38020', groq: '#F55036', together: '#0F6FFF',
    mistral: '#FF7000', deepseek: '#4D6BFE'
  };

  // ── theming: one injected stylesheet, all classes, no inline soup ──
  var styleEl = null;
  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = 'cv-style';
    styleEl.textContent = [
      '.cv-root { padding: 12px 14px 18px; display: flex; flex-direction: column; gap: 10px; }',
      '.cv-count { font-size: var(--ui-micro-fs); color: var(--text-3); margin: -2px 2px 0; }',
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
      '  .cv-section, .cv-row { animation: none; transition: none; }',
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

  function rowHTML(c) {
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
    return '<button class="cv-row" data-cv-sid="' + esc(c.session_id) + '">' +
      '<div class="cv-topline">' +
        '<span class="cv-name">' + esc(c.title || 'Untitled chat') + '</span>' +
        '<span class="cv-time">' + esc(relTime(c.updated_at)) + '</span>' +
      '</div>' + preview +
      '<div class="cv-meta">' +
        '<span class="cv-badge" title="' + esc(c.model || '') + '">' +
          '<span class="cv-dot" style="background:' + providerColor(c.provider) + '"></span>' +
          esc(shortModel(c.model) || c.provider || '—') +
        '</span>' + tag +
        '<span class="cv-nmsgs">' + esc(String(c.msg_count || 0)) + ' msg' + (c.msg_count === 1 ? '' : 's') + '</span>' +
      '</div>' +
    '</button>';
  }

  function sectionHTML(title, chats) {
    var rows = '';
    for (var i = 0; i < chats.length; i++) rows += rowHTML(chats[i]);
    return '<div class="cv-section">' +
      '<div class="cv-section-title">' + esc(title) +
        '<span class="cv-sec-count">' + chats.length + '</span>' +
      '</div>' + rows + '</div>';
  }

  function emptyHTML(msg, glyph) {
    return '<div class="cv-empty"><span class="cv-empty-glyph">' + (glyph || '💬') + '</span>' + esc(msg) + '</div>';
  }

  function renderChats(listEl, countEl, chats) {
    if (!chats.length) {
      countEl.textContent = '';
      listEl.innerHTML = emptyHTML('No conversations yet — tap a chatbot on the canvas to start one.', '💬');
      return;
    }
    var buckets = [[], [], [], []];
    for (var i = 0; i < chats.length; i++) {
      buckets[bucketOf(chats[i].updated_at)].push(chats[i]);
    }
    var html = '';
    for (var b = 0; b < 4; b++) {
      if (buckets[b].length) html += sectionHTML(BUCKET_TITLES[b], buckets[b]);
    }
    countEl.textContent = chats.length + (chats.length === 1 ? ' chat' : ' chats');
    listEl.innerHTML = html;
  }

  function open() {
    ensureStyle();
    var panel = (window.ChatPanel && window.ChatPanel.current() || {}).panel;
    var hostReady = panel && panel.isOpen && panel.isOpen();
    var start = function () {
      var p = (window.ChatPanel && window.ChatPanel.current() || {}).panel;
      if (!p) return;
      mountView(p);
    };
    if (!hostReady) {
      // No live panel. The index is SELF-SUFFICIENT: if the engine has
      // ANY session, host the view on the most recent one (materializing
      // its icon exactly like a search jump does — an empty canvas with
      // sessions in the DB is precisely when this browse surface earns
      // its keep). Zero sessions is the only honest "no chats yet".
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

  function mountView(panel) {
    panel.pushView({
      title: 'all chats',
      render: function () {
        return '<div class="cv-root">' +
          '<div id="cv-count" class="cv-count" aria-live="polite"></div>' +
          '<div id="cv-list">' +
            '<div class="cv-loading"><span class="cv-spinner"></span>loading chats…</div>' +
          '</div>' +
        '</div>';
      },
      onMount: function () {
        var listEl = document.getElementById('cv-list');
        var countEl = document.getElementById('cv-count');
        if (!listEl || !countEl) return;

        fetch('/api/chats')
          .then(function (r) { return r.ok ? r.json() : { error: 'HTTP ' + r.status }; })
          .then(function (d) {
            if (!d || d.error) {
              countEl.textContent = '';
              listEl.innerHTML = emptyHTML(d && d.error ? d.error : 'Could not load chats.', '⚠️');
              return;
            }
            renderChats(listEl, countEl, (d && d.chats) || []);
          })
          .catch(function () {
            countEl.textContent = '';
            listEl.innerHTML = emptyHTML('Could not load chats — is the engine running?', '⚠️');
          });

        // tap a row → open that chat (openChatBySession materializes
        // an icon for icon-less sessions — the same path search uses).
        listEl.addEventListener('click', function (e) {
          var row = e.target.closest && e.target.closest('.cv-row');
          if (!row) return;
          var sid = row.getAttribute('data-cv-sid');
          if (!window.doomalay || !window.doomalay.openChatBySession) return;
          try { if (navigator.vibrate) navigator.vibrate(10); } catch (er) {}
          Promise.resolve(window.doomalay.openChatBySession(sid, {}));
        });
      },
      onClose: function () {}
    });
  }

  window.ChatsView = { open: open };
})();
