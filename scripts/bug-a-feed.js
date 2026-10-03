#!/usr/bin/env node
// bug-a-feed.js — feeds the CAPTURED live frames (bug-live-driver.mjs) through
// the ported handleEvent state machine to print the exact transcript the UI
// builds, then simulates the NEXT TURN on the same state.
'use strict';
var path = require('path');
var fs = require('fs');
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');
var sandboxLS = {};
global.localStorage = { getItem: function (k) { return sandboxLS.hasOwnProperty(k) ? sandboxLS[k] : null; }, setItem: function (k, v) { sandboxLS[k] = String(v); }, removeItem: function (k) { delete sandboxLS[k]; } };
global.window = { ChatTypes: { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } }, addEventListener: function () {} };
global.document = { addEventListener: function () {}, createElement: function () { return { style: {} }; } };
global.location = { protocol: 'http:', host: 'test' };
function FakeWS() {}
FakeWS.prototype.send = function () {};
global.WebSocket = FakeWS;
var P = require(path.join(WEB, 'chatpanel.js'));

function newState() { return { messages: [], lastEventI: 0, isStreaming: false }; }

function handleEvent(ev, state) {
  var type = ev.type;
  if (ev.i !== undefined && ev.i !== null && !isNaN(ev.i)) {
    if (ev.i <= (state.lastEventI || 0)) return;
    state.lastEventI = ev.i;
  }
  if (type === 'assistant_delta' || type === 'assistant_complete') {
    if (ev.text) {
      var last = state.messages[state.messages.length - 1];
      if (!last || last.role !== 'assistant' || last.complete) {
        last = { role: 'assistant', text: '', complete: false, streaming: true, ts: 1 };
        if (ev.i) last.ei = ev.i;
        state.messages.push(last);
      }
      last.text += ev.text;
    }
  } else if (type === 'assistant') {
    var dec = P.roundFlowApply(state.messages, ev, 'assistant');
    if (dec.action === 'push') {
      var full = { role: 'assistant', text: ev.text, complete: true, ts: 1 };
      if (ev.i) full.ei = ev.i;
      state.messages.push(full);
    } else if (dec.action === 'finalize') {
      var fin = state.messages[dec.index];
      if (fin && !fin.complete) { fin.complete = true; fin.streaming = false; }
    }
  } else if (type === 'round_end') {
    var rdec = P.roundFlowApply(state.messages, { type: 'round_end' }, 'round_end');
    if (rdec.action === 'finalize') {
      var rfin = state.messages[rdec.index];
      rfin.complete = true; rfin.streaming = false;
    }
  } else if (type === 'thinking') {
    var lastThink = state.messages[state.messages.length - 1];
    if (!lastThink || lastThink.role !== 'thinking') {
      lastThink = { role: 'thinking', text: '', streaming: true, startedAt: 1, ts: 1 };
      if (ev.i) lastThink.ei = ev.i;
      state.messages.push(lastThink);
    }
    lastThink.text += ev.text;
  } else if (type === 'tool_use' || type === 'tool_result') {
    var pay = ev;
    if ((!pay.name || pay.summary === undefined) && pay.text) {
      try { pay = JSON.parse(pay.text); } catch (e) {}
    }
    state.messages.push({ role: 'tool', text: (pay.summary || pay.name || ''), tool: !ev.result, result: !!ev.result, payload: pay, ts: 1 });
  } else if (type === 'status') {
    if (ev.state === 'idle' || ev.state === 'error') {
      state.isStreaming = false;
      for (var i = 0; i < state.messages.length; i++) {
        var m = state.messages[i];
        if (m && m.streaming) { m.streaming = false; if (m.role === 'assistant') m.complete = true; }
      }
    }
  }
}

function dump(label, state) {
  console.log('\n== ' + label + ' ==');
  state.messages.forEach(function (m, i) {
    var d = i + ': ' + m.role.toUpperCase();
    if (m.role === 'assistant') d += ' text=' + JSON.stringify(m.text.slice(0, 48)) + (m.complete ? ' [DONE]' : ' [OPEN!!]');
    if (m.role === 'thinking') d += ' (' + (m.text || '').length + ' chars)';
    if (m.role === 'tool') d += ' (' + (m.result ? 'result' : 'use') + ') ' + JSON.stringify((m.text || '').slice(0, 24));
    console.log('   ' + d);
  });
}

var which = process.argv[2] || 'live';
var file = which === 'replay' ? '/tmp/bug-a-replay.json' : '/tmp/bug-a-frames.json';
var frames = JSON.parse(fs.readFileSync(file, 'utf8'));
var state = newState();
frames.forEach(function (f) { handleEvent(f, state); });
dump('DIRECT PATH — ' + which.toUpperCase() + ' frames → UI transcript', state);

// simulate the NEXT TURN on the same state (deltas only, brain-style)
var seq = 1000;
function nextEv(type, extra) { var e = extra || {}; e.type = type; e.i = seq++; return e; }
[
  nextEv('user', { text: 'again' }),
  nextEv('assistant_delta', { text: 'Second turn answer.' }),
  nextEv('status', { state: 'idle' }),
].forEach(function (e) { handleEvent(e, state); });
dump('…after the NEXT simple turn (no tools)', state);
