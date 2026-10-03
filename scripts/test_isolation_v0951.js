#!/usr/bin/env node
// test_isolation_v0951.js — v0.95.1 THE ISOLATION WAVE pins (node-side).
// The live leak: two chats on the same provider — one chat's turn appeared
// inside the other's transcript ("Hello! I'm Nemotron" in scooby/deepseek's
// log). The client-side half of the fix is the RUNTIME DUPLICATE-BIND HEAL:
// whenever a chat state CLAIMS a session, every other state holding that
// session is unbound (client closed, session cleared) — two chats can never
// write into one event log again. (The engine-side rejection guard is
// pinned in Go: isolation_v0951_test.go.)
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

require(path.join(WEB, 'chatclient.js'));
var P = require(path.join(WEB, 'chatpanel.js'));

var pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label); }
}

console.log('v0.95.1 isolation pins:');

// ── 1. THE HEAL: a claim unbinds every other state on that session ──
(function () {
  var states = P.states();
  var closedA = [];
  var a = { id: 'A', sessionId: 'sessX', _icon: { sessionId: 'sessX', save: function () { closedA.push('A'); } }, client: { sessionId: 'sessX', close: function () { closedA.push('clientA'); } } };
  var b = { id: 'B', sessionId: 'sessX', _icon: { sessionId: 'sessX', save: function () {} }, client: { sessionId: 'sessX', close: function () {} } };
  var c = { id: 'C', sessionId: 'sessY', _icon: { sessionId: 'sessY', save: function () {} }, client: null };
  states['A'] = a; states['B'] = b; states['C'] = c;

  P.healDuplicateSessionBinds(b, 'sessX');

  ok(a.sessionId === null, 'the other state on sessX is unbound');
  ok(a.client === null, 'the other state client is closed + dropped');
  ok(a._icon.sessionId === '', 'the other icon is unbound');
  ok(closedA.indexOf('clientA') >= 0, 'the stale client was closed (not leaked)');
  ok(b.sessionId === 'sessX', 'the claimer keeps the session');
  ok(c.sessionId === 'sessY', 'an unrelated session is untouched');
  delete states['A']; delete states['B']; delete states['C'];
})();

// ── 2. NO-OP safety: empty session, self, absent states ──
(function () {
  var states = P.states();
  var a = { id: 'A', sessionId: 'sessZ', _icon: { sessionId: 'sessZ', save: function () { throw new Error('must not save'); } }, client: null };
  states['A'] = a;
  P.healDuplicateSessionBinds(a, 'sessZ'); // self — untouched
  ok(a.sessionId === 'sessZ', 'the claimer itself is never unbound');
  P.healDuplicateSessionBinds({ id: 'B' }, ''); // empty sid — no crash
  ok(true, 'an empty session id is a safe no-op');
  delete states['A'];
})();

// ── 3. THE FRAME CONTRACT: send/stop/raw frames all carry session_id ──
(function () {
  var CC = window.ChatClient;
  var sent = [];
  var c = new CC('', 'sessQ', '');
  c.ws = { readyState: 1, send: function (m) { sent.push(JSON.parse(m)); } };
  c.send('hello', { model: 'nvidia/m1', provider: 'nvidia' });
  ok(sent.length === 1 && sent[0].session_id === 'sessQ', 'send frames carry session_id');
  ok(sent[0].type === 'send' && sent[0].message === 'hello', 'send frame shape intact');

  c.stop();
  var stopFrame = sent[sent.length - 1];
  ok(stopFrame.type === 'stop' && stopFrame.session_id === 'sessQ', 'stop frames carry session_id');

  c.sendRaw({ type: 'hide', ids: [1, 2] });
  var hideFrame = sent[sent.length - 1];
  ok(hideFrame.type === 'hide' && hideFrame.session_id === 'sessQ', 'raw control frames carry session_id');
})();

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
