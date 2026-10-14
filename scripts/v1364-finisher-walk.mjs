#!/usr/bin/env node
// v1364-finisher-walk.mjs — v1.36.0 THE FINISHER WAVE, the LIVE walk.
// The real engine binary + a REAL-executing bridge stub + the REAL setup.sh:
//   W1  an OFFLINE first setup (the real script, sandboxed $HOME, no
//       network) leaves the ledger pending + resume.sh on the device
//   W2  the engine SEES the pending ledger through the bridge (status:
//       pkgs_pending=true) and the ready-ladder stays green
//   W3  the OFFLINE resume (the engine fires resume.sh through the bridge)
//       is a seconds-fast honest no-op — the ledger stands, last_ok=true
//   W4  the NETWORK RETURNS: the resume really runs, the ledger flips to
//       pkgs=ok, the status answers the full truth, the bell rides
//   W5  the composed resume command carried the fresh --checkin URL (and
//       the bell's query is the resume=1&pkgs=1 truth)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const ENGINE_BIN = '/tmp/doomalay-v1364-engine';
const ENGINE_PORT = 8097;
const BRIDGE_PORT = 8098;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const TOKEN = crypto.randomUUID();
const CHECKIN_TOKEN = crypto.randomUUID();
const CHECKIN_URL = `http://127.0.0.1:${BRIDGE_PORT}/${CHECKIN_TOKEN}/checkin`;
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1364-home-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1364-data-'));
const BIN = path.join(FAKE_HOME, 'bin');
fs.mkdirSync(BIN, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the device stubs (pkg / curl / the termux tools) ───────────
// offline=true: the mirror probe fails (exit 7); checkin URLs still REALLY
// hit the bridge (the stub curls them for real). pkgWorks: the apt pair.
function writeStubs({ offline, pkgWorks }) {
  // the checkin bell REALLY rides /usr/bin/curl (absolute path — the stub
  // dir is first in PATH, a bare 'curl' would recurse into itself forever)
  fs.writeFileSync(path.join(BIN, 'curl'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const url = args.filter(a => a.startsWith('http'))[0] || '';
if (url.includes('/checkin')) {
  const { execFileSync } = require('child_process');
  try { execFileSync('/usr/bin/curl', ['-fsS', '--max-time', '6', url], { stdio: 'ignore' }); } catch (e) {}
  process.exit(0);
}
process.exit(${offline ? 7 : 0});
`);
  fs.chmodSync(path.join(BIN, 'curl'), 0o755);
  fs.writeFileSync(path.join(BIN, 'pkg'),
    `#!/usr/bin/env node\nprocess.exit(${pkgWorks ? 0 : 100});\n`);
  fs.chmodSync(path.join(BIN, 'pkg'), 0o755);
  for (const tool of ['termux-wake-lock', 'termux-wake-unlock', 'termux-reload-settings', 'termux-setup-storage']) {
    fs.writeFileSync(path.join(BIN, tool),
      tool === 'termux-setup-storage'
        ? `#!/usr/bin/env node\nrequire('fs').mkdirSync(${JSON.stringify(path.join(FAKE_HOME, 'storage', 'shared'))}, { recursive: true });\nprocess.exit(0);\n`
        : '#!/usr/bin/env node\nprocess.exit(0);\n');
    fs.chmodSync(path.join(BIN, tool), 0o755);
  }
}

// ── the bridge stub (the REAL executor — the v1204 pattern) ────
const bridge = { runCmds: [], checkinHits: [] };
function startBridge() {
  const srv = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    console.error('[bridge] ' + req.method + ' ' + req.url);
    const urlPath = req.url.replace(/\?.*$/, '');
    if (urlPath === '/' + CHECKIN_TOKEN + '/checkin') {
      bridge.checkinHits.push(req.url);
      json(200, { ok: true });
      return;
    }
    // the token guards the SUBTREE (the Kotlin contract): /<token>/status,
    // /<token>/probe, /<token>/run, /<token>/act — anything else is 403
    if (!urlPath.startsWith('/' + TOKEN + '/')) { json(403, { error: 'bad token' }); return; }
    const route = urlPath.slice(TOKEN.length + 1);
    if (route === '/status' && req.method === 'GET') {
      json(200, {
        installed: true, api_installed: false, version_code: 1002,
        version_name: '0.118.3', permission: true,
        checkin_url: CHECKIN_URL, bootstrap_done: true,
        checkin_at: Math.floor(Date.now() / 1000), checkin_storage: true, checkin_props: true,
      });
      return;
    }
    if (route === '/probe' && req.method === 'POST') {
      const storage = fs.existsSync(path.join(FAKE_HOME, 'storage', 'shared'));
      const props = fs.readFileSync(path.join(FAKE_HOME, '.termux', 'termux.properties'), 'utf8')
        .includes('allow-external-apps');
      json(200, {
        ok: true,
        stdout: '__doomalay_probe__\n' + (storage ? 'storage_ok\n' : 'storage_missing\n') + (props ? 'props_ok\n' : 'props_missing\n'),
        stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false,
      });
      return;
    }
    if (route === '/run' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        const o = JSON.parse(body || '{}');
        const cmd = o.command || '';
        bridge.runCmds.push(cmd);
        // THE REAL EXECUTION: bash with HOME=FAKE_HOME and the device PATH.
        // The sandbox pid cap can EAGAIN a spawn — one honest retry.
        const runOnce = () => new Promise((resolve) => {
          const p = spawn('bash', ['-c', cmd], {
            env: { ...process.env, HOME: FAKE_HOME, PATH: BIN + ':' + (process.env.PATH || '') },
            cwd: FAKE_HOME,
          });
          let out = '', errS = '', settled = false;
          const done = (r) => { if (!settled) { settled = true; resolve(r); } };
          const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 120000);
          p.stdout.on('data', (d) => { out += d; });
          p.stderr.on('data', (d) => { errS += d; });
          p.on('close', (code) => { clearTimeout(timer); done({ ok: true, stdout: out.slice(0, 102400), stderr: errS.slice(0, 2048), exit_code: code == null ? -1 : code, err: 0, errmsg: null, timeout: false }); });
          p.on('error', (e) => { clearTimeout(timer); done({ ok: false, spawnErr: e.code || 'spawn', stdout: '', stderr: '', exit_code: -1, err: 1, errmsg: String(e.code || 'spawn'), timeout: false }); });
        });
        let r = await runOnce();
        if (r.spawnErr === 'EAGAIN' || r.spawnErr === 'spawn') {
          await sleep(500);
          r = await runOnce();
        }
        delete r.spawnErr;
        json(200, r);
      });
      return;
    }

    if (route === '/act' && req.method === 'POST') { json(200, { ok: true }); return; }
    json(404, { error: 'not found' });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── W1: the OFFLINE first setup (the real script, sandboxed) ───
console.log('W1 — the offline first setup (the real termux/setup.sh):');
writeStubs({ offline: true, pkgWorks: false });
const setupRun = spawnSync('bash', [path.join(ROOT, 'termux', 'setup.sh'), '--checkin', CHECKIN_URL], {
  env: { ...process.env, HOME: FAKE_HOME, PATH: BIN + ':' + (process.env.PATH || ''), DM_COLS: '60' },
  encoding: 'utf8', timeout: 120000,
});
ok('W1: the setup completed (exit 0) despite no network', setupRun.status === 0,
  'exit=' + setupRun.status + ' sig=' + setupRun.signal + ' err=' + (setupRun.error && setupRun.error.message) + '\nSTDOUT-tail: ' + (setupRun.stdout || '').slice(-400) + '\nSTDERR-tail: ' + (setupRun.stderr || '').slice(-400));
ok('W1: the ledger says pkgs=pending',
  fs.readFileSync(path.join(FAKE_HOME, '.doomalay-setup', 'state'), 'utf8').includes('pkgs=pending'));
ok('W1: resume.sh waits on the device',
  fs.existsSync(path.join(FAKE_HOME, '.doomalay-setup', 'resume.sh')));

// ── the engine boot ────────────────────────────────────────────
try { execFileSync('pkill', ['-f', 'doomalay-v1364-engine']); } catch (e) {}
await sleep(300);
const bridgeSrv = startBridge();
// the sandbox pid cap kills node-spawned go builds — the prebuilt binary
// (built in the shell: go build -p 2 -o /tmp/doomalay-v1364-engine ./cmd/doomalay)
// is reused when present, built otherwise
if (!fs.existsSync(ENGINE_BIN)) {
  execFileSync('go', ['build', '-p', '2', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: path.join(ROOT, 'engine'), stdio: 'inherit', env: { ...process.env, GOMAXPROCS: '2' } });
}
const ENGINE_LOG = '/tmp/doomalay-v1364-engine.log';
const eng = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
  env: { ...process.env, DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN, DOOMALAY_OTA_DISABLE: '1', GOMAXPROCS: '2' },
  detached: true, stdio: ['ignore', fs.openSync(ENGINE_LOG, 'a'), fs.openSync(ENGINE_LOG, 'a')],
});
eng.unref();
async function waitEngine() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never became healthy');
}
async function jget(u) { const r = await fetch(u); const t = await r.text(); return { status: r.status, body: JSON.parse(t || '{}') }; }
async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); return { status: r.status, body: JSON.parse(t || '{}') };
}
const ledgerOf = () => fs.readFileSync(path.join(FAKE_HOME, '.doomalay-setup', 'state'), 'utf8');

