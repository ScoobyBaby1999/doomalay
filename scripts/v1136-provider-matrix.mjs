#!/usr/bin/env node
// v1136-provider-matrix.mjs — the REAL-KEY provider matrix (v1.13.6 §LIVE,
// the user's ask: "test each provider and check and ensure they are able to
// reliably chain tools, even the weaker models").
//
// Spawns the REAL engine (no stubs) and drives, per provider:
//   1. KEY RECEIPT   — seed via /api/keys, record the validation verdict
//   2. CHAIN TURN    — "compute 37*14 + Tokyo time" → calculator + time_now
//                      through the MCP bus (native tool_calls loop)
//   3. ARTIFACT TURN — zip_create → the artifact card contract
//   4. WEAK MODEL    — the chain turn again on the provider's small model
//
// Providers: nvidia · opencode · openrouter · mistral (engine-direct) —
// privatemodeai is E2E-wasm-only (the direct API refuses plain requests:
// "minimum client version v1.46") and HF is not an engine chat provider;
// both get their own receipts in the matrix summary (pm-node-probe.mjs /
// whoami + router probe).
//
// Usage: node scripts/v1136-provider-matrix.mjs [provider ...]
// Keys live in /home/z/keys.env — OUTSIDE the repo, never committed.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ENG = ROOT + 'engine/bin/doomalay-engine';
const PORT = 8595;
const BASE = `http://127.0.0.1:${PORT}`;

// keys.env → env map
const keys = {};
for (const line of readFileSync('/home/z/keys.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) keys[m[1]] = m[2].trim();
}

const PROVIDERS = {
  nvidia: {
    env: 'NVIDIA_API_KEY', key: keys.NVIDIA_KEY,
    // NVIDIA wire ids carry their own vendor prefix — the session id is
    // "nvidia/<wire-id>" (live-probed: lightning ✓, nano deprovisioned
    // again, llama-3.2-11b serves tools ✓).
    strong: { model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', label: 'nemotron-3.5-lightning-30b (a3b)' },
    weak: { model: 'nvidia/meta/llama-3.2-11b-vision-instruct', label: 'llama-3.2-11b (the small one)' },
  },
  opencode: {
    env: 'OPENCODE_ZEN_API_KEY', key: keys.OPENCODE_KEY,
    strong: { model: 'opencode/big-pickle', label: 'big-pickle (their flagship free)' },
    weak: { model: 'opencode/mimo-v2.6-flash-free', label: 'mimo-v2.6-flash (the small flash)' },
  },
  openrouter: {
    env: 'OPENROUTER_API_KEY', key: keys.OPENROUTER_KEY,
    // free-tier account (the $50 is a usage cap, not spendable credits):
    // paid models 402. Live-probed free+tools models: nemotron-3.5-lightning
    // ✓ (finish_reason tool_calls) and liquid/lfm-2.5-2.6b ✓ (the 2.6B).
    strong: { model: 'openrouter/nvidia/nemotron-3.5-lightning:free', label: 'nemotron-3.5-lightning:free (tools ✓)' },
    weak: { model: 'openrouter/liquid/lfm-2.5-2.6b:free', label: 'lfm-2.5-2.6b:free (the 2.6B tiny)' },
  },
  mistral: {
    env: 'MISTRAL_API_KEY', key: keys.MISTRAL_KEY,
    strong: { model: 'mistral/mistral-small-latest', label: 'mistral-small (function_calling ✓)' },
    weak: { model: 'mistral/ministral-3b-latest', label: 'ministral-3b (the 3B)' },
  },
};

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'));
const run = wanted.length ? wanted : Object.keys(PROVIDERS);
for (const p of run) if (!PROVIDERS[p]) { console.error(`unknown provider ${p}`); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body = null) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
  return r.json();
}

let PASS = 0, FAIL = 0, WARN = 0;
const receipts = [];
function ck(provider, name, cond, extra = '', warnOnly = false) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else if (warnOnly) { WARN++; console.log(`  ⚠ ${name}  → ${String(extra).slice(0, 200)}`); }
  else { FAIL++; console.log(`  ✗ ${name}  → ${String(extra).slice(0, 200)}`); }
}

