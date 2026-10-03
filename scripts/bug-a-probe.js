#!/usr/bin/env node
// bug-a-probe.js — adversarial drive of chatpanel's handleEvent state machine
// (branches ported VERBATIM from engine/internal/server/web/chatpanel.js) to
// find the event order that breaks the "one bubble per round segment" flow.
'use strict';
var path = require('path');
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

// ── the ported handleEvent core (assistant/thinking/tool/status paths) ──
function newState() { return { messages: [], lastEventI: 0, isStreaming: false }; }

function handleEvent(ev, state) {
  var type = ev.type;
  if (ev.i !== undefined && ev.i !== null && !isNaN(ev.i)) {
    if (ev.i <= (state.lastEventI || 0)) return 'DEDUPED';
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
    state.messages.push({ role: 'tool', text: (ev.summary || ev.name || ''), tool: !ev.result, result: !!ev.result, payload: ev, ts: 1 });
  } else if (type === 'status') {
    if (ev.state === 'idle' || ev.state === 'error') {
      state.isStreaming = false;
      // completeAllStreaming
      for (var i = 0; i < state.messages.length; i++) {
        var m = state.messages[i];
        if (m && m.streaming) { m.streaming = false; if (m.role === 'assistant') m.complete = true; }
      }
    }
  }
  return 'OK';
}

var seq = 100;
function ev(type, extra) { var e = extra || {}; e.type = type; e.i = seq++; return e; }

function run(name, events, opts) {
  var state = newState();
  state.messages.push({ role: 'user', text: 'go', complete: true });
  events.forEach(function (e) { handleEvent(e, state); });
  var roles = state.messages.map(function (m, i) {
    return i + ':' + (m.role === 'assistant' ? 'A(' + JSON.stringify(m.text).slice(0, 60) + (m.complete ? ',DONE)' : ',OPEN)') :
      m.role === 'thinking' ? 'T(' + (m.text || '').length + 'ch)' :
      m.role === 'tool' ? (m.result ? 'RES' : 'TOOL') : m.role.toUpperCase());
  });
  console.log('\n== ' + name + ' ==');
  roles.forEach(function (r) { console.log('   ' + r); });
  return state;
}

// S1: direct/native LIVE order (chat.go: deltas → assistant(round) → round_end → tools → deltas → assistant(final) → idle)
run('S1 direct-native live', [
  ev('status', { state: 'running' }),
  ev('thinking', { text: 'hmm…' }),
  ev('assistant_delta', { text: 'Let me check the repo.' }),
  ev('assistant', { text: 'Let me check the repo.', round: true }),
  ev('round_end'),
  ev('tool_use', { name: 'workspace', summary: 'tree main' }),
  ev('tool_result', { name: 'workspace', summary: 'ok · 0.4s' }),
  ev('thinking', { text: 'now the answer…' }),
  ev('assistant_delta', { text: 'The repo has ' }),
  ev('assistant_delta', { text: '42 files.' }),
  ev('assistant', { text: 'The repo has 42 files.' }),
  ev('status', { state: 'idle' })
]);

// S2: brain LIVE order (no round_end, no assistant events — pure deltas)
run('S2 brain live (no round events)', [
  ev('status', { state: 'running' }),
  ev('thinking', { text: 'hmm…' }),
  ev('assistant_delta', { text: 'Let me check the repo.' }),
  ev('tool_use', { name: 'workspace', summary: 'tree main' }),
  ev('tool_result', { name: 'workspace', summary: 'ok' }),
  ev('thinking', { text: 'now…' }),
  ev('assistant_delta', { text: 'The repo has 42 files.' }),
  ev('status', { state: 'idle' })
]);

// S3: REPLAY of the direct-path persisted log (deltas + segments, same order)
run('S3 direct replay', [
  ev('thinking', { text: 'hmm…' }),
  ev('assistant_delta', { text: 'Let me check the repo.' }),
  ev('assistant', { text: 'Let me check the repo.', round: true }),
  ev('round_end'),
  ev('tool_use', { name: 'workspace', summary: 'tree main' }),
  ev('tool_result', { name: 'workspace', summary: 'ok' }),
  ev('assistant_delta', { text: 'The repo has 42 files.' }),
  ev('assistant', { text: 'The repo has 42 files.' }),
  ev('status', { state: 'idle' })
]);

