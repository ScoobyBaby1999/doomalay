#!/usr/bin/env node
// v1540-library-rig.mjs — v1.54 THE LIBRARY SHIP redteam, PURE phase
// (node-required chatbundle.js + publishers.js; the LIVE phase rides
// v1540-library-walk.mjs):
//
//   B1  THE FORMAT LAW: build → read round-trip (format 'doomalay-chat',
//       exactly one chat, manifest contents); a 2-chat bundle rejected;
//       a 0-chat bundle rejected; children/*.doomcanvas rejected (a chat
//       is a leaf); canvas.json rejected (unknown entry)
//   B2  THE LADDER — bomb (both sizes), ratio (100:1), traversal, name
//       depth, unknown entries, version (2.0 rejected · 1.1 accepted ·
//       x-* rides), wrong format, entry count, truncation (a patched
//       central directory lies → rejected)
//   B3  THE IMPORT E2E (io stubs): the session reborn fresh, auto-tools
//       OFF at birth (R7), personas FORCED INACTIVE (the bundle's
//       'always' claim dies at the border), preamble_sel '' (the
//       unselected law), history replayed in order, assets materialized
//   B4  THE ROLLBACK: a mid-driver throw reverse-walks the journal —
//       the reborn session dies
//   B5  BYOK: no key-shaped field name rides any .doomchat JSON
'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'engine/internal/server/web');
const P = require(path.join(WEB, 'publishers.js'));
const CHB = require(path.join(WEB, 'chatbundle.js'));
const ff = require(path.join(WEB, 'vendor/fflate.js'));

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const J = (v) => JSON.stringify(v);

function zipOf(files) {
  const entries = {};
  Object.keys(files).forEach((k) => {
    entries[k] = (typeof files[k] === 'string') ? ff.strToU8(files[k]) : files[k];
  });
  return ff.zipSync(entries, { level: 6 });
}
function chatManifest(extra) {
  return Object.assign({
    format: 'doomalay-chat', formatVersion: '1.0', uuid: 'u1',
    createdAt: '2026-10-21T00:00:00Z', appVersion: 'test', name: 'rig chat',
    author: '', contents: {}, sizes: {},
    flags: { provenance: 'doomalay-chat', requires: [] }
  }, extra || {});
}
function chatBody(over) {
  return J(Object.assign({
    session: { title: 'Aster', model: 'glm-5.3', provider: 'opencode' },
    tweaks: { bubbleStyle: 'soft' },
    assets: [{ kind: 'background', file: 'assets/0.png', mime: 'image/png' }],
    history: { events: [
      { seq: 1, type: 'user', text: 'hello' },
      { seq: 2, type: 'assistant', text: 'the rig hears you' }
    ] }
  }, over || {}));
}
const TINY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 250, 207, 192, 80, 15, 0, 4, 133, 1, 128, 132, 169, 129, 109, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

// patch the CENTRAL DIRECTORY's uncompressed size for a named entry
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
  return z;
}

