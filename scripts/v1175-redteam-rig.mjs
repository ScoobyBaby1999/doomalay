#!/usr/bin/env node
// v1175-redteam-rig.mjs — v1.17.5 THE REDTEAM rig (PLAN-V117 §v1.17.5).
//
// Speaks to a LIVE engine exactly the way the PWA does, against two fake
// servers that implement the REAL contracts byte-for-byte:
//
//   · the fake Termux bridge — the Kotlin TermuxBridgeServer's HTTP
//     contract (GET /<token>/status, POST /<token>/probe, POST
//     /<token>/run, POST /<token>/act; 403 on token mismatch) with a
//     control endpoint (POST /__control {"state":…}) that flips its
//     answers through the device ladder: not_installed → installed →
//     no_permission → bridge_ok → ready, plus dead / slow.
//   · the fake OTA server — /patch-manifest.json + file contents at the
//     exact paths ota.FileURL resolves for a non-github manifest URL
//     (the manifest's own directory + the repo-root-relative path), with
//     a control endpoint switching valid_update / corrupt /
//     engine_required / unreachable.
//
// The engine is spawned daemonized (nohup setsid — this sandbox reaps
// normal spawns) with DOOMALAY_TERMUX_BRIDGE + DOOMALAY_OTA_URL env,
// --port 8090 --bind 127.0.0.1 --data-dir /tmp/doomalay-redteam-data,
// log at /tmp/redteam-engine.log. A second short-lived engine (8091,
// WRONG token) proves the wrong-token honesty law (S5).
//
// Scenarios (asserted over plain HTTP JSON):
//   S1 the pivot contract (index.html pins + quick-by-birth sessions +
//      the capability stack round-trip)
//   S2 the termux status ladder (every rung + dead + slow + the cache)
//   S3 the act passthrough (happy + honest 4xx/502)
//   S4 the OTA ladder (update → download → overlay law → current →
//      corrupt → engine_required → unreachable)
//   S5 the wrong-token bridge (honest status, never a 500 loop)
//
// Modes:
//   node scripts/v1175-redteam-rig.mjs          run the scenarios, then tear down
//   node scripts/v1175-redteam-rig.mjs --keep   run the scenarios, KEEP the
//                                                live infra up for the E2E
//                                                (state file /tmp/v1175-rig.json)
//   node scripts/v1175-redteam-rig.mjs --down   tear the infra down
//
// THE REAPER LAW (this sandbox): --keep must itself be daemonized the
// double-fork way (an intermediate bash that exits instantly, orphaning
// the rig to init) — a plain `&` child of the tool shell gets reaped:
//   bash -c "nohup setsid node scripts/v1175-redteam-rig.mjs --keep >> /tmp/v1175-serve.log 2>&1 &"
'use strict';

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENGINE_BIN = '/tmp/doomalay-redteam-engine';
const DATA_DIR = '/tmp/doomalay-redteam-data';
const DATA_DIR_S5 = '/tmp/doomalay-redteam-data-s5';
const ENGINE_LOG = '/tmp/redteam-engine.log';
const STATE_FILE = '/tmp/v1175-rig.json';

const ENGINE_PORT = 8090;
const ENGINE_PORT_S5 = 8091;
const BRIDGE_PORT = 8181;
const OTA_PORT = 8182;
const TOKEN = 'rt' + crypto.randomBytes(10).toString('hex');
// The web-relative patch path (the engine's otaPatchable strips the
// repo prefix — patches land at <dataDir>/ota/<web-rel>)
const OTA_REL = 'atoms.js';
const OTA_CORRUPT_REL = 'lattice.js';

const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}/${TOKEN}`;
const OTA_MANIFEST_URL = `http://127.0.0.1:${OTA_PORT}/patch-manifest.json`;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra !== undefined ? '  → ' + String(extra).slice(0, 300) : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tiny fetch helpers (plain JSON, like the PWA's own calls) ──────────
async function jget(url, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, ok: r.ok, text, data };
  } finally { clearTimeout(t); }
}
async function jpost(url, body, timeoutMs = 30000, raw = false) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body || {}),
      signal: ac.signal
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, ok: r.ok, text, data };
  } finally { clearTimeout(t); }
}

// ── THE FAKE TERMUX BRIDGE (the Kotlin contract, byte-faithful) ────────
// Probe answers mirror TermuxBridge.probe()'s ProbeResult JSON: the
// stdout markers are the engine's ground truth (parseProbeMarkers
// re-derives storage_ok/props_ok from them — no marker, no truth).
const PROBE_MARKERS = '__doomalay_probe__\nstorage_ok\nprops_ok\n';
const bridge = {
  state: 'not_installed',
  probeHits: 0,
  actHits: [],
  runHits: 0
};

