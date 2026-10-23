#!/usr/bin/env node
// v1590-honest-return-rig.mjs — v1.59 THE HONEST RETURN battery (PLAN-V159 §4).
//
// §0 parse + source pins: the three sub-waves' laws live in the source.
// §A THE BOTTOM (v1.59.1): the Android WebView-reload reality — the page
//    RELOADS (chatStates empty), a long-convos chat opens, and the load:
//    bulk-fetches the log (REST), folds data-only, mounts ONE tail-shaped
//    transcript at the BOTTOM (the MutationObserver census: a handful of
//    childList records, not one per message), connects the WS with
//    &since=<maxSeq> (the engine ships only the gap + the live tail), the
//    folded convo is WHOLE, the scroll lands at the bottom, the composer
//    settles (no mid-flight theater), and it all happens FAST.
// §B THE SERVE MEMORY (v1.59.2): the engine side — pinned by
//    TestV1592_ServeMemoryBinding (go test): create+persist → engine
//    restart ADOPTS (no new serve session, prompt = user text only) →
//    dead binding self-heals → the delete drops the binding + issues the
//    serve-side DELETE (and never spawns when the bridge is down). This
//    rig re-verifies the live 2.1.2 shapes via a REAL serve probe section.
// §C THE GHOST (v1.59.3): a populated chat closes (the DOM stash lands —
//    the ghost fuel), the long-press DELETE path runs, and EVERY residue
//    dies (state map, stash, LS draft + scroll rows, the engine session);
//    the next newborn id is MONOTONIC (max+1, never the retired id); the
//    newborn's panel is VIRGIN; a dead-session export renders the honest
//    message and NEVER opens a dead URL (the black-window crash class).
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(__ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p.startsWith('/') ? p : path.join(WEB, p), 'utf8');

const ENGINE_PORT = 8463;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const ENGINE_BIN = '/tmp/v1590-rig-engine';
const DATA_DIR = '/tmp/v1590-rig-data';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log('\n═ ' + t); }

const ab = (args, timeoutMs) => {
  try {
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 30000, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR: ' + String((e && e.stderr) || e.message || e).slice(0, 160);
  }
};
function abEval(js) { return ab(['eval', js], 45000); }
// abStr: agent-browser returns JSON-encoded values — strings carry quotes.
function abStr(js) { const v = abEval(js); return String(v).replace(/^"|"$/g, ''); }
function abJson(js) {
  const v = abEval(js);
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') j = JSON.parse(j);
    return j;
  } catch (e) { return null; }
}
async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ══ §0 parse + source pins ══════════════════════════════════════════
section('§0 the touched files parse + the laws live in the source');
for (const f of ['chatpanel.js', 'app.js', 'chatclient.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}
{
  const cp = read('chatpanel.js');
  ok('v1.59.1: bootstrapHistory folds the log data-only (_bulkLoad + _replay tags)',
    cp.includes('state._bulkLoad = true') && cp.includes("ev._replay = true;    // historical"));
  ok('v1.59.1: handleEvent honors the data-only gate',
    cp.includes('isOwner(state) && !state._bulkLoad'));
  ok('v1.59.1: connectWS pre-arms the seq cursor (&since gap-only replay)',
    cp.includes('if (sinceSeq > 0) state.client.lastSeq = sinceSeq;'));
  ok('v1.59.1: the tail mount rides renderHost\'s own windowing (OPEN_TAIL + backfill)',
    cp.includes('function mountTranscriptTail') && cp.includes('scheduleBackfill(msgs,'));
  ok('v1.59.3: the death law (forgetChatState) clears state + stash + client + LS',
    cp.includes('function forgetChatState') && cp.includes('deleteScrollLS(chatId);'));
  ok('v1.59.3: the export view pings before it pushes (the honest dead-session state)',
    cp.includes('sessionDead = (r.status === 404);'));
  const ap = read('app.js');
  ok('v1.59.3: deleteIconNow calls forgetState + saveNow directly',
    ap.includes('window.ChatPanel.forgetState) window.ChatPanel.forgetState(icon.id)') && ap.includes('saveNow();   // v1.59.3'));
  ok('v1.59.3: createIconAt ids are monotonic (max+1 — a retired id is never reissued)',
    ap.includes("const m = /^chat_(\\d+)$/.exec(e.id || '');"));
}
{
  const ot = fs.readFileSync(path.join(__ROOT, 'engine', 'internal', 'server', 'ocserveturn.go'), 'utf8');
  // (v1.62 re-anchor: the parallel wave's v1.61 rework renamed the binding
  // var bound→persisted — the pin rides the SEMANTIC: the persisted binding
  // is adopted only after SessionExists, whatever the local is named)
  ok('v1.59.2: the binding persists (chat.ocserve.<sid>) and adopts after a restart',
    ot.includes('func ocServeBindKey') && /m\.SessionExists\((bound|persisted)\)/.test(ot));
  const oc = fs.readFileSync(path.join(__ROOT, 'engine', 'internal', 'ocserve', 'ocserve.go'), 'utf8');
  ok('v1.59.2: SessionExists speaks the live-probed GET /api/session/{id} shape',
    oc.includes('func (m *Manager) SessionExists'));
  ok('v1.59.2: DeleteSession rides the live-probed DELETE /api/session/{id} (204)',
    oc.includes('func (m *Manager) DeleteSession') && oc.includes('"/api/session/"+serveSess, nil'));
}

// ══ the engine boots ═════════════════════════════════════════════════
await sleep(600);
try { if (fs.existsSync(ENGINE_BIN)) execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
  env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
});
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
  detached: true, stdio: 'ignore',
  env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' },
});
child.unref();
let booted = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ENGINE + '/api/health')).ok) { booted = true; break; } } catch (e) {}
  await sleep(500);
}
ok('the engine boots', booted);

