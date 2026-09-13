// modelbrowser.js — the dynamic model browser (v0.13).
//
// Port of the HF space's ModelSelectOverlay.tsx (the "tremendous amount of
// work" — kept faithful, adapted to vanilla JS + the engine's v2 catalog):
//
//   TWO VIEWS (header toggle, active tab marked with the shared UIActive
//   underline sweep):
//     • PROVIDERS — each provider as a collapsible card (color dot, live-sync
//       dot, model count), its models as single-line rows ranked in list
//       format: [radio] name [context] [pricing chip].
//     • MODELS — ALL providers' models combined, grouped by family into
//       logical models, listed by capabilities with benchmark scores.
//       Each row shows the PROVIDER PRIORITY indicator (colored dots, one
//       per host; dimmed when the host has no key). Expanding reveals the
//       host rank list — reorder with ▲▼ (persisted per model).
//
//   SEARCH (200ms debounce) + FILTERS: capability pills (Reason / Smart /
//   Code / Agent / Tools / Vision), context minimums (32K / 128K / 1M),
//   Free ⇄ Paid. SORT: intelligence → context → coding → name.
//
//   100% RUNTIME DATA: everything comes from GET /api/models — the engine
//   live-syncs every provider's list (no static fallbacks anywhere). The
//   refresh button re-syncs (?refresh=1) and shows "synced Ns ago".
//
//   Selection picks the BEST host automatically (hasApiKey && syncedLive
//   first) and calls onPick(provider, modelId) with the raw slot id.
//
//   PERSISTENCE (localStorage, same keys as the old app):
//     doomalay.model-select.view / .search / .filters / .ctxMin / .pricing /
//     .providerOrder / .providerExpanded / .hostOrder (per logical model)
//
// Exposes: window.ModelBrowser = { open }
(function () {
  'use strict';

  var EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  var LS = 'doomalay.model-select.';

  // Filter pill definitions (label, color, match key) — same set as the old app.
  var PILLS = [
    { key: 'reasoning', label: 'Reason', color: '#f97316' },
    { key: 'intelligence', label: 'Smart', color: '#a855f7' },
    { key: 'code', label: 'Code', color: '#3b82f6' },
    { key: 'agent', label: 'Agent', color: '#14b8a6' },
    { key: 'tools', label: 'Tools', color: '#8b5cf6' },
    { key: 'vision', label: 'Vision', color: '#22c55e' }
  ];
  var CTX_OPTIONS = [
    { label: 'Any', v: 0 },
    { label: '32K', v: 32000 },
    { label: '128K', v: 128000 },
    { label: '1M', v: 1000000 }
  ];

  function lsGet(key, dflt) {
    try {
      var v = localStorage.getItem(LS + key);
      return v === null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }
  function lsSet(key, v) {
    try { localStorage.setItem(LS + key, JSON.stringify(v)); } catch (e) {}
  }

  function open(onPick, opts) {
    opts = opts || {};

    // Mutable UI state (persisted where it makes sense).
    var view = lsGet('view', 'providers');
    var search = '';
    var filters = lsGet('filters', []);
    var ctxMin = lsGet('ctxMin', 0);
    var pricing = lsGet('pricing', 'all');
    var providerOrder = lsGet('providerOrder', null);
    var providerExpanded = lsGet('providerExpanded', {});
    var hostOrder = lsGet('hostOrder', {});
    var searchOpen = false;
    var expandedLogical = {};

    // Catalog data.
    var catalog = null;
    var syncedAt = 0;
    var syncing = false;
    var opened = false;

    fetchCatalog(false, function () { render(); });

    function fetchCatalog(refresh, done) {
      var url = '/api/models' + (refresh ? '?refresh=1' : '');
      if (refresh) syncing = true;
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        catalog = d || {};
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

    // ── Rendering ───────────────────────────────────────────────────────

    function render() {
      var html =
        '<div style="padding:16px 16px 24px">' +
        header() +
        searchBox() +
        filterRow() +
        (view === 'providers' ? providerView() : modelsView()) +
        footer() +
        '</div>';

      if (!opened) {
        if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
          window.ConnectOverlay.replaceContent(html, { onSwap: wireEvents });
        } else {
          window.ConnectOverlay.open(html, { onSwap: wireEvents });
        }
        opened = true;
      } else {
        var contentEl = window.ConnectOverlay.getContentEl();
        contentEl.innerHTML = html;
        wireEvents();
      }
    }

    function header() {
      var isProv = view === 'providers';
      return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<h2 style="font-size:17px;font-weight:600;color:#e0e0e8;margin:0;flex:1">Select a model</h2>' +
        // View toggle (the two "tabs")
        '<div style="display:flex;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:3px">' +
          '<button id="mb-view-providers" class="mb-viewtab' + (isProv ? ' dd-active-tab' : '') + '" style="--dd-accent:#34d399;background:transparent;border:none;color:' + (isProv ? '#e0e0e8' : '#71717a') + ';font-size:12px;font-weight:600;font-family:inherit;padding:6px 12px;border-radius:8px;cursor:pointer;position:relative">Providers</button>' +
          '<button id="mb-view-models" class="mb-viewtab' + (!isProv ? ' dd-active-tab' : '') + '" style="--dd-accent:#a78bfa;background:transparent;border:none;color:' + (!isProv ? '#e0e0e8' : '#71717a') + ';font-size:12px;font-weight:600;font-family:inherit;padding:6px 12px;border-radius:8px;cursor:pointer;position:relative">Models</button>' +
        '</div>' +
        '<button id="mb-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:2px 6px">✕</button>' +
        '</div>' +
        // Sync line + refresh
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
        '<button id="mb-refresh" style="display:flex;align-items:center;gap:6px;background:transparent;border:1px solid #1a1a22;color:#71717a;font-size:11px;font-family:inherit;padding:5px 10px;border-radius:8px;cursor:pointer;touch-action:manipulation">' +
        '<span id="mb-refresh-icon" style="display:inline-block;' + (syncing ? 'animation:mb-spin 0.9s linear infinite' : '') + '">⟳</span>' +
        '<span id="mb-sync-label">' + syncLabel() + '</span></button>' +
        '<span style="font-size:11px;color:#4a4a5e;flex:1;text-align:right">' + liveCount() + ' providers live · ' + totalModels() + ' models</span>' +
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
        '<input id="mb-search" type="text" inputmode="search" placeholder="Search models, providers, capabilities…" value="' + escAttr(search) + '" style="width:100%;box-sizing:border-box;background:#0a0a0e;border:1px solid #2a2a35;color:#e0e0e8;padding:10px 12px;border-radius:10px;font-size:13px;font-family:inherit;outline:none" />' +
        '</div>';
    }

    function filterRow() {
      var pills = '';
      for (var i = 0; i < PILLS.length; i++) {
        var p = PILLS[i];
        var on = filters.indexOf(p.key) >= 0;
        pills += '<button data-pill="' + p.key + '" style="flex-shrink:0;background:' + (on ? p.color + '22' : 'transparent') + ';border:1px solid ' + (on ? p.color + '88' : '#2a2a35') + ';color:' + (on ? p.color : '#71717a') + ';font-size:11px;font-weight:600;padding:5px 11px;border-radius:14px;font-family:inherit;cursor:pointer">' + p.label + '</button>';
      }
      // Context pills
      var ctxPills = '';
      for (var c = 0; c < CTX_OPTIONS.length; c++) {
        var co = CTX_OPTIONS[c];
        var onC = ctxMin === co.v;
        ctxPills += '<button data-ctx="' + co.v + '" style="flex-shrink:0;background:' + (onC ? '#14b8a622' : 'transparent') + ';border:1px solid ' + (onC ? '#14b8a6888' : '#2a2a35') + ';color:' + (onC ? '#14b8a6' : '#71717a') + ';font-size:11px;font-weight:600;padding:5px 11px;border-radius:14px;font-family:inherit;cursor:pointer">' + co.label + '</button>';
      }
      // Pricing pills
      var prPills = '';
      var prOpts = [['all', '#71717a'], ['free', '#22c55e'], ['paid', '#f59e0b']];
      for (var pr = 0; pr < prOpts.length; pr++) {
        var onP = pricing === prOpts[pr][0];
        prPills += '<button data-pricing="' + prOpts[pr][0] + '" style="flex-shrink:0;background:' + (onP ? prOpts[pr][1] + '22' : 'transparent') + ';border:1px solid ' + (onP ? prOpts[pr][1] + '88' : '#2a2a35') + ';color:' + (onP ? prOpts[pr][1] : '#71717a') + ';font-size:11px;font-weight:600;padding:5px 11px;border-radius:14px;font-family:inherit;cursor:pointer">' + (prOpts[pr][0] === 'all' ? 'Any $' : (prOpts[pr][0] === 'free' ? 'Free' : 'Paid')) + '</button>';
      }
      var clearHTML = (filters.length || ctxMin || pricing !== 'all' || search) ? '<button id="mb-clear" style="flex-shrink:0;background:transparent;border:none;color:#f87171;font-size:11px;padding:5px 8px;font-family:inherit;cursor:pointer">clear</button>' : '';
      return '<div style="display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;margin-bottom:4px">' + pills + ctxPills + prPills + clearHTML + '</div>';
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
      var out = '';
      for (var i = 0; i < groups.length; i++) {
        out += providerBox(groups[i]);
      }
      if (!groups.length) {
        out = '<div style="text-align:center;color:#71717a;padding:40px 20px;font-size:13px">Syncing providers…</div>';
      }
      return '<div style="display:flex;flex-direction:column;gap:10px">' + out + '</div>';
    }

    function providerBox(g) {
      var expanded = !!providerExpanded[g.name];
      var matching = [];
      var filteredOut = 0;
      var models = g.models || [];
      for (var i = 0; i < models.length; i++) {
        if (modelMatches(models[i], g.displayName)) matching.push(models[i]);
        else filteredOut++;
      }
      var liveDot = g.syncedLive ? '<span class="dd-live-dot" title="synced live from provider API"></span>' : '<span class="dd-live-dot dd-stale" title="no live sync"></span>';
      var hasKeyDot = g.hasKey ? window.UIActive.dotHTML('API key connected') : '';
      var chevron = expanded ? '▾' : '▸';

      var rows = '';
      for (var m = 0; m < matching.length; m++) {
        rows += providerModelRow(g, matching[m]);
      }
      if (filteredOut > 0 && expanded) {
        rows += '<div style="padding:8px 12px;font-size:11px;color:#4a4a5e;opacity:0.8">▸ ' + filteredOut + ' filtered out</div>';
      }

      return '<div class="mb-provbox' + (expanded ? ' dd-active' : '') + '" data-prov="' + g.name + '" style="background:#14141a;border:1px solid ' + (expanded ? 'rgba(255,255,255,0.14)' : '#1a1a22') + ';border-radius:12px;overflow:hidden;--dd-accent:' + (g.color || '#34d399') + '">' +
        '<div data-provhead="' + g.name + '" style="display:flex;align-items:center;gap:9px;padding:12px 14px;cursor:pointer;touch-action:manipulation">' +
          '<span style="font-size:10px;color:#71717a;flex-shrink:0">' + chevron + '</span>' +
          '<span style="width:10px;height:10px;border-radius:50%;background:' + (g.color || '#4a4a5e') + ';flex-shrink:0"></span>' +
          '<span style="font-size:14px;font-weight:600;color:#e0e0e8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (g.displayName || g.name) + '</span>' +
          hasKeyDot +
          liveDot +
          '<span style="font-size:11px;color:#71717a;flex-shrink:0">' + (g.modelCount || 0) + '</span>' +
        '</div>' +
        (expanded ? '<div style="max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid #1a1a22">' + (rows || '<div style="padding:16px;font-size:12px;color:#71717a;text-align:center">no models match</div>') + '</div>' : '') +
        '</div>';
    }

    function providerModelRow(g, m) {
      var ctx = fmtCtx(m.contextLength);
      var priceChip = m.isFree
        ? '<span style="font-size:10px;color:#22c55e;background:rgba(34,197,94,0.12);padding:2px 7px;border-radius:4px;flex-shrink:0">free</span>'
        : '<span style="font-size:10px;color:#f59e0b;background:rgba(245,158,11,0.1);padding:2px 7px;border-radius:4px;flex-shrink:0">paid</span>';
      var caps = (m.capabilities || []).length ? '<span style="font-size:9px;color:#71717a;flex-shrink:0;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (m.capabilities || []).join('·') + '</span>' : '';
      return '<div data-slot="' + escAttr(m.id) + '" style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;touch-action:manipulation;min-height:36px">' +
        '<span style="width:6px;height:6px;border-radius:50%;border:1.5px solid #a855f7;flex-shrink:0"></span>' +
        '<span style="font-size:13px;color:#e0e0e8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (m.displayName || m.rawId) + '</span>' +
        caps +
        '<span style="font-size:10px;color:#71717a;flex-shrink:0;min-width:34px;text-align:right">' + ctx + '</span>' +
        priceChip +
        '</div>';
    }

    // ── Models view (logical, all providers combined) ────────────────────

    function modelsView() {
      var logical = ((catalog && catalog.logical) || []).slice();
      var matching = [];
      for (var i = 0; i < logical.length; i++) {
        if (logicalMatches(logical[i])) matching.push(logical[i]);
      }
      // Sort is server-side (intelligence → ctx → coding → name); when
      // filters are active, re-rank by filter score first.
      if (filters.length) {
        matching.sort(function (a, b) { return filterScore(b) - filterScore(a); });
      }
      var out = '';
      for (var l = 0; l < matching.length; l++) {
        out += logicalRow(matching[l]);
      }
      var hidden = logical.length - matching.length;
      if (hidden > 0) {
        out += '<div style="padding:10px;font-size:11px;color:#4a4a5e;text-align:center">' + hidden + ' models hidden by filters</div>';
      }
      if (!logical.length) {
        out = '<div style="text-align:center;color:#71717a;padding:40px 20px;font-size:13px">Syncing models…</div>';
      }
      return '<div style="display:flex;flex-direction:column;gap:6px">' + out + '</div>';
    }

    function logicalRow(lm) {
      var expanded = !!expandedLogical[lm.logical];
      var hosts = orderedHosts(lm);
      var available = hosts.some(function (h) { return h.hasApiKey; });

      // Provider priority indicator: up to 5 colored dots (dim when no key).
      var dots = '';
      var shown = Math.min(hosts.length, 5);
      for (var d = 0; d < shown; d++) {
        dots += '<span style="width:7px;height:7px;border-radius:50%;background:' + (hosts[d].color || '#4a4a5e') + ';opacity:' + (hosts[d].hasApiKey ? 1 : 0.35) + ';flex-shrink:0" title="' + escAttr(hosts[d].providerDisplayName || hosts[d].provider) + (hosts[d].hasApiKey ? ' (key)' : '') + '"></span>';
      }
      if (hosts.length > 5) dots += '<span style="font-size:9px;color:#71717a">+' + (hosts.length - 5) + '</span>';

      // Capability chips + benchmarks.
      var attrs = lm.attributes || {};
      var chips = '';
      var bm = attrs.benchmarks || {};
      if (bm.intelligence) chips += bmChip('AA ' + Math.round(bm.intelligence), bm.intelligence);
      if (bm.coding) chips += bmChip('code ' + Math.round(bm.coding), bm.coding);
      if (bm.agentic) chips += bmChip('agent ' + Math.round(bm.agentic), bm.agentic);
      var caps = attrs.capabilities || [];
      for (var c = 0; c < caps.length && c < 5; c++) {
        chips += capChip(caps[c]);
      }
      if (attrs.effortLevels && attrs.effortLevels.length) chips += capChip('effort');
      var priceChip = lm.isFree
        ? '<span style="font-size:9px;color:#22c55e;background:rgba(34,197,94,0.12);padding:1px 6px;border-radius:4px">free route</span>'
        : '<span style="font-size:9px;color:#f59e0b;background:rgba(245,158,11,0.1);padding:1px 6px;border-radius:4px">paid</span>';

      // Host rank rows (expanded).
      var hostRows = '';
      if (expanded) {
        for (var h = 0; h < hosts.length; h++) {
          var hr = hosts[h];
          hostRows += '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04)">' +
            '<span style="font-size:10px;font-weight:700;color:#0a0a0b;background:' + (hr.color || '#4a4a5e') + ';width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + (h + 1) + '</span>' +
            '<span style="width:8px;height:8px;border-radius:50%;background:' + (hr.color || '#4a4a5e') + ';flex-shrink:0"></span>' +
            '<span style="font-size:12px;color:' + (hr.hasApiKey ? '#e0e0e8' : '#71717a') + ';flex-shrink:0;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (hr.providerDisplayName || hr.provider) + '</span>' +
            '<span style="font-size:10px;color:#4a4a5e;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHTML(hr.modelId) + '</span>' +
            '<span style="font-size:10px;color:#71717a;flex-shrink:0">' + fmtCtx(hr.contextLength) + '</span>' +
            '<button data-hostup="' + escAttr(lm.logical + '|' + hr.provider) + '" style="background:transparent;border:1px solid #2a2a35;color:#71717a;font-size:9px;padding:3px 6px;border-radius:5px;cursor:pointer;flex-shrink:0;font-family:inherit" title="raise priority">▲</button>' +
            '<button data-hostdown="' + escAttr(lm.logical + '|' + hr.provider) + '" style="background:transparent;border:1px solid #2a2a35;color:#71717a;font-size:9px;padding:3px 6px;border-radius:5px;cursor:pointer;flex-shrink:0;font-family:inherit" title="lower priority">▼</button>' +
            '</div>';
        }
      }

      return '<div style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;overflow:hidden;' + (available ? '' : 'opacity:0.75') + '">' +
        '<div data-logical="' + escAttr(lm.logical) + '" style="display:flex;align-items:center;gap:8px;padding:11px 12px;cursor:pointer;touch-action:manipulation">' +
          '<span style="width:6px;height:6px;border-radius:50%;border:1.5px solid #a855f7;flex-shrink:0"></span>' +
          '<span style="font-size:13px;font-weight:600;color:#e0e0e8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (lm.displayName || lm.logical) + '</span>' +
          '<span style="display:flex;align-items:center;gap:3px;flex-shrink:0">' + dots + '</span>' +
          '<span style="font-size:10px;color:#71717a;flex-shrink:0;min-width:34px;text-align:right">' + fmtCtx(lm.contextLength) + '</span>' +
          priceChip +
          '<span style="font-size:10px;color:#71717a;flex-shrink:0">' + (expanded ? '▾' : '▸') + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;padding:0 12px 10px;align-items:center">' + chips + '</div>' +
        (expanded ? '<div style="border-top:1px solid #1a1a22">' + hostRows + '</div>' : '') +
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
      var color = score >= 70 ? '#22c55e' : (score >= 40 ? '#f59e0b' : '#71717a');
      return '<span style="font-size:9px;color:' + color + ';background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:4px">' + text + '</span>';
    }

    var CAP_COLORS = { reasoning: '#f97316', code: '#3b82f6', tools: '#8b5cf6', vision: '#22c55e', audio: '#ec4899', agents: '#14b8a6' };
    function capChip(cap) {
      var key = String(cap).toLowerCase();
      var color = CAP_COLORS[key] || '#71717a';
      return '<span style="font-size:9px;color:' + color + ';background:' + color + '14;padding:1px 6px;border-radius:4px">' + escHTML(cap) + '</span>';
    }

    // ── Matching / filtering ─────────────────────────────────────────────

    function modelMatches(m, providerName) {
      var q = search.toLowerCase().trim();
      if (q) {
        var hay = ((m.displayName || '') + ' ' + (m.rawId || '') + ' ' + (m.id || '') + ' ' + (providerName || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (ctxMin > 0 && (m.contextLength || 0) < ctxMin) return false;
      if (pricing === 'free' && !m.isFree) return false;
      if (pricing === 'paid' && m.isFree) return false;
      if (filters.length) return matchesFiltersCaps((m.capabilities || []), m.effortLevels, m.rawId, m.displayName);
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
      if (filters.length) {
        var attrs = lm.attributes || {};
        return matchesFiltersCaps(attrs.capabilities || [], attrs.effortLevels, lm.logical, lm.displayName);
      }
      return true;
    }

    // The old app's filter semantics: OR across pills; reasoning also true
    // when effort levels exist; code/tools also via benchmarks.
    function matchesFiltersCaps(caps, effortLevels, rawId, displayName) {
      var bm = (catalog && catalog.logical) || [];
      var name = String(rawId || '') + ' ' + String(displayName || '');
      var capsLower = caps.map(function (c) { return String(c).toLowerCase(); });
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
        else if (key === 'code') ok = hasCap('code') || hasCap('coding');
        else if (key === 'agent') ok = hasCap('agent') || hasCap('agentic');
        else if (key === 'intelligence') ok = hasCap('smart');
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
        if (key === 'reasoning' && attrs.effortLevels && attrs.effortLevels.length) score += 1;
        if (key === 'intelligence') score += (bm.intelligence || 0);
        if (key === 'code') score += Math.max(bm.coding || 0, 0);
        if (key === 'agent' || key === 'tools') score += (bm.agentic || 0);
      }
      return score;
    }

    // ── Footer ───────────────────────────────────────────────────────────

    function footer() {
      return '<div style="padding:16px 0 0;font-size:10px;color:#4a4a5e;text-align:center">' +
        'tap to select · ' + liveCount() + ' providers live · ' + totalModels() + ' models · fully live-synced' +
        '</div>';
    }

    // ── Wiring ───────────────────────────────────────────────────────────

    var searchTimer = null;

    function wireEvents() {
      var contentEl = window.ConnectOverlay.getContentEl();

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
        searchInput.addEventListener('input', function () {
          if (searchTimer) clearTimeout(searchTimer);
          searchTimer = setTimeout(function () {
            search = searchInput.value;
            render();
          }, 200);
        });
      }

      // Filter pills.
      contentEl.querySelectorAll('[data-pill]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.dataset.pill;
          var idx = filters.indexOf(key);
          if (idx >= 0) filters.splice(idx, 1);
          else filters.push(key);
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

      // Pricing pills.
      contentEl.querySelectorAll('[data-pricing]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          pricing = btn.dataset.pricing;
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

      // Provider box expand/collapse.
      contentEl.querySelectorAll('[data-provhead]').forEach(function (head) {
        head.addEventListener('click', function (e) {
          if (e.target.closest && e.target.closest('[data-slot]')) return;
          var name = head.dataset.provhead;
          providerExpanded[name] = !providerExpanded[name];
          lsSet('providerExpanded', providerExpanded);
          render();
        });
      });

      // Provider model row → select.
      contentEl.querySelectorAll('[data-slot]').forEach(function (row) {
        row.addEventListener('click', function (e) {
          e.stopPropagation();
          var slot = row.dataset.slot;
          var slash = slot.indexOf('/');
          var provider = slot.slice(0, slash);
          var modelId = slot.slice(slash + 1);
          window.ConnectOverlay.close();
          if (onPick) onPick(provider, modelId);
        });
      });

      // Logical row → expand or select-best.
      contentEl.querySelectorAll('[data-logical]').forEach(function (rowEl) {
        rowEl.addEventListener('click', function () {
          var logical = rowEl.dataset.logical;
          if (expandedLogical[logical]) {
            // Collapse on second tap; first tap expands.
            delete expandedLogical[logical];
            render();
            return;
          }
          expandedLogical[logical] = true;
          render();
        });
      });

      // Host reorder buttons.
      contentEl.querySelectorAll('[data-hostup]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          moveHost(btn.dataset.hostup, -1);
        });
      });
      contentEl.querySelectorAll('[data-hostdown]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          moveHost(btn.dataset.hostdown, 1);
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

  window.ModelBrowser = { open: open };
})();