const BRIDGE_LADDER = {
  not_installed: {
    status: { installed: false, version_code: 0, version_name: null, permission: false },
    // Kotlin: runCommand checks isInstalled first → immediate send error,
    // no result, no markers (the engine keeps bridge_ok:true — the HTTP
    // round-trip DID deliver; storage/props honestly false).
    probe: { ok: false, timeout: false, send_error: 'termux not installed', stdout: '', stderr: '', exit_code: -1, err: -1 }
  },
  installed: {
    status: { installed: true, version_code: 1002, version_name: '0.118.3', permission: false },
    // Termux installed but allow-external-apps unset → the intent is
    // silently refused, no PendingIntent result → the Kotlin timeout.
    probe: { ok: false, timeout: true, send_error: null, stdout: '', stderr: '', exit_code: -1, err: 0 }
  },
  // v1.20.1 THE QUIET GATE: the setup script's checkin landed — the bridge
  // /status carries the checkin ladder (bootstrap_done, the URL, the
  // script's own two step outcomes, the timestamp); props/storage are ON
  // (the script set them); the permission grant is still the user's tap.
  bootstrapped: {
    status: { installed: true, version_code: 1002, version_name: '0.118.3', permission: false,
      checkin_url: `http://127.0.0.1:${BRIDGE_PORT}/rt-checkin-token-0123456789abcdef/checkin`,
      bootstrap_done: true, checkin_at: 1717000000, checkin_storage: true, checkin_props: true },
    probe: { ok: true, timeout: false, send_error: null, stdout: PROBE_MARKERS, stderr: '', exit_code: 0, err: 0 }
  },
  no_permission: {
    status: { installed: true, version_code: 1002, version_name: '0.118.3', permission: false },
    // Props set + bootstrap ran, but the RUN_COMMAND permission is not
    // granted → SecurityException at the send.
    probe: { ok: false, timeout: false, send_error: 'RUN_COMMAND permission not granted', stdout: '', stderr: '', exit_code: -1, err: -1 }
  },
  bridge_ok: {
    status: { installed: true, version_code: 1002, version_name: '0.118.3', permission: false },
    // The round-trip works + markers — but permission:false, so the
    // engine's ready conjunction must stay false (this rung proves the
    // engine never shortcuts ready from the probe alone).
    probe: { ok: true, timeout: false, send_error: null, stdout: PROBE_MARKERS, stderr: '', exit_code: 0, err: 0 }
  },
  ready: {
    status: { installed: true, version_code: 1002, version_name: '0.118.3', permission: true },
    probe: { ok: true, timeout: false, send_error: null, stdout: PROBE_MARKERS, stderr: '', exit_code: 0, err: 0 }
  }
};

const SLOW_DELAY_MS = 30000; // strictly beyond the engine's 20s probe deadline

function bridgeStateShape() {
  return BRIDGE_LADDER[bridge.state] || BRIDGE_LADDER.not_installed;
}

function startBridge() {
  const srv = http.createServer((req, res) => {
    // THE CONTROL PLANE (no token — the rig's own lever)
    if (req.url === '/__control' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          if (d.state) {
            bridge.state = String(d.state);
            bridge.probeHits = 0; bridge.actHits = []; bridge.runHits = 0;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, state: bridge.state }));
        } catch (e) {
          res.writeHead(400); res.end('{"error":"bad control body"}');
        }
      });
      return;
    }
    if (req.url === '/__state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bridge));
      return;
    }

    // dead → destroy every connection (the loopback server is gone)
    if (bridge.state === 'dead') {
      res.socket.destroy();
      return;
    }
    // slow → hold everything past the engine's own deadlines
    if (bridge.state === 'slow') {
      const u = req.url;
      setTimeout(() => { try { res.socket.destroy(); } catch (e) { /* already gone */ } }, SLOW_DELAY_MS);
      return;
    }

    // THE TOKEN LAW: the path must be /<token>/<route> — anything else 403s
    const prefix = '/' + TOKEN + '/';
    if (!req.url.startsWith(prefix)) {
      bridge.rejectHits = (bridge.rejectHits || 0) + 1;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"forbidden"}');
      return;
    }
    const route = req.url.slice(prefix.length).split('?')[0];

    const readBody = (cb) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => cb(b));
    };
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (route === 'status' && req.method === 'GET') {
      json(200, bridgeStateShape().status);
      return;
    }
    if (route === 'probe' && req.method === 'POST') {
      bridge.probeHits++;
      const p = bridgeStateShape().probe;
      const out = {
        ok: p.ok, storage_ok: p.ok, props_ok: p.ok,
        stdout: p.stdout, stderr: p.stderr, exit_code: p.exit_code,
        err: p.err, errmsg: p.send_error, timeout: p.timeout,
        send_error: p.send_error
      };
      json(200, out);
      return;
    }
    if (route === 'run' && req.method === 'POST') {
      bridge.runHits++;
      readBody((b) => {
        let cmd = '';
        try { cmd = (JSON.parse(b || '{}').command) || ''; } catch (e) { /* honest 400 below */ }
        if (!cmd) { json(400, { error: 'missing command' }); return; }
        json(200, { ok: true, stdout: 'rig-run-ack', stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false });
      });
      return;
    }
    if (route === 'act' && req.method === 'POST') {
      readBody((b) => {
        let what = '';
        try { what = JSON.parse(b || '{}').what || ''; } catch (e) { /* honest 400 below */ }
        if (what === 'open_termux' || what === 'open_fdroid' || what === 'open_permission_settings') {
          bridge.actHits.push(what);
          json(200, { ok: true });
          return;
        }
        json(400, { error: 'unknown what' });
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => srv.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(srv)));
}

