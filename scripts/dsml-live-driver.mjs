#!/usr/bin/env node
// dsml-live-driver.mjs — v0.95.4 THE DSML FILTER live red-team.
//
// The live bug (the user's scooby export): the mock emits deepseek-style
// native tool markup (<｜DSML｜calls>…) AS CONTENT — no tools array, the
// exact shape a deepseek-family model produces when it falls back to its
// native markup on the TEXT protocol. Before v0.95.4 the markup streamed
// into the visible transcript and the call inside never executed.
//
// Verdicts (direct path, brain-less — the ACTION/ReAct consumer):
//   1. No 'DSML' substring in ANY assistant event (the markup never renders).
//   2. The rescued call EXECUTED — a calculator tool_use/tool_result pair
//      appears (the ACTION line was injected and parsed).
//   3. The prose around the markup survives.
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const PORT = 8539, MPORT = 8538;
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
procs.push(spawn(ENG, ['--port', String(PORT), '--data-dir', '/tmp/doomalay-dsml-rt'], {
  env: { ...process.env, DOOMALAY_BRAIN_DISABLE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
procs[1].stderr.on('data', d => process.stderr.write('[engine] ' + d));
for (let i = 0; i < 60; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }
console.log('engine up');

// Point nvidia at the mock via the engine's provider registry override env.
procs[1].kill(9);
procs.length = 1;
procs.push(spawn(ENG, ['--port', String(PORT), '--data-dir', '/tmp/doomalay-dsml-rt'], {
  env: { ...process.env, DOOMALAY_BASE_URL_NVIDIA: `http://127.0.0.1:${MPORT}/v1`, DOOMALAY_BRAIN_DISABLE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
procs[1].stderr.on('data', d => process.stderr.write('[engine] ' + d));
for (let i = 0; i < 60; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }

await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', provider: 'nvidia', key: 'mock_key' });
await api('/api/sessions', 'POST', { id: 'dsml-rt', title: 'dsml', model: MODEL, provider: 'nvidia' });

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=dsml-rt`);
const frames = [];
const done = new Promise(resolve => {
  ws.onopen = () => ws.send(JSON.stringify({ type: 'send', message: 'use dsml mode please', session_id: 'dsml-rt', model: MODEL, provider: 'nvidia' }));
  ws.onmessage = (e) => {
    try { frames.push(JSON.parse(e.data)); } catch { frames.push({ raw: e.data }); }
    const f = frames[frames.length - 1];
    if (f.type === 'status' && (f.state === 'idle' || f.state === 'error')) setTimeout(resolve, 500);
  };
  setTimeout(resolve, 30000);
});
await done;
ws.close();

let fails = 0;
const fail = (m) => { fails++; console.log('  ✗ ' + m); };
const pass = (m) => console.log('  ✓ ' + m);

const textFrames = frames.filter(f => (f.type === 'assistant_delta' || f.type === 'assistant') && f.text);
const allText = textFrames.map(f => f.text).join('');
const toolUses = frames.filter(f => f.type === 'tool_use');
const toolResults = frames.filter(f => f.type === 'tool_result');

if (/DSML/.test(allText)) fail('DSML markup leaked into the visible transcript');
else pass('no DSML markup anywhere in the visible stream');

if (toolUses.some(f => f.name === 'calculator')) pass('the rescued calculator call EXECUTED (tool_use seen)');
else fail('the rescued call never executed — no calculator tool_use');

if (toolResults.length > 0) pass('the tool result returned to the model');
else fail('no tool result');

if (/calculator now/.test(allText)) pass('the surrounding prose survived');
else fail('the prose around the markup was lost');

killAll();
console.log(fails ? `\nDSML RED-TEAM FAILED (${fails})` : '\nDSML RED-TEAM PASSED — markup stripped, call rescued, prose kept');
process.exit(fails ? 1 : 0);
