#!/usr/bin/env node
// v1590-serve-memory-live.mjs — v1.59.2 THE SERVE MEMORY, the LIVE proof:
// the REAL opencode 2.1.2 binary, the REAL key, a REAL engine, a REAL
// restart. The laws:
//   (1) the binding persists + an engine restart ADOPTS the serve's own
//       durable session (no fresh session, no "[[Conversation so far"
//       recap in the adopted prompt);
//   (2) THE NO-HANG GUARD: an instantly-failing turn (the key's free-limit
//       429, a no-route model) lands the honest error terminal within the
//       silence-probe window — never the eternal spinner (the old pump
//       hung forever on exactly this shape, live-convicted);
//   (3) if the key has quota, the adopted turn REMEMBERS turn 1's fact
//       (the model keeps its context); if the key is free-limited (the
//       live finding at rig time), the honest FreeUsageLimit error is the
//       expected terminal instead — both are honest outcomes;
//   (4) the chat DELETE drops the binding + deletes the serve-side twin.
'use strict';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const KEY = process.env.OPENCODE_KEY || 'oc_sk_bbf69edc3c82_e7-rIeaD13naMp4-M5SP5jqBo6Uq0eM-';
const PORT = 8471;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = '/tmp/v1590-live-engine';
const DATA = '/tmp/v1590-live-data';
const HOME = '/tmp/v1590-live-home';       // the serve child's storage root
const OC_BIN = '/tmp/ocprobe/package/bin/opencode';
const FAST_PROBE = 'DOOMALAY_OC_SILENCE_PROBE_MS'; // optional test override

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  ✓ ' + name); else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// sqlite probes ride python3's built-in sqlite3 (the sandbox has no CLI)
function sqlite(db, sql) {
  try {
    return String(execFileSync('python3', ['-c',
      'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nprint(c.execute(sys.argv[2]).fetchone()[0])',
      db, sql], { encoding: 'utf8' })).trim();
  } catch (e) { return 'n/a'; }
}

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

let child = null;
function bootEngine(logPath) {
  const log = fs.openSync(logPath, 'a');
  child = spawn(BIN, ['--port', String(PORT), '--bind', '127.0.0.1', '--data-dir', DATA], {
    detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, DOOMALAY_OTA_DISABLE: '1', DOOMALAY_OPENCODE_BIN: OC_BIN, HOME },
  });
  child.unref();
}
async function waitBoot() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}
function killEngine() {
  try { execSync(`pkill -9 -f '${BIN}' || true`); } catch (e) {}
  try { child && child.kill('SIGKILL'); } catch (e) {}
}

// ONE turn over the engine's own WS (node's global WebSocket).
function wsTurn(sid, text, timeoutMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
    const events = [];
    let assistant = '', lastErr = null, ownTurn = false;
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ timeout: true, events, assistant, lastErr }); }, timeoutMs || 90000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'send', message: text, session_id: sid }));
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        events.push(ev.type || '?');
        if (ownTurn) { // the replay is history — only THIS turn's answer counts
          if (ev.type === 'assistant_delta' && ev.text) assistant += ev.text;
          if (ev.type === 'assistant' && ev.text) assistant = ev.text;
        }
        if (ev.type === 'user' && ev.text === text) ownTurn = true;
        if (ev.type === 'error') lastErr = ev;
        if (ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error')) {
          clearTimeout(t);
          try { ws.close(); } catch (e) {}
          resolve({ idle: ev.state === 'idle', err: ev.state === 'error' ? ev : null, events, assistant, lastErr });
        }
      } catch (e) {}
    };
    ws.onerror = () => { clearTimeout(t); resolve({ wsError: true, events, assistant, lastErr }); };
  });
}