// ── THE FAKE OTA SERVER (ota.FileURL's directory contract) ──────────────
// A manifest at http://host:port/patch-manifest.json is neither github.com
// nor raw.githubusercontent.com → every file URL resolves to the
// manifest's own directory + the repo-root-relative path, i.e.
// http://host:port/engine/internal/server/web/<file>. This stub serves
// exactly those paths.
const OTA_TARGET = 'engine/internal/server/web/atoms.js';   // the patched file
const OTA_CORRUPT_TARGET = 'engine/internal/server/web/lattice.js';
const ota = { state: 'match', payload: null, hits: 0 };

async function otaBuildUpdate() {
  // ONE real web file with different content + the CORRECT sha256: the
  // live bytes of /atoms.js (embedded or already-overlaid) + a unique
  // comment marker — valid JS (the PWA will load it after the patch),
  // different bytes every run.
  const r = await jget(`${ENGINE_URL}/atoms.js`);
  if (r.status !== 200) throw new Error('cannot read live atoms.js: HTTP ' + r.status);
  const marker = `/* doomalay-redteam-ota-patch ${Date.now()} ${crypto.randomBytes(4).toString('hex')} */`;
  const content = r.text.replace(/\s*$/, '') + '\n' + marker + '\n';
  return {
    marker,
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content)
  };
}

function otaManifest() {
  const base = { version: 'v1.17.5-redteam', ref: 'main', min_engine: '' };
  if (ota.state === 'valid_update' && ota.payload) {
    return { ...base, min_engine: '1.16.0', files: [{ path: OTA_TARGET, sha256: ota.payload.sha256, size: ota.payload.size }] };
  }
  if (ota.state === 'corrupt') {
    // a sha that will NOT match what we serve — the corrupt download
    return { ...base, min_engine: '1.16.0', files: [{ path: OTA_CORRUPT_TARGET, sha256: crypto.createHash('sha256').update('not-the-real-bytes').digest('hex'), size: 123 }] };
  }
  if (ota.state === 'engine_required') {
    return { ...base, min_engine: '99.0.0', files: [{ path: OTA_CORRUPT_TARGET, sha256: crypto.createHash('sha256').update('not-the-real-bytes').digest('hex'), size: 123 }] };
  }
  return { ...base, files: [] };   // match → current
}

function startOta() {
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/__control' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          if (d.state) { ota.state = String(d.state); ota.payload = null; ota.hits = 0; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, state: ota.state }));
        } catch (e) {
          res.writeHead(400); res.end('{"error":"bad control body"}');
        }
      });
      return;
    }
    if (req.url === '/__state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // v1.17.5 rig fix: the marker rides __state — a REUSED infra (the
      // --keep daemon) holds the payload in ITS process; the rig main must
      // never read its local (stale) ota object for it.
      res.end(JSON.stringify({ state: ota.state, hits: ota.hits,
        marker: (ota.payload && ota.payload.marker) || null }));
      return;
    }
    if (ota.state === 'unreachable') {
      res.socket.destroy();
      return;
    }
    if (req.method === 'GET' && req.url === '/patch-manifest.json') {
      ota.hits++;
      // lazily build the fresh update payload the FIRST time a
      // valid_update manifest is served (the payload derives from the
      // engine's live bytes — the engine is up by the time anyone asks)
      if (ota.state === 'valid_update' && !ota.payload) {
        try { ota.payload = await otaBuildUpdate(); } catch (e) { /* fall through to the match manifest */ }
      }
      const m = otaManifest();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(m));
      return;
    }
    if (req.method === 'GET' && ota.state === 'valid_update' && ota.payload &&
        req.url === '/' + OTA_TARGET) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(ota.payload.content);
      return;
    }
    if (req.method === 'GET' && ota.state === 'corrupt' && req.url === '/' + OTA_CORRUPT_TARGET) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('corrupt payload that does not hash to the manifest sha\n');
      return;
    }
    if (req.method === 'GET' && ota.state === 'engine_required' && req.url === '/' + OTA_CORRUPT_TARGET) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('engine-required payload\n');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => srv.listen(OTA_PORT, '127.0.0.1', () => resolve(srv)));
}

// lazily build the fresh update payload the first time it's needed (the
// engine must be up — the payload derives from its live bytes)
async function ensureOtaPayload() {
  // v1.17.5 rig fix: fetch the marker from the LIVE fake server (works
  // identically fresh or reused — the daemon owns the payload).
  const st = await jget(`http://127.0.0.1:${OTA_PORT}/__state`);
  if (st.status === 200 && st.data && st.data.marker) return { marker: st.data.marker };
  // fallback: this process IS the server and nothing built yet → build now
  if (otaSrv && ota.state === 'valid_update' && !ota.payload) {
    try { ota.payload = await otaBuildUpdate(); } catch (e) { return null; }
    return ota.payload;
  }
  return null;
}

