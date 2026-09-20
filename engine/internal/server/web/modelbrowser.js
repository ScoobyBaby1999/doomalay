// modelbrowser.js — the dynamic model browser (v0.32 → v0.34).
//
// Port of the HF space's ModelSelectOverlay.tsx (the "tremendous amount of
// work"), v0.13 heritage preserved, OVERHAULED per the v0.32 user spec,
// polished through v0.32.6, then REWORKED for v0.34:
//
//   1. THREE TABS: ★ favorites | Providers | Models (the chat header's ★
//      quick-switch button is GONE — favorites live here now). The last
//      tab is remembered across closes (persisted 'view', like before).
//   2. THE 6-COLUMN ROW (user spec): name (biggest, wraps — never cut
//      off), ★ star, ℹ info (uncollapses the benchmarks beneath the
//      row), ⚖ compare, context, pricing. The MODELS + FAVORITES rows
//      add the subtext line: stat sliders + capability pills + the
//      provider dots (moved OFF the top row) right-aligned with the ➜
//      arrow that opens the provider-priority dropdown. Tapping the top
//      row anywhere except ★/ℹ/⚖/dots/arrow selects the model.
//   3. THE DROP-DOWN (host priority rows) dropped its ⠿ grip + key pill
//      for a 🔑 key/no-key ICON column; drag by holding the row ANYWHERE
//      (except the ▲▼ arrows — taps on those move the row directly).
//   4. "Available" / "All" pills in the filter box (exclusive pair):
//      Available = only models with a key-backed provider; All = the
//      default catalogue. The old 'available' capability pill and the
//      'starred' pill (superseded by the ★ tab) are gone.
//   5. PERFORMANCE (the 1-3s lag): the catalogue re-rendered its ENTIRE
//      ~500-row DOM + re-wired ~4k listeners on EVERY tap. Now: ONE
//      delegated click handler per open (no per-node wiring), surgical
//      zone updates (header / sticky bar / list — the search input node
//      is NEVER replaced), row-level refresh (ℹ/➜ swap ONE row), and the
//      list renders in pages of 100 rows ("show more" + auto-load on
//      scroll) — a filter tap repaints ≤100 rows, not 500+.
//
// Retained from v0.32.x: AA benchmark ranking, sort control, inline
// add-key, live provider dots, current-model ring, compare drawer,
// detail drawers, keyboard navigation, drag reordering, sticky filter
// bar + removable chips, "/" search focus, Esc close.
//
// 100% RUNTIME DATA: everything comes from GET /api/models. Selection
// picks the best host and calls onPick(provider, modelId).
//
// PERSISTENCE (localStorage, same keys as the old app):
//   doomalay.model-select.view / .search / .filters / .filtersOpen /
//   .ctxMin / .pricing / .avail / .providerOrder / .providerExpanded /
//   .hostOrder (per logical model) / .sort / .starred / .recent
//
// Exposes: window.ModelBrowser = { open, quickPick, quickEntries, toggleStar }
(function () {
  'use strict';

  var EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  var LS = 'doomalay.model-select.';
  var PAGE = 100; // rows per list page (the perf cap)

  // Filter pill definitions (label, color, match key).
  // v0.34: 'available' moved to its own exclusive pair; 'starred' moved
  // to the ★ tab — both gone from the OR-pills.
  // v0.34.1 THEME TONES: pill/chip colors compose from the theme vars —
  // a tone is {c:'var(--x)', rgb:'var(--x-rgb)'} so active states render
  // as rgba(var(--x-rgb),a). No raw hex remains in the catalogue (every
  // theme recolors it). Mapping: reasoning/tools→accent-3, smart/agent/
  // ctx→accent, code/all→accent-2, vision/free/avail→ok, paid→warn.
  function tone(name) { return { c: 'var(--' + name + ')', rgb: 'var(--' + name + '-rgb)' }; }
  var PILLS = [
    { key: 'reasoning', label: 'Reason', color: tone('accent-3') },
    { key: 'intelligence', label: 'Smart', color: tone('accent') },
    { key: 'code', label: 'Code', color: tone('accent-2') },
    { key: 'agent', label: 'Agent', color: tone('accent') },
    { key: 'tools', label: 'Tools', color: tone('accent-3') },
    { key: 'vision', label: 'Vision', color: tone('ok') }
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
    { key: 'free', label: 'Free', color: tone('ok') },
    { key: 'paid', label: 'Paid', color: tone('warn') }
  ];
  // v0.34 (user spec #9): the availability pair — Available shows only
  // key-backed models; All restores the default catalogue.
  var AVAIL_OPTIONS = [
    { key: 'available', label: 'Avail', color: tone('ok') },
    { key: 'all', label: 'All', color: tone('accent-2') }
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

  // Self-contained styles (injected once).
  function ensureStyles() {
    if (document.getElementById('mb-v32-styles')) return;
    var s = document.createElement('style');
    s.id = 'mb-v32-styles';
    s.textContent =
      '.mb-logrow,[data-provhead],[data-hostslot],[data-slot],[data-expand],[data-select]{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.mb-logrow [data-select]{border-radius:8px;transition:background 130ms}' +
      '.mb-logrow [data-select]:hover{background:rgba(var(--text-3-rgb),0.10)}' +
      '[data-hostgrip],[data-grip]{user-select:none;-webkit-user-select:none;transition:background 130ms,color 130ms;border-radius:7px}' +
      '[data-hostgrip]:hover,[data-grip]:hover{background:rgba(var(--text-3-rgb),0.14);color:var(--text-1)}' +
      '.mb-dragging{position:relative;z-index:40;box-shadow:0 18px 44px rgba(0,0,0,0.55);cursor:grabbing}' +
      '.mb-dragging *{pointer-events:none}' +
      'body.mb-noselect,body.mb-noselect *{user-select:none!important;-webkit-user-select:none!important}' +
      // v0.32.1 F/G: interaction polish — pills feel pressable, boxes/rows
      // brighten on hover, current row wears a green ring.
      '.mb-pill{transition:transform 120ms cubic-bezier(0.32,0.72,0,1),background 130ms,border-color 130ms,color 130ms}' +
      '.mb-pill:hover{transform:scale(1.05)}' +
      '.mb-pill:active{transform:scale(0.95)}' +
      '.mb-pill:focus-visible,.mb-chevbtn:focus-visible,#mb-sort:focus-visible,#mb-search:focus-visible,[data-keyinput]:focus-visible,[data-info]:focus-visible,[data-compare]:focus-visible,[data-cmpclose]:focus-visible,[data-cmpuse]:focus-visible,[data-unfilter]:focus-visible,[data-avail]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
      '.mb-ufchip:active{transform:scale(0.95)}' +
      // v0.32.7 F3 (ported to the v0.34 rows): star-pop — the tap lands
      // with a little bounce.
      '@keyframes mb-star-pop{0%{transform:scale(0.6)}55%{transform:scale(1.3)}100%{transform:scale(1)}}' +
      '.mb-starbtn.mb-pop{animation:mb-star-pop 260ms cubic-bezier(0.32,0.72,0,1)}' +
      // v0.32.9 F4 (ported): removable chips feel pressable too — a hover lift.
      '.mb-ufchip{transition:transform 120ms cubic-bezier(0.32,0.72,0,1)}' +
      '.mb-ufchip:hover{transform:scale(1.05)}' +
      '.mb-provbox{transition:opacity 200ms,filter 200ms,border-color 150ms}' +
      '.mb-provbox:not(.mb-dragging):hover{border-color:rgba(var(--surface-3-rgb),0.18)!important}' +
      '.mb-logrow{transition:opacity 200ms,filter 200ms,border-color 150ms}' +
      '.mb-logrow:not(.mb-dragging):not(.mb-cur):hover{border-color:rgba(var(--surface-3-rgb),0.16)!important}' +
      '.mb-logrow.mb-cur{border-color:rgba(var(--ok-rgb),0.55)!important}' +
      // v0.34.1 FIX 3: the PROVIDERS tab rings its current model in the
      // PRIMARY theme color (accent — user asked for accent, not ok-green)
      // and the owning provider box gets a softer accent outline. The
      // :hover twin keeps the accent winning over the generic provbox
      // hover rule (equal-specificity !important, later wins).
      '.mb-prow.mb-cur{border-color:rgba(var(--accent-rgb),0.65)!important}' +
      '.mb-provbox.mb-prov-cur,.mb-provbox.mb-prov-cur:not(.mb-dragging):hover{border-color:rgba(var(--accent-rgb),0.55)!important}' +
      '.mb-logrow[data-slot] [data-slotrow]:hover{background:rgba(var(--accent-rgb),0.06)}' +
      '@keyframes mb-hint-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}' +
      '.mb-hint{animation:mb-hint-in 200ms cubic-bezier(0.32,0.72,0,1)}' +
      '.mb-countline{animation:mb-hint-in 160ms cubic-bezier(0.32,0.72,0,1)}' +
      // v0.34: the star is a BARE glyph that turns gold (user spec — no
      // icon+background chip appears on tap).
      '.mb-star{transition:transform 120ms cubic-bezier(0.32,0.72,0,1),color 130ms}' +
      '.mb-star:hover{transform:scale(1.18)}' +
      '.mb-star:active{transform:scale(0.8)}' +
      '.mb-star:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
      // v0.32.4 F2: the ℹ detail-toggle button + the drawer's animated
      // benchmark bars and the drawer's entrance.
      '.mb-infobtn,[data-info],[data-compare]{transition:background 140ms,border-color 140ms,color 140ms}' +
      '[data-info]:hover,[data-compare]:hover{background:rgba(var(--text-3-rgb),0.14);border-color:rgba(var(--surface-3-rgb),0.22)}' +
      '@keyframes mb-bar{from{transform:scaleX(0)}}' +
      '.mb-barfill{transform-origin:left center;animation:mb-bar 480ms cubic-bezier(0.32,0.72,0,1) both}' +
      '@keyframes mb-drawer-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}' +
      '.mb-detail{animation:mb-drawer-in 240ms cubic-bezier(0.32,0.72,0,1)}' +
      // v0.32.3 F4: keyboard focus rings on the roving-tabindex rows.
      '.mb-logrow:focus-visible,[data-provhead]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
      '.mb-keyform input::placeholder{color:var(--border-strong)}' +
      // ── v0.34: THE 6-COLUMN ROW ────────────────────────────────────
      // One grid for every catalogue row (models, favorites, provider
      // rows): NAME takes the remaining width and WRAPS (the full model
      // name is never cut off); the fixed columns stay aligned across
      // rows. Tapping the row (outside the buttons) selects.
      '.mb-r6{display:grid;grid-template-columns:minmax(0,1fr) 28px 28px 28px 44px 58px;gap:7px;align-items:center;padding:9px 12px;cursor:pointer;touch-action:manipulation}' +
      '.mb-r6 .mb-name{font-size:calc(var(--ui-fs) - 1px);font-weight:600;color:var(--text-1);overflow-wrap:anywhere;word-break:break-word;line-height:1.25;min-width:0}' +
      '.mb-r6 .mb-name .mb-curdot{display:inline-block;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--ok);background:var(--ok);box-shadow:0 0 0 3px rgba(var(--ok-rgb),0.18);margin-right:6px;vertical-align:baseline}' +
      '.mb-r6 .mb-ctx{font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3);text-align:right;font-variant-numeric:tabular-nums}' +
      '.mb-r6 .mb-price{font-size:calc(var(--ui-small-fs) - 2px);color:var(--warn);background:rgba(var(--warn-rgb),0.1);border-radius:4px;padding:2px 0;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}' +
      '.mb-r6 .mb-price.mb-free{color:var(--ok);background:rgba(var(--ok-rgb),0.12)}' +
      '.mb-ic{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--surface-2);background:rgba(var(--text-3-rgb),0.06);border-radius:8px;color:var(--text-2);padding:0;cursor:pointer;font-family:inherit;touch-action:manipulation}' +
      '.mb-ic[data-on="1"]{border-color:rgba(var(--accent-rgb),0.55);background:rgba(var(--accent-rgb),0.10);color:var(--accent)}' +
      '.mb-starbtn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;background:transparent;border:none;color:var(--border-strong);font-size:17px;line-height:1;padding:0;cursor:pointer;font-family:inherit;touch-action:manipulation}' +
      '.mb-starbtn[data-on="1"]{color:var(--warn)}' +
      // the subtext line (models + favorites rows): stats + pills left,
      // provider dots + the ➜ arrow right-aligned.
      '.mb-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 12px 9px}' +
      '.mb-sub .mb-subpills{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:1;min-width:0}' +
      '.mb-dots{display:flex;align-items:center;gap:3px;flex-shrink:0;cursor:pointer;touch-action:manipulation}' +
      '.mb-arrowbtn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--surface-2);background:rgba(var(--text-3-rgb),0.06);border-radius:8px;color:var(--text-1);flex-shrink:0;cursor:pointer;transition:background 140ms,border-color 140ms}' +
      '.mb-arrowbtn:hover{background:rgba(var(--text-3-rgb),0.14);border-color:rgba(var(--surface-3-rgb),0.22)}' +
      '.mb-arrowbtn svg{transition:transform 240ms cubic-bezier(0.32,0.72,0,1)}' +
      '.mb-arrowbtn[data-open="1"] svg{transform:rotate(180deg)}' +
      // the host-priority drop-down rows: key icon | name | ctx | price | arrows
      '.mb-hrow{display:grid;grid-template-columns:26px minmax(0,1fr) 44px 58px auto;gap:7px;align-items:center;padding:9px 12px;border-bottom:1px solid rgba(var(--surface-3-rgb),0.04);cursor:pointer;touch-action:manipulation;min-height:44px}' +
      '.mb-hrow .mb-hname{font-size:var(--ui-small-fs);color:var(--text-1);overflow-wrap:anywhere;word-break:break-word;line-height:1.25;min-width:0}' +
      '.mb-hrow .mb-hname .mb-hprov{font-weight:700;color:var(--text-2)}' +
      '.mb-hrow .mb-hname .mb-hid{color:var(--border-strong);font-size:calc(var(--ui-small-fs) - 2px)}' +
      '.mb-keyic{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;flex-shrink:0}' +
      '.mb-keyic svg{width:15px;height:15px}' +
      '.mb-keyic[data-key="1"]{color:var(--ok)}' +
      '.mb-keyic[data-key="0"]{color:var(--border-strong);opacity:0.7}' +
      '.mb-hbtn{background:transparent;border:1px solid var(--border);color:var(--text-3);font-size:9px;padding:6px 8px;border-radius:6px;cursor:pointer;flex-shrink:0;font-family:inherit;touch-action:manipulation;min-width:30px}' +
      '.mb-hbtn:hover{background:rgba(var(--text-3-rgb),0.12);color:var(--text-1)}' +
      '.mb-hrow .mb-ctx,.mb-hrow .mb-price{font-size:calc(var(--ui-small-fs) - 2px)}' +
      // the "show more" pagination row (v0.34.1: the .mb-availpair row is
      // GONE — the avail pair folded into the main pill grid, see filterRow)
      '.mb-more{display:block;width:100%;box-sizing:border-box;background:var(--surface-1);border:1px dashed var(--border);color:var(--text-2);font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;padding:11px;border-radius:10px;cursor:pointer;font-family:inherit;touch-action:manipulation}' +
      '.mb-more:hover{color:var(--text-1);border-color:var(--border-strong)}' +
      // v0.32.3 F5: reduced-motion users get no transform theatrics.
      '@media (prefers-reduced-motion: reduce){' +
      '.mb-pill,.mb-pill:hover,.mb-pill:active,.mb-starbtn,.mb-starbtn:hover,.mb-starbtn:active,' +
      '.mb-arrowbtn svg,.mb-hint,.mb-countline,.mb-barfill,.mb-detail{transition:none!important;animation:none!important}' +
      '}';
    document.head.appendChild(s);
  }

  // ── v0.32.3 F1/F2: module-level QUICK-SWITCH API ─────────────────────
  //
  // The chat panel's ★ button is GONE in v0.34 (favorites moved to the
  // browser's ★ tab), but the API stays exported — quickEntries still
  // powers the recents sort and any future surface.
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
        var wanted = opts.current && opts.current.modelId ? String(opts.current.modelId) : '';
        for (var i = 0; i < hosts.length; i++) {
          if (!best && hosts[i].hasApiKey) best = hosts[i];
          if (opts.current && hosts[i].provider === opts.current.provider &&
              (hosts[i].modelId === wanted ||
               (hosts[i].provider + '/' + hosts[i].modelId) === wanted ||
               lm.logical === wanted)) cur = true;
        }
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
  // v0.32.9 F3 (ported v0.34): "x" clears every filter + search — the
  // browser exposes ModelBrowser.resetFilters while open, inert closed.
  // (Bound once per page.)
  var escBound = false;

  // v0.35.1 LISTENER LIFECYCLE: the browser renders into ConnectOverlay's
  // SINGLETON content element. Every open() used to add another full set
  // of delegated listeners (click/input/keydown/change/scroll) — closures
  // over THAT open's onPick + filters + catalog — and nothing ever
  // detached the previous set. One row tap then fired N listeners: the
  // pick applied to EVERY chat that had ever opened the browser (both
  // icons + both engine sessions patched with the same model — the
  // cross-chat "model bleed"; live-captured: 4 PATCH calls, one per
  // accumulated listener, from 4 different closures). wireOnce now
  // detaches the previous open's handlers before attaching its own.
  var wiredHandlers = []; // [{el, type, fn, opts}]
  function detachWired() {
    for (var i = 0; i < wiredHandlers.length; i++) {
      var w = wiredHandlers[i];
      try { w.el.removeEventListener(w.type, w.fn, w.opts || undefined); } catch (e) {}
    }
    wiredHandlers = [];
  }
  function wireTracked(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    wiredHandlers.push({ el: el, type: type, fn: fn, opts: opts || null });
  }
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
      } else if (e.key === 'x' || e.key === 'X') {
        var tx = e.target;
        if (tx && (tx.tagName === 'INPUT' || tx.tagName === 'TEXTAREA' || tx.tagName === 'SELECT')) return;
        if (window.ModelBrowser && window.ModelBrowser.resetFilters) {
          e.preventDefault();
          window.ModelBrowser.resetFilters();
        }
      }
    });
  }

  function open(onPick, opts) {
    opts = opts || {};
    ensureStyles();
    bindEscOnce();

    // Mutable UI state (persisted where it makes sense).
    var view = (function () {
      var v = lsGet('view', 'providers');
      return (v === 'favorites' || v === 'models' || v === 'providers') ? v : 'providers';
    })();
    var search = '';
    var filters = lsGet('filters', []);
    var filtersOpen = lsGet('filtersOpen', false);
    var ctxMin = lsGet('ctxMin', 0);
    var pricing = lsGet('pricing', 'all');
    var avail = (lsGet('avail', 'all') === 'available') ? 'available' : 'all'; // v0.34
    var providerOrder = lsGet('providerOrder', null);
    var providerExpanded = lsGet('providerExpanded', {});
    var hostOrder = lsGet('hostOrder', {});
    var expandedLogical = {};
    var infoOpen = {}; // v0.32.4 F2: transient per-session detail drawers
    var comparePair = []; // v0.32.5 F2: 0–2 logical ids pinned for compare
    var provComparePair = []; // v0.32.8 F1 (ported v0.34): 0–2 provider names pinned for compare
    var sortKey = lsGet('sort', 'best');
    var currentModel = (opts && opts.current) || null; // {provider, modelId}
    var keyAdding = null; // provider name whose inline key form is open
    var starred = lsGet('starred', []); // v0.32.2 A: logical/family ids
    var shownCount = PAGE; // v0.34: the list render cap (grows via "more")

    // v0.32.9 F3 (ported v0.34): one reset path — the clear button, the
    // hidden-count line and the document-level 'x' shortcut all land here.
    function resetAllFilters() {
      filters = []; ctxMin = 0; pricing = 'all'; avail = 'all'; search = '';
      lsSet('filters', []); lsSet('ctxMin', 0); lsSet('pricing', 'all'); lsSet('avail', 'all');
      shownCount = PAGE;
      var c = window.ConnectOverlay.getContentEl();
      var si = c && c.querySelector('#mb-search');
      if (si) si.value = '';
      updateSticky(); renderList();
    }
    // the document-level 'x' handler (bindEscOnce) reaches in through
    // this hook — re-exposed every open, inert while closed.
    window.ModelBrowser.resetFilters = resetAllFilters;

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
    //
    // v0.34 ZONED RENDER: the overlay is built ONCE with stable zones —
    // the header (#mb-head), the sticky bar (#mb-sticky, the search input
    // LIVES here and is never replaced) and the list (#mb-list). Every
    // interaction updates only the zone it touches; row-level actions
    // (ℹ, ➜) swap a single row. The 1–3s full-catalogue re-render lag is
    // gone.

    function render() {
      // v0.34.1 FIX 1: everything sits in a 16px-padded wrapper — the
      // catalogue no longer rides flush against the overlay's border. The
      // sticky bar's -16px negative margins (below) now work CORRECTLY:
      // they stretch it edge-to-edge across the padded content box.
      var html =
        '<div id="mb-wrap" style="padding:16px">' +
        '<div id="mb-head">' + header() + '</div>' +
        '<div id="mb-sticky" style="position:sticky;top:0;z-index:30;margin:0 -16px;padding:10px 16px 8px;background:var(--surface-1);border-bottom:1px solid var(--surface-2);box-shadow:0 8px 14px -8px rgba(0,0,0,0.45)">' +
        searchBox() +
        filterToggleRow() +
        '</div>' +
        (filtersOpen ? '<div id="mb-filterrow">' + filterRow() + '</div>' : '') +
        '<div id="mb-list">' + listHTML() + '</div>' +
        footer() +
        '</div>';

      // v0.32.2 C: a FULL re-render (catalog sync) replaces the search
      // input — remember focus + caret and restore them after the swap.
      var keepFocus = false, caret = 0;
      if (opened) {
        var oldEl = window.ConnectOverlay.getContentEl();
        var oldSi = oldEl && oldEl.querySelector('#mb-search');
        if (oldSi && oldSi === document.activeElement) {
          keepFocus = true;
          caret = oldSi.selectionStart;
          if (typeof caret !== 'number') caret = oldSi.value.length;
        }
      }

      if (!opened) {
        if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
          window.ConnectOverlay.replaceContent(html, { onSwap: wireZones });
        } else {
          window.ConnectOverlay.open(html, { onSwap: wireZones });
        }
        opened = true;
        wireOnce();
      } else {
        var contentEl = window.ConnectOverlay.getContentEl();
        contentEl.innerHTML = html;
        wireZones();
      }

      if (keepFocus) {
        var newSi = window.ConnectOverlay.getContentEl().querySelector('#mb-search');
        if (newSi) {
          newSi.focus();
          try { newSi.setSelectionRange(caret, caret); } catch (e) {}
        }
      }
    }

    // ── zone updaters (surgical) ─────────────────────────────────────

    function updateHead() {
      var el = window.ConnectOverlay.getContentEl();
      var h = el && el.querySelector('#mb-head');
      if (h) h.innerHTML = header();
    }
    function updateSticky() {
      var el = window.ConnectOverlay.getContentEl();
      var s = el && el.querySelector('#mb-sticky');
      if (!s) return;
      // v0.34: the search input node is only replaced by THIS zone — keep
      // the caret alive for the (rare) filter tap mid-typing.
      var keepFocus = false, caret = 0, hadValue = '';
      var oldSi = s.querySelector('#mb-search');
      if (oldSi && oldSi === document.activeElement) {
        keepFocus = true;
        caret = oldSi.selectionStart;
        if (typeof caret !== 'number') caret = oldSi.value.length;
      }
      s.innerHTML = searchBox() + filterToggleRow();
      // the expanded pill grid sits just BELOW the sticky bar
      var oldRow = el.querySelector('#mb-filterrow');
      if (oldRow) oldRow.remove();
      if (filtersOpen) {
        s.insertAdjacentHTML('afterend', '<div id="mb-filterrow">' + filterRow() + '</div>');
      }
      if (keepFocus) {
        var newSi = s.querySelector('#mb-search');
        if (newSi) {
          newSi.focus();
          try { newSi.setSelectionRange(caret, caret); } catch (e) {}
        }
      }
    }
    function renderList() {
      var el = window.ConnectOverlay.getContentEl();
      var l = el && el.querySelector('#mb-list');
      if (l) l.innerHTML = listHTML();
      wireZones();
    }

    // swap ONE logical row in place (ℹ drawer / ➜ dropdown toggles)
    function refreshRow(logical) {
      var el = window.ConnectOverlay.getContentEl();
      if (!el) return;
      var row = el.querySelector('.mb-logrow[data-logical-id="' + String(logical).replace(/"/g, '\\"') + '"]');
      var lm = findLogical(logical);
      if (!row || !lm) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = logicalRow(lm, false);
      if (tmp.firstChild) row.replaceWith(tmp.firstChild);
    }
    // swap ONE provider model row in place (ℹ drawer toggles)
    function refreshSlotRow(slot) {
      var el = window.ConnectOverlay.getContentEl();
      if (!el) return;
      var row = el.querySelector('.mb-logrow[data-slot="' + String(slot).replace(/"/g, '\\"') + '"]');
      if (!row) return;
      var parts = String(slot).split('/');
      var provider = parts.shift();
      var modelId = parts.join('/');
      var g = groupByName(provider);
      var m = g ? modelById(g, slot) : null; // models[].id carries the full "provider/…" form
      var lm = findLogicalByRoute(provider, modelId);
      if (!m) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = providerModelRow(g, m, lm, false);
      if (tmp.firstChild) row.replaceWith(tmp.firstChild);
    }

    function header() {
      var isFav = view === 'favorites';
      var isProv = view === 'providers';
      var favCount = starred.length;
      return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<h2 style="font-size: calc(var(--ui-fs) + 3px);font-weight:600;color:var(--text-1);margin:0;flex:1">Select a model</h2>' +
        // v0.34: the three tabs — ★ favorites | Providers | Models
        '<div style="display:flex;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:3px">' +
          tabBtn('favorites', '★' + (favCount ? ' ' + favCount : ''), 'var(--warn)') +
          tabBtn('providers', 'Providers', 'var(--ok)') +
          tabBtn('models', 'Models', 'var(--accent)') +
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

    function tabBtn(v, label, accent) {
      var on = view === v;
      return '<button data-viewtab="' + v + '" class="mb-viewtab' + (on ? ' dd-active-tab' : '') + '" style="--dd-accent:' + accent + ';background:transparent;border:none;color:' + (on ? 'var(--text-1)' : 'var(--text-3)') + ';font-size:12px;font-weight:600;font-family:inherit;padding:6px ' + (v === 'providers' ? '12px' : '10px') + ';border-radius:8px;cursor:pointer;position:relative' + (on ? '' : ';white-space:nowrap') + '">' + label + '</button>';
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
      if (avail === 'available') n++;
      return n;
    }

    function filterToggleRow() {
      var n = activeFilterCount();
      var badge = n
        ? '<span style="font-size:10px;font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.14);border:1px solid rgba(var(--ok-rgb),0.45);padding:2px 8px;border-radius:6px;flex-shrink:0">' + n + ' on</span>'
        : '';
      var funnel = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M3 5h18l-7 8.2V19l-4 2v-7.8L3 5z"/></svg>';
      var toggle = '<button id="mb-filters-toggle" style="flex:1;min-width:0;box-sizing:border-box;display:flex;align-items:center;gap:9px;background:var(--surface-1);border:1px solid ' + (n ? 'rgba(var(--ok-rgb),0.5)' : 'var(--surface-2)') + ';color:' + (n ? 'var(--text-1)' : 'var(--text-3)') + ';padding:9px 12px;border-radius:10px;cursor:pointer;font-family:inherit;touch-action:manipulation;transition:border-color 150ms">' +
        funnel +
        '<span style="font-size:12.5px;font-weight:600;flex:1;text-align:left;overflow:hidden;white-space:nowrap">Filters</span>' +
        badge +
        '<span style="display:inline-flex;transition:transform 240ms ' + EASE + ';transform:rotate(' + (filtersOpen ? '180deg' : '0deg') + ');color:var(--text-3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>' +
        '</button>';
      // The clear control sits BESIDE the toggle (a button can't nest a
      // button — the parser would break the structure).
      var clearHTML = (filters.length || ctxMin || pricing !== 'all' || avail !== 'all' || search)
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
    // v0.32.9 F2 (ported v0.34): chips wear the SAME live match count as
    // the expanded pills — both states tell the same story.
    function collapsedFilterChips() {
      if (!activeFilterCount()) return '';
      var chip = function (label, t, attrVal, count) {
        // v0.34.1: t = theme tone {c, rgb} — chips compose rgba() like the
        // pills (the old hex+'1c'/'80' alpha-append can't do var() colors).
        return '<button data-unfilter="' + escAttr(attrVal) + '" class="mb-ufchip" title="remove this filter" style="display:inline-flex;align-items:center;gap:5px;background:rgba(' + t.rgb + ',0.11);border:1px solid rgba(' + t.rgb + ',0.5);color:' + t.c + ';font-size:10.5px;font-weight:600;padding:4px 8px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation;flex-shrink:0">' +
          escHTML(label) +
          (count != null ? ' <span style="font-weight:800;opacity:0.85">' + count + '</span>' : '') +
          '<span style="font-size:9px;opacity:0.85;line-height:1">✕</span></button>';
      };
      var chips = '';
      for (var i = 0; i < filters.length; i++) {
        var def = null;
        for (var p = 0; p < PILLS.length; p++) if (PILLS[p].key === filters[i]) { def = PILLS[p]; break; }
        if (def) chips += chip(def.label, def.color, 'pill:' + def.key, pillCount(def.key));
      }
      if (avail === 'available') chips += chip('Available', tone('ok'), 'avail:available', pillCount('available'));
      if (ctxMin > 0) {
        for (var c = 0; c < CTX_OPTIONS.length; c++) {
          if (CTX_OPTIONS[c].v === ctxMin) { chips += chip(CTX_OPTIONS[c].label + '+', tone('accent'), 'ctx:' + ctxMin, ctxCount(ctxMin)); break; }
        }
      }
      if (pricing !== 'all') {
        for (var pr = 0; pr < PRICING_OPTIONS.length; pr++) {
          if (PRICING_OPTIONS[pr].key === pricing) { chips += chip(PRICING_OPTIONS[pr].label, PRICING_OPTIONS[pr].color, 'pricing:' + pricing, priceCount(pricing === 'free')); break; }
        }
      }
      if (!chips) return '';
      return '<div style="display:flex;flex-wrap:wrap;gap:5px;padding:7px 0 2px">' + chips + '</div>';
    }

    // v0.32.8 F4 → v0.32.9 F2 (hoisted, ported v0.34): per-pill match
    // counts — the pill's OWN predicate against the whole catalog
    // (search/other pills excluded: the count you'd see tapping it on a
    // clean slate). Cheap: ~500 logical models of in-memory checks, and
    // only ON filters compute.
    function pillCount(key) {
      var logical = (catalog && catalog.logical) || [];
      var n = 0;
      for (var i = 0; i < logical.length; i++) {
        var lm = logical[i];
        if (key === 'available') {
          if ((lm.hosts || []).some(function (h) { return h.hasApiKey; })) n++;
        } else if (key === 'starred') {
          if (starred.indexOf(lm.logical) >= 0) n++;
        } else {
          var attrs = lm.attributes || {};
          if (matchesFiltersCaps(attrs.capabilities || [], attrs.effortLevels, attrs.benchmarks || {}, String(lm.logical || '') + ' ' + String(lm.displayName || ''), [key])) n++;
        }
      }
      return n;
    }
    function ctxCount(minV) {
      var logical = (catalog && catalog.logical) || [];
      var n = 0;
      for (var i = 0; i < logical.length; i++) {
        if ((logical[i].contextLength || 0) >= minV) n++;
      }
      return n;
    }
    function priceCount(wantFree) {
      var logical = (catalog && catalog.logical) || [];
      var n = 0;
      for (var i = 0; i < logical.length; i++) {
        if (!!logical[i].isFree === wantFree) n++;
      }
      return n;
    }

    // Squared, uniform, grid-like pills — a real CSS grid: every cell the
    // same width, rows aligned, wrapping naturally, NO horizontal scroll
    // (v0.32 spec #2).
    // v0.34.1: `color` is a theme TONE {c, rgb} — an active pill wears
    // rgba(var(--x-rgb),a) mixes of its theme color.
    function squaredPill(attr, label, color, on) {
      return '<button ' + attr + ' class="mb-pill" aria-pressed="' + (on ? 'true' : 'false') + '" style="display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap;background:' + (on ? 'rgba(' + color.rgb + ',0.13)' : 'transparent') + ';border:1px solid ' + (on ? 'rgba(' + color.rgb + ',0.6)' : 'var(--border)') + ';color:' + (on ? color.c : 'var(--text-3)') + ';font-size:11px;font-weight:600;padding:7px 4px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation">' + label + '</button>';
    }

    function filterRow() {
      // v0.34.1 FIX 4: ONE grid — the availability pair folded IN as regular
      // (shorter-label) cells + a ↺ Reset half-pill at the end. The min
      // column shrank 70→56px so the 15 cells still wrap tidily.
      var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:6px;padding:2px 0 4px;margin-bottom:8px">';
      // Capability pills — v0.32.8 F4: an ACTIVE pill wears its live
      // match count ("Smart 134").
      for (var i = 0; i < PILLS.length; i++) {
        var p = PILLS[i];
        var on = filters.indexOf(p.key) >= 0;
        var cnt = on ? pillCount(p.key) : null;
        html += squaredPill('data-pill="' + p.key + '"', p.label + (cnt != null ? ' ' + cnt : ''), p.color, on);
      }
      // Context pills.
      for (var c = 0; c < CTX_OPTIONS.length; c++) {
        var co = CTX_OPTIONS[c];
        var onC = ctxMin === co.v;
        var cntC = onC && co.v > 0 ? ctxCount(co.v) : null;
        html += squaredPill('data-ctx="' + co.v + '"', co.label + (cntC != null ? ' ' + cntC : ''), tone('accent'), onC);
      }
      // Pricing pills (self-cancelling toggles — no "Any $").
      for (var pr = 0; pr < PRICING_OPTIONS.length; pr++) {
        var po = PRICING_OPTIONS[pr];
        var onP = pricing === po.key;
        var cntP = onP ? priceCount(po.key === 'free') : null;
        html += squaredPill('data-pricing="' + po.key + '"', po.label + (cntP != null ? ' ' + cntP : ''), po.color, onP);
      }
      // v0.34 (user spec #9) → v0.34.1: the availability pair lives IN the
      // grid now (short labels; the count still rides the ACTIVE side).
      var availCnt = pillCount('available');
      html += squaredPill('data-avail="available" title="available models only"', 'Avail' + (avail === 'available' ? ' ' + availCnt : ''), tone('ok'), avail === 'available');
      html += squaredPill('data-avail="all" title="all models"', 'All' + (avail === 'all' ? ' ' + (catalog && catalog.logical ? catalog.logical.length : '') : ''), tone('accent-2'), avail === 'all');
      // v0.34.1: the 15th cell — the ↺ Reset half-pill (one tap = the
      // same reset as the "clear" button / the 'x' key).
      html += '<button data-resetfilters="1" title="reset all filters" class="mb-pill" style="display:flex;align-items:center;justify-content:center;gap:3px;overflow:hidden;white-space:nowrap;background:transparent;border:1px solid var(--border-strong);color:var(--text-2);font-size:10px;font-weight:600;padding:5px 4px;border-radius:8px;font-family:inherit;cursor:pointer;touch-action:manipulation">↺ Reset</button>';
      html += '</div>';
      return html;
    }

    // ── THE LIST ZONE (per tab) ──────────────────────────────────────

    function listHTML() {
      if (view === 'providers') return providerView();
      if (view === 'favorites') return favoritesView();
      return modelsView();
    }

    function matchingLogicals() {
      var logical = ((catalog && catalog.logical) || []).slice();
      var matching = [];
      for (var i = 0; i < logical.length; i++) {
        if (logicalMatches(logical[i])) matching.push(logical[i]);
      }
      applySort(matching);
      return { all: logical, matching: matching };
    }

    // v0.34: the ★ FAVORITES tab — the starred logical models, same
    // 6-column rows + subtext as the models tab. Unstarring here removes
    // the row live (the star tap special-case).
    function favoritesView() {
      var out = '';
      var list = [];
      var logical = (catalog && catalog.logical) || [];
      for (var i = 0; i < logical.length; i++) {
        if (starred.indexOf(logical[i].logical) >= 0) list.push(logical[i]);
      }
      applySort(list);
      if (!starred.length) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:calc(var(--ui-fs) - 1px)">' +
          'No favorites yet — tap the <span style="color:var(--warn)">★</span> on any model to pin it here.</div>';
      } else if (!list.length) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:calc(var(--ui-fs) - 1px)">' +
          (starred.length === 1 ? 'Your favorited model left the catalogue.' : 'Your ' + starred.length + ' favorited models left the catalogue.') + '</div>';
      } else {
        var shown = 0;
        for (var l = 0; l < list.length && l < shownCount; l++) {
          out += logicalRow(list[l], l === 0);
          shown++;
        }
        out += moreRow(shown, list.length);
      }
      var counts = list.length
        ? '<div class="mb-countline" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3)"><span>' + list.length + ' favorite' + (list.length === 1 ? '' : 's') + '</span><span style="color:var(--warn);font-weight:600">★ pinned</span></div>'
        : '';
      return sortControl() + counts + compareZone(list) + '<div style="display:flex;flex-direction:column;gap:6px">' + out + '</div>';
    }

    // v0.32.3 F5: friendly zero-result state (search or filters).
    function emptyStateHtml() {
      var hasSearch = !!search;
      var hasFilters = filters.length > 0 || pricing !== 'all' || ctxMin > 0 || avail !== 'all';
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

    // v0.34: the pagination row — "showing X of Y · show more" (also
    // auto-loads when the user scrolls near the bottom).
    function moreRow(shown, total) {
      if (shown >= total) return '';
      return '<button id="mb-more" class="mb-more" style="margin-top:4px">show ' + Math.min(PAGE, total - shown) + ' more · ' + shown + ' of ' + total + '</button>';
    }

    function modelsView() {
      var res = matchingLogicals();
      var matching = res.matching;
      var logical = res.all;
      var out = '';
      if (!matching.length) {
        out = emptyStateHtml();
      }
      var shown = 0;
      for (var l = 0; l < matching.length && l < shownCount; l++) {
        out += logicalRow(matching[l], l === 0);
        shown++;
      }
      out += moreRow(shown, matching.length);
      var hidden = logical.length - matching.length;
      if (hidden > 0 && matching.length) {
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
        ? '<div class="mb-countline" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3)"><span>' + matching.length + ' of ' + logical.length + ' models</span><span style="display:flex;gap:10px;align-items:center"><span id="mb-star-total" title="favorited models" style="color:var(--warn);font-weight:600">★ ' + starred.length + '</span><span style="color:' + (withKeys ? 'var(--ok)' : 'var(--text-3)') + ';font-weight:600">' + withKeys + ' with your keys</span></span></div>'
        : '';
      return sortControl() + counts + compareZone(logical) + '<div style="display:flex;flex-direction:column;gap:6px">' + out + '</div>';
    }

    // v0.32.5 F2: compare drawer (pair complete) or the pin hint (one
    // pinned, waiting for the second). Rendered above the list.
    function compareZone(logical) {
      if (comparePair.length === 2) return compareDrawer(comparePair[0], comparePair[1]);
      if (comparePair.length !== 1) return '';
      var pl = null;
      for (var pc = 0; pc < logical.length; pc++) {
        if (logical[pc].logical === comparePair[0]) { pl = logical[pc]; break; }
      }
      if (!pl) return '';
      return '<div data-nodrag style="display:flex;align-items:center;gap:8px;border:1px dashed rgba(var(--accent-rgb),0.45);border-radius:10px;padding:8px 12px;margin-bottom:10px;background:rgba(var(--accent-rgb),0.05)">' +
        '<span style="font-size:11px;color:var(--accent);flex-shrink:0">⚖</span>' +
        '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="color:var(--text-1)">' + escHTML(pl.displayName || pl.logical) + '</b> pinned — tap ⚖ on another model</span>' +
        '<button data-cmpclose data-nodrag title="unpin" aria-label="unpin compare" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:10px;width:20px;height:20px;border-radius:6px;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0">✕</button>' +
        '</div>';
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

    // v0.32.8 F3 (ported v0.34): surgical ★-count update for the
    // models-tab counts line — the star tap is in-place (no re-render),
    // so the total follows here and pops on the CHANGE.
    function updateStarCountline() {
      var c = window.ConnectOverlay.getContentEl();
      var el = c && c.querySelector('#mb-star-total');
      if (!el) return;
      el.textContent = '★ ' + starred.length;
      el.classList.remove('mb-pop');
      void el.offsetWidth;
      el.classList.add('mb-pop');
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

    // v0.34.1 FIX 3: is this exact provider ROUTE the chat's current
    // model? Mirrors isCurrentModel()'s id forms (bare modelId,
    // "provider/modelId", logical id) but keyed to the exact provider —
    // the Providers tab rings ITS current row in the primary accent.
    function isCurrentRoute(g, m, lm) {
      if (!currentModel || !currentModel.modelId) return false;
      if (currentModel.provider !== g.name) return false;
      var cm = String(currentModel.modelId);
      var mid = String(m.id || '');
      if (mid === cm) return true;
      var cutAt = mid.indexOf('/');
      if (cutAt > 0 && mid.slice(0, cutAt) === g.name && mid.slice(cutAt + 1) === cm) return true;
      if (lm && lm.logical === cm) return true;
      return false;
    }
    // v0.34.1 FIX 3: does the current model belong to this provider's box?
    // (provider names are the shared key across hosts[]/groups[] — the
    // box gets the soft .mb-prov-cur accent outline)
    function providerHasCurrent(g) {
      return !!(currentModel && currentModel.modelId && currentModel.provider === g.name);
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

    function groupByName(name) {
      var groups = (catalog && catalog.groups) || [];
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].name === name) return groups[i];
      }
      return null;
    }

    function modelById(g, id) {
      var models = g.models || [];
      for (var i = 0; i < models.length; i++) {
        if (models[i].id === id) return models[i];
      }
      return null;
    }

    function findLogicalByRoute(provider, modelId) {
      var logical = (catalog && catalog.logical) || [];
      for (var i = 0; i < logical.length; i++) {
        var hh = logical[i].hosts || [];
        for (var j = 0; j < hh.length; j++) {
          if (hh[j].provider === provider && hh[j].modelId === modelId) return logical[i];
        }
      }
      return null;
    }

    function providerView() {
      var groups = orderedGroups();
      var availOnly = avail === 'available';
      var out = '';
      var shown = 0, ready = 0;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].hasApiKey) ready++;
        // "Available" hides keyless providers' boxes entirely (their models
        // are all filtered out anyway).
        if (availOnly && !groups[i].hasApiKey) continue;
        out += providerBox(groups[i], shown === 0);
        shown++;
      }
      if (!groups.length) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size: calc(var(--ui-fs) - 1px)">Syncing providers…</div>';
      } else if (availOnly && !out) {
        out = '<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size: calc(var(--ui-fs) - 1px)">No providers with API keys yet — paste a key to unlock them.</div>';
      }
      // v0.32.8 F1 (ported v0.34): the provider-compare drawer (pair
      // complete) or the pin hint (one pinned).
      var cmp = '';
      if (provComparePair.length === 2) {
        var ga = null, gb = null;
        for (var pcg = 0; pcg < groups.length; pcg++) {
          if (groups[pcg].name === provComparePair[0]) ga = groups[pcg];
          if (groups[pcg].name === provComparePair[1]) gb = groups[pcg];
        }
        if (ga && gb) cmp = provCompareDrawer(ga, gb);
      } else if (provComparePair.length === 1) {
        var gp = null;
        for (var pch = 0; pch < groups.length; pch++) {
          if (groups[pch].name === provComparePair[0]) { gp = groups[pch]; break; }
        }
        if (gp) cmp = provCompareHint(gp);
      }
      // v0.32.1 C: live counts line.
      var counts = groups.length
        ? '<div class="mb-countline" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3)"><span>' + shown + ' of ' + groups.length + ' providers</span><span style="color:' + (ready ? 'var(--ok)' : 'var(--text-3)') + ';font-weight:600">' + ready + ' ready</span></div>'
        : '';
      return cmp + counts + '<div id="mb-provlist" style="display:flex;flex-direction:column;gap:10px">' + out + '</div>';
    }

    function providerBox(g, kbFirst) {
      var expanded = !!providerExpanded[g.name];
      // v0.34 PERF: the matching model rows are only computed for
      // EXPANDED boxes (a collapsed catalogue was matching ~3k models on
      // every render — a fat slice of the 1-3s lag).
      var rows = '';
      var filteredOut = 0;
      if (expanded) {
        var matching = [];
        var models = g.models || [];
        for (var i = 0; i < models.length; i++) {
          if (modelMatches(models[i], g)) matching.push(models[i]);
          else filteredOut++;
        }
        for (var m = 0; m < matching.length; m++) {
          // m.id is "provider/modelId" — strip the provider prefix for the
          // logical lookup (hosts[].modelId carries no provider prefix).
          var mid = String(matching[m].id || '');
          var cutAt = mid.indexOf('/');
          var lm = (cutAt >= 0 && mid.slice(0, cutAt) === g.name)
            ? findLogicalByRoute(g.name, mid.slice(cutAt + 1))
            : findLogicalByRoute(g.name, mid);
          rows += providerModelRow(g, matching[m], lm, m === 0 && kbFirst);
        }
        if (filteredOut > 0) {
          rows += '<div style="padding:8px 12px;font-size: calc(var(--ui-small-fs) - 1px);color:var(--border-strong);opacity:0.8">▸ ' + filteredOut + ' filtered out</div>';
        }
      }
      var liveDot = g.syncedLive ? '<span class="dd-live-dot" title="synced live from provider API"></span>' : '<span class="dd-live-dot dd-stale" title="no live sync"></span>';
      // v0.32 #5 → v0.34.1 FIX 2: the availability badge and the one-tap
      // key unlock MERGED — a keyless provider shows a single "+ key" pill
      // BUTTON (accent, dashed) in the old "view only" slot; the separate
      // ＋ key button is gone (no duplicates, data-addkey semantics kept:
      // the value is the provider name the click handler feeds keyAdding).
      var keyBadge = g.hasApiKey
        ? '<span style="font-size:10px;font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.4);padding:2px 8px;border-radius:5px;white-space:nowrap">ready</span>'
        : '<button data-addkey="' + escAttr(g.name) + '" data-nodrag title="paste an API key for ' + escAttr(g.displayName || g.name) + '" style="font-size:10px;font-weight:700;color:var(--accent);background:rgba(var(--accent-rgb),0.12);border:1px dashed rgba(var(--accent-rgb),0.5);padding:2px 8px;border-radius:5px;white-space:nowrap;cursor:pointer;font-family:inherit;touch-action:manipulation">+ key</button>';
      var chevron = expanded ? '▾' : '▸';
      // v0.32.8 F1 (ported v0.34): the provider-compare pin on the box.
      var cmpPinned = provComparePair.indexOf(g.name) >= 0;
      var provCmpBtn = '<button data-pcmp="' + escAttr(g.name) + '" data-nodrag class="mb-ic" data-on="' + (cmpPinned ? '1' : '0') + '" aria-pressed="' + (cmpPinned ? 'true' : 'false') + '" title="' + (cmpPinned ? (provComparePair.length === 2 ? 'in compare — tap to remove' : 'pinned for compare — tap to unpin') : 'compare with another provider') + '" style="width:26px;height:26px;font-size:12px;line-height:1">⚖</button>';
      // v0.32 #8: grip — instant drag handle on the box.
      var grip = '<span data-grip data-nodrag title="drag to re-order providers" style="cursor:grab;color:var(--text-3);width:26px;height:26px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:7px;touch-action:none;font-size:13px;line-height:1">⠿</span>';
      // (v0.32.1 D's separate addKeyBtn is GONE — merged into keyBadge above.)

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
          '<button data-keysave="' + escAttr(g.name) + '" data-nodrag style="background:var(--ok);border:none;color:var(--surface-1);font-size:11px;font-weight:700;padding:8px 12px;border-radius:8px;cursor:pointer;font-family:inherit;white-space:nowrap">Save</button>' +
          '<button data-keycancel data-nodrag title="cancel" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:11px;padding:8px 10px;border-radius:8px;cursor:pointer;font-family:inherit">✕</button>' +
          '</div>';
      }
      // v0.34.1 FIX 3: the box owning the chat's current model wears the
      // .mb-prov-cur accent outline (CSS rule in ensureStyles).
      var provCur = providerHasCurrent(g);
      return '<div class="mb-provbox' + (provCur ? ' mb-prov-cur' : '') + '" data-prov="' + escAttr(g.name) + '" style="background:var(--surface-1);border:1px solid ' + (expanded ? 'rgba(var(--surface-3-rgb),0.14)' : 'var(--surface-2)') + ';border-radius:12px;overflow:hidden;--dd-accent:' + (g.color || 'var(--ok)') + ';' + dim + 'transition:opacity 200ms,filter 200ms">' +
        // v0.34.1 FIX 2: a GRID header — the count / ⚖ / grip columns are
        // FIXED widths now, so every provider row aligns identically
        // whether it holds 10 or 400 models.
        '<div data-provhead="' + escAttr(g.name) + '" role="button" tabindex="' + (kbFirst ? 0 : -1) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" style="display:grid;grid-template-columns:14px 10px minmax(0,1fr) auto auto 34px 26px 26px;gap:9px;align-items:center;padding:12px 14px;cursor:pointer;touch-action:manipulation">' +
          '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3)">' + chevron + '</span>' +
          '<span style="width:10px;height:10px;border-radius:50%;background:' + (g.color || 'var(--border-strong)') + '"></span>' +
          '<span style="font-size: var(--ui-fs);font-weight:600;color:var(--text-1);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(g.displayName || g.name) + '</span>' +
          keyBadge +
          liveDot +
          '<span title="' + (g.modelCount || 0) + ' models" style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);width:34px;text-align:right;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (g.modelCount || 0) + '</span>' +
          provCmpBtn +
          grip +
        '</div>' +
        keyForm +
        detailStrip +
        (expanded ? '<div style="max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid var(--surface-2)">' + (rows || '<div style="padding:16px;font-size: var(--ui-small-fs);color:var(--text-3);text-align:center">no models match' + (g.hasApiKey ? '' : ' — no API key yet') + '</div>') + '</div>' : '') +
        '</div>';
    }

    // ── SHARED ROW BUILDERS ────────────────────────────────────────────

    // The 6 fixed columns every catalogue row shares (user spec): the
    // NAME (biggest, wraps) + ★ + ℹ + ⚖ + context + pricing. `kind`
    // distinguishes the row's click behavior (logical select vs route
    // select); `isRoute` rows sit inside provider boxes.
    function row6Columns(opts) {
      var name = opts.name;
      if (opts.isCur) name = '<span class="mb-curdot" title="current model"></span>' + name;
      var star = opts.starKey
        ? '<button data-star="' + escAttr(opts.starKey) + '" class="mb-starbtn" data-on="' + (starred.indexOf(opts.starKey) >= 0 ? '1' : '0') + '" aria-pressed="' + (starred.indexOf(opts.starKey) >= 0 ? 'true' : 'false') + '" title="' + (starred.indexOf(opts.starKey) >= 0 ? 'unstar this favorite' : 'star this favorite') + '">★</button>'
        : '<span></span>';
      var info = '<button data-info="' + escAttr(opts.infoKey) + '" data-nodrag class="mb-ic" data-on="' + (opts.infoOn ? '1' : '0') + '" aria-expanded="' + (opts.infoOn ? 'true' : 'false') + '" title="model details — benchmarks, pricing, ranks">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.2" r="0.4" fill="currentColor" stroke="none"/></svg>' +
        '</button>';
      var cmpIdx = comparePair.indexOf(opts.infoKey);
      var cmp = '<button data-compare="' + escAttr(opts.infoKey) + '" data-nodrag class="mb-ic" data-on="' + (cmpIdx >= 0 ? '1' : '0') + '" aria-pressed="' + (cmpIdx >= 0 ? 'true' : 'false') + '" title="' + (cmpIdx >= 0 ? (comparePair.length === 2 ? 'in compare — tap to remove' : 'pinned for compare — tap to unpin') : 'compare with another model') + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>' +
        '</button>';
      var price;
      if (opts.isFree) {
        price = '<span class="mb-price mb-free">free</span>';
      } else {
        var pMatch = String(opts.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
        price = pMatch
          ? '<span class="mb-price" title="' + escAttr(opts.pricing) + '">$' + pMatch[1] + '/M</span>'
          : '<span class="mb-price">paid</span>';
      }
      // grid order = the user's column order: NAME | ★ | ℹ | ⚖ | ctx | price
      return '<span class="mb-name">' + name + '</span>' +
        star + info + cmp +
        '<span class="mb-ctx">' + (opts.ctx || '—') + '</span>' +
        price;
    }

    // v0.34: the star button — a bare ★ that turns gold (no chip).
    function starBtnHtml(key) {
      var on = starred.indexOf(key) >= 0;
      return '<button data-star="' + escAttr(key) + '" class="mb-starbtn" data-on="' + (on ? '1' : '0') + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + (on ? 'unstar this favorite' : 'star this favorite') + '">★</button>';
    }

    // ── THE MODELS / FAVORITES ROW ─────────────────────────────────────
    //
    // The 6-column top row (tapping anywhere except ★/ℹ/⚖/dots selects)
    // + the subtext line: stat sliders, capability pills, then the
    // provider dots + ➜ arrow right-aligned (the dropdown trigger).
    function logicalRow(lm, kbFirst) {
      var expanded = !!expandedLogical[lm.logical];
      var hosts = orderedHosts(lm);
      var available = hosts.some(function (h) { return h.hasApiKey; });
      var isCur = isCurrentModel(lm); // v0.32.1 E
      var attrs = lm.attributes || {};
      var infoOpenNow = !!infoOpen[lm.logical];

      // v0.34: the top formatted row — the shared 6 columns. Tapping it
      // (outside its buttons) SELECTS the model.
      var top = '<div class="mb-r6" data-select="' + escAttr(lm.logical) + '" role="button" tabindex="-1" title="' + (isCur ? 'current model — tap to keep' : 'select this model') + '">' +
        row6Columns({
          name: escHTML(lm.displayName || lm.logical),
          isCur: isCur,
          starKey: lm.logical,
          infoKey: lm.logical,
          infoOn: infoOpenNow,
          isFree: !!lm.isFree,
          pricing: attrs.pricing,
          ctx: fmtCtx(lm.contextLength)
        }) +
        '</div>';

      // v0.34: the subtext — stats (mini-bar chips), capability pills,
      // then the provider dots + arrow right-aligned.
      var sub = subtextRow(lm, hosts, expanded);

      // v0.32 #5/#9: dimming carries availability; the row tap selects.
      var dim = available ? '' : 'opacity:0.55;filter:saturate(0.6);';

      return '<div class="mb-logrow' + (isCur ? ' mb-cur' : '') + '" data-logical-id="' + escAttr(lm.logical) + '" tabindex="' + (kbFirst ? 0 : -1) + '" style="background:var(--surface-1);border:1px solid ' + (isCur ? 'rgba(var(--ok-rgb),0.55)' : (expanded ? 'rgba(var(--surface-3-rgb),0.14)' : 'var(--surface-2)')) + ';border-radius:12px;overflow:hidden;' + dim + 'transition:opacity 200ms,filter 200ms">' +
        top +
        sub +
        (infoOpenNow ? detailDrawer(lm) : '') +
        (expanded ? '<div data-hostlist="' + escAttr(lm.logical) + '" style="border-top:1px solid var(--surface-2)">' + hostRowsHTML(lm, hosts) + '</div>' : '') +
        '</div>';
    }

    function subtextRow(lm, hosts, expanded) {
      var attrs = lm.attributes || {};
      var bm = attrs.benchmarks || {};
      var pills = '';
      if (bm.intelligence) pills += bmChip('AA ' + Math.round(bm.intelligence), bm.intelligence);
      if (bm.coding) pills += bmChip('code ' + Math.round(bm.coding), bm.coding);
      if (bm.agentic) pills += bmChip('agent ' + Math.round(bm.agentic), bm.agentic);
      var caps = attrs.capabilities || [];
      for (var c = 0; c < caps.length && c < 5; c++) {
        pills += capChip(caps[c]);
      }
      if (attrs.effortLevels && attrs.effortLevels.length) pills += capChip('effort');
      if (!pills) pills = '<span style="font-size:calc(var(--ui-small-fs) - 3px);color:var(--border-strong)">no stats published</span>';

      // v0.34: the provider dots moved from the top row to HERE, right
      // before the ➜ arrow (both open the priority dropdown).
      var dots = '';
      var shown = Math.min(hosts.length, 5);
      for (var d = 0; d < shown; d++) {
        dots += '<span style="width:7px;height:7px;border-radius:50%;background:' + (hosts[d].color || 'var(--border-strong)') + ';opacity:' + (hosts[d].hasApiKey ? 1 : 0.35) + ';flex-shrink:0" title="' + escAttr(hosts[d].providerDisplayName || hosts[d].provider) + (hosts[d].hasApiKey ? ' (key)' : '') + '"></span>';
      }
      if (hosts.length > 5) dots += '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:var(--text-3)">+' + (hosts.length - 5) + '</span>';

      return '<div class="mb-sub">' +
        '<span class="mb-subpills">' + pills + '</span>' +
        '<span class="mb-dots" data-expand="' + escAttr(lm.logical) + '" role="button" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="provider priority">' + dots + '</span>' +
        '<button class="mb-arrowbtn" data-expand="' + escAttr(lm.logical) + '" data-open="' + (expanded ? '1' : '0') + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="re-arrange this model\'s providers" data-nodrag>' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>' +
        '</button>' +
      '</div>';
    }

    // v0.34 (user spec #8): the host-priority drop-down rows — a 🔑
    // key/no-key ICON column (the old ⠿ grip + "key ✓ / no key" pill are
    // gone), the name (provider + route id, wraps), context, pricing,
    // and ▲▼. Drag by holding the row ANYWHERE (except the arrows);
    // tapping the arrows moves the row directly; tapping the row picks
    // that exact provider+model.
    function hostRowsHTML(lm, hosts) {
      var html = '';
      for (var h = 0; h < hosts.length; h++) {
        var hr = hosts[h];
        var price;
        if (hr.isFree) {
          price = '<span class="mb-price mb-free">free</span>';
        } else {
          var rpm = String(hr.pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
          price = rpm
            ? '<span class="mb-price" title="' + escAttr(hr.pricing) + '">$' + rpm[1] + '/M</span>'
            : '<span class="mb-price">paid</span>';
        }
        var keyIcon = '<span class="mb-keyic" data-key="' + (hr.hasApiKey ? '1' : '0') + '" title="' + (hr.hasApiKey ? 'API key set — ready to use' : 'no API key for this provider yet') + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9"/><path d="m17 2 4 4"/><path d="m14.5 8.5 2 2"/></svg>' +
          '</span>';
        html += '<div class="mb-hrow" data-hostslot="' + escAttr(hr.provider + '|' + hr.modelId) + '" title="' + (hr.hasApiKey ? 'select this route · hold to drag' : 'no key — select adds it to the plan') + '">' +
          keyIcon +
          '<span class="mb-hname"><span class="mb-hprov">' + escHTML(hr.providerDisplayName || hr.provider) + '</span>' +
            '<br><span class="mb-hid">' + escHTML(hr.modelId) + '</span></span>' +
          '<span class="mb-ctx">' + fmtCtx(hr.contextLength) + '</span>' +
          price +
          '<span style="display:flex;gap:4px;align-items:center">' +
            '<button data-hostup="' + escAttr(lm.logical + '|' + hr.provider) + '" class="mb-hbtn" data-nodrag title="raise priority">▲</button>' +
            '<button data-hostdown="' + escAttr(lm.logical + '|' + hr.provider) + '" class="mb-hbtn" data-nodrag title="lower priority">▼</button>' +
          '</span>' +
          '</div>';
      }
      return html;
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
      var color = score >= 70 ? 'var(--ok)' : (score >= 40 ? 'var(--warn)' : 'var(--text-3)');
      // v0.32.1 G: a 32×3px score mini-bar next to the number — the score
      // becomes readable at a glance (green ≥70, amber ≥40).
      var pct = Math.max(5, Math.min(100, Math.round(score)));
      return '<span style="display:inline-flex;align-items:center;gap:5px;font-size: calc(var(--ui-small-fs) - 3px);color:' + color + ';background:rgba(var(--surface-3-rgb),0.04);padding:1px 6px;border-radius:4px">' + text +
        '<span style="width:32px;height:3px;border-radius:2px;background:rgba(var(--text-3-rgb),0.22);overflow:hidden;flex-shrink:0" title="score ' + Math.round(score) + '/100"><i style="display:block;height:100%;width:' + pct + '%;background:' + color + ';border-radius:2px;opacity:0.85"></i></span>' +
        '</span>';
    }

    // v0.34.1 THEME SWEEP: capability chips compose from theme tones too
    // (the old code appended raw hex alpha — impossible with var()
    // colors). audio keeps the persona tint when the theme has one.
    var CAP_COLORS = {
      reasoning: tone('accent-3'),
      code: tone('accent-2'),
      tools: tone('accent'),
      vision: tone('ok'),
      audio: { c: 'var(--persona-tint,var(--accent))', rgb: 'var(--persona-rgb,var(--accent-rgb))' },
      agents: tone('accent')
    };
    function capChip(cap) {
      var key = String(cap).toLowerCase();
      var t = CAP_COLORS[key] || null;
      return '<span style="font-size: calc(var(--ui-small-fs) - 3px);color:' + (t ? t.c : 'var(--text-3)') + ';background:' + (t ? 'rgba(' + t.rgb + ',0.08)' : 'rgba(var(--text-3-rgb),0.08)') + ';padding:1px 6px;border-radius:4px">' + escHTML(cap) + '</span>';
    }

    // ── THE PROVIDER MODEL ROW (v0.34: the same 6-column format) ──────
    //
    // Same columns as the models tab (name | ★ | ℹ | ⚖ | ctx | price);
    // ℹ uncollapses the model's benchmarks beneath the row — the exact
    // method and function as the models tab. Tapping the row (outside the
    // buttons) selects that exact provider+model.
    function providerModelRow(g, m, lm, kbFirst) {
      var slot = m.id; // "provider/modelId"
      var infoKey = lm ? lm.logical : (slot);
      var infoOpenNow = !!(lm && infoOpen[lm.logical]);
      var starKey = lm ? lm.logical : (m.family || '');
      var isCur = isCurrentRoute(g, m, lm); // v0.34.1 FIX 3: real current-model state (was hardcoded false)
      var top = '<div class="mb-r6" data-slotrow="' + escAttr(slot) + '" role="button" tabindex="' + (kbFirst ? 0 : -1) + '" title="' + escAttr(m.displayName || m.rawId) + '">' +
        row6Columns({
          name: escHTML(m.displayName || m.rawId),
          isCur: isCur,
          starKey: starKey || null,
          infoKey: infoKey,
          infoOn: infoOpenNow,
          isFree: !!m.isFree,
          pricing: m.pricing,
          ctx: fmtCtx(m.contextLength)
        }) +
        '</div>';
      var drawer = (infoOpenNow && lm) ? detailDrawer(lm) : '';
      var hasKey = !!g.hasApiKey;
      return '<div class="mb-logrow mb-prow' + (isCur ? ' mb-cur' : '') + '" data-slot="' + escAttr(slot) + '" data-logical-id="' + escAttr(lm ? lm.logical : '') + '" style="background:var(--surface-1);border:1px solid ' + (isCur ? 'rgba(var(--accent-rgb),0.55)' : 'var(--surface-2)') + ';border-radius:10px;' + (hasKey ? '' : 'opacity:0.55;filter:saturate(0.6);') + 'margin:6px 8px">' +
        top + drawer + '</div>';
    }

    // v0.32.4 F2: the MODEL DETAIL DRAWER — a per-row expandable card with
    // full benchmark bars, the prompt/completion pricing split, context,
    // capabilities, effort levels, usage-rank chips (OpenRouter ranks) and
    // a hosts summary. Purely informational — selection stays on the row,
    // priority stays on the ➜ dropdown.
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
        html += '<div style="display:flex;gap:8px;align-items:center"><span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3);flex-shrink:0">Pricing</span><span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;color:var(--ok)">free route</span></div>';
      } else if (pm) {
        html += '<div style="display:flex;flex-direction:column;gap:5px">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3)">Pricing <span style="font-weight:400;letter-spacing:0;text-transform:none">· prompt / completion per M</span></div>' +
          '<div style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-1);font-variant-numeric:tabular-nums"><b>$' + pm[1] + '</b> <span style="color:var(--text-3)">/</span> <b>$' + pm[2] + '</b></div>' +
          '</div>';
      }

      // ── Facts: context, capabilities, effort levels ──
      var facts = '';
      if (lm.contextLength) facts += '<span title="context window" style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);padding:2px 8px;border-radius:5px;white-space:nowrap">' + fmtCtx(lm.contextLength) + ' ctx</span>';
      var caps2 = attrs.capabilities || [];
      for (var c = 0; c < caps2.length && c < 6; c++) {
        facts += capChip(caps2[c]);
      }
      if (attrs.effortLevels && attrs.effortLevels.length) facts += capChip('effort: ' + attrs.effortLevels.join('/'));
      var ranks = attrs.ranks || [];
      for (var r = 0; r < ranks.length && r < 3; r++) {
        facts += '<span title="ranked #' + ranks[r].rank + ' for ' + escAttr(ranks[r].label) + '" style="font-size:calc(var(--ui-small-fs) - 3px);color:var(--accent);background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.35);padding:2px 7px;border-radius:5px;white-space:nowrap"><b>#' + ranks[r].rank + '</b> ' + escHTML(ranks[r].label) + '</span>';
      }
      if (facts) html += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' + facts + '</div>';

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
        if (lm.isFree) return '<b style="color:var(--ok)">free</b>';
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
          for (var k = 0; k < list.length && k < 3; k++) s += '<span title="ranked #' + list[k].rank + ' for ' + escAttr(list[k].label) + '" style="font-size:calc(var(--ui-small-fs) - 3px);color:var(--accent);background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.35);padding:2px 7px;border-radius:5px;white-space:nowrap"><b>#' + list[k].rank + '</b> ' + escHTML(list[k].label) + '</span>';
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

    // v0.32.8 F1 (ported v0.34): PROVIDER COMPARE — the ⚖ pin on provider
    // boxes. Two pinned providers get a side-by-side strip above the list:
    // physical stats (models, free models, cheapest prompt price, biggest
    // context, key status) with the winner highlighted, and a per-side
    // "browse N models →" that deep-links into the Models tab (search =
    // provider display name — logicalMatches already matches host names).
    // Transient: like the model compare, never persisted.
    function toggleProvComparePin(name) {
      var idx = provComparePair.indexOf(name);
      if (idx >= 0) {
        provComparePair.splice(idx, 1);
      } else if (provComparePair.length < 2) {
        provComparePair.push(name);
      } else {
        provComparePair.shift(); // v0.32.5 behavior: oldest pin drops off
        provComparePair.push(name);
      }
    }

    function provStats(g) {
      var models = g.models || [];
      var free = 0, minPrompt = Infinity, maxCtx = 0;
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        if (m.isFree) {
          free++;
          // v0.32.8 F1: a free model IS the cheapest route ($0) — an
          // all-free provider must win "cheapest" over any paid price,
          // not render "—" and forfeit.
          if (minPrompt > 0) minPrompt = 0;
        } else if (m.pricing) {
          var pm = String(m.pricing).match(/\$([0-9]+(?:\.[0-9]+)?)/);
          if (pm) {
            var v = parseFloat(pm[1]);
            if (v < minPrompt) minPrompt = v;
          }
        }
        if ((m.contextLength || 0) > maxCtx) maxCtx = m.contextLength;
      }
      return { n: models.length, free: free, minPrompt: (minPrompt === Infinity ? null : minPrompt), maxCtx: maxCtx, keyed: !!g.hasApiKey };
    }

    function provCompareDrawer(gA, gB) {
      var a = provStats(gA), b = provStats(gB);
      var lbl = function (g, s) {
        return '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px;min-width:0">' +
          '<span style="width:9px;height:9px;border-radius:50%;background:' + (g.color || 'var(--border-strong)') + ';flex-shrink:0"></span>' +
          '<span style="font-size:calc(var(--ui-small-fs));font-weight:700;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(g.displayName || g.name) + '</span>' +
          '</div>' +
          '<span style="font-size:calc(var(--ui-small-fs) - 2px);font-weight:700;color:' + (s.keyed ? 'var(--ok)' : 'var(--text-3)') + '">' + (s.keyed ? 'ready' : '+ key needed') + '</span>' +
          '</div>';
      };
      // metric row: winner side gets ▲ + var(--ok); ties get neither.
      // Justification is FIXED per side so the win state never MOVES a
      // value, only colors it (v0.32.8 F5 VLM round).
      var row = function (label, va, vb, fmt, better) {
        var hasA = va !== null && va !== undefined;
        var hasB = vb !== null && vb !== undefined;
        var winA = hasA && (better === 'more' ? va > vb : (better === 'less' ? va < vb : false));
        var winB = hasB && (better === 'more' ? vb > va : (better === 'less' ? vb < va : false));
        var cell = function (v, win, side) {
          var arrow = win ? '<span style="font-size:8px;line-height:1">▲</span>' : '';
          return '<span style="display:inline-flex;align-items:center;gap:3px;font-size:calc(var(--ui-small-fs) - 1px);font-variant-numeric:tabular-nums;line-height:1.3;color:' + (win ? 'var(--ok)' : 'var(--text-2)') + ';font-weight:' + (win ? '700' : '500') + ';justify-self:' + (side === 'L' ? 'end' : 'start') + '">' + (side === 'L' ? (fmt(v) + arrow) : (arrow + fmt(v))) + '</span>';
        };
        return '<div class="mb-pcmprow" style="display:grid;grid-template-columns:1fr 84px 1fr;align-items:center;gap:6px;min-height:26px">' +
          cell(va, winA, 'L') +
          '<span style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-2);text-align:center;text-transform:uppercase;letter-spacing:0.06em;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + label + '</span>' +
          cell(vb, winB, 'R') +
          '</div>';
      };
      var fmtP = function (v) { return v === null ? '—' : (v === 0 ? 'free' : '$' + v + '/M'); };
      var html = '<div class="mb-compare" data-nodrag style="border:1px solid rgba(var(--accent-rgb),0.40);border-radius:12px;padding:12px;margin-bottom:10px;background:rgba(0,0,0,0.14);display:flex;flex-direction:column;gap:10px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:11px;color:var(--accent);flex-shrink:0">⚖</span>' +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:700;color:var(--text-1);flex:1">Provider compare</span>' +
        '<button data-pcmpclose data-nodrag title="unpin both" aria-label="close provider compare" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:11px;width:22px;height:22px;border-radius:7px;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0">✕</button>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 84px 1fr;gap:6px">' + lbl(gA, a) + '<span></span>' + lbl(gB, b) + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:3px;border-top:1px solid var(--surface-2);padding-top:8px">' +
        row('models', a.n, b.n, function (v) { return String(v); }, 'more') +
        row('free', a.free, b.free, function (v) { return String(v); }, 'more') +
        row('cheapest', a.minPrompt, b.minPrompt, fmtP, 'less') +
        row('context', a.maxCtx, b.maxCtx, function (v) { return fmtCtx(v); }, 'more') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        (a.n > 0 ? '<button data-pcmpbrowse="' + escAttr(gA.displayName || gA.name) + '" data-nodrag title="browse ' + escAttr(gA.displayName || gA.name) + ' models in the Models tab" style="background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.55);color:var(--accent);font-size:10.5px;font-weight:700;padding:6px 10px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">browse ' + a.n + ' models →</button>' : '<span></span>') +
        (b.n > 0 ? '<button data-pcmpbrowse="' + escAttr(gB.displayName || gB.name) + '" data-nodrag title="browse ' + escAttr(gB.displayName || gB.name) + ' models in the Models tab" style="background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.55);color:var(--accent);font-size:10.5px;font-weight:700;padding:6px 10px;border-radius:7px;font-family:inherit;cursor:pointer;touch-action:manipulation;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">browse ' + b.n + ' models →</button>' : '<span></span>') +
        '</div>' +
        '</div>';
      return html;
    }

    function provCompareHint(g) {
      return '<div data-nodrag style="display:flex;align-items:center;gap:8px;border:1px dashed rgba(var(--accent-rgb),0.45);border-radius:10px;padding:8px 12px;margin-bottom:10px;background:rgba(var(--accent-rgb),0.05)">' +
        '<span style="font-size:11px;color:var(--accent);flex-shrink:0">⚖</span>' +
        '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="color:var(--text-1)">' + escHTML(g.displayName || g.name) + '</b> pinned — tap ⚖ on another provider</span>' +
        '<button data-pcmpclose data-nodrag title="unpin" aria-label="unpin provider compare" style="background:transparent;border:1px solid var(--surface-2);color:var(--text-3);font-size:10px;width:20px;height:20px;border-radius:6px;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0">✕</button>' +
        '</div>';
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
      // v0.34: "Available" — the provider must have an API key (the
      // exclusive Available/All pair replaced the old OR-pill).
      if (avail === 'available' && !g.hasApiKey) return false;
      if (filters.length) {
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
      // v0.34: "Available" — ≥1 host with an API key (position in the
      // priority order is irrelevant).
      if (avail === 'available' && !(lm.hosts || []).some(function (h) { return h.hasApiKey; })) return false;
      if (filters.length) {
        var attrs = lm.attributes || {};
        return matchesFiltersCaps(attrs.capabilities || [], attrs.effortLevels, attrs.benchmarks || {}, String(lm.logical || '') + ' ' + String(lm.displayName || ''));
      }
      return true;
    }

    // OR across pills; reasoning also true when effort levels exist;
    // smart/code/agent match the Artificial Analysis benchmarks (v0.32 #3)
    // with capability fallbacks. v0.34: only capability pills remain in
    // `filters` (available → the exclusive pair, starred → the ★ tab).
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

    // ── Selection ────────────────────────────────────────────────────────

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
      rememberRecent(logical); // v0.32.3 F1: recents feed the MRU sort
      window.ConnectOverlay.close();
      if (onPick) onPick(best.provider, best.modelId);
    }

    function selectRoute(slot) {
      var slash = String(slot).indexOf('/');
      var provider = String(slot).slice(0, slash);
      var modelId = String(slot).slice(slash + 1);
      var lg = logicalFor(provider, modelId); // v0.32.3 F1
      if (lg) rememberRecent(lg);
      window.ConnectOverlay.close();
      if (onPick) onPick(provider, modelId);
    }

    // v0.32.1 D: POST the pasted key for the view-only provider, then
    // re-sync the catalog — the box flips to "ready" in place.
    function saveProviderKey() {
      var contentEl = window.ConnectOverlay.getContentEl();
      var inp = contentEl && contentEl.querySelector('[data-keyinput]');
      if (!inp) return;
      var key = (inp.value || '').trim();
      var name = keyAdding;
      var g = groupByName(name);
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
      el.style.cssText = 'position:sticky;bottom:0;left:0;right:0;display:flex;align-items:center;gap:8px;background:var(--surface-1);border:1px solid rgba(var(--warn-rgb),0.5);color:var(--warn);font-size:12px;padding:10px 14px;border-radius:10px;margin-top:10px';
      el.innerHTML = '<span style="flex-shrink:0">⚠</span><span style="flex:1">' + text + '</span>';
      // v0.34.1: append INSIDE the padded wrapper so the toast keeps the
      // catalogue's 16px side spacing (falls back to the content root).
      var hintHost = contentEl.querySelector('#mb-wrap') || contentEl;
      hintHost.appendChild(el);
      setTimeout(function () {
        el.style.transition = 'opacity 300ms';
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 320);
      }, 2600);
    }

    // ── Footer ───────────────────────────────────────────────────────────

    function footer() {
      return '<div style="padding:12px 0 0;font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-2,var(--text-3));text-align:center">' +
        'tap a row to select · ★ pins a favorite (its own tab above) · ℹ shows benchmarks & pricing · ⚖ compares models or providers · ➜ re-arranges providers · hold a row to drag · / searches · x clears filters · s stars · Esc closes · ' + liveCount() + ' providers live' +
        '</div>';
    }

    // ── Drag & drop (v0.32 #7/#8) — iPhone-style reorder ─────────────────
    //
    // The dragged item follows the finger 1:1 (transform, no transition);
    // siblings FLIP around it (transform transitions). Provider boxes:
    // hold 220ms (or grab the ⠿ grip) and drag. v0.34: the host rows in
    // the priority drop-down drag from a HOLD ANYWHERE too (the ⠿ grip is
    // gone — the 🔑 icon replaced it) — taps still select the route, and
    // the ▲▼ arrows stay exempt.

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
          else renderList();
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
        // Drags may only begin in the allowed start zone.
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
    //
    // v0.34: ONE delegated click/input/change/keydown handler set on the
    // overlay's contentEl, bound ONCE per open — the innerHTML zone swaps
    // never orphan listeners, and there is no per-row wiring cost. This
    // (plus the 100-row page cap) is what killed the 1–3s tap lag.

    var searchTimer = null;

    function wireOnce() {
      var contentEl = window.ConnectOverlay.getContentEl();
      if (!contentEl) return;

      // v0.35.1: previous open's delegated handlers go FIRST (see the
      // wiredHandlers note above) — exactly one live listener set.
      detachWired();

      wireTracked(contentEl, 'click', delegatedClick);
      wireTracked(contentEl, 'input', function (e) {
        if (e.target && e.target.id === 'mb-search') {
          if (searchTimer) clearTimeout(searchTimer);
          var v = e.target.value;
          searchTimer = setTimeout(function () {
            search = v;
            shownCount = PAGE;
            renderList();
          }, 200);
        }
      });
      wireTracked(contentEl, 'keydown', function (e) {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-keyinput') != null) {
          // the inline add-key form owns its keys
          if (e.key === 'Enter') { e.stopPropagation(); saveProviderKey(); }
          else if (e.key === 'Escape') { e.stopPropagation(); keyAdding = null; renderList(); }
          return;
        }
        if (t && t.id === 'mb-search' && e.key === 'Escape') {
          // v0.32.2 C: Esc inside a non-empty search clears it; empty blurs.
          e.stopPropagation();
          if (t.value) {
            t.value = '';
            search = '';
            shownCount = PAGE;
            renderList();
          } else {
            t.blur();
          }
        }
      });
      wireTracked(contentEl, 'change', function (e) {
        if (e.target && e.target.id === 'mb-sort') {
          sortKey = e.target.value;
          lsSet('sort', sortKey);
          renderList();
        }
      });

      // v0.34: auto-load the next page when the user nears the bottom.
      var morePending = false;
      wireTracked(contentEl, 'scroll', function () {
        if (morePending) return;
        if (contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight > 600) return;
        var more = contentEl.querySelector('#mb-more');
        if (!more) return;
        morePending = true;
        requestAnimationFrame(function () {
          morePending = false;
          if (!window.ConnectOverlay.isOpen()) return;
          var m2 = contentEl.querySelector('#mb-more');
          if (!m2) return;
          shownCount += PAGE;
          renderList();
        });
      });

      bindKeyboardNav(contentEl);
    }

    function delegatedClick(e) {
      if (clickSuppressed()) { e.stopPropagation(); return; }
      var t = e.target;
      if (!t || !t.closest) return;
      var c = window.ConnectOverlay.getContentEl();

      // buttons FIRST (they sit inside bigger click zones)
      var el;
      if ((el = t.closest('[data-star]'))) {
        e.stopPropagation();
        var key = el.getAttribute('data-star');
        var wasOn = starred.indexOf(key) >= 0;
        if (wasOn) starred.splice(starred.indexOf(key), 1);
        else starred.push(key);
        lsSet('starred', starred);
        // v0.32.7 F3 (ported): the tap lands with a bounce.
        el.classList.remove('mb-pop');
        void el.offsetWidth; // restart the animation
        el.classList.add('mb-pop');
        if (view === 'favorites') { renderList(); updateHead(); return; }
        // in-place: the bare ★ flips gold — no chip, no re-render
        el.setAttribute('aria-pressed', wasOn ? 'false' : 'true');
        el.setAttribute('data-on', wasOn ? '0' : '1');
        el.title = wasOn ? 'star this favorite' : 'unstar this favorite';
        updateStarCountline(); // v0.32.8 F3 (ported): ★ total, in place
        updateHead(); // the ★ tab's count badge follows
        return;
      }
      if ((el = t.closest('[data-hostup]'))) {
        e.stopPropagation();
        moveHost(el.getAttribute('data-hostup'), -1);
        return;
      }
      if ((el = t.closest('[data-hostdown]'))) {
        e.stopPropagation();
        moveHost(el.getAttribute('data-hostdown'), 1);
        return;
      }
      if ((el = t.closest('[data-info]'))) {
        e.stopPropagation();
        var iKey = el.getAttribute('data-info');
        if (infoOpen[iKey]) delete infoOpen[iKey]; else infoOpen[iKey] = true;
        var row = el.closest('.mb-logrow');
        if (row && row.getAttribute('data-slot')) refreshSlotRow(row.getAttribute('data-slot'));
        else refreshRow(iKey);
        return;
      }
      if ((el = t.closest('[data-compare]'))) {
        e.stopPropagation();
        toggleComparePin(el.getAttribute('data-compare'));
        renderList();
        return;
      }
      if ((el = t.closest('[data-cmpclose]'))) {
        e.stopPropagation();
        comparePair = [];
        renderList();
        return;
      }
      if ((el = t.closest('[data-pcmp]'))) {
        e.stopPropagation();
        toggleProvComparePin(el.getAttribute('data-pcmp'));
        renderList();
        return;
      }
      if ((el = t.closest('[data-pcmpclose]'))) {
        e.stopPropagation();
        provComparePair = [];
        renderList();
        return;
      }
      if ((el = t.closest('[data-pcmpbrowse]'))) {
        e.stopPropagation();
        // deep-link: search = provider display name, straight to Models
        search = el.getAttribute('data-pcmpbrowse') || '';
        shownCount = PAGE;
        var sB = c && c.querySelector('#mb-search');
        if (sB) sB.value = search;
        switchView('models');
        return;
      }
      if ((el = t.closest('[data-cmpuse]'))) {
        e.stopPropagation();
        selectLogical(el.getAttribute('data-cmpuse'));
        return;
      }
      if ((el = t.closest('[data-addkey]'))) {
        e.stopPropagation();
        keyAdding = el.getAttribute('data-addkey');
        renderList();
        var inp = c && c.querySelector('[data-keyinput]');
        if (inp) inp.focus();
        return;
      }
      if ((el = t.closest('[data-keysave]'))) {
        e.stopPropagation();
        saveProviderKey();
        return;
      }
      if ((el = t.closest('[data-keycancel]'))) {
        e.stopPropagation();
        keyAdding = null;
        renderList();
        return;
      }
      if ((el = t.closest('[data-unfilter]'))) {
        e.stopPropagation();
        var spec = String(el.getAttribute('data-unfilter') || '');
        var cut = spec.indexOf(':');
        if (cut >= 0) {
          var kind = spec.slice(0, cut), val = spec.slice(cut + 1);
          if (kind === 'pill') {
            var idx = filters.indexOf(val);
            if (idx >= 0) filters.splice(idx, 1);
            lsSet('filters', filters);
          } else if (kind === 'ctx') {
            ctxMin = 0; lsSet('ctxMin', 0);
          } else if (kind === 'pricing') {
            pricing = 'all'; lsSet('pricing', 'all');
          } else if (kind === 'avail') {
            avail = 'all'; lsSet('avail', 'all');
          }
        }
        shownCount = PAGE;
        updateSticky(); renderList();
        return;
      }
      if ((el = t.closest('[data-emptyclear]'))) {
        e.stopPropagation();
        if (el.getAttribute('data-emptyclear') === 'search') {
          search = '';
          var si = c && c.querySelector('#mb-search');
          if (si) si.value = '';
        } else {
          filters = []; ctxMin = 0; pricing = 'all'; avail = 'all';
          lsSet('filters', []); lsSet('ctxMin', 0); lsSet('pricing', 'all'); lsSet('avail', 'all');
        }
        shownCount = PAGE;
        updateSticky(); renderList();
        return;
      }
      if ((el = t.closest('[data-clearall]'))) {
        e.stopPropagation();
        resetAllFilters();
        return;
      }
      if (t.closest('#mb-more')) {
        e.stopPropagation();
        shownCount += PAGE;
        renderList();
        return;
      }
      if (t.closest('#mb-close')) { window.ConnectOverlay.close(); return; }
      if ((el = t.closest('[data-viewtab]'))) {
        e.stopPropagation();
        switchView(el.getAttribute('data-viewtab'));
        return;
      }
      if (t.closest('#mb-refresh')) {
        e.stopPropagation();
        syncing = true;
        updateHead();
        fetchCatalog(true, function () { render(); });
        return;
      }
      if (t.closest('#mb-filters-toggle')) {
        e.stopPropagation();
        filtersOpen = !filtersOpen;
        lsSet('filtersOpen', filtersOpen);
        updateSticky();
        return;
      }
      if (t.closest('#mb-clear')) {
        e.stopPropagation();
        resetAllFilters();
        return;
      }
      if ((el = t.closest('[data-pill]'))) {
        e.stopPropagation();
        var pKey = el.getAttribute('data-pill');
        var pi = filters.indexOf(pKey);
        if (pi >= 0) filters.splice(pi, 1);
        else {
          filters.push(pKey);
          // v0.32.4 P0: a scoring pill auto-aligns the sort to its metric.
          var PILL_SORT = { intelligence: 'aa', code: 'code', agent: 'agent' };
          if (PILL_SORT[pKey] && PILL_SORT[pKey] !== sortKey) {
            sortKey = PILL_SORT[pKey];
            lsSet('sort', sortKey);
          }
        }
        lsSet('filters', filters);
        shownCount = PAGE;
        updateSticky(); renderList();
        return;
      }
      if ((el = t.closest('[data-ctx]'))) {
        e.stopPropagation();
        ctxMin = parseInt(el.getAttribute('data-ctx'), 10) || 0;
        lsSet('ctxMin', ctxMin);
        shownCount = PAGE;
        updateSticky(); renderList();
        return;
      }
      if ((el = t.closest('[data-pricing]'))) {
        e.stopPropagation();
        pricing = (pricing === el.getAttribute('data-pricing')) ? 'all' : el.getAttribute('data-pricing');
        lsSet('pricing', pricing);
        shownCount = PAGE;
        updateSticky(); renderList();
        return;
      }
      if ((el = t.closest('[data-avail]'))) {
        e.stopPropagation();
        avail = el.getAttribute('data-avail') === 'available' ? 'available' : 'all';
        lsSet('avail', avail);
        shownCount = PAGE;
        updateSticky(); renderList();
        return;
      }
      // v0.34.1 FIX 4: the ↺ Reset half-pill — one tap, same path as the
      // "clear" button / the document-level 'x' shortcut.
      if ((el = t.closest('[data-resetfilters]'))) {
        e.stopPropagation();
        resetAllFilters();
        return;
      }
      if ((el = t.closest('[data-provhead]'))) {
        e.stopPropagation();
        if (t.closest && t.closest('[data-slot],[data-addkey],[data-keyform],[data-grip]')) return;
        var pname = el.getAttribute('data-provhead');
        providerExpanded[pname] = !providerExpanded[pname];
        lsSet('providerExpanded', providerExpanded);
        renderList();
        return;
      }
      if ((el = t.closest('[data-hostslot]'))) {
        e.stopPropagation();
        selectRoute(el.getAttribute('data-hostslot'));
        return;
      }
      if ((el = t.closest('[data-slotrow]'))) {
        e.stopPropagation();
        var srow = el.closest('[data-slot]');
        if (srow) selectRoute(srow.getAttribute('data-slot'));
        return;
      }
      if ((el = t.closest('[data-expand]'))) {
        e.stopPropagation();
        var xKey = el.getAttribute('data-expand');
        if (expandedLogical[xKey]) delete expandedLogical[xKey];
        else expandedLogical[xKey] = true;
        refreshRow(xKey);
        return;
      }
      if ((el = t.closest('[data-select]'))) {
        e.stopPropagation();
        selectLogical(el.getAttribute('data-select'));
        return;
      }
    }

    function clickSuppressed() { return Date.now() < suppressClickUntil; }

    // rebind the per-list drag handlers after a zone swap (the delegated
    // click/input/change/keydown handlers above survive untouched)
    function wireZones() {
      var contentEl = window.ConnectOverlay.getContentEl();
      if (!contentEl) return;
      var provList = contentEl.querySelector('#mb-provlist');
      if (provList) {
        makeSortable(provList, {
          itemSel: '.mb-provbox',
          startSel: '[data-provhead]',
          handleSel: '[data-grip]',
          holdMs: 220,
          keyOf: function (el) { return el.getAttribute('data-prov'); },
          onOrder: function (keys) {
            providerOrder = keys;
            lsSet('providerOrder', providerOrder);
            renderList();
          }
        });
      }
      contentEl.querySelectorAll('[data-hostlist]').forEach(function (hostListEl) {
        makeSortable(hostListEl, {
          itemSel: '[data-hostslot]',
          startSel: '[data-hostslot]', // v0.34: hold the ROW anywhere
          handleSel: null,             // the ⠿ grip is gone (🔑 took its place)
          holdMs: 220,
          keyOf: function (el) { return el.getAttribute('data-hostslot'); },
          onOrder: function (keys) {
            var logical = hostListEl.getAttribute('data-hostlist');
            var providers = [];
            keys.forEach(function (k) {
              var p = k.split('|')[0];
              if (providers.indexOf(p) < 0) providers.push(p);
            });
            hostOrder[logical] = providers;
            lsSet('hostOrder', hostOrder);
            renderList();
          }
        });
      });
      if (keyAdding) {
        var inp = contentEl.querySelector('[data-keyinput]');
        if (inp) { try { inp.focus(); } catch (e) {} }
      }
    }

    // v0.32.3 F4: keyboard navigation (roving tabindex, WAI-APG).
    // Arrows move focus among the logical rows (models + favorites views)
    // or provider box headers (providers view); Enter/Space selects or
    // toggles; ArrowRight/Left expand/collapse; Home/End jump to the
    // ends; the search box's ArrowDown drops into the list. Bound ONCE
    // per open on the content element (v0.34 — survives zone swaps).
    function bindKeyboardNav(contentEl) {
      // v0.35.1: tracked like every other contentEl listener — the old
      // untracked addEventListener accumulated one keyboard-nav handler
      // per open() (duplicate ArrowDown hops once 2+ opens stacked).
      wireTracked(contentEl, 'keydown', function (e) {
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
        var row = (t && t.classList && (t.classList.contains('mb-logrow') || t.hasAttribute && t.hasAttribute('data-provhead'))) ? t : null;
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
            var name = row.getAttribute('data-provhead');
            providerExpanded[name] = !providerExpanded[name];
            lsSet('providerExpanded', providerExpanded);
            renderList();
            refocusAfterRender('[data-provhead="' + (name && name.replace(/"/g, '\\"')) + '"]');
          } else {
            selectLogical(row.getAttribute('data-logical-id'));
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (view === 'providers') {
            var pn = row.getAttribute('data-provhead');
            if (!providerExpanded[pn]) {
              providerExpanded[pn] = true;
              lsSet('providerExpanded', providerExpanded);
              renderList();
              refocusAfterRender('[data-provhead="' + (pn && pn.replace(/"/g, '\\"')) + '"]');
            }
          } else {
            var lid = row.getAttribute('data-logical-id');
            if (!expandedLogical[lid]) {
              expandedLogical[lid] = true;
              refreshRow(lid);
            }
          }
        } else if ((e.key === 'i' || e.key === 'I') && view !== 'providers') {
          // v0.32.4 F2: "i" toggles the detail drawer on the focused row.
          e.preventDefault();
          var ilid = row.getAttribute('data-logical-id');
          if (infoOpen[ilid]) delete infoOpen[ilid]; else infoOpen[ilid] = true;
          refreshRow(ilid);
          refocusAfterRender('.mb-logrow[data-logical-id="' + (ilid || '').replace(/"/g, '\\"') + '"]');
        } else if ((e.key === 'c' || e.key === 'C') && view !== 'providers') {
          // v0.32.5 F2: "c" toggles the compare pin on the focused row.
          e.preventDefault();
          toggleComparePin(row.getAttribute('data-logical-id'));
          renderList();
          refocusAfterRender('.mb-logrow[data-logical-id="' + (row.getAttribute('data-logical-id') || '').replace(/"/g, '\\"') + '"]');
        } else if ((e.key === 'c' || e.key === 'C') && view === 'providers') {
          // v0.32.8 F6 (ported): "c" pins the focused provider box for ⚖
          // compare — keyboard parity with the models view.
          e.preventDefault();
          toggleProvComparePin(row.getAttribute('data-provhead'));
          renderList();
          refocusAfterRender('[data-provhead="' + String(row.getAttribute('data-provhead') || '').replace(/"/g, '\\"') + '"]');
        } else if ((e.key === 's' || e.key === 'S') && view !== 'providers') {
          // v0.32.7 F4 (ported): "s" stars/unstars the focused row —
          // same logic as the ★ button, same in-place treatment.
          e.preventDefault();
          var sid = row.getAttribute('data-logical-id');
          var srow = contentEl.querySelector('.mb-logrow[data-logical-id="' + String(sid).replace(/"/g, '\\"') + '"] [data-star]');
          if (srow) srow.click();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (view === 'providers') {
            var cn = row.getAttribute('data-provhead');
            if (providerExpanded[cn]) {
              delete providerExpanded[cn];
              lsSet('providerExpanded', providerExpanded);
              renderList();
              refocusAfterRender('[data-provhead="' + (cn && cn.replace(/"/g, '\\"')) + '"]');
            }
          } else {
            var clid = row.getAttribute('data-logical-id');
            if (expandedLogical[clid]) {
              delete expandedLogical[clid];
              refreshRow(clid);
            }
          }
        }
      });

      function visibleKbRows() {
        var sel = view === 'providers' ? '[data-provhead]' : '.mb-logrow[data-logical-id]:not([data-logical-id=""])';
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
    }

    function switchView(v) {
      if (v !== 'favorites' && v !== 'providers' && v !== 'models') return;
      view = v;
      lsSet('view', view);
      shownCount = PAGE;
      updateHead();
      renderList();
    }

    function moveHost(key, dir) {
      var parts = key.split('|');
      var logical = parts[0];
      var provider = parts.slice(1).join('|');
      var lm = findLogical(logical);
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
      renderList();
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

  // v0.32.6 F1: star/unstar from outside the overlay. Returns the NEW
  // state (true = starred). NOTE: deliberately does NOT touch the
  // open()-scoped `starred` copy — the overlay re-reads it from
  // localStorage on every open(), so the two never diverge.
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
