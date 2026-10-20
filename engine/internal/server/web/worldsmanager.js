// worldsmanager.js — v1.42.7 THE MANAGER (PLAN-V142 §3.4 W4): the
// worlds overlay. Three zones, top to bottom:
//
//   1. YOUR CANVASES — a row per world (thumbnail, name, updated, size);
//      tap = jump (the ONE switchTo — or the portal dive when the manager
//      was entered from a portal's panel). Long-press a row (or its ⋯)
//      = rename / duplicate / delete. Rename is LOCAL-ONLY and rides the
//      engine row — the no-clobber law keeps state safe (store comment,
//      canvases.go: the v1.42.7 rename PUT must never clobber state).
//   2. BROWSE WORLDS — opens the hub pre-filtered to the canvas type.
//      The canvas library type ships with the library wave (v1.43.0):
//      until it registers, the same call lands on the hub home honestly
//      (the hub's type-reset law) and the row says so — zero dead ends,
//      zero changes needed when the wave lands.
//   3. + CREATE NEW CANVAS — a blank world with a generic name
//      (canvas_N, first free index — ONE law, the Settings page shares
//      it); when entered from a portal, the pair wires per W3's two-way
//      law and the dive carries you through.
//
// THE BACK-STACK: the visited chain (doomalay:world-switched events,
// browser semantics — a revisit truncates) + the manager as home base.
// A '↩ back to X' chip appears whenever there is somewhere to go back
// to. Session memory only (the plan: "visited worlds in this dive").
//
// THE SURFACE LAW: this rides ConnectOverlay — the sanctioned Overlay
// Screen (open/pushPage/popPage; the sheet and the rename form are
// pushed pages, so the back gesture and Esc pop them by the built-in
// law). ZERO body appenders (B1): every node lives in the overlay's
// content element.
//
// THE BUDGET LAW: open-time DOM only — no tick handlers, no per-frame
// work, nothing at rest. The switch burst rides v1.42.5's ONE switchTo.
//
// Theme law: zero literal colors — everything composes var(--…).
//
// Exposes: window.WorldsManager = { open, nextName, probe } (app.js +
// the settings page + the rigs).
(function () {
  'use strict';

  var HOLD_MS = 500;        // the app's LONG_PRESS_MS (app.js:1901)
  var MOVE_PX = 10;         // the app's MOVE_THRESHOLD

  var rowsCache = [];
  var libHasCanvas = false;
  var lastErr = '';
  var openCtx = null;       // {fromPortal: holeIcon} | null
  var myPage = false;       // the manager page is (one of) the overlay's

  // ── the visited chain (the back-stack) ───────────────────────────

  var visited = [];         // ids, oldest first (browser semantics)
  window.addEventListener('doomalay:world-switched', function (e) {
    var id = e && e.detail && e.detail.id;
    if (!id) return;
    var i = visited.indexOf(id);
    if (i >= 0) visited.length = i + 1;   // a revisit truncates the loop
    else visited.push(id);
  });
  function seedVisited() {
    if (!visited.length) {
      visited = [(window.Worlds && window.Worlds.activeId) ? window.Worlds.activeId() : 'default'];
    }
  }

  // ── helpers ──────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status);
      return r.json();
    });
  }
  function activeId() {
    return (window.Worlds && window.Worlds.activeId) ? window.Worlds.activeId() : 'default';
  }
  function toast(txt) {
    if (window.DoomToast) { try { window.DoomToast(txt); } catch (e) {} }
    else console.log('worldsmanager: ' + txt);
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    var ms = Date.now() - (ts > 1e12 ? ts : ts * 1000);
    var min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    var hrs = Math.round(min / 60);
    if (hrs < 48) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }
  function fmtSize(b) {
    if (!b || b <= 0) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function fetchRows() {
    return fetch('/api/canvases').then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; }).then(function (d) {
      rowsCache = (d && d.canvases) || [];
      return rowsCache;
    });
  }

  // nextName(rows) — the generic-default law (the plan: canvas_1, first
  // free index). Catches the legacy 'Canvas N' names too, so a mixed
  // install never births a duplicate. ONE law: the Settings page's
  // create rides this same helper.
  function nextName(rows) {
    var used = {};
    (rows || []).forEach(function (r) {
      var m = /^canvas[\s_-]*(\d+)$/i.exec(String((r && r.name) || ''));
      if (m) used[parseInt(m[1], 10)] = true;
    });
    var n = 1;
    while (used[n]) n++;
    return 'canvas_' + n;
  }

  // ── the page skeleton (the root) ─────────────────────────────────
  // A placeholder + onSwap — popPage re-renders the SNAPSHOT html, so
  // the skeleton is static and fill() paints LIVE state every time the
  // root page lands (fresh rows after every sheet action, for free).

  function rootHTML() {
    return '<div id="wm-root" style="padding:18px 16px 22px;display:flex;flex-direction:column;gap:12px;min-height:100%">' +
      '<div id="wm-head" style="display:flex;flex-direction:column;gap:4px">' +
        '<div style="font-size:var(--ui-large-fs);font-weight:700;color:var(--text-1)">Worlds</div>' +
        '<div id="wm-sub" style="color:var(--text-3);font-size:var(--ui-tiny-fs)">…</div>' +
      '</div>' +
      '<button id="wm-back" style="display:none;align-self:flex-start;background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:999px;padding:7px 14px;font-size:var(--ui-small-fs);cursor:pointer;touch-action:manipulation"></button>' +
      '<div id="wm-portalnote" style="display:none;background:rgba(var(--accent-rgb),0.10);border:1px solid rgba(var(--accent-rgb),0.30);border-radius:10px;padding:9px 12px;color:var(--text-2);font-size:var(--ui-tiny-fs)"></div>' +
      '<div id="wm-rows" style="display:flex;flex-direction:column"></div>' +
      '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs);letter-spacing:0.08em;text-transform:uppercase;padding-top:6px">browse</div>' +
      '<button id="wm-browse" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:12px;padding:12px 14px;font-size:var(--ui-small-fs);cursor:pointer;touch-action:manipulation">' +
        '<span style="font-size:18px;line-height:1">🜚</span>' +
        '<span style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="font-weight:600">browse worlds</span>' +
        '<span id="wm-browse-sub" style="color:var(--text-3);font-size:var(--ui-tiny-fs)">…</span></span>' +
      '</button>' +
      '<button id="wm-create" style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:12px;padding:12px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation">＋ create new canvas</button>' +
      '<div id="wm-note" style="color:var(--text-3);font-size:var(--ui-tiny-fs)"></div>' +
      '<div id="wm-storage" style="color:var(--text-3);font-size:var(--ui-tiny-fs);margin-top:auto"></div>' +
      '</div>';
  }

  function note(txt) {
    var el = document.getElementById('wm-note');
    if (el) el.textContent = txt || '';
  }

  // ── zone 1 rows ──────────────────────────────────────────────────

  function rowHTML(r) {
    var isActive = r.id === activeId();
    var portal = !!(openCtx && openCtx.fromPortal);
    var dead = portal && isActive;    // the pair law: a portal never targets its own world
    var thumb = r.has_thumb
      ? '<img src="/api/canvases/' + encodeURIComponent(r.id) + '/thumb" alt="" style="width:52px;height:40px;object-fit:cover;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);flex:none">'
      : '<div style="width:52px;height:40px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:16px">⊞</div>';
    var name = '<span style="color:var(--text-1);' + (isActive ? 'font-weight:600' : '') + '">' + esc(r.name) + '</span>';
    var badge = isActive
      ? '<span style="color:var(--ok);font-size:var(--ui-tiny-fs);border:1px solid var(--border);border-radius:999px;padding:1px 7px;flex:none">' + (portal ? 'you are here' : 'active') + '</span>'
      : '';
    var meta = (r.icon_count || 0) + ' icons · ' + fmtSize(r.state_bytes) + ' · ' + fmtAgo(r.saved_at || r.updated_at);
    return '<div data-wm-id="' + esc(r.id) + '" style="display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--border);cursor:' + (dead ? 'default' : 'pointer') + ';touch-action:manipulation;' + (dead ? 'opacity:0.55' : '') + '">' +
      thumb +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">' +
        '<div style="display:flex;align-items:center;gap:8px;min-width:0">' + name + badge + '</div>' +
        '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs)">' + esc(meta) + '</div>' +
      '</div>' +
      (dead ? '' :
        '<button data-wm-more="' + esc(r.id) + '" title="Actions" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:15px;flex:none">⋯</button>') +
      '</div>';
  }

  function fill() {
    var host = document.getElementById('wm-rows');
    if (!host) return;
    var portal = !!(openCtx && openCtx.fromPortal);
    var sub = document.getElementById('wm-sub');
    if (sub) sub.textContent = rowsCache.length
      ? rowsCache.length + (rowsCache.length === 1 ? ' world' : ' worlds') + ' — tap one to switch (chats keep running)'
      : '…';
    if (!rowsCache.length) {
      host.innerHTML = '<div style="color:var(--text-3);font-size:var(--ui-small-fs);padding:10px 2px">no canvases yet</div>';
    } else {
      host.innerHTML = rowsCache.map(rowHTML).join('');
    }
    // the portal context banner
    var pn = document.getElementById('wm-portalnote');
    if (pn) {
      if (portal) {
        var lbl = (openCtx.fromPortal && openCtx.fromPortal.label) || 'portal';
        pn.style.display = '';
        pn.textContent = 'picking a new target for "' + lbl + '" — tap a world and fall through';
      } else pn.style.display = 'none';
    }
    // the back chip (the visited chain)
    var back = document.getElementById('wm-back');
    if (back) {
      if (visited.length > 1) {
        var prev = visited[visited.length - 2];
        var prow = rowsCache.filter(function (r) { return r.id === prev; })[0];
        back.style.display = '';
        back.textContent = '↩ back to ' + ((prow && prow.name) || 'the previous world');
      } else back.style.display = 'none';
    }
    // the browse subtitle (the forward-wiring: flips when v1.43.0 lands)
    var bs = document.getElementById('wm-browse-sub');
    if (bs) bs.textContent = libHasCanvas
      ? 'shared worlds, ready to download'
      : 'canvas worlds join the library with the next wave';
    // the storage line (best-effort)
    fetch('/api/storage/usage').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (d) {
      var el = document.getElementById('wm-storage');
      if (el && d && d.engine) {
        el.textContent = d.engine.canvases + ' canvas' + (d.engine.canvases === 1 ? '' : 'es') + ' · engine db ' +
          ((d.engine.db_bytes / 1048576).toFixed(1)) + ' MB';
      }
    });
  }

  function refresh() {
    return fetchRows().then(function (rows) {
      if (rows === null) {
        lastErr = 'the engine is unreachable';
        note(lastErr);
      } else {
        lastErr = '';
        note('');
      }
      fill();
      return rows;
    });
  }

  // ── the actions ──────────────────────────────────────────────────

  function doSwitch(id) {
    note('switching…');
    window.doomalay.switchTo(id).then(function (res) {
      if (res && res.ok) {
        closeMine();
        if (res.already) toast('already here');
      } else {
        note((res && res.error) || 'the switch failed');
      }
    });
  }

  function doCreate() {
    var portal = openCtx && openCtx.fromPortal;
    api('POST', '/api/canvases', { name: nextName(rowsCache), state: { icons: [], dots: [], savedAt: Date.now(), offset: { x: 0, y: 0 }, scale: 1 } })
      .then(function (d) {
        var id = d && d.canvas && d.canvas.id;
        if (!id) throw new Error('no id');
        if (portal) {
          // the plan: "(when entered from a portal) wires the return
          // portal per W3's two-way law" — the pair births at the hole,
          // then the dive carries you through.
          return retargetPair(portal, id).then(function (res) {
            return { dive: true, res: res, id: id };
          });
        }
        return { dive: false, id: id };
      })
      .then(function (r) {
        closeHostPanel();
        closeMine();
        if (r.dive) {
          if (r.res && r.res.hole) return window.Holes.transition(r.res.hole);
          return diveNew();
        }
        return window.doomalay.switchTo(r.id);
      })
      .catch(function (e) { note('create failed — ' + (e && e.message)); });
  }

  // the portal context: re-point the pair at the hole's position, then
  // dive. The old pair dies (both sides), the new one births at the
  // same spot — the hole "refreshes" in place.
  function retargetPair(hole, targetId) {
    var at = { x: hole.x, y: hole.y };
    var label = hole.label || '';
    var oldPair = hole.pairId;
    return Promise.resolve()
      .then(function () {
        return window.Holes.deletePair(oldPair);
      })
      .then(function () {
        return window.Holes.createPair(at, targetId, label);
      });
  }
  function diveNew() {
    var probe = window.Holes.probe();
    var hole = probe && probe.holes && probe.holes.length
      ? window.doomalay.world.entities.filter(function (e) { return e.type === 'hole'; })[0]
      : null;
    if (hole) return window.Holes.transition(hole);
    toast('the pair is wired — tap the portal to fall through');
    return Promise.resolve({ ok: true });
  }
  function doPortalDive(rowId) {
    var hole = openCtx && openCtx.fromPortal;
    if (!hole) return;
    note('re-targeting…');
    retargetPair(hole, rowId).then(function (res) {
      // the fresh hole becomes the context (a second pick re-targets
      // THE NEW pair — never births a stacked twin)
      if (res && res.hole) openCtx.fromPortal = res.hole;
      closeHostPanel();
      closeMine();
      if (res && res.hole) return window.Holes.transition(res.hole);
      return diveNew();
    }).catch(function (e) {
      note('re-target failed — ' + (e && e.message));
    });
  }
  function closeHostPanel() {
    if (window.Holes && window.Holes.closeHostPanel) { try { window.Holes.closeHostPanel(); } catch (e) {} }
  }

  function doRename(id) {
    var row = rowsCache.filter(function (r) { return r.id === id; })[0];
    var current = (row && row.name) || '';
    var html = '<div style="padding:18px 16px;display:flex;flex-direction:column;gap:14px">' +
      '<div style="font-size:var(--ui-large-fs);font-weight:700;color:var(--text-1)">Rename</div>' +
      '<form id="wm-rn" style="display:flex;flex-direction:column;gap:10px">' +
        '<input id="wm-rn-in" value="' + esc(current) + '" maxlength="60" style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text-1);padding:10px 12px;font-size:var(--ui-small-fs)" />' +
        '<div style="display:flex;gap:8px">' +
          '<button type="submit" style="flex:1;background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:10px;padding:10px 12px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer">save</button>' +
          '<button type="button" id="wm-rn-x" style="flex:1;background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:var(--ui-small-fs);cursor:pointer">cancel</button>' +
        '</div>' +
        '<div id="wm-rn-note" style="color:var(--text-3);font-size:var(--ui-tiny-fs)">the name rides this device\'s row — published names are never touched</div>' +
      '</form>' +
      '</div>';
    window.ConnectOverlay.pushPage(html, {
      onSwap: function () {
        var input = document.getElementById('wm-rn-in');
        if (input) { input.focus(); input.select(); }
        var form = document.getElementById('wm-rn');
        if (!form) return;
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var v = (input.value || '').trim();
          var nEl = document.getElementById('wm-rn-note');
          if (!v) { if (nEl) nEl.textContent = 'a name, please'; return; }
          api('PUT', '/api/canvases/' + encodeURIComponent(id), { name: v })
            .then(function () {
              toast('renamed');
              popToRoot(2);
              refresh();
            })
            .catch(function (err) { if (nEl) nEl.textContent = 'rename failed — ' + (err && err.message); });
        });
        var x = document.getElementById('wm-rn-x');
        if (x) x.addEventListener('click', function () { popToRoot(2); });
      }
    });
  }

  function doDuplicate(id) {
    var src = rowsCache.filter(function (r) { return r.id === id; })[0];
    note('duplicating…');
    fetch('/api/canvases/' + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var st = d && d.canvas && d.canvas.state;
        if (!st) throw new Error('the source has no state');
        return api('POST', '/api/canvases', { name: ((src && src.name) || 'canvas') + ' copy', state: st });
      })
      .then(function () { toast('duplicated'); popToRoot(1); refresh(); })
      .catch(function (e) { note('duplicate failed — ' + (e && e.message)); });
  }

  function doDelete(id) {
    var row = rowsCache.filter(function (r) { return r.id === id; })[0];
    // the two-tap forever question (the del-ov precedent's language)
    var html = '<div style="padding:18px 16px;display:flex;flex-direction:column;gap:14px">' +
      '<div style="font-size:var(--ui-large-fs);font-weight:700;color:var(--text-1)">Delete ' + esc((row && row.name) || id) + ' forever?</div>' +
      '<div style="color:var(--text-3);font-size:var(--ui-small-fs)">(a very long time)</div>' +
      '<div style="color:var(--text-2);font-size:var(--ui-small-fs)">The world, its layout and every portal side living in it — gone from this device. Portals aiming here become lost. This cannot be undone.</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="wm-del-k" style="flex:1;background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:var(--ui-small-fs);cursor:pointer">keep it</button>' +
        '<button id="wm-del-y" style="flex:1;background:rgba(var(--warn-rgb),0.14);color:var(--text-1);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer">delete forever</button>' +
      '</div>' +
      '<div id="wm-del-note" style="color:var(--text-3);font-size:var(--ui-tiny-fs)"></div>' +
      '</div>';
    window.ConnectOverlay.pushPage(html, {
      onSwap: function () {
        var k = document.getElementById('wm-del-k');
        if (k) k.addEventListener('click', function () { popToRoot(1); });
        var y = document.getElementById('wm-del-y');
        if (!y) return;
        y.addEventListener('click', function () {
          var nEl = document.getElementById('wm-del-note');
          if (rowsCache.length <= 1) { if (nEl) nEl.textContent = 'the last canvas stays — the app needs a world'; return; }
          var after = function () {
            api('DELETE', '/api/canvases/' + encodeURIComponent(id))
              .then(function () {
                toast('deleted');
                if (window.Holes && window.Holes.healLost) window.Holes.healLost();   // live lost-marks, not just next boot
                popToRoot(2);   // confirm → sheet → the manager rows (never the stale sheet)
                refresh();
              })
              .catch(function (e) { if (nEl) nEl.textContent = 'delete failed — ' + (e && e.message); });
          };
          if (id === activeId()) {
            if (nEl) nEl.textContent = 'switching away…';
            var other = rowsCache.filter(function (r) { return r.id !== id; })[0];
            window.doomalay.switchTo(other.id).then(function (res) {
              if (res && res.ok) after();
              else if (nEl) nEl.textContent = (res && res.error) || 'could not switch away — nothing deleted';
            });
          } else after();
        });
      }
    });
  }

  // the row action sheet (long-press or ⋯). Publish rides the bundle
  // wave (v1.42.8's CanvasPublisher) — a dead button would lie.
  function openSheet(id) {
    var row = rowsCache.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    var btn = function (act, glyph, label) {
      return '<button data-wm-act="' + act + '" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:10px;padding:11px 13px;font-size:var(--ui-small-fs);cursor:pointer;touch-action:manipulation">' +
        '<span style="width:20px;text-align:center;flex:none">' + glyph + '</span><span>' + label + '</span></button>';
    };
    var html = '<div style="padding:18px 16px;display:flex;flex-direction:column;gap:10px">' +
      '<div style="display:flex;flex-direction:column;gap:2px;padding-bottom:2px">' +
        '<div style="font-size:var(--ui-large-fs);font-weight:700;color:var(--text-1)">' + esc(row.name) + '</div>' +
        '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs)">' + (row.icon_count || 0) + ' icons · ' + fmtSize(row.state_bytes) + ' · ' + fmtAgo(row.saved_at || row.updated_at) + '</div>' +
      '</div>' +
      btn('rename', '✎', 'rename') +
      btn('dup', '⧉', 'duplicate') +
      btn('del', '🗑', 'delete') +
      '</div>';
    window.ConnectOverlay.pushPage(html, {
      onSwap: function () {
        var root = window.ConnectOverlay.getContentEl();
        if (!root) return;
        root.querySelectorAll('[data-wm-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var act = b.getAttribute('data-wm-act');
            if (act === 'rename') doRename(id);
            else if (act === 'dup') doDuplicate(id);
            else if (act === 'del') doDelete(id);
          });
        });
      }
    });
  }

  // popToRoot(levels) — walk back to the root page; the root's onSwap
  // re-fills from live state (the placeholder law), so the rows are
  // fresh when we land. The overlay's own gen-guard makes chained pops
  // safe (only the last render fires).
  function popToRoot(levels) {
    var ov = window.ConnectOverlay;
    if (!ov) return;
    var n = Math.min(levels || 1, (ov.pageDepth && ov.pageDepth()) - 1);
    for (var i = 0; i < n; i++) {
      try { ov.popPage(); } catch (e) { break; }
    }
  }
  function closeMine() {
    myPage = false;
    if (window.ConnectOverlay && window.ConnectOverlay.isOpen()) {
      try { window.ConnectOverlay.close(); } catch (e) {}
    }
  }

  // ── the browse row (the hub pre-filter, forward-wired) ───────────

  function doBrowse() {
    if (!(window.doomalay && window.doomalay.openLibrary)) { note('the library is unavailable'); return; }
    closeMine();
    // today (canvas type unregistered): the hub home, honestly. When
    // v1.43.0 registers it: the same call pre-filters. ONE code path.
    window.doomalay.openLibrary(libHasCanvas ? 'canvas' : undefined);
    if (!libHasCanvas) toast('canvas worlds join the library soon — browsing everything');
  }

  // ── the wiring (delegation — the containers survive child swaps) ─

  var hold = { timer: null, rowId: null, x: 0, y: 0, fired: false };
  function clearHold() {
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = null; }
    hold.rowId = null;
  }

  function wireRoot() {
    var rows = document.getElementById('wm-rows');
    if (rows) {
      rows.addEventListener('pointerdown', function (e) {
        var rowEl = e.target.closest('[data-wm-id]');
        if (!rowEl || e.target.closest('button')) return;
        var id = rowEl.getAttribute('data-wm-id');
        if (openCtx && openCtx.fromPortal && id === activeId()) return;   // 'you are here' refuses
        clearHold();
        hold.rowId = id;
        hold.x = e.clientX; hold.y = e.clientY;
        hold.timer = setTimeout(function () {
          hold.timer = null;
          var rid = hold.rowId;
          hold.rowId = null;
          if (rid) {
            hold.fired = true;   // the following click is the hold's own — swallow it
            openSheet(rid);
          }
        }, HOLD_MS);
      });
      rows.addEventListener('click', function (e) {
        var more = e.target.closest('button[data-wm-more]');
        if (more) {
          e.stopPropagation();
          openSheet(more.getAttribute('data-wm-more'));
          return;
        }
        if (hold.fired) { hold.fired = false; return; }   // the hold just opened the sheet
        var rowEl = e.target.closest('[data-wm-id]');
        if (!rowEl) return;
        var id = rowEl.getAttribute('data-wm-id');
        if (openCtx && openCtx.fromPortal) {
          if (id !== activeId()) doPortalDive(id);
          return;
        }
        doSwitch(id);
      });
    }
    var back = document.getElementById('wm-back');
    if (back) back.addEventListener('click', function () {
      if (visited.length > 1) doSwitch(visited[visited.length - 2]);
    });
    var browse = document.getElementById('wm-browse');
    if (browse) browse.addEventListener('click', doBrowse);
    var create = document.getElementById('wm-create');
    if (create) create.addEventListener('click', function () {
      if (!window.doomalay || !window.doomalay.switchTo) { note('the switch path is unavailable'); return; }
      doCreate();
    });
  }

  // window-level hold tracking (move/cancel kills the hold; the tap
  // only fires when the hold never did)
  window.addEventListener('pointermove', function (e) {
    if (!hold.timer) return;
    var dx = e.clientX - hold.x, dy = e.clientY - hold.y;
    if (dx * dx + dy * dy >= MOVE_PX * MOVE_PX) clearHold();
  }, true);
  window.addEventListener('pointerup', function () {
    if (hold.timer) clearHold();
  }, true);
  window.addEventListener('pointercancel', function () { clearHold(); }, true);

  // ── open ─────────────────────────────────────────────────────────

  function open(opts) {
    opts = opts || {};
    openCtx = (opts.fromPortal && window.Holes) ? { fromPortal: opts.fromPortal } : null;
    seedVisited();
    var ov = window.ConnectOverlay;
    if (!ov) return;
    var page = { onSwap: function () { myPage = true; wireRoot(); refresh(); } };
    if (ov.isOpen()) ov.replaceContent(rootHTML(), page);
    else ov.open(rootHTML(), page);
    // the library check (the browse row's forward-wiring)
    fetch('/api/hub/libraries').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (d) {
      libHasCanvas = !!(d && d.libraries && d.libraries.some(function (l) { return l && l.type === 'canvas'; }));
      var bs = document.getElementById('wm-browse-sub');
      if (bs) bs.textContent = libHasCanvas
        ? 'shared worlds, ready to download'
        : 'canvas worlds join the library with the next wave';
    });
  }

  // ── exports ──────────────────────────────────────────────────────

  window.WorldsManager = {
    open: open,
    nextName: nextName,
    probe: function () {
      return {
        open: !!(myPage && window.ConnectOverlay && window.ConnectOverlay.isOpen()),
        depth: (window.ConnectOverlay && window.ConnectOverlay.pageDepth) ? window.ConnectOverlay.pageDepth() : 0,
        rows: rowsCache.length,
        activeId: activeId(),
        portalMode: !!(openCtx && openCtx.fromPortal),
        visited: visited.slice(),
        hasCanvasLib: libHasCanvas,
        lastError: lastErr
      };
    }
  };
})();
