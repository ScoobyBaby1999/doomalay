#!/usr/bin/env node
// v1300-recovery-rig.mjs — v1.30.0 THE RECOVERY WAVE battery.
//
// The user's five reports (v1.29.x phases, PLAN-V130):
//   §1 v1.29.1 THE TERMUX LADDER — the verify step hidden (the ladder
//      still computes + force-polls it), the number pills designed
//      (theme vars only), Open Termux carries the command + teaches the
//      paste gesture.
//   §2 v1.29.2 THE QUIET END — stampThinkEnd ends the CHAIN's UI (the
//      cursor dies when the chain ends, not when the turn ends); the
//      pmsdk _pmBootstrapCache is DECLARED (the ReferenceError pill is
//      dead).
//   §3 v1.29.3 THE OPEN DOOR — the stale-turn takeover (gate + abort +
//      bounded wait), the honest busy message, the probe ladder at 12.
//      (The behavioral Go pins: TestV1293_* in chat_v1293_test.go.)
//   §4 v1.29.4 THE STEADY RESUME — the engine's replay_done marker ends
//      the client's _replay tag DETERMINISTICALLY (behavioral test
//      below: the exact user scenario — a resume landing straight into
//      a fast reasoning stream); the panel force-repaints the streaming
//      bubbles when the burst ends.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p, 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (!cond) fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
}

// ══ syntax: every touched client file parses ══════════════════════════
for (const f of ['termuxsetup.js', 'chatpanel.js', 'chatclient.js']) {
  try { new Function(read(path.join(WEB, f))); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}
try {
  const pm = read(path.join(WEB, 'vendor', 'pm', 'pmsdk.js'));
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: pm });
  ok('pmsdk.js parses (module)', true);
} catch (e) { ok('pmsdk.js parses (module)', false, e.message); }

// ══ §1 THE TERMUX LADDER ══════════════════════════════════════════════
console.log('§1 the termux ladder — 3 visible steps, designed pills, the carried command');
const tsx = read(path.join(WEB, 'termuxsetup.js'));
ok('the verify ROW is gone from the page (hidden, not removed)',
  !/stepRow\('verify'/.test(tsx));
ok('the ladder still computes all four states',
  /key: 'verify',\s*done: !!status\.ready/.test(tsx));
ok('the verify stage force-poll survives (shouldForce reads steps[3])',
  /s\.steps\[0\]\.done && s\.steps\[1\]\.done && s\.steps\[2\]\.done/.test(tsx));
ok('the hidden stage speaks on the status line',
  /finishing — verifying storage \+ the command bridge…/.test(tsx));
ok('the number pill map exists (1/2/3 shown, verify internal)',
  /STEP_NUM = \{ install: 1, bootstrap: 2, permission: 3, verify: 4 \}/.test(tsx));
ok('the pill states ride the theme system (no hardcoded colors in the new styles)',
  /\.tsx-num\.now\{[^}]*var\(--accent\)[^}]*\}/.test(tsx) &&
  /\.tsx-num\.done\{[^}]*var\(--on-accent\)[^}]*\}/.test(tsx) &&
  !/tsx-num\{[^}]*#[0-9a-fA-F]{3,8}/.test(tsx));
