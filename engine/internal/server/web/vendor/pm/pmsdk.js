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

  // v0.20: local tools ride EVERY PM turn through the unified loop (web
  // tools still gate on the toggle inside it) — same always-on local tool
  // set as the engine's own ReAct pipeline.
  return runToolLoop(c, opts);
}

// ── v0.20: the browser-side ReAct loop (mirrors the Go pipeline) ──────
//
// PM chats run in the WebView, so the engine's Go tool loop can't drive
// them. Instead the ENGINE becomes the tool server (/api/tools/* —
// same-origin) and this loop does what chat.go does: inject the ACTION
// protocol, watch the model's reply for an ACTION line, run the tool,
// feed back OBSERVATION, repeat (max 16 — deep tool chains are legal).
//
// v0.20: the LOCAL tool set (calculator/time/uuid/hash/json/…) rides
// EVERY PM turn through /api/tools/local — same Go implementations the
// engine's own loop uses. The web tools still gate on the toggle.
var PM_TOOLS_PROTOCOL = [
  'You have access to tools. To use one, output EXACTLY ONE line as your ENTIRE reply, then stop:',
  'ACTION: <tool> {<json arguments>}',
  'After each ACTION you will receive:',
  'OBSERVATION:',
  '<tool output>',
  'Use observations to answer. One tool per reply; chain tools across replies when a task needs several steps.',
  'When you have enough information, write your FINAL answer as a normal reply (no ACTION line). Never fabricate tool results.',
  '',
  'Local tools (run instantly on the device):',
  'ACTION: calculator {"expr": "2+2*10"} — arithmetic; + - * / % ^ ( ) and sqrt/ln/log/abs/round/floor/ceil/sin/cos/tan/exp, pi, e',
  'ACTION: time_now {"tz": "UTC"} — current date+time (IANA zone, "+HH:MM" offset, or UTC)',
  'ACTION: uuid {"count": 3} — generate UUIDv4 ids',
  'ACTION: random {"min": 1, "max": 100, "count": 1, "unique": true} — random integers',
  'ACTION: base64 {"mode": "encode|decode", "text": "..."} — base64 transform',
  'ACTION: hash {"algo": "md5|sha1|sha256", "text": "..."} — hex digest',
  'ACTION: json_tool {"mode": "format|validate|minify", "text": "..."} — JSON utilities',
  'ACTION: text_stats {"text": "..."} — chars/words/lines/sentences/bytes + reading time',
  'ACTION: url_encode {"mode": "encode|decode", "text": "..."} — percent encoding',
  'ACTION: regex_extract {"pattern": "...", "text": "...", "group": 0} — regex matches'
].join('\n');

var PM_WEB_TOOLS_PROTOCOL = [
  'You also have web tools (live internet):',
  'ACTION: web_search {"query": "<search terms>"}',
  'ACTION: web_fetch {"url": "<https url>"}',
  'Cite web sources inline as [1], [2] matching the search result numbering. Never fabricate URLs.'
].join('\n');

// v0.20: repair truncated tool-call JSON — models sometimes cut the
// closing brace/quote (observed live: `ACTION: web_search {"query": "cat
// diaper how to put on guide"` with no closing }). Append what's missing
// instead of losing the tool call.
function repairJSON(s) {
  if (typeof s !== 'string' || !s.trim().startsWith('{')) return s;
  var inStr = false, esc = false, depth = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  var out = s;
  if (inStr) out += '"';
  while (depth > 0) { out += '}'; depth--; }
  return out;
}