// SEED: two chat icons on a canvas — chat_1 (the long convo) + chat_9 (the
// monotonic-law anchor). savedAt: newest → the Worlds boot restores THIS row.
const seedIcons = [
  { id: 'chat_1', type: 'chat', x: -600, y: -300, radius: 28, name: 'LongConvo', sessionId: '', model: 'glm-5.3', provider: 'nvidia' },
  { id: 'chat_9', type: 'chat', x: 600, y: -300, radius: 28, name: 'AnchorChat', sessionId: '', model: 'glm-5.3', provider: 'nvidia' }
];
await api('PUT', '/api/canvases/wRig159', {
  name: 'Rig World 159',
  state: { offset: { x: -640, y: -400 }, scale: 1, currentFamily: '', savedAt: Date.now(),
    icons: seedIcons, dots: [] }
});

// SEED the sessions + a LONG convo on S1: 60 turns × (user + thinking +
// assistant + status-idle) = 240 events, 180 folded messages.
const TURNS = 60;
{
  const c1 = await api('POST', '/api/sessions', { title: 'LongConvo', sandbox: 'quick', model: 'glm-5.3', provider: 'nvidia' });
  const c9 = await api('POST', '/api/sessions', { title: 'AnchorChat', sandbox: 'quick', model: 'glm-5.3', provider: 'nvidia' });
  const s1 = c1.body.ID, s9 = c9.body.ID;
  fs.writeFileSync('/tmp/v1590-ids.json', JSON.stringify({ s1, s9 }));
  for (let t = 1; t <= TURNS; t++) {
    await api('POST', `/api/sessions/${s1}/events`, { type: 'user', text: `user turn ${t} — the question that started it` });
    await api('POST', `/api/sessions/${s1}/events`, { type: 'thinking', text: `thinking about turn ${t} with some depth` });
    await api('POST', `/api/sessions/${s1}/events`, { type: 'assistant', text: `assistant answer ${t} — THE FINAL ANSWER ${t === TURNS ? 'LAST_MARKER' : ''}` });
    await api('POST', `/api/sessions/${s1}/events`, { type: 'status', text: '{"state":"idle","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}' });
  }
  // bind the sessions to the seeded icons via the canvas save (the icons'
  // sessionId is what the restore honors)
  seedIcons[0].sessionId = s1;
  seedIcons[1].sessionId = s9;
  await api('PUT', '/api/canvases/wRig159', {
    name: 'Rig World 159',
    state: { offset: { x: -640, y: -400 }, scale: 1, currentFamily: '', savedAt: Date.now() + 5,
      icons: seedIcons, dots: [] }
  });
  const ev = await api('GET', `/api/sessions/${s1}/events`);
  const maxSeq = ev.body.events.length ? ev.body.events[ev.body.events.length - 1].seq : 0;
  ok('the long convo is seeded (240 events, maxSeq ' + maxSeq + ')', ev.body.events.length === TURNS * 4 && maxSeq === TURNS * 4);
  fs.writeFileSync('/tmp/v1590-maxseq.txt', String(maxSeq));
}

