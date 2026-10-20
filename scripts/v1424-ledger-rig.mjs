#!/usr/bin/env node
// v1424-ledger-rig.mjs — v1.42.4 THE LEDGER redteam (PLAN-V142 §3.2
// W2): the engine-side multi-canvas home, proven against a REAL booted
// engine + the pure web core (node-required worlds.js).
//
// ENGINE PHASE (the real binary, real SQLite):
//   T1  clean boot: the ledger lists [] (shape, not null)
//   T2  create (explicit id + a real WorldState) → list probes
//       (icon_count, saved_at, has_thumb)
//   T3  GET full row (state rides as raw JSON) · GET missing → 404
//   T4  THE NO-CLOBBER LAW: a rename-only PUT keeps state; a state-only
//       PUT keeps name+sort (the Worlds sync contract, live)
//   T5  PUT-on-missing upserts (the idempotent migration retry)
//   T6  caps at the door: state >4MB → 413 · thumb >64KB → 415-family
//       refusal (wrong magic) + 413 (over cap)
//   T7  thumb PNG round-trip (magic-sniffed content-type, byte-exact)
//   T8  DELETE idempotent
//   T9  the digest across canvases (icon ids + session ids, the hygiene
//       sweep's join) — the plain list carries NO ids
//   T10 /api/storage/usage counts canvases (the honest dashboard)
//   T11 THE MIGRATION SHAPE: a state.v2-shaped blob (icons with
//       sessionId + dots + camera + family) round-trips verbatim
//   T12 THE DRAG LAW: 30 rapid state PUTs (the drag-rate cadence
//       compressed) → ONE row, the WAL stays bounded (the v1.42.1 law
//       holds under the new write source)
//   T13 concurrent PUTs converge on one row
//
// PURE-CORE PHASE (worlds.js required as a module):
//   N1-N12 the decideBoot matrix (engine-down/fresh/migrate/heal/
//       ownership/stale-pointer/poison) + the syncWait cadence math
//
// Usage: node scripts/v1424-ledger-rig.mjs
'use strict';

import { createRequire } from 'node:module';
import { execFileSync, spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENGINE_BIN = path.join(os.tmpdir(), 'doomalay-v1424-rig-engine');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1424-rig-'));
const PORT = 8424;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  · ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  · ' + String(extra).slice(0, 300) : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(method, p, body, raw) {
  const init = { method };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    init.headers = { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' };
  }
  const r = await fetch(BASE + p, init);
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, body: d };
}

// a realistic WorldState (what app.js saveNow produces)
function worldState(savedAt, nIcons) {
  const icons = [];
  for (let i = 0; i < (nIcons || 3); i++) {
    icons.push({
      type: 'chat', id: 'chat_' + String(i), name: 'Bot ' + i,
      x: 100 + i * 80, y: 200 + i * 40, vx: 0, vy: 0, radius: 34,
      pinned: false, sandbox: 'quick',
      sessionId: i === 1 ? '' : 'sess-' + i
    });
  }
  return {
    offset: { x: -120.5, y: 88.25 }, scale: 0.85, currentFamily: 'aurora',
    icons, dots: [{ id: 'dot-1', members: ['chat_2'] }],
    savedAt, canvas: 'default'
  };
}

async function waitEngine() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) {}
    await sleep(500);
  }
  return false;
}