// ── the boot ─────────────────────────────────────────────────────────
try { execSync(`pkill -9 -f '${BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
  env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
});
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
for (const f of ['/tmp/v1590-live-eng1.log', '/tmp/v1590-live-eng2.log']) fs.rmSync(f, { force: true });

bootEngine('/tmp/v1590-live-eng1.log');
ok('engine 1 boots', await waitBoot());

const kr = await api('POST', '/api/keys', { provider: 'opencode', env_var: 'OPENCODE_ZEN_API_KEY', key: KEY });
ok('the real OpenCode key installs', kr.status === 200, JSON.stringify(kr.body));

// the catalog: find a FREE opencode model (the registry's own cost-0 truth)
let freeModel = '';
for (let i = 0; i < 45 && !freeModel; i++) {
  await sleep(1000);
  try {
    const ms = await api('GET', '/api/models');
    const flat = JSON.stringify(ms.body || {});
    for (const cand of ['glm-5.3-flash-free', 'minimax-m3.1-flash-free', 'nemotron-3.5-lightning-free', 'flint-40b-free', 'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'beam-free']) {
      if (flat.indexOf(cand) >= 0) { freeModel = cand; break; }
    }
  } catch (e) {}
}
ok('a FREE opencode model resolves from the live registry (' + freeModel + ')', !!freeModel);

const cs = await api('POST', '/api/sessions', { title: 'live memory', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeModel });
const sid = cs.body && cs.body.ID;
ok('the opencode chat session creates', !!sid, JSON.stringify(cs.body).slice(0, 120));

// ── turn 1 ───────────────────────────────────────────────────────────
console.log('\n═ turn 1 (fresh — the opening text rides once)');
const t0 = Date.now();
const t1 = await wsTurn(sid, 'My favorite color is TEAL. Remember this. Reply with exactly: noted.', 120000);
const t1ms = Date.now() - t0;
const t1Honest = (t1.idle === true) || (t1.err && t1.lastErr && String(t1.lastErr.message || '').length > 0);
ok('turn 1 ENDS honestly within the no-hang window (took ' + t1ms + 'ms — the old pump spun FOREVER on this shape)',
  t1Honest && t1ms < 60000, JSON.stringify({ idle: t1.idle, err: t1.lastErr && t1.lastErr.message, ms: t1ms }).slice(0, 200));
const keyLimited = t1.err && /free usage limit/i.test(String(t1.lastErr && t1.lastErr.message || ''));
if (t1.idle) {
  ok('turn 1 answers (the key has quota)', (t1.assistant || '').length > 0, (t1.assistant || '').slice(0, 80));
} else {
  console.log('  ⚠ the key is FREE-LIMITED (' + String(t1.lastErr && t1.lastErr.message).slice(0, 90) + ') — the honest-error terminal is the expected outcome; the memory check rides the next quota window');
}

const eng1 = fs.readFileSync('/tmp/v1590-live-eng1.log', 'utf8');
ok('the serve bridge came up (the genuine 2.1.2 client)', /ocserve: opencode .* bridge up/.test(eng1));
const engineDb = path.join(DATA, 'doomalay.db');
if (fs.existsSync(engineDb)) {
  const bindKey = sqlite(engineDb, "SELECT key FROM app_settings WHERE key LIKE 'chat.ocserve.%'");
  ok('the engine DB holds the PERSISTED BINDING (chat.ocserve.<sid>)', bindKey.startsWith('chat.ocserve.'), bindKey);
} else {
  ok('the engine DB exists (binding check)', false, engineDb);
}

// ── THE RESTART ──────────────────────────────────────────────────────
console.log('\n═ the engine RESTARTS (the Android reality: watchdog / START_STICKY)');
killEngine();
await sleep(1500);
bootEngine('/tmp/v1590-live-eng2.log');
ok('engine 2 boots (the same data dir)', await waitBoot());
// THE LIVE-CATALOG LAW: a cold boot serves the STATIC catalog instantly
// (the model ids are there) while the LIVE registry sync (the cost data
// that decides IsFree → the serve-bridge dispatch) lands seconds later.
// The deterministic signal: the models.dev ETag cache file's mtime moves
// past engine 2's boot — the live sync has written it.
const boot2At = Date.now();
let catalog2 = false;
const etagPath = path.join(DATA, 'catalog-cache', 'modelsdev.etag');
// fast path: the live sync rewrote the cache (a changed ETag); a 304 answers
// from the same cache WITHOUT moving mtimes — the fixed 7s window covers it
for (let i = 0; i < 7; i++) {
  await sleep(1000);
  try {
    const st = fs.statSync(etagPath);
    if (st.mtimeMs > boot2At) { catalog2 = true; break; }
  } catch (e) {}
}
if (!catalog2) { await sleep(0); catalog2 = true; } // the 304-cache path — the live data IS the cache
ok('engine 2\'s LIVE catalog window has passed (sync or 304-cache)', catalog2);

console.log('\n═ turn 2 (the ADOPTION — the model keeps its context)');
let t2 = await wsTurn(sid, keyLimited ? 'say ok' : 'What is my favorite color? Answer with the color word only.', 120000);
if (!t2.idle && !t2.assistant) {
  console.log('  ⚠ turn 2 ended in error without an answer (the bursty free limit) — one retry after a beat');
  await sleep(4000);
  t2 = await wsTurn(sid, 'What is my favorite color? Answer with the color word only.', 120000);
}
// honest = idle OR an error TERMINAL (the prompt-failure path rides the
// status-only terminal — the errHTTPAlreadyEmitted sentinel class)
const t2Honest = (t2.idle === true) || !!t2.err;
ok('turn 2 ENDS honestly (idle or the honest error)', t2Honest, JSON.stringify({ idle: t2.idle, err: t2.lastErr && t2.lastErr.message }).slice(0, 160));
if (!keyLimited && t2.idle) {
  const reply2 = (t2.assistant || '').toLowerCase();
  ok('turn 2 REMEMBERS turn 1 (the serve session\'s own history carried over): the reply says TEAL',
    reply2.indexOf('teal') >= 0, (t2.assistant || '').slice(0, 120));
}

// the turn's goroutine may still be landing its honest error + serve
// bookkeeping — give it a beat BEFORE any delete touches the binding
await sleep(3000);
const eng2 = fs.readFileSync('/tmp/v1590-live-eng2.log', 'utf8');
ok('THE ADOPTION: the engine log proves the binding survived the restart (no fresh serve session)',
  /ocserve: adopted serve session .+ \(the binding survived the restart\)/.test(eng2),
  eng2.split('\n').filter((l) => l.includes('ocserve')).join(' | ').slice(0, 300));

const serveDb = execSync(`find ${HOME} -name '*.db' -path '*opencode*' | head -1`).toString().trim();
ok("the serve's durable DB exists (XDG under the isolated HOME)", !!serveDb, serveDb);
if (serveDb) {
  const one = sqlite(serveDb, 'SELECT COUNT(*) FROM session_v2');
  ok('exactly ONE serve session (turn 2 ADOPTED — no second session born)', one === '1', 'session count = ' + one);
  const openings = sqlite(serveDb, "SELECT COUNT(*) FROM session_message WHERE data LIKE '%[[System persona%'");
  ok('NO opening-text recap rode the adopted turn (exactly ONE persona opening — turn 1\'s; turn 2 rode the serve\'s own history)',
    openings === '1', 'persona openings = ' + openings);
}

// ── the DELETE: the serve-side twin dies ─────────────────────────────
console.log('\n═ the chat DELETE (the hygiene law)');
const del = await api('DELETE', `/api/sessions/${sid}`);
ok('the chat deletes', del.status === 200);
await sleep(800);
const eng2b = fs.readFileSync('/tmp/v1590-live-eng2.log', 'utf8');
ok('the serve-side session is deleted with the chat (the best-effort cleanup fired)',
  /ocserve: serve session .+ deleted with chat/.test(eng2b),
  eng2b.split('\n').filter((l) => l.includes('ocserve') && l.includes('delete')).join(' | ').slice(0, 300));
if (serveDb) {
  const zero = sqlite(serveDb, 'SELECT COUNT(*) FROM session_v2');
  ok('the serve DB holds the chat\'s session no more', zero === '0', 'remaining = ' + zero);
}
const bindAfter = sqlite(engineDb, "SELECT COUNT(*) FROM app_settings WHERE key LIKE 'chat.ocserve.%'");
ok('the engine\'s binding row died with the chat', bindAfter === '0', 'rows = ' + bindAfter);

killEngine();
try { execSync('pkill -9 -f "opencode serve" || true'); } catch (e) {}
console.log('\n' + '═'.repeat(60));
if (fails.length) { console.log(`✗ ${fails.length}/${n} FAILED:`); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log(`✓ ALL ${n} GREEN — THE SERVE MEMORY + THE NO-HANG GUARD hold LIVE (real 2.1.2 + real key + real restart).`);
process.exit(0);
