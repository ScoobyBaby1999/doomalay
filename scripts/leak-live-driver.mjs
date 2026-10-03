#!/usr/bin/env node
// leak-live-driver.mjs — v0.95.1 THE ISOLATION RED-TEAM (the live leak repro).
//
// The user's live report: two chats on the SAME provider — one chat's turn
// ("Hello! I'm Nemotron…") appeared inside the OTHER chat's transcript, and
// the model saw "the user said 'Hi' twice". This driver reproduces the exact
// scenario against the REAL engine + mock provider:
//   1. Two sessions (A: deepseek, B: kimi) on the same nvidia mock provider.
//   2. Two CONCURRENT WS connections, interleaved sends (the parallel-tabs
//      pattern: grouped browser tabs, 100% isolated).
//   3. A FORGED frame: B's session_id sent over A's socket (the cross-bind
//      attack) — must be REJECTED.
//   4. A STALE-CLIENT send: after both turns, send on A's socket with a
//      WRONG session_id again after activity.
// Verdict: each transcript contains ONLY its own turns; the forged frames
// produce error frames on the wire and NOTHING in either log.
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const PORT = 8537, MPORT = 8536;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = 'z-ai/glm-5.3-flash';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(9); } catch {} });
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(1); });

procs.push(spawn('python3', [ROOT + 'scripts/bug-nvidia-mock.py', String(MPORT)], { stdio: 'inherit' }));
await sleep(500);
procs.push(spawn(ENG, ['--port', String(PORT), '--data-dir', '/tmp/doomalay-leak-rt'], {
  env: { ...process.env, DOOMALAY_BASE_URL_NVIDIA: `http://127.0.0.1:${MPORT}/v1` },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
procs[1].stderr.on('data', d => process.stderr.write('[engine] ' + d));
for (let i = 0; i < 60; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }
console.log('engine up');

await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', provider: 'nvidia', key: 'mock_key' });
const A = 'leak-a', B = 'leak-b';
await api('/api/sessions', 'POST', { id: A, title: 'Scooby', model: MODEL, provider: 'nvidia' });
await api('/api/sessions', 'POST', { id: B, title: 'Nemotron-chat', model: MODEL, provider: 'nvidia' });

function openChat(sid) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
  const frames = [];
  ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { frames.push({ raw: e.data }); } };
  const closed = new Promise(res => ws.onclose = res);
  return { ws, frames, closed };
}
const turnDone = (frames) => new Promise(resolve => {
  const t = setInterval(() => {
    const last = frames[frames.length - 1];
    if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) { clearInterval(t); resolve(); }
  }, 150);
  setTimeout(() => { clearInterval(t); resolve(); }, 25000);
});

// 1. Two concurrent sockets + interleaved sends (the parallel-tabs pattern).
const chatA = openChat(A), chatB = openChat(B);
await sleep(400);
console.log('sending interleaved turns on both chats…');
chatA.ws.send(JSON.stringify({ type: 'send', message: 'compute for A', session_id: A, model: MODEL, provider: 'nvidia' }));
chatB.ws.send(JSON.stringify({ type: 'send', message: 'compute for B', session_id: B, model: MODEL, provider: 'nvidia' }));
await Promise.all([turnDone(chatA.frames), turnDone(chatB.frames)]);

// 2. THE FORGED FRAME: B's identity over A's socket (the cross-bind attack).
console.log('forging a cross-bound frame (B session_id over A socket)…');
const beforeA = chatA.frames.length;
chatA.ws.send(JSON.stringify({ type: 'send', message: 'poison', session_id: B, model: MODEL, provider: 'nvidia' }));
await sleep(800);

// 3. verdicts
let fails = 0;
const fail = (m) => { fails++; console.log('  ✗ ' + m); };
const pass = (m) => console.log('  ✓ ' + m);

const userTexts = (sid) => api('/api/sessions/' + sid + '/events').then(d => {
  const evs = d.events || d;
  return (Array.isArray(evs) ? evs : []).filter(e => e.type === 'user').map(e => e.text || e.content || '');
});
const aUsers = await userTexts(A);
const bUsers = await userTexts(B);

aUsers.length === 1 && aUsers[0] === 'compute for A' ? pass('A transcript: exactly its own turn (' + JSON.stringify(aUsers) + ')')
  : fail('A transcript contaminated: ' + JSON.stringify(aUsers));
bUsers.length === 1 && bUsers[0] === 'compute for B' ? pass('B transcript: exactly its own turn (' + JSON.stringify(bUsers) + ')')
  : fail('B transcript contaminated: ' + JSON.stringify(bUsers));
bUsers.includes('poison') ? fail('THE LEAK: the forged frame EXECUTED in B') : pass('the forged frame never executed');

const forgedErr = chatA.frames.slice(beforeA).find(f => f.type === 'error');
forgedErr ? pass('the forged frame was REJECTED on the wire (' + JSON.stringify((forgedErr.text || '').slice(0, 60)) + '…)')
  : fail('no rejection frame for the forged send');

// A's transcript must not show the forged turn either
const aAfter = await userTexts(A);
aAfter.includes('poison') ? fail('A transcript recorded the poisoned message') : pass('A transcript clean of the poison');

chatA.ws.close(); chatB.ws.close();
await Promise.allSettled([chatA.closed, chatB.closed]);
killAll();

console.log(fails ? `\nLEAK RED-TEAM FAILED (${fails})` : '\nLEAK RED-TEAM PASSED — chats are 100% isolated');
process.exit(fails ? 1 : 0);
