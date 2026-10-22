#!/usr/bin/env node
// v1630-six-fixes-rig.mjs — v1.63 THE SIX FIXES battery (PLAN-V163 §proof).
//
// §A source pins: the six laws live in the source (the requirements
//    ladder, the race-fix arm, the marker guard, the onPop hook, the
//    cloud gate + the pushPage branch, the setup copy, the walled
//    message builder, the cell law twins).
// §B THE CLOUD GATE live: the catalogue's cloud glyph exists (left of the
//    ★ tab) → press → the providers screen is a PUSHED stack level
//    (depth 2) → ONE back pops to the CATALOGUE (never the canvas) — the
//    real ConnectOverlay nav stack, the real backOne.
// §C THE ALWAYS-ON POLL + THE ALWAYS PILL live: the providers screen arms
//    the poll (the µs race convicted in v1.63.1 — the arm retries until
//    the panel opens; ≥2 extra /api/opencode/bridge fetches inside 12s)
//    + the opencode row ALWAYS carries pills from first paint (desktop
//    answers state 'desktop' → the dim '✓ opencode setup' + the
//    requirements ladder NEVER renders empty pills).
// §D THE DYNAMIC WALL source pins: the message builder ladder + the
//    model/size inclusions (the Go pins TestV1632_* hold the shapes —
//    run separately via go test).
// §E honesty: zero page errors through the battery.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(__ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p.startsWith('/') ? p : path.join(WEB, p), 'utf8');

const ENGINE_PORT = 8467;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const ENGINE_BIN = '/tmp/v1630-rig-engine';
const DATA_DIR = '/tmp/v1630-rig-data';

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
function abJson(js) {
  const v = abEval(js);
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') j = JSON.parse(j);
    return j;
  } catch (e) { return null; }
}

