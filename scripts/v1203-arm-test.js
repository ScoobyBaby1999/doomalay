#!/usr/bin/env node
// v1203-arm-test.js — v1.20.3 THE ARM pins (node-side, source pins — the
// heavy behavior lives in termuxtool_test.go: the arming matrix, the verb
// matrix, the blocklist, the jail, the cooldown, the session lifecycle).
//
// THE ARM: the bot-facing Termux hand — ONE gated MCP tool ("termux", the
// workspace tool's one-tool/verb-map shape), jailed to the chat's bound
// termux workspaces, full output, honest caps, background-process sessions.
//
// This rig pins the wiring contract across the layers:
//   mcpbus: the GateTermux const + the Def + the Gates/Turn fields + the
//           SpecsFor/armedToolList cases + the handler dispatch
//   llm:    the ChatRequest field + the mcpGates/mcpTurnFor bridges + the
//           native ACTION dispatch twin
//   server: the TermuxToolFn wiring + the sessionctx teaching + the
//           blocklist/cooldown laws in termuxtool.go
'use strict';

var path = require('path');
var fs = require('fs');

var ROOT = path.join(__dirname, '..');
var MB = path.join(ROOT, 'engine', 'internal', 'mcpbus');
var LLM = path.join(ROOT, 'engine', 'internal', 'llm');
var SRV = path.join(ROOT, 'engine', 'internal', 'server');

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}
function src(p) { return fs.readFileSync(p, 'utf8'); }

// ── 1. mcpbus: the gate + the Def + the projections ────────────────────
console.log('v1.20.3 THE ARM pins — mcpbus:');
(function () {
  var def = src(path.join(MB, 'def.go'));
  ok(/GateTermux\s+Gate = "termux"/.test(def), 'GateTermux const exists');
  ok(/\{Name: "termux", Gate: GateTermux,/.test(def), 'the termux Def is registered and gated');
  ok(/session_start/.test(def) && /session_kill/.test(def), 'the Def teaches the session verbs');
  ok(/100KB/.test(def), 'the Def teaches the 100KB honesty cap');

  var bus = src(path.join(MB, 'bus.go'));
  ok(/Termux\s+bool/.test(bus), 'Gates.Termux field exists');
  ok(/case GateTermux:/.test(bus), 'SpecsFor carries the GateTermux case (the manifest gate)');
  ok(/g\.Termux/.test(bus), 'the gate check reads g.Termux');

  var turn = src(path.join(MB, 'turn.go'));
  ok(/Termux func\(ctx context\.Context, argJSON string\) string/.test(turn),
    'Turn.Termux closure exists (the per-turn hand)');

  var handlers = src(path.join(MB, 'handlers.go'));
  ok(/"termux"/.test(handlers), 'the handler dispatch routes the termux tool');
})();

// ── 2. llm: the request field + both-path bridges ──────────────────────
console.log('v1.20.3 THE ARM pins — llm wiring:');
(function () {
  var chat = src(path.join(LLM, 'chat.go'));
  ok(/TermuxToolFn func\(ctx context\.Context, argJSON string\) string/.test(chat),
    'ChatRequest.TermuxToolFn exists (the native fallback twin)');
  ok(/action == "termux"/.test(chat), 'the ACTION dispatch carries the termux branch');

  var bridge = src(path.join(LLM, 'mcpbridge.go'));
  ok(/Termux:\s*req\.TermuxToolFn != nil/.test(bridge), 'mcpGates derives Termux from the closure');
  ok(/Termux:\s*req\.TermuxToolFn/.test(bridge), 'mcpTurnFor bridges the Termux closure');
})();

// ── 3. server: the runner + the wiring + the teaching ──────────────────
console.log('v1.20.3 THE ARM pins — server:');
(function () {
  var chat = src(path.join(SRV, 'chat.go'));
  ok(/req\.TermuxToolFn = func\(ctx context\.Context, argJSON string\) string \{[\s\S]{0,40}return s\.runTermuxAction/.test(chat),
    'the server wires TermuxToolFn → runTermuxAction (conditional arm when the chat has the capability)');

  var tool = src(path.join(SRV, 'termuxtool.go'));
  ok(tool.length > 20000, 'termuxtool.go exists (the verb runner, >20KB)');
  // THE BLOCKLIST LAW: refused BEFORE the bridge is touched
  ok(/termuxBlocklistHit\(command\)/.test(tool), 'the blocklist gate runs on every exec');
  ok(/fork bomb/.test(tool) && /mkfs/.test(tool) && /reboot/.test(tool) && /dd writing/.test(tool),
    'the blocklist classes: fork bomb / mkfs / power / dd');
  // THE COOLDOWN LAW
  ok(/≥4s|>= 4|4\*time\.Second|4 \* time\.Second/.test(tool), 'the exec cooldown (≥4s between one-shots)');
  // THE JAIL LAW: exit 42 Termux-side, prefix-check engine-side
  ok(/exit 42/.test(tool), 'the jail script exits 42 on violation (never touches the file)');
  // THE WHOLE-TRUTH LAW: Termux's 100KB is the only cap, reported honestly
  ok(/truncated at 100KB|100KB by Termux/.test(tool), 'the truncation honesty line exists');
  // THE SESSIONS MODEL: nohup + pid + out.log under $HOME/.doomalay/sessions
  ok(/\.doomalay\/sessions/.test(tool), 'the sessions dir is $HOME/.doomalay/sessions');
  ok(/nohup/.test(tool) && /pid/.test(tool) && /out\.log/.test(tool), 'the background-process session model (nohup/pid/out.log)');
  // ZERO shell interpolation of model/user strings — positional args only
  ok(/termuxShellQuote|"\$1"|'\$1'/.test(tool), 'positional-arg law (no string interpolation into scripts)');

  var sctx = src(path.join(SRV, 'sessionctx.go'));
  ok(/THE TERMUX HAND/.test(sctx), 'sessionctx teaches the hand when armed');
  ok(/no device folder is connected yet/.test(sctx), 'sessionctx stays honest when armed-but-unbound');
  ok(!/ARMED but inert/.test(sctx), 'the v1.17.1 inert line is retired');
  ok(!/tools arrive next update/.test(sctx), 'the "tools arrive next update" promise is gone (they arrived)');
})();

// ── 4. the Def↔tool verb-map consistency (one source of truth) ────────
console.log('v1.20.3 THE ARM pins — consistency:');
(function () {
  var def = src(path.join(MB, 'def.go'));
  var tool = src(path.join(SRV, 'termuxtool.go'));
  var verbs = ['exec', 'ls', 'read', 'write', 'append', 'rm', 'mkdir', 'grep', 'find', 'pkg',
    'session_start', 'session_list', 'session_log', 'session_kill', 'help'];
  verbs.forEach(function (v) {
    ok(def.indexOf("'" + v + "'") >= 0, 'the Def enum carries ' + v);
    ok(tool.indexOf('"' + v + '"') >= 0 || tool.indexOf("'" + v + "'") >= 0, 'the runner dispatches ' + v);
  });
})();

// ── 5. the gate honesty: not-armed answers teach, never crash ──────────
console.log('v1.20.3 THE ARM pins — honesty:');
(function () {
  var tool = src(path.join(SRV, 'termuxtool.go'));
  ok(/termuxTeachNotStacked/.test(tool), 'the not-stacked teach exists');
  ok(/termuxTeachNoFolder/.test(tool), 'the no-folder teach exists');
  ok(/never a panic|NEVER a panic|never silence/.test(tool), 'the honest-branch law is documented');
})();

console.log('');
console.log('v1203 arm pins: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
