// artifacts.js — v0.42 the ARTIFACTS DRAWER + TEXT EDITOR.
//
// v0.42 REBUILD (user item #3): the drawer's file browser is now a
// CUSTOM mobile-first tree renderer. The vendored wunderbaum library
// (v0.29) is RETIRED for the browser view — its skin was, per the
// user, "severely lacking in visual clarity: nested files don't
// indent, the icons look weird, we can't collapse nested folders.
// Functionally good, visually very bad." The hand-rolled tree (see
// THE DRAWER below) indents every nesting level 18px with rail
// hairlines, gives every file its FileTypes icon + color, collapses
// folders with a smooth animated slide, sorts folders-first in
// natural order, and adds expand-all / collapse-all controls. The
// vendor files stay on disk untouched — the drawer just never loads
// them anymore.
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
//   Drawer  — full-screen overlay, CUSTOM tree (v0.42): one row per
//             folder/file, [chevron] [icon] name [size] [⋯], ≥44px
//             rows, per-level indentation, collapsible folders with
//             persisted expand state, long-press or ⋯ for the action
//             sheet (rename / download / delete), tap row → editor.
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

  // ── THE DRAWER (v0.42: a CUSTOM file tree — wunderbaum retired) ──
  // User spec history: v0.29 asked for "nested files and an actual
  // tree… root folders not indented, sub files and folders indented…
  // collapsible." wunderbaum rendered it but never looked right on
  // mobile (see the v0.42 header note). This is a hand-rolled tree:
  //
  //   • INDENTATION — every nesting level indents 18px (padding-left
  //     per row via a --d depth var), with subtle rail hairlines
  //     (repeating-linear-gradient) aligned to each level's chevron
  //     column, VS-Code-style.
  //   • FOLDERS — the row itself toggles; a CSS-triangle chevron
  //     rotates ▸→▾ and children slide open/closed via an animated
  //     max-height (0 → measured → 'none' once settled, so nested
  //     expansion never clips). Open/closed state persists for the
  //     drawer session (treeExpandState, keyed by folder path — the
  //     same "src/lib/" keys v0.29 used).
  //   • FILE ICONS — FileTypes' per-extension icon + color.
  //   • ROWS — [chevron] [icon] name [size] [⋯], ≥44px tall, theme
  //     vars (--surface-*/--text-*/--border) so light+dark both work.
  //   • ACTIONS — every capability stays reachable: tap a file →
  //     open/preview (editor, incl. the zip/docx/xlsx viewers), ⋯ or
  //     long-press (the msgactions pattern) → the action sheet
  //     (rename / download / delete).
  //   • ZIP — archives stay file rows; tapping one opens the editor's
  //     archive member browser (preview/entry/extract), unchanged.
  //   • SORT — folders first, then files, both natural order
  //     (numeric-aware: file2 < file10).
  //   • TOP BAR — title/close/count + expand-all/collapse-all.
  //   • SCALE — plain DOM (chats rarely exceed dozens of artifacts);
  //     only >500-node trees skip the height animation (a 100k-row
  //     max-height transition janks) and start fully collapsed.
  var treeExpandState = {}; // sessionId → { "path/": true } expanded folder keys

  function openDrawer(sessionId, chat) {
    if (!sessionId) return;
    liveCM = null; // drawer replaces the editor — drop its resize hook
    currentSession = sessionId;
    currentChat = chat || null;

    var html =
      '<div class="art-scrim"></div>' +
      '<div class="art-panel">' +
        '<div class="art-head">' +
          '<span class="art-title">🌳 artifacts' +
            (chat && chat.name ? ' · ' + esc(chat.name) : '') + '</span>' +
          '<span class="art-count" id="art-count"></span>' +
          // v0.42: tree-wide expand/collapse micro-controls (wired once
          // the tree exists — renderTree owns them)
          '<button class="art-tree-ctl" id="art-expand-all" aria-label="Expand all folders" title="expand all">▸▸</button>' +
          '<button class="art-tree-ctl" id="art-collapse-all" aria-label="Collapse all folders" title="collapse all">▾▾</button>' +
          '<button class="art-close">✕</button>' +
        '</div>' +
        '<div class="art-body" id="art-list" style="overflow-y:auto;overscroll-behavior:contain;padding:6px 6px 2px">' +
          '<div class="art-loading">loading…</div>' +
        '</div>' +
      '</div>';
    var root = openOverlay(html);
    wireClose(root, null);

    var listEl = root.querySelector('#art-list');
    list(sessionId).then(function (items) {
      if (!root.isConnected || currentSession !== sessionId) return;
      renderTree(listEl, items, sessionId);
      // v0.44: the CLOUD WORKSPACES section — bound repos appear as lazy
      // trees under the local artifacts (never downloaded; rows fetch on
      // demand from the forge via the engine).
      if (window.Workspace && window.Workspace.renderCloudSection) {
        try { window.Workspace.renderCloudSection(listEl, sessionId); } catch (e) {}
      }
    }).catch(function (e) {
      listEl.style.overflow = 'auto';
      listEl.style.padding = '12px 14px';
      listEl.innerHTML = '<div class="art-loading">⚠ ' + esc(e.message) + '</div>';
    });
    refreshPills();
  }

  // -- natural sort (numeric-aware, case-insensitive) ----------------
  // localeCompare with {numeric:true} gives "file2" < "file10" on every
  // Chromium WebView we ship; the fallback covers exotic locales.
  function naturalCompare(a, b) {
    try { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
    catch (e) {
      var x = String(a).toLowerCase(), y = String(b).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }

  // -- tree model from flat artifact paths ---------------------------
  function buildTreeModel(items) {
    var root = { folders: new Map(), files: [] };
    items.forEach(function (m) {
      var name = String(m.name || '').replace(/\\/g, '/').replace(/^\.?\//, '');
      var parts = name.split('/').filter(function (p) { return p.length > 0; });
      if (!parts.length) return;
      if (parts.length === 1) { root.files.push({ seg: parts[0], meta: m }); return; }
      var dir = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var seg = parts[i];
        if (!dir.folders.has(seg)) dir.folders.set(seg, { folders: new Map(), files: [] });
        dir = dir.folders.get(seg);
      }
      dir.files.push({ seg: parts[parts.length - 1], meta: m });
    });
    return root;
  }

  // recursive aggregates for the folder row: file count + summed size
  function folderStats(node) {
    var count = 0, size = 0;
    (function walk(n) {
      n.files.forEach(function (f) { count++; size += f.meta.size || 0; });
      n.folders.forEach(function (child) { walk(child); });
    })(node);
    return { count: count, size: size };
  }

  // -- self-contained tree styles (injected once, modelbrowser-style) -
  function ensureArtTreeStyles() {
    if (document.getElementById('art-v42-styles')) return;
    var s = document.createElement('style');
    s.id = 'art-v42-styles';
    s.textContent =
      /* rows: flat elements, indentation via --d-driven padding-left */
      '.artt{--artt-ind:18px;--artt-rail:rgba(var(--surface-3-rgb),0.7);font-size:var(--ui-fs)}' +
      '.artt-row{position:relative;display:flex;align-items:center;gap:6px;' +
        'min-height:44px;padding-right:6px;margin:1px 0;border-radius:10px;cursor:pointer;' +
        'padding-left:calc(8px + var(--d,0)*var(--artt-ind));' +
        'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;' +
        '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      '.artt-row:active{background:rgba(var(--accent-2-rgb),0.10)}' +
      /* indent guide rails: one hairline per nesting level, aligned
         with each level's chevron column (background-position 8px) */
      '.artt-row::before{content:"";position:absolute;left:0;top:0;bottom:0;' +
        'width:calc(var(--d,0)*var(--artt-ind));pointer-events:none;' +
        'background-image:repeating-linear-gradient(to right,var(--artt-rail) 0 1px,transparent 1px var(--artt-ind));' +
        'background-position:8px 0}' +
      /* chevron column: CSS triangle that rotates on open (folders) */
      '.artt-chev{flex-shrink:0;width:18px;height:18px;position:relative;pointer-events:none}' +
      '.artt-row[data-kind="folder"] .artt-chev::after{content:"";position:absolute;left:6px;top:6px;' +
        'border-style:solid;border-width:4px 0 4px 5px;' +
        'border-color:transparent transparent transparent var(--text-3);' +
        'transition:transform 0.18s cubic-bezier(0.32,0.72,0,1)}' +
      '.artt-branch.open>.artt-row .artt-chev::after{transform:rotate(90deg)}' +
      /* per-type file icon (FileTypes icon+color) + distinct folder icon */
      '.artt-ico{flex-shrink:0;width:24px;text-align:center;font-size:15px;line-height:1}' +
      '.artt-ico-folder{font-size:16px}' +
      '.artt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--text-1);font-weight:500}' +
      '.artt-row[data-kind="folder"] .artt-name{font-weight:600}' +
      '.artt-size{flex-shrink:0;max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'text-align:right;color:var(--text-3);font-size:calc(var(--ui-small-fs) - 1px);' +
        'font-variant-numeric:tabular-nums}' +
      /* the per-row ⋯ (actions) button */
      '.artt-more{flex-shrink:0;background:transparent;border:none;color:var(--text-3);' +
        'font-size:17px;font-weight:700;line-height:1;padding:8px 9px;margin-right:-6px;' +
        'border-radius:8px;cursor:pointer;font-family:inherit;touch-action:manipulation;' +
        '-webkit-tap-highlight-color:transparent}' +
      '.artt-more:active{background:var(--surface-2);color:var(--text-1)}' +
      /* children: hidden by default, animated max-height when opened */
      '.artt-kids{overflow:hidden;max-height:0;opacity:0}' +
      '.artt-branch.open>.artt-kids{opacity:1}' +
      '.artt-kids.artt-anim{transition:max-height 0.22s cubic-bezier(0.32,0.72,0,1),opacity 0.15s ease}' +
      /* the header's expand-all / collapse-all micro-controls */
      '.art-tree-ctl{flex-shrink:0;display:flex;align-items:center;justify-content:center;' +
        'background:transparent;border:1px solid var(--surface-3);color:var(--text-3);' +
        'border-radius:7px;font-size:11px;line-height:1;letter-spacing:-1.5px;padding:6px 7px;' +
        'cursor:pointer;font-family:inherit;touch-action:manipulation;' +
        '-webkit-tap-highlight-color:transparent}' +
      '.art-tree-ctl:active{background:var(--surface-2);color:var(--text-1)}';
    document.head.appendChild(s);
  }

  // -- open/close a folder branch -----------------------------------
  // animate: true → 0 → measured px → 'none' (so later nested expansion
  // never clips); false → instant (build-time restore + bulk ops + huge
  // trees where the transition would jank).
  function setKidsOpen(branch, open, animate) {
    var kids = branch.querySelector(':scope > .artt-kids');
    if (!kids) return;
    branch.classList.toggle('open', open);
    var row = branch.querySelector(':scope > .artt-row');
    if (row) {
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      var ico = row.querySelector('.artt-ico');
      if (ico) ico.textContent = open ? '📂' : '📁'; // open/closed folder glyph
    }
    if (kids._capT) { clearTimeout(kids._capT); kids._capT = null; }
    kids.setAttribute('aria-hidden', open ? 'false' : 'true'); // collapsed = hidden from AT
    if (!animate) {
      kids.classList.remove('artt-anim');
      kids.style.maxHeight = open ? 'none' : '0px';
      return;
    }
    kids.classList.add('artt-anim');
    if (open) {
      kids.style.maxHeight = kids.scrollHeight + 'px';
      kids._capT = setTimeout(function () {
        kids._capT = null;
        if (branch.classList.contains('open')) kids.style.maxHeight = 'none';
      }, 240);
    } else {
      // 'none' isn't animatable — pin the real height first, reflow,
      // then slide to 0
      if (!kids.style.maxHeight || kids.style.maxHeight === 'none') {
        kids.style.maxHeight = kids.scrollHeight + 'px';
        void kids.offsetHeight;
      }
      kids.style.maxHeight = '0px';
    }
  }

  // -- DOM builders --------------------------------------------------
  // A folder = .artt-branch [ .artt-row + .artt-kids [ nested branches +
  // file rows ] ]. File rows are plain .artt-row siblings inside .artt-kids
  // (or the tree root) — indentation is per-row padding, so the DOM stays
  // shallow and rows never wrap weirdly.
  function buildFolderBranch(seg, node, path, depth, expandedSet) {
    var stats = folderStats(node);
    var branch = document.createElement('div');
    branch.className = 'artt-branch';
    branch.setAttribute('data-path', path);

    var row = document.createElement('div');
    row.className = 'artt-row';
    row.setAttribute('data-kind', 'folder');
    row.setAttribute('aria-expanded', 'false');
    row.style.setProperty('--d', depth);
    row.title = path + ' — ' + stats.count + ' file' + (stats.count === 1 ? '' : 's') +
      ' · ' + FT.humanBytes(stats.size);
    row.innerHTML =
      '<span class="artt-chev"></span>' +
      '<span class="artt-ico artt-ico-folder">📁</span>' +
      '<span class="artt-name"></span>' +
      '<span class="artt-size"></span>';
    row.querySelector('.artt-name').textContent = seg;
    row.querySelector('.artt-size').textContent =
      stats.count + ' file' + (stats.count === 1 ? '' : 's');
    branch.appendChild(row);

    var kids = document.createElement('div');
    kids.className = 'artt-kids';
    branch.appendChild(kids);

    // children: folders first, then files, both natural-sorted
    var names = Array.from(node.folders.keys()).sort(naturalCompare);
    for (var i = 0; i < names.length; i++) {
      kids.appendChild(buildFolderBranch(names[i], node.folders.get(names[i]),
        path + names[i] + '/', depth + 1, expandedSet));
    }
    var files = node.files.slice().sort(function (a, b) { return naturalCompare(a.seg, b.seg); });
    for (var j = 0; j < files.length; j++) {
      kids.appendChild(buildFileRow(files[j], depth + 1));
    }

    // restore persisted expansion at build time (instant — the slide is
    // for user toggles, not the initial paint)
    if (expandedSet[path]) setKidsOpen(branch, true, false);
    else kids.setAttribute('aria-hidden', 'true'); // closed by default → hidden from AT
    return branch;
  }

  function buildFileRow(f, depth) {
    var meta = f.meta;
    var info = FT.info(meta.name || f.seg);
    var glyph = info.icon || '📄';
    if (glyph === 'BIN') glyph = '▦'; // the registry's only text glyph — swap for a shape
    var row = document.createElement('div');
    row.className = 'artt-row';
    row.setAttribute('data-kind', 'file');
    row.setAttribute('data-aid', meta.id);
    row.style.setProperty('--d', depth);
    row.title = (meta.name || f.seg) + ' · ' + info.label + ' · ' +
      FT.humanBytes(meta.size) + (meta.updated_at ? ' · ' + fmtDate(meta.updated_at) : '');
    row.innerHTML =
      '<span class="artt-chev"></span>' + // spacer: icons align with folders
      '<span class="artt-ico"></span>' +
      '<span class="artt-name"></span>' +
      '<span class="artt-size"></span>' +
      '<button class="artt-more" aria-label="file actions">⋯</button>';
    var icoEl = row.querySelector('.artt-ico');
    icoEl.textContent = glyph;
    icoEl.style.color = info.color || 'var(--text-2)';
    row.querySelector('.artt-name').textContent = f.seg;
    row.querySelector('.artt-size').textContent = FT.humanBytes(meta.size);
    return row;
  }

  // -- mount the tree ------------------------------------------------
  function renderTree(listEl, items, sessionId) {
    var cEl = document.getElementById('art-count');
    if (cEl) cEl.textContent = items.length ? items.length + ' file' + (items.length > 1 ? 's' : '') : '';

    if (!items.length) {
      listEl.style.overflow = 'auto';
      listEl.style.padding = '12px 14px';
      listEl.innerHTML =
        '<div class="art-empty">No artifacts yet.</div>' +
        '<div class="art-empty-sub">Ask the bot for a file — "write me a markdown report", "give me the data as JSON" — it lands here.</div>';
      return;
    }

    ensureArtTreeStyles();
    var panelEl = listEl.closest('.art-panel');

    var model = buildTreeModel(items);

    // expansion memory: root folders expanded for small trees, everything
    // collapsed once it gets big (a monorepo must not flash-open rows).
    var expandedSet = treeExpandState[sessionId];
    if (!expandedSet) {
      expandedSet = {};
      if (items.length <= 120) {
        model.folders.forEach(function (_v, k) { expandedSet[k + '/'] = true; });
      }
      treeExpandState[sessionId] = expandedSet;
    }

    // scale guard: plain DOM is fine for chats (dozens of artifacts);
    // >500 nodes → instant toggles only (huge max-height transitions jank)
    var nodeCount = 0;
    (function walk(n) {
      nodeCount += n.files.length;
      n.folders.forEach(function (c) { nodeCount++; walk(c); });
    })(model);
    var big = nodeCount > 500;

    listEl.innerHTML = '';
    var tree = document.createElement('div');
    tree.className = 'art-tree artt';
    tree.setAttribute('role', 'tree');
    tree.style.cssText = 'padding:2px 2px 12px';
    listEl.appendChild(tree);

    var byId = {};
    items.forEach(function (m) { byId[m.id] = m; });

    // root level: folders first, then loose files, both natural-sorted
    var folderNames = Array.from(model.folders.keys()).sort(naturalCompare);
    for (var i = 0; i < folderNames.length; i++) {
      tree.appendChild(buildFolderBranch(folderNames[i], model.folders.get(folderNames[i]),
        folderNames[i] + '/', 0, expandedSet));
    }
    var rootFiles = model.files.slice().sort(function (a, b) { return naturalCompare(a.seg, b.seg); });
    for (var j = 0; j < rootFiles.length; j++) {
      tree.appendChild(buildFileRow(rootFiles[j], 0));
    }

    function toggleBranch(branch) {
      var open = !branch.classList.contains('open');
      setKidsOpen(branch, open, !big);
      var path = branch.getAttribute('data-path');
      try {
        if (open) treeExpandState[sessionId][path] = true;
        else delete treeExpandState[sessionId][path];
      } catch (err) {}
    }

    // expand-all / collapse-all header controls (bulk = instant, never
    // a cascade of height animations)
    var expandBtn = panelEl ? panelEl.querySelector('#art-expand-all') : null;
    var collapseBtn = panelEl ? panelEl.querySelector('#art-collapse-all') : null;
    if (expandBtn) expandBtn.addEventListener('click', function () {
      var branches = tree.querySelectorAll('.artt-branch');
      for (var k = 0; k < branches.length; k++) setKidsOpen(branches[k], true, false);
      (function mark(n, prefix) {
        n.folders.forEach(function (child, name) {
          try { treeExpandState[sessionId][prefix + name + '/'] = true; } catch (err) {}
          mark(child, prefix + name + '/');
        });
      })(model, '');
    });
    if (collapseBtn) collapseBtn.addEventListener('click', function () {
      var branches = tree.querySelectorAll('.artt-branch');
      for (var k = 0; k < branches.length; k++) setKidsOpen(branches[k], false, false);
      try { treeExpandState[sessionId] = {}; } catch (err) {}
      expandedSet = treeExpandState[sessionId];
    });

    // ONE delegated click handler: ⋯ → action sheet; folder row →
    // toggle; file row → open/preview (the editor + its zip/docx/xlsx
    // viewers, all unchanged).
    var suppressClickUntil = 0;
    tree.addEventListener('click', function (ev) {
      if (performance.now() < suppressClickUntil) { ev.stopPropagation(); ev.preventDefault(); return; }
      var more = ev.target.closest ? ev.target.closest('.artt-more') : null;
      if (more) {
        ev.stopPropagation();
        var row = more.closest('.artt-row');
        var meta = row ? byId[row.getAttribute('data-aid')] : null;
        if (meta) openActionSheet(panelEl, sessionId, meta);
        return;
      }
      var row2 = ev.target.closest ? ev.target.closest('.artt-row') : null;
      if (!row2 || !row2.isConnected) return;
      if (row2.getAttribute('data-kind') === 'folder') {
        toggleBranch(row2.parentElement); // folder rows are direct kids of their branch
        return;
      }
      var aid = row2.getAttribute('data-aid');
      if (aid) openEditor(sessionId, aid);
    });

    // LONG-PRESS a file row → action sheet (the msgactions pattern:
    // 450ms touch / 675ms mouse, haptic, move cancels; the follow-up
    // synthetic click is suppressed so the editor never also opens).
    var LP_MS = 450;
    var lpTimer = null;
    var lpRow = null;
    var lpDocUp = function () { lpClear(); };
    function lpClear() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      lpRow = null;
      document.removeEventListener('mouseup', lpDocUp);
    }
    function lpStart(target, ms) {
      var row = target && target.closest ? target.closest('.artt-row[data-aid]') : null;
      if (!row || (target.closest && target.closest('button, input, a'))) return;
      lpRow = row;
      document.addEventListener('mouseup', lpDocUp);
      lpTimer = setTimeout(function () {
        lpTimer = null;
        var row2 = lpRow;
        lpRow = null;
        document.removeEventListener('mouseup', lpDocUp);
        if (!row2 || !row2.isConnected) return;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
        suppressClickUntil = performance.now() + 400; // kill the ghost tap
        var meta = byId[row2.getAttribute('data-aid')];
        if (meta) openActionSheet(panelEl, sessionId, meta);
      }, ms || LP_MS);
    }
    tree.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return lpClear();
      lpStart(e.touches[0].target, LP_MS);
    }, { passive: true });
    tree.addEventListener('touchmove', lpClear, { passive: true });
    tree.addEventListener('touchend', lpClear, { passive: true });
    tree.addEventListener('touchcancel', lpClear, { passive: true });
    // desktop: long mouse-hold (the agent-browser test path) — slower
    // than touch, same as msgactions (450 × 1.5 = 675ms)
    tree.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      lpStart(e.target, LP_MS * 1.5);
    });
    tree.addEventListener('mousemove', function () { if (lpTimer) lpClear(); });
  }

  // -- the ⋯ action sheet (rename / download / delete) ───────────────
  function openActionSheet(panelEl, sessionId, meta) {
    var old = panelEl.querySelector('.art-sheet');
    if (old) old.remove();
    var sheet = document.createElement('div');
    sheet.className = 'art-sheet';
    sheet._openedAt = performance.now(); // v0.42: long-press ghost-tap guard
    sheet.innerHTML =
      '<div class="art-sheet-name">' + esc(meta.name) + '</div>' +
      '<button class="art-sheet-btn" data-sheet="rename"><span class="art-sheet-ico">✎</span> rename</button>' +
      '<button class="art-sheet-btn" data-sheet="download"><span class="art-sheet-ico">⇩</span> download</button>' +
      '<button class="art-sheet-btn danger" data-sheet="delete"><span class="art-sheet-ico">🗑</span> delete</button>' +
      '<button class="art-sheet-btn art-sheet-cancel" data-sheet="cancel">cancel</button>';
    panelEl.appendChild(sheet);
    requestAnimationFrame(function () { sheet.classList.add('open'); });

    function close() {
      sheet.classList.remove('open');
      setTimeout(function () { sheet.remove(); }, 240);
    }
    function commitDelete(btn) {
      if (btn.dataset.armed) {
        api('/api/sessions/' + sessionId + '/artifacts/' + meta.id, 'DELETE')
          .then(function () { close(); openDrawer(sessionId, currentChat); refreshPills(); })
          .catch(function (err) { toast(err.message); });
        return;
      }
      btn.dataset.armed = '1';
      btn.innerHTML = '<span class="art-sheet-ico">🗑</span> delete forever?';
      setTimeout(function () {
        if (!btn.isConnected) return;
        delete btn.dataset.armed;
        btn.innerHTML = '<span class="art-sheet-ico">🗑</span> delete';
      }, 2600);
    }
    function beginRename() {
      var info = FT.info(meta.name);
      sheet.innerHTML =
        '<div class="art-sheet-name">rename — ' + esc(info.label) + '</div>' +
        '<input class="art-sheet-input" id="sheet-rename-input" value="' + escAttr2(meta.name) + '" autocapitalize="off" spellcheck="false">' +
        '<div style="display:flex;gap:8px">' +
          '<button class="art-sheet-btn" data-sheet="do-rename" style="flex:1;margin-bottom:0;justify-content:center">save</button>' +
          '<button class="art-sheet-btn art-sheet-cancel" data-sheet="cancel" style="flex:1;margin-bottom:0">cancel</button>' +
        '</div>';
      var input = sheet.querySelector('#sheet-rename-input');
      input.focus();
      input.setSelectionRange(meta.name.length, meta.name.length);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); sheet.querySelector('[data-sheet="do-rename"]').click(); }
        if (ev.key === 'Escape') close();
      });
      sheet.querySelector('[data-sheet="do-rename"]').addEventListener('click', function () {
        var nn = input.value.trim();
        if (!nn || nn === meta.name) { close(); return; }
        api('/api/sessions/' + sessionId + '/artifacts/' + meta.id, 'PUT', { name: nn })
          .then(function () { close(); openDrawer(sessionId, currentChat); })
          .catch(function (err) { toast(err.message); });
      });
      sheet.querySelector('[data-sheet="cancel"]').addEventListener('click', close);
    }

    sheet.addEventListener('click', function (ev) {
      // v0.42: opened by long-press → the release's synthetic click may
      // land on a sheet button; ignore clicks in the first 350ms.
      if (performance.now() - (sheet._openedAt || 0) < 350) return;
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-sheet]') : null;
      if (!b) return;
      var act = b.getAttribute('data-sheet');
      if (act === 'cancel') close();
      else if (act === 'rename') beginRename();
      else if (act === 'download') {
        window.open('/api/sessions/' + sessionId + '/artifacts/' + meta.id + '/download', '_blank');
      } else if (act === 'delete') commitDelete(b);
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