ok('the unicode-glyph icon style is gone',
  !/\.tsx-ico\{/.test(tsx) && !/stepRow\('install', '①'/.test(tsx));
ok('Open Termux carries the command (copy → open → teach)',
  /copyText\(bootstrapCmd, function \(\) \{/.test(tsx) &&
  /act\(inst, 'open_termux'/.test(tsx) &&
  /long-press in Termux → Paste → Enter/.test(tsx));
ok('the paste-gesture hint renders under the command',
  /tsx-hint[^']*'Open Termux copies the command/.test(tsx.replace(/\n\s+/g, '')) ||
  /Open Termux copies the command — in Termux: '/.test(tsx));
ok('the rig-pinned contracts survive (Open Termux label, copy helper, refresh probes)',
  tsx.indexOf('Open Termux') >= 0 && tsx.indexOf('window.Formatter.copyText') >= 0 &&
  tsx.indexOf('?refresh=1') >= 0);

// ══ §2 THE QUIET END ══════════════════════════════════════════════════
console.log('§2 the quiet end — the cursor dies with the chain, the pmsdk cache is declared');
const cp = read(path.join(WEB, 'chatpanel.js'));
ok('stampThinkEnd flips streaming OFF (the chain-end law)',
  /lt\.endedAt = tsMs \|\| Date\.now\(\);[\s\S]{0,1200}if \(lt\.streaming\) \{\s*lt\.streaming = false;\s*updateMessageEl\(bodyEl, lt, false, state\);/.test(cp));
ok('every WS call site passes bodyEl (6 sites, zero bare)',
  (cp.match(/stampThinkEnd\(state, evTsMs\(ev\), bodyEl\)/g) || []).length === 6 &&
  (cp.match(/stampThinkEnd\(state, evTsMs\(ev\)\);/g) || []).length === 0);
ok('the PM path reports through the same law',
  cp.includes('stampThinkEnd(state, 0, bodyEl)'));
ok('the elapsed chip hides with the chain (the stats line keeps the frozen label)',
  /chip\.style\.display = 'none'/.test(cp));
ok('the pmsdk bootstrap cache is DECLARED (the ReferenceError pill is dead)',
  /var _pmBootstrapCache = null;/.test(read(path.join(WEB, 'vendor', 'pm', 'pmsdk.js'))));

// ══ §3 THE OPEN DOOR (source mirrors of the Go pins) ══════════════════
console.log('§3 the open door — the takeover sits in the busy branch');
const goChat = read(path.join(ROOT, 'engine', 'internal', 'server', 'chat.go'));
ok('the takeover gate + abort + bounded wait sit in handleTurn',
  /if takeoverStaleTurn\(sessionID, sender\) \{/.test(goChat) &&
  /lockSessionWait\(sessionID, 3\*time\.Second\)/.test(goChat));
ok('the honest busy message replaced the dead end',
  !goChat.includes('{"error":"busy","message":"agent already processing"}') &&
  /the previous turn is still running — tap Stop to end it, or wait for it to finish/.test(goChat));
const goLlm = read(path.join(ROOT, 'engine', 'internal', 'llm', 'catalog.go'));
ok('the probe ladder reaches 12 + names the honesty',
  /const probeCandidateCap = 12/.test(goLlm) &&
  goLlm.includes('model-level errors only; the key itself was never rejected'));

// ══ §4 THE STEADY RESUME — BEHAVIORAL ═════════════════════════════════
console.log('§4 the steady resume — the replay tag ends deterministically (real chatclient logic)');
const sandbox = { window: {}, WebSocket: function () {}, console };
vm.createContext(sandbox);
vm.runInContext(read(path.join(WEB, 'chatclient.js')), sandbox);
const ChatClient = sandbox.window.ChatClient;
ok('chatclient loads in the vm harness', typeof ChatClient === 'function');
{
  const c = new ChatClient('', 'sess-recovery', '');
  // THE EXACT USER SCENARIO: connect (backlog burst armed) → the gap
  // replay lands → the live reasoning stream follows at <1200ms cadence.
  c._replaying = true;
  c._replayLastAt = 0;
  const frame = (type, seq) => { const ev = { type, seq }; c._tagReplay(ev); return ev; };
  const r1 = frame('thinking', 101);
  const r2 = frame('thinking', 102);
  ok('the backlog burst is tagged (_replay) while it drains', r1._replay === true && r2._replay === true);
  // the live deltas — OLD code: tagged forever (no 1200ms gap ever
  // arrives on a fast stream) → the frozen box. NEW code: the marker
  // ends the tag BEFORE the first live delta.
  const done = { type: 'ws_state', state: 'replay_done', resumed: true };
  c._tagReplay(done);                       // onmessage order: tag FIRST…
  c._stopReplayTag();                       // …then the marker clears it
  const live1 = frame('thinking', 103);
  const live2 = frame('thinking', 104);
  ok('LIVE deltas after replay_done are UNTAGGED', !live1._replay && !live2._replay);
  // and the fallback for older engines still works (1200ms quiet gap)
  const c2 = new ChatClient('', 'sess-old', '');
  c2._replaying = true; c2._replayLastAt = Date.now();
  const oldEv = { type: 'thinking', seq: 9 };
  c2._tagReplay(oldEv);
  ok('older engines: the heuristic still tags within the window', oldEv._replay === true);
  c2._replayLastAt = Date.now() - 1300;
  const afterGap = { type: 'thinking', seq: 10 };
  c2._tagReplay(afterGap);
  ok('older engines: a >1200ms gap still ends the tag (fallback intact)',
    c2._replaying === false && !afterGap._replay);
}
ok('the engine sends the replay_done marker (ephemeral, after the burst)',
  /"state": "replay_done", "resumed": since > 1/.test(goChat));
ok('the panel force-repaints streaming bubbles when the burst ends',
  /else if \(ev\.state === 'replay_done'\) \{[\s\S]{0,900}updateMessageEl\(bodyEl, rm, false, state\);/.test(cp));

// ══ done ══════════════════════════════════════════════════════════════
console.log('\n' + (n - fails.length) + '/' + n + ' checks passed');
if (fails.length) {
  console.log('FAILURES:\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('THE RECOVERY WAVE battery is green.');
