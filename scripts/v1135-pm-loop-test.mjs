// v1135-pm-loop-test.mjs — THE LAST ACTION: the PM browser loop, native.
//
// Drives the REAL vendored pmsdk.js loop blocks in Node with a scripted
// PM transport (an async generator playing the model's SSE chunks) and a
// fetch stub (playing the engine's /mcp endpoint). NOTHING is
// re-implemented — the loop under test is byte-for-byte the shipping
// code.
//
// Contracts:
//   1. THE MANIFEST: the loop fetches tools/list from /mcp (session
//      header) and rides it as OpenAI tools[] on the request.
//   2. THE NATIVE CALL: a round streaming structured tool_calls deltas
//      (split across chunks) assembles, executes via /mcp tools/call,
//      feeds a role:"tool" message back, and the next round answers.
//   3. NO ACTION GRAMMAR: the request messages carry NO ACTION protocol
//      text; the model-side wire is tools[] + tool_calls only.
//   4. SOURCES: web_search's structuredContent.sources flow to the
//      turn's sources (citation rendering).
//
// Run: node scripts/v1135-pm-loop-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

// Block 1: the usage normalizers.
const usageBlock = sliceFrom('function normUsage(', 'async function streamChat');
// Block 2: the MCP bridge helpers + manifest + exec.
const helpersBlock = sliceFrom('var _pmManifestCache =', 'function repairJSON');
// Block 3: repairJSON + the nudge detectors + dsmlClean.
const parserBlock = sliceFrom('function repairJSON', 'async function runToolLoop');
// Block 4: THE LOOP.
const loopBlock = sliceFrom('async function runToolLoop', 'window.PMBridge = {');

const protoBlock = sliceFrom('var PM_LIB_ACTIONS = [', 'function fetchLibBootstrap');
const mod = new Function(
  'fetch',
  protoBlock + '\n' + helpersBlock + '\n' + usageBlock + '\n' + parserBlock + '\n' + loopBlock + '\n' +
  'return { runToolLoop, pmToolManifest, mcpExecTool };'
)(fetchStub);
const { runToolLoop, pmToolManifest, mcpExecTool } = mod;

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

// ── the fetch stub: the engine's /mcp endpoint ────────────────────────
const mcpCalls = [];
const MANIFEST_TOOLS = [
  { name: 'calculator', description: 'Evaluate a math expression and return the result.',
    inputSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } },
  { name: 'web_search', description: 'Search the live web.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];
function fetchStub(url, init) {
  const body = JSON.parse(init.body);
  mcpCalls.push({ url, body, headers: init.headers });
  if (body.method === 'tools/list') {
    return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: MANIFEST_TOOLS } }));
  }
  if (body.method === 'tools/call') {
    if (body.params.name === 'calculator' && body.params.arguments.expr === '37*14') {
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: body.id,
        result: { content: [{ type: 'text', text: '518' }] } }));
    }
    if (body.params.name === 'web_search') {
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: body.id,
        result: { content: [{ type: 'text', text: '[1] Model Context Protocol\nhttps://modelcontextprotocol.io\nthe open standard' }],
                  isError: false, structuredContent: { sources: [{ title: 'Model Context Protocol', url: 'https://modelcontextprotocol.io', snippet: 'the open standard' }] } } }));
    }
    return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: body.id, error: { message: 'unknown tool' } }));
  }
  return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: body.id, error: { message: 'no such method' } }));
}
function jsonResponse(obj) {
  return { ok: true, status: 200, json: () => Promise.resolve(obj) };
}