// ── B3's io stub: a shape-honest in-memory engine (the v1428 law — the
// GET marshals PascalCase, POST/PATCH speak snake_case) ──────────────
function stubIO(opts) {
  const failOn = (opts && opts.failOn) || null;
  const state = {
    sessions: {},           // nsid → session row (PascalCase reads)
    tweaks: {}, events: {}, // nsid → {…} / nsid → [rows]
    assets: {},             // nsid → { background: bytes }
    births: [],             // the raw snake_case birth bodies (R7 asserts)
    patches: [],            // the raw PATCH bodies (the trust ladder asserts)
    nextId: 100,
  };
  const io = {
    getJSON: async (url) => {
      if (url === '/api/keys') return { opencode: { provider: 'opencode', has_key: true }, nvidia: { provider: 'nvidia', has_key: false } };
      const m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m) {
        const s = state.sessions[m[1]];
        if (!s) throw new Error('no session ' + m[1]);
        return s;
      }
      const t = /^\/api\/sessions\/([^/]+)\/tweaks$/.exec(url);
      if (t) return { tweaks: state.tweaks[t[1]] || {} };
      const e = /^\/api\/sessions\/([^/]+)\/export\.json/.exec(url);
      if (e) return { events: state.events[e[1]] || [] };
      throw new Error('stub: no GET ' + url);
    },
    postJSON: async (url, body) => {
      if (url === '/api/sessions') {
        state.births.push(body);
        if (failOn === 'birth') throw new Error('the engine refused a session birth');
        const id = 's' + (state.nextId++);
        state.sessions[id] = {
          ID: id, Title: body.title || '', Model: body.model || '', Provider: body.provider || '',
          Sandbox: body.sandbox || '', Personas: '[]', Preambles: '[]', PreambleSel: '',
          WebSearch: !!body.web_search, TemplateAuto: !!body.template_auto,
          SkillsAuto: !!body.skills_auto, LibAuto: !!body.lib_auto, Termux: !!body.termux,
        };
        return state.sessions[id];
      }
      const ev = /^\/api\/sessions\/([^/]+)\/events$/.exec(url);
      if (ev) {
        if (failOn === 'event') throw new Error('event refused');
        (state.events[ev[1]] = state.events[ev[1]] || []).push({ Seq: (state.events[ev[1]].length + 1) * 10, event_type: body.type, content: body.text });
        return { Seq: (state.events[ev[1]].length) * 10 };
      }
      throw new Error('stub: no POST ' + url);
    },
    patchJSON: async (url, body) => {
      const m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m) {
        state.patches.push(body);
        const s = state.sessions[m[1]];
        if (body.personas !== undefined) s.Personas = body.personas;
        if (body.preambles !== undefined) s.Preambles = body.preambles;
        if (body.preamble_sel !== undefined) s.PreambleSel = body.preamble_sel;
        return s;
      }
      throw new Error('stub: no PATCH ' + url);
    },
    putJSON: async (url, body) => {
      const m = /^\/api\/sessions\/([^/]+)\/tweaks$/.exec(url);
      if (m) { state.tweaks[m[1]] = body; return {}; }
      throw new Error('stub: no PUT ' + url);
    },
    del: async (url) => {
      const m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m) { delete state.sessions[m[1]]; (state.dels = state.dels || []).push(m[1]); return {}; }
      throw new Error('stub: no DELETE ' + url);
    },
    putBytes: async (url, bytes) => {
      const m = /^\/api\/sessions\/([^/]+)\/(background|texture|icon)$/.exec(url);
      if (m) { (state.assets[m[1]] = state.assets[m[1]] || {})[m[2]] = bytes; return {}; }
      throw new Error('stub: no PUT bytes ' + url);
    },
    getBytes: async () => null,
  };
  return { io, state };
}

// ═══ B1: the format law ════════════════════════════════════════════
console.log('B1 — the .doomchat format law');
{
  const files = {
    'manifest.json': J(chatManifest()),
    'chats/s-old.json': chatBody(),
    'assets/0.png': TINY_PNG,
  };
  const zip = zipOf(files);
  const rd = CHB.read(zip);
  ok('the round-trip reads', rd.ok, rd.why);
  ok('format doomalay-chat', rd.ok && rd.manifest.format === 'doomalay-chat');
  ok('exactly one chat + its sid', rd.ok && rd.sid === 's-old');
  ok('assets ride as bytes', rd.ok && rd.files['assets/0.png'] instanceof Uint8Array);
  ok('the manifest parses', rd.ok && rd.manifest.name === 'rig chat');

  const two = CHB.read(zipOf({
    'manifest.json': J(chatManifest()),
    'chats/a.json': chatBody(), 'chats/b.json': chatBody(),
  }));
  ok('TWO chats rejected (a canvas\'s job)', !two.ok && /exactly ONE/.test(two.why), two.why);

  const none = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'assets/0.png': TINY_PNG }));
  ok('ZERO chats rejected', !none.ok && /no chat/.test(none.why), none.why);

  const nested = CHB.read(zipOf({
    'manifest.json': J(chatManifest()),
    'chats/a.json': chatBody(),
    'children/x.doomcanvas': new Uint8Array([1, 2, 3]),
  }));
  ok('children/*.doomcanvas rejected (a chat is a leaf)', !nested.ok && /unknown entry/.test(nested.why), nested.why);

  const canvasJson = CHB.read(zipOf({
    'manifest.json': J(chatManifest()),
    'chats/a.json': chatBody(),
    'canvas.json': J({ icons: [] }),
  }));
  ok('canvas.json rejected (unknown entry in a chat)', !canvasJson.ok && /unknown entry/.test(canvasJson.why), canvasJson.why);
}

