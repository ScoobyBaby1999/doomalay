#!/usr/bin/env node
// v1280-lexicon-walk.mjs — PLAN-V126 THE LEXICON redteam: the REAL-USER
// walk (v1.27.1-.3), driven through agent-browser exactly as a human.
//
//   S2  the chat opens
//   S3  chat data: the Placeholders row enumerates the REAL vocabulary
//       and sits ABOVE the Preamble row (the user's ordering ask)
//   S4  the lexicon screen: every section renders; a block row unfolds
//       its LIVE engine expansion ({controls}); {artifacts} reports the
//       collapse
//   S5  the create system: 🌐 {brand} adds; {session} is REFUSED with
//       the honest reason (the hard refuse); 📍 {mood} adds
//   S6  the trigger tie: the builder lists {date}; the { } pill hands
//       over to the placeholders screen and back
//   S7  the import bridge: unknown {keys} surface as one-tap suggestion
//       rows; a tap prefills the add flow (🌐 armed); the create retires
//       the row
//   S8  the receipts: 390px no-overflow + screenshots
//
// ONE long-lived process (the sandbox reaps daemons between commands).

'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');

const ENGINE_BIN = '/tmp/doomalay-v1280-lexicon-engine';
const DATA_DIR = '/tmp/v1280-lexicon-walk-data';
const ENGINE_LOG = '/tmp/v1280-lexicon-walk-engine.log';
const SHOTS = '/tmp/v1280-shots';
const ENGINE_PORT = 8691;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const GO_BIN = process.env.GO_BIN || '/home/z/my-project/tools/go/bin/go';
const SID = 'v1280-lexicon-walk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let okCount = 0, failCount = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { okCount++; console.log('  ok - ' + name); }
  else { failCount++; fails.push(name); console.log('  FAIL - ' + name + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
}

async function jfetch(u, method, body) {
  const r = await fetch(u, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
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
// agent-browser eval prints the JSON-encoded result — decode it so the
// assertions compare real values (quotes were eating exact matches).
function abEval(js) {
  const raw = ab('eval ' + JSON.stringify(js), 20000);
  try { return JSON.parse(raw); } catch (e) { return raw; }
}
async function waitFn(expr, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 10000)) {
    try { if (abEval('!!(' + expr + ')') === true) return true; } catch (e) {}
    await sleep(400);
  }
  return false;
}

function bootEngine() {
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN,
    '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR],
    { env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' }, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine() {
  for (let i = 0; i < 80; i++) {
    try { const r = await jfetch(ENGINE + '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await sleep(250);
  }
  return false;
}

try { execSync("pkill -f '" + ENGINE_BIN + "' || true", { stdio: 'ignore' }); } catch (e) {}
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
execFileSync(GO_BIN, ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
fs.mkdirSync(DATA_DIR, { recursive: true });
bootEngine();
if (!(await waitEngine())) { console.log('FATAL — the engine never came up'); process.exit(1); }
await jfetch(ENGINE + '/api/sessions', 'POST', { id: SID, title: 'lexicon walk', model: 'groq/stub-model', provider: 'groq' });
ok('S1: the world boots (engine healthy, the chat exists)', true);
ab('close');

// S2 — the chat opens
console.log('S2 — the chat opens:');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
const openRes = abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
const composerReady = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
ok('S2: the chat opens with the composer ready', composerReady && openRes === 'opened', openRes);
await sleep(600);

// S3 — the chat-data rows (placeholders ABOVE preamble, the enumeration)
console.log('S3 — the chat-data rows:');
abEval("(function(){var p=document.querySelector('#pill-persona');if(p){p.click();return 'tapped'}return 'no pill'})()");
const listUp = await waitFn("Array.prototype.some.call(document.querySelectorAll('.pv-row-title'),function(n){return n.textContent.indexOf('Placeholders')>=0})", 12000);
ok('S3: the persona list opens (the Placeholders row renders)', listUp);
const rowData = abEval("(function(){var rows=Array.prototype.slice.call(document.querySelectorAll('.pv-row'));var ph=null,pre=null;rows.forEach(function(r){var t=r.querySelector('.pv-row-title');if(!t)return;if(t.textContent.trim()==='Placeholders')ph=r;if(t.textContent.trim()==='Preamble')pre=r;});if(!ph)return 'no-ph';var sub=ph.querySelector('.pv-row-sub');var cmp=ph.compareDocumentPosition(pre);var order=(cmp&Node.DOCUMENT_POSITION_FOLLOWING)?'ph-first':'ph-not-first';return order+' | '+(sub?sub.textContent:'no sub')})()");
ok('S3: the Placeholders row sits ABOVE the Preamble row', /^ph-first/.test(String(rowData)), rowData);
ok('S3: the row enumerates the REAL vocabulary (12 built-ins — 5 blocks · 5 facts · 2 metrics)',
  /12 built-ins — 5 blocks · 5 facts · 2 metrics/.test(String(rowData)), rowData);
ab('screenshot ' + SHOTS + '/s3-chat-data.png');

// S4 — the lexicon screen + the live block previews
console.log('S4 — the lexicon screen:');
const tapPh = abEval("(function(){var rows=Array.prototype.slice.call(document.querySelectorAll('.pv-row'));var ph=rows.find(function(r){var t=r.querySelector('.pv-row-title');return t&&t.textContent.trim()==='Placeholders';});if(ph){ph.click();return 'tapped'}return 'no row'})()");
await waitFn("Array.prototype.some.call(document.querySelectorAll('.pv-section-label'),function(n){return n.textContent.indexOf('live blocks')>=0})", 8000);
const sections = abEval("(function(){return Array.prototype.map.call(document.querySelectorAll('.pv-section-label'),function(n){return n.textContent.trim()}).join(' || ')})()");
ok('S4: the tap lands on the lexicon view', tapPh === 'tapped', tapPh);
ok('S4: the sections render (live blocks / live facts / trigger metrics / global / this chat / add)',
  /live blocks/.test(String(sections)) && /live facts/.test(String(sections)) && /trigger metrics/.test(String(sections)) && /global/.test(String(sections)) && /this chat/.test(String(sections)) && /add/.test(String(sections)), sections);
const blockRows = abEval("(function(){return Array.prototype.map.call(document.querySelectorAll('[data-block-row]'),function(b){return b.getAttribute('data-block-row')}).join(',')})()");
ok('S4: the five MIRROR block rows render (repo_access,artifacts,library,controls,session)',
  blockRows === 'repo_access,artifacts,library,controls,session', blockRows);
abEval("(function(){var b=document.querySelector('[data-block-row=\"artifacts\"]');if(b)b.click();return 'ok'})()");
await sleep(600);
const artPrev = abEval("(function(){var n=document.querySelector('[data-block-prev=\"artifacts\"]');return n&&n.style.display!=='none'?n.textContent.slice(0,140):'closed'})()");
ok('S4: {artifacts} unfolds the COLLAPSE copy (the default persona teaches the protocol)',
  /collapsed — your persona already teaches/.test(String(artPrev)), artPrev);
abEval("(function(){var b=document.querySelector('[data-block-row=\"controls\"]');if(b)b.click();return 'ok'})()");
await sleep(900);
const ctlPrev = abEval("(function(){var n=document.querySelector('[data-block-prev=\"controls\"]');return n&&n.style.display!=='none'?n.textContent.slice(0,160):'closed'})()");
ok('S4: {controls} unfolds its LIVE expansion (the engine rendered the real controls ledger)',
  /controls/.test(String(ctlPrev)) && String(ctlPrev).length > 40 && ctlPrev !== 'preview unavailable', ctlPrev);
ab('screenshot ' + SHOTS + '/s4-block-preview.png');

// S5 — the create system: 🌐 adds, {session} refuses, 📍 adds
console.log('S5 — the create system (the hard refuse at the UI door):');
const addKey = (k, v, scope) => abEval("(function(){var i=document.querySelector('#ph-key');var v2=document.querySelector('#ph-val');if(!i||!v2)return 'no inputs';i.value='" + k + "';v2.value='" + v + "';var b=document.querySelector('#ph-scope button[data-scope=\"" + scope + "\"]');if(b)b.click();var a=document.querySelector('#ph-add');if(!a)return 'no add';a.click();var t=document.querySelector('#doom-toast');return 'clicked|'+(t?t.textContent:'no toast')})()");
const r1 = await addKey('brand', 'Acme', 'global');
await sleep(1100);
ok('S5: 🌐 {brand} adds (the custom row lands with the scope pill)',
  abEval("(function(){return !!document.querySelector('[data-del-key=\"brand\"]')})()") === true, r1);
const r2 = await addKey('session', 'shadow!', 'global');
await sleep(900);
ok('S5: {session} is REFUSED with the honest reason (a live preamble block — never a silent shadow)',
  /live preamble block/.test(String(r2)), r2);
ok('S5: the refused {session} never lands as a custom row (the live-block row doesn\u2019t count)',
  abEval("(function(){return !document.querySelector('[data-del-key=\"session\"]')})()") === true);
const r3 = await addKey('mood', 'playful', 'local');
await sleep(1100);
ok('S5: 📍 {mood} adds (the local door works)',
  abEval("(function(){return !!document.querySelector('[data-del-key=\"mood\"]')})()") === true, r3);
ab('screenshot ' + SHOTS + '/s5-create.png');

// S6 — the trigger tie (pop the lexicon view → the list → Default → editor → trigger)
console.log('S6 — the trigger tie ({date} + the { } pill):');
abEval('(window.Persona && window.Persona.backClose) ? window.Persona.backClose() : 0');
await sleep(700);
const tapDefault = abEval("(function(){var rows=Array.prototype.slice.call(document.querySelectorAll('.pv-row'));var d=rows.find(function(r){var t=r.querySelector('.pv-row-title');return t&&/Default|Persona \\d/.test(t.textContent.trim())});if(d){d.click();return 'editor'}return 'no persona row'})()");
await waitFn("!!document.querySelector('[data-set-mode=\"trigger\"]')", 8000);
const trigTap = abEval("(function(){var b=document.querySelector('[data-set-mode=\"trigger\"]');if(b){b.click();return 'tapped'}return 'no pill'})()");
await waitFn("!!document.querySelector('#tr-key')", 8000);
const dateOpt = abEval("(function(){var s=document.querySelector('#tr-key');if(!s)return 'no select';return Array.prototype.some.call(s.querySelectorAll('option'),function(o){return o.value==='date'})?'date-listed':'no-date'})()");
ok('S6: the trigger builder opens from the editor', trigTap === 'tapped' && tapDefault === 'editor', tapDefault + ' | ' + trigTap);
ok('S6: {date} is a trigger key now (the "activate on Monday" tie)', dateOpt === 'date-listed', dateOpt);
const vocabPill = abEval("(function(){var b=document.querySelector('#tr-vocab');if(!b)return 'no pill';b.click();return 'tapped'})()");
await waitFn("!!document.querySelector('#ph-add')", 8000);
const backToBuilder = abEval('(window.Persona && window.Persona.backClose) ? (window.Persona.backClose(), "popped") : "no api"');
await sleep(600);
ok('S6: the { } pill hands over to the placeholders screen AND back (the builder survives the push)',
  vocabPill === 'tapped' && backToBuilder === 'popped' && abEval("(function(){return !!document.querySelector('#tr-key')})()") === true, vocabPill + ' | ' + backToBuilder);

// S7 — the import bridge (pop to the list, tap Placeholders fresh)
console.log('S7 — THE IMPORT BRIDGE (unknown keys → suggestion rows):');
abEval('(window.Persona && window.Persona.backClose) ? window.Persona.backClose() : 0'); // the trigger builder → the editor
abEval('(window.Persona && window.Persona.backClose) ? window.Persona.backClose() : 0'); // the editor → the list
await sleep(700);
const needs = abEval("(window.Persona && window.Persona.preambleKeyNeeds) ? JSON.stringify(window.Persona.preambleKeyNeeds('Say hi to {brand2} — {session} stays live, {repo} is template-internal.')) : 'no api'");
ok('S7: preambleKeyNeeds returns ONLY the unknown custom ({brand2}; {session} + {repo} + the vocab stay)',
  needs === '["brand2"]', needs);
abEval("(window.Persona && window.Persona.suggestPlaceholderKeys) ? window.Persona.suggestPlaceholderKeys(['brand2']) : 0");
await sleep(500);
const tapPh2 = abEval("(function(){var rows=Array.prototype.slice.call(document.querySelectorAll('.pv-row'));var ph=rows.find(function(r){var t=r.querySelector('.pv-row-title');return t&&t.textContent.trim()==='Placeholders';});if(ph){ph.click();return 'tapped'}return 'no row'})()");
await waitFn("!!document.querySelector('#ph-add')", 8000);
const suggRow = abEval("(function(){var b=document.querySelector('[data-ph-suggest=\"brand2\"]');return b?'suggestion-row':'none'})()");
ok('S7: the suggestion row renders ("the imported preamble needs")', suggRow === 'suggestion-row', suggRow + ' | tap=' + tapPh2);
const prefill = abEval("(function(){var b=document.querySelector('[data-ph-suggest=\"brand2\"]');if(!b)return 'no row';b.click();var i=document.querySelector('#ph-key');var g=document.querySelector('#ph-scope button[data-scope=\"global\"]');return 'key='+(i?i.value:'?')+'|global='+(g&&g.getAttribute('data-on')==='1')})()");
ok('S7: the tap prefills the add flow (key=brand2, 🌐 armed)', prefill === 'key=brand2|global=true', prefill);
const rAdd = abEval("(function(){var v=document.querySelector('#ph-val');if(v)v.value='the brand';var a=document.querySelector('#ph-add');if(a){a.click();return 'added'}return 'no add'})()");
await sleep(1100);
ok('S7: the suggested key creates (the custom lands, the suggestion retired)',
  abEval("(function(){return !!document.querySelector('[data-del-key=\"brand2\"]')})()") === true && abEval("(function(){return !document.querySelector('[data-ph-suggest=\"brand2\"]')})()") === true, rAdd);
ab('screenshot ' + SHOTS + '/s7-import-bridge.png');

// S8 — the receipts: 390px
console.log('S8 — the receipts (390px):');
ab('set viewport 390 844');
await sleep(900);
const overflow = abEval("(function(){var d=document.documentElement;return d.scrollWidth>390?('overflow:'+d.scrollWidth):'clean'})()");
ok('S8: 390px holds (no horizontal overflow)', overflow === 'clean', overflow);
const panelOverflow = abEval("(function(){var p=document.querySelector('.panel-body');return p&&p.scrollWidth>p.clientWidth+2?('panel-overflow:'+p.scrollWidth):'clean'})()");
ok('S8: the panel body holds at 390px', panelOverflow === 'clean', panelOverflow);
ab('screenshot ' + SHOTS + '/s8-390px.png');

console.log('');
console.log('=== ' + okCount + ' ok · ' + failCount + ' fail ===');
try { execSync("pkill -f '" + ENGINE_BIN + "' || true", { stdio: 'ignore' }); } catch (e) {}
process.exit(failCount ? 1 : 0);
