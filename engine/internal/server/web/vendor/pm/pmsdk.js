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

// ── v0.22: the browser-side ReAct loop (mirrors the Go pipeline) ──────
//
// PM chats run in the WebView, so the engine's Go tool loop can't drive
// them. Instead the ENGINE becomes the tool server (/api/tools/* —
// same-origin) and this loop does what chat.go does: inject the ACTION
// protocol, watch the model's reply for an ACTION line, run the tool,
// feed back OBSERVATION, repeat (max 16 — deep tool chains are legal).
//
// v0.22 FIXES (the "chain gets interrupted" bug, from the live CSVs):
//   1. ACTION DETECTION — the old regex was ^-anchored to the WHOLE
//      reply, so models writing a prose preamble before their ACTION
//      line ("Step 1/12: ... ACTION: time_now {...}") were treated as
//      final answers and the chain died at step 1. Now ANY complete
//      line can carry the ACTION (last one wins), glued JSON
//      (time_now{"tz":...}) parses, and a preamble never breaks the loop.
//   2. LIVE STREAMING — the old loop held EVERY round silent, so final
//      answers popped as one blob (thinking streamed, the reply didn't:
//      "replies outside of the thinking box don't stream smoothly").
//      Rounds now stream live once they're provably not an ACTION
//      (bounded hold: 700 bytes / 3 non-blank lines, same as the Go
//      loop), and ACTION rounds stay fully suppressed.
//   3. NETWORK RETRY — a mid-chain "reading stream chunk: network
//      error" used to kill the whole turn. Suppressed rounds (nothing
//      rendered yet) now retry with backoff.
//   4. FILE TOOLS — docx_create/xlsx_create/zip_create/zip_extract ride
//      /api/tools/local with the session id so binaries save into the
//      chat's artifact drawer (real Word/Excel/zip downloads).
var PM_TOOLS_PROTOCOL = [
  'You have access to tools. To call one, output a line in this exact shape:',
  'ACTION: <tool> {<json arguments>}',
  'A short one-line preamble before the ACTION line is allowed, but the ACTION line must be the LAST line of your reply and contain nothing else.',
  'After every ACTION the system AUTOMATICALLY sends you an OBSERVATION (the tool output) — you never wait for the user for this. IMMEDIATELY issue your next ACTION after reading an observation; you may chain many tool calls (up to 24) in one turn back-to-back without any user message in between.',
  'ONLY when you have everything you need do you write your FINAL answer as a normal reply (no ACTION line). Never fabricate tool results.',
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
  'ACTION: regex_extract {"pattern": "...", "text": "...", "group": 0} — regex matches',
  'ACTION: docx_create {"name": "f.docx", "blocks": [{"type": "title|heading|subheading|paragraph|bullet|number|quote", "text": "...", "bold": true, "color": "FFD700", "size": 28, "align": "center", "runs": [{"text": "...", "bold": true}]}]} — build a REAL Word .docx with styled headings, colored/bold/italic/underline/strikethrough runs, fonts, sizes, alignment. Saved as a downloadable artifact.',
  'ACTION: xlsx_create {"name": "f.xlsx", "sheets": [{"name": "Data", "bold_header": true, "rows": [["h1", "h2"], [1, 2]]}]} — build a REAL Excel .xlsx (multi-sheet, bold headers). Saved as a downloadable artifact.',
  'ACTION: zip_create {"name": "b.zip", "files": [{"name": "a.txt", "content": "..."}]} — build a real .zip from named text/base64 files. Saved as a downloadable artifact.',
  'ACTION: zip_extract {"artifact": "b.zip"} or {"b64": "<zip bytes>"} — list a zip archive and extract its files as artifacts.',
  'ACTION: delegate {"prompt": "<question>", "models": ["..."]} — consult up to 3 OTHER models in parallel (multi-model swarm)',
  'For REAL files (Word/Excel/zip) ALWAYS use docx_create/xlsx_create/zip_create instead of hand-writing base64 into the chat — the tools build valid binaries the user can download.',
  'Use a tool whenever it beats guessing (math, time, encodings, ids, validation, files).'
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

// v0.22: find the LAST complete line that starts with "ACTION:" —
// preambles are legal, glued JSON is legal, several ACTION lines are
// legal (the last is operative). Returns null or {name, rest, lineStart}.
function findActionLine(text) {
  var lines = String(text || '').split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    var t = lines[i].replace(/^[ \t]+/, '');
    if (/^ACTION:/i.test(t)) {
      var head = t.replace(/^ACTION:\s*/i, '');
      var m = head.match(/^([a-zA-Z0-9_-]+)([\s\S]*)$/);
      if (!m) return null;
      return { name: m[1], rest: m[2].trim(), lineStart: text.lastIndexOf('\n', text.indexOf(lines[i])) + 1 };
    }
  }
  return null;
}

