#!/usr/bin/env node
// test_interrupt_fixes.js — node-side verification of the v0.44
// INTERRUPT HARDENING (W3-B6 / T7-b). Loads the REAL chatpanel.js +
// chatclient.js through their node export paths (stubbed browser
// surface, same pattern as test_uikit.js / test_theme_twins.js) and
// exercises the pure logic the event pipeline now delegates to:
//
//   · resolveUserEcho     — the pendingSends dedupe (matching text
//                           stamps the right message even when buried
//                           non-last; stale-mi re-scan; no match →
//                           duplicate push; the 2-minute ts window)
//                           + the tail-scan fallback (last 6, local,
//                           ei-less only)
//   · dropAdjacentUserDupes — the reconnect adjacent-duplicate pass
//                           (local orphan next to its echoed twin
//                           drops; legit repeats / non-adjacent /
//                           non-local never drop; ONE drop per call)
//   · draftSaveStaleMs + saveDraftLS/clearDraftLS — the late-IME
//                           guard (a save within 800ms of a send-clear
//                           is skipped; after 800ms it persists)
//   · chatclient's replay tag (_replay) + turnActive on send — the
//                           connect-time burst is tagged, the first
//                           post-quiet-gap event goes out live, close
//                           ends the drain, and a reconnect re-arms it
//
// Prints 'SELF-TEST OK' + exit 0 on success; failures + exit 1.

'use strict';

var path = require('path');
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

// ── 1. the stub browser surface (chatpanel + chatclient load paths) ──
var sandboxLS = {};
global.localStorage = {
  getItem: function (k) { return sandboxLS.hasOwnProperty(k) ? sandboxLS[k] : null; },
  setItem: function (k, v) { sandboxLS[k] = String(v); },
  removeItem: function (k) { delete sandboxLS[k]; }
};
global.window = {
  ChatTypes: {
    helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} }
  },
  addEventListener: function () {}
};
global.document = {
  addEventListener: function () {},
  createElement: function () { return { style: {} }; }
};
global.location = { protocol: 'http:', host: 'test' };
// the fake WebSocket: records instances so the harness can drive
// onopen/onmessage/onclose by hand.
var wsInstances = [];
function FakeWS(url) {
  this.url = url;
  this.readyState = FakeWS.CONNECTING;
  this.sent = [];
  this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
  wsInstances.push(this);
}
FakeWS.CONNECTING = 0;
FakeWS.OPEN = 1;
FakeWS.CLOSING = 2;
FakeWS.CLOSED = 3;
FakeWS.prototype.send = function (m) { this.sent.push(m); };
global.WebSocket = FakeWS;

