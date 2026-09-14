// pmsdk.js — the PrivateMode chat bridge (v0.15).
//
// WHY THIS EXISTS: PrivateMode's chat API requires their end-to-end
// encryption protocol — remote attestation of the deployment + an
// AES-GCM session secret, all implemented in the official SDK's WASM
// module. The Go engine cannot speak that protocol (PM's docs route
// non-JS clients through a local Docker proxy, which Android can't
// run). The WebView IS a JavaScript runtime, so PM chat turns run HERE
// through the vendored SDK — the same architecture as PM's own web app.
// Their API sends `access-control-allow-origin: *`, so the WASM's
// cross-origin fetches succeed from http://127.0.0.1:8080.
//
// Chat turns driven by this bridge:
//   1. build conversation history (last 40 messages — same window as
//      the engine's buildHistory),
//   2. stream through the encrypted channel, feeding deltas back to
//      the ChatPanel's event pipeline,
//   3. persist user/assistant/status events via the engine's
//      POST /api/sessions/{id}/events so replay + reload stay exact.
//
// Exposed: window.PMBridge = { streamChat(opts) → Promise<{text,usage}> }

import { PrivatemodeCore } from './privatemode-ai.js';

var core = null;         // the PrivatemodeCore instance
var coreKey = null;      // the key core was constructed with (re-init on change)
var verifyPromise = null;

function pmError(message) {
  var e = new Error(message);
  e.isPM = true;
  return e;
}

// Shorten the SDK's raw attestation trace into the actionable essence:
// "…doing attest request: Unauthorized {"error":{"message":"Invalid API key"…"
// → "PrivateMode rejected the key: Invalid API key".
function friendlyPMError(raw) {
  var msg = String(raw || '');
  var m = msg.match(/"message"\s*:\s*"([^"]+)"/);
  if (m && /invalid|unauthorized|auth/i.test(m[1] + msg)) {
    return 'PrivateMode rejected the key — ' + m[1] + '. Re-copy it from portal.privatemode.ai/api-keys and Save again.';
  }
  if (msg.length > 200) msg = msg.slice(0, 200) + '…';
  return msg;
}

async function getCore() {
  var res = await fetch('/api/keys/value?env_var=PRIVATEMODEAI_API_KEY');
  if (!res.ok) throw pmError('engine key endpoint failed (' + res.status + ')');
  var data = await res.json();
  if (!data || !data.has_key) {
    throw pmError('No PrivateMode API key saved yet — connect the provider first (+ Model → Connect Cloud Provider).');
  }
  if (core && coreKey === data.key) return core;
  if (core && typeof core.close === 'function') {
    try { core.close(); } catch (e) { /* already closed */ }
  }
  core = new PrivatemodeCore({
    apiKey: data.key,
    // The WebView is the trusted app runtime (keys are already stored
    // on this device; PM's own web app holds the key client-side too).
    dangerouslyAllowBrowser: true,
    browserWasmURL: '/vendor/pm/privatemode.wasm'
  });
  coreKey = data.key;
  verifyPromise = null;
  return core;
}

function ensureVerified(c) {
  if (!verifyPromise) {
    // v0.16 FIX: the SDK contract is verify() THEN refreshSecret() —
    // verify() alone leaves the encryption secret unset and every chat
    // turn dies with "no secret available: call Initialize() and
    // UpdateSecret() first". refreshSecret() establishes the AES-GCM
    // session secret; retryWithSecretRefresh keeps it fresh mid-stream.
    // v0.16b: PM's /v1/attest endpoint is intermittently slow ("context
    // deadline exceeded" — observed live in 1-of-3 fresh boots) — retry
    // the whole verify+secret handshake up to 3× with backoff so a
    // transient attest blip never kills a chat turn.
    verifyPromise = (async () => {
      var lastErr = null;
      for (var attempt = 1; attempt <= 3; attempt++) {
        try {
          await c.verify();
          await c.refreshSecret();
          return true;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
        }
      }
      throw lastErr;
    })().catch(function (e) {
      verifyPromise = null; // a failed attestation must be retried next turn
      throw e;
    });
  }
  return verifyPromise;
}

// streamChat(opts):
//   opts.model     — PM model id (e.g. "kimi-k2.6")
//   opts.messages  — [{role, content}] full conversation
//   opts.signal    — AbortSignal (the Stop button)
//   opts.onDelta   — (text) per assistant delta
//   opts.onThinking— (text) per reasoning delta
//   opts.onStatus  — (state) running / idle / error progress hints
//   opts.tools     — true: enable the web ReAct loop (v0.16)
//   opts.onTool    — (toolEvent) {name, summary, result, sources} for the UI
// Returns { text, usage, sources? }.
async function streamChat(opts) {
  opts.onStatus && opts.onStatus('running');
  var c;
  try {
    c = await getCore();
    await ensureVerified(c);
  } catch (e) {
    opts.onStatus && opts.onStatus('error');
    throw pmError('Secure channel: ' + friendlyPMError(e && e.message ? e.message : e));
  }

  if (opts.tools) {
    return runToolLoop(c, opts);
  }
  return roundTrip(c, opts, opts.messages, null);
}