// ── THE ENGINE (daemonized — this sandbox reaps normal spawns) ─────────
function pkillEngine(port) {
  try { execFileSync('pkill', ['-f', `doomalay-redteam-engine --port ${port}`], { stdio: 'ignore' }); } catch (e) { /* none */ }
}
function spawnEngine(port, dataDir, termuxBridge, otaEnv) {
  const env = { ...process.env, DOOMALAY_TERMUX_BRIDGE: termuxBridge, ...otaEnv };
  const cmd = `nohup setsid ${ENGINE_BIN} --port ${port} --bind 127.0.0.1 --data-dir ${dataDir} >> ${ENGINE_LOG} 2>&1 &`;
  const child = spawn('bash', ['-c', cmd], { env, detached: true, stdio: 'ignore' });
  child.unref();
}
async function waitHealth(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await jget(`http://127.0.0.1:${port}/api/health`, 3000);
      if (r.status === 200 && r.data && r.data.ok !== false) return true;
    } catch (e) { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

// ── infra lifecycle ────────────────────────────────────────────────────
let bridgeSrv = null, otaSrv = null;
let infraUp = false;

async function infraAlive() {
  const st = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
  if (!st || !st.pid || !fs.existsSync('/proc/' + st.pid)) return false;
  try {
    const r = await jget(`${ENGINE_URL}/api/health`, 2500);
    if (r.status !== 200) return false;
    const b = await jget(`http://127.0.0.1:${BRIDGE_PORT}/__state`, 2500);
    const o = await jget(`http://127.0.0.1:${OTA_PORT}/__state`, 2500);
    return b.status === 200 && o.status === 200;
  } catch (e) { return false; }
}

async function bringUp() {
  if (await infraAlive()) { console.log('(reusing the live rig infra at ' + ENGINE_URL + ')'); infraUp = true; return; }
  // stale leftovers from a dead serve process → clean kill + fresh boot
  pkillEngine(ENGINE_PORT);
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (!fs.existsSync(ENGINE_BIN)) {
    console.error('FATAL: ' + ENGINE_BIN + ' missing — build it first:');
    console.error('  cd engine && go build -o /tmp/doomalay-redteam-engine ./cmd/doomalay');
    process.exit(2);
  }
  bridgeSrv = await startBridge();
  otaSrv = await startOta();
  spawnEngine(ENGINE_PORT, DATA_DIR, BRIDGE_BASE, { DOOMALAY_OTA_URL: OTA_MANIFEST_URL });
  const healthy = await waitHealth(ENGINE_PORT);
  if (!healthy) {
    console.error('FATAL: engine never became healthy — see ' + ENGINE_LOG);
    process.exit(2);
  }
  infraUp = true;
}

async function tearDown() {
  pkillEngine(ENGINE_PORT);
  pkillEngine(ENGINE_PORT_S5);
  if (bridgeSrv) bridgeSrv.close();
  if (otaSrv) otaSrv.close();
  for (const s of Object.values(process._getActiveHandles ? process._getActiveHandles() : {})) {
    try { if (s.unref) s.unref(); } catch (e) { /* noop */ }
  }
  infraUp = false;
}

// ── S1 — THE PIVOT CONTRACT ────────────────────────────────────────────
async function s1() {
  console.log('S1 — the pivot contract (quick by birth, the library, no picker):');
  const r = await jget(ENGINE_URL + '/');
  ok(r.status === 200, 'GET / serves the PWA (200)', r.status);
  ok(/<html/i.test(r.text) || /<!doctype html/i.test(r.text), 'GET / serves an HTML document');
  ok(r.text.indexOf('src="capabilities.js"') >= 0, 'index.html loads capabilities.js');
  ok(r.text.indexOf('src="termuxsetup.js"') >= 0, 'index.html loads termuxsetup.js');
  ok(r.text.indexOf('src="ota.js"') >= 0, 'index.html loads ota.js');
  ok(r.text.indexOf('sandboxpicker') < 0, 'index.html has ZERO sandboxpicker references');

  // quick by birth: sandbox omitted → 'quick' (the engine-side default
  // the v1.17.1 pivot law demands — the PWA always sends it, the engine
  // must not regress when a client omits it)
  const c = await jpost(ENGINE_URL + '/api/sessions', { title: 'v1175 redteam pivot' });
  ok(c.status === 201, 'POST /api/sessions (no sandbox) → 201', c.status + ' ' + c.text);
  ok(c.data && c.data.Sandbox === 'quick', 'a fresh session defaults to quick (' + (c.data && c.data.Sandbox) + ')', c.data && c.data.Sandbox);
  const sid = c.data && c.data.ID;
  const g = await jget(ENGINE_URL + '/api/sessions/' + sid);
  ok(g.status === 200 && g.data && g.data.Sandbox === 'quick', 'GET the session back → sandbox quick', g.data && g.data.Sandbox);

  // the capability stack round-trips through the session (the fields the
  // library's toggles PATCH)
  const c2 = await jpost(ENGINE_URL + '/api/sessions', {
    title: 'v1175 redterm stack', sandbox: 'quick',
    deep_research: true, termux: true, web_search: true, lib_auto: true
  });
  ok(c2.status === 201 && c2.data && c2.data.DeepResearch === true && c2.data.Termux === true &&
     c2.data.WebSearch === true && c2.data.LibAuto === true, 'the stacked capabilities round-trip at create', c2.text);
  const p = await fetch(ENGINE_URL + '/api/sessions/' + c2.data.ID, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termux: false, deep_research: false })
  });
  const pj = await p.json().catch(() => null);
  ok(p.status === 200 && pj && pj.Termux === false && pj.DeepResearch === false,
    'PATCH unstacks the capabilities (persistCaps machinery)', p.status + ' ' + JSON.stringify(pj));
}

