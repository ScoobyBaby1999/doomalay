#!/usr/bin/env node
// v113-mcp-live-driver.mjs — v1.13.3 THE GUT live verification (PLAN-V113).
//
// Drives the REAL engine with REAL provider keys (OpenRouter + Nvidia +
// Mistral — the user's keys) through the panel's own WebSocket protocol:
//   1. THE CALCULATOR CHAIN — one turn, two+ native tool_calls through
//      the MCP bus (calculator + time_now): pills, results, final answer.
//   2. THE LIVE WEB — web_search through the bus: sources event + answer.
//   3. THE ARTIFACT — zip_create through the bus: the artifact card rides
//      the tool_result (the download contract).
// Verdict: every turn ends idle, every tool_use has its tool_result,
//      no error frames, and the answers reference the tool outputs.
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const PORT = 8591;
const BASE = `http://127.0.0.1:${PORT}`;

const keys = {};
for (const [k, v] of Object.entries({
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
})) if (v) keys[k] = v;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}

let PASS = 0, FAIL = 0;
function ck(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}  → ${extra}`); }
}

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(9); } catch {} });
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(1); });

// ── engine up ────────────────────────────────────────────────────────
procs.push(spawn(ENG, ['--port', String(PORT), '--data-dir', '/tmp/doomalay-v113-live'], {
  env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
}));
procs[0].stderr.on('data', d => process.stderr.write('[engine] ' + d));
for (let i = 0; i < 80; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }
console.log('engine up on', PORT);

// ── keys (real, from env) ────────────────────────────────────────────
for (const [envVar, key] of Object.entries(keys)) {
  await api('/api/keys', 'POST', { env_var: envVar, provider: envVar.replace('_API_KEY', '').toLowerCase(), key });
}
const keyList = await api('/api/keys');
console.log('keys seeded:', keyList.keys ? keyList.keys.map(k => k.env_var).join(', ') : Object.keys(keys).join(','));

// (probe verdict: the OpenRouter key carries no credits (402) and the
// Mistral key is invalid (the repo's own v0917 test says re-copy it);
// NVIDIA + nemotron-3.5-lightning-30b-a3b — the repo's proven model —
// answers live from this sandbox.)
const MODEL = 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b';
const PROVIDER = 'nvidia';
const SID = 'v113-live';

await api('/api/sessions', 'POST', { id: SID, title: 'MCP live', model: MODEL, provider: PROVIDER });

// ONE socket for the whole session (the panel client's own pattern —
// the engine routes one chat pipe per session; per-test sockets fight it).
const chat = { ws: null, frames: [] };
function connect() {
  chat.frames = [];
  chat.ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${SID}`);
  chat.ws.onmessage = (e) => { try { chat.frames.push(JSON.parse(e.data)); } catch { chat.frames.push({ raw: String(e.data) }); } };
}
const waitOpen = () => new Promise(res => { chat.ws.onopen = res; setTimeout(res, 2000); });
connect();
await waitOpen();

// one TURN = frames from its baseline until the terminal status (idle or
// error) or a busy rejection; timeouts resolve too (reported as failure).
async function turn(message, timeoutMs = 300000) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const baseline = chat.frames.length;
    chat.ws.send(JSON.stringify({ type: 'send', message, session_id: SID, model: MODEL, provider: PROVIDER }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const f = chat.frames.slice(baseline);
      const last = f[f.length - 1];
      if (last && last.type === 'error' && last.error === 'busy') break; // retry
      if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) return f;
      await sleep(150);
    }
    const f = chat.frames.slice(baseline);
    const last = f[f.length - 1];
    if (last && last.type === 'error' && last.error === 'busy') {
      console.log('  (busy — waiting 2s, retrying the send)');
      await sleep(2000);
      continue;
    }
    console.log('  (turn timeout — last frames:)', f.slice(-6).map(x => `${x.type}:${(x.text || x.state || x.name || x.error || '').slice(0, 80)}`).join(' | '));
    return f; // timeout — the checks will report what arrived
  }
  return chat.frames.slice(-1);
}

