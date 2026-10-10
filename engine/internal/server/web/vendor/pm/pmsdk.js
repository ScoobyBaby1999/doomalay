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

// ── v0.71: USAGE NORMALIZATION + ROUND-SUMMING (the PM tracking fix) ──
// The engine's usage aggregation (server/usage.go) reads the engine
// shape — usage:{input_tokens, output_tokens}. PM's OpenAI-compatible
// stream reports {prompt_tokens, completion_tokens, total_tokens}; the
// bridge persisted it RAW, so every PM status event unmarshalled to
// TURNS WITH ZERO TOKENS ("usage doesn't get tracked at all while using
// privatemodeai"). normUsage maps either spelling into the engine
// shape; mergeUsage sums across ReAct rounds exactly like the engine's
// llm.mergeUsage (a 24-round tool loop is 24 API calls — the LAST
// round's usage alone was never the turn's real cost).
function normUsage(u) {
  if (!u || typeof u !== 'object') return null;
  var tin = u.input_tokens, tout = u.output_tokens;
  if (tin === undefined || tin === null) tin = u.prompt_tokens;
  if (tout === undefined || tout === null) tout = u.completion_tokens;
  if ((tin === undefined || tin === null) && (tout === undefined || tout === null)) return null;
  tin = Number(tin) || 0; tout = Number(tout) || 0;
  return { input_tokens: tin, output_tokens: tout,
           total_tokens: Number(u.total_tokens) || (tin + tout) };
}
function mergeUsage(a, b) {
  if (!b) return a;
  if (!a) return b;
  return { input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
           output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
           total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0) };
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

// v1.13.5 THE LAST ACTION (PLAN-V113 §5): PM_TOOLS_PROTOCOL and
// PM_WEB_TOOLS_PROTOCOL (the ACTION grammar the model hand-wrote) are
// DELETED. PM's E2E API passes OpenAI tools[] through natively (verified
// live: glm returns structured tool_calls with finish_reason tool_calls)
// — the manifest comes from the engine's MCP bus (/mcp tools/list, the
// session-header binding), and the model calls tools STRUCTURALLY. The
// tools themselves teach their own names, args and descriptions.
var PM_LIB_ACTIONS = [
  'You also have THE SKILL LIBRARY (methodology skills — brainstorming, writing-plans, TDD, systematic-debugging, verification…) plus the PUBLIC HUB (templates, skills, scripts, docs — other publishers\u2019 work):',
  'Call the skills tool with action "list" — the skill index; action "search" with q — ranked hits; action "load" with skill — load a skill and FOLLOW it; action "files"/"read" with skill + path — companion files.',
  'Call the hublib tool with action "search" + q + type — browse the public hub; action "get" + type/repo/id — an item\u2019s detail; action "download" + type/repo/id — download into the user\u2019s library + use it.',
  'NEVER guess or invent a skill — list/search FIRST, then load what actually exists. listing + searching are always available; load + download need this chat\u2019s 🛠 lib pill ON — when they are refused, finish from what you have and tell the user to flip the 🛠 lib pill on.',
  'The library is an ASSET, not a detour: when a task would plausibly benefit from a hub item (a methodology to follow, a template to reuse, a script to run), search for one and recommend the hits by name — a fit beats improvising. If the search comes back empty or nothing fits, say so and proceed without: never force a library item that steers away from the task, and never name an item a real search did not return.',
  'If the user asks what\u2019s in the library, or asks you to find/recommend something for their task — search it and show the real results (cards render for the user). The user browses and downloads from the ✦ library panel too.'
].join('\n');
var PM_LIB_DISCIPLINE = 'If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST load it BEFORE starting the work it covers. Load → follow the skill\u2019s workflow to the letter.';
var PM_LIB_PROTOCOL = PM_LIB_ACTIONS + '\n' + PM_LIB_DISCIPLINE;

function fetchLibBootstrap(sessionId) {
  if (_pmBootstrapCache) return Promise.resolve(_pmBootstrapCache);
  var u = '/api/tools/skills?action=bootstrap' + (sessionId ? '&session=' + encodeURIComponent(sessionId) : '');
  return fetch(u).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.result) {
      _pmBootstrapCache = d.result;
      return d.result;
    }
    _pmBootstrapCache = null;
    throw new Error((d && d.error) || 'bootstrap unavailable');
  }).catch(function (e) {
    _pmBootstrapCache = null;
    throw e;
  });
}

