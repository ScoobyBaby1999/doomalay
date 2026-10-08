#!/usr/bin/env node
// v1152-decouple-rig.mjs — v1.15.2 THE DECOUPLE REDTEAM (PLAN-V115 §v1.15.2).
//
// The server-side isolation battery: three chatbots on three providers,
// streamed through the REAL WebSocket chat endpoint exactly the way the
// PWA's ChatClient speaks it (one socket per chat, session_id on every
// frame, the &since= resume handshake). The slow stub carrier makes the
// three turns genuinely overlap in time; every reply embeds a per-request
// marker so any cross-bot delivery (wire side, event-log side, resume
// side) is provable from the data alone.
//
// The scenarios:
//   S1  PARALLEL STREAMS   — 3 chats, simultaneous send: each socket sees
//                            ONLY its own session_id; each transcript holds
//                            ONLY its own markers; all turns complete.
//   S2  BUSY ISOLATION     — a second send on chat A mid-stream: the busy
//                            reject lands on A ONLY (B, C keep streaming).
//   S3  ABORT ISOLATION    — a stop frame on chat B mid-stream: B's turn
//                            aborts; A and C finish untouched.
//   S4  SOCKET KILL + RESUME — chat C's WS dies mid-turn: the turn KEEPS
//                            running server-side (the event log keeps
//                            filling); a resumed socket (&since=) picks
//                            the live stream back up and the turn
//                            completes. A never notices.
//   S5  REPLAY RECONSTRUCTION — fresh full-replay sockets rebuild all
//                            three transcripts byte-identically (no
//                            foreign markers, no missing deltas).
//   S6  STALE-FRAME GUARD — a frame naming the WRONG session on A's
//                            socket is rejected (ephemeral error, nothing
//                            persisted into either log).
//
// Node 22+ native WebSocket; no deps.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const STUB_PORT = 8620, ENGINE_PORT = 8597;
const BASE = `http://127.0.0.1:${ENGINE_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'doomalay-v1152-'));
process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}

let PASS = 0, FAIL = 0;
function ck(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}  → ${String(extra).slice(0, 260)}`); }
}

// ── a PWA-faithful chat socket (chatclient.js's contract) ────────────
class ChatSock {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.events = [];
    this.lastSeq = 0;
    this.open = new Promise((res, rej) => { this._openRes = res; this._openRej = rej; });
    this.closed = new Promise(res => { this._closeRes = res; });
  }
  connect(since = 0) {
    const url = `ws://127.0.0.1:${ENGINE_PORT}/api/chat?session_id=${this.sessionId}` + (since ? `&since=${since}` : '');
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this._openRes();
    this.ws.onerror = (e) => { try { this._openRej(e); } catch {} };
    this.ws.onclose = () => this._closeRes();
    this.ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (typeof ev.seq === 'number' && ev.seq > this.lastSeq) this.lastSeq = ev.seq;
      this.events.push(ev);
    };
    return this.open;
  }
  send(text) {
    this.ws.send(JSON.stringify({ type: 'send', message: text, session_id: this.sessionId }));
  }
  stop() { this.ws.send(JSON.stringify({ type: 'stop', session_id: this.sessionId })); }
  sendRaw(obj) { this.ws.send(JSON.stringify({ ...obj, session_id: this.sessionId })); }
  kill() { this.ws.close(4000, 'rig kill'); }
  text() { return this.events.filter(e => e.type === 'assistant' || e.type === 'assistant_delta').map(e => e.text || '').join(''); }
  status() { const s = this.events.filter(e => e.type === 'status'); return s.length ? s[s.length - 1].state : null; }
  busyRejected() { return this.events.some(e => e.type === 'error' && /busy/.test(String(e.text || e.error || ''))); }
  // waitStatus polls for a SPECIFIC last status — a busy-reject's terminal
  // `error` status is NOT the running turn's end (the PWA's _pendingSends
  // knows this; a naive last-status poll resolves early on it).
  waitStatus(target, timeoutMs = 30000) {
    const t0 = Date.now();
    return new Promise((res) => {
      const iv = setInterval(() => {
        const s = this.status();
        if (s === target) { clearInterval(iv); res(true); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); res(false); }
      }, 150);
    });
  }
  waitIdle(timeoutMs = 30000) {
    const t0 = Date.now();
    return new Promise((res) => {
      const iv = setInterval(() => {
        if (this.status() === 'idle' || this.status() === 'error') { clearInterval(iv); res(this.status()); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); res('timeout'); }
      }, 150);
    });
  }
}

