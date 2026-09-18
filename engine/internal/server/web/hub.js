// hub.js — v0.31 THE HUB: the modular library panel.
//
// USER SPEC (Batch 9): one library per item type (personas, templates,
// future: icons, models, skills…), registry-driven — the TABS come from
// GET /api/hub/libraries, so a new engine library appears here with
// ZERO web changes. The panel rides the master panel's view stack
// (panel.js pushView — back bar + ✕ for free, Android back for free):
//
//   ┌ tabs (one per registered library type)
//   ├ search (200ms debounce, the model-browser pattern)
//   ├ sort pills — recent / downloads / endorsed / relevant
//   ├ tag pills (built from the tags present in the CURRENT results)
//   ├ grid size steppers — cols 1–5 × rows 3–10, persisted to
//   │ localStorage doomalay.hubgrid.v1 (default 2×5)
//   └ THE GRID — repeat(var(--hub-cols), minmax(0,1fr)), clamped by
//     the viewport so columns never drop under ~150px; items per page
//     = cols × rows with prev/next paging.
//
// ITEM CARDS: background = the item's gradient design, its PNG
// (probed; fades 100→0 alpha into the card surface), or a deterministic
// client-side gradient hashed from the item id. Name / description /
// author / ♥ endorsements / ⤓ downloads — every text sized from
// --ui-fs / --ui-small-fs so the settings' size sliders resize it all.
//
// Data: GET /api/hub/{type}/items?q=&sort=&tag= (&refresh=1 after a
// publish). Errors surface as toasts (the persona.js pattern).
//
// Exposes: window.Hub = { open, markStale, refreshItem, isDownloaded,
//                         markDownloaded, setHearted }
(function () {
  'use strict';

  var GRID_KEY = 'doomalay.hubgrid.v1';
  var SORTS = [
    { key: 'recent',    label: 'recent' },
    { key: 'downloads', label: 'downloads' },
    { key: 'hearts',    label: 'endorsed' },
    { key: 'relevant',  label: 'relevant' }
  ];

  // The served Item carries no local-state flags — the web tracks what
  // THIS session downloaded / hearted so the item detail can enable the
  // endorse button (the engine enforces "download before endorse" with
  // a 400 either way).
  var downloaded = {}; // "type|repo|id" → true
  var hearted = {};    // "type|repo|id" → true

  var cur = null;      // the open hub view's state

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function stateKey(type, repo, id) { return type + '|' + repo + '|' + id; }

  function PV() {
    var c = window.ChatPanel && window.ChatPanel.current();
    return (c && c.panel) || null;
  }

  // view() — persona.js's helper plus the onClose hook the hub needs
  // (it owns a window-resize listener while open).
  function view(title, renderHTML, wire, onClose) {
    return {
      title: title,
      render: function () { return renderHTML(); },
      onMount: function (el) { if (wire) wire(el); },
      onClose: onClose || null
    };
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('hub-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hub-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
        'border-radius:10px;font-size:var(--ui-small-fs);z-index:3450;opacity:0;transition:opacity 0.2s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1900);
  }

  // fetch wrapper — rejects with Error(message) + .status, so callers
  // can branch (401 → the connect flow).
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

  // ── the deterministic id-gradient ────────────────────────────────
  // No design on the item → a client-side gradient hashed from the
  // item id, so the same card looks the same everywhere. Fixed S/L
  // bands (60–80% / 45–65%) keep text readable on both themes.
  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }
  function hsl(h, s, l) { return 'hsl(' + (h % 360) + ', ' + s + '%, ' + l + '%)'; }
  function idGradient(id) {
    var h = hashStr(String(id || ''));
    var h1 = Math.abs(h) % 360;
    var h2 = (h1 + 40 + (Math.abs(h >> 8) % 80)) % 360;
    var s1 = 60 + Math.abs(h >> 4) % 21;
    var l1 = 45 + Math.abs(h >> 12) % 21;
    return 'linear-gradient(135deg, ' + hsl(h1, s1, l1) + ', ' + hsl(h2, s1, l1 + 8) + ')';
  }

  // ── grid prefs (cols 1–5 × rows 3–10, default 2×5) ───────────────
  function readGrid() {
    try {
      var g = JSON.parse(localStorage.getItem(GRID_KEY));
      if (g && typeof g.cols === 'number' && typeof g.rows === 'number' &&
          g.cols >= 1 && g.cols <= 5 && g.rows >= 3 && g.rows <= 10) {
        return { cols: g.cols | 0, rows: g.rows | 0 };
      }
    } catch (e) {}
    return { cols: 2, rows: 5 };
  }
  function saveGrid(g) { try { localStorage.setItem(GRID_KEY, JSON.stringify(g)); } catch (e) {} }

  // viewport clamp: never fewer than ~150px of column
  function clampCols(g, containerW) {
    var max = Math.max(1, Math.floor((containerW || 320) / 150));
    return Math.max(1, Math.min(g.cols, max));
  }

  // ── data ─────────────────────────────────────────────────────────
  function fetchLibraries() {
    return api('GET', '/api/hub/libraries').then(function (d) {
      if (!cur) return;
      cur.libraries = (d && d.libraries) || [];
      // repaint ONLY when the hub view is still the one on top — a view
      // stacked over it (item detail, publish) owns the body meanwhile,
      // and the hub re-renders from live state when it next shows.
      if (isTop()) cur.panel.replaceView(buildView());
    }).catch(function (e) {
      if (!cur) return;
      cur.libErr = e.message || 'libraries unavailable';
      if (isTop()) cur.panel.replaceView(buildView());
    });
  }

  function loadAuth() {
    return api('GET', '/api/hub/auth/status').then(function (d) {
      if (!cur) return;
      cur.auth = d || {};
      if (isTop()) cur.panel.replaceView(buildView());
    }).catch(function () {});
  }

  function loadItems(refresh) {
    if (!cur || !cur.type) return;
    var seq = cur.seq = (cur.seq || 0) + 1;
    cur.loading = true;
    var qs = [];
    if (cur.q) qs.push('q=' + encodeURIComponent(cur.q));
    qs.push('sort=' + encodeURIComponent(cur.sort));
    if (cur.tag) qs.push('tag=' + encodeURIComponent(cur.tag));
    if (refresh) qs.push('refresh=1');
    api('GET', '/api/hub/' + encodeURIComponent(cur.type) + '/items?' + qs.join('&'))
      .then(function (d) {
        if (!cur || cur.seq !== seq) return;
        cur.loading = false;
        cur.items = (d && d.items) || [];
        cur.err = '';
        cur.page = 1;
        cur.stale = false;
        cur.tags = collectTags(cur.items);
        if (isTop()) cur.panel.replaceView(buildView());
      })
      .catch(function (e) {
        if (!cur || cur.seq !== seq) return;
        cur.loading = false;
        cur.items = [];
        cur.err = e.message || 'the library could not be reached';
        cur.page = 1;
        if (isTop()) { toast(cur.err); cur.panel.replaceView(buildView()); }
      });
  }

  function collectTags(items) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      (it.tags || []).forEach(function (t) {
        if (t && !seen[t]) { seen[t] = true; out.push(t); }
      });
    });
    return out.sort();
  }

  // ── rendering ────────────────────────────────────────────────────
  // isTop(): is the hub view the one currently shown? Async callbacks
  // (search debounce, tab switches, the post-publish refresh) may resolve
  // AFTER another view was stacked over the hub — replacing then would
  // clobber the user's current view, so they update the state and leave
  // the repaint to the hub's next render.
  function isTop() {
    return !!(cur && cur.panel && cur.viewObj &&
      typeof cur.panel.topView === 'function' && cur.panel.topView() === cur.viewObj);
  }

  function shortLabel(lib) {
    return String(lib.label || lib.type || '').replace(/\s*library\s*$/i, '');
  }

  function buildView() {
    var v = view('hub', function () { return renderHTML(); },
      function (el) { wire(el); },
      function () { onClosed(); });
    if (cur) cur.viewObj = v; // isTop()'s identity check
    return v;
  }

  function renderHTML() {
    if (!cur) return '';
    var c = cur;
    var tabs = '';
    c.libraries.forEach(function (lib) {
      tabs += '<button class="hub-tab" data-tab="' + escAttr(lib.type) + '"' +
        (lib.type === c.type ? ' data-on="1"' : '') + ' title="' + escAttr(lib.desc || '') + '">' +
        esc(shortLabel(lib)) + '</button>';
    });
    if (!tabs) tabs = '<span class="hub-tab hub-tab-ghost">' + esc(c.libErr || 'no libraries registered') + '</span>';

    var sorts = '';
    SORTS.forEach(function (s) {
      sorts += '<button class="hub-pill" data-sort="' + escAttr(s.key) + '"' +
        (s.key === c.sort ? ' data-on="1"' : '') + '>' + esc(s.label) + '</button>';
    });

    var tagpills = '';
    c.tags.forEach(function (t) {
      tagpills += '<button class="hub-pill" data-tag="' + escAttr(t) + '"' +
        (t === c.tag ? ' data-on="1"' : '') + '>#' + esc(t) + '</button>';
    });

    var eff = clampCols(c.grid, c.width);
    var per = eff * c.grid.rows;
    var items = c.items || [];
    var pages = Math.max(1, Math.ceil(items.length / per));
    var page = Math.min(Math.max(1, c.page), pages);
    var slice = items.slice((page - 1) * per, page * per);

    var status = (c.auth && c.auth.connected)
      ? '<div class="hub-status">HF: connected as <b>' + esc(c.auth.username || '?') + '</b>' +
        '<button data-disconnect="1" title="disconnect the Hugging Face token">disconnect</button></div>'
      : '';

    var body = '';
    if (c.loading) {
      body = '<div class="art-loading">loading the library…</div>';
    } else if (!items.length) {
      body = '<div class="hub-empty">' +
        (c.err ? esc(c.err) :
          'nothing here' + (c.q ? ' for “' + esc(c.q) + '”' : '') +
          ' — try another search, another tag, or publish something below') +
        '</div>';
    } else {
      body =
        '<div class="hub-grid" id="hub-grid" style="--hub-cols:' + eff + '">' +
          slice.map(cardHTML).join('') +
        '</div>' +
        '<div class="hub-pager">' +
          '<button class="hub-nav" data-page="prev"' + (page <= 1 ? ' disabled' : '') + ' aria-label="previous page">‹</button>' +
          '<span class="hub-page-line">page ' + page + '/' + pages + '</span>' +
          '<button class="hub-nav" data-page="next"' + (page >= pages ? ' disabled' : '') + ' aria-label="next page">›</button>' +
        '</div>';
    }

    return (
      '<div class="hub-root">' +
        status +
        '<div class="hub-tabs">' + tabs + '</div>' +
        '<input id="hub-search" class="hub-search" type="text" inputmode="search"' +
          ' placeholder="search name, description, tags…" value="' + escAttr(c.q) + '" aria-label="search the library">' +
        '<div class="hub-pillrow">' + sorts + '</div>' +
        (tagpills ? '<div class="hub-pillrow">' + tagpills + '</div>' : '') +
        '<div class="hub-ctlrow">' +
          stepper('cols', c.grid.cols, 1, 5) +
          stepper('rows', c.grid.rows, 3, 10) +
          '<button class="hub-publish" id="hub-publish">＋ publish</button>' +
        '</div>' +
        body +
      '</div>'
    );
  }

  function stepper(kind, val, lo, hi) {
    return '<span class="hub-ctl">' + esc(kind) +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':-1"' + (val <= lo ? ' disabled' : '') +
        ' aria-label="fewer ' + esc(kind) + '">−</button>' +
      '<span class="hub-step-val" id="hub-' + escAttr(kind) + '-val">' + val + '</span>' +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':1"' + (val >= hi ? ' disabled' : '') +
        ' aria-label="more ' + escAttr(kind) + '">＋</button>' +
    '</span>';
  }

  function cardHTML(it) {
    var sub = it.description ||
      (it.tags || []).map(function (t) { return '#' + t; }).join(' ') ||
      '—';
    return (
      '<button class="hub-card" data-item="' + escAttr(it.id) + '">' +
        '<span class="hub-card-bg" data-bgcard="1"></span>' +
        '<span class="hub-card-body">' +
          '<span class="hub-card-name">' + esc(it.name) + '</span>' +
          '<span class="hub-card-desc">' + esc(sub) + '</span>' +
          '<span class="hub-card-author">by ' + esc(it.author || 'unknown') + '</span>' +
          '<span class="hub-card-foot">' +
            '<span>♥ ' + (it.hearts || 0) + '</span>' +
            '<span>⤓ ' + (it.downloads || 0) + '</span>' +
          '</span>' +
        '</span>' +
      '</button>'
    );
  }

  // The card's background layer: design gradient → PNG (probed, fading
  // 100→0 alpha into the card surface) → deterministic id gradient.
  function paintCardBg(bgEl, it) {
    var d = it.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 2) {
      bgEl.style.backgroundImage = 'linear-gradient(135deg, ' + d.colors.join(', ') + ')';
      return;
    }
    if (d.kind === 'png') {
      var url = '/api/hub/' + encodeURIComponent(it.type) + '/png/' +
        encodeURIComponent(it.repo) + '/' + encodeURIComponent(it.id);
      var probe = new Image();
      probe.onload = function () {
        // the fade mask paints OVER the image (first layer on top)
        bgEl.style.backgroundImage =
          'linear-gradient(to top, var(--surface-1) 0%, transparent 55%), url("' + url + '")';
      };
      probe.onerror = function () { bgEl.style.backgroundImage = idGradient(it.id); };
      probe.src = url;
      return;
    }
    bgEl.style.backgroundImage = idGradient(it.id);
  }

  // ── wiring ───────────────────────────────────────────────────────
  function wire(el) {
    if (!cur) return;
    var c = cur;

    // measure now that the view is in the DOM — re-render when the
    // viewport clamp disagrees with what the render assumed.
    var gridEl = el.querySelector('#hub-grid');
    c.width = (gridEl && gridEl.clientWidth) || el.clientWidth || 320;
    var renderedEff = gridEl ? (gridEl.style.getPropertyValue('--hub-cols') | 0) : 0;
    if (gridEl && renderedEff !== clampCols(c.grid, c.width)) {
      c.panel.replaceView(buildView());
      return; // the fresh view re-wires itself
    }

    // search (200ms debounce — the model-browser pattern). The re-render
    // rebuilds the input, so a search mid-typing refocuses it (caret at
    // the end) — without this the mobile keyboard would close after the
    // first debounce fired.
    var searchTimer = null;
    var searchInput = el.querySelector('#hub-search');
    if (searchInput) {
      if (c.typing) {
        searchInput.focus();
        try { searchInput.setSelectionRange(9999, 9999); } catch (e) {}
      }
      searchInput.addEventListener('focus', function () { c.typing = true; });
      searchInput.addEventListener('blur', function () { c.typing = false; });
      searchInput.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          if (!cur) return;
          cur.q = searchInput.value;
          loadItems();
        }, 200);
      });
    }

    // library tabs — switching reloads the items for that type
    el.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.getAttribute('data-on') === '1') return;
        cur.type = b.getAttribute('data-tab');
        cur.items = null;
        cur.tag = '';
        cur.q = '';
        cur.page = 1;
        loadItems();
      });
    });

    // sort pills
    el.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        cur.sort = b.getAttribute('data-sort');
        loadItems();
      });
    });

    // tag pills (tap toggles)
    el.querySelectorAll('[data-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var t = b.getAttribute('data-tag');
        cur.tag = (cur.tag === t) ? '' : t;
        loadItems();
      });
    });

    // grid steppers
    el.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var parts = b.getAttribute('data-step').split(':');
        var kind = parts[0], dir = parseInt(parts[1], 10) || 0;
        if (kind === 'cols') cur.grid.cols = Math.max(1, Math.min(5, cur.grid.cols + dir));
        else cur.grid.rows = Math.max(3, Math.min(10, cur.grid.rows + dir));
        saveGrid(cur.grid);
        cur.page = 1;
        cur.panel.replaceView(buildView());
      });
    });

    // pager
    el.querySelectorAll('[data-page]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.disabled) return;
        cur.page += (b.getAttribute('data-page') === 'next') ? 1 : -1;
        cur.page = Math.max(1, cur.page);
        cur.panel.replaceView(buildView());
      });
    });

    // publish
    var pub = el.querySelector('#hub-publish');
    if (pub) pub.addEventListener('click', function () {
      if (window.HubPublish && cur) window.HubPublish.open(cur.type);
      else toast('the publisher is not available');
    });

    // disconnect
    var dc = el.querySelector('[data-disconnect]');
    if (dc) dc.addEventListener('click', function () {
      api('POST', '/api/hub/auth/disconnect').then(function () {
        toast('disconnected from Hugging Face');
        if (cur) { cur.auth = null; loadAuth(); }
      }).catch(function (e) { toast(e.message || 'could not disconnect'); });
    });

    // cards → item detail
    var items = c.items || [];
    el.querySelectorAll('[data-item]').forEach(function (b) {
      var id = b.getAttribute('data-item');
      var it = null;
      for (var i = 0; i < items.length; i++) if (items[i].id === id) { it = items[i]; break; }
      if (!it) return;
      b.addEventListener('click', function () {
        if (window.HubItem) window.HubItem.open(cur.type, it);
      });
      var bg = b.querySelector('[data-bgcard]');
      if (bg) paintCardBg(bg, it);
    });

    // the resize clamp — only while this view is open
    if (!c._onResize) {
      var t = null;
      c._onResize = function () {
        if (!cur || !cur.panel) return;
        if (t) clearTimeout(t);
        t = setTimeout(function () {
          if (!cur) return;
          var g = cur.panel.bodyEl && cur.panel.bodyEl.querySelector('#hub-grid');
          var w = (g && g.clientWidth) || (cur.panel.bodyEl && cur.panel.bodyEl.clientWidth) || 320;
          cur.width = w;
          var eff = clampCols(cur.grid, w);
          var rendered = g ? (g.style.getPropertyValue('--hub-cols') | 0) : eff;
          if (g && rendered !== eff) cur.panel.replaceView(buildView());
        }, 120);
      };
      window.addEventListener('resize', c._onResize);
    }

    // first load / stale refresh (loadAuth repaints itself, guarded)
    if (!c.items || c.stale) loadItems(!!c.stale);
    if (!c.auth) loadAuth();
  }

  function onClosed() {
    if (cur && cur._onResize) {
      window.removeEventListener('resize', cur._onResize);
      cur._onResize = null;
    }
    cur = null;
  }

  // ── entry ────────────────────────────────────────────────────────
  function open(type) {
    var panel = PV();
    if (!panel) { toast('open a chat first'); return; }
    cur = {
      panel: panel,
      libraries: [],
      libErr: '',
      type: type || null,
      items: null,
      tags: [],
      q: '',
      sort: 'recent',
      tag: '',
      page: 1,
      grid: readGrid(),
      loading: false,
      stale: false,
      err: '',
      auth: null,
      width: 0,
      _onResize: null
    };
    panel.pushView(buildView());
    fetchLibraries().then(function () {
      if (!cur) return;
      if (!cur.type && cur.libraries.length) cur.type = cur.libraries[0].type;
      if (isTop()) cur.panel.replaceView(buildView());
    });
  }

  // ── cross-module state (hubitem / hubpublish call these) ─────────
  function markDownloaded(type, repo, id) { downloaded[stateKey(type, repo, id)] = true; }
  function isDownloaded(type, repo, id) { return !!downloaded[stateKey(type, repo, id)]; }
  function setHearted(type, repo, id, on) {
    if (on) hearted[stateKey(type, repo, id)] = true;
    else delete hearted[stateKey(type, repo, id)];
  }
  function isHearted(type, repo, id) { return !!hearted[stateKey(type, repo, id)]; }

  // force the next render of {type}'s list to refetch (after publish) +
  // re-read the auth state (the connect flow may have just changed it).
  function markStale(type) {
    if (cur && (!type || cur.type === type)) { cur.stale = true; cur.auth = null; }
  }

  // update the in-place copy so back-navigation shows fresh counters
  function refreshItem(item) {
    if (!cur || !cur.items || !item) return;
    for (var i = 0; i < cur.items.length; i++) {
      if (cur.items[i].id === item.id) { cur.items[i] = item; break; }
    }
  }

  window.Hub = {
    open: open,
    markStale: markStale,
    refreshItem: refreshItem,
    isDownloaded: isDownloaded,
    markDownloaded: markDownloaded,
    setHearted: setHearted,
    isHearted: isHearted,
    toast: toast,
    idGradient: idGradient
  };
})();