// ═══ B2: the ladder ════════════════════════════════════════════════
console.log('B2 — the read ladder');
{
  const big = new Uint8Array(9 * 1024 * 1024); // 9MB > the 8MB entry cap
  const bomb = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody(), 'assets/0.png': big }));
  ok('a 9MB entry rejected (8MB/entry)', !bomb.ok, bomb.why);

  const ratio = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody(), 'assets/0.bin': new Uint8Array(8 * 1024 * 1024) }, ));
  // a fully-zero 8MB entry compresses past 100:1 → the ratio rung
  ok('the 100:1 ratio rung rejects a bomb-shaped entry', !ratio.ok, ratio.why);

  const trav = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody(), 'assets/../evil.png': TINY_PNG }));
  ok('traversal names rejected', !trav.ok, trav.why);

  const deep = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody(), 'assets/1/2/3/4/5/6/7/8/9/0/x.png': TINY_PNG }));
  ok('over-deep names rejected', !deep.ok, deep.why);

  const unknown = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody(), 'evil.sh': new Uint8Array([1]) }));
  ok('unknown entries rejected', !unknown.ok && /unknown entry/.test(unknown.why), unknown.why);

  const v2 = CHB.read(zipOf({ 'manifest.json': J(chatManifest({ formatVersion: '2.0' })), 'chats/a.json': chatBody() }));
  ok('a 2.0 format rejected', !v2.ok && /newer/.test(v2.why), v2.why);

  const v11 = CHB.read(zipOf({ 'manifest.json': J(chatManifest({ formatVersion: '1.1', extraFuture: 'rides' })), 'chats/a.json': chatBody() }));
  ok('a 1.1 format accepted + unknown fields ignored', v11.ok, v11.why);

  const xns = CHB.read(zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody(), 'x-future': J({ any: 'thing' }) }));
  ok('the x-* namespace rides', xns.ok, xns.why);

  const wrong = CHB.read(zipOf({ 'manifest.json': J(chatManifest({ format: 'doomalay-canvas' })), 'chats/a.json': chatBody() }));
  ok('a .doomcanvas manifest rejected', !wrong.ok && /format mismatch/.test(wrong.why), wrong.why);

  const lie = zipOf({ 'manifest.json': J(chatManifest()), 'chats/a.json': chatBody() });
  const lying = CHB.read(patchCDSize(lie, 'chats/a.json', 999));
  ok('a lying central directory rejected (truncation rung)', !lying.ok && /truncated/.test(lying.why), lying.why);
}

// ═══ B3: the import E2E + THE TRUST LADDER ═════════════════════════
console.log('B3 — importChat E2E (io stubs) + the trust ladder');
{
  // a bundle whose personas claim mode 'always' + a preamble rides along
  const body = chatBody({
    session: {
      title: 'Aster', model: 'glm-5.3', provider: 'opencode',
      manually_renamed: true,
      personas: J([{ id: 'p1', name: 'Sneaky', text: 'activate me', mode: 'always' }]),
      preambles: J([{ id: 'pre1', name: 'P', text: 'hello' }]),
      preamble_sel: 'pre1',
    },
  });
  const zip = zipOf({
    'manifest.json': J(chatManifest({ flags: { provenance: 'doomalay-chat', requires: ['nvidia'] } })),
    'chats/s-old.json': body,
    'assets/0.png': TINY_PNG,
  });
  const { io, state } = stubIO();
  const res = await CHB.importChat(zip, { io });
  ok('the import lands', res.ok, res.why);
  ok('the session is reborn fresh', res.nsid && state.sessions[res.nsid]);
  const birth = state.births[0] || {};
  ok('R7: web_search OFF at birth', birth.web_search === false, J(birth));
  ok('R7: template_auto OFF at birth', birth.template_auto === false);
  ok('R7: skills_auto OFF at birth', birth.skills_auto === false);
  ok('R7: lib_auto OFF at birth', birth.lib_auto === false);
  ok('R7: termux OFF at birth', birth.termux === false);
  const patch = state.patches[0] || {};
  const personas = JSON.parse(patch.personas || '[]');
  ok('THE TRUST LADDER: the bundle\'s persona mode \'always\' dies at the border', personas.length === 1 && personas[0].mode === 'inactive', J(personas));
  ok('THE UNSELECTED LAW: preamble_sel lands \'\'', patch.preamble_sel === '', J(patch));
  ok('the tweaks ride', J(state.tweaks[res.nsid]) === J({ bubbleStyle: 'soft' }));
  ok('the history replayed (2 events in order)', (state.events[res.nsid] || []).length === 2 && state.events[res.nsid][0].content === 'hello');
  ok('the asset materialized onto the reborn session', state.assets[res.nsid] && state.assets[res.nsid].background instanceof Uint8Array);
  ok('BYOK: the nvidia requires warning surfaces (no key in the stub)', res.warnings.some((w) => /nvidia/.test(w)), J(res.warnings));
  ok('created counts', res.created && res.created.chats === 1 && res.created.assets === 1, J(res.created));
}

