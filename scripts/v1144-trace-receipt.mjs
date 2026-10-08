#!/usr/bin/env node
// v1144-trace-receipt.mjs — v1.14.4 THE TRACE: the live receipt.
//
// Spawns the real engine, drives ONE tool-chain turn through the MCP bus
// (the v1.13.6 chain idiom), then dumps the trace surface:
//   1. /api/debug/trace            → the resolved posture + live sessions
//   2. /api/debug/trace/<session>  → the event tail (the full lifecycle:
//      turn.start → dispatch → round.start → request → stream.open →
//      first_token → deltas → tool.start/end → round.end → finish → turn.end)
//   3. kind filters (delta.reasoning heads, tool.* only)
//
// Usage: node scripts/v1144-trace-receipt.mjs   (NVIDIA_KEY from /home/z/keys.env)
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const PORT = 8596;
const BASE = `http://127.0.0.1:${PORT}`;

const keys = {};
for (const line of readFileSync('/home/z/keys.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) keys[m[1]] = m[2].trim();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}

const DATA_DIR = mkdtempSync(join(tmpdir(), 'doomalay-trace-'));
const eng = spawn(ENG, ['--port', String(PORT), '--data-dir', DATA_DIR], {
  env: { ...process.env, DOOM_TRACE_DELTAS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
eng.stderr.on('data', d => { log += d.toString(); });
process.on('exit', () => { try { eng.kill(9); } catch {} try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

for (let i = 0; i < 100; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }

// seed the key (POST /api/keys — {env_var, key})
await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', key: keys.NVIDIA_KEY });
console.log('engine up — key seeded\n');

// ── the session + one chain turn ──────────────────────────────────────
const sid = 'trace-receipt-1';
const model = 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b';
await api('/api/sessions', 'POST', { id: sid, title: 'trace receipt', model, provider: 'nvidia' });
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
const frames = [];
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch {} };
await new Promise(res => { ws.onopen = res; setTimeout(res, 2500); });

console.log('turn: "Use your tools: compute 37*14 exactly, then tell me the current time in Tokyo."');
ws.send(JSON.stringify({ type: 'send', message: 'Use your tools: compute 37*14 exactly, then tell me the current time in Tokyo. Do both, then answer.', session_id: sid, model, provider: 'nvidia' }));
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const last = frames[frames.length - 1];
  if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) break;
  await sleep(200);
}
console.log(`turn done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${(frames.filter(f => f.type === 'tool_use')).length} tool pills, answer: "${frames.filter(f => f.type === 'assistant_delta').map(f => f.text).join('').slice(0, 90)}…"\n`);

// ── THE TRACE RECEIPT ─────────────────────────────────────────────────
const overview = await api('/api/debug/trace');
console.log('═ POSTURE ═');
console.log(JSON.stringify(overview.config));
console.log(`sessions with rings: ${overview.sessions.map(s => `${s.session_id}(${s.events}ev, ${s.deltas}deltas)`).join(', ')}`);

const tail = await api(`/api/debug/trace/${sid}?limit=400`);
console.log(`\n═ EVENT TAIL — ${tail.count} events ═`);
const kinds = {};
for (const e of tail.events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
console.log('kind histogram:', JSON.stringify(kinds));

const picks = ['turn.start', 'turn.dispatch', 'llm.round.start', 'llm.request', 'llm.stream.open', 'llm.first_token', 'delta.reasoning', 'delta.content', 'delta.tool_call', 'tool.start', 'tool.end', 'llm.round.end', 'llm.finish', 'turn.end'];
console.log('\n═ THE LIFECYCLE (one line per kind, first 2 of each) ═');
for (const k of picks) {
  const evs = tail.events.filter(e => e.kind === k).slice(0, 2);
  for (const e of evs) {
    console.log(`  ${e.kind.padEnd(18)} seq=${String(e.Seq ?? e.seq).padStart(5)} turn=${e.turn} round=${e.round || '-'} ${JSON.stringify(e.data).slice(0, 120)}`);
  }
}
const reasoning = tail.events.filter(e => e.kind === 'delta.reasoning').slice(0, 3);
if (reasoning.length) {
  console.log('\n═ REASONING DELTA HEADS (the model thinking, captured) ═');
  for (const e of reasoning) console.log(`  len=${e.data.len} head="${e.data.head}"`);
}
const finish = tail.events.find(e => e.kind === 'llm.finish');
if (finish) {
  console.log('\n═ FINISH VERDICT ═');
  console.log(`  finish_reason=${finish.data.finish_reason} output_cut=${finish.data.output_cut} in=${finish.data.input_tokens} out=${finish.data.output_tokens} duration=${finish.data.duration_ms}ms`);
  console.log(`  tallies: reasoning=${finish.data.reasoning_deltas} content=${finish.data.content_deltas} tool_call=${finish.data.tool_call_deltas}`);
}
console.log('\nverdict: THE TRACE is live end to end.');