// v0.22: could the text STILL become an ACTION round? While it could,
// we hold deltas (bounded — see roundTripOnce). Mirrors the Go loop's
// preambleHoldBytes/preambleHoldLines.
function stillMaybePreamble(held) {
  if (!held) return true;
  if (held.length >= 700) return false;
  var complete = held.split('\n');
  complete.pop(); // last element may still be open
  var nonBlank = 0;
  for (var i = 0; i < complete.length; i++) {
    if (complete[i].trim() !== '') nonBlank++;
    if (/^[ \t]*ACTION:/i.test(complete[i])) return true; // it IS one
  }
  return nonBlank < 3;
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
  var MAX_ROUNDS = 24; // v0.22: 24 — 10-file generations + zip round-trip fit

  for (var round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal && opts.signal.aborted) {
      return { text: finalText, usage: usage, aborted: true, sources: allSources };
    }
    var res = await roundTrip(c, opts, messages);
    usage = res.usage || usage;
    var reply = (res.text || '').trim();

    var act = findActionLine(reply);
    if (!act) {
      finalText = reply;
      break;
    }
    // v0.22: a >700-byte preamble streamed before its ACTION line — wipe
    // the leaked text so the tool pills render on a clean slate.
    if (res.emitted && opts.onReset) opts.onReset();
    var tool = act.name.toLowerCase();
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
    else if (/^(docx|word|word_doc|make_docx)$/.test(tool)) tool = 'docx_create';
    else if (/^(xlsx|excel|spreadsheet|make_xlsx)$/.test(tool)) tool = 'xlsx_create';
    else if (/^(zip|make_zip|archive|compress)$/.test(tool)) tool = 'zip_create';
    else if (/^(unzip|extract|decompress|unarchive)$/.test(tool)) tool = 'zip_extract';
    var arg = {};
    if (act.rest) {
      try { arg = JSON.parse(act.rest); }
      catch (e) {
        // truncated JSON — repair the missing braces/quotes, then retry
        var fixed = repairJSON(act.rest);
        try { arg = JSON.parse(fixed); } catch (e2) { arg = act.rest.replace(/^["']|["']$/g, ''); }
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
        // LOCAL tool — the engine computes it (/api/tools/local).
        // v0.22: session-scoped so file tools save artifacts + zip_extract
        // can re-read what an earlier round saved.
        var sum = arg.expr || arg.tz || arg.pattern || arg.mode || arg.algo || arg.name || '';
        opts.onTool && opts.onTool({ name: tool, summary: String(sum).slice(0, 80) });
        var ls = '/api/tools/local?name=' + encodeURIComponent(tool) + '&args=' + encodeURIComponent(JSON.stringify(arg));
        if (opts.sessionId) ls += '&session=' + encodeURIComponent(opts.sessionId);
        var r3 = await fetch(ls);
        if (!r3.ok) {
          var errText = 'tool error HTTP ' + r3.status;
          opts.onTool && opts.onTool({ name: tool, result: errText });
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: 'OBSERVATION:\n(' + errText + ' — try again with valid arguments)' });
          continue;
        }
        var d3 = await r3.json();
        var out3 = (d3 && d3.result) || '';
        opts.onTool && opts.onTool({ name: tool, result: String(out3).slice(0, 120), artifact: d3 && d3.artifact });
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
    var last = await roundTrip(c, opts, messages);
    finalText = (last.text || '').trim();
  }

  opts.onStatus && opts.onStatus('idle');
  return { text: finalText, usage: usage, sources: allSources };
}

// One PM streaming round (v0.22: LIVE STREAMING + NETWORK RETRY).
//
// Round lifecycle:
//   held      — content accumulates while it could still be an ACTION
//               (bounded: 700 bytes / 3 non-blank lines — same as Go)
//   action    — an ACTION line appeared → everything stays suppressed
//   streaming — provably a final answer → deltas flow live
//
// A network error only retries when nothing was rendered yet (every
// ACTION/undecided round qualifies — those are exactly the rounds that
// used to kill 12-tool chains with "reading stream chunk: network error").
async function roundTrip(c, opts, messages) {
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = await roundTripOnce(c, opts, messages);
    if (res.aborted || !res.err) {
      // v0.20 EMPTY-ROUND GUARD — PM sometimes returns a 200 stream with
      // zero tokens. One retry, then a visible error (not a silent no-op).
      if (!res.aborted && (res.text || '').trim() === '' && !res.usage) {
        res = await roundTripOnce(c, opts, messages);
        if ((res.text || '').trim() === '' && !res.aborted && !res.err) {
          res.err = new Error('the model returned an empty response — try again or pick a different model');
        }
      }
      if (res.err) throw pmError('PrivateMode: ' + friendlyPMError(res.err.message));
      return res;
    }
    // retry only rounds that rendered nothing (ACTION/undecided rounds)
    var transient = /network|fetch|timeout|stream chunk|HTTP 5|502|503/i.test(res.err.message || '');
    if (!transient || res.emitted || attempt === 2) {
      throw pmError('PrivateMode: ' + friendlyPMError(res.err.message));
    }
    lastErr = res.err;
    await new Promise(function (r) { setTimeout(r, 1500 * (attempt + 1)); });
  }
  throw pmError('PrivateMode: ' + friendlyPMError(lastErr && lastErr.message));
}

async function roundTripOnce(c, opts, messages) {
  var full = '';
  var usage = null;
  var emitted = false;     // any onDelta fired (retry safety)
  var decided = null;      // null = undecided · 'action' · 'final'

  // v0.22b SMOOTH PUMP — PM's proxy delivers the entire reply content as
  // ONE chunk (live probe: 2961 chars in a single delta after 18s of
  // streamed thinking — the "replies outside the thinking box don't stream
  // smoothly" root cause, provider-side batching we can't un-batch).
  // Big chunks are re-streamed at a typewriter cadence instead: small
  // pieces every ~4ms tick, accelerating for very large payloads so a
  // 100KB artifact body still completes in a few hundred milliseconds.
  var pumpQueue = '';
  var pumping = null;
  var enqueue = function (text) {
    if (!text) return;
    pumpQueue += text;
    if (!pumping) {
      pumping = (async function () {
        while (pumpQueue.length > 0) {
          var n = pumpQueue.length > 6000 ? Math.ceil(pumpQueue.length / 60)
            : (pumpQueue.length > 600 ? 96 : 48);
          var piece = pumpQueue.slice(0, n);
          pumpQueue = pumpQueue.slice(n);
          opts.onDelta && opts.onDelta(piece);
          emitted = true;
          await new Promise(function (r) { setTimeout(r, 0); });
        }
        pumping = null;
      })();
    }
  };
  var drainPump = function () { return pumping || Promise.resolve(); };

  var out = { text: '', usage: null, emitted: false, aborted: false, err: null };
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
          if (decided === 'action') {
            // suppressed — round is a tool call
          } else if (decided === 'final') {
            enqueue(d.content);
          } else if (findActionLine(full + '\n')) {
            decided = 'action';
          } else if (!stillMaybePreamble(full)) {
            decided = 'final';
            enqueue(full);
          }
        }
      }
      if (ch.usage) usage = ch.usage;
    }
    // round complete — decide the tail if still undecided
    if (!decided) {
      if (findActionLine(full)) {
        decided = 'action';
      } else {
        decided = 'final';
        if (full) enqueue(full);
      }
    }
    await drainPump(); // visual stream finishes BEFORE the round resolves
    opts.onStatus && opts.onStatus('idle');
    out.text = full; out.usage = usage; out.emitted = emitted;
    return out;
  } catch (e) {
    opts.onStatus && opts.onStatus('error');
    pumpQueue = ''; // failed round — stop the visual stream where it is
    if (e && e.name === 'AbortError') { out.text = full; out.usage = usage; out.emitted = emitted; out.aborted = true; return out; }
    out.err = e;
    out.emitted = emitted;
    return out;
  }
}

window.PMBridge = {
  streamChat: streamChat,
  available: function () { return typeof WebSocket !== 'undefined' && typeof WebAssembly !== 'undefined'; }
};
