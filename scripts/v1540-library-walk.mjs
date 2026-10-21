#!/usr/bin/env node
// v1540-library-walk.mjs — v1.54 THE LIBRARY SHIP live walk (a real
// engine + the real PWA + a PROTOCOL-HONEST fake HF + the real finger):
// publish a world to the library → browse → download → the world lands;
// publish a chat → download → the icon materializes; the trust ladder
// live-convicted.
//
//   W1  THE CANVAS PUBLISH (the real finger): the manager → ⋯ → publish
//       → the sheet → "publish to the library" → the form (name
//       prefilled · the blob chip · the auto-summary description) →
//       publish → the item detail
//   W2  THE FAKE-HF TRUTH: the repo doomalay-canvases exists with the
//       seeded .gitattributes (the 3 LFS lines), the payload rode the
//       LFS protocol (the /lfs bucket holds the exact bytes), the meta
//       carries type+size, the index regenerated
//   W3  THE BROWSE FLIP + THE DOWNLOAD: the manager's browse row
//       subtitle FLIPPED → the hub opens on the canvas type → the card
//       → the detail → download → the payload STREAMS → the world lands
//       (world-switched · provenance = the source name · the manager's
//       ◇ chip)
//   W4  THE CHAT DOOR: the Aster panel → export view → "Publish
//       .doomchat" → the sheet → publish → the chat library pill → the
//       card → download → the icon MATERIALIZES on the canvas + the
//       panel opens + the history rode
//   W5  THE TRUST LADDER LIVE: the reborn sessions carry personas
//       INACTIVE (the seed's 'always' dies at the border), preamble_sel
//       '', auto-tools OFF at birth
//   W6  zero page errors · the theme pin (zero literals in the new
//       modules) · B1 (no body appenders)
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1540-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1540-walk-'));
const ENGINE_PORT = 8441;
const FAKEHF_PORT = 8440;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const FAKEHF = 'http://127.0.0.1:' + FAKEHF_PORT;

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 320) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = (args, timeoutMs) => {
  try {
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 30000, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR: ' + String((e && e.stderr) || e.message || e).slice(0, 160);
  }
};
function abEval(js) { return ab(['eval', js], 30000); }
function abJson(js) {
  const v = abEval(js);
  if (v == null) return null;
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') {
      try { j = JSON.parse(j); } catch (e2) { /* single-encoded — keep it */ }
    }
    return j;
  } catch (e) {
    // a RAW string return (the encoding nondeterminism conviction):
    // '≈ 1.2 KB' parses as nothing — hand the raw text through.
    return typeof v === 'string' && v.length ? v : null;
  }
}
async function waitFn(js, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    // agent-browser's boolean returns arrive in MULTIPLE shapes (true ·
    // "true" · '"true"' — the double-encoding conviction, v1425/v1427):
    // be liberal in what we accept.
    const s = String(v).trim().replace(/^"+|"+$/g, '');
    if (s === 'true') return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(350);
  }
}
async function api(method, p, body, raw) {
  const init = { method };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw) init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}
async function fakeState() {
  try {
    const r = await fetch(FAKEHF + '/state');
    return await r.json();
  } catch (e) { return null; }
}

// the REAL finger: the long-press menu, every time
function longPress(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'down'})()");
}
async function openManagerByFinger() {
  longPress(500, 400);
  const opened = await waitFn("(function(){var m=document.getElementById('menu');return m&&!m.classList.contains('hidden')&&!!document.querySelector('#menu [data-action=new-canvas]')})()", 4000);

  if (!opened) return false;
  abEval("(function(){var b=document.querySelector('#menu [data-action=new-canvas]');if(b)b.click();return 'clicked'})()");
  return waitFn("!!document.getElementById('wm-root')", 8000);
}
function back() {
  abEval("(function(){window.ConnectOverlay.backOne();return 'back'})()");
}