// ── assertions ──────────────────────────────────────────────────────
var fails = [];
var n = 0;
function ok(name, cond) { n++; if (!cond) fails.push(name); }
function eq(name, got, want) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(name + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {

// ══ 2. chatpanel.js — the pure helpers ═══════════════════════════════
var P = require(path.join(WEB, 'chatpanel.js'));
eq('exports resolveUserEcho', typeof P.resolveUserEcho, 'function');
eq('exports dropAdjacentUserDupes', typeof P.dropAdjacentUserDupes, 'function');
eq('exports draftSaveStaleMs', typeof P.draftSaveStaleMs, 'function');
eq('exports saveDraftLS', typeof P.saveDraftLS, 'function');
eq('exports clearDraftLS', typeof P.clearDraftLS, 'function');

// ── 2a. resolveUserEcho: the pendingSends dedupe ────────────────────
var NOW = 1700000000000;

// THE REPORTED BUG: the optimistic user message is buried under
// thinking/delta bubbles when the gap replay delivers its echo — the
// old last-message-only check pushed a duplicate.
var msgs = [
  { role: 'user', text: 'hello', local: true, ts: NOW },
  { role: 'thinking', text: 'hm', streaming: false },
  { role: 'assistant', text: 'par', streaming: true, complete: false }
];
var pend = [{ text: 'hello', ts: NOW, mi: 0 }];
var res = P.resolveUserEcho(pend, msgs, { type: 'user', text: 'hello', ts: NOW / 1000, i: 42 });
eq('buried optimistic message stamps (not push)', res, { kind: 'stamp', mi: 0, pend: 0 });

// the recorded mi went stale (the message list re-shaped since the
// send) — the re-scan from the END finds the local copy.
msgs = [
  { role: 'assistant', text: 'old reply', complete: true },
  { role: 'user', text: 'hello', local: true, ts: NOW },
  { role: 'thinking', text: '…' }
];
pend = [{ text: 'hello', ts: NOW, mi: 9 }]; // points nowhere valid
res = P.resolveUserEcho(pend, msgs, { type: 'user', text: 'hello', ts: NOW / 1000 });
eq('stale mi → end-scan stamp', res, { kind: 'stamp', mi: 1, pend: 0 });

// no pending match and no local copy → a genuinely new message pushes.
res = P.resolveUserEcho(null, msgs, { type: 'user', text: 'brand new', ts: NOW / 1000 });
eq('no match → push', res, { kind: 'push' });

// THE TS WINDOW: an echo older/newer than 2 minutes from the recorded
// send does NOT consume the pending entry (stale ledger from a dead
// turn) — falls through (here: to push, nothing local matches).
pend = [{ text: 'hello', ts: NOW, mi: 0 }];
res = P.resolveUserEcho(pend,
  [{ role: 'user', text: 'hello', ts: NOW - 600000 }], // echoed long ago, not local
  { type: 'user', text: 'hello', ts: (NOW + 400000) / 1000 });
eq('stale ts window → no pending match', res, { kind: 'push' });
// ...and a fresh echo within the window does.
pend = [{ text: 'hello', ts: NOW, mi: 0 }];
res = P.resolveUserEcho(pend,
  [{ role: 'user', text: 'hello', local: true, ts: NOW }],
  { type: 'user', text: 'hello', ts: (NOW + 90000) / 1000 });
eq('ts window inside → stamp', res, { kind: 'stamp', mi: 0, pend: 0 });
// no event ts → the window is skipped (text-only match).
res = P.resolveUserEcho([{ text: 'hi', ts: 0, mi: 0 }],
  [{ role: 'user', text: 'hi', local: true, ts: 5 }],
  { type: 'user', text: 'hi' });
eq('no ev.ts → text-only pending match', res, { kind: 'stamp', mi: 0, pend: 0 });

// several pending entries: the FIRST text+window match wins and its
// index is reported so the handler can splice exactly that entry.
pend = [
  { text: 'one', ts: NOW - 5000, mi: 0 },
  { text: 'two', ts: NOW, mi: 1 }
];
msgs = [
  { role: 'user', text: 'one', local: true, ts: NOW - 5000 },
  { role: 'user', text: 'two', local: true, ts: NOW }
];
res = P.resolveUserEcho(pend, msgs, { type: 'user', text: 'two', ts: NOW / 1000 });
eq('second pending entry matched by index', res, { kind: 'stamp', mi: 1, pend: 1 });

// the classic LAST-message case (the old code's only path) still stamps.
msgs = [{ role: 'user', text: 'hello', local: true, ts: NOW }];
res = P.resolveUserEcho(null, msgs, { type: 'user', text: 'hello' });
eq('last-message case stamps', res, { kind: 'stamp', mi: 0, pend: -1 });

// ── 2b. resolveUserEcho: the tail-scan fallback ─────────────────────
// a local copy within the trailing 6 (but NOT last, and no pending
// ledger — e.g. the ledger was pruned at a terminal) still stamps.
msgs = [
  { role: 'user', text: 'q1', ts: 1 },
  { role: 'assistant', text: 'a1', complete: true },
  { role: 'user', text: 'hello', local: true, ts: NOW },
  { role: 'thinking', text: 'x' },
  { role: 'assistant', text: 'y', complete: false }
];
res = P.resolveUserEcho(null, msgs, { type: 'user', text: 'hello' });
eq('tail-scan finds non-last local copy', res, { kind: 'stamp', mi: 2, pend: -1 });

// the 6th message back is still inside the window (5 messages follow it).
res = P.resolveUserEcho(null,
  [
    { role: 'user', text: 'far', ts: 1 },
    { role: 'user', text: 'hello', local: true, ts: 2 },
    { role: 'user', text: 'm1' }, { role: 'user', text: 'm2' },
    { role: 'user', text: 'm3' }, { role: 'user', text: 'm4' },
    { role: 'assistant', text: 'm5' }
  ],
  { type: 'user', text: 'hello' });
eq('exactly-6-back still scanned', res, { kind: 'stamp', mi: 1, pend: -1 });

// 7 back → outside the window → push (belt: the adjacent-dup pass owns
// the deep cases).
res = P.resolveUserEcho(null,
  [
    { role: 'user', text: 'hello', local: true, ts: 2 },
    { role: 'user', text: 'm1' }, { role: 'user', text: 'm2' },
    { role: 'user', text: 'm3' }, { role: 'user', text: 'm4' },
    { role: 'user', text: 'm5' }, { role: 'user', text: 'm6' },
    { role: 'assistant', text: 'm7' }
  ],
  { type: 'user', text: 'hello' });
eq('7-back is outside the tail window → push', res, { kind: 'push' });

// an ALREADY-STAMPED copy (ei set — e.g. the PM path stamps via POST)
// is not re-stamped by the tail scan → push (the id-dedupe owns that
// case on the wire anyway).
res = P.resolveUserEcho(null,
  [{ role: 'user', text: 'hello', local: true, ei: 7, ts: NOW }],
  { type: 'user', text: 'hello' });
eq('ei-stamped copy not tail-matched', res, { kind: 'push' });

// a non-local (replayed) copy never matches → push.
res = P.resolveUserEcho(null,
  [{ role: 'user', text: 'hello', ts: NOW }],
  { type: 'user', text: 'hello' });
eq('non-local copy not matched', res, { kind: 'push' });

// empty text / empty state never match anything.
eq('empty text pushes', P.resolveUserEcho(null, [{ role: 'user', text: '', local: true }], { type: 'user', text: '' }), { kind: 'push' });
eq('no messages pushes', P.resolveUserEcho(null, [], { type: 'user', text: 'x' }), { kind: 'push' });
eq('null messages push safely', P.resolveUserEcho(null, null, { type: 'user', text: 'x' }), { kind: 'push' });

// ── 2c. dropAdjacentUserDupes: the reconnect pass ───────────────────
// echoed twin FIRST, orphan local copy SECOND → the local one drops.
var cleaned = P.dropAdjacentUserDupes([
  { role: 'user', text: 'hi', ei: 10, ts: 1 },
  { role: 'user', text: 'hi', local: true, ts: 2 },
  { role: 'assistant', text: 'tail' }
]);
eq('right-side orphan drops', cleaned, [
  { role: 'user', text: 'hi', ei: 10, ts: 1 },
  { role: 'assistant', text: 'tail' }
]);

// orphan FIRST, echoed twin SECOND → the local one still drops.
cleaned = P.dropAdjacentUserDupes([
  { role: 'user', text: 'hi', local: true, ts: 2 },
  { role: 'user', text: 'hi', ei: 11, ts: 3 }
]);
eq('left-side orphan drops', cleaned, [{ role: 'user', text: 'hi', ei: 11, ts: 3 }]);

// a legit double-send (both echoed) survives — the log keeps history.
ok('both-ei pair survives', P.dropAdjacentUserDupes([
  { role: 'user', text: 'continue', ei: 1 }, { role: 'user', text: 'continue', ei: 2 }
]) === null);

// both local (two optimistic sends, no echoes yet) — nothing to decide.
ok('both-local pair survives', P.dropAdjacentUserDupes([
  { role: 'user', text: 'hi', local: true }, { role: 'user', text: 'hi', local: true }
]) === null);

// non-adjacent / different text / short lists never match.
ok('non-adjacent survives', P.dropAdjacentUserDupes([
  { role: 'user', text: 'hi', local: true }, { role: 'assistant', text: 'x' },
  { role: 'user', text: 'hi', ei: 9 }
]) === null);
ok('different text survives', P.dropAdjacentUserDupes([
  { role: 'user', text: 'a', ei: 1 }, { role: 'user', text: 'b', local: true }
]) === null);
ok('singleton survives', P.dropAdjacentUserDupes([{ role: 'user', text: 'a', local: true }]) === null);
ok('empty survives', P.dropAdjacentUserDupes([]) === null);
ok('null survives', P.dropAdjacentUserDupes(null) === null);

// ONE drop per call (the caller may re-run the pass).
cleaned = P.dropAdjacentUserDupes([
  { role: 'user', text: 'hi', ei: 10 },
  { role: 'user', text: 'hi', local: true },
  { role: 'user', text: 'hi', local: true }
]);
eq('one drop per call (right pair first)', cleaned, [
  { role: 'user', text: 'hi', ei: 10 },
  { role: 'user', text: 'hi', local: true }
]);
// a re-run cleans the remaining orphan.
eq('re-run drops the second orphan', P.dropAdjacentUserDupes(cleaned), [
  { role: 'user', text: 'hi', ei: 10 }
]);

// the input array is never mutated (pure — the state swap is the caller's).
var orig = [
  { role: 'user', text: 'hi', ei: 10 },
  { role: 'user', text: 'hi', local: true }
];
P.dropAdjacentUserDupes(orig);
eq('input not mutated', orig.length, 2);
ok('input keeps its local flag', orig[1].local === true);

// ── 2d. the draft guard (CAUSE #4) ──────────────────────────────────
// pure core: within 800ms of a clear → stale; after → allowed.
ok('stale at +0ms', P.draftSaveStaleMs(1000, 1000) === true);
ok('stale at +799ms', P.draftSaveStaleMs(1000, 1799) === true);
ok('allowed at +800ms', P.draftSaveStaleMs(1000, 1800) === false);
ok('allowed at +5s', P.draftSaveStaleMs(1000, 6000) === false);
ok('never-cleared map entry (0) is allowed late', P.draftSaveStaleMs(0, 999999) === false);

// integration through the real saveDraftLS/clearDraftLS (stubbed
// localStorage + a controlled Date.now — the debounce timer is real).
var realNow = Date.now.bind(Date);
var clock = 1700000000000;
Date.now = function () { return clock; };
var SID = 'chat-1';
try {
  // a normal save persists through the 250ms debounce.
  P.saveDraftLS(SID, 'typed draft');
  await sleep(400); // real time for the debounce timer
  ok('normal save persists', global.localStorage.getItem('doomalay.chatdraft.v1').indexOf('typed draft') >= 0);

  // the send-clear wipes it…
  P.clearDraftLS(SID);
  ok('clear wipes the map', global.localStorage.getItem('doomalay.chatdraft.v1').indexOf(SID) < 0);

  // …and the LATE IME 'input' event (within 800ms) is skipped entirely.
  clock += 100;
  P.saveDraftLS(SID, 'stale IME text');
  await sleep(400);
  ok('late-IME save skipped (<800ms)', global.localStorage.getItem('doomalay.chatdraft.v1').indexOf('stale IME text') < 0);

  // real typing AFTER the window re-saves normally.
  clock += 900;
  P.saveDraftLS(SID, 'fresh typing');
  await sleep(400);
  ok('post-window save persists', global.localStorage.getItem('doomalay.chatdraft.v1').indexOf('fresh typing') >= 0);
} finally {
  Date.now = realNow;
}

// ══ 3. chatclient.js — the replay tag + turnActive ══════════════════
require(path.join(WEB, 'chatclient.js')); // sets window.ChatClient on the stub
var CC = global.window.ChatClient;
eq('ChatClient exposed on window', typeof CC, 'function');

var client = new CC('', 'sess-1', '');
eq('fresh client not replaying', client.isReplaying(), false);

// connect → the fake socket; drive onopen + a back-to-back burst.
client.connect();
var sock = wsInstances[wsInstances.length - 1];
ok('connect opened a socket', !!sock);
sock.readyState = FakeWS.OPEN;
sock.onopen();
eq('open state reported', client.state, 'open');

var seen = [];
client.onEvent = function (ev) { seen.push(ev); };
function deliver(obj) { sock.onmessage({ data: JSON.stringify(obj) }); }

deliver({ type: 'assistant_delta', text: 'a', i: 1, seq: 1 });
deliver({ type: 'thinking', text: 'b', i: 2, seq: 2 });
deliver({ type: 'assistant_delta', text: 'c', i: 3, seq: 3 });
eq('burst events are tagged _replay', [seen[0]._replay, seen[1]._replay, seen[2]._replay], [true, true, true]);
eq('burst still tracked by lastSeq', client.lastSeq, 3);
eq('client reports replaying during burst', client.isReplaying(), true);

// a >1.2s quiet gap ends the drain — the NEXT event is live (untagged).
// (clock runs AHEAD of the real clock so the delta math is exact)
var realNow2 = Date.now.bind(Date);
var clock2 = Date.now() + 100000;
Date.now = function () { return clock2; };
try {
  clock2 += 2000; // 2s since the last arrival
  deliver({ type: 'assistant_delta', text: 'live', i: 4, seq: 4 });
  eq('post-quiet event is LIVE (no _replay)', seen[3]._replay, undefined);
  eq('client no longer replaying', client.isReplaying(), false);

  // and events keep flowing untagged afterwards.
  clock2 += 50;
  deliver({ type: 'assistant_delta', text: 'live2', i: 5, seq: 5 });
  eq('subsequent events stay live', seen[4]._replay, undefined);
} finally {
  Date.now = realNow2;
}

// close ends any in-flight drain (the tag must not leak into a later
// live phase by accident of stale state)…
sock.readyState = FakeWS.CLOSED;
sock.onclose({});
eq('close ends the drain', client.isReplaying(), false);

// …and a reconnect re-arms it (the new socket replays its gap first).
client.connect();
var sock2 = wsInstances[wsInstances.length - 1];
sock2.readyState = FakeWS.OPEN;
sock2.onopen(); // fires a synthetic ws_state 'open' into `seen` too
eq('reconnect re-arms the tag', client.isReplaying(), true);
sock2.onmessage({ data: JSON.stringify({ type: 'assistant_delta', text: 'gap', i: 6, seq: 6 }) });
ok('gap event tagged', seen[seen.length - 1]._replay === true);
sock2.readyState = FakeWS.CLOSED;
sock2.onclose({});

// connect latency must never pre-end the drain: the quiet-gap clock
// starts at the FIRST arrival, so however long the open took, the
// backlog's first event is still tagged (a fresh open's old deltas
// must never reach the panel untagged — that would re-arm streaming).
var client4 = new CC('', 'sess-4', '');
var realNow3 = Date.now.bind(Date);
var clock3 = Date.now() + 500000;
Date.now = function () { return clock3; };
try {
  client4.connect();
  var sock6 = wsInstances[wsInstances.length - 1];
  clock3 += 5000; // 5s of "connect latency"
  sock6.readyState = FakeWS.OPEN;
  sock6.onopen();
  var first = [];
  client4.onEvent = function (ev) { first.push(ev); };
  clock3 += 100; // the event lands 5.1s after connect() armed the tag
  sock6.onmessage({ data: JSON.stringify({ type: 'thinking', text: 'x', i: 9, seq: 9 }) });
  ok('first arrival always tagged despite connect latency', first[0]._replay === true);
  clock3 += 100;
  sock6.onmessage({ data: JSON.stringify({ type: 'thinking', text: 'y', i: 10, seq: 10 }) });
  ok('burst continues tagged', first[1]._replay === true);
} finally {
  Date.now = realNow3;
}

// turnActive: only send() (and now the PM turn) sets it; stop clears.
var client2 = new CC('', 'sess-2', '');
eq('fresh turnActive false', client2.turnActive, false);
client2.send('hello', {});
eq('send arms turnActive', client2.turnActive, true);
client2.stop();
eq('stop clears turnActive', client2.turnActive, false);
// status idle/error clears it (the client's own onmessage rule).
client2.send('again', {});
var sock4 = wsInstances[wsInstances.length - 1];
sock4.readyState = FakeWS.OPEN;
sock4.onopen();
sock4.onmessage({ data: JSON.stringify({ type: 'status', state: 'idle' }) });
eq('status idle clears turnActive', client2.turnActive, false);

// send while the socket is CLOSED queues + kicks a connect (the dead-
// client path the panel's reviveClient relies on).
var client3 = new CC('', 'sess-3', '');
var before = wsInstances.length;
client3.send('queued', {});
ok('dead-socket send kicks a connect', wsInstances.length === before + 1);
ok('message queued for the new socket', client3._eventQueue.length === 1);
var sock5 = wsInstances[wsInstances.length - 1];
sock5.readyState = FakeWS.OPEN;
sock5.onopen();
ok('queue flushed on open', sock5.sent.indexOf(JSON.stringify({ type: 'send', message: 'queued' })) >= 0);

// ── verdict ─────────────────────────────────────────────────────────
if (fails.length) {
  console.log('SELF-TEST FAILED (' + fails.length + '/' + n + '):');
  for (var f = 0; f < fails.length; f++) console.log('  ✗ ' + fails[f]);
  process.exit(1);
}
console.log('SELF-TEST OK — ' + n + ' assertions (interrupt hardening: echo dedupe, tail-scan, adjacent-dup pass, draft guard, replay tag, turnActive)');
process.exit(0);

})().catch(function (e) {
  console.log('SELF-TEST FAILED (harness error): ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