// ── v0.16: the browser-side ReAct loop (mirrors the Go pipeline) ──────
//
// PM chats run in the WebView, so the engine's Go tool loop can't drive
// them. Instead the ENGINE becomes the tool server (/api/tools/websearch
// + /api/tools/webfetch, same-origin) and this loop does what chat.go
// does: inject the ACTION protocol, watch the model's reply for an
// ACTION line, run the tool, feed back OBSERVATION, repeat (max 6).
var PM_TOOLS_PROTOCOL = [
  'You have access to web tools. To use one, output EXACTLY ONE line as your ENTIRE reply, then stop:',
  'ACTION: web_search {"query": "<search terms>"}',
  'or',
  'ACTION: web_fetch {"url": "<https url>"}',
  'After each ACTION you will receive:',
  'OBSERVATION:',
  '<tool output>',
  'Use observations to answer. When you have enough information, write your FINAL answer as a normal reply (no ACTION line) with sources cited inline as [1], [2] matching the search result numbering. Never fabricate URLs.'
].join('\n');

async function runToolLoop(c, opts) {
  var messages = [{ role: 'system', content: PM_TOOLS_PROTOCOL }].concat(opts.messages);
  var allSources = [];
  var finalText = '';
  var usage = null;
  var MAX_ROUNDS = 6;

  for (var round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal && opts.signal.aborted) {
      return { text: finalText, usage: usage, aborted: true, sources: allSources };
    }
    // ALL ReAct rounds are silent — an ACTION line must never render as
    // the assistant's answer. Progress shows via onThinking (live) + the
    // onTool chips; the final answer streams once it's confirmed clean.
    var res = await roundTrip(c, opts, messages, 'silent');
    usage = res.usage || usage;
    var reply = (res.text || '').trim();

    var m = reply.match(/^ACTION:\s*(web_search|web_fetch)\s*(\{[\s\S]*\})?\s*$/i);
    if (!m) {
      // FINAL answer — stream it now if it was held back, then done.
      if (res.held && reply) opts.onDelta && opts.onDelta(reply);
      finalText = reply;
      break;
    }
    var tool = m[1].toLowerCase();
    var arg = {};
    try { arg = m[2] ? JSON.parse(m[2]) : {}; } catch (e) { arg = {}; }

    try {
      if (tool === 'web_search') {
        var q = arg.query || String(arg.q || '');
        opts.onTool && opts.onTool({ name: 'web_search', summary: q });
        var r = await fetch('/api/tools/websearch?q=' + encodeURIComponent(q) + '&max=8');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var data = await r.json();
        var results = (data && data.results) || [];
        for (var i = 0; i < results.length; i++) {
          allSources.push({ title: results[i].title, url: results[i].url, snippet: results[i].snippet });
        }
        var fmt = results.map(function (s, j) {
          return '[' + (j + 1) + '] ' + s.title + '\n' + s.url + '\n' + (s.snippet || '');
        }).join('\n\n');
        opts.onTool && opts.onTool({ name: 'web_search', result: (results.length + ' results') + (results[0] ? ' — ' + results[0].title : ''), sources: results });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: 'OBSERVATION:\n' + (fmt || '(no results)') });
      } else {
        var u = arg.url || String(arg.u || '');
        opts.onTool && opts.onTool({ name: 'web_fetch', summary: u });
        var r2 = await fetch('/api/tools/webfetch?url=' + encodeURIComponent(u) + '&max=6000');
        if (!r2.ok) throw new Error('HTTP ' + r2.status);
        var d2 = await r2.json();
        opts.onTool && opts.onTool({ name: 'web_fetch', result: ((d2.text || '') + '').slice(0, 120) });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: 'OBSERVATION:\n' + ((d2 && d2.text) || '(empty page)') });
      }
    } catch (e) {
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: 'OBSERVATION:\n(tool error: ' + (e.message || e) + ' — try a different query or answer from what you have)' });
    }
  }

  if (round === MAX_ROUNDS && !finalText) {
    // Budget exhausted without a final answer — force one last plain round.
    messages.push({ role: 'user', content: 'Tool budget exhausted. Give your FINAL answer now from what you have (no ACTION line), citing sources as [n].' });
    var last = await roundTrip(c, opts, messages, null);
    finalText = (last.text || '').trim();
  }

  opts.onStatus && opts.onStatus('idle');
  return { text: finalText, usage: usage, sources: allSources };
}

// One PM streaming round. mode 'silent' holds deltas (ReAct probe rounds
// that may turn out to be ACTION lines) and returns the assembled text.
async function roundTrip(c, opts, messages, mode) {
  var full = '';
  var usage = null;
  var held = mode === 'silent';
  var body = {
    model: opts.model,
    messages: messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  try {
    var stream = await c.streamChatCompletions(body, { signal: opts.signal || undefined });
    for await (var chunk of stream) {
      var ch = chunk || {};
      if (ch.choices && ch.choices.length) {
        var d = ch.choices[0].delta || {};
        if (d.reasoning_content) { opts.onThinking && opts.onThinking(d.reasoning_content); }
        if (d.content) {
          full += d.content;
          if (!held) opts.onDelta && opts.onDelta(d.content);
        }
      }
      if (ch.usage) usage = ch.usage;
    }
    opts.onStatus && opts.onStatus('idle');
    return { text: full, usage: usage, held: held };
  } catch (e) {
    opts.onStatus && opts.onStatus('error');
    if (e && e.name === 'AbortError') return { text: full, usage: usage, aborted: true, held: held };
    throw pmError('PrivateMode: ' + friendlyPMError(e && e.message ? e.message : e));
  }
}

window.PMBridge = {
  streamChat: streamChat,
  available: function () { return typeof WebSocket !== 'undefined' && typeof WebAssembly !== 'undefined'; }
};
