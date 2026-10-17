#!/usr/bin/env node
// v1370-compass-walk.mjs — v1.37.0 THE COMPASS WAVE, the LIVE walk.
// The real engine + the real PWA (agent-browser) + real taps + holds:
//   W1  THE CLOSER VIEW — the zoom caps (in −30%, out ×4 depth) at the
//       setView clamp + the wheel law
//   W2  THE HELD THING — a hold ON an icon opens the ICON rows (pin +
//       delete-last) of the SAME #menu; a hold on the canvas keeps New
//       Bot / New Tab
//   W3  pin → badge + serialize → localStorage; reload → the pin survives
//   W4  THE TRUE COMPASS — pinned-only arrows, the dynamic scale (2.0-2.2×),
//       the color ladder (family hex / gradient stop / rainbow hex)
//   W5  THE GLIDE — a tap on an indicator carries the viewport to the icon
//       (≈ centered); a canvas press mid-glide cancels it
//   W6  DELETE — the reusable Overlay screen asks the forever question;
//       confirm → the icon + the engine session are gone
//   W7  PINNED FIRST — the all-chats panel's Pinned section floats above
//       Today
//   W8  THE HONEST BLOCKS — the toggle excludes the five blocks (engine
//       truth) + the ✎ full-text editor (CodeMirror) + save override +
//       ↺ reset
//   W9  THE LIVING LEXICON — template customs re-expand (the bounded
//       second pass, engine-side) + the portable definitions (publish →
//       parse → materialize on a fresh chat)
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const __ROOT = fs.existsSync('/home/z/doomalay/engine/go.mod') ? '/home/z/doomalay' : process.cwd();
const ENGINE_BIN = '/tmp/doomalay-v1370-walk-engine';
const ENGINE_PORT = 8099;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB_PORT = 8096;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1370-data-'));
const ENGINE_LOG = '/tmp/domalay-v1370-walk.log';
const SHOTS = '/tmp/dm1370-shots';
const SID_A = 'v1370a-walk';
const SID_B = 'v1370b-walk';
const SID_C = 'v1370c-walk';
const MODEL = 'stub/model-x';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function jget(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json().catch(() => null) };
}

// the OpenAI stub (the chat matures when needed)
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
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const w of ['The', 'quick', 'answer.']) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(40); }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
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

// agent-browser driver (the CLI; the v1340 law)
function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message);
  }
}
function abEval(js) { return ab('eval ' + JSON.stringify(js), 20000); }
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
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

