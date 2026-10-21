#!/usr/bin/env node
// v1428-vessel-rig.mjs — v1.42.8 THE VESSEL redteam, PURE-CORE phase
// (the node-required publishers.js + canvasbundle.js; the LIVE phase
// rides v1428-vessel-walk.mjs):
//
//   A1  THE CONTRACT: six publishers in dependency order (assets →
//       iconsets → settings → chats → layout → portals), each carrying
//       collect + applyImport
//   A2  THE SAFE PICK: pickSession drops the poison (hooks_config,
//       tool_allowlist, the auto-tools, compact state) and keeps the
//       safe; pickSettings whitelists (a foreign key dies)
//   A3  THE LADDER — bomb (both sizes), ratio (100:1), traversal,
//       name depth, unknown entries, version (2.0 rejected · 1.1
//       accepted · unknown manifest fields ignored · x-* namespace
//       rides), wrong format, entry count, truncation (a patched
//       central directory lies about a size → rejected)
//   A4  THE IMPORT E2E (io stubs): sessions reborn fresh, events in
//       order, hide masks TRANSLATED, assets materialized, the canvas
//       row LAST, icon rebind + hole retarget, requires[] warns on a
//       missing key
//   A5  BYOK: no key-shaped field name rides any bundle JSON
//   A6  THE ROLLBACK: a mid-driver throw reverse-walks the journals —
//       the created session dies, no canvas row was born
//   A7  THE CAPS: a >6MB asset skipped with the warning; the history
//       fold keeps a chat under 8MB
'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'engine/internal/server/web');
const P = require(path.join(WB(WEB), 'publishers.js'));
const CB = require(path.join(WB(WEB), 'canvasbundle.js'));
const ff = require(path.join(WEB, 'vendor/fflate.js'));
function WB(w) { return w; }   // (path.join is already absolute)

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 260) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function J(v) { return JSON.stringify(v); }

// ── a bundle builder helper (the ladder probes feed it) ────────────
function zipOf(files) {
  const entries = {};
  Object.keys(files).forEach((k) => {
    entries[k] = (typeof files[k] === 'string') ? ff.strToU8(files[k]) : files[k];
  });
  return ff.zipSync(entries, { level: 6 });
}
function manifest(extra) {
  return Object.assign({
    format: 'doomalay-canvas', formatVersion: '1.0', uuid: 'u1',
    createdAt: '2026-10-21T00:00:00Z', appVersion: 'test', name: 'rig world',
    author: '', contents: {}, sizes: {}, flags: { provenance: 'doomalay-canvas', requires: [] }
  }, extra || {});
}
function canvasOf(icons) {
  return J({ camera: { offset: { x: 0, y: 0 }, scale: 1 }, family: '', icons: icons || [], dots: [] });
}

// patch the CENTRAL DIRECTORY's uncompressed size for a named entry
// (the truncation probe's lying zip).
function patchCDSize(zip, name, newSize) {
  const z = new Uint8Array(zip);
  for (let i = 0; i < z.length - 46; i++) {
    if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 0x01 && z[i + 3] === 0x02) {
      const nameLen = z[i + 28] | (z[i + 29] << 8);
      const nm = ff.strFromU8(z.slice(i + 46, i + 46 + nameLen));
      if (nm === name) {
        const dv = new DataView(z.buffer);
        dv.setUint32(i + 24, newSize, true);
        return z;
      }
    }
  }
  return null;
}

