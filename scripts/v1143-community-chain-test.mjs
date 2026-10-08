#!/usr/bin/env node
// v1143-community-chain-test.mjs — v1.14.3 THE PRE-MADE HORDE: REAL
// community MCP servers chain onto the bus and a REAL provider (the user's
// NVIDIA key + nemotron) drives their tools through chat — the "expose the
// pre-made tools to our apps and bots" proof.
//
// The chained fleet (all keyless, all pre-made, all live):
//   fs       — @modelcontextprotocol/server-filesystem  (read/write/list/…)
//   memory   — @modelcontextprotocol/server-memory      (knowledge graph)
//   think    — @modelcontextprotocol/server-sequential-thinking
//   sqlite   — mcp-server-sqlite-npx                    (SQL over a real db)
//
// Contracts:
//   1. boot: every server chains (engine log "chained <name> … N tools")
//   2. chat: the model CALLS community tools through the bus (namespace_
//      names), results flow back, the answer is grounded in them
//   3. /mcp: external consumers (apps/bots) see the SAME merged registry
//
// Pre-warm the npx cache first (the attach timeout is 30s/server — see the
// rig README note in docs/MCP-CHAIN.md).
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

const SERVERS = [
  { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/v1143-ws'] },
  { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { name: 'think', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { name: 'sqlite', command: 'npx', args: ['-y', 'mcp-server-sqlite-npx', '/tmp/v1143.db'] },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}
let PASS = 0, FAIL = 0;
function ck(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}  → ${String(extra).slice(0, 240)}`); }
}

const DATA_DIR = mkdtempSync(join(tmpdir(), 'doomalay-v1143-'));
const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(9); } catch {} });
process.on('exit', () => { killAll(); try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });
process.on('SIGINT', () => { killAll(); process.exit(1); });

let engineLog = '';
const eng = spawn(ENG, ['--port', String(PORT), '--data-dir', DATA_DIR], {
  env: {
    ...process.env,
    DOOMALAY_MCP_SERVERS: JSON.stringify(SERVERS),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(eng);
eng.stderr.on('data', d => { engineLog += d.toString(); });
eng.stdout.on('data', d => { engineLog += d.toString(); });

for (let i = 0; i < 120; i++) {
  try { await api('/api/health'); break; } catch { await sleep(400); }
}
// give the chain attaches a beat (they run async post-boot)
await sleep(6000);
console.log(`engine up on ${PORT}\n`);

// v1.14.5 test-heal: nemotron-3.5-lightning-30b-a3b was deprovisioned from
// NIM (live roster check: 404) — the live a3b-class flagship is
// nemotron-3-super-120b-a12b. The chain contract is model-independent.
const MODEL = 'nvidia/nvidia/nemotron-3-super-120b-a12b';
const PROVIDER = 'nvidia';
const SID = 'v1143-horde';

// ── 1. boot: the fleet chains ─────────────────────────────────────────
console.log('[1] THE FLEET CHAINS (real community servers onto the bus)');
for (const s of SERVERS) {
  const re = new RegExp(`chained "${s.name}".*?(\\d+) tools attached`);
  const m = engineLog.match(re);
  ck(`${s.name} chained`, !!m, engineLog.split('\n').filter(l => l.includes(`"${s.name}"`)).join(' | ').slice(0, 200));
  if (m) console.log(`    ${s.name}: ${m[1]} tools attached`);
}

// seed the real key
const v = await api('/api/keys', 'POST', { env_var: 'NVIDIA_API_KEY', provider: 'nvidia', key: keys.NVIDIA_KEY });
console.log(`key receipt: ${v.state || 'valid'}`);

await api('/api/sessions', 'POST', { id: SID, title: 'v1143 horde', model: MODEL, provider: PROVIDER });
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${SID}`);
const frames = [];
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch {} };
await new Promise(res => { ws.onopen = res; setTimeout(res, 2500); });

async function turn(message, timeoutMs = 300000) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const baseline = frames.length;
    ws.send(JSON.stringify({ type: 'send', message, session_id: SID, model: MODEL, provider: PROVIDER }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const f = frames.slice(baseline);
      const last = f[f.length - 1];
      if (last && last.type === 'error' && last.error === 'busy') break;
      if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) return f;
      await sleep(200);
    }
    const f = frames.slice(baseline);
    const last = f[f.length - 1];
    if (last && last.type === 'error' && last.error === 'busy') { await sleep(2000); continue; }
    return f;
  }
  return frames.slice(-1);
}
const answer = (f) => f.filter(x => x.type === 'assistant_delta').map(x => x.text || '').join('');
const errText = (f) => f.filter(x => x.type === 'error').map(x => `${x.error}:${x.message || ''}`).join(' | ');