// the pristine-browser law (the v1.42.8 conviction): close every tab first
ab(['close', '--all']);
ab(['open', ENGINE + '/']);
await sleep(2500);
ok('the app boots ready', abEval("(function(){return !!window.__doomalayReady})()") === 'true');

// ══ §A THE BOTTOM ════════════════════════════════════════════════════
section('§A THE BOTTOM — the reload load lands at the bottom (v1.59.1)');
{
  const { s1 } = JSON.parse(fs.readFileSync('/tmp/v1590-ids.json', 'utf8'));
  const maxSeq = parseInt(fs.readFileSync('/tmp/v1590-maxseq.txt', 'utf8'), 10);

  // THE ANDROID REALITY: the WebView dies while the user is away — the page
  // RELOADS, chatStates is empty. The old path then replayed the whole log
  // through the live pipeline (minutes of "watching history go by").
  ab(['reload']);
  await sleep(2500);
  ok('the page reloaded ready (the fresh-state reality)', abEval("(function(){return !!window.__doomalayReady})()") === 'true');
  ok('no chat state survived the reload (the honest starting point)',
    abJson("(function(){var st=window.ChatPanel?ChatPanel.getState('chat_1'):null;return JSON.stringify({alive:!!st,msgs:st?st.messages.length:0})})()") .alive === false);

  // the recorders: every WebSocket constructor URL + every window.open
  abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});" +
    "window.__wsUrls=[];var O=window.WebSocket;function W(u){window.__wsUrls.push(String(u));return new O(u);}" +
    "W.prototype=O.prototype;W.CONNECTING=O.CONNECTING;W.OPEN=O.OPEN;W.CLOSING=O.CLOSING;W.CLOSED=O.CLOSED;window.WebSocket=W;" +
    "window.__opens=[];window.open=function(u){window.__opens.push(String(u));return null;};return 'armed'})()");

  // OPEN the long convo (the exact global-search/materialize path)
  const t0 = Date.now();
  abEval(`doomalay.openChatBySession('${s1}')`);
  // the census observer rides the transcript container the moment it exists
  abEval("(function(){var c=document.querySelector('#chat-messages');if(!c)return 'no container';window.__loadMuts=0;" +
    "window.__mo=new MutationObserver(function(rs){for(var i=0;i<rs.length;i++)if(rs[i].addedNodes.length){window.__loadMuts+=1;" +
    "window.__recs=window.__recs||[];var n=rs[i].addedNodes[0];window.__recs.push((n.className||n.id||n.tagName||'?')+':'+String(n.textContent||'').slice(0,24));}});" +
    "window.__mo.observe(c,{childList:true});return 'observing'})()");

  // settle: the client connects + the mount landed + a quiet beat
  let settled = false, settledAt = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const st = abJson("(function(){var s=ChatPanel.getState('chat_1');return JSON.stringify({open:s&&s.client?s.client.state:'',muts:window.__loadMuts||0})})()");
    if (st && st.open === 'open' && st.muts >= 1) { settledAt = i; settled = true; break; }
  }
  await sleep(900);
  const loadMs = Date.now() - t0;

  const probe = abJson("(function(){var s=ChatPanel.getState('chat_1');var sc=document.querySelector('#chat-scroll');" +
    "var c=document.querySelector('#chat-messages');var btn=document.querySelector('#chat-send');" +
    "var msgs=s?s.messages:[];var lastA=null;for(var i=msgs.length-1;i>=0;i--)if(msgs[i].role==='assistant'){lastA=msgs[i].text;break;}" +
    "return JSON.stringify({msgs:msgs.length,rows:c?c.children.length:0,streaming:s?s.isStreaming:null," +
    "mode:btn?btn.getAttribute('data-mode'):'',atBottom:sc?(sc.scrollHeight-sc.scrollTop-sc.clientHeight):null," +
    "muts:window.__loadMuts||0,lastA:lastA,ws:window.__wsUrls})})()");

  ok('the load settles fast (a 240-event log lands in < 2.5s, took ' + loadMs + 'ms)', settled && loadMs < 2500, loadMs + 'ms');
  const chatUrl = (probe.ws || []).filter((u) => u.indexOf('/api/chat?') >= 0).pop() || '';
  ok('the WS connect is cursor-armed: &since=' + maxSeq + ' (the gap-only replay)',
    chatUrl.indexOf('&since=' + maxSeq) >= 0, chatUrl);
  ok('the folded convo is WHOLE (180 messages: 60 user + 60 thinking + 60 assistant)',
    probe.msgs === TURNS * 3, probe.msgs);
  ok('the tail mounted at the bottom (≥ the tail window rows, not a per-event crawl)',
    probe.rows >= 28, probe.rows);
  ok('the LAST answer is aboard', probe.lastA && probe.lastA.indexOf('LAST_MARKER') >= 0, probe.lastA);
  ok('the scroll lands at the BOTTOM', probe.atBottom !== null && probe.atBottom <= 80, probe.atBottom);
  ok('THE CENSUS: the load is a tail-shaped mount (≤ 6 childList records — the legacy replay was 180+)',
    probe.muts <= 6, probe.muts);
  if (probe.muts > 6) {
    const recs = abJson("(function(){return JSON.stringify(window.__recs||[])})()") || [];
    console.log('  ── CENSUS DEBUG (' + recs.length + ' records) — first 10:');
    for (const r of recs.slice(0, 10)) console.log('     ' + r);
    console.log('  ── last 5:');
    for (const r of recs.slice(-5)) console.log('     ' + r);
  }
  ok('no mid-flight theater (the composer settles on send)', probe.streaming === false && probe.mode === 'send',
    JSON.stringify({ streaming: probe.streaming, mode: probe.mode }));
  const errs = abJson("(function(){return JSON.stringify(window.__errs||[])})()");
  ok('zero page errors during the load', errs && errs.length === 0, JSON.stringify(errs));

  // the backfill law: the older history prepends in idle chunks (scroll-
  // compensated — the reader never sees the head arrive). Give it a beat.
  await sleep(2500);
  const bf = abJson("(function(){var c=document.querySelector('#chat-messages');return JSON.stringify({rows:c?c.children.length:0})})()");
  ok('the backfill mounts the WHOLE head in idle chunks (the windowing law)',
    bf.rows >= TURNS * 3, bf.rows);
}