// ── the io stub: an in-memory engine with the REAL endpoint semantics ──
function stubIO(seed) {
  const S = {
    sessions: Object.assign({}, (seed && seed.sessions) || {}),
    events: Object.assign({}, (seed && seed.events) || {}),
    tweaks: Object.assign({}, (seed && seed.tweaks) || {}),
    media: Object.assign({}, (seed && seed.media) || {}),
    canvases: Object.assign({}, (seed && seed.canvases) || {}),
    keys: Object.assign({}, (seed && seed.keys) || {}),
    deleted: [], canvasDeleted: [],
    failOn: (seed && seed.failOn) || null   // 'session2' — the rollback probe
  };
  let sessionBirths = 0;
  // the REAL wire shapes (live-convicted on the engine): the session
  // GET/POST-response marshals PascalCase Go names; bodies are snake;
  // events ride event_type/content; canvases answer {canvas:{id}}.
  const pascalOf = (body, id) => ({
    ID: id, Title: body.title || 'New Chat', Model: body.model || '', Provider: body.provider || '',
    Sandbox: body.sandbox || 'quick', Effort: body.effort || 'med', Mode: body.mode || 'auto',
    WebSearch: body.web_search !== undefined ? body.web_search : true,
    DeepResearch: !!body.deep_research, WebTemplate: body.web_template || '', DeepTemplate: body.deep_template || '',
    DeepMode: body.deep_mode || '', JudgeCount: body.judge_count || 3, JudgeTemplate: body.judge_template || 'critique',
    SlidingWindow: body.sliding_window || 40, MaxContext: body.max_context || 128000,
    ToolAllowlist: '', HooksConfig: '', Routing: body.routing || '', WorkspaceID: body.workspace_id || '',
    Persona: body.persona || '', Personas: body.personas || '', Placeholders: body.placeholders || '',
    Preambles: body.preambles || '', PreambleSel: '', PhBlocksOff: !!body.ph_blocks_off,
    BlockOverrides: body.block_overrides || '', ManuallyRenamed: !!body.manually_renamed,
    TemplateAuto: !!body.template_auto, SkillsAuto: !!body.skills_auto, LibAuto: !!body.lib_auto, Termux: !!body.termux
  });
  const snakeToPascalPatch = (rec, patch) => {
    const map = { manually_renamed: 'ManuallyRenamed', persona: 'Persona', personas: 'Personas', placeholders: 'Placeholders', preambles: 'Preambles', preamble_sel: 'PreambleSel', ph_blocks_off: 'PhBlocksOff', block_overrides: 'BlockOverrides' };
    Object.keys(patch || {}).forEach((k) => { if (map[k]) rec[map[k]] = patch[k]; });
    return rec;
  };
  const io = {
    _S: S,
    getJSON: async (url) => {
      if (url === '/api/health') return { status: 'ok', version: 'stub-1.0' };
      if (url === '/api/keys') return S.keys;
      let m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m) { if (!S.sessions[m[1]]) throw new Error('404'); return S.sessions[m[1]]; }
      m = /^\/api\/sessions\/([^/]+)\/tweaks$/.exec(url);
      if (m) return { tweaks: S.tweaks[m[1]] || {} };
      m = /^\/api\/sessions\/([^/]+)\/export\.json/.exec(url);
      if (m) {
        return { session: S.sessions[m[1]] || {}, events: (S.events[m[1]] || []).map((e, i) => ({ seq: i + 1, event_type: e.type, content: e.text })) };
      }
      m = /^\/api\/canvases\/([^/]+)$/.exec(url);
      if (m) {
        const row = S.canvases[m[1]];
        if (!row) throw new Error('404');
        return { name: row.name, canvas: { id: m[1], state: row.state } };
      }
      throw new Error('stub getJSON: ' + url);
    },
    getBytes: async (url) => {
      const m = /^\/api\/sessions\/([^/]+)\/(background|texture|icon)$/.exec(url);
      if (!m) return null;
      const b = S.media[m[1] + ':' + m[2]];
      return b ? { bytes: b, mime: 'image/png' } : null;
    },
    postJSON: async (url, body) => {
      if (url === '/api/sessions') {
        sessionBirths++;
        if (S.failOn === 'session' + sessionBirths) throw new Error('the engine refused (rollback probe)');
        const id = 'ns' + sessionBirths + '_' + Math.random().toString(36).slice(2, 6);
        S.sessions[id] = pascalOf(body, id);
        return S.sessions[id];
      }
      let m = /^\/api\/sessions\/([^/]+)\/events$/.exec(url);
      if (m) {
        const evs = S.events[m[1]] = S.events[m[1]] || [];
        evs.push({ seq: evs.length + 1, type: body.type, text: body.text });
        return { seq: evs.length, event_type: body.type, content: body.text };
      }
      m = /^\/api\/canvases$/.exec(url);
      if (m) {
        const id = 'ncv' + Object.keys(S.canvases).length + '_' + Math.random().toString(36).slice(2, 6);
        S.canvases[id] = { name: body.name, state: body.state };
        S.canvasOrder = (S.canvasOrder || []).concat(id);
        return { canvas: { id, name: body.name, state: body.state } };
      }
      throw new Error('stub postJSON: ' + url);
    },
    patchJSON: async (url, body) => {
      const m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m && S.sessions[m[1]]) { snakeToPascalPatch(S.sessions[m[1]], body); return S.sessions[m[1]]; }
      throw new Error('stub patchJSON: ' + url);
    },
    putJSON: async (url, body) => {
      let m = /^\/api\/sessions\/([^/]+)\/tweaks$/.exec(url);
      if (m) { S.tweaks[m[1]] = body; return {}; }
      throw new Error('stub putJSON: ' + url);
    },
    putBytes: async (url, bytes) => {
      const m = /^\/api\/sessions\/([^/]+)\/(background|texture|icon)$/.exec(url);
      if (m) { S.media[m[1] + ':' + m[2]] = bytes; return {}; }
      throw new Error('stub putBytes: ' + url);
    },
    del: async (url) => {
      let m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m) { delete S.sessions[m[1]]; delete S.events[m[1]]; S.deleted.push(m[1]); return {}; }
      m = /^\/api\/canvases\/([^/]+)$/.exec(url);
      if (m) { delete S.canvases[m[1]]; S.canvasDeleted.push(m[1]); return {}; }
      throw new Error('stub del: ' + url);
    }
  };
  return io;
}

