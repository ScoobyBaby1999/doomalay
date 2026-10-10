#!/usr/bin/env node
// v1211-armed-hand-rig.mjs — v1.21.1 THE ARMED HAND rig.
//
// Reproduces the USER'S LIVE BUG over the wire, then proves every fix:
//   · a fake Termux bridge that EXECUTES the received bash for real
//     (the v1204 law: the Termux roots remapped onto a sandbox tree, the
//     resolved paths remapped back so the engine's P| jail echo sees
//     real Termux-shaped strings);
//   · the engine booted with DOOMALAY_TERMUX_BRIDGE, driven EXACTLY the
//     way the PWA drives it — including the PrivateMode browser loop's
//     own tool path: POST /mcp with X-Doomalay-Session (pmsdk.js's
//     pmToolManifest + mcpExecTool, byte-for-byte the same calls).
//
// Scenarios:
//   S0 THE USER'S BUG (pre-fix shape): a session with a bound termux
//      folder but no ⌨ stack → /mcp tools/call termux → the honest
//      not-stacked teach (the v1.20.3 answer was the same class —
//      "not armed (not stacked or no folder)" — now the exact reason).
//   S1 THE AUTO-STACK HEAL: POST /api/workspaces/device with a
//      termux_path + session_id → the session flips ⌨ ON (the bind IS
//      the consent) → the same /mcp call now RUNS.
//   S2 THE PM ARM (the killer fix): tools/list (the manifest, the new
//      whole-userland Desc), tools/call termux help / exec / cmds /
//      write+read / grep / find / session_start+log+kill — every verb
//      through the PM path, executing for real.
//   S3 THE UNARMED HONESTY: a bare session → the not-stacked teach,
//      bridge untouched.
//
// Modes:
//   node scripts/v1211-armed-hand-rig.mjs        run + tear down
//   node scripts/v1211-armed-hand-rig.mjs --keep keep infra up
//   node scripts/v1211-armed-hand-rig.mjs --down tear down
'use strict';

import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const MODE = process.argv[2] || '';

const ENGINE_BIN = '/tmp/doomalay-v1211-engine';
const DATA_DIR = '/tmp/doomalay-v1211-data';
const ENGINE_LOG = '/tmp/v1211-engine.log';
const STATE_FILE = '/tmp/v1211-rig.json';

const ENGINE_PORT = 8094;
const BRIDGE_PORT = 8633;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1211-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;

let okCount = 0, failCount = 0;
function ok(cond, label, extra) {
  if (cond) { okCount++; console.log('  ok - ' + label); }
  else { failCount++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 400) : '')); }
}

// ── the fake Termux tree ───────────────────────────────────────────────
function seedFs() {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.mkdirSync(FAKE_SHARED + '/Doomalay/proj', { recursive: true });
  fs.writeFileSync(FAKE_SHARED + '/Doomalay/proj/notes.txt', 'alpha\nbravo TODO fix\ncharlie\n');
  fs.writeFileSync(FAKE_SHARED + '/Doomalay/proj/tool.py', 'print("py-alive")\n');
}

// intoFake remaps the literal Termux roots into the sandbox tree.
const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
// intoTermux remaps BACK — FAKE_SHARED FIRST (it contains FAKE_HOME as a
// prefix; splitting the home first would mangle the shared paths and the
// engine's P| jail echo would see garbage — the v1204 law).
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);

// ── the fake bridge ────────────────────────────────────────────────────
function startBridge() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, { ok: false, error: 'bad token' }); return; }
    if (req.method === 'GET' && req.url.endsWith('/status')) {
      send(200, { installed: true, version_code: 1022, version_name: '0.119.0-beta.3', permission: true });
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/probe')) {
      send(200, { ok: true, storage_ok: true, props_ok: true, stdout: '__doomalay_probe__\nstorage_ok\nprops_ok\n', stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false });
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/act')) { send(200, { ok: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/run')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        const cmd = intoFake(String(b.command || ''));
        const workdir = b.workdir ? intoFake(String(b.workdir)) : '';
        const timeoutMS = Number(b.timeout_ms) || 60000;
        const p = spawn('bash', ['-c', cmd], {
          env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin', PREFIX: '/usr' },
          cwd: fs.existsSync(workdir) ? workdir : undefined,
        });
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMS + 4000);
        p.on('close', (code, signal) => {
          clearTimeout(timer);
          const timedOut = signal === 'SIGKILL' && Date.now() - startedAt > timeoutMS;
          send(200, {
            ok: true, stdout: intoTermux(out), stderr: intoTermux(errOut),
            exit_code: timedOut ? 124 : (code === null ? 1 : code),
            err: 0, errmsg: null, timeout: timedOut,
          });
        });
        const startedAt = Date.now();
      });
      return;
    }
    send(404, { ok: false, error: 'no route' });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── the engine ─────────────────────────────────────────────────────────
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
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

