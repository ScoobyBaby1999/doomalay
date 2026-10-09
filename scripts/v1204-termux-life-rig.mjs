#!/usr/bin/env node
// v1204-termux-life-rig.mjs — v1.20.4 THE REDTEAM rig (PLAN-V120 §v1.20.4).
//
// Speaks to a LIVE engine exactly the way the PWA does, against a fake
// Termux bridge that EXECUTES the received bash commands for real (the
// Termux paths remapped onto a sandbox tree — the v1202 Go tests' law,
// now over the wire) plus the v1194-style OpenAI stub that plays a REAL
// termux tool turn (round 1: the tool call; round 2: the answer).
//
// Infra (the v1175 rig's daemonized-boot pattern):
//   · fake bridge :8631 — /<token>/{status,probe,run,act} + the v1.20.1
//     checkin route + /__control (the ladder: not_installed → installed →
//     bootstrapped → ready, dead) + /run EXECUTES bash with HOME=FAKE_HOME,
//     the literal Termux roots remapped onto FAKE_SHARED/FAKE_HOME and the
//     resolved paths remapped BACK (the engine's P| jail echo + prefix
//     checks see real Termux-shaped strings).
//   · OpenAI stub :8632 — /models + the two-round termux tool turn.
//   · the engine :8093 — DOOMALAY_TERMUX_BRIDGE + DOOMALAY_OTA_DISABLE=1,
//     data-dir /tmp/doomalay-v1204-data, log /tmp/v1204-engine.log.
//
// Scenarios (plain HTTP JSON, the v1175 law — honest states, never a 5xx
// for Termux-side problems):
//   L1 the fs ladder — listing shape, alias resolution, navigation,
//      mkdir+reflect, the jail refusals (.., foreign absolute, symlink
//      laundering), the TRUNCATED honesty at 500 entries.
//   L2 the device workspace round-trip — POST device {termux_path} → the
//      termux row → GET/PUT the ws file (the stdin write law, verified
//      ON DISK) → non-termux ws refusal.
//   L3 the quiet gate — the suppression law end-to-end (probe_suppressed
//      with a known-not-props cache; ZERO probes past TTL), the checkin
//      route flipping bootstrap_done through the ENGINE's status, the
//      refresh=1 escape hatch.
//
// Modes:
//   node scripts/v1204-termux-life-rig.mjs          run + tear down
//   node scripts/v1204-termux-life-rig.mjs --keep   keep infra up for E2E
//                                                   (state /tmp/v1204-rig.json)
//   node scripts/v1204-termux-life-rig.mjs --down   tear down
'use strict';

