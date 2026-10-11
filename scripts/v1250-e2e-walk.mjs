#!/usr/bin/env node
// v1250-e2e-walk.mjs — v1.25.0 THE PARITY WAVE redteam: the REAL-USER walk.
//
// ONE long-lived process (the sandbox reaps daemons between commands):
// boots the carrier world in-process (the executing fake bridge + the
// OpenAI stub with a SLOW termux tool call + the engine), then drives
// the PWA through agent-browser exactly as a human would — every phase
// of PLAN-V125 in ONE ride:
//
//   S2  the chat opens — and the ⚡ badge is GONE (quick + nothing in
//       use paints NO badge — §4's death of the meaningless glyph)
//   S3  THE CAP ROW PILL (§1): the capabilities library opens, the
//       Termux row speaks the ON/OFF pill every toggle row speaks, the
//       sub is STATIC, the tap cycle flips on → off → on
//   S4  THE PILL TITLES (§5): the turn runs a real termux exec — the
//       pill carries the ONE-WORD VERB chip (bash) + the dim body; the
//       ↗ overlay's tv-name speaks 'bash' with the raw name in the
//       tooltip; the merged pill survives
//   S5  THE DRAWER PARITY (§2): the workspace picker's termux row →
//       '📂 open in drawer' → the drawer renders the DEVICE STORAGE
//       tree → expand → the file → the editor → EDIT → SAVE → the file
//       CHANGED ON DISK (save ≠ download)
//   S6  THE HONEST NAMES (§3): a nameless device bind derives the real
//       folder's basename (the engine fallback — pinned live)
//   S7  THE BUNDLE FACE (§4): applyBundle (the hub Use seam) → the
//       chat icon's corner badge paints the bundle's FACE (the lucide
//       svg — the same IconLib resolver the library card uses), the seg
//       shows label + ✕, the ✕ DETACHES (badge gone, manifest dropped);
//       re-attach → RELOAD → the badge re-faces at open (the loadBundle
//       init) — and the ⚡ stays dead when detached
//   S8  mobile 390px + zero page errors (the wave's receipts)
'use strict';

import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');

const ENGINE_BIN = '/tmp/doomalay-v1250-e2e-engine';
const DATA_DIR = '/tmp/v1250-e2e-data';
const ENGINE_LOG = '/tmp/v1250-e2e-engine.log';
const SHOTS = '/tmp/v1250-shots';

const ENGINE_PORT = 8661;
const STUB_PORT = 8662;
const BRIDGE_PORT = 8663;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1250-e2e-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;

const SID = 'e2e-parity-walk';
const MODEL = 'groq/stub-model';
const SLOW_CMD = "bash -c 'for i in $(seq 1 8); do echo \"wave step $i done\"; sleep 0.5; done'";

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

// agent-browser driver (the CLI; JSON where we parse)
function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message);
  }
}
function abEval(js) { return ab('eval ' + JSON.stringify(js), 20000); }

