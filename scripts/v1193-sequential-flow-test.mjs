// v1193-sequential-flow-test.mjs — v1.19.3 THE SEQUENTIAL FLOW (PLAN-V119 §3).
//
// Drives the REAL vendored pmsdk.js loop in Node with a scripted transport
// playing THREE rounds: prose+tool_calls → prose+tool_calls → final prose.
// Pins the segment-boundary contract the user's report demands ("the bot
// replaces or appends to its previous reply" — never again):
//
//   1. THE BOUNDARY: onReset fires ONCE per tool round, BEFORE the tool_use
//      pills — the exact order the engine's direct path emits (round_end
//      before tool_use, v0.93.3) and the receiver (chatpanel onReset,
//      v0.95.2) was built for but nothing ever fired until v1.19.3.
//   2. THE ORDER: round-1 deltas → onReset → tool_use → tool_result →
//      round-2 deltas → onReset → pills → final deltas. Narration stays in
//      its own block; no replacement, no gluing.
//   3. THE WHOLE TRUTH: the tool_result payload text rides WHOLE (the old
//      120-char slice is dead) — the viewer shows what the bot saw.
//
// Run: node scripts/v1193-sequential-flow-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

const usageBlock = sliceFrom('function normUsage(', 'async function streamChat');
const helpersBlock = sliceFrom('var _pmManifestCache =', 'function repairJSON');
const parserBlock = sliceFrom('function repairJSON', 'async function runToolLoop');
const loopBlock = sliceFrom('async function runToolLoop', 'window.PMBridge = {');
const protoBlock = sliceFrom('var PM_LIB_ACTIONS = [', 'function fetchLibBootstrap');

const mod = new Function(
  'fetch',
  protoBlock + '\n' + helpersBlock + '\n' + usageBlock + '\n' + parserBlock + '\n' + loopBlock + '\n' +
  'return { runToolLoop, pmToolManifest, mcpExecTool };'
)(fetchStub);
const { runToolLoop } = mod;

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

// ── the fetch stub: the engine's /mcp endpoint ────────────────────────
const BIG_RESULT = 'R'.repeat(500) + '-TAIL'; // 507 chars — the old slice ate it at 120
function fetchStub(url, init) {
  const body = JSON.parse(init.body);
  if (body.method === 'tools/list') {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: { tools: [
      { name: 'web_fetch', description: 'Fetch a web page.',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    ] } }) });
  }
  if (body.method === 'tools/call') {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: BIG_RESULT }], isError: false } }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, error: { message: 'no such method' } }) });
}

// ── the scripted transport: THREE rounds ─────────────────────────────
let roundIdx = 0;
const ROUNDS = [
  // round 0: narration THEN a tool call
  [
    { choices: [{ delta: { content: 'Let me fetch that page for you.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_fetch', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"url":"https://e.test/x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
  // round 1: narration again, another call
  [
    { choices: [{ delta: { content: 'Got the first page — reading the follow-up.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://e.test/y"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
  // round 2: the final answer
  [
    { choices: [{ delta: { content: 'All done — here is the full verdict.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ],
];
const core = {
  requestBodies: [],
  streamChatCompletions: async function* (body) {
    core.requestBodies.push(body);
    const chunks = ROUNDS[roundIdx] || ROUNDS[ROUNDS.length - 1];
    roundIdx++;
    for (const ch of chunks) yield ch;
  },
};

// ── the opts: the UI seams, recorded in order ─────────────────────────
const events = [];
const opts = {
  model: 'glm-latest',
  sessionId: 'pm-seq-1',
  messages: [{ role: 'system', content: 'You are the PM test persona.' }, { role: 'user', content: 'fetch two pages and report' }],
  onDelta: (t) => events.push(['delta', t]),
  onReset: () => events.push(['reset']),
  onTool: (e) => events.push([e.result !== undefined ? 'tool_result' : 'tool_use', e.name, e.result !== undefined ? String(e.result) : undefined]),
  onProgress: () => {},
  onStatus: () => {},
};

const res = await runToolLoop(core, opts);

const kinds = events.map((e) => e[0]).join(',');

// 1. THE BOUNDARY: exactly two resets (one per tool round), none after the
//    final narration.
ok('onReset fired exactly twice (once per tool round)',
   events.filter((e) => e[0] === 'reset').length === 2, kinds);
ok('no reset after the final round (the last block stays open for the turn-end close)',
   events.map((e) => e[0]).lastIndexOf('reset') < events.map((e) => e[0]).lastIndexOf('delta'), kinds);

// 2. THE ORDER: deltas → reset → tool_use → tool_result → deltas …
ok('round 1: narration deltas precede the first reset',
   events.map((e) => e[0]).indexOf('delta') < events.map((e) => e[0]).indexOf('reset'), kinds);
ok('pills follow the reset, deltas follow the pills (block-per-round)',
   /reset,tool_use,tool_result,delta/.test(kinds), kinds);
ok('the second round repeats the shape (reset 2 before its pills)',
   (kinds.match(/reset/g) || []).length === 2 &&
   kinds.indexOf('reset', kinds.indexOf('reset') + 1) < kinds.lastIndexOf('tool_use'), kinds);
ok('final answer delivered', /full verdict/.test(res.text || ''), JSON.stringify(res.text));

// 3. THE WHOLE TRUTH: the tool_result payload carries the FULL 507-char
//    result — the old .slice(0, 120) would cut the tail.
const resultEvents = events.filter((e) => e[0] === 'tool_result');
ok('two tool_result payloads recorded', resultEvents.length === 2, kinds);
const payloadText = JSON.stringify(events);
ok('tool_result payload rides WHOLE (507 chars, tail intact)',
   payloadText.includes('-TAIL') && payloadText.includes('R'.repeat(400)), 'payload sliced?');

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
