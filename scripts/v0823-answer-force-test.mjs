// v0823-answer-force-test.mjs — THE ANSWER-FORCE NETS (user report:
//   "notice how the LLM just stopped responding… it said it will give
//    a summary, then didn't, it always does this when testing. I'm using
//    privatemodeai, but I think Nvidia does this too. I was using quick
//    chat but I think this issue happens in hf spaces too").
//
// THE v0.81.7 GAP (root cause, from the user's own chat log seq 46-47):
// the net CAUGHT the reasoning-only round and synthesized the honest
// prefix + last thought — but the model never actually REPLIED, because
// the nudge retry re-sent the SAME effort shape: kimi was still
// configured with chat_template_kwargs.thinking=true on the retry, so
// it thought again, burned its output, and stopped again.
//
// THE FIX (v0.82.3): every retry path now runs with thinking DISABLED —
// Moonshot's documented instant mode
// ({'chat_template_kwargs': {"thinking": false}}) — so the model MUST
// spend its output on visible content. This rig pins the PM twin (the
// path the user hit): the retry request BODY carries the disable; the
// finish_reason rides home; the still-empty case synthesizes.
//
// Run: node scripts/v0823-answer-force-test.mjs   (from the repo root)
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

// ── 1. THE USER'S EXACT SHAPE, FIXED — the reasoning-only round, then a ────
// retry that now carries the thinking DISABLE and yields content.
{
  const bodies = [];
  const rounds = [
    // round 1: reasoning-only (the user's seq 46 shape) + finish_reason
    [
      { choices: [{ delta: { reasoning_content: 'Let me test file_delete, then I will give a summary of what works and what does not.' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 5000, completion_tokens: 900 } }
    ],
    // round 2 (the nudged retry): instant mode — content only
    [
      { choices: [{ delta: { content: 'THE SUMMARY: everything works except grep line numbers.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5100, completion_tokens: 40 } }
    ]
  ];
  let i = 0;
  const core = {
    streamChatCompletions: async function* (body) {
      bodies.push(body);
      for (const ch of rounds[Math.min(i++, rounds.length - 1)]) yield ch;
    }
  };
  const deltas = [];
  const res = await runToolLoop(core, {
    model: 'kimi-k2.6', effort: 'med',
    messages: [{ role: 'user', content: 'test everything and summarize' }],
    onDelta: (t) => deltas.push(t)
  });
  ok('the reasoning-only round fired the retry (two requests)',
     bodies.length === 2, 'bodies: ' + bodies.length);
  ok('THE ANSWER-FORCE SHAPE: the retry body carries chat_template_kwargs.thinking === false (kimi instant mode)',
     bodies.length > 1 && bodies[1].chat_template_kwargs && bodies[1].chat_template_kwargs.thinking === false,
     JSON.stringify(bodies[1] && bodies[1].chat_template_kwargs));
  ok('the FIRST round kept its normal shape (thinking on — the turn still reasons)',
     bodies.length > 0 && bodies[0].chat_template_kwargs && bodies[0].chat_template_kwargs.thinking === true,
     JSON.stringify(bodies[0] && bodies[0].chat_template_kwargs));
  ok('the nudged round\'s content becomes the reply (a REAL answer, not the synth prefix)',
     res.text.includes('THE SUMMARY'), res.text.slice(0, 80));
  ok('no synth prefix leaked when the retry works',
     !res.text.includes('(the model finished its reasoning'), res.text.slice(0, 60));
}

// ── 2. BOTH ROUNDS REASONING-ONLY — the disable rides BOTH retries and ────
// the turn-end net synthesizes the reply from the reasoning tail.
{
  const bodies = [];
  const shape = [
    { choices: [{ delta: { reasoning_content: 'I plan to summarize all the tool test results now.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }
  ];
  const core = {
    streamChatCompletions: async function* (body) {
      bodies.push(body);
      for (const ch of shape) yield ch;
    }
  };
  const res = await runToolLoop(core, {
    model: 'kimi-k2.6', effort: 'med',
    messages: [{ role: 'user', content: 'summarize' }],
    onDelta: () => {}
  });
  ok('the retry carries the disable while the first round kept its thinking on',
     bodies.length >= 2 && bodies[0].chat_template_kwargs && bodies[0].chat_template_kwargs.thinking === true &&
     bodies.slice(1).every(b => b.chat_template_kwargs && b.chat_template_kwargs.thinking === false),
     JSON.stringify(bodies.map(b => b.chat_template_kwargs)));
  ok('the still-empty case synthesizes the reply from the reasoning tail',
     res.text.includes('(the model finished its reasoning') && res.text.includes('summarize all the tool test results'),
     res.text.slice(0, 120));
}

// ── 3. NON-KIMI FAMILY — enum models drop the effort param on the retry ───
{
  const bodies = [];
  const rounds = [
    [{ choices: [{ delta: { reasoning_content: 'thinking...' } }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    [{ choices: [{ delta: { content: 'final answer here' } }] }, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }]
  ];
  let i = 0;
  const core = {
    streamChatCompletions: async function* (body) {
      bodies.push(body);
      for (const ch of rounds[Math.min(i++, rounds.length - 1)]) yield ch;
    }
  };
  await runToolLoop(core, {
    model: 'glm-5.3-flash', effort: 'high',
    messages: [{ role: 'user', content: 'go' }],
    onDelta: () => {}
  });
  ok('enum model: first round carries reasoning_effort=high',
     bodies[0].reasoning_effort === 'high', JSON.stringify(bodies[0]));
  ok('enum model: the retry DROPS the effort param (no thinking config)',
     bodies.length > 1 && !('reasoning_effort' in bodies[1]) && !('chat_template_kwargs' in bodies[1]),
     JSON.stringify(bodies[1]));
}

// ── 4. finish_reason capture rides home on the round result ────────────────
ok('roundTripOnce captures finish_reason (source contract)',
   /if \(fr\) out\.finish = fr;/.test(src) && /finish_reason/.test(src));

// ── 5. the OTHER paths' twins (source contracts; their behavior is pinned ──
// by their own suites: chat_v0823_test.go + the brain compile checks)
const chatSrc = readFileSync('engine/internal/llm/chat.go', 'utf8');
const ntSrc = readFileSync('engine/internal/llm/nativetools.go', 'utf8');
const brainSrc = readFileSync('engine/internal/hfzero/brain/agent.py', 'utf8');

ok('engine direct: the nudge round sets Effort "off" (v1.13.3: the ACTION-era runReActRoundWithRetry died; the native loop carries the disable)',
   /roundReq\.Effort = "off"/.test(ntSrc) && /Reply NOW with your FINAL answer as plain text/.test(ntSrc));
ok('engine direct: the turn-end net synthesizes the reasoning-tail reply (chat_v0823_test.go locks it live)',
   /the model finished its reasoning without sending a visible reply/.test(ntSrc));

ok('nativetools (Nvidia): contentSeen + the nudge + the turn-end net exist',
   /contentSeen := false/.test(ntSrc) && /contentSeen = true/.test(ntSrc) &&
   /reasoning ended without a reply — asking again with thinking off/.test(ntSrc) &&
   /if !contentSeen \{/.test(ntSrc));
ok('nativetools: the nudge round runs with Effort "off"',
   /roundReq\.Effort = "off"/.test(ntSrc));

ok('brain: the nudge runs with the effort DISABLE body (kimi thinking:false)',
   /_build_effort_disable\(model\)/.test(brainSrc) &&
   /"chat_template_kwargs": \{"thinking": False\}/.test(brainSrc));

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
