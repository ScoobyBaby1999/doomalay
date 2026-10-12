#!/usr/bin/env node
// v1300-e2e-walk.mjs — v1.30.0 THE CONTINUOUS MIND's REAL-USER walk
// (PLAN-V130 §7): the panel-lifecycle law (the stash + the unbroken
// turn), the honest query (no [object Object]), and git_setup's stdin
// lane — driven through agent-browser exactly as a human would.
//
//   S1  the world boots (engine + executing bridge + the scripted LLM stub)
//   S2  the chat opens; the message sends; the ONE pill + a DOM MARKER
//   S3  MID-TURN the panel CLOSES (the drag-down): the stash captures the
//       live #chat-root (the same nodes, the listeners, the streaming pill)
//   S4  while closed the turn KEEPS RUNNING (the stub's slow stream; the
//       events land data-only) — NO interrupt, no error bubble
//   S5  REOPEN: the stash RESTORES the SAME DOM (the marker element is
//       re-connected, no innerHTML rebuild), the delta appends, the turn
//       finishes INTO the restored tree
//   S6  the pill's ↗ overlay: the QUERY box shows the REAL command (never
//       [object Object]) — THE HONEST QUERY
//   S7  git_setup: the vault token arms Termux through the bridge's STDIN
//       lane (the credentials file lands in the fake HOME, 0600)
//   S8  RELOAD: the replayed pill + the honest query (the persisted pair)
//   S9  mobile 390px + zero page errors
'use strict';
import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1300-e2e-engine';
const DATA_DIR = '/tmp/v1300-e2e-data';
const ENGINE_LOG = '/tmp/v1300-e2e-engine.log';
const SHOTS = '/tmp/v1300-shots';
const ENGINE_PORT = 8691;
const STUB_PORT = 8692;
const BRIDGE_PORT = 8693;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');
const FAKE_HOME = '/tmp/v1300-e2e-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1300-continuous-walk';
const MODEL = 'groq/stub-model';
const GH_PAT = 'ghp_' + 'e2e'.padEnd(3, 'e') + 'testtoken' + String(123456789012345); // built at runtime — no literal secret shape in source

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okCount = 0, failCount = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { okCount++; console.log('  ok - ' + name); }
  else { failCount++; fails.push(name); console.log('  FAIL - ' + name + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
}
async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message);
  }
}
function abEval(js) { return ab('eval ' + JSON.stringify(js), 25000); }
async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    if (String(v).trim() === 'true' || String(v).trim() === '"true"') return true;
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(350);
  }
}
function jparse(s) { try { return JSON.parse(JSON.parse(s)); } catch (e) {} try { return JSON.parse(s); } catch (e) {} return {}; }

