// canvasespanel.js — v1.42.5 THE SWAP (PLAN-V142 §3.2.5): the Canvases
// manager — the CORE (the full spec — browse-the-library row, downloaded
// canvases, canvas_N defaults — is v1.42.7 THE MANAGER).
//
// THE PANEL LAW: this rides the EXISTING settings panel (registerPage,
// the storagehygiene.js precedent) — no new surface. The rows are the
// engine ledger (GET /api/canvases); every action is the real path:
//   tap row    → window.doomalay.switchTo(id) — the ONE canonical switch
//   + New      → POST (a fresh empty world) + switch to it
//   rename     → PUT {name} (inline edit; engine-side, survives devices)
//   duplicate  → GET state → POST {name copy, state} (stay on current)
//   delete     → the last canvas refuses; deleting the active one
//                switches away first, then deletes
//
// Theme law: zero literal colors — everything composes from var(--…).
// The thumbnail <img> rides the engine's /thumb endpoint (no-store).
//
// Exposes: window.DoomCanvases { refresh, rows } (the rigs + v1.42.7).
(function () {
  'use strict';

  var rowsCache = [];

  function fmtAgo(ts) {
    if (!ts) return '—';
    var ms = Date.now() - (ts > 1e12 ? ts : ts * 1000);   // the row's saved_at is ms; updated_at is s
    var min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    var hrs = Math.round(min / 60);
    if (hrs < 48) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fetchRows() {
    return fetch('/api/canvases').then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; }).then(function (d) {
      rowsCache = (d && d.canvases) || [];
      return rowsCache;
    });
  }

  // ── the page ─────────────────────────────────────────────────────

  function pageRender() {
    setTimeout(fill, 0);
    return '<div style="padding:2px 0 8px">' +
      '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs);padding:2px 2px 8px">' +
        'every canvas is a world — tap one to switch (chats keep running)' +
      '</div>' +
      '<div id="cv-rows">…</div>' +
      '<button id="cv-new" data-action="canvas-new" style="width:100%;margin-top:10px;background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:10px;padding:10px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation">+ New canvas</button>' +
      '<div id="cv-note" style="color:var(--text-3);font-size:var(--ui-tiny-fs);padding:8px 2px"></div>' +
      '<div id="cv-storage" style="color:var(--text-3);font-size:var(--ui-tiny-fs);padding:2px 2px 0"></div>' +
      '</div>';
  }

  function note(txt, html) {
    var el = document.getElementById('cv-note');
    if (!el) return;
    // html mode ONLY for this module's own action chips (the delete
    // confirm) — any caller data must be esc()'d by the caller (the
    // theme law's cousin: never trust a name into markup).
    if (html) el.innerHTML = txt;
    else el.textContent = txt;
  }

  function rowHtml(r, activeId) {
    var isActive = r.id === activeId;
    var thumb = r.has_thumb
      ? '<img src="/api/canvases/' + encodeURIComponent(r.id) + '/thumb" alt="" style="width:44px;height:34px;object-fit:cover;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);flex:none">'
      : '<div style="width:44px;height:34px;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:14px">⊞</div>';
    var name = isActive
      ? '<span style="color:var(--text-1);font-weight:600">' + esc(r.name) + '</span>'
      : '<span style="color:var(--text-1)">' + esc(r.name) + '</span>';
    var badge = isActive
      ? '<span style="color:var(--ok);font-size:var(--ui-tiny-fs);border:1px solid var(--border);border-radius:999px;padding:1px 7px">active</span>'
      : '';
    return '<div data-cv-id="' + esc(r.id) + '" style="display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid var(--border);cursor:pointer;touch-action:manipulation">' +
      thumb +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">' +
        '<div style="display:flex;align-items:center;gap:8px;min-width:0">' + name + badge + '</div>' +
        '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs)">' +
          (r.icon_count || 0) + ' icons · ' + fmtAgo(r.saved_at || r.updated_at) +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:4px;flex:none">' +
        '<button data-cv-act="rename" data-cv-id="' + esc(r.id) + '" title="Rename" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:13px">✎</button>' +
        '<button data-cv-act="dup" data-cv-id="' + esc(r.id) + '" title="Duplicate" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:13px">⧉</button>' +
        '<button data-cv-act="del" data-cv-id="' + esc(r.id) + '" title="Delete" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:13px">✕</button>' +
      '</div>' +
    '</div>';
  }

  function fill() {
    var activeId = (window.Worlds && window.Worlds.activeId) ? window.Worlds.activeId() : 'default';
    fetchRows().then(function (rows) {
      var host = document.getElementById('cv-rows');
      if (!host) return;
      if (rows === null) {
        host.innerHTML = '<div style="color:var(--text-3);font-size:var(--ui-small-fs);padding:10px 2px">the engine is unreachable</div>';
        return;
      }
      if (!rows.length) {
        host.innerHTML = '<div style="color:var(--text-3);font-size:var(--ui-small-fs);padding:10px 2px">no canvases yet</div>';
      } else {
        host.innerHTML = rows.map(function (r) { return rowHtml(r, activeId); }).join('');
      }
      wire();
      // the storage line (best-effort)
      fetch('/api/storage/usage').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (d) {
        var el = document.getElementById('cv-storage');
        if (el && d && d.engine) {
          el.textContent = d.engine.canvases + ' canvas' + (d.engine.canvases === 1 ? '' : 'es') + ' · engine db ' +
            ((d.engine.db_bytes / 1048576).toFixed(1)) + ' MB';
        }
      });
    });
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function wire() {
    var host = document.getElementById('cv-rows');
    if (host && !host.dataset.wired) {
      host.dataset.wired = '1';
      host.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-cv-act]');
        var rowEl = e.target.closest('[data-cv-id]');
        if (!rowEl) return;
        var id = rowEl.getAttribute('data-cv-id');
        if (btn) {
          var act = btn.getAttribute('data-cv-act');
          e.stopPropagation();
          if (act === 'rename') doRename(id);
          else if (act === 'dup') doDuplicate(id);
          else if (act === 'del') doDelete(id);
        } else {
          doSwitch(id);
        }
      });
    }
    var newBtn = document.getElementById('cv-new');
    if (newBtn && !newBtn.dataset.wired) {
      newBtn.dataset.wired = '1';
      newBtn.addEventListener('click', function () { doCreate(); });
    }
  }

  function doSwitch(id) {
    note('switching…');
    if (!(window.doomalay && window.doomalay.switchTo)) { note('the switch path is unavailable'); return; }
    window.doomalay.switchTo(id).then(function (res) {
      if (res && res.ok) { note(res.already ? 'already here' : 'switched'); fill(); }
      else note((res && res.error) || 'the switch failed');
    });
  }

  function doCreate() {
    note('creating…');
    var n = 2;
    rowsCache.forEach(function (r) { if (/^Canvas \d+$/.test(r.name || '')) n = Math.max(n, parseInt(r.name.split(' ')[1], 10) + 1); });
    api('POST', '/api/canvases', { name: 'Canvas ' + n, state: { icons: [], dots: [], savedAt: Date.now(), offset: { x: 0, y: 0 }, scale: 1 } })
      .then(function (d) {
        var id = d && d.canvas && d.canvas.id;
        if (!id) throw new Error('no id');
        note('created — switching…');
        return (window.doomalay && window.doomalay.switchTo) ? window.doomalay.switchTo(id) : { ok: true };
      })
      .then(function (res) { note((res && res.ok) ? 'a new world' : 'created'); fill(); })
      .catch(function (e) { note('create failed — ' + e.message); });
  }

  function doRename(id) {
    var row = rowsCache.find(function (r) { return r.id === id; });
    var current = row ? row.name : '';
    // the inline edit: a one-field prompt-free form in the note line
    var host = document.getElementById('cv-note');
    if (!host) return;
    host.innerHTML = '<form id="cv-rn" style="display:flex;gap:6px;align-items:center">' +
      '<input id="cv-rn-in" value="' + esc(current) + '" maxlength="60" style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--text-1);padding:7px 10px;font-size:var(--ui-small-fs)" />' +
      '<button type="submit" style="background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:8px;padding:7px 12px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer">Save</button>' +
      '<button type="button" id="cv-rn-x" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:var(--ui-small-fs);cursor:pointer">✕</button>' +
      '</form>';
    var input = document.getElementById('cv-rn-in');
    if (input) { input.focus(); input.select(); }
    var form = document.getElementById('cv-rn');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = (input.value || '').trim();
      if (!v) { note('a name, please'); return; }
      api('PUT', '/api/canvases/' + encodeURIComponent(id), { name: v })
        .then(function () { note('renamed'); fill(); })
        .catch(function (err) { note('rename failed — ' + err.message); });
    });
    document.getElementById('cv-rn-x').addEventListener('click', function () { note(''); });
  }

  function doDuplicate(id) {
    note('duplicating…');
    var src = rowsCache.find(function (r) { return r.id === id; });
    fetch('/api/canvases/' + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var st = d && d.canvas && d.canvas.state;
        if (!st) throw new Error('the source has no state');
        var name = ((src && src.name) || 'Canvas') + ' copy';
        return api('POST', '/api/canvases', { name: name, state: st });
      })
      .then(function () { note('duplicated'); fill(); })
      .catch(function (e) { note('duplicate failed — ' + e.message); });
  }

  function doDelete(id) {
    var activeId = (window.Worlds && window.Worlds.activeId) ? window.Worlds.activeId() : 'default';
    if (rowsCache.length <= 1) { note('the last canvas stays — the app needs a world'); return; }
    var row = rowsCache.find(function (r) { return r.id === id; });
    note('delete "' + esc((row && row.name) || id) + '"? ' +
      '<button id="cv-del-y" style="background:rgba(var(--warn-rgb),0.14);color:var(--text-1);border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-size:var(--ui-tiny-fs);cursor:pointer">delete it</button>', true);
    var y = document.getElementById('cv-del-y');
    if (!y) return;
    y.addEventListener('click', function () {
      var after = function () {
        api('DELETE', '/api/canvases/' + encodeURIComponent(id))
          .then(function () { note('deleted'); fill(); })
          .catch(function (e) { note('delete failed — ' + e.message); });
      };
      if (id === activeId) {
        // deleting the ACTIVE world: switch away first (the plan's law —
        // exactly one world is ever live), then delete the frozen row.
        var other = rowsCache.find(function (r) { return r.id !== id; });
        note('switching away…');
        window.doomalay.switchTo(other.id).then(function (res) {
          if (res && res.ok) after();
          else note((res && res.error) || 'could not switch away — nothing deleted');
        });
      } else after();
    });
  }

  // ── boot ──────────────────────────────────────────────────────────

  function boot() {
    if (window.Settings && window.Settings.registerPage) {
      window.Settings.registerPage('canvases', {
        title: 'Canvases',
        icon: '⊞',
        render: pageRender
      });
    }
    // a switch elsewhere (portals, v1.42.6) refreshes an open page
    window.addEventListener('doomalay:world-switched', function () {
      if (document.getElementById('cv-rows')) fill();
    });
  }

  if (typeof window !== 'undefined') {
    window.DoomCanvases = { refresh: fill, rows: function () { return rowsCache.slice(); } };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else boot();
  }
})();
