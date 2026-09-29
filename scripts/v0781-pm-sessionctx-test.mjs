// v0781-pm-sessionctx-test.mjs — THE PM TWIN OF THE SESSION DASHBOARD.
//
// User spec (v0.78.1): the model must know usage/pricing/context/connections
// on EVERY path. PM turns bypass the engine, so chatpanel.js composes the
// twin client-side (pmSessionContext + pmPrimeSessionContext). This test
// slices the SHIPPING functions out of chatpanel.js (the v071/v028 slice
// pattern — nothing re-implemented) and drives them with a fetch stub
// playing the engine's four endpoints, asserting the composed block matches
// the engine twin's shape and the live values.
//
// Run: node scripts/v0781-pm-sessionctx-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/chatpanel.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

const block = sliceFrom('function pmSessionContext(state)', 'function pmPrimeSessionContext(state)');
const prime = sliceFrom('function pmPrimeSessionContext(state)', 'function pmSystemMessage(state');
// both functions ride the same scope; evaluate together with a fetch stub.
const mod = new Function('fetch', block + '\n' + prime + '\n' +
  'return { pmSessionContext, pmPrimeSessionContext };');

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

// ── the canned engine (the four endpoints the twin reads) ──────────────────
const PAYLOADS = {
  '/api/sessions/s1/usage': {
    totals: { tokensIn: 2800, tokensOut: 940, turns: 2, cost: 0.0013, hasCost: true },
    rates: { in: 0.27, out: 1.10, free: false },
    context: { model: 'deepseek-v4.1-flash', limit: 131072, usedTokens: 1600, fillPct: 1, compacted: false }
  },
  '/api/hub/auth/status': { connected: true, username: 'ScoobyBaby1999' },
  '/api/workspaces/accounts': { accounts: [
    { kind: 'github', signed_in: true, login: 'ScoobyBaby1999' },
    { kind: 'gitea', signed_in: false, login: null }
  ] },
  '/api/sessions/s1/workspaces': { workspaces: [
    { kind: 'github', name: 'me/project', owner: 'me', repo: 'project', access: 'full' }
  ] },
  '/api/workspaces': { workspaces: [
    { kind: 'github', name: 'me/project', access: 'full' },
    { kind: 'hf', name: 'ScoobyBaby1999/doomalaysocreate', access: 'read' }
  ] }
};
const seen = [];
const fakeFetch = (url) => {
  const u = url.replace(/^https?:\/\/[^/]+/, '');
  seen.push(u);
  return Promise.resolve({ json: () => Promise.resolve(PAYLOADS[u] ?? null) });
};

const { pmSessionContext, pmPrimeSessionContext } = mod(fakeFetch);
const state = { sessionId: 's1', sandbox: 'quick' };

// 1. before priming: honest degradation (no usage yet, no connections)
const bare = pmSessionContext(state);
ok('bare compose carries the headline',
   bare.includes('## Your session (live'), bare.slice(0, 80));
ok('bare compose degrades honestly (not connected / none yet)',
   bare.includes('Hugging Face: not connected') && bare.includes('Repos bound to this chat: none yet'), bare);

// 2. prime against the canned engine, then compose
await pmPrimeSessionContext(state);
const out = pmSessionContext(state);
ok('the four endpoints were read',
   seen.includes('/api/sessions/s1/usage') && seen.includes('/api/hub/auth/status') &&
   seen.includes('/api/workspaces/accounts') && seen.includes('/api/sessions/s1/workspaces'));
ok('usage totals render (2 turns, 2,800 in / 940 out, ≈$0.00 at list rates)',
   out.includes('This chat so far: 2 turn(s), 2,800 tokens in / 940 tokens out') &&
   out.includes('≈$0.00 at list rates'), out);
ok('rates render ($0.27 in / $1.10 out per 1M)',
   out.includes('$0.27 in / $1.10 out per 1M tokens (list)'), out);
ok('context renders (~131,072 window, ~1,600 riding, 1% full)',
   out.includes('Context window: ~131,072 tokens; this turn rides ~1,600 (1% full, ~129,472 still free)'), out);
ok('connections render (HF as ScoobyBaby1999; GitHub as ScoobyBaby1999; Gitea not)',
   out.includes('Hugging Face: signed in as ScoobyBaby1999') &&
   out.includes('GitHub: signed in as ScoobyBaby1999') &&
   out.includes('Gitea: not signed in'), out);
ok('bound repos render with access levels (github me/project (full))',
   out.includes('Repos bound to this chat (1): github me/project (full)'), out);
ok('workspace total renders (2 of 2)',
   out.includes('You have 2 workspace(s) connected in total'), out);
ok('the capability line names every forge incl. HF repo types',
   out.includes('GitHub, Gitea, GitLab, Sourcehut and Hugging Face repos (models, datasets and Spaces)'), out);
ok('no HF-sandbox note on a quick chat',
   !out.includes('sandbox runs on your Hugging Face Space'), out);

// 3. the HF-sandbox variant carries the honest-degradation note
const outHF = pmSessionContext({ sessionId: 's1', sandbox: 'hf', _usage: state._usage, _pmConn: state._pmConn });
ok('HF-sandbox chats get the engine-bridge note',
   outHF.includes("sandbox runs on your Hugging Face Space"), outHF);

// 4. the 15s cache: a second prime fires no fetches
const seenBefore = seen.length;
await pmPrimeSessionContext(state);
ok('the 15s connection cache holds (no refetch)', seen.length === seenBefore);

// 5. free-tier rates shape
const st2 = { sessionId: 'x', _usage: { rates: { in: 0.6, out: 1.8, free: true } } };
ok('free-tier rates render as FREE ($0)',
   pmSessionContext(st2).includes('this tier is FREE ($0)'), pmSessionContext(st2));
// unpriced shape
const st3 = { sessionId: 'x', _usage: { rates: { unpriced: true } } };
ok('unpriced models render the honest no-price line',
   pmSessionContext(st3).includes('no price data for this model'), pmSessionContext(st3));

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