// ── S2 — THE TERMUX STATUS LADDER ──────────────────────────────────────
async function termuxStatus(query = '') {
  return jget(ENGINE_URL + '/api/termux/status' + query);
}
async function flipBridge(state) {
  const r = await jpost(`http://127.0.0.1:${BRIDGE_PORT}/__control`, { state });
  if (!r.ok) throw new Error('bridge control flip failed: ' + r.text);
  return r;
}
async function bridgeProbeHits() {
  const r = await jget(`http://127.0.0.1:${BRIDGE_PORT}/__state`);
  return (r.data && r.data.probeHits) || 0;
}

async function s2() {
  console.log('S2 — the termux status ladder (honest states, never a 500):');

  const rungs = [
    ['not_installed', { installed: false, permission: false, bridge_ok: true, storage_ok: false, props_ok: false, ready: false }],
    ['installed',     { installed: true, permission: false, bridge_ok: true, storage_ok: false, props_ok: false, ready: false }],
    ['bootstrapped',  { installed: true, permission: false, bridge_ok: true, storage_ok: true, props_ok: true, ready: false }],
    ['no_permission', { installed: true, permission: false, bridge_ok: true, storage_ok: false, props_ok: false, ready: false }],
    ['bridge_ok',     { installed: true, permission: false, bridge_ok: true, storage_ok: true, props_ok: true, ready: false }],
    ['ready',         { installed: true, permission: true, bridge_ok: true, storage_ok: true, props_ok: true, ready: true }]
  ];
  for (const [state, want] of rungs) {
    await flipBridge(state);
    const r = await termuxStatus('?refresh=1');
    const label = state + ': ';
    ok(r.status === 200, label + 'HTTP 200', r.status);
    const d = r.data || {};
    ok(d.available === true, label + 'available:true (the bridge is configured)', JSON.stringify(d));
    ok(d.installed === want.installed, label + 'installed=' + want.installed, d.installed);
    ok(d.permission === want.permission, label + 'permission=' + want.permission, d.permission);
    ok(d.bridge_ok === want.bridge_ok, label + 'bridge_ok=' + want.bridge_ok, d.bridge_ok);
    ok(d.storage_ok === want.storage_ok, label + 'storage_ok=' + want.storage_ok, d.storage_ok);
    ok(d.props_ok === want.props_ok, label + 'props_ok=' + want.props_ok, d.props_ok);
    ok(d.ready === want.ready, label + 'ready=' + want.ready + (state === 'ready' ? ' (ONLY here)' : ''), d.ready);
    ok(typeof d.checked_at === 'number' && d.checked_at > 0, label + 'checked_at present');
    // v1.20.1: the new status fields are always present + typed (forced
    // probes are never suppressed)
    ok(typeof d.checkin_url === 'string', label + 'checkin_url present (string)');
    ok(typeof d.bootstrap_done === 'boolean', label + 'bootstrap_done present (bool)');
    ok(typeof d.checkin_storage === 'boolean' && typeof d.checkin_props === 'boolean',
      label + 'checkin_storage/checkin_props present (bools)');
    ok(d.probe_suppressed === false, label + 'probe_suppressed:false (a forced probe is never suppressed)', d.probe_suppressed);
    if (state === 'bootstrapped') {
      ok(d.checkin_url === `http://127.0.0.1:${BRIDGE_PORT}/rt-checkin-token-0123456789abcdef/checkin` &&
         d.bootstrap_done === true && d.checkin_at === 1717000000 &&
         d.checkin_storage === true && d.checkin_props === true,
        'bootstrapped: the whole checkin ladder passes through', JSON.stringify(d));
    } else {
      ok(d.checkin_url === '' && d.bootstrap_done === false && d.checkin_storage === false && d.checkin_props === false,
        label + 'no checkin yet → the honest empty/false state (old-flow)');
    }
    if (state === 'installed') {
      ok(d.version_code === 1002 && d.version_name === '0.118.3', 'installed: version_code/version_name round-trip', d.version_code + '/' + d.version_name);
    }
    if (state === 'not_installed') {
      ok(d.android === false, 'the honest android:false on a desktop engine', d.android);
      ok(d.last_error === '' || d.last_error == null, 'not_installed: no last_error (the ladder is honest, not erroring)', d.last_error);
    }
  }

  // the /status half is FRESH (uncached) — a plain poll reflects a flip
  await flipBridge('not_installed');
  await termuxStatus('?refresh=1');
  await flipBridge('installed');
  const plain = await termuxStatus();
  ok(plain.status === 200 && plain.data.installed === true,
    'plain poll (no refresh) reflects the fresh /status half immediately', plain.text);

  // the probe half is CACHED (TTL): two plain polls → no new probe hits;
  // ?refresh=1 → exactly one more
  const h0 = await bridgeProbeHits();
  await termuxStatus();
  await termuxStatus();
  const h1 = await bridgeProbeHits();
  ok(h1 === h0, 'the cached probe: two plain polls → ZERO extra RUN_COMMANDs', h0 + ' → ' + h1);
  await termuxStatus('?refresh=1');
  const h2 = await bridgeProbeHits();
  ok(h2 === h1 + 1, '?refresh=1 forces exactly one re-probe', h1 + ' → ' + h2);

  // DEAD: the loopback server is gone → a STATUS, never a 500
  await flipBridge('dead');
  const d1 = await termuxStatus('?refresh=1');
  ok(d1.status === 200, 'dead bridge: HTTP 200 (never a 500)', d1.status);
  ok(d1.data && d1.data.bridge_ok === false, 'dead bridge: bridge_ok:false', d1.data && d1.data.bridge_ok);
  ok(d1.data && d1.data.ready === false, 'dead bridge: ready:false', d1.data && d1.data.ready);
  ok(d1.data && typeof d1.data.last_error === 'string' && d1.data.last_error.length > 0,
    'dead bridge: last_error carries the typed reason', d1.data && d1.data.last_error);
  let all200 = true;
  for (let i = 0; i < 3; i++) {
    const p = await termuxStatus();
    if (p.status !== 200) all200 = false;
  }
  ok(all200, 'dead bridge: repeated polls stay HTTP 200 (no 500 loop, no hang)');
  const cachedDead = await termuxStatus();
  ok(cachedDead.data && cachedDead.data.bridge_ok === false,
    'the dead answer is CACHED (the starve guard — every poll is not a fresh timeout)', cachedDead.text);

  // recovery: dead → live again
  await flipBridge('not_installed');
  const rec = await termuxStatus('?refresh=1');
  ok(rec.status === 200 && rec.data && rec.data.bridge_ok === true && rec.data.available === true,
    'recovery: a refresh after the bridge returns shows the live state again', rec.text);

  // SLOW: the engine's own probe deadline (20s) must cut it off — bounded
  // + honest
  await flipBridge('slow');
  const t0 = Date.now();
  const slow = await termuxStatus('?refresh=1', 60000);
  const elapsed = Date.now() - t0;
  ok(slow.status === 200, 'slow bridge: HTTP 200 (the engine does not hang)', slow.status);
  ok(elapsed < 30000, 'slow bridge: the engine returns within its own bounded deadline (' + elapsed + 'ms)', elapsed + 'ms');
  ok(slow.data && slow.data.bridge_ok === false, 'slow bridge: bridge_ok:false (honest)', slow.data && slow.data.bridge_ok);
  ok(slow.data && typeof slow.data.last_error === 'string' && /timed out|timeout/i.test(slow.data.last_error),
    'slow bridge: last_error says timeout', slow.data && slow.data.last_error);
  await flipBridge('ready');
  await termuxStatus('?refresh=1');

  // v1.20.1 THE QUIET GATE — the suppression semantics, live: props
  // honestly off + no checkin + cache filled → the TTL expiry serves the
  // STALE cache (ZERO new RUN_COMMANDs — each probe while
  // allow-external-apps is unset forces a Termux notification, the exact
  // spam the user reported). One real TTL wait (30s) — the only honest
  // way to watch a TTL expire from the outside. (Every flip resets the
  // stub's probe counter, so each phase counts its own probes.)
  await flipBridge('installed');
  await termuxStatus('?refresh=1');                 // fill the cache: props off
  const g0 = await bridgeProbeHits();
  await sleep(31000);                                // let the 30s TTL expire
  const g1 = await termuxStatus();                   // plain poll — must NOT probe
  ok(g1.status === 200, 'quiet gate: the suppressed poll stays HTTP 200', g1.status);
  ok(g1.data && g1.data.probe_suppressed === true, 'quiet gate: probe_suppressed:true (a VISIBLE state, never silence)', g1.text);
  ok(/probe paused/i.test((g1.data && g1.data.last_error) || ''),
    'quiet gate: last_error says the probe is paused (honest)', g1.data && g1.data.last_error);
  ok((await bridgeProbeHits()) === g0,
    'quiet gate: TTL expiry with props off + no checkin → ZERO new RUN_COMMANDs (the spam is dead)');
  const g2 = await termuxStatus();                   // TTL still expired, still quiet
  ok(g2.data && g2.data.probe_suppressed === true && (await bridgeProbeHits()) === g0,
    'quiet gate: repeated plain polls stay quiet (no loop, no drift)');

  // the checkin opens the gate: bootstrap_done → the auto-probe resumes
  // (the TTL is still expired — suppression never refreshes it)
  await flipBridge('bootstrapped');
  const g3 = await termuxStatus();
  ok((await bridgeProbeHits()) === 1,
    'the checkin (bootstrap_done) reopens the auto-probe — exactly one probe');
  ok(g3.data && g3.data.probe_suppressed === false && g3.data.bootstrap_done === true,
    'the reopened gate clears the flag + passes the checkin through', g3.text);

  // ?refresh=1 still forces while the gate holds — an explicit user
  // action (the "check now" escape hatch): one probe, never a loop
  await flipBridge('installed');
  await termuxStatus('?refresh=1');
  ok((await bridgeProbeHits()) === 1, '?refresh=1 forces one probe even while suppressed (explicit user action)');
}

