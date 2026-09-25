// ghconnect.js — v0.61: the GitHub connect panel — GITHUB STANDS ALONE.
//
// THE PRODUCTION SIGN-IN (v0.61, PLAN-AUTH-V061): GitHub, fully separated
// from HuggingFace — no HF login, no space, no broker in the path. The
// engine now ships the GitHub App's client secret gh-CLI-style (GitHub's
// own CLI embeds its secret in open source: "This value is safe to be
// embedded in version control") + PKCE S256, so the button auto-picks:
//   1. loopback origin + secret available (the shipped default once
//      armed) → THE DIRECT ONE-PRESS: a POPUP to
//      /api/workspaces/oauth/github/start → github.com/login/oauth/
//      authorize (login if needed → press Authorize — first run also
//      picks "Only select repositories" = complete access over ONE
//      repo) → back to the engine's loopback callback → done page →
//      postMessage + auto-close → this panel repaints. No code entry,
//      no HF anywhere, zero setup;
//   2. gateway/preview/LAN origins (callback can't be registered there)
//      → the v0.60.2 space broker popup when armed, else the v0.55
//      DEVICE-CODE flow (one-time code at github.com/login/device — the
//      engine polls in the background; the open button uses the
//      ?user_code= prefill URL GitHub's login wall preserves);
//   3. "Optional manual method" — paste-token box (POST /api/workspaces/
//      accounts {kind:"github", token});
//   4. "get token ↗" link → https://github.com/settings/tokens.
//
// v0.60 SYNC (kept): a `message` listener (done-page postMessage) +
// visibilitychange/focus/pageshow refetches of /api/gh/account repaint
// the panel the moment the user is back.
//
// Two hosts, same builder: openConnectPanel (ConnectOverlay page) and
// connectPanelView (master-panel view) — the workspace picker's GitHub row
// opens the overlay one.
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

  // isLoopbackOrigin — v0.61: only a loopback origin's callback URL can be
  // registered on the GitHub App (exact-match rule), so the DIRECT one-
  // press web flow runs here and nowhere else. Gateways/previews/LAN keep
  // the broker (when armed) / device flow.
  function isLoopbackOrigin() {
    var h = (window.location.hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  // ── v0.60.2: the space broker probe (the one-click, repo-scoped path) ──
  // /api/gh/account carries broker_url; the panel probes the space's
  // /gh/oauth/config (CORS-open boolean — no secret material) and, when
  // the space holds the GitHub App secret, the primary button becomes the
  // BROKER popup: one Authorize click on GitHub with "Only select
  // repositories" = complete access over ONE repo (the user's spec). The
  // device flow stays as the linked fallback for every other case.
  var broker = { url: '', configured: false };
  function probeBroker(url, onReady) {
    if (!url || broker.url === url) { if (onReady) onReady(); return; }
    broker.url = url;
    fetch(url.replace(/\/$/, '') + '/gh/oauth/config', { mode: 'cors' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (c && c.configured) {
          broker.configured = true;
          paintBrokerMode();
        }
        if (onReady) onReady();
      })
      .catch(function () { if (onReady) onReady(); }); // unreachable space → device flow
  }
  function paintBrokerMode() {
    var btn = document.getElementById('ghc-oauth');
    var copy = document.getElementById('ghc-copy');
    var alt = document.getElementById('ghc-code-fallback');
    if (btn && btn.textContent.indexOf('one click') < 0) {
      btn.textContent = 'Sign in with GitHub — one click';
    }
    if (copy) {
      copy.innerHTML = 'One click, no codes: a window opens to GitHub where you press ' +
        '<b style="color:var(--text-2)">Install &amp; Authorize</b>. On the repository ' +
        'screen pick <b style="color:var(--text-2)">Only select repositories</b> and ' +
        'choose your repo — that grants complete access to that repo only ' +
        '(branches, files, PRs), never your whole account. The window closes ' +
        'itself and this panel updates. The token is stored in the engine\'s ' +
        'encrypted vault — we never see your password.';
    }
    if (alt) alt.style.display = 'block';
  }
  // paintOneTapMode — v0.61: the DIRECT one-press copy (loopback + shipped
  // secret). Same button label as the broker mode, different story: the
  // popup goes STRAIGHT to GitHub — nothing of HuggingFace is involved.
  function paintOneTapMode() {
    var btn = document.getElementById('ghc-oauth');
    var copy = document.getElementById('ghc-copy');
    var alt = document.getElementById('ghc-code-fallback');
    if (btn && btn.textContent.indexOf('one click') < 0) {
      btn.textContent = 'Sign in with GitHub — one click';
    }
    if (copy) {
      copy.innerHTML = 'One press, no codes, no HuggingFace: a window opens ' +
        '<b style="color:var(--text-2)">straight to GitHub</b> — log in if ' +
        'asked, press <b style="color:var(--text-2)">Authorize</b> and you\'re ' +
        'done. The first time, pick <b style="color:var(--text-2)">Only select ' +
        'repositories</b> and choose your repo — that grants complete access ' +
        'to that repo only (branches, files, PRs), never your whole account. ' +
        'The window closes itself and this panel updates; the token is stored ' +
        'in the engine\'s encrypted vault. We never see your password.';
    }
    if (alt) alt.style.display = 'block';
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

  // panelMode — v0.61: which one-click flavor the button is in (set by
  // refresh; the waitPopup reset + re-opened panels need it).
  var panelMode = { oneTap: false };

  // waitPopup — disable the button while the popup lives; re-enable when
  // the user closes it without finishing (shared by both popup flows).
  function waitPopup(oauth, p, errEl) {
    oauth.disabled = true; oauth.textContent = 'Waiting for GitHub…';
    if (errEl) errEl.textContent = '';
    var watch = setInterval(function () {
      var closed = true;
      try { closed = p.closed; } catch (e) {}
      if (closed) {
        clearInterval(watch);
        if (active && !active.connectedUser) {
          oauth.disabled = false;
          oauth.textContent = (panelMode.oneTap || broker.configured)
            ? 'Sign in with GitHub — one click' : 'Sign in with GitHub';
        }
      }
    }, 800);
  }

  function bodyHTML(acct) {
    return '' +
      '<div style="padding:26px 22px">' +
        '<div id="ghc-state" style="margin-bottom:16px"></div>' +
        '<button id="ghc-oauth" style="width:100%;padding:14px;border-radius:12px;' +
          'background:var(--accent);color:var(--bg-app);border:none;font-size:15px;font-weight:600;' +
          'font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(var(--accent-rgb),0.3)">' +
          'Sign in with GitHub</button>' +
        '<p id="ghc-copy" style="font-size:12px;color:var(--text-3);margin:12px 0 0;line-height:1.5">' +
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
        '<a id="ghc-code-fallback" href="#" style="display:none;margin:10px 0 0;font-size:12px;' +
          'color:var(--accent-2);text-decoration:none">or use a one-time code instead →</a>' +
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
  // v0.61: the open button prefers verification_uri_complete (the ?user_code=
  // prefill URL — GitHub's login wall preserves it, so the code may already
  // be typed in when the user lands).
  function paintDeviceUI(stateEl, d) {
    if (!stateEl) return;
    var uri = d.verification_uri || 'https://github.com/login/device';
    var openUri = d.verification_uri_complete || uri;
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
      window.open(openUri, '_blank');
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
    var oneTap = false; // v0.61: loopback + secret → the direct one-press
    var refresh = function () {
      account().then(function (a) {
        paintState(stateEl, a);
        if (a && a.connected && active) active.connectedUser = a.user || '?';
        // v0.61: the DIRECT one-press rules on loopback (GitHub fully
        // separated from HF — no broker in the path). Off-loopback the
        // v0.60.2 broker is still the one-click option when armed.
        oneTap = !!(a && a.has_secret) && isLoopbackOrigin();
        panelMode.oneTap = oneTap;
        if (oneTap) {
          paintOneTapMode();
        } else if (a && a.broker_url && !(a.connected)) {
          probeBroker(a.broker_url);
        }
      }).catch(function () {});
    };
    refresh();

    var altLink = el.querySelector('#ghc-code-fallback');
    if (altLink) altLink.addEventListener('click', function (e) {
      e.preventDefault();
      runDeviceFlow(el, errEl, stateEl, el.querySelector('#ghc-oauth'), onDone);
    });
    // a re-opened panel gets fresh DOM — re-apply the one-click paint if
    // the probe/refresh already ran in this page session
    if (broker.configured) paintBrokerMode();

    var oauth = el.querySelector('#ghc-oauth');
    if (oauth) {
      active.btn = oauth;
      oauth.addEventListener('click', function () {
        // v0.61 priority: direct one-press (loopback) → broker (gateway,
        // armed) → device flow. `oneTap` is refreshed by account() and
        // also re-derived here so a slow first fetch never strands the
        // button in device mode.
        if (oneTap) {
          var dp = openAuthPopup('/api/workspaces/oauth/github/start?redirect=/');
          if (dp) waitPopup(oauth, dp, errEl);
          return;
        }
        if (broker.configured) {
          var bp = openAuthPopup('/api/gh/oauth/broker/start?origin=' +
            encodeURIComponent(window.location.origin));
          if (bp) waitPopup(oauth, bp, errEl);
          return;
        }
        account().then(function (a) {
          if (a && a.has_secret && isLoopbackOrigin()) {
            var p = openAuthPopup('/api/workspaces/oauth/github/start?redirect=/');
            if (p) waitPopup(oauth, p, errEl);
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
    _applyAuthResult: applyAuthResult, // test hook — simulate the done-page message
    _broker: broker // test hook — the probe state
  };
})();