async function boot() {
  // the v1.42.8 harness law: a pristine browser per run
  try { ab(['close', '--all']); } catch (e) {}
  await sleep(600);
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  try { execSync(`pkill -9 -f 'fakehf.mjs ${FAKEHF_PORT}' || true`); } catch (e) {}

  // the fake HF (the protocol twin) — LOGGED (a crash would otherwise
  // be silent: stdio:'ignore' swallowed the stack)
  const hfLog = fs.openSync('/tmp/v1540-fakehf.log', 'w');
  const hf = spawn('node', [path.join(__ROOT, 'scripts/fakehf.mjs'), String(FAKEHF_PORT)], {
    detached: true, stdio: ['ignore', hfLog, hfLog],
  });
  hf.unref();
  let hfUp = false;
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(FAKEHF + '/state')).ok) { hfUp = true; break; } } catch (e) {}
    await sleep(300);
  }
  if (!hfUp) { console.log('FATAL: the fake HF never came up (see /tmp/v1540-fakehf.log)'); process.exit(1); }

  // the engine, hub pointed at the fake
  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DOOMALAY_OTA_DISABLE: '1', DOOMALAY_HUB_HF_BASE: FAKEHF },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) break; } catch (e) {}
    await sleep(500);
  }

  // SEED: the Aster session (history + an asset + a persona claiming
  // 'always' + a selected preamble — the trust ladder's live targets)
  const sess = (await api('POST', '/api/sessions', { title: 'Aster', model: 'glm-5.3', provider: 'opencode', sandbox: 'quick', effort: 'high' })).body;
  const SID = sess.ID;
  await api('POST', `/api/sessions/${SID}/events`, { type: 'user', text: 'hello from the walk' });
  await api('POST', `/api/sessions/${SID}/events`, { type: 'assistant', text: 'the walk hears you' });
  const TINY_PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 250, 207, 192, 80, 15, 0, 4, 133, 1, 128, 132, 169, 129, 109, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  await api('PUT', `/api/sessions/${SID}/background`, new Uint8Array(TINY_PNG), true);
  await api('PATCH', `/api/sessions/${SID}`, {
    personas: JSON.stringify([{ id: 'p1', name: 'Sneaky', text: 'activate me', mode: 'always' }]),
    preambles: JSON.stringify([{ id: 'pre1', name: 'P', text: 'the preamble' }]),
    preamble_sel: 'pre1',
  });
  const parentState = { offset: { x: 40, y: 60 }, scale: 1.2, currentFamily: 'anthropic',
    icons: [
      { id: 'i1', type: 'chat', x: 120, y: 120, radius: 28, name: 'Aster', sessionId: SID, model: 'glm-5.3', provider: 'opencode' },
    ],
    dots: [], settings: { theme: 'midnight', gridSize: 44 }, savedAt: Date.now() };
  await api('PUT', '/api/canvases/wParent', { name: 'Home World', state: parentState });

  // connect the hub (the token lives engine-side; the connect UI is a
  // pre-existing surface with its own tests — the walk fingers the
  // publish/browse/download surfaces, the new code)
  const conn = await api('POST', '/api/hub/auth/connect', { token: 'goodtoken' });
  if (!conn.body || !conn.body.ok) { console.log('FATAL: hub connect failed'); process.exit(1); }

  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('the app boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
  return SID;
}