// ── S3 — THE ACT PASSTHROUGH ───────────────────────────────────────────
async function s3() {
  console.log('S3 — the act passthrough (the setup overlay\'s action surface):');
  await flipBridge('ready');
  for (const what of ['open_termux', 'open_fdroid', 'open_permission_settings']) {
    const r = await jpost(ENGINE_URL + '/api/termux/act', { what });
    ok(r.status === 200 && r.data && r.data.ok === true, 'act ' + what + ' → {ok:true}', r.status + ' ' + r.text);
  }
  const st = await jget(`http://127.0.0.1:${BRIDGE_PORT}/__state`);
  const wants = ['open_termux', 'open_fdroid', 'open_permission_settings'];
  ok((st.data.actHits || []).slice(0, 3).join(',') === wants.join(','),
    'the fake bridge SAW the three intents in order', JSON.stringify(st.data.actHits));
  const bad = await jpost(ENGINE_URL + '/api/termux/act', { what: 'rm -rf' });
  ok(bad.status === 400, 'act with an unknown what → honest 400', bad.status);
  const badJson = await jpost(ENGINE_URL + '/api/termux/act', '{nope', 15000, true);
  ok(badJson.status === 400, 'act with malformed JSON → honest 400', badJson.status);
  const empty = await jpost(ENGINE_URL + '/api/termux/act', {});
  ok(empty.status === 400, 'act with an empty body → honest 400', empty.status);

  await flipBridge('dead');
  const deadAct = await jpost(ENGINE_URL + '/api/termux/act', { what: 'open_termux' });
  ok(deadAct.status === 502 && deadAct.data && deadAct.data.ok === false,
    'act through a dead bridge → honest 502 {ok:false,error}', deadAct.status + ' ' + deadAct.text);
  await flipBridge('ready');
}

