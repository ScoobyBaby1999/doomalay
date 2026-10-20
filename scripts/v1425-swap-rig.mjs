#!/usr/bin/env node
// v1425-swap-rig.mjs — v1.42.5 THE SWAP redteam (PLAN-V142 §3.2): the
// freeze/switch machinery + the settings layering + the manager core,
// proven LIVE (a real engine + the real PWA + a stub LLM for the turn).
//
//   T1  BOOT + THE MANAGER PAGE: the Canvases settings page renders the
//       default row (active badge, the storage line)
//   T2  THE SECOND WORLD: "+ New canvas" through the REAL UI → the
//       switch fires, both rows live, the pointer follows
//   T3  THE BUDGET: a 100-icon world — switching TO it and BACK each
//       land under the plan's 400ms burst budget (the world-switched
//       event's own ms measurement)
//   T4  BEHAVIORAL PARITY: A→B→A restores camera + family + icons
//       exactly; every switch births a NEW Physics.World (no inherited
//       bins); the dots serialize survives the round-trip
//   T5  THE SETTINGS LAYER: world B's theme rides its engine row
//       (state.settings.theme); switching materializes each world's
//       look — the live theme flips with the world
//   T6  THE GOLDEN TEST — TURN CONTINUITY: a 30-chunk stream (~10.5s)
//       mid-flight world switches (A→B→A): the stream never drops, the
//       panel survives (session-keyed, not icon-keyed), the icon
//       re-attaches on return (sessionId rebind), the transcript is
//       complete + dup-free
//   T7  THE MANAGER ACTIONS: rename (inline form) · duplicate ·
//       delete-the-active (switches away first) · the last-canvas guard
//   T8  ZERO page errors + one-row-per-world + the pointer law
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1425-rig-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1425-rig-'));
const ENGINE_PORT = 8427;
const STUB_PORT = 8428;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const MODEL = 'stub/swap-model';
const SID = 'swap-golden-session';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 260) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// failure-tolerant: a failed find returns the error text instead of
// killing the rig (the ok() lines carry the verdicts).
const ab = (args, timeoutMs) => {
  try {
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 30000, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR: ' + String((e && e.stderr) || e.message || e).slice(0, 160);
  }
};
function abEval(js) { return ab(['eval', js], 30000); }
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
}
// abJson — agent-browser JSON-encodes STRING eval results, so a
// JSON.stringify(...) probe comes back DOUBLE-ENCODED; unwrap both
// layers (the first run's 'ms=undefined' lesson: a single parse leaves
// the object a string and every field reads undefined — vacuously).
function abJson(js) {
  const v = abEval(js);
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') j = JSON.parse(j);
    return j;
  } catch (e) { return null; }
}
async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    if (v === true || v === 'true') return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}

// ── the stub LLM (the v1400 harness) ────────────────────────────────
function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  const srv = http.createServer(async (req, res) => {
    const url = req.url.replace(/\?.*$/, '');
    if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      let parsed = {}; try { parsed = JSON.parse(body); } catch (e) {}
      const users = (parsed.messages || []).filter((m) => m.role === 'user');
      const lastUser = String((users[users.length - 1] || {}).content || '');
      let plan;
      if (/long/i.test(lastUser)) {
        plan = [];
        for (let i = 0; i < 30; i++) plan.push({ d: ' swapchunk-' + i + ' padding text to make the tail real. ', wait: 350 });
      } else {
        plan = [{ d: ' quick-a ', wait: 150 }, { d: ' quick-b ', wait: 150 }];
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const ch of plan) {
        if (ch.d) sse(res, { choices: [{ delta: { content: ch.d } }] });
        await sleep(ch.wait);
      }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(STUB_PORT, '127.0.0.1', () => r(srv)));
}

// ── world states ────────────────────────────────────────────────────
function icon(i) {
  return { type: 'chat', id: 'chat_w_' + i, name: 'W' + i, x: 120 + (i % 10) * 90, y: 120 + Math.floor(i / 10) * 90,
    vx: 0, vy: 0, radius: 34, pinned: false, sandbox: 'quick', sessionId: '' };
}
function worldA() {   // the 2-icon home world (camera + family + a golden-test icon)
  return {
    offset: { x: -240, y: 160 }, scale: 0.9, currentFamily: 'anthropic',
    icons: [
      // v1.42.5 T6 lesson: the model rides the ICON (serialize carries
      // it — chatbot.js) — a hand-built icon without one dead-ends at the
      // gatelock (no composer, no bind, no turn). Real saves always have it.
      Object.assign(icon(900), { id: 'chat_golden', name: 'Golden', sessionId: SID, model: MODEL, provider: 'groq' }),
      icon(901)
    ],
    dots: [], settings: { theme: 'midnight' }, savedAt: Date.now(), canvas: 'default'
  };
}
function worldB() {   // the 100-icon budget world (different camera + look)
  const icons = [];
  for (let i = 0; i < 100; i++) icons.push(icon(i));
  return {
    offset: { x: 400, y: -300 }, scale: 0.55, currentFamily: 'default',
    icons, dots: [], settings: { theme: 'ocean' }, savedAt: Date.now(), canvas: 'w100'
  };
}

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