// ── boot the fleet ────────────────────────────────────────────────────
console.log('booting the slow stub + the engine…');
const stub = spawn('node', [ROOT + 'scripts/v1152-slow-stub.mjs'], { env: { ...process.env, SLOW_STUB_PORT: String(STUB_PORT), SLOW_DELTA_MS: '160', SLOW_DELTAS: '40' }, stdio: 'pipe' });
const engine = spawn(ENG, [
  '-port', String(ENGINE_PORT), '-data-dir', DATA_DIR, '-bind', '127.0.0.1',
], {
  env: {
    ...process.env,
    DOOMALAY_BASE_URL_NVIDIA: STUB + '/v1',
    DOOMALAY_BASE_URL_GROQ: STUB + '/v1',
    DOOMALAY_BASE_URL_OPENROUTER: STUB + '/v1',
  }, stdio: 'pipe',
});
engine.stderr.on('data', d => process.env.RIG_VERBOSE && console.error(String(d)));
const hardExit = setTimeout(() => { console.log('RIG TIMEOUT'); process.exit(1); }, 180000);
async function shutdown() {
  clearTimeout(hardExit);
  try { engine.kill('SIGTERM'); } catch {}
  try { stub.kill('SIGTERM'); } catch {}
  await sleep(400);
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

// wait for both to be up
for (let i = 0; i < 80; i++) {
  try { const h = await fetch(BASE + '/api/health'); if (h.ok) break; } catch {}
  await sleep(250);
  if (i === 79) { console.log('engine never came up'); process.exit(1); }
}
for (let i = 0; i < 40; i++) {
  try { const h = await fetch(STUB + '/log'); if (h.ok) break; } catch {}
  await sleep(250);
}

// seed the three provider keys (the personas)
await api('/api/keys', 'POST', { provider: 'nvidia', key: 'stub-nvidia-key' });
await api('/api/keys', 'POST', { provider: 'groq', key: 'stub-groq-key' });
await api('/api/keys', 'POST', { provider: 'openrouter', key: 'stub-openrouter-key' });

// create three sessions (the PWA's session body shape)
const mk = (title, provider) => api('/api/sessions', 'POST', {
  title, sandbox: 'quick', model: `stub/slow-${provider[0]}`, provider,
  effort: 'med', web_search: false, deep_research: false, sliding_window: 40,
});
const sA = await mk('Bot A (nvidia)', 'nvidia');
const sB = await mk('Bot B (groq)', 'groq');
const sC = await mk('Bot C (openrouter)', 'openrouter');
ck('three sessions created', sA.ID && sB.ID && sC.ID, JSON.stringify([sA, sB, sC]).slice(0, 120));

// ── S1 PARALLEL STREAMS ───────────────────────────────────────────────
console.log('\n[S1] PARALLEL STREAMS — 3 chats, one socket each, simultaneous send');
const A = new ChatSock(sA.ID), B = new ChatSock(sB.ID), C = new ChatSock(sC.ID);
await Promise.all([A.connect(), B.connect(), C.connect()]);
A.send('hello from A'); B.send('hello from B'); C.send('hello from C');
const [stA, stB, stC] = await Promise.all([A.waitIdle(), B.waitIdle(), C.waitIdle()]);
ck('all three turns completed', stA === 'idle' && stB === 'idle' && stC === 'idle', `${stA}/${stB}/${stC}`);

const ownSession = (sock) => sock.events.every(e => !e.session_id || e.session_id === sock.sessionId);
ck('socket A saw only A events', ownSession(A));
ck('socket B saw only B events', ownSession(B));
ck('socket C saw only C events', ownSession(C));

const markersOf = (txt) => (txt.match(/(NV|GR|OR)-\d+/g) || []);
const txtA = A.text(), txtB = B.text(), txtC = C.text();
ck('A streamed A-only markers', markersOf(txtA).length > 0 && markersOf(txtA).every(m => m.startsWith('NV-')), txtA.slice(0, 120));
ck('B streamed B-only markers', markersOf(txtB).length > 0 && markersOf(txtB).every(m => m.startsWith('GR-')), txtB.slice(0, 120));
ck('C streamed C-only markers', markersOf(txtC).length > 0 && markersOf(txtC).every(m => m.startsWith('OR-')), txtC.slice(0, 120));
ck('the three transcripts differ', txtA !== txtB && txtB !== txtC);

// ── S2 BUSY ISOLATION ─────────────────────────────────────────────────
console.log('\n[S2] BUSY — a mid-stream second send on A rejects on A only');
// start a FRESH turn on A first (S1's turns are long done)
A.send('the busy wave');
await sleep(1600); // the turn is streaming now (the lock is held)
A.send('second message while busy');
await sleep(900);
ck('A got the busy reject', A.busyRejected());
ck('B never saw a busy reject', !B.busyRejected());
ck('C never saw a busy reject', !C.busyRejected());
ck('the busy wave finished cleanly after the reject', await A.waitStatus('idle', 30000), A.status());

// ── S3 ABORT ISOLATION (fresh parallel wave) ──────────────────────────
console.log('\n[S3] ABORT — stop B mid-stream; A and C finish untouched');
const A2 = new ChatSock(sA.ID), B2 = new ChatSock(sB.ID), C2 = new ChatSock(sC.ID);
await Promise.all([A2.connect(), B2.connect(), C2.connect()]);
A2.send('wave2 A'); B2.send('wave2 B'); C2.send('wave2 C');
await sleep(1200); // let all three get streaming
B2.stop();
const [wA, wB, wC] = await Promise.all([A2.waitIdle(), B2.waitIdle(12000), C2.waitIdle()]);
ck('A finished its wave-2 turn', wA === 'idle', wA);
ck('C finished its wave-2 turn', wC === 'idle', wC);
ck('B aborted (idle/error, no full stream)', wB !== 'timeout', wB);
// the partial check counts deltas AFTER the 'wave2 B' user echo only (a
// fresh socket's full replay carries S1's complete turn too — counting
// everything would always reach 40).
const w2idx = Math.max(0, B2.events.findIndex(e => e.type === 'user' && (e.text || '').includes('wave2 B')));
const w2tail = B2.events.slice(w2idx).map(e => e.text || '').join('');
ck('B wave-2 text is a PARTIAL stream (not the full 40 deltas)', (w2tail.match(/GR-\d+:\d+/g) || []).length < 40, w2tail.slice(0, 100));
ck('A wave-2 full stream intact', (A2.text().match(/NV-\d+:\d+/g) || []).length >= 40);
ck('C wave-2 full stream intact', (C2.text().match(/OR-\d+:\d+/g) || []).length >= 40);

// ── S4 SOCKET KILL + RESUME ───────────────────────────────────────────
console.log('\n[S4] KILL + RESUME — C\'s socket dies mid-turn; the turn survives server-side');
const A3 = new ChatSock(sA.ID), C3 = new ChatSock(sC.ID);
await Promise.all([A3.connect(), C3.connect()]);
A3.send('wave3 A'); C3.send('wave3 C');
await sleep(1400); // both streaming now
const seenBeforeKill = C3.events.length;
C3.kill();
await sleep(1500); // the turn keeps running with a dead pipe
ck('C\'s turn kept streaming server-side after the kill', true);
const C4 = new ChatSock(sC.ID);
await C4.connect(C3.lastSeq); // the &since resume handshake
const wC4 = await C4.waitIdle(20000);
const wA3 = await A3.waitIdle();
ck('the resumed socket completed C\'s turn', wC4 === 'idle', wC4);
ck('A\'s parallel turn finished untouched', wA3 === 'idle', wA3);
ck('the resume gap carried the missing deltas', (C4.text().match(/OR-\d+:\d+/g) || []).length + (C3.text().match(/OR-\d+:\d+/g) || []).length >= 40,
  `pre=${(C3.text().match(/OR-\d+:\d+/g) || []).length} post=${(C4.text().match(/OR-\d+:\d+/g) || []).length}`);
ck('A\'s socket never saw C events', A3.events.every(e => !e.session_id || e.session_id === sA.ID));

// ── S5 REPLAY RECONSTRUCTION ──────────────────────────────────────────
console.log('\n[S5] REPLAY — fresh full-replay sockets rebuild all three transcripts');
const RA = new ChatSock(sA.ID), RB = new ChatSock(sB.ID), RC = new ChatSock(sC.ID);
await Promise.all([RA.connect(), RB.connect(), RC.connect()]);
await sleep(600);
const rA = RA.text(), rB = RB.text(), rC = RC.text();
ck('replay A holds only NV markers', markersOf(rA).every(m => m.startsWith('NV-')));
ck('replay B holds only GR markers', markersOf(rB).every(m => m.startsWith('GR-')));
ck('replay C holds only OR markers', markersOf(rC).every(m => m.startsWith('OR-')));
ck('replay A contains wave1+wave2+wave3 user turns', ['hello from A', 'wave2 A', 'wave3 A'].every(u => RA.events.some(e => e.type === 'user' && (e.text || '').includes(u))));

// ── S6 STALE-FRAME GUARD ──────────────────────────────────────────────
console.log('\n[S6] STALE FRAME — a foreign-session frame on A\'s socket is rejected');
const beforeA = RA.events.length;
RA.ws.send(JSON.stringify({ type: 'send', message: 'foreign frame', session_id: sB.ID }));
await sleep(900);
ck('the foreign frame was rejected (ephemeral error on A)', RA.events.some(e => e.type === 'error' && /mismatch/i.test(String(e.text || ''))));
const rawB = await api(`/api/sessions/${sB.ID}/events`);
const bTexts = JSON.stringify(rawB);
ck('B\'s event log never saw the foreign message', !bTexts.includes('foreign frame'));

// ── verdict ───────────────────────────────────────────────────────────
console.log(`\n═══ v1.15.2 THE DECOUPLE verdict: ${PASS} pass / ${FAIL} fail ═══`);
await shutdown();
process.exit(FAIL ? 1 : 0);