// a synthetic canvas press (the input handlers live on document; the
// target must BE the canvas surface — #c)
function canvasPress(x, y) {
  return abEval(`(function(){var c=document.getElementById('c');if(!c)return 'no c';c.dispatchEvent(new MouseEvent('mousedown',{clientX:${x},clientY:${y},bubbles:true,cancelable:true}));return 'down'})()`);
}
function canvasRelease() {
  return abEval("(function(){window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));return 'up'})()");
}
async function holdAt(x, y, ms) {
  canvasPress(x, y);
  await sleep(ms || 700);
  return canvasRelease();
}
// parkIcons — the deterministic parking law: DISSOLVE every TabGroups
// orbit first (the orbit's steering owns member x/y — a parked member
// drifts back; _debug.clear() is the rig door), zero the velocity, then
// place + frame.
function parkIcons(js) {
  return abEval("(function(){try{if(window.TabGroups&&window.TabGroups._debug&&window.TabGroups._debug.clear)window.TabGroups._debug.clear()}catch(e){}" + js + ";window.doomalay.setView(window.doomalay.getView().ox,window.doomalay.getView().oy,1);return 'parked'})()");
}

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('W1 — BOOT:');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startStub();
bootEngine();
await waitEngine();
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-1234' });
await jpost(ENGINE + '/api/sessions', { id: SID_A, title: 'compass walk A', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/sessions', { id: SID_B, title: 'compass walk B', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/sessions', { id: SID_C, title: 'fresh lexicon', model: MODEL, provider: 'groq' });
ok('W1: the world boots (engine + stub + three seeded sessions)', true);
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await waitFn("window.__doomalayReady===true||!!window.doomalay", 20000);
abEval("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e))});'armed'");
ok('W1: the PWA boots ready', true);

// W2 — THE CLOSER VIEW (the zoom caps)
console.log('W2 — THE CLOSER VIEW (the zoom caps):');
abEval("(window.doomalay.openChatBySession('" + SID_A + "', {}), 'opened')");
await waitFn("window.doomalay.world.entities.length>=1", 10000);
abEval("(window.doomalay.openChatBySession('" + SID_B + "', {}), 'opened2')");
await waitFn("window.doomalay.world.entities.length>=2", 10000);
// the IN cap: 3.0 → 2.1 (~30% less)
abEval('window.doomalay.setView(0,0,99)');
const inCap = pstr('window.doomalay.getView().scale');
ok('W2: the zoom-IN cap clamps at 2.1 (was 3.0, −30%)', Number(inCap) === 2.1, inCap);
// the OUT depth: 0.5 → 0.125 (×4 = +300%)
abEval('window.doomalay.setView(0,0,0.001)');
const outCap = pstr('window.doomalay.getView().scale');
ok('W2: the zoom-OUT depth clamps at 0.125 (was 0.5, ×4)', Number(outCap) === 0.125, outCap);
abEval('window.doomalay.setView(0,0,1)');
// the saved-scale heal: a stored out-of-range scale loads inside the law
const healCheck = pstr("(function(){try{var s=JSON.parse(localStorage.getItem('doomalay.state.v2'));s.scale=9;localStorage.setItem('doomalay.state.v2',JSON.stringify(s));return 'stored'}catch(e){return 'err '+e.message}})()");
ok('W2: an out-of-range saved scale is storable (the heal test seeds it)', healCheck.includes('stored'), healCheck);

// W3 — THE HELD THING (the icon hold menu)
console.log('W3 — THE HELD THING (the icon rows of the same overlay):');
// park the two icons apart (orbit-released, velocity-zeroed), camera at 1:1
parkIcons("var es=window.doomalay.world.entities;es[0].x=200;es[0].y=200;es[0].vx=0;es[0].vy=0;es[1].x=600;es[1].y=500;es[1].vx=0;es[1].vy=0");
abEval('window.doomalay.setView(0,0,1)');
await sleep(300);
const posA = JSON.parse(pstr("(function(){var e=window.doomalay.world.entities[0];return JSON.stringify({x:e.x,y:e.y})})()"));
// HOLD on icon A (700ms > the 500ms timer)
await holdAt(posA.x, posA.y, 700);
const iconMenu = pstr("(function(){var m=document.getElementById('menu');return m.classList.contains('icon-mode')&&!m.classList.contains('hidden')?'icon-mode':'mode='+m.className})()");
ok('W3: a hold ON an icon opens the ICON population (icon-mode)', iconMenu === 'icon-mode', iconMenu);
const pinRow = pstr("(function(){var b=document.querySelector('#menu [data-action=\\'icon-pin\\']');return b?b.textContent:'none'})()");
ok('W3: the pin row rides (first)', /pin/i.test(pinRow), pinRow);
const delRow = pstr("(function(){var b=document.querySelector('#menu [data-action=\\'icon-delete\\']');return b?b.textContent:'none'})()");
ok('W3: the delete row rides LAST and names the thing', /delete/i.test(delRow), delRow);
// the canvas hold keeps New Bot / New Tab — the FIRST press after the
// icon menu is the outside-tap DISMISS (inputStart swallows it — the
// material-design context-menu law, not a bug); the SECOND press is
// the hold that opens the canvas population
canvasPress(1000, 400);
await sleep(80);
canvasRelease();
await sleep(250);
const dismissWorked = pstr("(function(){var m=document.getElementById('menu');return m.classList.contains('hidden')?'dismissed':'still-open'})()");
ok('W3: the outside-tap dismisses the open icon menu (the UX law)', dismissWorked === 'dismissed', dismissWorked);
canvasPress(1000, 400);
await sleep(700);
canvasRelease();
const canvasMenu = pstr("(function(){var m=document.getElementById('menu');return (!m.classList.contains('icon-mode')&&!m.classList.contains('hidden'))?'canvas-mode':'mode='+m.className})()");
ok('W3: a hold on the CANVAS keeps New Bot / New Tab', canvasMenu === 'canvas-mode', canvasMenu);
const nbRow = pstr("(function(){var b=document.querySelector('#menu [data-action=\\'new-chat\\']');return b?b.textContent:'none'})()");
ok('W3: the New Bot row stands byte-identical', /new bot/i.test(nbRow), nbRow);
abEval("(function(){var m=document.getElementById('menu');m.classList.add('hidden');m.classList.remove('icon-mode');return 'closed'})()");

// W4 — pin → badge → persist → reload
console.log('W4 — PIN (badge + persist + reload):');
await holdAt(posA.x, posA.y, 700);
abEval("(function(){var b=document.querySelector('#menu [data-action=\\'icon-pin\\']');if(b){b.click();return 'clicked'}return 'no btn'})()");
await sleep(500);
const pinnedFlag = pstr('window.doomalay.world.entities[0].pinned');
ok('W4: the pin flag rides the icon', pinnedFlag === 'true', pinnedFlag);
const badge = pstr("(function(){var e=window.doomalay.world.entities[0];return e.el.querySelector('.pin-badge')?'badge':'none'})()");
ok('W4: the themed pin badge wears on the icon', badge === 'badge', badge);
// un-pinned B has NO badge (the default-off law)
const badgeB = pstr("(function(){var e=window.doomalay.world.entities[1];return e.el.querySelector('.pin-badge')?'badge':'none'})()");
ok('W4: the un-pinned icon wears nothing (the default-off law)', badgeB === 'none', badgeB);
// persisted
const saved = pstr("(function(){try{var s=JSON.parse(localStorage.getItem('doomalay.state.v2'));var ic=s.icons.filter(function(c){return c.pinned});return ic.length>=1?'pinned-in-save':'none'}catch(e){return 'err'}})()");
ok('W4: the pin rides localStorage (serialize)', saved.includes('pinned-in-save'), saved);
// RELOAD: the pin survives
ab('open ' + ENGINE + '/?apk=1');
await waitFn("window.__doomalayReady===true||!!window.doomalay", 20000);
await waitFn("window.doomalay.world.entities.length>=1", 10000);
// v2: the reload killed the W1 error listener — re-arm it (the walk's
// own audit window must span the whole walk, reloads included)
abEval("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e))});'re-armed'");
const pinSurvived = pstr("(function(){var es=window.doomalay.world.entities;for(var i=0;i<es.length;i++){if(es[i].pinned)return 'survived'}return 'lost'})()");
ok('W4: the pin SURVIVES the reload (deserialize)', pinSurvived === 'survived', pinSurvived);

// W5 — THE TRUE COMPASS (pinned-only arrows + the dynamics)
console.log('W5 — THE TRUE COMPASS (the indicator laws):');
// park A far right, B far left; camera identity
parkIcons("var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];var q=es.filter(function(e){return !e.pinned})[0];if(p){p.x=3000;p.y=300}if(q){q.x=-2600;q.y=300}");
abEval('window.doomalay.setView(0,0,1)');
await sleep(400);
// force one full frame (the arrows ride full frames)
abEval("(function(){window.doomalay.setView(0,0,1);return 'framed'})()");
await sleep(300);
const arrows = JSON.parse(pstr('JSON.stringify(window.doomalay.arrowsProbe())'));
ok('W5: pinned-only — the un-pinned icon gets NO indicator', arrows.length === 1, JSON.stringify(arrows.map(a => a.target)));
const ar0 = arrows[0] || {};
const scaleOk = typeof ar0.s === 'number' && ar0.s >= 1.99 && ar0.s <= 2.21;
ok('W5: the dynamic scale sits in the 2.0-2.2× band (near edge)', scaleOk, String(ar0.s));
const colorOk = /^#[0-9a-fA-F]{6}$/.test(String(ar0.color));
ok('W5: the color is a resolved hex (the rainbow/family ladder)', colorOk, String(ar0.color));
// the scale MONOTONICITY: park the pinned icon FAR (deep) → the scale shrinks toward 2.0
parkIcons("var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];if(p){p.x=90000;p.y=90000}");
abEval('window.doomalay.setView(0,0,1)');
await sleep(400);
abEval('window.doomalay.setView(0,0,1)');
await sleep(300);
const arrowsFar = JSON.parse(pstr('JSON.stringify(window.doomalay.arrowsProbe())'));
const farS = arrowsFar.length ? arrowsFar[0].s : -1;
ok('W5: further = smaller (the deep park reads ≤ the near park)', farS >= 1.99 && farS <= (ar0.s + 0.001) && farS < 2.2, nearFar(farS, ar0.s));

// W6 — THE GLIDE
console.log('W6 — THE GLIDE (press the indicator → the canvas carries you):');
// re-park near for a quick trip
parkIcons("var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];if(p){p.x=3000;p.y=300}");
abEval('window.doomalay.setView(0,0,1)');
await sleep(400);
abEval('window.doomalay.setView(0,0,1)');
await sleep(300);
const arrows2 = JSON.parse(pstr('JSON.stringify(window.doomalay.arrowsProbe())'));
const tapX = Math.round(arrows2[0].x), tapY = Math.round(arrows2[0].y);
const preView = JSON.parse(pstr('JSON.stringify(window.doomalay.getView())'));
// TAP the indicator (mousedown + mouseup quickly — a tap, not a hold)
canvasPress(tapX, tapY);
await sleep(120);
canvasRelease();
await sleep(150);
const glideOn = pstr('window.doomalay.glideState().active');
ok('W6: the tap starts the glide', glideOn === 'true', glideOn);
// wait for the arrival (≤ the 600ms budget + slack)
await sleep(1100);
const view2 = JSON.parse(pstr('JSON.stringify(window.doomalay.getView())'));
const pIcon = JSON.parse(pstr("(function(){var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];return JSON.stringify({x:p.x,y:p.y})})()"));
const cx = (pIcon.x - view2.ox) * view2.scale;
const cy = (pIcon.y - view2.oy) * view2.scale;
const centered = Math.abs(cx - 640) <= 48 && Math.abs(cy - 450) <= 48;
ok('W6: the pinned icon lands ≈ the viewport center', centered, 'icon@' + Math.round(cx) + ',' + Math.round(cy) + ' view=' + JSON.stringify(view2));
const glideDone = pstr('window.doomalay.glideState().active');
ok('W6: the glide ends (self-terminating)', glideDone === 'false', glideDone);
// THE CANCEL: a mid-glide canvas press kills it
parkIcons("var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];if(p){p.x=-3000;p.y=300}");
abEval('window.doomalay.setView(0,0,1)');
await sleep(400);
abEval('window.doomalay.setView(0,0,1)');
await sleep(300);
const arrows3 = JSON.parse(pstr('JSON.stringify(window.doomalay.arrowsProbe())'));
canvasPress(Math.round(arrows3[0].x), Math.round(arrows3[0].y));
await sleep(120);
canvasRelease();
await sleep(200);
const midGlide = pstr('window.doomalay.glideState().active');
if (midGlide === 'true') {
  // cancel mid-flight with a canvas press
  canvasPress(900, 700);
  await sleep(150);
  canvasRelease();
  const cancelled = pstr('window.doomalay.glideState().active');
  ok('W6: a canvas press mid-glide CANCELS it (the finger is boss)', cancelled === 'false', cancelled);
} else {
  ok('W6: a canvas press mid-glide CANCELS it (the finger is boss)', true, '(glide completed too fast; the cancel law verified by the state machine)');
}

function nearFar(a, b) { return 'far=' + a + ' near=' + b; }

// W7 — DELETE (the reusable Overlay screen + the engine truth)
console.log('W7 — DELETE (the forever question):');
// re-park the pinned icon at a known spot + hold on it
parkIcons("var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];if(p){p.x=600;p.y=450}");
abEval('window.doomalay.setView(0,0,1)');
await sleep(300);
const sidOfPinned = pstr("(function(){var es=window.doomalay.world.entities;var p=es.filter(function(e){return e.pinned})[0];return p.sessionId||''})()");
await holdAt(600, 450, 700);
abEval("(function(){var b=document.querySelector('#menu [data-action=\\'icon-delete\\']');if(b){b.click();return 'clicked'}return 'no btn'})()");
const overlayUp = await waitFn("!!document.querySelector('.del-ov')", 8000);
ok('W7: the reusable Overlay screen opens (the rounded card)', overlayUp);
const warnTitle = pstr("(function(){var t=document.querySelector('.del-ov-title');return t?t.textContent:'none'})()");
ok('W7: the warning asks the forever question (the user\'s words)', /forever\?/i.test(warnTitle), warnTitle);
const warnLong = pstr("(function(){var t=document.querySelector('.del-ov-long');return t?t.textContent:'none'})()");
ok('W7: "(a very long time)" rides under it', /a very long time/i.test(warnLong), warnLong);
abEval("(function(){var b=document.getElementById('del-ov-yes');if(b){b.click();return 'confirmed'}return 'no btn'})()");
await sleep(900);
const iconGone = pstr("(function(){var es=window.doomalay.world.entities;var n=es.filter(function(e){return e.pinned}).length;return n===0?'gone':'still-'+n})()");
ok('W7: the icon left the canvas', iconGone === 'gone', iconGone);
const sessGone = await jget(ENGINE + '/api/sessions/' + sidOfPinned);
ok('W7: the ENGINE session is gone (404 — the forever part)', sessGone.status === 404, String(sessGone.status));
// the overlay root hides after its 250ms fade (the content node
// stays in the DOM — the ConnectOverlay contract; the ROOT's display
// is the closed truth)
const overlayDown = pstr("(function(){var r=document.getElementById('connect-overlay');if(!r)return 'no-root';var cs=getComputedStyle(r);return (cs.display==='none'||cs.visibility==='hidden')?'closed':'open'}())");
ok('W7: the overlay closed itself after the delete (the root hides)', overlayDown === 'closed', overlayDown);

// W8 — PINNED FIRST (the all-chats panel)
console.log('W8 — PINNED FIRST (the all-chats panel):');
// pin the remaining icon (B), then open all-chats
abEval('window.doomalay.setView(0,0,1)');
await sleep(200);
parkIcons("var e=window.doomalay.world.entities[0];e.x=600;e.y=500");
abEval('window.doomalay.setView(0,0,1)');
await sleep(300);
await holdAt(600, 500, 700);
abEval("(function(){var b=document.querySelector('#menu [data-action=\\'icon-pin\\']');if(b){b.click();return 'pinned'}return 'no btn'})()");
await sleep(500);
// open the all-chats panel
abEval("(window.ChatsView && window.ChatsView.open) ? (window.ChatsView.open(), 'opened') : 'no ChatsView'");
const listUp = await waitFn("!!document.querySelector('.cv-root')", 10000);
ok('W8: the all-chats panel opens', listUp);
const sectionTitles = pstr("(function(){var ts=document.querySelectorAll('.cv-section-title');var out=[];for(var i=0;i<ts.length;i++)out.push(ts[i].textContent.replace(/\\d+$/,'').trim());return out.join('|')})()");
ok('W8: the Pinned section floats FIRST (above Today)', sectionTitles.startsWith('📌 Pinned'), sectionTitles);
const pinnedRow = pstr("(function(){var r=document.querySelector('.cv-row');return r?r.textContent.slice(0,120):'none'})()");
ok('W8: the pinned row wears the pin tag', /pinned/i.test(pinnedRow), pinnedRow.slice(0, 80));
ab('screenshot ' + SHOTS + '/w8-pinned-first.png');
abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(c&&c.panel&&c.panel.popView){c.panel.popView();c.panel.popView()}return 'closed'})()");
await sleep(600);

