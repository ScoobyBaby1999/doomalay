// canvasbundle.js — v1.42.8 THE VESSEL (PLAN-V142 §3.5 W5): the
// .doomcanvas container. ONE file carries a world: manifest.json +
// settings.json + iconsets.json + canvas.json + chats/<sid>.json +
// assets/<i>.<ext> + children/<uuid>.doomcanvas (nested worlds).
//
// THE BUILD: publishers.collect (everything ON, one fetch pass) → the
// publish sheet shows the toggle tree + the live size → build(picks)
// FILTERS the collected files (no re-fetch — the preview is the truth).
//
// THE READ LADDER (untrusted-DATA discipline, the lookio precedent
// hardened to the canvas scale — every rung rejects the WHOLE bundle):
//   R1 THE CAPS — fflate's filter sees the CENTRAL DIRECTORY sizes
//      pre-inflation: per-entry BOTH sizes ≤8MB, running total ≤96MB,
//      ≤1024 entries, per-entry ratio ≤100:1. A filtered-out entry is
//      a REJECTION (a bundle hiding a bomb-sized entry is hostile by
//      shape).
//   R2 TRUNCATION — post-inflate, bytes.length === originalSize for
//      every entry (the silent-truncation detector; stored entries
//      copy compressedSize bytes so BOTH sizes were already capped).
//   R3 NAMES — no '..' / leading '/' / '\\', depth ≤8 segments.
//   R4 THE WHITELIST — manifest.json, settings.json, iconsets.json,
//      canvas.json, chats/*.json, assets/*, children/*.doomcanvas,
//      and the x-* forward-compat namespace (ignored — the OCI law:
//      unknown EXTENSIONS are data, unknown SURFACES are attacks).
//   R5 THE MANIFEST — valid JSON, format 'doomalay-canvas',
//      formatVersion MAJOR.MINOR: reject a greater MAJOR, accept any
//      MINOR (a 1.1 bundle opens in a 1.0 reader), ignore unknown
//      FIELDS (forward-compat); uuid/name/author are strings ≤256.
//   R6 THE CHATS — every chats/*.json parses; sessions pass the safe
//      pick whitelist (unknown fields dropped — never trusted).
//   R7 NESTING — children/*.doomcanvas recurse at depth ≤3 (42.zip
//      needs 5; ClamAV allows 10 — the format law is 3), and the
//      child's originalSize is charged to the parent's budget BEFORE
//      the recursion (the recursive 96MB law).
//   R8 THE DRIVER — per-publisher applyImport in dependency order,
//      each writing an undo journal; ANY throw reverse-walks the
//      journals (honest 'rolled back' report); the canvas row is LAST
//      (the cheapest undo is "nothing was born").
//
// BYOK LAW: keys are structurally absent (sessions never carry them);
// the rig asserts no key-shaped field name rides any bundle JSON.
//
// Budgets: publish/import are BURSTS — zero per-frame additions.
// Theme law: data-plane + the sheet's DOM composes var(--…) only.
//
// Exposes: window.CanvasBundle = { collect, build, read, download,
//   pickImport, importBundle, importFromFile, lastBuilt, probe }
// (the node rig imports the module side with io injected).
(function () {
  'use strict';

  var P = (typeof window !== 'undefined') ? window.Publishers
    : (typeof require !== 'undefined' ? require('./publishers.js') : null);
  if (!P) throw new Error('publishers.js must load first');

  // ── the caps (the ladder's law — mirrors the plan's table) ────────
  var ENTRY_MAX = 8 * 1024 * 1024;        // per entry, BOTH sizes
  var TOTAL_MAX = 96 * 1024 * 1024;       // the recursive budget
  var ENTRIES_MAX = 1024;
  var RATIO_MAX = 100;                    // per-entry inflation ratio
  var DEPTH_MAX = 3;                      // nested .doomcanvas levels
  var NAME_SEG_MAX = P.NAME_DEPTH_MAX;    // path segments per name

  var KNOWN_FILES = { 'manifest.json': 1, 'settings.json': 1, 'iconsets.json': 1, 'canvas.json': 1 };

  function ff() {
    if (typeof window !== 'undefined' && window.fflate) return window.fflate;
    if (typeof require !== 'undefined') { try { return require('./vendor/fflate.js'); } catch (e) { return null; } }
    return null;
  }

  function nameOK(n) {
    if (typeof n !== 'string' || !n.length || n.length > 256) return false;
    if (n.indexOf('..') !== -1 || n.charAt(0) === '/' || n.indexOf('\\') !== -1) return false;
    if (n.split('/').length > NAME_SEG_MAX) return false;
    return true;
  }

  function knownEntry(n) {
    if (KNOWN_FILES[n]) return true;
    if (n.indexOf('x-') === 0) return true;              // the forward-compat namespace (ignored)
    if (n.indexOf('chats/') === 0 && n.slice(-5) === '.json') return true;
    if (n.indexOf('assets/') === 0) return true;
    if (n.indexOf('children/') === 0 && n.slice(-11) === '.doomcanvas') return true;
    return false;
  }

  // ── the browser io (the rig injects its own) ──────────────────────
  function browserIO() {
    function j(method, url, body, raw) {
      var opt = { method: method };
      if (body !== undefined) {
        opt.body = raw ? body : JSON.stringify(body);
        if (!raw) opt.headers = { 'content-type': 'application/json' };
      }
      return fetch(url, opt).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j0) {
            var e = new Error(j0.error || (method + ' ' + url + ' → ' + r.status));
            e.status = r.status;
            throw e;
          });
        }
        return r.json();
      });
    }
    return {
      getJSON: function (url) { return j('GET', url); },
      postJSON: function (url, body) { return j('POST', url, body); },
      putJSON: function (url, body) { return j('PUT', url, body); },
      patchJSON: function (url, body) { return j('PATCH', url, body); },
      del: function (url) { return j('DELETE', url); },
      putBytes: function (url, bytes) {
        return fetch(url, { method: 'PUT', body: bytes }).then(function (r) {
          if (!r.ok) throw new Error('PUT ' + url + ' → ' + r.status);
          return {};
        });
      },
      getBytes: function (url) {
        return fetch(url).then(function (r) {
          if (!r.ok) return null;
          return r.arrayBuffer().then(function (b) {
            return { bytes: new Uint8Array(b), mime: (r.headers.get('content-type') || '').split(';')[0] };
          });
        });
      }
    };
  }

  // ══ THE READ LADDER ══════════════════════════════════════════════
  // read(bytes, budget) → { ok, files, manifest } | { ok:false, why }
  // files: { name: string } — JSON entries as strings, assets/children
  // as Uint8Array (the publishers parse what they own).
  function read(bytes, budget) {
    var f = ff();
    if (!f || !f.unzipSync) return { ok: false, why: 'the zip reader is unavailable' };
    if (!bytes || !bytes.length || bytes.length > TOTAL_MAX) return { ok: false, why: 'the bundle is empty or over the 96MB cap' };
    var cap = Math.min(TOTAL_MAX, budget || TOTAL_MAX);
    var total = 0, count = 0, rejected = false, overRatio = false;
    var sizes = {};   // name → the central directory's originalSize (R2's truth)
    var files;
    try {
      files = f.unzipSync(bytes, { filter: function (file) {
        count++;
        if (count > ENTRIES_MAX) { rejected = true; return false; }
        if (!nameOK(file.name)) { rejected = true; return false; }
        if (file.size > ENTRY_MAX || file.originalSize > ENTRY_MAX) { rejected = true; return false; }
        if (file.originalSize > Math.max(file.size, 1) * RATIO_MAX) { overRatio = true; rejected = true; return false; }
        total += file.originalSize;
        if (total > cap) { rejected = true; return false; }
        sizes[file.name] = file.originalSize;
        return true;
      } });
    } catch (e) { return { ok: false, why: 'not a readable zip' }; }
    if (rejected) {
      return { ok: false, why: overRatio
        ? 'an entry inflates past the 100:1 ratio cap (a zip bomb by shape)'
        : 'an entry exceeds the caps (8MB/entry · 96MB total · 1024 entries · name depth)' };
    }
    var names = Object.keys(files);
    if (!names.length) return { ok: false, why: 'the bundle carries nothing' };
    // R2 truncation + R4 the whitelist + the string/bytes split
    var out = {};
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (!knownEntry(n)) return { ok: false, why: 'unknown entry: ' + n };
      var data = files[n];
      if (data.length !== sizes[n]) {
        return { ok: false, why: 'the entry "' + n + '" is truncated (its bytes do not match its declared size)' };
      }
      if (n.slice(-11) === '.doomcanvas') out[n] = data;
      else {
        try { out[n] = f.strFromU8(data); } catch (e) { return { ok: false, why: 'the entry "' + n + '" is not valid UTF-8' }; }
      }
    }
    // R5 the manifest
    var manifest;
    try { manifest = JSON.parse(out['manifest.json']); }
    catch (e) { return { ok: false, why: 'no readable manifest.json' }; }
    if (!manifest || typeof manifest !== 'object') return { ok: false, why: 'the manifest is not an object' };
    if (manifest.format !== 'doomalay-canvas') return { ok: false, why: 'not a doomalay canvas (format mismatch)' };
    var v = String(manifest.formatVersion || '');
    var m = /^(\d+)\.(\d+)$/.exec(v);
    if (!m) return { ok: false, why: 'the manifest version "' + v + '" is not MAJOR.MINOR' };
    if (parseInt(m[1], 10) > 1) return { ok: false, why: 'the bundle format ' + v + ' is newer than this reader (1.x)' };
    if (typeof manifest.name !== 'string' || manifest.name.length > 256) return { ok: false, why: 'the manifest name is invalid' };
    // R6 the chats parse (cheap pre-validation — the publishers
    // re-validate through the safe-pick whitelist at import)
    var chatNames = names.filter(function (n) { return n.indexOf('chats/') === 0 && n.slice(-5) === '.json'; });
    for (var c = 0; c < chatNames.length; c++) {
      try { JSON.parse(out[chatNames[c]]); } catch (e) { return { ok: false, why: chatNames[c] + ' is not valid JSON' }; }
    }
    if (out['canvas.json']) {
      try { JSON.parse(out['canvas.json']); } catch (e) { return { ok: false, why: 'canvas.json is not valid JSON' }; }
    } else return { ok: false, why: 'the bundle carries no canvas.json' };
    return { ok: true, files: out, manifest: manifest };
  }

  // ══ THE BUILD ════════════════════════════════════════════════════
  // collect(picks, worldCtx) → drives the publishers (everything ON)
  // → { files, tree, requires, warnings, canvasName, childBytes, meta }.
  // worldCtx (optional — the publish sheet for a NON-active row): 
  // { state, name, id } from the engine row; absent = the live world.
  // The children/<cid>.doomcanvas zips are built EAGERLY here so the
  // sheet's live size readout is exact (build() reuses them).
  async function collect(picks, worldCtx) {
    var io = (typeof window !== 'undefined') ? browserIO() : null;
    if (!io) throw new Error('collect needs an io (browser or rig-injected)');
    var health = { version: '' };
    try { health = await io.getJSON('/api/health'); } catch (e) {}
    var worldState, canvasName, canvasId;
    if (worldCtx && worldCtx.state) {
      worldState = worldCtx.state;
      canvasName = worldCtx.name || 'a world';
      canvasId = worldCtx.id || '';
    } else {
      worldState = (typeof window !== 'undefined' && window.doomalay && window.doomalay.getWorldStateForExport)
        ? window.doomalay.getWorldStateForExport()
        : null;
      if (!worldState) throw new Error('the world state is unavailable');
      canvasName = (window.Worlds && window.Worlds.active && window.Worlds.active().name) || 'a world';
      canvasId = (window.Worlds && window.Worlds.activeId) ? window.Worlds.activeId() : 'default';
    }
    var ctx = {
      io: io, worldState: worldState, canvasName: canvasName,
      canvasId: canvasId,
      picks: picks || {}, appVersion: health.version || '',
      deps: { IconReg: (typeof window !== 'undefined') ? window.IconReg : null }
    };
    var files = {}, tree = [], requires = [], warnings = [];
    var chatHistoryBytes = {};
    for (var i = 0; i < P.publishers.length; i++) {
      var r = await P.publishers[i].collect(ctx);
      Object.assign(files, r.files);
      tree = tree.concat(r.tree);
      (r.requires || []).forEach(function (p) { if (requires.indexOf(p) < 0) requires.push(p); });
      (r.warnings || []).forEach(function (w) { warnings.push(w); });
    }
    // the per-chat history sizes (the sheet's history toggle math)
    Object.keys(files).forEach(function (n) {
      if (n.indexOf('chats/') !== 0) return;
      try {
        var body = JSON.parse(files[n]);
        chatHistoryBytes[n.slice(6, -5)] = body.history ? JSON.stringify(body.history).length : 0;
      } catch (e) {}
    });
    // the child worlds — built EAGERLY (exact sizes for the sheet)
    var childIds = ctx.childCanvasIds || [];
    var childBytes = {};
    for (var c = 0; c < childIds.length; c++) {
      var cid = childIds[c];
      try {
        var row = await io.getJSON('/api/canvases/' + encodeURIComponent(cid));
        var st = row && row.canvas && row.canvas.state;
        if (!st) continue;
        var nested = await buildWorld(io, st, (row.name || cid), health.version || '', {}, 1);
        files['children/' + cid + '.doomcanvas'] = nested;
        childBytes[cid] = nested.length;
      } catch (e) {
        warnings.push('a linked world could not be read — it will ride as a lost portal');
      }
    }
    return {
      files: files, tree: tree, requires: requires, warnings: warnings,
      canvasName: canvasName, appVersion: ctx.appVersion,
      childBytes: childBytes, chatHistoryBytes: chatHistoryBytes
    };
  }

  // build(collected, picks) → Uint8Array (the .doomcanvas bytes)
  async function build(collected, picks) {
    var f = ff();
    if (!f || !f.zipSync) throw new Error('the zip writer is unavailable');
    picks = picks || {};
    var files = Object.assign({}, collected.files);
    // filter by the picks — no re-fetch (the preview is the truth):
    //  · a chat off → its chats/<sid>.json + its assets die
    //  · history off → strip history from the kept chats
    //  · an asset off (or orphaned) → the file + its refs die
    var keepChats = {};
    var chatNames = Object.keys(files).filter(function (n) { return n.indexOf('chats/') === 0 && n.slice(-5) === '.json'; });
    chatNames.forEach(function (n) {
      var sid = n.slice(6, -5);
      keepChats[sid] = !picks.chats || picks.chats[sid] !== false;
      if (!keepChats[sid]) delete files[n];
    });
    if (picks.history === false) {
      chatNames.forEach(function (n) {
        if (!files[n]) return;
        var body = JSON.parse(files[n]);
        delete body.history;
        files[n] = JSON.stringify(body);
      });
    }
    // the assets: keep only files referenced by kept chats AND picked
    var keepAssets = {};
    chatNames.forEach(function (n) {
      if (!files[n]) return;
      var body = JSON.parse(files[n]);
      var refs = (body.assets || []).filter(function (a) {
        return a && (!picks.assets || picks.assets[a.file] !== false);
      });
      refs.forEach(function (a) { keepAssets[a.file] = true; });
      if (refs.length !== (body.assets || []).length) {
        body.assets = refs;
        files[n] = JSON.stringify(body);
      }
    });
    Object.keys(files).forEach(function (n) {
      if (n.indexOf('assets/') === 0 && !keepAssets[n]) delete files[n];
    });
    // the children: picked only
    if (picks.children) {
      Object.keys(files).forEach(function (n) {
        if (n.indexOf('children/') === 0) {
          var cid = n.slice(9, -11);
          if (picks.children[cid] === false) delete files[n];
        }
      });
    }
    // the nested children: the eager build already stashed them —
    // build() reuses the stashed bytes (no re-fetch, the preview IS
    // the truth); only missing ones (a race) rebuild fresh.
    var childIds = collected.childCanvasIds || Object.keys(collected.childBytes || {}).map(function (cid) { return cid; });
    if (childIds.length) {
      var io2 = (typeof window !== 'undefined') ? browserIO() : null;
      for (var i = 0; i < childIds.length; i++) {
        var cid = childIds[i];
        if (picks.children && picks.children[cid] === false) continue;
        if (files['children/' + cid + '.doomcanvas']) continue;   // the stashed eager build
        var row = await io2.getJSON('/api/canvases/' + encodeURIComponent(cid));
        var st = row && row.canvas && row.canvas.state;
        if (!st) continue;
        files['children/' + cid + '.doomcanvas'] = await buildWorld(io2, st, row.name || cid, collected.appVersion, {}, 1);
      }
    }
    // the manifest — the LAST file (sizes need the final set)
    var sizes = {}, total = 0;
    Object.keys(files).forEach(function (n) {
      var b = files[n];
      var s = (typeof b === 'string') ? b.length : b.byteLength;
      sizes[n] = s; total += s;
    });
    var manifest = {
      format: 'doomalay-canvas',
      formatVersion: '1.0',
      uuid: 'cvb_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      appVersion: collected.appVersion || '',
      name: collected.canvasName || 'a world',
      author: '',
      contents: {
        settings: !!files['settings.json'],
        iconsets: !!files['iconsets.json'],
        canvas: !!files['canvas.json'],
        chats: Object.keys(files).filter(function (n) { return n.indexOf('chats/') === 0; }).length,
        assets: Object.keys(files).filter(function (n) { return n.indexOf('assets/') === 0; }).length,
        children: Object.keys(files).filter(function (n) { return n.indexOf('children/') === 0; }).length
      },
      sizes: { total: total, files: sizes },
      flags: { provenance: 'doomalay-canvas', requires: collected.requires || [] }
    };
    files['manifest.json'] = JSON.stringify(manifest);
    // the zip (strings → u8; assets/children already bytes)
    var entries = {};
    Object.keys(files).forEach(function (n) {
      entries[n] = (typeof files[n] === 'string') ? f.strToU8(files[n]) : files[n];
    });
    var zip = f.zipSync(entries, { level: 6 });
    lastBuilt = { bytes: zip, manifest: manifest, name: (manifest.name || 'world') };
    return zip;
  }

  // buildWorld — the recursive collect for a CHILD canvas (depth ≤3;
  // the parent pays the bytes into its own zip — the budget law rides
  // the read ladder, not the build: a builder can always build).
  async function buildWorld(io, worldState, name, appVersion, picks, depth) {
    if (depth > DEPTH_MAX) throw new Error('nested worlds over depth ' + DEPTH_MAX);
    var ctx = {
      io: io, worldState: worldState, canvasName: name, canvasId: '',
      picks: picks, appVersion: appVersion,
      deps: { IconReg: (typeof window !== 'undefined') ? window.IconReg : null }
    };
    var files = {};
    for (var i = 0; i < P.publishers.length; i++) {
      var r = await P.publishers[i].collect(ctx);
      Object.assign(files, r.files);
    }
    delete files['manifest.json'];
    var manifest = {
      format: 'doomalay-canvas', formatVersion: '1.0',
      uuid: 'cvb_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      createdAt: new Date().toISOString(), appVersion: appVersion || '',
      name: name, author: '',
      contents: {}, sizes: {}, flags: { provenance: 'doomalay-canvas', requires: [] }
    };
    files['manifest.json'] = JSON.stringify(manifest);
    var f = ff();
    var entries = {};
    Object.keys(files).forEach(function (n) {
      entries[n] = (typeof files[n] === 'string') ? f.strToU8(files[n]) : files[n];
    });
    return f.zipSync(entries, { level: 6 });
  }

  // ══ THE IMPORT DRIVER ════════════════════════════════════════════
  // importBundle(bytes, opts) → { ok, canvasId?, why?, rolledBack?,
  //                               created, warnings, oldNewSessionMap,
  //                               oldNewCanvasMap }
  async function importBundle(bytes, opts) {
    opts = opts || {};
    var depth = opts.depth || 0;
    var verdict = read(bytes, opts.budget || TOTAL_MAX);
    if (!verdict.ok) return { ok: false, why: verdict.why, rolledBack: false };
    var files = verdict.files, manifest = verdict.manifest;
    var childNames = Object.keys(files).filter(function (n) { return n.indexOf('children/') === 0; });
    if (depth >= DEPTH_MAX && childNames.length) {
      return { ok: false, why: 'nested worlds over depth ' + DEPTH_MAX, rolledBack: false };
    }
    // the children's bytes charge the budget BEFORE recursion (R7)
    var budget = opts.budget || TOTAL_MAX;
    var charged = 0;
    childNames.forEach(function (n) { charged += files[n].byteLength || files[n].length; });
    var io = opts.io || ((typeof window !== 'undefined') ? browserIO() : null);
    if (!io) return { ok: false, why: 'no io (browser or rig-injected)', rolledBack: false };
    var ctx = {
      io: io, manifest: manifest, files: files, warnings: [],
      staged: {}, imported: {},
      oldNewSessionMap: {}, oldNewCanvasMap: {},
      depth: depth, budget: Math.max(0, budget - charged),
      deps: {
        importBundle: importBundle,
        IconReg: (typeof window !== 'undefined') ? window.IconReg : (opts.IconReg || null)
      }
    };
    var journals = [], tail = null, created = {};
    try {
      for (var i = 0; i < P.publishers.length; i++) {
        var j = await P.publishers[i].applyImport(ctx);
        journals.push(j);
        Object.assign(created, j.created || {});
      }
      tail = await new P.CanvasPublisher().applyImport(ctx);
      journals.push(tail);
      created.canvas = tail.canvasId;
    } catch (e) {
      // R8 the rollback: reverse-walk the undo journals, honest report
      for (var k = journals.length - 1; k >= 0; k--) {
        try { await journals[k].undo(); } catch (e2) {}
      }
      return { ok: false, why: String(e && e.message || e), rolledBack: true, warnings: ctx.warnings };
    }
    // the requires[] warnings (BYOK: provider names only, never keys)
    try {
      if (manifest.flags && Array.isArray(manifest.flags.requires) && manifest.flags.requires.length) {
        var keys = await io.getJSON('/api/keys');
        manifest.flags.requires.forEach(function (prov) {
          var has = false;
          Object.keys(keys || {}).forEach(function (env) {
            if (keys[env] && keys[env].provider === prov && keys[env].has_key) has = true;
          });
          if (!has) ctx.warnings.push('provider "' + prov + '" has no key on this device — connect one to chat');
        });
      }
    } catch (e) { /* the keys check is best-effort */ }
    // the landing: the ONE switchTo + the thumb (browser only; the
    // rig stubs it via opts.quiet). A failed landing is a WARNING — the
    // rows are real; the report stays honest.
    if (!opts.quiet && typeof window !== 'undefined' && window.doomalay && window.doomalay.switchTo) {
      try {
        var res = await window.doomalay.switchTo(tail.canvasId);
        if (res && res.ok && window.doomalay.captureThumb) {
          try { await window.doomalay.captureThumb(); } catch (e2) {}   // the ACTIVE row is the new world now
        }
        if (!res || !res.ok) ctx.warnings.push('landed as a row — the live switch failed (' + ((res && res.error) || '?') + ')');
      } catch (e) { ctx.warnings.push('landed as a row — the live switch failed'); }
    }
    return {
      ok: true, canvasId: tail.canvasId, created: created,
      warnings: ctx.warnings,
      oldNewSessionMap: ctx.oldNewSessionMap,
      oldNewCanvasMap: ctx.oldNewCanvasMap
    };
  }

  // ── the browser affordances ───────────────────────────────────────
  var lastBuilt = null;

  function download(nameOverride) {
    if (!lastBuilt) return false;
    var nm = (nameOverride || lastBuilt.name || 'world') + '.doomcanvas';
    var url = URL.createObjectURL(new Blob([lastBuilt.bytes], { type: 'application/zip' }));
    var a = document.createElement('a');
    a.href = url; a.download = nm;
    // B1 (no body appenders): the transient download anchor rides the
    // SANCTIONED surface (the overlay's content — the publish sheet is
    // open by construction); the head fallback keeps the click working
    // when no overlay is open. Removed the moment the click lands.
    var host = (window.ConnectOverlay && window.ConnectOverlay.getContentEl && window.ConnectOverlay.getContentEl()) || document.head;
    host.appendChild(a);
    a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 400);
    return true;
  }

  function importFromFile(file, opts) {
    return file.arrayBuffer().then(function (b) {
      return importBundle(new Uint8Array(b), opts);
    });
  }

  // probe — the rigs' hook (the house law: every module carries one)
  function probe() {
    return {
      version: 'v1.42.8',
      caps: { entry: ENTRY_MAX, total: TOTAL_MAX, entries: ENTRIES_MAX, ratio: RATIO_MAX, depth: DEPTH_MAX, nameSegs: NAME_SEG_MAX },
      lastBuilt: lastBuilt ? { name: lastBuilt.name, bytes: lastBuilt.bytes.length, manifest: lastBuilt.manifest } : null
    };
  }

  // ── the exports (dual-env) ────────────────────────────────────────
  var API = {
    collect: collect, build: build, read: read, importBundle: importBundle,
    download: download, importFromFile: importFromFile, probe: probe,
    get lastBuilt() { return lastBuilt; },
    _browserIO: browserIO,
    ENTRY_MAX: ENTRY_MAX, TOTAL_MAX: TOTAL_MAX, ENTRIES_MAX: ENTRIES_MAX,
    RATIO_MAX: RATIO_MAX, DEPTH_MAX: DEPTH_MAX
  };
  if (typeof window !== 'undefined') window.CanvasBundle = API;
  else if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