async function enginePhase() {
  console.log('\nENGINE PHASE (real binary, real SQLite)');
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(PORT), '--data-dir', DATA_DIR], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  ok('engine boots', await waitEngine());

  // T1 — clean ledger
  let r = await j('GET', '/api/canvases');
  ok('T1 clean ledger is []', r.status === 200 && Array.isArray(r.body.canvases) && r.body.canvases.length === 0);

  // T2 — create with probes
  r = await j('POST', '/api/canvases', { id: 'default', name: 'Main', state: worldState(1111, 3) });
  ok('T2 create 201', r.status === 201 && r.body.canvas && r.body.canvas.id === 'default');
  r = await j('GET', '/api/canvases');
  const row = r.body.canvases[0];
  ok('T2 list probes', row.icon_count === 3 && row.saved_at === 1111 && row.has_thumb === false && row.name === 'Main',
    `icons=${row.icon_count} saved=${row.saved_at}`);

  // T3 — full row + missing
  r = await j('GET', '/api/canvases/default');
  ok('T3 full row state raw', r.status === 200 && r.body.canvas.state && r.body.canvas.state.icons.length === 3);
  ok('T3 full row verbatim', r.body.canvas.state.offset.x === -120.5 && r.body.canvas.state.dots.length === 1);
  r = await j('GET', '/api/canvases/nope');
  ok('T3 missing 404', r.status === 404);

  // T4 — THE NO-CLOBBER LAW
  r = await j('PUT', '/api/canvases/default', { name: 'Renamed' });
  ok('T4 rename keeps state', r.status === 200 && r.body.canvas.state && r.body.canvas.state.savedAt === 1111 && r.body.canvas.name === 'Renamed');
  r = await j('PUT', '/api/canvases/default', { state: worldState(2222, 5) });
  ok('T4 state-only keeps name', r.status === 200 && r.body.canvas.name === 'Renamed' && r.body.canvas.state.savedAt === 2222);
  r = await j('GET', '/api/canvases/default');
  ok('T4 row survived both', r.body.canvas.state.icons.length === 5 && r.body.canvas.name === 'Renamed');

  // T5 — upsert-on-missing (the migration retry)
  r = await j('PUT', '/api/canvases/second', { name: 'Second', state: worldState(3333, 1) });
  ok('T5 PUT-on-missing upserts', r.status === 200 && r.body.canvas.id === 'second');
  r = await j('GET', '/api/canvases');
  ok('T5 two rows now', r.body.canvases.length === 2);

  // T6 — caps
  const huge = { state: { savedAt: 1, icons: [], pad: 'x'.repeat(4 * 1024 * 1024) } };
  r = await j('PUT', '/api/canvases/big', huge);
  ok('T6 state >4MB → 413', r.status === 413);
  const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n || 128, 7)]);
  r = await j('PUT', '/api/canvases/second/thumb', '<html>fake</html>', true);
  ok('T6 wrong magic → 415', r.status === 415);
  r = await j('PUT', '/api/canvases/second/thumb', png(65 * 1024), true);
  ok('T6 thumb >64KB → 413', r.status === 413);

  // T7 — thumb round-trip
  r = await j('PUT', '/api/canvases/second/thumb', png(512), true);
  ok('T7 thumb put', r.status === 200 && r.body.content_type === 'image/png');
  const tr = await fetch(BASE + '/api/canvases/second/thumb');
  const tbytes = Buffer.from(await tr.arrayBuffer());
  ok('T7 thumb round-trip byte-exact', tr.status === 200 && tr.headers.get('content-type') === 'image/png' && tbytes.length === 520 && tbytes[0] === 0x89);
  r = await j('GET', '/api/canvases');
  ok('T7 has_thumb probe flips', r.body.canvases.find((c) => c.id === 'second').has_thumb === true);

  // T8 — delete idempotent
  r = await j('DELETE', '/api/canvases/second');
  ok('T8 delete ok', r.status === 200 && r.body.ok === true);
  r = await j('DELETE', '/api/canvases/second');
  ok('T8 delete idempotent', r.status === 200 && r.body.ok === true);
  r = await j('GET', '/api/canvases/second');
  ok('T8 gone', r.status === 404);

  // T9 — digest
  await j('PUT', '/api/canvases/d1', { name: 'D1', state: worldState(1, 2) });
  await j('PUT', '/api/canvases/d2', { name: 'D2', state: { icons: [{ id: 'web_x', sessionId: 'sess-9' }], savedAt: 2 } });
  r = await j('GET', '/api/canvases?digest=1');
  const dig = r.body.canvases;
  const join = { icons: [], sessions: [] };
  dig.forEach((d) => { join.icons.push(...d.icon_ids); join.sessions.push(...d.session_ids); });
  ok('T9 digest joins icons', ['chat_0', 'chat_1', 'web_x'].every((i) => join.icons.includes(i)), join.icons.join(','));
  ok('T9 digest joins sessions', ['sess-0', 'sess-9'].every((s) => join.sessions.includes(s)), join.sessions.join(','));
  r = await j('GET', '/api/canvases');
  ok('T9 plain list carries no ids', r.body.canvases.every((c) => !c.icon_ids && !c.session_ids));

  // T10 — usage
  r = await j('GET', '/api/storage/usage');
  ok('T10 usage counts canvases', r.body.engine.canvases === 3, `canvases=${r.body.engine.canvases}`);

  // T11 — the migration shape
  const blob = worldState(1234567890, 4);
  r = await j('PUT', '/api/canvases/mig', { name: 'Canvas', state: blob });
  r = await j('GET', '/api/canvases/mig');
  const st = r.body.canvas.state;
  ok('T11 migration shape verbatim',
    st.icons.length === 4 && st.icons[0].sessionId === 'sess-0' && st.icons[1].sessionId === '' &&
    st.dots.length === 1 && st.offset.x === -120.5 && st.currentFamily === 'aurora' && st.savedAt === 1234567890);

  // T12 — THE DRAG LAW (30 rapid PUTs, one row, WAL bounded)
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await j('PUT', '/api/canvases/drag', { state: worldState(Date.now(), 3) });
  }
  const dt = Date.now() - t0;
  r = await j('GET', '/api/canvases');
  const dragRows = r.body.canvases.filter((c) => c.id === 'drag');
  r = await j('GET', '/api/storage/usage');
  ok('T12 drag-rate: one row', dragRows.length === 1);
  ok('T12 WAL bounded under the burst', r.body.engine.wal_bytes <= 8 * 1024 * 1024,
    `wal=${(r.body.engine.wal_bytes / 1048576).toFixed(1)}MB after 30 PUTs in ${dt}ms`);

  // T13 — concurrent PUTs converge
  await Promise.all(Array.from({ length: 10 }, (_, i) => j('PUT', '/api/canvases/race', { state: worldState(i, 2) })));
  r = await j('GET', '/api/canvases');
  ok('T13 concurrent PUTs converge', r.body.canvases.filter((c) => c.id === 'race').length === 1);

  // teardown
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
}