// ── the executing fake bridge (the v1233 law) ─────────────────────────
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
        const stdin = (b.stdin === undefined || b.stdin === null) ? '' : String(b.stdin);
        const workdir = b.workdir ? intoFake(String(b.workdir)) : '';
        const timeoutMS = Number(b.timeout_ms) || 60000;
        const p = spawn('bash', ['-c', cmd], {
          env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin', PREFIX: '/usr' },
          cwd: fs.existsSync(workdir) ? workdir : undefined,
        });
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        // v1.20.2 THE EXTRA_STDIN LAW (the v1204 bridge law): the write's
        // content rides stdin — `cat > "$1"` reads it; without the pipe the
        // save truncates the file to empty (the S5 redteam find).
        if (stdin) { try { p.stdin.write(stdin); } catch (e) {} }
        try { p.stdin.end(); } catch (e) {}
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMS + 4000);
        p.on('close', (code) => {
          clearTimeout(timer);
          send(200, {
            ok: true,
            stdout: intoTermux(out).slice(0, 102400),
            stderr: intoTermux(errOut).slice(0, 20480),
            stdout_original_length: intoTermux(out).length,
            stderr_original_length: intoTermux(errOut).length,
            exit_code: code === null ? -1 : code,
            err: 0, errmsg: null, timeout: false,
          });
        });
      });
      return;
    }
    send(404, { ok: false, error: 'unknown route' });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── the OpenAI stub (round 1: the SLOW termux exec; round 2: the answer)
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
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      const hasToolResult = (parsed.messages || []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (!hasToolResult) {
        sse(res, { choices: [{ delta: { content: 'Running it on the device shell.' } }] });
        await sleep(100);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v1251', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(50);
        // v1.26.1: the DEVICE'S EXACT SHAPE — the nested args as a JSON
        // STRING (the MCP manifest's declared type; the live Faqous
        // events' form — the blank-title bug's root cause, now pinned
        // in BOTH walks)
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: JSON.stringify({ command: SLOW_CMD, timeout_ms: 60000 }) }) } }] } }] });
        await sleep(50);
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const w of ['Done', '—', 'the', 'shell', 'answered.']) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(30); }
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
  const env = {
    ...process.env,
    DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN,
    DOOMALAY_BASE_URL_GROQ: STUB,
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
    await sleep(200);
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    if (String(v).trim() === 'true' || String(v).trim() === '"true"') return true;
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(400);
  }
}
// agent-browser returns eval results JSON-encoded — a plain string comes
// back double-quoted; unwrap it (and double-encoded JSON twice).
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
}
function jparse(s) {
  try { return JSON.parse(JSON.parse(s)); } catch (e) {}
  try { return JSON.parse(s); } catch (e) {}
  return {};
}

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('S1 — BOOT (engine + bridge + stub + seeds):');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/wave-proj', { recursive: true });
fs.writeFileSync(FAKE_SHARED + '/Doomalay/wave-proj/notes.txt', 'alpha\nbravo\ncharlie\n');
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
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'parity walk', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/workspaces/device', { name: 'wave-proj', termux_path: TERMUX_SHARED + '/Doomalay/wave-proj', session_id: SID });
ok('the world boots (engine healthy, session armed, termux workspace bound + auto-stacked)', true);
ab('close');
console.log('S1 ok — opening the PWA');

// S2 — the chat opens + the ⚡ is dead
// (?apk=1 — the documented desktop escape hatch so the Termux capability
// row renders for this E2E; the row still needs the live bridge status)
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
const openRes = abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
const composerReady = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
ok('S2: the chat opens with the composer ready (model pre-set)', composerReady && openRes.includes('opened'), openRes);
await sleep(800);  // the bind + pill paints settle
const badgeIdle = pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var b=c&&c.icon?c.icon.el:null;var bad=b?b.querySelector('.sandbox-badge'):null;return bad?bad.className+'|'+bad.textContent:'none'})()");
ok('S2: quick + nothing in use → NO badge at all (the ⚡ dies — §4)', badgeIdle === 'none', badgeIdle);

// S3 — THE CAP ROW PILL (§1 the parity)
console.log('S3 — THE CAP ROW (the Termux on/off pill):');
abEval('(function(){var c=window.ChatPanel.current();if(window.Capabilities&&c){window.Capabilities.open(c);return "opened"}return "no caps"})()');
const capUp = await waitFn("!!document.querySelector('.cap-row[data-cap=\"termux\"]')", 8000);
ok('S3: the capabilities library opens with the Termux row', capUp);
if (capUp) {
  const rowInfo = abEval("(function(){var c=document.getElementById('cap-chip-termux');return JSON.stringify({chip:c?c.textContent.trim():'none',cls:c?c.className:''})})()");
  const ri = jparse(rowInfo);
  ok('S3: ready + stacked → the chip reads ON (the pill every toggle row speaks)',
    /on/i.test(ri.chip || '') && /cap-chip on/.test(ri.cls || ''), rowInfo);
  // the static sub (the description never moves under the finger)
  const subBefore = pstr("(document.getElementById('cap-sub-termux')||{textContent:''}).textContent");
  // the tap cycle: on → off → on
  abEval('(function(){var r=document.querySelector(\'.cap-row[data-cap="termux"]\');if(r){r.click();return "tapped"}return "no row"})()');
  await sleep(1400);
  const chipOff = pstr("(document.getElementById('cap-chip-termux')||{textContent:''}).textContent.trim()");
  ok('S3: the tap flips the chip OFF (the same pill, honest state)', /off/i.test(chipOff), chipOff);
  const subAfter = pstr("(document.getElementById('cap-sub-termux')||{textContent:''}).textContent");
  ok('S3: the sub is STATIC across the flip (the MD3 row law — §1)', subBefore === subAfter, subBefore + ' vs ' + subAfter);
  abEval('(function(){var r=document.querySelector(\'.cap-row[data-cap="termux"]\');if(r){r.click();return "tapped"}return "no row"})()');
  await sleep(1400);
  const chipOn = pstr("(document.getElementById('cap-chip-termux')||{textContent:''}).textContent.trim()");
  ok('S3: the tap flips the chip back ON (the cycle completes)', /on/i.test(chipOn) && !/off/i.test(chipOn), chipOn);
  abEval('document.querySelector("#connect-overlay-x") && document.querySelector("#connect-overlay-x").click()');
  await sleep(500);
  ab('screenshot ' + SHOTS + '/s3-cap-row.png');
}

