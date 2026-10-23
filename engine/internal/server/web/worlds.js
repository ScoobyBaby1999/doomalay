// worlds.js — v1.42.4 THE LEDGER (PLAN-V142 §3.2 W2): the Worlds
// registry. The engine becomes the durable home for canvas state; the
// WebView's doomalay.state.v2 stays as the fast local scratch (and the
// freshest-wins crash-heal backup); doomalay.canvas.current is the tiny
// active-pointer.
//
// WHY (R3, the plan's decision): WebView localStorage is 5-10 MB,
// evictable, and wiped by WebView updates — it cannot hold N worlds +
// thumbnails. The engine dir is durable, already the chats' home.
//
// THE CADENCE LAW (the drag-rate finding, app.js:1448): scheduleSave
// fires per tick during icon drags — a 200ms-debounced engine PUT would
// hammer SQLite (~5 commits/s × the full world state). So the engine
// sync rides its own CALM debounce (≥2s between PUTs, trailing, always
// flushed on pagehide/visibility-hidden) while the localStorage scratch
// keeps its 200ms shape. Boot convergence is freshest-savedAt-wins: a
// crash loses at most the unsynced tail, and the next boot heals it.
//
// THIS PHASE owns the data plane only: registry + migration + sync.
// No switchTo, no freeze, no UI (v1.42.5+ THE SWAP / THE MANAGER).
//
// Dual-environment (the storagehygiene.js precedent): the pure core
// (decideBoot + the throttle math) is node-requireable for the rig.
//
// Exposes: window.Worlds { boot, save, flushNow, active, activeId,
// setCurrent, CanvasStore } — app.js consumes boot()/save()/flushNow().
(function () {
  'use strict';

  var POINTER_KEY = 'doomalay.canvas.current';
  var SCRATCH_KEY = 'doomalay.state.v2';       // app.js's save target — read here for the heal decision
  var DEFAULT_ID = 'default';                   // the migration target (deterministic — concurrent boots converge)
  var SYNC_MIN_MS = 2000;                       // the calm cadence
  var HEAL_SKEW_MS = 1000;                      // tombstone must beat the row by ≥1s to win

  // ── the pure core (node-rig tested) ─────────────────────────────

  // decideBoot(rows, tombstone, pointerId) → the boot decision:
  //   rows       — null (engine unreachable) | [] | [{id, saved_at, …}]
  //   tombstone  — the parsed state.v2 scratch | null
  //   pointerId  — the localStorage pointer | null
  // → {source: 'engine'|'tombstone'|'fresh', id?, migrate?, resync?}
  //
  //   engine-down  + scratch  → tombstone (today's exact behavior)
  //   engine-down  + none     → fresh
  //   rows + pointer-match    → that row (or the first row — stale pointer heals)
  //   rows + fresher scratch  → tombstone + resync (the ≤2s crash-window heal;
  //                             ONLY when the scratch belongs to that row —
  //                             the scratch carries its canvas id post-migration)
  //   no rows + scratch       → tombstone + MIGRATE (state.v2 becomes 'default')
  //   no rows + none          → fresh + MIGRATE (a 'default' canvas is birthed)
  function decideBoot(rows, tombstone, pointerId) {
    if (rows === null) {
      return tombstone ? { source: 'tombstone' } : { source: 'fresh' };
    }
    if (rows && rows.length > 0) {
      var current = null;
      if (pointerId) {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i] && rows[i].id === pointerId) { current = rows[i]; break; }
        }
      }
      if (!current) current = rows[0];
      // the crash-window heal: the scratch is fresher AND belongs to this row
      if (tombstone && typeof tombstone.savedAt === 'number') {
        var owns = tombstone.canvas === current.id ||
                   (tombstone.canvas === undefined && rows.length === 1);
        if (owns && tombstone.savedAt > (current.saved_at || 0) + HEAL_SKEW_MS) {
          return { source: 'tombstone', id: current.id, resync: true };
        }
      }
      return { source: 'engine', id: current.id };
    }
    if (tombstone) return { source: 'tombstone', id: DEFAULT_ID, migrate: true };
    return { source: 'fresh', id: DEFAULT_ID, migrate: true };
  }

  // syncWait(now, lastSync, dirty) — the calm-cadence math (rig-tested):
  // how long flush() should wait before the next PUT (0 = now).
  function syncWait(now, lastSync, dirty) {
    if (!dirty) return -1;            // nothing to send — no timer
    var remain = lastSync + SYNC_MIN_MS - now;
    return remain > 0 ? remain : 0;
  }

  // ── the DOM half ────────────────────────────────────────────────

  var active = null;        // {id, name, sort} — the ONE active world (this phase: always the boot pick)
  var dirty = null;         // the latest unsent state — {state, id}: the id is
                            // tagged at save() time (a switch can move `active`
                            // between the save and the flush; the payload
                            // belongs to ITS world)
  var syncing = false;      // a PUT in flight
  var lastSync = 0;
  var syncTimer = 0;
  var syncLog = [];         // v1.42.5: the last 64 flush attempts (the rigs'
                            // PUT-law evidence — id, savedAt, icon count)
  var booted = false;

  function lsGet(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (e) {} }

  function readTombstone() {
    try {
      var raw = lsGet(SCRATCH_KEY);
      if (!raw) return null;
      var st = JSON.parse(raw);
      return (st && typeof st === 'object') ? st : null;
    } catch (e) { return null; }
  }
  function readPointer() {
    var v = lsGet(POINTER_KEY);
    return v || null;
  }
  function writePointer(id) { lsSet(POINTER_KEY, String(id)); }

  // CanvasStore — the engine client (relative URLs, the house law).
  var CanvasStore = {
    list: function () {
      return fetch('/api/canvases').then(function (r) {
        if (!r.ok) throw new Error('list ' + r.status);
        return r.json();
      }).then(function (d) { return (d && d.canvases) || []; });
    },
    get: function (id) {
      return fetch('/api/canvases/' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) throw new Error('get ' + r.status);
        return r.json();
      });
    },
    upsert: function (id, fields) {
      return fetch('/api/canvases/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields || {})
      }).then(function (r) {
        if (!r.ok) {
          var err = new Error('upsert ' + r.status);
          err.status = r.status;
          if (r.status === 409) {
            // v1.69.2 THE ROOM: the stale-doc gate's truth (ops_since /
            // latest) must ride the error — the flush's catch dispatches
            // the rebase event from it. The body resolves BEFORE the
            // throw (the promise chain, never a race).
            return r.json().then(function (b) {
              err.body = b;
              throw err;
            }).catch(function (e) {
              if (e === err) throw e;
              throw err; // a body-parse failure still carries the 409
            });
          }
          throw err;
        }
        return r.json();
      });
    },
    remove: function (id) {
      return fetch('/api/canvases/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { if (!r.ok) throw new Error('delete ' + r.status); return r.json(); });
    },
    putThumb: function (id, bytes) {
      return fetch('/api/canvases/' + encodeURIComponent(id) + '/thumb', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes
      }).then(function (r) {
        if (!r.ok) throw new Error('thumb ' + r.status);
        return r.json();
      });
    }
  };

  // boot() → Promise<decision> — called by app.js init BEFORE the state
  // restore. Performs the migration when the decision says so.
  function boot() {
    if (booted) return Promise.resolve(boot._last || { source: 'fresh' });
    return CanvasStore.list().then(function (rows) {
      return converge(rows);
    }).catch(function () {
      return converge(null); // engine unreachable — the honest fallback
    });
  }

  function converge(rows) {
    var tomb = readTombstone();
    var ptr = readPointer();
    var d = decideBoot(rows, tomb, ptr);
    booted = true;
    boot._last = d;
    if (!d.id) d.id = DEFAULT_ID;
    active = { id: d.id, name: (d.source === 'engine' && rowById(rows, d.id)) ? rowById(rows, d.id).name : 'Canvas', sort: 0 };
    var done = function () {
      writePointer(d.id);
      try { window.dispatchEvent(new CustomEvent('doomalay:worlds-booted', { detail: { source: d.source, id: d.id, migrate: !!d.migrate, resync: !!d.resync } })); } catch (e) {}
      return d;
    };
    if (d.migrate) {
      // the v1 migration: the scratch (or a fresh shell) becomes the
      // 'default' canvas — idempotent PUT, concurrent-boot safe.
      var st = (d.source === 'tombstone') ? tomb : {};
      return CanvasStore.upsert(DEFAULT_ID, { name: 'Canvas', state: st })
        .catch(function () { /* engine flaked mid-migration — the scratch stays the truth until the next boot retries */ })
        .then(done);
    }
    return Promise.resolve(done());
  }

  function rowById(rows, id) {
    if (!rows) return null;
    for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) return rows[i];
    return null;
  }

  // save(state) — app.js's saveNow hands every state here; the CALM
  // debounce keeps the engine at ≤1 PUT / 2s steady-state (the drag law).
  function save(state) {
    if (!active) return;
    dirty = { state: state, id: active.id };   // v1.42.5: the id rides the payload
    if (!syncTimer) {
      syncTimer = setTimeout(flush, SYNC_MIN_MS);
    }
  }

  function flush() {
    syncTimer = 0;
    if (!dirty || syncing) return;
    var wait = syncWait(Date.now(), lastSync, dirty);
    if (wait > 0) { syncTimer = setTimeout(flush, wait); return; }
    var st = dirty.state;
    var id = dirty.id;   // tagged at save() time — a switch can move `active`
    // between the save and this flush; the payload belongs to ITS world.
    dirty = null;
    syncing = true;
    lastSync = Date.now();
    syncLog.push({ at: lastSync, id: id, savedAt: st && st.savedAt, icons: st && st.icons ? st.icons.length : -1, theme: st && st.settings ? st.settings.theme : null });
    if (syncLog.length > 64) syncLog.shift();
    CanvasStore.upsert(id, { state: st }).catch(function (err) {
      if (err && err.status === 409) {
        // v1.69.2 THE ROOM: a stale whole-state PUT is NOT a network
        // failure — the payload must NOT re-arm (it would 409-loop
        // forever). The collab session owns the recovery: the rebase
        // applies the missed ops, then a FRESH save re-derives the
        // payload with the advanced cursor and the calm cadence reflushes.
        syncLog.push({ at: Date.now(), id: id, stale: true, ops_since: err.body && err.body.ops_since, latest: err.body && err.body.latest });
        if (syncLog.length > 64) syncLog.shift();
        try {
          window.dispatchEvent(new CustomEvent('doomalay:doc-stale', {
            detail: { id: id, ops_since: err.body && err.body.ops_since, latest: err.body && err.body.latest }
          }));
        } catch (e) {}
        return;
      }
      // the PUT failed — restore the payload for the next flush; the
      // crash-window heal covers the rest at boot.
      if (!dirty || (st.savedAt || 0) >= (dirty.state.savedAt || 0)) dirty = { state: st, id: id };
    }).then(function () {
      syncing = false;
      if (dirty && !syncTimer) syncTimer = setTimeout(flush, 250);
    });
  }

  // flushNow() — pagehide/visibility-hidden AND the world switch: the
  // last-chance sync (bypasses the calm throttle; the browser is going
  // away or the world is about to stop existing in memory).
  function flushNow() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = 0; }
    if (!dirty) return;
    var d = dirty;
    dirty = null;
    // sendBeacon-style best-effort: a plain fetch with keepalive so the
    // browser doesn't cancel it on teardown.
    try {
      syncLog.push({ at: Date.now(), id: d.id, savedAt: d.state && d.state.savedAt, icons: d.state && d.state.icons ? d.state.icons.length : -1, now: true });
      if (syncLog.length > 64) syncLog.shift();
      fetch('/api/canvases/' + encodeURIComponent(d.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: d.state }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function activeInfo() { return active ? { id: active.id, name: active.name, sort: active.sort } : null; }
  function activeId() { return active ? active.id : DEFAULT_ID; }

  // setCurrent(id) — future phases (THE SWAP) own the real switching;
  // this phase only persists the pointer when the boot picks a row.
  function setCurrent(id) {
    if (!id) return;
    if (active) active.id = String(id);
    writePointer(id);
  }

  // ── the exports ─────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    window.Worlds = {
      boot: boot,
      save: save,
      flush: flush,
      flushNow: flushNow,
      active: activeInfo,
      activeId: activeId,
      setCurrent: setCurrent,
      CanvasStore: CanvasStore,
      _decideBoot: decideBoot,
      _syncWait: syncWait,
      _syncLog: function () { return syncLog.slice(); },
      DEFAULT_ID: DEFAULT_ID,
      SYNC_MIN_MS: SYNC_MIN_MS
    };
  } else if (typeof module !== 'undefined' && module.exports) {
    // the node rig path — the pure core only
    module.exports = { decideBoot: decideBoot, syncWait: syncWait, DEFAULT_ID: DEFAULT_ID, SYNC_MIN_MS: SYNC_MIN_MS };
  }
})();
