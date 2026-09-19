// hub.js — v0.31→v0.33 THE PUBLIC LIBRARY (the modular hub panel).
//
// USER SPEC (Batch 10): "In the hub panel, let's rename it to Public
// Library, let's put everything that isn't the grid itself as the
// header, except the search bar, which we move under the header. As per
// usual, the header should be collapsible and expandable… the filters
// (recent, downloads, etc) should also be disclosed from the header and
// placed under the search bar… to the right of a new filter icon and
// filter by subtext… displayed in columns instead of pills like so
// Recent | Downloads | Endorsements… Above the persona and template
// pills, we should have a subtext description that says Browse the
// community for: the pills themselves should change to another style of
// pill, one that engulfs its entire row… they should have emojis or
// icons next to them as well, and when selected, the personas should be
// purplish and the templates should be greenish (depending on theme)."
//
// And the keyboard rule: "the search results update with every key
// without making the keyboard go down" — the view is rendered ONCE and
// every interaction (search / sort / tag / tab / steppers / paging)
// updates the DOM surgically (only the grid zone, or the filter states,
// or the library pills). The search input is NEVER re-rendered while
// the hub is on top, so focus — and the mobile keyboard — survive.
//
// The panel still rides the master panel's view stack (panel.js
// pushView — back bar + ✕ + Android back for free).
//
// Exposes: window.Hub = { open, markStale, refreshItem, isDownloaded,
//                         markDownloaded, setHearted, isHearted }
(function () {
  'use strict';

  var GRID_KEY = 'doomalay.hubgrid.v1';
  var SORTS = [
    { key: 'recent',    label: 'recent',       sub: 'newest updates first' },
    { key: 'downloads', label: 'downloads',    sub: 'most downloaded first' },
    { key: 'hearts',    label: 'endorsements', sub: 'most endorsed first' },
    { key: 'relevant',  label: 'relevant',     sub: 'the best matches first' }
  ];
  var SORT_SUB = {};
  SORTS.forEach(function (s) { SORT_SUB[s.key] = s.sub; });

  // the library pills' glyphs — future registry types fall back to 📚
  var LIB_ICONS = { persona: '🎭', template: '🧩' };
  function libIcon(type) { return LIB_ICONS[type] || '📚'; }

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
      var hadType = !!cur.type;
      if (!cur.type && cur.libraries.length) cur.type = cur.libraries[0].type;
      // repaint ONLY when the hub view is still the one on top — a view
      // stacked over it (item detail, publish) owns the body meanwhile.
      if (isTop()) {
        updateLibs();
        if (!hadType && cur.type) loadItems();
      }
    }).catch(function (e) {
      if (!cur) return;
      cur.libErr = e.message || 'libraries unavailable';
      if (isTop()) updateLibs();
    });
  }

  function loadAuth() {
    return api('GET', '/api/hub/auth/status').then(function (d) {
      if (!cur) return;
      cur.auth = d || {};
      if (isTop()) updateStatus();
    }).catch(function () {});
  }

  function loadItems(refresh) {
    if (!cur || !cur.type) return;
    var seq = cur.seq = (cur.seq || 0) + 1;
    cur.loading = true;
    if (isTop()) updateBody();     // the loading state paints immediately
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
        if (isTop()) { updateLibs(); updateTags(); updateBody(); }
      })
      .catch(function (e) {
        if (!cur || cur.seq !== seq) return;
        cur.loading = false;
        cur.items = [];
        cur.err = e.message || 'the library could not be reached';
        cur.page = 1;
        if (isTop()) { toast(cur.err); updateTags(); updateBody(); }
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
  // AFTER another view was stacked over the hub — updating then would
  // clobber the user's current view, so they no-op instead.
  function isTop() {
    return !!(cur && cur.panel && cur.viewObj &&
      typeof cur.panel.topView === 'function' && cur.panel.topView() === cur.viewObj);
  }

  // the live-DOM accessors — every update is SURGICAL (the search input
  // is never re-rendered, so the keyboard stays up while results stream)
  function q(sel) {
    return (cur && cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.querySelector(sel) : null;
  }
  function zone() { return q('#hub-bodyzone'); }

  function shortLabel(lib) {
    return String(lib.label || lib.type || '').replace(/\s*library\s*$/i, '');
  }

  function buildView() {
    var v = view('public library', function () { return renderHTML(); },
      function (el) { wire(el); },
      function () { onClosed(); });
    if (cur) cur.viewObj = v; // isTop()'s identity check
    return v;
  }

  function renderHTML() {
    if (!cur) return '';
    return (
      '<div class="hub-root">' +
        headHTML() +
        '<div class="hub-sticky">' +
          '<input id="hub-search" class="hub-search" type="text" inputmode="search"' +
            ' placeholder="search name, description, tags…" value="' + escAttr(cur.q) + '"' +
            ' aria-label="search the library">' +
          filtersHTML() +
        '</div>' +
        '<div class="hub-bodyzone" id="hub-bodyzone">' + bodyHTML() + '</div>' +
      '</div>'
    );
  }

  // the COLLAPSIBLE header — everything that isn't the grid (or the
  // search bar) lives here: title + HF status + "Browse the community
  // for:" + the full-row library pills + the grid steppers + publish +
  // the tag pills.
  function headHTML() {
    var c = cur;
    var status = '<span class="pub-status" id="pub-status">' + statusHTML() + '</span>';
    return (
      '<div class="pub-head' + (c.folded ? ' folded' : '') + '" id="pub-head">' +
        // a div, NOT a button: the bar carries the status's own disconnect
        // button — the HTML parser drops nested <button>s silently
        '<div class="pub-head-bar" id="pub-head-toggle" role="button" tabindex="0"' +
          ' aria-expanded="' + (!c.folded) + '">' +
          '<span class="pub-title">Public Library</span>' +
          status +
          '<span class="pub-chev" aria-hidden="true">' + (c.folded ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<div class="pub-head-body">' +
          '<div class="pub-sub">Browse the community for:</div>' +
          '<div class="hub-librow" id="hub-libs">' + libsHTML() + '</div>' +
          '<div class="hub-ctlrow">' +
            stepper('cols', c.grid.cols, 1, 5) +
            stepper('rows', c.grid.rows, 3, 10) +
            '<button class="hub-publish" id="hub-publish">＋ publish</button>' +
          '</div>' +
          '<div class="hub-pillrow" id="hub-tags">' + tagsHTML() + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function libsHTML() {
    var c = cur;
    var out = '';
    c.libraries.forEach(function (lib) {
      var active = lib.type === c.type;
      var label = shortLabel(lib) + 's';
      out += '<button type="button" class="hub-libpill" data-lib="' + escAttr(lib.type) + '"' +
        ' data-tone="' + escAttr(lib.type) + '"' +
        (active ? ' data-on="1"' : '') +
        ' title="' + escAttr(lib.desc || '') + '">' +
        '<span class="dx-pill-ico">' + libIcon(lib.type) + '</span>' +
        '<span class="dx-pill-label">' + esc(label) + '</span>' +
        (active && c.items && !c.loading && c.items.length
          ? '<span class="hub-libpill-count">' + c.items.length + '</span>' : '') +
        '</button>';
    });
    if (!out) {
      out = '<span class="hub-libpill hub-libpill-ghost">' +
        esc(c.libErr || 'no libraries registered') + '</span>';
    }
    return out;
  }

  function statusHTML() {
    var a = cur.auth;
    if (!a || !a.connected) return '';
    return 'HF: <b>' + esc(a.username || '?') + '</b>' +
      ' <button type="button" data-disconnect="1" title="disconnect the Hugging Face token">disconnect</button>';
  }

  function filtersHTML() {
    var c = cur;
    var cols = '';
    SORTS.forEach(function (s) {
      cols += '<button type="button" class="hub-fcol" data-sort="' + escAttr(s.key) + '"' +
        (s.key === c.sort ? ' data-on="1"' : '') + ' title="' + escAttr(s.sub) + '">' +
        esc(s.label) + '</button>';
    });
    return (
      '<div class="hub-filters">' +
        '<span class="hub-funnel" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>' +
        '</span>' +
        '<div class="hub-fcols" id="hub-fcols">' + cols + '</div>' +
      '</div>' +
      '<div class="hub-fsub" id="hub-fsub">' + esc(SORT_SUB[c.sort] || '') + '</div>'
    );
  }

  function tagsHTML() {
    var c = cur;
    var out = '';
    c.tags.forEach(function (t) {
      out += '<button type="button" class="dx-pill dx-pill--sm" data-tag="' + escAttr(t) + '"' +
        (t === c.tag ? ' data-on="1"' : '') + '>#' + esc(t) + '</button>';
    });
    return out;
  }

  function bodyHTML() {
    var c = cur;
    var eff = clampCols(c.grid, c.width);
    c.eff = eff;
    var per = eff * c.grid.rows;
    var items = c.items || [];
    var pages = Math.max(1, Math.ceil(items.length / per));
    var page = Math.min(Math.max(1, c.page), pages);
    c.page = page;

    if (c.loading && !c.items) return '<div class="art-loading">loading the library…</div>';
    if (!items.length) {
      return '<div class="hub-empty">' +
        (c.err ? esc(c.err) :
          'nothing here' + (c.q ? ' for “' + esc(c.q) + '”' : '') +
          ' — try another search, another tag, or publish something below') +
        '</div>';
    }
    return (
      '<div class="hub-grid" id="hub-grid" style="--hub-cols:' + eff + '">' +
          items.slice((page - 1) * per, page * per).map(cardHTML).join('') +
      '</div>' +
      '<div class="hub-pager">' +
        '<button class="hub-nav" data-page="prev"' + (page <= 1 ? ' disabled' : '') + ' aria-label="previous page">‹</button>' +
        '<span class="hub-page-line">page ' + page + '/' + pages + '</span>' +
        '<button class="hub-nav" data-page="next"' + (page >= pages ? ' disabled' : '') + ' aria-label="next page">›</button>' +
      '</div>'
    );
  }

  function stepper(kind, val, lo, hi) {
    return '<span class="hub-ctl">' + esc(kind) +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':-1"' + (val <= lo ? ' disabled' : '') +
        ' aria-label="fewer ' + esc(kind) + '">−</button>' +
      '<span class="hub-step-val" id="hub-' + escAttr(kind) + '-val">' + val + '</span>' +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':1"' + (val >= hi ? ' disabled' : '') +
        ' aria-label="more ' + esc(kind) + '">＋</button>' +
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

  // The card's background layer: design gradient (1–10 stops — one
  // stop renders solid) → PNG (probed, fading 100→0 alpha into the card
  // surface) → deterministic id gradient.
  function paintCardBg(bgEl, it) {
    var d = it.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      if (d.colors.length === 1) {
        bgEl.style.backgroundColor = d.colors[0]; // one stop = a solid
      } else {
        bgEl.style.backgroundImage = 'linear-gradient(135deg, ' + d.colors.join(', ') + ')';
      }
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

  // ── SURGICAL updates (the keyboard-safe replacement for replaceView) ──
  function updateLibs() {
    var el = q('#hub-libs');
    if (!el) return;
    el.innerHTML = libsHTML();
    wireLibs(el);
  }
  function updateTags() {
    var el = q('#hub-tags');
    if (!el) return;
    el.innerHTML = tagsHTML();
    wireTags(el);
  }
  function updateStatus() {
    var el = q('#pub-status');
    if (!el) return;
    el.innerHTML = statusHTML();
    var dc = el.querySelector('[data-disconnect]');
    if (dc) dc.addEventListener('click', function () {
      api('POST', '/api/hub/auth/disconnect').then(function () {
        toast('disconnected from Hugging Face');
        if (cur) { cur.auth = null; loadAuth(); }
      }).catch(function (e) { toast(e.message || 'could not disconnect'); });
    });
  }
  function updateFilters() {
    var c = cur;
    var cols = q('#hub-fcols');
    if (cols) {
      cols.querySelectorAll('[data-sort]').forEach(function (b) {
        if (b.getAttribute('data-sort') === c.sort) b.setAttribute('data-on', '1');
        else b.removeAttribute('data-on');
      });
    }
    var sub = q('#hub-fsub');
    if (sub) sub.textContent = SORT_SUB[c.sort] || '';
  }
  function updateBody() {
    var z = zone();
    if (!z) return;
    z.innerHTML = bodyHTML();
    wireBody(z);
  }

  // ── wiring ───────────────────────────────────────────────────────
  function wire(el) {
    if (!cur) return;
    var c = cur;

    // measure now that the view is in the DOM — the clamp may disagree
    // with what the render assumed; a surgical body update fixes it.
    var gridEl = el.querySelector('#hub-grid');
    c.width = (gridEl && gridEl.clientWidth) || el.clientWidth || 320;
    if (gridEl && (gridEl.style.getPropertyValue('--hub-cols') | 0) !== clampCols(c.grid, c.width)) {
      updateBody();
    }

    // the collapsible header — a class toggle, no re-render (the bar is
    // a div: the disconnect button inside forbids a nested <button>)
    var toggle = el.querySelector('#pub-head-toggle');
    if (toggle) {
      var fold = function () {
        var head = q('#pub-head');
        if (!head) return;
        c.folded = !c.folded;
        head.classList.toggle('folded', c.folded);
        var chev = head.querySelector('.pub-chev');
        if (chev) chev.textContent = c.folded ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!c.folded));
      };
      toggle.addEventListener('click', fold);
      toggle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold(); }
      });
    }

    // search (200ms debounce — the model-browser pattern). The input
    // is NEVER replaced: only the body zone re-renders, so focus and
    // the mobile keyboard survive every keystroke.
    var searchTimer = null;
    var searchInput = el.querySelector('#hub-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          if (!cur) return;
          cur.q = searchInput.value;
          loadItems();
        }, 200);
      });
    }

    // the filter columns (funnel row) — sort + subtext, surgical
    el.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        cur.sort = b.getAttribute('data-sort');
        updateFilters();
        loadItems();
      });
    });

    // library pills + tags + the body zone (cards / pager / publish /
    // steppers all live inside the zones these wire)
    wireLibs(el);
    wireTags(el);
    wireBody(el);

    var pub = el.querySelector('#hub-publish');
    if (pub) pub.addEventListener('click', function () {
      if (window.HubPublish && cur) window.HubPublish.open(cur.type);
      else toast('the publisher is not available');
    });

    // the resize clamp — only while this view is open
    if (!c._onResize) {
      var t = null;
      c._onResize = function () {
        if (!cur || !cur.panel) return;
        if (t) clearTimeout(t);
        t = setTimeout(function () {
          if (!cur) return;
          var g = zone() && zone().querySelector('#hub-grid');
          var w = (g && g.clientWidth) || (cur.panel.bodyEl && cur.panel.bodyEl.clientWidth) || 320;
          cur.width = w;
          if (g && (g.style.getPropertyValue('--hub-cols') | 0) !== clampCols(cur.grid, w)) {
            updateBody();
          }
        }, 120);
      };
      window.addEventListener('resize', c._onResize);
    }

    // first load / stale refresh (loadAuth repaints itself, guarded)
    if (!c.items || c.stale) loadItems(!!c.stale);
    if (!c.auth) loadAuth();
  }

  // library pills — switching reloads the items for that type
  function wireLibs(root) {
    (root || (cur && cur.panel ? cur.panel.bodyEl : document)).querySelectorAll('[data-lib]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.getAttribute('data-on') === '1') return;
        cur.type = b.getAttribute('data-lib');
        cur.items = null;
        cur.tag = '';
        cur.q = '';
        cur.page = 1;
        var si = q('#hub-search');
        if (si) si.value = '';
        updateLibs();
        updateTags();
        updateBody();
        loadItems();
      });
    });
  }

  // tag pills (tap toggles — inside the collapsible header)
  function wireTags(root) {
    (root || (cur && cur.panel ? cur.panel.bodyEl : document)).querySelectorAll('[data-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var t = b.getAttribute('data-tag');
        cur.tag = (cur.tag === t) ? '' : t;
        updateTags();
        loadItems();
      });
    });
  }

  // the body zone: cards → item detail, pager, steppers
  function wireBody(root) {
    if (!cur) return;
    var c = cur;
    var host = root || zone();
    if (!host) return;

    // grid steppers (surgical: the val spans + the button states + the
    // body zone — the header itself never re-renders)
    host.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var parts = b.getAttribute('data-step').split(':');
        var kind = parts[0], dir = parseInt(parts[1], 10) || 0;
        var lo = kind === 'cols' ? 1 : 3, hi = kind === 'cols' ? 5 : 10;
        if (kind === 'cols') cur.grid.cols = Math.max(lo, Math.min(hi, cur.grid.cols + dir));
        else cur.grid.rows = Math.max(lo, Math.min(hi, cur.grid.rows + dir));
        saveGrid(cur.grid);
        cur.page = 1;
        var cv = q('#hub-cols-val'), rv = q('#hub-rows-val');
        if (cv) cv.textContent = cur.grid.cols;
        if (rv) rv.textContent = cur.grid.rows;
        var ctl = b.closest('.hub-ctl');
        if (ctl) {
          var minus = ctl.querySelector('[data-step="' + kind + ':-1"]');
          var plus = ctl.querySelector('[data-step="' + kind + ':1"]');
          if (minus) minus.disabled = cur.grid[kind] <= lo;
          if (plus) plus.disabled = cur.grid[kind] >= hi;
        }
        updateBody();
      });
    });

    // pager
    host.querySelectorAll('[data-page]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.disabled) return;
        cur.page += (b.getAttribute('data-page') === 'next') ? 1 : -1;
        cur.page = Math.max(1, cur.page);
        updateBody();
      });
    });

    // cards → item detail
    var items = c.items || [];
    host.querySelectorAll('[data-item]').forEach(function (b) {
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
      folded: false,
      eff: 0,
      _onResize: null
    };
    panel.pushView(buildView());
    // safety net: the chat root's async label repaint can still race a
    // freshly pushed view (it would write bodyEl directly) — one delayed
    // self-heal repaints the hub if its DOM vanished. The race itself
    // is fixed in chatpanel.js (the repaint defers while views are
    // stacked); this is the belt under the suspenders.
    setTimeout(function () {
      if (cur && cur.panel && isTop() && !q('#pub-head')) {
        cur.panel.replaceView(buildView());
      }
    }, 650);
    fetchLibraries();
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
    if (cur && (!type || cur.type === type)) {
      cur.stale = true; cur.auth = null;
      if (isTop()) { loadItems(true); loadAuth(); }
    }
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
