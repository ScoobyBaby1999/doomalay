// hub.js — v0.31→v0.44 THE PUBLIC LIBRARY (the modular hub panel).
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
  // v0.58 (user spec pt 4): the show-bundles toggle — ON by default. ON
  // shows the bunch cards and HIDES their member items; OFF hides the
  // bunch cards and shows every individual item.
  var BUNDLES_KEY = 'doomalay.hubbundles.v1';
  function readBundles() {
    try { return localStorage.getItem(BUNDLES_KEY) !== '0'; } catch (e) { return true; }
  }
  function saveBundles(on) { try { localStorage.setItem(BUNDLES_KEY, on ? '1' : '0'); } catch (e) {} }
  var SORTS = [
    { key: 'recent',    label: 'recent',       sub: 'newest updates first' },
    { key: 'downloads', label: 'downloads',    sub: 'most downloaded first' },
    { key: 'hearts',    label: 'endorsements', sub: 'most endorsed first' },
    { key: 'relevant',  label: 'relevant',     sub: 'the best matches first' }
  ];
  var SORT_SUB = {};
  SORTS.forEach(function (s) { SORT_SUB[s.key] = s.sub; });

  // the library pills' glyphs — future registry types fall back to 📚
  // v0.60 pt C.5: script (⌨ terminal) + doc (📖 book) join the set.
  var LIB_ICONS = { persona: '🎭', template: '🧩', skill: '🛠', theme: '🎨', script: '⌨', doc: '📖' };
  function libIcon(type) { return LIB_ICONS[type] || '📚'; }

  // v0.58 (user spec pts 1 + 8): each browsed library has ONE tone pair that
  // ALL the library chrome follows (publish pill, focused search, sort icons,
  // the bunch chip, the my-xyz pill). The tones are THEME VARS (persona /
  // template tints; skills ride accent-3; themes ride accent-2) — the CSS
  // maps .hub-root[data-tone] → --hub-tone / --hub-tone-rgb.
  function mineLabel(type) {
    return { persona: 'my personas', skill: 'my skills', template: 'my templates', theme: 'my themes', script: 'my scripts', doc: 'my docs' }[type] || 'my items';
  }

  // The served Item carries no local-state flags — the web tracks what
  // THIS session downloaded / hearted so the item detail can enable the
  // endorse button (the engine enforces "download before endorse" with
  // a 400 either way).
  var downloaded = {}; // "type|repo|id" → true
  var hearted = {};    // "type|repo|id" → true

  var cur = null;      // the open hub view's state
  // v0.60 pt B: the BUNCH detail is its OWN pushed view (bcur) — the grid
  // beneath keeps its filters/selection/scroll untouched, so ‹ from a
  // bundle returns to exactly the grid you left (panel.js snapshots the
  // covered view's scroll on push).
  var bcur = null;     // the open bunch view's state

  // v0.60 pt B: BROWSE-STATE PERSISTENCE — the library remembers where
  // you were (type, q, sort, tag, mine, page, folded, scroll) across
  // close→reopen. Saved on every user action + throttled scroll + close;
  // restored on open (an explicit type argument wins; q/tag/mine restore
  // only when the browsed type matches the saved one).
  var HUBSTATE_KEY = 'doomalay.hubstate.v1';
  function saveHubstate() {
    if (!cur) return;
    try {
      localStorage.setItem(HUBSTATE_KEY, JSON.stringify({
        type: cur.type || '',
        q: cur.q || '',
        sort: cur.sort || 'recent',
        tag: cur.tag || '',
        mine: !!cur.mine,
        page: cur.page || 1,
        folded: !!cur.folded,
        scroll: (cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.scrollTop : 0
      }));
    } catch (e) {}
  }
  function readHubstate() {
    try { return JSON.parse(localStorage.getItem(HUBSTATE_KEY)) || null; } catch (e) { return null; }
  }

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
  // v0.58 (user spec pt 7): toast(msg, {hold}) — the transient footer pill.
  // hold keeps it on screen (a "downloading…" / "endorsing…" state) until a
  // later normal toast swaps the text and fades; ms tunes the dwell.
  function toast(msg, opts) {
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
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (!(opts && opts.hold)) {
      toastTimer = setTimeout(function () { t.style.opacity = '0'; }, (opts && opts.ms) || 1900);
    }
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
  // v0.58: idColors — the two hashed stops behind idGradient, split out so
  // the bundle FLAG can paint its solid from the same deterministic hash.
  function idColors(id) {
    var h = hashStr(String(id || ''));
    var h1 = Math.abs(h) % 360;
    var h2 = (h1 + 40 + (Math.abs(h >> 8) % 80)) % 360;
    var s1 = 60 + Math.abs(h >> 4) % 21;
    var l1 = 45 + Math.abs(h >> 12) % 21;
    return [hsl(h1, s1, l1), hsl(h2, s1, l1 + 8)];
  }
  function idGradient(id) {
    var c = idColors(id);
    return 'linear-gradient(135deg, ' + c[0] + ', ' + c[1] + ')';
  }

  // ── grid prefs (cols 1–5 × rows 3–100, default 2×10) ──────────
  // v0.56 (user spec): "change the max rows from 10 to 100, and have
  // the default be 10".
  function readGrid() {
    try {
      var g = JSON.parse(localStorage.getItem(GRID_KEY));
      if (g && typeof g.cols === 'number' && typeof g.rows === 'number' &&
          g.cols >= 1 && g.cols <= 5 && g.rows >= 3 && g.rows <= 100) {
        return { cols: g.cols | 0, rows: g.rows | 0 };
      }
    } catch (e) {}
    return { cols: 2, rows: 10 };
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
        // v0.60 pt B: the saved page applies once (bodyHTML clamps it to
        // the real page count) + the one-shot scroll restore after the
        // first paint (rAF — the grid needs a frame to lay out).
        if (cur._keepPage) { cur.page = cur._keepPage; cur._keepPage = 0; }
        if (isTop()) { updateLibs(); updateTags(); updateBody(); }
        if (cur._restoreScroll) {
          var bodyEl = cur.panel && cur.panel.bodyEl;
          var y = cur._restoreScroll;
          cur._restoreScroll = 0;
          if (bodyEl) requestAnimationFrame(function () {
            try { bodyEl.scrollTop = y; } catch (e) {}
          });
        }
        seedLocalState(cur.type);   // v0.58: light up downloaded/hearted states
        loadCollections(refresh);
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

  // v0.58: seed the session's downloaded/hearted maps from the engine's
  // local rows (the served list carries no per-user state; without this a
  // fresh page shows dead hearts on items the user already has).
  function seedLocalState(type) {
    if (!type) return;
    api('GET', '/api/hub/' + encodeURIComponent(type) + '/downloads')
      .then(function (d) {
        var changed = false;
        ((d && d.items) || []).forEach(function (r) {
          if (!r || !r.item) return;
          if (!isDownloaded(type, r.item.repo, r.item.id)) {
            markDownloaded(type, r.item.repo, r.item.id);
            changed = true;
          }
          if (r.hearted && !isHearted(type, r.item.repo, r.item.id)) {
            setHearted(type, r.item.repo, r.item.id, true);
            changed = true;
          }
        });
        if (changed && isTop() && cur && cur.type === type) updateBody();
      })
      .catch(function () {});
  }

  // v0.52: the bunches for the current q — they ride the grid's first
  // slots. Shares the items' refresh so one ⟳ refreshes both.
  function loadCollections(refresh) {
    if (!cur) return;
    var seq = cur.colSeq = (cur.colSeq || 0) + 1;
    cur.bunchLoading = true;
    if (isTop()) updateBody();
    var qs = [];
    if (cur.q) qs.push('q=' + encodeURIComponent(cur.q));
    if (refresh) qs.push('refresh=1');
    api('GET', '/api/hub/collections?' + qs.join('&'))
      .then(function (d) {
        if (!cur || cur.colSeq !== seq) return;
        cur.bunchLoading = false;
        cur.collections = (d && d.collections) || [];
        if (isTop()) updateBody();
      })
      .catch(function () {
        if (!cur || cur.colSeq !== seq) return;
        cur.bunchLoading = false;
        cur.collections = [];
        if (isTop()) updateBody();
      });
  }

  // v0.60 pt B: OPEN A BUNCH — its own PUSHED view. The grid beneath
  // keeps its filters/selection/scroll (pushView snapshots the covered
  // view's scroll); ‹ pops back to exactly the grid you left.
  function openBunch(id) {
    var panel = PV();
    if (!panel || !cur) return;
    bcur = { panel: panel, id: id, groups: null, loading: true, seq: 0, viewObj: null };
    panel.pushView(bunchView());
    fetchBunch(id);
  }

  function bunchView() {
    var v = view('bundle · ' + (bcur ? bcur.id : 'bundle'), function () { return bunchRender(); },
      function (el) { bunchWire(el); },
      function () { bcur = null; });
    if (bcur) bcur.viewObj = v; // bunchTop()'s identity check
    return v;
  }

  function bunchTop() {
    return !!(bcur && bcur.panel && bcur.viewObj &&
      typeof bcur.panel.topView === 'function' && bcur.panel.topView() === bcur.viewObj);
  }

  function bunchRepaint() {
    if (!bcur || !bcur.panel) return;
    bcur.panel.replaceView(bunchView(), { keepScroll: true });
  }

  function fetchBunch(id) {
    if (!bcur) return;
    var seq = bcur.seq = (bcur.seq || 0) + 1;
    api('GET', '/api/hub/collections/' + encodeURIComponent(id) + '/items')
      .then(function (d) {
        if (!bcur || bcur.seq !== seq) return;
        bcur.loading = false;
        bcur.groups = (d && d.groups) || [];
        if (bunchTop()) bunchRepaint();
      })
      .catch(function (e) {
        if (!bcur || bcur.seq !== seq) return;
        bcur.loading = false;
        bcur.groups = [];
        if (bunchTop()) { toast(e.message || 'the bunch could not be reached'); bunchRepaint(); }
      });
  }

  // the bunch view render — a hero (the bunch's own design + flag) + the
  // cross-library member sections, one grid per type.
  function bunchRender() {
    if (!bcur) return '';
    var b = bunchMeta(bcur.id);
    var I = window.IconLib;
    var ico = (I && I.has(b.icon || '')) ? I.svg(b.icon, 22) : (I ? I.svg('package', 22) : '');
    var bits = [];
    var byType = b.byType || {};
    Object.keys(byType).forEach(function (t) {
      bits.push(byType[t] + ' ' + shortType(t) + (byType[t] === 1 ? '' : 's'));
    });
    var flag = (b.tag || '').trim()
      ? '<span class="hub-bundle-flag"' + flagStyle(b) + '><b>#' + esc(String(b.tag).trim()) +
        '</b><i>bundle</i></span>' : '';
    var hero =
      '<div class="hub-bunch-hero" style="background-image:' +
        ((window.Hub && window.Hub.idGradient) ? window.Hub.idGradient(bcur.id) : 'none') + '">' +
        '<span class="hub-bunch-hero-bg" data-bunchbg="1"></span>' +
        '<span class="hub-bunch-hero-scrim" aria-hidden="true"></span>' +
        '<div class="hub-bunch-hero-body">' +
          '<div class="hub-bunch-hero-titlerow">' +
            (ico ? '<span class="hub-card-ico" aria-hidden="true">' + ico + '</span>' : '') +
            '<span class="hub-bunch-hero-name">' + esc(bcur.id) + '</span>' +
          '</div>' +
          '<div class="hub-bunch-hero-desc">' + esc((b.members || 0) + ' bundled items — ' + bits.join(' · ')) + '</div>' +
        '</div>' +
        flag +
      '</div>';
    var body = '';
    if (bcur.loading) {
      body = '<div class="art-loading">loading the bundle…</div>';
    } else {
      var groups = bcur.groups || [];
      if (!groups.length) {
        body = '<div class="hub-empty">the bundle “' + esc(bcur.id) + '” has no members anymore</div>';
      } else {
        groups.forEach(function (g) {
          body += '<div class="hub-bunch-sec">' +
            '<div class="hub-bunch-sec-h">' + libIcon(g.type) + ' ' + esc(shortType(g.type)) + 's' +
              ' <span class="hub-bunch-sec-n">' + g.items.length + '</span></div>' +
            '<div class="hub-grid" style="--hub-cols:' + clampCols(cur && cur.grid, bcur.panel && bcur.panel.bodyEl ? bcur.panel.bodyEl.clientWidth : 320) + '">' +
              g.items.map(cardHTML).join('') +
            '</div>' +
          '</div>';
        });
      }
    }
    return '<div class="hub-root hub-root--bunch" data-tone="' + escAttr((cur && cur.type) || '') + '">' + hero +
      '<div class="hub-bodyzone">' + body + '</div></div>';
  }

  // the bunch view's meta — the collections list the GRID loaded (this
  // view only opens from a bunch card, so cur is alive and holds it).
  function bunchMeta(id) {
    var list = (cur && cur.collections) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return { id: id, members: 0, byType: {}, tag: '', design: null, icon: '' };
  }

  function bunchWire(el) {
    if (!bcur || !el) return;
    var c = cur;
    // member cards → the item detail (the same open path the grid uses)
    el.querySelectorAll('[data-item]').forEach(function (b) {
      var id = b.getAttribute('data-item');
      var it = findItem(id);
      if (!it) return;
      b.addEventListener('click', function () {
        if (window.HubItem) window.HubItem.open(it.type || (c && c.type), it);
      });
      var bg = b.querySelector('[data-bgcard]');
      if (bg) paintCardBg(bg, it);
    });
    // the hero's art layer — the bunch's own design
    var heroBg = el.querySelector('[data-bunchbg]');
    if (heroBg) paintBunchBg(heroBg, bunchMeta(bcur.id));
    // live hearts on the member cards (the shared grid handler)
    wireCardHearts(el);
    marqueeScan(el);
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

  // v0.56 (user spec item 9): the sort pills' ICONS — the old text
  // columns (recent / downloads / endorsements / relevant + the filter
  // funnel + the redundant filter-by-text box) are GONE; the freed space
  // rides the search row as little icon buttons.
  var SORT_ICONS = { recent: 'zap', downloads: 'download', hearts: 'heart', relevant: 'sparkles' };

  function renderHTML() {
    if (!cur) return '';
    return (
      '<div class="hub-root" data-tone="' + escAttr(cur.type || '') + '">' +
        // v0.52: the chat-connection pill — the library's ONLY binding to
        // a chat (decoupled by default: "no chat" unless a chatbot opened
        // it). Tap → the merged all-chats overlay in pick mode.
        '<div class="hub-chatrow">' + chatPillHTML() + '</div>' +
        topDockHTML() +
        headBodyHTML() +
        '<div class="hub-bodyzone" id="hub-bodyzone">' + bodyHTML() + '</div>' +
      '</div>'
    );
  }

  // v0.56 (user spec item 9): THE TOP DOCK — the pinned library chrome.
  // When you scroll, the collapsed "Public Library" header pill stays
  // pinned and the search bar + sort icons collapse to a round search
  // icon; tapping it expands the row again (and focuses the input). The
  // dock blends with the panel behind (surface-1 glass + blur) — NOT the
  // overlay background (user spec: "not use the overlay background color
  // and use something else. Something that would blend with the rest of
  // the background").
  function topDockHTML() {
    var c = cur;
    var status = '<span class="pub-status" id="pub-status">' + statusHTML() + '</span>';
    var ico = (window.IconLib && window.IconLib.has('search'))
      ? window.IconLib.svg('search', 15) : '⌕';
    return (
      '<div class="hub-topdock" id="hub-topdock">' +
        '<div class="pub-head-bar" id="pub-head-toggle" role="button" tabindex="0"' +
          ' aria-expanded="' + (!c.folded) + '">' +
          '<span class="pub-title">Public Library</span>' +
          status +
          '<span class="pub-chev" aria-hidden="true">' + (c.folded ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<div class="hub-dockrow" id="hub-dockrow">' +
          '<button type="button" class="hub-searchico" id="hub-searchico" aria-label="Search the library" title="Search">' + ico + '</button>' +
          '<input id="hub-search" class="hub-search" type="text" inputmode="search"' +
            ' placeholder="search name, description, tags…" value="' + escAttr(cur.q) + '"' +
            ' aria-label="search the library">' +
          sortIconsHTML() +
        '</div>' +
        '<div class="hub-fsub" id="hub-fsub">' + fsubHTML() + '</div>' +
      '</div>');
  }

  function sortIconsHTML() {
    var c = cur;
    var out = '';
    SORTS.forEach(function (s) {
      var g = (window.IconLib && window.IconLib.has(SORT_ICONS[s.key]))
        ? window.IconLib.svg(SORT_ICONS[s.key], 15) : '';
      out += '<button type="button" class="hub-sortico" data-sort="' + escAttr(s.key) + '"' +
        (s.key === c.sort ? ' data-on="1"' : '') +
        ' title="' + escAttr(s.label + ' — ' + s.sub) + '" aria-label="sort by ' + escAttr(s.label) + '">' +
        g + '</button>';
    });
    return '<div class="hub-sortrow" id="hub-sortrow">' + out + '</div>';
  }

  function fsubHTML() {
    var c = cur;
    return esc(SORT_SUB[c.sort] || '');
  }

  // the collapsible header body — everything that ISN'T the pinned dock:
  // "Browse the community for:" + the full-row library pills + the grid
  // steppers + publish + the tag pills. Folds under the pinned bar.
  function headBodyHTML() {
    var c = cur;
    return (
      '<div class="pub-head-body' + (c.folded ? ' folded' : '') + '" id="pub-head-body">' +
        '<div class="pub-sub">Browse the community for:</div>' +
        '<div class="hub-librow" id="hub-libs">' + libsHTML() + '</div>' +
        '<div class="hub-ctlrow">' +
          stepper('cols', c.grid.cols, 1, 5) +
          stepper('rows', c.grid.rows, 3, 100) +
          // v0.58 (user spec pt 4): the show-bundles toggle — rides between
          // the steppers and the publish pill; ON = bundle cards shown (their
          // member items hidden), OFF = plain items only.
          bundlesToggleHTML() +
          '<button class="hub-publish" id="hub-publish">＋ publish</button>' +
        '</div>' +
        '<div class="hub-pillrow" id="hub-tags">' + tagsHTML() + '</div>' +
      '</div>');
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

  // v0.49 → v0.56 RETIRED: the filter row (funnel + the 4 text sort
  // columns + the filter-by-text box) is gone — the sort columns are
  // ICONS riding the search row now (sortIconsHTML) and the text filter
  // duplicated the search bar (user spec: "remove the unnecessary
  // filter").

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
    // v0.58 (user spec pt 8): MY-xyz — the my-pill filters the grid to the
    // user's downloads (client-side q + sort over the downloads list).
    // (v0.60 pt B: the BUNCH view is its own pushed view now — the grid
    // below only ever renders the library/mine lists.)
    if (c.mine) {
      if (c.mineLoading) return '<div class="art-loading">loading your downloads…</div>';
      var mine = mineVisible(c);
      if (!mine.length) {
        return '<div class="hub-empty">nothing downloaded yet — browse the community and grab something</div>';
      }
      var mp = minePage(c, mine);
      return (
        '<div class="hub-grid" id="hub-grid" style="--hub-cols:' + mp.eff + '">' +
          mine.slice((mp.page - 1) * mp.per, mp.page * mp.per).map(cardHTML).join('') +
        '</div>' +
        pagerHTML(mp.page, mp.pages)
      );
    }
    var eff = clampCols(c.grid, c.width);
    c.eff = eff;
    var per = eff * c.grid.rows;
    // v0.58 (user spec pt 4): the bundles toggle decides the grid — ON =
    // the bunch cards lead AND their member items hide; OFF = plain items.
    var showBundles = readBundles();
    var items = (c.items || []).filter(function (it) {
      return !showBundles || !(it && it.collection);
    });
    var pages = Math.max(1, Math.ceil(items.length / per));
    var page = Math.min(Math.max(1, c.page), pages);
    c.page = page;

    if (c.loading && !c.items) return '<div class="art-loading">loading the library…</div>';
    if (!items.length && !(showBundles && (c.collections || []).length)) {
      return '<div class="hub-empty">' +
        (c.err ? esc(c.err) :
          'nothing here' + (c.q ? ' for “' + esc(c.q) + '”' : '') +
          ' — try another search, another tag, or publish something below') +
        '</div>';
    }
    // the bunch cards ride the SAME grid, first (they match the current
    // q — loadCollections shares it). v0.56 (user spec): a bunch only
    // lands in libraries its members ACTUALLY have — superpowers with no
    // theme files stops appearing in Themes.
    var bunches = (showBundles && !c.bunchLoading) ? (c.collections || []).filter(function (b) {
      return ((b && b.byType) || {})[c.type] > 0;
    }) : [];
    return (
      '<div class="hub-grid" id="hub-grid" style="--hub-cols:' + eff + '">' +
          bunches.map(collectionCardHTML).join('') +
          items.slice((page - 1) * per, page * per).map(cardHTML).join('') +
      '</div>' +
      pagerHTML(page, pages)
    );
  }

  function pagerHTML(page, pages) {
    return (
      '<div class="hub-pager">' +
        '<button class="hub-nav" data-page="prev"' + (page <= 1 ? ' disabled' : '') + ' aria-label="previous page">‹</button>' +
        '<span class="hub-page-line">page ' + page + '/' + pages + '</span>' +
        '<button class="hub-nav" data-page="next"' + (page >= pages ? ' disabled' : '') + ' aria-label="next page">›</button>' +
      '</div>'
    );
  }

  // v0.58: the my-xyz list — client-side q filter + sort over downloads.
  function mineVisible(c) {
    var list = (c.mineItems || []).slice();
    var lq = String(c.q || '').toLowerCase();
    if (lq) {
      list = list.filter(function (it) {
        return (it.name || '').toLowerCase().indexOf(lq) >= 0 ||
          (it.description || '').toLowerCase().indexOf(lq) >= 0 ||
          (it.tags || []).some(function (t) { return (t || '').toLowerCase().indexOf(lq) >= 0; });
      });
    }
    var key = c.sort === 'downloads' ? 'downloads' : (c.sort === 'hearts' ? 'hearts' : 'updatedAt');
    list.sort(function (a, b) {
      if (key !== 'updatedAt') return (b[key] || 0) - (a[key] || 0);
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    return list;
  }
  function minePage(c, mine) {
    var eff = clampCols(c.grid, c.width);
    c.eff = eff;
    var per = eff * c.grid.rows;
    var pages = Math.max(1, Math.ceil(mine.length / per));
    var page = Math.min(Math.max(1, c.page), pages);
    c.page = page;
    return { eff: eff, per: per, page: page, pages: pages };
  }

  function stepper(kind, val, lo, hi) {
    return '<span class="hub-ctl" data-ctl="' + escAttr(kind) + '">' +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':-1"' + (val <= lo ? ' disabled' : '') +
        ' aria-label="fewer ' + esc(kind) + '">' + (kind === 'cols' ? '‹' : '−') + '</button>' +
      '<span class="hub-step-val" id="hub-' + escAttr(kind) + '-val">' + val + '</span>' +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':1"' + (val >= hi ? ' disabled' : '') +
        ' aria-label="more ' + esc(kind) + '">' + (kind === 'cols' ? '›' : '＋') + '</button>' +
    '</span>';
  }

  // v0.58 (user spec pt 4): the bundles toggle — a compact labeled switch.
  function bundlesToggleHTML() {
    var on = readBundles();
    return '<button type="button" class="hub-bundles' + (on ? ' on' : '') + '" id="hub-bundles"' +
      ' aria-pressed="' + on + '" title="show bundle cards (their member items hide while on)">' +
      '<span class="hub-bundles-track"><span class="hub-bundles-dot"></span></span>' +
      '<span class="hub-bundles-label">bundles</span></button>';
  }

  // ── v0.52: themed stat glyphs (bigger ♥ / ⤓ — user spec item 4). The
  // heart FILLS when hearted (fill=currentColor over the stroke).
  function statIcon(name, filled) {
    var I = window.IconLib;
    if (!I || !I.has(name)) return '';
    var s = I.svg(name, 17);
    if (filled) s = s.replace('fill="none"', 'fill="currentColor"');
    return s;
  }
  function heartGlyph(on) { return statIcon('heart', on) || (on ? '♥' : '♡'); }
  function dlGlyph() { return statIcon('download', false) || '⤓'; }

  function findItem(id) {
    if (!cur) return null;
    var i, j;
    if (cur.items) {
      for (i = 0; i < cur.items.length; i++) {
        if (cur.items[i].id === id) return cur.items[i];
      }
    }
    // v0.58: the my-xyz filter renders items cur.items never held
    if (cur.mineItems) {
      for (i = 0; i < cur.mineItems.length; i++) {
        if (cur.mineItems[i].id === id) return cur.mineItems[i];
      }
    }
    // v0.60 pt B: bunch members live in the BUNCH VIEW's groups
    var groups = (bcur && bcur.groups) || [];
    for (i = 0; i < groups.length; i++) {
      var items = groups[i].items || [];
      for (j = 0; j < items.length; j++) {
        if (items[j].id === id) return items[j];
      }
    }
    return null;
  }

  function cardHTML(it) {
    var sub = it.description ||
      (it.tags || []).map(function (t) { return '#' + t; }).join(' ') ||
      '—';
    // v0.52 (user spec item 3): the icon COLUMN left of the name —
    // optional; no icon renders exactly the pre-v0.52 layout.
    var ico = (it.icon && window.IconLib) ? window.IconLib.svg(it.icon, 20) : '';
    var hearted = isHearted(it.type || (cur && cur.type), it.repo, it.id);
    // v0.58 (user spec pt 10): "~x stages" rides the foot, right of the
    // downloads with a two-tab gap — templates with a deterministic count.
    var isTpl = (it.type || (cur && cur.type)) === 'template';
    var stages = (isTpl && it.stageCount > 0)
      ? '<span class="hub-card-stat hub-card-stat--stages">~' + it.stageCount + ' stages</span>' : '';
    return (
      '<button class="hub-card" data-item="' + escAttr(it.id) + '">' +
        '<span class="hub-card-bg" data-bgcard="1"></span>' +
        '<span class="hub-card-fade"></span>' +
        '<span class="hub-card-body">' +
          '<span class="hub-card-titlerow">' +
            (ico ? '<span class="hub-card-ico" aria-hidden="true">' + ico + '</span>' : '') +
            '<span class="hub-card-name"><span class="hub-card-name-in">' + esc(it.name) + '</span></span>' +
          '</span>' +
          '<span class="hub-card-desc">' + esc(sub) + '</span>' +
          '<span class="hub-card-author">by ' + esc(it.author || 'unknown') + '</span>' +
          '<span class="hub-card-foot">' +
            '<span class="hub-card-stat' + (hearted ? ' on' : '') + '" data-heart="1" role="button"' +
              ' tabindex="0" aria-label="endorse">' + heartGlyph(hearted) + '<b>' + (it.hearts || 0) + '</b></span>' +
            '<span class="hub-card-stat">' + dlGlyph() + '<b>' + (it.downloads || 0) + '</b></span>' +
            stages +
          '</span>' +
        '</span>' +
      '</button>'
    );
  }

  // v0.58 (user spec pt 6): long names MARQUEE — the inner span slowly
  // slides across when the name overflows its line (see marqueeScan).
  function marqueeScan(host) {
    var scope = host || (cur && cur.panel ? cur.panel.bodyEl : document);
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('.hub-card-name').forEach(function (n) {
      var inner = n.firstElementChild;
      if (!inner || n.classList.contains('marquee')) return;
      var over = inner.scrollWidth - n.clientWidth;
      if (over > 8) {
        n.classList.add('marquee');
        n.style.setProperty('--slide-d', -over + 'px');
        n.style.setProperty('--slide-t', Math.max(4, Math.round(over / 26)) + 's');
      }
    });
  }

  // v0.52 (user spec item 1): the BUNCH card — one grouped listing for a
  // whole collection. v0.58 (user spec pt 2): the bunch is now a FULL card
  // — bg art (the engine resolves design: curated override → newest member
  // design → the deterministic hash fallback) + a horizontal FOR-SALE-STYLE
  // FLAG on the left edge showing "#tag" + a smaller "bundle". Tap opens
  // the cross-library member view.
  function collectionCardHTML(b) {
    var I = window.IconLib;
    var ico = (I && I.has(b.icon || '')) ? I.svg(b.icon, 22)
      : (I ? I.svg('package', 22) : '');
    var bits = [];
    var byType = b.byType || {};
    Object.keys(byType).forEach(function (t) {
      bits.push(byType[t] + ' ' + (shortType(t)) + (byType[t] === 1 ? '' : 's'));
    });
    var flag = (b.tag || '').trim()
      ? '<span class="hub-bundle-flag"' + flagStyle(b) + '><b>#' + esc(String(b.tag).trim()) +
        '</b><i>bundle</i></span>' : '';
    return (
      '<button class="hub-card hub-card--bunch" data-bunch="' + escAttr(b.id) + '">' +
        '<span class="hub-card-bg" data-bunchbg="1"></span>' +
        '<span class="hub-card-fade"></span>' +
        '<span class="hub-card-body">' +
          '<span class="hub-card-titlerow">' +
            (ico ? '<span class="hub-card-ico" aria-hidden="true">' + ico + '</span>' : '') +
            '<span class="hub-card-name"><span class="hub-card-name-in">' + esc(b.id) + '</span></span>' +
          '</span>' +
          '<span class="hub-card-desc">' + esc(b.members + ' bundled items — ' + bits.join(' · ')) + '</span>' +
          '<span class="hub-card-foot">' +
            '<span class="hub-card-stat">' + heartGlyph(false) + '<b>' + (b.hearts || 0) + '</b></span>' +
            '<span class="hub-card-stat">' + dlGlyph() + '<b>' + (b.downloads || 0) + '</b></span>' +
          '</span>' +
        '</span>' +
        flag +
      '</button>'
    );
  }

  // v0.58: the flag's paint — an opaque solid from the bunch's own design
  // (its first stop), else the deterministic hash color; ink flips by
  // luminance so the text always reads. This is per-item CONTENT data (the
  // same rule as card art), not UI chrome — chrome stays on theme vars.
  function flagStyle(b) {
    var d = b.design || {};
    var color = '';
    if (d.kind === 'gradient' && d.colors && d.colors.length) color = d.colors[0];
    if (!color) color = idColors(b.id)[0];
    var ink = '#fff', shadow = '0 1px 4px rgba(0,0,0,0.55)';
    var m = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
    if (m) {
      var r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), bl = parseInt(m[1].slice(4, 6), 16);
      if (0.299 * r + 0.587 * g + 0.114 * bl > 168) {
        ink = 'rgba(10,10,14,0.92)'; shadow = '0 1px 3px rgba(255,255,255,0.35)';
      }
    }
    return ' style="background:' + color + ';color:' + ink + ';text-shadow:' + shadow + '"';
  }

  // v0.58: the bunch card's art layer — like paintCardBg but png designs
  // (member uploads) fall back to the hash gradient (no png endpoint for
  // a bunch).
  function paintBunchBg(bgEl, b) {
    var d = b.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      var GU = window.GradientUI;
      if (GU) {
        var css = GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex });
        if (css.charAt(0) === '#') bgEl.style.backgroundColor = css;
        else {
          bgEl.style.backgroundImage = css;
          if (d.tex && GU.BLENDED) bgEl.style.backgroundBlendMode = 'color';
        }
        return;
      }
      if (d.colors.length === 1) { bgEl.style.backgroundColor = d.colors[0]; return; }
      bgEl.style.backgroundImage = 'linear-gradient(135deg, ' + d.colors.join(', ') + ')';
      return;
    }
    bgEl.style.backgroundImage = idGradient(b.id);
  }

  function shortType(t) {
    return { persona: 'persona', template: 'template', skill: 'skill', theme: 'theme', script: 'script', doc: 'doc' }[t] || t;
  }

  // The card's background layer: a v0.44 design SPEC (the shared
  // gradient system — 1–15 stops, dir / angle / an optional texture
  // dataURL blended in with background-blend-mode: color; legacy rows
  // without dir render exactly as before: 'auto' = the 135° linear
  // sweep — one stop renders solid) → PNG (probed, fading 100→0 alpha
  // into the card surface) → deterministic id gradient.
  function paintCardBg(bgEl, it) {
    var d = it.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      var GU = window.GradientUI;
      if (GU) {
        var css = GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex });
        if (css.charAt(0) === '#') {
          bgEl.style.backgroundColor = css;   // one stop + no texture = a solid
        } else {
          bgEl.style.backgroundImage = css;   // the tex dataURL rides as the bottom layer
          if (d.tex && GU.BLENDED) bgEl.style.backgroundBlendMode = 'color';
        }
        return;
      }
      // no uikit — the v0.33 render
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
    // v0.58: cur.type resolves ASYNC (fetchLibraries) — after it lands the
    // chrome re-tones + the my-xyz pill relabels (the initial render had
    // no type yet).
    var rootEl = (cur && cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.querySelector('.hub-root') : null;
    if (rootEl && cur.type && rootEl.getAttribute('data-tone') !== cur.type) {
      rootEl.setAttribute('data-tone', cur.type);
      updateChatrow();
    }
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
    // v0.56: the sort ICONS (the old #hub-fcols text columns are gone) —
    // surgical data-on swap + the fsub line (the sort hint).
    var root = (cur && cur.panel) ? cur.panel.bodyEl : null;
    if (root) {
      root.querySelectorAll('[data-sort]').forEach(function (b) {
        if (b.getAttribute('data-sort') === c.sort) b.setAttribute('data-on', '1');
        else b.removeAttribute('data-on');
      });
    }
    var sub = q('#hub-fsub');
    if (sub) sub.innerHTML = fsubHTML();
  }

  function updateBody() {
    var z = zone();
    if (!z) return;
    z.innerHTML = bodyHTML();
    wireBody(z);
    marqueeScan(z);   // v0.58: measure the long names after the paint
  }

  // v0.58 (user spec pt 8): refresh the chat row (the my-xyz pill follows
  // the browsed type + its on/off state).
  function updateChatrow() {
    var el = q('.hub-chatrow');
    if (!el) return;
    el.innerHTML = chatPillHTML();
    wireChatPill(el);
  }

  // ── wiring ───────────────────────────────────────────────────────
  function wire(el) {
    if (!cur) return;
    var c = cur;

    // v0.52: the chat-connection pill + the NEUTRAL header. While the
    // library view is up, the panel header stops showing the HOST
    // chat's avatar/sub (the library is not bound to it) — a library
    // glyph + "community library" ride instead. The panel's root
    // restore puts the chat's values back when the view pops.
    wireChatPill(el);
    try {
      var p = c.panel;
      if (p && p.avatarEl && p.subEl) {
        c._savedAvatar = p.avatarEl.innerHTML;
        c._savedSub = p.subEl.textContent;
        c._hadHeader = true;
        p.avatarEl.innerHTML = '📚';
        p.subEl.textContent = 'community library';
      }
    } catch (e) {}

    // measure now that the view is in the DOM — the clamp may disagree
    // with what the render assumed; a surgical body update fixes it.
    var gridEl = el.querySelector('#hub-grid');
    c.width = (gridEl && gridEl.clientWidth) || el.clientWidth || 320;
    if (gridEl && (gridEl.style.getPropertyValue('--hub-cols') | 0) !== clampCols(c.grid, c.width)) {
      updateBody();
    }

    // the collapsible header — a class toggle, no re-render (the bar is
    // a div: the disconnect button inside forbids a nested <button>).
    // v0.56: the bar lives in the pinned dock; the BODY folds below it.
    var toggle = el.querySelector('#pub-head-toggle');
    if (toggle) {
      var fold = function () {
        var head = q('#pub-head-body');
        if (!head) return;
        c.folded = !c.folded;
        head.classList.toggle('folded', c.folded);
        var chev = q('.pub-chev');
        if (chev) chev.textContent = c.folded ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!c.folded));
        saveHubstate(); // v0.60 pt B
      };
      toggle.addEventListener('click', fold);
      toggle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold(); }
      });
    }

    // v0.56 (user spec item 9): THE SCRUNCH — on scroll, the pinned dock
    // collapses its search row to a round search icon; tapping the icon
    // (or scrolling back to the top) expands it again.
    var rootEl = el.querySelector('.hub-root') || el;
    var searchico = el.querySelector('#hub-searchico');
    var setScrunch = function (on) {
      if (!rootEl) return;
      if (on) rootEl.classList.add('scrunch');
      else rootEl.classList.remove('scrunch');
    };
    if (searchico) {
      searchico.addEventListener('click', function () {
        setScrunch(false);
        var si = q('#hub-search');
        if (si) { si.focus(); si.select(); }
      });
    }
    if (!c._onHubScroll) {
      var lastSave = 0;
      c._onHubScroll = function () {
        if (!cur || !cur.panel || !cur.panel.bodyEl) return;
        var st = cur.panel.bodyEl.scrollTop;
        // v0.56: never scrunch while the user is TYPING or has a query —
        // focusing the input can fire a scroll event (scrollIntoView),
        // which immediately re-scrunched the dock the tap just expanded.
        var si = q('#hub-search');
        var typing = si && (document.activeElement === si ||
          String(si.value || '').length > 0);
        setScrunch(st > 24 && !typing);
        // v0.60 pt B: the scroll position persists (throttled — at most
        // one write per 400ms of scrolling).
        var now = Date.now();
        if (now - lastSave > 400) { lastSave = now; saveHubstate(); }
      };
      c.panel.bodyEl.addEventListener('scroll', c._onHubScroll, { passive: true });
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
          saveHubstate(); // v0.60 pt B: the browse state persists
          loadItems();
        }, 200);
      });
    }

    // v0.56: the filter-by-text box is GONE (it duplicated the search
    // bar — user spec: "remove the unnecessary filter").

    // the sort ICONS — surgical, same data-sort contract as the old
    // text columns
    el.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        cur.sort = b.getAttribute('data-sort');
        saveHubstate(); // v0.60 pt B
        updateFilters();
        loadItems();
      });
    });

    // library pills + tags + the body zone (cards / pager / publish /
    // steppers all live inside the zones these wire)
    wireLibs(el);
    wireTags(el);
    wireBody(el);
    marqueeScan(el);   // v0.58: the initial grid paint needs a scan too
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

  // library pills — switching reloads the items for that type (and
  // leaves any open bunch — the pill is the way back to a library grid)
  function wireLibs(root) {
    (root || (cur && cur.panel ? cur.panel.bodyEl : document)).querySelectorAll('[data-lib]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.getAttribute('data-on') === '1') return;
        cur.type = b.getAttribute('data-lib');
        cur.items = null;
        cur.tag = '';
        cur.q = '';
        cur.page = 1;
        cur.mine = false;
        cur.mineItems = null;
        saveHubstate(); // v0.60 pt B
        var si = q('#hub-search');
        if (si) si.value = '';
        // v0.58 (pts 1 + 8): the whole library chrome re-tones to the
        // browsed category + the my-xyz pill relabels (and reloads if on).
        var rootEl = (cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.querySelector('.hub-root') : null;
        if (rootEl) rootEl.setAttribute('data-tone', cur.type);
        updateLibs();
        updateTags();
        updateFilters();
        updateChatrow();
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
        saveHubstate(); // v0.60 pt B
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
        // v0.58: the rows cap finally matches its spec everywhere (3–100 —
        // the old handler clamped at 10 while the UI promised 100).
        var lo = kind === 'cols' ? 1 : 3, hi = kind === 'cols' ? 5 : 100;
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
        saveHubstate(); // v0.60 pt B
        updateBody();
      });
    });

    // v0.58 (user spec pt 4): the show-bundles toggle — one tap flips the
    // grid between bundle cards (members hidden) and plain items. (Guarded:
    // wireBody re-runs on every body update and the fallback lookup finds
    // the header button from the zone scope — without the flag every
    // updateBody would add another listener and the clicks would cancel.)
    var bundlesBtn = host.querySelector('#hub-bundles') ||
      (c.panel && c.panel.bodyEl ? c.panel.bodyEl.querySelector('#hub-bundles') : null);
    if (bundlesBtn && !bundlesBtn._bundlesWired) {
      bundlesBtn._bundlesWired = 1;
      bundlesBtn.addEventListener('click', function () {
        if (!cur) return;
        var on = !readBundles();
        saveBundles(on);
        cur.page = 1;
        var btn = q('#hub-bundles');
        if (btn) {
          btn.classList.toggle('on', on);
          btn.setAttribute('aria-pressed', String(on));
        }
        updateBody();
      });
    }

    // cards → item detail · v0.60 pt B: bunch cards OPEN THE PUSHED BUNCH
    // VIEW (the grid beneath keeps its filters/selection/scroll), and the
    // card hearts endorse DIRECTLY (user spec item 6: every heart is live —
    // downloaded items toggle their endorsement right on the card; the
    // engine still 400-guards endorse-before-download, so a heart on a
    // not-yet-downloaded item opens the detail where the download lives).
    var items = c.items || [];
    host.querySelectorAll('[data-item]').forEach(function (b) {
      var id = b.getAttribute('data-item');
      var it = findItem(id) || (function () {
        for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
        return null;
      })();
      if (!it) return;
      b.addEventListener('click', function () {
        if (window.HubItem) window.HubItem.open(it.type || cur.type, it);
      });
      var bg = b.querySelector('[data-bgcard]');
      if (bg) paintCardBg(bg, it);
    });

    host.querySelectorAll('[data-bunch]').forEach(function (b) {
      b.addEventListener('click', function () {
        openBunch(b.getAttribute('data-bunch'));
      });
      // v0.58: the bunch card's own art layer
      var bid = b.getAttribute('data-bunch');
      var bb = (c.collections || []).filter(function (x) { return x && x.id === bid; })[0];
      var bg2 = b.querySelector('[data-bunchbg]');
      if (bg2 && bb) paintBunchBg(bg2, bb);
    });

    wireCardHearts(host);
  }

  // v0.60 pt B: wireCardHearts — the shared live-heart handler for BOTH the
  // library grid and the bunch view's member cards (same contract as the
  // old inline wireBody block).
  function wireCardHearts(host) {
    if (!host || !host.querySelectorAll) return;
    host.querySelectorAll('[data-heart]').forEach(function (h) {
      h.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!cur) return;
        var card = h.closest('[data-item]');
        if (!card) return;
        var it = findItem(card.getAttribute('data-item'));
        if (!it) return;
        var type = it.type || cur.type;
        if (!isDownloaded(type, it.repo, it.id)) {
          // v0.58 (user spec pt 7): the footer pill says it out loud — then
          // the detail opens (that's where the download lives).
          toast('download first — endorsing needs a download', { ms: 2400 });
          if (window.HubItem) window.HubItem.open(type, it);
          return;
        }
        var on = !isHearted(type, it.repo, it.id);
        api('POST', '/api/hub/' + encodeURIComponent(type) +
            (on ? '/endorse' : '/unendorse'), { repo: it.repo, id: it.id })
          .then(function (d) {
            setHearted(type, it.repo, it.id, on);
            if (d && d.item) refreshItem(d.item);
            toast(on ? 'endorsed ♥' : 'endorsement removed');
            if (isTop()) updateBody();
            else if (bunchTop()) bunchRepaint();
          })
          .catch(function (e2) { toast((e2 && e2.message) || 'could not endorse'); });
      });
    });
  }

  function onClosed() {
    // v0.60 pt B: persist the browse state (final scroll included) BEFORE
    // cur goes away.
    saveHubstate();
    if (cur && cur._onResize) {
      window.removeEventListener('resize', cur._onResize);
      cur._onResize = null;
    }
    // v0.56: the scrunch scroll listener rides the panel body — remove it
    if (cur && cur._onHubScroll && cur.panel && cur.panel.bodyEl) {
      cur.panel.bodyEl.removeEventListener('scroll', cur._onHubScroll);
      cur._onHubScroll = null;
    }
    // v0.52: restore the header the hub neutralized (the panel's own
    // root-restore also re-puts the stashed values; this covers the
    // closeView-without-pop edge).
    try {
      var p = PV();
      if (p && p.avatarEl && cur && cur._hadHeader) {
        p.avatarEl.innerHTML = cur._savedAvatar || '';
        p.subEl.textContent = cur._savedSub || '';
      }
    } catch (e) {}
    // v0.60 pt B: CANVAS ENTRY — back/✕ on the library's main browsing page
    // closes the whole panel (the user returns to the CANVAS, not the
    // synthetic host chat opened just to hold the library). A chat connected
    // through the pill cleared fromCanvas, so that path pops normally.
    var fromCanvas = cur && cur.fromCanvas;
    var panel = cur ? cur.panel : null;
    cur = null;
    if (fromCanvas && panel) {
      try { panel.close(); } catch (e) {}
    }
  }

  // ── v0.52: the chat connection (user item 5) ────────────────────
  // The public library is DECOUPLED from chats: it opens with NO chat
  // connected (canvas entry) or with the launching chatbot's chat
  // already connected (pill entry points). The pill row at the top of
  // the view shows the connection; tapping it opens the merged
  // all-chats overlay in PICK mode (ChatsView.openPicker) — picking a
  // row updates the pill (and every library action that targets a
  // chat). chat: {sessionId, title, name, avatarHTML} | null.

  function deriveChatFromPanel() {
    var c = window.ChatPanel && window.ChatPanel.current();
    if (!c || !c.panel || !c.panel.isOpen || !c.panel.isOpen()) return null;
    if (!c.icon || c.icon.type !== 'chat') return null;
    var sid = (c.state && c.state.sessionId) || c.icon.sessionId || '';
    var title = (c.icon && c.icon.name) || '';
    var avatar = (c.icon && c.icon.getAvatarHTML) ? c.icon.getAvatarHTML() : '';
    if (!sid && !title) return null;
    return { sessionId: sid, title: title, name: title, avatarHTML: avatar };
  }

  function chatPillHTML() {
    var c = cur && cur.chat;
    var out = '';
    if (c && (c.sessionId || c.title)) {
      var label = esc(c.title || c.sessionId);
      if (c.name && c.name !== c.title) label += ' · ' + esc(c.name);
      out = '<button type="button" id="hub-chatpill" class="hub-chatpill" aria-label="connected chat: ' +
        escAttr(label) + ' — tap to change" title="tap to connect a different chat">' +
        '<span class="hub-chatpill-ico">' + (c.avatarHTML || '💬') + '</span>' +
        '<span class="hub-chatpill-label">' + label + '</span>' +
        '<span class="hub-chatpill-chev" aria-hidden="true">▾</span></button>';
    } else {
      out = '<button type="button" id="hub-chatpill" class="hub-chatpill hub-chatpill--none"' +
        ' aria-label="no chat connected — tap to connect one" title="tap to connect a chat">' +
        '<span class="hub-chatpill-ico">📚</span>' +
        '<span class="hub-chatpill-label">no chat</span>' +
        '<span class="hub-chatpill-chev" aria-hidden="true">▾</span></button>';
    }
    // v0.58 (user spec pt 8): MY-XYZ — the local-library FILTER pill. It
    // shows for EVERY browsed type ("my personas / my skills / my templates /
    // my themes"), relabels as the user browses, and FILTERS the grid to the
    // engine's downloaded items (no more redirect to the template sheet).
    if (cur) {
      out += '<button type="button" id="hub-locallib" class="hub-chatpill hub-chatpill--mine' +
        (cur.mine ? ' on' : '') + '"' +
        ' aria-pressed="' + (cur.mine ? 'true' : 'false') + '"' +
        ' title="show only your downloaded ' + esc(shortType(cur.type)) + 's"' +
        ' aria-label="' + escAttr(mineLabel(cur.type)) + ' — filter to your downloads">' +
        '<span class="hub-chatpill-ico">' + libIcon(cur.type) + '</span>' +
        '<span class="hub-chatpill-label">' + esc(mineLabel(cur.type)) + '</span>' +
        (cur.mine ? '<span class="hub-chatpill-chev" aria-hidden="true">✓</span>' : '') + '</button>';
    }
    return out;
  }

  function wireChatPill(root) {
    var pill = root.querySelector('#hub-chatpill');
    if (pill) pill.addEventListener('click', function () {
      if (!window.ChatsView || !window.ChatsView.openPicker) {
        toast('the all-chats view is not available');
        return;
      }
      window.ChatsView.openPicker(function (pick) {
        if (!cur) return;
        cur.chat = {
          sessionId: pick.session_id || '',
          title: pick.title || '',
          name: pick.title || '',
          avatarHTML: ''
        };
        // the icon avatar comes from the canvas icon when it exists
        try {
          var icon = (window.doomalay && window.doomalay.findIconForSession)
            ? window.doomalay.findIconForSession(cur.chat.sessionId) : null;
          if (icon && icon.getAvatarHTML) cur.chat.avatarHTML = icon.getAvatarHTML();
          if (icon && icon.name) cur.chat.name = icon.name;
        } catch (e) {}
        paintChatPill(root);
        toast('library connected to ' + (cur.chat.title || 'the chat'));
      });
    });
    // v0.58 (user spec pt 8): the my-xyz FILTER pill — taps toggle the
    // grid between the community and the user's downloads. (Guarded:
    // paintChatPill re-invokes this without replacing the my-pill node.)
    var local = root.querySelector('#hub-locallib');
    if (local && !local._mineWired) {
      local._mineWired = 1;
      local.addEventListener('click', function () {
        if (!cur) return;
        if (cur.mine) {
          cur.mine = false;
          cur.mineItems = null;
          cur.page = 1;
          saveHubstate(); // v0.60 pt B
          updateChatrow();
          updateBody();
          return;
        }
        cur.mine = true;
        cur.page = 1;
        saveHubstate(); // v0.60 pt B
        loadMine();
      });
    }
  }

  // v0.58: fetch the engine's downloads for the browsed type (the my-xyz
  // filter's source — it follows the user across devices + reinstalls).
  function loadMine() {
    if (!cur || !cur.type) return;
    var type = cur.type;
    cur.mineLoading = true;
    updateChatrow();
    updateBody();
    api('GET', '/api/hub/' + encodeURIComponent(type) + '/downloads')
      .then(function (d) {
        if (!cur || cur.type !== type || !cur.mine) return;
        cur.mineLoading = false;
        cur.mineItems = [];
        ((d && d.items) || []).forEach(function (r) {
          if (!r || !r.item) return;
          markDownloaded(type, r.item.repo, r.item.id);
          if (r.hearted) setHearted(type, r.item.repo, r.item.id, true);
          cur.mineItems.push(r.item);
        });
        updateBody();
      })
      .catch(function (e) {
        if (!cur || !cur.mine) return;
        cur.mineLoading = false;
        cur.mineItems = [];
        toast((e && e.message) || 'could not load your downloads');
        updateBody();
      });
  }

  function paintChatPill(root) {
    var old = root.querySelector('#hub-chatpill');
    if (!old) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = chatPillHTML();
    var fresh = tmp.firstElementChild;
    if (fresh) old.parentNode.replaceChild(fresh, old);
    wireChatPill(root);
  }

  // ── entry ────────────────────────────────────────────────────────
  function open(type, opts) {
    var panel = PV();
    if (!panel) { toast('open a chat first'); return; }
    opts = opts || {};
    var chat = null;
    if (opts.chat) {
      chat = opts.chat; // explicit — {sessionId,title,name,avatarHTML} (or null-no-chat)
    } else if (opts.chat === undefined) {
      chat = deriveChatFromPanel(); // legacy callers: connect the hosting chat
    } // opts.chat === null → explicitly NO chat (the canvas entry)
    // v0.60 pt B: restore the last browse state. An explicit type argument
    // wins; q/tag/mine only restore when the browsed type matches the saved
    // one (a skills search makes no sense over templates).
    var saved = readHubstate() || {};
    var explicitType = !!type;
    var sameType = !explicitType || saved.type === type;
    cur = {
      panel: panel,
      chat: chat, // v0.52: null (no chat) | {sessionId,title,name,avatarHTML}
      // v0.60 pt B: opened from the CANVAS (app.js passes canvasHost when
      // it had to open a host panel just to hold the library) — back/✕ on
      // the main browsing page closes the whole panel (canvas), instead of
      // dropping the user on the synthetic host chat behind it.
      fromCanvas: !!opts.canvasHost,
      libraries: [],
      libErr: '',
      type: explicitType ? type : (saved.type || null),
      items: null,
      tags: [],
      q: sameType ? (saved.q || '') : '',
      sort: saved.sort || 'recent',
      tag: sameType ? (saved.tag || '') : '',
      page: 1,
      // v0.60 pt B: the saved page applies ONCE after the items land
      // (loadItems resets page=1 on fetch; bodyHTML clamps the overflow).
      _keepPage: sameType && saved.page > 1 ? saved.page : 0,
      _restoreScroll: sameType ? (saved.scroll || 0) : 0,
      grid: readGrid(),
      loading: false,
      stale: false,
      err: '',
      auth: null,
      width: 0,
      folded: !!saved.folded,
      eff: 0,
      collections: null,
      colSeq: 0,
      // v0.58: the my-xyz filter state
      mine: sameType && !!saved.mine,
      mineItems: null,
      mineLoading: false,
      _onResize: null
    };
    panel.pushView(buildView());
    // safety net: the chat root's async label repaint can still race a
    // freshly pushed view (it would write bodyEl directly) — one delayed
    // self-heal repaints the hub if its DOM vanished. The race itself
    // is fixed in chatpanel.js (the repaint defers while views are
    // stacked); this is the belt under the suspenders.
    setTimeout(function () {
      if (cur && cur.panel && isTop() && !q('#hub-topdock')) {
        cur.panel.replaceView(buildView());
      }
    }, 650);
    fetchLibraries();
  }

  // ── cross-module state (hubitem / hubpublish call these) ─────────
  function markDownloaded(type, repo, id) { downloaded[stateKey(type, repo, id)] = true; }
  function isDownloaded(type, repo, id) { return !!downloaded[stateKey(type, repo, id)]; }
  // v0.60 pt A.3: delete-your-copy clears the local mark (hubitem doDelete).
  function unmarkDownloaded(type, repo, id) { delete downloaded[stateKey(type, repo, id)]; }
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
    // v0.52: the connected chat (null when the library is unbound) —
    // the chat toolbar's [template|+] / [skills|+] buttons and any
    // "apply to this chat" action read this.
    chat: function () { return cur ? cur.chat : null; },
    // v0.60 pt B: connecting a chat through the pill clears the canvas
    // entry — back from the library then pops to the chat panel normally
    // (the library is no longer canvas-rooted).
    setChat: function (chat) {
      if (!cur) return;
      cur.chat = chat || null;
      if (chat) cur.fromCanvas = false;
    },
    markStale: markStale,
    refreshItem: refreshItem,
    isDownloaded: isDownloaded,
    markDownloaded: markDownloaded,
    unmarkDownloaded: unmarkDownloaded,
    setHearted: setHearted,
    isHearted: isHearted,
    toast: toast,
    idGradient: idGradient
  };
})();