const DATA_DIR = mkdtempSync(join(tmpdir(), 'doomalay-matrix-'));
const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(9); } catch {} });
process.on('exit', () => { killAll(); try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });
process.on('SIGINT', () => { killAll(); process.exit(1); });

let engineLog = '';
const eng = spawn(ENG, ['--port', String(PORT), '--data-dir', DATA_DIR], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(eng);
eng.stderr.on('data', d => { engineLog += d.toString(); });
for (let i = 0; i < 100; i++) { try { await api('/api/health'); break; } catch { await sleep(300); } }
console.log(`provider matrix — engine up on ${PORT} (data ${DATA_DIR})\n`);

// ── one WS chat pipe per session ──────────────────────────────────────
async function session(id, model, provider) {
  await api('/api/sessions', 'POST', { id, title: 'matrix ' + id, model, provider });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${id}`);
  const st = { ws, frames: [] };
  ws.onmessage = (e) => { try { st.frames.push(JSON.parse(e.data)); } catch { st.frames.push({ raw: String(e.data) }); } };
  await new Promise(res => { ws.onopen = res; setTimeout(res, 2500); });
  return st;
}
async function turn(st, sid, message, model, provider, timeoutMs = 300000) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const baseline = st.frames.length;
    st.ws.send(JSON.stringify({ type: 'send', message, session_id: sid, model, provider }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const f = st.frames.slice(baseline);
      const last = f[f.length - 1];
      if (last && last.type === 'error' && last.error === 'busy') break;
      if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) return f;
      await sleep(200);
    }
    const f = st.frames.slice(baseline);
    const last = f[f.length - 1];
    if (last && last.type === 'error' && last.error === 'busy') { await sleep(2000); continue; }
    return f;
  }
  return st.frames.slice(-1);
}
const answer = (f) => f.filter(x => x.type === 'assistant_delta').map(x => x.text || '').join('');

async function chainTurn(provider, label, model) {
  const sid = `mx-${provider}-${label.replace(/[^a-z0-9]+/gi, '')}`.toLowerCase();
  const st = await session(sid, model, provider);
  console.log(`\n── ${provider} / ${label}: THE CHAIN (calculator + time_now through the bus)`);
  const t0 = Date.now();
  const f = await turn(st, sid, 'Use your tools: compute 37*14 exactly, then tell me the current time in Tokyo. Do both, then answer.', model, provider);
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  const use = f.filter(x => x.type === 'tool_use');
  const res = f.filter(x => x.type === 'tool_result');
  const ans = answer(f);
  const errs = f.filter(x => x.type === 'error');
  const idle = f.some(x => x.type === 'status' && x.state === 'idle');
  ck(provider, `[${dt}s] turn ends idle`, idle, errs.map(e => e.error + ' ' + (e.message || '')).join(' | '));
  ck(provider, 'no error frames', errs.length === 0, JSON.stringify(errs).slice(0, 180));
  ck(provider, 'tool_use pills fired', use.length >= 1, `${use.length} pills: ${use.map(u => u.name).join(',')}`);
  ck(provider, 'calculator called', use.some(u => u.name === 'calculator'), use.map(u => u.name).join(','));
  ck(provider, 'calculator result carries 518', res.some(r => r.name === 'calculator' && (r.text || '').includes('518')), res.map(r => `${r.name}:${(r.text || '').slice(0, 40)}`).join(' | '));
  ck(provider, 'final answer references the tool output', /518|Tokyo/i.test(ans), ans.slice(0, 200));
  if (ans && !/518/.test(ans)) {
    console.log(`    [receipt] answer: ${ans.slice(0, 300)}`);
  }
  const srcReceipt = f.filter(x => x.type === 'progress' || x.type === 'status').map(x => (x.text || x.state || '')).slice(0, 3).join(' / ');
  receipts.push({ provider, model: label, kind: 'chain', pass: idle && use.length >= 1, seconds: dt, note: srcReceipt.slice(0, 120) });
  return st;
}

async function artifactTurn(provider, model) {
  const sid = `mx-${provider}-artifact`;
  const st = await session(sid, model, provider);
  console.log(`\n── ${provider}: THE ARTIFACT (zip_create through the bus)`);
  const f = await turn(st, sid, 'Create a zip archive named bundle.zip containing two files: a.txt with the text hello and b.txt with the text world. Tell me when it is ready.', model, provider);
  const use = f.filter(x => x.type === 'tool_use');
  const zipRes = f.filter(x => x.type === 'tool_result').find(r => r.name === 'zip_create');
  ck(provider, 'turn ends idle', f.some(x => x.type === 'status' && x.state === 'idle'));
  ck(provider, 'no error frames', f.filter(x => x.type === 'error').length === 0);
  ck(provider, 'zip_create called', use.some(u => u.name === 'zip_create'), use.map(u => u.name).join(','));
  ck(provider, 'artifact card rides the result', !!zipRes?.artifact && zipRes.artifact.name === 'bundle.zip', JSON.stringify(zipRes || {}).slice(0, 160));
  ck(provider, 'answer confirms the archive', /ready|saved|download|bundle/i.test(answer(f)), answer(f).slice(0, 160));
  receipts.push({ provider, model: 'artifact', kind: 'zip', pass: !!zipRes?.artifact, note: (zipRes?.text || '').slice(0, 80) });
}

// ── the matrix ────────────────────────────────────────────────────────
for (const name of run) {
  const p = PROVIDERS[name];
  console.log(`\n═══ ${name.toUpperCase()} (${p.env}) ═══`);
  if (!p.key) { console.log('  (no key — skipping)'); receipts.push({ provider: name, kind: 'key', pass: false, note: 'no key' }); continue; }

  // 1. key receipt (the engine's own validation probe)
  const v = await api('/api/keys', 'POST', { env_var: p.env, provider: name, key: p.key });
  const state = v.state || v.status || (v.ok ? 'valid' : 'unknown');
  console.log(`  key receipt: ${state}${v.reason ? ' — ' + String(v.reason).slice(0, 140) : ''}`);
  receipts.push({ provider: name, kind: 'key', pass: /valid/i.test(state), note: `${state}: ${String(v.reason || '').slice(0, 100)}` });

  // 2. strong model: chain + artifact
  try {
    await chainTurn(name, 'strong', p.strong.model, p.strong.label);
    await artifactTurn(name, p.strong.model);
  } catch (e) {
    console.log(`  ✗ harness error: ${e.message}`);
    receipts.push({ provider: name, kind: 'harness', pass: false, note: e.message });
  }

  // 3. weak model: chain
  try {
    await chainTurn(name, 'weak', p.weak.model, p.weak.label);
  } catch (e) {
    console.log(`  ✗ harness error (weak): ${e.message}`);
    receipts.push({ provider: name, kind: 'harness-weak', pass: false, note: e.message });
  }
}

killAll();
console.log('\n═══ THE PROVIDER MATRIX — receipts ═══');
for (const r of receipts) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.provider.padEnd(11)} ${r.kind.padEnd(9)} ${String(r.model || '').padEnd(30)} ${r.note || ''}`);
}
console.log(`\n═══ v1.13.6 provider matrix verdict: ${PASS} pass / ${WARN} warn / ${FAIL} fail ═══`);
if (engineLog) {
  const lines = engineLog.split('\n').filter(l => /blacklist|reject|mcpbus|error/i.test(l)).slice(-12);
  if (lines.length) console.log('engine notes:\n  ' + lines.join('\n  '));
}
process.exit(FAIL ? 1 : 0);