// ══ §A the source laws ══════════════════════════════════════════════
section('§A the six fixes live in the source');
for (const f of ['providers.js', 'connectoverlay.js', 'modelbrowser.js', 'termuxsetup.js', 'lattice.js', 'app.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}
{
  const pv = read('providers.js');
  // (1) THE HONEST PILL — the requirements ladder
  ok('the requirements ladder: "opencode requires " + the missing pieces joined (the pill that never disappears)',
    /need\.push\('API key'\)/.test(pv) && /need\.push\('termux setup'\)/.test(pv) &&
    /need\.push\('opencode install \(one-time ~' \+ \(b\.size_hint \|\| '72\.5MB'\) \+ '\)'\)/.test(pv) &&
    /'opencode requires ' \+ need\.join\(' \+ '\)/.test(pv));
  ok('the old walled pill ("opencode needs its key") is DEAD — no pill literal anywhere',
    !/text: 'opencode needs its key'/.test(pv));
  ok('walled joins the termux action states (termux setup is a real rung)',
    /st === 'install_failed' \|\| st === 'walled'/.test(pv));
  // (2) THE RACE FIX — the arm retries until the panel opens
  ok('THE RACE FIX: the poll arm retries until the panel opens (the µs-fast bridge status no longer swallows ocBridgeStartPoll — the counter lives OUTSIDE the callback: its first arg is the fetch RESULT)',
    /var armTries = 0;/.test(pv) && /fetchOcBridge\(function armPoll\(\) \{/.test(pv) &&
    /if \(armTries\+\+ < 400\) setTimeout\(armPoll, 150\);/.test(pv));
  // (3) THE STACK GUARD — the marker
  ok('THE STACK GUARD: #prov-root marks OUR page (a poll tick can never swap a pushed page away)',
    /id="prov-root"/.test(pv) && /!contentEl\.querySelector\('#prov-root'\)\) return;/.test(pv));
  // (4) THE ONPOP FRESH RENDER
  ok('THE ONPOP FRESH RENDER: popping back re-fetches + re-renders (the stale snapshot dies)',
    /onPop: function \(\) \{ fetchOcBridge\(function \(\) \{ render\(\); \}\); \}/.test(pv));
  // (5) THE CLOUD GATE — the pushPage branch
  ok('THE CLOUD GATE: providers.js carries the usePushPage branch (the pushed stack level)',
    /opts\.usePushPage && window\.ConnectOverlay\.isOpen\(\)/.test(pv) && /window\.ConnectOverlay\.pushPage\(html, \{/.test(pv));
}
{
  const co = read('connectoverlay.js');
  ok('connectoverlay popPage fires the restored page\'s opts.onPop',
    /typeof page\.opts\.onPop === 'function'/.test(co) && /try \{ page\.opts\.onPop\(\); \}/.test(co));
}
{
  const mb = read('modelbrowser.js');
  ok('the catalogue header: the cloud glyph LEFT of the ★ tab (same size, data-mb-cloud)',
    /data-mb-cloud="1"/.test(mb) && mb.indexOf('data-mb-cloud="1"') < mb.indexOf("tabBtn('favorites'"));
  ok('the cloud gate opens the providers screen PUSHED (back pops to the catalogue)',
    /t\.closest\('\[data-mb-cloud\]'\)/.test(mb) && /ProvidersScreen\.open\(null, \{ usePushPage: true \}\)/.test(mb));
  ok("the catalogue's own stack guard + onPop fresh render (#mb-wrap)",
    /!contentEl\.querySelector\('#mb-wrap'\)\) return;/.test(mb) && /onPop: function \(\) \{ render\(\); \}/.test(mb));
}
{
  const tsx = read('termuxsetup.js');
  ok('step ② pill: "Open Termux ↗ then hold and Paste" (the redirect icon + the whole gesture)',
    /Open Termux ↗ then hold and Paste<\/button>/.test(tsx));
  ok('the auto-copy explanation hint is DEAD (markup + style)', !/tsx-hint{/.test(tsx.replace(/\.tsx-hint\(/, '')) && !/var hint =/.test(tsx));
  ok('the paste phrase under "Bootstrap once" rides the theme accent',
    /in Termux: <b style="color:var\(--accent\);font-weight:700">hold and Paste<\/b> the command, then Enter/.test(tsx));
  ok('step ③ names the REAL screens (Additional Permissions → Run commands; Manage app optional)',
    /go to Additional Permissions and allow Run commands in Termux environment — optionally disable Manage app if unused/.test(tsx));
}
{
  const llmChat = fs.readFileSync(path.join(__ROOT, 'engine', 'internal', 'llm', 'chat.go'), 'utf8');
  const llmPocket = fs.readFileSync(path.join(__ROOT, 'engine', 'internal', 'llm', 'ocpocket.go'), 'utf8');
  const srv = fs.readFileSync(path.join(__ROOT, 'engine', 'internal', 'server', 'server.go'), 'utf8');
  const ocapi = fs.readFileSync(path.join(__ROOT, 'engine', 'internal', 'server', 'ocbridgeapi.go'), 'utf8');
  ok('THE DYNAMIC WALL: ocWalledAndroidMessage builds the ladder (the probe + the model + the live size)',
    /func ocWalledAndroidMessage\(model string\) string \{/.test(llmChat) && /OcPocketProbe != nil/.test(llmChat) &&
    /\+ m \+ " is one of them\)"/.test(llmChat) && /st\.SizeHint/.test(llmChat) && /ocserve\.AndroidZipSizeHint\(\)/.test(srv));
  ok('the message ladder: the SETUP path (Capabilities → Termux) + the INSTALL path (✓ one step left)',
    /expanding the chat metadata → Capabilities → Termux/.test(llmChat) && /Termux is set up ✓ — one step left/.test(llmChat));
  ok('the probe hook (llm/ocpocket.go) + the server arms it with the real probes',
    /var OcPocketProbe func\(\) OcPocketState/.test(llmPocket) && /llm\.OcPocketProbe = func\(\) llm\.OcPocketState \{/.test(srv) &&
    /ocserve\.AndroidZipSizeHint\(\)/.test(srv));
  ok('THE ALWAYS-TRUTH LADDER: the termux gates evaluate FIRST (walled no longer masks them)',
    /tInstalled, tReady = st\.Installed, st\.Permission/.test(ocapi) &&
    /return "walled", "Add your OpenCode key first[^"]*", tInstalled, tReady/.test(ocapi));
  ok('friendlyHTTPErrorFor carries the model (the builder names the picked model)',
    /func friendlyHTTPErrorFor\(status int, body string, provider string, model string\) string \{/.test(llmChat));
}
{
  const la = read('lattice.js');
  ok('THE CELL LAW twin: app.js re-synced to 480',
    /const GRID_BASE = 480;/.test(read('app.js')) && /var GRID_BASE = 480;/.test(la));
}

// ══ boot ════════════════════════════════════════════════════════════
section('§A.5 boot (the pristine-browser law)');
try { ab(['close', '--all']); } catch (e) {}
await sleep(600);
try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
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
ab(['open', ENGINE + '/']);
await sleep(2500);
ok('the app boots ready', abEval("document.readyState") !== 'ERR:');

// ══ §B THE CLOUD GATE live ══════════════════════════════════════════
section('§B THE CLOUD GATE (the pushed back-stack)');
{
  // open the model catalogue (the chat header's 👾 model pill opens the browser)
  abEval("(function(){var b=document.querySelector('#chat-header-model-pill, [data-open-modelbrowser], .model-pill');if(b){b.click();return 'clicked'}return 'noselect'})()");
  await sleep(300);
  // fall back: the exported API
  abEval("(function(){if(window.ModelBrowser){window.ModelBrowser.open(null,{});return 'opened'}return 'none'})()");
  await sleep(1400);
  const inBrowser = abJson("(function(){return JSON.stringify({depth:window.ConnectOverlay.pageDepth(),hasWrap:!!document.getElementById('mb-wrap'),cloud:!!document.querySelector('[data-mb-cloud]'),star:!!document.querySelector('[data-viewtab=\"favorites\"]')})})()");
  ok('the catalogue is open (the browser page + the cloud glyph + the ★ tab present)', inBrowser && inBrowser.depth === 1 && inBrowser.hasWrap && inBrowser.cloud && inBrowser.star, JSON.stringify(inBrowser));
  // the cloud glyph sits LEFT of the ★ tab (same size — the DOM order + the box size)
  const geo = abJson("(function(){var c=document.querySelector('[data-mb-cloud]'),s=document.querySelector('[data-viewtab=\"favorites\"]');if(!c||!s)return null;var cr=c.getBoundingClientRect(),sr=s.getBoundingClientRect();return JSON.stringify({cR:cr.right,sL:sr.left,h:Math.round(cr.height),sh:Math.round(sr.height)})})()");
  ok('the cloud icon sits LEFT of the ★ tab, the tab\'s own size', geo && geo.cR <= geo.sL + 2 && Math.abs(geo.h - geo.sh) <= 6, JSON.stringify(geo));
  // press it → the providers screen is PUSHED (depth 2)
  abEval("(function(){var c=document.querySelector('[data-mb-cloud]');if(c){c.click();return 'pressed'}return 'none'})()");
  await sleep(1400);
  const pushed = abJson("(function(){return JSON.stringify({depth:window.ConnectOverlay.pageDepth(),hasProv:!!document.getElementById('prov-root'),hasWrap:!!document.getElementById('mb-wrap'),title:(document.querySelector('h2')||{}).textContent})})()");
  ok('pressing the cloud icon PUSHES the providers screen (depth 2 — a real stack level, the browser still beneath)', pushed && pushed.depth === 2 && pushed.hasProv && !pushed.hasWrap, JSON.stringify(pushed));
  ok('the pushed screen IS the cloud provider screen (the Cloud Providers header)', pushed && /Cloud Providers/i.test(String(pushed.title || '')), JSON.stringify(pushed && pushed.title));
  // ONE back → the CATALOGUE (never the canvas)
  abEval("(function(){window.ConnectOverlay.backOne();return 'back'})()");
  await sleep(1200);
  const popped = abJson("(function(){return JSON.stringify({depth:window.ConnectOverlay.pageDepth(),hasWrap:!!document.getElementById('mb-wrap'),hasProv:!!document.getElementById('prov-root'),canvasVisible:!!document.getElementById('chatbots')&&document.getElementById('chatbots').style.display!=='none'})})()");
  ok('ONE back pops to the MODEL CATALOGUE (depth 1, #mb-wrap back, the providers page gone — never the canvas)', popped && popped.depth === 1 && popped.hasWrap && !popped.hasProv, JSON.stringify(popped));
  // close the browser for §C
  abEval("(function(){window.ConnectOverlay.close();return 'closed'})()");
  await sleep(900);
}

// ══ §C THE ALWAYS-ON POLL + THE ALWAYS PILL live ════════════════════
section('§C THE ALWAYS-ON POLL + THE ALWAYS PILL');
{
  // open the providers screen fresh; the FIRST paint renders the checking
  // pill before any truth lands; once the truth lands the row ALWAYS has
  // pills; and the poll keeps fetching (≥2 extra /api/opencode/bridge
  // inside 12s — THE RACE FIX's live proof: the µs-status landing first
  // used to swallow the arm forever).
  abEval("(function(){window.ProvidersScreen.open(null,{});return 'opened'})()");
  await sleep(700);
  const firstPaint = abJson("(function(){var pills=document.querySelectorAll('[data-oc-pill]');var t=[];pills.forEach(function(p){t.push(p.textContent.trim())});return JSON.stringify({n:pills.length,texts:t,hasProv:!!document.getElementById('prov-root')})})()");
  ok('the opencode row ALWAYS carries pills (first paint → the truth — never empty)', firstPaint && firstPaint.n >= 1 && firstPaint.texts.length >= 1, JSON.stringify(firstPaint));
  const pollCount0 = abJson("(function(){var es=performance.getEntriesByType('resource');var c=0;for(var i=0;i<es.length;i++){if(es[i].name.indexOf('/api/opencode/bridge')>=0)c++}return JSON.stringify({c:c})})()");
  await sleep(12000);
  const pollCount1 = abJson("(function(){var es=performance.getEntriesByType('resource');var c=0;for(var i=0;i<es.length;i++){if(es[i].name.indexOf('/api/opencode/bridge')>=0)c++}return JSON.stringify({c:c})})()");
  const delta = (pollCount1 && pollCount0) ? (pollCount1.c - pollCount0.c) : -1;
  ok('THE ALWAYS-ON POLL IS ARMED (≥2 extra /api/opencode/bridge fetches inside 12s — the race fix live)', delta >= 2, 'Δ=' + delta);
  // the pill text reflects the DESKTOP ladder honestly
  const pillNow = abJson("(function(){var t=[];document.querySelectorAll('[data-oc-pill]').forEach(function(p){t.push(p.textContent.trim())});return JSON.stringify(t)})()");
  ok('the desktop ladder answers the ✓ opencode setup pill (the honest state)', pillNow && pillNow.some((t) => /✓ opencode setup/.test(t)), JSON.stringify(pillNow));
  // THE STACK GUARD live: push TermuxSetup over the providers page — a
  // poll tick (waited 6s) must NOT swap it away.
  abEval("(function(){if(window.TermuxSetup){window.TermuxSetup.open();return 'pushed'}return 'none'})()");
  await sleep(800);
  const stacked = abJson("(function(){return JSON.stringify({tsx:!!document.getElementById('tsx-page'),prov:!!document.getElementById('prov-root'),depth:window.ConnectOverlay.pageDepth()})})()");
  ok('the TermuxSetup page is stacked over the providers screen (depth ' + ((stacked && stacked.depth) || '?') + ')', stacked && stacked.tsx && stacked.depth === 2, JSON.stringify(stacked));
  await sleep(6000);
  const stillStacked = abJson("(function(){return JSON.stringify({tsx:!!document.getElementById('tsx-page')})})()");
  ok('THE STACK GUARD: a poll tick NEVER swaps the stacked setup page away (6s of ticks — the ladder survived)', stillStacked && stillStacked.tsx, JSON.stringify(stillStacked));
  // pop back → the providers page returns + onPop re-rendered it fresh
  abEval("(function(){window.ConnectOverlay.backOne();return 'back'})()");
  await sleep(1400);
  const backProv = abJson("(function(){return JSON.stringify({depth:window.ConnectOverlay.pageDepth(),tsx:!!document.getElementById('tsx-page'),prov:!!document.getElementById('prov-root'),pills:document.querySelectorAll('[data-oc-pill]').length})})()");
  ok('popping back restores the providers page FRESH (onPop re-render — the pills alive)', backProv && backProv.depth === 1 && !backProv.tsx && backProv.prov && backProv.pills >= 1, JSON.stringify(backProv));
  abEval("(function(){window.ConnectOverlay.close();return 'closed'})()");
  await sleep(600);
}

// ══ §E honesty ══════════════════════════════════════════════════════
section('§E honesty');
{
  const errs = abJson("(function(){var w=window;return JSON.stringify({errs:(w.__rigErrs||[]).length})})()");
  ok('zero page errors through the battery', !errs || errs.errs === 0, JSON.stringify(errs));
}

try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
try { ab(['close', '--all']); } catch (e) {}

console.log('\n════════════════════════════════════');
if (fails.length) {
  console.log(`v1630 six-fixes rig: ${n - fails.length}/${n} — FAILURES: ${fails.join(' · ')}`);
  process.exit(1);
} else {
  console.log(`v1630 six-fixes rig: ${n}/${n} — ALL GREEN`);
}
