// sandboxpicker.js — the "+ Sandbox" picker (v0.48: the connect-wave rework).
//
// Opens on the reusable ConnectOverlay (static ✕ + back stack, theme vars
// only). 4 top-level cards:
//   1. Quick Chat      — no commands, no sandbox. Just talk.
//   2. HF Space        — opens the HF sandbox chooser (below)
//   3. Another Device  — deferred (mesh setup, future)
//   4. Terminal/VM     — dynamic, device-dependent (Termux on Android).
//
// THE HF CHOOSER (v0.48 task 9 — three options):
//   1. 🐳 HF Docker sandbox — the engine provisions the user's OWN
//      full-toolchain Docker Space brick by brick (fork doomalay → their
//      GitHub, create a static Space for free, ONE commit flips it to
//      docker with the whole brain). Needs GitHub + HF — pressing it walks
//      the connect panels one at a time (HF first, then GitHub).
//      2 vCPU · 16 GB RAM · 1 GB internal storage · sleeps after 48h ·
//      ~5 min wake. (HF gates cpu-basic runtime behind PRO on free accounts
//      since Jul-2026 — the picker reports the paused_quota state honestly
//      and offers the pause-swap remedy + the ZeroGPU fallback.)
//   2. ⚡ HF ZeroGPU Sandbox — the guaranteed FREE path (2 per free account,
//      verified email + 30-day-old account). Dynamic resources (NVIDIA RTX
//      Pro 6000 Blackwell) · 1 GB internal storage · sleeps depending on
//      usage · ~5 min wake. Needs an HF token.
//   3. 📋 Pick an existing space — the user's doomalay spaces, SCROLLABLE.
//
//   (The old "Shared sandbox" card is GONE from the UI — the engine keeps
//   its endpoint so existing shared chats keep working.)
//
// Each option calls onPick(sandboxType, detail); for 'hf',
// detail = {mode:'own', repo:'user/name'}.
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

  // small theme-safe status chips (green/yellow)
  function okChip(text) {
    return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;' +
      'border-radius:8px;background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.35);' +
      'color:var(--ok);font-size:calc(var(--ui-small-fs) - 1px);font-weight:600">✓ ' + esc(text) + '</span>';
  }
  function warnChip(text, extra) {
    return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;' +
      'border-radius:8px;background:rgba(var(--warn-rgb),0.10);border:1px solid rgba(var(--warn-rgb),0.3);' +
      'color:var(--warn);font-size:calc(var(--ui-small-fs) - 1px);font-weight:600">● ' + esc(text) + '</span>' +
      (extra || '');
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
      '</div>' +
      '<p style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-3);margin:0 0 20px">Pick a runtime for this chat. Each sandbox has different capabilities.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('quick', '⚡', 'Quick Chat',
          'No commands, no sandbox. Just talk. Has tool use, default effort modes, web search, and custom templates.',
          null) +
        optionCard('hf', '🤗', 'Hugging Face Space',
          'A real Linux sandbox — bash, python, git, Node, gcc/g++/make/cmake, Go, Rust, Java, package installs, full HF API access to manage the space. Your own Space on your own HF account.',
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

    contentEl.querySelectorAll('[data-sandbox]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.sandbox;
        if (card.dataset.disabled === 'true') return; // skip "coming soon"
        if (type === 'hf') {
          openHFChooser(onPick);
          return;
        }
        window.ConnectOverlay.close();
        if (onPick) onPick(type);
      });
    });
  }

  // ── the HF chooser (v0.48: docker / zerogpu / pick) ───────────────────
  function openHFChooser(onPick) {
    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<h2 style="font-size: calc(var(--ui-fs) + 4px);font-weight:600;color:var(--text-1);margin:0">🤗 HF sandbox</h2>' +
      '<button id="sb-back" style="background:transparent;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:4px 8px">← back</button>' +
      '</div>' +
      '<p style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-3);margin:0 0 6px">' +
        'A real Linux sandbox on Hugging Face — real bash, python, git, Node and build tools, package installs, and the full HF API to manage the space. Driven by this chat.</p>' +
      '<p id="hf-acct" style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 16px">checking your HF connection…</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('hf-docker', '🐳', 'HF Docker sandbox',
          'Your own full-toolchain Docker Space, provisioned automatically: 2 vCPU · 16 GB RAM · 1 GB internal storage · sleeps after 48h of inactivity · ~5 mins to wake. ' +
          'Capabilities: bash, python, git, Node, gcc/g++/make/cmake, Go, Rust, Java, qemu; pip/npm/apt installs; modify the Dockerfile/Gradio/app and manage the Space via the HF API. ' +
          'Also forks the doomalay source into your GitHub. Needs GitHub + Hugging Face (one at a time).',
          null, false, '<div id="docker-req" style="margin-top:10px"></div>') +
        optionCard('hf-zero', '⚡', 'HF ZeroGPU Sandbox',
          'Your own Space on ZeroGPU — runs FREE on every account: Dynamic Resources (NVIDIA RTX Pro 6000 Blackwell GPU) · 1 GB internal storage · sleeps depending on usage · limit of 2 for the free tier (verified email + account 30+ days old) · ~5 mins to wake. ' +
          'Same Linux sandbox + brain as the Docker flavor.',
          null, false, '<div id="zero-req" style="margin-top:10px"></div>') +
        optionCard('hf-pick', '📋', 'Pick an existing space',
          'Reuse one of your doomalay spaces.', null) +
      '</div>' +
      '<div id="hf-detail" style="margin-top:16px"></div>' +
      '</div>';

    window.ConnectOverlay.open(html);
    var contentEl = window.ConnectOverlay.getContentEl();
    var back = contentEl.querySelector('#sb-back');
    if (back) back.addEventListener('click', function () { open(onPick); });

    var detail = contentEl.querySelector('#hf-detail');

    // account states (HF + GitHub in parallel) → dynamic texts
    var hfP = getJSON('/api/hf/account').catch(function () { return { connected: false, user: '' }; });
    var ghP = getJSON('/api/gh/account').catch(function () { return { connected: false, user: '' }; });

    hfP.then(function (acct) {
      var el = contentEl.querySelector('#hf-acct');
      if (!el) return;
      if (acct.connected) {
        el.innerHTML = okChip('connected as ' + (acct.user || 'unknown'));
      } else {
        // task 2: yellow "not connected" + a Connect button next to it —
        // opens the SAME panel the hub-publish flow shows with no token.
        el.innerHTML = warnChip('not connected',
          ' <button id="hf-connect-inline" style="padding:4px 12px;border-radius:8px;' +
            'background:var(--accent);color:var(--bg-app);border:none;font-size:calc(var(--ui-small-fs) - 1px);' +
            'font-weight:600;font-family:inherit;cursor:pointer;margin-left:8px">Connect to HF</button>');
        var btn = el.querySelector('#hf-connect-inline');
        if (btn) btn.addEventListener('click', function () {
          if (window.HFConnect) window.HFConnect.openConnectPanel({
            onDone: function () { openHFChooser(onPick); }
          });
        });
      }
      return ghP.then(function (gh) {
        var dr = contentEl.querySelector('#docker-req');
        if (dr) {
          dr.innerHTML = (acct.connected && gh.connected)
            ? okChip('GitHub and Hugging Face connected')
            : warnChip('GitHub or HuggingFace required');
        }
        var zr = contentEl.querySelector('#zero-req');
        if (zr) {
          zr.innerHTML = acct.connected ? okChip('HuggingFace connected')
                                        : warnChip('HF login required');
        }
      });
    }).catch(function () {
      var el = contentEl.querySelector('#hf-acct');
      if (el) el.textContent = 'HF connection unknown — is the engine running?';
    });

    contentEl.querySelectorAll('[data-sandbox]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.sandbox;
        if (type === 'hf-docker') dockerFlow(onPick);
        else if (type === 'hf-zero') zeroFlow(onPick);
        else if (type === 'hf-pick') renderPick(detail, onPick);
      });
    });
  }

  // ── option 1: the Docker sandbox flow (connect checks, one at a time) ─
  function dockerFlow(onPick) {
    Promise.all([
      getJSON('/api/hf/account').catch(function () { return { connected: false }; }),
      getJSON('/api/gh/account').catch(function () { return { connected: false }; })
    ]).then(function (r) {
      var hf = r[0], gh = r[1];
      if (!hf.connected) {
        // sign in to HF FIRST, then GitHub — one at a time (user spec)
        if (window.HFConnect) window.HFConnect.openConnectPanel({
          onDone: function () { dockerFlow(onPick); }
        });
        return;
      }
      if (!gh.connected) {
        if (window.GHConnect) window.GHConnect.openConnectPanel({
          onDone: function () { dockerFlow(onPick); }
        });
        return;
      }
      renderDocker(onPick);
    });
  }

  function renderDocker(onPick) {
    var html =
      '<div style="padding:24px">' +
      '<h2 style="font-size: calc(var(--ui-fs) + 2px);font-weight:600;color:var(--text-1);margin:0 0 6px">🐳 HF Docker sandbox</h2>' +
      '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 14px;line-height:1.5">' +
        'The engine forks the doomalay source into your GitHub, creates a free Space on your HF account, and uploads the full toolchain + brain brick by brick — as if you built it yourself. ' +
        '2 vCPU · 16 GB RAM · 1 GB internal storage · sleeps after 48h of inactivity · ~5 mins to wake.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<input id="hf-docker-name" placeholder="doomalay-<auto>" style="flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-1);font-size:calc(var(--ui-small-fs));font-family:inherit" />' +
      '<button id="hf-docker-create" style="padding:9px 16px;border-radius:10px;background:var(--accent);color:var(--bg-app);border:none;font-size:calc(var(--ui-small-fs));font-weight:600;cursor:pointer">Create</button>' +
      '</div>' +
      '<div id="hf-docker-progress" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);line-height:1.6"></div>' +
      '</div>';
    window.ConnectOverlay.open(html, {
      onSwap: function () {
        var root = document.getElementById('hf-docker-create');
        var box = root ? root.parentElement.parentElement : document;
        var btn = box.querySelector('#hf-docker-create');
        var prog = box.querySelector('#hf-docker-progress');
        if (btn) btn.addEventListener('click', function () {
          var name = (box.querySelector('#hf-docker-name') || {}).value || '';
          btn.disabled = true; btn.textContent = 'Creating…';
          if (prog) prog.innerHTML = 'forking doomalay → your GitHub, creating the Space, uploading the full toolchain + brain…';
          postJSON('/api/hf/space/docker-create', { name: name, fork: true }).then(function (res) {
            if (res.state === 'running' || res.state === 'building') {
              watchBuild(prog, res.repo, function () {
                window.ConnectOverlay.close();
                if (onPick) onPick('hf', { mode: 'own', repo: res.repo });
              });
              return;
            }
            if (res.state === 'paused_quota') {
              renderQuotaPaused(prog, res, onPick);
              return;
            }
            if (prog) prog.innerHTML = '<span style="color:var(--ok)">✓ ' + esc(res.repo) + '</span> — ' + esc(res.note || '');
            watchBuild(prog, res.repo, function () {
              window.ConnectOverlay.close();
              if (onPick) onPick('hf', { mode: 'own', repo: res.repo });
            });
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'Create';
            if (prog) prog.innerHTML = '<span style="color:var(--err)">' + esc(e.message || e) + '</span>';
          });
        });
      }
    });
  }

  // the honest cpu-basic quota state: the Space is BUILT and READY, but HF
  // gates its runtime. Offer HF's own remedy — pause another of the user's
  // spaces holding the slot — plus the ZeroGPU fallback.
  function renderQuotaPaused(prog, res, onPick) {
    if (!prog) return;
    prog.innerHTML =
      '<div style="background:rgba(var(--notice-rgb),0.10);border:1px solid rgba(var(--notice-rgb),0.35);' +
        'border-radius:10px;padding:12px;margin-bottom:10px">' +
      '<div style="font-size:calc(var(--ui-small-fs));font-weight:600;color:var(--notice);margin-bottom:4px">' +
        'Space built and ready — runtime is PRO-gated</div>' +
      '<p style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0;line-height:1.5">' +
        '<b>' + esc(res.repo) + '</b> was created and fully provisioned, but Hugging Face gates cpu-basic ' +
        'runtime behind PRO on free accounts (since Jul 2026). It will wake the moment your account has a ' +
        'free cpu-basic slot — pause another Space to free it, upgrade to PRO, or use the free ZeroGPU sandbox.</p>' +
      '</div>' +
      '<div id="hf-quota-spaces" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3)">checking your other spaces…</div>';
    getJSON('/api/hf/spaces').then(function (data) {
      var host = prog.querySelector('#hf-quota-spaces');
      if (!host) return;
      var running = (data.spaces || []).filter(function (sp) {
        return sp.running && sp.repo !== res.repo;
      });
      if (!running.length) {
        host.innerHTML = 'No other running doomalay spaces to pause. ' +
          'Free path: the <b>⚡ HF ZeroGPU Sandbox</b> (2 free) — go back and pick it.';
        return;
      }
      host.innerHTML = 'Your account\'s cpu-basic slot is held by:' +
        running.map(function (sp) {
          return '<div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-1);' +
            'border:1px solid var(--surface-2);border-radius:10px;padding:8px 12px;margin-top:6px">' +
            '<span style="font-family:monospace;font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + esc(sp.repo) + '</span>' +
            '<button data-pause-repo="' + esc(sp.repo) + '" style="padding:5px 12px;border-radius:8px;' +
              'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border-strong);' +
              'font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer">pause it & wake mine</button>' +
            '</div>';
        }).join('');
      host.querySelectorAll('[data-pause-repo]').forEach(function (b) {
        b.addEventListener('click', function () {
          b.disabled = true; b.textContent = 'pausing…';
          postJSON('/api/hf/space/pause?repo=' + encodeURIComponent(b.dataset.pauseRepo), {})
            .then(function () {
              b.textContent = 'waking yours…';
              return postJSON('/api/hf/space/restart?repo=' + encodeURIComponent(res.repo), {});
            })
            .then(function () {
              if (window.toast) window.toast('switched the cpu-basic slot — waking ' + res.repo);
              watchBuild(prog, res.repo, function () {
                window.ConnectOverlay.close();
                if (onPick) onPick('hf', { mode: 'own', repo: res.repo });
              });
            })
            .catch(function (e) {
              b.disabled = false; b.textContent = 'pause it & wake mine';
              if (window.toast) window.toast(e.message || 'could not switch slots');
            });
        });
      });
    }).catch(function () {
      var host = prog.querySelector('#hf-quota-spaces');
      if (host) host.textContent = '';
    });
  }

  // ── option 2: the ZeroGPU sandbox (the free path) ─────────────────────
  function zeroFlow(onPick) {
    getJSON('/api/hf/account').catch(function () { return { connected: false }; }).then(function (acct) {
      if (!acct.connected) {
        if (window.HFConnect) window.HFConnect.openConnectPanel({
          onDone: function () { renderZero(onPick); }
        });
        return;
      }
      renderZero(onPick);
    });
  }

  function renderZero(onPick) {
    var html =
      '<div style="padding:24px">' +
      '<h2 style="font-size: calc(var(--ui-fs) + 2px);font-weight:600;color:var(--text-1);margin:0 0 6px">⚡ HF ZeroGPU Sandbox</h2>' +
      '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 14px;line-height:1.5">' +
        'The engine creates a Space under your HF account on the ZeroGPU flavor — free on every account. ' +
        'Dynamic Resources (NVIDIA RTX Pro 6000 Blackwell GPU) · 1 GB internal storage · sleeps depending on usage · ' +
        'limit of 2 for the free tier (verified email + account 30+ days old) · ~5 mins to wake. ' +
        'Same Linux sandbox + brain: bash, python, git, Node, build tools, package installs.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<input id="hf-zero-name" placeholder="doomalay-<auto>" style="flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-1);font-size:calc(var(--ui-small-fs));font-family:inherit" />' +
      '<button id="hf-zero-create" style="padding:9px 16px;border-radius:10px;background:var(--accent);color:var(--bg-app);border:none;font-size:calc(var(--ui-small-fs));font-weight:600;cursor:pointer">Create</button>' +
      '</div>' +
      '<div id="hf-zero-progress" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);line-height:1.6"></div>' +
      '</div>';
    window.ConnectOverlay.open(html, {
      onSwap: function () {
        var root = document.getElementById('hf-zero-create');
        var box = root ? root.parentElement.parentElement : document;
        var btn = box.querySelector('#hf-zero-create');
        var prog = box.querySelector('#hf-zero-progress');
        if (btn) btn.addEventListener('click', function () {
          var name = (box.querySelector('#hf-zero-name') || {}).value || '';
          btn.disabled = true; btn.textContent = 'Creating…';
          if (prog) prog.textContent = 'creating the Space + uploading the brain (~2.3 MB)…';
          postJSON('/api/hf/space/create', { name: name }).then(function (res) {
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
                prog.innerHTML += '<br><span style="color:var(--text-3)">You have 2 ZeroGPU sandboxes already — use “Pick an existing space”.</span>';
              } else if (m.indexOf('PRO') >= 0 || m.indexOf('subscription') >= 0) {
                prog.innerHTML += '<br><span style="color:var(--text-3)">Your account can\'t create ZeroGPU spaces yet — it needs a verified email + 30+ days of age (or PRO). Try the shared paths or an existing space.</span>';
              }
            }
          });
        });
      }
    });
  }

  function stageBadge(s) {
    if (!s) return '';
    var color = 'var(--text-3)', label = s.stage || 'unknown';
    if (s.running) { color = 'var(--ok)'; label = 'running'; }
    else if (s.sleeping) { color = 'var(--warn)'; label = (s.quota_paused ? 'pro-gated' : 'sleeping'); }
    else if (s.building) { color = 'var(--accent-2)'; label = 'building'; }
    else if (s.error) { color = 'var(--err)'; label = 'error'; }
    return '<span style="font-size:11px;color:' + color + '">● ' + esc(label) + '</span>';
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
        } else if (s.quota_paused) {
          clearInterval(timer);
          renderQuotaPaused(prog, { repo: repo }, done);
        } else if (ticks > 60) { // ~6 min of polls
          clearInterval(timer);
          prog.innerHTML = 'still building — you can close this and pick the space later from "Pick an existing space".';
        }
      }).catch(function () { /* transient */ });
    }, 6000);
  }

  // ── option 3: pick an existing space (SCROLLABLE list) ────────────────
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
        ? '<div style="max-height:280px;overflow-y:auto;padding-right:2px">' + rows + '</div>' +
            '<p style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3-dim);margin:4px 0 0">tap to use a space in this chat</p>'
        : '<p style="font-size:calc(var(--ui-small-fs));color:var(--text-3);margin:0">No doomalay spaces yet — create one above.</p>';
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

  function optionCard(type, icon, title, desc, badge, disabled, extra) {
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
      (extra || '') +
      '</div>';
  }

  window.SandboxPicker = { open: open, detectDevice: detectDevice };
})();
