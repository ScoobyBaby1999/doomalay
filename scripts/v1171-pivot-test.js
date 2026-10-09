#!/usr/bin/env node
// v1171-pivot-test.js — v1.17.1 THE PIVOT pins (node-side).
//
// The sandbox picker dies; the capability library is born. New chats are
// quick by birth; the gatelock is model-only + an optional capabilities
// box; the chat session grows the stacked `termux` capability column.
// This rig pins the source contracts (the picker's death, the quick
// default, the engine column) and exercises the pure behavior the DOM
// is too heavy to fake here (the capability row builder, the Termux
// gating logic, the chatframework gatelock/pill shape via window stubs).
'use strict';

var path = require('path');
var fs = require('fs');
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');
var STORE = path.join(__dirname, '..', 'engine', 'internal', 'store');
var SERVER = path.join(__dirname, '..', 'engine', 'internal', 'server');

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}
function src(file) { return fs.readFileSync(path.join(WEB, file), 'utf8'); }

// ── 1. SOURCE PINS: the picker died, the library was born ─────────────
console.log('v1.17.1 THE PIVOT pins:');
(function () {
  ok(!fs.existsSync(path.join(WEB, 'sandboxpicker.js')), 'sandboxpicker.js does not exist');
  ok(fs.existsSync(path.join(WEB, 'capabilities.js')), 'capabilities.js exists');

  var idx = src('index.html');
  ok(idx.indexOf('src="capabilities.js"') >= 0, 'index.html loads capabilities.js');
  ok(idx.indexOf('src="sandboxpicker.js"') < 0, 'index.html no longer loads the sandbox picker script');

  // no SandboxPicker references remain anywhere in web/ (vendor aside)
  var files = fs.readdirSync(WEB).filter(function (f) { return /\.js$/.test(f); });
  var offenders = [];
  files.forEach(function (f) {
    if (src(f).indexOf('SandboxPicker') >= 0) offenders.push(f);
  });
  ok(offenders.length === 0, 'no SandboxPicker references remain in web/ (' + offenders.join(', ') + ')');

  var cf = src('chatframework.js');
  ok(cf.indexOf("key: 'caps'") >= 0 && cf.indexOf("'+ capabilities'") >= 0, 'chatframework: the caps gatelock box exists');
  ok(cf.indexOf('optional · stack what you need') >= 0, 'chatframework: the caps box sub reads "optional · stack what you need"');
  ok(cf.indexOf('One step and the chat opens below.') >= 0, 'chatframework: the intro is the ONE-step line');
  ok(cf.indexOf('Two steps') < 0, 'chatframework: the two-steps intro is gone');
  ok(/isFulfilled\(state\)\s*\{\s*return !!state\.model;\s*\}/.test(cf), 'chatframework: isFulfilled is model-only');
  ok(cf.indexOf("id: 'pill-caps'") >= 0, 'chatframework: the capabilities pill (pill-sandbox\'s heir)');
  ok(cf.indexOf("id: 'pill-termux'") < 0, 'v1.20.1: the ⌨ Termux pill is DEAD (chat metadata noise — the capability rides the library row)');
  ok(cf.indexOf('window.SandboxLabel') >= 0 && cf.indexOf('SANDBOX_LABELS') >= 0, 'chatframework: legacy SandboxLabel + label maps kept for existing hf/terminal/device sessions');

  var cp = src('chatpanel.js');
  ok(/sandbox:\s*state\.sandbox\s*\|\|\s*'quick'/.test(cp), 'chatpanel: sessionBody defaults sandbox to quick');
  ok(cp.indexOf('+ Sandbox') < 0, 'chatpanel: no "+ Sandbox" gatelock/pill/dropdown string');
  ok(/termux:\s*!!state\.termux/.test(cp) && /termux:\s*state\.termux\s*!==\s*false/.test(cp) === false, 'chatpanel: termux rides sessionBody + persistCaps');
  ok(cp.indexOf('termux: !!state.termux') >= 0, 'chatpanel: persistCaps PATCHes termux');
  ok(/web_search:\s*state\.webSearch\s*!==\s*false/.test(cp), 'chatpanel: the web_search capability rides turns with the real state (no hardcode)');
  ok(cp.indexOf('web_search: true') < 0, 'chatpanel: the v0.45 web_search:true hardcode is gone');
  ok(cp.indexOf('[/^pill-caps/') >= 0 && cp.indexOf('[/^pill-termux/') < 0, 'chatpanel: PILL_TONES carries the caps entry — the termux tone died with the pill (v1.20.1)');
  ok(cp.indexOf('[/^pill-sandbox/') < 0, 'chatpanel: the pill-sandbox tone entry is gone');

  var cb = src('chatbot.js');
  ok(/sandbox\s*=\s*'quick'/.test(cb), 'chatbot: a new ChatIcon is sandbox=quick FROM BIRTH');
  ok(/sandbox:\s*data\.sandbox\s*\|\|\s*''/.test(cb), 'chatbot: deserialize still restores each icon\'s own sandbox (legacy sessions)');

  var st = fs.readFileSync(path.join(STORE, 'sessions.go'), 'utf8');
  ok(/Termux\s+bool/.test(st), 'store: the Session struct carries Termux');
  ok(st.indexOf('lib_auto, termux') >= 0, 'store: CreateSession INSERTs the termux column');
  ok(st.indexOf('lib_auto=?, termux=?') >= 0, 'store: UpdateSession writes the termux column');
  ok(st.indexOf('lib_auto, termux, sandbox_mode') >= 0, 'store: GetSession SELECTs the termux column');
  var dbm = fs.readFileSync(path.join(STORE, 'db.go'), 'utf8');
  ok(dbm.indexOf('"termux", "ALTER TABLE chat_sessions ADD COLUMN termux INTEGER DEFAULT 0"') >= 0, 'store: the termux migration follows the addColumn pattern');

  var sv = fs.readFileSync(path.join(SERVER, 'sessions.go'), 'utf8');
  ok(sv.indexOf('Termux bool `json:"termux"`') >= 0, 'server: create accepts termux from the JSON body');
  ok(sv.indexOf('req["termux"].(bool)') >= 0, 'server: PATCH accepts termux');

  var sx = fs.readFileSync(path.join(SERVER, 'sessionctx.go'), 'utf8');
  ok(sx.indexOf('Your capabilities (stacked by the user in this chat\'s capabilities library)') >= 0, 'sessionctx: the capabilities prose line');
  // v1.20.3 re-pin: THE ARM replaced the inert note — the teaching rides
  // the armed/unbound branches (the capability line survived every wave).
  ok(sx.indexOf('Termux capability: ARMED but no device folder is connected yet') >= 0,
    'sessionctx: the termux unbound teach (v1.20.3 THE ARM replaced the inert note)');
  ok(sx.indexOf('THE TERMUX HAND on this chat') >= 0, 'sessionctx: the armed teach exists (a bound folder arms it)');
  ok(sx.indexOf('quick / hf / terminal / device') < 0, 'sessionctx: the sandbox-type teaching is retired');
})();

