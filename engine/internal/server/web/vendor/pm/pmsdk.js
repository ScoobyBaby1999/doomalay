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
  'You have tools. To call one, put a line in EXACTLY this shape as the LAST line of your reply:',
  'ACTION: <tool_name> {<json arguments>}',
  '',
  'HOW IT WORKS (do this every time a tool would help — never ask permission, never announce a plan, just call it in your very first reply):',
  'USER: What time is it in Tokyo, and what is 37*14?',
  'ASSISTANT: ACTION: time_now {"tz": "Asia/Tokyo"}',
  'SYSTEM (OBSERVATION — automatic, never wait for it): 2026-09-18 09:41 +09:00',
  'ASSISTANT: ACTION: calculator {"expr": "37*14"}',
  'SYSTEM: 518',
  'ASSISTANT: It is 09:41 in Tokyo (UTC+9), and 37*14 = 518.',
  '',
  'RULES:',
  '- One tool call per reply. The ACTION line must be the last line, plain text (no bold, no backticks, no code fence), and contain nothing but the call.',
  '- After every ACTION the system AUTOMATICALLY sends you an OBSERVATION (the tool\'s output) as a user message — you never wait for the user for this. Read it and IMMEDIATELY issue your next ACTION (up to 24 chained calls per turn).',
  '- NEVER say you cannot do something (search the web, make a file, calculate, check the time) — you CAN, with these tools. Try the tool first; only report failure after its OBSERVATION says so.',
  '- ONLY when you have everything you need do you write your FINAL answer as a normal reply (no ACTION line). Never fabricate tool results.',
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
  'ACTION: persona_list {} — list YOUR personas and placeholders in this chat (id, name, mode, preview)',
  'ACTION: persona_set {"id": "p_123", "name": "…", "text": "…", "activate": false} — create or edit your own persona (omit id to create; new ones start inactive; activate:true makes it the one always-active persona and deactivates any previous)',
  'ACTION: persona_activate {"id": "p_123"} — become a listed persona (deactivates the previous one); {"id": ""} deactivates all (back to the app default)',
  'ACTION: placeholder_set {"key": "mood", "value": "playful"} — set a {placeholder} usable in personas and triggers',
  'For REAL files (Word/Excel/zip) ALWAYS use docx_create/xlsx_create/zip_create instead of hand-writing base64 into the chat — the tools build valid binaries the user can download.' + ' After a file tool reports "Saved as artifact", do NOT also emit an artifact block for that same file — that would attach it twice.',
  'Use a tool whenever it beats guessing (math, time, encodings, ids, validation, files). You may inspect and rework your own personality with the persona tools whenever the user asks for a change in tone, style, name, or behavior — do it instead of only describing how it would be done.'
].join('\n');

var PM_WEB_TOOLS_PROTOCOL = [
  'You also have web tools (live internet):',
  'ACTION: web_search {"query": "<search terms>"}',
  'ACTION: web_fetch {"url": "<https url>"}',
  'Cite web sources inline as [1], [2] matching the search result numbering. Never fabricate URLs.'
].join('\n');

// v0.60 pt C.13: THE LIB PILL — the superpowers discipline on the PM path.
// When the chat's lib gate is ON, the system message ALSO carries the full
// bootstrap (fetched from the engine: using-superpowers verbatim + this
// harness's tool map — porting guide Part 3: "the bootstrap is the entire
// difference between the port working and not working") plus this protocol.
var PM_LIB_PROTOCOL = [
  'You also have THE SKILL LIBRARY (methodology skills — brainstorming, writing-plans, TDD, systematic-debugging, verification…):',
  'ACTION: skills {"action": "list"} — the skill index',
  'ACTION: skills {"action": "search", "q": "debug"} — ranked hits',
  'ACTION: skills {"action": "load", "skill": "brainstorming"} — load a skill and FOLLOW it',
  'ACTION: skills {"action": "files", "skill": "…"} / {"action": "read", "skill": "…", "path": "…"} — companion files',
  'ACTION: hublib {"action": "search", "q": "research", "type": "skill|doc|script|template"} — browse the public hub',
  'ACTION: hublib {"action": "get", "type": "…", "repo": "…", "id": "…"} — an item\u2019s detail + payload head',
  'ACTION: hublib {"action": "download", "type": "…", "repo": "…", "id": "…"} — download into the user\u2019s library + use it',
  'If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST load it BEFORE starting the work it covers. Load → follow the skill\u2019s workflow to the letter.'
].join('\n');

// The bootstrap cache (per page — the skill body is static per install).
var _pmBootstrapCache = null;
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

// v0.20: repair truncated tool-call JSON — models sometimes cut the
// closing brace/quote (observed live: `ACTION: web_search {"query": "cat
// diaper how to put on guide"` with no closing }). Append what's missing
// instead of losing the tool call.
// v0.25: (a) escape RAW newlines/tabs/CR inside string values (models paste
// multi-line file content into zip_create args — invalid JSON otherwise;
// the dock-CSV "files is required" bug), (b) close brackets AND braces
// innermost-first (a truncated "files": [{…} needs ] AND }).
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

