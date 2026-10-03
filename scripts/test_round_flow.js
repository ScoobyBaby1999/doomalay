#!/usr/bin/env node
// test_round_flow.js — v0.93.3 THE TOOL-CHAIN FLOW pins (node-side).
// The user's spec: "It should flow like a chat — many responses that remain
// in the position they should be and stream with the conversation."
// Exercises roundFlowApply (chatpanel's pure segment decision):
//   · live: deltas → open bubble → segment 'assistant' event (same text) → finalize
//   · round_end: closes the open bubble (idempotent — a second call no-ops)
//   · replay: per-segment 'assistant' events → each pushes its OWN block
//   · a short segment contained in an earlier one is NOT deduped (the old
//     assembled-containment bug)
'use strict';

var path = require('path');
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

var sandboxLS = {};
global.localStorage = {
  getItem: function (k) { return sandboxLS.hasOwnProperty(k) ? sandboxLS[k] : null; },
  setItem: function (k, v) { sandboxLS[k] = String(v); },
  removeItem: function (k) { delete sandboxLS[k]; }
};
global.window = { ChatTypes: { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } }, addEventListener: function () {} };
global.document = { addEventListener: function () {}, createElement: function () { return { style: {} }; } };
global.location = { protocol: 'http:', host: 'test' };
function FakeWS() { this.sent = []; }
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
FakeWS.prototype.send = function () {};
global.WebSocket = FakeWS;

var P = require(path.join(WEB, 'chatpanel.js'));

var fails = [];
var n = 0;
function ok(name, cond) { n++; if (!cond) fails.push(name); }
function eq(name, got, want) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(name + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  }
}

// ── 1. LIVE FLOW: the open bubble finalizes on its own segment event ──
var msgs = [{ role: 'user', text: 'go' }];
var open = { role: 'assistant', text: 'Let me check the repo.', complete: false, streaming: true };
msgs.push(open);
eq('live segment event finalizes the open bubble',
  P.roundFlowApply(msgs, { type: 'assistant', text: 'Let me check the repo.' }, 'assistant'),
  { action: 'finalize', index: 1 });

// ── 2. round_end closes the open bubble; second call no-ops ──
eq('round_end finalizes the open bubble',
  P.roundFlowApply(msgs, { type: 'round_end' }, 'round_end'),
  { action: 'finalize', index: 1 });
msgs[1].complete = true; // the finalize applied
eq('round_end is idempotent after close',
  P.roundFlowApply(msgs, { type: 'round_end' }, 'round_end'),
  { action: 'none' });

// ── 3. REPLAY: each segment event pushes its own complete block ──
var replay = [{ role: 'user', text: 'go' }];
eq('replay segment 1 pushes a block',
  P.roundFlowApply(replay, { type: 'assistant', text: 'Let me check the repo.' }, 'assistant'),
  { action: 'push' });
replay.push({ role: 'assistant', text: 'Let me check the repo.', complete: true });
replay.push({ role: 'tool', text: 'pill' });
// the OLD assembled-containment check would dedupe a short segment inside
// the assembled text — segments are independent now:
eq('replay segment 2 (contained in segment 1) still pushes',
  P.roundFlowApply(replay, { type: 'assistant', text: 'check the repo.' }, 'assistant'),
  { action: 'push' });
replay.push({ role: 'assistant', text: 'check the repo.', complete: true });
eq('replay final segment pushes too',
  P.roundFlowApply(replay, { type: 'assistant', text: 'The repo has 42 files.' }, 'assistant'),
  { action: 'push' });

// ── 4. v0.95.2 THE DUPLICATE SUPPRESSOR: a text-matching 'assistant' event
// on an ALREADY-COMPLETE bubble is the same segment twice (the pre-v0.95.2
// engine shipped the final assistant AFTER status:idle — completeAllStreaming
// had closed the bubble and the event duplicated into a second full-text
// block; replays of old logs still carry that order). No-op on match, push on
// differing text.
var dup = [
  { role: 'user', text: 'go' },
  { role: 'assistant', text: 'The result is 22.', complete: true }
];
eq('a matching assistant event on a completed bubble no-ops',
  P.roundFlowApply(dup, { type: 'assistant', text: 'The result is 22.' }, 'assistant'),
  { action: 'none' });
eq('a DIFFERING assistant event still pushes (a genuine new segment)',
  P.roundFlowApply(dup, { type: 'assistant', text: 'And one more thing…' }, 'assistant'),
  { action: 'push' });

// ── 4. a mismatched text on an OPEN bubble pushes a NEW block ──
var mismatch = [{ role: 'assistant', text: 'partial…', complete: false, streaming: true }];
eq('mismatched text pushes a new block (never replaces the open one)',
  P.roundFlowApply(mismatch, { type: 'assistant', text: 'different text' }, 'assistant'),
  { action: 'push' });

// ── 5. empty text + no assistant messages never break ──
eq('empty text is a no-op', P.roundFlowApply([], { type: 'assistant', text: '' }, 'assistant'), { action: 'none' });
eq('round_end with no assistant messages is a no-op',
  P.roundFlowApply([], { type: 'round_end' }, 'round_end'), { action: 'none' });

if (fails.length) {
  console.error('FAILURES (' + fails.length + '):');
  fails.forEach(function (f) { console.error('  ✕ ' + f); });
  process.exit(1);
}
console.log('SELF-TEST OK — ' + n + ' assertions (round flow: live finalize, idempotent round_end, replay pushes per segment, no containment dedupe)');
