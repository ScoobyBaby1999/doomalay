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
  var liveCM = null;      // v0.18: the open editor's CodeMirror (resize hook)
  var liveEditor = null;  // v0.18: { isDirty, guard } of the open editor (back-close)

  // v0.18: split-screen / rotation — a resized WebView leaves CodeMirror
  // rendering at stale metrics (garbled or clipped lines). One global
  // listener refreshes whichever editor is open.
  window.addEventListener('resize', function () {
    if (liveCM && liveCM.refresh) { try { liveCM.refresh(); } catch (e) {} }
  });

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
    liveCM = null;    // drop the resize hook with the editor
    liveEditor = null; // and the back-close guard
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

  // v0.18: the Android BACK gesture. Returns:
  //   false   — nothing open (caller falls through)
  //   'blocked' — the editor has unsaved changes: the in-DOM discard
  //              banner is up (back is consumed; closing would lose edits)
  //   'closed' — the overlay is gone
  function backClose() {
    if (!overlayEl || overlayEl.style.display === 'none') return false;
    if (liveEditor) {
      if (liveEditor.isDirty()) { liveEditor.guard('close'); return 'blocked'; }
    }
    closeOverlay();
    return 'closed';
  }

  // ── THE DRAWER ──────────────────────────────────────────────────
  function openDrawer(sessionId, chat) {
    if (!sessionId) return;
    liveCM = null; // drawer replaces the editor — drop its resize hook
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

  // v0.18 — NO window.confirm / window.prompt ANYWHERE in this file.
  // Android WebView silently returns false/null for both (no
  // WebChromeClient) — every exit from the editor was a dead tap after
  // an edit (the "couldn't X the panel, had to close the app" bug).
  // Everything is in-DOM now:
  //   confirmBtn — swaps a button for an inline yes/no chip

  function confirmBtn(btn, label, cb) {
    var holder = document.createElement('span');
    holder.className = 'art-confirm';
    holder.innerHTML = '<span class="art-confirm-label">' + esc(label) + '</span>' +
      '<button class="art-confirm-yes">yes</button><button class="art-confirm-no">no</button>';
    btn.replaceWith(holder);
    // the chip is WIDER than the button it replaces — in horizontally
    // scrolling strips (.art-ed-actions) it would land half off-screen;
    // center it so the yes/no buttons are actually tappable.
    if (holder.scrollIntoView) {
      try { holder.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }
    var settled = false;
    var settle = function (v) {
      if (settled) return;
      settled = true;
      if (!v) holder.replaceWith(btn); // put the ORIGINAL button back
      cb(v);
    };
    holder.querySelector('.art-confirm-yes').addEventListener('click', function (e) {
      e.stopPropagation(); settle(true);
    });
    holder.querySelector('.art-confirm-no').addEventListener('click', function (e) {
      e.stopPropagation(); settle(false);
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
  // v0.18: every destructive/exit action is IN-DOM (no window.confirm /
  // window.prompt — the Android WebView kills native dialogs silently,
  // which dead-ended every ✕ / ‹ / delete / rename after an edit).
  // ── v0.23: COMPLEX-FILE VIEWERS (docx · xlsx · archives) ────────
  //
  // User spec: "our editor currently cannot view complex files like word
  // dox or zip files contents — if we can, let's have it be able to view
  // these files and contents of zips." The engine parses (GET .../preview,
  // .../entry, POST .../extract), this side renders. Read-only — editing
  // stays for text artifacts; download stays one tap away.
  function renderViewer(bodyEl, sessionId, artifactId, d, info) {
    bodyEl.innerHTML = '<div class="art-loading">parsing…</div>';
    api('/api/sessions/' + sessionId + '/artifacts/' + artifactId + '/preview')
      .then(function (pv) {
        if (!bodyEl.isConnected) return;
        if (pv.kind === 'docx') renderDocxView(bodyEl, pv);
        else if (pv.kind === 'xlsx') renderXlsxView(bodyEl, pv);
        else if (pv.kind === 'archive') renderArchiveView(bodyEl, sessionId, artifactId, pv, d);
        else if (pv.kind === 'text') renderTextView(bodyEl, sessionId, d, pv.text || '');
        else renderBinaryFallback(bodyEl, d, info);
      })
      .catch(function (e) {
        bodyEl.innerHTML = '<div class="art-binary"><div class="art-binary-name">could not parse</div>' +
          '<div class="art-binary-sub">' + esc(e.message) + '</div></div>';
      });
  }

  function renderBinaryFallback(bodyEl, d, info) {
    bodyEl.innerHTML =
      '<div class="art-binary">' +
        '<span style="font-size:34px">' + (info ? info.icon : '📄') + '</span>' +
        '<div class="art-binary-name">' + esc(d.name) + '</div>' +
        '<div class="art-binary-sub">' + esc((info && info.label) || 'binary file') + ' · ' + FT.humanBytes(d.size) + '</div>' +
      '</div>';
  }

  // docx: styled document view (title/heading/quote/list paragraphs, runs
  // with bold/italic/underline/strike/color/size/font — everything the
  // docx_create tool can build).
  function renderDocxView(bodyEl, pv) {
    var html = '<div class="vw-doc">';
    var blocks = pv.blocks || [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var cls = 'vw-p';
      if (b.type === 'title') cls = 'vw-title';
      else if (b.type === 'heading') cls = 'vw-h1';
      else if (b.type === 'subheading') cls = 'vw-h2';
      else if (b.type === 'quote') cls = 'vw-quote';
      else if (b.type === 'bullet') cls = 'vw-li vw-li-bullet';
      else if (b.type === 'number') cls = 'vw-li vw-li-num';
      var align = b.align === 'center' || b.align === 'right' ? ' style="text-align:' + b.align + '"' : '';
      var inner = '';
      if (b.runs && b.runs.length) {
        for (var j = 0; j < b.runs.length; j++) inner += runHTML(b.runs[j]);
      } else {
        inner = esc(b.text || '');
      }
      html += '<div class="' + cls + '"' + align + '>' + inner + '</div>';
    }
    html += '</div>';
    bodyEl.innerHTML = html;
  }

  function runHTML(r) {
    var st = '';
    if (r.font) st += 'font-family:' + esc(r.font.replace(/"/g, '')) + ';';
    if (r.size) st += 'font-size:' + Math.max(8, Math.round(r.size / 2)) + 'pt;';
    if (r.color) st += 'color:#' + esc(r.color.replace(/[^0-9a-fA-F]/g, '')) + ';';
    if (r.italic) st += 'font-style:italic;';
    var deco = '';
    if (r.underline) deco += ' underline';
    if (r.strike) deco += ' line-through';
    if (deco) st += 'text-decoration:' + deco.trim() + ';';
    return '<span' + (st ? ' style="' + st + '"' : '') + (r.bold ? ' class="vw-b"' : '') + '>' + esc(r.text || '') + '</span>';
  }

  // xlsx: sheet tabs + table (first row bold, numbers right-aligned).
  function renderXlsxView(bodyEl, pv) {
    var sheets = pv.sheets || [];
    if (!sheets.length) { renderBinaryFallback(bodyEl, pv, null); return; }
    var html = '<div class="vw-xlsx"><div class="vw-sheets">';
    for (var s = 0; s < sheets.length; s++) {
      html += '<button class="vw-tab" data-vw-sheet="' + s + '"' + (s === 0 ? ' data-on="1"' : '') + '>' + esc(sheets[s].name || ('Sheet ' + (s + 1))) + '</button>';
    }
    html += '</div><div class="vw-sheet-body" id="vw-sheet-body"></div></div>';
    bodyEl.innerHTML = html;

    var show = function (idx) {
      var rows = sheets[idx].rows || [];
      var t = '<table class="vw-table"><tbody>';
      for (var r = 0; r < rows.length; r++) {
        t += '<tr>';
        for (var c = 0; c < rows[r].length; c++) {
          var v = String(rows[r][c] == null ? '' : rows[r][c]);
          var numeric = v !== '' && !isNaN(Number(v)) && /^[\d.,\-+%eE]+$/.test(v);
          t += '<td' + (r === 0 ? ' class="vw-th"' : '') + (numeric ? ' class="vw-num"' : '') + '>' + esc(v) + '</td>';
        }
        t += '</tr>';
      }
      t += '</tbody></table>';
      if (!rows.length) t = '<div class="art-loading">empty sheet</div>';
      bodyEl.querySelector('#vw-sheet-body').innerHTML = t;
      var tabs = bodyEl.querySelectorAll('.vw-tab');
      for (var k = 0; k < tabs.length; k++) {
        if (tabs[k].getAttribute('data-vw-sheet') === String(idx)) tabs[k].setAttribute('data-on', '1');
        else tabs[k].removeAttribute('data-on');
      }
    };
    show(0);
    Array.prototype.forEach.call(bodyEl.querySelectorAll('.vw-tab'), function (tab) {
      tab.addEventListener('click', function () {
        show(parseInt(tab.getAttribute('data-vw-sheet'), 10) || 0);
      });
    });
  }

  // archives: member browser — tap a text member to view it inline (the
  // "view contents of zips" ask), extract-all unpacks every member into
  // this chat's artifact drawer.
  function renderArchiveView(bodyEl, sessionId, artifactId, pv, d) {
    var entries = (pv.entries || []).filter(function (e) { return !e.dir; });
    var html = '<div class="vw-arch"><div class="vw-arch-head">' +
      '<span class="vw-arch-fmt">' + esc(pv.format || 'archive') + '</span>' +
      '<span class="vw-arch-n">' + entries.length + ' file' + (entries.length === 1 ? '' : 's') + '</span>' +
      '<button class="art-ed-btn" id="vw-extract-all">⇩ extract all</button>' +
      '</div><div class="vw-arch-list">';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var mi = FT.info(e.name || '');
      html += '<div class="vw-arch-row" data-vw-member="' + escAttr2(e.name) + '">' +
        '<span class="vw-arch-ico" style="color:' + (mi.color || '#71717a') + '">' + (mi.icon || '📄') + '</span>' +
        '<span class="vw-arch-name">' + esc(e.name) + '</span>' +
        '<span class="vw-arch-size">' + FT.humanBytes(e.size || 0) + '</span>' +
        '</div>';
    }
    html += '</div><div class="vw-arch-member" id="vw-member" style="display:none"></div></div>';
    bodyEl.innerHTML = html;

    Array.prototype.forEach.call(bodyEl.querySelectorAll('.vw-arch-row'), function (row) {
      row.addEventListener('click', function () {
        var name = row.getAttribute('data-vw-member');
        var host = bodyEl.querySelector('#vw-member');
        host.style.display = 'block';
        host.innerHTML = '<div class="art-loading">reading ' + esc(name) + '…</div>';
        api('/api/sessions/' + sessionId + '/artifacts/' + artifactId + '/entry?name=' + encodeURIComponent(name))
          .then(function (en) {
            if (!host.isConnected) return;
            if (en.binary) {
              host.innerHTML = '<div class="vw-member-note">📦 ' + esc(en.name) + ' · binary member (' + FT.humanBytes(en.size || 0) + ') — extract it to use it</div>';
              return;
            }
            var mode = FT.cmMode(en.name);
            var pre = '<div class="vw-member-title">' + esc(en.name) + (en.truncated ? ' · truncated' : '') + '</div>';
            if (mode) {
              pre += '<pre class="vw-member-pre"></pre>';
              host.innerHTML = pre;
              host.querySelector('.vw-member-pre').textContent = en.text || '';
              // best-effort syntax color via the Formatter's prism if loaded
              if (window.Formatter && window.Formatter.highlight) {
                try { host.querySelector('.vw-member-pre').innerHTML = window.Formatter.highlight(en.text || '', FT.prismLang(en.name)); } catch (err) {}
              }
            } else {
              pre += '<pre class="vw-member-pre"></pre>';
              host.innerHTML = pre;
              host.querySelector('.vw-member-pre').textContent = en.text || '';
            }
          })
          .catch(function (err) {
            host.innerHTML = '<div class="vw-member-note">could not read member: ' + esc(err.message) + '</div>';
          });
      });
    });

    bodyEl.querySelector('#vw-extract-all').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'extracting…';
      api('/api/sessions/' + sessionId + '/artifacts/' + artifactId + '/extract', 'POST')
        .then(function (res) {
          btn.textContent = '✓ ' + (res.extracted || 0) + ' extracted';
          toast((res.extracted || 0) + ' files extracted to artifacts');
          refreshPills();
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = '⇩ extract all';
          toast(err.message);
        });
    });
  }

  // read-only text view (preview fallback for text-ish files)
  function renderTextView(bodyEl, sessionId, d, text) {
    var host = document.createElement('pre');
    host.className = 'vw-member-pre vw-text-full';
    host.textContent = text;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(host);
  }

  function escAttr2(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

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
        // v0.18: unsaved-changes banner (replaces window.confirm)
        '<div class="art-unsaved" id="ed-unsaved">' +
          '<span class="art-unsaved-text">unsaved changes</span>' +
          '<button class="art-unsaved-discard" id="ed-unsaved-discard">discard</button>' +
          '<button class="art-unsaved-stay" id="ed-unsaved-stay">keep editing</button>' +
        '</div>' +
      '</div>';
    var root = openOverlay(html);

    var dirty = false;
    var cm = null;
    var data = null;
    var pendingExit = null;        // 'close' | 'back' — what discard should do
    var saveBtn = root.querySelector('#ed-save');
    var nameEl = root.querySelector('#ed-name');
    var metaEl = root.querySelector('#ed-meta');
    var bodyEl = root.querySelector('#ed-body');
    var unsavedEl = root.querySelector('#ed-unsaved');

    function hideUnsaved() {
      pendingExit = null;
      if (unsavedEl) unsavedEl.classList.remove('show');
    }
    // In-DOM unsaved-changes guard. Returns false (blocks the exit) and
    // pops the discard banner when there are unsaved edits.
    function guardFor(intent) {
      if (!dirty) return true;
      pendingExit = intent;
      if (unsavedEl) unsavedEl.classList.add('show');
      return false;
    }
    function runPendingExit() {
      var intent = pendingExit;
      hideUnsaved();
      dirty = false;
      if (intent === 'back') openDrawer(sessionId, currentChat);
      else closeOverlay();
    }

    wireClose(root, function () { return guardFor('close'); });
    root.querySelector('.art-back').addEventListener('click', function () {
      if (isGhostTap()) return; // ghost of the row-tap that opened the editor
      if (guardFor('back')) openDrawer(sessionId, currentChat);
    });
    liveEditor = { isDirty: function () { return dirty; }, guard: guardFor };
    if (unsavedEl) {
      unsavedEl.querySelector('#ed-unsaved-stay').addEventListener('click', hideUnsaved);
      unsavedEl.querySelector('#ed-unsaved-discard').addEventListener('click', function (e) {
        e.stopPropagation(); runPendingExit();
      });
    }

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
        // v0.18: in-DOM confirm chip (window.confirm is dead on Android).
        // "no" restores the original button — unsaved edits stay intact.
        confirmBtn(this, 'delete?', function (yes) {
          if (!yes) return;
          api('/api/sessions/' + sessionId + '/artifacts/' + artifactId, 'DELETE')
            .then(function () { openDrawer(sessionId, currentChat); refreshPills(); })
            .catch(function (e) { toast(e.message); });
        });
      });
      root.querySelector('#ed-rename').addEventListener('click', function () {
        // v0.18: INLINE rename (window.prompt is dead on Android) — the
        // header title becomes an input; Enter commits, Esc reverts.
        if (root.querySelector('#ed-rename-input')) return;
        var span = root.querySelector('#ed-name');
        if (!span) return;
        var oldName = d.name;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = oldName;
        input.id = 'ed-rename-input';
        input.className = 'art-rename-input';
        span.replaceWith(input);
        input.focus();
        input.setSelectionRange(oldName.length, oldName.length);
        var done = false;
        var restore = function (finalName) {
          if (done) return;
          done = true;
          var s = document.createElement('span');
          s.className = 'art-title'; s.id = 'ed-name';
          s.textContent = finalName;
          input.replaceWith(s);
        };
        var commit = function () {
          var nn = input.value.trim();
          if (!nn || nn === oldName) { restore(oldName); return; }
          api('/api/sessions/' + sessionId + '/artifacts/' + artifactId, 'PUT', { name: nn })
            .then(function (m) {
              d.name = m.name;
              data.name = m.name;
              restore(m.name);
              var i2 = FT.info(m.name);
              metaEl.textContent = i2.label + ' · ' + FT.humanBytes(m.size);
              toast('renamed');
            })
            .catch(function (e) { restore(oldName); toast(e.message); });
        };
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { restore(oldName); }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', function (ev) { ev.stopPropagation(); });
      });

      // v0.23: complex files get REAL viewers — docx renders as a styled
      // document, xlsx as sheet tables, archives as a member browser with
      // extract. Only the truly opaque stay download-only.
      if (info.viewer) {
        renderViewer(bodyEl, sessionId, artifactId, d, info);
        return;
      }
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
          hideUnsaved();
          saveBtn.disabled = false;
          saveBtn.classList.add('dirty');
        });
        liveCM = cm;
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
          hideUnsaved();
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
    closeOverlay: closeOverlay,   // v0.18: the Android back gesture uses this
    backClose: backClose,        // v0.18: dirty-aware back (banner, not data loss)
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