function purePhase() {
  console.log('\nPURE-CORE PHASE (worlds.js as a module)');
  const W = require(path.join(ROOT, 'engine/internal/server/web/worlds.js'));
  const { decideBoot, syncWait, SYNC_MIN_MS } = W;

  const row = (id, saved) => ({ id, saved_at: saved, name: 'x' });
  const scratch = (saved, canvas) => ({ savedAt: saved, ...(canvas ? { canvas } : {}), icons: [] });

  // N1 engine down + scratch → tombstone (today's exact behavior)
  ok('N1 engine-down+scratch → tombstone', decideBoot(null, scratch(5), null).source === 'tombstone');
  // N2 engine down + nothing → fresh
  ok('N2 engine-down+nothing → fresh', decideBoot(null, null, null).source === 'fresh');
  // N3 no rows + scratch → MIGRATE
  let d = decideBoot([], scratch(5), null);
  ok('N3 no rows+scratch → migrate', d.source === 'tombstone' && d.migrate === true && d.id === 'default');
  // N4 no rows + nothing → fresh migrate (the default canvas births)
  d = decideBoot([], null, null);
  ok('N4 no rows+nothing → fresh migrate', d.source === 'fresh' && d.migrate === true && d.id === 'default');
  // N5 rows + pointer match → that row
  d = decideBoot([row('a', 100), row('b', 200)], null, 'b');
  ok('N5 pointer match', d.source === 'engine' && d.id === 'b');
  // N6 stale pointer → first row (sort order)
  d = decideBoot([row('a', 100), row('b', 200)], null, 'ghost');
  ok('N6 stale pointer heals to first', d.source === 'engine' && d.id === 'a');
  // N7 THE HEAL: fresher scratch for the SAME row (post-migration ownership)
  d = decideBoot([row('a', 100)], scratch(5000, 'a'), 'a');
  ok('N7 heal: fresher owned scratch wins', d.source === 'tombstone' && d.resync === true && d.id === 'a');
  // N8 ownership guard: fresher scratch for ANOTHER row does NOT heal
  d = decideBoot([row('a', 100), row('b', 900)], scratch(5000, 'b'), 'a');
  ok('N8 foreign scratch never heals', d.source === 'engine' && d.id === 'a');
  // N9 legacy scratch (no canvas field, single row) may heal
  d = decideBoot([row('a', 100)], scratch(5000), 'a');
  ok('N9 legacy single-row scratch heals', d.source === 'tombstone' && d.resync === true);
  // N10 legacy scratch with MULTIPLE rows never heals (ambiguous)
  d = decideBoot([row('a', 100), row('b', 200)], scratch(5000), 'a');
  ok('N10 ambiguous legacy never heals', d.source === 'engine');
  // N11 the skew law: barely-fresher scratch does not heal (≥1s)
  d = decideBoot([row('a', 4999)], scratch(5000, 'a'), 'a');
  ok('N11 sub-skew scratch does not heal', d.source === 'engine');
  // N12 poison scratch (no savedAt) never heals
  d = decideBoot([row('a', 100)], { icons: [] }, 'a');
  ok('N12 poison scratch → engine', d.source === 'engine');

  // the cadence math
  ok('N13 syncWait: nothing dirty → -1', syncWait(Date.now(), 0, false) === -1);
  ok('N14 syncWait: fresh dirty → 0', syncWait(10000, 0, true) === 0);
  ok('N15 syncWait: within the window → waits the remainder', syncWait(10000, 9000, true) === SYNC_MIN_MS - 1000);
  ok('N16 syncWait: past the window → 0', syncWait(50000, 0, true) === 0);
  ok('N17 the cadence is calm (≥2s)', SYNC_MIN_MS >= 2000, `${SYNC_MIN_MS}ms`);
}

(async () => {
  console.log('v1424-ledger-rig — THE LEDGER (the engine-side canvas home)');
  await enginePhase();
  purePhase();
  console.log(`\n${pass} passed, ${fail} failed${fail ? '\nFAILED: ' + failures.join(' · ') : ''}`);
  process.exit(fail ? 1 : 0);
})();
