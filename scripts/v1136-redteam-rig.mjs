#!/usr/bin/env node
// v1136-redteam-rig.mjs — v1.13.6 THE REDTEAM (PLAN-V113 §6).
//
// The full adversarial battery against the REAL engine — no live keys, all
// determinism: a scripted OpenAI-wire stub (v1136-stub-provider.mjs) plays
// the providers via the base-URL overrides, and mcpdemo (engine/cmd/mcpdemo)
// plays a 100-tool external MCP server chained onto the bus.
//
// The 13 scenarios:
//   S1  GOLDEN CHAIN      — calculator + time_now through the MCP bus
//   S2  ARTIFACT          — zip_create, the artifact card contract
//   S3  EXTERNAL 100+     — demo_tool_42 routes bus→proxy→mcpdemo; the
//                           manifest carries 128+ tools
//   S4  EXTERNAL BOOM     — a failing external tool: turn survives
//   S5  EXTERNAL HANG     — a hanging external tool: the per-call timeout
//   S6  EXTERNAL PANIC    — a panicking external handler: contained
//   S7  CUT ARGS          — v1.13.6 honesty line: cut args are NOT
//                           executed (exactly ONE tool message on the wire)
//   S8  MALFORMED ARGS    — the same contract for unrecoverable args
//   S9  REJECT + BLACKLIST— groq 400s tools; the honest degrade, then the
//                           blacklist skips re-arming on the next turn
//   S10 ANSWER-ONLY       — a plain streamed answer, no pills
//   S11 REPLAY DETERMINISM— the same turn twice: identical frame sequences
//   S12 FIVE-WAY CONCURRENCY — 5 sessions × the golden chain at once
//   S13 /mcp CONSUMER     — raw JSON-RPC tools/list (128+) + tools/call,
//                           including the chain out to mcpdemo
//
// Verdict: every check green = the MCP wave's contracts hold under fault.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const MCPDEMO_PORT = 8600, STUB_PORT = 8610, ENGINE_PORT = 8592;
const BASE = `http://127.0.0.1:${ENGINE_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const DEMO = `http://127.0.0.1:${MCPDEMO_PORT}`;
// hermetic: a FRESH data-dir per rig run — persisted sessions from a
// previous run would change every scenario's conversation state.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'doomalay-v1136-'));
process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}
async function stubLog() {
  const r = await fetch(STUB + '/log');
  return r.json();
}

let PASS = 0, FAIL = 0;
function ck(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}  → ${String(extra).slice(0, 220)}`); }
}

const procs = [];
let engineErr = '';
const killAll = () => procs.forEach(p => { try { p.kill(9); } catch {} });
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(1); });

function spawnLog(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => {
    const s = d.toString();
    if (name === 'engine') engineErr += s;
    if (process.env.RIG_VERBOSE) process.stderr.write(`[${name}] ${s}`);
  });
  if (name === 'engine') p.stdout.on('data', d => { engineErr += d.toString(); });
  procs.push(p);
  return p;
}

// ── boot: mcpdemo + stub + engine ─────────────────────────────────
// mcpdemo runs from the prebuilt binary (go build -o /tmp/mcpdemo
// ./cmd/mcpdemo) — deterministic boot, no go-run compile latency.
spawnLog('mcpdemo', '/tmp/mcpdemo', ['--port', String(MCPDEMO_PORT), '--tools', '100']);
spawnLog('stub', 'node', [ROOT + 'scripts/v1136-stub-provider.mjs'], { STUB_PORT: String(STUB_PORT) });
spawnLog('engine', ENG, ['--port', String(ENGINE_PORT), '--data-dir', DATA_DIR], {
  DOOMALAY_BASE_URL_NVIDIA: STUB,
  DOOMALAY_BASE_URL_OPENROUTER: STUB,
  DOOMALAY_BASE_URL_GROQ: STUB,
  DOOMALAY_MCP_SERVERS: JSON.stringify([{ name: 'demo', url: DEMO + '/mcp', timeout_ms: 6000 }]),
});

async function waitUp(url, path, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url + path); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}
if (!await waitUp(DEMO, '/healthz')) { console.error('mcpdemo never came up'); killAll(); process.exit(1); }
if (!await waitUp(STUB, '/log')) { console.error('stub never came up'); killAll(); process.exit(1); }
if (!await waitUp(BASE, '/api/health')) { console.error('engine never came up:\n' + engineErr.slice(-3000)); killAll(); process.exit(1); }
console.log('rig: mcpdemo + stub + engine up');

// ── keys + sessions ───────────────────────────────────────────────────
await fetch(STUB + '/reset', { method: 'POST' });
await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', provider: 'nvidia', key: 'stub-nvidia-key-000' });
await api('/api/keys', 'POST', { env_var: 'OPENROUTER_API_KEY', provider: 'openrouter', key: 'stub-openrouter-key-000' });
await api('/api/keys', 'POST', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-000' });

const MODEL = {
  nvidia: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
  openrouter: 'openrouter/meta-llama/llama-3.3-70b-instruct',
  groq: 'groq/llama-3.3-70b-versatile',
};

const sockets = new Map();
async function session(id, provider = 'nvidia') {
  await api('/api/sessions', 'POST', { id, title: 'rig ' + id, model: MODEL[provider], provider });
  const ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/api/chat?session_id=${id}`);
  const st = { ws, frames: [] };
  ws.onmessage = (e) => { try { st.frames.push(JSON.parse(e.data)); } catch { st.frames.push({ raw: String(e.data) }); } };
  await new Promise(res => { ws.onopen = res; setTimeout(res, 2500); });
  sockets.set(id, st);
  return st;
}

