#!/usr/bin/env node
// v1610-patient-hand-rig.mjs — v1.61 THE PATIENT HAND, the LIVE proof:
// the REAL engine binary, a fake OpenAI-compat provider that 429s then
// recovers, a fake termux bridge that EXECUTES through local bash — the
// three legs:
//
//   LEG 1 — THE AUTO-CONTINUE ARC: a turn parks on the fake's 429 → the
//           sentinel arms → the probe pills pace on the WS exactly as
//           the PWA sees them → the fake flips → the recovered pill →
//           the conversation CONTINUES ITSELF (no tap) and the reply
//           lands. The pills carry attempts + the honest elapsed.
//
//   LEG 2 — THE SHARED TIMER: a SECOND chat parks on the SAME signal →
//           ONE timer serves both (both recover + both continue).
//
//   LEG 3 — THE UNFUMBLE: kenny's byte-exact malformed termux call (the
//           tag grammar + the nested-args fumble) through the REAL /mcp
//           route + the REAL bridge — the call EXECUTES, the observation
//           carries the honest teach head (the worst model executes
//           seamlessly).
//
// Honesty law: every assertion binds to the tool's own frames — no
// inference from side effects.
'use strict';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8610;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = '/tmp/v1610-engine';
const DATA = '/tmp/v1610-data';
const HOME = '/tmp/v1610-home';
const TAGA = '\u003c/arg_key\u003e';
const TAGB = '\u003carg_value\u003e';

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ── the fake provider: 429s N chats, then recovers ─────────────────────
const fake = {
  // time-based windows (the count-based design broke under the
  // interleaved auto-continues — the rig's own live conviction):
  // chat calls answer 429 until chatDownUntil, /models until modelsDownUntil.
  chatDownUntil: 0, modelsDownUntil: 0,
};
const fakeSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      if (Date.now() < fake.modelsDownUntil) {
        res.writeHead(429, { 'Retry-After': '2', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited (probe)' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      }
      return;
    }
    // /v1/chat/completions
    if (Date.now() < fake.chatDownUntil) {
      res.writeHead(429, { 'Retry-After': '2', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited — the fake window is closed' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"x","choices":[{"delta":{"content":"AUTO-CONTINUED"}}]}\n\n');
    res.write('data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── the fake termux bridge: /run executes through local bash ───────────
const bridgeSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url === '/status' || req.url === '/probe') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ installed: true, permission: true, props_ok: true, storage_ok: true }));
      return;
    }
    if (req.url === '/run') {
      let cmd = '';
      try { cmd = JSON.parse(body).command || ''; } catch (e) {}
      const child = spawn('/bin/sh', ['-c', cmd], { cwd: HOME });
      let out = '', errx = '';
      child.stdout.on('data', (c) => out += c);
      child.stderr.on('data', (c) => errx += c);
      child.on('close', (code) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stdout: out, stderr: errx, exit_code: code || 0, storage_ok: true, props_ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
});

// ── the engine ─────────────────────────────────────────────────────────
let child = null;
function bootEngine(logPath) {
  const log = fs.openSync(logPath, 'a');
  child = spawn(BIN, ['--port', String(PORT), '--bind', '127.0.0.1', '--data-dir', DATA], {
    detached: true, stdio: ['ignore', log, log],
    env: {
      ...process.env,
      DOOMALAY_OTA_DISABLE: '1',
      DOOMALAY_TERMUX_BRIDGE: 'http://127.0.0.1:8611',
      DOOMALAY_BASE_URL_OPENROUTER: 'http://127.0.0.1:8612',
      DOOMALAY_SENTINEL_QUOTA_S: '2',   // the compressed probe clock (rig law)
      DOOMALAY_SENTINEL_NET_S: '2',
      DOOMALAY_TERMUX_EXTRA_ROOT: '/tmp/v1610-termux-root', // the rig-only safe root (the fake bridge's local jail)
      HOME,
    },
  });
  child.unref();
}
async function waitBoot() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}
function killEngine() {
  try { execSync(`pkill -9 -f '${BIN}' || true`); } catch (e) {}
  try { child && child.kill('SIGKILL'); } catch (e) {}
}

// ONE turn over the engine's WS — collects every frame, the pill rows
// included, resolving on the terminal status.
function wsTurn(sid, text, timeoutMs, collect) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
    const events = [];
    let assistant = '', terminal = null;
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ timeout: true, events, assistant, terminal }); }, timeoutMs || 120000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'send', message: text, session_id: sid }));
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        events.push(ev);
        if (collect) collect(ev);
        if (ev.type === 'assistant_delta' && ev.text) assistant += ev.text;
        if (ev.type === 'assistant' && ev.text) assistant = ev.text;
        if (ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error')) {
          terminal = ev.state;
        }
      } catch (e) {}
    };
    ws.onerror = () => { clearTimeout(t); resolve({ wsError: true, events, assistant, terminal }); };
    ws.onclose = () => { clearTimeout(t); resolve({ events, assistant, terminal }); };
    // the resolver: the rig watches the frames via collect(); the close
    // comes from the caller or the terminal+settle
    if (!collect) { /* plain turn: resolve at close */ }
  });
}