// v0.22: find the LAST complete line that starts with "ACTION:" —
// preambles are legal, glued JSON is legal, several ACTION lines are
// legal (the last is operative). Returns null or {name, rest, lineStart}.
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

// v0.28 STUPID-PROOF — the tolerant ACTION-line normalizer (mirrors the
// Go engine's stripActionDecorations): case-insensitive, optional space
// before the colon, optional MISSING colon, markdown chrome (**bold**,
// __italic__, `code`, "> " quotes, "- "/"* " bullets), and a mid-line
// backtick-wrapped call ("Here's how: `ACTION: …`"). Returns the cleaned
// line, or "" when it carries no ACTION at all.
var ACTION_HEAD_RE = /^ACTION[ \t]*(?:\*\*|__|`)?[ \t]*(?::|[ \t])[ \t]*(?:\*\*|__|`)?[ \t]*([a-zA-Z0-9_-]+)/i;

function stripActionDecorations(line) {
  var s = String(line || '').trim();
  for (;;) {
    if (s.startsWith('**') || s.startsWith('__')) s = s.slice(2).trim();
    else if (s.charAt(0) === '`') { s = s.slice(1).replace(/^`/, '').trim(); }
    else if (s.startsWith('> ') || s.startsWith('- ') || s.startsWith('* ')) s = s.slice(2).trim();
    else break;
  }
  if (!ACTION_HEAD_RE.test(s)) {
    // mid-line backtick wrap: "… `ACTION: …" — slice from the last one
    var m = /`[ \t]*ACTION/i.exec(s);
    if (m && m.index >= 0) {
      s = s.slice(m.index + 1).trim();
      for (;;) {
        if (s.startsWith('**') || s.startsWith('__')) s = s.slice(2).trim();
        else if (s.startsWith('> ') || s.startsWith('- ') || s.startsWith('* ')) s = s.slice(2).trim();
        else break;
      }
    }
  }
  return s.replace(/[`*_ \t]+$/, ''); // closing inline-code/bold after the args
}

function isActionLineJS(line) {
  return ACTION_HEAD_RE.test(stripActionDecorations(line));
}

function findActionLine(text) {
  var lines = String(text || '').split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    if (isActionLineJS(lines[i])) {
      var head = extractActionHeadJS(stripActionDecorations(lines[i]));
      if (head) return { name: head.name, rest: head.rest, lineStart: text.lastIndexOf('\n', text.indexOf(lines[i])) + 1 };
      return null;
    }
  }
  return null;
}

