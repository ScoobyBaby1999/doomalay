// ghconnect.js — v0.55: the GitHub connect panel.
//
// THE PRODUCTION SIGN-IN (v0.55): GitHub has no public-client redirect flow
// (the code exchange always demands the client secret — shipping it inside
// a distributed app would leak it to every install). So "Sign in with
// GitHub" now auto-picks:
//   1. secret configured on this install (env/vault — self-hosters) → the
//      one-tap REDIRECT flow (GET /api/workspaces/oauth/github/start) —
//      v0.60: in a POPUP (the app tab never navigates; the popup ends on
//      the engine's done page which postMessages back and closes itself;
//      the APK WebView can't popup → same-tab fallback, where the redirect
//      into the external browser is intercepted and the SPA survives);
//   2. otherwise → the DEVICE-CODE flow (POST /api/workspaces/oauth/github/
//      device/start): a one-time code to enter at github.com/login/device,
//      the engine polls GitHub in the background, the token lands in this
//      device's encrypted vault. NO secret anywhere, no setup, works the
//      same for every user of a shipped build (same flow the gh CLI uses).
//   3. "Optional manual method" — paste-token box (POST /api/workspaces/
//      accounts {kind:"github", token});
//   4. "get token ↗" link → https://github.com/settings/tokens.
//
// v0.60 SYNC: like the HF panel, a `message` listener (done-page
// postMessage) + visibilitychange/focus/pageshow refetches of
// /api/gh/account repaint the panel the moment the user is back.
//
// Two hosts, same builder: openConnectPanel (ConnectOverlay page) and
// connectPanelView (master-panel view) — the workspace picker's GitHub row
// (no secret configured) opens the overlay one.
//
// Exposes: window.GHConnect = { openConnectPanel, connectPanelView, account,
//                               _applyAuthResult (test hook) }
(function () {
  'use strict';

  function account() {
    return fetch('/api/gh/account').then(function (r) { return r.json(); });
  }

  // ── v0.60: live panel sync (same shape as hfconnect.js) ──────────────
  var active = null; // {stateEl, errEl, btn, onDone, connectedUser}
  function applyAuthResult(d) {
    if (!active) return;
    if (d && d.error) {
      if (active.errEl) active.errEl.textContent = d.error;
      if (active.btn) { active.btn.disabled = false; active.btn.textContent = 'Sign in with GitHub'; }
      return;
    }
    var login = (d && d.user) || '?';
    if (active.connectedUser === login) return; // dedupe: message + focus both fire
    active.connectedUser = login;
    paintState(active.stateEl, { connected: true, user: login });
    if (active.btn) { active.btn.disabled = false; active.btn.textContent = 'Sign in with GitHub'; }
    if (window.toast) window.toast('signed in to GitHub as ' + login + ' — token saved encrypted');
    if (active.onDone) active.onDone(login);
  }
  function installSyncListeners() {
    if (installSyncListeners.done) return;
    installSyncListeners.done = true;
    window.addEventListener('message', function (e) {
      if (!active || !e.data || e.data.type !== 'doomalay-auth') return;
      if (e.data.provider !== 'github') return;
      if (e.origin !== window.location.origin) return;
      applyAuthResult(e.data);
    });
    var refetch = function () {
      if (!active || active.connectedUser) return;
      account().then(function (a) {
        if (a && a.connected) applyAuthResult({ provider: 'github', user: a.user });
      }).catch(function () {});
    };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refetch(); });
    window.addEventListener('focus', refetch);
    window.addEventListener('pageshow', refetch); // bfcache back-restore
  }

  // openAuthPopup — popup FIRST so the app tab never navigates (see
  // hfconnect.js; the Android WebView takes the same-tab path).
  function openAuthPopup(url) {
    if (/\bwv\b/.test(navigator.userAgent || '')) { window.location.href = url; return null; }
    var p = null;
    try { p = window.open(url, 'doomalay-gh', 'width=520,height=680'); } catch (e) {}
    if (p) { try { p.focus(); } catch (e) {} }
    return p;
  }

  function bodyHTML(acct) {
    return '' +
      '<div style="padding:26px 22px">' +
        '<div id="ghc-state" style="margin-bottom:16px"></div>' +
        '<button id="ghc-oauth" style="width:100%;padding:14px;border-radius:12px;' +
          'background:var(--accent);color:var(--bg-app);border:none;font-size:15px;font-weight:600;' +
          'font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(var(--accent-rgb),0.3)">' +
          'Sign in with GitHub</button>' +
        '<p style="font-size:12px;color:var(--text-3);margin:12px 0 0;line-height:1.5">' +
          'One login: you\'ll get a short <b style="color:var(--text-2)">one-time ' +
          'code</b> — not a password — to enter at ' +
          '<b style="color:var(--text-2)">github.com/login/device</b> (the page opens for you). ' +
          'GitHub\'s own note there ("staff will never ask you for this code") is its ' +
          'standard phishing guard — the code only confirms this sign-in and can\'t ' +
          'be reused. The app asks for <b style="color:var(--text-2)">repository access ' +
          'only</b>: read/write your code, open pull requests. No account settings, ' +
          'no profile, no emails. Press <b style="color:var(--text-2)">Authorize</b> and the ' +
          'token is acquired automatically into the engine\'s encrypted vault. ' +
          'We never see your password.</p>' +
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

  // paintDeviceUI — the "enter this code" panel of the device flow. The
  // poll loop flips it to connected/expired/error as GitHub answers.
  function paintDeviceUI(stateEl, d) {
    if (!stateEl) return;
    var uri = d.verification_uri || 'https://github.com/login/device';
    stateEl.innerHTML = '' +
      '<div style="padding:16px;border-radius:12px;background:var(--surface-2);' +
        'border:1px solid var(--border-strong)">' +
        '<div style="font-size:12px;color:var(--text-3);margin-bottom:8px">' +
          'step 1 — enter this one-time code (not a password) at <b style="color:var(--text-2)">' + uri.replace(/^https?:\/\//, '') + '</b>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
          '<span id="ghc-devcode" style="font-size:26px;font-weight:700;letter-spacing:0.12em;' +
            'color:var(--text-1);font-family:inherit">' + (d.user_code || '…') + '</span>' +
          '<button id="ghc-copy" style="padding:7px 12px;border-radius:10px;background:var(--surface-2);' +
            'color:var(--text-1);border:1px solid var(--border-strong);font-size:12px;font-weight:600;' +
            'font-family:inherit;cursor:pointer">copy</button>' +
          '<button id="ghc-open" style="padding:7px 12px;border-radius:10px;background:var(--accent);' +
            'color:var(--bg-app);border:none;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer">' +
            'open github ↗</button>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-3);line-height:1.5">' +
          'step 2 — press <b style="color:var(--text-2)">Authorize</b> on the GitHub page ' +
          '(repository access only). ' +
          '<span id="ghc-wait" style="color:var(--accent-2)">waiting for you…</span></div>' +
      '</div>';
    var copy = stateEl.querySelector('#ghc-copy');
    if (copy) copy.addEventListener('click', function () {
      var code = (stateEl.querySelector('#ghc-devcode') || {}).textContent || '';
      var done = function () { copy.textContent = 'copied ✓'; setTimeout(function () { copy.textContent = 'copy'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, done);
      } else { done(); }
    });
    var open = stateEl.querySelector('#ghc-open');
    if (open) open.addEventListener('click', function () {
      window.open(uri, '_blank');
    });
  }

  // runDeviceFlow — start the device grant and poll the engine's status
  // endpoint until it resolves. onDone(login) fires exactly on success.
  function runDeviceFlow(el, errEl, stateEl, btn, onDone) {
    btn.disabled = true; btn.textContent = 'starting…';
    errEl.textContent = '';
    fetch('/api/workspaces/oauth/github/device/start', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
        return r.json();
      })
      .then(function (d) {
        paintDeviceUI(stateEl, d);
        var poll = null;
        var stop = function () {
          if (poll) { clearInterval(poll); poll = null; }
          btn.disabled = false; btn.textContent = 'Sign in with GitHub';
        };
        poll = setInterval(function () {
          fetch('/api/workspaces/oauth/github/device/status')
            .then(function (r) { return r.json(); })
            .then(function (st) {
              if (st.status === 'connected') {
                stop();
                paintState(stateEl, { connected: true, user: st.login || 'unknown' });
                if (window.toast) window.toast('signed in to GitHub as ' + (st.login || '?') + ' — token saved encrypted');
                if (onDone) onDone(st.login || '');
              } else if (st.status === 'expired') {
                stop();
                errEl.textContent = 'the code expired before authorization — press Sign in with GitHub for a fresh one';
              } else if (st.status === 'error') {
                stop();
                errEl.textContent = st.error || 'GitHub refused the sign-in';
              }
              // pending | idle (a newer flow replaced ours?) → keep waiting
            })
            .catch(function () { /* transient — the next tick retries */ });
        }, 2500);
      })
      .catch(function (e) {
        btn.disabled = false; btn.textContent = 'Sign in with GitHub';
        errEl.textContent = e.message || 'could not start the device flow';
      });
  }

  function wire(el, onDone) {
    var errEl = el.querySelector('#ghc-err');
    var stateEl = el.querySelector('#ghc-state');

    installSyncListeners();
    active = { stateEl: stateEl, errEl: errEl, btn: null, onDone: onDone, connectedUser: null };
    var refresh = function () {
      account().then(function (a) {
        paintState(stateEl, a);
        if (a && a.connected && active) active.connectedUser = a.user || '?';
      }).catch(function () {});
    };
    refresh();

    var oauth = el.querySelector('#ghc-oauth');
    if (oauth) {
      active.btn = oauth;
      oauth.addEventListener('click', function () {
        // v0.55: secret configured (self-hosted install) → one-tap redirect
        // (v0.60: in a POPUP); otherwise → the secretless device flow.
        account().then(function (a) {
          if (a && a.has_secret) {
            var p = openAuthPopup('/api/workspaces/oauth/github/start?redirect=/');
            if (p) {
              oauth.disabled = true; oauth.textContent = 'Waiting for GitHub…';
              if (errEl) errEl.textContent = '';
              var watch = setInterval(function () {
                var closed = true;
                try { closed = p.closed; } catch (e) {}
                if (closed) {
                  clearInterval(watch);
                  if (active && !active.connectedUser) {
                    oauth.disabled = false; oauth.textContent = 'Sign in with GitHub';
                  }
                }
              }, 800);
            }
          } else {
            runDeviceFlow(el, errEl, stateEl, oauth, onDone);
          }
        }).catch(function () {
          runDeviceFlow(el, errEl, stateEl, oauth, onDone);
        });
      });
    }

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
    window.ConnectOverlay.open(bodyHTML(null), {
      onSwap: function () {
        var root = document.getElementById('ghc-oauth');
        wire(root ? root.parentElement : document, opts.onDone);
      }
    });
  }

  function connectPanelView(opts) {
    opts = opts || {};
    return {
      title: 'connect github',
      render: function () {
        return bodyHTML(null);
      },
      onMount: function (el) { wire(el, opts.onDone); }
    };
  }

  window.GHConnect = {
    openConnectPanel: openConnectPanel,
    connectPanelView: connectPanelView,
    account: account,
    _applyAuthResult: applyAuthResult // test hook — simulate the done-page message
  };
})();
