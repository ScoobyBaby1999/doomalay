// v0817-final-answer-nets-test.mjs — THE FINAL-ANSWER NETS (user report:
//   "Privatemodeai and possibly Nvidia still has an issue where they
//    finish the reasoning but don't follow up with a reply, take this
//    example where the bot finished it's reasoning but then just stopped.
//    No reply after '✻ reasoning · 15s · 2.8k chars…'").
//
// The v071 pattern: slice the PURE blocks out of the real vendored
// pmsdk.js, drive the REAL runToolLoop with a scripted transport +
// fetch stub. The repro shapes:
//   1. THE SILENT TURN — a reasoning-only round (thinking deltas, usage
//      chunk, zero content) twice in a row: the v0.77.5 guard errored
//      ("the model returned an empty response"); the v0.81.7 net first
//      ARMS the retry with the final-answer nudge, then (when the model
//      reproduces the reasoning-only shape) synthesizes the reply from
//      the reasoning tail — the user sees an ANSWER, never silence.
//   2. THE NUDGE WORKS — the second round (after the nudge) yields
//      content: the reply is the model's own answer, no synth prefix.
//   3. THE USAGE SUMS across the guard's extra rounds (no lost tokens).
//   4. The brain + Go twins are pinned by source contracts (their own
//      test suites run them: llm/chat_v0817_test.go for the direct
//      path; agent.py's net is exercised by the compile-level checks).
//
// Run: node scripts/v0817-final-answer-nets-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

const usageBlock = sliceFrom('function normUsage(', '// streamChat(opts):');
const protoBlock = sliceFrom('var PM_LIB_ACTIONS = [', 'function fetchLibBootstrap');
const parserBlock = sliceFrom('var INTENT_PHRASES', 'async function runToolLoop');
const loopBlock = sliceFrom('async function runToolLoop', 'window.PMBridge = {');
function toolCallChunk(index, id, name, args) {
  return { choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] } }] };
}
function finish(reason) {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

const helpersBlock = sliceFrom('var _pmManifestCache =', 'function repairJSON');
const mod = new Function(
  'fetch',
  'async function fetchLibBootstrap(sessionId){ return "BOOTSTRAP-BODY"; }\n' + helpersBlock + '\n' + usageBlock + '\n' + protoBlock + '\n' + parserBlock + '\n' + loopBlock + '\n' +
  'return { runToolLoop };'
)(globalThis.fetch);
const { runToolLoop } = mod;

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

function makeCore(rounds) {
  let i = 0;
  return {
    calls: 0,
    streamChatCompletions: async function* () {
      this.calls++;
      const idx = Math.min(i++, rounds.length - 1);
      const chunks = typeof rounds[idx] === 'function' ? rounds[idx]() : rounds[idx];
      for (const ch of chunks) yield ch;
    }
  };
}
const delta = (content) => ({ choices: [{ delta: { content } }] });
const think = (reasoning_content) => ({ choices: [{ delta: { reasoning_content } }] });
const usageChunk = (u) => ({ usage: u });

globalThis.fetch = async (url, init) => {
  // the /mcp contract (v1.13.5): tools/list + tools/call
  if (String(url).includes('/mcp')) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (body.method === 'tools/list') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [
        { name: 'workspace', description: 'Act on connected repos.', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } } ] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'one repo with full access' }] } }) };
  }
  return { ok: true, status: 200, json: async () => ({ result: '(tool ok)' }) };
};

// ══ 1. THE SILENT TURN (the user's exact repro shape) ═════════════════════
// Round 1: 2.8k chars of reasoning, then nothing (usage chunk only). The
// guard's armed retry fires (round 2 scripted the same shape — the model
// reproduces the reasoning-only behavior). The turn-end net synthesizes.
{
  const reasoning = 'Let me check what I can do with the connected repo. '.repeat(40).slice(0, 2800) +
    'I will provide a clear answer about what happened.';
  const rounds = [
    [ think(reasoning), usageChunk({ prompt_tokens: 500, completion_tokens: 700, total_tokens: 1200 }) ],
    // the nudged round ALSO finishes inside reasoning (the stubborn shape)
    [ think('The user wants the answer. I should just say it now.'), usageChunk({ prompt_tokens: 300, completion_tokens: 400, total_tokens: 700 }) ],
  ];
  const core = makeCore(rounds);
  const deltas = [];
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'what can you do now?' }],
    tools: true, lib: false, sessionId: 's-silent',
    onTool: () => {}, onProgress: () => {},
    onDelta: (t) => deltas.push(t), onThinking: () => {}
  });
  ok('THE SILENT TURN IS DEAD: the turn ends with a REPLY (not silence, not a bare error)',
    (res.text || '').trim() !== '', 'text=' + JSON.stringify((res.text || '').slice(0, 80)));
  ok('the reply carries the honest prefix (reasoning-without-reply named)',
    /without sending a visible reply/.test(res.text || ''), 'text=' + JSON.stringify((res.text || '').slice(0, 90)));
  ok('the reply CONTAINS the reasoning tail (the answer the model never sent)',
    /clear answer about what happened|I should just say it now/.test(res.text || ''),
    'tail missing — text=' + JSON.stringify((res.text || '').slice(0, 160)));
  ok('the synthesized reply RENDERED through the live seam (onDelta)',
    deltas.some(d => /without sending a visible reply/.test(d)),
    'deltas=' + JSON.stringify(deltas.map(d => d.slice(0, 40))));
  ok('the armed retry fired (2 transport calls: the round + the nudged retry — the synth is client-side, no third call)',
    core.calls === 2, 'calls=' + core.calls);
  ok('usage SUMMED across the guard rounds (500+300 in / 700+400 out)',
    res.usage && res.usage.input_tokens === 800 && res.usage.output_tokens === 1100,
    'usage=' + JSON.stringify(res.usage));
}

