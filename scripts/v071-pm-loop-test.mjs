// v071-pm-loop-test.mjs — THE REAL PM REACT LOOP, EXTRACTED AND DRIVEN.
//
// USER SPEC: "Verify that u can have the LLM have many turns (chain 20+
// tools with reasoning in between and still not get interrupted and be
// able to finish the output)" + the v0.71 fixes (usage normalization,
// round-summing, the always-on ACTION vocabulary, the bundle manifest).
//
// The v28 pattern: slice the PURE blocks out of the real vendored
// pmsdk.js (no window/import deps), run them in Node with a scripted
// transport (an async generator playing the model) + a fetch stub
// (playing the engine's /api/tools/* endpoints). NOTHING is re-implemented —
// the loop under test is byte-for-byte the shipping code.
//
// Run: node scripts/v071-pm-loop-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

// Block 1: the usage normalizer + round-merger (v0.71).
const usageBlock = sliceFrom('function normUsage(', '// streamChat(opts):');
// Block 2: the ACTION protocols (tools + web + the split lib protocol).
const protoBlock = sliceFrom('var PM_TOOLS_PROTOCOL =', 'function fetchLibBootstrap');
// Block 3: the parser + nudge detectors (v0.28's proven slice).
const parserBlock = sliceFrom('var INTENT_PHRASES', 'async function runToolLoop');
// Block 4: THE LOOP — runToolLoop + actionHasRequiredArgJS + execAction +
// roundTrip + roundTripOnce (everything between the loop and the export).
const loopBlock = sliceFrom('async function runToolLoop', 'window.PMBridge = {');

const mod = new Function(
  'async function fetchLibBootstrap(sessionId){ return "BOOTSTRAP-BODY (superpowers discipline)"; }\n' +
  usageBlock + '\n' + protoBlock + '\n' + parserBlock + '\n' + loopBlock + '\n' +
  'return { runToolLoop, normUsage, mergeUsage, PM_LIB_ACTIONS, PM_LIB_DISCIPLINE, PM_LIB_PROTOCOL };'
)();
const { runToolLoop, normUsage, mergeUsage, PM_LIB_ACTIONS, PM_LIB_DISCIPLINE } = mod;

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

// ── the scripted transport: an async generator per roundTripOnce ────────
// Each scripted round is an ARRAY of chunks; the generator replays them.
function makeCore(rounds) {
  let i = 0;
  return {
    calls: 0,
    streamChatCompletions: async function* () {
      const idx = Math.min(i++, rounds.length - 1);
      const chunks = typeof rounds[idx] === 'function' ? rounds[idx]() : rounds[idx];
      for (const ch of chunks) yield ch;
    }
  };
}
const delta = (content) => ({ choices: [{ delta: { content } }] });
const think = (reasoning_content) => ({ choices: [{ delta: { reasoning_content } }] });
const usageChunk = (u) => ({ usage: u });

