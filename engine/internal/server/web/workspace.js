// workspace.js — v0.46 THE WORKSPACES WAVE, ROUND 2 (user edits A1–A12).
//
// WHAT CHANGED vs v0.44 (user feedback, verbatim intent):
//   · "nothing persists / instantly disconnects" — the picker listed only
//     SESSION-BOUND repos and the pill could open before the engine session
//     landed, so connect silently skipped the bind. NOW: the picker lists
//     ALL GLOBAL workspaces (edit A9), the pill reads the session LIVE,
//     and rows bind/unbind per chat explicitly. Nothing vanishes.
//   · "tokens: paste once, encrypted instantly" (A7) — a global forge
//     account (vault, AES-256-GCM) or "Sign in with GitHub" (A8/A12,
//     GitHub App OAuth). Every form shows SIGN-IN FIRST, token second.
//   · "device storage" (A11) — a real folder on this device via the File
//     System Access API: suggested location, browse, read/write, saved as
//     a global workspace every chatbot can bind.
//   · "my repos: choose entire repo or branches" (A10) — repo detail page
//     with a branch picker (checkboxes, default prechecked); branches
//     persist on the workspace and switch in the drawer.
//   · "overlay: X top right, back pops one level" (A3/A4) — the overlay
//     shell (connectoverlay.js) owns the static ✕ + nav stack; this file
//     only pushes pages.
//   · "everything theme colors" (A6) — zero hard-coded colors left.
//
// SURFACE MAP (all pages are ConnectOverlay levels — the sanctioned
// modifiable overlay screen, per edit A1):
//   picker (global list + pinned "+ connect workspace" bottom row)
//     → connect page (cloud / create / my repos / device storage / local)
//         → cloud form (URL + sign-in-first)
//         → create form (name/license/gitignore + sign-in-first)
//         → my repos (sign-in-first → repo list → repo detail + branches)
//         → device storage (folder picker + suggested location)
//   artifacts drawer: ☁ cloud section (lazy trees, branch switcher) +
//     📱 device section (local FS handle trees). File taps open overlay
//     pages (viewer; editor with commit when full access).
//
// Exposes: window.Workspace { pill, setPillSession, openPicker,
//           openCloudFile, openDeviceFile, renderCloudSection,
//           refreshPills, onPillRefresh, toast }
(function () {
  'use strict';

  var esc = window.Formatter ? window.Formatter.esc : function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ── styles (injected once) — every color is a theme var (edit A6) ─────
  function ensureStyles() {
    if (document.getElementById('ws-v46-styles')) return;
    var s = document.createElement('style');
    s.id = 'ws-v46-styles';
    s.textContent =
      '.wsx{font-size:var(--ui-fs);color:var(--text-1);padding-bottom:6px}' +
      '.wsx-head{display:flex;align-items:center;gap:8px;padding:14px 48px 10px 16px;' +
        'border-bottom:1px solid var(--surface-2)}' +
      '.wsx-title{flex:1;font-size:calc(var(--ui-fs) + 1px);font-weight:700}' +
      '.wsx-sub{font-size:var(--ui-small-fs);color:var(--text-3);padding:8px 16px 2px;line-height:1.45}' +
      '.wsx-list{padding:6px 10px 4px}' +
      '.wsx-row{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 10px;' +
        'border-radius:12px;cursor:pointer;-webkit-tap-highlight-color:transparent;' +
        'touch-action:manipulation}' +
      '.wsx-row.dim{opacity:0.72}' +
      '.wsx-row:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      '.wsx-ico{flex-shrink:0;width:28px;height:28px;border-radius:8px;display:flex;' +
        'align-items:center;justify-content:center;font-size:15px;' +
        'background:rgba(var(--accent-2-rgb),0.08);border:1px solid rgba(var(--accent-2-rgb),0.25)}' +
      '.wsx-ico.k-github{background:rgba(var(--accent-2-rgb),0.10);border-color:rgba(var(--accent-2-rgb),0.3)}' +
      '.wsx-ico.k-gitea{background:rgba(var(--ok-rgb),0.10);border-color:rgba(var(--ok-rgb),0.3)}' +
      '.wsx-ico.k-gitlab{background:rgba(var(--accent-3-rgb),0.10);border-color:rgba(var(--accent-3-rgb),0.3)}' +
      '.wsx-ico.k-device{background:rgba(var(--accent-rgb),0.10);border-color:rgba(var(--accent-rgb),0.3)}' +
      '.wsx-ico.k-generic{background:rgba(var(--surface-3-rgb),0.25);border-color:var(--surface-3)}' +
      '.wsx-mid{flex:1;min-width:0}' +
      '.wsx-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.wsx-owner{font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);' +
        'letter-spacing:0.3px;margin-bottom:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
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
      '.wsx-badge.inchat{color:var(--ok);border-color:rgba(var(--ok-rgb),0.55);' +
        'background:rgba(var(--ok-rgb),0.10)}' +
      // the PINNED connect row (edit A9): sticky bottom — v0.62: a real
      // THEME-GRADIENT pill (the old dashed-border row read as unthemed).
      '.wsx-conn-wrap{position:sticky;bottom:0;z-index:3;margin-top:4px;' +
        'padding:8px 12px 10px;background:color-mix(in srgb, var(--surface-1) 92%, transparent);' +
        'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
        'border-top:1px solid var(--surface-2)}' +
      '.wsx-conn{display:flex;align-items:center;gap:9px;min-height:44px;padding:9px 12px;' +
        'border-radius:12px;cursor:pointer;' +
        'border:1.5px solid rgba(var(--accent-rgb),0.45);' +
        'color:var(--accent);font-weight:700;font-size:var(--ui-small-fs);' +
        'background:linear-gradient(135deg,rgba(var(--accent-rgb),0.16),rgba(var(--accent-2-rgb),0.10));' +
        'background-image:linear-gradient(135deg,rgba(var(--accent-rgb),0.16),rgba(var(--accent-2-rgb),0.10));' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation;' +
        'transition:filter 0.15s}' +
      '.wsx-conn:active{filter:brightness(1.35)}' +
      // v0.62: the simple empty state (user spec: "nothing here yet…")
      '.wsx-empty{padding:26px 16px;text-align:center;color:var(--text-3);' +
        'font-size:var(--ui-small-fs);font-weight:500}' +
      '.wsx-acts{display:flex;flex-wrap:wrap;gap:6px;padding:2px 10px 10px 48px}' +
      '.wsx-act{background-color:var(--surface-2);border:1px solid var(--surface-3);color:var(--text-2);' +
        'padding:6px 10px;border-radius:9px;font-size:var(--ui-small-fs);font-family:inherit;' +
        'cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-act.primary{color:var(--accent-2);border-color:rgba(var(--accent-2-rgb),0.5)}' +
      '.wsx-act.danger{color:var(--err);border-color:rgba(var(--err-rgb),0.4)}' +
      '.wsx-field{margin:10px 16px 0}' +
      '.wsx-label{font-size:var(--ui-small-fs);color:var(--text-3);margin-bottom:5px;font-weight:600}' +
      '.wsx-input{width:100%;box-sizing:border-box;background-color:var(--surface-2);' +
        'border:1px solid var(--border);border-radius:10px;color:var(--text-1);' +
        'padding:10px 12px;font-size:var(--ui-fs);font-family:inherit;outline:none}' +
      '.wsx-input:focus{border-color:var(--accent-2)}' +
      '.wsx-select{width:100%;background-color:var(--surface-2);border:1px solid var(--border);' +
        'border-radius:10px;color:var(--text-1);padding:10px 12px;font-size:var(--ui-fs);' +
        'font-family:inherit;outline:none}' +
      '.wsx-go{display:block;width:calc(100% - 32px);margin:16px 16px 8px;padding:12px;' +
        'border-radius:12px;border:none;background:var(--accent-2);color:var(--bg-app);background-image:var(--accent-2-gradient,none);background-attachment:fixed;' +
        'font-size:var(--ui-fs);font-weight:700;font-family:inherit;cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-go:disabled{opacity:0.5}' +
      '.wsx-opt{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 12px;' +
        'margin:6px 12px;border-radius:12px;cursor:pointer;' +
        'border:1px solid var(--surface-3);background-color:var(--surface-1);' +
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
      // sign-in-first block (edit A8): row 1 big + row 2 manual token
      '.wsx-signin{margin:10px 12px 0;padding:12px;border-radius:12px;' +
        'background:rgba(var(--accent-2-rgb),0.06);border:1px solid rgba(var(--accent-2-rgb),0.3)}' +
      '.wsx-signin.big{cursor:pointer;-webkit-tap-highlight-color:transparent;' +
        'touch-action:manipulation;background:linear-gradient(135deg,' +
        'rgba(var(--accent-2-rgb),0.16),rgba(var(--accent-rgb),0.10));' +
        'border:1px solid rgba(var(--accent-2-rgb),0.45)}' +
      '.wsx-signin.big:active{background:linear-gradient(135deg,' +
        'rgba(var(--accent-2-rgb),0.28),rgba(var(--accent-rgb),0.18))}' +
      '.wsx-signin.done{background:rgba(var(--ok-rgb),0.07);border-color:rgba(var(--ok-rgb),0.4)}' +
      '.wsx-signin-title{display:flex;align-items:center;gap:8px;font-weight:700;' +
        'color:var(--accent-2);font-size:var(--ui-fs)}' +
      '.wsx-signin.done .wsx-signin-title{color:var(--ok)}' +
      '.wsx-signin-sub{font-size:var(--ui-small-fs);color:var(--text-3);margin-top:3px;line-height:1.4}' +
      '.wsx-manual{margin:8px 12px 0;border:1px dashed var(--border-strong);border-radius:10px;' +
        'padding:10px 12px}' +
      '.wsx-manual-toggle{background:transparent;border:none;color:var(--text-3);' +
        'font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;padding:2px 0;' +
        'font-weight:600;-webkit-tap-highlight-color:transparent}' +
      // the formatted cloud description (edit A5): theme-colored chips
      '.wsx-cloudhero{margin:8px 12px 2px;padding:12px;border-radius:12px;' +
        'background:linear-gradient(135deg,rgba(var(--accent-2-rgb),0.10),' +
        'rgba(var(--accent-3-rgb),0.07));border:1px solid rgba(var(--accent-2-rgb),0.3)}' +
      '.wsx-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
      '.wsx-chip{font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;padding:3px 9px;' +
        'border-radius:999px;border:1px solid}' +
      '.wsx-chip.c1{color:var(--accent-2);border-color:rgba(var(--accent-2-rgb),0.5);' +
        'background:rgba(var(--accent-2-rgb),0.08)}' +
      '.wsx-chip.c2{color:var(--ok);border-color:rgba(var(--ok-rgb),0.5);' +
        'background:rgba(var(--ok-rgb),0.08)}' +
      '.wsx-chip.c3{color:var(--accent-3);border-color:rgba(var(--accent-3-rgb),0.5);' +
        'background:rgba(var(--accent-3-rgb),0.08)}' +
      '.wsx-chip.cn{color:var(--text-3);border-color:var(--border);' +
        'background:rgba(var(--surface-3-rgb),0.3)}' +
      '.wsx-chip.cw{color:var(--warn);border-color:rgba(var(--warn-rgb),0.5);' +
        'background:rgba(var(--warn-rgb),0.08)}' +
      // repo rows (edit A10): nesting + varied type marks + meta line
      '.wsx-reposec{font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;color:var(--text-3);' +
        'letter-spacing:0.5px;padding:12px 22px 4px;text-transform:uppercase}' +
      '.wsx-repo{margin:2px 12px}' +
      '.wsx-repo .wsx-row{margin:0}' +
      '.wsx-repo .wsx-mid{padding-left:4px}' +
      '.wsx-type{flex-shrink:0;font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;' +
        'width:24px;height:24px;border-radius:7px;display:flex;align-items:center;' +
        'justify-content:center;border:1px solid}' +
      '.wsx-type.pub{color:var(--accent-2);border-color:rgba(var(--accent-2-rgb),0.45);' +
        'background:rgba(var(--accent-2-rgb),0.08)}' +
      '.wsx-type.priv{color:var(--warn);border-color:rgba(var(--warn-rgb),0.45);' +
        'background:rgba(var(--warn-rgb),0.08)}' +
      '.wsx-type.fork{color:var(--accent-3);border-color:rgba(var(--accent-3-rgb),0.45);' +
        'background:rgba(var(--accent-3-rgb),0.08)}' +
      '.wsx-stat{display:flex;align-items:center;gap:3px}' +
      '.wsx-stat .dot{width:8px;height:8px;border-radius:999px;background:var(--accent-3)}' +
      '.wsx-stat .star{color:var(--warn)}' +
      // branch picker (edit A10)
      '.wsx-brlist{margin:6px 12px;border:1px solid var(--surface-3);border-radius:10px;' +
        'max-height:220px;overflow-y:auto;-webkit-overflow-scrolling:touch}' +
      '.wsx-br{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;' +
        'border-bottom:1px solid var(--surface-2);font-size:var(--ui-small-fs);' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsx-br:last-child{border-bottom:none}' +
      '.wsx-br:active{background:rgba(var(--accent-2-rgb),0.08)}' +
      '.wsx-br .box{width:18px;height:18px;border-radius:6px;border:1.5px solid var(--border-strong);' +
        'display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--bg-app);' +
        'flex-shrink:0;font-weight:900}' +
      '.wsx-br.on .box{background:var(--accent-2);border-color:var(--accent-2)}' +
      '.wsx-br .def{margin-left:auto;font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3)}' +
      // drawer sections (cloud + device)
      '.wsc-sec{margin:10px 4px 2px;padding:7px 10px 5px;border-top:1px solid var(--surface-2);' +
        'font-size:var(--ui-small-fs);font-weight:700;color:var(--text-3);letter-spacing:0.4px;' +
        'display:flex;align-items:center;gap:6px}' +
      '.wsc-brsel{margin-left:auto;background-color:var(--surface-2);color:var(--text-2);' +
        'border:1px solid var(--surface-3);border-radius:7px;font-size:calc(var(--ui-small-fs) - 2px);' +
        'font-family:inherit;padding:2px 4px;outline:none}' +
      '.wsc-row{position:relative;display:flex;align-items:center;gap:6px;min-height:44px;' +
        'padding-right:6px;margin:1px 0;border-radius:10px;cursor:pointer;' +
        'padding-left:calc(8px + var(--d,0)*18px);user-select:none;-webkit-user-select:none;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.wsc-row:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      '.wsc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--text-1);font-weight:500}' +
      '.wsc-size{flex-shrink:0;color:var(--text-3);font-size:calc(var(--ui-small-fs) - 1px)}' +
      // file viewer / editor pages (v0.49 sweep: raised surfaces, not
      // the canvas var — with the surface-2 gradient twin)
      '.wsv-pre{overflow:auto;margin:0;padding:12px;background:var(--surface-2);' +
        'background-image:var(--surface-2-gradient,none);background-attachment:fixed;' +
        'color:var(--text-1);font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'font-size:calc(var(--ui-fs) - 2px);line-height:1.5;white-space:pre;' +
        '-webkit-overflow-scrolling:touch}' +
      '.wsv-ta{width:100%;box-sizing:border-box;border:none;outline:none;resize:none;' +
        'min-height:240px;padding:12px;background:var(--surface-2);' +
        'background-image:var(--surface-2-gradient,none);color:var(--text-1);' +
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
    return { github: '🐙', gitea: '🍵', gitlab: '🦊', sourcehut: '🪶', device: '📱' }[kind] || '📁';
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

  // ── accounts (edit A7/A8): paste/sign in ONCE, vault-encrypted ────────
  var accounts = { github: { signed_in: false, login: '', oauth_configured: false},
                   gitea:  { signed_in: false, login: '', oauth_configured: false} };

  function refreshAccounts() {
    return api('/api/workspaces/accounts').then(function (d) {
      (d.accounts || []).forEach(function (a) {
        if (accounts[a.kind]) {
          accounts[a.kind].signed_in = !!a.signed_in;
          accounts[a.kind].login = a.login || '';
          accounts[a.kind].oauth_configured = !!a.oauth_configured;
        }
      });
      return accounts;
    }).catch(function () { return accounts; });
  }

  // The sign-in-first block (edit A8): BIG "Sign in" row + manual token row.
  // state: 'idle' (show sign-in) | 'done' (signed in as X) | 'manual-open'
  function signinHTML(kind, ctx) {
    var a = accounts[kind] || { signed_in: false, login: '', oauth_configured: false };
    var id = ctx + '-signin';
    if (a.signed_in) {
      return (
        '<div class="wsx-signin done" id="' + id + '">' +
          '<div class="wsx-signin-title">✓ signed in' +
            (a.login ? ' as <span style="color:var(--accent-2)">@' + esc(a.login) + '</span>' : '') +
          '</div>' +
          '<div class="wsx-signin-sub">' + esc(kind) + ' account saved (encrypted) — ' +
            'repos you connect will use it. no repeated token prompts.</div>' +
          '<button class="wsx-back" data-a="switch" style="padding:6px 0 0">use a different account</button>' +
        '</div>' +
        '<div class="wsx-manual" id="' + id + '-manual" style="display:none">' +
          manualTokenInner(kind, ctx) +
        '</div>');
    }
    return (
      '<div class="wsx-signin big" id="' + id + '" role="button" tabindex="0">' +
        '<div class="wsx-signin-title">⏾ Sign in with ' + esc(kindLabel(kind)) + '</div>' +
        '<div class="wsx-signin-sub" id="' + id + '-sub">' +
          (kind === 'github'
            ? 'one tap — you approve on github, we get the token. no pasting.'
            : 'connect your ' + esc(kindLabel(kind)) + ' account once.') +
        '</div>' +
      '</div>' +
      '<div class="wsx-manual" id="' + id + '-manual" style="display:none">' +
        manualTokenInner(kind, ctx) +
      '</div>');
  }

  function manualTokenInner(kind, ctx) {
    return (
      '<button class="wsx-manual-toggle" data-a="close-manual">or paste a token instead ▴</button>' +
      '<div class="wsx-field" style="margin:8px 0 0">' +
        '<input class="wsx-input" id="' + ctx + '-token" placeholder="' +
          (kind === 'github' ? 'ghp_… / github_pat_…' : kind + ' token') + '" ' +
          'autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '</div>' +
      '<div class="wsx-note" style="padding:4px 0 0">encrypted into the engine vault the moment you save — ' +
        'stored once, reused everywhere.</div>' +
      '<button class="wsx-go" data-a="save-token" style="margin:10px 0 0;width:100%">save token</button>');
  }

  function kindLabel(kind) {
    return { github: 'GitHub', gitea: 'Gitea', gitlab: 'GitLab' }[kind] || kind;
  }

  // Wire a signin block. actions: { onSignedIn: fn } — re-render via caller.
  function wireSignin(root, kind, ctx, onSignedIn) {
    var el = root.querySelector('#' + ctx + '-signin');
    var manual = root.querySelector('#' + ctx + '-manual');
    if (!el) return;
    var openManual = function () {
      if (manual) { manual.style.display = ''; el.style.display = 'none'; }
    };
    if (el.classList.contains('done')) {
      var sw = el.querySelector('[data-a="switch"]');
      if (sw) sw.addEventListener('click', function (e) { e.stopPropagation(); openManual(); });
    } else {
      el.addEventListener('click', function () {
        if (kind === 'github' && window.GHConnect) {
          // v0.61: ALWAYS the GitHub connect panel — it picks the flow
          // (loopback+secret → the direct one-press POPUP; gateway →
          // broker; else the device code) and the app tab NEVER navigates
          // (the v0.60 same-tab redirect killed SPA state + the back
          // gesture; that path is gone for good).
          window.GHConnect.openConnectPanel({ onDone: function () { if (onSignedIn) onSignedIn(); } });
        } else {
          openManual();
          var sub = el.querySelector('#' + ctx + '-signin-sub');
          if (sub && kind === 'github') {
            sub.textContent = 'one-tap sign-in isn\u2019t available here — ' +
              'paste a token for now, it works the same.';
          }
        }
      });
    }
    if (manual) {
      var closeBtn = manual.querySelector('[data-a="close-manual"]');
      if (closeBtn) closeBtn.addEventListener('click', function () {
        manual.style.display = 'none';
        if (el) el.style.display = '';
      });
      var save = manual.querySelector('[data-a="save-token"]');
      if (save) save.addEventListener('click', function () {
        var input = manual.querySelector('#' + ctx + '-token');
        var tok = input ? input.value.trim() : '';
        if (!tok) { input.style.borderColor = 'var(--err)'; return; }
        save.disabled = true; save.textContent = 'verifying…';
        api('/api/workspaces/accounts', 'POST', { kind: kind, token: tok })
          .then(function (d) {
            toast('signed in to ' + kindLabel(kind) + (d.login ? ' as ' + d.login : '') + ' — saved encrypted');
            input.value = '';
            return refreshAccounts();
          })
          .then(function () { if (onSignedIn) onSignedIn(); })
          .catch(function (e) {
            save.disabled = false; save.textContent = 'save token';
            toast(e.message);
          });
      });
    }
  }

  // ── THE PICKER (global list + pinned connect row — edits A7/A9) ───────
  // sidOrFn: a session id OR a live getter (fixes the stale-null race that
  // made connects "instantly disconnect": the pill used to capture the sid
  // BEFORE the engine session landed).
  var currentPicker = { getSid: null, chat: null };

  function sidNow() {
    try { return currentPicker.getSid ? currentPicker.getSid() : null; }
    catch (e) { return null; }
  }

  function openPicker(sidOrFn, chat) {
    ensureStyles();
    currentPicker = {
      getSid: (typeof sidOrFn === 'function') ? sidOrFn : function () { return sidOrFn || null; },
      chat: chat || null
    };
    refreshAccounts().then(function () {
      window.ConnectOverlay.open(pickerHTML(), {
        onSwap: function () { wirePicker(); loadGlobals(); }
      });
      checkOAuthReturn();
    });
  }

  // OAuth return: gh_connected=1 / gh_error on the query (like the HF flow).
  function checkOAuthReturn() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var connected = params.get('gh_connected') === '1';
    var err = params.get('gh_error');
    if (!connected && !err) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (err) { toast('GitHub sign-in failed: ' + err); return; }
    var login = params.get('gh_login') || '';
    refreshAccounts().then(function () {
      toast('signed in to GitHub' + (login ? ' as ' + login : '') + ' ✓');
      // resume a connect that was in flight before the redirect
      var resume = null;
      try { resume = sessionStorage.getItem('ws-pending-connect'); sessionStorage.removeItem('ws-pending-connect'); sessionStorage.removeItem('ws-oauth-resume'); } catch (e) {}
      if (resume) {
        try {
          var pend = JSON.parse(resume);
          if (pend.mode === 'discover') { openDiscover(); return; }
          if (pend.mode === 'create') { openCreateForm(); return; }
          if (pend.mode === 'cloud' && pend.url) { openCloudForm(pend.url); return; }
        } catch (e) {}
      }
      // nothing parked — reopen the picker fresh with the new account
      loadGlobals();
    });
  }

  function pickerHTML() {
    // v0.62 (user spec): no large description text — the header is tight,
    // the empty state says the simple thing.
    return (
      '<div class="wsx">' +
        '<div class="wsx-head">' +
          '<span class="wsx-title">▣ workspaces</span>' +
          '<span class="wsx-badge read" id="wsx-count">…</span>' +
        '</div>' +
        '<div class="wsx-list" id="wsx-list">' +
          '<div class="wsx-sub">loading…</div>' +
        '</div>' +
        '<div class="wsx-conn-wrap">' +
          '<div class="wsx-conn" id="wsx-connect" role="button" tabindex="0">' +
            '<span style="font-size:15px">＋</span>' +
            '<span class="wsx-mid">connect workspace' +
              '<div class="wsx-meta">cloud · create · device</div></span>' +
          '</span>' +
        '</div>' +
      '</div>');
  }

  function wirePicker() {
    var conn = document.getElementById('wsx-connect');
    if (conn) conn.addEventListener('click', function () { openConnectPage(); });
  }

  function loadGlobals() {
    var listEl = document.getElementById('wsx-list');
    var cntEl = document.getElementById('wsx-count');
    if (!listEl) return;
    var sid = sidNow();
    var globalsP = api('/api/workspaces');
    var boundP = sid
      ? api('/api/sessions/' + encodeURIComponent(sid) + '/workspaces')
      : Promise.resolve({ workspaces: [] });
    Promise.all([globalsP, boundP]).then(function (res) {
      var rows = res[0].workspaces || [];
      var boundIds = {};
      (res[1].workspaces || []).forEach(function (w) { boundIds[w.id] = true; });
      if (cntEl) cntEl.textContent = String(Object.keys(boundIds).length);
      if (!rows.length) {
        // v0.62 (user spec): a simple "nothing here yet…" — not a body of text.
        listEl.innerHTML =
          '<div class="wsx-empty">nothing here yet…</div>';
        return;
      }
      var html = '';
      rows.forEach(function (ws) { html += boundRowHTML(ws, !!boundIds[ws.id]); });
      listEl.innerHTML = html;
      wireBoundRows(listEl, rows);
    }).catch(function (e) {
      listEl.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>';
    });
  }

  function boundRowHTML(ws, inChat) {
    var acc = ws.access || 'read';
    var meta = ws.kind === 'device'
      ? ['this device', ws.meta && ws.meta.display_path || ''].filter(Boolean).join(' · ')
      : [ws.kind, [ws.branch, (ws.meta && ws.meta.branches && ws.meta.branches.length > 1)
          ? '+' + (ws.meta.branches.length - 1) + ' branches' : '']
          .filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    return (
      '<div class="wsx-row' + (inChat ? '' : ' dim') + '" data-wsid="' + esc(ws.id) + '">' +
        '<span class="wsx-ico k-' + esc(ws.kind) + '">' + kindIcon(ws.kind) + '</span>' +
        '<span class="wsx-mid">' +
          '<span class="wsx-name">' + esc(ws.name || ((ws.owner || '') + '/' + ws.repo)) + '</span>' +
          '<div class="wsx-meta">' + esc(meta) + '</div>' +
        '</span>' +
        (inChat
          ? '<span class="wsx-badge inchat">✓ in chat</span>'
          : '<span class="wsx-badge read">＋</span>') +
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
          wireRowActions(acts, ws);
        }
      });
    });
  }

  function wireRowActions(acts, ws) {
    var sid = sidNow();
    var inChat = /in chat/.test(acts.previousElementSibling.innerHTML);
    acts.innerHTML =
      (sid
        ? '<button class="wsx-act primary" data-a="bind">' +
            (inChat ? '✓ remove from this chat' : '＋ add to this chat') + '</button>'
        : '') +
      (ws.kind !== 'device'
        ? '<button class="wsx-act" data-a="drawer">☁ open in drawer</button>' +
          '<button class="wsx-act" data-a="chat">✦ explore in chat</button>' +
          ((ws.access === 'read' || ws.access === 'partial')
            ? '<button class="wsx-act" data-a="token">🔑 upgrade access</button>' : '') +
          '<button class="wsx-act" data-a="web">↗ browser</button>'
        : '<button class="wsx-act" data-a="drawer">📂 open in drawer</button>') +
      '<button class="wsx-act danger" data-a="unbind">✕ forget workspace</button>';
    var bind = acts.querySelector('[data-a="bind"]');
    if (bind) bind.addEventListener('click', function () {
      var sid2 = sidNow();
      if (!sid2) { toast('connect a model first'); return; }
      if (inChat) {
        api('/api/sessions/' + encodeURIComponent(sid2) + '/workspaces/' + encodeURIComponent(ws.id), 'DELETE')
          .then(function () { loadGlobals(); refreshPills(); toast('removed from this chat (still saved globally)'); })
          .catch(function (e) { toast(e.message); });
      } else {
        api('/api/sessions/' + encodeURIComponent(sid2) + '/workspaces', 'POST', { workspace_id: ws.id })
          .then(function () { loadGlobals(); refreshPills(); toast(ws.name + ' added to this chat'); })
          .catch(function (e) { toast(e.message); });
      }
    });
    var dr = acts.querySelector('[data-a="drawer"]');
    if (dr) dr.addEventListener('click', function () {
      window.ConnectOverlay.close();
      if (window.Artifacts) window.Artifacts.openDrawer(ws.kind === 'device' ? ws.id : sidNow(),
        { name: ws.kind === 'device' ? 'device' : 'cloud' });
      else toast('open the artifacts drawer');
    });
    var ch = acts.querySelector('[data-a="chat"]');
    if (ch) ch.addEventListener('click', function () {
      window.ConnectOverlay.close();
      var inp = document.getElementById('chat-input');
      if (inp) {
        inp.value = 'explore the ' + ws.name + ' workspace: give me the repo brief (structure, readme digest, recent activity)';
        inp.focus();
      }
    });
    var tok = acts.querySelector('[data-a="token"]');
    if (tok) tok.addEventListener('click', function () { openTokenPage(ws); });
    var web = acts.querySelector('[data-a="web"]');
    if (web) web.addEventListener('click', function () {
      if (ws.repo_url) window.open(ws.repo_url, '_blank');
    });
    acts.querySelector('[data-a="unbind"]').addEventListener('click', function () {
      api('/api/workspaces/' + encodeURIComponent(ws.id), 'DELETE')
        .then(function () { loadGlobals(); refreshPills(); toast('forgot ' + ws.name); })
        .catch(function (e) { toast(e.message); });
    });
  }

  // push a page onto the overlay nav stack (edit A4: back pops one level)
  function pushPage(html, wire) {
    window.ConnectOverlay.pushPage(html, { onSwap: function () { if (wire) wire(); } });
  }

  // ── THE CONNECT PAGE (edit A5: no giant bottom note; cloud gets a
  // formatted, theme-colored description) ─────────────────────────────────
  function openConnectPage() {
    pushPage(connectHTML(), wireConnectPage);
  }

  function connectHTML() {
    return (
      '<div class="wsx">' +
        '<div class="wsx-head"><span class="wsx-title">connect workspace</span></div>' +
        '<div class="wsx-opt" id="wso-cloud">' +
          '<span class="wsx-ico k-github">☁</span>' +
          '<span class="wsx-mid">Cloud Workspace</span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        // edit A5: the formatted, theme-colored cloud description
        '<div class="wsx-cloudhero">' +
          '<div style="font-size:var(--ui-small-fs);color:var(--text-2);line-height:1.5">' +
            'connect <b style="color:var(--text-1)">any repo URL</b> — recognized hosts below. ' +
            'a plain URL is <b style="color:var(--text-1)">read-only</b>; sign in for writes.' +
          '</div>' +
          '<div class="wsx-chips">' +
            '<span class="wsx-chip c1">🐙 github</span>' +
            '<span class="wsx-chip c2">🍵 gitea</span>' +
            '<span class="wsx-chip c3">🦊 gitlab</span>' +
            '<span class="wsx-chip cn">🪶 sourcehut</span>' +
            '<span class="wsx-chip cn">📦 self-hosted</span>' +
          '</div>' +
          '<div class="wsx-chips" style="margin-top:6px">' +
            '<span class="wsx-chip cn">read</span>' +
            '<span class="wsx-chip cw">partial — fork + PR</span>' +
            '<span class="wsx-chip c2">full — direct commits</span>' +
          '</div>' +
        '</div>' +
        '<div class="wsx-opt" id="wso-create">' +
          '<span class="wsx-ico k-gitea">✚</span>' +
          '<span class="wsx-mid">create new repo' +
            '<div class="wsx-meta">from scratch — name, license, gitignore</div></span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        '<div class="wsx-opt" id="wso-discover">' +
          '<span class="wsx-ico k-github">⌂</span>' +
          '<span class="wsx-mid">my repos' +
            '<div class="wsx-meta">your GitHub — pick branches, one-tap connect</div></span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        '<div class="wsx-opt" id="wso-device">' +
          '<span class="wsx-ico k-device">📱</span>' +
          '<span class="wsx-mid">device storage' +
            '<div class="wsx-meta">a folder on this device — read + write, never leaves your phone</div></span>' +
          '<span style="color:var(--accent-2)">›</span>' +
        '</div>' +
        '<div class="wsx-opt" aria-disabled="true">' +
          '<span class="wsx-ico k-generic">▤</span>' +
          '<span class="wsx-mid">local folder<div class="wsx-meta">coming soon</div></span>' +
        '</div>' +
      '</div>');
  }

  function wireConnectPage() {
    var c = document.getElementById('wso-cloud');
    if (c) c.addEventListener('click', function () { openCloudForm(''); });
    var cr = document.getElementById('wso-create');
    if (cr) cr.addEventListener('click', openCreateForm);
    var d = document.getElementById('wso-discover');
    if (d) d.addEventListener('click', openDiscover);
    var dv = document.getElementById('wso-device');
    if (dv) dv.addEventListener('click', openDevicePage);
  }

  function pageHead(title) {
    return (
      '<div class="wsx-head"><span class="wsx-title">' + esc(title) + '</span></div>');
  }

  // ── cloud connect form (edit A8: sign-in first, token manual) ──────────
  function openCloudForm(prefill) {
    pushPage(cloudFormHTML(prefill), function () { wireCloudForm(prefill); });
  }

  function cloudFormHTML(prefill) {
    return (
      '<div class="wsx">' +
        pageHead('☁ cloud workspace') +
        '<div class="wsx-field"><div class="wsx-label">REPO URL</div>' +
          '<input class="wsx-input" id="wsf-url" placeholder="https://github.com/owner/repo" ' +
          'autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(prefill || '') + '"></div>' +
        '<div class="wsx-note" id="wsf-preview">paste any repo URL — the host is recognized automatically</div>' +
        signinHTML('github', 'wsf') +
        '<div class="wsx-err" id="wsf-err" style="display:none"></div>' +
        '<button class="wsx-go" id="wsf-go">connect</button>' +
        '<div class="wsx-note">read-only with just a URL · signed in (or a token) upgrades to ' +
          'partial (fork + PR) or full (direct commits). tokens live in the engine\'s ' +
          'encrypted vault, never in the chat.</div>' +
      '</div>');
  }

  function wireCloudForm(prefill) {
    wireSignin(document, 'github', 'wsf', function () {
      // signed in — re-render this page to show the ✓ state
      pushPage(cloudFormHTML(prefill), function () { wireCloudForm(prefill); });
    });
    var url = document.getElementById('wsf-url');
    var prev = document.getElementById('wsf-preview');
    if (url) url.addEventListener('input', function () {
      var v = url.value.trim();
      if (!v) { prev.textContent = 'paste any repo URL — the host is recognized automatically'; return; }
      var m = v.replace(/^https?:\/\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)\/([\w.-]+)/);
      if (m) prev.textContent = 'recognized: ' + kindIcon(guessKind(m[1])) + ' ' + m[1] + ' · ' + m[2] + '/' + m[3];
      else if (/^[\w.-]+\//.test(v)) prev.textContent = 'looks like a repo path — connecting will probe the host';
      else prev.textContent = 'keep typing…';
    });
    var go = document.getElementById('wsf-go');
    if (go) go.addEventListener('click', function () {
      var u = (url ? url.value : '').trim();
      var err = document.getElementById('wsf-err');
      err.style.display = 'none';
      if (!u) { err.textContent = 'a URL is required'; err.style.display = ''; return; }
      go.disabled = true; go.textContent = 'connecting…';
      // token: only if the user opened the manual row and typed one
      var manualTok = '';
      var mt = document.getElementById('wsf-token');
      if (mt && mt.value.trim()) manualTok = mt.value.trim();
      api('/api/workspaces/connect', 'POST', {
        url: u,
        token: manualTok,
        session_id: sidNow() || ''
      }).then(function (d) {
        refreshPills();
        pushPage(
          '<div class="wsx">' +
            pageHead('connected') +
            '<div class="wsx-list"><div class="wsx-row">' +
              '<span class="wsx-ico k-' + esc(d.kind) + '">' + kindIcon(d.kind) + '</span>' +
              '<span class="wsx-mid"><span class="wsx-name">' + esc(d.name) + '</span>' +
              '<div class="wsx-meta">' + esc(d.kind + ' · ' + (d.branch || '')) + '</div></span>' +
              '<span class="wsx-badge ' + esc(d.access) + '">' + esc(d.access) + '</span>' +
            '</div></div>' +
            '<div class="wsx-ok">access level: ' + esc(d.access) +
              (d.access === 'read' ? ' — sign in (or attach a token) to upgrade.' :
               d.access === 'partial' ? ' — you can fork + open PRs.' :
               ' — the agent can commit directly.') + '</div>' +
            '<button class="wsx-go" id="wsx-done">done</button>' +
          '</div>',
          function () {
            var done = document.getElementById('wsx-done');
            if (done) done.addEventListener('click', backToPicker);
          });
        toast('connected ' + d.name + ' (' + d.access + ')');
      }).catch(function (e) {
        go.disabled = false; go.textContent = 'connect';
        err.textContent = e.message; err.style.display = '';
      });
    });
  }

  function backToPicker() {
    // pop everything back to the picker root (level 1)
    while (window.ConnectOverlay.pageDepth() > 1) {
      if (!window.ConnectOverlay.popPage()) break;
    }
    loadGlobals();
  }

  function guessKind(host) {
    host = String(host || '').toLowerCase();
    if (/(^|\.)github\.com$/.test(host)) return 'github';
    if (/(^|\.)gitlab\.com$/.test(host)) return 'gitlab';
    if (/gitea|codeberg/.test(host)) return 'gitea';
    if (/sr\.ht$/.test(host)) return 'sourcehut';
    return 'generic';
  }

  // ── token attach / upgrade page (sign-in first, per-workspace override) ─
  function openTokenPage(ws) {
    pushPage(
      '<div class="wsx">' +
        pageHead('🔑 upgrade — ' + esc(ws.name)) +
        signinHTML(ws.kind === 'gitea' ? 'gitea' : 'github', 'wst') +
        '<div class="wsx-note">a signed-in account (or a token with push rights) upgrades this ' +
          'workspace to full access — direct API commits. stored encrypted in the engine vault.</div>' +
        '<div class="wsx-err" id="wst-err" style="display:none"></div>' +
      '</div>',
      function () {
        wireSignin(document, ws.kind === 'gitea' ? 'gitea' : 'github', 'wst', function () {
          // account saved — re-probe this workspace with it
          api('/api/workspaces/' + encodeURIComponent(ws.id) + '/token', 'POST', { use_account: true })
            .then(function (d) { toast('access: ' + d.access); backToPicker(); })
            .catch(function (e) { toast(e.message); });
        });
      });
  }

  // ── create repo form (edit A10: uses the saved sign-in) ────────────────
  function openCreateForm() {
    pushPage(createFormHTML(), wireCreateForm);
  }

  function createFormHTML() {
    return (
      '<div class="wsx">' +
        pageHead('✚ create new repo') +
        signinHTML('github', 'wsc') +
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
        '<div class="wsx-err" id="wsc-err" style="display:none"></div>' +
        '<button class="wsx-go" id="wsc-go">create + connect</button>' +
      '</div>');
  }

  function wireCreateForm() {
    wireSignin(document, 'github', 'wsc', function () {
      pushPage(createFormHTML(), wireCreateForm);
    });
    var loadLists = function () {
      ['license', 'gitignore'].forEach(function (which) {
        api('/api/workspaces/' + which + 's?kind=github').then(function (d) {
          var sel = document.getElementById('wsc-' + which);
          if (!sel) return;
          var key = which === 'license' ? 'licenses' : 'gitignores';
          (d[key] || []).forEach(function (l) {
            var o = document.createElement('option'); o.value = l; o.textContent = l;
            sel.appendChild(o);
          });
        }).catch(function () {});
      });
    };
    if (accounts.github.signed_in) loadLists();
    var go = document.getElementById('wsc-go');
    if (go) go.addEventListener('click', function () {
      var err = document.getElementById('wsc-err');
      err.style.display = 'none';
      var name = document.getElementById('wsc-name').value.trim();
      if (!name) { err.textContent = 'a name is required'; err.style.display = ''; return; }
      if (!accounts.github.signed_in) {
        err.textContent = 'sign in above first — the new repo needs an owner account';
        err.style.display = ''; return;
      }
      go.disabled = true; go.textContent = 'creating…';
      api('/api/workspaces/create-repo', 'POST', {
        kind: 'github',
        name: name,
        description: document.getElementById('wsc-desc').value.trim(),
        license: document.getElementById('wsc-license').value,
        gitignore: document.getElementById('wsc-gitignore').value,
        private: document.getElementById('wsc-priv').value === 'private',
        session_id: sidNow() || ''
      }).then(function (d) {
        refreshPills();
        toast('created ' + d.name + ' — full access');
        backToPicker();
      }).catch(function (e) {
        go.disabled = false; go.textContent = 'create + connect';
        err.textContent = e.message; err.style.display = '';
      });
    });
  }

  // ── MY REPOS (edit A10: sign-in-first + the rework) ────────────────────
  function openDiscover() {
    pushPage(discoverHTML(), function () {
      wireSignin(document, 'github', 'wsd', function () {
        pushPage(discoverHTML(), wireDiscover);
        listMyRepos();
      });
      if (accounts.github.signed_in) listMyRepos();
    });
    if (accounts.github.signed_in) listMyRepos();
  }

  function discoverHTML() {
    return (
      '<div class="wsx">' +
        pageHead('⌂ my repos') +
        signinHTML('github', 'wsd') +
        '<div class="wsx-list" id="wsd-list"></div>' +
        '<div class="wsx-err" id="wsd-err" style="display:none"></div>' +
      '</div>');
  }

  function wireDiscover() {
    wireSignin(document, 'github', 'wsd', function () {
      pushPage(discoverHTML(), wireDiscover);
      listMyRepos();
    });
    if (accounts.github.signed_in) listMyRepos();
  }

  function repoTypeMark(r) {
    if (r.fork) return '<span class="wsx-type fork" title="fork">⑂</span>';
    if (r.private) return '<span class="wsx-type priv" title="private">🔒</span>';
    return '<span class="wsx-type pub" title="public">◇</span>';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
    return Math.floor(s / 2592000) + 'mo ago';
  }

  function listMyRepos() {
    var list = document.getElementById('wsd-list');
    if (!list) return;
    list.innerHTML = '<div class="wsx-sub">loading your repos…</div>';
    api('/api/workspaces/discover?kind=github&limit=100').then(function (d) {
      var repos = d.repos || [];
      if (!repos.length) {
        list.innerHTML = '<div class="wsx-sub">no repos on that account</div>';
        return;
      }
      // edit A10: group by owner (nesting + indentation), varied type
      // marks, stars/language/updated meta, theme colors throughout.
      var byOwner = {};
      var order = [];
      repos.forEach(function (r) {
        var owner = (r.full_name || r.name).split('/')[0] || 'yours';
        if (!byOwner[owner]) { byOwner[owner] = []; order.push(owner); }
        byOwner[owner].push(r);
      });
      var html = '';
      order.forEach(function (owner) {
        html += '<div class="wsx-reposec">' + esc(owner) +
          '<span style="color:var(--text-3);font-weight:400"> · ' +
          byOwner[owner].length + '</span></div>';
        byOwner[owner].forEach(function (r) {
          var meta = [];
          if (r.stars != null) meta.push('<span class="wsx-stat"><span class="star">★</span> ' + r.stars + '</span>');
          if (r.language) meta.push('<span class="wsx-stat"><span class="dot"></span> ' + esc(r.language) + '</span>');
          if (r.updated_at) meta.push(esc(timeAgo(r.updated_at)));
          html +=
            '<div class="wsx-repo" data-url="' + esc(r.web_url || '') + '" data-name="' + esc(r.full_name || r.name) + '" data-def="' + esc(r.default_branch || '') + '">' +
              '<div class="wsx-row">' +
                repoTypeMark(r) +
                '<span class="wsx-mid">' +
                  '<span class="wsx-name" style="font-size:var(--ui-small-fs)">' + esc((r.full_name || r.name).split('/').pop()) + '</span>' +
                  '<div class="wsx-meta">' + (meta.length ? meta.join('<span style="color:var(--border-strong)"> · </span>') :
                    esc(r.default_branch || '')) + '</div>' +
                '</span>' +
                '<span style="color:var(--text-3)">›</span>' +
              '</div>' +
            '</div>';
        });
      });
      list.innerHTML = html;
      Array.prototype.forEach.call(list.querySelectorAll('.wsx-repo'), function (el) {
        el.addEventListener('click', function () {
          openRepoDetail(el.getAttribute('data-url'), el.getAttribute('data-name'),
            el.getAttribute('data-def'));
        });
      });
    }).catch(function (e) {
      list.innerHTML = '';
      var err = document.getElementById('wsd-err');
      if (err) { err.textContent = e.message; err.style.display = ''; }
    });
  }

  // ── REPO DETAIL (edit A10: entire repo | pick branches) ────────────────
  function openRepoDetail(url, name, defaultBranchHint) {
    pushPage(
      '<div class="wsx">' +
        pageHead('⑂ ' + esc(name || 'repo')) +
        '<div class="wsx-sub" style="padding-top:10px">' + esc(url) + '</div>' +
        '<div class="wsx-field"><div class="wsx-label">WHAT TO SYNC</div></div>' +
        '<div class="wsx-opt" id="wrd-all" style="border-color:rgba(var(--accent-2-rgb),0.5);' +
          'background:rgba(var(--accent-2-rgb),0.06)">' +
          '<span class="wsx-ico k-github">◍</span>' +
          '<span class="wsx-mid">entire repo' +
            '<div class="wsx-meta" id="wrd-allmeta">default branch' +
            (defaultBranchHint ? ': ' + esc(defaultBranchHint) : ' — everything reachable') + '</div></span>' +
        '</div>' +
        '<div class="wsx-opt" id="wrd-pick">' +
          '<span class="wsx-ico k-gitea">⑂</span>' +
          '<span class="wsx-mid">pick branches' +
            '<div class="wsx-meta">choose one or a specific set</div></span>' +
        '</div>' +
        '<div id="wrd-brwrap" style="display:none">' +
          '<div class="wsx-brlist" id="wrd-brlist"><div class="wsx-sub">loading branches…</div></div>' +
        '</div>' +
        '<div class="wsx-err" id="wrd-err" style="display:none"></div>' +
        '<button class="wsx-go" id="wrd-go">connect</button>' +
        '<div class="wsx-note">zero-download: the agent works through the forge API. branch picks ' +
          'persist on the workspace (switchable in the drawer).</div>' +
      '</div>',
      function () { wireRepoDetail(url, name, defaultBranchHint); });
  }

  function wireRepoDetail(url, name, defaultBranchHint) {
    var mode = 'all';
    var picked = {};   // branch -> true
    var branches = [];
    var defaultBranch = defaultBranchHint || '';
    var allRow = document.getElementById('wrd-all');
    var pickRow = document.getElementById('wrd-pick');
    var brWrap = document.getElementById('wrd-brwrap');
    allRow.addEventListener('click', function () {
      mode = 'all';
      allRow.style.borderColor = 'rgba(var(--accent-2-rgb),0.5)';
      allRow.style.background = 'rgba(var(--accent-2-rgb),0.06)';
      pickRow.style.borderColor = 'var(--surface-3)';
      pickRow.style.background = 'var(--surface-1)';
      brWrap.style.display = 'none';
    });
    pickRow.addEventListener('click', function () {
      mode = 'pick';
      pickRow.style.borderColor = 'rgba(var(--accent-2-rgb),0.5)';
      pickRow.style.background = 'rgba(var(--accent-2-rgb),0.06)';
      allRow.style.borderColor = 'var(--surface-3)';
      allRow.style.background = 'var(--surface-1)';
      brWrap.style.display = '';
      if (!branches.length) loadBranches();
    });
    function loadBranches() {
      var listEl = document.getElementById('wrd-brlist');
      api('/api/explore/view/branches?url=' + encodeURIComponent(url)).then(function (d) {
        branches = [];
        (d.items || []).forEach(function (b) {
          // the forge returns branches as plain strings; other views as
          // objects — accept both shapes
          var nm = (typeof b === 'string') ? b : (b.name || b.Name || '');
          if (nm) branches.push(nm);
        });
        if (!branches.length) {
          listEl.innerHTML = '<div class="wsx-sub">no branches listed — connect with the default</div>';
          return;
        }
        defaultBranch = defaultBranchHint || branches[0];
        // put the default first so the precheck + label are right
        branches = branches.slice().sort(function (a, b) {
          if (a === defaultBranch) return -1;
          if (b === defaultBranch) return 1;
          return 0;
        });
        var meta = document.getElementById('wrd-allmeta');
        if (meta) meta.textContent = 'default branch: ' + defaultBranch;
        var html = '';
        branches.forEach(function (b) {
          picked[b] = b === defaultBranch;
          html +=
            '<div class="wsx-br' + (picked[b] ? ' on' : '') + '" data-br="' + esc(b) + '">' +
              '<span class="box">' + (picked[b] ? '✓' : '') + '</span>' +
              '<span style="color:var(--text-1)">' + esc(b) + '</span>' +
              (b === defaultBranch ? '<span class="def">default</span>' : '') +
            '</div>';
        });
        listEl.innerHTML = html;
        Array.prototype.forEach.call(listEl.querySelectorAll('.wsx-br'), function (row) {
          row.addEventListener('click', function () {
            var b = row.getAttribute('data-br');
            picked[b] = !picked[b];
            row.classList.toggle('on', picked[b]);
            row.querySelector('.box').textContent = picked[b] ? '✓' : '';
          });
        });
      }).catch(function (e) {
        listEl.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>';
      });
    }
    var go = document.getElementById('wrd-go');
    go.addEventListener('click', function () {
      var err = document.getElementById('wrd-err');
      err.style.display = 'none';
      var chosen = mode === 'all'
        ? (defaultBranch ? [defaultBranch] : [])
        : Object.keys(picked).filter(function (b) { return picked[b]; });
      if (mode === 'pick' && !chosen.length) {
        err.textContent = 'pick at least one branch (or choose entire repo)';
        err.style.display = '';
        return;
      }
      go.disabled = true; go.textContent = 'connecting…';
      api('/api/workspaces/connect', 'POST', {
        url: url, session_id: sidNow() || ''
      }).then(function (d) {
        if (mode === 'pick' && chosen.length) {
          return api('/api/workspaces/' + encodeURIComponent(d.id) + '/branches', 'POST', {
            branches: chosen,
            primary: chosen[0] || ''
          }).then(function () { return d; }).catch(function () { return d; });
        }
        return d;
      }).then(function (d) {
        refreshPills();
        toast('connected ' + d.name + (mode === 'pick' ? ' (' + chosen.length + ' branches)' : ''));
        backToPicker();
      }).catch(function (e) {
        go.disabled = false; go.textContent = 'connect';
        err.textContent = e.message; err.style.display = '';
      });
    });
  }

  // ── DEVICE STORAGE (edit A11) ───────────────────────────────────────────
  //
  // A real folder on THIS device via the File System Access API: the user
  // grants permission once, we suggest a location (Doomalay/<name> inside
  // the folder they pick — or they browse anywhere), the handle goes into
  // IndexedDB, and the workspace row is GLOBAL — every chatbot can bind it.
  // Reads/writes go straight to disk through the handle; nothing uploads.

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('doomalay-ws', 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('handles');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbPut(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('handles', 'readonly');
        var rq = tx.objectStore('handles').get(key);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  // ensure permission (a user gesture must be in the call stack for
  // requestPermission — all our entry points are taps)
  function ensurePerm(handle) {
    if (!handle) return Promise.resolve(false);
    if (handle.queryPermission) {
      return handle.queryPermission({ mode: 'readwrite' }).then(function (state) {
        if (state === 'granted') return true;
        if (handle.requestPermission) {
          return handle.requestPermission({ mode: 'readwrite' }).then(function (s2) {
            return s2 === 'granted';
          }).catch(function () { return false; });
        }
        return false;
      }).catch(function () { return false; });
    }
    return Promise.resolve(true); // older API shape — try and let ops fail
  }

  function openDevicePage() {
    var supported = typeof window.showDirectoryPicker === 'function';
    pushPage(
      '<div class="wsx">' +
        pageHead('📱 device storage') +
        '<div class="wsx-cloudhero" style="background:linear-gradient(135deg,' +
          'rgba(var(--accent-rgb),0.10),rgba(var(--accent-2-rgb),0.07));' +
          'border-color:rgba(var(--accent-rgb),0.35)">' +
          '<div style="font-size:var(--ui-small-fs);color:var(--text-2);line-height:1.5">' +
            'a folder <b style="color:var(--text-1)">on this device</b> — this chatbot reads ' +
            'and writes files there. files <b style="color:var(--text-1)">never leave your ' +
            'phone</b>, and the workspace is saved for every chatbot to use.</div>' +
          '<div class="wsx-chips">' +
            '<span class="wsx-chip c1">read + write</span>' +
            '<span class="wsx-chip cn">stays on device</span>' +
            '<span class="wsx-chip c3">all chatbots</span>' +
          '</div>' +
        '</div>' +
        '<div class="wsx-field"><div class="wsx-label">WORKSPACE NAME</div>' +
          '<input class="wsx-input" id="wsv-name" placeholder="' +
          esc(currentPicker.chat || 'my files') + '" autocomplete="off" spellcheck="false"></div>' +
        '<div class="wsx-field"><div class="wsx-label">LOCATION</div></div>' +
        '<div class="wsx-opt" id="wsv-pick">' +
          '<span class="wsx-ico k-device">📂</span>' +
          '<span class="wsx-mid">choose a folder' +
            '<div class="wsx-meta" id="wsv-pickmeta">' + (supported
              ? 'grant permission → we suggest a spot inside, or browse anywhere'
              : 'this browser can\'t grant folder access (needs Chrome/Edge)') + '</div></span>' +
        '</div>' +
        '<div class="wsx-note" id="wsv-note"></div>' +
        '<div class="wsx-err" id="wsv-err" style="display:none"></div>' +
        '<button class="wsx-go" id="wsv-go" disabled>save device workspace</button>' +
      '</div>',
      function () { wireDevicePage(supported); });
  }

  function wireDevicePage(supported) {
    var dirHandle = null;
    var subfolder = true; // use the suggested Doomalay/<name> subfolder
    var pick = document.getElementById('wsv-pick');
    var note = document.getElementById('wsv-note');
    var go = document.getElementById('wsv-go');
    var nameInput = document.getElementById('wsv-name');
    if (nameInput && !nameInput.value && currentPicker.chat) nameInput.value = currentPicker.chat;
    pick.addEventListener('click', function () {
      if (!supported) return;
      window.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) {
        dirHandle = h;
        go.disabled = false;
        note.innerHTML =
          'picked: <b style="color:var(--text-1)">' + esc(h.name) + '</b>' +
          '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="wsx-act primary" id="wsv-sub">use a suggested subfolder inside</button>' +
            '<button class="wsx-act" id="wsv-asis">use this folder as-is</button>' +
          '</div>';
        var sub = document.getElementById('wsv-sub');
        var asis = document.getElementById('wsv-asis');
        sub.addEventListener('click', function () {
          subfolder = true;
          sub.style.borderColor = 'rgba(var(--accent-2-rgb),0.6)';
          asis.style.borderColor = 'var(--surface-3)';
          suggestName();
        });
        asis.addEventListener('click', function () {
          subfolder = false;
          asis.style.borderColor = 'rgba(var(--accent-2-rgb),0.6)';
          sub.style.borderColor = 'var(--surface-3)';
        });
        suggestName();
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the picker
        var err = document.getElementById('wsv-err');
        if (err) { err.textContent = String(e.message || e); err.style.display = ''; }
      });
      function suggestName() {
        var nm = (nameInput.value || 'workspace').trim();
        var meta = document.getElementById('wsv-pickmeta');
        if (meta && subfolder) meta.textContent = 'suggested: ' + h.name + '/Doomalay/' + nm +
          ' — we\'ll create it inside';
      }
    });
    go.addEventListener('click', function () {
      var err = document.getElementById('wsv-err');
      err.style.display = 'none';
      var name = (nameInput.value || '').trim() || 'my files';
      if (!dirHandle) return;
      var target = dirHandle;
      var finish = function () {
        var displayPath = target.name + (subfolder ? '/Doomalay/' + name : '');
        api('/api/workspaces/device', 'POST', {
          name: name,
          path: displayPath,
          session_id: sidNow() || ''
        }).then(function (d) {
          return idbPut('ws-' + d.id, target).then(function () {
            refreshPills();
            toast('device workspace "' + name + '" saved — files stay on this device');
            backToPicker();
          });
        }).catch(function (e) {
          err.textContent = e.message; err.style.display = '';
        });
      };
      if (subfolder) {
        // create Doomalay/<name> inside the picked folder (idempotent)
        dirHandle.getDirectoryHandle('Doomalay', { create: true }).then(function (dh) {
          return dh.getDirectoryHandle(name, { create: true });
        }).then(function (dh) { target = dh; finish(); })
          .catch(function (e) { err.textContent = e.message; err.style.display = ''; });
      } else {
        finish();
      }
    });
  }

  // device tree: walk a directory handle one level at a time
  function deviceEntries(dirHandle) {
    var out = [];
    return new Promise(function (resolve) {
      var it = dirHandle.entries();
      var step = function () {
        it.next().then(function (res) {
          if (res.done) { resolve(out); return; }
          out.push(res.value);
          step();
        }).catch(function () { resolve(out); });
      };
      step();
    });
  }

  // ── CLOUD FILE VIEWER/EDITOR — now an overlay page (edit A1: no more
  // custom fullscreen div; rides the sanctioned overlay + its static ✕) ──
  function openCloudFile(ws, path) {
    ensureStyles();
    var q = 'path=' + encodeURIComponent(path);
    if (ws.branch) q += '&ref=' + encodeURIComponent(ws.branch);
    var sha = '';
    window.ConnectOverlay.open(
      '<div class="wsx" style="display:flex;flex-direction:column;min-height:0">' +
        '<div class="wsx-head"><span class="wsx-title" style="font-size:var(--ui-fs);' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(path) + '</span>' +
          '<span class="wsx-badge ' + esc(ws.access) + '">' + esc(ws.access) + '</span></div>' +
        '<div id="wsv-body" style="min-height:60px"><span class="wsx-sub">loading…</span></div>' +
      '</div>');
    api('/api/workspaces/' + encodeURIComponent(ws.id) + '/file?' + q).then(function (fc) {
      var body = document.getElementById('wsv-body');
      if (!body) return;
      sha = fc.sha || '';
      if (fc.binary) {
        body.innerHTML = '<div class="wsx-sub">📦 binary file — ' + fmtSize(fc.size) + '</div>' +
          '<button class="wsx-go" id="wsv-dl">open raw in browser</button>';
        var dl = document.getElementById('wsv-dl');
        if (dl) dl.addEventListener('click', function () {
          window.open((ws.repo_url || '') + '/blob/' + encodeURIComponent(ws.branch || 'HEAD') + '/' + path, '_blank');
        });
        return;
      }
      var text = fc.content || '';
      if (ws.access === 'full') {
        body.innerHTML = '<textarea class="wsv-ta" id="wsv-ta" spellcheck="false"></textarea>' +
          '<div style="display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--surface-2)">' +
            '<button class="wsx-go" id="wsv-save" style="margin:0;width:auto;padding:8px 18px">commit</button>' +
            '<span class="wsx-note" id="wsv-note" style="padding:6px 0">edits commit straight to ' +
            esc(ws.branch || 'the branch') + '</span>' +
          '</div>';
        document.getElementById('wsv-ta').value = text;
        document.getElementById('wsv-save').addEventListener('click', function () {
          var btn = document.getElementById('wsv-save');
          btn.disabled = true; btn.textContent = 'committing…';
          api('/api/workspaces/' + encodeURIComponent(ws.id) + '/file', 'PUT', {
            path: path,
            content: document.getElementById('wsv-ta').value,
            message: 'doomalay: update ' + path,
            branch: ws.branch || '',
            sha: sha
          }).then(function (d) {
            btn.disabled = false; btn.textContent = 'commit';
            var n = document.getElementById('wsv-note');
            if (n) n.textContent = '✓ committed — ' + (d.commit_url || '');
            toast('committed ' + path);
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'commit';
            var n = document.getElementById('wsv-note');
            if (n) n.textContent = '⚠ ' + e.message;
          });
        });
      } else {
        body.innerHTML = '<pre class="wsv-pre">' + esc(text) + '</pre>' +
          '<div class="wsx-note">read-only' + (ws.access === 'partial'
            ? ' for this repo (partial access writes go through forks/PRs — ask in chat)' : '') + '</div>';
      }
    }).catch(function (e) {
      var body = document.getElementById('wsv-body');
      if (body) body.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>';
    });
  }

  // ── DEVICE FILE VIEWER/EDITOR (reads/writes straight to disk) ──────────
  function openDeviceFile(wsId, name) {
    ensureStyles();
    window.ConnectOverlay.open(
      '<div class="wsx" style="display:flex;flex-direction:column;min-height:0">' +
        '<div class="wsx-head"><span class="wsx-title" style="font-size:var(--ui-fs)">' + esc(name) + '</span>' +
          '<span class="wsx-badge full">device</span></div>' +
        '<div id="wsv-body" style="min-height:60px"><span class="wsx-sub">loading…</span></div>' +
      '</div>');
    idbGet('ws-' + wsId).then(function (handle) {
      if (!handle) throw new Error('folder handle missing — re-pick the folder in the workspace list');
      return ensurePerm(handle).then(function (ok) {
        if (!ok) throw new Error('folder permission denied — tap the file again and allow access');
        return handle.getFile();
      });
    }).then(function (file) {
      var body = document.getElementById('wsv-body');
      if (!body) return;
      return file.text().then(function (text) {
        body.innerHTML = '<textarea class="wsv-ta" id="wsv-ta" spellcheck="false"></textarea>' +
          '<div style="display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--surface-2)">' +
            '<button class="wsx-go" id="wsv-save" style="margin:0;width:auto;padding:8px 18px">save to device</button>' +
            '<span class="wsx-note" id="wsv-note" style="padding:6px 0">writes straight to disk</span>' +
          '</div>';
        document.getElementById('wsv-ta').value = text;
        document.getElementById('wsv-save').addEventListener('click', function () {
          var btn = document.getElementById('wsv-save');
          btn.disabled = true; btn.textContent = 'saving…';
          idbGet('ws-' + wsId).then(function (h) {
            var w = h.createWritable();
            return w.write(new Blob([document.getElementById('wsv-ta').value])).then(function () {
              return w.close();
            });
          }).then(function () {
            btn.disabled = false; btn.textContent = 'save to device';
            var n = document.getElementById('wsv-note');
            if (n) n.textContent = '✓ saved';
            toast('saved ' + name + ' to device');
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'save to device';
            var n = document.getElementById('wsv-note');
            if (n) n.textContent = '⚠ ' + e.message;
          });
        });
      });
    }).catch(function (e) {
      var body = document.getElementById('wsv-body');
      if (body) body.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>';
    });
  }

  // ── ARTIFACTS DRAWER: the cloud section (+ branch switcher, edit A10) ──
  function renderCloudSection(listEl, sessionId) {
    if (!listEl || !sessionId) return;
    api('/api/sessions/' + encodeURIComponent(sessionId) + '/workspaces').then(function (d) {
      var rows = (d.workspaces || []).filter(function (w) { return w.kind !== 'device'; });
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
    var branches = (ws.meta && Array.isArray(ws.meta.branches)) ? ws.meta.branches : [];
    row.innerHTML =
      '<span style="flex-shrink:0;width:18px;font-size:13px">▶</span>' +
      '<span style="flex-shrink:0;font-size:14px">' + kindIcon(ws.kind) + '</span>' +
      '<span class="wsc-name" style="font-weight:600">' + esc(ws.name || ws.repo) + '</span>' +
      '<span class="wsc-size">' + esc(ws.access || 'read') + '</span>';
    var branch = document.createElement('div');
    branch.style.display = 'none';
    listEl.appendChild(row);
    // edit A10: the branch switcher for multi-branch workspaces
    var brSel = null;
    if (branches.length > 1) {
      brSel = document.createElement('select');
      brSel.className = 'wsc-brsel';
      branches.forEach(function (b) {
        var o = document.createElement('option');
        o.value = b; o.textContent = b;
        if (b === ws.branch) o.selected = true;
        brSel.appendChild(o);
      });
      brSel.addEventListener('change', function () {
        ws.branch = brSel.value;
        branch.innerHTML = '';
        loaded = false;
        loadCloudLevel(branch, ws, '', 1);
      });
      brSel.addEventListener('click', function (e) { e.stopPropagation(); });
      row.appendChild(brSel);
    }
    listEl.appendChild(branch);
    var loaded = false;
    row.addEventListener('click', function (e) {
      if (e.target === brSel) return;
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

  // ── ARTIFACTS DRAWER: the device section (local FS handles) ────────────
  function renderDeviceSection(listEl, sessionId) {
    if (!listEl || !sessionId) return;
    api('/api/sessions/' + encodeURIComponent(sessionId) + '/workspaces').then(function (d) {
      var rows = (d.workspaces || []).filter(function (w) { return w.kind === 'device'; });
      if (!rows.length) return;
      var head = document.createElement('div');
      head.className = 'wsc-sec';
      head.textContent = '📱 DEVICE STORAGE';
      listEl.appendChild(head);
      rows.forEach(function (ws) {
        var row = document.createElement('div');
        row.className = 'wsc-row';
        row.style.setProperty('--d', '0');
        row.innerHTML =
          '<span style="flex-shrink:0;width:18px;font-size:13px">▶</span>' +
          '<span style="flex-shrink:0;font-size:14px">📱</span>' +
          '<span class="wsc-name" style="font-weight:600">' + esc(ws.name) + '</span>' +
          '<span class="wsc-size">' + esc((ws.meta && ws.meta.display_path) || 'device') + '</span>';
        var kids = document.createElement('div');
        kids.style.display = 'none';
        listEl.appendChild(row);
        listEl.appendChild(kids);
        var loaded = false;
        row.addEventListener('click', function () {
          var open = kids.style.display !== 'none';
          kids.style.display = open ? 'none' : '';
          row.firstChild.textContent = open ? '▶' : '▼';
          if (!loaded && !open) {
            loaded = true;
            loadDeviceLevel(kids, ws, 1);
          }
        });
      });
    }).catch(function () {});
  }

  function loadDeviceLevel(container, ws, depth) {
    var loading = document.createElement('div');
    loading.className = 'wsc-row';
    loading.style.setProperty('--d', String(depth));
    loading.innerHTML = '<span class="wsc-size">loading…</span>';
    container.appendChild(loading);
    idbGet('ws-' + ws.id).then(function (handle) {
      if (!handle) throw new Error('folder handle missing');
      return ensurePerm(handle).then(function (ok) {
        if (!ok) throw new Error('permission needed — tap the folder row again');
        return deviceEntries(handle);
      });
    }).then(function (entries) {
      loading.remove();
      if (!entries.length) {
        var e = document.createElement('div');
        e.className = 'wsc-row'; e.style.setProperty('--d', String(depth));
        e.innerHTML = '<span class="wsc-size">(empty)</span>';
        container.appendChild(e);
        return;
      }
      entries.forEach(function (pair) {
        var name = pair[0], handle = pair[1];
        var isDir = handle.kind === 'directory';
        var row = document.createElement('div');
        row.className = 'wsc-row';
        row.style.setProperty('--d', String(depth));
        row.innerHTML =
          '<span style="flex-shrink:0;width:18px;font-size:13px">' + (isDir ? '▶' : '·') + '</span>' +
          '<span class="wsc-name">' + esc(name) + '</span>';
        container.appendChild(row);
        if (isDir) {
          var sub = document.createElement('div');
          sub.style.display = 'none';
          container.appendChild(sub);
          row.addEventListener('click', function () {
            var o = sub.style.display !== 'none';
            sub.style.display = o ? 'none' : '';
            row.firstChild.textContent = o ? '▶' : '▼';
            if (!o && !sub.dataset.loaded) {
              sub.dataset.loaded = '1';
              loadDeviceLevel(sub, { id: ws.id, __dir: handle }, depth + 1);
            }
          });
        } else {
          row.addEventListener('click', function () {
            openDeviceFileFromHandle(ws.id, name, handle);
          });
        }
      });
    }).catch(function (e) {
      loading.remove();
      var err = document.createElement('div');
      err.className = 'wsc-row'; err.style.setProperty('--d', String(depth));
      err.innerHTML = '<span class="wsc-size" style="color:var(--err)">⚠ ' + esc(e.message) + '</span>';
      container.appendChild(err);
    });
  }

  // device rows below the top level use the DIR handle directly
  function openDeviceFileFromHandle(wsId, name, fileHandle) {
    ensureStyles();
    window.ConnectOverlay.open(
      '<div class="wsx" style="display:flex;flex-direction:column;min-height:0">' +
        '<div class="wsx-head"><span class="wsx-title" style="font-size:var(--ui-fs)">' + esc(name) + '</span>' +
          '<span class="wsx-badge full">device</span></div>' +
        '<div id="wsv-body" style="min-height:60px"><span class="wsx-sub">loading…</span></div>' +
      '</div>');
    fileHandle.getFile().then(function (file) {
      var body = document.getElementById('wsv-body');
      if (!body) return;
      if (file.size > 2 * 1024 * 1024) {
        body.innerHTML = '<div class="wsx-sub">📦 ' + fmtSize(file.size) + ' — too big to edit inline</div>';
        return;
      }
      return file.text().then(function (text) {
        body.innerHTML = '<textarea class="wsv-ta" id="wsv-ta" spellcheck="false"></textarea>' +
          '<div style="display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--surface-2)">' +
            '<button class="wsx-go" id="wsv-save" style="margin:0;width:auto;padding:8px 18px">save to device</button>' +
            '<span class="wsx-note" id="wsv-note" style="padding:6px 0">writes straight to disk</span>' +
          '</div>';
        document.getElementById('wsv-ta').value = text;
        document.getElementById('wsv-save').addEventListener('click', function () {
          var btn = document.getElementById('wsv-save');
          btn.disabled = true; btn.textContent = 'saving…';
          var w = fileHandle.createWritable();
          w.write(new Blob([document.getElementById('wsv-ta').value])).then(function () {
            return w.close();
          }).then(function () {
            btn.disabled = false; btn.textContent = 'save to device';
            var n = document.getElementById('wsv-note');
            if (n) n.textContent = '✓ saved';
            toast('saved ' + name + ' to device');
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'save to device';
            var n = document.getElementById('wsv-note');
            if (n) n.textContent = '⚠ ' + e.message;
          });
        });
      });
    }).catch(function (e) {
      var body = document.getElementById('wsv-body');
      if (body) body.innerHTML = '<div class="wsx-err">' + esc(e.message) + '</div>';
    });
  }

  function fmtSize(n) {
    n = Number(n || 0);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ── THE PILL (chatpanel wires this into the header's pill row) ────────
  // v0.46: accepts a LIVE session GETTER (function) — the v0.44 bug: the
  // pill captured state.sessionId before the engine session landed, the
  // picker then connected with a null sid, the bind was skipped, and the
  // workspace "instantly disconnected".
  function pill(sessionIdOrFn) {
    ensureStyles();
    var b = document.createElement('button');
    b.id = 'pill-workspace';
    b.className = 'pill-workspace';
    // v0.52 (user item 7): the pill reads "▣ + workspace <count>" — the
    // icon-only form didn't say what it does.
    b.innerHTML = '▣ + workspace <span id="pill-workspace-count">0</span>';
    b.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
      'background:rgba(var(--accent-2-rgb),0.06);border:1px solid rgba(var(--accent-2-rgb),0.55);color:var(--accent-2);' +
      'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
      'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2';
    b.title = 'Cloud workspaces connected to this chat';
    var getSid = (typeof sessionIdOrFn === 'function')
      ? sessionIdOrFn
      : function () { return sessionIdOrFn || null; };
    b._wsGetSid = getSid;
    var paint = function () {
      var sid = getSid();
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
      openPicker(getSid, null);
    });
    paint();
    onPillRefresh(paint);
    return b;
  }

  // session can lag the pill's construction (model connect flow) — the
  // panel re-wires the pill when the session lands (now a getter swap,
  // not a rebuild)
  function setPillSession(btn, sessionId) {
    if (!btn) return btn;
    btn._wsGetSid = function () { return sessionId || null; };
    return btn;
  }

  // ── exports ────────────────────────────────────────────────────────────
  window.Workspace = {
    pill: pill,
    setPillSession: setPillSession,
    openPicker: openPicker,
    openCloudFile: openCloudFile,
    openDeviceFile: openDeviceFile,
    renderCloudSection: renderCloudSection,
    renderDeviceSection: renderDeviceSection,
    refreshPills: refreshPills,
    onPillRefresh: onPillRefresh,
    toast: toast
  };
})();