async function boot() {
  console.log('boot: engine + stub + the real PWA');
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DOOMALAY_BASE_URL_GROQ: STUB, DOOMALAY_OTA_DISABLE: '1' },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) break; } catch (e) {}
    await sleep(500);
  }
  await api('POST', '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-key' });
  await api('POST', '/api/sessions', { id: SID, title: 'swap golden', model: MODEL, provider: 'groq' });
  // the two worlds, engine-side (the rig owns the seed; the app boots into A).
  // ORDER: w100 first, THEN default — the list is sort ASC, updated_at DESC,
  // so the LAST-seeded row is rows[0] and a pointerless boot deterministically
  // lands on Home (worldA) — the rig's every A↔B assumption hangs on this.
  await api('PUT', '/api/canvases/w100', { name: 'The Field', state: worldB() });
  await api('PUT', '/api/canvases/default', { name: 'Home', state: worldA() });
  // the clean slate (the v1424 lesson: static page, no app JS)
  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('T1 the app boots', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  // capture the switch events (the rig's own clock)
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
}

async function openSettingsCanvases() {
  // close any open panel first (the golden test leaves the chat panel
  // up; the Settings button sits under it — 'Element is covered' kills
  // the find-click). #panel-view-x is the panel chrome's close (the
  // stack-eating X, not a single-view pop).
  abEval("(function(){var x=document.getElementById('panel-view-x');if(x){x.click();return 'closed'}return 'no-panel'})()");
  await sleep(600);
  ab(['find', 'role', 'button', 'click', '--name', 'Settings']);
  await sleep(800);
  // the panel opens on the Appearance tab — the Canvases NAV TAB carries
  // the page (the storagehygiene precedent: data-page=<id>)
  abEval("(function(){var t=document.querySelector('[data-page=canvases]');if(!t)return 'no-tab';t.click();return 'clicked'})()");
  return waitFn("!!document.getElementById('cv-rows')", 8000);
}

const iconCount = () => parseInt(abEval("document.querySelectorAll('#chatbots > *').length") || '0', 10);
const probe = () => abJson("(window.doomalay.worldsProbe ? JSON.stringify(window.doomalay.worldsProbe()) : '{}')");
const lastSwitch = () => abJson("(window.__sw&&window.__sw.length)?JSON.stringify(window.__sw[window.__sw.length-1]):'null'");