// ══ 2. THE NUDGE WORKS — the second round answers ═════════════════════════
{
  const rounds = [
    [ think('I need to think about this first…'), usageChunk({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) ],
    // the NUDGED round yields the answer as plain content
    [ delta('FINAL ANSWER: I can grep, read, push, PR, review code, file issues, post discussions and dispatch workflows on your connected repo.') ],
  ];
  const core = makeCore(rounds);
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'what can you do now?' }],
    tools: true, lib: false, sessionId: 's-nudge',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  ok('the nudged round\'s own answer IS the reply (no synth prefix when the model answers)',
    /FINAL ANSWER: I can grep/.test(res.text || '') && !/without sending a visible reply/.test(res.text || ''),
    'text=' + JSON.stringify((res.text || '').slice(0, 90)));
}

// ══ 3. THE CHAIN CASE — reasoning-only AFTER tool calls still nets ════════
// (the repro's deeper shape: the model ran its tool, got the observation,
// reasoned about it, and stopped without replying.)
{
  // v1.13.5: the first round carries a structured tool_call (the native
  // wire — the ACTION-line mock died with the parser); the mock engine
  // answers through the fetch stub's /mcp route.
  const rounds = [
    [ toolCallChunk(0, 'call_chain_1', 'workspace', '{"action": "list"}'), finish('tool_calls'), usageChunk({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }) ],
    [ think('The observation shows one repo with full access. Now I can tell the user what I can do.'), usageChunk({ prompt_tokens: 80, completion_tokens: 90, total_tokens: 170 }) ],
    // the nudged retry: reasoning again (stubborn)
    [ think('Answering now.'), usageChunk({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }) ],
  ];
  const core = makeCore(rounds);
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'list my repos then tell me what you can do' }],
    tools: true, lib: false, sessionId: 's-chain',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  ok('the post-tool reasoning-only turn still ends with a reply (the net catches chains too)',
    (res.text || '').trim() !== '' && /without sending a visible reply/.test(res.text || ''),
    'text=' + JSON.stringify((res.text || '').slice(0, 120)));
  ok('the chain\'s reasoning tail rode home (repo context visible in the reply)',
    /full access|one repo/.test(res.text || ''), 'text=' + JSON.stringify((res.text || '').slice(0, 200)));
}

// ══ 4. THE TWINS — the brain + Go sides carry their nets ══════════════════
{
  const agent = readFileSync('brain/agent.py', 'utf8');
  ok('brain: the final-answer net guards _assistant_emitted (the reasoning-only turn)',
    /_assistant_emitted/.test(agent) && /without a visible answer/.test(agent) &&
    /without sending a visible reply/.test(agent));
  ok('brain: the nudge streams its reply as assistant_delta events (the engine persists them)',
    /yield \{"type": "assistant_delta", "text": _txt\}/.test(agent));
  const mirror = readFileSync('engine/internal/hfzero/brain/agent.py', 'utf8');
  ok('brain: the hfzero mirror matches', /_assistant_emitted/.test(mirror));
  const go = readFileSync('engine/internal/llm/chat.go', 'utf8') + readFileSync('engine/internal/llm/nativetools.go', 'utf8');
  ok('Go direct path: the reasoning accumulator + the flush net live in the native turn (v1.13.3: runReActRoundStream died with the ACTION parser)',
    /think = think \+ reasoning|think \+ reasoning/.test(go) || /answer-force/.test(go));
  const gotest = readFileSync('engine/internal/llm/chat_v0817_test.go', 'utf8');
  ok('Go direct path: the v0817 test locks the flush (reasoning-only → answer, normal unchanged)',
    /TestV817_ReasoningOnlyStreamFlushesAnswer/.test(gotest) && /TestV817_NormalStreamUnchanged/.test(gotest));
}

console.log('══════════════════════════════════════════════');
console.log(' v0.81.7 FINAL-ANSWER NETS: ' + PASS + ' pass / ' + FAIL + ' fail');
if (FAIL > 0) process.exit(1);