// ── the engine fetch stub (execAction's /api/tools/* endpoints) ─────────
let fetchLog = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.startsWith('/api/tools/skills')) {
    if (u.includes('action=load')) {
      return { ok: true, status: 200, json: async () => ({ tool: 'skills', result: 'SKILL LOADED — test-skill. Follow this methodology now.' }) };
    }
    return { ok: true, status: 200, json: async () => ({ tool: 'skills', result: 'SKILLS LIBRARY:\n- test-skill — does the thing' }) };
  }
  if (u.startsWith('/api/tools/hublib')) {
    return { ok: true, status: 200, json: async () => ({ tool: 'hublib', result: 'HUB HITS:\n- test item' }) };
  }
  if (u.startsWith('/api/tools/websearch')) {
    return { ok: true, status: 200, json: async () => ({ results: [{ title: 'Result A', url: 'https://a.example/x', snippet: 'alpha' }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ result: '(tool ok)' }) };
};

// ══ 1. THE 25-ROUND CHAIN — 25 tools with reasoning between, no interruption
{
  const N = 25;
  const rounds = [];
  for (let r = 0; r < N; r++) {
    rounds.push([
      think('round ' + r + ' reasoning about the next step…'),
      delta('Let me check the time.\nACTION: time_now'),
      usageChunk({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
    ]);
  }
  rounds.push([ delta('All 25 checks done. FINAL ANSWER: everything verified.') ]);
  const core = makeCore(rounds);
  const tools = [];
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'run the chain' }],
    tools: true, lib: false, sessionId: 's-test',
    onTool: (ev) => tools.push({ name: ev.name, done: !!ev.result }),
    onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  // one onTool fires per execAction start (summary) + one with the result
  // — count the START events (no result yet) = actual executions.
  const execs = tools.filter(t => t.name === 'time_now' && !t.done).length;
  ok('the 25-tool chain ran every round (no interruption)', execs === N,
    'got ' + execs + ' tool executions');
  ok('the chain FINISHED with the final output', /FINAL ANSWER: everything verified/.test(res.text || ''),
    'text=' + JSON.stringify((res.text || '').slice(0, 80)));
  ok('usage SUMMED across all 25 rounds (2500 in / 1250 out)',
    res.usage && res.usage.input_tokens === 2500 && res.usage.output_tokens === 1250,
    'usage=' + JSON.stringify(res.usage));
  ok('usage NORMALIZED to the engine shape (input_tokens, not prompt_tokens)',
    res.usage && typeof res.usage.input_tokens === 'number' && !('prompt_tokens' in res.usage));
}

// ══ 2. THE ALWAYS-ON VOCABULARY — the lib pill OFF still teaches the actions
{
  const rounds = [[ delta('plain answer, no tools needed.') ]];
  const core = makeCore(rounds);
  const seen = [];
  // capture the system message the transport received — via the opts
  // side door: runToolLoop passes `messages` forward; roundTripOnce
  // forwards to streamChatCompletions. Sneak it out through the stream.
  const capture = { streamChatCompletions: async function* (body) {
    seen.push(body);
    yield delta('ok');
  } };
  await runToolLoop(capture, { messages: [{ role: 'user', content: 'hi' }], tools: false, lib: false, sessionId: '' });
  const sys = seen[0] && seen[0].messages && seen[0].messages[0] && seen[0].messages[0].content || '';
  ok('lib OFF → the system message STILL carries the skills/hublib ACTION vocabulary',
    sys.includes('ACTION: skills') && sys.includes('ACTION: hublib'), 'sys head=' + JSON.stringify(sys.slice(0, 100)));
  ok('lib OFF → the protocol names the 🛠 lib pill requirement (no retry storms)',
    sys.includes('lib pill'), '');
  ok('lib OFF → the superpowers DISCIPLINE line does NOT ride', !sys.includes('1% chance'), '');
}
{
  const rounds = [[ delta('answer.') ]];
  const core = makeCore(rounds);
  const seen = [];
  const capture = { streamChatCompletions: async function* (body) {
    seen.push(body);
    yield delta('ok');
  } };
  // lib ON: fetchLibBootstrap is stubbed at the harness boundary — the
  // system must carry its body + the discipline line.
  await runToolLoop(capture, { messages: [{ role: 'user', content: 'hi' }], tools: false, lib: true, sessionId: 's2' });
  const sys = seen[0] && seen[0].messages && seen[0].messages[0] && seen[0].messages[0].content || '';
  ok('lib ON → the bootstrap body rides (the harness bootstrap stub)', sys.includes('BOOTSTRAP-BODY'), '');
  ok('lib ON → the 1%-chance DISCIPLINE line rides', sys.includes('1% chance'), '');
}

// ══ 3. THE BUNDLE MANIFEST — the whole-bundle decision protocol
{
  const rounds = [[ delta('loaded the right member, done.') ]];
  const core = makeCore(rounds);
  const seen = [];
  const capture = { streamChatCompletions: async function* (body) {
    seen.push(body);
    yield delta('ok');
  } };
  await runToolLoop(capture, {
    messages: [{ role: 'user', content: 'do the thing' }], tools: true, lib: true, sessionId: 's3',
    bundle: {
      id: 'superpowers-mock', name: 'superpowers-mock', tag: 'superpowers',
      members: [
        { type: 'skill', name: 'brainstorming', desc: 'idea flow', repo: 'mocklib/superpowers-mock', id: 'skill-1' },
        { type: 'template', name: 'writing-plans', desc: 'plan writing', repo: 'mocklib/superpowers-mock', id: 'tpl-1' }
      ]
    }
  });
  const sys = seen[0] && seen[0].messages && seen[0].messages[0] && seen[0].messages[0].content || '';
  ok('the bundle block rides the system message', sys.includes('THE ATTACHED BUNDLE — superpowers-mock'), '');
  ok('the manifest lists every member with type + repo/id', sys.includes('skill — brainstorming') && sys.includes('[mocklib/superpowers-mock / skill-1]'), '');
  ok('the decision protocol teaches load-then-use', sys.includes('decide which member') || sys.includes('LOAD the pick'), '');
}

// ══ 4. normUsage/mergeUsage unit pins (the tracking fix's core)
{
  const n1 = normUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  ok('normUsage maps prompt/completion → input/output', n1 && n1.input_tokens === 10 && n1.output_tokens === 5);
  const n2 = normUsage({ input_tokens: 7, output_tokens: 3 });
  ok('normUsage passes the engine shape through', n2 && n2.input_tokens === 7 && n2.output_tokens === 3);
  ok('normUsage drops empty usage objects', normUsage({}) === null && normUsage(null) === null);
  const m = mergeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
  ok('mergeUsage sums across rounds (engine llm.mergeUsage parity)', m.input_tokens === 17 && m.output_tokens === 8 && m.total_tokens === 25);
}

// ══ 5. THE EXHAUSTION PATH — a chain that never finishes still gets a final answer
{
  const N = 45; // more than MAX_ROUNDS (40) — the loop must exhaust gracefully
  const rounds = [];
  for (let r = 0; r < N + 2; r++) {
    rounds.push([ delta('ACTION: time_now'), usageChunk({ prompt_tokens: 1, completion_tokens: 1 }) ]);
  }
  const core = makeCore(rounds);
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'loop forever' }],
    tools: true, lib: false, sessionId: 's4',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  ok('a >40-round chain exhausts WITHOUT an exception and still returns text',
    typeof res.text === 'string', 'res=' + JSON.stringify(String(res && res.text).slice(0, 60)));
  ok('the exhausted turn still reports summed usage', res.usage && res.usage.input_tokens >= 40);
}

console.log('\n' + (PASS) + ' passed, ' + (FAIL) + ' failed');
process.exit(FAIL ? 1 : 0);
