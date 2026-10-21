// chatbundle.js — v1.54 THE LIBRARY SHIP (PLAN-V154 phase 3): the
// .doomchat container. ONE conversation as a file: manifest.json (format
// 'doomalay-chat') + chats/<sid>.json (session + tweaks + optional folded
// history + asset refs) + assets/<i>.<ext>.
//
// THE OOP LAW: no twin drift — AssetsPublisher + ChatsPublisher run
// VERBATIM against a synthetic ONE-chat worldState (their collect is
// icons-scoped; a one-icon state scopes them to this chat), and the import
// driver reuses their applyImport as-is (assets staged first, the chat's
// birth split + auto-tools-off + preamble-unselected laws all ride).
//
// THE READ LADDER (chat-scoped, the canvasbundle precedent):
//   R1 THE CAPS — per-entry BOTH sizes ≤8MB, total ≤40MB (the chat tier),
//      ≤1024 entries, ratio ≤100:1 (a filtered-out entry is a REJECTION).
//   R2 TRUNCATION — bytes.length === the central directory's originalSize.
//   R3 NAMES — no '..' / leading '/' / '\', depth ≤8.
//   R4 THE WHITELIST — manifest.json, chats/*.json, assets/*, x-* (the
//      forward-compat namespace, ignored). children/*.doomcanvas is
//      REJECTED — a chat is a LEAF (no nesting).
//   R5 THE MANIFEST — format 'doomalay-chat', MAJOR.MINOR, MAJOR ≤1.
//   R6 THE CHAT — every chats/*.json parses; EXACTLY ONE rides (a
//      .doomchat is one conversation — two is a canvas's job).
//   R7 THE DRIVER — assets → chats (dependency order), undo journals,
//      ANY throw reverse-walks (honest 'rolled back' report).
//
// THE LANDING: the caller lands the icon (openChatBySession's materialize
// branch) — importChat only births the session and maps the ids.
//
// Budgets: publish/import are BURSTS; zero per-frame additions. Theme law:
// the sheet's DOM composes var(--…) only.
//
// Exposes: window.ChatBundle = { collect, build, read, importChat,
//   download, openPublishSheet, lastBuilt, probe } (dual-env; the node rig
// imports the module side with io injected).
(function () {
  'use strict';

  var P = (typeof window !== 'undefined') ? window.Publishers
    : (typeof require !== 'undefined' ? require('./publishers.js') : null);
  if (!P) throw new Error('publishers.js must load first');

  var ENTRY_MAX = 8 * 1024 * 1024;        // per entry, BOTH sizes
  var TOTAL_MAX = 40 * 1024 * 1024;       // the chat tier (history 8 + assets 24 + headroom)
  var ENTRIES_MAX = 1024;
  var RATIO_MAX = 100;
  var NAME_SEG_MAX = P.NAME_DEPTH_MAX;

  function ff() {
    if (typeof window !== 'undefined' && window.fflate) return window.fflate;
    if (typeof require !== 'undefined') { try { return require('./vendor/fflate.js'); } catch (e) { return null; } }
    return null;
  }

  function browserIO() {
    // the canvasbundle twin (kept local — the module stands alone)
    function j(method, url, body) {
      var opt = { method: method };
      if (body !== undefined) {
        opt.body = JSON.stringify(body);
        opt.headers = { 'content-type': 'application/json' };
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

  function nameOK(n) {
    if (typeof n !== 'string' || !n.length || n.length > 256) return false;
    if (n.indexOf('..') !== -1 || n.charAt(0) === '/' || n.indexOf('\\') !== -1) return false;
    if (n.split('/').length > NAME_SEG_MAX) return false;
    return true;
  }

  function knownEntry(n) {
    if (n === 'manifest.json') return true;
    if (n.indexOf('x-') === 0) return true;
    if (n.indexOf('chats/') === 0 && n.slice(-5) === '.json') return true;
    if (n.indexOf('assets/') === 0) return true;
    return false;   // children/*.doomcanvas REJECTED — a chat is a leaf
  }

  // ══ THE READ LADDER ══════════════════════════════════════════════
  function read(bytes) {
    var f = ff();
    if (!f || !f.unzipSync) return { ok: false, why: 'the zip reader is unavailable' };
    if (!bytes || !bytes.length || bytes.length > TOTAL_MAX) return { ok: false, why: 'the bundle is empty or over the 40MB cap' };
    var total = 0, count = 0, rejected = false, overRatio = false;
    var sizes = {};
    var files;
    try {
      files = f.unzipSync(bytes, { filter: function (file) {
        count++;
        if (count > ENTRIES_MAX) { rejected = true; return false; }
        if (!nameOK(file.name)) { rejected = true; return false; }
        if (file.size > ENTRY_MAX || file.originalSize > ENTRY_MAX) { rejected = true; return false; }
        if (file.originalSize > Math.max(file.size, 1) * RATIO_MAX) { overRatio = true; rejected = true; return false; }
        total += file.originalSize;
        if (total > TOTAL_MAX) { rejected = true; return false; }
        sizes[file.name] = file.originalSize;
        return true;
      } });
    } catch (e) { return { ok: false, why: 'not a readable zip' }; }
    if (rejected) {
      return { ok: false, why: overRatio
        ? 'an entry inflates past the 100:1 ratio cap (a zip bomb by shape)'
        : 'an entry exceeds the caps (8MB/entry · 40MB total · 1024 entries · name depth)' };
    }
    var names = Object.keys(files);
    if (!names.length) return { ok: false, why: 'the bundle carries nothing' };
    var out = {};
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (!knownEntry(n)) return { ok: false, why: 'unknown entry: ' + n };
      var data = files[n];
      if (data.length !== sizes[n]) {
        return { ok: false, why: 'the entry "' + n + '" is truncated (its bytes do not match its declared size)' };
      }
      if (n.indexOf('assets/') === 0) out[n] = data;
      else {
        try { out[n] = f.strFromU8(data); } catch (e) { return { ok: false, why: 'the entry "' + n + '" is not valid UTF-8' }; }
      }
    }
    var manifest;
    try { manifest = JSON.parse(out['manifest.json']); }
    catch (e) { return { ok: false, why: 'no readable manifest.json' }; }
    if (!manifest || typeof manifest !== 'object') return { ok: false, why: 'the manifest is not an object' };
    if (manifest.format !== 'doomalay-chat') return { ok: false, why: 'not a doomalay chat (format mismatch)' };
    var v = String(manifest.formatVersion || '');
    var m = /^(\d+)\.(\d+)$/.exec(v);
    if (!m) return { ok: false, why: 'the manifest version "' + v + '" is not MAJOR.MINOR' };
    if (parseInt(m[1], 10) > 1) return { ok: false, why: 'the bundle format ' + v + ' is newer than this reader (1.x)' };
    if (typeof manifest.name !== 'string' || manifest.name.length > 256) return { ok: false, why: 'the manifest name is invalid' };
    // R6: every chats/*.json parses + EXACTLY ONE rides
    var chatNames = names.filter(function (n2) { return n2.indexOf('chats/') === 0 && n2.slice(-5) === '.json'; });
    if (chatNames.length !== 1) {
      return { ok: false, why: chatNames.length
        ? 'a .doomchat carries exactly ONE conversation (' + chatNames.length + ' found — that is a canvas\'s job)'
        : 'the bundle carries no chat' };
    }
    try { JSON.parse(out[chatNames[0]]); } catch (e) { return { ok: false, why: chatNames[0] + ' is not valid JSON' }; }
    return { ok: true, files: out, manifest: manifest, sid: chatNames[0].slice(6, -5) };
  }

  // ══ THE BUILD ════════════════════════════════════════════════════
  // collect(picks, chatCtx) — chatCtx = {sid, title} (absent = the
  // CURRENT chat). The publishers run VERBATIM against a synthetic
  // one-chat worldState (the OOP law — their collect is icons-scoped).
  async function collect(picks, chatCtx) {
    var io = (typeof window !== 'undefined') ? browserIO() : null;
    if (!io) throw new Error('collect needs an io (browser or rig-injected)');
    var sid = chatCtx && chatCtx.sid;
    var title = (chatCtx && chatCtx.title) || '';
    if (!sid) {
      var c = (typeof window !== 'undefined' && window.ChatPanel) ? window.ChatPanel.current() : null;
      sid = c && c.state && c.state.sessionId;
      title = (c && c.icon && c.icon.name) || title;
    }
    if (!sid) throw new Error('no conversation to publish — send a message first');
    var health = { version: '' };
    try { health = await io.getJSON('/api/health'); } catch (e) {}
    var ctx = {
      io: io,
      worldState: { icons: [{ id: 'chatbundle', type: 'chat', sessionId: sid, name: title || sid }] },
      canvasName: title || 'a chat', canvasId: '',
      picks: picks || {}, appVersion: health.version || '',
      deps: { IconReg: (typeof window !== 'undefined') ? window.IconReg : null }
    };
    var files = {}, tree = [], requires = [], warnings = [];
    // dependency order: assets (writes ctx.assetIndex) → chats
    var assetsPub = null, chatsPub = null;
    for (var i = 0; i < P.publishers.length; i++) {
      if (P.publishers[i].id === 'assets') assetsPub = P.publishers[i];
      if (P.publishers[i].id === 'chats') chatsPub = P.publishers[i];
    }
    if (!assetsPub || !chatsPub) throw new Error('the publishers are unavailable');
    var ra = await assetsPub.collect(ctx);
    Object.assign(files, ra.files);
    tree = tree.concat(ra.tree);
    (ra.warnings || []).forEach(function (w) { warnings.push(w); });
    var rc = await chatsPub.collect(ctx);
    Object.assign(files, rc.files);
    tree = tree.concat(rc.tree);
    (rc.requires || []).forEach(function (p) { if (requires.indexOf(p) < 0) requires.push(p); });
    (rc.warnings || []).forEach(function (w) { warnings.push(w); });
    var historyBytes = 0;
    var chatName = Object.keys(files).filter(function (n) { return n.indexOf('chats/') === 0; })[0];
    if (chatName) {
      try {
        var body = JSON.parse(files[chatName]);
        historyBytes = body.history ? JSON.stringify(body.history).length : 0;
        if (!title && body.session && body.session.title) title = body.session.title;
      } catch (e) {}
    }
    return {
      files: files, tree: tree, requires: requires, warnings: warnings,
      chatTitle: title || 'a chat', sid: sid, appVersion: ctx.appVersion,
      historyBytes: historyBytes
    };
  }

  // build(collected, picks) → Uint8Array (the .doomchat bytes)
  async function build(collected, picks) {
    var f = ff();
    if (!f || !f.zipSync) throw new Error('the zip writer is unavailable');
    picks = picks || {};
    var files = Object.assign({}, collected.files);
    var chatNames = Object.keys(files).filter(function (n) { return n.indexOf('chats/') === 0 && n.slice(-5) === '.json'; });
    // history off → strip it from the chat body
    if (picks.history === false) {
      chatNames.forEach(function (n) {
        var body = JSON.parse(files[n]);
        delete body.history;
        files[n] = JSON.stringify(body);
      });
    }
    // assets off (or orphaned) → the file + its refs die
    var keepAssets = {};
    chatNames.forEach(function (n) {
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
    var sizes = {}, total = 0;
    Object.keys(files).forEach(function (n) {
      var b = files[n];
      var s = (typeof b === 'string') ? b.length : b.byteLength;
      sizes[n] = s; total += s;
    });
    var manifest = {
      format: 'doomalay-chat',
      formatVersion: '1.0',
      uuid: 'chb_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      appVersion: collected.appVersion || '',
      name: collected.chatTitle || 'a chat',
      author: '',
      contents: {
        chats: Object.keys(files).filter(function (n) { return n.indexOf('chats/') === 0; }).length,
        assets: Object.keys(files).filter(function (n) { return n.indexOf('assets/') === 0; }).length,
        history: picks.history !== false && Object.keys(files).some(function (n) {
          if (n.indexOf('chats/') !== 0) return false;
          try { return !!JSON.parse(files[n]).history; } catch (e) { return false; }
        })
      },
      sizes: { total: total, files: sizes },
      flags: { provenance: 'doomalay-chat', requires: collected.requires || [] }
    };
    files['manifest.json'] = JSON.stringify(manifest);
    var entries = {};
    Object.keys(files).forEach(function (n) {
      entries[n] = (typeof files[n] === 'string') ? f.strToU8(files[n]) : files[n];
    });
    var zip = f.zipSync(entries, { level: 6 });
    lastBuilt = { bytes: zip, manifest: manifest, name: (manifest.name || 'chat') };
    return zip;
  }

  // ══ THE IMPORT DRIVER ════════════════════════════════════════════
  // importChat(bytes, opts) → { ok, nsid?, why?, rolledBack?, created,
  //                            warnings, oldNewSessionMap }
  // The caller lands the icon (openChatBySession's materialize branch).
  async function importChat(bytes, opts) {
    opts = opts || {};
    var verdict = read(bytes);
    if (!verdict.ok) return { ok: false, why: verdict.why, rolledBack: false };
    var files = verdict.files, manifest = verdict.manifest;
    var io = opts.io || ((typeof window !== 'undefined') ? browserIO() : null);
    if (!io) return { ok: false, why: 'no io (browser or rig-injected)', rolledBack: false };
    var ctx = {
      io: io, manifest: manifest, files: files, warnings: [],
      staged: {}, imported: {},
      oldNewSessionMap: {}, oldNewCanvasMap: {},
      depth: 0, budget: TOTAL_MAX,
      deps: { importBundle: null, IconReg: (typeof window !== 'undefined') ? window.IconReg : (opts.IconReg || null) }
    };
    var assetsPub = null, chatsPub = null;
    for (var i = 0; i < P.publishers.length; i++) {
      if (P.publishers[i].id === 'assets') assetsPub = P.publishers[i];
      if (P.publishers[i].id === 'chats') chatsPub = P.publishers[i];
    }
    if (!assetsPub || !chatsPub) return { ok: false, why: 'the publishers are unavailable', rolledBack: false };
    var journals = [], created = {};
    try {
      var ja = await assetsPub.applyImport(ctx);
      journals.push(ja);
      Object.assign(created, ja.created || {});
      var jc = await chatsPub.applyImport(ctx);
      journals.push(jc);
      Object.assign(created, jc.created || {});
    } catch (e) {
      for (var k = journals.length - 1; k >= 0; k--) {
        try { await journals[k].undo(); } catch (e2) {}
      }
      return { ok: false, why: String(e && e.message || e), rolledBack: true, warnings: ctx.warnings };
    }
    var nsid = null;
    Object.keys(ctx.oldNewSessionMap).forEach(function (old) { nsid = ctx.oldNewSessionMap[old]; });
    if (!nsid) return { ok: false, why: 'the chat was not reborn', rolledBack: false, warnings: ctx.warnings };
    // the requires[] warnings (BYOK — provider names only, never keys)
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
    } catch (e) { /* best-effort */ }
    return {
      ok: true, nsid: nsid, created: created, warnings: ctx.warnings,
      oldNewSessionMap: ctx.oldNewSessionMap
    };
  }

  // ── the publish sheet (a PANEL view — the export view's sibling) ──
  // openPublishSheet(panel, chatCtx) — the toggle tree + live size +
  // export + publish-to-library. The worldsmanager sheet's pattern,
  // panel-flavored (the chat panel's own view stack).
  async function openPublishSheet(panel, chatCtx) {
    if (!panel) return;
    var picks = { history: true, assets: {} };
    var collected;
    try { collected = await collect(picks, chatCtx); }
    catch (e) { window.DoomToast(e && e.message ? e.message : 'the chat could not be read'); return; }
    function fmtSize(n) {
      if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + ' MB';
      if (n >= 1024) return (Math.round(n / 102.4) / 10) + ' KB';
      return n + ' B';
    }
    function pickedBytes() {
      var total = 0;
      Object.keys(collected.files).forEach(function (n) {
        if (n.indexOf('assets/') === 0 && picks.assets[n] === false) return;
        if (n.indexOf('chats/') === 0 && picks.history === false && collected.historyBytes) {
          var b = 0;
          try { b = JSON.stringify(JSON.parse(collected.files[n]).session || {}).length; } catch (e) { b = 0; }
          total += b;
          return;
        }
        var v = collected.files[n];
        total += (typeof v === 'string') ? v.length : (v.byteLength || 0);
      });
      return total;
    }
    function sheetView() {
      var rows = (collected.tree || []).map(function row(t) {
        var glyph = t.locked ? '⊛' : (t.on !== false ? '☑' : '☐');
        return '<div data-cb-tg="' + t.id + '" style="display:flex;align-items:center;gap:9px;padding:8px ' + (10 + 0) + 'px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);cursor:' + (t.locked ? 'default' : 'pointer') + ';touch-action:manipulation' + (t.locked ? ';opacity:0.65' : '') + '">' +
          '<span style="width:18px;text-align:center;flex:none;color:var(--text-2)">' + glyph + '</span>' +
          '<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">' +
            '<span style="color:var(--text-1);font-size:var(--ui-small-fs)">' + t.label + (t.locked ? ' <span style="color:var(--text-3)">(always)</span>' : '') + '</span>' +
            '<span style="color:var(--text-3);font-size:var(--ui-tiny-fs)">' + (t.detail || '') + '</span>' +
          '</span></div>' +
          (t.children || []).map(function (c) { return row(c); }).join('');
      }).join('');
      var warnHTML = (collected.warnings || []).slice(0, 4).map(function (w) {
        return '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs)">⚠ ' + w + '</div>';
      }).join('');
      return {
        title: 'publish chat',
        render: function () {
          return '<div style="padding:18px 16px;display:flex;flex-direction:column;gap:10px;max-height:100%;overflow-y:auto">' +
            '<div style="display:flex;flex-direction:column;gap:2px">' +
              '<div style="font-size:var(--ui-large-fs);font-weight:700;color:var(--text-1)">Publish "' + (collected.chatTitle || 'chat') + '"</div>' +
              '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs)">one .doomchat file — the conversation, its look assets and optional history (keys stay home — BYOK)</div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:5px">' + rows + '</div>' +
            '<div id="cb-pub-size" style="color:var(--text-2);font-size:var(--ui-small-fs);font-weight:600"></div>' +
            warnHTML +
            '<button id="cb-pub-export" style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:12px;padding:12px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation">⤓ export .doomchat</button>' +
            '<button id="cb-pub-hub" style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:12px;padding:12px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation">⤒ publish to the library</button>' +
            '<div id="cb-pub-note" style="color:var(--text-3);font-size:var(--ui-tiny-fs)"></div>' +
            '</div>';
        },
        onMount: function (el) {
          function setNote(t) { var n = el.querySelector('#cb-pub-note'); if (n) n.textContent = t || ''; }
          function recompute() {
            var s = el.querySelector('#cb-pub-size');
            if (s) s.textContent = '≈ ' + fmtSize(pickedBytes());
          }
          el.querySelectorAll('[data-cb-tg]').forEach(function (row) {
            row.addEventListener('click', function () {
              var id = row.getAttribute('data-cb-tg');
              var found = null;
              (collected.tree || []).forEach(function walk(t) {
                if (t.id === id) found = t;
                (t.children || []).forEach(walk);
              });
              if (!found || found.locked) return;
              var on = found.on !== false;
              found.on = !on;
              if (found.kind === 'asset') picks.assets[found.file] = !on;
              else if (found.id === 'history') picks.history = !on;
              // the chat group itself is always on (a .doomchat IS one chat)
              if (found.kind === 'chat') { found.on = true; return; }
              row.querySelector('span').textContent = found.on !== false ? '☑' : '☐';
              recompute();
            });
          });
          var ex = el.querySelector('#cb-pub-export');
          if (ex) ex.addEventListener('click', function () {
            setNote('building…');
            build(collected, picks).then(function () {
              download();
              setNote('exported — ' + fmtSize(lastBuilt.bytes.length) + ' written');
              window.DoomToast('chat exported');
            }).catch(function (e) { setNote('export failed — ' + (e && e.message)); });
          });
          var hb = el.querySelector('#cb-pub-hub');
          if (hb) hb.addEventListener('click', function () {
            if (!(window.HubPublish && window.HubPublish.open)) { setNote('the publisher is unavailable'); return; }
            setNote('building…');
            build(collected, picks).then(function () {
              var bytes = lastBuilt.bytes;
              var nAssets = Object.keys(collected.files).filter(function (n) {
                return n.indexOf('assets/') === 0 && picks.assets[n] !== false;
              }).length;
              var parts = [];
              if (collected.historyBytes && picks.history !== false) parts.push('with history');
              else parts.push('no history');
              if (nAssets) parts.push(nAssets + ' asset' + (nAssets === 1 ? '' : 's'));
              parts.push(fmtSize(bytes.length));
              var req = collected.requires || [];
              var tail = req.length ? ' — needs keys: ' + req.join(', ') : '';
              var prefill = {
                name: collected.chatTitle || 'a chat',
                desc: 'a conversation — ' + parts.join(' · ') + tail,
                payloadBlob: bytes,
                payloadLabel: (collected.chatTitle || 'chat') + ' — ' + fmtSize(bytes.length)
              };
              setNote('');
              window.HubPublish.open('chat', prefill);
            }).catch(function (e) { setNote('publish failed — ' + (e && e.message)); });
          });
          recompute();
        }
      };
    }
    panel.pushView(sheetView());
  }

  // ── the browser affordances ───────────────────────────────────────
  var lastBuilt = null;

  function download(nameOverride) {
    if (!lastBuilt) return false;
    var nm = (nameOverride || lastBuilt.name || 'chat') + '.doomchat';
    var url = URL.createObjectURL(new Blob([lastBuilt.bytes], { type: 'application/zip' }));
    var a = document.createElement('a');
    a.href = url; a.download = nm;
    // B1 (no body appenders): the transient anchor rides the panel's own
    // content (the sheet is open by construction).
    var host = (window.ChatPanel && window.ChatPanel.current && window.ChatPanel.current() &&
      window.ChatPanel.current().panel && window.ChatPanel.current().panel.bodyEl) || document.head;
    host.appendChild(a);
    a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 400);
    return true;
  }

  // probe — the rigs' hook (the house law)
  function probe() {
    return {
      version: 'v1.54.3',
      caps: { entry: ENTRY_MAX, total: TOTAL_MAX, entries: ENTRIES_MAX, ratio: RATIO_MAX, nameSegs: NAME_SEG_MAX },
      lastBuilt: lastBuilt ? { name: lastBuilt.name, bytes: lastBuilt.bytes.length, manifest: lastBuilt.manifest } : null
    };
  }

  // ── the exports (dual-env) ────────────────────────────────────────
  var API = {
    collect: collect, build: build, read: read, importChat: importChat,
    download: download, openPublishSheet: openPublishSheet, probe: probe,
    get lastBuilt() { return lastBuilt; },
    _browserIO: browserIO,
    ENTRY_MAX: ENTRY_MAX, TOTAL_MAX: TOTAL_MAX, ENTRIES_MAX: ENTRIES_MAX,
    RATIO_MAX: RATIO_MAX
  };
  if (typeof window !== 'undefined') window.ChatBundle = API;
  else if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