// the pill watcher — a WS that stays open collecting the retry rows
function pillWatcher(sid) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
    const rows = [];
    const errors = [];
    let assistant = '';
    ws.onopen = () => resolve({
      ws, rows, errors, assistant,
      waitFor: (pred, timeoutMs) => new Promise((res) => {
        const t = setTimeout(() => res(false), timeoutMs || 90000);
        const tick = setInterval(() => {
          if (pred(rows, errors, assistant)) { clearTimeout(t); clearInterval(tick); res(true); }
        }, 300);
        ws.onmessage = (m) => {
          try {
            const ev = JSON.parse(m.data);
            if (ev.type === 'retry') rows.push(ev);
            if (ev.type === 'error') errors.push(ev);
            if (ev.type === 'assistant_delta' && ev.text) assistant += ev.text;
            if (ev.type === 'assistant' && ev.text) assistant = ev.text;
          } catch (e) {}
        };
      }),
    });
  });
}

function phaseOf(r) {
  if (r && r.phase) return r.phase;
  try { return JSON.parse(r.text || '{}').phase; } catch (e) { return null; }
}
function pillPhases(rows) { return rows.map(phaseOf); }
function retryRow(rows, phase) { return rows.find((r) => phaseOf(r) === phase); }

// ── the run ───────────────────────────────────────────────────────────
(async function main() {
  try { execSync(`pkill -9 -f '${BIN}' || true`); } catch (e) {}
  const fakeP = new Promise((r) => fakeSrv.listen(8612, '127.0.0.1', r));
  const bridgeP = new Promise((r) => bridgeSrv.listen(8611, '127.0.0.1', r));
  await Promise.all([fakeP, bridgeP]);

  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  bootEngine('/tmp/v1610-eng.log');
  ok('the engine boots', await waitBoot());

  const kr = await api('POST', '/api/keys', { provider: 'openrouter', env_var: 'OPENROUTER_API_KEY', key: 'sk-rig-fake' });
  ok('the fake-provider key installs', kr.status === 200, JSON.stringify(kr.body));

  const cs = await api('POST', '/api/sessions', { title: 'sentinel arc', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/fake-model' });
  const sid = cs.body && (cs.body.ID || cs.body.id);
  ok('the chat session creates', !!sid, JSON.stringify(cs.body).slice(0, 120));

  // ═ LEG 1 — THE AUTO-CONTINUE ARC ═
  console.log('\n\u2550 LEG 1 \u2014 the auto-continue arc (429 park \u2192 probes \u2192 recovery \u2192 the reply lands, no tap)');
  // the rig-controlled release law: the chat 429 window is a generous
  // CEILING; the probe (models) window OPENS only when the armed pill
  // is sighted (the first turn's catalog sync must see /models UP or
  // its 429 delays the dispatch — the run-3 live conviction); the chat
  // window CLOSES when the recovered pill is sighted (the auto-continue
  // then lands its 200 — no cascade).
  fake.chatDownUntil = Date.now() + 120000;
  fake.modelsDownUntil = 0;
  const watch1 = await pillWatcher(sid);
  // the turn rides the pill-watcher's WS (the send flows through it)
  watch1.ws.send(JSON.stringify({ type: 'send', message: 'say AUTO-CONTINUED', session_id: sid }));
  const armed1 = await watch1.waitFor((rows) => pillPhases(rows).includes('armed'), 90000);
  ok('the 429 parks the turn and the sentinel arms', armed1, JSON.stringify(pillPhases(watch1.rows)));
  fake.modelsDownUntil = Date.now() + 4500; // probes fail twice, the third lands
  const recovered1 = await watch1.waitFor((rows) => pillPhases(rows).includes('recovered'), 90000);
  fake.chatDownUntil = 0; // release NOW — before the auto-continue's call (the rig-controlled release)
  const reply1 = await watch1.waitFor((rows, errors, assistant) => assistant.includes('AUTO-CONTINUED'), 60000);
  ok('the sentinel probed, RECOVERED, and the reply landed with NO tap', recovered1 && reply1,
     JSON.stringify({ pills: pillPhases(watch1.rows), errors: watch1.errors.length, assistant: watch1.assistant.slice(0, 60) }));
  const phases1 = pillPhases(watch1.rows);
  ok('the pill ladder is honest (armed → probe(s) → recovered)',
     phases1.includes('armed') && phases1.filter((p) => p === 'probe').length >= 2 && phases1.includes('recovered'),
     JSON.stringify(phases1));
  ok('the parked error carries the machine class', watch1.errors.some((e) => e.retry_class === '429'), JSON.stringify(watch1.errors.slice(0, 1)));
  const recRow = retryRow(watch1.rows, 'recovered');
  const recParsed = recRow ? { phase: recRow.phase, attempts: recRow.attempts, note: recRow.note, started_at: recRow.started_at } : {};
  ok('the recovered pill carries the attempts + the honest elapsed',
     typeof recParsed.attempts === 'number' && recParsed.attempts >= 3 && !!(recParsed.note || recParsed.started_at),
     JSON.stringify(recParsed));
  try { watch1.ws.close(); } catch (e) {}

  // ═ LEG 2 — THE SHARED TIMER (two chats, one signal) ═
  console.log('\n\u2550 LEG 2 \u2014 the shared timer (two chats park on the same 429)');
  fake.chatDownUntil = Date.now() + 180000; // the ceiling covers BOTH ladders
  fake.modelsDownUntil = 0;
  const cs2 = await api('POST', '/api/sessions', { title: 'shared timer b', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/fake-model' });
  const sid2 = cs2.body && (cs2.body.ID || cs2.body.id);
  ok('the second chat creates', !!sid2);

  const w1 = await pillWatcher(sid);
  const w2 = await pillWatcher(sid2);
  w1.ws.send(JSON.stringify({ type: 'send', message: 'say AUTO-CONTINUED', session_id: sid }));
  const aArmed = await w1.waitFor((rows) => pillPhases(rows).includes('armed'), 90000);
  ok('chat A parks + arms', aArmed, JSON.stringify(pillPhases(w1.rows)));
  // B parks on the SAME signal; the probe window stays closed until B
  // joins (~+13s) so ONE timer serves both listeners
  fake.modelsDownUntil = Date.now() + 16000;
  w2.ws.send(JSON.stringify({ type: 'send', message: 'say AUTO-CONTINUED TOO', session_id: sid2 }));
  const bArmed = await w2.waitFor((rows) => pillPhases(rows).includes('armed'), 90000);
  ok('chat B parks + JOINS the same signal', bArmed, JSON.stringify(pillPhases(w2.rows)));

  const bothRec = await Promise.all([
    w1.waitFor((rows) => pillPhases(rows).includes('recovered'), 120000),
    w2.waitFor((rows) => pillPhases(rows).includes('recovered'), 120000),
  ]);
  fake.chatDownUntil = 0; // release both — the staggered continues land
  const bothReply = await Promise.all([
    w1.waitFor((rows, errors, assistant) => assistant.includes('AUTO-CONTINUED'), 60000),
    w2.waitFor((rows, errors, assistant) => assistant.includes('AUTO-CONTINUED'), 60000),
  ]);
  ok('BOTH chats recovered + continued (the shared timer served both)', bothRec[0] && bothRec[1] && bothReply[0] && bothReply[1],
     JSON.stringify({ a: pillPhases(w1.rows), b: pillPhases(w2.rows) }));
  try { w1.ws.close(); } catch (e) {}
  try { w2.ws.close(); } catch (e) {}

  // ═ LEG 3 — THE UNFUMBLE (kenny's exact malformed call through /mcp) ═
  console.log('\n\u2550 LEG 3 \u2014 the unfumble (kenny\u2019s byte-exact tag-grammar call EXECUTES)');
  // arm the chat: the termux capability + a bound device workspace
  const tsess = await api('POST', '/api/sessions', { title: 'unfumble', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/fake-model', capabilities: ['termux'] });
  const tsid = tsess.body && (tsess.body.ID || tsess.body.id);
  ok('the termux chat creates', !!tsid);
  // sess.Termux: the capability flag — check the session's toggles route
  const tset = await api('PATCH', '/api/sessions/' + tsid, { termux: true });
  ok('the \u268a termux capability arms', tset.status === 200 || tset.status === 204, JSON.stringify(tset.body).slice(0, 120));
  const root = '/tmp/v1610-termux-root/unfumble-root';
  fs.mkdirSync(root, { recursive: true });
  const wc = await api('POST', '/api/workspaces/device', { name: 'rigroot', termux_path: root, session_id: tsid });
  const wid = wc.body && (wc.body.ID || wc.body.id || (wc.body.workspace && wc.body.workspace.ID));
  ok('the device workspace connects + binds to the chat', !!wid, JSON.stringify(wc.body).slice(0, 160));

  // kenny's byte-exact shape: {"args": "{\"action\":\"exec\",\"args" + TAGS + "{\"command\":…}"}
  const nested = '{"action":"exec","args' + TAGA + TAGB + '{"command":"echo kenny-would-have-failed"}';
  const argsObj = { args: nested };
  const mc = await fetch(ENGINE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Doomalay-Session': tsid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'termux', arguments: argsObj } }),
  });
  let mcBody = '';
  try { mcBody = await mc.text(); } catch (e) { mcBody = String(e); }
  ok('kenny\u2019s tagged call EXECUTES through the real bus + bridge',
     mcBody.includes('kenny-would-have-failed'), mcBody.slice(0, 400));
  ok('the observation carries the honest teach head',
     mcBody.includes('auto-repaired'), mcBody.slice(0, 400));

  // ═ the verdict ═
  console.log('\n\u2550 VERDICT: ' + (n - fails.length) + '/' + n + (fails.length ? ' \u2014 FAILURES: ' + fails.join(', ') : ' \u2014 ALL GREEN'));
  killEngine();
  try { fakeSrv.close(); bridgeSrv.close(); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('RIG CRASH:', e); killEngine(); process.exit(2); });
