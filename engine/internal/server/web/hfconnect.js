// hfconnect.js — v0.45 ITEM 7: the Hugging Face Space connect flow.
//
// USER SPEC: "import the HF chat doomalaysocreate space into this app and
// enable the user to connect to hf space -> redirect to login -> redirect to
// screen where user presses pill to allow access to clone, create spaces,
// then we clone a space for the user in the background -> redirect back to
// app. User only has to login and press any buttons to allow access for
// what we need to do on the background to automatically set everything up."
//
// FLOW (the two user-facing steps):
//   1. Connect: opens ConnectOverlay with "Connect Hugging Face" →
//      GET /api/hf/oauth/start → browser redirects to HF login → user grants
//      → HF redirects to /api/hf/oauth/callback → engine stores token →
//      redirects back to /?hf_connected=1&hf_user=…
//   2. Space status: once connected, a status pill (top-right of the canvas)
//      shows the Space's live stage (building/running/sleeping/error) +
//      a "wake" button when sleeping. Tapping the pill opens the logs view
//      (live SSE stream from /api/hf/space/logs).
//
// The engine handles create-from-scratch in the background (POST /api/hf/space/
// create) — if the user has no doomalay space yet, the engine creates one on
// first connect (PRO tier required for new Docker spaces; the user's existing
// doomalaysocreate is reused when present).
//
// Exposes: window.HFConnect = { openConnect, statusPill, openLogs }
(function () {
  'use strict';

  var POLL_MS = 20000;   // 20s — well under HF's 1000 req / 5 min free limit
  var pollTimer = 0;
  var curSpace = null;   // {repo, stage, running, sleeping, ...}
  var pillEl = null;
  var onSpaceUpdate = null;

  // ── STEP 1: the connect overlay ────────────────────────────────────────
  function openConnect(opts) {
    opts = opts || {};
    onSpaceUpdate = opts.onSpaceUpdate || null;
    var html = '' +
      '<div style="padding:28px 24px;text-align:center">' +
        '<div style="font-size:48px;margin-bottom:16px">🤗</div>' +
        '<h2 style="font-size:22px;font-weight:700;color:var(--text-1);margin:0 0 8px">Connect Hugging Face</h2>' +
        '<p style="font-size:14px;color:var(--text-3);line-height:1.5;margin:0 0 24px">' +
          'Connect your HF account to spin up a real Docker sandbox — bash, python, ' +
          'and the full build toolchain on Hugging Face Spaces (free cpu-basic tier).' +
        '</p>' +
        '<button id="hf-connect-btn" style="width:100%;padding:14px;border-radius:12px;' +
          'background:var(--accent);color:#fff;border:none;font-size:15px;font-weight:600;' +
          'font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(var(--accent-rgb),0.3)">' +
          'Connect via Hugging Face' +
        '</button>' +
        '<p style="font-size:12px;color:var(--text-3);margin:16px 0 0;line-height:1.4">' +
          'You\'ll be redirected to huggingface.co to log in and grant access ' +
          '(scopes: read your profile + create/manage Spaces). We never see your password — ' +
          'the token stays in the engine\'s encrypted vault.' +
        '</p>' +
        '<div id="hf-connect-status" style="margin-top:16px;font-size:13px;color:var(--text-3)"></div>' +
      '</div>';
    window.ConnectOverlay.open(html, {
      onSwap: function () {
        var btn = document.getElementById('hf-connect-btn');
        if (btn) btn.addEventListener('click', startOAuth);
        // auto-detect existing connection (callback redirect)
        checkExistingConnection();
      },
      onClose: function () { /* keep state */ }
    });
  }

  function checkExistingConnection() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('hf_connected') === '1') {
      var user = params.get('hf_user') || '';
      var status = document.getElementById('hf-connect-status');
      if (status) {
        status.innerHTML = '<span style="color:var(--ok)">✓ Connected as ' + user + '</span><br>' +
          'Spinning up your Space…';
      }
      // clean the URL
      window.history.replaceState({}, '', '/');
      // probe the space status
      ensureSpace(user);
    }
  }

  function startOAuth() {
    var btn = document.getElementById('hf-connect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
    // redirect to the engine's OAuth start (engine → HF authorize → callback → back here)
    window.location.href = '/api/hf/oauth/start?redirect=/';
  }

  // ── STEP 2: ensure a Space exists (create-from-scratch or reuse) ──────
  function ensureSpace(user) {
    var status = document.getElementById('hf-connect-status');
    // try to find an existing doomalay space first
    fetch('/api/hf/space/status?repo=' + encodeURIComponent(user + '/doomalaysocreate'))
      .then(function (r) {
        if (r.ok) return r.json();
        // space doesn't exist — try creating one
        if (r.status === 404 || r.status === 502) {
          return createSpace();
        }
        throw new Error('status ' + r.status);
      })
      .then(function (data) {
        if (data && data.repo) {
          curSpace = data;
          if (status) {
            status.innerHTML = '<span style="color:var(--ok)">✓ Space ready: ' + data.repo + '</span><br>' +
              'Stage: ' + (data.stage || 'unknown');
          }
          if (onSpaceUpdate) onSpaceUpdate(data);
          startPolling(data.repo);
          if (window.ConnectOverlay && window.ConnectOverlay.isOpen) {
            setTimeout(function () { window.ConnectOverlay.close(); }, 1500);
          }
        }
      })
      .catch(function (err) {
        if (status) {
          status.innerHTML = '<span style="color:var(--err)">✗ ' + err.message + '</span><br>' +
            '<span style="font-size:12px;color:var(--text-3)">' +
            'New Docker Spaces require HF PRO. Your existing doomalaysocreate space ' +
            'will be reused if present.</span>';
        }
      });
  }

  function createSpace() {
    return fetch('/api/hf/space/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'doomalay-' + Math.random().toString(36).slice(2, 8), shared: false })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  // ── the status pill (top-right of the canvas) ─────────────────────────
  function ensurePill() {
    if (pillEl) return pillEl;
    pillEl = document.createElement('button');
    pillEl.id = 'hf-space-pill';
    pillEl.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:40;display:flex;align-items:center;gap:6px;' +
      'padding:6px 12px;border-radius:14px;border:1px solid var(--border);' +
      'background:var(--surface-1);color:var(--text-2);font-size:12px;font-weight:600;' +
      'font-family:inherit;cursor:pointer;backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);transition:all 0.15s;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)';
    pillEl.addEventListener('click', openLogs);
    // insert into the canvas container (next to the settings gear)
    var host = document.querySelector('.spatial-canvas') || document.body;
    host.appendChild(pillEl);
    return pillEl;
  }

  function statusPill() {
    return pillEl;
  }

  function paintPill(s) {
    var p = ensurePill();
    if (!s) { p.style.display = 'none'; return; }
    p.style.display = 'flex';
    var stage = s.stage || 'unknown';
    var dot = '●';
    var color = 'var(--text-3)';
    var label = stage;
    if (s.running) { color = 'var(--ok)'; label = 'running'; }
    else if (s.sleeping) { color = 'var(--warn)'; label = 'sleeping'; }
    else if (s.building) { color = 'var(--accent-2)'; label = 'building'; }
    else if (s.error) { color = 'var(--err)'; label = 'error'; }
    p.innerHTML = '<span style="color:' + color + ';font-size:10px">' + dot + '</span>' +
      '<span>HF: ' + label + '</span>';
    p.title = 'Space: ' + s.repo + '\nStage: ' + stage + '\nHardware: ' + (s.hardware || '?') +
      '\n\nClick to view logs. Sleeping spaces wake on first request.';
  }

  // ── polling the Space status ──────────────────────────────────────────
  function startPolling(repo) {
    if (pollTimer) clearInterval(pollTimer);
    var tick = function () {
      fetch('/api/hf/space/status?repo=' + encodeURIComponent(repo))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (s) { curSpace = s; paintPill(s); if (onSpaceUpdate) onSpaceUpdate(s); }
        })
        .catch(function () { /* network blip — keep the last status */ });
    };
    tick();
    pollTimer = setInterval(tick, POLL_MS);
  }

  // ── the logs view (live SSE stream) ────────────────────────────────────
  function openLogs() {
    if (!curSpace) return;
    var repo = curSpace.repo;
    var html = '' +
      '<div style="padding:20px 16px;height:100%;display:flex;flex-direction:column">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
          '<div>' +
            '<h3 style="margin:0;font-size:16px;color:var(--text-1)">HF Space Logs</h3>' +
            '<p style="margin:2px 0 0;font-size:12px;color:var(--text-3);font-family:monospace">' + repo + '</p>' +
          '</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button id="hf-wake-btn" style="padding:6px 12px;border-radius:8px;' +
              'background:var(--accent);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer">Wake</button>' +
            '<button id="hf-logs-close" style="padding:6px 12px;border-radius:8px;' +
              'background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);font-size:12px;cursor:pointer">✕</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:10px">' +
          '<button class="hf-log-tab" data-type="run" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-2);font-size:11px;cursor:pointer">run logs</button>' +
          '<button class="hf-log-tab" data-type="build" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-3);font-size:11px;cursor:pointer">build logs</button>' +
        '</div>' +
        '<pre id="hf-log-stream" style="flex:1;overflow-y:auto;background:#0a0a0b;color:#a3e635;' +
          'padding:12px;border-radius:8px;font-size:11px;font-family:monospace;line-height:1.5;' +
          'white-space:pre-wrap;word-break:break-word;margin:0"></pre>' +
      '</div>';
    window.ConnectOverlay.open(html, {
      onSwap: function () {
        var close = document.getElementById('hf-logs-close');
        if (close) close.addEventListener('click', function () { window.ConnectOverlay.close(); });
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
    // store so we can close on overlay close
    window._hfLogStream = es;
  }

  // expose
  window.HFConnect = {
    openConnect: openConnect,
    statusPill: statusPill,
    openLogs: openLogs,
    current: function () { return curSpace; }
  };
})();