// ═══ B4: the rollback + the honest-history law ════════════════════
console.log('B4 — the rollback + the honest-history law');
{
  // (1) a PRE-BIRTH throw (assets staging over the cap) → rolled back,
  // nothing born — the journals reverse-walk cleanly. The asset is
  // HIGH-ENTROPY (deterministic PRNG) so the ratio rung passes and the
  // 6MB per-asset cap is what convicts.
  const bigAsset = new Uint8Array(7 * 1024 * 1024);
  let x = 123456789;
  for (let i = 0; i < bigAsset.length; i++) {
    x ^= (x << 13) >>> 0; x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0; x >>>= 0;
    bigAsset[i] = x & 0xff;
  }
  const zip1 = zipOf({
    'manifest.json': J(chatManifest()),
    'chats/s-old.json': chatBody(),
    'assets/0.png': bigAsset,
  });
  const s1 = stubIO();
  const r1 = await CHB.importChat(zip1, { io: s1.io });
  ok('an over-cap asset fails honestly', !r1.ok && /6MB/.test(r1.why || ''), r1.why);
  ok('rolled back, nothing born', r1.rolledBack === true && Object.keys(s1.state.sessions).length === 0);

  // (2) a refused BIRTH → fails, nothing to undo.
  const zip2 = zipOf({ 'manifest.json': J(chatManifest()), 'chats/s-old.json': chatBody() });
  const s2 = stubIO({ failOn: 'birth' });
  const r2 = await CHB.importChat(zip2, { io: s2.io });
  ok('a refused birth fails honestly', !r2.ok, r2.why);
  ok('no session leaked', Object.keys(s2.state.sessions).length === 0);

  // (3) THE HONEST HISTORY LAW (the rig's conviction, now the law): a
  // mid-replay event failure NEVER throws — the birth is the commitment,
  // history is cargo. The import SUCCEEDS with a warning; the session
  // lives; the events that could land, landed.
  const s3 = stubIO({ failOn: 'event' });
  const r3 = await CHB.importChat(zip2, { io: s3.io });
  ok('a mid-replay failure degrades to a warning (the import lands)', r3.ok, r3.why);
  ok('the reborn session LIVES (no leak, no orphan undo)', r3.ok && s3.state.sessions[r3.nsid]);
  ok('the refusal surfaced honestly', (r3.warnings || []).some((w) => /refused/.test(w)), J(r3.warnings));
}

// ═══ B5: BYOK ══════════════════════════════════════════════════════
console.log('B5 — BYOK (no key-shaped field rides the bundle)');
{
  const KEYSHAPE = /(api[_-]?key|token|secret|password|credential|authorization|bearer)/i;
  const files = { 'manifest.json': J(chatManifest()), 'chats/s-old.json': chatBody() };
  let bad = null;
  Object.keys(files).forEach((k) => {
    if (KEYSHAPE.test(files[k])) bad = k;
    // key-shaped FIELD NAMES anywhere in the JSON
    const walk = (v) => {
      if (bad) return;
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        Object.keys(v).forEach((fk) => { if (KEYSHAPE.test(fk)) bad = k + '#' + fk; walk(v[fk]); });
      }
    };
    try { walk(JSON.parse(files[k])); } catch (e) {}
  });
  ok('no key-shaped field name rides any .doomchat JSON', !bad, bad);
}

console.log('');
console.log(`v1540-library-rig: ${n - fails.length}/${n}` + (fails.length ? '  FAILED: ' + fails.join(' · ') : '  ALL GREEN'));
process.exit(fails.length ? 1 : 0);
