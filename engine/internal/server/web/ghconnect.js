// ghconnect.js — v0.48 (task 11): the GitHub connect panel.
//
// Mirrors hfconnect.js exactly (user spec: "reuse the HF connect panel
// pattern for a GitHub equivalent with OAuth auto-connect + optional manual
// token paste"):
//   1. big "Sign in with GitHub" button → GET /api/workspaces/oauth/github/
//      start (the Doomalay GitHub App — client id ships built-in);
//   2. when the OAuth secret isn't configured yet: a one-time "OAuth setup"
//      box (paste the GitHub App client secret → POST /api/workspaces/oauth/
//      github/config) — the panel shows the exact redirect URI to register;
//   3. "Optional manual method" — paste-token box (POST /api/workspaces/
//      accounts {kind:"github", token}, verified against api.github.com/user);
//   4. "get token ↗" link → https://github.com/settings/tokens.
//
// Two hosts, same builder: openConnectPanel (ConnectOverlay page) and
// connectPanelView (master-panel view) — the sandbox picker's Docker option
// ("sign in to HF first, then GitHub") opens the overlay one.
//
// Exposes: window.GHConnect = { openConnectPanel, connectPanelView, account }
(function () {
  'use strict';

  function account() {
    return fetch('/api/gh/account').then(function (r) { return r.json(); });
  }

  function bodyHTML(acct) {
    // v0.52: the setup box is ALWAYS in the DOM (hidden unless the secret
    // is missing) — the panel-view host renders before the account probe
    // answers, and wire()'s refresh() then shows/hides it live. The
    // overlay host (which renders AFTER the probe) pre-sets visibility.
    var secretNeeded = acct ? !acct.has_secret : true;
    return '' +
      '<div style="padding:26px 22px">' +
        '<div id="ghc-state" style="margin-bottom:16px"></div>' +
        '<button id="ghc-oauth" style="width:100%;padding:14px;border-radius:12px;' +
          'background:var(--accent);color:var(--bg-app);border:none;font-size:15px;font-weight:600;' +
          'font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(var(--accent-rgb),0.3)">' +
          'Sign in with GitHub</button>' +
        '<p style="font-size:12px;color:var(--text-3);margin:12px 0 0;line-height:1.5">' +
          'One tap: you\'ll be redirected to github.com to log in and authorize ' +
          'the Doomalay app — the token is acquired automatically and stored in ' +
          'the engine\'s encrypted vault. We never see your password.</p>' +
        '<div id="ghc-setup" style="margin:16px 0 0;padding:14px;border-radius:10px;' +
          'background:rgba(var(--notice-rgb),0.10);border:1px solid rgba(var(--notice-rgb),0.35)' +
          (secretNeeded ? '' : ';display:none') + '">' +
          '<div style="font-size:12px;font-weight:700;color:var(--notice);margin-bottom:6px">' +
            '🔐 one-time OAuth setup — paste the client secret once</div>' +
          '<p style="font-size:12px;color:var(--text-3);margin:0 0 8px;line-height:1.5">' +
            'Sign-in needs the Doomalay GitHub App <b style="color:var(--text-2)">client secret</b> to finish its ' +
            'token exchange. Paste it <b style="color:var(--text-2)">once per install</b> — it is encrypted into ' +
            'this device\'s vault and <b style="color:var(--ok)">never leaves the device</b> (it is NOT shipped ' +
            'inside the app and no one else can read it from here). The box disappears once saved.' +
            ' <span id="ghc-cid">App client id: <code style="color:var(--text-2);font-size:11px">' +
            ((acct && acct.client_id) || 'built-in') + '</code></span> · redirect URI this install answers:' +
            ' <code id="ghc-ruri" style="color:var(--text-2);font-size:11px;word-break:break-all">' +
            ((acct && acct.redirect_uri) || '…') + '</code></p>' +
          '<div style="display:flex;gap:8px">' +
            '<input id="ghc-secret" type="password" placeholder="GitHub App client secret" autocomplete="off" style="flex:1;' +
              'padding:10px 12px;border-radius:10px;border:1px solid var(--border);' +
              'background:var(--surface-2);color:var(--text-1);font-size:13px;font-family:inherit;outline:none">' +
            '<button id="ghc-save-secret" style="padding:10px 14px;border-radius:10px;' +
              'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border-strong);' +
              'font-size:12px;font-weight:600;font-family:inherit;cursor:pointer">save</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin:22px 0 0;padding-top:18px;border-top:1px solid var(--border)">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;' +
            'letter-spacing:0.06em;margin-bottom:10px">Optional manual method</div>' +
          '<input id="ghc-token" type="text" placeholder="ghp_… / github_pat_…" autocomplete="off" style="width:100%;' +
            'box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--border);' +
            'background:var(--surface-2);color:var(--text-1);font-size:13px;font-family:inherit;outline:none">' +
          '<button id="ghc-manual" style="width:100%;margin-top:8px;padding:11px;border-radius:10px;' +
            'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border-strong);' +
            'font-size:13px;font-weight:600;font-family:inherit;cursor:pointer">connect with token</button>' +
          '<div style="margin-top:10px;text-align:center">' +
            '<a id="ghc-gettoken" href="#" style="font-size:12px;color:var(--accent-2);text-decoration:none">' +
              'get token ↗</a></div>' +
        '</div>' +
        '<div id="ghc-err" style="margin-top:12px;font-size:12px;color:var(--err);min-height:16px"></div>' +
      '</div>';
  }

  function paintState(el, acct) {
    if (!el) return;
    if (acct && acct.connected) {
      el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;' +
        'border-radius:10px;background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.35)">' +
        '<span style="color:var(--ok);font-weight:700;font-size:14px">✓</span>' +
        '<span style="color:var(--ok);font-size:13px;font-weight:600">connected as ' +
        (acct.user || 'unknown') + '</span></div>';
    } else {
      el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;' +
        'border-radius:10px;background:rgba(var(--warn-rgb),0.10);border:1px solid rgba(var(--warn-rgb),0.3)">' +
        '<span style="color:var(--warn);font-size:14px">●</span>' +
        '<span style="color:var(--warn);font-size:13px;font-weight:600">not connected</span></div>';
    }
  }

  function wire(el, onDone) {
    var errEl = el.querySelector('#ghc-err');
    var stateEl = el.querySelector('#ghc-state');

    var refresh = function () {
      account().then(function (a) {
        paintState(stateEl, a);
        var btn = el.querySelector('#ghc-oauth');
        if (btn && !a.has_secret) {
          btn.title = 'needs the one-time OAuth setup below (client secret)';
        }
        // v0.52: live-toggle the setup box + refresh its id/URI hints —
        // the panel-view host renders before the probe answers.
        var box = el.querySelector('#ghc-setup');
        if (box) box.style.display = a.has_secret ? 'none' : '';
        var cid = el.querySelector('#ghc-cid code');
        if (cid && a.client_id) cid.textContent = a.client_id;
        var ruri = el.querySelector('#ghc-ruri');
        if (ruri && a.redirect_uri) ruri.textContent = a.redirect_uri;
      }).catch(function () {});
    };
    refresh();

    var oauth = el.querySelector('#ghc-oauth');
    if (oauth) oauth.addEventListener('click', function () {
      oauth.disabled = true; oauth.textContent = 'Redirecting…';
      window.location.href = '/api/workspaces/oauth/github/start?redirect=/';
    });

    var saveSecret = el.querySelector('#ghc-save-secret');
    if (saveSecret) saveSecret.addEventListener('click', function () {
      var sec = (el.querySelector('#ghc-secret').value || '').trim();
      if (!sec) { errEl.textContent = 'paste the client secret first'; return; }
      errEl.textContent = '';
      saveSecret.disabled = true; saveSecret.textContent = 'saving…';
      // v0.52: client_id omitted — the engine keeps the built-in app id
      // (or the previously saved one). The secret itself is the only
      // sensitive half of the pair, and it goes vault-only.
      fetch('/api/workspaces/oauth/github/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_secret: sec })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
        return r.json();
      }).then(function () {
        saveSecret.disabled = false; saveSecret.textContent = 'save';
        errEl.textContent = '';
        if (window.toast) window.toast('OAuth secret saved (encrypted on this device) — sign in works now');
        // hide the setup box (re-render state)
        var box = el.querySelector('#ghc-setup');
        if (box) box.style.display = 'none';
      }).catch(function (e) {
        saveSecret.disabled = false; saveSecret.textContent = 'save';
        errEl.textContent = e.message || 'could not save the secret';
      });
    });

    var link = el.querySelector('#ghc-gettoken');
    if (link) link.addEventListener('click', function (e) {
      e.preventDefault();
      window.open('https://github.com/settings/tokens', '_blank');
    });

    var manual = el.querySelector('#ghc-manual');
    if (manual) manual.addEventListener('click', function () {
      var tok = (el.querySelector('#ghc-token').value || '').trim();
      if (!tok) { errEl.textContent = 'paste a token first'; return; }
      errEl.textContent = '';
      manual.disabled = true; manual.textContent = 'connecting…';
      fetch('/api/workspaces/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'github', token: tok })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
        return r.json();
      }).then(function (d) {
        manual.disabled = false; manual.textContent = 'connect with token';
        paintState(stateEl, { connected: true, user: d.login || '?' });
        if (onDone) onDone(d.login || '');
      }).catch(function (e) {
        manual.disabled = false; manual.textContent = 'connect with token';
        errEl.textContent = e.message || 'GitHub rejected the token';
      });
    });
  }

  function openConnectPanel(opts) {
    opts = opts || {};
    account().then(function (acct) {
      window.ConnectOverlay.open(bodyHTML(acct), {
        onSwap: function () {
          var root = document.getElementById('ghc-oauth');
          wire(root ? root.parentElement : document, opts.onDone);
        }
      });
    }).catch(function () {
      window.ConnectOverlay.open(bodyHTML(null), {
        onSwap: function () {
          var root = document.getElementById('ghc-oauth');
          wire(root ? root.parentElement : document, opts.onDone);
        }
      });
    });
  }

  function connectPanelView(opts) {
    opts = opts || {};
    return {
      title: 'connect github',
      render: function () {
        // rendered async-ish: the panel view renders synchronously, so this
        // builds the no-account variant; wire() refreshes the state + the
        // setup box visibility immediately after mount.
        return bodyHTML(null);
      },
      onMount: function (el) { wire(el, opts.onDone); }
    };
  }

  window.GHConnect = {
    openConnectPanel: openConnectPanel,
    connectPanelView: connectPanelView,
    account: account
  };
})();