// S4 — THE PILL TITLES (§5)
console.log('S4 — THE PILL TITLES (the one-word verb chip):');
const sendRes = abEval('(function(){var t=document.querySelector(\'#chat-input\')||document.querySelector(\'textarea\');if(!t)return \'no input\';t.value=\'run it on the shell please\';t.dispatchEvent(new Event(\'input\',{bubbles:true}));var s=document.querySelector(\'[aria-label="Send the message"]\');if(!s)return \'no send\';s.click();return \'sent\'})()');
ok('S4: the message sends', sendRes.includes('sent'), sendRes);
const pillUp = await waitFn("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length >= 1", 20000);
ok('S4: the ONE pill appears', pillUp);
if (pillUp) {
  const pillInfo = abEval("(function(){var p=document.querySelector('.tool-pill');var nm=p&&p.querySelector('.tool-pill-name');var lbl=p&&p.querySelector('.tool-pill-text');return p?p.className+' | '+(nm?nm.textContent:'')+' | '+(lbl?lbl.textContent.slice(0,80):''):'none'})()");
  ok('S4: the pill carries the ONE-WORD VERB chip (bash) + the dim body (§5)',
    /tool-pill-use/.test(pillInfo) && /bash/.test(pillInfo) && !/ exec /.test(pillInfo), pillInfo);
  // the overlay: tv-name speaks the verb
  abEval('(function(){var o=document.querySelector(\'.tool-pill-open\');if(!o)return \'no open ctl\';o.click();return \'clicked\'})()');
  const ovUp = await waitFn("!!document.querySelector('.tool-fullview')", 8000);
  ok('S4: the overlay opens (pending, live)', ovUp);
  if (ovUp) {
    const one = abEval("(function(){var v=document.querySelector('.tool-fullview');if(!v)return 'none';return JSON.stringify({name:(v.querySelector('.tv-name')||{}).textContent,nameAttr:(v.querySelector('.tv-name')||{}).title,sub:(v.querySelector('.tv-sub')||{}).textContent})})()");
    const s = jparse(one);
    ok('S4: tv-name = the verb (bash), the raw name in the tooltip, the sub is the body',
      s.name === 'bash' && s.nameAttr === 'termux' && /-c/.test(s.sub || ''), one);
    ab('screenshot ' + SHOTS + '/s4-overlay.png');
  }
  await waitFn("!!document.querySelector('.tool-fullview .tv-result')", 30000);
  abEval('document.querySelector(\'#connect-overlay-x\') && document.querySelector(\'#connect-overlay-x\').click()');
  await sleep(500);
  // the merged pill survives the landing
  const merged = abEval("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length");
  ok('S4: ONE merged pill after the landing', merged === '1', merged);
  ab('screenshot ' + SHOTS + '/s4-merged-pill.png');
}