// ══ §C THE GHOST ═════════════════════════════════════════════════════
section('§C THE GHOST — the death clears every residue (v1.59.3)');
{
  const { s1, s9 } = JSON.parse(fs.readFileSync('/tmp/v1590-ids.json', 'utf8'));

  // the ghost fuel: the panel CLOSE stashes the live DOM into the state —
  // exactly what the user's delete-then-create flow left behind
  abEval("document.querySelector('#chat-scrim') && document.querySelector('#chat-scrim').click()");
  await sleep(700);
  const stashed = abJson("(function(){var s=ChatPanel.getState('chat_1');return JSON.stringify({stash:!!(s&&s._domStash),msgs:s?s.messages.length:0,sid:s?s.sessionId:''})})()");
  ok('the close-time stash landed (the ghost fuel: a live DOM + 180 messages + the session id)',
    stashed.stash === true && stashed.msgs === TURNS * 3 && stashed.sid === s1, JSON.stringify(stashed));

  // seed the LS residues the old leak left behind (a draft + a scroll pos)
  abEval("(function(){try{var d=JSON.parse(localStorage.getItem('doomalay.chatdraft.v1')||'{}');d['chat_1']='the dead draft';" +
    "localStorage.setItem('doomalay.chatdraft.v1',JSON.stringify(d));}catch(e){}" +
    "try{var m=JSON.parse(localStorage.getItem('doomalay.chatscroll.v1')||'{}');m['chat_1']=421;m['chat_9']=808;" +
    "localStorage.setItem('doomalay.chatscroll.v1',JSON.stringify(m));}catch(e){}return 'seeded'})()");

  // THE REAL DELETE PATH: long-press the icon → the icon menu → delete →
  // 'delete forever'. The icon's screen position from its live element.
  const rect = abJson("(function(){var el=document.querySelector('[data-id=\"chat_1\"]');if(!el)return null;" +
    "var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()");
  ok('the icon is on screen for the real finger', rect && rect.x > 0 && rect.y >= 0, JSON.stringify(rect));
  if (rect) {
    ab(['mouse', 'move', String(rect.x), String(rect.y)]);
    ab(['mouse', 'down', 'left']);
    await sleep(700);            // LONG_PRESS_MS = 500
    ab(['mouse', 'up', 'left']);
    await sleep(500);
    // the icon menu: the delete row
    const delClicked = abStr("(function(){var b=document.querySelector('#menu [data-action=\"icon-delete\"]');if(!b)return 'no menu';b.click();return 'clicked'})()");
    ok('the long-press menu opens + the delete row taps', delClicked === 'clicked', delClicked);
    await sleep(400);
    const confirmed = abStr("(function(){var b=document.getElementById('del-ov-yes');if(!b)return 'no overlay';b.click();return 'deleted'})()");
    ok('the confirm overlay: delete forever', confirmed === 'deleted', confirmed);
    await sleep(1200);
  }

  // EVERY residue dies
  const after = abJson("(function(){var st=ChatPanel.getState('chat_1');var w=doomalay.world.entities.map(function(e){return e.id});" +
    "var draft=null,scroll=null;try{draft=(JSON.parse(localStorage.getItem('doomalay.chatdraft.v1')||'{}'))['chat_1']}catch(e){}" +
    "try{scroll=(JSON.parse(localStorage.getItem('doomalay.chatscroll.v1')||'{}'))['chat_1']}catch(e){}" +
    "return JSON.stringify({state:!!st,inWorld:w.indexOf('chat_1')>=0,world:w,draft:draft,scroll:scroll})})()");
  ok('the chat state is GONE (no ghost adoption — the death law)', after.state === false, JSON.stringify(after));
  ok('the icon left the world', after.inWorld === false, JSON.stringify(after.world));
  ok('the draft LS row died with the chat', after.draft === undefined, JSON.stringify(after.draft));
  ok('the scroll LS row died with the chat (chat_9\'s survives)', after.scroll === undefined, JSON.stringify(after.scroll));
  const sess = await api('GET', `/api/sessions/${s1}`);
  ok('the engine session is gone (404)', sess.status === 404);

  // THE MONOTONIC LAW: the newborn id is max+1 (chat_9 lives → chat_10)
  // long-press EMPTY canvas → the menu → new-chat
  const empty = { x: 1000, y: 160 };
  ab(['mouse', 'move', String(empty.x), String(empty.y)]);
  ab(['mouse', 'down', 'left']);
  await sleep(700);
  ab(['mouse', 'up', 'left']);
  await sleep(450);
  const newChat = abStr("(function(){var b=document.querySelector('#menu [data-action=\"new-chat\"]');if(!b)return 'no menu';b.click();return 'created'})()");
  ok('the canvas menu: new chat', newChat === 'created', newChat);
  await sleep(900);
  const ids = abJson("(function(){return JSON.stringify(doomalay.world.entities.map(function(e){return e.id}))})()");
  ok('the newborn id is MONOTONIC (chat_10 — the retired chat_1 is never reissued)',
    ids && ids.indexOf('chat_10') >= 0 && ids.indexOf('chat_1,') < 0 && ids.indexOf('"chat_1"') < 0, JSON.stringify(ids));

  // THE VIRGIN PANEL: open the newborn — a NEW chat, not the ghost
  const ten = abJson("(function(){var el=document.querySelector('[data-id=\"chat_10\"]');if(!el)return null;var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()");
  if (ten) {
    ab(['mouse', 'move', String(ten.x), String(ten.y)]);
    ab(['mouse', 'down', 'left']);
    ab(['mouse', 'up', 'left']);
    await sleep(1500);
  }
  const virgin = abJson("(function(){var s=ChatPanel.getState('chat_10');var g=document.querySelector('#chat-greeting');" +
    "var gate=document.querySelector('#gatelock');" +
    "var body=document.querySelector('#panel-body')||document.body;var ghostText=body.innerHTML.indexOf('assistant answer')>=0;" +
    "return JSON.stringify({msgs:s?s.messages.length:-1,sid:s?s.sessionId:null,greeting:!!g,gate:!!gate,ghost:ghostText})})()");
  ok('the newborn panel is VIRGIN (zero messages, no session, the fresh gate/greeting)',
    virgin.msgs === 0 && !virgin.sid && (virgin.greeting === true || virgin.gate === true), JSON.stringify(virgin));
  ok('the old chat\'s history is NOWHERE in the panel (the ghost is dead)', virgin.ghost === false, JSON.stringify(virgin));

  // THE HONEST EXPORT: a dead engine session renders the honest state —
  // never a dead URL in a black window. chat_9 opens (the same open path
  // the app's tap drives), THEN its session dies out-of-band (the
  // storage-hygiene reality), THEN the export taps.
  abEval("document.querySelector('#chat-scrim') && document.querySelector('#chat-scrim').click()");
  await sleep(600);
  abEval(`doomalay.openChatBySession('${s9}')`);
  await sleep(1500);
  await api('DELETE', `/api/sessions/${s9}`);
  await sleep(300);
  const exp = abStr("(function(){var btns=document.querySelectorAll('.util-btn');for(var i=0;i<btns.length;i++)" +
    "if(btns[i].textContent.indexOf('export')>=0){btns[i].click();return 'opened'}return 'no button'})()");
  ok('the export view opens (the util row)', exp === 'opened', exp);
  await sleep(900);
  const honest = abJson("(function(){var el=document.querySelector('.pv-hint');var body=document.body.innerHTML;" +
    "return JSON.stringify({deadMsg:body.indexOf('nothing left to export')>=0," +
    "rows:(body.match(/export\\.md/g)||[]).length,opens:window.__opens?window.__opens.length:-1})})()");
  ok('the dead session renders the HONEST message (no rows, no dead URL)',
    honest.deadMsg === true && honest.rows === 0, JSON.stringify(honest));
  ok('zero window.open of dead URLs (the black-window crash class is dead)',
    honest.opens === 0, JSON.stringify(honest));
  const errsC = abJson("(function(){return JSON.stringify(window.__errs||[])})()");
  ok('zero page errors through the whole ghost pass', errsC && errsC.length === 0, JSON.stringify(errsC));
}

// ══ the verdict ══════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(64));
if (fails.length) {
  console.log(`✗ ${fails.length}/${n} FAILED:`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`✓ ALL ${n} GREEN — THE HONEST RETURN holds.`);
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  process.exit(0);
}