// S4: THE MISMATCH — the round-segment 'assistant' event text differs from the
// open bubble (e.g. deltas coalesced differently, or the segment arrives late)
run('S4 segment event text mismatch (push while open)', [
  ev('assistant_delta', { text: 'Let me check the repo.' }),
  ev('assistant', { text: 'Let me check the repo. EXTRA', round: true }),
  ev('round_end'),
  ev('tool_use', { name: 'x', summary: 'y' }),
  ev('assistant_delta', { text: 'final answer' }),
  ev('status', { state: 'idle' })
]);

// S5: segments arrive AFTER the next round's deltas (server reordering /
// the buffered events channel flushes late)
run('S5 segment event AFTER next deltas', [
  ev('assistant_delta', { text: 'Let me check the repo.' }),
  ev('tool_use', { name: 'x', summary: 'y' }),
  ev('assistant', { text: 'Let me check the repo.', round: true }), // LATE
  ev('round_end'), // LATE — finalizes… WHICH bubble?
  ev('assistant_delta', { text: 'final answer' }),
  ev('status', { state: 'idle' })
]);

// S6: TWO reasoning-only rounds then final (kimi/nvidia shape): NO prose
// before the tool calls, thinking between rounds only
run('S6 reasoning-only rounds', [
  ev('thinking', { text: 'think1' }),
  ev('round_end'),            // engine emits round_end only when roundHadContent… but ACTION path emits it on parse
  ev('tool_use', { name: 'x', summary: 'y' }),
  ev('tool_result', { name: 'x', summary: 'ok' }),
  ev('thinking', { text: 'think2' }),
  ev('tool_use', { name: 'x', summary: 'z' }),
  ev('tool_result', { name: 'x', summary: 'ok' }),
  ev('thinking', { text: 'think3' }),
  ev('assistant_delta', { text: 'final answer' }),
  ev('status', { state: 'idle' })
]);

// S7: the ACTION-path live order where the preamble hold FLUSHED mid-round
// (>700B or 2+ complete lines) then the ACTION line parsed: deltas → deltas
// (final mode) → round_end → tool pills
run('S7 ACTION path preamble flush', [
  ev('assistant_delta', { text: 'I will do several things now.\n' }),
  ev('assistant_delta', { text: 'First, let me gather data.\n' }),   // 2 complete lines → flush() = mode 1
  ev('round_end'),   // the leak backstop (mode==1 + actions parsed + emitted)
  ev('tool_use', { name: 'web_search', summary: 'q' }),
  ev('tool_result', { name: 'web_search', summary: 'ok' }),
  ev('assistant_delta', { text: 'final answer' }),
  ev('status', { state: 'idle' })
]);

// S8 (added by the bug-A investigation): THE BRAIN-PATH NUDGE SHAPE —
// narration streams, the round proves reasoning-only (no tool call, no
// round_end — the brain path has NO segment events), the answer-force nudge
// streams MORE deltas. No pill separates them → the nudge text GLOMS into
// the first bubble (the "one box at the top" symptom).
run('S8 brain nudge glom (no pills between segments)', [
  ev('status', { state: 'running' }),
  ev('assistant_delta', { text: 'I will compute that now.\n' }),
  ev('assistant_delta', { text: 'Let me gather the data first.' }),
  // (reasoning-only round — dropped by litellm; the nudge round:)
  ev('assistant_delta', { text: 'The result is 22.' }),
  ev('tool_use', { name: 'calculator', summary: '' }),
  ev('tool_result', { name: 'calculator', summary: '' }),
  ev('assistant_delta', { text: 'Final answer: 22.' }),
  ev('status', { state: 'idle' })
]);

// S9: THE POST-TURN PILL BURST (the old hook-drift shape — every tool pill
// lands AFTER the whole turn's deltas): one top bubble gloms ALL segments,
// then the tool spam below = the user's literal report.
run('S9 all pills at the end (hook drift / post-turn walk)', [
  ev('status', { state: 'running' }),
  ev('assistant_delta', { text: 'Let me check the repo. ' }),
  ev('assistant_delta', { text: 'Now the files. ' }),
  ev('assistant_delta', { text: 'The repo has 42 files.' }),
  ev('tool_use', { name: 'workspace', summary: 'tree' }),
  ev('tool_result', { name: 'workspace', summary: 'ok' }),
  ev('tool_use', { name: 'workspace', summary: 'read' }),
  ev('tool_result', { name: 'workspace', summary: 'ok' }),
  ev('tool_use', { name: 'workspace', summary: 'grep' }),
  ev('tool_result', { name: 'workspace', summary: 'ok' }),
  ev('status', { state: 'idle' })
]);
