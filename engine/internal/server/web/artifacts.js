// artifacts.js — v0.17 the ARTIFACTS DRAWER + TEXT EDITOR.
//
// User spec: "Each chat should have its own artifacts drawer located in
// the header. It is a pill with a drawer icon that when pressed opens a
// panel that lists all the artifacts of any file type, the user may
// download the artifact and have it save to their storage. The user may
// also permanently delete and rename an artifact. The user may click on
// any artifact row itself to open the artifact file itself… a panel that
// can display text in proper formatting depending on the file type…
// a text editor panel that not only recognizes most file types, but
// allows for editing, and saving changes."
//
// IMPLEMENTATION:
//   Drawer  — full-screen overlay, one row per artifact (icon, name,
//             type · size · date), inline rename, confirm-delete,
//             download, tap row → editor.
//   Editor  — CodeMirror 5 (vendored MIT) with per-type mode from
//             FileTypes.cmMode; save (PUT), rename, download, delete.
//             Binary artifacts → download-only view.
//
// Engine API used (see server/artifacts.go):
//   GET/POST  /api/sessions/{id}/artifacts
//   GET/PUT/DELETE /api/sessions/{id}/artifacts/{aid}
//   GET /api/sessions/{id}/artifacts/{aid}/download
//
// Exposes: window.Artifacts
(function () {
  'use strict';

  var FT = window.FileTypes;
  var esc = window.Formatter.esc;

  var overlayEl = null;   // the drawer/editor root (built lazily)
  var currentSession = null;
  var currentChat = null; // { name } for the header title
  var refreshHooks = [];  // pill badge refreshers

  // ── tiny script/css loader (lazy CodeMirror + Prism langs) ──────
  var loaded = {};
  function ensureScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { delete loaded[src]; reject(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  function ensureCSS(href) {
    if (loaded[href]) return loaded[href];
    loaded[href] = new Promise(function (resolve) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = resolve;
      l.onerror = resolve;
      document.head.appendChild(l);
    });
    return loaded[href];
  }

  // ── API helpers ─────────────────────────────────────────────────
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

  function list(sessionId) {
    return api('/api/sessions/' + sessionId + '/artifacts').then(function (d) {
      return d.artifacts || [];
    });
  }

  function create(sessionId, name, content, encoding, source) {
    return api('/api/sessions/' + sessionId + '/artifacts', 'POST', {
      name: name, content: content, encoding: encoding || 'utf8', source: source || 'model'
    });
  }

  function refreshPills() {
    refreshHooks.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  // ── Overlay scaffolding ────────────────────────────────────────
  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'artifacts-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;z-index:3000;display:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function openOverlay(innerHTML) {
    var el = ensureOverlay();
    el.innerHTML = innerHTML;
    el.style.display = 'block';
    el._openedAt = performance.now(); // ghost-click guard (see isGhostTap)
    requestAnimationFrame(function () {
      el.classList.add('open');
    });
    return el;
  }

  // A tap on a list row swaps the overlay content (drawer → editor). The
  // browser dispatches the tap's synthetic click AFTER the swap — it lands
  // on whatever is now at those coordinates (often the scrim → instant
  // close, or the back button). Ignore clicks that arrive within 400ms of
  // a content swap — they're ghosts of the tap that caused it.
  function isGhostTap() {
    return overlayEl && (performance.now() - (overlayEl._openedAt || 0) < 400);
  }

  function closeOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.remove('open');
    var el = overlayEl;
    setTimeout(function () {
      if (!el.classList.contains('open')) {
        el.style.display = 'none';
        el.innerHTML = '';
      }
    }, 240);
  }

  // scrim tap / ✕ → close (unless the editor has unsaved changes)
  function wireClose(root, onClose) {
    var scrim = root.querySelector('.art-scrim');
    if (scrim) scrim.addEventListener('click', function (e) {
      if (e.target === scrim && !isGhostTap() && (!onClose || onClose() !== false)) closeOverlay();
    });
    var x = root.querySelector('.art-close');
    if (x) x.addEventListener('click', function () {
      if (isGhostTap()) return;
      if (!onClose || onClose() !== false) closeOverlay();
    });
  }

  // ── THE DRAWER ──────────────────────────────────────────────────
  function openDrawer(sessionId, chat) {
    if (!sessionId) return;
    currentSession = sessionId;
    currentChat = chat || null;

    var html =
      '<div class="art-scrim"></div>' +
      '<div class="art-panel">' +
        '<div class="art-head">' +
          '<span class="art-title">🗄 artifacts' +
            (chat && chat.name ? ' · ' + esc(chat.name) : '') + '</span>' +
          '<span class="art-count" id="art-count"></span>' +
          '<button class="art-close">✕</button>' +
        '</div>' +
        '<div class="art-body" id="art-list"><div class="art-loading">loading…</div></div>' +
      '</div>';
    var root = openOverlay(html);
    wireClose(root, null);

    var listEl = root.querySelector('#art-list');
    list(sessionId).then(function (items) {
      if (!root.isConnected || currentSession !== sessionId) return;
      renderList(listEl, items, sessionId);
    }).catch(function (e) {
      listEl.innerHTML = '<div class="art-loading">⚠ ' + esc(e.message) + '</div>';
    });
    refreshPills();
  }

  function renderList(listEl, items, sessionId) {
    var cEl = document.getElementById('art-count');
    if (cEl) cEl.textContent = items.length ? items.length + ' file' + (items.length > 1 ? 's' : '') : '';

    if (!items.length) {
      listEl.innerHTML =
        '<div class="art-empty">No artifacts yet.</div>' +
        '<div class="art-empty-sub">Ask the bot for a file — "write me a markdown report", "give me the data as JSON" — it lands here.</div>';
      return;
    }

    listEl.innerHTML = '';
    items.sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); });
    items.forEach(function (m) {
      var info = FT.info(m.name);
      var row = document.createElement('div');
      row.className = 'art-row';
      row.innerHTML =
        '<span class="art-row-ico" style="color:' + info.color + '">' + info.icon + '</span>' +
        '<span class="art-row-meta">' +
          '<span class="art-row-name">' + esc(m.name) + '</span>' +
          '<span class="art-row-sub">' + esc(info.label) + ' · ' + FT.humanBytes(m.size) +
            ' · ' + fmtDate(m.updated_at) + '</span>' +
        '</span>' +
        '<button class="art-row-btn" data-act="rename" aria-label="Rename">✎</button>' +
        '<button class="art-row-btn" data-act="download" aria-label="Download">⇩</button>' +
        '<button class="art-row-btn art-row-btn-danger" data-act="delete" aria-label="Delete">🗑</button>';

      row.addEventListener('click', function (e) {
        if (e.target.closest('.art-row-btn')) return;
        openEditor(sessionId, m.id);
      });
      row.querySelector('[data-act="download"]').addEventListener('click', function (e) {
        e.stopPropagation();
        window.open('/api/sessions/' + sessionId + '/artifacts/' + m.id + '/download', '_blank');
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', function (e) {
        e.stopPropagation();
        confirmInline(this, 'delete forever?', function (yes) {
          if (!yes) return;
          api('/api/sessions/' + sessionId + '/artifacts/' + m.id, 'DELETE')
            .then(function () { openDrawer(sessionId, currentChat); refreshPills(); })
            .catch(function (err) { toast(err.message); });
        });
      });
      // inline rename: ✎ turns the name into an input + ✓
      row.querySelector('[data-act="rename"]').addEventListener('click', function (e) {
        e.stopPropagation();
        var nameEl = row.querySelector('.art-row-name');
        var old = m.name;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = old;
        input.className = 'art-rename-input';
        nameEl.replaceWith(input);
        input.focus();
        input.setSelectionRange(old.length, old.length);
        var done = false;
        var commit = function () {
          if (done) return;
          done = true;
          var nn = input.value.trim();
          if (!nn || nn === old) { openDrawer(sessionId, currentChat); return; }
          api('/api/sessions/' + sessionId + '/artifacts/' + m.id, 'PUT', { name: nn })
            .then(function () { openDrawer(sessionId, currentChat); })
            .catch(function (err) { toast(err.message); openDrawer(sessionId, currentChat); });
        };
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { done = true; openDrawer(sessionId, currentChat); }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', function (ev) { ev.stopPropagation(); });
      });

      listEl.appendChild(row);
    });
  }

  function fmtDate(unix) {
    if (!unix) return '';
    var d = new Date(unix * 1000);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  // small inline confirm chip on a button
  function confirmInline(btn, label, cb) {
    var row = btn.closest('.art-row');
    var holder = document.createElement('span');
    holder.className = 'art-confirm';
    holder.innerHTML = '<span class="art-confirm-label">' + esc(label) + '</span>' +
      '<button class="art-confirm-yes">yes</button><button class="art-confirm-no">no</button>';
    btn.replaceWith(holder);
    holder.querySelector('.art-confirm-yes').addEventListener('click', function (e) {
      e.stopPropagation(); cb(true);
    });
    holder.querySelector('.art-confirm-no').addEventListener('click', function (e) {
      e.stopPropagation(); cb(false);
    });
    if (row) row.addEventListener('click', function no() {
      cb(false); row.removeEventListener('click', no);
    });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'art-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, 2200);
  }

  // ── THE EDITOR ─────────────────────────────────────────────────
  function openEditor(sessionId, artifactId) {
    if (!sessionId || !artifactId) return;
    currentSession = sessionId;

    var html =
      '<div class="art-scrim"></div>' +
      '<div class="art-panel art-panel-editor">' +
        '<div class="art-head">' +
          '<button class="art-back">‹</button>' +
          '<span class="art-title" id="ed-name">…</span>' +
          '<span class="art-count" id="ed-meta"></span>' +
          '<button class="art-close">✕</button>' +
        '</div>' +
        '<div class="art-ed-actions">' +
          '<button id="ed-save" class="art-ed-btn" disabled>save</button>' +
          '<button id="ed-rename" class="art-ed-btn">✎ rename</button>' +
          '<button id="ed-dl" class="art-ed-btn">⇩ download</button>' +
          '<button id="ed-del" class="art-ed-btn art-ed-btn-danger">🗑 delete</button>' +
        '</div>' +
        '<div class="art-ed-body" id="ed-body"><div class="art-loading">loading…</div></div>' +
      '</div>';
    var root = openOverlay(html);

    var dirty = false;
    var cm = null;
    var data = null;
    var saveBtn = root.querySelector('#ed-save');
    var nameEl = root.querySelector('#ed-name');
    var metaEl = root.querySelector('#ed-meta');
    var bodyEl = root.querySelector('#ed-body');

    var guard = function () {
      if (!dirty) return true;
      return window.confirm('Discard unsaved changes?');
    };
    wireClose(root, guard);
    root.querySelector('.art-back').addEventListener('click', function () {
      if (isGhostTap()) return; // ghost of the row-tap that opened the editor
      if (guard()) openDrawer(sessionId, currentChat);
    });

    api('/api/sessions/' + sessionId + '/artifacts/' + artifactId).then(function (d) {
      if (!root.isConnected) return;
      data = d;
      var info = FT.info(d.name);
      nameEl.textContent = d.name;
      metaEl.textContent = info.label + ' · ' + FT.humanBytes(d.size);
      root.querySelector('#ed-dl').addEventListener('click', function () {
        window.open('/api/sessions/' + sessionId + '/artifacts/' + artifactId + '/download', '_blank');
      });
      root.querySelector('#ed-del').addEventListener('click', function () {
        if (!window.confirm('Delete "' + d.name + '" permanently?')) return;
        api('/api/sessions/' + sessionId + '/artifacts/' + artifactId, 'DELETE')
          .then(function () { openDrawer(sessionId, currentChat); refreshPills(); })
          .catch(function (e) { toast(e.message); });
      });
      root.querySelector('#ed-rename').addEventListener('click', function () {
        var nn = window.prompt('Rename artifact:', d.name);
        if (!nn || !nn.trim() || nn.trim() === d.name) return;
        api('/api/sessions/' + sessionId + '/artifacts/' + artifactId, 'PUT', { name: nn.trim() })
          .then(function (m) {
            data.name = m.name;
            nameEl.textContent = m.name;
            var i2 = FT.info(m.name);
            metaEl.textContent = i2.label + ' · ' + FT.humanBytes(m.size);
            toast('renamed');
          })
          .catch(function (e) { toast(e.message); });
      });

      if (info.binary) {
        bodyEl.innerHTML =
          '<div class="art-binary">' +
            '<span style="font-size:34px">' + info.icon + '</span>' +
            '<div class="art-binary-name">' + esc(d.name) + '</div>' +
            '<div class="art-binary-sub">' + esc(info.label) + ' · binary file · ' + FT.humanBytes(d.size) + '</div>' +
            '<button class="art-ed-btn" id="ed-dl2">⇩ download to your device</button>' +
          '</div>';
        bodyEl.querySelector('#ed-dl2').addEventListener('click', function () {
          window.open('/api/sessions/' + sessionId + '/artifacts/' + artifactId + '/download', '_blank');
        });
        return;
      }

      // text file → CodeMirror editor with the type's mode
      var mode = FT.cmMode(d.name) || null;
      var modeSpec = mode === 'javascript' ? { name: 'javascript', json: true } : (mode || 'text/plain');
      // CHAIN the loads: the mode file calls CodeMirror.defineMode at
      // eval time — it MUST land after the core (parallel injection raced
      // and threw "CodeMirror is not defined").
      var coreP = ensureCSS('/vendor/editor/codemirror.css')
        .then(function () { return ensureScript('/vendor/editor/codemirror.min.js'); });
      if (mode) {
        coreP = coreP.then(function () { return ensureScript('/vendor/editor/mode-' + mode + '.min.js'); });
      }
      coreP.then(function () {
        if (!root.isConnected || !window.CodeMirror) return;
        bodyEl.innerHTML = '';
        var cmHost = document.createElement('div');
        cmHost.className = 'art-cm-host';
        bodyEl.appendChild(cmHost);
        try {
          cm = CodeMirror(cmHost, {
            value: d.content || '',
            mode: modeSpec,
            lineNumbers: true,
            lineWrapping: true,
            theme: 'doomalay',
            viewportMargin: 60,
            indentUnit: 2
          });
        } catch (e) {
          // mode failed → plain textarea fallback
          bodyEl.innerHTML = '';
          var ta = document.createElement('textarea');
          ta.className = 'art-fallback-ta';
          ta.value = d.content || '';
          bodyEl.appendChild(ta);
          cm = {
            getValue: function () { return ta.value; },
            on: function () {}
          };
        }
        cm.on('change', function () {
          dirty = true;
          saveBtn.disabled = false;
          saveBtn.classList.add('dirty');
        });
        setTimeout(function () { if (cm && cm.refresh) cm.refresh(); }, 60);
      }).catch(function (e) {
        bodyEl.innerHTML = '<div class="art-loading">⚠ ' + esc(e.message) + '</div>';
      });

      saveBtn.addEventListener('click', function () {
        if (!cm || !dirty) return;
        saveBtn.textContent = 'saving…';
        api('/api/sessions/' + sessionId + '/artifacts/' + artifactId, 'PUT', {
          content: cm.getValue()
        }).then(function (m) {
          dirty = false;
          saveBtn.disabled = true;
          saveBtn.classList.remove('dirty');
          saveBtn.textContent = 'saved ✓';
          metaEl.textContent = FT.info(m.name).label + ' · ' + FT.humanBytes(m.size);
          setTimeout(function () { saveBtn.textContent = 'save'; }, 1500);
        }).catch(function (e) {
          saveBtn.textContent = 'save';
          toast(e.message);
        });
      });
    }).catch(function (e) {
      bodyEl.innerHTML = '<div class="art-loading">⚠ ' + esc(e.message) + '</div>';
    });
  }

  // ── Save an artifact extracted from a message (deduped by name+size) ──
  function saveFromMessage(sessionId, art, onSaved) {
    if (!sessionId || !art || !art.file) return Promise.resolve(null);
    return list(sessionId).then(function (items) {
      var size = art.encoding === 'base64'
        ? Math.floor(art.content.length * 3 / 4)
        : art.content.length;
      var dup = items.find(function (m) { return m.name === art.file && m.size === size; });
      if (dup) return dup; // already saved (replay-safe)
      return create(sessionId, art.file, art.content, art.encoding, 'model');
    }).then(function (m) {
      refreshPills();
      if (onSaved) onSaved(m);
      return m;
    });
  }

  // Save a bare code block (the code-card ⇩-file button) — derives a name.
  var codeCounter = {};
  function saveCodeBlock(sessionId, language, code) {
    if (!sessionId) return Promise.resolve(null);
    var extMap = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
      python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', go: 'go',
      rust: 'rs', rs: 'rs', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs',
      ruby: 'rb', php: 'php', lua: 'lua', sql: 'sql', json: 'json',
      yaml: 'yml', html: 'html', css: 'css', markup: 'html', docker: 'dockerfile',
      powershell: 'ps1', diff: 'diff', markdown: 'md', jsx: 'jsx', tsx: 'tsx' };
    var lang = String(language || '').toLowerCase();
    var ext = extMap[lang] || 'txt';
    codeCounter[ext] = (codeCounter[ext] || 0) + 1;
    var name = 'snippet-' + codeCounter[ext] + '.' + ext;
    return create(sessionId, name, code, 'utf8', 'user').then(function (m) {
      refreshPills();
      return m;
    });
  }

  // pill badge refresher registration (chatpanel registers per-chat)
  function onRefresh(fn) { refreshHooks.push(fn); }

  function setSession(sessionId, chat) {
    currentSession = sessionId;
    currentChat = chat || null;
  }

  window.Artifacts = {
    openDrawer: openDrawer,
    openEditor: openEditor,
    saveFromMessage: saveFromMessage,
    saveCodeBlock: saveCodeBlock,
    list: list,
    onRefresh: onRefresh,
    setSession: setSession,
    toast: toast,
    ensureScript: ensureScript,
    ensureCSS: ensureCSS
  };
})();