// ── v1.13.5 THE LAST ACTION: the MCP bridge helpers ────────────────────
//
// The tool contract now rides the engine's MCP bus (/mcp — stateless
// streamable HTTP, the same JSON-RPC the engine itself speaks):
//   · pmToolManifest(sessionId)  — tools/list with the session header →
//     the OpenAI tools[] manifest (real JSON Schemas; session-scoped
//     tools appear only for their session). 60s cache.
//   · mcpExecTool(name, args…)   — tools/call with the session header →
//     {text, isError, sources}. Everything (local, file, web, skills,
//     hublib, workspace, persona, delegate) runs through ONE endpoint.
var _pmManifestCache = { key: null, at: 0, specs: null };
function pmToolManifest(sessionId) {
  var now = Date.now();
  if (_pmManifestCache.key === sessionId && (now - _pmManifestCache.at) < 60000 && _pmManifestCache.specs) {
    return Promise.resolve(_pmManifestCache.specs);
  }
  return fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Doomalay-Session': sessionId || '' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  }).then(function (r) {
    if (!r.ok) throw new Error('tools/list HTTP ' + r.status);
    return r.json();
  }).then(function (d) {
    var tools = (d && d.result && d.result.tools) || [];
    var specs = [];
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i] || {};
      if (!t.name) continue;
      specs.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || ('Tool ' + t.name),
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      });
    }
    _pmManifestCache = { key: sessionId, at: now, specs: specs };
    return specs;
  }).catch(function (e) {
    // honest degrade: no manifest → the turn runs tool-less (the engine
    // contract — never the deleted ACTION grammar)
    _pmManifestCache = { key: sessionId, at: now, specs: null };
    return null;
  });
}

// mcpExecTool — ONE tool call through the bus. Returns
// {text, isError, sources}; throws only on transport failure (the loop
// turns that into the honest observation).
function mcpExecTool(name, args, sessionId) {
  return fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Doomalay-Session': sessionId || '' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call',
      params: { name: name, arguments: args || {} }
    })
  }).then(function (r) {
    if (!r.ok) throw new Error('tools/call HTTP ' + r.status);
    return r.json();
  }).then(function (d) {
    if (d && d.error) {
      var msg = (d.error.message || 'tool call failed');
      return { text: 'error: ' + msg, isError: true, sources: null };
    }
    var res = (d && d.result) || {};
    var text = '';
    var content = res.content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === 'text') text += (text ? '\n' : '') + String(content[i].text || '');
    }
    var sources = null;
    if (res.structuredContent && res.structuredContent.sources) {
      sources = res.structuredContent.sources;
    }
    return { text: text, isError: !!res.isError, sources: sources };
  });
}

// v1.13.5: repair truncated STREAMED tool_call arguments (the native
// twin of the Go engine's repairJSON) — a provider output cap can cut
// the arguments JSON mid-string; the closing braces/quotes get appended
// instead of losing the call.
function repairJSON(s) {
  if (typeof s !== 'string' || !s.trim().startsWith('{')) return s;
  var out = '';
  var stack = [];
  var inStr = false, esc = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; }
      else if (ch === '\\') { esc = true; out += ch; }
      else if (ch === '"') { inStr = false; out += ch; }
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else if (ch === '"') { inStr = true; out += ch; }
    else if (ch === '{') { stack.push('}'); out += ch; }
    else if (ch === '[') { stack.push(']'); out += ch; }
    else if ((ch === '}' || ch === ']') && stack.length) { stack.pop(); out += ch; }
    else out += ch;
  }
  if (inStr) out += '"';
  for (var j = stack.length - 1; j >= 0; j--) out += stack[j];
  return out;
}

// v0.24 — intent detection for the auto-proceed nudge (mirrors the Go
// engine's looksLikeIntentOnly). A short no-ACTION reply that announces
// what it's ABOUT to do ("I'll demonstrate...") gets pushed once instead
// of ending the turn to wait for the user to say "go".
var INTENT_PHRASES = [
  'i will now', "i'll now", 'i will start', "i'll start", 'i will begin', "i'll begin",
  'i will demonstrate', "i'll demonstrate", 'i will show', "i'll show you",
  "i'm going to", 'im going to', 'let me start', 'let me begin', 'let me demonstrate',
  'let me show', 'i will walk', "i'll walk you", 'i will create', "i'll create",
  'i will use', "i'll use", 'i will run', "i'll run", 'i will call', "i'll call",
  'i will first', "i'll first", 'starting now', 'shall i proceed', 'should i proceed',
  'would you like me to', 'want me to', 'ready when you are', 'say go', 'give me the go',
  'tell me to', 'i am about to', "i'm about to", "here's my plan", 'here is my plan',
  'my plan is', 'i plan to',
  // v0.28: the "proactively search" flavors — models that announce a
  // search instead of just running it.
  "i'll search", 'i will search', 'let me search', "i'll look", 'let me look',
  "i'll check", 'let me check', "i'll fetch", 'let me fetch', "i'll go ahead",
  'i will go ahead', 'let me try', "i'll try", "i'll find out", 'let me find out'
];