// tolerant head extractor: {name, rest} off a cleaned line ("" rest → "{}").
function extractActionHeadJS(line) {
  var m = ACTION_HEAD_RE.exec(line);
  if (!m) return null;
  var name = m[1].replace(/[*_`]+$/, ''); // **calculator** → calculator
  var rest = line.slice(m.index + m[0].length).trim().replace(/^[*_` \t]+/, '').replace(/[*_`]+$/, '');
  return { name: name, rest: rest || '{}' };
}

// v0.25 findActions — EVERY executable action in the reply (mirrors the Go
// engine's parseActions):
//   1. the LAST ACTION line is operative (preambles are legal)
//   2. its JSON may extend over following lines (pretty-printed args) —
//      brace-balance extension
//   3. GLUED actions on one line — `base64 {…} ACTION: hash {…}` (the dock
//      CSV bug) — split at depth-0 ACTION: markers OUTSIDE strings; every
//      piece runs, observations are numbered
function findActions(text) {
  text = String(text || '');
  var lines = text.split('\n');
  var hit = -1;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (isActionLineJS(lines[i])) { hit = i; break; }
  }
  if (hit < 0) {
    // v0.60 pt C.13b: TRAILING GLUED ACTION — the model wrote prose then
    // glued the call after it on the SAME line (observed live on PM
    // glm-5.3: "…before we build. ACTION: skills {\"action\":\"load\"…}").
    // When the very END of the reply is a complete tool call (balanced
    // JSON terminated by the text's end — trailing prose never matches),
    // execute it instead of leaking the literal line to the user.
    var gm = /ACTION:\s*([a-zA-Z0-9_-]+)\s*(\{[\s\S]*?\})\s*$/i.exec(text.trim());
    if (gm && balancedJSONJS(gm[2])) {
      return splitGluedJS(gm[1] + ' ' + gm[2]);
    }
    return [];
  }
  // v0.28: tolerant extractor — decorations, "Action :", missing colon.
  var head = extractActionHeadJS(stripActionDecorations(lines[hit]));
  if (!head) return [];
  var name = head.name, rest = head.rest;
  if (!rest) rest = '{}';
  // multi-line extension: JSON braces must balance
  if (rest.charAt(0) === '{' && !balancedJSONJS(rest)) {
    for (var j = hit + 1; j < lines.length && j <= hit + 40; j++) {
      rest += '\n' + lines[j];
      if (balancedJSONJS(rest)) break;
    }
  }
  return splitGluedJS(name + ' ' + rest);
}

function balancedJSONJS(s) {
  var inStr = false, esc = false, depth = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth === 0 && !inStr;
}

// splitGluedJS — depth-0 "ACTION:" markers outside strings split the region.
function splitGluedJS(region) {
  var out = [], inStr = false, esc = false, depth = 0, start = 0;
  for (var i = 0; i < region.length; i++) {
    var ch = region[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (!inStr && depth <= 0 && hasActionMarkerJS(region, i)) {
      var seg = region.slice(start, i).trim();
      if (seg) out.push(seg);
      i += 6; start = i + 1; // skip "ACTION:"
    }
  }
  var tail = region.slice(start).trim();
  if (tail) out.push(tail);
  if (!out.length) out.push(region);
  return out.map(function (seg) {
    var mm = seg.match(/^([a-zA-Z0-9_-]+)([\s\S]*)$/);
    if (!mm) return null;
    return { name: mm[1].toLowerCase(), rest: mm[2].trim() || '{}' };
  }).filter(Boolean);
}

function hasActionMarkerJS(s, i) {
  if (i + 7 > s.length) return false;
  if (s.substr(i, 7).toUpperCase() !== 'ACTION:') return false;
  if (i > 0) {
    var p = s[i - 1];
    if (p !== ' ' && p !== '\t' && p !== '\n' && p !== '\r' && p !== '{' && p !== '}') return false;
  }
  return true;
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
    if (isActionLineJS(complete[i])) return true; // it IS one
  }
  return nonBlank < 3;
}

async function runToolLoop(c, opts) {
  var toolsOn = !!opts.tools;
  var system = opts.messages[0] && opts.messages[0].role === 'system'
    ? opts.messages[0].content + '\n\n' + PM_TOOLS_PROTOCOL + (toolsOn ? '\n\n' + PM_WEB_TOOLS_PROTOCOL : '')
    : PM_TOOLS_PROTOCOL + (toolsOn ? '\n\n' + PM_WEB_TOOLS_PROTOCOL : '');
  // v0.60 pt C.13: the lib gate — ON prepends the full bootstrap (the
  // using-superpowers body fetched from the engine, verbatim upstream +
  // the harness tool map) and arms the skills/hublib ACTION protocol.
  if (opts.lib) {
    try {
      var boot = await fetchLibBootstrap(opts.sessionId || '');
      system = boot + '\n\n' + system + '\n\n' + PM_LIB_PROTOCOL;
    } catch (e) {
      // gate off server-side / engine hiccup — degrade to the plain loop
      opts.onProgress && opts.onProgress({ text: 'skill library unavailable — ' + (e.message || e) });
    }
  }
  var messages = [{ role: 'system', content: system }].concat(
    opts.messages[0] && opts.messages[0].role === 'system' ? opts.messages.slice(1) : opts.messages);
  var allSources = [];
  var finalText = '';
  var usage = null;
  var MAX_ROUNDS = 24; // v0.22: 24 — 10-file generations + zip round-trip fit
  var anyToolRun = false; // v0.24: has a tool executed yet this turn
  var nudged = false;     // v0.24: the auto-proceed push fired (max once)

  for (var round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal && opts.signal.aborted) {
      return { text: finalText, usage: usage, aborted: true, sources: allSources };
    }
    var res = await roundTrip(c, opts, messages);
    usage = res.usage || usage;
    var reply = (res.text || '').trim();

    var act = findActions(reply);
    if (!act.length) {
      // v0.24 AUTO-PROCEED NUDGE (same as the engine loop): models that
      // "just say it will start and make me have to tell it go" — when NO
      // tool has run yet, the reply is short, and it reads as intent-to-act,
      // push once instead of ending the turn.
      if (!nudged && round === 0 && !anyToolRun && looksLikeIntentOnly(reply)) {
        nudged = true;
        opts.onProgress && opts.onProgress({ text: 'model announced a plan — telling it to proceed…' });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: '(system: proceed now — do not wait for permission and do not ask. Emit your ACTION tool-call lines immediately and carry the task through to the final result.)' });
        continue;
      }
      // v0.28 CAPABILITY-DENIAL NUDGE — the model claimed it can't (no
      // internet / no tools / knowledge cutoff) while the tools are armed.
      // Push once, NAMING them (mirrors the Go engine's denial branch).
      if (!nudged && round === 0 && !anyToolRun && looksLikeCapabilityDenial(reply)) {
        nudged = true;
        opts.onProgress && opts.onProgress({ text: "model said it can't — reminding it about its tools…" });
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: '(system: you DO have tools — this app runs a live tool protocol. web_search and web_fetch give you the live internet (when enabled); calculator, time_now, uuid, random, base64, hash, json_tool, text_stats, url_encode, regex_extract, docx_create, xlsx_create, zip_create, zip_extract, archive_create, archive_extract and delegate all run on-device. Your earlier statement that you cannot access or verify this was wrong. Call the right tool NOW with an ACTION line and finish the task.)' });
        continue;
      }
      finalText = reply;
      break;
    }
    // v0.38 PHANTOM-ACTION FILTER (mirrors the Go engine's actionHasRequiredArg):
    // the model RECAPS an earlier call inside its final prose
    // ("…I ran ACTION: web_search…") — the parser grabs the line, args
    // default to {}, and the loop executed a REAL empty search whose error
    // observation confused the next round. Arg-requiring tools with an
    // empty required arg are recaps, not calls; if nothing executable
    // remains, this round WAS the final answer.
    var live = [];
    for (var fi = 0; fi < act.length; fi++) {
      if (actionHasRequiredArgJS(act[fi])) live.push(act[fi]);
    }
    if (!live.length) {
      finalText = reply;
      break;
    }
    act = live;
    anyToolRun = true;
    // v0.22: a >700-byte preamble streamed before its ACTION line — wipe
    // the leaked text so the tool pills render on a clean slate.
    if (res.emitted && opts.onReset) opts.onReset();

    // v0.25 MULTI-ACTION: execute EVERY parsed action (glued lines split —
    // the dock-CSV bug), observations numbered so the model can attribute
    // results. Mirrors the Go engine's executeAction loop.
    var obsParts = [];
    for (var k = 0; k < act.length; k++) {
      var obs = 'OBSERVATION:\n(tool error)';
      try { obs = await execAction(act[k], opts, allSources); }
      catch (e) {
        obs = 'OBSERVATION:\n(tool error: ' + (e.message || e) + ' — try a different approach or answer from what you have)';
      }
      if (act.length > 1) {
        obsParts.push('OBSERVATION (' + (k + 1) + ' of ' + act.length + ' — ' + act[k].name + '):\n' + String(obs).replace(/^OBSERVATION:\n/, ''));
      } else {
        obsParts.push(obs);
      }
    }
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: obsParts.join('\n\n') });
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

// ── v0.28 stupid-proof tool-name + JSON canonicalizers ───────────────────
//
// canonicalToolNameJS — alias table (mirrors the Go engine's
// canonicalToolName, kept in lockstep) + a Levenshtein ≤2 fuzzy snap for
// near-miss spellings ("docx_creat", "times_now"). Models invent names;
// the chain keeps moving instead of erroring.
var PM_TOOL_ALIASES = {
  search: 'web_search', websearch: 'web_search', google: 'web_search', bing: 'web_search',
  duckduckgo: 'web_search', find: 'web_search', web: 'web_search', internet: 'web_search',
  lookup: 'web_search', search_web: 'web_search', web_lookup: 'web_search',
  fetch: 'web_fetch', open_url: 'web_fetch', browse: 'web_fetch', get: 'web_fetch',
  visit: 'web_fetch', read_url: 'web_fetch', url: 'web_fetch', read_page: 'web_fetch',
  open_page: 'web_fetch', read_website: 'web_fetch',
  calc: 'calculator', math: 'calculator', compute: 'calculator', evaluate: 'calculator', arithmetic: 'calculator',
  time: 'time_now', now: 'time_now', clock: 'time_now', date: 'time_now', get_time: 'time_now',
  timestamp: 'time_now', current_time: 'time_now', datetime: 'time_now',
  guid: 'uuid', uuid4: 'uuid', uuidgen: 'uuid', generate_uuid: 'uuid', new_uuid: 'uuid', random_uuid: 'uuid',
  rand: 'random', random_number: 'random', dice: 'random', randomint: 'random',
  b64: 'base64', base_64: 'base64', base64encode: 'base64', base64decode: 'base64',
  md5: 'hash', sha: 'hash', sha1_hash: 'hash', digest: 'hash', sha256: 'hash', checksum: 'hash',
  json: 'json_tool', json_format: 'json_tool', validate_json: 'json_tool', jsonlint: 'json_tool', json_check: 'json_tool',
  word_count: 'text_stats', count: 'text_stats', stats: 'text_stats', wc: 'text_stats', textstats: 'text_stats', count_words: 'text_stats',
  urldecode: 'url_encode', percent_encode: 'url_encode', urlencode: 'url_encode', urlcodec: 'url_encode',
  regex: 'regex_extract', grep: 'regex_extract', findall: 'regex_extract', match: 'regex_extract', regexp: 'regex_extract',
  docx: 'docx_create', word: 'docx_create', word_doc: 'docx_create', make_docx: 'docx_create', create_docx: 'docx_create', wordfile: 'docx_create', word_file: 'docx_create',
  xlsx: 'xlsx_create', excel: 'xlsx_create', spreadsheet: 'xlsx_create', make_xlsx: 'xlsx_create', create_xlsx: 'xlsx_create', excel_file: 'xlsx_create', excelfile: 'xlsx_create',
  make_archive: 'archive_create', create_archive: 'archive_create', '7z': 'archive_create', '7zip': 'archive_create', make_7z: 'archive_create',
  tar: 'archive_create', make_tar: 'archive_create', tarball: 'archive_create', gzip: 'archive_create',
  archive: 'archive_create', bundle: 'archive_create', compress: 'archive_create', pack: 'archive_create',
  unzip: 'archive_extract', extract: 'archive_extract', decompress: 'archive_extract', unarchive: 'archive_extract',
  untar: 'archive_extract', unrar: 'archive_extract', ungzip: 'archive_extract', gunzip: 'archive_extract',
  open_archive: 'archive_extract', list_archive: 'archive_extract', extract_archive: 'archive_extract',
  '7z_extract': 'archive_extract', tar_extract: 'archive_extract', extract_files: 'archive_extract',
  persona: 'persona_list', personas: 'persona_list', list_personas: 'persona_list', my_personas: 'persona_list', who_am_i: 'persona_list',
  set_persona: 'persona_set', persona_edit: 'persona_set', edit_persona: 'persona_set', create_persona: 'persona_set',
  new_persona: 'persona_set', update_persona: 'persona_set',
  activate_persona: 'persona_activate', switch_persona: 'persona_activate', become: 'persona_activate', use_persona: 'persona_activate',
  placeholder: 'placeholder_set', set_placeholder: 'placeholder_set', variable: 'placeholder_set', set_variable: 'placeholder_set',
  // v0.60 pt C.13: the lib pill's superpowers tools.
  skill: 'skills', load_skill: 'skills', skill_load: 'skills', use_skill: 'skills',
  superpowers: 'skills', methodology: 'skills',
  hub: 'hublib', hub_library: 'hublib', library: 'hublib', public_library: 'hublib',
  browse_hub: 'hublib', download_skill: 'hublib'
};

var PM_ALL_TOOLS = ['calculator', 'time_now', 'uuid', 'random', 'base64', 'hash', 'json_tool', 'text_stats', 'url_encode', 'regex_extract', 'docx_create', 'xlsx_create', 'zip_create', 'zip_extract', 'archive_create', 'archive_extract', 'web_search', 'web_fetch', 'delegate', 'persona_list', 'persona_set', 'persona_activate', 'placeholder_set', 'skills', 'hublib'];

function canonicalToolNameJS(name) {
  var n = String(name || '').toLowerCase().trim();
  if (PM_TOOL_ALIASES[n]) return PM_TOOL_ALIASES[n];
  // fuzzy: typo-level near-miss of a real tool name
  var best = '', bestD = 3;
  for (var i = 0; i < PM_ALL_TOOLS.length; i++) {
    var d = levenshteinJS(n, PM_ALL_TOOLS[i], 2);
    if (d < bestD) { best = PM_ALL_TOOLS[i]; bestD = d; }
  }
  return best || n;
}

function levenshteinJS(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  var prev = [], cur = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    cur[0] = i;
    var rowMin = cur[0];
    for (var k = 1; k <= b.length; k++) {
      var cost = a[i - 1] === b[k - 1] ? 0 : 1;
      cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      if (cur[k] < rowMin) rowMin = cur[k];
    }
    if (rowMin > max) return max + 1;
    var t = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}

// lenientJSONJS — the non-JSON JSON Python-trained models emit (mirrors the
// Go engine's lenientJSON): smart quotes → straight, 'single quotes' →
// "double", trailing commas dropped, bare-word keys quoted.
function lenientJSONJS(s) {
  var str = String(s || '');
  str = str.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  var out = '', inD = false, inS = false, esc = false, lastCh = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (inD) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inD = false;
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') lastCh = ch;
      continue;
    }
    if (inS) {
      if (ch === "'") { out += '"'; inS = false; lastCh = '"'; }
      else if (ch === '"') { out += '\\"'; }
      else { out += ch; if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') lastCh = ch; }
      continue;
    }
    if (ch === '"') { inD = true; out += '"'; lastCh = '"'; continue; }
    if (ch === "'") { inS = true; out += '"'; lastCh = '"'; continue; }
    if (ch === ',') {
      var j = i + 1;
      while (j < str.length && /[\s]/.test(str[j])) j++;
      if (str[j] === '}' || str[j] === ']') continue; // trailing comma
      out += ','; lastCh = ','; continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      // possible bare key: identifier followed by ':' in key position
      var m = /^([A-Za-z0-9_]+)\s*:/.exec(str.slice(i));
      if (m && (lastCh === '{' || lastCh === ',')) {
        out += '"' + m[1] + '"';
        i += m[1].length - 1;
        lastCh = m[1].charAt(m[1].length - 1);
        continue;
      }
      out += ch; lastCh = ch; continue;
    }
    out += ch;
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') lastCh = ch;
  }
  return out;
}

// execAction — v0.25: ONE parsed tool call → its OBSERVATION string (the
// old inline dispatch, extracted so the multi-action loop can call it per
// action). Throws on unexpected errors (the loop catches → observation).
// v0.38 PHANTOM-ACTION FILTER helper (mirrors the Go engine's
// actionHasRequiredArg): does this parsed action carry its tool's REQUIRED
// argument? An arg-requiring tool with an empty required value is a RECAP
// of an earlier call quoted in final prose — not a call.
function actionHasRequiredArgJS(act) {
  var tool = canonicalToolNameJS(act.name);
  var arg = {};
  if (act.rest) {
    try { arg = JSON.parse(act.rest); }
    catch (e) {
      try { arg = JSON.parse(repairJSON(act.rest)); }
      catch (e2) { arg = {}; }
    }
  }
  if (typeof arg !== 'object' || arg === null) return true; // bare string — execAction wraps it
  var req = {
    web_search: 'query', web_fetch: 'url', delegate: 'prompt', calculator: 'expr',
    regex_extract: 'pattern', zip_create: 'name', docx_create: 'name',
    xlsx_create: 'name', archive_create: 'name',
    skills: 'action', hublib: 'action'
  }[tool];
  if (!req) return true; // no required arg (time_now, uuid, persona_list…)
  var v = arg[req];
  return typeof v === 'string' && v.trim() !== '';
}

async function execAction(act, opts, allSources) {
  var tool = canonicalToolNameJS(act.name);
  var arg = {};
  if (act.rest) {
    try { arg = JSON.parse(act.rest); }
    catch (e) {
      // truncated JSON — repair the missing braces/quotes, then retry;
      // v0.28: then LENIENT — single quotes / trailing commas / smart
      // quotes / bare keys (both orders — either flaw can mask the other).
      var fixed = repairJSON(act.rest);
      try { arg = JSON.parse(fixed); }
      catch (e2) {
        var l1 = lenientJSONJS(repairJSON(act.rest));
        try { arg = JSON.parse(l1); }
        catch (e3) {
          var l2 = repairJSON(lenientJSONJS(act.rest));
          try { arg = JSON.parse(l2); }
          catch (e4) {
            var bare = act.rest.replace(/^["'(`*_-]+/, '').replace(/["')`*_-]+$/, '');
            arg = bare;
          }
        }
      }
    }
  }
  // models sometimes pass the query as a bare string instead of JSON
  if (typeof arg === 'string') {
    var wrapped = act.rest.replace(/^[\("'`]+/, '').replace(/[\)"'`]+$/, '');
    // v0.28: per-tool bare-arg keys (mirrors the Go engine's switch — a
    // bare 'Asia/Tokyo' becomes EVERY plausible key; each tool reads its own).
    arg = { query: wrapped, url: wrapped, text: wrapped, expr: wrapped, pattern: wrapped,
            tz: wrapped, algo: wrapped, name: wrapped, artifact: wrapped,
            prompt: wrapped, id: wrapped, key: wrapped, value: wrapped, mode: wrapped,
            action: wrapped, skill: wrapped, type: wrapped, repo: wrapped, path: wrapped, q: wrapped };
  }

  // v0.60 pt C.13: THE SKILL LIBRARY + THE BOT-SIDE HUB — the engine serves
  // both (lib-gated server-side; browse always OK, load/download gated).
  if (tool === 'skills' || tool === 'hublib') {
    var act2 = String(arg.action || '').toLowerCase();
    if (!act2) {
      // bare "ACTION: skills brainstorming" → load it; bare hublib → search
      if (arg.skill || arg.name) { act2 = 'load'; arg.skill = arg.skill || arg.name; }
      else if (arg.q) act2 = 'search';
      else act2 = tool === 'skills' ? 'list' : 'search';
    }
    if (act2 === 'load' && !arg.skill) arg.skill = arg.name || arg.q || arg.id || '';
    var su = '/api/tools/' + tool + '?action=' + encodeURIComponent(act2);
    if (arg.q) su += '&q=' + encodeURIComponent(String(arg.q).slice(0, 200));
    if (arg.skill) su += '&skill=' + encodeURIComponent(String(arg.skill).slice(0, 200));
    if (arg.path) su += '&path=' + encodeURIComponent(String(arg.path).slice(0, 300));
    if (arg.type) su += '&type=' + encodeURIComponent(String(arg.type).slice(0, 40));
    if (arg.repo) su += '&repo=' + encodeURIComponent(String(arg.repo).slice(0, 200));
    if (arg.id) su += '&id=' + encodeURIComponent(String(arg.id).slice(0, 200));
    if (opts.sessionId) su += '&session=' + encodeURIComponent(opts.sessionId);
    var sProg = act2 === 'load' ? 'loading skill ' + (arg.skill || '') + '…'
      : act2 === 'download' ? 'downloading ' + (arg.id || '') + '…'
      : act2 === 'search' ? 'searching the ' + (tool === 'skills' ? 'skill library' : 'hub') + '…'
      : tool === 'skills' ? 'browsing the skill library…' : 'browsing the hub…';
    opts.onProgress && opts.onProgress({ text: sProg });
    opts.onTool && opts.onTool({ name: tool, summary: (act2 + ' ' + (arg.skill || arg.q || arg.id || '')).trim().slice(0, 80) });
    var rs = await fetch(su);
    if (!rs.ok) {
      var errS = 'tool error HTTP ' + rs.status;
      opts.onTool && opts.onTool({ name: tool, result: errS });
      return 'OBSERVATION:\n(' + errS + ' — try again with valid arguments)';
    }
    var ds = await rs.json();
    var outs = (ds && (ds.result || ds.error)) || '(empty)';
    opts.onTool && opts.onTool({ name: tool, result: String(outs).slice(0, 120) });
    return 'OBSERVATION:\n' + outs;
  }

  if (tool === 'web_search') {
    var q = arg.query || String(arg.q || '');
    if (!q) {
      // models sometimes omit the argument — teach, don't 400
      return 'OBSERVATION:\nerror: empty query. Usage: ACTION: web_search {"query": "<search terms>"}';
    }
    opts.onProgress && opts.onProgress({ text: 'searching the web…' });
    opts.onTool && opts.onTool({ name: 'web_search', summary: q });
    var r = await fetch('/api/tools/websearch?q=' + encodeURIComponent(q) + '&max=8');
    if (!r.ok) {
      // v0.27.1: the old throw surfaced a bare "HTTP 502" — the engine
      // wraps EVERY search failure in that status, and the model had no
      // idea WHAT failed (observed live: it retried the identical search
      // three times, then guessed "GitHub blocks bots"). Read the JSON
      // error body so the observation names the real cause, and pair it
      // with an explicit do-not-loop instruction.
      var sErr = await bridgeToolError(r);
      opts.onTool && opts.onTool({ name: 'web_search', result: 'error: ' + sErr });
      return 'OBSERVATION:\nerror: ' + sErr;
    }
    var data = await r.json();
    var results = (data && data.results) || [];
    for (var i = 0; i < results.length; i++) {
      allSources.push({ title: results[i].title, url: results[i].url, snippet: results[i].snippet });
    }
    var fmt = results.map(function (s, j) {
      return '[' + (j + 1) + '] ' + s.title + '\n' + s.url + '\n' + (s.snippet || '');
    }).join('\n\n');
    opts.onTool && opts.onTool({ name: 'web_search', result: (results.length + ' results') + (results[0] ? ' — ' + results[0].title : ''), sources: results });
    return 'OBSERVATION:\n' + (fmt || '(no results for this query — if you were looking for a specific named project/account, it may be private or nonexistent; say so instead of retrying)');
  }
  if (tool === 'web_fetch') {
    var u = arg.url || String(arg.u || '');
    if (!u) {
      return 'OBSERVATION:\nerror: empty url. Usage: ACTION: web_fetch {"url": "<https url>"}';
    }
    opts.onProgress && opts.onProgress({ text: 'reading ' + u.slice(0, 60) + '…' });
    opts.onTool && opts.onTool({ name: 'web_fetch', summary: u });
    var r2 = await fetch('/api/tools/webfetch?url=' + encodeURIComponent(u) + '&max=6000');
    if (!r2.ok) {
      // v0.27.1: same as web_search — surface the engine's error detail
      // (it distinguishes 404/private/deleted from network failures)
      // instead of a statusless "HTTP 502" the model can only guess at.
      var fErr = await bridgeToolError(r2);
      opts.onTool && opts.onTool({ name: 'web_fetch', result: 'error: ' + fErr });
      return 'OBSERVATION:\nerror: ' + fErr;
    }
    var d2 = await r2.json();
    opts.onTool && opts.onTool({ name: 'web_fetch', result: ((d2.text || '') + '').slice(0, 120) });
    return 'OBSERVATION:\n' + ((d2 && d2.text) || '(empty page)');
  }
  // LOCAL tool — the engine computes it (/api/tools/local).
  // v0.22: session-scoped so file tools save artifacts + zip_extract
  // can re-read what an earlier round saved.
  // v0.25: delegate routes to the engine's swarm fanout (was "unknown
  // tool" — dock CSV event 31).
  var sum = arg.expr || arg.tz || arg.pattern || arg.mode || arg.algo || arg.artifact || arg.prompt || arg.name || '';
  // v0.23: keep the indicator alive across the HTTP round-trip —
  // "building X…" / "running tool…" instead of a frozen chat.
  var progText = /^(docx_create|xlsx_create|zip_create|archive_create)$/.test(tool)
    ? (arg.name ? 'building ' + arg.name + '…' : 'building file…')
    : /^(zip_extract|archive_extract)$/.test(tool)
      ? (arg.artifact ? 'unpacking ' + arg.artifact + '…' : 'unpacking archive…')
      : tool === 'delegate'
        ? 'consulting other models…'
        : 'running ' + tool + '…';
  opts.onProgress && opts.onProgress({ text: progText });
  opts.onTool && opts.onTool({ name: tool, summary: String(sum).slice(0, 80) });
  var ls = '/api/tools/local?name=' + encodeURIComponent(tool) + '&args=' + encodeURIComponent(JSON.stringify(arg));
  if (opts.sessionId) ls += '&session=' + encodeURIComponent(opts.sessionId);
  var r3 = await fetch(ls);
  if (!r3.ok) {
    var errText = 'tool error HTTP ' + r3.status;
    opts.onTool && opts.onTool({ name: tool, result: errText });
    return 'OBSERVATION:\n(' + errText + ' — try again with valid arguments)';
  }
  var d3 = await r3.json();
  var out3 = (d3 && d3.result) || '';
  opts.onTool && opts.onTool({ name: tool, result: String(out3).slice(0, 120), artifact: d3 && d3.artifact });
  return 'OBSERVATION:\n' + out3;
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

  // v0.23 NO-SILENCE — the suppressed ACTION stream becomes live progress
  // ("building bundle.zip · 12.4 KB so far"). A 10-file zip_create ACTION
  // takes the model 60-80 SECONDS to stream; without this the PM chat sat
  // completely silent the whole time (the user's "froze for 10 seconds,
  // then everything arrived at once").
  var progTool = '', progName = '', progLast = 0;
  var NAME_RE = /"name"\s*:\s*"([^"\n]{1,80})"/;
  var ACTION_RE = /^[ \t]*ACTION:\s*([a-zA-Z0-9_-]+)/;
  function progVerb(bytes) {
    if (progTool === 'web_search') return 'searching the web…';
    if (progTool === 'web_fetch') return progName ? 'reading ' + progName + '…' : 'fetching page…';
    if (/^(docx_create|xlsx_create|zip_create|archive_create)$/.test(progTool)) {
      if (progName) return bytes > 0
        ? 'building ' + progName + ' · ' + humanSize(bytes) + ' so far'
        : 'building ' + progName + '…';
      return bytes > 0 ? 'building file · ' + humanSize(bytes) + ' so far' : 'building file…';
    }
    if (/^(zip_extract|archive_extract)$/.test(progTool)) {
      return progName ? 'unpacking ' + progName + '…' : 'unpacking archive…';
    }
    return bytes > 0 ? 'working · ' + humanSize(bytes) : 'working…';
  }
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function progEmit(bytes) {
    if (!opts.onProgress) return;
    opts.onProgress({ text: progVerb(bytes), bytes: bytes });
    progLast = Date.now();
  }
  function progStart() {
    var act = findActionLine(full);
    if (act) progTool = act.name.toLowerCase();
    progEmit(0);
  }
  function progObserve() {
    if (!opts.onProgress) return;
    if (!progName) {
      var m = NAME_RE.exec(full);
      if (m) { progName = m[1]; progEmit(full.length); return; }
    }
    if (Date.now() - progLast >= 1200) progEmit(full.length);
  }

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

  var out = { text: '', usage: null, emitted: false, aborted: false, err: null };
  var body = {
    model: opts.model,
    messages: messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  // v0.42 DYNAMIC EFFORT SHAPE (mirrors engine/internal/llm/effort.go —
  // the OpenRouter-reasoning-registry merge): PM's live surface has two
  // shapes per model family. 'off' (or empty) always sends NOTHING (the
  // provider default). Otherwise:
  //   · kimi family → chat_template_kwargs.thinking = true (the verified
  //     PM toggle — even when the catalog carries an enum ladder, PM's
  //     own API for kimi is the boolean).
  //   · enum-level models (glm-5.3 / glm-flash / gpt-oss …) → top-level
  //     reasoning_effort = the chosen level string.
  //   · gemma/glm-5.1 style → chat_template_kwargs.enable_thinking.
  // The 400-resilience net in the engine covers any mismatch (PM 400s
  // are retried without the param).
  if (opts.effort && opts.effort !== 'off' && opts.effort !== '') {
    var mLower = String(opts.model || '').toLowerCase();
    var enumEffort = !/^(on|off)$/.test(opts.effort);
    if (mLower.indexOf('kimi') >= 0) {
      body.chat_template_kwargs = { thinking: true };
    } else if (mLower.indexOf('gemma') >= 0 || mLower.indexOf('glm-5.1') >= 0) {
      body.chat_template_kwargs = { enable_thinking: true };
    } else if (enumEffort) {
      body.reasoning_effort = opts.effort;
    } else {
      body.chat_template_kwargs = { thinking: true };
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
    var thinkClose = function () {
      if (thinkOpen) { thinkOpen = false; opts.onThinkingEnd && opts.onThinkingEnd(); }
    };
    for await (var chunk of stream) {
      var ch = chunk || {};
      if (ch.choices && ch.choices.length) {
        var d = ch.choices[0].delta || {};
        if (d.reasoning_content) { thinkOpen = true; opts.onThinking && opts.onThinking(d.reasoning_content); }
        if (d.content) {
          thinkClose(); // content follows thinking → the thinking phase is over
          full += d.content;
          if (decided === 'action') {
            // suppressed — round is a tool call, but progress stays live
            progObserve();
          } else if (decided === 'final') {
            enqueue(d.content);
          } else if (findActionLine(full + '\n')) {
            decided = 'action';
            progStart();
          } else if (!stillMaybePreamble(full)) {
            decided = 'final';
            enqueue(full);
          }
        }
      }
      if (ch.usage) usage = ch.usage;
    }
    thinkClose(); // stream ended while still thinking
    // round complete — decide the tail if still undecided
    if (!decided) {
      if (findActionLine(full)) {
        decided = 'action';
        progStart();
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
    thinkClose(); // aborted/failed mid-thinking — freeze the timer anyway
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