async function turn(st, sid, message, provider = 'nvidia', timeoutMs = 90000) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const baseline = st.frames.length;
    st.ws.send(JSON.stringify({ type: 'send', message, session_id: sid, model: MODEL[provider], provider }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const f = st.frames.slice(baseline);
      const last = f[f.length - 1];
      if (last && last.type === 'error' && last.error === 'busy') break;
      if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) return f;
      await sleep(120);
    }
    const f = st.frames.slice(baseline);
    const last = f[f.length - 1];
    if (last && last.type === 'error' && last.error === 'busy') { await sleep(1500); continue; }
    return f;
  }
  return st.frames.slice(-1);
}
const sum = (f, t) => f.filter(x => x.type === 'assistant_delta').map(x => x.text || '').join('');
const errs = (f) => f.filter(x => x.type === 'error');

const s1 = await session('rig-s1');

// ── S1 GOLDEN CHAIN ───────────────────────────────────────────────────
console.log('\n[S1] GOLDEN CHAIN — calculator + time_now through the bus');
{
  const f = await turn(s1, 'rig-s1', 'STUB CHAIN');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const answer = sum(f);
  ck('turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
  ck('two tool calls fired', use.length >= 2, use.map(u => u.name).join(','));
  ck('every use has a result', res.length >= use.length, `${use.length} vs ${res.length}`);
  ck('calculator says 518', res.some(r => r.name === 'calculator' && (r.text || '').includes('518')), JSON.stringify(res.map(r => r.name)));
  ck('answer references 518', answer.includes('518'), answer.slice(0, 160));
  ck('round segments flow', f.some(x => x.type === 'round_end'));
}

// ── S2 ARTIFACT ───────────────────────────────────────────────────────
console.log('\n[S2] ARTIFACT — zip_create + the artifact card');
{
  const f = await turn(s1, 'rig-s1', 'STUB ZIP');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const zipRes = res.find(r => r.name === 'zip_create');
  ck('turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
  ck('zip_create called', use.some(u => u.name === 'zip_create'));
  ck('artifact card rides the result', !!zipRes?.artifact && zipRes.artifact.name === 'bundle.zip', JSON.stringify(zipRes || {}).slice(0, 200));
  ck('saved-as-artifact observation', (zipRes?.text || '').includes('Saved as artifact'));
  ck('answer confirms', /ready/i.test(sum(f)), sum(f).slice(0, 160));
}

// ── S3 EXTERNAL 100+ ──────────────────────────────────────────────────
console.log('\n[S3] EXTERNAL CHAIN — 100+ tools, bus→proxy→mcpdemo routing');
{
  const f = await turn(s1, 'rig-s1', 'STUB EXTERNAL');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const ext = res.find(r => r.name === 'demo_tool_42');
  ck('turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
  ck('demo_tool_42 called', use.some(u => u.name === 'demo_tool_42'), use.map(u => u.name).join(','));
  ck('the EXTERNAL server answered (7*6=42)', (ext?.text || '').includes('tool_42 computed 7*6=42'), ext?.text);
  ck('answer carries the external value', sum(f).includes('42'), sum(f).slice(0, 160));
  const L = await stubLog();
  const armed = L.filter(e => e.last_user === 'STUB EXTERNAL' && e.tools_count > 0);
  ck('manifest carried 128+ tools', armed.length > 0 && armed[armed.length - 1].tools_count >= 128, `tools_count=${armed.map(e => e.tools_count).join(',')}`);
  ck('mcpdemo chained at boot', /chained "demo"/.test(engineErr), engineErr.split('\n').filter(l => l.includes('mcpbus')).join(' | ').slice(0, 200));
}

// ── S4 EXTERNAL BOOM ──────────────────────────────────────────────────
console.log('\n[S4] EXTERNAL FAULT: boom — the failing tool');
{
  const f = await turn(s1, 'rig-s1', 'STUB BOOM');
  const res = f.filter(x => x.type === 'tool_result');
  const boom = res.find(r => r.name === 'demo_boom');
  ck('turn survives (idle)', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
  ck('boom result reports the fault', /boom|error|fail/i.test(boom?.text || ''), boom?.text);
  ck('model answers despite the fault', sum(f).length > 0, sum(f).slice(0, 160));
}

// ── S5 EXTERNAL HANG ──────────────────────────────────────────────────
console.log('\n[S5] EXTERNAL FAULT: hang — the per-call timeout');
{
  const t0 = Date.now();
  const f = await turn(s1, 'rig-s1', 'STUB HANG');
  const dt = Date.now() - t0;
  const res = f.filter(x => x.type === 'tool_result');
  ck('turn survives (idle)', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
  ck('the timeout cut the hang', res.some(r => r.name === 'demo_hang' && /error|deadline|timeout|hang/i.test(r.text || '')), JSON.stringify(res.map(r => [r.name, (r.text || '').slice(0, 60)])));
  ck('bounded turn time (<45s)', dt < 45000, `${(dt / 1000).toFixed(1)}s`);
}

// ── S6 EXTERNAL PANIC ─────────────────────────────────────────────────
console.log('\n[S6] EXTERNAL FAULT: panic — the contained handler');
{
  const f = await turn(s1, 'rig-s1', 'STUB PANIC');
  const res = f.filter(x => x.type === 'tool_result');
  ck('turn survives (idle)', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
  ck('panic came back as a tool-level result', res.some(r => r.name === 'demo_boom_panic' && /error|panic|fail|EOF|closed/i.test(r.text || '')), JSON.stringify(res.map(r => [r.name, (r.text || '').slice(0, 60)])));
  const r = await fetch(DEMO + '/healthz');
  ck('the external server survived the panic', r.ok, await r.text());
}

// ── S7 CUT ARGS (the v1.13.6 honesty line) ────────────────────────────
console.log('\n[S7] CUT ARGS — never executed, exactly ONE tool message');
{
  const f = await turn(s1, 'rig-s1', 'STUB CUT');
  const calc = f.filter(x => x.type === 'tool_result' && x.name === 'calculator');
  ck('turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('exactly ONE tool_result for the cut call', calc.length === 1, JSON.stringify(calc.map(r => (r.text || '').slice(0, 80))));
  ck('the fault text is the answer', /CUT OFF|NOT executed/i.test(calc[0]?.text || ''), calc[0]?.text);
  const L = await stubLog();
  const cuts = L.filter(e => e.last_user === 'STUB CUT');
  const round2 = cuts[cuts.length - 1];
  ck('wire round-2 carries ONE role:tool', !!round2 && round2.tool_msgs === 1, JSON.stringify(cuts.map(e => e.tool_msgs)));
  ck('no execution result on the wire', !(round2?.tool_msg_texts || []).some(t => t.includes('518')), JSON.stringify(round2?.tool_msg_texts));
  ck('model acknowledged the re-send ask', sum(f).length > 0, sum(f).slice(0, 160));
}

// ── S8 MALFORMED ARGS ─────────────────────────────────────────────────
console.log('\n[S8] MALFORMED ARGS — the same contract');
{
  const f = await turn(s1, 'rig-s1', 'STUB BAD');
  const calc = f.filter(x => x.type === 'tool_result' && x.name === 'calculator');
  ck('turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('exactly ONE tool_result for the bad call', calc.length === 1, JSON.stringify(calc.map(r => (r.text || '').slice(0, 80))));
  ck('malformed verdict named', /malformed/i.test(calc[0]?.text || ''), calc[0]?.text);
  const L = await stubLog();
  const bads = L.filter(e => e.last_user === 'STUB BAD');
  const round2 = bads[bads.length - 1];
  ck('wire round-2 carries ONE role:tool', !!round2 && round2.tool_msgs === 1, JSON.stringify(bads.map(e => e.tool_msgs)));
  ck('no execution result on the wire', !(round2?.tool_msg_texts || []).some(t => t.includes('518')), JSON.stringify(round2?.tool_msg_texts));
}

// ── S9 REJECT + BLACKLIST ─────────────────────────────────────────────
console.log('\n[S9] REJECT + BLACKLIST — the honest degrade (groq persona)');
{
  const s9 = await session('rig-s9', 'groq');
  const f1 = await turn(s9, 'rig-s9', 'STUB CHAIN', 'groq');
  ck('turn 1 ends idle', f1.some(x => x.type === 'status' && x.state === 'idle'));
  ck('turn 1 answers without tools', sum(f1).includes('518'), sum(f1).slice(0, 160));
  ck('turn 1 has no tool pills', f1.filter(x => x.type === 'tool_use').length === 0, 'pills should be absent');
  const f2 = await turn(s9, 'rig-s9', 'STUB CHAIN', 'groq');
  ck('turn 2 ends idle', f2.some(x => x.type === 'status' && x.state === 'idle'));
  ck('turn 2 answers without tools', sum(f2).includes('518'), sum(f2).slice(0, 160));
  const L = await stubLog();
  const groq = L.filter(e => e.persona === 'groq');
  ck('the 400 round happened (tools armed once)', groq.some(e => e.tools_count > 0), JSON.stringify(groq.map(e => e.tools_count)));
  ck('blacklisted: later groq turns never re-arm tools', groq.length >= 3 && groq[groq.length - 1].tools_count === 0, JSON.stringify(groq.map(e => e.tools_count)));
}

// ── S10 ANSWER-ONLY ───────────────────────────────────────────────────
console.log('\n[S10] ANSWER-ONLY — the plain streaming path');
{
  const f = await turn(s1, 'rig-s1', 'STUB ANSWER');
  ck('turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('no tool pills', f.filter(x => x.type === 'tool_use').length === 0);
  ck('the answer streams', sum(f).includes('518'), sum(f).slice(0, 160));
  ck('no error frames', errs(f).length === 0, JSON.stringify(errs(f)));
}

// ── S11 REPLAY DETERMINISM ────────────────────────────────────────────
console.log('\n[S11] REPLAY DETERMINISM — the same turn, identical frames');
{
  const sA = await session('rig-s11');
  const f1 = await turn(sA, 'rig-s11', 'STUB CHAIN');
  const f2 = await turn(sA, 'rig-s11', 'STUB CHAIN');
  // pacing `progress` frames are TIME-positioned (the provider rate
  // limiter) — they are not part of the protocol contract; filter them.
  const shape = (f) => f.filter(x => x.type !== 'progress').map(x => x.type).join(',');
  ck('both turns idle', f1.some(x => x.type === 'status' && x.state === 'idle') && f2.some(x => x.type === 'status' && x.state === 'idle'));
  ck('identical frame sequences', shape(f1) === shape(f2), `${shape(f1)}\n  vs\n${shape(f2)}`);
  ck('identical answers', sum(f1) === sum(f2), `${sum(f1)} vs ${sum(f2)}`);
}

// ── S12 FIVE-WAY CONCURRENCY ──────────────────────────────────────────
console.log('\n[S12] FIVE-WAY CONCURRENCY — 5 sessions, one golden chain each');
{
  const ids = ['rig-s12a', 'rig-s12b', 'rig-s12c', 'rig-s12d', 'rig-s12e'];
  const sts = await Promise.all(ids.map(id => session(id, 'openrouter')));
  const turns = await Promise.all(sts.map((st, i) => turn(st, ids[i], 'STUB CHAIN', 'openrouter')));
  turns.forEach((f, i) => {
    const ok = f.some(x => x.type === 'status' && x.state === 'idle');
    const got518 = sum(f).includes('518');
    const pills = f.filter(x => x.type === 'tool_use').length;
    ck(`session ${i + 1}: idle + 518 + 2 pills`, ok && got518 && pills >= 2, `idle=${ok} 518=${got518} pills=${pills} err=${errs(f).length}`);
  });
}

// ── S13 /mcp CONSUMER ─────────────────────────────────────────────────
console.log('\n[S13] /mcp CONSUMER — raw JSON-RPC, incl. the chain to mcpdemo');
{
  async function mcp(body) {
    const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { code: r.status, out: await r.json().catch(() => ({})) };
  }
  const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tools = list.out?.result?.tools || [];
  ck('tools/list answers 200', list.code === 200, JSON.stringify(list.out).slice(0, 200));
  ck('128+ tools served externally', tools.length >= 128, `got ${tools.length}`);
  ck('the external fleet is listed', tools.some(t => t.name === 'demo_tool_42'));
  const calc = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'calculator', arguments: { expr: '6*7' } } });
  const calcText = (calc.out?.result?.content || []).map(c => c.text || '').join('');
  ck('calculator through /mcp = 42', calc.code === 200 && calcText.includes('42'), calcText);
  const twin = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo_twin_calculator', arguments: { expr: '6*7' } } });
  const twinText = (twin.out?.result?.content || []).map(c => c.text || '').join('');
  ck('the consumer chains OUT to mcpdemo (twin = 42)', twin.code === 200 && /42/.test(twinText), twinText);
}

killAll();
console.log(`\n═══ v1.13.6 THE REDTEAM verdict: ${PASS} pass / ${FAIL} fail ═══`);
process.exit(FAIL ? 1 : 0);