try {
  await waitEngine();
  console.log('\nW2 — the engine sees the pending ledger through the bridge:');
  let r = await jget(ENGINE + '/api/termux/status?refresh=1');
  ok('W2: the status answers ready:true (the shell ladder is green)', r.body.ready === true, JSON.stringify({ ready: r.body.ready, err: r.body.last_error }));
  ok('W2: the status surfaces pkgs_pending:true', r.body.pkgs_pending === true, 'pkgs_state=' + r.body.pkgs_state);
  ok('W2: the state read ran through the bridge (the marker law held)',
    bridge.runCmds.some(c => c.includes('__doomalay_state__')));

  console.log('\nW3 — the offline resume (the engine fires the real resume.sh):');
  // wait out the auto-attempt's own first fire (the forced poll above fired
  // it); give the executor a moment, then use the explicit door
  await sleep(1500);
  let before = bridge.runCmds.length;
  r = await jpost(ENGINE + '/api/termux/resume', {});
  ok('W3: the door answers ok (started or already running)', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  // wait for the executor to really land
  let waited = 0;
  while (waited < 30000) {
    const st = await jget(ENGINE + '/api/termux/status');
    if (st.body.resume_running === false && st.body.resume_last_at > 0) break;
    await sleep(300); waited += 300;
  }
  r = await jget(ENGINE + '/api/termux/status?refresh=1');
  ok('W3: the offline resume was an HONEST no-op (last_ok=true)',
    r.body.resume_last_ok === true, 'err=' + r.body.resume_last_error);
  ok('W3: the ledger still says pending (nothing was touched)',
    ledgerOf().includes('pkgs=pending'));
  ok('W3: the offline resume was FAST (no hang)',
    r.body.resume_last_error === '', JSON.stringify(r.body));

  console.log('\nW4 — the network returns (the finisher really pays):');
  writeStubs({ offline: false, pkgWorks: true });   // the device came online
  const cmdsBefore = bridge.runCmds.length;
  r = await jpost(ENGINE + '/api/termux/resume', {});
  ok('W4: the door starts the finisher', r.status === 200 && r.body.started === true, JSON.stringify(r.body));
  waited = 0;
  let flipped = false;
  while (waited < 60000) {
    const st = await jget(ENGINE + '/api/termux/status?refresh=1');
    if (st.body.pkgs_state === 'ok') { flipped = true; r = st; break; }
    await sleep(500); waited += 500;
  }
  ok('W4: the ledger FLIPPED to pkgs=ok and the status tells it', flipped, 'pkgs_state=' + (r.body || {}).pkgs_state);
  ok('W4: the engine really ran the finisher (a new resume command)',
    bridge.runCmds.slice(cmdsBefore).some(c => c.includes('resume.sh')));

  console.log('\nW5 — the bell and the fresh URL:');
  const resumeCmds = bridge.runCmds.filter(c => c.includes('resume.sh'));
  const lastResume = resumeCmds[resumeCmds.length - 1] || '';
  ok('W5: the composed command carried the fresh --checkin URL',
    lastResume.includes('--checkin ' + CHECKIN_URL), JSON.stringify(lastResume));
  ok('W5: the bell rang with the resume truth (resume=1&pkgs=1)',
    bridge.checkinHits.some(u => u.includes('resume=1') && u.includes('pkgs=1')),
    JSON.stringify(bridge.checkinHits));

  console.log('\nW6 — the door refuses when there is nothing pending:');
  r = await jpost(ENGINE + '/api/termux/resume', {});
  ok('W6: nothing pending → the honest 400',
    r.status === 400 && String(r.body.error || '').includes('nothing pending'), JSON.stringify(r.body));
} finally {
  try { process.kill(-eng.pid, 'SIGKILL'); } catch (e) {}
  try { bridgeSrv.close(); } catch (e) {}
  console.log('\nv1364 walk infra down');
}
console.log('\nv1364 finisher walk: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