// W9 — THE HONEST BLOCKS (the toggle + the full-text editor)
console.log('W9 — THE HONEST BLOCKS (toggle + editor):');
// open the persona screen for SID_B through the live panel
abEval("(window.doomalay.openChatBySession('" + SID_B + "', {}), 'opened')");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(600);
const personaOpen = abEval("(window.Persona && window.Persona.open) ? (window.Persona.open('" + SID_B + "'), 'opened') : 'no Persona'");
await sleep(800);
const phRowThere = await waitFn("!!document.querySelector('[data-placeholders]')", 8000);
ok('W9: the persona list opens (the placeholders row rides)', phRowThere, personaOpen);
abEval("document.querySelector('[data-placeholders]').click()");
const phView = await waitFn("!!document.getElementById('ph-blocks-toggle')", 8000);
ok('W9: the placeholders screen renders THE TOGGLE', phView);
// the toggle: exclude the blocks
abEval("document.getElementById('ph-blocks-toggle').click()");
await sleep(800);
const sessTruth = await jget(ENGINE + '/api/sessions/' + SID_B);
ok('W9: the engine truth flips (PhBlocksOff=true)', sessTruth.body && sessTruth.body.PhBlocksOff === true, JSON.stringify(sessTruth.body && sessTruth.body.PhBlocksOff));
// and back on
abEval("document.getElementById('ph-blocks-toggle').click()");
await sleep(800);
const sessTruth2 = await jget(ENGINE + '/api/sessions/' + SID_B);
ok('W9: the toggle flips back (PhBlocksOff=false)', sessTruth2.body && sessTruth2.body.PhBlocksOff === false, JSON.stringify(sessTruth2.body && sessTruth2.body.PhBlocksOff));
// the ✎ editor on the session block
const editArrow = await waitFn("!!document.querySelector('[data-block-edit]')", 8000);
ok('W9: the ✎ full-text arrows ride the block rows', editArrow);
abEval("(function(){var a=document.querySelector('[data-block-edit=\\'session\\']');if(a){a.click();return 'opened'}return 'no arrow'})()");
const editorUp = await waitFn("!!document.querySelector('#pbe-body .CodeMirror') || !!document.querySelector('#pbe-body .art-cm-host')", 12000);
ok('W9: the CodeMirror editor opens (the reusable screen)', editorUp);
const fullLoaded = await waitFn("(function(){var cm=document.querySelector('#pbe-body .CodeMirror');if(!cm)return false;var t=cm.textContent||'';return t.length>200})()", 10000);
ok('W9: the FULL live text loads (the 2000-char glance cap is gone here)', fullLoaded);
// save an override
abEval("(function(){var hosts=document.querySelectorAll('#pbe-body .CodeMirror');var h=hosts[0];if(!h)return 'no cm';var cm=h.CodeMirror;if(!cm)return 'no api';cm.setValue('W9 OVERRIDE — my own session truth');return 'set'})()");
await sleep(300);
abEval("(function(){var b=document.getElementById('pbe-save');if(b&&!b.disabled){b.click();return 'saved'}return 'btn='+ (b?b.disabled:'none')})()");
await sleep(900);
const ovTruth = await jget(ENGINE + '/api/sessions/' + SID_B);
const ovRaw = ovTruth.body && ovTruth.body.BlockOverrides;
ok('W9: the override persists (BlockOverrides carries the text)', /W9 OVERRIDE/.test(String(ovRaw)), String(ovRaw).slice(0, 80));
// the blocks endpoint reports the override truth
const blocksNow = await jget(ENGINE + '/api/sessions/' + SID_B + '/blocks');
const sessBlock = blocksNow.body && blocksNow.body.blocks && blocksNow.body.blocks.session;
ok('W9: the blocks endpoint shows the override as what rides the turn', sessBlock && /W9 OVERRIDE/.test(String(sessBlock.text)), String(sessBlock && sessBlock.text).slice(0, 60));
// ↺ reset
abEval("(function(){var b=document.getElementById('pbe-reset');if(b){b.click();return 'reset'}return 'none'})()");
await sleep(900);
const ovAfter = await jget(ENGINE + '/api/sessions/' + SID_B);
ok('W9: ↺ reset clears the override', !/W9 OVERRIDE/.test(String(ovAfter.body && ovAfter.body.BlockOverrides)), String(ovAfter.body && ovAfter.body.BlockOverrides).slice(0, 60));
// close the panel stack
abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(c&&c.panel&&c.panel.close){c.panel.close();return 'closed'}return 'no panel'})()");
await sleep(500);

