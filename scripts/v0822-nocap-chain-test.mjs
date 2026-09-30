// v0822-nocap-chain-test.mjs — THE NO-CAP CHAIN (user spec, verbatim:
//   "REMOVE THE 24 MAX TURNS CAP, OR FIND A WAY AROUND IT?! DIDNT U
//    SAY IT CAN RUN 100 CHAINED TOOLS WITHOUT MAX TURNS?").
//
// THE 24 WAS THREE THINGS AT ONCE:
//   1. PROMPT TEXT — both tool protocols told the model "up to 24 chained
//      calls per turn" (engine chat.go + PM pmsdk.js) — the model
//      self-throttled at 24 and TOLD users about the cap.
//   2. THE ENFORCED MID-LOOP INJECTION — chat.go's ReAct loop injected
//      "Tool budget reached. Write your FINAL answer now." at round == 23
//      (the 24th round!) — THE cap the user hit live: 19 tool calls +
//      reasoning, then the forced-final pushed mid-chain and the turn
//      died inside reasoning.
//   3. THE LOOP BUDGETS — PM MAX_ROUNDS 40, engine 64, nativetools 64.
//
// THE FIX: the prompt now names NO number ("There is NO fixed cap on
// chained calls — keep going as long as the task needs (a hundred is
// fine)"), the round==23 injection is deleted (a single exhaustion path
// remains at the END of each loop), and every loop budget is 200.
//
// This rig pins the source contracts (the same pattern v0817 uses for
// the Go twins) + drives the REAL PM runToolLoop past the old 24/40
// walls with a scripted fake core proving a 100-call chain completes.
//
// Run: node scripts/v0822-nocap-chain-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const pmSrc = readFileSync('engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');
const chatSrc = readFileSync('engine/internal/llm/chat.go', 'utf8');
const ntSrc = readFileSync('engine/internal/llm/nativetools.go', 'utf8');

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

// ── 1. the prompt no longer names a cap (both twins) ───────────────────────
ok('PM protocol: the "24 chained calls" phrasing is gone',
   !pmSrc.includes('24 chained calls'), pmSrc.slice(pmSrc.indexOf('RULES'), pmSrc.indexOf('RULES') + 600));
ok('PM protocol: the no-cap rule rides the protocol',
   pmSrc.includes('NO fixed cap on chained calls'));
ok('engine protocol: the "24 chained calls" phrasing is gone',
   !chatSrc.includes('24 chained calls'));
ok('engine protocol: the no-cap rule rides the protocol',
   chatSrc.includes('NO fixed cap on chained calls'));

// ── 2. the enforced cap is dead ────────────────────────────────────────────
ok('the round==23 forced-final injection is REMOVED from the ReAct loop',
   !/if round == 23 \{/.test(chatSrc));

// ── 3. the loop budgets are 200 (every path) ──────────────────────────────
ok('PM MAX_ROUNDS = 200 (was 40)',
   /var MAX_ROUNDS = 200;/.test(pmSrc));
ok('engine ReAct loop: 200 rounds (was 64)',
   /for round := 0; round < 200; round\+\+/.test(chatSrc));
ok('nativetools maxRounds = 200 (was 64)',
   /const maxRounds = 200/.test(ntSrc));

// ── 4. THE LIVE PROOF — the real PM loop completes a 100-call chain ───────
// (the v0817 slice pattern: runToolLoop driven by a scripted core that
// answers 100 tool calls with observations, then the final answer.)
function sliceFrom(src, marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}
const usageBlock = sliceFrom(pmSrc, 'function normUsage(', '// streamChat(opts):');
const protoBlock = sliceFrom(pmSrc, 'var PM_TOOLS_PROTOCOL =', 'function fetchLibBootstrap');
const parserBlock = sliceFrom(pmSrc, 'var INTENT_PHRASES', 'async function runToolLoop');
const loopBlock = sliceFrom(pmSrc, 'async function runToolLoop', 'window.PMBridge = {');
const mod = new Function(
  'async function fetchLibBootstrap(sessionId){ return "BOOTSTRAP-BODY"; }\n' +
  usageBlock + '\n' + protoBlock + '\n' + parserBlock + '\n' + loopBlock + '\n' +
  'return { runToolLoop };'
)();
const { runToolLoop } = mod;

let calls = 0;
const core = {
  streamChatCompletions: async function* (body) {
    calls++;
    if (calls <= 100) {
      yield { choices: [{ delta: { content: 'ACTION: time_now {}' } }] };
    } else {
      yield { choices: [{ delta: { content: 'All 100 steps done — THE FINAL ANSWER.' } }] };
    }
    yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
};
const deltas = [];
const obs = await runToolLoop(core, {
  model: 'kimi-k2.6', effort: 'off',
  messages: [{ role: 'user', content: 'run 100 steps' }],
  onDelta: (t) => deltas.push(t)
});
ok('a 100-call chain completes (the old 40-round PM wall would have died at ~40)',
   calls === 101, 'core calls: ' + calls);
ok('the final answer streams after the chain',
   obs.text.includes('THE FINAL ANSWER'), obs.text.slice(0, 120));
ok('usage accumulates across the whole chain (101 rounds × 15 tokens = 1515)',
   obs.usage && obs.usage.completion_tokens === 505 + (obs.usage.input_tokens ? 0 : 0) || (obs.usage.total_tokens === 1515), JSON.stringify(obs.usage));

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