// ── the scripted PM transport: rounds of SSE chunks ───────────────────
let roundIdx = 0;
const ROUND1 = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"expr":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' "37*14"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];
const ROUND2 = [
  { choices: [{ delta: { content: '37*14 = 518, from the calculator.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
];
const core = {
  requestBodies: [],
  streamChatCompletions: async function* (body) {
    core.requestBodies.push(body);
    const chunks = roundIdx === 0 ? ROUND1 : ROUND2;
    roundIdx++;
    for (const ch of chunks) yield ch;
  },
};

// ── the opts: the UI seams, recorded ──────────────────────────────────
const toolEvents = [];
const progressEvents = [];
const deltas = [];
const opts = {
  model: 'glm-latest',
  sessionId: 'pm-sess-1',
  messages: [{ role: 'system', content: 'You are the PM test persona.' }, { role: 'user', content: 'what is 37*14? use the calculator' }],
  onTool: (e) => toolEvents.push(e),
  onProgress: (e) => progressEvents.push(e),
  onDelta: (t) => deltas.push(t),
  onStatus: () => {},
};

const res = await runToolLoop(core, opts);

// 1. THE MANIFEST: tools/list fired with the session header, and tools[]
//    rode the model request.
ok('tools/list fetched from /mcp with session header',
   mcpCalls.some(c => c.body.method === 'tools/list' && c.headers['X-Doomalay-Session'] === 'pm-sess-1'));
ok('manifest rides the request as OpenAI tools[]',
   Array.isArray(core.requestBodies[0].tools) && core.requestBodies[0].tools.length === 2 &&
   core.requestBodies[0].tools[0].function.name === 'calculator' &&
   core.requestBodies[0].tool_choice === 'auto',
   JSON.stringify(core.requestBodies[0].tools || null));

// 2. THE NATIVE CALL: split tool_calls deltas assembled; executed via
//    /mcp; role:"tool" fed back; the final round answers.
ok('split tool_calls deltas assembled + executed via /mcp tools/call',
   mcpCalls.some(c => c.body.method === 'tools/call' && c.body.params.name === 'calculator' &&
   c.body.params.arguments.expr === '37*14' && c.headers['X-Doomalay-Session'] === 'pm-sess-1'));
const toolMsg = JSON.stringify(core.requestBodies[1].messages);
ok('role:tool message fed back with tool_call_id',
   toolMsg.includes('"role":"tool"') && toolMsg.includes('call_1') && toolMsg.includes('518'), toolMsg.slice(0, 300));
ok('final answer reflects the tool result', /518/.test(res.text || ''), JSON.stringify(res.text));

// 3. NO ACTION GRAMMAR: no ACTION protocol text anywhere in the requests.
const allMsgs = JSON.stringify(core.requestBodies.map(b => b.messages));
ok('no ACTION grammar in any request', !/ACTION:/.test(allMsgs), allMsgs.slice(0, 200));
ok('the assistant tool_calls wire message rides round 2',
   toolMsg.includes('"tool_calls"') && toolMsg.includes('"calculator"'));

// 4. the UI seams: tool pills + result events fired.
ok('tool_use event fired with summary', toolEvents.some(e => e.name === 'calculator' && e.summary === '37*14'), JSON.stringify(toolEvents));
ok('tool_result event fired', toolEvents.some(e => e.name === 'calculator' && /518/.test(String(e.result || ''))), JSON.stringify(toolEvents));
ok('deltas streamed the final answer', deltas.join('').includes('518'));

// ── the web_search sources contract ───────────────────────────────────
roundIdx = 0;
core.requestBodies.length = 0;
mcpCalls.length = 0;
const webRounds = {
  1: () => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'web_search', arguments: '{"query":"model context protocol"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
  2: () => [
    { choices: [{ delta: { content: 'MCP is the open standard — [1].' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ],
};
core.streamChatCompletions = async function* (body) {
  core.requestBodies.push(body);
  const chunks = webRounds[roundIdx + 1] ? webRounds[roundIdx + 1]() : webRounds[2]();
  roundIdx++;
  for (const ch of chunks) yield ch;
};
const res2 = await runToolLoop(core, { ...opts, messages: [{ role: 'user', content: 'search the web for MCP' }] });
ok('web_search sources flow from structuredContent', (res2.sources || []).length === 1 &&
   res2.sources[0].url === 'https://modelcontextprotocol.io', JSON.stringify(res2.sources));
ok('web_search citation event carried sources', toolEvents.some(e => e.name === 'web_search' && e.sources && e.sources.length === 1));

console.log(`\n═══ v1.13.5 THE LAST ACTION (PM loop): ${PASS} pass / ${FAIL} fail ═══`);
process.exit(FAIL ? 1 : 0);