// v0.28 CAPABILITY-DENIAL phrases — models claiming they have no
// internet/tools while the protocol is armed (mirrors the Go engine's
// denialPhrases; the user's "models don't proactively discover tools"
// report was exactly this, observed with the repo-explain convo).
var DENIAL_PHRASES = [
  "i can't search", 'i cannot search', "i can't browse", 'i cannot browse',
  "i can't access the internet", 'i cannot access the internet',
  "i don't have internet access", "i don't have access to the internet",
  'no internet access', "i can't go online", "i can't fetch", 'i cannot fetch',
  "i can't access the web", 'i cannot access the web', "i can't access external",
  "i can't visit websites", 'i cannot visit websites', "i can't look that up",
  "i can't check the time", "i don't have the ability to search",
  "i don't have the ability to browse", "i'm not able to access",
  'i am not able to access', "i don't have access to that",
  "i don't have real-time", "i don't have live", 'as an ai language model, i',
  'my knowledge cutoff', "i can't verify", 'i cannot verify'
];

function looksLikeIntentOnly(reply) {
  var r = String(reply || '').toLowerCase();
  if (r.length > 900) return false; // a real, substantial answer
  for (var i = 0; i < INTENT_PHRASES.length; i++) {
    if (r.indexOf(INTENT_PHRASES[i]) !== -1) return true;
  }
  return false;
}

function looksLikeCapabilityDenial(reply) {
  var r = String(reply || '').toLowerCase();
  if (r.length > 1200) return false;
  for (var i = 0; i < DENIAL_PHRASES.length; i++) {
    if (r.indexOf(DENIAL_PHRASES[i]) !== -1) return true;
  }
  return false;
}

