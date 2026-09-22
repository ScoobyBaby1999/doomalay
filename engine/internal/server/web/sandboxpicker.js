// sandboxpicker.js — the "+ Sandbox" picker (v0.46: the HF CHAT flow).
//
// Opens as a blur-background overlay with 4 options:
//   1. Quick Chat      — no commands, no sandbox. Just talk. Has tool use,
//      default effort modes, web search, and custom templates.
//   2. HF Space        — v0.46: opens the HF sandbox chooser:
//        a. SHARED space (instant — the community doomalaysocreate sandbox,
//           auth rides your own HF connection)
//        b. YOUR OWN SPACE (the engine creates a private free-tier sandbox
//           via the ZeroGPU loophole — live build progress, ~3-6 min first
//           build)
//        c. PICK EXISTING (your doomalay-* spaces with live stages)
//   3. Another Device  — deferred (mesh setup, future)
//   4. Terminal/VM     — dynamic, device-dependent (Termux on Android).
//
// Each option calls onPick(sandboxType, detail) when selected. For 'hf',
// detail = {mode: 'shared'} | {mode: 'own', repo: 'user/name'}.
//
// Exposes: window.SandboxPicker
(function () {
  'use strict';

  function detectDevice() {
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var isAndroid = /android/i.test(ua) || /Android/.test(platform);
    var isIOS = /iPad|iPhone|iPod/.test(ua) || /iPad|iPhone/.test(platform);
    var isMac = /Mac/.test(platform) || /Macintosh/.test(ua);
    var isLinux = /Linux/.test(platform) || /X11/.test(ua);
    var isWindows = /Win/.test(platform) || /Windows/.test(ua);
    if (isAndroid) return 'android-apk';
    if (isIOS) return 'ios';
    if (isMac) return 'macos';
    if (isWindows) return 'windows';
    if (isLinux) return 'linux';
    return 'unknown';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getJSON(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function postJSON(url, body) {
    return getJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  // ── main picker ───────────────────────────────────────────────────────
  function open(onPick) {
    var device = detectDevice();

    var terminalOption;
    if (device === 'android-apk') {
      terminalOption = optionCard('terminal', '⌨️', 'Termux (Local)',
        'Local terminal with bash, file access, and local compilation. Full Python brain on your phone — runs entirely offline.',
        null);
    } else if (device === 'macos' || device === 'linux' || device === 'windows') {
      terminalOption = optionCard('terminal', '⌨️', 'Local Terminal',
        'Use your device\'s native terminal + Python. Full brain, full tools, local compile. Runs entirely on your device.',
        null);
    } else {
      terminalOption = optionCard('terminal', '⌨️', 'Terminal / VM',
        'Device-specific terminal support. Detected: ' + device + '. Coming soon.',
        'coming soon', true);
    }

    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<h2 style="font-size: calc(var(--ui-fs) + 4px);font-weight:600;color:var(--text-1);margin:0">Choose a model and sandbox and go!</h2>' +
      '<button id="sb-close" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
      '</div>' +
      '<p style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-3);margin:0 0 20px">Pick a runtime for this chat. Each sandbox has different capabilities.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('quick', '⚡', 'Quick Chat',
          'No commands, no sandbox. Just talk. Has tool use, default effort modes, web search, and custom templates.',
          null) +
        optionCard('hf', '🤗', 'Hugging Face Space',
          'A real Linux sandbox — bash, python, git, node, build tools. Shared (instant) or your own private space. Free HF account is enough.',
          null) +
        optionCard('device', '🔗', 'Another Device',
          'Connect to a remote engine (mesh setup). Deferred — coming in a future milestone.',
          'coming soon', true) +
        terminalOption +
      '</div>' +
      '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3-dim);margin:20px 0 0;text-align:center">Detected device: ' + device + '</p>' +
      '</div>';

    window.ConnectOverlay.open(html);

    var contentEl = window.ConnectOverlay.getContentEl();
    var closeBtn = contentEl.querySelector('#sb-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.ConnectOverlay.close(); });

    contentEl.querySelectorAll('[data-sandbox]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.sandbox;
        if (card.dataset.disabled === 'true') return; // skip "coming soon"
        if (type === 'hf') {
          openHFChooser(onPick); // v0.46: the HF sub-flow
          return;
        }
        window.ConnectOverlay.close();
        if (onPick) onPick(type);
      });
    });
  }

  // ── the HF chooser (v0.46 — THE PAYWALL-HACK FLOW) ────────────────────
  function openHFChooser(onPick) {
    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<h2 style="font-size: calc(var(--ui-fs) + 4px);font-weight:600;color:var(--text-1);margin:0">🤗 HF sandbox</h2>' +
      '<button id="sb-back" style="background:transparent;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:4px 8px">← back</button>' +
      '</div>' +
      '<p style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-3);margin:0 0 6px">' +
        'A full Linux sandbox on Hugging Face — real bash, python, git, node and build tools, driven by this chat.</p>' +
      '<p id="hf-acct" style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 16px">checking your HF connection…</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('hf-shared', '🌍', 'Shared sandbox',
          'The community space — ready instantly, no setup. Needs an HF connection (your account is the access key). Per-chat workspaces, capacity shared.',
          null) +
        optionCard('hf-own', '🏠', 'Your own space',
          'The engine creates a PRIVATE sandbox under your HF account (free tier — our ZeroGPU trick; free accounts host up to 2, then chats reuse them). First build takes ~3-6 min.',
          null) +
        optionCard('hf-pick', '📋', 'Pick an existing space',
          'Reuse one of your doomalay spaces.', null) +
      '</div>' +
      '<div id="hf-detail" style="margin-top:16px"></div>' +
      '</div>';

    window.ConnectOverlay.open(html);
    var contentEl = window.ConnectOverlay.getContentEl();
    var back = contentEl.querySelector('#sb-back');
    if (back) back.addEventListener('click', function () { open(onPick); });

    // account status
    getJSON('/api/hf/account').then(function (acct) {
      var el = contentEl.querySelector('#hf-acct');
      if (!el) return;
      if (acct.connected) {
        el.innerHTML = '<span style="color:var(--ok)">✓ connected as ' + esc(acct.user) + '</span>';
      } else {
        el.innerHTML = '<span style="color:var(--warn)">not connected</span> — shared + own spaces need an HF token: ' +
          '<b>Hub → Publish → connect Hugging Face</b>, then come back. ' +
          '(Any free account works.)';
      }
    }).catch(function () {
      var el = contentEl.querySelector('#hf-acct');
      if (el) el.textContent = 'HF connection unknown — is the engine running?';
    });

    var detail = contentEl.querySelector('#hf-detail');

    contentEl.querySelectorAll('[data-sandbox]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.sandbox;
        if (detail) {
          if (type === 'hf-shared') renderShared(detail, onPick);
          else if (type === 'hf-own') renderOwn(detail, onPick);
          else if (type === 'hf-pick') renderPick(detail, onPick);
        }
      });
    });
  }

  function stageBadge(s) {
    if (!s) return '';
    var color = 'var(--text-3)', label = s.stage || 'unknown';
    if (s.running) { color = 'var(--ok)'; label = 'running'; }
    else if (s.sleeping) { color = 'var(--warn)'; label = 'sleeping'; }
    else if (s.building) { color = 'var(--accent-2)'; label = 'building'; }
    else if (s.error) { color = 'var(--err)'; label = 'error'; }
    return '<span style="font-size:11px;color:' + color + '">● ' + esc(label) + '</span>';
  }

  function renderShared(detail, onPick) {
    detail.innerHTML = '<p style="font-size:calc(var(--ui-small-fs));color:var(--text-3);margin:0 0 8px">checking the shared sandbox…</p>';
    getJSON('/api/hf/shared').then(function (sh) {
      detail.innerHTML =
        '<div style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:12px;padding:14px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<span style="font-size:calc(var(--ui-small-fs));font-weight:600;color:var(--text-1)">' + esc(sh.repo) + '</span>' +
        stageBadge(sh) + '</div>' +
        '<p style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 10px">' +
        'Community sandbox on the full build toolchain. Your HF account is the key. Workspaces are per-chat and ephemeral.</p>' +
        '<button id="hf-use-shared" style="width:100%;padding:10px;border-radius:10px;background:var(--accent);color:#fff;border:none;font-size:calc(var(--ui-small-fs));font-weight:600;cursor:pointer">Use the shared sandbox</button>' +
        '</div>';
      var btn = detail.querySelector('#hf-use-shared');
      if (btn) btn.addEventListener('click', function () {
        window.ConnectOverlay.close();
        if (onPick) onPick('hf', { mode: 'shared', repo: sh.repo });
      });
    }).catch(function (e) {
      detail.innerHTML = '<p style="color:var(--err);font-size:calc(var(--ui-small-fs));margin:0">' + esc(e.message) + '</p>';
    });
  }

  function renderOwn(detail, onPick) {
    detail.innerHTML =
      '<div style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:12px;padding:14px">' +
      '<p style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 10px">' +
      'Creates a <b>private</b> Space under your HF account and uploads the Doomalay brain. ' +
      'Free tier — no PRO needed (the engine uses the ZeroGPU creation path). Name it or leave blank for auto.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<input id="hf-own-name" placeholder="doomalay-<auto>" style="flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-1);font-size:calc(var(--ui-small-fs));font-family:inherit" />' +
      '<button id="hf-own-create" style="padding:9px 16px;border-radius:10px;background:var(--accent);color:#fff;border:none;font-size:calc(var(--ui-small-fs));font-weight:600;cursor:pointer">Create</button>' +
      '</div>' +
      '<div id="hf-own-progress" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3)"></div>' +
      '</div>';
    var btn = detail.querySelector('#hf-own-create');
    if (btn) btn.addEventListener('click', function () {
      var name = (detail.querySelector('#hf-own-name') || {}).value || '';
      var prog = detail.querySelector('#hf-own-progress');
      btn.disabled = true; btn.textContent = 'Creating…';
      if (prog) prog.textContent = 'creating the Space + uploading the brain (~2.3 MB)…';
      postJSON('/api/hf/space/create', { name: name }).then(function (res) {
        // created — watch the build, then use it
        watchBuild(prog, res.repo, function () {
          window.ConnectOverlay.close();
          if (onPick) onPick('hf', { mode: 'own', repo: res.repo });
        });
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Create';
        if (prog) {
          var m = String(e.message || '');
          prog.innerHTML = '<span style="color:var(--err)">' + esc(m) + '</span>';
          if (m.indexOf('ZeroGPU') >= 0 || m.indexOf('2 ZeroGPU') >= 0) {
            prog.innerHTML += '<br><span style="color:var(--text-3)">You have 2 own sandboxes already — use “Pick an existing space” or the SHARED sandbox.</span>';
          } else if (m.indexOf('PRO') >= 0) {
            prog.innerHTML += '<br><span style="color:var(--text-3)">The free creation path is blocked for your account — use the SHARED sandbox instead.</span>';
          }
        }
      });
    });
  }

  function watchBuild(prog, repo, done) {
    if (!prog) { done(); return; }
    var ticks = 0;
    prog.innerHTML = 'building <b>' + esc(repo) + '</b> — first build installs the brain (~3-6 min)… <span id="hf-build-stage">queued</span>';
    var stageEl = function () { return prog.querySelector('#hf-build-stage'); };
    var timer = setInterval(function () {
      ticks++;
      getJSON('/api/hf/space/status?repo=' + encodeURIComponent(repo)).then(function (s) {
        var el = stageEl();
        if (el) el.textContent = s.stage || '…';
        if (s.running) {
          clearInterval(timer);
          prog.innerHTML = '<span style="color:var(--ok)">✓ ' + esc(repo) + ' is running — starting the chat there…</span>';
          setTimeout(done, 600);
        } else if (s.error) {
          clearInterval(timer);
          prog.innerHTML = '<span style="color:var(--err)">build failed (' + esc(s.stage) + ')</span> — <a href="#" id="hf-view-logs" style="color:var(--accent)">view logs</a>';
          var lg = prog.querySelector('#hf-view-logs');
          if (lg) lg.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (window.HFConnect && window.HFConnect.openLogsFor) window.HFConnect.openLogsFor(repo);
          });
        } else if (ticks > 60) { // ~6 min of polls
          clearInterval(timer);
          prog.innerHTML = 'still building — you can close this and pick the space later from "Pick an existing space".';
        }
      }).catch(function () { /* transient */ });
    }, 6000);
  }

  function renderPick(detail, onPick) {
    detail.innerHTML = '<p style="font-size:calc(var(--ui-small-fs));color:var(--text-3);margin:0 0 8px">loading your spaces…</p>';
    getJSON('/api/hf/spaces').then(function (data) {
      var rows = (data.spaces || []).map(function (sp) {
        return '<div class="hf-pick-row" data-repo="' + esc(sp.repo) + '" style="display:flex;justify-content:space-between;align-items:center;' +
          'background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer">' +
          '<span style="font-family:monospace;font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + esc(sp.repo) + '</span>' +
          stageBadge(sp) + '</div>';
      }).join('');
      detail.innerHTML = rows
        ? rows + '<p style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3-dim);margin:4px 0 0">tap to use a space in this chat</p>'
        : '<p style="font-size:calc(var(--ui-small-fs));color:var(--text-3);margin:0">No doomalay spaces yet — create one with "Your own space".</p>';
      detail.querySelectorAll('.hf-pick-row').forEach(function (row) {
        row.addEventListener('click', function () {
          window.ConnectOverlay.close();
          if (onPick) onPick('hf', { mode: 'own', repo: row.dataset.repo });
        });
      });
    }).catch(function (e) {
      detail.innerHTML = '<p style="color:var(--err);font-size:calc(var(--ui-small-fs));margin:0">' + esc(e.message) + '</p>';
    });
  }

  function optionCard(type, icon, title, desc, badge, disabled) {
    var opacity = disabled ? 'opacity:0.5;pointer-events:none' : 'cursor:pointer';
    var badgeHTML = badge ? '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);background:var(--text-3-dim);padding:3px 8px;border-radius:6px">' + badge + '</span>' : '';
    return '<div data-sandbox="' + type + '" data-disabled="' + (disabled ? 'true' : 'false') + '"' +
      ' style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:12px;padding:16px;' +
      opacity + ';transition:border-color 0.15s"' +
      ' onmouseover="if(this.dataset.disabled!==\'true\')this.style.borderColor=\'var(--text-3-dim)\'"' +
      ' onmouseout="this.style.borderColor=\'var(--surface-2)\'"' +
      '>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
      '<span style="font-size:24px">' + icon + '</span>' +
      '<span style="font-size: calc(var(--ui-fs) + 1px);font-weight:600;color:var(--text-1);flex:1">' + title + '</span>' +
      badgeHTML +
      '</div>' +
      '<p style="font-size: var(--ui-small-fs);color:var(--text-3);margin:0;line-height:1.5">' + desc + '</p>' +
      '</div>';
  }

  window.SandboxPicker = { open: open, detectDevice: detectDevice };
})();
