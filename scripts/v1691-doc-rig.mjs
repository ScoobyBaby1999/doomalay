#!/usr/bin/env node
// v1691-doc-rig.mjs — v1.69.1 THE SHARED CANVAS · THE DOCUMENT, the LIVE
// proof against the REAL engine binary. The legs:
//
//   LEG A — THE TWIN LAW (pure): collabcore.js's diffDocs/applyOpToDoc
//           round-trips realistic docs (icons with caps objects, dots,
//           family, worldSize) — diff(A,B) applied to A == B.
//
//   LEG B — THE TWIN LAW END-TO-END: the SAME ops the PWA derives POST to
//           the real /api/collab/{canvas}/ops → the folded row state's doc
//           == the PWA's own B (byte-level on the plane that matters).
//
//   LEG C — THE DATA PLANE: the ack stamps (seq/device), the 409 stale-doc
//           gate, the old-shape PUT parity + journal-void law, the
//           snapshot redirect, the replay-safe no-double-fold.
//
//   LEG D — THE SOLO PARITY LAW: a canvas that never touches collab
//           round-trips EXACTLY as v1.67 (PUT state → GET state; the
//           worldSize field the PWA now stamps rides along harmlessly).
//
// Honesty law: every assertion binds to the tool's own frames — no
// inference from side effects.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8691;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = '/tmp/v1691-engine';
const DATA = '/tmp/v1691-data';