import http from 'node:http';
import { spawn, execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');

const ENGINE_BIN = '/tmp/doomalay-v1204-engine';
const DATA_DIR = '/tmp/doomalay-v1204-data';
const ENGINE_LOG = '/tmp/v1204-engine.log';
const STATE_FILE = '/tmp/v1204-rig.json';

const ENGINE_PORT = 8093;
const BRIDGE_PORT = 8631;
const STUB_PORT = 8632;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

// The sandbox Termux: FAKE_HOME stands in for /data/data/com.termux/files/home
// (with HOME= at exec time), FAKE_SHARED for /storage/emulated/0.
const FAKE_HOME = '/tmp/v1204-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;

let okCount = 0, failCount = 0;
function ok(cond, label, extra) {
  if (cond) { okCount++; console.log('  ok - ' + label); }
  else { failCount++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
}

// ── the fake shared tree ────────────────────────────────────────────────
function seedFs() {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.mkdirSync(FAKE_SHARED + '/Download', { recursive: true });
  fs.mkdirSync(FAKE_SHARED + '/Documents/notes', { recursive: true });
  fs.mkdirSync(FAKE_SHARED + '/Doomalay', { recursive: true });
  fs.mkdirSync(FAKE_HOME + '/.termux', { recursive: true });
  fs.writeFileSync(FAKE_HOME + '/.termux/termux.properties', 'allow-external-apps = true\n');
  fs.writeFileSync(FAKE_SHARED + '/Download/invoice.pdf.txt', 'fake pdf bytes\n');
  fs.writeFileSync(FAKE_SHARED + '/Documents/notes/todo.md', '- buy milk\n');
  fs.writeFileSync(FAKE_SHARED + '/Doomalay/hello.txt', 'hello from the fake shared tree\n');
  // the launderer: a symlink pointing OUTSIDE the jail from inside it
  try { fs.symlinkSync('/etc', FAKE_SHARED + '/Documents/laundry'); } catch (e) { /* ok */ }
  // the TRUNCATED proof: 600 files in one dir
  execSync(`for i in $(seq 1 600); do : > "${FAKE_SHARED}/Download/bulk-$i.txt"; done`);
}

// remap Termux-side literal paths → the sandbox tree (and back)
const intoFake = (s) => String(s).split(TERMUX_SHARED).join(FAKE_SHARED).split(TERMUX_HOME).join(FAKE_HOME);
const backToTermux = (s) => String(s).split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);

// ── the fake bridge (executes for real) ────────────────────────────────
const bridge = { state: 'not_installed', checkin: false, checkinHits: 0, probeHits: 0, runHits: 0, runCmds: [] };

function ladderStatus() {
  const s = {
    installed: true, version_code: 1022, version_name: '0.119.0-beta.3-rig',
    permission: false, checkin_url: BRIDGE + '/' + TOKEN + '/checkin',
    bootstrap_done: !!bridge.checkin || bridge.state === 'bootstrapped' || bridge.state === 'ready',
    checkin_at: bridge.checkin ? Math.floor(Date.now() / 1000) - 30 : 0,
    checkin_storage: !!bridge.checkin, checkin_props: !!bridge.checkin,
  };
  if (bridge.state === 'not_installed') { s.installed = false; }
  if (bridge.state === 'ready') { s.permission = true; }
  return s;
}
function ladderProbe() {
  const st = bridge.state;
  if (st === 'not_installed' || st === 'installed' || st === 'no_permission') {
    return { ok: false, storage_ok: false, props_ok: false, stdout: '', stderr: '', exit_code: -1, err: 0, errmsg: 'send-side: rung ' + st, timeout: false, send_error: 'ladder rung ' + st };
  }
  return {
    ok: true, storage_ok: true, props_ok: true,
    stdout: '__doomalay_probe__\nstorage_ok\nprops_ok\n', stderr: '', exit_code: 0,
    err: 0, errmsg: null, timeout: false,
    stdout_original_length: -1, stderr_original_length: -1,
  };
}

function startBridge() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/__control' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          if (d.state) { bridge.state = String(d.state); bridge.checkin = false; bridge.probeHits = 0; bridge.runHits = 0; bridge.runCmds = []; }
          if (d.reset) { bridge.state = 'not_installed'; bridge.checkin = false; bridge.probeHits = 0; bridge.runHits = 0; bridge.runCmds = []; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400); res.end('{"error":"bad control"}'); }
      });
      return;
    }
    if (req.url === '/__state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bridge));
      return;
    }
    if (bridge.state === 'dead') { res.socket.destroy(); return; }

    const readBody = (cb) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { void cb(b); });
    };
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    const prefix = '/' + TOKEN + '/';
    if (!req.url.startsWith(prefix)) { res.writeHead(403); res.end('{"error":"forbidden"}'); return; }
    const route = req.url.slice(prefix.length).split('?')[0];

    if (route === 'status' && req.method === 'GET') { json(200, ladderStatus()); return; }

    if (route === 'checkin' && req.method === 'GET') {
      bridge.checkinHits++;
      bridge.checkin = true;
      json(200, { ok: true });
      return;
    }

    if (route === 'probe' && req.method === 'POST') {
      bridge.probeHits++;
      json(200, ladderProbe());
      return;
    }

    if (route === 'run' && req.method === 'POST') {
      bridge.runHits++;
      readBody(async (b) => {
        let cmd = '', stdin = null, timeoutMs = 60000;
        try {
          const o = JSON.parse(b || '{}');
          cmd = o.command || ''; stdin = (o.stdin === undefined) ? null : o.stdin;
          if (o.timeout_ms) timeoutMs = o.timeout_ms;
        } catch (e) { json(400, { error: 'missing command' }); return; }
        if (!cmd) { json(400, { error: 'missing command' }); return; }
        bridge.runCmds.push(cmd.slice(0, 120));
        // THE REAL EXECUTION: bash with HOME=FAKE_HOME, the Termux literals
        // remapped in, the output remapped back (the engine's jail echo +
        // prefix checks see real Termux-shaped strings).
        const exec = () => new Promise((resolve) => {
          const p = spawn('bash', ['-c', intoFake(cmd)], {
            env: { ...process.env, HOME: FAKE_HOME },
            cwd: FAKE_HOME,
          });
          let out = '', errS = '';
          const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, Math.min(timeoutMs, 90000));
          p.stdout.on('data', (d) => { out += d; });
          p.stderr.on('data', (d) => { errS += d; });
          p.on('close', (code) => {
            clearTimeout(timer);
            resolve({
              ok: true, stdout: backToTermux(out).slice(0, 102400),
              stderr: backToTermux(errS).slice(0, 2048), exit_code: code == null ? -1 : code,
              err: 0, errmsg: null, timeout: false,
              stdout_original_length: out.length, stderr_original_length: errS.length,
            });
          });
          p.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout: '', stderr: 'spawn failed', exit_code: -1, err: 1, errmsg: 'spawn failed', timeout: false }); });
          if (stdin !== null) { try { p.stdin.write(stdin); } catch (e) {} }
          try { p.stdin.end(); } catch (e) {}
        });
        const r = await exec();
        json(200, r);
      });
      return;
    }

    if (route === 'act' && req.method === 'POST') {
      readBody((b) => {
        let what = '';
        try { what = JSON.parse(b || '{}').what || ''; } catch (e) {}
        if (what === 'open_termux' || what === 'open_fdroid' || what === 'open_permission_settings') {
          json(200, { ok: true });
        } else { json(400, { error: 'unknown what' }); }
      });
      return;
    }
    res.writeHead(404); res.end('{"error":"not found"}');
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── the OpenAI stub (the v1194 pattern + the termux tool turn) ──────────
function startStub() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  const srv = http.createServer(async (req, res) => {
    const url = req.url.replace(/\?.*$/, '');
    if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub/termuxful' }] }));
      return;
    }
    if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      const hasToolResult = (parsed.messages || []).some((m) => m.role === 'tool');
      const toolsSeen = (parsed.tools || []).map((t) => t.function && t.function.name).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (!hasToolResult) {
        // round 1: narrate + call the termux tool (exec)
        sse(res, { choices: [{ delta: { content: 'Running it on the device shell.' } }] });
        await sleep(100);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_tx1', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(50);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: { command: 'echo termux-exec-alive && ls' } }) } }] } }] });
        await sleep(50);
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const toolOut = (parsed.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join('\n');
        const sawTool = toolsSeen.indexOf('termux') >= 0;
        const words = ['The', 'device', 'shell', 'answered', '—', String(toolOut.length), 'bytes.', sawTool ? '(termux tool was armed in the manifest)' : '(WARNING: termux NOT in manifest)'];
        for (const w of words) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(40); }
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  srv.listen(STUB_PORT, '127.0.0.1');
  return srv;
}

// ── the engine boot (the v1175 daemonized pattern) ──────────────────────
function buildEngine() {
  execFileSync('go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'), stdio: 'inherit',
  });
}
function bootEngine() {
  const env = {
    ...process.env,
    DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN,
    DOOMALAY_OTA_DISABLE: '1',
  };
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN,
    '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR],
    { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(ENGINE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* booting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('engine never became healthy');
}

// ── tiny HTTP helpers ───────────────────────────────────────────────────
async function jget(u) { const r = await fetch(u); const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {} return { status: r.status, body: d, text: t }; }
async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
async function jput(u, body) {
  const r = await fetch(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the scenarios ───────────────────────────────────────────────────────
async function L1_fsLadder() {
  console.log('L1 — the fs ladder (real execution through the bridge):');
  const list = async (p) => jget(ENGINE + '/api/termux/fs?path=' + encodeURIComponent(p));

  await control({ state: 'ready' });
  await sleep(300);

  let r = await list('shared');
  ok(r.status === 200 && r.body && r.body.ok !== false, 'the shared root lists (HTTP 200)');
  ok(r.body && typeof r.body.path === 'string' && r.body.path === TERMUX_SHARED,
    'the resolved path is the real Termux shared root', JSON.stringify(r.body && r.body.path));
  const names = (r.body && r.body.entries || []).map((e) => e.name);
  ok(names.indexOf('Download') >= 0 && names.indexOf('Documents') >= 0 && names.indexOf('Doomalay') >= 0,
    'the seeded dirs are there (Download/Documents/Doomalay)');
  const dl = (r.body && r.body.entries || []).find((e) => e.name === 'Download');
  ok(dl && dl.dir === true, 'Download is a dir entry');
  ok((r.body.entries || []).every((e) => e.name !== 'laundry' || e.dir), 'entries carry the dir flag');

  r = await list('shared/Documents/notes');
  ok(r.status === 200 && (r.body.entries || []).some((e) => e.name === 'todo.md'), 'subpath navigation works');
  r = await list('shared/Download');
  const bulk = (r.body.entries || []).filter((e) => /^bulk-/.test(e.name)).length;
  ok(bulk === 500, 'the cap returns 500 entries (the honest ceiling)', 'got ' + bulk);
  ok(r.body.truncated === true && r.body.total === 601, 'the TRUNCATED honesty fires with the true total (600 bulk + 1 file = 601)', JSON.stringify({ t: r.body.truncated, total: r.body.total }));

  r = await list('downloads');
  ok(r.status === 200, 'the downloads alias resolves');
  r = await list('home');
  ok(r.status === 200 && (r.body.entries || []).some((e) => e.name === '.termux'), 'the home alias lists dotted entries');

  // THE JAIL
  r = await list('home/..');
  ok(r.status === 400, 'the .. escape out of home is refused (400)', r.status);
  r = await list('shared/../../../../..');
  ok(r.status === 400, 'the deep .. escape out of shared is refused (400)', r.status);
  r = await list('/etc');
  ok(r.status === 400, 'a foreign absolute path is refused (400)', r.status);
  r = await list('/data/data/com.other.app/files');
  ok(r.status === 400, 'another app\'s data dir is refused', r.status);
  r = await list('shared/Documents/laundry');
  ok(r.status === 400, 'the symlink launderer is refused (readlink -f resolves outside)', r.status);

  // mkdir + reflect
  r = await jpost(ENGINE + '/api/termux/fs', { action: 'mkdir', path: 'shared/Doomalay', name: 'rig-made' });
  ok(r.status === 200 && r.body.ok !== false, 'mkdir under a root works');
  ok(fs.existsSync(FAKE_SHARED + '/Doomalay/rig-made'), 'mkdir landed ON the fake tree (real execution)');
  r = await list('shared/Doomalay');
  ok((r.body.entries || []).some((e) => e.name === 'rig-made'), 'the listing reflects the new folder');
  r = await jpost(ENGINE + '/api/termux/fs', { action: 'mkdir', path: 'shared', name: '../evil' });
  ok(r.status === 400, 'a mkdir with .. in the name is refused');
}

async function L2_deviceRoundTrip() {
  console.log('L2 — the device workspace round-trip:');
  const mk = await jpost(ENGINE + '/api/workspaces/device', {
    name: 'rig device', termux_path: TERMUX_SHARED + '/Doomalay', session_id: '',
  });
  ok(mk.status === 200 && mk.body && mk.body.id, 'POST device {termux_path} creates a row');
  ok(mk.body && mk.body.kind === 'termux', 'the row is Kind termux', JSON.stringify(mk.body && mk.body.kind));
  const wsId = mk.body && mk.body.id;

  const r1 = await jget(ENGINE + '/api/workspaces/' + wsId + '/file?path=hello.txt');
  ok(r1.status === 200 && r1.body && typeof r1.body.content === 'string' && r1.body.content.indexOf('hello from the fake shared tree') >= 0,
    'GET the ws file (the jailed cat)', r1.text && r1.text.slice(0, 120));
  ok(r1.body && r1.body.size > 0, 'the read carries the size');

  const w = await jput(ENGINE + '/api/workspaces/' + wsId + '/file', { path: 'written.txt', content: 'written by the rig via stdin\n' });
  ok(w.status === 200 && w.body && w.body.ok !== false, 'PUT writes through the stdin law');
  const onDisk = fs.readFileSync(FAKE_SHARED + '/Doomalay/written.txt', 'utf8');
  ok(onDisk === 'written by the rig via stdin\n', 'the written bytes landed ON DISK exactly');

  // a non-termux workspace refuses the file verbs honestly
  const mk2 = await jpost(ENGINE + '/api/workspaces/device', { name: 'old device row', path: 'Z:/picked', session_id: '' });
  const r2 = await jget(ENGINE + '/api/workspaces/' + mk2.body.id + '/file?path=x');
  ok(r2.status >= 400 && r2.body && r2.body.error, 'a non-termux device row refuses the file verb honestly (the forge\'s own refusal — never a 200 lie)', r2.status + ' ' + (r2.text || '').slice(0, 100));
}

async function L3_quietGate() {
  console.log('L3 — THE QUIET GATE (suppression + the checkin):');
  await control({ state: 'no_permission', reset: true });
  await sleep(200);
  // burn one status (the first look probes once)
  let r = await jget(ENGINE + '/api/termux/status');
  ok(r.status === 200 && r.body && r.body.available === true, 'status answers honestly at the rung');
  const firstProbes = (await jget(BRIDGE + '/__state')).body.probeHits;
  ok(firstProbes >= 1, 'the first look fired ONE probe (to learn the state)');
  // past TTL with a known-not-props cache: ZERO further probes
  await sleep(31000);
  for (let i = 0; i < 3; i++) { await jget(ENGINE + '/api/termux/status'); }
  const afterProbes = (await jget(BRIDGE + '/__state')).body.probeHits;
  ok(afterProbes === firstProbes, 'ZERO probes past TTL while known-not-props (the spam is dead)', 'probes: ' + firstProbes + ' → ' + afterProbes);
  r = await jget(ENGINE + '/api/termux/status');
  ok(r.body.probe_suppressed === true, 'probe_suppressed is a visible state');
  ok(String(r.body.last_error || '').indexOf('bootstrap') >= 0, 'the paused line names the bootstrap wait');

  // the refresh escape hatch (explicit user action)
  r = await jget(ENGINE + '/api/termux/status?refresh=1');
  const refreshProbes = (await jget(BRIDGE + '/__state')).body.probeHits;
  ok(refreshProbes > afterProbes, 'refresh=1 forces a probe (the explicit user action)');

  // THE CHECKIN: the setup script's curl flips the ladder without commands
  const st = await jget(ENGINE + '/api/termux/status');
  const checkinUrl = st.body && st.body.checkin_url;
  ok(typeof checkinUrl === 'string' && /127\.0\.0\.1/.test(checkinUrl), 'the engine exposes the checkin URL');
  const c = await jget(checkinUrl + '?storage=1&props=1');
  ok(c.status === 200 && c.body && c.body.ok === true, 'the checkin route answers');
  await sleep(200);
  r = await jget(ENGINE + '/api/termux/status');
  ok(r.body.bootstrap_done === true, 'the ENGINE sees bootstrap_done through the bridge status');
  ok(r.body.checkin_storage === true && r.body.checkin_props === true, 'the script\'s own step outcomes ride along');

  // now the ladder completes: permission rung → ready
  await control({ state: 'ready' });
  await sleep(200);
  // within the 30s TTL the cache honestly serves the stale rung — the
  // setup page's verify stage (and every act) forces the refresh:
  r = await jget(ENGINE + '/api/termux/status');
  ok(r.body.ready === false, 'within the TTL the stale rung serves (the cache is honest)');
  r = await jget(ENGINE + '/api/termux/status?refresh=1');
  ok(r.body.ready === true, 'the forced re-probe completes the ladder to ready');
}

async function control(payload) { await jpost(BRIDGE + '/__control', payload); }

// ── main ────────────────────────────────────────────────────────────────
async function up() {
  seedFs();
  buildEngine();
  startBridge();
  startStub();
  bootEngine();
  await waitEngine();
  if (process.argv.includes('--keep')) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ engine: ENGINE, bridge: BRIDGE, stub: 'http://127.0.0.1:' + STUB_PORT, token: TOKEN }));
    console.log('v1204 rig infra UP (keep mode): engine ' + ENGINE + ' · bridge ' + BRIDGE + ' · stub :8632');
  }
}

async function down() {
  try { execSync('pkill -f "' + ENGINE_BIN + '" || true'); } catch (e) {}
  try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}
  console.log('v1204 rig infra DOWN');
}

async function main() {
  if (process.argv.includes('--down')) { await down(); return; }
  await up();
  try {
    await L1_fsLadder();
    await L2_deviceRoundTrip();
    await L3_quietGate();
  } catch (e) {
    failCount++;
    console.log('  FAIL - rig crashed: ' + (e && e.message));
  }
  console.log('');
  console.log('v1204 termux-life rig: ' + okCount + ' passed, ' + failCount + ' failed');
  if (!process.argv.includes('--keep')) {
    await down();
    process.exit(failCount > 0 ? 1 : 0);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