// live turns against the NVIDIA free tier need breathing room — real users
// don't machine-gun turns, and back-to-back provider requests 429.
async function liveTurn(message, timeoutMs = 300000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = await turn(message, timeoutMs);
    const idle = f.some(x => x.type === 'status' && x.state === 'idle');
    const busy = f.some(x => x.type === 'error' && x.error === 'busy');
    if (idle || attempt === 1) return f;
    console.log(`    (turn ended non-idle — breathing 10s, one retry: ${errText(f).slice(0, 160)})`);
    await sleep(10000);
  }
}

// ── 2. chat: the model drives community tools ─────────────────────────
console.log('\n[2] THE MODEL DRIVES THE PRE-MADE TOOLS (real chat turns)');
{
  await sleep(6000);
  const f = await liveTurn('Use your filesystem tools: create a file named notes.txt containing exactly the text doomalay-was-here, then read the file back and tell me its exact content.');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const ans = answer(f);
  ck('fs turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck('fs turn: no error frames', f.filter(x => x.type === 'error').length === 0);
  ck('the model called a COMMUNITY tool (fs_*)', use.some(u => (u.name || '').startsWith('fs_')), use.map(u => u.name).join(','));
  ck('write + read both ran', use.some(u => /fs_write_file|fs_create_file/.test(u.name || '')) && use.some(u => /fs_read/.test(u.name || '')), use.map(u => u.name).join(','));
  ck('the read-back carries the exact content', res.some(r => (r.name || '').startsWith('fs_') && (r.text || '').includes('doomalay-was-here')), res.map(r => `${r.name}:${(r.text || '').slice(0, 60)}`).join(' | '));
  ck('the answer is grounded in the tool result', /doomalay-was-here/i.test(ans), ans.slice(0, 200));
}
{
  await sleep(6000);
  const f = await liveTurn('Use your memory tools: create an entity named doomalay with the observation that it chains community MCP servers, then read your knowledge graph and tell me what you know about doomalay.');
  const use = f.filter(x => x.type === 'tool_use');
  const ans = answer(f);
  ck('memory turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'), errText(f));
  ck('the model called memory_* tools', use.some(u => (u.name || '').startsWith('memory_')), use.map(u => u.name).join(','));
  ck('answer grounded in the graph', /doomalay/i.test(ans) && /chain|community|server|MCP/i.test(ans), ans.slice(0, 200));
}
{
  await sleep(6000);
  const f = await liveTurn('Use your sqlite tools: create a table called notes with a text column, insert the row hello-world, then query all rows and tell me exactly what you stored.');
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const ans = answer(f);
  ck('sqlite turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'), errText(f));
  ck('the model called sqlite_* tools', use.some(u => (u.name || '').startsWith('sqlite_')), use.map(u => u.name).join(','));
  ck('the queried rows carry the insert', res.some(r => (r.name || '').startsWith('sqlite_') && /hello-world/.test(r.text || '')), res.map(r => `${r.name}:${(r.text || '').slice(0, 50)}`).join(' | '));
  ck('answer grounded in the query', /hello-world/i.test(ans), ans.slice(0, 160));
}

// ── 3. /mcp: apps + bots see the merged registry ─────────────────────
console.log('\n[3] /mCP: the merged registry served to external consumers');
{
  const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const out = await r.json().catch(() => ({}));
  const tools = out?.result?.tools || [];
  const names = new Set(tools.map(t => t.name));
  ck('tools/list 200 with the merged registry', r.ok && tools.length > 0, `got ${tools.length}`);
  ck('internal tools served', names.has('calculator'));
  ck('fs_* community tools served', [...names].some(n => n.startsWith('fs_')));
  ck('memory_* community tools served', [...names].some(n => n.startsWith('memory_')));
  ck('sqlite_* community tools served', [...names].some(n => n.startsWith('sqlite_')));
  console.log(`    merged registry: ${tools.length} tools (internal + community)`);
  // and one community tool EXECUTES for an external caller
  const c = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_read_file', arguments: { path: '/tmp/v1143-ws/notes.txt' } } }) });
  const co = await c.json().catch(() => ({}));
  const text = (co?.result?.content || []).map(x => x.text || '').join('');
  ck('an external consumer calls a community tool through /mcp', c.ok && /doomalay-was-here/.test(text), text.slice(0, 120));
}

killAll();
console.log(`\n═══ v1.14.3 THE PRE-MADE HORDE verdict: ${PASS} pass / ${FAIL} fail ═══`);
process.exit(FAIL ? 1 : 0);