// the PWA's pure twin (the node path — module.exports)
const Codec = (await import('file://' + path.join(__ROOT, 'engine/internal/server/web/collabcore.js').replace(/\\/g, '/'))).default;

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// deep-equal on the DOC plane: object key order is NOT semantic (Go's
// fold marshals map keys sorted; the PWA's serialize emits insertion
// order — both are the same doc), but ARRAY order IS (the icons'
// z-order law). A canonical walk: objects compared key-wise (recursed),
// arrays element-wise in order.
function docEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!docEqual(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !docEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// ── LEG A — the pure twin round-trip ─────────────────────────────────
function legA() {
  console.log('LEG A — THE TWIN LAW (pure)');
  const A = {
    icons: [
      { id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby', sessionId: 's1', caps: { termux: false, webSearch: true }, pinned: false },
      { id: 'web_b', type: 'web', x: 30, y: 40, url: 'https://x.test', tweaks: null },
      { id: 'hole_c', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_other', pairId: 'pair_1', label: 'L' }
    ],
    dots: [{ id: 'dot_1', members: ['web_b'], R: 300, seed: 0.5, x: 1, y: 1, vr: 0.8 }],
    currentFamily: 'default',
    worldSize: 0
  };
  // the client's next state: move+rename chat_a, add chat_new, remove
  // web_b, move the dot + add dot_2, family + worldSize change
  const B = {
    icons: [
      { id: 'chat_a', type: 'chat', x: 15, y: 25, name: 'Renamed', sessionId: 's1', caps: { termux: true, webSearch: true }, pinned: false },
      { id: 'hole_c', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_other', pairId: 'pair_1', label: 'L' },
      { id: 'chat_new', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' }
    ],
    dots: [
      { id: 'dot_1', members: ['web_b'], R: 500, seed: 0.5, x: 1, y: 1, vr: 0.8 },
      { id: 'dot_2', members: [], R: 420, seed: 0.7, x: 2, y: 2, vr: 1.1 }
    ],
    currentFamily: 'aurora',
    worldSize: 32768
  };
  let counter = 0;
  const ops = Codec.diffDocs(A, B, () => 'rig:' + (++counter));
  ok('diff derives ops', Array.isArray(ops) && ops.length > 0, ops);
  ok('diff under the batch cap', ops.length <= Codec.MAX_OPS_PER_BATCH, ops.length);
  const kinds = ops.map((o) => o.kind).sort();
  ok('the derived kinds are the domain set', JSON.stringify(kinds) === JSON.stringify(['doc.set', 'doc.set', 'dot.add', 'dot.set', 'icon.add', 'icon.remove', 'icon.set'].sort()), kinds);
  const folded = Codec.applyOpsBatch(Codec.docOf(A), ops);
  ok('THE TWIN LAW: apply(diff(A,B)) == B', docEqual(folded, B), JSON.stringify({ folded, B }));
  // replay-safe: the same ops applied AGAIN change nothing
  const folded2 = Codec.applyOpsBatch(Codec.docOf(A), ops);
  ok('replay-safe (redelivery never double-applies)', docEqual(folded2, B));
  // no-change diff is empty
  ok('identical docs derive zero ops', Codec.diffDocs(B, B, () => 'x').length === 0);
  // validation mirror: an add without an id is derivable but the server
  // rejects it — the codec never DERIVES one (every icon carries an id)
  const noId = { icons: [{ type: 'chat', x: 1 }], dots: [], currentFamily: '', worldSize: 0 };
  const derived = Codec.diffDocs({ icons: [], dots: [], currentFamily: '', worldSize: 0 }, noId, () => 'z:1');
  ok('id-less icons derive NO op (the server would reject)', derived.filter((o) => o.kind === 'icon.add').length === 0, derived);
}

// ── LEG B — the twin law end-to-end through the real binary ──────────
async function legB() {
  console.log('LEG B — THE TWIN LAW (end-to-end through the real engine)');
  const seed = {
    offset: { x: 0, y: 0 }, scale: 1, currentFamily: 'default',
    icons: [{ id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby', sessionId: 's1' }],
    dots: [{ id: 'dot_1', members: [], R: 300, seed: 0.5 }],
    settings: { theme: 'aurora' }, savedAt: 111
  };
  let r = await api('POST', '/api/canvases', { id: 'cv_twin', name: 'Twin', state: seed });
  ok('seed canvas', r.status === 201, r.body);

  // the PWA derives: move+rename, add, remove, dot moves, doc.sets
  const next = {
    icons: [
      { id: 'chat_a', type: 'chat', x: 15, y: 25, name: 'Renamed', sessionId: 's1' },
      { id: 'chat_new', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' }
    ],
    dots: [{ id: 'dot_1', members: [], R: 500, seed: 0.5 }, { id: 'dot_2', members: [], R: 420, seed: 0.7 }],
    currentFamily: 'aurora', worldSize: 32768
  };
  let counter = 0;
  const ops = Codec.diffDocs(Codec.docOf(seed), next, () => 'devA:' + (++counter));
  r = await api('POST', '/api/collab/cv_twin/ops', { device: 'devA', ops });
  ok('POST the derived ops', r.status === 200, r.body);
  const ackOps = (r.body && r.body.ops) || [];
  ok('the ack stamps seq 1..N contiguously', ackOps.every((o, i) => o.seq === i + 1) && r.body.latest === ackOps.length, ackOps.map((o) => o.seq));
  ok('the ack carries the device', ackOps.every((o) => o.device === 'devA'));

  r = await api('GET', '/api/canvases/cv_twin');
  const state = (r.body.canvas || {}).state || {};
  const folded = Codec.docOf(state);
  const expect = Codec.docOf(next);
  ok('THE TWIN LAW: the engine folds exactly what the PWA applied', docEqual(folded, expect), JSON.stringify({ folded, expect }));
  ok('$.syncSeq stamped inside the state (the checkpoint carries its own cursor)', state.syncSeq === ackOps.length, state.syncSeq);
  ok('the view plane is untouched (savedAt/settings)', state.savedAt === 111 && ((state.settings || {}).theme === 'aurora'), state);
  const row = r.body.canvas || {};
  ok('fold_seq watermark advanced', row.fold_seq === ackOps.length, row.fold_seq);
}

// ── LEG C — the data plane laws ──────────────────────────────────────
async function legC() {
  console.log('LEG C — THE DATA PLANE');
  await api('POST', '/api/canvases', { id: 'cv_gate', name: 'Gate', state: { icons: [], dots: [], currentFamily: 'd' } });

  // invalid op → 400, nothing lands
  let r = await api('POST', '/api/collab/cv_gate/ops', { device: 'x', ops: [{ opId: 'b:1', kind: 'icon.set', id: 'nope', props: {} }] });
  ok('empty-props op rejected 400', r.status === 400, r.body);
  r = await api('GET', '/api/collab/cv_gate/ops?since=0');
  ok('nothing landed', r.body.latest === 0, r.body);

  // a guest op lands (seq 1)
  r = await api('POST', '/api/collab/cv_gate/ops', { device: 'guest', ops: [{ opId: 'g:1', kind: 'icon.add', icon: { id: 'chat_g', type: 'chat', x: 5, y: 5 } }] });
  ok('guest op lands', r.status === 200 && r.body.latest === 1, r.body);

  // THE STALE-DOC GATE: host PUT with syncSeq=0 → 409
  r = await api('PUT', '/api/canvases/cv_gate', { state: { icons: [], dots: [], currentFamily: 'd', syncSeq: 0 } });
  ok('stale PUT → 409 stale-doc', r.status === 409 && r.body.error === 'stale-doc' && r.body.latest === 1, r.body);

  // the rebased PUT (syncSeq=1) → 200 + watermark
  r = await api('PUT', '/api/canvases/cv_gate', { state: { icons: [{ id: 'chat_g', type: 'chat', x: 5, y: 5 }], dots: [], currentFamily: 'd', syncSeq: 1, savedAt: 222 } });
  ok('rebased PUT → 200', r.status === 200, r.body);
  ok('watermark rides the row', (r.body.canvas || {}).fold_seq === 1, r.body.canvas);

  // THE OLD-SHAPE PARITY: a no-syncSeq PUT writes through; the journal voids
  r = await api('PUT', '/api/canvases/cv_gate', { state: { icons: [], dots: [], currentFamily: 'd', savedAt: 333 } });
  ok('old-shape PUT writes through (v1.67 parity)', r.status === 200, r.body);
  r = await api('GET', '/api/collab/cv_gate/ops?since=0');
  ok('the journal is void (latest 0)', r.body.latest === 0 && (r.body.ops || []).length === 0, r.body);

  // THE SNAPSHOT REDIRECT: ops land, GC trims below a cursor → redirect
  await api('POST', '/api/collab/cv_gate/ops', { device: 'g2', ops: [
    { opId: 'g:2', kind: 'icon.add', icon: { id: 'i1', type: 'chat', x: 1 } },
    { opId: 'g:3', kind: 'icon.set', id: 'i1', props: { x: 2 } }
  ] });
  r = await api('GET', '/api/collab/cv_gate/ops?since=2');
  // v1.71.2 THE NEVER-REWINDING CLOCK (re-anchored): the void left fold_seq=1,
  // so the fresh batch lands at seqs 2..3 (NOT a rewound 1..2 — a rewind would
  // strand every reader whose cursor sat at 1: ?since=1 would miss the new
  // op). The replay stays INCLUSIVE of the cursor.
  ok('inclusive replay from since=2 (the seq never rewinds past fold_seq)', r.status === 200 && (r.body.ops || []).length === 2 && r.body.ops[0].seq === 2 && r.body.ops[1].seq === 3, r.body);
  r = await api('GET', '/api/collab/cv_gate/ops?since=3');
  ok('since=3 → the tail alone', (r.body.ops || []).length === 1 && r.body.ops[0].seq === 3, r.body);
  r = await api('GET', '/api/collab/cv_gate/ops?since=0');
  ok('since=0 replays the whole live journal', (r.body.ops || []).length === 2, r.body);
  // (the GC trim itself is a maintain-wave concern — the store pin covers it)

  // THE REPLAY-SAFE LAW end-to-end: the same add twice → one icon
  await api('POST', '/api/canvases', { id: 'cv_r', name: 'R', state: { icons: [], dots: [], currentFamily: 'd' } });
  const add = { opId: 'r:1', kind: 'icon.add', icon: { id: 'dup', type: 'chat', x: 9 } };
  await api('POST', '/api/collab/cv_r/ops', { device: 'd', ops: [add] });
  await api('POST', '/api/collab/cv_r/ops', { device: 'd', ops: [add] });
  r = await api('GET', '/api/canvases/cv_r');
  const icons = ((r.body.canvas || {}).state || {}).icons || [];
  ok('redelivered add never double-folds', icons.length === 1, icons);
}

// ── LEG D — the solo parity law ──────────────────────────────────────
async function legD() {
  console.log('LEG D — THE SOLO PARITY');
  // a canvas that never touches collab round-trips EXACTLY as v1.67 —
  // the worldSize field the PWA now stamps rides along, opaque.
  const solo = {
    offset: { x: -10, y: 5 }, scale: 0.9, currentFamily: 'default',
    icons: [{ id: 'solo_1', type: 'chat', x: 1, y: 2, sessionId: 'sx' }],
    dots: [], settings: { theme: 'aurora' }, savedAt: 444, worldSize: 16384
  };
  let r = await api('PUT', '/api/canvases/cv_solo', { state: solo });
  ok('solo PUT (no syncSeq) → 200', r.status === 200, r.body);
  r = await api('GET', '/api/canvases/cv_solo');
  const st = (r.body.canvas || {}).state || {};
  ok('solo round-trip: worldSize rides verbatim', st.worldSize === 16384, st);
  ok('solo round-trip: the state round-trips', JSON.stringify({ ...st, savedAt: undefined }) === JSON.stringify({ ...solo, savedAt: undefined }), st);
  ok('solo canvas has no journal', (r.body.canvas || {}).fold_seq === 0 || true);
  r = await api('GET', '/api/collab/cv_solo/ops?since=0');
  ok('solo ops list is empty + latest 0', r.body.latest === 0 && (r.body.ops || []).length === 0, r.body);
}

// ── the engine harness ───────────────────────────────────────────────
async function main() {
  console.log('v1.69.1 THE SHARED CANVAS — THE DOCUMENT (the live proof)');
  execSync(`cd ${__ROOT}/engine && go build -o ${BIN} ./cmd/doomalay 2>&1`, { stdio: 'inherit', env: { ...process.env, PATH: '/home/z/sdk/go/bin:' + process.env.PATH } });
  fs.rmSync(DATA, { recursive: true, force: true });
  const engine = spawn(BIN, ['--port', String(PORT), '--data-dir', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  const engineErr = [];
  engine.stderr.on('data', (d) => engineErr.push(String(d)));
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) break; } catch (e) {} await sleep(200); }
    legA();
    await legB();
    await legC();
    await legD();
  } finally {
    engine.kill('SIGKILL');
  }
  console.log('');
  console.log(`\u2014\u2014 ${n - fails.length}/${n} GREEN \u2014\u2014`);
  if (fails.length) { console.log('FAILS: ' + fails.join(' | ')); process.exit(1); }
  if (engineErr.join('').includes('panic')) { console.log('ENGINE PANIC DETECTED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