// ── HTTP helpers ───────────────────────────────────────────────────────
async function jpost(u, body, headers) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
async function jget(u) {
  const r = await fetch(u); const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mcpCall — EXACTLY pmsdk.js's mcpExecTool (the PM browser loop's tool path).
async function mcpCall(sessionId, name, args) {
  return jpost(ENGINE + '/mcp', {
    jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call',
    params: { name, arguments: args || {} },
  }, { 'X-Doomalay-Session': sessionId || '' });
}
async function mcpList(sessionId) {
  return jpost(ENGINE + '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  }, { 'X-Doomalay-Session': sessionId || '' });
}
function toolText(res) {
  const content = (res.body && res.body.result && res.body.result.content) || [];
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
}

// ── teardown ───────────────────────────────────────────────────────────
function tearDown() {
  try { const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); for (const pid of st.pids || []) { try { process.kill(-pid, 'SIGTERM'); } catch (e) {} } } catch (e) {}
  try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
  try { fs.rmSync(ENGINE_BIN, { force: true }); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}
  console.log('torn down');
}

// ── the scenarios ──────────────────────────────────────────────────────
async function run() {
  // boot
  seedFs();
  const bridge = startBridge();
  const build = spawn('/home/z/sdk/go/bin/go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
  await new Promise((r, j) => { build.on('close', (c) => c === 0 ? r() : j(new Error('build failed'))); });
  bootEngine();
  await waitEngine();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pids: [] }));
  console.log('engine up at ' + ENGINE + ', bridge at ' + BRIDGE);

  // a fresh session (the user's shape: privatemodeai, quick chat)
  const mkSession = async (id) => {
    const r = await jpost(ENGINE + '/api/sessions', { id, title: 'PM test', model: 'privatemodeai/glm-5.3-flash', provider: 'privatemodeai', web_search: true });
    return r;
  };

  // ── S0 THE USER'S BUG (the pre-fix shape): folder bound, no ⌨ stack ──
  console.log('S0 — the user\'s bug shape (bound folder, no stack):');
  await mkSession('userchat');
  const dev = await jpost(ENGINE + '/api/workspaces/device', {
    name: 'Test for app', termux_path: TERMUX_SHARED + '/Doomalay/proj', session_id: 'userchat',
  });
  ok(dev.status === 200 && dev.body && dev.body.kind === 'termux', 'the device row saves as kind termux');
  const s0sess = await jget(ENGINE + '/api/sessions/userchat');
  ok(s0sess.body && s0sess.body.Termux === true, 'THE AUTO-STACK: the bind flipped the ⌨ capability on (the bind IS the consent)');
  // (the pre-fix engine answered the session with Termux:false forever —
  //  the not-armed teach. With the auto-stack the same POST heals it.)

  // ── S1 THE PM ARM: the whole verb set through /mcp (pmsdk's path) ────
  console.log('S1 — THE PM ARM (every verb through /mcp, executing for real):');
  const list = await mcpList('userchat');
  const names = ((list.body && list.body.result && list.body.result.tools) || []).map((t) => t.name);
  ok(names.includes('termux'), 'tools/list carries the termux tool for the session');
  const termuxSpec = ((list.body && list.body.result && list.body.result.tools) || []).find((t) => t.name === 'termux');
  ok(!!termuxSpec && /whole Linux userland/.test(termuxSpec.description || ''), 'the manifest Desc teaches the whole-userland capability');
  ok(!!termuxSpec && /cmds/.test(termuxSpec.description || ''), 'the manifest Desc teaches the cmds inventory');

  let res = await mcpCall('userchat', 'termux', { action: 'help' });
  let text = toolText(res);
  ok(/termux tool — a real Termux Linux shell/.test(text), 'PM-path help answers the real help');
  ok(text.includes(TERMUX_SHARED + '/Doomalay/proj'), 'PM-path help lists the REAL bound root');
  ok(/WHOLE LINUX USERLAND/.test(text), 'the help teaches the whole-userland capability');
  ok(/"action":"cmds"/.test(text), 'the help teaches the cmds verb');

  res = await mcpCall('userchat', 'termux', { action: 'exec', args: { command: 'echo pm-arm-alive && ls' } });
  text = toolText(res);
  ok(/pm-arm-alive/.test(text), 'PM-path exec runs for real', text);
  ok(/notes\.txt/.test(text), 'PM-path exec workdir = the bound folder', text);
  ok(/exit_code: 0/.test(text), 'PM-path exec reports the exit code', text);
  // THE PACING PIN (v1.23.1 re-pin: the ≥4s cooldown is GONE — the user's
  // ask): an immediate second exec RUNS (rapid fire is legal now); the
  // anti-burst law lives in the 12/min rolling cap only.
  const paced = await mcpCall('userchat', 'termux', { action: 'exec', args: { command: 'echo paced' } });
  ok(/paced/.test(toolText(paced)), 'the immediate second exec RUNS (no cooldown law)', toolText(paced));

  res = await mcpCall('userchat', 'termux', { action: 'cmds', args: {} });
  text = toolText(res);
  ok(/CMDS — every command available/.test(text), 'the NEW cmds action answers through the PM path');
  ok(/PATH=/.test(text) && /PREFIX=/.test(text), 'cmds carries PATH + PREFIX');
  ok(/bash/.test(text) && /ls /.test(text), 'cmds inventories real commands');
  ok(/exit_code: 0/.test(text), 'cmds exits 0 (the fail-soft script)');

  res = await mcpCall('userchat', 'termux', { action: 'write', args: { path: 'made.txt', content: 'written by the PM arm' } });
  text = toolText(res);
  ok(/WROTE/.test(text), 'PM-path write lands', res.text.slice(0, 400));
  ok(fs.readFileSync(FAKE_SHARED + '/Doomalay/proj/made.txt', 'utf8') === 'written by the PM arm', 'the write is ON DISK');

  res = await mcpCall('userchat', 'termux', { action: 'read', args: { path: 'made.txt' } });
  ok(/written by the PM arm/.test(toolText(res)), 'PM-path read returns the bytes', toolText(res));

  res = await mcpCall('userchat', 'termux', { action: 'grep', args: { pattern: 'TODO' } });
  ok(/bravo TODO fix/.test(toolText(res)), 'PM-path grep finds the hit', toolText(res));

  res = await mcpCall('userchat', 'termux', { action: 'find', args: { name: '*.py' } });
  ok(/tool\.py/.test(toolText(res)), 'PM-path find locates the file', toolText(res));

  res = await mcpCall('userchat', 'termux', { action: 'session_start', args: { name: 'v1211', command: 'sleep 30 && echo done-v1211' } });
  text = toolText(res);
  ok(/SESSION STARTED/.test(text), 'PM-path session_start launches');
  await sleep(700);

  res = await mcpCall('userchat', 'termux', { action: 'session_list', args: {} });
  ok(/v1211/.test(toolText(res)), 'PM-path session_list sees the process');

  res = await mcpCall('userchat', 'termux', { action: 'session_kill', args: { name: 'v1211' } });
  ok(/KILLED/.test(toolText(res)), 'PM-path session_kill stops it');

  // the nested "args" string form (the Def's documented shape)
  await sleep(4300);
  res = await mcpCall('userchat', 'termux', { action: 'exec', args: JSON.stringify({ command: 'echo nested-form-ok' }) });
  ok(/nested-form-ok/.test(toolText(res)), 'the nested args-string form works (the Def\'s shape)', res.text.slice(0, 400));

  // ── S2 THE UNARMED HONESTY (the runner's gate, bridge untouched) ─────
  console.log('S2 — the unarmed honesty:');
  await mkSession('barechat');
  res = await mcpCall('barechat', 'termux', { action: 'exec', args: { command: 'echo hi' } });
  text = toolText(res);
  ok(/the ⌨ Termux capability is not stacked/.test(text), 'the unarmed chat gets the honest not-stacked teach');

  // ── S3 THE PM SYSTEM-MESSAGE TWIN (the PWA-side teaching, static pin) ─
  console.log('S3 — the PWA teaching twin (source pins):');
  const panelSrc = fs.readFileSync(__ROOT + '/engine/internal/server/web/chatpanel.js', 'utf8');
  ok(/THE TERMUX HAND on this chat: the `termux` tool/.test(panelSrc), 'pmSessionContext carries THE TERMUX HAND line');
  ok(/txRoots\.join\(', '\)/.test(panelSrc), 'the PM block lists the REAL jailed roots');
  ok(/r\.ok\)/.test(panelSrc) && /could not save the capability flip/.test(panelSrc), 'persistCaps checks res.ok and toasts the failure (the silent-death fix)');

  // done
  console.log('\n' + okCount + ' ok, ' + failCount + ' FAIL');
  if (MODE !== '--keep') { bridge.close(); tearDown(); }
  else { fs.writeFileSync(STATE_FILE, JSON.stringify({ pids: [], engine: ENGINE, bridge: BRIDGE })); console.log('kept up: ' + STATE_FILE); }
  process.exit(failCount > 0 ? 1 : 0);
}

if (MODE === '--down') { tearDown(); process.exit(0); }
run().catch((e) => { console.error('RIG ERROR:', e.message); process.exit(1); });
