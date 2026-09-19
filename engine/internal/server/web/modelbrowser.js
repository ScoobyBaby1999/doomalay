// modelbrowser.js — the dynamic model browser (v0.32).
//
// Port of the HF space's ModelSelectOverlay.tsx (the "tremendous amount of
// work"), v0.13 heritage preserved, OVERHAULED per the v0.32 user spec:
//
//   1. FILTERS COLLAPSED behind a "Filters" toggle row (funnel icon +
//      active-count badge) in BOTH tabs. Collapsed by default, persisted.
//   2. When expanded the pills are squared, uniform and grid-like — they
//      lay out in wrapped rows (flex-wrap), never a horizontal scroll.
//   3. Smart / Agent / Code pills rank by OpenRouter's Artificial Analysis
//      benchmarks (attributes.benchmarks: intelligence / agentic / coding),
//      highest → lowest. (The old 'smart' capability match never fired.)
//   4. New "Available" pill: only models with ≥1 key-backed provider. The
//      useless "Any $" pill is GONE — Free/Paid are self-cancelling toggles.
//   5. Providers tab: keyless boxes are dimmed + badged "view only" (keyed
//      = "ready"). Models tab: logical models with no key-backed host
//      anywhere (priority position irrelevant) are dimmed hard.
//   6. Model rows are SPLIT: LEFT (radio + name) selects the model (best
//      key-backed host, user's host order); RIGHT (after a 1px separator —
//      the hotspot marker) opens the provider-priority dropdown; the
//      chevron is now a proper 30px button that rotates when open.
//   7. Host priority re-ordering: ▲▼ AND drag-and-drop (⠿ handle on each
//      host row) — the row follows the finger, siblings FLIP around it.
//   8. Providers tab: HOLD a box (~220ms) or grab its ⠿ grip and drag to
//      re-order the boxes — iPhone-style reorder, persisted.
//   9. The "use" pill is GONE — the left-side tap selects; models with no
//      key anywhere show an inline hint instead of selecting.
//
// v0.32.1 (QA round 2):
//   A. BUGFIX: "Available" as the ONLY filter hid EVERYTHING in both tabs
//      (the caps matcher has no branch for it, and providerView read a
//      non-existent `hasKey` field). Both fixed — Available alone now shows
//      the 148 key-backed models / the ready provider boxes.
//   B. SORT control (models tab): Best / Smartest / Top agent / Top code /
//      Cheapest / Biggest ctx / A→Z — persisted.
//   C. Live counts line (both tabs): "X of Y models · Z with your keys".
//   D. Inline ADD-KEY form on view-only provider boxes (＋ key) — POSTs
//      /api/keys, re-syncs, box flips to "ready" without leaving the panel.
//   E. Current-model indicator: filled radio + green ring + "current" chip
//      on the row the chat is actually using (chatpanel passes opts.current).
//   F. Esc closes the overlay. Pills get hover/press/focus polish +
//      aria-pressed; rows/boxes get hover borders + aria-expanded.
//   G. Benchmark chips grow score mini-bars.
//
// v0.32.2 (QA round 3):
//   A. STARRED favorites: ★ button on every model row (models view +
//      provider view rows), "Starred" filter pill, "★ Starred first"
//      sort, persisted (.starred). Starring updates in place — no
//      re-render, so scroll position survives.
//   B. REAL PRICE chips: paid rows show "$0.91/M" (parsed from
//      attributes.pricing) instead of a bare "paid" — tooltip carries the
//      full pricing string.
//   C. SEARCH UX FIX: the 200ms-debounced re-render used to replace the
//      input mid-typing (focus + caret lost after any pause > 200ms).
//      render() now preserves focus + caret across re-renders. "/" focuses
//      search; Esc inside a non-empty search clears it (instead of closing
//      the whole overlay); empty search + Esc blurs.
//   D. Friendly empty state when the Starred pill is on but nothing is
//      starred yet.
//
// 100% RUNTIME DATA: everything comes from GET /api/models. Selection
// picks the best host and calls onPick(provider, modelId).
//
// PERSISTENCE (localStorage, same keys as the old app):
//   doomalay.model-select.view / .search / .filters / .filtersOpen /
//   .ctxMin / .pricing / .providerOrder / .providerExpanded /
//   .hostOrder (per logical model)
//
// Exposes: window.ModelBrowser = { open }
(function () {
  'use strict';

  var EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  var LS = 'doomalay.model-select.';

  // Filter pill definitions (label, color, match key).
  var PILLS = [
    { key: 'reasoning', label: 'Reason', color: '#f97316' },
    { key: 'intelligence', label: 'Smart', color: '#a855f7' },
    { key: 'code', label: 'Code', color: '#3b82f6' },
    { key: 'agent', label: 'Agent', color: '#14b8a6' },
    { key: 'tools', label: 'Tools', color: '#8b5cf6' },
    { key: 'vision', label: 'Vision', color: '#22c55e' },
    { key: 'available', label: 'Available', color: '#10b981' },
    { key: 'starred', label: 'Starred', color: '#eab308' } // v0.32.2 A
  ];
  var CTX_OPTIONS = [
    { label: 'Any', v: 0 },
    { label: '32K', v: 32000 },
    { label: '128K', v: 128000 },
    { label: '1M', v: 1000000 }
  ];
  // "Any $" removed (v0.32): Free / Paid are self-cancelling toggles —
  // neither active == pricing 'all'.
  var PRICING_OPTIONS = [
    { key: 'free', label: 'Free', color: '#22c55e' },
    { key: 'paid', label: 'Paid', color: '#f59e0b' }
  ];

  // Pills that re-rank the list by a benchmark score.
  var SCORING_KEYS = ['intelligence', 'code', 'agent'];

  // v0.32.1 B: sort options for the models tab (persisted as .sort).
  var SORTS = [
    { key: 'best',    label: 'Best' },
    { key: 'recent',  label: 'Recently used' }, // v0.32.4 F1: MRU order
    { key: 'starred', label: '★ Starred first' }, // v0.32.2 A
    { key: 'aa',      label: 'Smartest (AA)' },
    { key: 'agent', label: 'Top agent' },
    { key: 'code',  label: 'Top code' },
    { key: 'price', label: 'Cheapest' },
    { key: 'ctx',   label: 'Biggest context' },
    { key: 'name',  label: 'A → Z' }
  ];

  // Shared click suppression after a drag (ms).
  var suppressClickUntil = 0;

  function lsGet(key, dflt) {
    try {
      var v = localStorage.getItem(LS + key);
      return v === null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }
  function lsSet(key, v) {
    try { localStorage.setItem(LS + key, JSON.stringify(v)); } catch (e) {}
  }

  // Self-contained v0.32 styles (injected once).
  function ensureStyles() {
    if (document.getElementById('mb-v32-styles')) return;
    var s = document.createElement('style');
    s.id = 'mb-v32-styles';
    s.textContent =
      '.mb-logrow,[data-provhead],[data-hostslot],[data-select],[data-expand]{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.mb-logrow [data-select]{border-radius:8px;transition:background 130ms}' +
      '.mb-logrow [data-select]:hover{background:rgba(128,128,140,0.10)}' +
      '.mb-logrow [data-expand] .mb-chevbtn{transition:background 140ms,border-color 140ms}' +
      '.mb-logrow [data-expand]:hover .mb-chevbtn{background:rgba(128,128,140,0.14);border-color:rgba(255,255,255,0.22)}' +
      '.mb-chevbtn svg{transition:transform 240ms cubic-bezier(0.32,0.72,0,1)}' +
      '[data-hostgrip],[data-grip]{user-select:none;-webkit-user-select:none;transition:background 130ms,color 130ms;border-radius:7px}' +
      '[data-hostgrip]:hover,[data-grip]:hover{background:rgba(128,128,140,0.14);color:var(--text-1)}' +
      '.mb-dragging{position:relative;z-index:40;box-shadow:0 18px 44px rgba(0,0,0,0.55);cursor:grabbing}' +
      '.mb-dragging *{pointer-events:none}' +
      'body.mb-noselect,body.mb-noselect *{user-select:none!important;-webkit-user-select:none!important}' +
      // v0.32.1 F/G: interaction polish — pills feel pressable, boxes/rows
      // brighten on hover, current row wears a green ring.
      '.mb-pill{transition:transform 120ms cubic-bezier(0.32,0.72,0,1),background 130ms,border-color 130ms,color 130ms}' +
      '.mb-pill:hover{transform:scale(1.05)}' +
      '.mb-pill:active{transform:scale(0.95)}' +
      '.mb-pill:focus-visible,.mb-chevbtn:focus-visible,[data-addkey]:focus-visible,#mb-sort:focus-visible,#mb-search:focus-visible,[data-keyinput]:focus-visible,[data-info]:focus-visible,[data-compare]:focus-visible,[data-cmpclose]:focus-visible,[data-cmpuse]:focus-visible,[data-unfilter]:focus-visible,[data-qs-star]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
      '.mb-ufchip:active{transform:scale(0.95)}' +
      '.mb-provbox{transition:opacity 200ms,filter 200ms,border-color 150ms}' +
      '.mb-provbox:not(.mb-dragging):hover{border-color:rgba(255,255,255,0.18)!important}' +
      '.mb-logrow{transition:opacity 200ms,filter 200ms,border-color 150ms}' +
      '.mb-logrow:not(.mb-dragging):not(.mb-cur):hover{border-color:rgba(255,255,255,0.16)!important}' +
      '.mb-logrow.mb-cur{border-color:rgba(var(--ok-rgb),0.55)!important}' +
      '@keyframes mb-hint-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}' +
      '.mb-hint{animation:mb-hint-in 200ms cubic-bezier(0.32,0.72,0,1)}' +
      '.mb-countline{animation:mb-hint-in 160ms cubic-bezier(0.32,0.72,0,1)}' +
      // v0.32.2 A: the star button — pressable, amber when on.
      '.mb-star{transition:transform 120ms cubic-bezier(0.32,0.72,0,1),color 130ms,background 130ms,border-color 130ms}' +
      '.mb-star:hover{transform:scale(1.18)}' +
      '.mb-star:active{transform:scale(0.8)}' +
      '.mb-star:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
      // v0.32.4 F2: the ℹ detail-toggle button + the drawer's animated
      // benchmark bars (scaleX keyframe works on innerHTML insert — no JS
      // post-render hook needed) and the drawer's entrance.
      '.mb-infobtn{transition:background 140ms,border-color 140ms,color 140ms}' +
      '.mb-logrow [data-expand]:hover .mb-infobtn{background:rgba(128,128,140,0.14);border-color:rgba(255,255,255,0.22)}' +
      '@keyframes mb-bar{from{transform:scaleX(0)}}' +
      '.mb-barfill{transform-origin:left center;animation:mb-bar 480ms cubic-bezier(0.32,0.72,0,1) both}' +
      '@keyframes mb-drawer-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}' +
      '.mb-detail{animation:mb-drawer-in 240ms cubic-bezier(0.32,0.72,0,1)}' +
      // v0.32.3 F4: keyboard focus rings on the roving-tabindex rows.
      '.mb-logrow:focus-visible,[data-provhead]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
      '.mb-keyform input::placeholder{color:var(--border-strong)}' +
      // v0.32.3 F5: reduced-motion users get no transform theatrics.
      '@media (prefers-reduced-motion: reduce){' +
      '.mb-pill,.mb-pill:hover,.mb-pill:active,.mb-star,.mb-star:hover,.mb-star:active,' +
      '.mb-chevbtn svg,.mb-hint,.mb-countline,.mb-barfill,.mb-detail{transition:none!important;animation:none!important}' +
      '}';
    document.head.appendChild(s);
  }

  // ── v0.32.3 F1/F2: module-level QUICK-SWITCH API ─────────────────────
  //
  // The chat panel's ★ button needs model resolution WITHOUT opening the
  // overlay. These live at module scope (outside open()) and keep their
  // own small catalog cache (2-min TTL — selection never wants stale
  // key state for longer than that).
  var quickCat = null;
  var quickCatAt = 0;
  var QUICK_TTL = 120000;

  function fetchQuickCatalog(done) {
    if (quickCat && Date.now() - quickCatAt < QUICK_TTL) { done(quickCat); return; }
    fetch('/api/models').then(function (r) { return r.json(); }).then(function (d) {
      quickCat = d || {};
      quickCatAt = Date.now();
      done(quickCat);
    }).catch(function () { done(quickCat || {}); });
  }

  function findLogicalIn(cat, id) {
    var L = (cat && cat.logical) || [];
    for (var i = 0; i < L.length; i++) if (L[i].logical === id) return L[i];
    return null;
  }

  // Hosts sorted by the user's priority order (same rule as open()).
  function quickOrderedHosts(lm) {
    var hosts = (lm.hosts || []).slice();
    var order = (lsGet('hostOrder', {}))[lm.logical];
    if (order && order.length) {
      hosts.sort(function (a, b) {
        var ia = order.indexOf(a.provider); var ib = order.indexOf(b.provider);
        if (ia < 0) ia = 999; if (ib < 0) ib = 999;
        return ia - ib;
      });
    }
    return hosts;
  }

  // F1: MRU recents (max 6 logical ids, newest first).
  function rememberRecent(id) {
    if (!id) return;
    var rec = lsGet('recent', []);
    rec = rec.filter(function (x) { return x !== id; });
    rec.unshift(id);
    if (rec.length > 6) rec.length = 6;
    lsSet('recent', rec);
  }

  // Reverse lookup: which logical model does this provider+modelId belong
  // to? (Used so host-slot and provider-view picks also feed recents.)
  function logicalFor(provider, modelId) {
    var L = (quickCat && quickCat.logical) || [];
    for (var i = 0; i < L.length; i++) {
      var hh = L[i].hosts || [];
      for (var j = 0; j < hh.length; j++) {
        if (hh[j].provider === provider && hh[j].modelId === modelId) return L[i].logical;
      }
    }
    return null;
  }

  // F2: pick a logical model's best KEY-BACKED host (user priority order)
  // without opening the overlay. onFail('nokey', lm) when nothing has a
  // key; onFail('unknown') when the id left the catalog.
  function quickPick(id, onPick, onFail) {
    fetchQuickCatalog(function (cat) {
      var lm = findLogicalIn(cat, id);
      if (!lm) { if (onFail) onFail('unknown'); return; }
      var hosts = quickOrderedHosts(lm);
      var best = null;
      for (var h = 0; h < hosts.length; h++) {
        if (hosts[h].hasApiKey) { best = hosts[h]; break; }
      }
      if (!best) { if (onFail) onFail('nokey', lm); return; }
      rememberRecent(id);
      if (onPick) onPick(best.provider, best.modelId, lm);
    });
  }

  // F2: resolve the recent + starred id lists into display rows:
  //   {id, name, providerLabel, hasKey, isCurrent}
  // opts.current = {provider, modelId} marks the chat's current model.
  function quickEntries(opts, cb) {
    opts = opts || {};
    fetchQuickCatalog(function (cat) {
      var hostOrder = lsGet('hostOrder', {});
      function entry(id) {
        var lm = findLogicalIn(cat, id);
        if (!lm) return null; // left the catalog — drop silently
        var hosts = (lm.hosts || []).slice();
        var order = hostOrder[id];
        if (order && order.length) {
          hosts.sort(function (a, b) {
            var ia = order.indexOf(a.provider); var ib = order.indexOf(b.provider);
            if (ia < 0) ia = 999; if (ib < 0) ib = 999;
            return ia - ib;
          });
        }
        var best = null, cur = false;
        // v0.32.3: state.model is canonical (provider/modelId); the
        // catalog's host modelId may lack that prefix — accept either
        // (same rule as open()'s isCurrentModel).
        var wanted = opts.current && opts.current.modelId ? String(opts.current.modelId) : '';
        for (var i = 0; i < hosts.length; i++) {
          if (!best && hosts[i].hasApiKey) best = hosts[i];
          if (opts.current && hosts[i].provider === opts.current.provider &&
              (hosts[i].modelId === wanted ||
               (hosts[i].provider + '/' + hosts[i].modelId) === wanted ||
               lm.logical === wanted)) cur = true;
        }
        // v0.32.6 F1: price chip for the BEST key-backed route — free /
        // "$X.XX/M" (prompt price) / null when the provider hides pricing.
        var price = null;
        if (best) {
          if (best.isFree) price = 'free';
          else {
            var ppm = String(best.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
            if (ppm) price = '$' + ppm[1] + '/M';
          }
        }
        return {
          id: id,
          name: lm.displayName || lm.logical,
          provider: best ? best.provider : null,
          providerLabel: best ? (best.providerDisplayName || best.provider) : 'no key',
          hasKey: !!best,
          isCurrent: cur,
          price: price
        };
      }
      cb({
        recent: lsGet('recent', []).map(entry).filter(Boolean),
        starred: lsGet('starred', []).map(entry).filter(Boolean)
      });
    });
  }

  // v0.32.1 F: Esc closes the overlay. v0.32.2 C: "/" focuses search.
  // (Bound once per page.)
  var escBound = false;
  function bindEscOnce() {
    if (escBound) return;
    escBound = true;
    document.addEventListener('keydown', function (e) {
      if (!window.ConnectOverlay || !window.ConnectOverlay.isOpen()) return;
      if (e.key === 'Escape') {
        window.ConnectOverlay.close();
      } else if (e.key === '/') {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
        var si = window.ConnectOverlay.getContentEl().querySelector('#mb-search');
        if (si) { e.preventDefault(); si.focus(); }
      }
    });
  }

  function open(onPick, opts) {
    opts = opts || {};
    ensureStyles();
    bindEscOnce();

    // Mutable UI state (persisted where it makes sense).
    var view = lsGet('view', 'providers');
    var search = '';
    var filters = lsGet('filters', []);
    var filtersOpen = lsGet('filtersOpen', false);
    var ctxMin = lsGet('ctxMin', 0);
    var pricing = lsGet('pricing', 'all');
    var providerOrder = lsGet('providerOrder', null);
    var providerExpanded = lsGet('providerExpanded', {});
    var hostOrder = lsGet('hostOrder', {});
    var expandedLogical = {};
    var infoOpen = {}; // v0.32.4 F2: transient per-session detail drawers
    var comparePair = []; // v0.32.5 F2: 0–2 logical ids pinned for compare
    var sortKey = lsGet('sort', 'best');
    var currentModel = (opts && opts.current) || null; // {provider, modelId}
    var keyAdding = null; // provider name whose inline key form is open
    var starred = lsGet('starred', []); // v0.32.2 A: logical/family ids

    // Catalog data.
    var catalog = null;
    var famBm = {};      // family → benchmarks (for provider-view pills)
    var syncedAt = 0;
    var syncing = false;
    var opened = false;

    fetchCatalog(false, function () { render(); });

    function fetchCatalog(refresh, done) {
      var url = '/api/models' + (refresh ? '?refresh=1' : '');
      if (refresh) syncing = true;
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        catalog = d || {};
        quickCat = catalog; // v0.32.3: keep the module-level quick cache warm
        quickCatAt = Date.now();
        buildFamBm();
        syncedAt = Date.now();
        syncing = false;
        if (done) done();
      }).catch(function (e) {
        console.error('model browser fetch failed', e);
        catalog = catalog || {};
        syncing = false;
        if (done) done();
      });
    }

    function buildFamBm() {
      famBm = {};
      var logical = (catalog && catalog.logical) || [];
      for (var i = 0; i < logical.length; i++) {
        var fam = logical[i].family || logical[i].logical;
        var bm = (logical[i].attributes || {}).benchmarks;
        if (fam && bm) famBm[fam] = bm;
      }
    }

    // ── Rendering ───────────────────────────────────────────────────────

    function render() {
      // v0.32.6 F4: the search + filter toggle (+ collapsed active-filter
      // chips) ride in a STICKY bar — they stay reachable while the user
      // scrolls a 500-row list (web-researched best practice: sticky
      // filters beat scroll-away headers; only a minority of products do
      // it). The expanded pill grid deliberately does NOT stick (it would
      // eat half a phone screen). z-index 30: above the rows, BELOW the
      // DnD ghost (z 40) so a dragged row still tracks the finger over it.
      var html =
        '<div style="padding:16px 16px 24px">' +
        header() +
        '<div class="mb-stickybar" style="position:sticky;top:0;z-index:30;margin:0 -16px;padding:10px 16px 8px;background:var(--surface-1);border-bottom:1px solid var(--surface-2);box-shadow:0 8px 14px -8px rgba(0,0,0,0.45)">' +
        searchBox() +
        filterToggleRow() +
        '</div>' +
        (filtersOpen ? filterRow() : '') +
        (view === 'providers' ? providerView() : modelsView()) +
        footer() +
        '</div>';

      // v0.32.2 C: the debounced re-render replaces the search input —
      // remember focus + caret and restore them after the swap, so typing
      // through a 200ms pause doesn't lose the caret (the old behaviour).
      // v0.32.3 F4: ALSO remember a focused keyboard row — a background
      // re-render (search debounce, catalog sync) must not strand a
      // keyboard user on <body>.
      var keepFocus = false, caret = 0;
      var kbRefocusSel = null; // row selector to refocus after the swap
      var kbRefocusRow = true; // v0.32.4: rows get the roving rewrite; the ℹ button just refocuses
      if (opened) {
        var oldEl = window.ConnectOverlay.getContentEl();
        var oldSi = oldEl && oldEl.querySelector('#mb-search');
        if (oldSi && oldSi === document.activeElement) {
          keepFocus = true;
          caret = oldSi.selectionStart;
          if (typeof caret !== 'number') caret = oldSi.value.length;
        } else if (oldEl && document.activeElement) {
          var ae = document.activeElement;
          if (ae.classList && ae.classList.contains('mb-logrow') && ae.dataset.logicalId) {
            kbRefocusSel = '.mb-logrow[data-logical-id="' + String(ae.dataset.logicalId).replace(/"/g, '\\"') + '"]';
          } else if (ae.hasAttribute && ae.hasAttribute('data-provhead') && ae.dataset.provhead) {
            kbRefocusSel = '[data-provhead="' + String(ae.dataset.provhead).replace(/"/g, '\\"') + '"]';
          } else if (ae.hasAttribute && ae.hasAttribute('data-info') && ae.dataset.info) {
            // v0.32.4 F2: the ℹ toggle keeps focus through the re-render.
            kbRefocusSel = '[data-info="' + String(ae.dataset.info).replace(/"/g, '\\"') + '"]';
            kbRefocusRow = false;
          } else if (ae.hasAttribute && ae.hasAttribute('data-compare') && ae.dataset.compare) {
            // v0.32.5 F2: the ⚖ toggle keeps focus through the re-render.
            kbRefocusSel = '[data-compare="' + String(ae.dataset.compare).replace(/"/g, '\\"') + '"]';
            kbRefocusRow = false;
          }
        }
      }

      if (!opened) {
        if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
          window.ConnectOverlay.replaceContent(html, { onSwap: wireEvents });
        } else {
          window.ConnectOverlay.open(html, { onSwap: wireEvents });
        }
        opened = true;
        bindKeyboardNav(); // v0.32.3 F4: one keydown binding per open()
      } else {
        var contentEl = window.ConnectOverlay.getContentEl();
        contentEl.innerHTML = html;
        wireEvents();
      }

      if (keepFocus) {
        var newSi = window.ConnectOverlay.getContentEl().querySelector('#mb-search');
        if (newSi) {
          newSi.focus();
          try { newSi.setSelectionRange(caret, caret); } catch (e) {}
        }
      } else if (kbRefocusSel) {
        var kbRow = window.ConnectOverlay.getContentEl().querySelector(kbRefocusSel);
        if (kbRow) {
          if (kbRefocusRow) {
            // keep exactly one tab stop (roving tabindex) and stay focused
            var kbRows = window.ConnectOverlay.getContentEl().querySelectorAll(
              view === 'providers' ? '[data-provhead]' : '.mb-logrow[data-logical-id]');
            for (var k = 0; k < kbRows.length; k++) kbRows[k].tabIndex = -1;
            kbRow.tabIndex = 0;
          }
          kbRow.focus();
        }
      }
    }

    // v0.32.3 F4: keyboard navigation (roving tabindex, WAI-APG).
    // Arrows move focus among the logical rows (models view) or provider
    // box headers (providers view); Enter/Space selects or toggles;
    // ArrowRight/Left expand/collapse; Home/End jump to the ends; the
    // search box's ArrowDown drops into the list. el.focus() scrolls the
    // newly focused row into view — the APG's roving-tabindex benefit.
    var kbBound = false;
    function bindKeyboardNav() {
      if (kbBound) return;
      kbBound = true;
      var contentEl = window.ConnectOverlay.getContentEl();
      function visibleKbRows() {
        var sel = view === 'providers' ? '[data-provhead]' : '.mb-logrow[data-logical-id]';
        var els = contentEl.querySelectorAll(sel);
        var out = [];
        for (var i = 0; i < els.length; i++) {
          if (els[i].offsetParent !== null) out.push(els[i]);
        }
        return out;
      }
      function focusKbRow(el) {
        if (!el || !el.offsetParent) return;
        var rows = visibleKbRows();
        for (var i = 0; i < rows.length; i++) rows[i].tabIndex = -1;
        el.tabIndex = 0; // the roving tab stop follows the keyboard focus
        el.focus();
      }
      function refocusAfterRender(selector) {
        var again = contentEl.querySelector(selector);
        if (again) focusKbRow(again);
      }
      contentEl.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
          if (t.id === 'mb-search' && e.key === 'ArrowDown') {
            var r0 = visibleKbRows()[0];
            if (r0) { e.preventDefault(); focusKbRow(r0); }
          }
          return; // typing in the search box owns every other key
        }
        var rows = visibleKbRows();
        if (!rows.length) return;
        var row = (t && t.classList && (t.classList.contains('mb-logrow') || t.hasAttribute('data-provhead'))) ? t : null;
        if (!row) return; // inner controls (stars, ▲▼, pills) keep their keys
        var idx = rows.indexOf(row);
        if (idx < 0) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          var next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
          if (next < 0) next = rows.length - 1;
          if (next >= rows.length) next = 0;
          focusKbRow(rows[next]);
        } else if (e.key === 'Home') {
          e.preventDefault();
          focusKbRow(rows[0]);
        } else if (e.key === 'End') {
          e.preventDefault();
          focusKbRow(rows[rows.length - 1]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (view === 'providers') {
            var name = row.dataset.provhead;
            providerExpanded[name] = !providerExpanded[name];
            lsSet('providerExpanded', providerExpanded);
            render();
            refocusAfterRender('[data-provhead="' + (name && name.replace(/"/g, '\\"')) + '"]');
          } else {
            selectLogical(row.dataset.logicalId);
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (view === 'providers') {
            var pn = row.dataset.provhead;
            if (!providerExpanded[pn]) {
              providerExpanded[pn] = true;
              lsSet('providerExpanded', providerExpanded);
              render();
              refocusAfterRender('[data-provhead="' + (pn && pn.replace(/"/g, '\\"')) + '"]');
            }
          } else {
            var lid = row.dataset.logicalId;
            if (!expandedLogical[lid]) {
              expandedLogical[lid] = true;
              render();
              refocusAfterRender('.mb-logrow[data-logical-id="' + (lid && lid.replace(/"/g, '\\"')) + '"]');
            }
          }
        } else if ((e.key === 'i' || e.key === 'I') && view !== 'providers') {
          // v0.32.4 F2: "i" toggles the detail drawer on the focused row.
          e.preventDefault();
          var ilid = row.dataset.logicalId;
          if (infoOpen[ilid]) delete infoOpen[ilid]; else infoOpen[ilid] = true;
          render();
          refocusAfterRender('.mb-logrow[data-logical-id="' + (ilid && ilid.replace(/"/g, '\\"')) + '"]');
        } else if ((e.key === 'c' || e.key === 'C') && view !== 'providers') {
          // v0.32.5 F2: "c" toggles the compare pin on the focused row.
          e.preventDefault();
          var cl2 = row.dataset.logicalId;
          toggleComparePin(cl2);
          render();
          refocusAfterRender('.mb-logrow[data-logical-id="' + (cl2 && cl2.replace(/"/g, '\\"')) + '"]');
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (view === 'providers') {
            var cn = row.dataset.provhead;
            if (providerExpanded[cn]) {
              delete providerExpanded[cn];
              lsSet('providerExpanded', providerExpanded);
              render();
              refocusAfterRender('[data-provhead="' + (cn && cn.replace(/"/g, '\\"')) + '"]');
            }
          } else {
            var clid = row.dataset.logicalId;
            if (expandedLogical[clid]) {
              delete expandedLogical[clid];
              render();
              refocusAfterRender('.mb-logrow[data-logical-id="' + (clid && clid.replace(/"/g, '\\"')) + '"]');
            }
          }
        }
      });
    }

    function header() {
      var isProv = view === 'providers';
      return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<h2 style="font-size: calc(var(--ui-fs) + 3px);font-weight:600;color:var(--text-1);margin:0;flex:1">Select a model</h2>' +
        // View toggle (the two "tabs")
        '<div style="display:flex;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:3px">' +
          '<button id="mb-view-providers" class="mb-viewtab' + (isProv ? ' dd-active-tab' : '') + '" style="--dd-accent:var(--ok);background:transparent;border:none;color:' + (isProv ? 'var(--text-1)' : 'var(--text-3)') + ';font-size:12px;font-weight:600;font-family:inherit;padding:6px 12px;border-radius:8px;cursor:pointer;position:relative">Providers</button>' +
          '<button id="mb-view-models" class="mb-viewtab' + (!isProv ? ' dd-active-tab' : '') + '" style="--dd-accent:var(--accent);background:transparent;border:none;color:' + (!isProv ? 'var(--text-1)' : 'var(--text-3)') + ';font-size:12px;font-weight:600;font-family:inherit;padding:6px 12px;border-radius:8px;cursor:pointer;position:relative">Models</button>' +
        '</div>' +
        '<button id="mb-close" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;padding:2px 6px">✕</button>' +
        '</div>' +
        // Sync line + refresh
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
        '<button id="mb-refresh" style="display:flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:11px;font-family:inherit;padding:5px 10px;border-radius:8px;cursor:pointer;touch-action:manipulation">' +
        '<span id="mb-refresh-icon" style="display:inline-block;' + (syncing ? 'animation:mb-spin 0.9s linear infinite' : '') + '">⟳</span>' +
        '<span id="mb-sync-label">' + syncLabel() + '</span></button>' +
        '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--border-strong);flex:1;text-align:right">' + liveCount() + ' providers live · ' + totalModels() + ' models</span>' +
        '</div>';
    }

    function syncLabel() {
      if (syncing) return 'syncing…';
      if (!syncedAt) return 'sync now';
      var s = Math.max(0, Math.floor((Date.now() - syncedAt) / 1000));
      if (s < 60) return 'synced ' + s + 's ago';
      var m = Math.floor(s / 60);
      if (m < 60) return 'synced ' + m + 'm ago';
      return 'synced ' + Math.floor(m / 60) + 'h ago';
    }

    function liveCount() {
      var groups = (catalog && catalog.groups) || [];
      var live = 0;
      for (var i = 0; i < groups.length; i++) if (groups[i].syncedLive) live++;
      return live + '/' + groups.length;
    }

    function totalModels() {
      return (catalog && catalog.totalModels) || 0;
    }

    function searchBox() {
      return '<div style="margin-bottom:10px">' +
        '<input id="mb-search" type="text" inputmode="search" autocomplete="off" spellcheck="false" aria-label="Search models" placeholder="Search models, providers, capabilities…" value="' + escAttr(search) + '" style="width:100%;box-sizing:border-box;background:var(--bg-app);border:1px solid var(--border);color:var(--text-1);padding:10px 12px;border-radius:10px;font-size:13px;font-family:inherit;outline:none" />' +
        '</div>';
    }

    // ── v0.32: the collapsible filter bar ───────────────────────────────

    function activeFilterCount() {
      var n = filters.length;
      if (ctxMin > 0) n++;
      if (pricing !== 'all') n++;
      return n;
    }

    function filterToggleRow() {
      var n = activeFilterCount();
      var badge = n
        ? '<span style="font-size:10px;font-weight:700;color:#10b981;background:rgba(16,185,129,0.14);border:1px solid rgba(16,185,129,0.45);padding:2px 8px;border-radius:6px;flex-shrink:0">' + n + ' on</span>'
        : '';
      var funnel = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M3 5h18l-7 8.2V19l-4 2v-7.8L3 5z"/></svg>';
      var toggle = '<button id="mb-filters-toggle" style="flex:1;min-width:0;box-sizing:border-box;display:flex;align-items:center;gap:9px;background:var(--surface-1);border:1px solid ' + (n ? 'rgba(16,185,129,0.5)' : 'var(--surface-2)') + ';color:' + (n ? 'var(--text-1)' : 'var(--text-3)') + ';padding:9px 12px;border-radius:10px;cursor:pointer;font-family:inherit;touch-action:manipulation;transition:border-color 150ms">' +
        funnel +
        '<span style="font-size:12.5px;font-weight:600;flex:1;text-align:left;overflow:hidden;white-space:nowrap">Filters</span>' +
        badge +
        '<span style="display:inline-flex;transition:transform 240ms ' + EASE + ';transform:rotate(' + (filtersOpen ? '180deg' : '0deg') + ');color:var(--text-3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>' +
        '</button>';
      // The clear control sits BESIDE the toggle (a button can't nest a
      // button — the parser would break the structure).
      var clearHTML = (filters.length || ctxMin || pricing !== 'all' || search)
        ? '<button id="mb-clear" title="reset all filters" style="flex:0 0 auto;background:transparent;border:1px solid rgba(var(--err-rgb),0.35);color:var(--err);font-size:11px;padding:0 12px;border-radius:10px;font-family:inherit;cursor:pointer;flex-shrink:0">clear</button>'
        : '';
      var out = '<div style="display:flex;gap:8px;align-items:stretch;margin-bottom:' + (filtersOpen ? '8px' : '0') + '">' + toggle + clearHTML + '</div>';
      // v0.32.6 F3: with the pills collapsed but filters ACTIVE, show the
      // active ones as removable chips — the user sees WHAT is filtering
      // the list without expanding, and can drop a single filter with one
      // tap (the standard applied-filters pattern; web-researched).
      if (!filtersOpen) out += collapsedFilterChips();
      return out;
    }

    // v0.32.6 F3: one removable chip per active filter (collapsed state).
    function collapsedFilterChips() {
      if (!activeFilterCount()) return '';
      var chip = function (label, color, attrVal) {
        return '<button data-unfilter="' + escAttr(attrVal) + '" class="mb-ufchip" title="remove this filter" style="display:inline-flex;align-items:center;gap:5px;background:' + color + '1c;border:1px solid ' + color + '80;color:' + color + ';font-size:10.5px;font-weight:600;padding:4px 8px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation;flex-shrink:0">' +
          escHTML(label) +
          '<span style="font-size:9px;opacity:0.85;line-height:1">✕</span></button>';
      };
      var chips = '';
      for (var i = 0; i < filters.length; i++) {
        var def = null;
        for (var p = 0; p < PILLS.length; p++) if (PILLS[p].key === filters[i]) { def = PILLS[p]; break; }
        if (def) chips += chip(def.label, def.color, 'pill:' + def.key);
      }
      if (ctxMin > 0) {
        for (var c = 0; c < CTX_OPTIONS.length; c++) {
          if (CTX_OPTIONS[c].v === ctxMin) { chips += chip(CTX_OPTIONS[c].label + '+', '#14b8a6', 'ctx:' + ctxMin); break; }
        }
      }
      if (pricing !== 'all') {
        for (var pr = 0; pr < PRICING_OPTIONS.length; pr++) {
          if (PRICING_OPTIONS[pr].key === pricing) { chips += chip(PRICING_OPTIONS[pr].label, PRICING_OPTIONS[pr].color, 'pricing:' + pricing); break; }
        }
      }
      if (!chips) return '';
      return '<div style="display:flex;flex-wrap:wrap;gap:5px;padding:7px 0 2px">' + chips + '</div>';
    }

    // Squared, uniform, grid-like pills — a real CSS grid: every cell the
    // same width, rows aligned, wrapping naturally, NO horizontal scroll
    // (v0.32 spec #2).
    function squaredPill(attr, label, color, on) {
      return '<button ' + attr + ' class="mb-pill" aria-pressed="' + (on ? 'true' : 'false') + '" style="display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap;background:' + (on ? color + '22' : 'transparent') + ';border:1px solid ' + (on ? color + '99' : 'var(--border)') + ';color:' + (on ? color : 'var(--text-3)') + ';font-size:11px;font-weight:600;padding:7px 4px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation">' + label + '</button>';
    }

    function filterRow() {
      var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px;padding:2px 0 4px;margin-bottom:8px">';
      // Capability + availability pills.
      for (var i = 0; i < PILLS.length; i++) {
        var p = PILLS[i];
        var on = filters.indexOf(p.key) >= 0;
        html += squaredPill('data-pill="' + p.key + '"', p.label, p.color, on);
      }
      // Context pills.
      for (var c = 0; c < CTX_OPTIONS.length; c++) {
        var co = CTX_OPTIONS[c];
        var onC = ctxMin === co.v;
        html += squaredPill('data-ctx="' + co.v + '"', co.label, '#14b8a6', onC);
      }
      // Pricing pills (self-cancelling toggles — no "Any $").
      for (var pr = 0; pr < PRICING_OPTIONS.length; pr++) {
        var po = PRICING_OPTIONS[pr];
        var onP = pricing === po.key;
        html += squaredPill('data-pricing="' + po.key + '"', po.label, po.color, onP);
      }
      html += '</div>';
      return html;
    }

    // ── Providers view ──────────────────────────────────────────────────

    function orderedGroups() {
      var groups = ((catalog && catalog.groups) || []).slice();
      if (providerOrder) {
        groups.sort(function (a, b) {
          var ia = providerOrder.indexOf(a.name); var ib = providerOrder.indexOf(b.name);
          if (ia < 0) ia = 999; if (ib < 0) ib = 999;
          return ia - ib;
        });
      }
      return groups;
    }

    function providerView() {
      var groups = orderedGroups();
      var availOnly = filters.indexOf('available') >= 0;
      var out = '';
      var shown = 0, ready = 0;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].hasApiKey) ready++;
        // "Available" hides keyless providers' boxes entirely (their models
        // are all filtered out anyway).
        // v0.32.1 A BUGFIX: the API field is hasApiKey — `hasKey` is
        // undefined, so this check used to skip EVERY box when the filter
        // was on ("No providers with API keys yet" with 2 keys set).
        if (availOnly && !groups[i].hasApiKey) continue;
        out += providerBox(groups[i], shown === 0);
        shown++;
      }
      if (!groups.length) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size: calc(var(--ui-fs) - 1px)">Syncing providers…</div>';
      } else if (availOnly && !out) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size: calc(var(--ui-fs) - 1px)">No providers with API keys yet — paste a key to unlock them.</div>';
      }
      // v0.32.1 C: live counts line.
      var counts = groups.length
        ? '<div class="mb-countline" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3)"><span>' + shown + ' of ' + groups.length + ' providers</span><span style="color:' + (ready ? 'var(--ok)' : 'var(--text-3)') + ';font-weight:600">' + ready + ' ready</span></div>'
        : '';
      return counts + '<div id="mb-provlist" style="display:flex;flex-direction:column;gap:10px">' + out + '</div>';
    }

    function providerBox(g, kbFirst) {
      var expanded = !!providerExpanded[g.name];
      var matching = [];
      var filteredOut = 0;
      var models = g.models || [];
      for (var i = 0; i < models.length; i++) {
        if (modelMatches(models[i], g)) matching.push(models[i]);
        else filteredOut++;
      }
      var liveDot = g.syncedLive ? '<span class="dd-live-dot" title="synced live from provider API"></span>' : '<span class="dd-live-dot dd-stale" title="no live sync"></span>';
      // v0.32 #5: explicit availability badge + dimming (view-only vs ready).
      // v0.32.1 (VLM review): view-only gets a bg fill so it reads as a badge,
      // not disabled text.
      var keyBadge = g.hasApiKey
        ? '<span style="font-size:10px;font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.4);padding:2px 8px;border-radius:5px;flex-shrink:0;white-space:nowrap">ready</span>'
        : '<span style="font-size:10px;font-weight:600;color:var(--text-2,var(--text-3));background:rgba(128,128,140,0.12);border:1px dashed var(--border-strong);padding:2px 8px;border-radius:5px;flex-shrink:0;white-space:nowrap">view only</span>';
      var chevron = expanded ? '▾' : '▸';
      // v0.32 #8: grip — instant drag handle on the box.
      var grip = '<span data-grip data-nodrag title="drag to re-order providers" style="cursor:grab;color:var(--text-3);width:26px;height:26px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:7px;touch-action:none;font-size:13px;line-height:1">⠿</span>';
      // v0.32.1 D: one-tap key unlock on view-only boxes.
      var addKeyBtn = (!g.hasApiKey && g.envVar)
        ? '<button data-addkey="' + escAttr(g.name) + '" data-nodrag title="paste an API key for ' + escAttr(g.displayName || g.name) + '" style="background:rgba(var(--ok-rgb),0.10);border:1px solid rgba(var(--ok-rgb),0.45);color:var(--ok);font-size:10px;font-weight:700;padding:3px 9px;border-radius:6px;flex-shrink:0;white-space:nowrap;cursor:pointer;font-family:inherit;touch-action:manipulation">＋ key</button>'
        : '';

      var rows = '';
      for (var m = 0; m < matching.length; m++) {
        rows += providerModelRow(g, matching[m]);
      }
      if (filteredOut > 0 && expanded) {
        rows += '<div style="padding:8px 12px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--border-strong);opacity:0.8">▸ ' + filteredOut + ' filtered out</div>';
      }

      var dim = g.hasApiKey ? '' : 'opacity:0.6;filter:saturate(0.5);';
      // v0.32.4 F3: expanded detail strip — the catalog's description of the
      // provider + free-tier chip + a "get a key ↗" deep link for keyless
      // boxes (answers WHERE to get a key, right where it matters).
      var detailStrip = '';
      if (expanded) {
        var strip =
          '<div style="padding:10px 14px;border-top:1px solid var(--surface-2);background:rgba(0,0,0,0.14);display:flex;flex-direction:column;gap:7px">';
        if (g.description) {
          strip += '<div style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2);line-height:1.45">' + escHTML(g.description) + '</div>';
        }
        var chips = '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">';
        if (g.freeTier) {
          chips += '<span style="font-size: calc(var(--ui-small-fs) - 2px);font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.10);border:1px solid rgba(var(--ok-rgb),0.4);padding:2px 8px;border-radius:5px;white-space:nowrap">free tier</span>';
        }
        if (g.envVar) {
          chips += '<span title="environment variable for the API key" style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);background:var(--surface-2);border:1px solid var(--border);padding:2px 8px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap">' + escHTML(g.envVar) + '</span>';
        }
        if (!g.hasApiKey && g.settingsUrl) {
          chips += '<a href="' + escAttr(g.settingsUrl) + '" target="_blank" rel="noopener noreferrer" data-nodrag title="open the provider\'s key page" style="font-size: calc(var(--ui-small-fs) - 2px);font-weight:700;color:var(--accent-2);background:rgba(var(--accent-2-rgb),0.10);border:1px solid rgba(var(--accent-2-rgb),0.4);padding:2px 8px;border-radius:5px;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:4px">get a key ↗</a>';
        }
        chips += '</div>';
        if (g.description || g.freeTier || g.envVar || (!g.hasApiKey && g.settingsUrl)) {
          strip += chips + '</div>';
          detailStrip = strip;
        }
      }
      // v0.32.1 D: the inline paste-a-key form (opened by the ＋ key button).
      var keyForm = '';
      if (keyAdding === g.name && !g.hasApiKey && g.envVar) {
        keyForm = '<div class="mb-keyform" data-keyform data-nodrag style="display:flex;gap:8px;align-items:center;padding:10px 12px;border-top:1px solid var(--surface-2);background:rgba(var(--ok-rgb),0.04)">' +
          '<input data-keyinput type="password" placeholder="' + escAttr(g.envVar) + '" autocomplete="off" spellcheck="false" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--surface-2);color:var(--text-1);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 10px;border-radius:8px;outline:none" />' +
          '<button data-keysave="' + escAttr(g.name) + '" data-nodrag style="background:var(--ok);border:none;color:#08240f;font-size:11px;font-weight:700;padding:8px 12px;border-radius:8px;cursor:pointer;font-family:inherit;white-space:nowrap">Save</button>' +
          '<button data-keycancel data-nodrag title="cancel" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:11px;padding:8px 10px;border-radius:8px;cursor:pointer;font-family:inherit">✕</button>' +
          '</div>';
      }
      return '<div class="mb-provbox" data-prov="' + escAttr(g.name) + '" style="background:var(--surface-1);border:1px solid ' + (expanded ? 'rgba(255,255,255,0.14)' : 'var(--surface-2)') + ';border-radius:12px;overflow:hidden;--dd-accent:' + (g.color || 'var(--ok)') + ';' + dim + 'transition:opacity 200ms,filter 200ms">' +
        '<div data-provhead="' + escAttr(g.name) + '" role="button" tabindex="' + (kbFirst ? 0 : -1) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" style="display:flex;align-items:center;gap:9px;padding:12px 14px;cursor:pointer;touch-action:manipulation">' +
          '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);flex-shrink:0">' + chevron + '</span>' +
          '<span style="width:10px;height:10px;border-radius:50%;background:' + (g.color || 'var(--border-strong)') + ';flex-shrink:0"></span>' +
          '<span style="font-size: var(--ui-fs);font-weight:600;color:var(--text-1);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(g.displayName || g.name) + '</span>' +
          keyBadge +
          addKeyBtn +
          liveDot +
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);flex-shrink:0">' + (g.modelCount || 0) + '</span>' +
          grip +
        '</div>' +
        keyForm +
        detailStrip +
        (expanded ? '<div style="max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid var(--surface-2)">' + (rows || '<div style="padding:16px;font-size: var(--ui-small-fs);color:var(--text-3);text-align:center">no models match' + (g.hasApiKey ? '' : ' — no API key (view only)') + '</div>') + '</div>' : '') +
        '</div>';
    }

    function providerModelRow(g, m) {
      var ctx = fmtCtx(m.contextLength);
      // v0.32.5 F3: real price chip — parse the provider's own pricing
      // string (prompt price per M tokens); bare "paid" only as fallback.
      var priceChip;
      if (m.isFree) {
        priceChip = '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:#22c55e;background:rgba(34,197,94,0.12);padding:2px 7px;border-radius:4px;flex-shrink:0;font-variant-numeric:tabular-nums">free</span>';
      } else {
        var ppm = String(m.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
        priceChip = ppm
          ? '<span title="' + escAttr(m.pricing) + '" style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--warn);background:rgba(var(--warn-rgb),0.1);padding:2px 7px;border-radius:4px;flex-shrink:0;font-variant-numeric:tabular-nums">$' + ppm[1] + '/M</span>'
          : '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--warn);background:rgba(var(--warn-rgb),0.1);padding:2px 7px;border-radius:4px;flex-shrink:0">paid</span>';
      }
      var caps = (m.capabilities || []).length ? '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:var(--text-3);flex-shrink:0;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (m.capabilities || []).join('·') + '</span>' : '';
      // v0.32.2 A: star the FAMILY (logical id) — same list as models view.
      var star = m.family ? starBtnHtml(m.family) : '';
      return '<div data-slot="' + escAttr(m.id) + '" data-nodrag style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;touch-action:manipulation;min-height:36px">' +
        '<span style="width:6px;height:6px;border-radius:50%;border:1.5px solid #a855f7;flex-shrink:0"></span>' +
        '<span title="' + escAttr(m.displayName || m.rawId) + '" style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-1);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(m.displayName || m.rawId) + '</span>' +
        star +
        caps +
        '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);flex-shrink:0;min-width:34px;text-align:right">' + ctx + '</span>' +
        priceChip +
        '</div>';
    }

    // v0.32.2 A: the star toggle button (rendered per row).
    function starBtnHtml(key) {
      var on = starred.indexOf(key) >= 0;
      return '<button data-star="' + escAttr(key) + '" data-nodrag class="mb-star" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + (on ? 'unstar this model' : 'star this model') + '" style="background:' + (on ? 'rgba(234,179,8,0.12)' : 'transparent') + ';border:1px solid ' + (on ? 'rgba(234,179,8,0.45)' : 'transparent') + ';color:' + (on ? '#eab308' : 'var(--border-strong)') + ';width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:7px;flex-shrink:0;cursor:pointer;font-size:13px;padding:0;line-height:1;font-family:inherit;touch-action:manipulation">★</button>';
    }

    // ── Models view (logical, all providers combined) ────────────────────

    // v0.32.3 F5: friendly zero-result state (search or filters).
    function emptyStateHtml() {
      var hasSearch = !!search;
      var hasFilters = filters.length > 0 || pricing !== 'all' || ctxMin > 0;
      var h = '<div style="text-align:center;padding:36px 20px">' +
        '<div style="font-size:26px;color:var(--text-3);margin-bottom:8px">⌕</div>' +
        '<div style="font-size:calc(var(--ui-fs) - 1px);font-weight:600;color:var(--text-1);margin-bottom:4px">No models match</div>' +
        '<div style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin-bottom:14px">' +
        (hasSearch && hasFilters ? 'the search and filters together hide everything' : (hasSearch ? 'nothing matches the search' : 'the filters hide everything')) +
        '</div>';
      if (hasSearch) h += '<button data-emptyclear="search" style="background:var(--surface-1);border:1px solid var(--border);color:var(--text-1);font-family:inherit;font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;cursor:pointer;margin:0 3px">Clear search</button>';
      if (hasFilters) h += '<button data-emptyclear="filters" style="background:var(--surface-1);border:1px solid var(--border);color:var(--text-1);font-family:inherit;font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;cursor:pointer;margin:0 3px">Clear filters</button>';
      h += '</div>';
      return h;
    }

    function modelsView() {
      var logical = ((catalog && catalog.logical) || []).slice();
      var matching = [];
      for (var i = 0; i < logical.length; i++) {
        if (logicalMatches(logical[i])) matching.push(logical[i]);
      }
      // v0.32.1 B: explicit sort (pills still re-rank under 'best').
      applySort(matching);
      var out = '';
      // v0.32.2 D: friendly empty state when Starred is on but nothing is
      // starred yet. (The starred filter empties the list anyway; this
      // replaces it with an actionable hint instead of just "N hidden".)
      var starredEmpty = filters.indexOf('starred') >= 0 && !starred.length;
      if (starredEmpty) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:calc(var(--ui-fs) - 1px)">No starred models yet — tap the <span style="color:#eab308">★</span> on a model to pin it here.</div>';
      } else if (!matching.length) {
        // v0.32.3 F5: friendly zero-result state (search or filters)
        out = emptyStateHtml();
      }
      for (var l = 0; l < matching.length; l++) {
        out += logicalRow(matching[l], l === 0);
      }
      var hidden = logical.length - matching.length;
      if (hidden > 0 && !starredEmpty) {
        out += '<div data-clearall title="clear all filters" style="padding:10px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--border-strong);text-align:center;cursor:pointer">' + hidden + ' models hidden by filters · <span style="color:var(--accent);text-decoration:underline">clear</span></div>';
      }
      if (!logical.length) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size: calc(var(--ui-fs) - 1px)">Syncing models…</div>';
      }
      // v0.32.1 C: live counts — "X of Y models · Z with your keys".
      var withKeys = 0;
      for (var wk = 0; wk < matching.length; wk++) {
        var wkHosts = matching[wk].hosts || [];
        for (var hh = 0; hh < wkHosts.length; hh++) {
          if (wkHosts[hh].hasApiKey) { withKeys++; break; }
        }
      }
      var counts = logical.length
        ? '<div class="mb-countline" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3)"><span>' + matching.length + ' of ' + logical.length + ' models</span><span style="color:' + (withKeys ? 'var(--ok)' : 'var(--text-3)') + ';font-weight:600">' + withKeys + ' with your keys</span></div>'
        : '';
      // v0.32.5 F2: compare drawer (pair complete) or the pin hint (one
      // pinned, waiting for the second). Rendered above the list.
      var cmp = '';
      if (comparePair.length === 2) {
        cmp = compareDrawer(comparePair[0], comparePair[1]);
      } else if (comparePair.length === 1) {
        var pl = null;
        for (var pc = 0; pc < logical.length; pc++) {
          if (logical[pc].logical === comparePair[0]) { pl = logical[pc]; break; }
        }
        if (pl) {
          cmp = '<div data-nodrag style="display:flex;align-items:center;gap:8px;border:1px dashed rgba(var(--accent-rgb),0.45);border-radius:10px;padding:8px 12px;margin-bottom:10px;background:rgba(var(--accent-rgb),0.05)">' +
            '<span style="font-size:11px;color:var(--accent);flex-shrink:0">⚖</span>' +
            '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="color:var(--text-1)">' + escHTML(pl.displayName || pl.logical) + '</b> pinned — tap ⚖ on another model</span>' +
            '<button data-cmpclose data-nodrag title="unpin" aria-label="unpin compare" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:10px;width:20px;height:20px;border-radius:6px;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0">✕</button>' +
            '</div>';
        }
      }
      return sortControl() + counts + cmp + '<div style="display:flex;flex-direction:column;gap:6px">' + out + '</div>';
    }

    // v0.32.1 B: the sort control — a compact native select (mobile-friendly,
    // accessible, no custom dropdown to maintain). Persisted as .sort.
    function sortControl() {
      var opts = '';
      for (var i = 0; i < SORTS.length; i++) {
        opts += '<option value="' + SORTS[i].key + '"' + (sortKey === SORTS[i].key ? ' selected' : '') + '>' + SORTS[i].label + '</option>';
      }
      return '<div style="display:flex;align-items:center;gap:8px;margin:0 0 8px">' +
        '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);flex-shrink:0">Sort</span>' +
        '<select id="mb-sort" aria-label="sort models" style="flex:1;min-width:0;background:var(--surface-1);border:1px solid var(--surface-2);color:var(--text-1);font-size: calc(var(--ui-small-fs) - 1px);font-family:inherit;padding:6px 8px;border-radius:8px;cursor:pointer">' + opts + '</select>' +
        '</div>';
    }

    // v0.32.1 B: sort implementations. 'best' keeps the pill-scoring rank
    // (filterScore); the rest are explicit. Ties break alphabetically.
    function applySort(list) {
      var k = sortKey;
      if (k === 'best') {
        var hasScoring = false;
        for (var s = 0; s < SCORING_KEYS.length; s++) {
          if (filters.indexOf(SCORING_KEYS[s]) >= 0) { hasScoring = true; break; }
        }
        if (filters.length && hasScoring) {
          list.sort(function (a, b) { return filterScore(b) - filterScore(a); });
        }
        return;
      }
      var nameOf = function (m) { return String(m.displayName || m.logical || ''); };
      // v0.32.2 A: starred models float to the top, ties alphabetical.
      if (k === 'starred') {
        list.sort(function (a, b) {
          var sa = starred.indexOf(a.logical) >= 0 ? 1 : 0;
          var sb = starred.indexOf(b.logical) >= 0 ? 1 : 0;
          return sb - sa || nameOf(a).localeCompare(nameOf(b));
        });
      } else if (k === 'recent') {
        // v0.32.4 F1: MRU order (the quick-switch recents list, newest
        // first); never-used models follow alphabetically.
        var rec = lsGet('recent', []);
        list.sort(function (a, b) {
          var ra = rec.indexOf(a.logical); if (ra < 0) ra = 9999;
          var rb = rec.indexOf(b.logical); if (rb < 0) rb = 9999;
          return ra - rb || nameOf(a).localeCompare(nameOf(b));
        });
      } else if (k === 'aa') {
        list.sort(function (a, b) { return (bmOf(b).intelligence || 0) - (bmOf(a).intelligence || 0) || nameOf(a).localeCompare(nameOf(b)); });
      } else if (k === 'agent') {
        list.sort(function (a, b) { return (bmOf(b).agentic || 0) - (bmOf(a).agentic || 0) || nameOf(a).localeCompare(nameOf(b)); });
      } else if (k === 'code') {
        list.sort(function (a, b) { return (bmOf(b).coding || 0) - (bmOf(a).coding || 0) || nameOf(a).localeCompare(nameOf(b)); });
      } else if (k === 'price') {
        list.sort(function (a, b) { return promptPrice(a) - promptPrice(b) || nameOf(a).localeCompare(nameOf(b)); });
      } else if (k === 'ctx') {
        list.sort(function (a, b) { return (b.contextLength || 0) - (a.contextLength || 0) || nameOf(a).localeCompare(nameOf(b)); });
      } else if (k === 'name') {
        list.sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
      }
    }

    function bmOf(lm) { return ((lm.attributes || {}).benchmarks) || {}; }

    // Cheapest-first: free models (isFree) count as 0; otherwise parse the
    // first dollar figure in the display pricing string (prompt price per
    // M). Unparseable → Infinity (sinks to the bottom).
    function promptPrice(lm) {
      if (lm.isFree) return 0;
      var p = ((lm.attributes || {}).pricing) || '';
      var m = String(p).match(/\$([0-9]+(?:\.[0-9]+)?)/);
      return m ? parseFloat(m[1]) : Infinity;
    }

    // v0.32.1 E: is this logical the chat's current model?
    function isCurrentModel(lm) {
      if (!currentModel || !currentModel.modelId) return false;
      var cm = String(currentModel.modelId);
      var cp = currentModel.provider;
      var hosts = lm.hosts || [];
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].provider === cp) {
          if (hosts[i].modelId === cm ||
              (hosts[i].provider + '/' + hosts[i].modelId) === cm ||
              lm.logical === cm) return true;
        }
      }
      return false;
    }

    // v0.32.4 F2: the MODEL DETAIL DRAWER — a per-row expandable card with
    // full benchmark bars, the prompt/completion pricing split, context,
    // capabilities, effort levels, usage-rank chips (OpenRouter ranks) and
    // a hosts summary. Purely informational — selection stays on the row's
    // left zone, priority stays on the chevron dropdown.
    function detailDrawer(lm) {
      var attrs = lm.attributes || {};
      var bm = attrs.benchmarks || {};
      var hosts = orderedHosts(lm);
      var withKeys = 0;
      for (var h = 0; h < hosts.length; h++) if (hosts[h].hasApiKey) withKeys++;

      var barColor = function (v) {
        return v >= 70 ? 'var(--ok)' : (v >= 40 ? 'var(--warn)' : 'var(--text-3)');
      };
      var barRow = function (label, v, idx) {
        if (!v) return '';
        var pct = Math.max(3, Math.min(100, v));
        return '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2);width:74px;flex-shrink:0">' + label + '</span>' +
          '<span style="flex:1;min-width:0;height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden">' +
            '<span class="mb-barfill" style="display:block;height:100%;width:' + pct + '%;border-radius:3px;background:' + barColor(v) + ';animation-delay:' + (idx * 70) + 'ms"></span>' +
          '</span>' +
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);font-weight:600;color:var(--text-1);width:34px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums">' + (Math.round(v * 10) / 10) + '</span>' +
          '</div>';
      };

      var html = '<div class="mb-detail" data-nodrag style="border-top:1px solid var(--surface-2);padding:12px;display:flex;flex-direction:column;gap:12px;background:rgba(0,0,0,0.14)">';

      // ── Benchmarks (Artificial Analysis) with animated bars ──
      if (bm.intelligence || bm.agentic || bm.coding) {
        html += '<div style="display:flex;flex-direction:column;gap:6px">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Benchmarks</div>' +
          barRow('Intelligence', bm.intelligence, 0) +
          barRow('Agentic', bm.agentic, 1) +
          barRow('Coding', bm.coding, 2) +
          '</div>';
      }

      // ── Pricing split (prompt / completion per M tokens) ──
      var pm = String(attrs.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)/);
      if (lm.isFree) {
        html += '<div style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--ok)">free route — no token billing</div>';
      } else if (pm) {
        html += '<div style="display:flex;flex-direction:column;gap:3px">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Pricing</div>' +
          '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">' +
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2)">prompt <b style="color:var(--warn);font-variant-numeric:tabular-nums">$' + pm[1] + '</b></span>' +
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2)">completion <b style="color:var(--warn);font-variant-numeric:tabular-nums">$' + pm[2] + '</b></span>' +
          '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3)">per M tokens</span>' +
          '</div></div>';
      }

      // ── Usage ranks (№1 fullstack · №1 webapps …) ──
      var ranks = attrs.ranks || [];
      if (ranks.length) {
        var rch = '';
        for (var r = 0; r < ranks.length && r < 4; r++) {
          rch += '<span title="ranked #' + ranks[r].rank + ' for ' + escAttr(ranks[r].label) + '" style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--accent);background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.35);padding:2px 8px;border-radius:5px;white-space:nowrap"><b>№' + ranks[r].rank + '</b> ' + escHTML(ranks[r].label) + '</span>';
        }
        if (ranks.length > 4) rch += '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);align-self:center">+' + (ranks.length - 4) + '</span>';
        html += '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' + rch + '</div>';
      }

      // ── Facts line: context · capabilities · effort levels ──
      var facts = '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2)"><b style="color:var(--text-1)">' + fmtCtx(lm.contextLength) + '</b> context</span>';
      var caps = attrs.capabilities || [];
      var capStr = '';
      for (var c = 0; c < caps.length; c++) {
        capStr += (capStr ? ' · ' : '') + escHTML(caps[c]);
      }
      if (capStr) facts += '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + capStr + '</span>';
      if (attrs.effortLevels && attrs.effortLevels.length) {
        facts += '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2)">effort: ' + attrs.effortLevels.length + ' levels</span>';
      }
      html += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' + facts + '</div>';

      // ── Hosts summary ──
      var hd = '';
      for (var d = 0; d < hosts.length && d < 5; d++) {
        hd += '<span style="width:7px;height:7px;border-radius:50%;background:' + (hosts[d].color || 'var(--border-strong)') + ';opacity:' + (hosts[d].hasApiKey ? 1 : 0.35) + ';flex-shrink:0" title="' + escAttr(hosts[d].providerDisplayName || hosts[d].provider) + '"></span>';
      }
      html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span style="display:flex;align-items:center;gap:3px">' + hd + '</span>' +
        '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + hosts.length + ' provider' + (hosts.length === 1 ? '' : 's') + ' · <b style="color:' + (withKeys ? 'var(--ok)' : 'var(--text-2)') + '">' + withKeys + ' with keys</b></span>' +
        '</div>';

      html += '</div>';
      return html;
    }

    // v0.32.5 F2: the COMPARE DRAWER — two pinned models side by side.
    // LiteLLM-style side-by-side (capped at 2 for phone widths): benchmark
    // bars with winner highlighting + delta chips, route pricing (cheaper
    // wins), context (bigger wins), capability diff, usage ranks and route
    // availability. Transient — never persisted, closes via ✕ / re-tap ⚖ / 'c'.
    function compareDrawer(a, b) {
      var resolve = function (id) {
        var list = (catalog && catalog.logical) || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].logical === id) return list[i];
        }
        return null;
      };
      var la = resolve(a), lb = resolve(b);
      if (!la || !lb) return '';
      var ba = bmOf(la), bb = bmOf(lb);
      var ca = (la.attributes || {}).capabilities || [];
      var cb = (lb.attributes || {}).capabilities || [];

      var html = '<div class="mb-compare" data-nodrag style="border:1px solid rgba(var(--accent-rgb),0.40);border-radius:12px;padding:12px;margin-bottom:10px;background:rgba(0,0,0,0.14);display:flex;flex-direction:column;gap:12px">';

      // ── Header: names + provider dots, ✕ closes (unpins both) ──
      var hostsOf = function (lm) {
        var hs = orderedHosts(lm), out = '', keys = 0;
        for (var i = 0; i < hs.length && i < 5; i++) {
          out += '<span style="width:7px;height:7px;border-radius:50%;background:' + (hs[i].color || 'var(--border-strong)') + ';opacity:' + (hs[i].hasApiKey ? 1 : 0.35) + ';flex-shrink:0" title="' + escAttr(hs[i].providerDisplayName || hs[i].provider) + '"></span>';
          if (hs[i].hasApiKey) keys++;
        }
        return { dots: out, keys: keys, n: hs.length };
      };
      var ha = hostsOf(la), hb = hostsOf(lb);
      // v0.32.6 F2: a "use this model" action under each column — the
      // compare flow ends in a DECISION, so let the user act on it right
      // in the drawer. Keyless side renders muted (tap still explains).
      var nameCol = function (lm, h) {
        var usable = h.keys > 0;
        return '<div style="min-width:0;display:flex;flex-direction:column;gap:3px">' +
          '<span title="' + escAttr(lm.displayName || lm.logical) + '" style="font-size:calc(var(--ui-fs) - 1px);font-weight:600;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(lm.displayName || lm.logical) + '</span>' +
          '<span style="display:flex;align-items:center;gap:5px">' + h.dots + '<span style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3)">' + h.n + ' route' + (h.n === 1 ? '' : 's') + '</span></span>' +
          '<button data-cmpuse="' + escAttr(lm.logical) + '" data-nodrag title="' + (usable ? 'switch the chat to this model' : 'no key-backed route yet — tap for details') + '" style="display:inline-flex;align-items:center;gap:5px;align-self:flex-start;background:' + (usable ? 'rgba(var(--accent-rgb),0.10)' : 'transparent') + ';border:1px solid ' + (usable ? 'rgba(var(--accent-rgb),0.55)' : 'var(--surface-2)') + ';color:' + (usable ? 'var(--accent)' : 'var(--text-3)') + ';font-size:10.5px;font-weight:700;padding:4px 10px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation;margin-top:2px">use this model <span style="font-size:9px">→</span></button>' +
          '</div>';
      };
      html += '<div style="display:flex;align-items:flex-start;gap:8px">' +
        '<span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--accent);flex-shrink:0;padding-top:2px">⚖ Compare</span>' +
        '<span style="flex:1"></span>' +
        '<button data-cmpclose data-nodrag title="close compare" aria-label="close compare" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:11px;width:22px;height:22px;border-radius:7px;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0">✕</button>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start">' + nameCol(la, ha) + nameCol(lb, hb) + '</div>';

      // ── Benchmark rows: dual bars, winner value green + "+Δ" chip ──
      var metricRow = function (label, va, vb) {
        if (!va && !vb) return '';
        var win = 0, d = 0;
        if (va && vb) { d = Math.round((va - vb) * 10) / 10; win = d > 0 ? -1 : (d < 0 ? 1 : 0); d = Math.abs(d); }
        var side = function (v, isWin) {
          if (!v) return '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3)">—</span></div>';
          var pct = Math.max(3, Math.min(100, v));
          var delta = isWin ? '<span style="font-size:calc(var(--ui-small-fs) - 3px);font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.14);padding:1px 5px;border-radius:4px;flex-shrink:0">+' + d + '</span>' : '';
          return '<div style="display:flex;flex-direction:column;gap:3px;min-width:0">' +
            '<div style="display:flex;align-items:center;gap:5px"><span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;color:' + (isWin ? 'var(--ok)' : 'var(--text-1)') + ';font-variant-numeric:tabular-nums">' + (Math.round(v * 10) / 10) + '</span>' + delta + '</div>' +
            '<span style="height:5px;border-radius:3px;background:var(--surface-2);overflow:hidden"><span class="mb-barfill" style="display:block;height:100%;width:' + pct + '%;border-radius:3px;background:' + (isWin ? 'var(--ok)' : 'var(--text-3)') + '"></span></span>' +
            '</div>';
        };
        return '<div style="display:flex;flex-direction:column;gap:5px">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">' + label + '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:end">' + side(va, win === -1) + side(vb, win === 1) + '</div>' +
          '</div>';
      };
      html += metricRow('Intelligence', ba.intelligence, bb.intelligence);
      html += metricRow('Agentic', ba.agentic, bb.agentic);
      html += metricRow('Coding', ba.coding, bb.coding);

      // ── Route pricing: cheaper prompt price wins (free = 0) ──
      var priceOf = function (lm) {
        if (lm.isFree) return 0;
        var p = ((lm.attributes || {}).pricing) || '';
        var m = String(p).match(/\$([0-9]+(?:\.[0-9]+)?)/);
        return m ? parseFloat(m[1]) : Infinity;
      };
      var priceLabel = function (lm, isWin) {
        if (lm.isFree) return '<b style="color:' + (isWin ? 'var(--ok)' : '#22c55e') + '">free</b>';
        var pm = String(((lm.attributes || {}).pricing) || '').match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)/);
        if (!pm) return '<span style="color:var(--text-3)">—</span>';
        return '<b style="color:' + (isWin ? 'var(--ok)' : 'var(--text-1)') + ';font-variant-numeric:tabular-nums">$' + pm[1] + '</b><span style="color:var(--text-3)"> / $' + pm[2] + '</span>';
      };
      var pa = priceOf(la), pb = priceOf(lb);
      var pWin = (pa === pb) ? 0 : (pa < pb ? -1 : 1);
      html += '<div style="display:flex;flex-direction:column;gap:5px">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Pricing <span style="font-weight:400;letter-spacing:0;text-transform:none">· prompt / completion per M</span></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + priceLabel(la, pWin === -1) + '</span>' +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + priceLabel(lb, pWin === 1) + '</span>' +
        '</div></div>';

      // ── Context: bigger wins ──
      var ctxWin = la.contextLength === lb.contextLength ? 0 : (la.contextLength > lb.contextLength ? -1 : 1);
      html += '<div style="display:flex;flex-direction:column;gap:5px">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Context</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;color:' + (ctxWin === -1 ? 'var(--ok)' : 'var(--text-1)') + '">' + fmtCtx(la.contextLength) + '</span>' +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;color:' + (ctxWin === 1 ? 'var(--ok)' : 'var(--text-1)') + '">' + fmtCtx(lb.contextLength) + '</span>' +
        '</div></div>';

      // ── Capability diff: shared chips centered; unique chips per side ──
      var onlyA = [], onlyB = [], shared = [];
      for (var i = 0; i < ca.length; i++) (cb.indexOf(ca[i]) >= 0 ? shared : onlyA).push(ca[i]);
      for (var j = 0; j < cb.length; j++) {
        if (ca.indexOf(cb[j]) >= 0) { if (shared.indexOf(cb[j]) < 0) shared.push(cb[j]); } // dedupe — both loops can hit the same cap
        else onlyB.push(cb[j]);
      }
      if (ca.length || cb.length) {
        var chip = function (c, unique) {
          return '<span style="font-size:calc(var(--ui-small-fs) - 3px);color:' + (unique ? 'var(--accent)' : 'var(--text-2)') + ';background:' + (unique ? 'rgba(var(--accent-rgb),0.10)' : 'var(--surface-2)') + ';border:1.5px solid ' + (unique ? 'rgba(var(--accent-rgb),0.60)' : 'transparent') + ';padding:2px 7px;border-radius:5px;white-space:nowrap">' + escHTML(c) + '</span>';
        };
        var col = function (list) {
          if (!list.length) return '<span style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3)">—</span>';
          var s = '';
          for (var k = 0; k < list.length; k++) s += chip(list[k], true);
          return '<div style="display:flex;gap:4px;flex-wrap:wrap">' + s + '</div>';
        };
        var sh = '';
        for (var s2 = 0; s2 < shared.length; s2++) sh += chip(shared[s2], false);
        html += '<div style="display:flex;flex-direction:column;gap:5px">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Capabilities <span style="font-weight:400;letter-spacing:0;text-transform:none">· accent = unique</span></div>' +
          (sh ? '<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center">' + sh + '</div>' : '') +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + col(onlyA) + col(onlyB) + '</div>' +
          '</div>';
      }

      // ── Usage ranks: up to 3 chips per side ──
      var ranksOf = function (lm) { return ((lm.attributes || {}).ranks) || []; };
      var ra = ranksOf(la), rb = ranksOf(lb);
      if (ra.length || rb.length) {
        var rcol = function (list) {
          if (!list.length) return '<span style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3)">—</span>';
          var s = '';
          for (var k = 0; k < list.length && k < 3; k++) s += '<span title="ranked #' + list[k].rank + ' for ' + escAttr(list[k].label) + '" style="font-size:calc(var(--ui-small-fs) - 3px);color:var(--accent);background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.35);padding:2px 7px;border-radius:5px;white-space:nowrap"><b>№' + list[k].rank + '</b> ' + escHTML(list[k].label) + '</span>';
          return '<div style="display:flex;gap:4px;flex-wrap:wrap">' + s + '</div>';
        };
        html += '<div style="display:flex;flex-direction:column;gap:5px">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Usage ranks</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + rcol(ra) + rcol(rb) + '</div>' +
          '</div>';
      }

      // ── Availability: routes with keys ── (title = hover explanation)
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<span title="how many of this model\u2019s provider routes have your API key" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)"><b style="color:' + (ha.keys ? 'var(--ok)' : 'var(--text-2)') + '">' + ha.keys + '/' + ha.n + '</b> routes keyed</span>' +
        '<span title="how many of this model\u2019s provider routes have your API key" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)"><b style="color:' + (hb.keys ? 'var(--ok)' : 'var(--text-2)') + '">' + hb.keys + '/' + hb.n + '</b> routes keyed</span>' +
        '</div>';

      html += '</div>';
      return html;
    }

    // v0.32.5 F2: pin-state toggle used by the ⚖ button and the 'c' key.
    function toggleComparePin(logical) {
      var idx = comparePair.indexOf(logical);
      if (idx >= 0) {
        comparePair.splice(idx, 1);
      } else if (comparePair.length < 2) {
        comparePair.push(logical);
      } else {
        // pair full and a third model tapped → start a fresh pin
        comparePair = [logical];
      }
    }

    function logicalRow(lm, kbFirst) {
      var expanded = !!expandedLogical[lm.logical];
      var hosts = orderedHosts(lm);
      var available = hosts.some(function (h) { return h.hasApiKey; });
      var isCur = isCurrentModel(lm); // v0.32.1 E

      // Provider priority indicator: up to 5 colored dots (dim when no key).
      var dots = '';
      var shown = Math.min(hosts.length, 5);
      for (var d = 0; d < shown; d++) {
        dots += '<span style="width:7px;height:7px;border-radius:50%;background:' + (hosts[d].color || 'var(--border-strong)') + ';opacity:' + (hosts[d].hasApiKey ? 1 : 0.35) + ';flex-shrink:0" title="' + escAttr(hosts[d].providerDisplayName || hosts[d].provider) + (hosts[d].hasApiKey ? ' (key)' : '') + '"></span>';
      }
      if (hosts.length > 5) dots += '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:var(--text-3)">+' + (hosts.length - 5) + '</span>';
      var dotsWrap = '<span style="display:flex;align-items:center;gap:3px;flex-shrink:0">' + dots + '</span>';

      // Capability chips + benchmarks.
      var attrs = lm.attributes || {};
      var chips = '';
      var bm = attrs.benchmarks || {};
      if (bm.intelligence) chips += bmChip('AA ' + Math.round(bm.intelligence), bm.intelligence);
      if (bm.coding) chips += bmChip('code ' + Math.round(bm.coding), bm.coding);
      if (bm.agentic) chips += bmChip('agent ' + Math.round(bm.agentic), bm.agentic);
      // v0.32.1 E: the "current" chip — the model this chat is using.
      if (isCur) chips = '<span style="font-size: calc(var(--ui-small-fs) - 3px);font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.35);padding:1px 7px;border-radius:4px">current</span>' + chips;
      var caps = attrs.capabilities || [];
      for (var c = 0; c < caps.length && c < 5; c++) {
        chips += capChip(caps[c]);
      }
      if (attrs.effortLevels && attrs.effortLevels.length) chips += capChip('effort');
      // v0.32.2 B: real price — "$0.91/M" parsed from attributes.pricing
      // (tooltip = full string); falls back to bare "paid".
      var priceChip;
      if (lm.isFree) {
        priceChip = '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:#22c55e;background:rgba(34,197,94,0.12);padding:1px 6px;border-radius:4px">free route</span>';
      } else {
        var pMatch = String(attrs.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
        priceChip = pMatch
          ? '<span title="' + escAttr(attrs.pricing) + '" style="font-size: calc(var(--ui-small-fs) - 3px);color:var(--warn);background:rgba(var(--warn-rgb),0.1);padding:1px 6px;border-radius:4px;white-space:nowrap">$' + pMatch[1] + '/M</span>'
          : '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:var(--warn);background:rgba(var(--warn-rgb),0.1);padding:1px 6px;border-radius:4px">paid</span>';
      }

      // v0.32 #6: the big, obvious chevron button (rotates when open) —
      // the affordance for the provider-priority dropdown.
      var chevBtn = '<span data-nodrag class="mb-chevbtn" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--surface-2);background:rgba(128,128,140,0.06);border-radius:8px;color:var(--text-1);flex-shrink:0">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(' + (expanded ? '180deg' : '0deg') + ')"><path d="M6 9l6 6 6-6"/></svg>' +
        '</span>';

      // v0.32.4 F2: the ℹ detail toggle — opens the benchmark/pricing
      // drawer below the row (selection stays left, priority stays chevron).
      var infoOpenNow = !!infoOpen[lm.logical];
      // v0.32.5 F2: compare pin state for this row.
      var cmpIdx = comparePair.indexOf(lm.logical);
      var cmpPinned = cmpIdx >= 0;
      var infoBtn = '<button data-info="' + escAttr(lm.logical) + '" data-nodrag class="mb-infobtn" aria-expanded="' + (infoOpenNow ? 'true' : 'false') + '" title="model details — benchmarks, pricing, ranks" style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid ' + (infoOpenNow ? 'rgba(var(--accent-rgb),0.55)' : 'var(--surface-2)') + ';background:' + (infoOpenNow ? 'rgba(var(--accent-rgb),0.10)' : 'rgba(128,128,140,0.06)') + ';border-radius:8px;color:' + (infoOpenNow ? 'var(--accent)' : 'var(--text-2)') + ';flex-shrink:0;cursor:pointer;font-family:inherit;touch-action:manipulation;padding:0">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.2" r="0.4" fill="currentColor" stroke="none"/></svg>' +
        '</button>';

      // v0.32.5 F2: the ⚖ compare pin — tap to pin, tap another row's ⚖ to
      // open the side-by-side compare drawer. Pinned = accent state.
      var cmpBtn = '<button data-compare="' + escAttr(lm.logical) + '" data-nodrag class="mb-cmpbtn" aria-pressed="' + (cmpPinned ? 'true' : 'false') + '" title="' + (cmpPinned ? (comparePair.length === 2 ? 'in compare — tap to remove' : 'pinned for compare — tap to unpin') : 'compare with another model') + '" style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid ' + (cmpPinned ? 'rgba(var(--accent-rgb),0.55)' : 'var(--surface-2)') + ';background:' + (cmpPinned ? 'rgba(var(--accent-rgb),0.10)' : 'rgba(128,128,140,0.06)') + ';border-radius:8px;color:' + (cmpPinned ? 'var(--accent)' : 'var(--text-2)') + ';flex-shrink:0;cursor:pointer;font-family:inherit;touch-action:manipulation;padding:0">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>' +
        '</button>';

      // v0.32 #6: split row — LEFT selects, RIGHT (dots → chevron) opens the
      // priority dropdown. The 1px separator marks the hotspot boundary.
      // v0.32.1 E: the current model wears a filled radio + green ring.
      // v0.32.2 A: the star toggle rides at the end of the left zone
      // (stopPropagation — tapping it must NOT select the model).
      var leftZone =
        '<div data-select="' + escAttr(lm.logical) + '" role="button" title="' + (isCur ? 'current model — tap to keep' : 'select this model') + '" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;touch-action:manipulation;padding:2px 4px 2px 0">' +
          '<span style="width:8px;height:8px;border-radius:50%;border:1.5px solid ' + (isCur ? 'var(--ok)' : '#a855f7') + ';' + (isCur ? 'background:var(--ok);box-shadow:0 0 0 3px rgba(var(--ok-rgb),0.18);' : '') + 'flex-shrink:0"></span>' +
          '<span title="' + escAttr(lm.displayName || lm.logical) + '" style="font-size: calc(var(--ui-fs) - 1px);font-weight:600;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(lm.displayName || lm.logical) + '</span>' +
          starBtnHtml(lm.logical) +
        '</div>';
      var separator = '<span style="width:1px;height:20px;background:var(--border);flex-shrink:0;opacity:0.9"></span>';
      var rightZone =
        '<div data-expand="' + escAttr(lm.logical) + '" role="button" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="provider priority" style="display:flex;align-items:center;gap:8px;flex-shrink:0;cursor:pointer;touch-action:manipulation;padding:2px 0 2px 6px">' +
          dotsWrap +
          '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);flex-shrink:0;min-width:34px;text-align:right">' + fmtCtx(lm.contextLength) + '</span>' +
          priceChip +
          infoBtn +
          cmpBtn +
          chevBtn +
        '</div>';

      // Host rank rows (the priority dropdown). Tap = select that
      // provider+model; ▲▼ or the ⠿ handle re-orders.
      var hostRows = '';
      if (expanded) {
        for (var h = 0; h < hosts.length; h++) {
          var hr = hosts[h];
          // v0.32.5 F1: route-level price chip — the same model can cost
          // differently per provider. free routes stay green; paid routes
          // show the prompt price per M tokens (tooltip = full pricing).
          // VLM review: FIXED-WIDTH column (min-width + centered) so the
          // ctx / key / arrows stay vertically aligned across rows — an
          // invisible spacer keeps the column when a route has no pricing.
          var routePrice = '<span style="min-width:54px;flex-shrink:0"></span>';
          if (hr.isFree) {
            routePrice = '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:#22c55e;background:rgba(34,197,94,0.12);padding:2px 7px;border-radius:4px;flex-shrink:0;min-width:54px;text-align:center;box-sizing:border-box;font-variant-numeric:tabular-nums">free</span>';
          } else {
            var rpm = String(hr.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
            if (rpm) {
              routePrice = '<span title="' + escAttr(hr.pricing) + '" style="font-size: calc(var(--ui-small-fs) - 3px);color:var(--warn);background:rgba(var(--warn-rgb),0.10);padding:2px 7px;border-radius:4px;flex-shrink:0;min-width:54px;text-align:center;box-sizing:border-box;font-variant-numeric:tabular-nums">$' + rpm[1] + '/M</span>';
            }
          }
          var keyBadge = hr.hasApiKey
            ? '<span style="font-size: calc(var(--ui-small-fs) - 3px);font-weight:700;color:var(--ok);padding:2px 6px;border:1px solid rgba(var(--ok-rgb),0.4);border-radius:5px;flex-shrink:0;min-width:47px;text-align:center;box-sizing:border-box">key ✓</span>'
            : '<span style="font-size: calc(var(--ui-small-fs) - 3px);font-weight:600;color:var(--border-strong);padding:2px 6px;border:1px solid var(--border);border-radius:5px;flex-shrink:0;min-width:47px;text-align:center;box-sizing:border-box">no key</span>';
          hostRows += '<div data-hostslot="' + escAttr(hr.provider + '|' + hr.modelId) + '" data-nodrag style="display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;touch-action:manipulation">' +
            '<span data-hostgrip data-nodrag title="drag to re-order priority" style="cursor:grab;color:var(--text-3);width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:6px;touch-action:none;font-size:12px;line-height:1">⠿</span>' +
            '<span style="font-size: calc(var(--ui-small-fs) - 2px);font-weight:700;color:var(--bg-app);background:' + (hr.color || 'var(--border-strong)') + ';width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + (h + 1) + '</span>' +
            '<span style="width:8px;height:8px;border-radius:50%;background:' + (hr.color || 'var(--border-strong)') + ';flex-shrink:0"></span>' +
            '<span style="font-size: var(--ui-small-fs);color:' + (hr.hasApiKey ? 'var(--text-1)' : 'var(--text-3)') + ';flex-shrink:0;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(hr.providerDisplayName || hr.provider) + '</span>' +
            '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--border-strong);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(hr.modelId) + '</span>' +
            routePrice +
            '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);flex-shrink:0;min-width:30px;text-align:right">' + fmtCtx(hr.contextLength) + '</span>' +
            keyBadge +
            '<button data-hostup="' + escAttr(lm.logical + '|' + hr.provider) + '" data-nodrag style="background:transparent;border:1px solid var(--border);color:var(--text-3);font-size:9px;padding:3px 6px;border-radius:5px;cursor:pointer;flex-shrink:0;font-family:inherit;margin-left:2px" title="raise priority">▲</button>' +
            '<button data-hostdown="' + escAttr(lm.logical + '|' + hr.provider) + '" data-nodrag style="background:transparent;border:1px solid var(--border);color:var(--text-3);font-size:9px;padding:3px 6px;border-radius:5px;cursor:pointer;flex-shrink:0;font-family:inherit" title="lower priority">▼</button>' +
            '</div>';
        }
      }

      // v0.32 #5/#9: no "use" button — dimming carries availability; the
      // left-side tap selects. (v0.32.1 VLM review: 0.5→0.55 + saturation
      // 0.45→0.6 keeps dimmed rows clearly dimmed but their chips legible.)
      var dim = available ? '' : 'opacity:0.55;filter:saturate(0.6);';

      // v0.32.1 E: the current row wears the mb-cur ring (see styles).
      // v0.32.3 F4: roving tabindex — the first row is tabbable, the rest
      // are arrow-reachable (WAI-APG pattern); data-logical-id serves the
      // Enter-to-select keyboard path.
      return '<div class="mb-logrow' + (isCur ? ' mb-cur' : '') + '" data-logical-id="' + escAttr(lm.logical) + '" tabindex="' + (kbFirst ? 0 : -1) + '" style="background:var(--surface-1);border:1px solid ' + (isCur ? 'rgba(var(--ok-rgb),0.55)' : (expanded ? 'rgba(255,255,255,0.14)' : 'var(--surface-2)')) + ';border-radius:12px;overflow:hidden;' + dim + 'transition:opacity 200ms,filter 200ms">' +
        '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px">' + leftZone + separator + rightZone + '</div>' +
        (chips ? '<div style="display:flex;gap:4px;flex-wrap:wrap;padding:0 12px 10px;align-items:center">' + chips + '</div>' : '') +
        (infoOpenNow ? detailDrawer(lm) : '') +
        (expanded ? '<div data-hostlist="' + escAttr(lm.logical) + '" style="border-top:1px solid var(--surface-2)">' + hostRows + '</div>' : '') +
        '</div>';
    }

    function orderedHosts(lm) {
      var hosts = (lm.hosts || []).slice();
      var order = hostOrder[lm.logical];
      if (order && order.length) {
        hosts.sort(function (a, b) {
          var ia = order.indexOf(a.provider); var ib = order.indexOf(b.provider);
          if (ia < 0) ia = 999; if (ib < 0) ib = 999;
          return ia - ib;
        });
      }
      return hosts;
    }

    function bmChip(text, score) {
      var color = score >= 70 ? '#22c55e' : (score >= 40 ? 'var(--warn)' : 'var(--text-3)');
      // v0.32.1 G: a 32×3px score mini-bar next to the number — the score
      // becomes readable at a glance (green ≥70, amber ≥40).
      var pct = Math.max(5, Math.min(100, Math.round(score)));
      return '<span style="display:inline-flex;align-items:center;gap:5px;font-size: calc(var(--ui-small-fs) - 3px);color:' + color + ';background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:4px">' + text +
        '<span style="width:32px;height:3px;border-radius:2px;background:rgba(128,128,140,0.22);overflow:hidden;flex-shrink:0" title="score ' + Math.round(score) + '/100"><i style="display:block;height:100%;width:' + pct + '%;background:' + color + ';border-radius:2px;opacity:0.85"></i></span>' +
        '</span>';
    }

    var CAP_COLORS = { reasoning: '#f97316', code: '#3b82f6', tools: 'var(--accent)', vision: '#22c55e', audio: '#ec4899', agents: '#14b8a6' };
    function capChip(cap) {
      var key = String(cap).toLowerCase();
      var color = CAP_COLORS[key] || 'var(--text-3)';
      return '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:' + color + ';background:' + color + '14;padding:1px 6px;border-radius:4px">' + escHTML(cap) + '</span>';
    }

    // ── Matching / filtering ─────────────────────────────────────────────

    function modelMatches(m, g) {
      var q = search.toLowerCase().trim();
      if (q) {
        var hay = ((m.displayName || '') + ' ' + (m.rawId || '') + ' ' + (m.id || '') + ' ' + (g.displayName || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (ctxMin > 0 && (m.contextLength || 0) < ctxMin) return false;
      if (pricing === 'free' && !m.isFree) return false;
      if (pricing === 'paid' && m.isFree) return false;
      // v0.32 #4: "available" — the provider must have an API key.
      if (filters.indexOf('available') >= 0 && !g.hasApiKey) return false;
      // v0.32.2 A: "starred" — the model's family must be starred.
      if (filters.indexOf('starred') >= 0 && starred.indexOf(m.family || '') < 0) return false;
      // v0.32.1 A BUGFIX: 'available' alone must NOT route into the caps
      // matcher (no capability branch matches it → every model hidden).
      // v0.32.2: same for 'starred'.
      var capFiltersM = [];
      for (var fmi = 0; fmi < filters.length; fmi++) {
        if (filters[fmi] !== 'available' && filters[fmi] !== 'starred') capFiltersM.push(filters[fmi]);
      }
      if (capFiltersM.length) {
        var bm = famBm[m.family] || {};
        return matchesFiltersCaps((m.capabilities || []), m.effortLevels, bm, String(m.rawId || '') + ' ' + String(m.displayName || ''));
      }
      return true;
    }

    function logicalMatches(lm) {
      var q = search.toLowerCase().trim();
      if (q) {
        var hostNames = '';
        for (var i = 0; i < (lm.hosts || []).length; i++) hostNames += ' ' + (lm.hosts[i].providerDisplayName || '');
        var hay = ((lm.displayName || '') + ' ' + (lm.logical || '') + hostNames).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (ctxMin > 0 && (lm.contextLength || 0) < ctxMin) return false;
      if (pricing === 'free' && !lm.isFree) return false;
      if (pricing === 'paid' && lm.isFree) return false;
      // v0.32 #4: "available" — ≥1 host with an API key (position in the
      // priority order is irrelevant).
      if (filters.indexOf('available') >= 0 && !(lm.hosts || []).some(function (h) { return h.hasApiKey; })) return false;
      // v0.32.2 A: "starred" — this logical model must be starred.
      if (filters.indexOf('starred') >= 0 && starred.indexOf(lm.logical) < 0) return false;
      // v0.32.1 A BUGFIX: same as modelMatches — 'available' as the ONLY
      // filter must not fall through into the capability matcher (none of
      // its branches match 'available', so the list used to go empty:
      // "503 models hidden by filters" while 148 were key-backed).
      // v0.32.2: same exclusion for 'starred'.
      var capFiltersL = [];
      for (var fli = 0; fli < filters.length; fli++) {
        if (filters[fli] !== 'available' && filters[fli] !== 'starred') capFiltersL.push(filters[fli]);
      }
      if (capFiltersL.length) {
        var attrs = lm.attributes || {};
        return matchesFiltersCaps(attrs.capabilities || [], attrs.effortLevels, attrs.benchmarks || {}, String(lm.logical || '') + ' ' + String(lm.displayName || ''));
      }
      return true;
    }

    // OR across pills; reasoning also true when effort levels exist;
    // smart/code/agent match the Artificial Analysis benchmarks (v0.32 #3)
    // with capability fallbacks.
    function matchesFiltersCaps(caps, effortLevels, bm, name) {
      bm = bm || {};
      var capsLower = (caps || []).map(function (c) { return String(c).toLowerCase(); });
      var hasCap = function (frag) {
        for (var i = 0; i < capsLower.length; i++) {
          if (capsLower[i].indexOf(frag) >= 0) return true;
        }
        return false;
      };
      for (var f = 0; f < filters.length; f++) {
        var key = filters[f];
        var ok = false;
        if (key === 'reasoning') ok = hasCap('reason') || (effortLevels && effortLevels.length > 0) || /reasoning|thinking/.test(name);
        else if (key === 'tools') ok = hasCap('tool') || hasCap('function') || hasCap('agent');
        else if (key === 'vision') ok = hasCap('vision');
        else if (key === 'code') ok = (bm.coding || 0) > 0 || hasCap('code') || hasCap('coding');
        else if (key === 'agent') ok = (bm.agentic || 0) > 0 || hasCap('agent') || hasCap('agentic');
        else if (key === 'intelligence') ok = (bm.intelligence || 0) > 0 || hasCap('smart');
        // 'available' is handled by the callers.
        if (ok) return true; // OR across pills
      }
      return false;
    }

    function filterScore(lm) {
      var attrs = (lm.attributes || {}) || {};
      var bm = attrs.benchmarks || {};
      var score = 0;
      for (var f = 0; f < filters.length; f++) {
        var key = filters[f];
        if (key === 'reasoning' && attrs.effortLevels && attrs.effortLevels.length) score += 2;
        if (key === 'intelligence') score += (bm.intelligence || 0);
        if (key === 'code') score += (bm.coding || 0);
        if (key === 'agent') score += (bm.agentic || 0);
        if (key === 'tools') score += (bm.agentic || 0);
      }
      return score;
    }

    // ── Selection (v0.32 #6: left-side tap) ──────────────────────────────

    function findLogical(logical) {
      var logicals = (catalog && catalog.logical) || [];
      for (var i = 0; i < logicals.length; i++) {
        if (logicals[i].logical === logical) return logicals[i];
      }
      return null;
    }

    function selectLogical(logical) {
      var lm = findLogical(logical);
      if (!lm) return;
      var hosts = orderedHosts(lm);
      var best = null;
      for (var h = 0; h < hosts.length; h++) {
        if (hosts[h].hasApiKey) { best = hosts[h]; break; }
      }
      if (!best) {
        showHint('No API key yet for any provider of ' + escHTML(lm.displayName || lm.logical) + ' — add one in the Providers tab.');
        return;
      }
      rememberRecent(logical); // v0.32.3 F1: recents feed the ★ quick-switch
      window.ConnectOverlay.close();
      if (onPick) onPick(best.provider, best.modelId);
    }

    // v0.32.1 D: POST the pasted key for the view-only provider, then
    // re-sync the catalog — the box flips to "ready" in place.
    function saveProviderKey() {
      var contentEl = window.ConnectOverlay.getContentEl();
      var inp = contentEl && contentEl.querySelector('[data-keyinput]');
      if (!inp) return;
      var key = (inp.value || '').trim();
      var name = keyAdding;
      var g = null;
      var groups = (catalog && catalog.groups) || [];
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].name === name) { g = groups[i]; break; }
      }
      if (!g || !g.envVar) { keyAdding = null; render(); return; }
      if (!key) { inp.focus(); return; }
      var saveBtn = contentEl.querySelector('[data-keysave]');
      if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
      fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_var: g.envVar, provider: g.name, key: key })
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (body) { throw new Error(body || ('HTTP ' + r.status)); });
        }
        keyAdding = null;
        showHint('Key saved — syncing ' + escHTML(g.displayName || g.name) + '…');
        syncing = true;
        render();
        fetchCatalog(true, function () { render(); });
      }).catch(function (err) {
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        showHint('Key rejected — ' + String(err.message || err).slice(0, 140));
      });
    }

    // Inline hint (sticky toast at the bottom of the overlay).
    function showHint(text) {
      var contentEl = window.ConnectOverlay.getContentEl();
      if (!contentEl) return;
      var old = contentEl.querySelector('.mb-hint');
      if (old) old.remove();
      var el = document.createElement('div');
      el.className = 'mb-hint';
      el.style.cssText = 'position:sticky;bottom:0;left:0;right:0;display:flex;align-items:center;gap:8px;background:rgba(30,30,38,0.97);border:1px solid rgba(245,158,11,0.5);color:var(--warn);font-size:12px;padding:10px 14px;border-radius:10px;margin-top:10px';
      el.innerHTML = '<span style="flex-shrink:0">⚠</span><span style="flex:1">' + text + '</span>';
      contentEl.appendChild(el);
      setTimeout(function () {
        el.style.transition = 'opacity 300ms';
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 320);
      }, 2600);
    }

    // ── Footer ───────────────────────────────────────────────────────────

    function footer() {
      // v0.32.2 (VLM round 3): --text-2 when available — the hint must be
      // readable, not a whisper. v0.32.4: mentions the ℹ drawer + shortcuts.
      // v0.32.5: mentions ⚖ compare + per-route prices.
      return '<div style="padding:16px 0 0;font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-2,var(--text-3));text-align:center">' +
        'tap the name to select · the dots open priority · ℹ shows benchmarks & pricing · ⚖ compares two models · ★ stars a favorite · ⠿ drag to re-order · / searches · Esc closes · ' + liveCount() + ' providers live' +
        '</div>';
    }

    // ── Drag & drop (v0.32 #7/#8) — iPhone-style reorder ─────────────────
    //
    // The dragged item follows the finger 1:1 (transform, no transition);
    // siblings FLIP around it (transform transitions). Works for both the
    // provider boxes (hold 220ms or grab the ⠿ grip) and the host priority
    // rows (drag from the ⠿ handle). Persists via onOrder(keys).

    function makeSortable(listEl, cfg) {
      // cfg: { itemSel, startSel (where a drag may begin), handleSel (instant
      // drag), holdMs (long-press to engage from startSel), keyOf(el),
      // onOrder(keys) }
      var drag = null;
      var holdTimer = null;
      var down = null;
      var docMove = null, docUp = null, docCancel = null;

      function scrollParentOf(el) {
        var p = el.parentElement;
        while (p && p !== document.body) {
          var oy = window.getComputedStyle(p).overflowY;
          if (oy === 'auto' || oy === 'scroll') return p;
          p = p.parentElement;
        }
        return null;
      }

      function blockTouch(e) {
        if (drag) e.preventDefault();
      }
      function blockCtx(e) {
        if (drag) e.preventDefault();
      }

      function detachDoc() {
        if (docMove) { document.removeEventListener('pointermove', docMove); docMove = null; }
        if (docUp) { document.removeEventListener('pointerup', docUp); docUp = null; }
        if (docCancel) { document.removeEventListener('pointercancel', docCancel); docCancel = null; }
        document.removeEventListener('touchmove', blockTouch);
        document.removeEventListener('contextmenu', blockCtx);
      }

      function cleanup() {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (drag) {
          if (drag.scrollRAF) cancelAnimationFrame(drag.scrollRAF);
          drag.items.forEach(function (it) {
            it.style.transition = '';
            it.style.transform = '';
            it.classList.remove('mb-dragging');
          });
          if (drag.listEl) drag.listEl.style.height = '';
          document.body.classList.remove('mb-noselect');
        }
        detachDoc();
        down = null;
        drag = null;
      }

      function engage(e) {
        if (drag || !down) return;
        var item = down.item;
        // Only DIRECT children of the list are sortable items.
        var items = Array.prototype.filter.call(
          listEl.querySelectorAll(cfg.itemSel),
          function (el) { return el.parentElement === listEl; }
        );
        var rects = items.map(function (it) { return it.getBoundingClientRect(); });
        var scrollEl = scrollParentOf(item);
        var base = scrollEl ? scrollEl.scrollTop : 0;
        var tops = rects.map(function (r) { return r.top + base; });
        var gap = items.length > 1 ? Math.max(0, tops[1] - (tops[0] + rects[0].height)) : 0;
        drag = {
          item: item,
          items: items,
          keys: items.map(cfg.keyOf),
          from: items.indexOf(item),
          to: items.indexOf(item),
          h: item.getBoundingClientRect().height,
          gap: gap,
          tops: tops,
          heights: rects.map(function (r) { return r.height; }),
          startY: down.startY,
          lastY: e.clientY,
          listEl: listEl,
          scrollEl: scrollEl,
          startScroll: base,
          scrollRAF: null
        };
        if (drag.from < 0 || items.length < 2) { drag = null; return; }

        // Freeze the container height so nothing jumps.
        listEl.style.height = listEl.getBoundingClientRect().height + 'px';
        item.classList.add('mb-dragging');
        items.forEach(function (it) { if (it !== item) it.style.transition = 'transform 170ms ' + EASE; });
        document.body.classList.add('mb-noselect');
        document.addEventListener('touchmove', blockTouch, { passive: false });
        document.addEventListener('contextmenu', blockCtx);
        try { item.setPointerCapture(down.pointerId); } catch (err) {}
        drag.scrollRAF = requestAnimationFrame(autoTick);
      }

      function autoTick() {
        if (!drag) return;
        var sp = drag.scrollEl;
        if (sp) {
          var rect = sp.getBoundingClientRect();
          var EDGE = 48, y = drag.lastY;
          if (y < rect.top + EDGE) {
            sp.scrollTop -= 10 * Math.min(3, 1 + (rect.top + EDGE - y) / EDGE);
          } else if (y > rect.bottom - EDGE) {
            sp.scrollTop += 10 * Math.min(3, 1 + (y - (rect.bottom - EDGE)) / EDGE);
          }
          applyShifts();
        }
        if (drag) drag.scrollRAF = requestAnimationFrame(autoTick);
      }

      function applyShifts() {
        if (!drag) return;
        var scrollAdj = drag.scrollEl ? (drag.scrollEl.scrollTop - drag.startScroll) : 0;
        var dy = drag.lastY - drag.startY + scrollAdj;
        var from = drag.from;
        var count = drag.items.length;
        // New index: how many other item-centers sit above the dragged center.
        var dragCenter = drag.tops[from] + drag.heights[from] / 2 + dy;
        var idx = 0;
        for (var j = 0; j < count; j++) {
          if (j === from) continue;
          if (drag.tops[j] + drag.heights[j] / 2 < dragCenter) idx++;
        }
        drag.to = Math.max(0, Math.min(count - 1, idx));
        // Dragged item follows the finger 1:1 (includes scroll adjustment).
        drag.item.style.transform = 'translateY(' + dy + 'px) scale(1.02)';
        // Siblings FLIP out of the way.
        for (var k = 0; k < count; k++) {
          if (k === from) continue;
          var shift = 0;
          if (from < drag.to && k > from && k <= drag.to) shift = -(drag.h + drag.gap);
          else if (drag.to < from && k >= drag.to && k < from) shift = (drag.h + drag.gap);
          drag.items[k].style.transform = shift ? 'translateY(' + shift + 'px)' : '';
        }
      }

      function settle() {
        var d = drag;
        if (!d) return;
        suppressClickUntil = Date.now() + 400;
        // Animate the dragged item into its final slot.
        var slotShift = (d.to - d.from) * (d.h + d.gap);
        d.item.style.transition = 'transform 190ms ' + EASE;
        d.item.style.transform = 'translateY(' + slotShift + 'px) scale(1)';
        var keys = d.keys.slice();
        var moved = keys.splice(d.from, 1)[0];
        keys.splice(d.to, 0, moved);
        var changed = d.from !== d.to;
        drag = null; // stop autoTick
        if (d.scrollRAF) cancelAnimationFrame(d.scrollRAF);
        setTimeout(function () {
          d.items.forEach(function (it) {
            it.style.transition = '';
            it.style.transform = '';
            it.classList.remove('mb-dragging');
          });
          d.listEl.style.height = '';
          document.body.classList.remove('mb-noselect');
          detachDoc();
          down = null;
          if (changed && cfg.onOrder) cfg.onOrder(keys);
          else render();
        }, 200);
      }

      function finish() {
        if (drag) { settle(); return; }
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        detachDoc();
        down = null;
      }

      listEl.addEventListener('pointerdown', function (e) {
        if (drag) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        var target = e.target;
        if (!target.closest) return;
        var item = target.closest(cfg.itemSel);
        if (!item || !listEl.contains(item) || item.parentElement !== listEl) return;
        var onHandle = !!(cfg.handleSel && target.closest(cfg.handleSel));
        // Drags may only begin in the allowed start zone (provider boxes:
        // the header; host rows: the ⠿ handle only).
        var zone = cfg.startSel || cfg.itemSel;
        if (!onHandle && !target.closest(zone)) return;
        // Never hijack interactive children (▲▼, buttons, links).
        if (!onHandle && target.closest('button,input,select,textarea,a,[data-nodrag]')) return;

        down = {
          item: item,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          handleInstant: onHandle
        };
        // Gesture-level document listeners (removed on finish — no leaks
        // across the panel's innerHTML re-renders).
        docMove = function (ev) {
          if (drag) {
            drag.lastY = ev.clientY;
            applyShifts();
            return;
          }
          if (!down) return;
          var dx = ev.clientX - down.startX;
          var dy = ev.clientY - down.startY;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 4) {
            down.moved = true;
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (down.handleInstant) {
              engage(ev);
              if (drag) { drag.lastY = ev.clientY; applyShifts(); }
            } else if (dist > 8) {
              // A scroll/tap gesture, not a hold → stand down.
              down = null;
            }
          }
        };
        docUp = finish;
        docCancel = function () {
          if (drag) { suppressClickUntil = Date.now() + 400; cleanup(); }
          else finish();
        };
        document.addEventListener('pointermove', docMove);
        document.addEventListener('pointerup', docUp);
        document.addEventListener('pointercancel', docCancel);
        document.addEventListener('touchmove', blockTouch, { passive: false });
        document.addEventListener('contextmenu', blockCtx);

        if (cfg.holdMs && !onHandle) {
          holdTimer = setTimeout(function () {
            if (down && !down.moved) engage(e);
          }, cfg.holdMs);
        }
      });
    }

    // ── Wiring ───────────────────────────────────────────────────────────

    var searchTimer = null;

    function wireEvents() {
      var contentEl = window.ConnectOverlay.getContentEl();
      function clickSuppressed() { return Date.now() < suppressClickUntil; }

      var closeBtn = contentEl.querySelector('#mb-close');
      if (closeBtn) closeBtn.addEventListener('click', window.ConnectOverlay.close);

      var vp = contentEl.querySelector('#mb-view-providers');
      var vm = contentEl.querySelector('#mb-view-models');
      if (vp) vp.addEventListener('click', function () { switchView('providers'); });
      if (vm) vm.addEventListener('click', function () { switchView('models'); });

      var refreshBtn = contentEl.querySelector('#mb-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', function () {
        syncing = true;
        render();
        fetchCatalog(true, function () { render(); });
      });

      var searchInput = contentEl.querySelector('#mb-search');
      if (searchInput) {
        // v0.32.2 C: Esc inside a non-empty search clears it (instead of
        // closing the whole overlay); empty + Esc blurs. stopPropagation so
        // the document-level Esc-close doesn't also fire.
        searchInput.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (searchInput.value) {
              searchInput.value = '';
              search = '';
              render(); // focus+caret are restored by render()
            } else {
              searchInput.blur();
            }
          }
        });
        searchInput.addEventListener('input', function () {
          if (searchTimer) clearTimeout(searchTimer);
          searchTimer = setTimeout(function () {
            search = searchInput.value;
            render();
          }, 200);
        });
      }

      // v0.32 #1: the filter toggle.
      var ft = contentEl.querySelector('#mb-filters-toggle');
      if (ft) ft.addEventListener('click', function () {
        filtersOpen = !filtersOpen;
        lsSet('filtersOpen', filtersOpen);
        render();
      });

      // Filter pills.
      // v0.32.4 P0 BUGFIX: activating a scoring pill (Smart/Agent/Code)
      // auto-aligns the sort to the pill's metric — the pill's documented
      // contract ("Smart = highest→lowest AA") must hold even when a
      // different sort (e.g. 'starred') was persisted from an earlier
      // session. The dropdown visibly updates, so it's discoverable and
      // reversible. Deactivating never touches the sort.
      var PILL_SORT = { intelligence: 'aa', code: 'code', agent: 'agent' };
      contentEl.querySelectorAll('[data-pill]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.dataset.pill;
          var idx = filters.indexOf(key);
          if (idx >= 0) filters.splice(idx, 1);
          else {
            filters.push(key);
            if (PILL_SORT[key] && PILL_SORT[key] !== sortKey) {
              sortKey = PILL_SORT[key];
              lsSet('sort', sortKey);
            }
          }
          lsSet('filters', filters);
          render();
        });
      });

      // Context pills.
      contentEl.querySelectorAll('[data-ctx]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ctxMin = parseInt(btn.dataset.ctx, 10) || 0;
          lsSet('ctxMin', ctxMin);
          render();
        });
      });

      // Pricing pills (self-cancelling — no "Any $").
      contentEl.querySelectorAll('[data-pricing]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          pricing = (pricing === btn.dataset.pricing) ? 'all' : btn.dataset.pricing;
          lsSet('pricing', pricing);
          render();
        });
      });

      var clearBtn = contentEl.querySelector('#mb-clear');
      if (clearBtn) clearBtn.addEventListener('click', function () {
        filters = []; ctxMin = 0; pricing = 'all'; search = '';
        lsSet('filters', []); lsSet('ctxMin', 0); lsSet('pricing', 'all');
        render();
      });

      // v0.32.1 C: the tappable "N hidden · clear" line under the list.
      var clearAll = contentEl.querySelector('[data-clearall]');
      if (clearAll) clearAll.addEventListener('click', function () {
        filters = []; ctxMin = 0; pricing = 'all'; search = '';
        lsSet('filters', []); lsSet('ctxMin', 0); lsSet('pricing', 'all');
        render();
      });

      // v0.32.3 F5: the zero-result empty state's clear buttons.
      contentEl.querySelectorAll('[data-emptyclear]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.dataset.emptyclear === 'search') {
            search = '';
            var si = contentEl.querySelector('#mb-search');
            if (si) si.value = '';
          } else {
            filters = []; ctxMin = 0; pricing = 'all';
            lsSet('filters', []); lsSet('ctxMin', 0); lsSet('pricing', 'all');
          }
          render();
        });
      });

      // v0.32.1 B: the sort select.
      var sortSel = contentEl.querySelector('#mb-sort');
      if (sortSel) sortSel.addEventListener('change', function () {
        sortKey = sortSel.value;
        lsSet('sort', sortKey);
        render();
      });

      // v0.32.2 A: star toggles. In-place restyle (no re-render) so the
      // scroll position survives — EXCEPT when the Starred pill is active
      // (then the row must leave/enter the list).
      contentEl.querySelectorAll('[data-star]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (clickSuppressed()) return;
          var key = btn.dataset.star;
          var wasOn = starred.indexOf(key) >= 0;
          if (wasOn) {
            starred.splice(starred.indexOf(key), 1);
          } else {
            starred.push(key);
          }
          lsSet('starred', starred);
          if (filters.indexOf('starred') >= 0) { render(); return; }
          btn.setAttribute('aria-pressed', wasOn ? 'false' : 'true');
          btn.title = wasOn ? 'star this model' : 'unstar this model';
          btn.style.color = wasOn ? 'var(--border-strong)' : '#eab308';
          btn.style.background = wasOn ? 'transparent' : 'rgba(234,179,8,0.12)';
          btn.style.borderColor = wasOn ? 'transparent' : 'rgba(234,179,8,0.45)';
        });
      });

      // v0.32.1 D: inline add-key flow on view-only provider boxes.
      contentEl.querySelectorAll('[data-addkey]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (clickSuppressed()) return;
          keyAdding = btn.dataset.addkey;
          render();
          var inp = contentEl.querySelector('[data-keyinput]');
          if (inp) inp.focus();
        });
      });
      var keyInput = contentEl.querySelector('[data-keyinput]');
      if (keyInput) {
        keyInput.addEventListener('keydown', function (e) {
          e.stopPropagation();
          if (e.key === 'Enter') saveProviderKey();
          else if (e.key === 'Escape') { keyAdding = null; render(); }
        });
      }
      var keySave = contentEl.querySelector('[data-keysave]');
      if (keySave) keySave.addEventListener('click', function (e) {
        e.stopPropagation();
        saveProviderKey();
      });
      var keyCancel = contentEl.querySelector('[data-keycancel]');
      if (keyCancel) keyCancel.addEventListener('click', function (e) {
        e.stopPropagation();
        keyAdding = null;
        render();
      });

      // ── Providers tab ──
      var provList = contentEl.querySelector('#mb-provlist');
      if (provList) {
        // Provider box expand/collapse (tap the header).
        contentEl.querySelectorAll('[data-provhead]').forEach(function (head) {
          head.addEventListener('click', function (e) {
            if (clickSuppressed()) return;
            if (e.target.closest && e.target.closest('[data-slot],[data-addkey],[data-keyform],[data-grip]')) return;
            var name = head.dataset.provhead;
            providerExpanded[name] = !providerExpanded[name];
            lsSet('providerExpanded', providerExpanded);
            render();
          });
        });

        // v0.32 #8: hold a provider box (or grab its ⠿ grip) and drag to
        // re-order the boxes.
        makeSortable(provList, {
          itemSel: '.mb-provbox',
          startSel: '[data-provhead]',
          handleSel: '[data-grip]',
          holdMs: 220,
          keyOf: function (el) { return el.dataset.prov; },
          onOrder: function (keys) {
            providerOrder = keys;
            lsSet('providerOrder', providerOrder);
            render();
          }
        });
      }

      // Provider model row → select.
      contentEl.querySelectorAll('[data-slot]').forEach(function (row) {
        row.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          var slot = row.dataset.slot;
          var slash = slot.indexOf('/');
          var provider = slot.slice(0, slash);
          var modelId = slot.slice(slash + 1);
          var lg = logicalFor(provider, modelId); // v0.32.3 F1
          if (lg) rememberRecent(lg);
          window.ConnectOverlay.close();
          if (onPick) onPick(provider, modelId);
        });
      });

      // ── Models tab ──
      // v0.32 #6: LEFT zone → select the model.
      contentEl.querySelectorAll('[data-select]').forEach(function (zone) {
        zone.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          selectLogical(zone.dataset.select);
        });
      });

      // v0.32 #6: RIGHT zone (separator, dots, ctx, price, chevron) → open
      // the provider-priority dropdown.
      contentEl.querySelectorAll('[data-expand]').forEach(function (zone) {
        zone.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          var logical = zone.dataset.expand;
          if (expandedLogical[logical]) delete expandedLogical[logical];
          else expandedLogical[logical] = true;
          render();
        });
      });

      // v0.32.4 F2: the ℹ button — toggles the detail drawer. Must NOT
      // trigger the surrounding data-expand zone (stopPropagation) and must
      // stay drag-safe (data-nodrag is on the button).
      contentEl.querySelectorAll('[data-info]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          var logical = btn.dataset.info;
          if (infoOpen[logical]) delete infoOpen[logical];
          else infoOpen[logical] = true;
          render();
        });
      });

      // v0.32.5 F2: the ⚖ compare pin — same guards as the ℹ button
      // (stopPropagation keeps the data-expand zone quiet; data-nodrag
      // keeps the long-press reorder disarmed).
      contentEl.querySelectorAll('[data-compare]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          toggleComparePin(btn.dataset.compare);
          render();
        });
      });

      // v0.32.5 F2: ✕ on the compare drawer / pin hint — unpins everything.
      contentEl.querySelectorAll('[data-cmpclose]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          comparePair = [];
          render();
        });
      });

      // v0.32.6 F2: "use this model" straight from the compare drawer —
      // same path as the row's left-zone select (best key-backed route;
      // keyless → the inline hint explains, overlay stays open).
      contentEl.querySelectorAll('[data-cmpuse]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          selectLogical(btn.dataset.cmpuse);
        });
      });

      // v0.32.6 F3: remove ONE filter via its collapsed chip. The chip's
      // data-unfilter encodes type:value so each kind resets precisely.
      contentEl.querySelectorAll('[data-unfilter]').forEach(function (chip) {
        chip.addEventListener('click', function () {
          if (clickSuppressed()) return;
          var spec = String(chip.dataset.unfilter || '');
          var cut = spec.indexOf(':');
          if (cut < 0) return;
          var kind = spec.slice(0, cut), val = spec.slice(cut + 1);
          if (kind === 'pill') {
            var idx = filters.indexOf(val);
            if (idx >= 0) filters.splice(idx, 1);
            lsSet('filters', filters);
          } else if (kind === 'ctx') {
            ctxMin = 0;
            lsSet('ctxMin', 0);
          } else if (kind === 'pricing') {
            pricing = 'all';
            lsSet('pricing', 'all');
          }
          render();
        });
      });

      // Tapping a HOST row (in the expanded rank list) selects that exact
      // provider+model.
      contentEl.querySelectorAll('[data-hostslot]').forEach(function (row) {
        row.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          if (e.target.closest && e.target.closest('[data-hostup], [data-hostdown], [data-hostgrip]')) return;
          e.stopPropagation();
          var parts = row.dataset.hostslot.split('|');
          var provider = parts.shift();
          var modelId = parts.join('|');
          var lg = logicalFor(provider, modelId); // v0.32.3 F1
          if (lg) rememberRecent(lg);
          window.ConnectOverlay.close();
          if (onPick) onPick(provider, modelId);
        });
      });

      // Host reorder: ▲▼ buttons…
      contentEl.querySelectorAll('[data-hostup]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          moveHost(btn.dataset.hostup, -1);
        });
      });
      contentEl.querySelectorAll('[data-hostdown]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          if (clickSuppressed()) return;
          e.stopPropagation();
          moveHost(btn.dataset.hostdown, 1);
        });
      });

      // …and v0.32 #7: drag-and-drop per expanded logical model.
      contentEl.querySelectorAll('[data-hostlist]').forEach(function (hostListEl) {
        makeSortable(hostListEl, {
          itemSel: '[data-hostslot]',
          startSel: '[data-hostgrip]',
          handleSel: '[data-hostgrip]',
          holdMs: 0,
          keyOf: function (el) { return el.dataset.hostslot; },
          onOrder: function (keys) {
            var logical = hostListEl.dataset.hostlist;
            // Persist provider order (hostOrder is provider-keyed).
            var providers = [];
            keys.forEach(function (k) {
              var p = k.split('|')[0];
              if (providers.indexOf(p) < 0) providers.push(p);
            });
            hostOrder[logical] = providers;
            lsSet('hostOrder', hostOrder);
            render();
          }
        });
      });
    }

    function switchView(v) {
      view = v;
      lsSet('view', view);
      render();
    }

    function moveHost(key, dir) {
      var parts = key.split('|');
      var logical = parts[0];
      var provider = parts.slice(1).join('|');
      // Find current ordered list for this logical.
      var lm = null;
      var logicals = (catalog && catalog.logical) || [];
      for (var i = 0; i < logicals.length; i++) {
        if (logicals[i].logical === logical) { lm = logicals[i]; break; }
      }
      if (!lm) return;
      var hosts = orderedHosts(lm);
      var order = hostOrder[logical] || hosts.map(function (h) { return h.provider; });
      var idx = order.indexOf(provider);
      if (idx < 0) {
        order = hosts.map(function (h) { return h.provider; });
        idx = order.indexOf(provider);
      }
      if (idx < 0) return;
      var swap = idx + dir;
      if (swap < 0 || swap >= order.length) return;
      var tmp = order[idx]; order[idx] = order[swap]; order[swap] = tmp;
      hostOrder[logical] = order;
      lsSet('hostOrder', hostOrder);
      render();
    }

    // ── helpers ──────────────────────────────────────────────────────────
    function fmtCtx(n) {
      if (!n || n <= 0) return '—';
      if (n >= 1000000) return (n % 1000000 === 0) ? '1M' : (n / 1000000).toFixed(0) + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'K';
      return String(n);
    }
    function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function escHTML(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  }

  // v0.32.6 F1: star/unstar from outside the overlay (the ★ quick-switch
  // rows). Returns the NEW state (true = starred). NOTE: deliberately does
  // NOT touch the open()-scoped `starred` copy — the overlay re-reads it
  // from localStorage on every open(), and the quick-switch popup only
  // ever runs while the overlay is closed, so the two never diverge.
  function toggleStar(id) {
    if (!id) return false;
    var list = lsGet('starred', []);
    var idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    lsSet('starred', list);
    return idx < 0;
  }

  window.ModelBrowser = { open: open, quickPick: quickPick, quickEntries: quickEntries, toggleStar: toggleStar };
})();
