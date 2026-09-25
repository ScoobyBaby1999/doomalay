// hubrepo.js — v0.60 pt C.8: THE REPO VIEW.
//
// The artifacts-style tree of any PUBLIC dataset repo behind the hub —
// browsed from a bundle's [cards|repo] pill (the whole repo that publishes
// the bunch) and from an item's detail (its own repo). Folder rows expand
// lazily (one directory level per fetch); FILE rows that match a hub item's
// payload File open THAT item's card — the rest render a preview:
//   .md  → the markdown pipeline (Formatter)
//   .sh  → Prism bash (the hubitem script treatment)
//   .json→ pretty-printed JSON (Formatter)
//   images → <img> (the engine streams bytes with a content-type)
//   anything else → "binary · N bytes"
//
// Data: GET /api/hub/repo/{repo}/tree?path= (one level, {entries}) +
// GET /api/hub/repo/{repo}/file?path= ({text} | {binary,size} | raw bytes).
// The tree reuses the artifacts tree's DOM contract (.artt-* classes —
// its stylesheet is self-contained per module, so the rules are re-declared
// here with the same names).
//
// Exposes: window.HubRepo = { mount, openFile }
(function () {
  'use strict';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function PV() {
    var c = window.ChatPanel && window.ChatPanel.current();
    return (c && c.panel) || null;
  }

  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var e = new Error((d && d.error) || ('HTTP ' + r.status));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  function repoBase(repo) {
    return '/api/hub/repo/' + encodeURIComponent(repo);
  }

  // natural compare (the artifacts tree's rule: digit runs compare numerically)
  function naturalCompare(a, b) {
    var ax = [], bx = [];
    a = String(a); b = String(b);
    a.replace(/(\d+)|(\D+)/g, function (_, d, s) { ax.push([d ? 1 : 0, d || s]); return ''; });
    b.replace(/(\d+)|(\D+)/g, function (_, d, s) { bx.push([d ? 1 : 0, d || s]); return ''; });
    while (ax.length && bx.length) {
      var an = ax.shift(), bn = bx.shift();
      if (an[0] !== bn[0]) return an[0] - bn[0];
      if (an[1] !== bn[1]) return an[1] < bn[1] ? -1 : 1;
    }
    return ax.length - bx.length;
  }

  // ── self-contained tree styles (the artifacts .artt-* contract) ──────
  function ensureStyles() {
    if (document.getElementById('hubrepo-styles')) return;
    var s = document.createElement('style');
    s.id = 'hubrepo-styles';
    s.textContent =
      '.artt{--artt-ind:18px;--artt-rail:rgba(var(--surface-3-rgb),0.7);font-size:var(--ui-fs)}' +
      '.artt-row{position:relative;display:flex;align-items:center;gap:6px;' +
        'min-height:44px;padding-right:6px;margin:1px 0;border-radius:10px;cursor:pointer;' +
        'padding-left:calc(8px + var(--d,0)*var(--artt-ind));' +
        'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.artt-row:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      '.artt-row::before{content:"";position:absolute;left:0;top:0;bottom:0;' +
        'width:calc(var(--d,0)*var(--artt-ind));pointer-events:none;' +
        'background-image:repeating-linear-gradient(to right,var(--artt-rail) 0 1px,transparent 1px var(--artt-ind));' +
        'background-position:8px 0}' +
      '.artt-chev{flex-shrink:0;width:18px;height:18px;position:relative;pointer-events:none}' +
      '.artt-row[data-kind="folder"] .artt-chev::after{content:"";position:absolute;left:6px;top:6px;' +
        'border-style:solid;border-width:4px 0 4px 5px;' +
        'border-color:transparent transparent transparent var(--text-3);' +
        'transition:transform 0.18s cubic-bezier(0.32,0.72,0,1)}' +
      '.artt-branch.open>.artt-row .artt-chev::after{transform:rotate(90deg)}' +
      '.artt-ico{flex-shrink:0;width:24px;text-align:center;font-size:15px;line-height:1}' +
      '.artt-ico-folder{font-size:16px}' +
      '.artt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--text-1);font-weight:500}' +
      '.artt-row[data-kind="folder"] .artt-name{font-weight:600}' +
      '.artt-size{flex-shrink:0;max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'text-align:right;color:var(--text-3);font-size:calc(var(--ui-small-fs) - 1px);' +
        'font-variant-numeric:tabular-nums}' +
      '.artt-kids{overflow:hidden;max-height:0;opacity:0}' +
      '.artt-branch.open>.artt-kids{opacity:1}' +
      '.artt-kids.artt-anim{transition:max-height 0.22s cubic-bezier(0.32,0.72,0,1),opacity 0.15s ease}' +
      '.artt-row[data-itemlink="1"] .artt-name{color:var(--hub-tone, var(--accent-2));font-weight:700}' +
      '.hubrepo-loading{padding:14px 16px;color:var(--text-3);font-size:var(--ui-small-fs)}';
    document.head.appendChild(s);
  }

  function humanBytes(n) {
    if (window.FT && window.FT.humanBytes) return window.FT.humanBytes(n);
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fileIcon(name) {
    var info = window.FT ? window.FT.info(name) : null;
    var glyph = (info && info.icon) || '📄';
    if (glyph === 'BIN') glyph = '▦';
    return glyph;
  }

  function setKidsOpen(branch, open) {
    var kids = branch.querySelector(':scope > .artt-kids');
    if (!kids) return;
    branch.classList.toggle('open', open);
    var row = branch.querySelector(':scope > .artt-row');
    if (row) {
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      var ico = row.querySelector('.artt-ico');
      if (ico) ico.textContent = open ? '📂' : '📁';
    }
    kids.setAttribute('aria-hidden', open ? 'false' : 'true');
    kids.style.maxHeight = open ? 'none' : '0px';
  }

  // ── the tree ────────────────────────────────────────────────────────
  // mount(container, repo, opts {itemsByPath, onOpenItem}) builds a lazily
  // loading directory tree: root fetches immediately; each folder fetches
  // its level on first expand. itemsByPath maps "items/<id>.<ext>" (or any
  // payload path) → the hub item — those file rows open the item's CARD.
  function mount(container, repo, opts) {
    if (!container) return;
    ensureStyles();
    opts = opts || {};
    var itemsByPath = opts.itemsByPath || {};

    var root = document.createElement('div');
    root.className = 'artt';
    container.innerHTML = '';
    container.appendChild(root);

    function fetchDir(path) {
      return api('GET', repoBase(repo) + '/tree?path=' + encodeURIComponent(path || '/'))
        .then(function (d) { return (d && d.entries) || []; });
    }

    function sortEntries(entries) {
      var dirs = entries.filter(function (e) { return e.type !== 'file'; });
      var files = entries.filter(function (e) { return e.type === 'file'; });
      var byName = function (a, b) { return naturalCompare(a.path, b.path); };
      return dirs.sort(byName).concat(files.sort(byName));
    }

    function buildDir(parentEl, path, depth) {
      var loading = document.createElement('div');
      loading.className = 'hubrepo-loading';
      loading.textContent = 'loading ' + (path === '/' ? 'the repo' : path) + '…';
      parentEl.appendChild(loading);
      fetchDir(path).then(function (entries) {
        loading.remove();
        sortEntries(entries).forEach(function (e) {
          if (e.type !== 'file') {
            parentEl.appendChild(buildFolder(e, depth));
          } else {
            parentEl.appendChild(buildFile(e, depth));
          }
        });
        if (!entries.length) {
          var empty = document.createElement('div');
          empty.className = 'hubrepo-loading';
          empty.textContent = '(empty)';
          parentEl.appendChild(empty);
        }
      }).catch(function (err) {
        loading.textContent = (err && err.message) || 'the listing failed';
      });
    }

    function buildFolder(entry, depth) {
      var branch = document.createElement('div');
      branch.className = 'artt-branch';
      branch.setAttribute('data-path', entry.path);
      var row = document.createElement('div');
      row.className = 'artt-row';
      row.setAttribute('data-kind', 'folder');
      row.setAttribute('aria-expanded', 'false');
      row.style.setProperty('--d', depth);
      row.title = entry.path;
      row.innerHTML =
        '<span class="artt-chev"></span>' +
        '<span class="artt-ico artt-ico-folder">📁</span>' +
        '<span class="artt-name"></span>' +
        '<span class="artt-size">…</span>';
      var seg = entry.path.split('/').filter(Boolean).pop() || entry.path;
      row.querySelector('.artt-name').textContent = seg;
      row.querySelector('.artt-size').textContent = '';
      branch.appendChild(row);
      var kids = document.createElement('div');
      kids.className = 'artt-kids';
      kids.setAttribute('aria-hidden', 'true');
      branch.appendChild(kids);
      var loaded = false;
      row.addEventListener('click', function () {
        var open = !branch.classList.contains('open');
        setKidsOpen(branch, open);
        if (open && !loaded) {
          loaded = true;
          buildDir(kids, entry.path, depth + 1);
        }
      });
      return branch;
    }

    function buildFile(entry, depth) {
      var row = document.createElement('div');
      row.className = 'artt-row';
      row.setAttribute('data-kind', 'file');
      row.style.setProperty('--d', depth);
      var seg = entry.path.split('/').filter(Boolean).pop() || entry.path;
      var item = itemsByPath[entry.path];
      if (item) row.setAttribute('data-itemlink', '1');
      row.title = entry.path + (item ? ' — opens the ' + (item.type || '') + ' card' : '');
      row.innerHTML =
        '<span class="artt-chev"></span>' +
        '<span class="artt-ico">' + esc(fileIcon(seg)) + '</span>' +
        '<span class="artt-name"></span>' +
        '<span class="artt-size"></span>';
      row.querySelector('.artt-name').textContent = seg;
      row.querySelector('.artt-size').textContent = humanBytes(entry.size || 0);
      row.addEventListener('click', function () {
        if (item && opts.onOpenItem) { opts.onOpenItem(item); return; }
        openFile(repo, entry.path);
      });
      return row;
    }

    buildDir(root, '/', 0);
  }

  // ── the file preview (a pushed view) ─────────────────────────────────
  function view(title, renderHTML, wire, onClose) {
    return {
      title: title,
      render: function () { return renderHTML(); },
      onMount: function (el) { if (wire) wire(el); },
      onClose: onClose || null
    };
  }

  function openFile(repo, path) {
    var panel = PV();
    if (!panel) return;
    var seg = path.split('/').filter(Boolean).pop() || path;
    var state = { loading: true, err: '', text: '', binary: 0, imgURL: '' };
    var v = view('repo · ' + seg, function () { return renderFile(state, repo, path); },
      function (el) { wireFile(el, state, repo, path); }, null);
    panel.pushView(v);

    var ext = (seg.indexOf('.') >= 0 ? seg.slice(seg.lastIndexOf('.')).toLowerCase() : '');
    var isImg = /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(seg);
    if (isImg) {
      state.imgURL = repoBase(repo) + '/file?path=' + encodeURIComponent(path);
      state.loading = false;
      panel.replaceView(v, { keepScroll: true });
      return;
    }
    api('GET', repoBase(repo) + '/file?path=' + encodeURIComponent(path))
      .then(function (d) {
        state.loading = false;
        if (d && d.binary) {
          state.binary = d.size || 0;
        } else {
          state.text = String((d && d.text) != null ? d.text : '');
        }
        panel.replaceView(v, { keepScroll: true });
      })
      .catch(function (e) {
        state.loading = false;
        state.err = (e && e.message) || 'the file could not be reached';
        panel.replaceView(v, { keepScroll: true });
      });
  }

  function renderFile(state, repo, path) {
    var seg = path.split('/').filter(Boolean).pop() || path;
    var head =
      '<div class="hubrepo-file-head">' +
        '<span class="hubrepo-file-path">' + esc(path) + '</span>' +
        '<span class="hubrepo-file-repo">' + esc(repo) + '</span>' +
      '</div>';
    if (state.loading) return head + '<div class="hubrepo-loading">loading the file…</div>';
    if (state.err) return head + '<div class="hub-empty">' + esc(state.err) + '</div>';
    if (state.binary) {
      return head + '<div class="hub-empty">binary file · ' + humanBytes(state.binary) + '</div>';
    }
    if (state.imgURL) {
      return head + '<div class="hubrepo-imgwrap"><img src="' + escAttr(state.imgURL) + '" alt="' +
        escAttr(seg) + '" /></div>';
    }
    return head + '<div class="hubrepo-file-body" id="hubrepo-file-body"></div>';
  }

  function wireFile(el, state, repo, path) {
    if (state.loading || state.err || state.binary || state.imgURL) return;
    var body = el.querySelector('#hubrepo-file-body');
    if (!body) return;
    var seg = path.split('/').filter(Boolean).pop() || path;
    var text = state.text || '';
    var F = window.Formatter;
    if (/\.md$/i.test(seg)) {
      try { F.renderInto(body, text, { mode: 'full' }); return; } catch (e) {}
      body.textContent = text;
      return;
    }
    if (/\.(sh|bash|zsh)$/i.test(seg)) {
      var slang = /^#!.*python/.test(text) ? 'python' : 'bash';
      try { F.renderInto(body, '```' + slang + '\n' + text + '\n```', { mode: 'full' }); return; } catch (e) {}
      body.textContent = text;
      return;
    }
    if (/\.json$/i.test(seg)) {
      var pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      try { F.renderInto(body, '```json\n' + pretty + '\n```', { mode: 'full' }); return; } catch (e) {}
      body.textContent = pretty;
      return;
    }
    var ext = (seg.indexOf('.') >= 0 ? seg.slice(seg.lastIndexOf('.') + 1).toLowerCase() : '');
    var lang = { js: 'javascript', ts: 'typescript', py: 'python', css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', csv: 'csv', xml: 'xml' }[ext];
    if (lang) {
      try { F.renderInto(body, '```' + lang + '\n' + text + '\n```', { mode: 'full' }); return; } catch (e) {}
    }
    body.textContent = text;
  }

  window.HubRepo = { mount: mount, openFile: openFile };
})();
