#!/usr/bin/env node
// v1421-aged-state-rig.mjs — v1.42.1 THE LONG HAUL (PLAN-V142 §3.0): the
// aged-state harness. The plan's promise: the app must not degrade with
// install age — this rig inflates a fresh DataDir to a 90-day-equivalent
// shape and proves the phase's fixes hold END-TO-END against a real
// booted engine.
//
// PHASE A — the aged engine:
//   A1  clean boot: /api/health ok + the aged sessions created via the
//       REAL API (CreateSession's own defaults — a raw sqlite insert
//       leaves NULL columns ListSessions' scan rightly refuses)
//   A2  aged boot (121 sessions · ~46k events · 1.5k hub rows · ghost
//       freelist): health ok within the boot budget
//   A3  the boot heal closes EXACTLY the seeded pending sessions (each
//       ends with a healed status; the 2k-delta mega-pending shape too)
//   A4  closed sessions are untouched by the heal
//   A5  GET /api/storage/usage: the honest dashboard (counts match seeds
//       + the 9 heal appends)
//   A6  POST /api/storage/maintain {force}: ok + the WAL truncates
//   A7  the forced VACUUM reclaims the ghost session's freelist
//   A8  the OTA overlay sweep: the stray (deleted-in-manifest) files die,
//       the manifest-listed file survives (local manifest server)
//
// PHASE B — the aged WebView (the pure core, node-required):
//   N1  pruneMaps: live-keep / dead-drop / icon-cap / session-kind
//   N2  collectLiveIds: icons+chatbots legacy shape, poison tolerance
//
// Usage: node scripts/v1421-aged-state-rig.mjs
// (builds engine/doomalay-engine into /tmp when absent).

import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENGINE_SRC = path.join(ROOT, 'engine');
const PORT = 8421;
const MPORT = 8422;
const BASE = `http://127.0.0.1:${PORT}`;

// The session ids the seeder hangs events on.
const SESS_IDS = [];
for (let s = 0; s < 110; s++) SESS_IDS.push(`aged-closed-${String(s).padStart(3, '0')}`);
for (let s = 0; s < 8; s++) SESS_IDS.push(`aged-pending-${String(s).padStart(2, '0')}`);
SESS_IDS.push('aged-mega-pending', 'aged-closed-keep', 'aged-ghost');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  · ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  · ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureEngine() {
  const bin = path.join(os.tmpdir(), 'doomalay-engine-v1421');
  if (fs.existsSync(bin)) return bin;
  execFileSync('go', ['build', '-o', bin, './cmd/doomalay'], {
    cwd: ENGINE_SRC,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  return bin;
}

async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === 'ok') return { ms: Date.now() - t0, j };
      }
    } catch (e) { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(120);
  }
}

function stopEngine(child) {
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch (e) {}
  }
}