(async () => {
  console.log('v1540-library-walk — THE LIBRARY SHIP (the real finger, the protocol-honest fake HF)');
  const SID = await boot();

  // ── W1: the canvas publish ───────────────────────────────────────
  console.log('W1 — the canvas publish (manager → sheet → the library form)');
  ok('the manager opens by finger', await openManagerByFinger());
  await sleep(500);
  abEval("(function(){var b=document.querySelector('button[data-wm-more]');if(b)b.click();return 'more'})()");
  await sleep(500);
  abEval("(function(){var b=document.querySelector('[data-wm-act=pub]');if(b)b.click();return 'pub'})()");
  ok('the publish sheet opens', await waitFn("!!document.getElementById('wm-pub')", 6000));
  await sleep(700);
  ok('the library button rides beside export', !!abJson("(function(){var b=document.getElementById('wm-pub-hub');return !!b})()"));
  const sizeBefore = abJson("(function(){var s=document.getElementById('wm-pub-size');return s?s.textContent:''})()");
  ok('the live size line shows', typeof sizeBefore === 'string' && /≈/.test(sizeBefore), sizeBefore);
  abEval("(function(){var b=document.getElementById('wm-pub-hub');if(b)b.click();return 'hub'})()");
  ok('the publish form opens (the blob prefill)', await waitFn("!!document.getElementById('hp-blobchip')", 10000));
  const nameVal = abJson("(function(){var i=document.getElementById('hp-name');return i?i.value:''})()");
  ok('the name prefills from the world', nameVal === 'Home World', nameVal);
  const descVal = abJson("(function(){var d=document.getElementById('hp-desc');return d?d.value:''})()");
  ok('the auto-summary description prefills', /whole world/.test(descVal) && /icons/.test(descVal), descVal);
  const chip = abJson("(function(){var c=document.getElementById('hp-blobchip');return c?c.textContent:''})()");
  ok('the blob chip carries the built bundle', /Home World/.test(chip) && /(KB|MB|B)/.test(chip), chip);
  abEval("(function(){var b=document.getElementById('hp-publish');if(b)b.click();return 'publish'})()");
  const landed = await waitFn("(function(){return !!document.getElementById('hi-dl') || !!document.querySelector('.hi-bundlecard')})()", 20000);
  if (!landed) {
    console.log('    [dbg] hp-err: ' + abJson("(function(){var e=document.getElementById('hp-err');return e?e.textContent:'(none)'})()"));
    console.log('    [dbg] btn: ' + abJson("(function(){var b=document.getElementById('hp-publish');return b?b.textContent+' disabled='+b.disabled:'(gone)'})()"));
    console.log('    [dbg] fakehf repos: ' + JSON.stringify(Object.keys((await fakeState() || {}).repos || {})));
    const fs2 = await fakeState();
    console.log('    [dbg] commits: ' + JSON.stringify((fs2 && fs2.commits || []).map((c) => c.repo + ' :: ' + c.body.slice(0, 90))));
  }
  ok('the publish lands (the item detail opens)', landed);

  // ── W2: the fake-HF truth ────────────────────────────────────────
  console.log('W2 — the fake-HF truth (LFS + the seed + the meta)');
  await sleep(800);
  const st = await fakeState();
  const repo = st && st.repos && st.repos['mockuser/doomalay-canvases'];
  ok('the repo doomalay-canvases exists', !!repo);
  if (repo) {
    const seedCommit = (st.commits || []).find((c) => /seed LFS attributes/.test(c.body));
    ok('the .gitattributes seed committed', !!seedCommit, JSON.stringify((st.commits || []).map((c) => c.body.slice(0, 80))));
    // the file content rides base64 inside the NDJSON — decode it
    let attrsText = '';
    if (seedCommit) {
      for (const line of seedCommit.body.split('\n')) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line);
          if (op.key === 'file' && op.value.path === '.gitattributes') {
            attrsText = Buffer.from(op.value.content || '', 'base64').toString('utf8');
          }
        } catch (e) {}
      }
    }
    ok('the seed carries the 3 LFS lines', /\.doomcanvas filter=lfs/.test(attrsText) && /\.doomchat filter=lfs/.test(attrsText) && /\.doomtheme filter=lfs/.test(attrsText), attrsText.slice(0, 200));
    const payloadFile = repo.files.find((f) => f.path.endsWith('.doomcanvas'));
    ok('the .doomcanvas payload committed', !!payloadFile, JSON.stringify(repo.files.map((f) => f.path)));
    const metaFile = repo.files.find((f) => /\.json$/.test(f.path) && f.path.indexOf('items/') === 0 && f.path.indexOf('index') < 0);
    ok('the item meta committed', !!metaFile);
    ok('the index regenerated', !!repo.files.find((f) => f.path === 'items/index.json'));
    // the LFS causality: the payload commit referenced lfsFile (not file)
    const pubCommit = (st.commits || []).filter((c) => /publish Home World/.test(c.body)).pop();
    ok('the publish commit rode the NDJSON shape', !!pubCommit);
    ok('the payload rode the LFS protocol (lfsFile ref)', pubCommit && /"key":"lfsFile"/.test(pubCommit.body), pubCommit && pubCommit.body.slice(0, 200));
  }

  // ── W3: the browse flip + the download ───────────────────────────
  console.log('W3 — the browse flip + the canvas download');
  // back out of the detail → the sheet → the manager root (the form
  // already popped itself on publish success; the stack is [root, sheet,
  // detail] — TWO backs land on the root)
  back(); await sleep(450); back(); await sleep(450); back(); await sleep(700);
  ok('back at the manager', await waitFn("!!document.getElementById('wm-root')", 6000));
  await sleep(900); // the library check repaints the subtitle
  const sub = abJson("(function(){var s=document.getElementById('wm-browse-sub');return s?s.textContent:''})()");
  ok('the browse row subtitle FLIPPED (the canvas type is live)', /shared worlds/.test(sub), sub);
  abEval("(function(){var b=document.getElementById('wm-browse');if(b)b.click();return 'browse'})()");
  ok('the hub opens on the canvas type', await waitFn("(function(){var s=document.querySelector('.hub-libpill[data-on], .hub-libpill[data-lib=canvas]');return !!s})()", 10000));
  await sleep(1200);
  const bunchName = abJson("(function(){var c=document.querySelector('.hub-card');return c?c.textContent:''})()");
  ok('the published world is listed (its self-bunch card)', /home-world-/.test(bunchName) && /1 world/.test(bunchName), bunchName);
  abEval("(function(){var c=document.querySelector('.hub-card');if(c)c.click();return 'bunch'})()");
  await sleep(1400);
  const memberName = abJson("(function(){var c=document.querySelector('.hub-card');return c?c.textContent:''})()");
  ok('the member card shows the world name', /Home World/.test(memberName), memberName);
  abEval("(function(){var c=document.querySelector('.hub-card');if(c)c.click();return 'member'})()");
  ok('the item detail opens (the bundle card, no zip dump)', await waitFn("!!document.querySelector('.hi-bundlecard')", 8000));
  const bundleCard = abJson("(function(){var c=document.querySelector('.hi-bundlecard');return c?c.textContent:''})()");
  ok('the bundle card describes the world (not the payload)', /whole world/.test(bundleCard), bundleCard);
  abEval("(function(){var b=document.getElementById('hi-dl');if(b)b.click();return 'dl'})()");
  ok('the download streams + the world LANDS', await waitFn("(window.__sw||[]).length > 0", 30000));
  const prov = abJson("(function(){return (window.doomalay&&window.doomalay.worldsProbe)?window.doomalay.worldsProbe().provenance:null})()");
  ok('the provenance = the source name', prov === 'Home World', prov);
  // the manager row chip
  await sleep(800);
  abEval("(function(){window.WorldsManager.refresh&&window.WorldsManager.refresh();return 'r'})()");
  const chipTxt = abJson("(function(){var rows=document.querySelectorAll('[data-wm-id]');for(var i=0;i<rows.length;i++){if(/Home World/.test(rows[i].textContent)&&/◇/.test(rows[i].textContent))return rows[i].textContent}return ''})()");
  ok('the manager row carries the ◇ provenance chip', /◇ Home World/.test(chipTxt), chipTxt);
  // the trust ladder: the reborn Aster session (personas inactive etc.)
  const reborn = abJson("(function(){var m=window.doomalay.worldsProbe();return JSON.stringify(m)})()");
  const rowsApi = (await api('GET', '/api/sessions')).body;
  const sessions = (rowsApi && rowsApi.sessions) || rowsApi || [];
  let rebornSess = null;
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    if (s.Title === 'Aster' && s.ID !== SID) rebornSess = s;
  }
  ok('the Aster chat was reborn in the world', !!rebornSess, JSON.stringify(sessions).slice(0, 200));
  if (rebornSess) {
    const full = (await api('GET', `/api/sessions/${rebornSess.ID}`)).body || {};
    const personas = JSON.parse(full.Personas || '[]');
    ok('THE TRUST LADDER LIVE: the bundle persona \'always\' → INACTIVE', personas.length === 1 && personas[0].mode === 'inactive', full.Personas);
    ok('THE UNSELECTED LAW LIVE: preamble_sel \'\'', (full.PreambleSel || '') === '', full.PreambleSel);
    ok('R7 LIVE: web_search OFF at birth', full.WebSearch === false, String(full.WebSearch));
    const evs = (await api('GET', `/api/sessions/${rebornSess.ID}/export.json`)).body;
    ok('the history rode into the reborn chat', (evs.events || []).some((e) => /walk hears you/.test(e.content || e.Text || '')), JSON.stringify((evs.events || []).length));
  }

  // ── W4: the chat door ────────────────────────────────────────────
  console.log('W4 — the chat door (export view → .doomchat → the library → the icon lands)');
  // close the hub back to the canvas; open the ORIGINAL Aster's panel
  for (let i = 0; i < 6; i++) { back(); await sleep(250); }
  await sleep(600);
  abEval("(function(){var els=document.querySelectorAll('#chatbots [data-type=chat]');if(!els.length)return 'none';var r=els[0].getBoundingClientRect();var c=document.getElementById('c');c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}));setTimeout(function(){c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}))},60);return 'tapped'})()");
  const panelUp0 = await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return !!(c&&c.panel&&c.panel.isOpen&&c.panel.isOpen())})()", 8000);
  ok('a chat panel opens (the icon tap)', panelUp0);
  await sleep(900);
  abEval("(function(){var b=document.querySelector('.util-btn');if(b&&/export/.test(b.textContent)){b.click();return 'exp'}return 'no-btn'})()");
  const expOpened = await waitFn("!!document.querySelector('[data-x=publish]')", 8000);
  if (!expOpened) {
    console.log('    [dbg] util-btns: ' + abJson("(function(){var bs=document.querySelectorAll('.util-btn');var o=[];for(var i=0;i<bs.length;i++)o.push(bs[i].textContent);return JSON.stringify(o)})()"));
    console.log('    [dbg] panel: ' + abJson("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return c? ('sid='+(c.state&&c.state.sessionId)+' open='+(c.panel&&c.panel.isOpen&&c.panel.isOpen())) : 'none'})()"));
  }
  ok('the export view opens', expOpened);
  const pubRow = abJson("(function(){var r=document.querySelector('[data-x=publish]');return r?r.textContent:''})()");
  ok('the Publish .doomchat row rides the export view', /Publish .doomchat/.test(pubRow), pubRow);
  abEval("(function(){var r=document.querySelector('[data-x=publish]');if(r)r.click();return 'pub'})()");
  ok('the chat publish sheet opens', await waitFn("!!document.getElementById('cb-pub-hub')", 10000));
  await sleep(900);
  const cbSize = abJson("(function(){var s=document.getElementById('cb-pub-size');return s?s.textContent:''})()");
  ok('the sheet\'s live size shows', /≈/.test(cbSize), cbSize);
  abEval("(function(){var b=document.getElementById('cb-pub-hub');if(b)b.click();return 'hub'})()");
  ok('the chat publish form opens (the blob chip)', await waitFn("!!document.getElementById('hp-blobchip')", 10000));
  const chatName = abJson("(function(){var i=document.getElementById('hp-name');return i?i.value:''})()");
  ok('the name prefills from the chat', /Aster/.test(chatName), chatName);
  abEval("(function(){var b=document.getElementById('hp-publish');if(b)b.click();return 'publish'})()");
  ok('the chat publish lands (the detail opens)', await waitFn("(function(){return !!document.querySelector('.hi-bundlecard') || !!document.getElementById('hi-dl')})()", 20000));
  await sleep(800);
  const st2 = await fakeState();
  const chatRepo = st2 && st2.repos && st2.repos['mockuser/doomalay-chats'];
  ok('the repo doomalay-chats exists', !!chatRepo);
  if (chatRepo) {
    ok('the .doomchat payload committed', !!chatRepo.files.find((f) => f.path.endsWith('.doomchat')), JSON.stringify(chatRepo.files.map((f) => f.path)));
  }
  // the chat library pill → the card → download → the icon materializes
  back(); await sleep(500); back(); await sleep(500); back(); await sleep(600);
  abEval("(function(){window.doomalay.openLibrary('chat');return 'lib'})()");
  ok('the chat library opens', await waitFn("!!document.querySelector('.hub-libpill[data-lib=chat]')", 10000));
  await sleep(1200);
  const chatBunch = abJson("(function(){var c=document.querySelector('.hub-card');return c?c.textContent:''})()");
  ok('the published chat is listed (its self-bunch card)', /aster-/.test(chatBunch) && /1 chat/.test(chatBunch), chatBunch);
  abEval("(function(){var c=document.querySelector('.hub-card');if(c)c.click();return 'bunch'})()");
  await sleep(1400);
  abEval("(function(){var c=document.querySelector('.hub-card');if(c)c.click();return 'member'})()");
  ok('the chat detail opens', await waitFn("!!document.querySelector('.hi-bundlecard')", 8000));
  const iconCountBefore = abJson("(function(){return document.querySelectorAll('#chatbots [data-type=chat]').length})()");
  abEval("(function(){var b=document.getElementById('hi-dl');if(b)b.click();return 'dl'})()");
  ok('the download lands a chat icon on the canvas', await waitFn("(function(){return document.querySelectorAll('#chatbots [data-type=chat]').length > " + (typeof iconCountBefore === 'number' ? iconCountBefore : 0) + "})()", 30000));
  await sleep(1000);
  const panelUp = abJson("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return !!(c&&c.panel&&c.panel.isOpen&&c.panel.isOpen())})()");
  ok('the panel opened for the materialized chat', !!panelUp);

  // ── W5+W6: the trust ladder on the CHAT path + hygiene ───────────
  console.log('W5/W6 — the trust ladder (chat path) + hygiene');
  const sessions2 = ((await api('GET', '/api/sessions')).body || {});
  const list2 = sessions2.sessions || sessions2 || [];
  let chatReborn = null;
  for (const s of (Array.isArray(list2) ? list2 : [])) {
    if (s.Title === 'Aster' && s.ID !== SID && (!rebornSess || s.ID !== rebornSess.ID)) chatReborn = s;
  }
  ok('the .doomchat download reborn ANOTHER Aster session', !!chatReborn, JSON.stringify(list2).slice(0, 160));
  if (chatReborn) {
    const cfull = (await api('GET', `/api/sessions/${chatReborn.ID}`)).body || {};
    const personas = JSON.parse(cfull.Personas || '[]');
    ok('the chat-path persona also lands INACTIVE', personas.length === 1 && personas[0].mode === 'inactive', cfull.Personas);
    ok('the chat-path preamble_sel \'\'', (cfull.PreambleSel || '') === '', cfull.PreambleSel);
    const evs = (await api('GET', `/api/sessions/${chatReborn.ID}/export.json`)).body;
    ok('the .doomchat history rode', (evs.events || []).some((e) => /walk hears you/.test(e.content || e.Text || '')));
  }
  const errs = abJson("(window.__errs||[])") || [];
  ok('zero page errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
  // the theme pin: the NEW modules carry zero hardcoded colors
  const newMods = ['chatbundle.js'];
  let literals = [];
  for (const f of newMods) {
    const src = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web', f), 'utf8');
    const hits = src.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g) || [];
    literals = literals.concat(hits.map((h) => f + ': ' + h));
  }
  ok('the theme pin (zero color literals in the new module)', literals.length === 0, JSON.stringify(literals.slice(0, 6)));
  // B1: no body appenders in the new module
  const b1src = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web', 'chatbundle.js'), 'utf8');
  ok('B1 (no body appenders in chatbundle.js)', !/document\.body\.append/.test(b1src));

  console.log('');
  console.log(`v1540-library-walk: ${n - fails.length}/${n}` + (fails.length ? '  FAILED: ' + fails.join(' · ') : '  ALL GREEN'));
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  try { execSync(`pkill -9 -f 'fakehf.mjs ${FAKEHF_PORT}' || true`); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('WALK CRASHED: ' + (e && e.stack || e));
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e2) {}
  try { execSync(`pkill -9 -f 'fakehf.mjs ${FAKEHF_PORT}' || true`); } catch (e2) {}
  process.exit(1);
});
