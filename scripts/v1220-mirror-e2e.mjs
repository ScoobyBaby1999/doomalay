#!/usr/bin/env node
// v1220-mirror-e2e.mjs — THE MIRROR end-to-end: boot the real engine
// against the capture stub and verify the ACTUAL system prompts the AI
// receives for the three preamble states (default / custom / off) + the
// {date}/{repo_access} expansion + the PATCH round-trip over the wire.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const STUB_PORT = 8723, ENGINE_PORT = 8722;
const ENGINE_BIN = '/tmp/doomalay-verify-engine';
const DATA_DIR = '/tmp/doomalay-mirror-data';
const CAP_DIR = '/tmp/doomalay-mirror-caps';
const ENGINE_LOG = '/tmp/doomalay-mirror-engine.log';
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`;
const MODEL = 'groq/stub-model';
const PROVIDER = 'groq';
const SID = 'mirror-e2e';

fs.rmSync(CAP_DIR, { recursive: true, force: true });
fs.mkdirSync(CAP_DIR, { recursive: true });
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(path, method, body) {
  const r = await fetch(ENGINE + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

let stubSrv;
function startStub() {
  return new Promise((resolve) => {
    stubSrv = http.createServer(async (req, res) => {
      const url = req.url.replace(/\?.*$/, '');
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 128000 }] }));
        return;
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        let b = ''; for await (const c of req) b += c;
        const parsed = JSON.parse(b);
        const n = fs.readdirSync(CAP_DIR).length;
        const sys = (parsed.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
        fs.writeFileSync(`${CAP_DIR}/cap-${String(n).padStart(2, '0')}.txt`, sys);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'MIRROR OK ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404); res.end('nope');
    });
    stubSrv.listen(STUB_PORT, '127.0.0.1', () => resolve());
  });
}
function pkillEngine() { try { execFileSync('pkill', ['-f', 'doomalay-verify-engine --port'], { stdio: 'ignore' }); } catch (e) { } }
async function waitHealth(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(ENGINE + '/api/health', { signal: AbortSignal.timeout(2500) }); if (r.status === 200) return true; } catch (e) { }
    await sleep(400);
  }
  return false;
}

let ws, frames = [];
async function turn(message) {
  const baseline = frames.length;
  ws.send(JSON.stringify({ type: 'send', message, session_id: SID, model: MODEL, provider: PROVIDER }));
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const f = frames.slice(baseline);
    const last = f[f.length - 1];
    if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) return f;
    await sleep(150);
  }
  return frames.slice(baseline);
}

const results = [];
function ck(name, ok, detail) { results.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }

await startStub();
pkillEngine();
{
  const env = { ...process.env, DOOMALAY_BASE_URL_GROQ: STUB };
  const child = spawn('bash', ['-c', `nohup setsid ${ENGINE_BIN} --port ${ENGINE_PORT} --bind 127.0.0.1 --data-dir ${DATA_DIR} >> ${ENGINE_LOG} 2>&1 &`], { env, detached: true, stdio: 'ignore' });
  child.unref();
}
ck('engine healthy', await waitHealth(), ENGINE_LOG);

await api('/api/keys', 'POST', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-000' });
await api('/api/sessions', 'POST', { id: SID, title: 'mirror e2e', model: MODEL, provider: PROVIDER });
ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/api/chat?session_id=${SID}`);
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { } };
await new Promise(res => { ws.onopen = res; setTimeout(res, 3000); });

const CUSTOM = 'MIRROR BRIEF for {model} on {date}.\n\n{session}\n\n{controls}';

// 1. default (no selection)
await turn('TURN ONE');
let sys1 = fs.readFileSync(`${CAP_DIR}/cap-00.txt`, 'utf8');
ck('default: the identity line rides', /You are stub-model, hosted via Groq, chatting inside the Doomalay app on the user's own device\. Today is /.test(sys1), '');
ck('default: {repo_access} expanded', sys1.includes('PUBLIC REPO ACCESS'), '');
ck('default: {library} expanded (the block moved from the persona)', sys1.includes('The Doomalay Library'), '');
ck('default: {controls} + {session} expanded', sys1.includes("This chat's controls") && sys1.includes('## Your session'), '');
ck('default: the persona rides after the machinery', sys1.indexOf('## Identity') > sys1.indexOf('## Your session'), '');
ck('default: NO library duplication', (sys1.match(/The Doomalay Library/g) || []).length === 1, String((sys1.match(/The Doomalay Library/g) || []).length));

// 2. custom preamble over the wire
const preList = [{ id: 'pre_e2e', name: 'E2E Brief', text: CUSTOM }];
const pr = await api('/api/sessions/' + SID, 'PATCH', { preambles: JSON.stringify(preList), preamble_sel: 'pre_e2e' });
ck('custom PATCH lands 200', pr.status === 200, JSON.stringify(pr.data).slice(0, 100));
const g1 = await api('/api/sessions/' + SID, 'GET');
ck('the GET round-trips the selection', g1.data.PreambleSel === 'pre_e2e' && (g1.data.Preambles || '').includes('MIRROR BRIEF'), '');
await turn('TURN TWO');
let files = fs.readdirSync(CAP_DIR).sort();
let sys2 = fs.readFileSync(`${CAP_DIR}/${files[files.length - 1]}`, 'utf8');
ck('custom: the template text rides', sys2.includes('MIRROR BRIEF for stub-model on '), '');
ck('custom: {date} substituted to the live date', /MIRROR BRIEF for stub-model on [A-Z][a-z]+day, \d+ \w+ \d{4}\./.test(sys2), '');
ck('custom: {session} + {controls} expanded', sys2.includes('## Your session') && sys2.includes("This chat's controls"), '');
ck('custom: the omitted blocks are ABSENT (no repo/library/artifact)', !sys2.includes('PUBLIC REPO ACCESS') && !sys2.includes('The Doomalay Library'), '');

// 3. off
await api('/api/sessions/' + SID, 'PATCH', { preamble_sel: 'off' });
await turn('TURN THREE');
files = fs.readdirSync(CAP_DIR).sort();
let sys3 = fs.readFileSync(`${CAP_DIR}/${files[files.length - 1]}`, 'utf8');
ck('off: no machinery at all', !sys3.includes("This chat's controls") && !sys3.includes('## Your session') && !sys3.includes('hosted via'), '');
ck('off: the persona IS the prompt', sys3.includes('## Identity'), '');

// 4. stale sel → the default
await api('/api/sessions/' + SID, 'PATCH', { preamble_sel: 'pre_gone' });
await turn('TURN FOUR');
files = fs.readdirSync(CAP_DIR).sort();
let sys4 = fs.readFileSync(`${CAP_DIR}/${files[files.length - 1]}`, 'utf8');
ck('stale: falls back to the app default', sys4.includes('PUBLIC REPO ACCESS') && sys4.includes('## Your session'), '');

const fails = results.filter(r => !r.ok);
console.log(`\nTOTAL: ${results.length - fails.length}/${results.length}`);
pkillEngine();
stubSrv.close();
process.exit(fails.length ? 1 : 0);
