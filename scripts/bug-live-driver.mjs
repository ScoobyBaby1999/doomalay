#!/usr/bin/env node
// bug-live-driver.mjs — drives the REAL engine (direct nvidia path) through a
// two-round native tool chain against the mock provider and captures EVERY
// WebSocket frame in arrival order. Run from the repo root.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const PORT = 8533, MPORT = 8531, SID = 'bug-a-live';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(9); } catch {} });
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(1); });

// 1. mock provider + engine with the nvidia base-url override
procs.push(spawn('python3', [ROOT + 'scripts/bug-nvidia-mock.py', String(MPORT)], { stdio: 'inherit' }));
await sleep(500);
procs.push(spawn(ENG, ['--port', String(PORT), '--data-dir', '/tmp/doomalay-bug-a'], {
  env: { ...process.env, DOOMALAY_BASE_URL_NVIDIA: `http://127.0.0.1:${MPORT}/v1` },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
procs[1].stderr.on('data', d => process.stderr.write('[engine] ' + d));
for (let i = 0; i < 60; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }
console.log('engine up');

// 2. seed a nvidia key + create the session
await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', provider: 'nvidia', key: 'mock_key' });
await api('/api/sessions', 'POST', { id: SID, title: 'bug a', model: 'z-ai/glm-5.3-flash', provider: 'nvidia' });

// 3. the WS turn — capture every frame
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${SID}`);
const frames = [];
const done = new Promise(resolve => {
  ws.onopen = () => ws.send(JSON.stringify({ type: 'send', message: 'compute 2+2*10', model: 'z-ai/glm-5.3-flash', provider: 'nvidia' }));
  ws.onmessage = (e) => {
    try { frames.push(JSON.parse(e.data)); } catch { frames.push({ raw: e.data }); }
    const f = frames[frames.length - 1];
    if (f.type === 'status' && (f.state === 'idle' || f.state === 'error')) setTimeout(resolve, 400);
  };
  ws.onerror = (e) => { console.error('ws error', e.message || e); resolve(); };
  setTimeout(resolve, 25000);
});
await done;
ws.close();

// 4. print the WIRE ORDER (the event schema the UI actually receives)
console.log('\n=== WIRE ORDER (' + frames.length + ' frames) ===');
for (const f of frames) {
  let d = '';
  if (f.type === 'thinking' || f.type === 'assistant_delta' || f.type === 'assistant') d = ' text=' + JSON.stringify((f.text || '').slice(0, 70));
  if (f.type === 'round_end') d = ' [round segment boundary]';
  if (f.round) d += ' round:true';
  if (f.type === 'tool_use' || f.type === 'tool_result') d = ' name=' + f.name + ' summary=' + JSON.stringify((f.summary || '').slice(0, 40));
  if (f.type === 'status') d = ' state=' + f.state;
  console.log(`  i=${f.i} ${f.type}${d}`);
}
writeFileSync('/tmp/bug-a-frames.json', JSON.stringify(frames, null, 1));
console.log('\nframes → /tmp/bug-a-frames.json');

// 5. ALSO capture the REPLAY (a fresh connect with since=0) — what a reload rebuilds
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${SID}`);
const replay = [];
const done2 = new Promise(resolve => {
  ws2.onmessage = (e) => { try { replay.push(JSON.parse(e.data)); } catch {} 
    const f = replay[replay.length - 1];
    if (f && f.type === 'status' && (f.state === 'idle' || f.state === 'error')) setTimeout(resolve, 500); };
  setTimeout(resolve, 6000);
});
await done2; ws2.close();
console.log('\n=== REPLAY ORDER (' + replay.length + ' frames, fresh open since=0) ===');
for (const f of replay) {
  let d = '';
  if (f.type === 'thinking' || f.type === 'assistant_delta' || f.type === 'assistant') d = ' text=' + JSON.stringify((f.text || '').slice(0, 70));
  if (f.round) d += ' round:true';
  if (f.type === 'tool_use' || f.type === 'tool_result') d = ' name=' + f.name;
  if (f.type === 'status') d = ' state=' + f.state;
  console.log(`  i=${f.i} ${f.type}${d}`);
}
writeFileSync('/tmp/bug-a-replay.json', JSON.stringify(replay, null, 1));
killAll();
process.exit(0);