// ── S4 — THE OTA LADDER ────────────────────────────────────────────────
async function otaFlip(state) {
  const r = await jpost(`http://127.0.0.1:${OTA_PORT}/__control`, { state });
  if (!r.ok) throw new Error('ota control flip failed: ' + r.text);
  return r;
}
function otaOverlayPath(rel) {
  return path.join(DATA_DIR, 'ota', rel);
}

async function s4() {
  console.log('S4 — the OTA ladder (download only what changed, honest failures):');

  // valid update → update_available
  await otaFlip('valid_update');
  const c1 = await jpost(ENGINE_URL + '/api/ota/check');
  ok(c1.status === 200 && c1.data && c1.data.state === 'update_available',
    'valid update: POST /api/ota/check → state update_available', c1.text);
  ok(c1.data && c1.data.manifest && c1.data.manifest.changed === 1 && c1.data.manifest.changed_bytes > 0,
    'valid update: changed=1, changed_bytes>0', JSON.stringify(c1.data && c1.data.manifest));
  const payload = await ensureOtaPayload();

  // download → ok:true
  const dl = await jpost(ENGINE_URL + '/api/ota/download');
  ok(dl.status === 200 && dl.data && dl.data.ok === true && dl.data.downloaded === 1 && dl.data.bytes > 0 && dl.data.state === 'current',
    'download → {ok:true, downloaded:1, bytes>0, state:current}', dl.text);

  // THE OVERLAY LAW: the patched web file serves the NEW bytes
  const patched = await jget(ENGINE_URL + '/atoms.js');
  ok(patched.status === 200 && patched.text.indexOf(payload.marker) >= 0,
    'GET /atoms.js serves the PATCHED bytes (the overlay law)', patched.text.slice(-120));
  const cur = await jget(ENGINE_URL + '/api/ota/status');
  ok(cur.status === 200 && cur.data && cur.data.state === 'current',
    'status after apply → current (the live hash is the same stack)', cur.text);
  ok(fs.existsSync(otaOverlayPath(OTA_REL)),
    'the patch landed at <dataDir>/ota/' + OTA_REL + ' (the web-relative overlay path)');

  // corrupt: wrong sha → honest 502, nothing lands, embedded still served
  await otaFlip('corrupt');
  const c2 = await jpost(ENGINE_URL + '/api/ota/check');
  ok(c2.status === 200 && c2.data && c2.data.state === 'update_available',
    'corrupt: check → update_available (the plan is honest)', c2.text);
  const dl2 = await jpost(ENGINE_URL + '/api/ota/download');
  ok(dl2.status === 502 && dl2.data && dl2.data.ok === false && /sha256|mismatch|corrupt/i.test(dl2.data.error || ''),
    'corrupt: download → honest 502 with the sha256 reason', dl2.status + ' ' + dl2.text);
  ok(!fs.existsSync(otaOverlayPath(OTA_CORRUPT_REL)),
    'corrupt: NOTHING landed (the .tmp is gone — corrupt = deleted)');
  const lat = await jget(ENGINE_URL + '/lattice.js');
  ok(lat.status === 200 && lat.text.indexOf('corrupt payload') < 0,
    'corrupt: GET /lattice.js still serves the EMBEDDED bytes', lat.text.slice(0, 60));
  const stillPatched = await jget(ENGINE_URL + '/atoms.js');
  ok(stillPatched.text.indexOf(payload.marker) >= 0,
    'corrupt: the earlier good patch is still served (failures are per-file)');

  // engine_required: min_engine far future → the honest full-APK wall
  await otaFlip('engine_required');
  const c3 = await jpost(ENGINE_URL + '/api/ota/check');
  ok(c3.status === 200 && c3.data && c3.data.state === 'engine_update_required',
    'engine_required: check → state engine_update_required', c3.text);
  const dl3 = await jpost(ENGINE_URL + '/api/ota/download');
  ok(dl3.status === 409 && dl3.data && dl3.data.ok === false && dl3.data.state === 'engine_update_required',
    'engine_required: download refused (409 — the engine binary is never hot-patched)', dl3.status + ' ' + dl3.text);
  ok(!fs.existsSync(otaOverlayPath(OTA_CORRUPT_REL)),
    'engine_required: nothing landed');

  // unreachable: the mirror is gone → a STATE, HTTP 200
  await otaFlip('unreachable');
  const c4 = await jpost(ENGINE_URL + '/api/ota/check');
  ok(c4.status === 200 && c4.data && c4.data.state === 'unreachable',
    'unreachable: check → HTTP 200 state unreachable (never a 5xx)', c4.status + ' ' + c4.text);
  ok(c4.data && typeof c4.data.last_error === 'string' && c4.data.last_error.length > 0,
    'unreachable: last_error says why', c4.data && c4.data.last_error);
}