// a world with: 2 chat icons (sessions + history + one asset), a hole
// targeting a child canvas, canvas-scope settings
function seedWorld() {
  const childState = {
    offset: { x: 0, y: 0 }, scale: 1, currentFamily: '',
    icons: [{ id: 'ci1', type: 'chat', x: 10, y: 10, name: 'child chat', sessionId: 'sOld2', model: 'm2', provider: 'nvidia' }],
    dots: [], settings: { theme: 'paper' }
  };
  return {
    sessions: {
      sOld1: { ID: 'sOld1', Title: 'Aster', Model: 'glm-5.3', Provider: 'opencode', Sandbox: 'quick', Effort: 'high', Mode: 'auto', Persona: 'be terse', WebSearch: true, HooksConfig: '{"x":1}', ToolAllowlist: 'sketchy', CompactSummary: 'old', ManuallyRenamed: true },
      sOld2: { ID: 'sOld2', Title: 'Betafence', Model: 'minimax-m3', Provider: 'nvidia', Sandbox: 'quick' }
    },
    events: {
      sOld1: [
        { type: 'user', text: 'hello world' },
        { type: 'assistant', text: 'hi there' },
        { type: 'hide', text: '[1]' },
        { type: 'user', text: 'second' },
        { type: 'assistant', text: 'second answer' }
      ],
      sOld2: [{ type: 'user', text: 'child turn' }]
    },
    tweaks: { sOld1: { bubbleStyle: 'soft' } },
    media: { 'sOld1:background': new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]) },
    canvases: { wChild: { name: 'The Child', state: childState } },
    keys: { OPENCODE_API_KEY: { provider: 'opencode', env_var: 'OPENCODE_API_KEY', has_key: true } }
  };
}
function parentWorldState() {
  return {
    offset: { x: 12, y: 34 }, scale: 1.4, currentFamily: 'anthropic',
    icons: [
      { id: 'i1', type: 'chat', x: 100, y: 100, name: 'Aster', sessionId: 'sOld1', model: 'glm-5.3', provider: 'opencode', caps: { termux: true, webSearch: true, deepResearch: false } },
      { id: 'h1', type: 'hole', x: 300, y: 200, targetWorldId: 'wChild', pairId: 'p1', label: 'to child' }
    ],
    dots: [{ id: 'd1', icons: ['i1'] }],
    settings: { theme: 'midnight', gridSize: 44, EVIL_FOREIGN_KEY: 'nope' }
  };
}