// ── 2. BEHAVIOR: the capability row builder (pure) ────────────────────
(function () {
  var C = require(path.join(WEB, 'capabilities.js'));

  // a fresh chat's state: web search ON by birth, lib ON (the v0.77.6
  // default), deep/skills/templates off, nothing stacked.
  var rows = C.rowsFor({ libAuto: true }, {});
  var by = {};
  rows.forEach(function (r) { by[r.key] = r; });
  ok(by.web_search.on === true, 'rowsFor: web search defaults ON');
  ok(by.lib_auto.on === true, 'rowsFor: library defaults ON (the lib pill default)');
  ok(by.deep_research.on === false && by.skills_auto.on === false && by.template_auto.on === false,
    'rowsFor: deep research / skills / templates default OFF');
  ok(by.persona.kind === 'action' && by.workspaces.kind === 'action', 'rowsFor: persona + workspaces are action rows');
  ok(!by.termux, 'rowsFor: NO Termux row without a bridge status (desktop honesty)');

  var chipWebOn = C.chipFor(by.web_search);
  ok(chipWebOn.cls === 'on' && chipWebOn.text === 'on', 'chipFor: ON = accent chip "on"');
  var chipDeepOff = C.chipFor(by.deep_research);
  ok(chipDeepOff.cls === 'off' && chipDeepOff.text === 'off', 'chipFor: OFF = muted chip "off"');

  // the toggle flip paints the opposite chip
  var flipped = C.rowsFor({ deepResearch: true }, {});
  var by2 = {};
  flipped.forEach(function (r) { by2[r.key] = r; });
  ok(C.chipFor(by2.deep_research).cls === 'on', 'rowsFor: a flipped deep_research renders the ON chip');

  // the persona row shows the active persona name when set
  var prows = C.rowsFor({}, { personaName: 'Kronos' });
  var pby = {};
  prows.forEach(function (r) { pby[r.key] = r; });
  ok(pby.persona.sub === 'active · Kronos', 'rowsFor: the persona row shows the active persona name');

  // the workspaces row shows the bound count
  var wrows = C.rowsFor({}, { wsCount: 3 });
  var wby = {};
  wrows.forEach(function (r) { wby[r.key] = r; });
  ok(wby.workspaces.chip.text === '3 bound' && wby.workspaces.chip.cls === 'on',
    'rowsFor: the workspaces row shows the bound count');
})();

