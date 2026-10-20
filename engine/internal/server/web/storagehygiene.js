// storagehygiene.js — v1.42.1 THE LONG HAUL (PLAN-V142 §3.0, H2): the
// WebView-side aged-storage sweep + the Storage settings page.
//
// THE DIAGNOSIS this module kills: four per-chat localStorage maps
// (chatscroll · chatdraft · chatbundle · exportlatest) grow with every
// chat ever opened and NEVER lose entries for deleted chats — a 90-day
// install carries scroll positions and drafts for conversations long
// gone. The model catalog cache (modelcache.v1) has no TTL — it rides
// until some catalog-changed event happens to fire. Neither is huge,
// but both grow with install age, and every boot pays the parse.
//
// THE SWEEP (once per 24h, stamped): keep only entries whose key is a
// LIVE icon id (chatscroll is icon-keyed) or a LIVE session id (the
// other three are session-keyed). Live = the canvas state's icons ∪ the
// engine's /api/chats index. The engine side keeps its own hygiene
// (store/maintain.go — checkpoint/vacuum cadence; /api/storage/usage).
//
// THE PAGE: Settings → Storage — the honest dashboard: engine DB/WAL
// sizes + row counts + last-VACUUM age (GET /api/storage/usage), the
// localStorage footprint by key, a Clean-stale-data action (the sweep,
// now), and a Maintain-now action (POST /api/storage/maintain — the
// busy engine answers 409 and the row says so).
//
// Theme law: zero literal colors — every style composes from var(--…).
// UI law: the page rides the EXISTING settings panel (registerPage —
// the perfhud.js precedent); no new surface.
//
// Exposes: window.DoomStorage { sweep, usage, KEYS } + the node-rig
// path (the pure prune core: scripts/v1421-aged-state-rig.mjs).
(function () {
  'use strict';

  var STAMP_KEY = 'doomalay.storagehygiene.v1';
  var SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;   // once per day
  var MODEL_CACHE_KEY = 'doomalay.modelcache.v1';
  var MODEL_CACHE_AT = 'doomalay.modelcache.at'; // the companion stamp (this module's)
  var MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // catalog staleness bound

  // The per-chat maps + their key kind (icon id vs session id).
  var MAP_KEYS = {
    'doomalay.chatscroll.v1': 'icon',
    'doomalay.chatdraft.v1': 'session',
    'doomalay.chatbundle.v1': 'session',
    'doomalay.exportlatest.v1': 'session'
  };
  var SCROLL_CAP = 60; // chatpanel's own cap — enforced here properly (it trims by one per save)

  function lsGet(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (e) {} }
  function readMap(k) { try { return JSON.parse(lsGet(k)) || {}; } catch (e) { return {}; } }

  // ── the pure core (node-rig testable) ─────────────────────────────

  // pruneMaps(mapObj, keyKind, liveIds, cap) → {kept, dropped}: the
  // entry survives iff its key is in liveIds (cap applies AFTER the
  // keep-filter, newest-inserted last — JSON key order = insertion
  // order for string keys, the same assumption chatpanel's own trim
  // makes).
  function pruneMaps(mapObj, keyKind, liveIds, cap) {
    var out = {}, kept = 0, dropped = 0;
    if (!mapObj || typeof mapObj !== 'object') return { map: {}, kept: 0, dropped: 0 };
    var keys = Object.keys(mapObj);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var live = keyKind === 'icon'
        ? liveIds.icons.indexOf(k) >= 0
        : liveIds.sessions.indexOf(k) >= 0;
      if (live) { out[k] = mapObj[k]; kept++; }
      else dropped++;
    }
    if (cap && keyKind === 'icon') {
      var live = Object.keys(out);
      while (live.length > cap) {
        delete out[live[0]]; // oldest inserted first
        live.shift(); kept--;
      }
    }
    return { map: out, kept: kept, dropped: dropped };
  }

  // collectLiveIds(stateBlob) → {icons:[], sessions:[]}: the canvas
  // state's own ids (icon ids + bound session ids), poison-tolerant.
  function collectLiveIds(stateBlob) {
    var icons = [], sessions = [];
    try {
      var st = JSON.parse(stateBlob || 'null');
      var arr = st && (st.icons || st.chatbots);
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          var c = arr[i];
          if (!c || typeof c !== 'object') continue;
          if (c.id) icons.push(String(c.id));
          if (c.sessionId) sessions.push(String(c.sessionId));
        }
      }
    } catch (e) {}
    return { icons: icons, sessions: sessions };
  }

  // ── the sweep (the DOM half) ──────────────────────────────────────

  function fetchEngineSessionIds() {
    return fetch('/api/chats').then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; }).then(function (d) {
      var out = [];
      if (d && Array.isArray(d.chats)) {
        for (var i = 0; i < d.chats.length; i++) {
          if (d.chats[i] && d.chats[i].session_id) out.push(String(d.chats[i].session_id));
        }
      }
      return out;
    });
  }

  // v1.42.4 THE LEDGER: the engine's canvas digest — every icon id +
  // bound session id across ALL canvases (an icon on ANY canvas is
  // live; post-migration the state.v2 scratch only knows the ACTIVE
  // world, so the sweep joins the engine's full ledger).
  function fetchEngineCanvasIds() {
    return fetch('/api/canvases?digest=1').then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; }).then(function (d) {
      var out = { icons: [], sessions: [] };
      if (d && Array.isArray(d.canvases)) {
        for (var i = 0; i < d.canvases.length; i++) {
          var cv = d.canvases[i];
          var ii = (cv && Array.isArray(cv.icon_ids)) ? cv.icon_ids : [];
          var si = (cv && Array.isArray(cv.session_ids)) ? cv.session_ids : [];
          for (var a = 0; a < ii.length; a++) out.icons.push(String(ii[a]));
          for (var b = 0; b < si.length; b++) out.sessions.push(String(si[b]));
        }
      }
      return out;
    });
  }

  // sweep(now) — the full pass. Returns a report (the settings page and
  // the rig read it). Offline-safe: no engine answer = canvas ids only.
  function sweep(now) {
    now = now || Date.now();
    var report = { ranAt: now, maps: {}, modelCacheDropped: false, skipped: false };
    var live = collectLiveIds(lsGet('doomalay.state.v2'));
    return Promise.all([fetchEngineSessionIds(), fetchEngineCanvasIds()]).then(function (both) {
      var engineIds = both[0];
      var canvasIds = both[1];
      if (engineIds && engineIds.length) {
        // engine ids JOIN the canvas ids (a chat can live engine-side
        // without an icon on the canvas today — its draft survives).
        for (var i = 0; i < engineIds.length; i++) {
          if (live.sessions.indexOf(engineIds[i]) < 0) live.sessions.push(engineIds[i]);
        }
      }
      // v1.42.4: the canvas ledger joins too (every world's icons)
      if (canvasIds) {
        for (var c = 0; c < canvasIds.icons.length; c++) {
          if (live.icons.indexOf(canvasIds.icons[c]) < 0) live.icons.push(canvasIds.icons[c]);
        }
        for (var s = 0; s < canvasIds.sessions.length; s++) {
          if (live.sessions.indexOf(canvasIds.sessions[s]) < 0) live.sessions.push(canvasIds.sessions[s]);
        }
      }
      if ((!engineIds || !engineIds.length) && (!canvasIds || (!canvasIds.icons.length && !canvasIds.sessions.length)) && !live.icons.length && !live.sessions.length) {
        // Nothing live known AND the engine is unreachable — do NOT
        // prune (a wrong wipe is worse than a day's wait).
        report.skipped = true;
        return report;
      }
      Object.keys(MAP_KEYS).forEach(function (key) {
        var kind = MAP_KEYS[key];
        var res = pruneMaps(readMap(key), kind, live, kind === 'icon' ? SCROLL_CAP : 0);
        if (res.dropped > 0) lsSet(key, JSON.stringify(res.map));
        report.maps[key] = { kept: res.kept, dropped: res.dropped };
      });
      // The model-catalog TTL backstop: a cache with no companion stamp
      // gets stamped NOW (first observation); a stamped cache older than
      // the TTL is dropped (modelbrowser refetches on next open — the
      // stale-while-revalidate open path already exists).
      var at = parseInt(lsGet(MODEL_CACHE_AT) || '0', 10);
      if (lsGet(MODEL_CACHE_KEY)) {
        if (!at) {
          lsSet(MODEL_CACHE_AT, String(now));
        } else if (now - at > MODEL_CACHE_TTL_MS) {
          try { window.localStorage.removeItem(MODEL_CACHE_KEY); } catch (e) {}
          lsSet(MODEL_CACHE_AT, String(now));
          report.modelCacheDropped = true;
        }
      }
      lsSet(STAMP_KEY, String(now));
      return report;
    });
  }

  function maybeSweep() {
    var last = parseInt(lsGet(STAMP_KEY) || '0', 10);
    if (Date.now() - last < SWEEP_EVERY_MS) return;
    sweep().catch(function () {});
  }

  // ── usage (the honest account) ────────────────────────────────────

  // usage() → {total, byKey}: UTF-16 byte cost per localStorage key
  // (2 bytes/char — the WebView's real accounting).
  function usage() {
    var byKey = {}, total = 0;
    try {
      var ls = window.localStorage;
      if (!ls) return { total: 0, byKey: {} };
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        var v = ls.getItem(k) || '';
        var bytes = (k.length + v.length) * 2;
        byKey[k] = bytes;
        total += bytes;
      }
    } catch (e) {}
    return { total: total, byKey: byKey };
  }

  function fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }

  // ── the Settings page ─────────────────────────────────────────────

  function row(id, label, hint) {
    return '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:9px 2px;border-bottom:1px solid var(--border)">' +
      '<span style="color:var(--text-1);font-size:var(--ui-small-fs)">' + label +
      (hint ? '<span style="color:var(--text-3);font-size:var(--ui-tiny-fs);margin-left:8px">' + hint + '</span>' : '') + '</span>' +
      '<span id="' + id + '" style="color:var(--text-2);font-size:var(--ui-small-fs);font-variant-numeric:tabular-nums">…</span>' +
      '</div>';
  }

  function pageRender() {
    setTimeout(fillRows, 0);
    return '<div style="padding:2px 0 8px">' +
      '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs);padding:2px 2px 8px">' +
        'the aged-state dashboard — sizes are honest, pruning keeps only live chats' +
      '</div>' +
      row('st-db', 'Engine database', 'sessions · events · hub rows') +
      row('st-wal', 'Write-ahead log', 'drains on idle maintenance') +
      row('st-rows', 'Rows', 'chats / events / hub / canvases') +
      row('st-vac', 'Last vacuum', 'the 7-day reclaim cadence') +
      row('st-ls', 'This device\'s storage', 'all localStorage keys') +
      '<div id="st-lskeys" style="padding:4px 2px 2px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 2px 4px">' +
        '<button id="st-clean" data-action="storage-clean" style="background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:9px;padding:8px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation">Clean stale chat data</button>' +
        '<button id="st-maint" data-action="storage-maintain" style="background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:9px;padding:8px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation">Maintain engine now</button>' +
      '</div>' +
      '<div id="st-note" style="color:var(--text-3);font-size:var(--ui-tiny-fs);padding:6px 2px"></div>' +
      '</div>';
  }

  function setTxt(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  function fillRows() {
    // localStorage side (local, instant)
    var u = usage();
    setTxt('st-ls', fmtBytes(u.total));
    var keys = Object.keys(u.byKey).sort(function (a, b) { return u.byKey[b] - u.byKey[a]; }).slice(0, 6);
    var kh = keys.map(function (k) {
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;color:var(--text-3);font-size:var(--ui-tiny-fs)">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">' + k.replace(/^doomalay\./, '') + '</span>' +
        '<span style="font-variant-numeric:tabular-nums">' + fmtBytes(u.byKey[k]) + '</span></div>';
    }).join('');
    var kEl = document.getElementById('st-lskeys');
    if (kEl) kEl.innerHTML = kh;

    // engine side (async)
    fetch('/api/storage/usage').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (d) {
      if (!d || !d.engine) { setTxt('st-db', 'unreachable'); setTxt('st-wal', '—'); setTxt('st-rows', '—'); setTxt('st-vac', '—'); return; }
      var e = d.engine;
      setTxt('st-db', fmtBytes(e.db_bytes || 0));
      setTxt('st-wal', fmtBytes(e.wal_bytes || 0));
      setTxt('st-rows', (e.sessions || 0) + ' / ' + (e.chat_events || 0) + ' / ' + (e.hub_items || 0) + ' / ' + (e.canvases || 0));
      if (e.last_vacuum_at) {
        var hrs = Math.round((Date.now() / 1000 - e.last_vacuum_at) / 3600);
        setTxt('st-vac', hrs <= 1 ? 'just now' : (hrs < 48 ? hrs + 'h ago' : Math.round(hrs / 24) + 'd ago'));
      } else setTxt('st-vac', 'never');
    });

    wireActions();
  }

  function wireActions() {
    var clean = document.getElementById('st-clean');
    if (clean && !clean.dataset.wired) {
      clean.dataset.wired = '1';
      clean.addEventListener('click', function () {
        clean.disabled = true; clean.textContent = 'cleaning…';
        sweep().then(function (rep) {
          clean.disabled = false; clean.textContent = 'Clean stale chat data';
          var n = 0;
          Object.keys(rep.maps).forEach(function (k) { n += rep.maps[k].dropped; });
          note(rep.skipped
            ? 'skipped — nothing live is known right now (offline?)'
            : ('removed ' + n + ' stale ' + (n === 1 ? 'entry' : 'entries') + (rep.modelCacheDropped ? ' + the stale model cache' : '')));
          fillRows();
        }).catch(function () { clean.disabled = false; clean.textContent = 'Clean stale chat data'; note('the sweep failed — try again'); });
      });
    }
    var maint = document.getElementById('st-maint');
    if (maint && !maint.dataset.wired) {
      maint.dataset.wired = '1';
      maint.addEventListener('click', function () {
        maint.disabled = true; maint.textContent = 'maintaining…';
        fetch('/api/storage/maintain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (d) {
          maint.disabled = false; maint.textContent = 'Maintain engine now';
          if (d && d.ok) {
            var rep = d.report || {};
            note('checkpoint ' + (rep.Checkpointed ? '✓' : '✗') + ' · vacuum ' + (rep.VacuumRan ? 'ran' : 'not needed') + ' · wal ' + fmtBytes(rep.WALBytesPre || 0) + ' → ' + fmtBytes(rep.WALBytesPost || 0));
          } else {
            note((d && d.error) || 'the engine refused');
          }
          fillRows();
        }).catch(function () { maint.disabled = false; maint.textContent = 'Maintain engine now'; note('the engine is unreachable'); });
      });
    }
  }

  function note(txt) {
    var el = document.getElementById('st-note');
    if (el) el.textContent = txt;
  }

  // ── boot ──────────────────────────────────────────────────────────

  function boot() {
    if (window.Settings && window.Settings.registerPage) {
      window.Settings.registerPage('storage', {
        title: 'Storage',
        icon: '▤',
        render: pageRender
      });
    }
    // The daily sweep rides boot (idle-ish; the stamp makes it once/24h).
    setTimeout(maybeSweep, 4000);
  }

  if (typeof window !== 'undefined') {
    window.DoomStorage = {
      sweep: sweep,
      usage: usage,
      fmtBytes: fmtBytes,
      KEYS: MAP_KEYS,
      _collectLiveIds: collectLiveIds,
      _pruneMaps: pruneMaps
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else boot();
  } else if (typeof module !== 'undefined' && module.exports) {
    // the node rig path — the pure core only
    module.exports = { pruneMaps: pruneMaps, collectLiveIds: collectLiveIds, MAP_KEYS: MAP_KEYS };
  }
})();