// ── the executing fake bridge (stdin-carrying: git_setup rides it) ───
const bridgeBodies = [];
function startBridge() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, { ok: false }); return; }
    if (req.method === 'GET' && req.url.endsWith('/status')) { send(200, { installed: true, version_code: 1022, version_name: '0.119.0-beta.3', permission: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/probe')) { send(200, { ok: true, storage_ok: true, props_ok: true, stdout: '__doomalay_probe__\nstorage_ok\nprops_ok\n', stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false }); return; }
    if (req.method === 'POST' && req.url.endsWith('/act')) { send(200, { ok: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/run')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        bridgeBodies.push(b);
        const cmd = intoFake(String(b.command || ''));
        const workdir = b.workdir ? intoFake(String(b.workdir)) : '';
        const stdin = intoFake(String(b.stdin || ''));
        const p = spawn('bash', ['-c', cmd], {
          env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin', PREFIX: '/usr' },
          cwd: fs.existsSync(workdir) ? workdir : undefined,
        });
        if (stdin) { try { p.stdin.write(stdin); } catch (e) {} }
        try { p.stdin.end(); } catch (e) {}
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        p.on('close', (code) => {
          send(200, { ok: true, stdout: intoTermux(out).slice(0, 102400), stderr: intoTermux(errOut).slice(0, 20480), stdout_original_length: out.length, stderr_original_length: errOut.length, exit_code: code === null ? -1 : code, err: 0, errmsg: null, timeout: false });
        });
      });
      return;
    }
    send(404, { ok: false });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── the scripted LLM stub ─────────────────────────────────────────────
// Round 1 (the first send): a SLOW termux exec (the panel closes
// mid-flight) → after the result, a LONG streamed answer.
// Round 2 (the second send): the git_setup tool call → the final answer.
function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  const srv = http.createServer(async (req, res) => {
    const url = req.url.replace(/\?.*$/, '');
    if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      let parsed = {}; try { parsed = JSON.parse(body); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      // v1300: the FOLD means role:tool messages ride every later request —
      // route on the LAST user message + whether the git result already rode
      const lastUser = [...(parsed.messages || [])].reverse().find((m) => m.role === 'user');
      const wantsGit = String((lastUser && lastUser.content) || '').includes('arm the github');
      const hasGitResult = (parsed.messages || []).some((m) => m.role === 'tool' && String(m.content || '').includes('GIT ARMED'));
      const hasResult = (parsed.messages || []).some((m) => m.role === 'tool' && !String(m.content || '').includes('GIT ARMED'));
      if (wantsGit && !hasGitResult) {
        sse(res, { choices: [{ delta: { content: 'Arming the vault token now.' } }] });
        await sleep(80);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v1300g', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'git_setup' }) } }] } }] });
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else if (!hasResult && !wantsGit) {
        // ROUND 1: the slow exec (the device's double-encoded args shape)
        sse(res, { choices: [{ delta: { content: 'Running it on the device shell.' } }] });
        await sleep(100);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v1300a', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(60);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: JSON.stringify({ command: "echo 'the continuous mind' && sleep 4 && echo 'stream tail'", timeout_ms: 30000 }) }) } }] } }] });
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // the answer after the observation — SLOW words (the mid-turn close)
        const words = ['Done', '—', 'the', 'shell', 'says:', 'the', 'continuous', 'mind.', 'Every', 'word', 'streamed', 'into', 'the', 'restored', 'tree.'];
        for (const w of words) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(260); }
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

function bootEngine() {
  const env = { ...process.env, DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN, DOOMALAY_BASE_URL_GROQ: STUB, DOOMALAY_OTA_DISABLE: '1' };
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('S1 — BOOT (engine + bridge + stub + seeds):');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/cont-proj', { recursive: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
execFileSync('/home/z/sdk/go/bin/go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startBridge();
startStub();
bootEngine();
await waitEngine();
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-1234' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'the continuous mind walk', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/workspaces/device', { name: 'cont-proj', termux_path: TERMUX_SHARED + '/Doomalay/cont-proj', session_id: SID });
ok('S1: the world boots (engine healthy, session armed, termux bound)', true);

console.log('S2 — THE CHAT OPENS + THE PILL:');
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
abEval("window.__v1300errs=[];window.addEventListener('error',function(e){window.__v1300errs.push(String(e.message||e))});'armed'");
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
const composerReady = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
ok('S2: the chat opens with the composer ready', composerReady);
const sendRes = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='run it on the shell please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
ok('S2: the message sends', sendRes.includes('sent'), sendRes);
const pillUp = await waitFn("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length >= 1", 25000);
ok('S2: the ONE pill appears (the tool round started)', pillUp);

console.log('S3 — MID-TURN PANEL CLOSE (the stash captures):');
abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(c&&c.state)window.__v1300state=c.state;return 'grabbed'})()");
await sleep(900); // the exec is mid-flight + the first-open label re-render settles
// THE DOM MARKER (planted AFTER the label re-render settles): the stash
// must re-connect THIS EXACT NODE on reopen (no innerHTML rebuild)
const markerSet = abEval("(function(){var p=document.querySelector('.tool-pill');if(!p)return 'no pill';p.setAttribute('data-v1300-marker','M1');window.__v1300marker=p;return 'marked'})()");
ok('S2: the DOM marker rides the pill (the stash-identity witness)', markerSet.includes('marked'), markerSet);
const closeRes = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no ctx panel';if(typeof c.panel.close!=='function')return 'no close';c.panel.close();return 'closed'})()");
ok('S3: the panel closes mid-turn', closeRes.includes('closed'), closeRes);
await sleep(600);
const stashState = abEval("(function(){var cp=window.__v1300state||null;return cp?('stash='+(cp._domStash?'yes':'no')+' len='+cp._stashLen+' streaming='+(cp.isStreaming?'yes':'no')):'no state'})()");
ok('S3: THE STASH captured the live root (the streaming turn stays armed)', stashState.includes('stash=yes') && stashState.includes('streaming=yes'), stashState);
ok('S3: the marker node is detached (not connected)', abEval("window.__v1300marker ? (window.__v1300marker.isConnected ? 'still-connected' : 'detached') : 'missing'").includes('detached'));

console.log('S4 — WHILE CLOSED THE TURN KEEPS RUNNING (no interrupt):');
await sleep(2500); // the slow exec finishes + the answer streams while closed
const closedState = abEval("(function(){var cp=window.__v1300state||null;return cp?('streaming='+(cp.isStreaming?'yes':'no')+' msgs='+cp.messages.length+' bgDrop='+(cp._bgDrop?'dropped':'alive')):'no state'})()");
ok('S4: the turn is STILL ARMED while closed (no false interrupt)', closedState.includes('streaming=yes'), closedState);
ok('S4: the messages grew data-only (the stream lands in state)', closedState.includes('msgs=') && parseInt((closedState.match(/msgs=(\d+)/) || [0, 0])[1], 10) >= 3, closedState);

console.log('S5 — REOPEN: THE STASH RESTORES (the same DOM, the delta, the stream):');
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'reopened') : 'no api'");
await sleep(900);
const markerAlive = abEval("(window.__v1300marker && window.__v1300marker.isConnected) ? 'same-node-restored' : (document.querySelector('[data-v1300-marker]') ? 'new-node' : 'gone')");
ok('S5: THE SAME NODE re-connected (no innerHTML rebuild — the stash restored it)', markerAlive.includes('same-node-restored'), markerAlive);
const turnDone = await waitFn("(window.__v1300state && !window.__v1300state.isStreaming)", 30000);
ok('S5: the turn finished INTO the restored tree (the unbroken turn)', turnDone);
const finalText = abEval("(function(){var b=document.querySelector('#chat-messages');if(!b)return 'no body';return b.textContent.slice(-140)})()");
ok('S5: the answer text landed (the words streamed into the restored DOM)', String(finalText).includes('continuous') || String(finalText).includes('restored'), finalText);
const noRetry = abEval("(function(){var b=document.querySelector('#chat-messages');return b&&b.textContent?b.textContent.slice(0,400):''})()");
ok('S5: NO "Connection dropped" error bubble (the false interrupt is dead)', !String(noRetry).includes('dropped') && !String(noRetry).includes('Tap Retry'));

console.log('S6 — THE HONEST QUERY (the ↗ overlay shows the REAL command):');
const openOv = abEval("(function(){var btn=document.querySelector('.tool-pill-open');if(!btn)return 'no open btn';btn.click();return 'opened'})()");
await sleep(700);
const qText = abEval("(function(){var q=document.querySelector('.tv-q');return q?q.textContent.slice(0,200):'no query box'})()");
ok('S6: the query box shows the REAL command (never [object Object])', String(qText).includes('echo') && !String(qText).includes('[object'), qText);
abEval("window.ConnectOverlay && window.ConnectOverlay.close ? (window.ConnectOverlay.close(), 'closed') : 'no api'");
await sleep(300);

console.log('S7 — GIT_SETUP (the vault token rides bridge stdin):');
await jpost(ENGINE + '/api/keys', { env_var: 'GITHUB_PAT', provider: 'github', key: GH_PAT });
const sendG = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='arm the github token please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
ok('S7: the git_setup request sends', sendG.includes('sent'), sendG);
const gitDone = await waitFn("(window.__v1300state && !window.__v1300state.isStreaming && window.__v1300state.messages.length > 4)", 30000);
ok('S7: the git_setup turn completed', gitDone);
const gitBodies = bridgeBodies.filter((b) => String(b.command || '').includes('git-credentials'));
ok('S7: the bridge ran the git_setup script (the stdin lane)', gitBodies.length >= 1, JSON.stringify(bridgeBodies.map((b) => String(b.command || '').slice(0, 30))));
const credBody = gitBodies[0] || {};
ok('S7: THE TOKEN rides STDIN only (never the command string)', String(credBody.stdin || '').includes(GH_PAT + '@github.com') && !String(credBody.command || '').includes(GH_PAT));
const credFile = FAKE_HOME + '/.git-credentials';
ok('S7: ~/.git-credentials landed in Termux ($HOME)', fs.existsSync(credFile) && String(fs.readFileSync(credFile)).includes(GH_PAT));
const cfgFile = FAKE_HOME + '/.gitconfig';
ok('S7: the identity + credential.helper configured', fs.existsSync(cfgFile) && String(fs.readFileSync(cfgFile)).includes('helper = store'));

console.log('S8 — RELOAD REPLAY (the persisted pair + the honest query):');
const errsBeforeReload = parseInt(String(abEval("window.__v1300errs ? window.__v1300errs.length : 0")) || '0', 10) || 0;
ab('open ' + ENGINE + '/?apk=1');
await sleep(2200);
abEval("window.__v1300errs=[];window.addEventListener('error',function(e){window.__v1300errs.push(String(e.message||e))});'armed'");
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'reopened') : 'no api'");
const replayPill = await waitFn("document.querySelectorAll('.tool-pill').length >= 2", 15000);
ok('S8: the replayed pills render (the persisted tool pairs)', replayPill);
abEval("(function(){var btn=document.querySelector('.tool-pill-open');if(!btn)return 'no btn';btn.click();return 'opened'})()");
await sleep(600);
const rqText = abEval("(function(){var q=document.querySelector('.tv-q');return q?q.textContent.slice(0,200):'no query box'})()");
ok('S8: the replayed query box stays honest (the REAL command)', String(rqText).includes('echo') && !String(rqText).includes('[object'), rqText);
abEval("window.ConnectOverlay && window.ConnectOverlay.close ? (window.ConnectOverlay.close(), 'closed') : 'no api'");

console.log('S9 — MOBILE + CONSOLE:');
ab('set viewport 390 800');
await sleep(900);
const overflow = abEval("(document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) ? 'overflow' : 'fits'");
ok('S9: no horizontal overflow at 390px', overflow.includes('fits'), overflow);
const errors = abEval("window.__v1300errs ? window.__v1300errs.length : 0");
ok('S9: zero page errors across the whole walk (pre-reload ' + errsBeforeReload + ')', parseInt(String(errors) || '0', 10) + errsBeforeReload === 0, errors);
ab('screenshot ' + SHOTS + '/s9-mobile.png');

console.log('');
console.log('v1300 E2E walk: ' + okCount + '/' + (okCount + failCount));
if (failCount) { console.log('FAILS:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('screenshots: ' + SHOTS + '/');
// v1.31.1: the deterministic exit — same law as the replication rig: the
// in-process fake bridge + stub carrier keep node's event loop alive, so an
// all-pass run hung after the final line (the pass printed, the process
// never ended). A one-shot rig exits.
process.exit(0);