// ── 3. BEHAVIOR: the Termux gating logic (pure) ───────────────────────
(function () {
  var C = require(path.join(WEB, 'capabilities.js'));

  ok(C.termuxRowState(null, {}) === null, 'termux: a failed status fetch renders NO row');
  ok(C.termuxRowState({}, {}) === null, 'termux: an empty status renders NO row');
  ok(C.termuxRowState({ available: false }, {}) === null, 'termux: {available:false} renders NO row');

  var unready = C.termuxRowState({ available: true }, {});
  ok(unready && unready.available === true && unready.ready === false, 'termux: available-but-unready is a row with ready=false');
  var ready = C.termuxRowState({ available: true, ready: true }, { termux: false });
  ok(ready && ready.ready === true && ready.on === false, 'termux: ready reports the toggle armed-able');

  // the row shape: unready → the tappable "set up…" hint chip (v1.17.3
  // rewire — was the muted "not set up" chip + a toast); ready → accent
  // "ready" chip; stacked → the stacked sub line.
  var rowsU = C.rowsFor({}, { termux: { available: true, ready: false } });
  var tu = rowsU.filter(function (r) { return r.key === 'termux'; })[0];
  ok(tu && C.chipFor(tu).text === 'set up…' && C.chipFor(tu).cls === 'setup',
    'termux: unready row carries the tappable "set up…" hint chip (the v1.17.3 rewire)');
  var rowsR = C.rowsFor({}, { termux: { available: true, ready: true } });
  var tr = rowsR.filter(function (r) { return r.key === 'termux'; })[0];
  ok(tr && C.chipFor(tr).text === 'ready' && C.chipFor(tr).cls === 'on' && tr.sub === 'tap to stack on this chat',
    'termux: ready row carries the accent "ready" chip + the stack invitation');
  var rowsS = C.rowsFor({ termux: true }, { termux: { available: true, ready: true } });
  var tson = rowsS.filter(function (r) { return r.key === 'termux'; })[0];
  ok(tson && tson.sub === 'stacked on this chat · tap to remove', 'termux: a stacked capability reads "stacked on this chat"');
})();

// ── 4. BEHAVIOR: the chatframework gatelock + pills (window stubs) ────
(function () {
  global.window = { addEventListener: function () {} };
  require(path.join(WEB, 'chatframework.js'));
  var ChatTypes = global.window.ChatTypes;
  ok(!!ChatTypes, 'chatframework: loads under node and exports window.ChatTypes');

  var type = ChatTypes.get('quick');

  // the gatelock: ONE required box (model) + ONE optional caps box
  var opened = [];
  global.window.Capabilities = { open: function (ctx) { opened.push(ctx); } };
  var ctx = {
    state: { sandbox: 'quick', provider: 'nvidia' },
    openModelPicker: function () {},
    applySandbox: function () { throw new Error('applySandbox must never be called by the new gatelock'); }
  };
  var steps = type.gatelockSteps(ctx);
  ok(steps.length === 2, 'gatelock: exactly two boxes');
  ok(steps[0].key === 'model' && steps[1].key === 'caps', 'gatelock: the model box first, the caps box second');
  ok(steps[1].filled === true, 'gatelock: the caps box NEVER blocks the gate (filled always)');
  ok(steps[0].title === 'Nvidia' || steps[0].title === '+ Model', 'gatelock: the model box keeps its behavior');
  ok(steps[0].sub === 'tap to pick · the model screen', 'gatelock: the v1.15.1 model pointer stays');
  steps[1].onTap();
  ok(opened.length === 1 && opened[0] === ctx, 'gatelock: the caps box opens the capability library with the chatpanel ctx');

  // isFulfilled is model-only (quick is the birth default now)
  ok(type.isFulfilled({ model: 'nvidia/x' }) === true, 'isFulfilled: a model alone opens the gate');
  ok(type.isFulfilled({ sandbox: 'quick' }) === false, 'isFulfilled: sandbox alone no longer opens the gate');
  ok(type.gatelockIntro({}) === 'One step and the chat opens below.', 'gatelockIntro: the one-step line');

  // the pills: caps (the sandbox pill's heir) + model. v1.20.1 THE QUIET
  // GATE: the ⌨ Termux pill died — stacking the capability never mints
  // chat-metadata noise again (the library row carries the state).
  var pills = type.pills({ state: { provider: 'nvidia', termux: false } });
  ok(pills.length === 2 && pills[0].id === 'pill-caps' && pills[1].id === 'pill-model',
    'pills: caps + model, no termux pill when unstacked');
  var pillsT = type.pills({ state: { provider: 'nvidia', termux: true } });
  ok(pillsT.length === 2 && pillsT[1].id === 'pill-model' &&
     pillsT.every(function (p) { return p.id !== 'pill-termux'; }),
    'v1.20.1: the ⌨ Termux pill does NOT join even when the capability is stacked');
  opened.length = 0;
  pillsT[0].onTap();
  ok(opened.length === 1, 'pills: the caps pill still opens the capability library');

  // the termux session field rides extraSessionFields
  ok(type.extraSessionFields({ termux: true }).termux === true &&
     type.extraSessionFields({}).termux === false, 'extraSessionFields: termux rides the session fields');
})();

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