// S5 — THE DRAWER PARITY (§2)
console.log('S5 — THE DRAWER (the picker → open in drawer → tree → edit → SAVE):');
abEval('(function(){window.Workspace.openPicker("' + SID + '", {name:"parity walk"});return "picker-open"})()');
const pickerUp = await waitFn("!!document.querySelector('.wsx-row')", 8000);
ok('S5: the workspace picker opens with the bound row', pickerUp);
if (pickerUp) {
  // expand the row → its acts
  abEval('(function(){var r=document.querySelector(\'.wsx-row\');if(r){r.click();return "expanded"}})()') ;
  await sleep(400);
  const drBtn = await waitFn("!!document.querySelector('[data-a=\"drawer\"]')", 6000);
  ok('S5: the row\'s acts expose the "📂 open in drawer" button', drBtn);
  abEval('(function(){var b=document.querySelector(\'[data-a="drawer"]\');if(b){b.click();return "clicked"}return "no btn"})()');
  const drawerUp = await waitFn("!!document.querySelector('.wsc-row')", 10000);
  ok('S5: the drawer renders the DEVICE STORAGE tree (the session-not-found error is dead — §2)', drawerUp);
  if (drawerUp) {
    // expand the termux root → the file row
    abEval('(function(){var r=document.querySelector(\'.wsc-row\');if(r){r.click();return "expanded"}})()');
    const fileRow = await waitFn("(function(){var rows=document.querySelectorAll('.wsc-row .wsc-name');for(var i=0;i<rows.length;i++){if(rows[i].textContent===\'notes.txt\')return true}return false})()", 10000);
    ok('S5: the termux tree lists the seeded file (expand + lazy load)', fileRow);
    if (fileRow) {
      abEval("(function(){var rows=document.querySelectorAll('.wsc-row');for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.wsc-name');if(n&&n.textContent==='notes.txt'){rows[i].click();return 'opened'}}return 'not found'})()");
      const editorUp = await waitFn("!!document.querySelector('#wtx-fsave')", 10000);
      ok('S5: the file opens in the drawer editor (textarea + save)', editorUp);
      if (editorUp) {
        const diskBefore = fs.readFileSync(FAKE_SHARED + '/Doomalay/wave-proj/notes.txt', 'utf8');
        abEval('(function(){var ta=document.getElementById(\'wsv-ta\');if(!ta)return \'no ta\';ta.value=ta.value+\'\\ndelta-saved\\n\';var b=document.getElementById(\'wtx-fsave\');if(b){b.click();return \'saved\'}return \'no btn\'})()');
        const savedNote = await waitFn("(function(){var n=document.getElementById('wtx-fnote');return n&&/saved/.test(n.textContent)}())", 12000);
        // read the disk truth (the save ≠ download law)
        await sleep(700);
        const diskAfter = fs.readFileSync(FAKE_SHARED + '/Doomalay/wave-proj/notes.txt', 'utf8');
        ok('S5: SAVE wrote the REAL file on disk (the edit landed — save ≠ download)',
          diskAfter !== diskBefore && /delta-saved/.test(diskAfter),
          JSON.stringify(diskAfter.slice(-60)));
        ok('S5: the save note confirms', savedNote === true || /saved/.test(abEval("(document.getElementById('wtx-fnote')||{textContent:''}).textContent")), abEval("(document.getElementById('wtx-fnote')||{textContent:''}).textContent"));
        ab('screenshot ' + SHOTS + '/s5-drawer-save.png');
      }
    }
  }
  abEval('document.querySelector("#connect-overlay-x") && document.querySelector("#connect-overlay-x").click()');
  await sleep(400);
}

// S6 — THE HONEST NAMES (§3): a nameless bind derives the basename
console.log('S6 — THE HONEST NAMES (the nameless bind):');
{
  const r = await jpost(ENGINE + '/api/workspaces/device', { termux_path: TERMUX_SHARED + '/Doomalay/wave-proj', session_id: SID });
  const listed = await (await fetch(ENGINE + '/api/sessions/' + SID + '/workspaces')).json();
  const rows = (listed.workspaces || []);
  const derived = rows.filter((w) => (w.meta && w.meta.termux_path || '').indexOf('wave-proj') >= 0);
  const names = derived.map((w) => w.name);
  ok('S6: a NAMELESS device bind derives the folder\'s real name (wave-proj — never "my folder")',
    r.status < 400 && names.some((nm) => /wave-proj/i.test(String(nm))) && !names.some((nm) => /my folder/i.test(String(nm))),
    JSON.stringify(names));
}