// ── S5 — THE WRONG-TOKEN BRIDGE ────────────────────────────────────────
async function s5() {
  console.log('S5 — the wrong-token bridge (403 honesty, never a 500 loop):');
  pkillEngine(ENGINE_PORT_S5);
  if (fs.existsSync(DATA_DIR_S5)) fs.rmSync(DATA_DIR_S5, { recursive: true, force: true });
  await flipBridge('ready');
  spawnEngine(ENGINE_PORT_S5, DATA_DIR_S5, `http://127.0.0.1:${BRIDGE_PORT}/WRONGTOKEN-${TOKEN}`,
    { DOOMALAY_OTA_DISABLE: '1' });
  const healthy = await waitHealth(ENGINE_PORT_S5);
  ok(healthy, 'the S5 engine (wrong token) boots healthy');
  if (!healthy) { pkillEngine(ENGINE_PORT_S5); return; }

  const base = `http://127.0.0.1:${ENGINE_PORT_S5}`;
  const r = await jget(base + '/api/termux/status');
  ok(r.status === 200, 'wrong token: status HTTP 200 (never a 500)', r.status);
  ok(r.data && r.data.available === true, 'wrong token: available:true (configured, but failing)', r.text);
  ok(r.data && r.data.bridge_ok === false, 'wrong token: bridge_ok:false', r.data && r.data.bridge_ok);
  ok(r.data && r.data.ready === false, 'wrong token: ready:false', r.data && r.data.ready);
  ok(r.data && typeof r.data.last_error === 'string' && /token|403/i.test(r.data.last_error),
    'wrong token: last_error names the 403/token', r.data && r.data.last_error);
  let all200 = true, lastErr = true;
  for (let i = 0; i < 4; i++) {
    const p = await jget(base + '/api/termux/status' + (i % 2 ? '?refresh=1' : ''));
    if (p.status !== 200) all200 = false;
    if (!p.data || !p.data.last_error) lastErr = false;
  }
  ok(all200 && lastErr, 'wrong token: repeated refresh polls stay 200 + honest (no 500 loop)');

  const st = await jget(`http://127.0.0.1:${BRIDGE_PORT}/__state`);
  ok((st.data.rejectHits || 0) >= 3, 'the S5 engine\'s probes actually hit the bridge (403 token rejections counted)', st.data.rejectHits);

  const act = await jpost(base + '/api/termux/act', { what: 'open_termux' });
  ok(act.status === 502 && act.data && act.data.ok === false, 'wrong token: act → honest 502', act.status);

  pkillEngine(ENGINE_PORT_S5);
  await sleep(400);
  let down = false;
  try { await jget(base + '/api/health', 2000); } catch (e) { down = true; }
  ok(down, 'the S5 engine is torn down');
}

// ── main ───────────────────────────────────────────────────────────────
const mode = process.argv[2] || '';

async function main() {
  if (mode === '--down') {
    const st = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
    pkillEngine(ENGINE_PORT);
    pkillEngine(ENGINE_PORT_S5);
    if (st && st.pid) { try { process.kill(st.pid, 'SIGTERM'); } catch (e) { /* already gone */ } }
    if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
    console.log('rig infra down.');
    process.exit(0);
  }

  await bringUp();

  await s1();
  await s2();
  await s3();
  await s4();
  await s5();

  // zero-panic sweep of the engine log
  try {
    const log = fs.readFileSync(ENGINE_LOG, 'utf8');
    ok(!/panic:|goroutine .* \[signal/.test(log), 'the engine log shows no panic across the whole run');
  } catch (e) { /* log may not exist if reused */ }

  // clean slate for the E2E (the fake bridge starts uninstalled, OTA match)
  await flipBridge('not_installed');
  await otaFlip('match');

  console.log(pass + ' passed, ' + fail + ' failed');

  if (mode === '--keep') {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      pid: process.pid,
      engine: ENGINE_URL, enginePort: ENGINE_PORT,
      bridgeControl: `http://127.0.0.1:${BRIDGE_PORT}/__control`,
      bridgeState: `http://127.0.0.1:${BRIDGE_PORT}/__state`,
      otaControl: `http://127.0.0.1:${OTA_PORT}/__control`,
      otaState: `http://127.0.0.1:${OTA_PORT}/__state`,
      token: TOKEN, dataDir: DATA_DIR, engineLog: ENGINE_LOG
    }, null, 2));
    console.log('(rig infra stays live for the E2E — state at ' + STATE_FILE + '; kill with --down)');
    // park forever (the stubs must survive for the browser walk)
    setInterval(() => {}, 60000);
  } else {
    await tearDown();
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('RIG ERROR:', e && e.stack || e);
  process.exit(2);
});