// v0.95.4 THE DSML HELPERS (the PM twin of the Go engine's llm/dsml.go) —
// deepseek-family models stream their native tool markup
// (<｜DSML｜calls>…<｜DSML｜/calls>) as content when they fall back to their
// own format; the markup must never render and the calls inside must not
// be lost. dsmlClean strips the markup from a VISIBLE fragment; the full
// conversion (calls → ACTION lines) happens at the parse layer.
function dsmlClean(s) {
  if (String(s).indexOf('<｜') < 0 && String(s).indexOf('<|') < 0) return s;
  var out = String(s)
    .replace(/<｜DSML｜\s*calls>[\s\S]*?<｜DSML｜\s*\/calls>/g, '')
    .replace(/<\|DSML\|\s*calls>[\s\S]*?<\|DSML\|\s*\/calls>/g, '');
  // an UNTERMINATED block (the stream cut mid-call) — strip the tail too
  out = out.replace(/<｜DSML｜[\s\S]*$/, '').replace(/<\|DSML\|[\s\S]*$/, '');
  return out;
}
async function runToolLoop(c, opts) {
  // v1.13.5 THE LAST ACTION (PLAN-V113 §5): the ACTION text protocol is
  // DELETED. PM's E2E API passes OpenAI tools[] through natively (verified
  // live: glm returns structured tool_calls) — the manifest comes from the
  // engine's MCP bus (/mcp tools/list, session-header-bound), the model
  // calls tools STRUCTURALLY, and every call executes through /mcp
  // tools/call (the SAME session-bound machinery the engine's own loop
  // uses — artifacts, library gates, workspace tokens and all).
  var specs = await pmToolManifest(opts.sessionId || '');
  if (!specs || !specs.length) {
    opts.onProgress && opts.onProgress({ text: 'tools unavailable — answering without them' });
  }
  var system = opts.messages[0] && opts.messages[0].role === 'system'
    ? opts.messages[0].content
    : '';
  // v0.71 lineage: the LIBRARY vocabulary always rides the system message
  // (the server gates the load/download half; the text says which half
  // needs the 🛜 lib pill, so a refusal becomes a recommendation + a user
  // hint instead of a retry storm).
  system = system + '\n\n' + PM_LIB_ACTIONS;
  // v0.60 pt C.13: the lib gate — ON prepends the full bootstrap.
  if (opts.lib) {
    try {
      var boot = await fetchLibBootstrap(opts.sessionId || '');
      system = boot + '\n\n' + system + '\n\n' + PM_LIB_DISCIPLINE;
    } catch (e) {
      opts.onProgress && opts.onProgress({ text: 'skill library unavailable — ' + (e.message || e) });
    }
  }
  // v0.71: THE ATTACHED BUNDLE — the manifest + the decision protocol ride
  // ABOVE everything else so the model reads the bundle first, every turn.
  if (opts.bundle && opts.bundle.members && opts.bundle.members.length) {
    var bd = opts.bundle;
    var lines = [];
    for (var bi = 0; bi < bd.members.length && bi < 60; bi++) {
      var m = bd.members[bi] || {};
      lines.push('· ' + (m.type || 'item') + ' — ' + (m.name || m.id || '?') +
        (m.desc ? ' — ' + String(m.desc).slice(0, 140) : '') +
        (m.repo && m.id ? ' [' + m.repo + ' / ' + m.id + ']' : ''));
    }
    system = 'THE ATTACHED BUNDLE — ' + (bd.name || bd.id) +
      (bd.tag ? ' (#' + bd.tag + ')' : '') + ' — ' + bd.members.length + ' members\n' +
      'The user attached this WHOLE bundle instead of one member. For EVERY request:\n' +
      '1. Review the members below against the task BEFORE answering.\n' +
      '2. Decide which member(s) fit the work best — never guess or answer from memory when a member covers it.\n' +
      '3. LOAD the pick BEFORE starting: an installed skill via the skills tool (action "load", skill "<name>"); any hub member via the hublib tool (action "get" then "download" with its type/repo/id from the manifest lines).\n' +
      '4. Follow the loaded member to the letter, and say briefly WHICH member you used and why.\n' +
      'Members:\n' + lines.join('\n') + '\n\n' + system;
  }
  var messages = (system ? [{ role: 'system', content: system }] : []).concat(
    opts.messages[0] && opts.messages[0].role === 'system' ? opts.messages.slice(1) : opts.messages);
  var allSources = [];
  var finalText = '';
  var usage = null;
  var MAX_ROUNDS = 200; // v0.82.2: the no-cap chain (user directive: 100 chained tools).
  var anyToolRun = false;
  var nudged = false;     // v0.24: the auto-proceed push (max once)
  var lastThink = '';     // v0.81.7: the turn-end net's raw material

  for (var round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal && opts.signal.aborted) {
      return { text: finalText, usage: usage, aborted: true, sources: allSources };
    }
    var res = await roundTrip(c, opts, messages, specs);
    usage = mergeUsage(usage, res.usage);
    if (res.think) lastThink = String(res.think);
    var reply = (res.text || '').trim();
    var calls = res.toolCalls || [];

    if (!calls.length) {
      // v0.24 AUTO-PROCEED NUDGE: models that announce a plan instead of
      // calling the tool — push once instead of ending the turn.
      if (!nudged && round === 0 && !anyToolRun && looksLikeIntentOnly(reply)) {
        nudged = true;
        opts.onProgress && opts.onProgress({ text: 'model announced a plan — telling it to proceed…' });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: '(system: proceed now — do not wait for permission and do not ask. Call your tools now and carry the task through to the final result.)' });
        continue;
      }
      // v0.28 CAPABILITY-DENIAL NUDGE — the model claimed it can't while
      // tools are offered. Push once, NAMING them.
      if (!nudged && round === 0 && !anyToolRun && specs && specs.length && looksLikeCapabilityDenial(reply)) {
        nudged = true;
        opts.onProgress && opts.onProgress({ text: "model said it can't — reminding it about its tools…" });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: '(system: you DO have tools — this app runs a live tool protocol and they were offered to you as functions. web_search and web_fetch give you the live internet (when enabled); calculator, time_now, uuid, random, base64, hash, json_tool, text_stats, url_encode, regex_extract, docx_create, xlsx_create, zip_create, zip_extract, archive_create, archive_extract and delegate all run on-device. Your earlier statement that you cannot access or verify this was wrong. Call the right tool NOW and finish the task.)' });
        continue;
      }
      finalText = reply;
      if (finalText && !res.emitted && opts.onDelta) {
        try { opts.onDelta(dsmlClean(finalText)); } catch (e) { /* never fatal */ }
      }
      break;
    }

    anyToolRun = true;

    // the assistant message carrying the structured calls (for the next
    // round — the OpenAI wire shape), then execute + append role:"tool".
    var wire = [];
    for (var w = 0; w < calls.length; w++) {
      wire.push({ id: calls[w].id || ('call_' + w), type: 'function', function: { name: calls[w].name, arguments: calls[w].arguments || '{}' } });
    }
    if (reply) {
      // a round with BOTH prose and calls: the prose streamed as a round
      // segment (roundTripOnce emits content deltas live); nothing more
      // to do here — the messages carry it below.
    }
    messages.push({ role: 'assistant', content: reply || null, tool_calls: wire });
    // v1.19.3 THE SEQUENTIAL FLOW (PLAN-V119 §3): the segment boundary the
    // engine paths emit as round_end — the receiver (chatpanel's onReset,
    // v0.95.2) closes the open narration block so the pills render below a
    // COMPLETED bubble and the next round's deltas open a NEW one at the
    // bottom. The old turn glued every round's text into one bubble (the
    // user's live report). Idempotent: nothing open → nothing happens.
    opts.onReset && opts.onReset();
    for (var k = 0; k < wire.length; k++) {
      var obs = '(tool error)';
      var name = wire[k].function.name;
      var argsRaw = wire[k].function.arguments || '{}';
      var argsObj = {};
      try { argsObj = JSON.parse(argsRaw); }
      catch (e) {
        try { argsObj = JSON.parse(repairJSON(argsRaw)); }
        catch (e2) {
          obs = 'error: arguments arrived malformed — re-issue the call';
          opts.onTool && opts.onTool({ name: name, result: obs });
          messages.push({ role: 'tool', tool_call_id: wire[k].id, name: name, content: obs });
          continue;
        }
      }
      try {
        var summary = '';
        // v1.23.2 THE ONE PILL: the nested args object wins first (the
        // termux shape {"action":"exec","args":{"command":"python -V"}}
        // summarized the ACTION — "exec" — instead of the command; the
        // nested command/path/pattern/name is the real query).
        if (argsObj.args && typeof argsObj.args === 'object') {
          for (var nk of ['command', 'path', 'pattern', 'name', 'query']) {
            if (typeof argsObj.args[nk] === 'string' && argsObj.args[nk]) {
              summary = argsObj.args[nk].slice(0, 80);
              break;
            }
          }
        }
        if (!summary) {
          for (var sk of ['query', 'url', 'expr', 'q', 'action', 'skill', 'ws', 'name', 'id', 'prompt', 'path', 'pattern']) {
            if (typeof argsObj[sk] === 'string' && argsObj[sk]) { summary = argsObj[sk].slice(0, 80); break; }
          }
        }
        if (name === 'web_search' || name === 'web_fetch') {
          opts.onProgress && opts.onProgress({ text: name === 'web_search' ? 'searching the web…' : 'reading ' + String(argsObj.url || '').slice(0, 60) + '…' });
        } else if (/^(docx_create|xlsx_create|zip_create|archive_create)$/.test(name)) {
          opts.onProgress && opts.onProgress({ text: 'building ' + (argsObj.name || 'file') + '…' });
        }
        // v1.23.2: the RAW args ride the use event — the pill derives
        // its label (the program being run) from them at render time.
        opts.onTool && opts.onTool({ name: name, summary: summary, args: argsObj });
        var out = await mcpExecTool(name, argsObj, opts.sessionId || '');
        obs = out.isError ? out.text : String(out.text || '');
        if (out.sources && out.sources.length) {
          for (var si = 0; si < out.sources.length; si++) {
            allSources.push({ title: out.sources[si].title, url: out.sources[si].url, snippet: out.sources[si].snippet });
          }
        }
        opts.onTool && opts.onTool({ name: name, result: String(out.text || ''), sources: out.sources || undefined });
      } catch (e) {
        obs = '(tool error: ' + (e.message || e) + ' — try a different approach or answer from what you have)';
        opts.onTool && opts.onTool({ name: name, result: String(obs) });
      }
      messages.push({ role: 'tool', tool_call_id: wire[k].id, name: name, content: obs });
    }
  }

  if (round === MAX_ROUNDS && !finalText) {
    messages.push({ role: 'user', content: 'Tool budget exhausted. Give your FINAL answer now from what you have, citing sources as [n] if any.' });
    var last = await roundTrip(c, opts, messages, null); // no tools on the forced final
    if (last.think) lastThink = String(last.think);
    finalText = (last.text || '').trim();
    if (finalText && !last.emitted && opts.onDelta) {
      try { opts.onDelta(dsmlClean(finalText)); } catch (e) { /* never fatal */ }
    }
  }

  // ── v0.81.7 THE FINAL-ANSWER NET — reasoning-without-reply is dead ──
  if (!finalText || !finalText.trim()) {
    var tail = (lastThink || '').trim();
    if (tail) {
      var clip = tail.length > 900 ? '…' + tail.slice(-900) : tail;
      finalText = '(the model finished its reasoning without sending a visible reply — its last thought:)\n' + clip;
    } else {
      finalText = '(the model returned an empty response — try again or pick a different model)';
    }
    if (opts.onDelta) {
      try { opts.onDelta(finalText); } catch (e) { /* never fatal */ }
    }
  }

  opts.onStatus && opts.onStatus('idle');
  return { text: finalText, usage: usage, sources: allSources };
}

