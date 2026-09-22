// hfconnect.js — v0.48: the Hugging Face connect panel + Space logs viewer.
//
// TASK 1 (v0.48): the canvas-grid 🤗 button and its runtime status pill are
// GONE (rolled back) — this module no longer owns any canvas chrome.
//
// TASK 3: the connect panel — one builder, TWO hosts:
//   • window.HFConnect.openConnectPanel({onDone}) — the reusable ConnectOverlay
//     page (the sandbox picker's "Connect to HF" button opens this).
//   • window.HFConnect.connectPanelView({onDone}) — the same UI as a master-
//     panel view; the hub-publish flow pushes it when there is no token, so
//     "the panel that appears when publishing to the hub with no token" and
//     the sandbox picker's connect button are THE SAME panel.
//
// Layout (user spec, in order):
//   1. big "Connect Hugging Face" button → GET /api/hf/oauth/start (the
//      doomalaysocreate OAuth app auto-acquires a write/read token — no
//      manual steps);
//   2. "Optional manual method" — paste-token textbox + connect
//      (POST /api/hub/auth/connect {token});
//   3. "get token ↗" link → https://huggingface.co/settings/tokens.
//
// Keeps (v0.46): openLogs / openLogsFor — the run/build logs viewer with the
// Wake button (used by the sandbox picker's build-failure "view logs" link).
//
// Exposes: window.HFConnect = { openConnectPanel, connectPanelView,
//                               openLogs, openLogsFor, current, account }
(function () {
  'use strict';

  var curSpace = null; // {repo, stage, running, sleeping, ...}

  // ── the shared account probe ───────────────────────────────────────────
  function account() {
    return fetch('/api/hf/account').then(function (r) { return r.json(); });
  }

  // ── the shared connect-panel body ──────────────────────────────────────
  // renderBody() → html; wireBody(el, api, onDone) → hooks it up.
  // `api` is the transport ({post: fn(url, body)}) so the overlay and the
  // panel view can reuse their own error/toast conventions.
  function connectBodyHTML() {
    return '' +
      '<div style="padding:26px 22px">' +
        '<div id="hfc-state" style="margin-bottom:16px"></div>' +
        '<button id="hfc-oauth" style="width:100%;padding:14px;border-radius:12px;' +
          'background:var(--accent);color:var(--bg-app);border:none;font-size:15px;font-weight:600;' +
          'font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(var(--accent-rgb),0.3)">' +
          'Connect Hugging Face</button>' +
        '<p style="font-size:12px;color:var(--text-3);margin:12px 0 0;line-height:1.5">' +
          'One tap: you\'ll be redirected to huggingface.co to log in and allow ' +
          'Doomalay — the token (read + write to your Spaces) is acquired ' +
          'automatically and stored in the engine\'s encrypted vault. ' +
          'We never see your password.</p>' +
        '<div style="margin:22px 0 0;padding-top:18px;border-top:1px solid var(--border)">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;' +
            'letter-spacing:0.06em;margin-bottom:10px">Optional manual method</div>' +
          '<input id="hfc-token" type="text" placeholder="hf_…" autocomplete="off" style="width:100%;' +
            'box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--border);' +
            'background:var(--surface-2);color:var(--text-1);font-size:13px;font-family:inherit;outline:none">' +
          '<button id="hfc-manual" style="width:100%;margin-top:8px;padding:11px;border-radius:10px;' +
            'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border-strong);' +
            'font-size:13px;font-weight:600;font-family:inherit;cursor:pointer">connect with token</button>' +
          '<div style="margin-top:10px;text-align:center">' +
            '<a id="hfc-gettoken" href="#" style="font-size:12px;color:var(--accent-2);text-decoration:none">' +
              'get token ↗</a></div>' +
        '</div>' +
        '<div id="hfc-err" style="margin-top:12px;font-size:12px;color:var(--err);min-height:16px"></div>' +
      '</div>';
  }

  function paintState(el, acct) {
    if (!el) return;
    if (acct && acct.connected) {
      el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;' +
        'border-radius:10px;background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.35)">' +
        '<span style="color:var(--ok);font-weight:700;font-size:14px">✓</span>' +
        '<span style="color:var(--ok);font-size:13px;font-weight:600">connected as ' +
        (acct.user || 'unknown') +
        (acct.auth === 'oauth' ? '' : ' · token') + '</span></div>';
    } else {
      el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;' +
        'border-radius:10px;background:rgba(var(--warn-rgb),0.10);border:1px solid rgba(var(--warn-rgb),0.3)">' +
        '<span style="color:var(--warn);font-size:14px">●</span>' +
        '<span style="color:var(--warn);font-size:13px;font-weight:600">not connected</span></div>';
    }
  }

  function wireConnectBody(el, onDone) {
    var errEl = el.querySelector('#hfc-err');
    var stateEl = el.querySelector('#hfc-state');

    account().then(function (a) { paintState(stateEl, a); }).catch(function () {});

    var oauth = el.querySelector('#hfc-oauth');
    if (oauth) oauth.addEventListener('click', function () {
      oauth.disabled = true; oauth.textContent = 'Redirecting…';
      window.location.href = '/api/hf/oauth/start?redirect=/';
    });

    var link = el.querySelector('#hfc-gettoken');
    if (link) link.addEventListener('click', function (e) {
      e.preventDefault();
      window.open('https://huggingface.co/settings/tokens', '_blank');
    });

    var manual = el.querySelector('#hfc-manual');
    if (manual) manual.addEventListener('click', function () {
      var tok = (el.querySelector('#hfc-token').value || '').trim();
      if (!tok) { errEl.textContent = 'paste a token first (hf_…)'; return; }
      errEl.textContent = '';
      manual.disabled = true; manual.textContent = 'connecting…';
      fetch('/api/hub/auth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tok })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
        return r.json();
      }).then(function (d) {
        manual.disabled = false; manual.textContent = 'connect with token';
        paintState(stateEl, { connected: true, user: d.username || '?', auth: 'token' });
        if (onDone) onDone(d.username || '');
      }).catch(function (e) {
        manual.disabled = false; manual.textContent = 'connect with token';
        errEl.textContent = e.message || 'Hugging Face rejected the token';
      });
    });
  }

  // ── host 1: the ConnectOverlay page ────────────────────────────────────
  function openConnectPanel(opts) {
    opts = opts || {};
    window.ConnectOverlay.open(connectBodyHTML(), {
      onSwap: function () {
        // the body div just landed in the overlay — wire inside it
        var root = document.getElementById('hfc-oauth');
        wireConnectBody(root ? root.parentElement : document, opts.onDone);
      }
    });
  }

  // ── host 2: the master-panel view (hub-publish "no token" flow) ────────
  function connectPanelView(opts) {
    opts = opts || {};
    return {
      title: 'connect hugging face',
      render: function () { return connectBodyHTML(); },
      onMount: function (el) { wireConnectBody(el, opts.onDone); }
    };
  }

  // ── OAuth return landing: /?hf_connected=1&hf_user=… ───────────────────
  // (v0.48: no canvas pill anymore — just a toast + a clean URL.)
  function initReturnListener() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('hf_connected') === '1') {
      var user = params.get('hf_user') || '';
      window.history.replaceState({}, '', '/');
      if (window.toast) {
        window.toast(user ? ('✓ connected to Hugging Face as ' + user)
                          : '✓ connected to Hugging Face');
      }
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReturnListener);
  } else {
    initReturnListener();
  }

  // ── the logs view (live SSE stream) — v0.46, kept ──────────────────────
  function openLogs(repoOverride) {
    var repo = repoOverride || (curSpace && curSpace.repo);
    if (!repo) return;
    var html = '' +
      '<div style="padding:20px 16px;height:100%;display:flex;flex-direction:column">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
          '<div>' +
            '<h3 style="margin:0;font-size:16px;color:var(--text-1)">HF Space Logs</h3>' +
            '<p style="margin:2px 0 0;font-size:12px;color:var(--text-3);font-family:monospace">' + repo + '</p>' +
          '</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button id="hf-wake-btn" style="padding:6px 12px;border-radius:8px;' +
              'background:var(--accent);color:var(--bg-app);border:none;font-size:12px;font-weight:600;cursor:pointer">Wake</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:10px">' +
          '<button class="hf-log-tab" data-type="run" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-2);font-size:11px;cursor:pointer">run logs</button>' +
          '<button class="hf-log-tab" data-type="build" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-3);font-size:11px;cursor:pointer">build logs</button>' +
        '</div>' +
        '<pre id="hf-log-stream" style="flex:1;overflow-y:auto;background:var(--bg-panel);color:var(--ok);' +
          'padding:12px;border-radius:8px;font-size:11px;font-family:monospace;line-height:1.5;' +
          'white-space:pre-wrap;word-break:break-word;margin:0"></pre>' +
      '</div>';
    window.ConnectOverlay.open(html, {
      onSwap: function () {
        var wake = document.getElementById('hf-wake-btn');
        if (wake) wake.addEventListener('click', function () {
          wake.textContent = 'Waking…'; wake.disabled = true;
          fetch('/api/hf/space/restart?repo=' + encodeURIComponent(repo), { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function () { wake.textContent = 'Wake'; wake.disabled = false; })
            .catch(function () { wake.textContent = 'Wake'; wake.disabled = false; });
        });
        var tabs = document.querySelectorAll('.hf-log-tab');
        tabs.forEach(function (t) {
          t.addEventListener('click', function () {
            tabs.forEach(function (x) {
              x.style.background = 'transparent'; x.style.color = 'var(--text-3)';
            });
            t.style.background = 'var(--surface-2)'; t.style.color = 'var(--text-2)';
            streamLogs(repo, t.dataset.type);
          });
        });
        streamLogs(repo, 'run');
      }
    });
  }

  function streamLogs(repo, type) {
    var pre = document.getElementById('hf-log-stream');
    if (!pre) return;
    pre.textContent = '';
    var url = '/api/hf/space/logs?repo=' + encodeURIComponent(repo) + '&type=' + type + '&tail=100';
    var es = new EventSource(url);
    es.onmessage = function (e) {
      pre.textContent += e.data + '\n';
      pre.scrollTop = pre.scrollHeight;
    };
    es.onerror = function () {
      pre.textContent += '\n[stream ended]\n';
      es.close();
    };
    window._hfLogStream = es;
  }

  // expose
  window.HFConnect = {
    openConnectPanel: openConnectPanel,
    connectPanelView: connectPanelView,
    account: account,
    openLogs: openLogs,
    openLogsFor: function (repo) {
      curSpace = { repo: repo };
      openLogs(repo);
    },
    current: function () { return curSpace; }
  };
})();
