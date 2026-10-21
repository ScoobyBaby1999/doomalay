// publishers.js — v1.42.8 THE VESSEL (PLAN-V142 §3.5 W5): the bundle
// component publishers. A .doomcanvas is built by OOP publishers, each
// owning ONE namespace of the bundle, collected in DEPENDENCY ORDER:
//
//   assets (10)  → the media bytes, staged FIRST (chats reference them)
//   iconsets (20) → iconsets.json (the registry sets the world's icons use)
//   settings (30) → settings.json (the canvas-scope LOOK slice only)
//   chats (40)   → chats/<sid>.json (session · tweaks · history · asset refs)
//   layout (50)  → canvas.json (camera · family · icons · dots)
//   portals (60) → children/<uuid>.doomcanvas (nested worlds, depth ≤3)
//   — CanvasPublisher (100): the composite — the manifest + the canvas
//     row LAST on import (the cheapest undo is "nothing was born").
//
// THE CONTRACT (every publisher):
//   id / label / order
//   async collect(ctx)    → { files: {name: string|Uint8Array},
//                             tree: [leaves], requires: [providers],
//                             warnings: [strings] }
//   async applyImport(ctx) → { undo: async fn }   (ctx.imported.* staged)
//
// ctx (collect):    { io, worldState, canvasId, canvasName, picks, appVersion }
// ctx (applyImport):{ io, manifest, files, warnings, staged, imported,
//                     oldNewSessionMap, oldNewCanvasMap, depth, budget }
//
// io (injectable, the dual-env law): { getJSON, getBytes, postJSON, putJSON,
//     putBytes, del } — the browser wires real fetch; the node rig wires
//     stubs (publishers are engine-adjacent PURE — no window access
//     except the explicitly injected deps in ctx.deps: IconReg).
//
// SANITIZE LAWS (the plan's will-NOT list, publish side):
//   · keys are STRUCTURALLY ABSENT — sessions/tweaks never carry them
//     (keys live in the AES vault); the rig asserts no key-shaped field
//     name anywhere in the bundle JSON.
//   · hooks_config + tool_allowlist are STRUCTURALLY ABSENT — a bundle
//     never wires code execution surfaces.
//   · auto-tools (web_search, lib_auto, skills_auto, template_auto,
//     termux) are STRUCTURALLY ABSENT — imports land them OFF (R7
//     no-auto-activation).
//   · settings are STRUCTURALLY canvas-scope (the pick list — a bundle
//     never rewrites the device's global look).
//   · BYOK: provider names + model ids ride; requires[] tells the
//     import which keys to warn about (has_key).
//
// Budgets: publish/import are BURSTS — zero per-frame additions, zero
// tick/physics/camera changes. Caps: per-asset 6MB, assets-total 24MB,
// per-chat history 8MB (the 200-turn fold), children recursive budget
// (the parent pays BEFORE recursing), names depth ≤8, nesting ≤3.
//
// Theme law: this file is data-plane — zero colors, zero DOM.
//
// Exposes: window.Publishers = { publishers, CanvasPublisher, pickSession,
//   CANVAS_KEYS, HISTORY_MAX_BYTES, ASSET_MAX_BYTES, ASSETS_TOTAL_MAX,
//   NAME_DEPTH_MAX } (the rig imports the node side).
(function () {
  'use strict';

  // ── the caps (ONE table — canvasbundle's ladder reads the same law) ──
  var HISTORY_MAX_BYTES = 8 * 1024 * 1024;   // per chat, the 200-turn fold
  var HISTORY_FOLD_TURNS = 200;
  var ASSET_MAX_BYTES = 6 * 1024 * 1024;     // per file
  var ASSETS_TOTAL_MAX = 24 * 1024 * 1024;   // per bundle
  var NAME_DEPTH_MAX = 8;                    // path segments per entry name

  // The session fields a bundle carries — the SAFE pick. Everything else
  // (hooks, allowlist, auto-tools, compact state, key-shaped fields) is
  // structurally absent by construction.
  // THE WIRE SHAPE (live-convicted on the real engine): the session GET
  // marshals Go field names (PascalCase — "WebSearch", "ManuallyRenamed")
  // while the POST/PATCH bodies speak snake_case ("web_search"). The
  // map below reads the GET shape and emits the canonical snake shape
  // (what the bundle carries + what the birth/patch bodies accept).
  var SESSION_FIELD_MAP = {
    'Title': 'title', 'ManuallyRenamed': 'manually_renamed',
    'Model': 'model', 'Provider': 'provider', 'Sandbox': 'sandbox',
    'SandboxMode': 'sandbox_mode', 'SandboxRepo': 'sandbox_repo',
    'Effort': 'effort', 'Mode': 'mode', 'DeepResearch': 'deep_research',
    'WebTemplate': 'web_template', 'DeepTemplate': 'deep_template', 'DeepMode': 'deep_mode',
    'JudgeCount': 'judge_count', 'JudgeTemplate': 'judge_template',
    'SlidingWindow': 'sliding_window', 'MaxContext': 'max_context',
    'Routing': 'routing', 'WorkspaceID': 'workspace_id',
    'Persona': 'persona', 'Personas': 'personas', 'Placeholders': 'placeholders',
    'Preambles': 'preambles', 'PhBlocksOff': 'ph_blocks_off', 'BlockOverrides': 'block_overrides'
  };
  // the birth subset (POST /api/sessions accepts these; the persona/
  // preamble family + manually_renamed ride the PATCH — the engine's
  // own create law, live-verified)
  var BIRTH_KEYS = ['title', 'model', 'provider', 'sandbox',
    'sandbox_mode', 'sandbox_repo', 'effort', 'mode', 'deep_research',
    'web_template', 'deep_template', 'deep_mode', 'judge_count',
    'judge_template', 'sliding_window', 'max_context', 'routing', 'workspace_id'];

  function pickSession(sess) {
    var out = {};
    if (!sess || typeof sess !== 'object') return out;
    Object.keys(SESSION_FIELD_MAP).forEach(function (gk) {
      var sk = SESSION_FIELD_MAP[gk];
      var v = sess[gk];
      // the snake twin too (the rig stubs + any future tagged shape)
      if (v === undefined || v === null || v === '') v = sess[sk];
      if (v !== undefined && v !== null && v !== '') out[sk] = v;
    });
    return out;
  }

  // The settings keys a bundle carries — the canvas-scope pick list
  // (the app's CANVAS_SCOPE_KEYS, mirrored here so publishers stay
  // loadable without app.js; app.js pins the parity at boot).
  var CANVAS_KEYS = [
    'theme', 'themeOverrides', 'fmtOverrides', 'chatScheme',
    'gridSize', 'bg', 'lineColor', 'dotColor', 'originColor',
    'hideGridLines', 'hideDots',
    'gridScatter', 'gridSizeVariation', 'gridRotation',
    'dotScatter', 'lineScatter', 'dotSizeVariation', 'lineSizeVariation',
    'dotSizeBias', 'lineSizeBias', 'dotRotation', 'lineRotation',
    'dotAnimate', 'lineAnimate', 'spaceParallax'
  ];

  function pickSettings(slice) {
    var out = {};
    if (!slice || typeof slice !== 'object') return out;
    for (var i = 0; i < CANVAS_KEYS.length; i++) {
      var k = CANVAS_KEYS[i];
      if (slice[k] !== undefined) out[k] = slice[k];
    }
    return out;
  }

  function byteSize(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;               // JSON strings ride UTF-8-ish (ASCII-dominant); the zip caps bound the rest
    if (v.length !== undefined && typeof v !== 'object') return v.length;
    if (v.byteLength !== undefined) return v.byteLength;
    return String(v).length;
  }

  function fileJSON(v) { return JSON.stringify(v); }

  // the media kinds a chat can own — assets/<i>.<ext>, the ext from the mime.
  // (persona badge images are persona-scoped — a follow-up wave's ref
  // shape; they do not ride this phase, an honest recorded limit.)
  var ASSET_KINDS = [
    { kind: 'background', path: 'background' },
    { kind: 'texture', path: 'texture' },
    { kind: 'icon', path: 'icon' }
  ];
  var MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg'
  };

  // ════════════════════════════════════════════════════════════════
  // AssetsPublisher — owns assets/ (the ONE caps owner: per-file +
  // total live here; chats reference the indexes; materializes FIRST)
  // ════════════════════════════════════════════════════════════════
  function AssetsPublisher() {}
  AssetsPublisher.prototype.id = 'assets';
  AssetsPublisher.prototype.label = 'Images & assets';
  AssetsPublisher.prototype.order = 10;

  AssetsPublisher.prototype.collect = async function (ctx) {
    var files = {}, tree = [], warnings = [];
    var index = [];   // {i, sid, kind, mime, bytes}
    var total = 0, i = 0;
    var chats = (ctx.worldState && ctx.worldState.icons) || [];
    for (var c = 0; c < chats.length; c++) {
      var ent = chats[c];
      if (!ent || ent.type !== 'chat' || !ent.sessionId) continue;
      if (ctx.picks && ctx.picks.chats && ctx.picks.chats[ent.sessionId] === false) continue;
      for (var k = 0; k < ASSET_KINDS.length; k++) {
        var ak = ASSET_KINDS[k];
        var res;
        try { res = await ctx.io.getBytes('/api/sessions/' + encodeURIComponent(ent.sessionId) + '/' + ak.path); }
        catch (e) { continue; }
        if (!res || !res.bytes || !res.bytes.length) continue;
        if (res.bytes.length > ASSET_MAX_BYTES) {
          warnings.push('a ' + ak.kind + ' of "' + (ent.name || ent.sessionId) + '" exceeds the 6MB per-asset cap — skipped');
          continue;
        }
        if (total + res.bytes.length > ASSETS_TOTAL_MAX) {
          warnings.push('the assets cap (24MB) filled — later assets skipped');
          break;
        }
        var ext = MIME_EXT[res.mime] || 'bin';
        var name = 'assets/' + (i) + '.' + ext;
        files[name] = res.bytes;
        total += res.bytes.length;
        index.push({ i: i, sid: ent.sessionId, kind: ak.kind, mime: res.mime, bytes: res.bytes.length, file: name });
        tree.push({ id: 'asset:' + i, label: (ent.name || 'chat') + ' · ' + ak.kind, detail: fmtKB(res.bytes.length), on: true, kind: 'asset', file: name });
        i++;
      }
    }
    ctx.assetIndex = index;   // the ChatsPublisher reads this (dependency order)
    return { files: files, tree: tree, requires: [], warnings: warnings, total: total };
  };

  AssetsPublisher.prototype.applyImport = async function (ctx) {
    // materialize FIRST: stage the bytes; validate the caps + mimes.
    var staged = {}, total = 0, names = Object.keys(ctx.files);
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      if (name.indexOf('assets/') !== 0) continue;
      var bytes = ctx.files[name];
      if (!bytes || !bytes.length) throw new Error('asset ' + name + ' is empty');
      if (bytes.length > ASSET_MAX_BYTES) throw new Error('asset ' + name + ' exceeds the 6MB cap');
      total += bytes.length;
      if (total > ASSETS_TOTAL_MAX) throw new Error('the assets exceed the 24MB cap');
      staged[name] = bytes;
    }
    ctx.staged.assets = staged;
    return {
      undo: async function () { /* staging only — nothing engine-side to undo */ },
      created: { assets: Object.keys(staged).length }
    };
  };

  // ════════════════════════════════════════════════════════════════
  // IconsetsPublisher — owns iconsets.json (rides IconReg's own
  // sanitize ladder at import — the v1016-proven tag/attr whitelist)
  // ════════════════════════════════════════════════════════════════
  function IconsetsPublisher() {}
  IconsetsPublisher.prototype.id = 'iconsets';
  IconsetsPublisher.prototype.label = 'Icon sets';
  IconsetsPublisher.prototype.order = 20;

  // iconsetsPayload() — the registry's imported sets + the active pick
  // (the lookio.js v2 precedent: the store rides localStorage under
  // doomalay.iconreg.v1; in the node rig ctx.deps.readIconsets stubs it).
  function iconsetsPayload(ctx) {
    if (ctx.deps && typeof ctx.deps.readIconsets === 'function') {
      return ctx.deps.readIconsets();
    }
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return null;
      var raw = localStorage.getItem('doomalay.iconreg.v1');
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !p.sets || !Object.keys(p.sets).length) return null;
      return { active: p.active || '', sets: p.sets };
    } catch (e) { return null; }
  }

  IconsetsPublisher.prototype.collect = async function (ctx) {
    var files = {}, tree = [], warnings = [];
    var payload = iconsetsPayload(ctx);
    var names = Object.keys((payload && payload.sets) || {});
    if (names.length) {
      files['iconsets.json'] = fileJSON({ active: payload.active || '', sets: payload.sets });
      tree.push({ id: 'iconsets', label: 'Icon sets', detail: names.length + ' set' + (names.length === 1 ? '' : 's'), on: true, kind: 'group' });
    }
    return { files: files, tree: tree, requires: [], warnings: warnings };
  };

  IconsetsPublisher.prototype.applyImport = async function (ctx) {
    var raw = ctx.files['iconsets.json'];
    if (!raw) return { undo: async function () {}, created: { iconsets: 0 } };
    var payload;
    try { payload = JSON.parse(raw); } catch (e) { throw new Error('iconsets.json is not valid JSON'); }
    var reg = ctx.deps && ctx.deps.IconReg;
    if (!reg || typeof reg.importIconify !== 'function') {
      ctx.warnings.push('icon sets skipped — the registry is unavailable');
      return { undo: async function () {}, created: { iconsets: 0 } };
    }
    var added = [];
    var sets = (payload && payload.sets) || {};
    Object.keys(sets).forEach(function (k) {
      var s = sets[k] || {};
      var r = reg.importIconify({ icons: s.icons || {}, width: s.width, height: s.height }, k);
      if (r && r.ok) added.push(r.name);   // the SANITIZED name is the truth
      else ctx.warnings.push('icon set "' + k + '" failed the sanitize ladder — skipped');
    });
    if (payload.active && added.indexOf(payload.active) >= 0 && typeof reg.useSet === 'function') {
      // the active set applies ONLY as the world's look at the tail —
      // never a global device change (the canvas-scope law). The tail
      // materializes the slice; useSet fires through applyWorldState.
      ctx.imported.activeIconset = payload.active;
    }
    return {
      undo: async function () {
        if (typeof reg.removeSet !== 'function') return;
        added.forEach(function (k) { try { reg.removeSet(k); } catch (e) {} });
      },
      created: { iconsets: added.length }
    };
  };

  // ════════════════════════════════════════════════════════════════
  // SettingsPublisher — owns settings.json (structurally canvas-scope)
  // ════════════════════════════════════════════════════════════════
  function SettingsPublisher() {}
  SettingsPublisher.prototype.id = 'settings';
  SettingsPublisher.prototype.label = 'Theme & grid look';
  SettingsPublisher.prototype.order = 30;

  SettingsPublisher.prototype.collect = async function (ctx) {
    var files = {}, tree = [];
    var slice = pickSettings((ctx.worldState && ctx.worldState.settings) || {});
    var n = Object.keys(slice).length;
    if (n) {
      files['settings.json'] = fileJSON(slice);
      tree.push({ id: 'look', label: 'Theme & grid look', detail: n + ' canvas settings', on: true, kind: 'group' });
    }
    return { files: files, tree: tree, requires: [], warnings: [] };
  };

  SettingsPublisher.prototype.applyImport = async function (ctx) {
    var raw = ctx.files['settings.json'];
    if (!raw) { ctx.imported.settings = {}; return { undo: async function () {}, created: {} }; }
    var slice;
    try { slice = JSON.parse(raw); } catch (e) { throw new Error('settings.json is not valid JSON'); }
    ctx.imported.settings = pickSettings(slice);   // the whitelist drops anything foreign
    return { undo: async function () {}, created: { settings: Object.keys(ctx.imported.settings).length } };
  };

  // ════════════════════════════════════════════════════════════════
  // ChatsPublisher — owns chats/<sid>.json (session · tweaks ·
  // history · asset refs); imports land sessions fresh + rebind
  // ════════════════════════════════════════════════════════════════
  function ChatsPublisher() {}
  ChatsPublisher.prototype.id = 'chats';
  ChatsPublisher.prototype.label = 'Chats';
  ChatsPublisher.prototype.order = 40;

  ChatsPublisher.prototype.collect = async function (ctx) {
    var self = this;
    var files = {}, tree = [], warnings = [], requires = [];
    var chats = (ctx.worldState && ctx.worldState.icons) || [];
    var leaves = [];
    for (var c = 0; c < chats.length; c++) {
      var ent = chats[c];
      if (!ent || ent.type !== 'chat' || !ent.sessionId) continue;
      var sid = ent.sessionId;
      var picked = !ctx.picks || !ctx.picks.chats || ctx.picks.chats[sid] !== false;
      var sess = null, tweaks = null, history = null;
      try { sess = await ctx.io.getJSON('/api/sessions/' + encodeURIComponent(sid)); } catch (e) { sess = null; }
      if (!sess) {
        warnings.push('chat "' + (ent.name || sid) + '" has no engine session — its icon rides, history does not');
        leaves.push({ id: 'chat:' + sid, label: ent.name || sid, detail: 'no session', on: picked, kind: 'chat', sid: sid });
        continue;
      }
      try { tweaks = await ctx.io.getJSON('/api/sessions/' + encodeURIComponent(sid) + '/tweaks'); } catch (e) { tweaks = null; }
      var body = {
        session: pickSession(sess),
        tweaks: (tweaks && tweaks.tweaks) || {},
        assets: (ctx.assetIndex || []).filter(function (a) { return a.sid === sid; })
          .map(function (a) { return { kind: a.kind, file: a.file, mime: a.mime }; })
      };
      if (!ctx.picks || ctx.picks.history !== false) {
        try {
          var ex = await ctx.io.getJSON('/api/sessions/' + encodeURIComponent(sid) + '/export.json?latest=' + HISTORY_FOLD_TURNS);
          var evs = (ex && ex.events) || [];
          var slim = evs.map(function (e) { return { seq: (e.seq !== undefined ? e.seq : e.Seq), type: (e.event_type !== undefined ? e.event_type : (e.Type !== undefined ? e.Type : e.type)), text: (e.content !== undefined ? e.content : (e.Text !== undefined ? e.Text : e.text)) }; });
          var hist = { events: slim };
          var hb = JSON.stringify(hist);
          while (hb.length > HISTORY_MAX_BYTES && slim.length > 2) {
            slim = slim.slice(Math.floor(slim.length / 4));   // drop the oldest quarter — honest fold under the cap
            hist = { events: slim };
            hb = JSON.stringify(hist);
          }
          if (slim.length < evs.length) warnings.push('chat "' + (sess.title || sid) + '" history folded to ' + slim.length + ' of ' + evs.length + ' events (the 8MB cap)');
          body.history = hist;
        } catch (e) { /* history is optional — the chat still rides */ }
      }
      if (sess.provider && requires.indexOf(sess.provider) < 0) requires.push(sess.provider);
      files['chats/' + sid + '.json'] = fileJSON(body);
      leaves.push({
        id: 'chat:' + sid, label: sess.title || ent.name || sid,
        detail: (sess.provider || '') + (sess.model ? ' · ' + sess.model : ''),
        on: picked, kind: 'chat', sid: sid
      });
    }
    if (leaves.length) {
      tree.push({ id: 'chats', label: 'Chats', detail: leaves.length + ' chat' + (leaves.length === 1 ? '' : 's'), on: true, kind: 'group', children: leaves });
      if (!ctx.picks || ctx.picks.history !== false) {
        tree.push({ id: 'history', label: 'Chat histories', detail: 'the last ' + HISTORY_FOLD_TURNS + ' turns each', on: true, kind: 'group' });
      }
    }
    return { files: files, tree: tree, requires: requires, warnings: warnings };
  };

  ChatsPublisher.prototype.applyImport = async function (ctx) {
    var created = [];
    var names = Object.keys(ctx.files).filter(function (n) { return n.indexOf('chats/') === 0 && n.slice(-5) === '.json'; })
      .sort();
    for (var i = 0; i < names.length; i++) {
      var body;
      try { body = JSON.parse(ctx.files[names[i]]); } catch (e) { throw new Error(names[i] + ' is not valid JSON'); }
      var oldSid = names[i].slice(6, -5);
      var safe = pickSession(body.session || {});
      // THE BIRTH SPLIT (the engine's own create law): POST accepts the
      // shape subset; the persona/preamble family rides the PATCH after.
      var birth = {};
      BIRTH_KEYS.forEach(function (k) { if (safe[k] !== undefined) birth[k] = safe[k]; });
      // births land the auto-tools OFF (R7) — the create call's own
      // default-on websearch is explicitly refused.
      birth.web_search = false; birth.template_auto = false; birth.skills_auto = false;
      birth.lib_auto = false; birth.termux = false;
      var sess = await ctx.io.postJSON('/api/sessions', birth);
      if (!sess) throw new Error('the engine refused a session birth');
      var nsid = (sess && (sess.ID || sess.id)) || null;
      if (!nsid) throw new Error('the engine refused a session birth (no id)');
      created.push(nsid);
      ctx.oldNewSessionMap[oldSid] = nsid;
      // the PATCH subset (persona · personas · placeholders · preambles ·
      // blocks) — preambles_sel resets to default (never auto-activates)
      var patch = {};
      ['manually_renamed', 'persona', 'personas', 'placeholders', 'preambles', 'ph_blocks_off', 'block_overrides'].forEach(function (k) {
        if (safe[k] !== undefined) patch[k] = safe[k];
      });
      patch.preamble_sel = '';
      // v1.54 THE TRUST LADDER: personas imported from a bundle land
      // INACTIVE — the bundle's claimed mode NEVER survives the border
      // (R7's no-auto-activation law; a malicious "always" is refused).
      // A malformed list never rides (delete → the PATCH skips it).
      if (typeof patch.personas === 'string') {
        try {
          var plist = JSON.parse(patch.personas);
          if (Array.isArray(plist)) {
            plist.forEach(function (p) { if (p && typeof p === 'object') p.mode = 'inactive'; });
            patch.personas = JSON.stringify(plist);
          } else { delete patch.personas; }
        } catch (e) { delete patch.personas; }
      }
      try { if (Object.keys(patch).length > 1) await ctx.io.patchJSON('/api/sessions/' + encodeURIComponent(nsid), patch); }
      catch (e) { ctx.warnings.push('a chat\'s persona/preamble settings were refused — skipped'); }
      if (body.tweaks && Object.keys(body.tweaks).length) {
        try { await ctx.io.putJSON('/api/sessions/' + encodeURIComponent(nsid) + '/tweaks', body.tweaks); }
        catch (e) { ctx.warnings.push('a chat\'s tweaks were refused — skipped'); }
      }
      var assets = body.assets || [];
      for (var a = 0; a < assets.length; a++) {
        var ref = assets[a];
        var bytes = ctx.staged.assets && ctx.staged.assets[ref.file];
        if (!bytes) continue;
        try { await ctx.io.putBytes('/api/sessions/' + encodeURIComponent(nsid) + '/' + ref.kind, bytes); }
        catch (e) { ctx.warnings.push('a chat asset (' + ref.kind + ') was refused — skipped'); }
      }
      if (body.history && Array.isArray(body.history.events) && body.history.events.length) {
        // v1.54 THE HONEST HISTORY: the replay is best-effort POST-BIRTH —
        // each event post + each hide mask degrades to a warning, never a
        // throw (the v1540 rig convicted the old shape: a mid-replay throw
        // escaped before the undo journal existed, leaking the born session).
        // The birth is the commitment; history is cargo.
        var evs = body.history.events;
        var seqMap = {};
        var hides = [];
        for (var v = 0; v < evs.length; v++) {
          var ev = evs[v];
          if (!ev || typeof ev.type !== 'string') continue;
          if (ev.type === 'hide') { hides.push(ev); continue; }
          try {
            var out = await ctx.io.postJSON('/api/sessions/' + encodeURIComponent(nsid) + '/events', { type: ev.type, text: String(ev.text || '') });
            var newSeq = out && (out.Seq !== undefined ? out.Seq : out.seq);
            if (newSeq) seqMap[ev.seq] = newSeq;
          } catch (e) {
            ctx.warnings.push('a history event of "' + (body.session && body.session.title || oldSid) + '" was refused — the replay continues');
          }
        }
        for (var h = 0; h < hides.length; h++) {
          var hv = hides[h];
          var ids = [];
          try { ids = JSON.parse(hv.text || '[]'); } catch (e) { ids = []; }
          if (!Array.isArray(ids)) ids = [];
          var mapped = ids.map(function (oldSeq) { return seqMap[oldSeq]; }).filter(function (s) { return s !== undefined; });
          if (mapped.length) {
            try { await ctx.io.postJSON('/api/sessions/' + encodeURIComponent(nsid) + '/events', { type: 'hide', text: JSON.stringify(mapped) }); }
            catch (e) { /* a lost mask is a cosmetic loss — noted, not fatal */ }
          }
        }
      }
    }
    return {
      undo: async function () {
        for (var i = created.length - 1; i >= 0; i--) {
          try { await ctx.io.del('/api/sessions/' + encodeURIComponent(created[i])); } catch (e) {}
        }
      },
      created: { chats: created.length }
    };
  };

  // ════════════════════════════════════════════════════════════════
  // LayoutPublisher — owns canvas.json (camera · family · icons ·
  // dots); import rebinds icon sessions + hole targets at the tail
  // ════════════════════════════════════════════════════════════════
  function LayoutPublisher() {}
  LayoutPublisher.prototype.id = 'layout';
  LayoutPublisher.prototype.label = 'Layout & camera';
  LayoutPublisher.prototype.order = 50;

  LayoutPublisher.prototype.collect = async function (ctx) {
    var ws = ctx.worldState || {};
    var layout = {
      camera: { offset: ws.offset || { x: 0, y: 0 }, scale: ws.scale || 1 },
      family: ws.currentFamily || '',
      icons: Array.isArray(ws.icons) ? ws.icons : [],
      dots: Array.isArray(ws.dots) ? ws.dots : []
    };
    var files = { 'canvas.json': fileJSON(layout) };
    var tree = [{
      id: 'layout', label: 'Layout & camera',
      detail: layout.icons.length + ' icons · ' + layout.dots.length + ' dots',
      on: true, kind: 'group', locked: true
    }];
    return { files: files, tree: tree, requires: [], warnings: [] };
  };

  LayoutPublisher.prototype.applyImport = async function (ctx) {
    var raw = ctx.files['canvas.json'];
    if (!raw) throw new Error('the bundle carries no canvas.json');
    var layout;
    try { layout = JSON.parse(raw); } catch (e) { throw new Error('canvas.json is not valid JSON'); }
    if (!layout || !Array.isArray(layout.icons)) throw new Error('canvas.json has no icons array');
    ctx.imported.layout = {
      camera: (layout.camera && typeof layout.camera === 'object') ? layout.camera : { offset: { x: 0, y: 0 }, scale: 1 },
      family: typeof layout.family === 'string' ? layout.family : '',
      icons: layout.icons,
      dots: Array.isArray(layout.dots) ? layout.dots : []
    };
    return { undo: async function () {}, created: { icons: layout.icons.length } };
  };

  // ════════════════════════════════════════════════════════════════
  // PortalsPublisher — owns children/<uuid>.doomcanvas (nested
  // worlds, depth ≤3, the parent pays the budget BEFORE recursing)
  // ════════════════════════════════════════════════════════════════
  function PortalsPublisher() {}
  PortalsPublisher.prototype.id = 'portals';
  PortalsPublisher.prototype.label = 'Linked worlds';
  PortalsPublisher.prototype.order = 60;

  PortalsPublisher.prototype.collect = async function (ctx) {
    var files = {}, tree = [], warnings = [];
    var holes = ((ctx.worldState && ctx.worldState.icons) || []).filter(function (e) {
      return e && e.type === 'hole' && e.targetWorldId;
    });
    var seen = {}, leaves = [];
    for (var i = 0; i < holes.length; i++) {
      var cid = holes[i].targetWorldId;
      if (seen[cid]) continue;
      seen[cid] = true;
      var picked = !ctx.picks || !ctx.picks.children || ctx.picks.children[cid] !== false;
      var row = null;
      try { row = await ctx.io.getJSON('/api/canvases/' + encodeURIComponent(cid)); } catch (e) { row = null; }
      if (!row || !row.canvas || !row.canvas.state) {
        warnings.push('a portal target world is missing — it will ride as a lost portal');
        continue;
      }
      leaves.push({
        id: 'child:' + cid, label: row.name || row.canvas.name || cid,
        detail: (row.canvas.state.icons || []).length + ' icons',
        on: picked, kind: 'child', cid: cid
      });
    }
    // the nested build happens in canvasbundle.build (it owns the zip
    // + the recursive budget); the tree + the hole census ride here.
    ctx.childCanvasIds = leaves.map(function (l) { return l.cid; });
    if (leaves.length) {
      tree.push({ id: 'children', label: 'Linked worlds', detail: leaves.length + ' world' + (leaves.length === 1 ? '' : 's') + ' via portals', on: true, kind: 'group', children: leaves });
    }
    return { files: files, tree: tree, requires: [], warnings: warnings, children: leaves };
  };

  PortalsPublisher.prototype.applyImport = async function (ctx) {
    // children/<uuid>.doomcanvas — recursive importBundle (depth-1);
    // the bytes were validated by the ladder; the recursion pays the
    // budget before recursing (the 42.zip law).
    var created = [];
    var names = Object.keys(ctx.files).filter(function (n) { return n.indexOf('children/') === 0 && n.slice(-11) === '.doomcanvas'; });
    if (names.length && typeof ctx.deps.importBundle !== 'function') {
      throw new Error('the bundle carries ' + names.length + ' nested world(s) but the importer is unavailable');
    }
    for (var i = 0; i < names.length; i++) {
      var res = await ctx.deps.importBundle(ctx.files[names[i]], {
        depth: (ctx.depth || 0) + 1, budget: ctx.budget, quiet: true,
        io: ctx.io, IconReg: (ctx.deps && ctx.deps.IconReg) || null   // the child inherits the parent's io (the rig's injected stub)
      });
      if (!res || !res.ok) throw new Error('a nested world failed: ' + ((res && res.why) || 'unknown'));
      created.push(res.canvasId);
      // the child's ORIGINAL id rides the filename (children/<cid>.doomcanvas)
      // — the parent's holes rebind to the REBORN row here (the child's
      // own oldNewCanvasMap joins too, for deeper chains).
      var oldCid = names[i].slice(9, -11);
      if (oldCid && res.canvasId) ctx.oldNewCanvasMap[oldCid] = res.canvasId;
      if (res.oldNewCanvasMap) {
        Object.keys(res.oldNewCanvasMap).forEach(function (k) { ctx.oldNewCanvasMap[k] = res.oldNewCanvasMap[k]; });
      }
      if (res.warnings) res.warnings.forEach(function (w) { ctx.warnings.push(w); });
    }
    return {
      undo: async function () {
        for (var i = created.length - 1; i >= 0; i--) {
          try { await ctx.io.del('/api/canvases/' + encodeURIComponent(created[i])); } catch (e) {}
        }
      },
      created: { children: created.length }
    };
  };

  // ════════════════════════════════════════════════════════════════
  // CanvasPublisher — the COMPOSITE: the manifest + (on import) the
  // canvas row LAST — the cheapest undo is "nothing was born"
  // ════════════════════════════════════════════════════════════════
  function CanvasPublisher() {}
  CanvasPublisher.prototype.id = 'canvas';
  CanvasPublisher.prototype.label = 'The canvas';
  CanvasPublisher.prototype.order = 100;

  CanvasPublisher.prototype.collect = async function (ctx) {
    // the composite's own file: manifest.json — the sizes + requires
    // are filled by canvasbundle.build (it knows the final picks).
    var tree = [{
      id: 'canvas', label: ctx.canvasName || 'This world',
      detail: 'the canvas itself', on: true, kind: 'group', locked: true
    }];
    return { files: {}, tree: tree, requires: [], warnings: [] };
  };

  CanvasPublisher.prototype.applyImport = async function (ctx) {
    // THE TAIL: the row LAST. The state was staged by the publishers
    // (layout + settings); the icon rebinding rides here (the maps
    // exist because chats/portals ran first — the dependency law).
    var layout = ctx.imported.layout;
    var state = {
      offset: (layout.camera && layout.camera.offset) || { x: 0, y: 0 },
      scale: (layout.camera && typeof layout.camera.scale === 'number') ? layout.camera.scale : 1,
      currentFamily: layout.family || '',
      icons: layout.icons.map(function (ic) {
        var c = Object.assign({}, ic);
        if (c.sessionId) {
          var nsid = ctx.oldNewSessionMap[c.sessionId];
          if (nsid) c.sessionId = nsid;
          else { delete c.sessionId; ctx.warnings.push('a chat icon lost its session binding — it will birth a fresh chat on open'); }
        }
        if (c.type === 'hole' && c.targetWorldId) {
          var ncid = ctx.oldNewCanvasMap[c.targetWorldId];
          if (ncid) c.targetWorldId = ncid;
          else { c.lost = true; ctx.warnings.push('a portal lost its target world — it rides as a lost portal'); }
        }
        // the auto-tool caps on the ICON land OFF too (the R7 law —
        // an imported icon never auto-fires tools on first open).
        if (c.caps) {
          c.caps = { termux: false, deepResearch: !!c.caps.deepResearch, webSearch: false, libAuto: false, skillsAuto: false, templateAuto: false };
        }
        return c;
      }),
      dots: layout.dots,
      settings: ctx.imported.settings || {},
      savedAt: Date.now(),
      imported: {
        from: ctx.manifest.name || '', author: ctx.manifest.author || '',
        at: ctx.manifest.createdAt || '', appVersion: ctx.manifest.appVersion || ''
      }
    };
    var name = (ctx.manifest.name || 'imported world') + '';
    var row = await ctx.io.postJSON('/api/canvases', { name: name, state: state });
    var rowId = row && ((row.canvas && (row.canvas.ID || row.canvas.id)) || row.ID || row.id);
    if (!rowId) throw new Error('the engine refused the canvas row');
    ctx.imported.state = state;
    return {
      undo: async function () {
        try { await ctx.io.del('/api/canvases/' + encodeURIComponent(rowId)); } catch (e) {}
      },
      created: { canvas: rowId },
      canvasId: rowId
    };
  };

  // ── the registry (dependency order — the collect/import driver) ──
  var PUBLISHERS = [
    new AssetsPublisher(),
    new IconsetsPublisher(),
    new SettingsPublisher(),
    new ChatsPublisher(),
    new LayoutPublisher(),
    new PortalsPublisher()
  ];

  function fmtKB(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // ── the exports (dual-env) ────────────────────────────────────────
  var API = {
    publishers: PUBLISHERS,
    CanvasPublisher: CanvasPublisher,
    pickSession: pickSession,
    pickSettings: pickSettings,
    CANVAS_KEYS: CANVAS_KEYS,
    SESSION_FIELD_MAP: SESSION_FIELD_MAP,
    HISTORY_MAX_BYTES: HISTORY_MAX_BYTES,
    HISTORY_FOLD_TURNS: HISTORY_FOLD_TURNS,
    ASSET_MAX_BYTES: ASSET_MAX_BYTES,
    ASSETS_TOTAL_MAX: ASSETS_TOTAL_MAX,
    NAME_DEPTH_MAX: NAME_DEPTH_MAX,
    fmtKB: fmtKB
  };
  if (typeof window !== 'undefined') window.Publishers = API;
  else if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