async function runToolLoop(c, opts) {
  var toolsOn = !!opts.tools;
  var system = opts.messages[0] && opts.messages[0].role === 'system'
    ? opts.messages[0].content + '\n\n' + PM_TOOLS_PROTOCOL + (toolsOn ? '\n\n' + PM_WEB_TOOLS_PROTOCOL : '')
    : PM_TOOLS_PROTOCOL + (toolsOn ? '\n\n' + PM_WEB_TOOLS_PROTOCOL : '');
  var messages = [{ role: 'system', content: system }].concat(
    opts.messages[0] && opts.messages[0].role === 'system' ? opts.messages.slice(1) : opts.messages);
  var allSources = [];
  var finalText = '';
  var usage = null;
  var MAX_ROUNDS = 16;

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

    var m = reply.match(/^ACTION:\s*([a-z0-9_]+)\s*(\{[\s\S]*\}?|[^\n]*)?\s*$/i);
    if (!m) {
      // FINAL answer — stream it now if it was held back, then done.
      if (res.held && reply) opts.onDelta && opts.onDelta(reply);
      finalText = reply;
      break;
    }
    var tool = m[1].toLowerCase();
    // v0.20 ALIASES: models invent plausible tool names (search, google,
    // fetch, browse, open_url…) — map them onto the real tools instead of
    // erroring. The engine loop does the same.
    if (/^(search|websearch|google|bing|duckduckgo|find)$/.test(tool)) tool = 'web_search';
    else if (/^(fetch|open_url|browse|get|visit|read_url|url)$/.test(tool)) tool = 'web_fetch';
    else if (/^(calc|math|compute|evaluate)$/.test(tool)) tool = 'calculator';
    else if (/^(time|now|clock|date)$/.test(tool)) tool = 'time_now';
    else if (/^(guid|uuid4|uuidgen)$/.test(tool)) tool = 'uuid';
    else if (/^(rand|random_number|dice)$/.test(tool)) tool = 'random';
    else if (/^(b64|base_64)$/.test(tool)) tool = 'base64';
    else if (/^(md5|sha|sha1_hash|digest)$/.test(tool)) tool = 'hash';
    else if (/^(json|json_format|validate_json|jsonlint)$/.test(tool)) tool = 'json_tool';
    else if (/^(word_count|count|stats|wc)$/.test(tool)) tool = 'text_stats';
    else if (/^(urldecode|percent_encode|urlencode)$/.test(tool)) tool = 'url_encode';
    else if (/^(regex|grep|findall|match)$/.test(tool)) tool = 'regex_extract';
    var arg = {};
    if (m[2]) {
      try { arg = JSON.parse(m[2]); }
      catch (e) {
        // truncated JSON — repair the missing braces/quotes, then retry
        var fixed = repairJSON(m[2]);
        try { arg = JSON.parse(fixed); } catch (e2) { arg = m[2].replace(/^["']|["']$/g, ''); }
      }
    }
    // models sometimes pass the query as a bare string instead of JSON
    if (typeof arg === 'string') arg = { query: arg, url: arg, text: arg, expr: arg, pattern: arg };

    try {
      if (tool === 'web_search') {
        var q = arg.query || String(arg.q || '');
        if (!q) {
          // models sometimes omit the argument — teach, don't 400
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: 'OBSERVATION:\nerror: empty query. Usage: ACTION: web_search {"query": "<search terms>"}' });
          continue;
        }
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
      } else if (tool === 'web_fetch') {
        var u = arg.url || String(arg.u || '');
        if (!u) {
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: 'OBSERVATION:\nerror: empty url. Usage: ACTION: web_fetch {"url": "<https url>"}' });
          continue;
        }
        opts.onTool && opts.onTool({ name: 'web_fetch', summary: u });
        var r2 = await fetch('/api/tools/webfetch?url=' + encodeURIComponent(u) + '&max=6000');
        if (!r2.ok) throw new Error('HTTP ' + r2.status);
        var d2 = await r2.json();
        opts.onTool && opts.onTool({ name: 'web_fetch', result: ((d2.text || '') + '').slice(0, 120) });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: 'OBSERVATION:\n' + ((d2 && d2.text) || '(empty page)') });
      } else {
        // v0.20: LOCAL tool — the engine computes it (/api/tools/local).
        var sum = arg.expr || arg.tz || arg.pattern || arg.mode || arg.algo || '';
        opts.onTool && opts.onTool({ name: tool, summary: String(sum).slice(0, 80) });
        var r3 = await fetch('/api/tools/local?name=' + encodeURIComponent(tool) + '&args=' + encodeURIComponent(JSON.stringify(arg)));
        if (!r3.ok) {
          var errText = 'tool error HTTP ' + r3.status;
          opts.onTool && opts.onTool({ name: tool, result: errText });
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: 'OBSERVATION:\n(' + errText + ' — try again with valid arguments)' });
          continue;
        }
        var d3 = await r3.json();
        var out3 = (d3 && d3.result) || '';
        opts.onTool && opts.onTool({ name: tool, result: String(out3).slice(0, 120) });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: 'OBSERVATION:\n' + out3 });
      }
    } catch (e) {
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: 'OBSERVATION:\n(tool error: ' + (e.message || e) + ' — try a different approach or answer from what you have)' });
    }
  }

  if (round === MAX_ROUNDS && !finalText) {
    // Budget exhausted without a final answer — force one last plain round.
    messages.push({ role: 'user', content: 'Tool budget exhausted. Give your FINAL answer now from what you have (no ACTION line), citing sources as [n] if any.' });
    var last = await roundTrip(c, opts, messages, null);
    finalText = (last.text || '').trim();
  }

  opts.onStatus && opts.onStatus('idle');
  return { text: finalText, usage: usage, sources: allSources };
}

// One PM streaming round. mode 'silent' holds deltas (ReAct probe rounds
// that may turn out to be ACTION lines) and returns the assembled text.
// v0.20: EMPTY-ROUND GUARD — PM (like NIM) sometimes returns a 200 stream
// with zero tokens. The engine path retries these; now the PM loop does
// too (once), and a persistently-empty model surfaces a visible error
// instead of a silent no-op turn.
async function roundTrip(c, opts, messages, mode) {
  var res = await roundTripOnce(c, opts, messages, mode);
  if (!res.aborted && !res.err && (res.text || '').trim() === '' && !res.usage) {
    // empty + not aborted → one retry
    res = await roundTripOnce(c, opts, messages, mode);
    if ((res.text || '').trim() === '' && !res.aborted && !res.err) {
      res.err = new Error('the model returned an empty response — try again or pick a different model');
    }
  }
  if (res.err) throw pmError('PrivateMode: ' + friendlyPMError(res.err.message));
  return res;
}

async function roundTripOnce(c, opts, messages, mode) {
  var full = '';
  var usage = null;
  var held = mode === 'silent';
  var out = { text: '', usage: null, held: held, aborted: false, err: null };
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
    out.text = full; out.usage = usage;
    return out;
  } catch (e) {
    opts.onStatus && opts.onStatus('error');
    if (e && e.name === 'AbortError') { out.text = full; out.usage = usage; out.aborted = true; return out; }
    out.err = e;
    return out;
  }
}

window.PMBridge = {
  streamChat: streamChat,
  available: function () { return typeof WebSocket !== 'undefined' && typeof WebAssembly !== 'undefined'; }
};