// bridgeToolError — v0.27.1: turn a failed /api/tools/* response into an
// observation-ready error string. The engine returns JSON {"error": "..."}
// with the REAL cause (which engine 502'd, whether the page was 404/private,
// timeouts, …); the old path threw 'HTTP <status>' which said nothing.
// The trailing guidance is what stops the retry-the-identical-call loops.
async function bridgeToolError(resp) {
  var detail = '';
  try {
    var body = await resp.json();
    if (body && body.error) detail = String(body.error);
  } catch (e) { /* non-JSON body — fall through to the status */ }
  if (!detail) detail = 'HTTP ' + resp.status;
  var hint = '';
  if (/HTTP 40[34]/.test(detail)) {
    hint = ' The page does not exist for anonymous access — it is likely private, deleted, or the URL is wrong.';
  } else if (/rate|502|503|429|timeout|deadline|unreachable|failed/i.test(detail)) {
    hint = ' This looks like a network/rate-limit failure, not a missing page.';
  }
  return detail + '.' + hint + ' Do not repeat the exact same call — try a different query/URL, a different tool, or answer from what you already know and tell the user what failed.';
}

async function roundTrip(c, opts, messages, toolSpecs) {
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = await roundTripOnce(c, opts, messages, null, toolSpecs);
    if (res.aborted || !res.err) {
      // v0.20 EMPTY-ROUND GUARD → v0.81.7 THE REASONING-ONLY NET: a
      // 200 stream that ends with ZERO text (thinking models that
      // finish inside reasoning_content — Privatemodeai's kimi class —
      // or a proxy truncation ending cleanly after the usage chunk).
      // v0.77.5's fix blindly retried the SAME messages: a reasoning-only
      // model reproduces the same reasoning-only round and the turn died
      // on "the model returned an empty response" (the user's report:
      // the reasoning bubble closes, then NOTHING — no reply, ever).
      // The retry is now ARMED: the final-answer nudge is appended FIRST
      // (the model is TOLD to answer as plain text), and if the nudged
      // round is STILL empty the result carries the reasoning (think)
      // back with NO error — runToolLoop's turn-end net synthesizes the
      // reply from it instead of surfacing an error.
      if (!res.aborted && (res.text || '').trim() === '' && !(res.toolCalls || []).length) {
        messages.push({ role: 'assistant', content: '(the previous reply contained reasoning but no visible answer)' });
        messages.push({ role: 'user', content: '(system: your last reply ended after its reasoning without a visible answer. Reply NOW with your FINAL answer as plain text — no tool calls, no more reasoning.)' });
        // v0.82.3 THE ANSWER-FORCE RETRY: the v0.81.7 nudge round re-sent
        // the SAME effort shape (chat_template_kwargs.thinking = true for
        // kimi) — the model was literally CONFIGURED to think again on the
        // retry, so it reproduced the reasoning-only shape and the turn
        // still died (the user's live log: 19 tool calls, "it said it will
        // give a summary, then didn't"). The retry now DISABLES thinking —
        // Moonshot's own documented instant mode (Kimi K2.5/K2.6: "to use
        // instant mode, pass {'chat_template_kwargs': {"thinking": False}}")
        // — so the model MUST spend its output budget on visible content.
        var retryRound = await roundTripOnce(c, opts, messages, { noThink: true }, toolSpecs);
        if ((retryRound.text || '').trim() !== '' || retryRound.aborted || retryRound.err) {
          retryRound.usage = mergeUsage(res.usage, retryRound.usage) || retryRound.usage;
          if (!retryRound.think) retryRound.think = res.think || '';
          res = retryRound;
        } else {
          // still empty after the nudge: BOTH rounds' reasoning (the
          // first usually carries the analysis — the observation-driven
          // chain case — the retry the final intention) + usage ride
          // home; the turn-end net decides what the user sees
          res = { text: '', usage: mergeUsage(res.usage, retryRound.usage) || null,
                  emitted: false, aborted: false, err: null,
                  think: (((res.think || '') + ' ' + (retryRound.think || '')).slice(-2400)) };
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

async function roundTripOnce(c, opts, messages, force, toolSpecs) {
  var full = '';
  var usage = null;
  var emitted = false;     // any onDelta fired (retry safety)
  // v1.13.5 THE LAST ACTION: tool_calls assemble here (the PM twin of
  // the engine's scanSSECollect) — PM streams them as
  // delta.tool_calls[{index, id, function:{name, arguments fragments}}].
  // There is NO suppression state machine anymore: content always
  // streams live (a tool-call round carries no visible prose to hide),
  // and the per-tool progress lines fire at EXECUTION time in the loop.
  var callsByIdx = {};

  // v0.22b SMOOTH PUMP — PM's proxy delivers the entire reply content as
  // ONE chunk (live probe: 2961 chars in a single delta after 18s of
  // streamed thinking — the "replies outside the thinking box don't stream
  // smoothly" root cause, provider-side batching we can't un-batch).
  // v0.23: the pump now targets a FIXED DURATION (0.6–3.5s, ~900 chars/s)
  // instead of a fixed huge chunk size — the old 96-chars/4ms pacing
  // finished a 3000-char reply in ~130ms, which read as "all at once".
  var pumpQueue = '';
  var pumping = null;
  var enqueue = function (text) {
    if (!text) return;
    pumpQueue += text;
    if (!pumping) {
      pumping = (async function () {
        while (pumpQueue.length > 0) {
          var targetSec = Math.min(3.5, Math.max(0.6, pumpQueue.length / 900));
          var n = Math.max(8, Math.ceil(pumpQueue.length / (targetSec * 100)));
          var piece = pumpQueue.slice(0, n);
          pumpQueue = pumpQueue.slice(n);
          opts.onDelta && opts.onDelta(piece);
          emitted = true;
          await new Promise(function (r) { setTimeout(r, 10); });
        }
        pumping = null;
      })();
    }
  };
  var drainPump = function () { return pumping || Promise.resolve(); };

  var out = { text: '', usage: null, emitted: false, aborted: false, err: null, toolCalls: [] };
  var body = {
    model: opts.model,
    messages: messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  // v1.13.5: the MCP-bus manifest rides the request — PM passes tools[]
  // through to the model natively (verified live on glm). toolSpecs null
  // (unavailable, rejected, or the forced-final round) = a plain round.
  if (toolSpecs && toolSpecs.length) {
    body.tools = toolSpecs;
    body.tool_choice = 'auto';
  }
  // v0.42 DYNAMIC EFFORT SHAPE → v0.89.2 THE DOCS TRUTH (privatemode.ai
  // verified 2026-10-01, same table as the engine's effort.go SOURCE 1.5
  // and chatpanel's pmDocsLadder). PM's live surface per model family:
  //   · kimi → chat_template_kwargs.thinking boolean; 'on' → true, and
  //     **'off' → thinking: FALSE** (the docs: "chat_template_kwargs:
  //     {"thinking": false} switches reasoning off"). The OLD code sent
  //     NOTHING for 'off' — PM's default is thinking ON, so dialing kimi
  //     down did nothing (the user's "can't use kimi on actual effort
  //     modes").
  //   · glm-5.x (5.2/5.3/flash/-latest) + gpt-oss → top-level
  //     reasoning_effort with the enum level (low/high/max ·
  //     low/medium/high; the docs map any other GLM value to max).
  //   · gemma / glm-5.1 style → chat_template_kwargs.enable_thinking.
  // The 400-resilience net in the engine covers any mismatch (PM 400s
  // are retried without the param); the browser net below mirrors it.
  if (opts.effort && opts.effort !== '') {
    var mLower = String(opts.model || '').toLowerCase();
    var isBool = /^(on|off)$/.test(opts.effort);
    if (mLower.indexOf('kimi') >= 0) {
      // v0.89.2: 'off' is a REAL wire param — thinking:false (was: send
      // nothing, which left kimi thinking at PM's default ON).
      body.chat_template_kwargs = { thinking: opts.effort !== 'off' };
    } else if (mLower.indexOf('gemma') >= 0 || mLower.indexOf('glm-5.1') >= 0) {
      body.chat_template_kwargs = { enable_thinking: opts.effort !== 'off' };
    } else if (isBool) {
      // an on/off level on a family without an enum — the honest
      // boolean toggle (on → true, off → false).
      body.chat_template_kwargs = { thinking: opts.effort !== 'off' };
    } else {
      body.reasoning_effort = opts.effort;
    }
  }
  // v0.83.2 THE BROWSER-SIDE 400-RESILIENCE NET: the PM chat path is
  // browser-only (the engine's retry-without-param net in chat.go can't
  // cover it). A 400 whose body names the effort/thinking request fields
  // (the same trigger words the engine's mentionsEffortParam uses, incl.
  // the Pydantic literal_error family) retries ONCE with the effort params
  // stripped — the turn still completes, only the dial is dropped. The
  // recursion guard is force.noEffort (the second attempt never retries).
  if (force && force.noEffort) {
    delete body.reasoning_effort;
    delete body.chat_template_kwargs;
  }
  // v0.82.3 THE ANSWER-FORCE SHAPE: the final-answer nudge retry runs with
  // thinking DISABLED — the model that just finished inside reasoning_content
  // must not be handed the thinking toggle again. Kimi gets Moonshot's
  // documented boolean off-switch (chat_template_kwargs.thinking:false — the
  // K2.5/K2.6 "instant mode"); the gemma/glm-5.1 enable_thinking family gets
  // its documented false; every other model just DROPS the effort param
  // (their provider default runs non-thinking or light — no unverified
  // shapes on the rescue path).
  if (force && force.noThink) {
    var mNo = String(opts.model || '').toLowerCase();
    delete body.reasoning_effort;
    if (mNo.indexOf('kimi') >= 0) {
      body.chat_template_kwargs = { thinking: false };
    } else if (mNo.indexOf('gemma') >= 0 || mNo.indexOf('glm-5.1') >= 0) {
      body.chat_template_kwargs = { enable_thinking: false };
    } else {
      delete body.chat_template_kwargs;
    }
  }
  try {
    var stream = await c.streamChatCompletions(body, { signal: opts.signal || undefined });
    // v0.27.1: stamp the thinking phase's END so the UI timer freezes at
    // true thinking duration. Without it the bubble's elapsed kept
    // growing through tool execution + the whole turn (observed live:
    // "reasoning · 181s" on a round that thought ~30s and spent the rest
    // waiting on rate-limited search retries).
    var thinkOpen = false;
    // v0.81.7: the reasoning ACCUMULATES (bounded — the last 2400 chars
    // ride home as res.think) so the turn-end net can synthesize a reply
    // when a thinking model finishes inside reasoning_content and never
    // sends content.
    var thinkText = '';
    var thinkClose = function () {
      if (thinkOpen) { thinkOpen = false; opts.onThinkingEnd && opts.onThinkingEnd(); }
    };
    for await (var chunk of stream) {
      var ch = chunk || {};
      if (ch.choices && ch.choices.length) {
        var d = ch.choices[0].delta || {};
        // v0.82.3: capture the round's finish_reason — 'length' means the
        // output budget truncated the stream (a reasoning tail can burn
        // it all); the empty-retry's fresh round resets the budget.
        var fr = ch.choices[0].finish_reason;
        if (fr) out.finish = fr;
        if (d.reasoning_content) {
          thinkOpen = true;
          thinkText = (thinkText + d.reasoning_content).slice(-2400);
          opts.onThinking && opts.onThinking(d.reasoning_content);
        }
        // v1.13.5: structured tool_calls deltas assemble by index
        if (d.tool_calls && d.tool_calls.length) {
          thinkClose();
          for (var tci = 0; tci < d.tool_calls.length; tci++) {
            var tc = d.tool_calls[tci] || {};
            var slot = callsByIdx[tc.index || 0] || (callsByIdx[tc.index || 0] = { id: '', name: '', arguments: '' });
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name = slot.name + tc.function.name;
            if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
          }
        }
        if (d.content) {
          thinkClose(); // content follows thinking → the thinking phase is over
          full += d.content;
          enqueue(dsmlClean(d.content)); // v0.95.4: DSML markup never renders
        }
      }
      if (ch.usage) usage = normUsage(ch.usage);
    }
    thinkClose(); // stream ended while still thinking
    // v1.13.5: assemble the round's tool calls (index order)
    var idxs = Object.keys(callsByIdx).map(Number).sort(function (a, b) { return a - b; });
    for (var ci = 0; ci < idxs.length; ci++) {
      var cc = callsByIdx[idxs[ci]];
      if (cc.name) out.toolCalls.push({ id: cc.id || ('call_' + idxs[ci]), name: cc.name, arguments: cc.arguments || '{}' });
    }
    await drainPump(); // visual stream finishes BEFORE the round resolves
    opts.onStatus && opts.onStatus('idle');
    out.text = full; out.usage = usage; out.emitted = emitted;
    out.think = thinkText; // v0.81.7: the reasoning tail rides home
    return out;
  } catch (e) {
    thinkClose(); // aborted/failed mid-thinking — freeze the timer anyway
    if (e && e.name === 'AbortError') {
      opts.onStatus && opts.onStatus('error');
      pumpQueue = ''; // aborted round — stop the visual stream where it is
      out.text = full; out.usage = usage; out.emitted = emitted; out.aborted = true; return out;
    }
    // v0.83.2: the effort-400 retry — see the force.noEffort note above.
    if (!(force && force.noEffort) &&
        (body.reasoning_effort || body.chat_template_kwargs) &&
        mentionsEffort400(e)) {
      opts.onProgress && opts.onProgress({ text: 'effort param rejected — retrying without it…' });
      try {
        return await roundTripOnce(c, opts, messages, { noEffort: true }, toolSpecs);
      } catch (e2) { e = e2; /* fall through to the terminal path */ }
    }
    opts.onStatus && opts.onStatus('error');
    pumpQueue = ''; // failed round — stop the visual stream where it is
    out.err = e;
    out.emitted = emitted;
    return out;
  }
}

// v0.83.2: the PM twin of the engine's mentionsEffortParam trigger — a 400
// that complains about the reasoning/effort/thinking REQUEST fields (not
// auth, quota, the model id, the payload…). Mirrors chat.go's word list
// (incl. the v0.69 Pydantic literal_error family PM deploys for enums).
function mentionsEffort400(e) {
  var s = String((e && (e.message || e.msg || e.detail)) || e || '').toLowerCase();
  var status = (e && (e.status || e.statusCode || e.code)) || '';
  if (status !== 400 && status !== '400' && s.indexOf('400') < 0 && s.indexOf('literal_error') < 0 &&
      s.indexOf('validation error') < 0 && s.indexOf('input should be') < 0) {
    return false; // not a request-validation 400
  }
  if (s.indexOf('reason') < 0 && s.indexOf('effort') < 0 && s.indexOf('thinking') < 0 &&
      s.indexOf('chat_template') < 0) {
    return false; // a 400 about something else (auth/quota/model/payload)
  }
  return s.indexOf('unexpected') >= 0 || s.indexOf('unknown') >= 0 ||
    s.indexOf('unrecognized') >= 0 || s.indexOf('not supported') >= 0 ||
    s.indexOf('unsupported') >= 0 || s.indexOf('invalid') >= 0 ||
    s.indexOf('additional') >= 0 || s.indexOf('not allowed') >= 0 ||
    s.indexOf('prohibited') >= 0 || s.indexOf('literal_error') >= 0 ||
    s.indexOf('validation error') >= 0 || s.indexOf('input should be') >= 0;
}

window.PMBridge = {
  streamChat: streamChat,
  available: function () { return typeof WebSocket !== 'undefined' && typeof WebAssembly !== 'undefined'; },
  // v0.77.5: the rig suite drives the REAL loop with a scripted fake core
  // (chunk-level SSE shapes — the empty-round and phantom-recap exits).
  // Production code never touches this hook.
  __test: { runToolLoop: runToolLoop, roundTrip: roundTrip }
};