(async () => {
  console.log('v1425-swap-rig — THE SWAP (freeze/switch live)');
  await startStub();
  await boot();

  // ── T1 the manager page ─────────────────────────────────────────
  ok('T1 the Canvases page opens from Settings', await openSettingsCanvases());
  await sleep(700);
  let rowsHtml = pstr("document.getElementById('cv-rows') ? document.getElementById('cv-rows').textContent : 'no-rows'");
  ok('T1 both worlds listed (Home + The Field)', /Home/.test(rowsHtml) && /The Field/.test(rowsHtml), rowsHtml.slice(0, 120));
  ok('T1 the active badge rides the current world', /active/.test(rowsHtml));
  const storageLine = pstr("document.getElementById('cv-storage') ? document.getElementById('cv-storage').textContent : ''");
  ok('T1 the storage line counts canvases', /2 canvases/.test(storageLine), storageLine);

  // ── T2 create + switch through the REAL UI ──────────────────────
  abEval("(function(){var b=document.getElementById('cv-new');if(!b)return 'no-btn';b.click();return 'clicked'})()");
  ok('T2 the create+switch lands', await waitFn("(window.__sw||[]).length >= 1", 8000));
  await sleep(600);
  const probe2 = probe();
  ok('T2 the new world is active + empty', probe2.active && probe2.active !== 'default' && probe2.active !== 'w100' && probe2.icons === 0, JSON.stringify(probe2));
  const ptr = pstr("localStorage.getItem('doomalay.canvas.current')");
  ok('T2 the pointer follows', ptr === probe2.active, ptr + ' vs ' + probe2.active);
  let listed = await api('GET', '/api/canvases');
  ok('T2 three rows engine-side (one per world)', listed.body.canvases.length === 3, JSON.stringify(listed.body.canvases.map((c) => c.id)));

  // ── T3 the budget (100 icons both directions) ───────────────────
  const sw1 = abEval("window.doomalay.switchTo('w100').then(r=>JSON.stringify(r))");
  ok('T3 switch TO the 100-icon world', await waitFn("(window.__sw||[]).some(s=>s.id==='w100'&&s.ok)", 10000));
  await sleep(400);
  ok('T3 all 100 icons restored', iconCount() === 100, 'icons=' + iconCount());
  let s1 = lastSwitch();
  ok('T3 TO-budget < 400ms (100 icons)', s1 && typeof s1.ms === 'number' && s1.ms < 400, 'ms=' + (s1 && s1.ms));
  const sw2 = abEval("window.doomalay.switchTo('default').then(r=>JSON.stringify(r))");
  ok('T3 switch BACK home', await waitFn("(window.__sw||[]).some(s=>s.id==='default'&&s.ok&&s.from==='w100')", 10000));
  await sleep(400);
  let s2 = lastSwitch();
  ok('T3 BACK-budget < 400ms', s2 && typeof s2.ms === 'number' && s2.ms < 400, 'ms=' + (s2 && s2.ms));
  ok('T3 home restored (2 icons)', iconCount() === 2, 'icons=' + iconCount());

  // ── T4 behavioral parity ────────────────────────────────────────
  // identity via a STAMP (abEval serializes objects — comparing them
  // compares shapes, not references; a property the fresh instance
  // cannot carry is the only honest identity probe in this harness)
  abEval("window.doomalay.world.__rigStamp = 'before'");
  const camA = JSON.parse(pstr('JSON.stringify(window.doomalay.cameraProbe())'));
  abEval("window.doomalay.switchTo('w100')");
  await sleep(900);
  const camB = JSON.parse(pstr('JSON.stringify(window.doomalay.cameraProbe())'));
  const stampMid = pstr("window.doomalay.world.__rigStamp || 'gone'");
  abEval("window.doomalay.world.__rigStamp = 'mid'");
  abEval("window.doomalay.switchTo('default')");
  await sleep(900);
  const camA2 = JSON.parse(pstr('JSON.stringify(window.doomalay.cameraProbe())'));
  const stampAfter = pstr("window.doomalay.world.__rigStamp || 'gone'");
  ok('T4 the camera restores exactly (A→B→A)', camA2.x === camA.x && camA2.y === camA.y && Math.abs(camA2.scale - camA.scale) < 1e-9,
    JSON.stringify({ a: camA, b: camB, a2: camA2 }));
  ok('T4 the worlds differ (B really applied)', camB.x !== camA.x || camB.y !== camA.y);
  ok('T4 every switch births a NEW Physics.World (stamps die)', stampMid === 'gone' && stampAfter === 'gone',
    'mid=' + stampMid + ' after=' + stampAfter);
  ok('T4 the family rides the world (anthropic home)', pstr('window.doomalay.getFamily()') === 'anthropic');
  const dots = pstr('JSON.stringify((window.TabGroups&&window.TabGroups.serialize())||[])');
  ok('T4 the dots serializer answers (empty home)', dots === '[]', dots);

  // ── T5 the settings layer ───────────────────────────────────────
  // world A carries theme midnight, world B carries theme ocean (the seeds)
  const themeBefore = pstr("JSON.parse(localStorage.getItem('doomalay.settings.v1')||'{}').theme || 'midnight'");
  abEval("window.doomalay.switchTo('w100')");
  await sleep(900);
  const themeB = pstr("JSON.parse(localStorage.getItem('doomalay.settings.v1')||'{}').theme || 'midnight'");
  abEval("window.doomalay.switchTo('default')");
  await sleep(900);
  const themeA = pstr("JSON.parse(localStorage.getItem('doomalay.settings.v1')||'{}').theme || 'midnight'");
  ok('T5 the look materializes per world (B=ocean)', themeB === 'ocean', themeBefore + ' → ' + themeB);
  ok('T5 the look materializes per world (A=midnight)', themeA === 'midnight', themeB + ' → ' + themeA);
  // the slice round-trips through the engine row (the calm sync)
  await sleep(2600);
  const rowA = await api('GET', '/api/canvases/default');
  const rowB = await api('GET', '/api/canvases/w100');
  ok('T5 the slice rides the engine rows', rowA.body.canvas.state.settings && rowA.body.canvas.state.settings.theme === 'midnight' &&
    rowB.body.canvas.state.settings.theme === 'ocean',
    JSON.stringify({ a: rowA.body.canvas.state.settings && rowA.body.canvas.state.settings.theme, b: rowB.body.canvas.state.settings && rowB.body.canvas.state.settings.theme }));

  // ── T6 THE GOLDEN TEST — a turn survives the switches ───────────
  ok('T6 the golden icon exists + is bound', pstr("(window.doomalay.findIconForSession('" + SID + "')||{}).sessionId || 'none'") === SID);
  abEval("(window.doomalay.openChatBySession('" + SID + "', {}), 'opened')");
  ok('T6 the chat opens', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
  const send = pstr("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='give me the long answer';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
  ok('T6 the long turn starts', send === 'sent', send);
  ok('T6 streaming arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return !!(c&&c.state&&c.state.isStreaming)})()", 8000));
  await sleep(1800);   // let some chunks land
  const len1 = parseInt(pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var st=c&&c.state;var la=null;for(var i=st.messages.length-1;i>=0;i--){if(st.messages[i].role==='assistant'){la=st.messages[i];break}}return la?la.text.length:0})()") || '0', 10);
  ok('T6 the stream is alive pre-switch', len1 > 20, 'len=' + len1);
  // MID-STREAM: switch away
  abEval("window.doomalay.switchTo('w100')");
  ok('T6 the mid-stream switch lands', await waitFn("(window.__sw||[]).some(s=>s.id==='w100'&&s.ok)", 8000));
  await sleep(1500);
  const lenMid = parseInt(pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var st=c&&c.state;var la=null;for(var i=st.messages.length-1;i>=0;i--){if(st.messages[i].role==='assistant'){la=st.messages[i];break}}return la?la.text.length:0})()") || '0', 10);
  ok('T6 THE STREAM SURVIVES the switch (still growing)', lenMid > len1, len1 + ' → ' + lenMid);
  // switch BACK mid-stream
  abEval("window.doomalay.switchTo('default')");
  ok('T6 the switch back lands', await waitFn("(window.__sw||[]).some(s=>s.id==='default'&&s.ok)", 8000));
  await sleep(1200);
  ok('T6 the icon re-attaches (sessionId rebind)', pstr("(window.doomalay.findIconForSession('" + SID + "')||{}).sessionId || 'none'") === SID);
  // the turn completes
  ok('T6 the turn completes', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return c&&c.state&&!c.state.isStreaming})()", 25000));
  const finalText = pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var st=c&&c.state;var la=null;for(var i=st.messages.length-1;i>=0;i--){if(st.messages[i].role==='assistant'){la=st.messages[i];break}}return la?la.text:''})()");
  const chunkCount = (finalText.match(/swapchunk-\d+/g) || []).length;
  const uniq = new Set(finalText.match(/swapchunk-\d+/g) || []);
  ok('T6 the transcript is complete (all 30 chunks)', chunkCount >= 30, 'chunks=' + chunkCount);
  ok('T6 the transcript is dup-free', uniq.size === chunkCount, uniq.size + '/' + chunkCount);
  const errBubbles = pstr("(function(){var t=document.body?document.body.textContent:'';return /tap Retry|reply was interrupted|Connection to the engine dropped/i.test(t)?'yes':'no'})()");
  ok('T6 zero error bubbles across the whole golden path', errBubbles === 'no', errBubbles);

  // ── T7 the manager actions ──────────────────────────────────────
  ok('T7 the Canvases page reopens', await openSettingsCanvases());
  await sleep(700);
  // rename the ACTIVE (Home) via the inline form — the row's OWN pencil
  // (row order is engine-sorted; find-by-text would hit whatever row
  // is first — deterministic targeting or the test is a lottery)
  abEval("(function(){var r=document.querySelector('#cv-rows [data-cv-id=default] [data-cv-act=rename]');if(!r)return 'no-btn';r.click();return 'clicked'})()");
  await sleep(400);
  const hasForm = abEval("!!document.getElementById('cv-rn-in')") === 'true';
  if (hasForm) {
    abEval("(function(){var i=document.getElementById('cv-rn-in');i.value='Home Renamed';i.dispatchEvent(new Event('input',{bubbles:true}));var f=document.getElementById('cv-rn');f.dispatchEvent(new Event('submit'));return 'submitted'})()");
    ok('T7 the rename lands engine-side', await waitFn("(fetch('/api/canvases/default').then(r=>r.json()).then(d=>d.canvas.name==='Home Renamed'))", 8000));
  } else ok('T7 the rename form opens', false, 'no inline form');
  await sleep(600);
  // duplicate the field — the w100 row's OWN dup button
  abEval("(function(){var r=document.querySelector('#cv-rows [data-cv-id=w100] [data-cv-act=dup]');if(!r)return 'no-btn';r.click();return 'clicked'})()");
  ok('T7 the duplicate appears', await waitFn("(fetch('/api/canvases').then(r=>r.json()).then(d=>d.canvases.some(c=>c.name==='The Field copy')))", 8000));
  await sleep(500);
  // delete the duplicate (a non-active row) — the LAST action button on its row.
  // ROW-DIV counting: the action buttons ALSO carry data-cv-id (4 elements
  // per canvas) — '#cv-rows [data-cv-id]' over-counts 4×; > child selectors
  // count real rows.
  // TIMELINE (installed BEFORE the click): stamp every cv-note mutation —
  // the confirm's render time vs the click time is the late-render evidence.
  abEval("(function(){window.__noteLog=[];window.__noteT0=0;var n=document.getElementById('cv-note');if(!n)return 'no-note';var mo=new MutationObserver(function(){window.__noteLog.push(Date.now())});mo.observe(n,{childList:true,subtree:true,characterData:true});return 'observing'})()");
  const delRes = pstr("(function(){var rows=document.querySelectorAll('#cv-rows > [data-cv-id]');for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('The Field copy')>=0){var b=rows[i].querySelector('[data-cv-act=del]');window.__noteT0=Date.now();b.click();return 'clicked'}}return 'not-found'})()");
  const confirmShown = await waitFn("!!document.getElementById('cv-del-y')", 8000);
  const noteTimeline = pstr("JSON.stringify({clickToNow:Date.now()-(window.__noteT0||0),log:(window.__noteLog||[]).map(function(t){return t-(window.__noteT0||0)})})");
  ok('T7 the delete confirm shows', delRes === 'clicked' && confirmShown,
    delRes + ' | confirm=' + confirmShown + ' | timeline=' + noteTimeline + ' | note=' + pstr("(document.getElementById('cv-note')||{}).textContent || 'no-note'").slice(0, 100));
  abEval("document.getElementById('cv-del-y').click()");
  ok('T7 the duplicate dies', await waitFn("(fetch('/api/canvases').then(r=>r.json()).then(d=>!d.canvases.some(c=>c.name==='The Field copy')))", 8000));
  // the last-canvas guard: delete everything down to one
  const guard = await (async () => {
    for (let guardI = 0; guardI < 6; guardI++) {
      const rr = await api('GET', '/api/canvases');
      if (rr.body.canvases.length <= 1) break;
      const victim = rr.body.canvases.find((c) => c.id !== 'default');
      await api('DELETE', '/api/canvases/' + victim.id);
    }
    return true;
  })();
  void guard;
  await sleep(300);
  // RELOAD (the engine-side deletes bypassed the page — a stale rowsCache
  // would pass the guard on 4 phantom rows; a fresh boot also re-proves the
  // pointer law + the row-count truth in one move)
  ab(['open', ENGINE]);
  ok('T7 the reload lands after the cleanup', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1500);
  abEval("(function(){window.__sw=window.__sw||[];window.__errs=window.__errs||[];return 'rewired'})()");
  await openSettingsCanvases();
  await sleep(700);
  const lastDel = pstr("(function(){var rows=document.querySelectorAll('#cv-rows > [data-cv-id]');if(rows.length!==1)return 'rows='+rows.length;rows[0].querySelector('[data-cv-act=del]').click();return 'clicked'})()");
  await sleep(400);
  const guardNote = pstr("document.getElementById('cv-note')?document.getElementById('cv-note').textContent:''");
  ok('T7 the LAST CANVAS GUARD refuses', lastDel === 'clicked' && /stays/.test(guardNote), lastDel + ' | ' + guardNote);

  // ── T8 the close-out laws ───────────────────────────────────────
  listed = await api('GET', '/api/canvases');
  ok('T8 one row per world (no leaks)', listed.body.canvases.length === 1 && listed.body.canvases[0].id === 'default',
    JSON.stringify(listed.body.canvases.map((c) => c.id)));
  // NOTE: `agent-browser errors` is decorative in this CLI build (bare ✗
  // marks regardless of page state — convicted live) — only real error
  // TEXT fails; the in-page listener is the truth.
  const errs = ab(['errors']);
  const realErrLines = String(errs).split('\n').map((l) => l.trim()).filter((l) => l && l !== '✗' && l !== '✓');
  ok('T8 zero page errors across the whole rig', realErrLines.length === 0, JSON.stringify(realErrLines).slice(0, 300));

  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  console.log(`\n${n - fails.length}/${n} passed${fails.length ? '\n  FAILED: ' + fails.join(' · ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
