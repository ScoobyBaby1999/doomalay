#!/usr/bin/env node
// bug-brain-driver.mjs — drives the REAL engine WITH the REAL brain
// (strands + litellm + the mock nvidia provider) through a two-round native
// tool chain, capturing every WS frame. This is the path a desktop user on
// nvidia/mistral actually rides. Run from anywhere.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ENG = '/home/z/my-project/doomalay/engine/bin/doomalay-engine';
const PORT = 8534, MPORT = 8531, SID = 'bug-a-brain';
const WORK = '/tmp/bugbrain/work';          // engine CWD → ../brain = the patched copy
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

// 1. mock provider + engine (spawns the patched brain itself)
procs.push(spawn('python3', ['/home/z/my-project/doomalay/scripts/bug-nvidia-mock.py', String(MPORT)], { stdio: 'inherit' }));
await sleep(500);
procs.push(spawn(ENG, ['--port', String(PORT), '--data-dir', '/tmp/doomalay-bug-a-brain'], {
  cwd: WORK,
  env: { ...process.env, DOOMALAY_BASE_URL_NVIDIA: `http://127.0.0.1:${MPORT}/v1` },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
let engLog = '';
procs[1].stdout.on('data', d => { engLog += d; });
procs[1].stderr.on('data', d => { engLog += d; });
for (let i = 0; i < 80; i++) { try { await api('/api/health'); break; } catch { await sleep(500); } }
console.log('engine up (brain spawned from ' + WORK + '/../brain)');

// 2. seed a nvidia key + create the session
await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', provider: 'nvidia', key: 'mock_key' });
await api('/api/sessions', 'POST', { id: SID, title: 'bug a brain', model: 'nvidia/z-ai/glm-5.3-flash', provider: 'nvidia' });

// 3. the WS turn — capture every frame
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${SID}`);
const frames = [];
const done = new Promise(resolve => {
  ws.onopen = () => ws.send(JSON.stringify({ type: 'send', message: 'compute 2+2*10', model: 'nvidia/z-ai/glm-5.3-flash', provider: 'nvidia' }));
  ws.onmessage = (e) => {
    try { frames.push(JSON.parse(e.data)); } catch { frames.push({ raw: e.data }); }
    const f = frames[frames.length - 1];
    if (f.type === 'status' && (f.state === 'idle' || f.state === 'error')) setTimeout(resolve, 600);
  };
  ws.onerror = () => resolve();
  setTimeout(resolve, 60000);
});
await done;
try { ws.close(); } catch {}

console.log('\n=== BRAIN-PATH WIRE ORDER (' + frames.length + ' frames) ===');
for (const f of frames) {
  let d = '';
  if (f.type === 'thinking' || f.type === 'assistant_delta' || f.type === 'assistant') d = ' text=' + JSON.stringify((f.text || '').slice(0, 70));
  if (f.type === 'round_end') d = ' [boundary]';
  if (f.round) d += ' round:true';
  if (f.type === 'tool_use' || f.type === 'tool_result') d = ' name=' + f.name + ' summary=' + JSON.stringify((f.summary || '').slice(0, 40));
  if (f.type === 'status') d = ' state=' + f.state;
  if (f.type === 'progress') d = ' msg=' + JSON.stringify((f.message || f.text || '').slice(0, 50));
  if (f.type === 'error') d = ' ' + JSON.stringify(f).slice(0, 200);
  console.log(`  i=${f.i} ${f.type}${d}`);
}
writeFileSync('/tmp/bug-a-brain-frames.json', JSON.stringify(frames, null, 1));
if (!frames.length || frames[frames.length - 1].type !== 'status') {
  console.log('\n[engine log tail]\n' + engLog.split('\n').slice(-25).join('\n'));
}
killAll();
process.exit(0);
