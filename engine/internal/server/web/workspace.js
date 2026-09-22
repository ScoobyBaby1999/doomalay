// workspace.js — v0.44 THE WORKSPACES WAVE (user spec #3): cloud repos in
// quick chat.
//
// WHAT THE USER ASKED FOR: "add a pill with '+workspace' in the header or
// collapsible metadata of the chat. Clicking this brings a drop-down or an
// overlay UI that shows a quick list of the connected workspaces for that
// specific chatbot. Then at the bottom of the list we add a default row
// connect workspace, that brings up an overlay similar to the cloud
// provider overlay but with different options, for the first option we
// have Cloud Workspace, this one connects generic urls like GitHub repos,
// or other repos like gitea… A simple url should connect the repo and
// allow the LLM to view it as read only… a difference between read only,
// partial access, and full access…"
//
// SURFACE:
//   +workspace pill (chatpanel pill-row) → THIS picker overlay:
//     · bound workspace rows (kind icon, name, branch, ACCESS BADGE,
//       expandable actions: open in drawer / browser, disconnect)
//     · "+ connect workspace" default row → the connect page:
//         ☁ Cloud Workspace    URL + optional token (access upgrades)
//         ✚ create new repo    name/desc/license/gitignore/private
//         ⌂ my repos           (token account's repos, one-tap connect)
//         ⋯ local folder / device storage — coming soon (the spec's other
//           options, intentionally inert placeholders)
//   Artifacts drawer: a "☁ cloud" section per bound repo (lazy tree from
//   the engine; tap a file → viewer; full access → editor with API-commit
//   save). The repo is NEVER downloaded to the device — rows fetch on
//   demand from the forge via the engine.
//
// API (engine workspaces.go): see the REST map in that file's header.
// Exposes: window.Workspace { pill, openPicker, refreshBound, drawerSection,
//           openCloudFile, toast }
(function () {
  'use strict';

  var esc = window.Formatter ? window.Formatter.esc : function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ── styles (injected once) ────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('ws-v44-styles')) return;
    var s = document.createElement('style');
    s.id = 'ws-v44-styles';
    s.textContent =
      '.wsx{font-size:var(--ui-fs);color:var(--text-1)}' +
      '.wsx-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;' +
        'border-bottom:1px solid var(--surface-2)}' +
      '.wsx-title{flex:1;font-size:calc(var(--ui-fs) + 1px);font-weight:700}' +
      '.wsx-sub{font-size:var(--ui-small-fs);color:var(--text-3);padding:8px 16px 2px;line-height:1.45}' +
      '.wsx-list{padding:6px 10px 4px}' +
      '.wsx-row{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 10px;' +
        'border-radius:12px;cursor:pointer;-webkit-tap-highlight-color:transparent;' +
        'touch-action:manipulation}' +
      '.wsx-row:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      '.wsx-ico{flex-shrink:0;width:28px;height:28px;border-radius:8px;display:flex;' +
        'align-items:center;justify-content:center;font-size:15px;' +
        'background:var(--surface-2);border:1px solid var(--surface-3)}' +
      '.wsx-mid{flex:1;min-width:0}' +
      '.wsx-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.wsx-meta{font-size:var(--ui-small-fs);color:var(--text-3);overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;margin-top:1px}' +
      '.wsx-badge{flex-shrink:0;font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;' +
        'padding:3px 8px;border-radius:999px;border:1px solid}' +
      '.wsx-badge.read{color:var(--text-3);border-color:var(--border);' +
        'background:rgba(var(--surface-3-rgb),0.35)}' +
      '.wsx-badge.partial{color:var(--warn);border-color:rgba(var(--warn-rgb),0.55);' +
        'background:rgba(var(--warn-rgb),0.08)}' +
      '.wsx-badge.full{color:var(--ok);border-color:rgba(var(--ok-rgb),0.55);' +
        'background:rgba(var(--ok-rgb),0.08)}' +
      '.wsx-conn{margin:10px 12px 4px;display:flex;align-items:center;gap:10px;' +
        'min-height:52px;padding:10px 12px;border-radius:12px;cursor:pointer;' +
        'border:1.5px dashed var(--border-strong);color:var(--accent-2);font-weight:600;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-conn:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      '.wsx-acts{display:flex;flex-wrap:wrap;gap:6px;padding:2px 10px 10px 48px}' +
      '.wsx-act{background:var(--surface-2);border:1px solid var(--surface-3);color:var(--text-2);' +
        'padding:6px 10px;border-radius:9px;font-size:var(--ui-small-fs);font-family:inherit;' +
        'cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-act.danger{color:var(--err);border-color:rgba(var(--err-rgb),0.4)}' +
      '.wsx-field{margin:10px 16px 0}' +
      '.wsx-label{font-size:var(--ui-small-fs);color:var(--text-3);margin-bottom:5px;font-weight:600}' +
      '.wsx-input{width:100%;box-sizing:border-box;background:var(--surface-2);' +
        'border:1px solid var(--border);border-radius:10px;color:var(--text-1);' +
        'padding:10px 12px;font-size:var(--ui-fs);font-family:inherit;outline:none}' +
      '.wsx-input:focus{border-color:var(--accent-2)}' +
      '.wsx-select{width:100%;background:var(--surface-2);border:1px solid var(--border);' +
        'border-radius:10px;color:var(--text-1);padding:10px 12px;font-size:var(--ui-fs);' +
        'font-family:inherit;outline:none}' +
      '.wsx-go{display:block;width:calc(100% - 32px);margin:16px 16px 8px;padding:12px;' +
        'border-radius:12px;border:none;background:var(--accent-2);color:#04121c;' +
        'font-size:calc(var(--ui-fs));font-weight:700;font-family:inherit;cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-go:disabled{opacity:0.5}' +
      '.wsx-opt{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 12px;' +
        'margin:6px 12px;border-radius:12px;cursor:pointer;' +
        'border:1px solid var(--surface-3);background:var(--surface-1);' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-opt:active{background:var(--surface-2)}' +
      '.wsx-opt .wsx-mid{font-weight:600}' +
      '.wsx-opt .wsx-meta{font-weight:400}' +
      '.wsx-opt[aria-disabled="true"]{opacity:0.45;pointer-events:none}' +
      '.wsx-note{font-size:var(--ui-small-fs);color:var(--text-3);padding:6px 16px 4px;line-height:1.5}' +
      '.wsx-err{color:var(--err);font-size:var(--ui-small-fs);padding:6px 16px;white-space:pre-wrap}' +
      '.wsx-ok{color:var(--ok);font-size:var(--ui-small-fs);padding:6px 16px}' +
      '.wsx-back{background:transparent;border:none;color:var(--accent-2);' +
        'font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;padding:6px 2px}' +
      // drawer cloud section
      '.wsc-sec{margin:10px 4px 2px;padding:7px 10px 5px;border-top:1px solid var(--surface-2);' +
        'font-size:var(--ui-small-fs);font-weight:700;color:var(--text-3);letter-spacing:0.4px}' +
      '.wsc-row{position:relative;display:flex;align-items:center;gap:6px;min-height:44px;' +
        'padding-right:6px;margin:1px 0;border-radius:10px;cursor:pointer;' +
        'padding-left:calc(8px + var(--d,0)*18px);user-select:none;-webkit-user-select:none;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsc-row:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      '.wsc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--text-1);font-weight:500}' +
      '.wsc-size{flex-shrink:0;color:var(--text-3);font-size:calc(var(--ui-small-fs) - 1px)}' +
      // cloud file viewer
      '.wsv-pre{flex:1;overflow:auto;margin:0;padding:12px;background:var(--bg-panel);' +
        'color:var(--text-1);font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'font-size:calc(var(--ui-fs) - 2px);line-height:1.5;white-space:pre;' +
        '-webkit-overflow-scrolling:touch}' +
      '.wsv-ta{flex:1;width:100%;box-sizing:border-box;border:none;outline:none;resize:none;' +
        'padding:12px;background:var(--bg-panel);color:var(--text-1);' +
        'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:calc(var(--ui-fs) - 2px);' +
        'line-height:1.5;-webkit-overflow-scrolling:touch}';
    document.head.appendChild(s);
  }

  // ── API helpers ────────────────────────────────────────────────────────
  function api(path, method, body) {
    var opts = { method: method || 'GET', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function kindIcon(kind) {
    return { github: '🐙', gitea: '🍵', gitlab: '🦊', sourcehut: '🪶', generic: '📦' }[kind] || '📁';
  }

  function toast(msg) {
    if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast(msg);
    else console.log('[workspace]', msg);
  }

  // ── pill badge refresh hooks (like artifacts.js refreshHooks) ──────────
  var pillHooks = [];
  function onPillRefresh(fn) { pillHooks.push(fn); }
  function refreshPills() {
    pillHooks.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  // ── THE PICKER (bound list + connect row) ─────────────────────────────
  var currentPicker = { sessionId: null, chat: null };

  function openPicker(sessionId, chat) {
    ensureStyles();
    currentPicker = { sessionId: sessionId, chat: chat || null };
    window.ConnectOverlay.open(pickerHTML(), {
      onSwap: function () { wirePicker(); }
    });
    loadBound();
  }

  function pickerHTML() {
    return (
      '<div class="wsx">' +
        '<div class="wsx-head">' +
          '<button class="wsx-back" id="wsx-back" style="display:none">‹ back</button>' +
          '<span class="wsx-title">▣ workspaces</span>' +
          '<span class="wsx-badge read" id="wsx-count">…</span>' +
        '</div>' +
        '<div class="wsx-sub" id="wsx-sub">cloud repos this chatbot can see — the agent explores, edits and builds on them per access level.</div>' +
        '<div class="wsx-list" id="wsx-list">' +
          '<div class="wsx-sub">loading…</div>' +
        '</div>' +
        '<div class="wsx-conn" id="wsx-connect" role="button" tabindex="0">' +
          '<span style="font-size:18px">＋</span>' +
          '<span class="wsx-mid">connect workspace' +
            '<div class="wsx-meta">cloud repo URL · create new · my repos</div></span>' +
        '</div>' +
      '</div>');
  }

  function wirePicker() {
    var conn = document.getElementById('wsx-connect');
    if (conn) conn.addEventListener('click', function () { openConnectPage(); });
    var back = document.getElementById('wsx-back');
    if (back) back.addEventListener('click', function () {
      window.ConnectOverlay.replaceContent(pickerHTML(), {
        onSwap: function () { wirePicker(); loadBound(); }
      });
    });
  }

  function loadBound() {
    var sid = currentPicker.sessionId;
    var listEl = document.getElementById('wsx-list');
    var cntEl = document.getElementById('wsx-count');
    if (!listEl) return;
    if (!sid) {
      listEl.innerHTML = '<div class="wsx-sub">connect a model first — workspaces bind to a chat.</div>';
      if (cntEl) cntEl.textContent = '0';
      return;
    }
    api('/api/sessions/' + encodeURIComponent(sid) + '/workspaces').then(function (d) {
      var rows = d.workspaces || [];
      if (cntEl) cntEl.textContent = String(rows.length);
      if (!rows.length) {
        listEl.innerHTML = '<div class="wsx-sub">none yet — connect a cloud repo below (a plain URL works: it becomes read-only).</div>';
        return;
      }
      var html = '';
      rows.forEach(function (ws) { html += boundRowHTML(ws); });
      listEl.innerHTML = html;
      wireBoundRows(listEl, rows);
    }).catch(function (e) {
      listEl.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>';
    });
  }

  function boundRowHTML(ws) {
    var acc = ws.access || 'read';
    var meta = [ws.kind, ws.branch || ws.default_branch || ''].filter(Boolean).join(' · ');
    return (
      '<div class="wsx-row" data-wsid="' + esc(ws.id) + '">' +
        '<span class="wsx-ico">' + kindIcon(ws.kind) + '</span>' +
        '<span class="wsx-mid">' +
          '<span class="wsx-name">' + esc(ws.name || (ws.owner + '/' + ws.repo)) + '</span>' +
          '<div class="wsx-meta">' + esc(meta) + '</div>' +
        '</span>' +
        '<span class="wsx-badge ' + esc(acc) + '">' + esc(acc) + '</span>' +
      '</div>' +
      '<div class="wsx-acts" id="wsx-acts-' + esc(ws.id) + '" style="display:none"></div>');
  }

  function wireBoundRows(listEl, rows) {
    rows.forEach(function (ws) {
      var row = listEl.querySelector('[data-wsid="' + ws.id + '"]');
      if (!row) return;
      var acts = document.getElementById('wsx-acts-' + ws.id);
      row.addEventListener('click', function () {
        if (!acts) return;
        var open = acts.style.display !== 'none';
        acts.style.display = open ? 'none' : '';
        if (!open && !acts.dataset.wired) {
          acts.dataset.wired = '1';
          acts.innerHTML =
            '<button class="wsx-act" data-a="drawer">☁ open in drawer</button>' +
            '<button class="wsx-act" data-a="chat">✦ explore in chat</button>' +
            ((ws.access === 'read' || ws.access === 'partial') ?
              '<button class="wsx-act" data-a="token">🔑 attach token</button>' : '') +
            '<button class="wsx-act" data-a="web">↗ browser</button>' +
            '<button class="wsx-act danger" data-a="unbind">✕ disconnect</button>';
          acts.querySelector('[data-a="drawer"]').addEventListener('click', function () {
            window.ConnectOverlay.close();
            if (window.Artifacts) window.Artifacts.openDrawer(ws.id, { name: 'cloud' });
            else toast('open the artifacts drawer');
          });
          acts.querySelector('[data-a="chat"]').addEventListener('click', function () {
            window.ConnectOverlay.close();
            var inp = document.getElementById('chat-input');
            if (inp) {
              inp.value = 'explore the ' + ws.name + ' workspace: give me the repo brief (structure, readme digest, recent activity)';
              inp.focus();
            }
          });
          var tok = acts.querySelector('[data-a="token"]');
          if (tok) tok.addEventListener('click', function () { openTokenPage(ws); });
          acts.querySelector('[data-a="web"]').addEventListener('click', function () {
            if (ws.repo_url) window.open(ws.repo_url, '_blank');
          });
          acts.querySelector('[data-a="unbind"]').addEventListener('click', function () {
            api('/api/sessions/' + encodeURIComponent(currentPicker.sessionId) +
                '/workspaces/' + encodeURIComponent(ws.id), 'DELETE')
              .then(function () { loadBound(); refreshPills(); toast('disconnected ' + ws.name); })
              .catch(function (e) { toast(e.message); });
          });
        }
      });
    });
  }

  // ── THE CONNECT PAGE ───────────────────────────────────────────────────
  function openConnectPage() {
    window.ConnectOverlay.replaceContent(connectHTML(), {
      onSwap: function () { wireConnectPage(); }
    });
  }

  function connectHTML() {
    return (
      '<div class="wsx">' +
        '<div class="wsx-head">' +
          '<button class="wsx-back" id="wsx-back">‹ workspaces</button>' +
          '<span class="wsx-title">connect workspace</span>' +
        '</div>' +
        '<div class="wsx-opt" id="wso-cloud">' +
          '<span class="wsx-ico">☁</span>' +
          '<span class="wsx-mid">Cloud Workspace' +
            '<div class="wsx-meta">any repo URL — github, gitea, codeberg, gitlab…</div></span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        '<div class="wsx-opt" id="wso-create">' +
          '<span class="wsx-ico">✚</span>' +
          '<span class="wsx-mid">create new repo' +
            '<div class="wsx-meta">from scratch — name, license, gitignore</div></span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        '<div class="wsx-opt" id="wso-discover">' +
          '<span class="wsx-ico">⌂</span>' +
          '<span class="wsx-mid">my repos' +
            '<div class="wsx-meta">your account\'s repos — one tap to connect</div></span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        '<div class="wsx-opt" aria-disabled="true">' +
          '<span class="wsx-ico">▤</span>' +
          '<span class="wsx-mid">local folder<div class="wsx-meta">coming soon</div></span>' +
        '</div>' +
        '<div class="wsx-opt" aria-disabled="true">' +
          '<span class="wsx-ico">📱</span>' +
          '<span class="wsx-mid">device storage<div class="wsx-meta">coming soon</div></span>' +
        '</div>' +
        '<div class="wsx-note">read-only by default — a plain URL is enough. Attach a token for partial (fork + PR) or full (direct commits) access.</div>' +
      '</div>');
  }

  function wireConnectPage() {
    var back = document.getElementById('wsx-back');
    if (back) back.addEventListener('click', openPickerRestore);
    var c = document.getElementById('wso-cloud');
    if (c) c.addEventListener('click', openCloudForm);
    var cr = document.getElementById('wso-create');
    if (cr) cr.addEventListener('click', openCreateForm);
    var d = document.getElementById('wso-discover');
    if (d) d.addEventListener('click', openDiscover);
  }

  function openPickerRestore() {
    window.ConnectOverlay.replaceContent(pickerHTML(), {
      onSwap: function () { wirePicker(); loadBound(); }
    });
  }

  function pageHead(title) {
    return (
      '<div class="wsx-head">' +
        '<button class="wsx-back" id="wsx-back">‹ connect</button>' +
        '<span class="wsx-title">' + esc(title) + '</span>' +
      '</div>');
  }

  function swapTo(html, wire) {
    window.ConnectOverlay.replaceContent('<div class="wsx">' + html + '</div>', {
      onSwap: wire || function () {}
    });
  }

  // ── cloud connect form ─────────────────────────────────────────────────
  function openCloudForm(prefill) {
    swapTo(
      pageHead('☁ cloud workspace') +
      '<div class="wsx-field"><div class="wsx-label">REPO URL</div>' +
        '<input class="wsx-input" id="wsf-url" placeholder="https://github.com/owner/repo" ' +
        'autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(prefill || '') + '"></div>' +
      '<div class="wsx-note" id="wsf-preview">paste any repo URL — the host is recognized automatically</div>' +
      '<div class="wsx-field"><div class="wsx-label">TOKEN (OPTIONAL — UPGRADES ACCESS)</div>' +
        '<input class="wsx-input" id="wsf-token" placeholder="ghp_… / gitea token" ' +
        'autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="wsx-note">no token → read-only · token without push → partial (fork+PR) · token with push → full (direct commits). Tokens are stored in the engine\'s encrypted vault, never in the chat.</div>' +
      '<div class="wsx-err" id="wsf-err" style="display:none"></div>' +
      '<button class="wsx-go" id="wsf-go">connect</button>',
      function () {
        document.getElementById('wsx-back').addEventListener('click', openConnectPage);
        var url = document.getElementById('wsf-url');
        var prev = document.getElementById('wsf-preview');
        url.addEventListener('input', function () {
          var v = url.value.trim();
          if (!v) { prev.textContent = 'paste any repo URL — the host is recognized automatically'; return; }
          var m = v.replace(/^https?:\/\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)\/([\w.-]+)/);
          if (m) prev.textContent = 'recognized: ' + kindIcon(guessKind(m[1])) + ' ' + m[1] + ' · ' + m[2] + '/' + m[3];
          else if (/^[\w.-]+\//.test(v)) prev.textContent = 'looks like a repo path — connecting will probe the host';
          else prev.textContent = 'keep typing…';
        });
        document.getElementById('wsf-go').addEventListener('click', function () {
          var u = url.value.trim();
          var err = document.getElementById('wsf-err');
          err.style.display = 'none';
          if (!u) { err.textContent = 'a URL is required'; err.style.display = ''; return; }
          var go = document.getElementById('wsf-go');
          go.disabled = true; go.textContent = 'connecting…';
          api('/api/workspaces/connect', 'POST', {
            url: u,
            token: document.getElementById('wsf-token').value.trim(),
            session_id: currentPicker.sessionId || ''
          }).then(function (d) {
            refreshPills();
            swapTo(
              pageHead('connected') +
              '<div class="wsx-list"><div class="wsx-row">' +
                '<span class="wsx-ico">' + kindIcon(d.kind) + '</span>' +
                '<span class="wsx-mid"><span class="wsx-name">' + esc(d.name) + '</span>' +
                '<div class="wsx-meta">' + esc(d.kind + ' · ' + (d.branch || '')) + '</div></span>' +
                '<span class="wsx-badge ' + esc(d.access) + '">' + esc(d.access) + '</span>' +
              '</div></div>' +
              '<div class="wsx-ok">access level: ' + esc(d.access) +
                (d.access === 'read' ? ' — attach a token (🔑 in the workspace row) or fork to upgrade.' :
                 d.access === 'partial' ? ' — you can fork + open PRs.' :
                 ' — the agent can commit directly.') + '</div>' +
              '<button class="wsx-go" id="wsx-done">done</button>',
              function () {
                document.getElementById('wsx-back').addEventListener('click', openPickerRestore);
                document.getElementById('wsx-done').addEventListener('click', openPickerRestore);
              });
            toast('connected ' + d.name + ' (' + d.access + ')');
          }).catch(function (e) {
            go.disabled = false; go.textContent = 'connect';
            err.textContent = e.message; err.style.display = '';
          });
        });
      });
  }

  function guessKind(host) {
    host = String(host || '').toLowerCase();
    if (/(^|\.)github\.com$/.test(host)) return 'github';
    if (/(^|\.)gitlab\.com$/.test(host)) return 'gitlab';
    if (/gitea|codeberg/.test(host)) return 'gitea';
    if (/sr\.ht$/.test(host)) return 'sourcehut';
    return 'generic';
  }

  // ── token attach page ──────────────────────────────────────────────────
  function openTokenPage(ws) {
    swapTo(
      pageHead('🔑 attach token — ' + ws.name) +
      '<div class="wsx-field"><div class="wsx-label">FORGE TOKEN</div>' +
        '<input class="wsx-input" id="wst-token" placeholder="paste the repo token" ' +
        'autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="wsx-note">a token with push rights upgrades this workspace to full access (direct API commits). Stored encrypted in the engine vault.</div>' +
      '<div class="wsx-err" id="wst-err" style="display:none"></div>' +
      '<button class="wsx-go" id="wst-go">attach</button>',
      function () {
        document.getElementById('wsx-back').addEventListener('click', openPickerRestore);
        document.getElementById('wst-go').addEventListener('click', function () {
          var t = document.getElementById('wst-token').value.trim();
          var err = document.getElementById('wst-err');
          if (!t) { err.textContent = 'paste a token'; err.style.display = ''; return; }
          api('/api/workspaces/' + encodeURIComponent(ws.id) + '/token', 'POST', { token: t })
            .then(function (d) {
              toast('token attached — access: ' + d.access);
              openPickerRestore();
            })
            .catch(function (e) { err.textContent = e.message; err.style.display = ''; });
        });
      });
  }

  // ── create repo form ───────────────────────────────────────────────────
  function openCreateForm() {
    swapTo(
      pageHead('✚ create new repo') +
      '<div class="wsx-field"><div class="wsx-label">FORGE</div>' +
        '<select class="wsx-select" id="wsc-kind"><option value="github">GitHub</option>' +
        '<option value="gitea">Gitea</option><option value="gitlab">GitLab</option></select></div>' +
      '<div class="wsx-field"><div class="wsx-label">NAME</div>' +
        '<input class="wsx-input" id="wsc-name" placeholder="my-new-repo" autocomplete="off" spellcheck="false"></div>' +
      '<div class="wsx-field"><div class="wsx-label">DESCRIPTION</div>' +
        '<input class="wsx-input" id="wsc-desc" placeholder="what is this repo for?" autocomplete="off"></div>' +
      '<div class="wsx-field"><div class="wsx-label">LICENSE</div>' +
        '<select class="wsx-select" id="wsc-license"><option value="">none</option></select></div>' +
      '<div class="wsx-field"><div class="wsx-label">GITIGNORE</div>' +
        '<select class="wsx-select" id="wsc-gitignore"><option value="">none</option></select></div>' +
      '<div class="wsx-field"><div class="wsx-label">VISIBILITY</div>' +
        '<select class="wsx-select" id="wsc-priv"><option value="public">public</option>' +
        '<option value="private">private</option></select></div>' +
      '<div class="wsx-field"><div class="wsx-label">TOKEN (REQUIRED — the account that owns the new repo)</div>' +
        '<input class="wsx-input" id="wsc-token" placeholder="forge token" autocomplete="off" spellcheck="false"></div>' +
      '<div class="wsx-err" id="wsc-err" style="display:none"></div>' +
      '<button class="wsx-go" id="wsc-go">create + connect</button>',
      function () {
        document.getElementById('wsx-back').addEventListener('click', openConnectPage);
        // populate license/gitignore lists when the forge token appears
        var loadLists = function () {
          var kind = document.getElementById('wsc-kind').value;
          var tok = document.getElementById('wsc-token').value.trim();
          if (!tok) return;
          var q = 'kind=' + encodeURIComponent(kind) +
                  (tok ? '&token=' + encodeURIComponent(tok) : '');
          api('/api/workspaces/licenses?' + q).then(function (d) {
            var sel = document.getElementById('wsc-license');
            (d.licenses || []).forEach(function (l) {
              var o = document.createElement('option'); o.value = l; o.textContent = l;
              sel.appendChild(o);
            });
          }).catch(function () {});
          api('/api/workspaces/gitignores?' + q).then(function (d) {
            var sel = document.getElementById('wsc-gitignore');
            (d.gitignores || []).forEach(function (g) {
              var o = document.createElement('option'); o.value = g; o.textContent = g;
              sel.appendChild(o);
            });
          }).catch(function () {});
        };
        document.getElementById('wsc-token').addEventListener('change', loadLists);
        document.getElementById('wsc-kind').addEventListener('change', loadLists);
        document.getElementById('wsc-go').addEventListener('click', function () {
          var err = document.getElementById('wsc-err');
          err.style.display = 'none';
          var name = document.getElementById('wsc-name').value.trim();
          if (!name) { err.textContent = 'a name is required'; err.style.display = ''; return; }
          var go = document.getElementById('wsc-go');
          go.disabled = true; go.textContent = 'creating…';
          api('/api/workspaces/create-repo', 'POST', {
            kind: document.getElementById('wsc-kind').value,
            name: name,
            description: document.getElementById('wsc-desc').value.trim(),
            license: document.getElementById('wsc-license').value,
            gitignore: document.getElementById('wsc-gitignore').value,
            private: document.getElementById('wsc-priv').value === 'private',
            token: document.getElementById('wsc-token').value.trim(),
            session_id: currentPicker.sessionId || ''
          }).then(function (d) {
            refreshPills();
            toast('created ' + d.name + ' — full access');
            openPickerRestore();
          }).catch(function (e) {
            go.disabled = false; go.textContent = 'create + connect';
            err.textContent = e.message; err.style.display = '';
          });
        });
      });
  }

  // ── discover my repos ──────────────────────────────────────────────────
  function openDiscover() {
    swapTo(
      pageHead('⌂ my repos') +
      '<div class="wsx-field"><div class="wsx-label">FORGE</div>' +
        '<select class="wsx-select" id="wsd-kind"><option value="github">GitHub</option>' +
        '<option value="gitea">Gitea</option><option value="gitlab">GitLab</option></select></div>' +
      '<div class="wsx-field"><div class="wsx-label">TOKEN</div>' +
        '<input class="wsx-input" id="wsd-token" placeholder="forge token" autocomplete="off" spellcheck="false"></div>' +
      '<button class="wsx-go" id="wsd-go">list my repos</button>' +
      '<div class="wsx-list" id="wsd-list"></div>' +
      '<div class="wsx-err" id="wsd-err" style="display:none"></div>',
      function () {
        document.getElementById('wsx-back').addEventListener('click', openConnectPage);
        document.getElementById('wsd-go').addEventListener('click', function () {
          var err = document.getElementById('wsd-err');
          err.style.display = 'none';
          var kind = document.getElementById('wsd-kind').value;
          var tok = document.getElementById('wsd-token').value.trim();
          var q = 'kind=' + encodeURIComponent(kind) + '&limit=60';
          if (tok) q += '&token=' + encodeURIComponent(tok);
          var list = document.getElementById('wsd-list');
          list.innerHTML = '<div class="wsx-sub">loading…</div>';
          api('/api/workspaces/discover?' + q).then(function (d) {
            var repos = d.repos || [];
            if (!repos.length) { list.innerHTML = '<div class="wsx-sub">no repos on that account</div>'; return; }
            var html = '';
            repos.forEach(function (r) {
              html +=
                '<div class="wsx-row" data-url="' + esc(r.web_url || '') + '">' +
                  '<span class="wsx-ico">' + kindIcon(kind) + '</span>' +
                  '<span class="wsx-mid"><span class="wsx-name">' + esc(r.name) + '</span>' +
                  '<div class="wsx-meta">' + (r.private ? 'private' : 'public') +
                  ' · ' + esc(r.default_branch || '') + '</div></span>' +
                  '<span class="wsx-badge read">connect</span>' +
                '</div>';
            });
            list.innerHTML = html;
            Array.prototype.forEach.call(list.querySelectorAll('.wsx-row'), function (row) {
              row.addEventListener('click', function () {
                openCloudForm(row.getAttribute('data-url'));
              });
            });
          }).catch(function (e) {
            list.innerHTML = '';
            err.textContent = e.message; err.style.display = '';
          });
        });
      });
  }

  // ── THE PILL (chatpanel wires this into the header's pill row) ────────
  function pill(sessionId) {
    ensureStyles();
    var b = document.createElement('button');
    b.id = 'pill-workspace';
    b.className = 'pill-workspace';
    b.innerHTML = '▣ <span id="pill-workspace-count">0</span>';
    b.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
      'background:rgba(var(--accent-2-rgb),0.06);border:1px solid rgba(var(--accent-2-rgb),0.55);color:var(--accent-2);' +
      'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
      'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2';
    b.title = 'Cloud workspaces connected to this chat';
    var sid = sessionId || null;
    var paint = function () {
      if (!sid) return;
      api('/api/sessions/' + encodeURIComponent(sid) + '/workspaces').then(function (d) {
        var n = (d.workspaces || []).length;
        var c = b.querySelector('#pill-workspace-count');
        if (c) c.textContent = String(n);
        b.style.opacity = n ? '1' : '0.75';
      }).catch(function () {});
    };
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      openPicker(sid, null);
    });
    paint();
    onPillRefresh(paint);
    return b;
  }

  // session can lag the pill's construction (model connect flow) — the
  // panel re-wires the pill when the session lands
  function setPillSession(btn, sessionId) {
    if (!btn) return;
    // simplest: rebuild via clone + re-call pill()
    var fresh = pill(sessionId);
    fresh.id = btn.id;
    btn.replaceWith(fresh);
    return fresh;
  }

  // ── ARTIFACTS DRAWER: the cloud section ───────────────────────────────
  // renderCloudSection(listEl, sessionId) appends bound repos as lazy
  // trees (artifacts.js calls this after its own tree renders).
  function renderCloudSection(listEl, sessionId) {
    if (!listEl || !sessionId) return;
    api('/api/sessions/' + encodeURIComponent(sessionId) + '/workspaces').then(function (d) {
      var rows = d.workspaces || [];
      if (!rows.length) return;
      var head = document.createElement('div');
      head.className = 'wsc-sec';
      head.textContent = '☁ CLOUD WORKSPACES';
      listEl.appendChild(head);
      rows.forEach(function (ws) { appendRepoRow(listEl, ws, 0); });
    }).catch(function () { /* offline engine — the local tree still shows */ });
  }

  function appendRepoRow(listEl, ws, depth, parentPath) {
    var row = document.createElement('div');
    row.className = 'wsc-row';
    row.style.setProperty('--d', String(depth));
    row.innerHTML =
      '<span style="flex-shrink:0;width:18px;font-size:13px">▶</span>' +
      '<span style="flex-shrink:0;font-size:14px">' + kindIcon(ws.kind) + '</span>' +
      '<span class="wsc-name" style="font-weight:600">' + esc(ws.name || ws.repo) + '</span>' +
      '<span class="wsc-size">' + esc(ws.access || 'read') + '</span>';
    var branch = document.createElement('div');
    branch.style.display = 'none';
    listEl.appendChild(row);
    listEl.appendChild(branch);
    var loaded = false;
    row.addEventListener('click', function () {
      var open = branch.style.display !== 'none';
      branch.style.display = open ? 'none' : '';
      row.firstChild.textContent = open ? '▶' : '▼';
      if (!loaded && !open) {
        loaded = true;
        loadCloudLevel(branch, ws, '', 1);
      }
    });
  }

  function loadCloudLevel(branch, ws, path, depth) {
    var q = [];
    if (path) q.push('path=' + encodeURIComponent(path));
    if (ws.branch) q.push('ref=' + encodeURIComponent(ws.branch));
    var loading = document.createElement('div');
    loading.className = 'wsc-row';
    loading.style.setProperty('--d', String(depth));
    loading.innerHTML = '<span class="wsc-size">loading…</span>';
    branch.appendChild(loading);
    api('/api/workspaces/' + encodeURIComponent(ws.id) + '/tree' + (q.length ? '?' + q.join('&') : ''))
      .then(function (d) {
        loading.remove();
        var entries = (d.entries || []).slice().sort(function (a, b) {
          var at = a.type === 'tree' ? 0 : 1, bt = b.type === 'tree' ? 0 : 1;
          return at - bt || String(a.path).localeCompare(String(b.path));
        });
        if (!entries.length) {
          var e = document.createElement('div');
          e.className = 'wsc-row'; e.style.setProperty('--d', String(depth));
          e.innerHTML = '<span class="wsc-size">(empty)</span>';
          branch.appendChild(e);
          return;
        }
        entries.forEach(function (en) {
          var rel = String(en.path || '').split('/').pop();
          var isDir = en.type === 'tree';
          var row = document.createElement('div');
          row.className = 'wsc-row';
          row.style.setProperty('--d', String(depth));
          row.innerHTML =
            '<span style="flex-shrink:0;width:18px;font-size:13px">' + (isDir ? '▶' : '·') + '</span>' +
            '<span class="wsc-name">' + esc(rel) + '</span>' +
            '<span class="wsc-size">' + (isDir ? '' : fmtSize(en.size)) + '</span>';
          branch.appendChild(row);
          if (isDir) {
            var sub = document.createElement('div');
            sub.style.display = 'none';
            branch.appendChild(sub);
            var l = false;
            row.addEventListener('click', function () {
              var o = sub.style.display !== 'none';
              sub.style.display = o ? 'none' : '';
              row.firstChild.textContent = o ? '▶' : '▼';
              if (!l && !o) { l = true; loadCloudLevel(sub, ws, en.path, depth + 1); }
            });
          } else {
            row.addEventListener('click', function () {
              openCloudFile(ws, en.path);
            });
          }
        });
      })
      .catch(function (e) {
        loading.remove();
        var err = document.createElement('div');
        err.className = 'wsc-row'; err.style.setProperty('--d', String(depth));
        err.innerHTML = '<span class="wsc-size" style="color:var(--err)">⚠ ' + esc(e.message) + '</span>';
        branch.appendChild(err);
      });
  }

  function fmtSize(n) {
    n = Number(n || 0);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ── cloud file viewer (+ editor when full access) ─────────────────────
  function openCloudFile(ws, path) {
    ensureStyles();
    var root = null;
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3200;display:flex;' +
      'flex-direction:column;background:var(--bg-app)';
    overlay.innerHTML =
      '<div class="wsx-head">' +
        '<button class="wsx-back" id="wsv-back">‹ close</button>' +
        '<span class="wsx-title" style="font-size:var(--ui-fs)">' + esc(path) + '</span>' +
        '<span class="wsx-badge ' + esc(ws.access) + '">' + esc(ws.access) + '</span>' +
      '</div>' +
      '<div id="wsv-body" class="wsc-row" style="min-height:60px"><span class="wsc-size">loading…</span></div>';
    document.body.appendChild(overlay);
    root = overlay;

    var q = 'path=' + encodeURIComponent(path);
    if (ws.branch) q += '&ref=' + encodeURIComponent(ws.branch);
    var sha = '';
    api('/api/workspaces/' + encodeURIComponent(ws.id) + '/file?' + q).then(function (fc) {
      if (!root.isConnected) return;
      sha = fc.sha || '';
      var body = document.getElementById('wsv-body');
      if (fc.binary) {
        body.className = '';
        body.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3)';
        body.innerHTML = '📦 binary file — ' + fmtSize(fc.size) +
          '<br><button class="wsx-act" id="wsv-dl" style="margin-top:10px">open raw</button>';
        var dl = document.getElementById('wsv-dl');
        if (dl) dl.addEventListener('click', function () {
          window.open((ws.repo_url || '') + '/blob/' + encodeURIComponent(ws.branch || 'HEAD') + '/' + path, '_blank');
        });
        return;
      }
      var text = fc.content || '';
      var editable = ws.access === 'full';
      body.className = '';
      body.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0';
      if (editable) {
        body.innerHTML = '<textarea class="wsv-ta" id="wsv-ta" spellcheck="false"></textarea>' +
          '<div style="display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--surface-2)">' +
            '<button class="wsx-go" id="wsv-save" style="margin:0;width:auto;padding:8px 18px">commit</button>' +
            '<span class="wsx-note" id="wsv-note" style="padding:6px 0">edits commit straight to ' + esc(ws.branch || 'the branch') + '</span>' +
          '</div>';
        document.getElementById('wsv-ta').value = text;
        document.getElementById('wsv-save').addEventListener('click', function () {
          var btn = document.getElementById('wsv-save');
          btn.disabled = true; btn.textContent = 'committing…';
          api('/api/workspaces/' + encodeURIComponent(ws.id) + '/file', 'PUT', {
            path: path,
            content: document.getElementById('wsv-ta').value,
            message: 'doomalay drawer: update ' + path,
            branch: ws.branch || '',
            sha: sha
          }).then(function (d) {
            btn.disabled = false; btn.textContent = 'commit';
            var note = document.getElementById('wsv-note');
            if (note) note.textContent = '✓ committed — ' + (d.commit_url || '');
            toast('committed ' + path);
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'commit';
            var note = document.getElementById('wsv-note');
            if (note) note.textContent = '⚠ ' + e.message;
          });
        });
      } else {
        body.innerHTML = '<pre class="wsv-pre">' + esc(text) + '</pre>' +
          '<div class="wsx-note">read-only' + (ws.access === 'partial' ? ' for this repo (partial access writes go through forks/PRs — ask in chat)' : '') + '</div>';
      }
    }).catch(function (e) {
      var body = document.getElementById('wsv-body');
      if (body) { body.className = ''; body.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>'; }
    });

    document.getElementById('wsv-back').addEventListener('click', function () {
      overlay.remove();
    });
  }

  // ── exports ────────────────────────────────────────────────────────────
  window.Workspace = {
    pill: pill,
    setPillSession: setPillSession,
    openPicker: openPicker,
    openCloudFile: openCloudFile,
    renderCloudSection: renderCloudSection,
    refreshPills: refreshPills,
    onPillRefresh: onPillRefresh,
    toast: toast
  };
})();