// the collect ctx (the browser's collect() uses window.doomalay — the
// rig drives the publishers DIRECTLY with the same ctx shape)
function collectCtx(io, worldState) {
  return {
    io, worldState, canvasName: 'The Parent', canvasId: 'wParent',
    picks: {}, appVersion: 'stub-1.0',
    deps: { IconReg: null, readIconsets: () => null }
  };
}

(async () => {
  console.log('v1428-vessel-rig — THE VESSEL (pure core: publishers + the ladder + the driver)');

  // ── A1 the contract ───────────────────────────────────────────────
  console.log('\nA1 THE CONTRACT');
  const ids = P.publishers.map((p) => p.id);
  ok('six publishers in dependency order', J(ids) === J(['assets', 'iconsets', 'settings', 'chats', 'layout', 'portals']), J(ids));
  ok('every publisher carries collect + applyImport', P.publishers.every((p) => typeof p.collect === 'function' && typeof p.applyImport === 'function'));
  ok('the composite exists and orders LAST', P.CanvasPublisher.prototype.order === 100);

  // ── A2 the safe pick ──────────────────────────────────────────────
  console.log('\nA2 THE SAFE PICK');
  const poison = { id: 'x', title: 'T', model: 'm', provider: 'p', sandbox: 'quick',
    hooks_config: '{"tools":["evil"]}', tool_allowlist: 'nope', web_search: true,
    lib_auto: true, skills_auto: true, template_auto: true, termux: true,
    compact_summary: 'stale', compact_seq: 42, persona: 'terse', personas: '[]' };
  const picked = P.pickSession(poison);
  ok('pickSession keeps the safe', picked.title === 'T' && picked.model === 'm' && picked.persona === 'terse');
  ok('pickSession drops hooks + allowlist + compact', picked.hooks_config === undefined && picked.tool_allowlist === undefined && picked.compact_summary === undefined && picked.compact_seq === undefined);
  ok('pickSession drops every auto-tool', ['web_search', 'lib_auto', 'skills_auto', 'template_auto', 'termux'].every((k) => picked[k] === undefined));
  const spicked = P.pickSettings({ theme: 'paper', gridSize: 40, deviceGlobal: 'nope', EVIL: 1 });
  ok('pickSettings whitelists the canvas-scope keys only', spicked.theme === 'paper' && spicked.gridSize === 40 && spicked.deviceGlobal === undefined && spicked.EVIL === undefined);
  ok('CANVAS_KEYS parity with the plan list (25 keys)', P.CANVAS_KEYS.length === 25, P.CANVAS_KEYS.length);

  // ── A3 the ladder ─────────────────────────────────────────────────
  console.log('\nA3 THE LADDER (the 8 rungs)');
  // R1 bomb — an entry over 8MB (originalSize AND size both capped)
  const bomb = zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), 'assets/0.bin': new Uint8Array(9 * 1024 * 1024) });
  let v = CB.read(bomb);
  ok('R1 a >8MB entry rejects (the bomb dies pre-inflation)', !v.ok && /caps/.test(v.why), v.why);
  // R1b ratio — 2MB of zeros (compresses ~2000:1) → the ratio rung
  const ratio = zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), 'assets/0.bin': new Uint8Array(2 * 1024 * 1024) });
  v = CB.read(ratio);
  ok('R1b a 100:1+ inflation ratio rejects', !v.ok && /ratio/.test(v.why), v.why);
  // R3 traversal + depth
  v = CB.read(zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), '../evil.json': 'x' }));
  ok('R3 a ../ name rejects', !v.ok && /caps|trunc|name/i.test(v.why), v.why);
  v = CB.read(zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), 'a/b/c/d/e/f/g/h/i.json': 'x' }));
  ok('R3b a 9-deep name rejects (depth ≤8)', !v.ok, v.why);
  // R4 the whitelist
  v = CB.read(zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), 'evil.exe': 'nope' }));
  ok('R4 an unknown entry rejects', !v.ok && /unknown entry/.test(v.why), v.why);
  v = CB.read(zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), 'x-future-thing': 'ignored' }));
  ok('R4b the x-* forward-compat namespace rides (ignored)', v.ok, v.why);
  // R5 the manifest
  v = CB.read(zipOf({ 'manifest.json': J(manifest({ format: 'doomalay-theme' })), 'canvas.json': canvasOf() }));
  ok('R5 a foreign format rejects', !v.ok && /format/.test(v.why), v.why);
  v = CB.read(zipOf({ 'manifest.json': J(manifest({ formatVersion: '2.0' })), 'canvas.json': canvasOf() }));
  ok('R5b a greater MAJOR rejects', !v.ok && /newer/.test(v.why), v.why);
  v = CB.read(zipOf({ 'manifest.json': J(manifest({ formatVersion: '1.1', someFutureField: { x: 1 } })), 'canvas.json': canvasOf() }));
  ok('R5c a greater MINOR accepts + unknown fields ignore', v.ok, v.why);
  v = CB.read(zipOf({ 'manifest.json': 'not json', 'canvas.json': canvasOf() }));
  ok('R5d a broken manifest rejects', !v.ok && /manifest/.test(v.why), v.why);
  // missing canvas.json
  v = CB.read(zipOf({ 'manifest.json': J(manifest()) }));
  ok('R5e a bundle without canvas.json rejects', !v.ok && /canvas\.json/.test(v.why), v.why);
  // entry count
  const many = { 'manifest.json': J(manifest()), 'canvas.json': canvasOf() };
  for (let i = 0; i < 1025; i++) many['assets/' + i + '.bin'] = new Uint8Array([i & 255]);
  v = CB.read(zipOf(many));
  ok('R1c over 1024 entries rejects', !v.ok && /caps|entries/.test(v.why), v.why);
  // R2 truncation — patch the CD's declared size UP modestly (declared
  // > the real stream, under the ratio cap): fflate inflates the honest
  // bytes, the post-inflate length check fires (data.length !== declared
  // = a lying entry). (The declared-DOWN shape amputates to the declared
  // size and dies at the JSON-parse / image-sniff rungs instead — both
  // shapes reject, by different honest rungs.)
  const honest = zipOf({ 'manifest.json': J(manifest()), 'canvas.json': canvasOf(), 'settings.json': J({ theme: 'paper' }) });
  const lying = patchCDSize(honest, 'settings.json', 40);
  v = CB.read(lying);
  ok('R2 a lying declared size rejects (truncation detector)', !v.ok && /truncated/.test(v.why), v.why);
  v = CB.read(honest);
  ok('R2b the honest twin passes', v.ok, v.why);
  // garbage
  v = CB.read(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  ok('garbage bytes reject honestly', !v.ok && /readable zip/.test(v.why), v.why);

  // ── A4 the import E2E (io stubs) ──────────────────────────────────
  console.log('\nA4 THE IMPORT E2E (the driver, io-stubbed)');
  // collect from the seeded world
  const srcIO = stubIO(seedWorld());
  const ctx = collectCtx(srcIO, parentWorldState());
  const files = {};
  for (const pub of P.publishers) {
    const r = await pub.collect(ctx);
    Object.assign(files, r.files);
  }
  ok('collect gathered canvas.json + settings.json + 1 chat + 1 asset (the child rides the nested build)',
    !!files['canvas.json'] && !!files['settings.json'] && !!files['chats/sOld1.json'] && !!files['assets/0.png'] && !files['children/wChild.doomcanvas'],
    J(Object.keys(files)));
  ok('the settings file is the whitelisted slice (no foreign keys)', (function () { const s = JSON.parse(files['settings.json']); return s.theme === 'midnight' && s.gridSize === 44 && s.EVIL_FOREIGN_KEY === undefined; })());
  const c1 = JSON.parse(files['chats/sOld1.json']);
  ok('the chat carries the safe session + tweaks + history + asset ref',
    c1.session.model === 'glm-5.3' && c1.session.hooks_config === undefined && c1.session.web_search === undefined &&
    c1.tweaks.bubbleStyle === 'soft' && c1.history.events.length === 5 && c1.assets.length === 1,
    J(Object.keys(c1)) + ' hist=' + (c1.history ? c1.history.events.length : 'none'));
  ok('the hole targets the child (the tree carries it)', (ctx.childCanvasIds || []).indexOf('wChild') >= 0);
  // build the bundle (with the child zip — the walk's build path; here
  // the manual manifest mirrors it)
  const mf = { format: 'doomalay-canvas', formatVersion: '1.0', uuid: 'u1', createdAt: 'now', appVersion: 'stub', name: 'The Parent', author: 'rig', contents: {}, sizes: {}, flags: { provenance: 'doomalay-canvas', requires: ['opencode', 'nvidia'] } };
  const bundleFiles = Object.assign({}, files, { 'manifest.json': J(mf) });
  // (the child canvas rides as a nested bundle — build it via the same path)
  const childIO = stubIO(seedWorld());
  const childCtx = collectCtx(childIO, seedWorld().canvases.wChild.state);
  const childFiles = {};
  for (const pub of P.publishers) {
    const r = await pub.collect(childCtx);
    Object.assign(childFiles, r.files);
  }
  const childManifest = Object.assign({}, mf, { name: 'The Child', flags: { provenance: 'doomalay-canvas', requires: ['nvidia'] } });
  delete childFiles['manifest.json'];
  childFiles['manifest.json'] = J(childManifest);
  const childZip = zipOf(childFiles);
  bundleFiles['children/wChild.doomcanvas'] = childZip;
  const bundle = zipOf(bundleFiles);
  // read it back
  v = CB.read(bundle);
  ok('the built bundle passes its own ladder', v.ok, v.why);
  // import into a FRESH stub
  const dstIO = stubIO({});
  const imp = await CB.importBundle(bundle, { io: dstIO, quiet: true, IconReg: null });
  ok('the import lands ok', imp.ok, imp.why);
  const S = dstIO._S;
  const newSids = Object.keys(S.sessions);
  ok('both chats reborn as FRESH sessions', newSids.length === 2 && newSids.every((s) => s.indexOf('ns') === 0), J(newSids));
  const reborn = S.sessions[newSids[0]];
  ok('the reborn session carries the safe fields + auto-tools OFF',
    reborn.Title === 'Aster' && reborn.Persona === 'be terse' && reborn.WebSearch === false && reborn.PreambleSel === '' && reborn.HooksConfig === '' && reborn.ManuallyRenamed === true,
    J(reborn));
  const evs = S.events[newSids[0]];
  ok('the history rode in seq order (user → assistant → … )', evs.length >= 4 && evs[0].type === 'user' && evs[0].text === 'hello world', J(evs && evs.slice(0, 2)));
  const hideEvs = evs.filter((e) => e.type === 'hide');
  ok('the hide mask rode TRANSLATED (old seq 1 → the new seq of that event)',
    hideEvs.length === 1 && (function () { const m = JSON.parse(hideEvs[0].text); return m.length === 1 && m[0] === 1; })(),
    J(hideEvs));
  ok('the asset materialized onto the reborn chat (background PUT)', !!S.media[newSids[0] + ':background']);
  const tweaksPut = S.tweaks[newSids[0]];
  ok('the tweaks rode', tweaksPut && tweaksPut.bubbleStyle === 'soft');
  const canvasIds = Object.keys(S.canvases);
  ok('the parent canvas row was born LAST (after the child)', S.canvasOrder && S.canvasOrder.length === 2 && S.canvasOrder[0] !== S.canvasOrder[1], J(S.canvasOrder));
  const parentRow = S.canvases[S.canvasOrder[S.canvasOrder.length - 1]];
  ok('the parent state rebinds icons to the FRESH sessions',
    (function () { const st = parentRow.state; const chat = st.icons.filter((i) => i.type === 'chat')[0]; return chat && chat.sessionId === newSids[0]; })(),
    J(parentRow.state.icons.filter((i) => i.type === 'chat').map((i) => i.sessionId)));
  ok('the hole retargets to the REBORN child canvas',
    (function () { const st = parentRow.state; const hole = st.icons.filter((i) => i.type === 'hole')[0]; return hole && hole.targetWorldId === S.canvasOrder[0]; })());
  ok('the icon caps land with auto-tools OFF',
    (function () { const st = parentRow.state; const chat = st.icons.filter((i) => i.type === 'chat')[0]; return chat.caps && chat.caps.termux === false && chat.caps.webSearch === false; })());
  ok('the provenance mark rides the state', parentRow.state.imported && parentRow.state.imported.from === 'The Parent' && parentRow.state.imported.author === 'rig');
  ok('the requires[] warning fires for the keyless provider (nvidia)',
    imp.warnings.some((w) => /nvidia/.test(w) && /no key/.test(w)), J(imp.warnings));

  // ── A5 BYOK — no key-shaped field names ride the bundle JSON ──────
  console.log('\nA5 BYOK');
  const keyish = /(api_?key|token|secret|password|credential)/i;
  let keyHits = [];
  Object.keys(bundleFiles).forEach((name) => {
    if (typeof bundleFiles[name] !== 'string') return;
    try {
      const walk = (o, pathStr) => {
        if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (keyish.test(k)) keyHits.push(pathStr + '.' + k); walk(o[k], pathStr + '.' + k); });
      };
      walk(JSON.parse(bundleFiles[name]), name);
    } catch (e) {}
  });
  ok('no key-shaped field name rides any bundle JSON', keyHits.length === 0, J(keyHits.slice(0, 5)));

  // ── A6 the rollback ───────────────────────────────────────────────
  console.log('\nA6 THE ROLLBACK');
  const rollIO = stubIO(Object.assign(seedWorld(), { failOn: 'session2' }));
  const imp2 = await CB.importBundle(bundle, { io: rollIO, quiet: true, IconReg: null });
  ok('the mid-driver throw fails honestly', !imp2.ok);
  ok('the report says rolled back', imp2.rolledBack === true, imp2.why);
  ok('the FIRST session was undone (deleted)', rollIO._S.deleted.length === 1, J(rollIO._S.deleted));
  ok('no canvas row was born', (rollIO._S.canvasOrder || []).length === 0, J(rollIO._S.canvasOrder));

  // ── A7 the caps ───────────────────────────────────────────────────
  console.log('\nA7 THE CAPS');
  const bigSeed = seedWorld();
  bigSeed.media['sOld1:background'] = new Uint8Array(6 * 1024 * 1024 + 1024);   // 6MB + 1KB → skipped
  const bigIO = stubIO(bigSeed);
  const bigCtx = collectCtx(bigIO, parentWorldState());
  let bigWarn = [];
  const bigFiles = {};
  for (const pub of P.publishers) {
    const r = await pub.collect(bigCtx);
    Object.assign(bigFiles, r.files);
    (r.warnings || []).forEach((w) => bigWarn.push(w));
  }
  ok('a >6MB asset is skipped with the honest warning', !bigFiles['assets/0.png'] && bigWarn.some((w) => /6MB/.test(w)), J(bigWarn));
  // the history fold: >8MB of events folds under the cap
  const foldSeed = seedWorld();
  const hugeEvs = [];
  for (let i = 0; i < 900; i++) hugeEvs.push({ type: 'user', text: 'x'.repeat(10 * 1024) });   // ~9.2MB
  foldSeed.events.sOld1 = hugeEvs;
  const foldIO = stubIO(foldSeed);
  const foldCtx = collectCtx(foldIO, parentWorldState());
  const foldFiles = {};
  let foldWarn = [];
  for (const pub of P.publishers) {
    const r = await pub.collect(foldCtx);
    Object.assign(foldFiles, r.files);
    (r.warnings || []).forEach((w) => foldWarn.push(w));
  }
  const fc = JSON.parse(foldFiles['chats/sOld1.json']);
  ok('a >8MB history folds under the cap (oldest dropped, honest warning)',
    fc.history && JSON.stringify(fc.history).length <= P.HISTORY_MAX_BYTES && foldWarn.some((w) => /folded/.test(w)),
    'hist=' + (fc.history ? JSON.stringify(fc.history).length : 'none') + ' warn=' + J(foldWarn.slice(0, 2)));

  console.log('\n═══ ' + (n - fails.length) + '/' + n + ' ═══');
  if (fails.length) { console.log('FAILS: ' + J(fails)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('RIG CRASH', e); process.exit(2); });