// ── the aged-state seeder (python rides sqlite directly — ONE
//    transaction; the fsync lesson: per-row AppendEvent would take
//    minutes on this rig's filesystem). Session ROWS were created
//    through the engine API beforehand; python seeds events + hub. ──
function seedAged(dataDir) {
  const script = [
    'import json, sqlite3, sys, time',
    'db = sqlite3.connect(sys.argv[1] + "/doomalay.db")',
    'cur = db.cursor()',
    'now = time.time()',
    'EV = []',
    'def turn(sid, n, closed=True, seq=1):',
    '    EV.append((sid, seq, "user", "question text", "", now)); seq += 1',
    '    EV.append((sid, seq, "status", json.dumps({"state":"running"}), "", now)); seq += 1',
    '    for i in range(n):',
    '        EV.append((sid, seq, "assistant_delta", "delta chunk " + str(i), "", now)); seq += 1',
    '    if closed:',
    '        EV.append((sid, seq, "status", json.dumps({"state":"idle","usage":{}}), "", now)); seq += 1',
    '    return seq',
    'for s in range(110):',
    '    sid = "aged-closed-%03d" % s',
    '    seq = 1',
    '    for t in range(4):',
    '        seq = turn(sid, 98, True, seq)',
    'for s in range(8):',
    '    turn("aged-pending-%02d" % s, 8, False, 1)',
    'turn("aged-mega-pending", 2000, False, 1)',
    'turn("aged-closed-keep", 6, True, 1)',
    'turn("aged-ghost", 2500, True, 1)',
    'cur.executemany("INSERT OR IGNORE INTO chat_events (session_id, seq, event_type, content, tool_use_id, created_at) VALUES (?,?,?,?,?,?)", EV)',
    'cur.execute("DELETE FROM chat_events WHERE session_id = ?", ("aged-ghost",))',
    'HUB = []',
    'for i in range(1500):',
    '    HUB.append(("persona", "p%04d" % i, "user/datasets-doomalay-persona", "Persona %d" % i,',
    '                json.dumps({"id": "p%04d" % i, "type": "persona", "name": "Persona %d" % i, "repo": "user/datasets-doomalay-persona", "tags": []}),',
    '                "x" * 2000, 0, None, "2026-08-%02d" % ((i % 28) + 1), 0, ""))',
    'cur.executemany("INSERT OR IGNORE INTO hub_items (type, id, repo, name, meta, payload, hearted, hearted_at, downloaded_at, via_collection, collection) VALUES (?,?,?,?,?,?,?,?,?,?,?)", HUB)',
    'db.commit()',
    'print(json.dumps({"sessions": 121, "events": len(EV) - 2503, "hub": len(HUB)}))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, dataDir], { encoding: 'utf8' }).trim();
  return JSON.parse(out.split('\n').pop());
}

// ── the local manifest server (the OTA sweep E2E) ──────────────────
function startManifestServer(dir) {
  const manifest = {
    version: 'v0.0.0-rig',
    ref: 'main',
    min_engine: 'v0.0.0',
    files: [
      { path: 'engine/internal/server/web/app.js', sha256: '0'.repeat(64), size: 1 },
      { path: 'engine/internal/server/web/hub.js', sha256: '0'.repeat(64), size: 1 },
    ],
  };
  fs.writeFileSync(path.join(dir, 'patch-manifest.json'), JSON.stringify(manifest));
  const child = spawn('python3', ['-m', 'http.server', String(MPORT), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
  return child;
}

// ── PHASE A ─────────────────────────────────────────────────────────
async function phaseA() {
  console.log('PHASE A — the aged engine');
  const bin = ensureEngine();

  // A1: clean boot (also migrates the schema + hosts the session creates).
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'v1421-aged-'));
  let child = spawn(bin, ['--port', String(PORT), '--data-dir', dir1], {
    env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let h = await waitHealth(15000);
  ok('A1 clean boot health', !!h);
  if (h) {
    let created = 0;
    for (const id of SESS_IDS) {
      try {
        const r = await fetch(`${BASE}/api/sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, title: id, model: 'test/model', provider: 'test' }),
        });
        if (r.status === 201) created++;
      } catch (e) { /* counted below */ }
    }
    ok('A1b aged sessions created via API', created === SESS_IDS.length, `${created}/${SESS_IDS.length}`);
  }
  stopEngine(child);
  await sleep(400);

  // seed the aged state (events + hub rows into the API-created sessions)
  const seeded = seedAged(dir1);
  console.log(`  seeded: ${seeded.sessions} sessions · ${seeded.events} events · ${seeded.hub} hub rows`);

  // the aged boot: OTA pointed at the local manifest server (A8 rides it)
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1421-manifest-'));
  const msrv = startManifestServer(mdir);
  const otaDir = path.join(dir1, 'ota');
  fs.mkdirSync(otaDir, { recursive: true });
  fs.writeFileSync(path.join(otaDir, 'app.js'), 'the kept overlay bytes');
  fs.writeFileSync(path.join(otaDir, 'sandboxpicker.js'), 'the resurrected deletion'); // the v1.17.1 shape
  fs.writeFileSync(path.join(otaDir, 'legacy-gone.css'), 'another stray');

  const t0 = Date.now();
  child = spawn(bin, ['--port', String(PORT), '--data-dir', dir1], {
    env: { ...process.env, DOOMALAY_OTA_URL: `http://127.0.0.1:${MPORT}/patch-manifest.json` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  child.stdout.on('data', (d) => { engineLog += d; });
  child.stderr.on('data', (d) => { engineLog += d; });

  h = await waitHealth(20000);
  const bootMs = Date.now() - t0;
  ok('A2 aged boot health', !!h, `boot→health ${bootMs}ms (budget 4000ms)`);
  ok('A2b aged boot budget', !!h && bootMs < 4000);

  // A3: the heal closed exactly the pending sessions
  let healedAll = true, megaHealed = true;
  for (let i = 0; i < 8; i++) {
    const sid = `aged-pending-${String(i).padStart(2, '0')}`;
    const r = await fetch(`${BASE}/api/sessions/${sid}/events`);
    const j = await r.json();
    const evs = j.events || [];
    const last = evs[evs.length - 1];
    if (!last || last.type !== 'status' || last.state !== 'error' || last.healed !== true) healedAll = false;
  }
  ok('A3 heal closes every pending session', healedAll, healedAll ? '' : 'engine log tail: ' + engineLog.split('\n').slice(-4).join(' | '));
  {
    const r = await fetch(`${BASE}/api/sessions/aged-mega-pending/events`);
    const j = await r.json();
    const evs = j.events || [];
    const last = evs[evs.length - 1];
    megaHealed = !!last && last.type === 'status' && last.state === 'error' && last.healed === true;
  }
  ok('A3b heal closes the 2k-delta mega-pending', megaHealed);

  // A4: the closed session is untouched
  {
    const r = await fetch(`${BASE}/api/sessions/aged-closed-keep/events`);
    const j = await r.json();
    const evs = j.events || [];
    const want = 1 + 1 + 6 + 1; // user + running + 6 deltas + idle
    ok('A4 closed session untouched by heal', evs.length === want, `${evs.length} events (want ${want})`);
  }

  // A5: the storage usage dashboard
  {
    const r = await fetch(`${BASE}/api/storage/usage`);
    const j = await r.json();
    const e = j.engine || {};
    ok('A5 usage counts', e.sessions === seeded.sessions && e.hub_items === seeded.hub && e.chat_events === seeded.events + 9,
      `sessions ${e.sessions}/${seeded.sessions} · events ${e.chat_events} (want ${seeded.events + 9} incl. 9 heals) · hub ${e.hub_items}/${seeded.hub}`);
    ok('A5b usage shape', typeof e.db_bytes === 'number' && typeof e.wal_bytes === 'number' && typeof e.last_vacuum_at === 'number' && !!j.overlay);
  }

  // A6+A7: the forced maintain pass
  {
    const r = await fetch(`${BASE}/api/storage/maintain`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
    });
    const j = await r.json();
    const rep = j.report || {};
    const walPath = path.join(dir1, 'doomalay.db-wal');
    const walAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    ok('A6 maintain ok + vacuum ran', j.ok === true && rep.VacuumRan === true,
      `wal ${rep.WALBytesPre}→${rep.WALBytesPost}, on disk ${walAfter}B`);
    ok('A6b wal truncated on disk', walAfter < 64 * 1024);
    ok('A7 freelist reclaimed', rep.FreePages <= Math.floor(rep.PageCount * 0.05),
      `freelist ${rep.FreePages}/${rep.PageCount} pages`);
    const r2 = await fetch(`${BASE}/api/storage/usage`);
    const j2 = await r2.json();
    ok('A7b vacuum stamped', (j2.engine || {}).last_vacuum_at > 0);
  }

  // A8: the OTA overlay sweep (the background refresher ran at boot)
  await sleep(1500);
  {
    const strayGone = !fs.existsSync(path.join(otaDir, 'sandboxpicker.js'));
    const stray2Gone = !fs.existsSync(path.join(otaDir, 'legacy-gone.css'));
    const kept = fs.existsSync(path.join(otaDir, 'app.js'));
    ok('A8 overlay sweep: strays removed', strayGone && stray2Gone);
    ok('A8b overlay sweep: manifest file kept', kept);
    ok('A8c sweep logged', /overlay sweep removed 2 file/i.test(engineLog));
  }

  stopEngine(child);
  try { msrv.kill('SIGKILL'); } catch (e) {}
  fs.rmSync(dir1, { recursive: true, force: true });
  fs.rmSync(mdir, { recursive: true, force: true });
}

// ── PHASE B (the pure core, node-required) ──────────────────────────
function phaseB() {
  console.log('PHASE B — the aged WebView (pure core)');
  const core = require(path.join(ROOT, 'engine', 'internal', 'server', 'web', 'storagehygiene.js'));
  const { pruneMaps, collectLiveIds, MAP_KEYS } = core;

  const live = { icons: ['chat_a', 'chat_b'], sessions: ['s1', 's2'] };
  let r = pruneMaps({ chat_a: 10, chat_dead: 20, chat_b: 30 }, 'icon', live, 0);
  ok('N1 icon map: live kept, dead dropped', r.kept === 2 && r.dropped === 1 && !r.map.chat_dead && r.map.chat_a === 10 && r.map.chat_b === 30);
  r = pruneMaps({ s1: 'draft', s9: 'gone' }, 'session', live, 0);
  ok('N1b session map: live kept, dead dropped', r.kept === 1 && r.dropped === 1 && r.map.s1 === 'draft');
  const capped = {};
  for (let i = 0; i < 80; i++) capped['chat_' + i] = i;
  const liveAll = { icons: Object.keys(capped), sessions: [] };
  r = pruneMaps(capped, 'icon', liveAll, 60);
  ok('N1c icon cap 60 enforced', Object.keys(r.map).length === 60 && r.map['chat_79'] === 79 && !r.map['chat_0']);
  r = pruneMaps(null, 'icon', live, 0);
  ok('N1d poison map tolerated', r.kept === 0 && r.dropped === 0);

  let ids = collectLiveIds(JSON.stringify({ icons: [{ id: 'chat_a', sessionId: 's1', type: 'chat' }, { id: 'web_1' }, 'poison', null] }));
  ok('N2 icons + sessions collected, poison skipped', ids.icons.length === 2 && ids.sessions.length === 1 && ids.icons.includes('chat_a') && ids.sessions.includes('s1'));
  ids = collectLiveIds(JSON.stringify({ chatbots: [{ id: 'old_1', sessionId: 's0' }] }));
  ok('N2b legacy chatbots key honored', ids.icons.includes('old_1') && ids.sessions.includes('s0'));
  ids = collectLiveIds('not json at all');
  ok('N2c corrupt state tolerated', ids.icons.length === 0 && ids.sessions.length === 0);
  ok('N2d the four maps registered', Object.keys(MAP_KEYS).length === 4);
}

// ── main ────────────────────────────────────────────────────────────
(async () => {
  console.log('v1421-aged-state-rig — THE LONG HAUL (install-age degradation)');
  try { await phaseA(); } catch (e) { fail++; failures.push('phaseA crashed'); console.log('  FAIL  phaseA crashed: ' + e.message); }
  try { phaseB(); } catch (e) { fail++; failures.push('phaseB crashed'); console.log('  FAIL  phaseB crashed: ' + e.message); }
  console.log(`\nRESULT: ${pass} PASS · ${fail} FAIL`);
  if (fail) { console.log('failures: ' + failures.join(', ')); process.exit(1); }
  process.exit(0);
})();