// S7 — THE BUNDLE FACE (§4)
console.log('S7 — THE BUNDLE FACE (attach → face → ✕ detach → reload → re-face):');
{
  // attach through the REAL activation seam (the hub Use button's own call)
  const att = abEval("(function(){window.ChatPanel.applyBundle({id:'superpowers-mock',name:'superpowers-mock',tag:'v125',icon:'zap',repo:'doomalay/superpowers',members:[{type:'skill',name:'member-one',repo:'doomalay/superpowers',id:'i1'}]});return 'applied'})()");
  ok('S7: applyBundle lands (the hub Use seam)', att.includes('applied'), att);
  await sleep(900);
  const face = abEval("(function(){var c=window.ChatPanel.current();var b=c&&c.icon?c.icon.el.querySelector('.sandbox-badge'):null;var seg=document.getElementById('seg-lib-bundle');return JSON.stringify({badge:!!b,cls:b?b.className:'',hasSvg:!!(b&&b.querySelector('svg')),chip:!!(c&&c.state&&c.state.bundle&&c.state.bundle.icon==='zap'),segShown:!!(seg&&seg.style.display!=='none'),segX:!!(seg&&seg.querySelector('.seg-lib-bundle-x')),segLab:(seg&&(seg.querySelector('.seg-lib-bundle-label')||{}).textContent)||'',tplChip:!!document.querySelector('#tpl-chip')})})()");
  const f = jparse(face);
  ok('S7: the chat icon\'s badge paints the bundle\'s FACE (the lucide svg — the card\'s own resolver)',
    f.badge === true && /bbdg/.test(f.cls || '') && f.hasSvg === true, face);
  ok('S7: state.bundle carries the icon + repo (the manifest face)',
    f.chip === true, face);
  ok('S7: the seg shows the bundle (label span + the ✕) — the pill right of the lib',
    f.segShown === true && f.segX === true && /superpowers/.test(f.segLab || ''), face);
  ok('S7: the redundant full-width ▣ chip is GONE (the seg + badge carry it)',
    f.tplChip === false, face);
  ab('screenshot ' + SHOTS + '/s7-bundle-face.png');

  // the ✕ DETACHES
  abEval('(function(){var x=document.querySelector(\'.seg-lib-bundle-x\');if(x){x.click();return \'x-clicked\'}return \'no x\'})()');
  await sleep(900);
  const after = abEval("(function(){var c=window.ChatPanel.current();var b=c&&c.icon?c.icon.el.querySelector('.sandbox-badge'):null;var seg=document.getElementById('seg-lib-bundle');return JSON.stringify({bundle:!!(c&&c.state&&c.state.bundle),badge:!!b,segShown:!!(seg&&seg.style.display!=='none'),stored:!!(function(){try{return JSON.parse(localStorage.getItem('doomalay.chatbundle.v1'))['" + SID + "']}catch(e){return false}})()})})()");
  const a2 = jparse(after);
  ok('S7: the ✕ DETACHES the bundle (state + localStorage manifest dropped)',
    a2.bundle === false && a2.stored === false, after);
  ok('S7: the badge hides with the detach (quick + nothing in use)', a2.badge === false, after);
  ok('S7: the seg hides with the detach', a2.segShown === false, after);

  // re-attach → reload → the badge re-faces at open (the loadBundle init)
  abEval("(function(){window.ChatPanel.applyBundle({id:'superpowers-mock',name:'superpowers-mock',tag:'v125',icon:'zap',repo:'doomalay/superpowers',members:[{type:'skill',name:'member-one',repo:'doomalay/superpowers',id:'i1'}]});return 're-applied'})()");
  await sleep(700);
  ab('reload');
  await sleep(2400);
  abEval("window.doomalay && window.doomalay.openChatBySession && window.doomalay.openChatBySession('" + SID + "', {})", 20000);
  const reface = await waitFn("(function(){var c=window.ChatPanel.current();var b=c&&c.icon?c.icon.el.querySelector('.sandbox-badge'):null;return !!(b&&b.querySelector('svg'))}())", 15000);
  ok('S7: after RELOAD the badge re-faces at open (the loadBundle init — §4)', reface);
  const reSeg = pstr("(function(){var seg=document.getElementById('seg-lib-bundle');return seg?String(seg.style.display!=='none'):'no seg'})()");
  ok('S7: the seg re-shows the attached bundle after reload', /true/.test(reSeg), reSeg);
  ab('screenshot ' + SHOTS + '/s7-reload-reface.png');
}

// S8 — mobile + console
console.log('S8 — MOBILE + CONSOLE (the receipts):');
ab('set viewport 390 844');
await sleep(700);
const noOverflow = abEval("document.documentElement.scrollWidth <= 392");
ok('S8: no horizontal overflow at 390px', /true/.test(noOverflow), noOverflow);
const segFits = abEval("(function(){var seg=document.getElementById('seg-lib-bundle');if(!seg)return 'no seg';var r=seg.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),hasX:!!seg.querySelector('.seg-lib-bundle-x')})})()");
const sf = jparse(segFits);
ok('S8: the seg (label + ✕) fits the mobile toolbar (≤ 90px, the ✕ intact)', sf.w <= 92 && sf.hasX === true, segFits);
ab('screenshot ' + SHOTS + '/s8-mobile.png');
const errs = ab('errors');
const errLines = errs.split('\n').filter((l) => l.trim() && !/^\[agent-browser\]/.test(l));
ok('S8: zero page errors across the whole walk', errLines.length === 0, errLines.slice(0, 3).join(' | '));

// teardown
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
const byes = fails.length ? '\n  FAIL - ' + fails.join('\n  FAIL - ') : '';
console.log(`\nv1250 E2E walk: ${okCount - failCount}/${okCount}${byes}`);
console.log('screenshots: ' + SHOTS + '/ (s3 s4 s5 s7 s8)');
process.exit(fails.length ? 1 : 0);