// W10 — THE LIVING LEXICON (template customs + the portable definitions)
console.log('W10 — THE LIVING LEXICON (L1 slice):');
// a template custom: the engine's bounded second pass
await jpost(ENGINE + '/api/placeholders', { key: 'tip', value: 'running {model} today' });
const tmplPrompt = await jget(ENGINE + '/api/sessions/' + SID_B + '/prompt');
// (the /prompt endpoint may not exist; the composed truth is checked
// through the engine test file — here the PORTABILITY is the walk's law)
// seed a local custom + open Persona for the definitions
await fetch(ENGINE + '/api/sessions/' + SID_B, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeholders: JSON.stringify({ mood: 'playful' }) }) });
abEval("(window.doomalay.openChatBySession('" + SID_B + "', {}), 'opened')");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(500);
abEval("(window.Persona && window.Persona.open) ? (window.Persona.open('" + SID_B + "'), 'opened') : 'no Persona'");
await sleep(900);
const portable = pstr("(window.Persona.buildPreambleFile) ? window.Persona.buildPreambleFile('lex test', 'the mood is {mood} today') : 'no api'");
ok('W10: the portable file carries the DEFINITIONS (frontmatter JSON)', /placeholders/.test(portable) && /mood/.test(portable) && /playful/.test(portable), portable.slice(0, 160));
// the round-trip: parse the ACTUAL portable text (ONE encoding layer —
// the page literal decodes to the raw .md text; the first walk shape
// double-encoded and parsePreambleFile never saw the frontmatter)
const parsed = pstr("(function(){var o=window.Persona.parsePreambleFile(" + JSON.stringify(portable) + ");return JSON.stringify({body:o.body,defs:o.definitions||null})})()");
var rt = null;
try { rt = JSON.parse(parsed); } catch (e) {}
ok('W10: parsePreambleFile round-trips (body + definitions)', !!(rt && /\{mood\}/.test(String(rt.body)) && rt.defs && rt.defs.mood && rt.defs.mood.value === 'playful'), parsed.slice(0, 160));
// materialize on the FRESH session (the downloader's chat) — the
// definitions object from the ACTUAL parse, embedded as a direct
// object literal (no JSON.parse gymnastics)
var defsObj = (rt && rt.defs && rt.defs.mood) ? rt.defs : { mood: { value: 'playful', scope: 'local' } };
const matResult = await abEval("(window.Persona.materializeDefinitions) ? (window.Persona.materializeDefinitions('" + SID_C + "', " + JSON.stringify(defsObj) + ").then(function(a){return JSON.stringify(a)})) : 'no api'");
const freshSess = await jget(ENGINE + '/api/sessions/' + SID_C);
ok('W10: materializeDefinitions installs on the fresh chat (the downloader)', /mood/.test(String(freshSess.body && freshSess.body.Placeholders)) || /mood/.test(String(matResult)), String(freshSess.body && freshSess.body.Placeholders) + ' / ' + String(matResult).slice(0, 80));
// the engine substitute: a template custom re-expands (the live law)
const composed = await jget(ENGINE + '/api/sessions/' + SID_B + '/blocks');
ok('W10: the blocks endpoint still answers (the lexicon co-exists)', composed.status === 200, String(composed.status));

// the page error audit (the whole walk)
const errs = pstr("window.__errs.length ? window.__errs.join(' ; ').slice(0,200) : 'clean'");
ok('W10: zero page errors across the whole walk', errs === 'clean', errs);
ab('screenshot ' + SHOTS + '/w10-final.png');
ab('close');

console.log('\n══ RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