// ── 1. THE CALCULATOR CHAIN ──────────────────────────────────────────
console.log('\n[1] THE CALCULATOR CHAIN (calculator + time_now through the MCP bus)');
{
  const f = await turn('Use your tools: compute 37*14 exactly, and tell me the current time in Tokyo. Do both, then answer.');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const answer = f.filter(x => x.type === 'assistant_delta').map(x => x.text || '').join('');
  const idle = f.some(x => x.type === 'status' && x.state === 'idle');
  const err = f.filter(x => x.type === 'error');
  ck('turn ends idle', idle);
  ck('no error frames', err.length === 0, JSON.stringify(err));
  ck('tool_use pills fired (≥2)', use.length >= 2, `${use.length} pills: ${use.map(u => u.name).join(',')}`);
  ck('every tool_use has a tool_result', use.length > 0 && res.length >= use.length, `${use.length} vs ${res.length}`);
  ck('calculator called', use.some(u => u.name === 'calculator'));
  ck('calculator says 518', res.some(r => r.name === 'calculator' && (r.text || '').includes('518')), res.map(r => r.text || '').join(' | ').slice(0, 200));
  ck('final answer references both', answer.includes('518') && /Tokyo|東京/i.test(answer), answer.slice(0, 300));
  if (!answer.includes('518')) {
    console.log('  [diag] turn-1 frame types:', f.map(x => x.type).join(','));
    for (const x of f.filter(y => y.type === 'thinking' || y.type === 'assistant_delta' || y.type === 'status' || y.type === 'progress')) {
      console.log(`  [diag] ${x.type}: ${(x.text || x.state || '').slice(0, 120).replace(/\n/g, ' ')}`);
    }
  }
  const roundEnds = f.filter(x => x.type === 'round_end');
  ck('round segments flow (round_end events)', roundEnds.length >= 1);
}

// ── 2. THE LIVE WEB ──────────────────────────────────────────────────
console.log('\n[2] THE LIVE WEB (web_search through the MCP bus)');
{
  const f = await turn('Search the live web for what "Model Context Protocol" is, then summarize it in two sentences with your sources.');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const sources = f.filter(x => x.type === 'sources');
  const answer = f.filter(x => x.type === 'assistant_delta').map(x => x.text || '').join('');
  const idle = f.some(x => x.type === 'status' && x.state === 'idle');
  const err = f.filter(x => x.type === 'error');
  ck('turn ends idle', idle);
  ck('no error frames', err.length === 0, JSON.stringify(err));
  ck('web_search called', use.some(u => u.name === 'web_search' || u.name === 'web_fetch'));
  ck('sources event fired with live results', sources.length > 0 && (sources[0].sources || []).length > 0, JSON.stringify(sources).slice(0, 200));
  ck('answer grounded (MCP mentioned)', /Model Context Protocol|Anthropic/i.test(answer), answer.slice(0, 300));
}

// ── 3. THE ARTIFACT ──────────────────────────────────────────────────
console.log('\n[3] THE ARTIFACT (zip_create through the MCP bus)');
{
  const f = await turn('Create a zip archive named bundle.zip containing two files: a.txt with the text hello and b.txt with the text world. Tell me when it is ready.');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const answer = f.filter(x => x.type === 'assistant_delta').map(x => x.text || '').join('');
  const idle = f.some(x => x.type === 'status' && x.state === 'idle');
  const err = f.filter(x => x.type === 'error');
  ck('turn ends idle', idle);
  ck('no error frames', err.length === 0, JSON.stringify(err));
  ck('zip_create called', use.some(u => u.name === 'zip_create'));
  const zipRes = res.find(r => r.name === 'zip_create');
  ck('artifact card rides the tool_result', !!zipRes && zipRes.artifact && zipRes.artifact.name === 'bundle.zip', JSON.stringify(zipRes || {}).slice(0, 200));
  ck('saved-as-artifact observation', (zipRes?.text || '').includes('Saved as artifact'));
  ck('answer confirms the file', /ready|saved|download/i.test(answer), answer.slice(0, 200));
}

killAll();
console.log(`\n═══ v1.13.3 THE GUT live verdict: ${PASS} pass / ${FAIL} fail ═══`);
process.exit(FAIL ? 1 : 0);
