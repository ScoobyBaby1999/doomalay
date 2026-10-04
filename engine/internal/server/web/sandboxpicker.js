// sandboxpicker.js — the "+ Sandbox" picker (v0.62: the HF Space rework).
//
// Opens on the reusable ConnectOverlay (static ✕ + back stack, theme vars
// only). 4 top-level cards:
//   1. Quick Chat      — title only (v0.62 user spec: no short description).
//   2. HF Space        — Linux sandbox, ephemeral (ZeroGPU). The card itself
//                        carries a live "HF login required / ✓ HF connected"
//                        mini pill. Press → login-gated straight into the
//                        REPURPOSED HF overlay (below) — no intermediate
//                        chooser screen anymore.
//   3. Another Device  — deferred (mesh setup, future).
//   4. Terminal/VM     — dynamic, device-dependent (Termux on Android).
//
// THE HF OVERLAY (v0.62 — repurposed from the old 3-card chooser + the
// create screen; the Community Docker Sandbox is REMOVED per user spec —
// ZeroGPU spaces are the only offer):
//   · a scrollable list of the user's spaces (live stage badges, managed
//     marks) — tap one to use it in this chat;
//   · the bottom row: ＋ create new space — inline name + Create, the build
//     watches INSIDE the app (quota/PRO errors surface in-app, the user
//     never leaves the app);
//   · the footer: a small search-bar-looking pill — paste a PUBLIC space
//     URL (someone else's space that allows use) → recognize → connect →
//     use it (sandbox hf, mode "public": HF-token auth like the shared
//     space, but on the pasted repo).
//
// Each option calls onPick(sandboxType, detail); for 'hf',
// detail = {mode:'own'|'shared'|'public', repo:'user/name'}.
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
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          // v0.74: the coded error shape — e.code lets the UI branch without
          // parsing English (the age card keys off "account_age").
          var err = new Error(data.error || ('HTTP ' + r.status));
          if (data && data.code) err.code = data.code;
          throw err;
        }
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

  // ── the HF card description builder ──────────────────────────────────
  // v0.63 (user spec, random item 1): the HF Space card body — a two-tone
  // structured description. tc1 = Accent 1, tc2 = Accent 2 (small text):
  //   Linux Sandbox (tc1). Access to bash, python, node, java … package
  //   installs … (tc2). Your own ZeroGPU space, runs on dynamically
  //   allocated resources.
  //   ° 2 per free account • sleeps by usage • 1 GB          (tc1)
  //   ° wakes in ~2 mins, installs are ephemeral (tc2), brain
  //     reinstalls packages automatically after sleep.        (tc1)
  function hfCardDesc() {
    var tc1 = 'var(--accent)';
    var tc2 = 'var(--accent-2)';
    return (
      '<div style="font-size:calc(var(--ui-small-fs) - 2px);line-height:1.55;color:var(--text-2)">' +
        '<span style="color:' + tc1 + ';font-weight:700">Linux Sandbox</span>' +
        '<span style="color:' + tc1 + '">. </span>' +
        '<span style="color:' + tc2 + '">Access to ' +
          '<b style="color:' + tc2 + '">bash, python, node, java</b> … package installs …</span>' +
        '<br>' +
        'Your own <b style="color:' + tc1 + '">ZeroGPU</b> space, runs on ' +
        '<b style="color:' + tc1 + '">dynamically allocated resources</b>.' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;margin-top:6px;font-size:calc(var(--ui-small-fs) - 2px);line-height:1.6">' +
        '<span style="color:' + tc1 + '">° 2 per free account • sleeps by usage • 1 GB</span>' +
        '<span style="color:' + tc1 + '">° wakes in ~2 mins, installs are ' +
          '<b style="color:' + tc2 + '">ephemeral</b>, brain reinstalls packages automatically after sleep.</span>' +
      '</div>');
  }

  // The live mini pill riding the HF card title row (async account probe).
  function hfMiniPill(connected) {
    if (connected) {
      return '<span class="hf-mini hf-mini-ok">✓ HF connected</span>';
    }
    return '<span class="hf-mini hf-mini-no">HF login required</span>';
  }

  // ── main picker ───────────────────────────────────────────────────────
  function open(onPick) {
    var device = detectDevice();

    var terminalOption;
    if (device === 'android-apk') {
      terminalOption = optionCard('terminal', '⌨️', 'Termux (Local)', '', null);
    } else if (device === 'macos' || device === 'linux' || device === 'windows') {
      terminalOption = optionCard('terminal', '⌨️', 'Local Terminal', '', null);
    } else {
      terminalOption = optionCard('terminal', '⌨️', 'Terminal / VM', '', 'coming soon', true);
    }

    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<h2 style="font-size: calc(var(--ui-fs) + 4px);font-weight:600;color:var(--text-1);margin:0">Choose a model and sandbox and go!</h2>' +
      '</div>' +
      '<p style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-3);margin:0 0 20px">Pick a runtime for this chat. Each sandbox has different capabilities.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        // v0.62 user spec: Quick Chat carries NO short description.
        optionCard('quick', '⚡', 'Quick Chat', '', null) +
        optionCard('hf', '🤗', 'Hugging Face Space',
          '<span id="hf-card-pill" style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim)">checking HF…</span>',
          null, false,
          '<div class="hf-desc">' + hfCardDesc() + '</div>') +
        optionCard('device', '🔗', 'Another Device', '', 'coming soon', true) +
        terminalOption +
      '</div>' +
      '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3-dim);margin:20px 0 0;text-align:center">Detected device: ' + device + '</p>' +
      '</div>';

    window.ConnectOverlay.open(html);

    var contentEl = window.ConnectOverlay.getContentEl();

    // the live mini pill on the HF card
    var pillEl = contentEl.querySelector('#hf-card-pill');
    getJSON('/api/hf/account').catch(function () { return { connected: false }; }).then(function (acct) {
      var el = window.ConnectOverlay.isOpen() ? window.ConnectOverlay.getContentEl().querySelector('#hf-card-pill') : null;
      if (!el) el = pillEl;
      if (el) el.outerHTML = hfMiniPill(!!acct.connected);
    });

    contentEl.querySelectorAll('[data-sandbox]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.sandbox;
        if (card.dataset.disabled === 'true') return; // skip "coming soon"
        if (type === 'hf') {
          openHFSpaces(onPick);
          return;
        }
        window.ConnectOverlay.close();
        if (onPick) onPick(type);
      });
    });
  }

  // ── THE HF OVERLAY (v0.62: login-gated; spaces list + create + public) ─
  function openHFSpaces(onPick) {
    getJSON('/api/hf/account').catch(function () { return { connected: false, user: '' }; }).then(function (acct) {
      if (!acct.connected) {
        // user spec: not logged in → straight to the login-to-HF panel;
        // once done, land in the spaces overlay.
        if (window.HFConnect) {
          window.HFConnect.openConnectPanel({
            onDone: function () { openHFSpaces(onPick); }
          });
        }
        return;
      }
      renderHFSpaces(acct, onPick);
    });
  }

  function renderHFSpaces(acct, onPick) {
    var html =
      '<div style="padding:20px 16px 0">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">' +
        '<h2 style="font-size: calc(var(--ui-fs) + 2px);font-weight:600;color:var(--text-1);margin:0">🤗 your HF spaces</h2>' +
        '<span class="hf-mini hf-mini-ok">✓ ' + esc(acct.user || 'connected') + '</span>' +
      '</div>' +
      '<p style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 12px;line-height:1.45">' +
        'Your personal ZeroGPU Linux sandboxes — pick one to run this chat on.</p>' +
      '<div id="hf-spaces-list" style="max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:2px">' +
        '<div style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3)">loading your spaces…</div>' +
      '</div>' +
      // the bottom row: create new space (user spec — creating NEVER leaves the app)
      '<div id="hf-create" style="margin-top:12px">' +
        '<div id="hf-create-pill" class="hf-create-pill" role="button" tabindex="0">' +
          '<span style="font-size:15px">＋</span>' +
          '<span style="flex:1;font-weight:600">create new space</span>' +
          '<span style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3)">free · ZeroGPU</span>' +
        '</div>' +
        '<div id="hf-create-form" style="display:none"></div>' +
      '</div>' +
      // the footer: the public-space search bar (user spec)
      '<div id="hf-public" class="hf-public-wrap">' +
        '<div class="hf-public-title">use a public space</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<div class="hf-public-bar">' +
            '<span style="flex-shrink:0;color:var(--text-3);font-size:13px">⌕</span>' +
            '<input id="hf-public-url" placeholder="paste a public space URL…" ' +
              'autocomplete="off" autocapitalize="off" spellcheck="false">' +
          '</div>' +
          '<button id="hf-public-go" class="hf-public-go">connect</button>' +
        '</div>' +
        '<div id="hf-public-note" style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3);margin-top:6px;line-height:1.45">' +
          'someone else\'s ZeroGPU space published for anyone — the app recognizes it and runs this chat on it.</div>' +
        '<div id="hf-public-err" style="display:none"></div>' +
      '</div>' +
      '</div>';

    window.ConnectOverlay.open(html, {
      onSwap: function () {
        wireSpacesList(onPick);
        wireCreate(onPick);
        wirePublicConnect(onPick);
      }
    });
  }

  // the scrollable list of the user's spaces (?all=1 — every space they
  // own, not just doomalay-named ones; managed marks the ones this engine
  // holds a token for).
  function wireSpacesList(onPick) {
    var listEl = document.getElementById('hf-spaces-list');
    if (!listEl) return;
    getJSON('/api/hf/spaces?all=1').then(function (data) {
      if (!window.ConnectOverlay.isOpen() || !document.getElementById('hf-spaces-list')) return;
      var rows = (data.spaces || []).map(function (sp) {
        return '<div class="hf-space-row" data-repo="' + esc(sp.repo) + '" data-managed="' + (sp.managed ? '1' : '') + '">' +
          '<span class="hf-space-name">' + esc(sp.repo) + '</span>' +
          (sp.managed ? '<span class="hf-space-mgd">· managed</span>' : '') +
          stageBadge(sp) + '</div>';
      }).join('');
      listEl.innerHTML = rows
        ? rows + '<p style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim);margin:6px 0 0">tap a space to use it in this chat</p>'
        : '<p style="font-size:calc(var(--ui-small-fs));color:var(--text-3);margin:0">no spaces yet — create one below.</p>';
      listEl.querySelectorAll('.hf-space-row').forEach(function (row) {
        row.addEventListener('click', function () {
          var repo = row.dataset.repo;
          var managed = !!row.dataset.managed;
          window.ConnectOverlay.close();
          // managed → we hold the per-space token (mode own); any other
          // own space connects with the HF token (mode public).
          if (onPick) onPick('hf', { mode: managed ? 'own' : 'public', repo: repo });
        });
      });
    }).catch(function (e) {
      listEl.innerHTML = '<p style="color:var(--err);font-size:calc(var(--ui-small-fs));margin:0">' + esc(e.message) + '</p>';
    });
  }

  // ── v0.74: THE AGE CARD ───────────────────────────────────────────
  // HF's 30+ day account-age refusal, as a friendly themed card instead
  // of the long raw error blob: the headline (bigger + brighter, themed),
  // the shared-space warning FIRST (v0.88: accent-3 + the triangle-alert
  // glyph), the community fallback link (tap-to-copy + the paste
  // instruction), the your-keys-stay-yours note (v0.88: the Connect
  // Cloud Providers key, always encrypted), and the one-tap way out.
  var COMMUNITY_SPACE = 'ScoobyBaby1999/doomalaysocreate';
  var COMMUNITY_URL = 'https://huggingface.co/spaces/ScoobyBaby1999/doomalaysocreate';

  // v0.88 THE AGE-CARD REWORK (user spec): the shared-space warning now
  // carries a real triangle-alert glyph riding ACCENT-3 (the warning
  // tone — accent-2 was the old tone and read as a link color), the BYOK
  // section + ghost button are GONE (the paste-your-key-here affordance
  // read as "the Space wants your key"), and the new "your keys stay
  // yours" section states the truth: the community Space runs each turn
  // with the key you already configured in Connect Cloud Providers —
  // your own key, always encrypted (AES-256 on this device, TLS in
  // flight, read only for the turn it serves, never stored by the Space).
  function renderAgeCard(form, onPick) {
    form.style.display = '';
    var warnIcon = (window.IconLib && window.IconLib.svg)
      ? window.IconLib.svg('triangle-alert', 15) : '⚠';
    form.innerHTML =
      '<div class="hf-age-card" role="alertdialog" aria-label="Hugging Face account age requirement">' +
        '<div class="hf-age-head">Hugging Face needs your account to be <b>30+ days old</b> to create a Space.</div>' +
        '<div class="hf-age-sub">a verified email + account age — or a PRO account — unlocks creating your own.</div>' +
        '<div class="hf-age-warn"><span class="hf-age-warn-ic">' + warnIcon + '</span>' +
          '<span>The community Space is shared with everyone.<br>' +
          '<b>Never share secrets or personal info in it.</b></span></div>' +
        '<div class="hf-age-sec">🌍 community fallback</div>' +
        '<div class="hf-age-copy" id="hf-age-copy" role="button" tabindex="0">' +
          '<span class="hf-age-url">' + COMMUNITY_URL + '</span>' +
          '<span class="hf-age-copybtn">tap to copy</span>' +
        '</div>' +
        '<div class="hf-age-note">paste it in <b>“use a public space”</b> below — or use the one-tap button.</div>' +
        '<div class="hf-age-sec">🔒 your keys stay yours</div>' +
        '<div class="hf-age-note">the community Space runs each turn with <b>the provider key you already saved in Connect Cloud Providers</b> — your own key, the same one your cloud chats use, never a shared one. your key, your bill.</div>' +
        '<div class="hf-age-note">that key is <b>always encrypted</b> — AES-256 on this device, TLS in flight, readable only for the turn it serves, never stored by the Space. The Space still processes the chat itself to run the turn, so keep secrets and personal info out of it.</div>' +
        '<div class="hf-age-actions">' +
          '<button id="hf-age-go" class="hf-age-btn hf-age-btn-go">🌍 use the community space for this chat</button>' +
        '</div>' +
      '</div>';

    var copyEl = form.querySelector('#hf-age-copy');
    if (copyEl) {
      var doCopy = function () {
        var done = function () {
          var b = copyEl.querySelector('.hf-age-copybtn');
          if (b) { b.textContent = '✓ copied'; setTimeout(function () { b.textContent = 'tap to copy'; }, 1800); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(COMMUNITY_URL).then(done, done);
        } else { done(); }
      };
      copyEl.addEventListener('click', doCopy);
      copyEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); doCopy(); }
      });
    }
    var goBtn = form.querySelector('#hf-age-go');
    if (goBtn) goBtn.addEventListener('click', function () {
      window.ConnectOverlay.close();
      if (onPick) onPick('hf', { mode: 'public', repo: COMMUNITY_SPACE });
    });
  }

  // the create flow — everything in-app: the form expands inline, the build
  // watches inline (stage ticks), quota/PRO errors render in-app, and the
  // moment the space is running it is picked (overlay closes into the
  // chat). The user NEVER leaves the app.
  function wireCreate(onPick) {
    var pill = document.getElementById('hf-create-pill');
    var form = document.getElementById('hf-create-form');
    if (!pill || !form) return;
    pill.addEventListener('click', function () {
      pill.style.display = 'none';
      form.style.display = '';
      form.innerHTML =
        '<div style="display:flex;gap:8px">' +
          '<input id="hf-new-name" class="hf-new-input" placeholder="doomalay-<auto>" ' +
            'autocomplete="off" autocapitalize="off" spellcheck="false">' +
          '<button id="hf-new-go" class="hf-new-go">Create</button>' +
        '</div>' +
        '<div id="hf-new-progress" style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3);line-height:1.55;margin-top:6px"></div>';
      var btn = form.querySelector('#hf-new-go');
      if (btn) btn.addEventListener('click', function () {
        var name = (form.querySelector('#hf-new-name') || {}).value || '';
        btn.disabled = true; btn.textContent = 'Creating…';
        var prog = form.querySelector('#hf-new-progress');
        if (prog) prog.textContent = 'creating the Space + uploading the brain (~2.3 MB)…';
        postJSON('/api/hf/space/create', { name: name }).then(function (res) {
          watchBuildInline(prog, res.repo, function () {
            window.ConnectOverlay.close();
            if (onPick) onPick('hf', { mode: 'own', repo: res.repo });
          });
          // the new space joins the list as it builds
          wireSpacesList(onPick);
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = 'Create';
          if (prog) prog.innerHTML = '';
          // v0.74: the coded age gate → the friendly card (bigger + brighter
          // + themed, with the community fallback + the shared warning).
          if (e && e.code === 'account_age') {
            renderAgeCard(form, onPick);
            return;
          }
          if (prog) {
            var m = String(e.message || '');
            prog.innerHTML = '<span style="color:var(--err)">' + esc(m) + '</span>';
            if (m.indexOf('ZeroGPU') >= 0 || m.indexOf('2 ZeroGPU') >= 0 || m.indexOf('both') >= 0) {
              prog.innerHTML += '<br><span style="color:var(--text-3)">You\'ve used every ZeroGPU space your account allows — pick one of your spaces above.</span>';
            } else if (m.indexOf('PRO') >= 0 || m.indexOf('subscription') >= 0) {
              prog.innerHTML += '<br><span style="color:var(--text-3)">Your account can\'t create ZeroGPU spaces yet — it needs a verified email + 30+ days of age (or PRO). Pick one of your spaces above.</span>';
            }
          }
        });
      });
    });
  }

  // the inline build watcher — the progress element is re-queried by id on
  // every tick (list repaints can replace the subtree it lived in).
  function watchBuildInline(progEl, repo, done) {
    if (!progEl) { done(); return; }
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      if (!window.ConnectOverlay.isOpen()) { clearInterval(timer); return; }
      var prog = document.getElementById('hf-new-progress') || progEl;
      if (!prog) { clearInterval(timer); return; }
      getJSON('/api/hf/space/status?repo=' + encodeURIComponent(repo)).then(function (s) {
        if (!window.ConnectOverlay.isOpen()) { clearInterval(timer); return; }
        prog.innerHTML = 'building <b>' + esc(repo) + '</b> — first build installs the brain (~3-6 min)… <b>' + esc(s.stage || '…') + '</b>';
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
        } else if (ticks > 70) { // ~7 min of polls
          clearInterval(timer);
          prog.innerHTML = 'still building — it will appear in your spaces when ready.';
        }
      }).catch(function () { /* transient */ });
    }, 6000);
  }

  // ── the footer: connect a PUBLIC space by URL ─────────────────────────
  // Recognizes huggingface.co/spaces/o/n, https://o-n.hf.space, o-n and
  // bare o/n — then verifies it live and connects (mode public).
  function parseSpaceRef(v) {
    v = String(v || '').trim();
    if (!v) return '';
    var m = v.match(/huggingface\.co\/spaces\/([\w.-]+)\/([\w.-]+)/i);
    if (m) return m[1] + '/' + m[2];
    m = v.match(/^https?:\/\/([\w.-]+)\.hf\.space\/?$/i);
    if (m) {
      var slug = m[1];
      var dash = slug.indexOf('-');
      if (dash > 0) return slug.slice(0, dash) + '/' + slug.slice(dash + 1);
      return '';
    }
    m = v.match(/^([\w.-]+)\/([\w.-]+)\/?$/);
    if (m) return m[1] + '/' + m[2];
    return '';
  }

  function wirePublicConnect(onPick) {
    var go = document.getElementById('hf-public-go');
    var input = document.getElementById('hf-public-url');
    if (!go || !input) return;
    function tryConnect() {
      var errEl = document.getElementById('hf-public-err');
      if (errEl) errEl.style.display = 'none';
      var repo = parseSpaceRef(input.value);
      if (!repo) {
        if (errEl) {
          errEl.style.display = '';
          errEl.innerHTML = '<span style="color:var(--err);font-size:calc(var(--ui-small-fs) - 1px)">couldn\'t read that as a space — paste a huggingface.co/spaces/… or *.hf.space URL</span>';
        }
        return;
      }
      go.disabled = true; go.textContent = 'checking…';
      getJSON('/api/hf/space/status?repo=' + encodeURIComponent(repo)).then(function (s) {
        if (s.error) throw new Error('that space is in an error state (' + s.stage + ')');
        if (s.sleeping) {
          // sleeping spaces can't answer the probe until they wake — connect
          // now; the first chat turn wakes it (~1 min).
          if (window.toast) window.toast('space is asleep — it wakes in ~1 min');
          window.ConnectOverlay.close();
          if (onPick) onPick('hf', { mode: 'public', repo: repo });
          return;
        }
        // the public-connect verification: the space must ACCEPT the user's
        // HF token (shared-style auth) before the chat commits to it.
        return getJSON('/api/hf/space/probe?repo=' + encodeURIComponent(repo)).then(function (p) {
          if (p && p.ok === false) throw new Error(p.error || 'that space refuses public use');
          window.ConnectOverlay.close();
          if (onPick) onPick('hf', { mode: 'public', repo: repo });
        });
      }).catch(function (e) {
        go.disabled = false; go.textContent = 'connect';
        if (errEl) {
          errEl.style.display = '';
          errEl.innerHTML = '<span style="color:var(--err);font-size:calc(var(--ui-small-fs) - 1px)">' + esc(e.message) + '</span>';
        }
      });
    }
    go.addEventListener('click', tryConnect);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); tryConnect(); }
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

  function optionCard(type, icon, title, desc, badge, disabled, extra) {
    var opacity = disabled ? 'opacity:0.5;pointer-events:none' : 'cursor:pointer';
    var badgeHTML = badge ? '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);background:var(--text-3-dim);padding:3px 8px;border-radius:6px">' + badge + '</span>' : '';
    return '<div data-sandbox="' + type + '" data-disabled="' + (disabled ? 'true' : 'false') + '"' +
      ' style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:12px;padding:16px;' +
      opacity + ';transition:border-color 0.15s"' +
      ' onmouseover="if(this.dataset.disabled!==\'true\')this.style.borderColor=\'var(--text-3-dim)\'"' +
      ' onmouseout="this.style.borderColor=\'var(--surface-2)\'"' +
      '>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:' + (desc || extra ? '8px' : '0') + '">' +
      '<span style="font-size:24px">' + icon + '</span>' +
      '<span style="font-size: calc(var(--ui-fs) + 1px);font-weight:600;color:var(--text-1);flex:1">' + title + '</span>' +
      badgeHTML +
      '</div>' +
      (desc ? '<p style="font-size: var(--ui-small-fs);color:var(--text-3);margin:0;line-height:1.5">' + desc + '</p>' : '') +
      (extra || '') +
      '</div>';
  }

  // ── v0.62 styles (injected once, theme vars only) ─────────────────────
  function ensureStyles() {
    if (document.getElementById('sp-v062-styles')) return;
    var s = document.createElement('style');
    s.id = 'sp-v062-styles';
    s.textContent =
      // the mini pill on the HF card
      '.hf-mini{flex-shrink:0;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;' +
        'border-radius:999px;font-size:calc(var(--ui-small-fs) - 2px);font-weight:700;border:1px solid}' +
      '.hf-mini-ok{color:var(--ok);border-color:rgba(var(--ok-rgb),0.45);background:rgba(var(--ok-rgb),0.10)}' +
      '.hf-mini-no{color:var(--warn);border-color:rgba(var(--warn-rgb),0.45);background:rgba(var(--warn-rgb),0.10)}' +
      // the HF card description (small text, formatted — user spec)
      '.hf-desc{margin-top:6px;font-size:calc(var(--ui-small-fs) - 2px);line-height:1.5;' +
        'color:var(--text-3);display:block}' +
      // spaces list rows
      '.hf-space-row{display:flex;justify-content:space-between;align-items:center;gap:8px;' +
        'background:var(--surface-1);border:1px solid var(--border);border-radius:10px;' +
        'padding:10px 12px;margin-bottom:8px;cursor:pointer;-webkit-tap-highlight-color:transparent;' +
        'touch-action:manipulation}' +
      '.hf-space-row:active{border-color:rgba(var(--accent-rgb),0.55)}' +
      '.hf-space-name{flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2);overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap}' +
      '.hf-space-mgd{flex-shrink:0;font-size:10px;color:var(--ok);font-family:inherit;font-weight:600}' +
      // the create pill (bottom row)
      '.hf-create-pill{display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 12px;' +
        'border-radius:12px;cursor:pointer;border:1.5px dashed var(--border-strong);' +
        'color:var(--text-1);font-weight:600;font-size:var(--ui-small-fs);' +
        'background:linear-gradient(135deg,rgba(var(--accent-rgb),0.10),rgba(var(--accent-2-rgb),0.06));' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.hf-create-pill:active{background:linear-gradient(135deg,rgba(var(--accent-rgb),0.20),rgba(var(--accent-2-rgb),0.12))}' +
      '.hf-new-input{flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--raised-ring);' +
        'background-color:var(--raised-chrome);color:var(--text-1);font-size:calc(var(--ui-small-fs));font-family:inherit;outline:none}' +
      '.hf-new-input:focus{border-color:var(--accent)}' +
      '.hf-new-go{padding:9px 16px;border-radius:10px;background:var(--accent);color:var(--on-accent);' +
        'background-image:var(--accent-gradient,none);background-attachment:fixed;border:none;font-size:calc(var(--ui-small-fs));' +
        'font-weight:600;font-family:inherit;cursor:pointer}' +
      // the footer public-space search bar
      '.hf-public-wrap{margin:14px 0 18px;padding:12px;border-radius:12px;' +
        'background:rgba(var(--accent-2-rgb),0.05);border:1px solid rgba(var(--accent-2-rgb),0.28)}' +
      '.hf-public-title{font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;color:var(--text-1);margin-bottom:7px}' +
      '.hf-public-bar{flex:1;display:flex;align-items:center;gap:7px;padding:8px 12px;border-radius:999px;' +
        'background:var(--surface-2);border:1px solid var(--border);min-width:0}' +
      '.hf-public-bar input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--text-1);' +
        'font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit}' +
      '.hf-public-bar input::placeholder{color:var(--text-3)}' +
      '.hf-public-go{flex-shrink:0;padding:8px 14px;border-radius:999px;border:none;cursor:pointer;' +
        'background:var(--accent-2);color:var(--bg-app);background-image:var(--accent-2-gradient,none);background-attachment:fixed;' +
        'font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;font-family:inherit;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      // v0.74: THE AGE CARD — the friendly 30+ day themed card.
      '.hf-age-card{margin-top:10px;padding:16px 14px;border-radius:14px;display:flex;flex-direction:column;gap:9px;' +
        'background:rgba(var(--accent-rgb),0.07);border:1px solid rgba(var(--accent-rgb),0.35)}' +
      // the headline: LARGER + BRIGHTER (the user spec) — accent ink, bold.
      '.hf-age-head{font-size:calc(var(--ui-fs) + 2px);line-height:1.4;font-weight:700;color:var(--text-1);' +
        'background-image:var(--accent-gradient,none);background-attachment:fixed;-webkit-background-clip:text;' +
        'background-clip:text}' +
      '.hf-age-head b{color:inherit}' +
      '.hf-age-sub{font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2);line-height:1.45}' +
      // v0.88: the shared-space warning rides ACCENT-3 (the warning tone)
      // + the real triangle-alert glyph (IconLib, currentColor → accent-3).
      '.hf-age-warn{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;' +
        'font-size:calc(var(--ui-small-fs) - 1px);line-height:1.5;color:var(--text-1);' +
        'background:rgba(var(--accent-3-rgb),0.10);border:1px solid rgba(var(--accent-3-rgb),0.45)}' +
      '.hf-age-warn b{color:var(--text-2)}' +
      '.hf-age-warn-ic{display:inline-flex;flex-shrink:0;color:var(--warn);margin-top:1px}' +
      '.hf-age-sec{margin-top:3px;font-size:calc(var(--ui-small-fs) - 2px);font-weight:700;letter-spacing:0.04em;' +
        'text-transform:uppercase;color:var(--text-3)}' +
      '.hf-age-copy{display:flex;align-items:center;gap:8px;min-height:44px;padding:10px 12px;border-radius:10px;' +
        'background:var(--surface-2);border:1px dashed var(--border);cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.hf-age-url{flex:1;min-width:0;font-size:calc(var(--ui-small-fs) - 2px);color:var(--fmt-link);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.hf-age-copybtn{flex-shrink:0;font-size:calc(var(--ui-small-fs) - 2px);font-weight:600;color:var(--text-3)}' +
      '.hf-age-note{font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3);line-height:1.5}' +
      '.hf-age-note b{color:var(--text-2)}' +
      '.hf-age-actions{display:flex;flex-direction:column;gap:8px;margin-top:3px}' +
      '.hf-age-btn{min-height:44px;padding:11px 16px;border-radius:12px;font-size:calc(var(--ui-small-fs));' +
        'font-weight:600;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.hf-age-btn-go{background:var(--accent);color:var(--on-accent);border:none;' +
        'background-image:var(--accent-gradient,none);background-attachment:fixed}';
    document.head.appendChild(s);
  }
  ensureStyles();

  window.SandboxPicker = { open: open, detectDevice: detectDevice };
})();
