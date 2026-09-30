// v0816-pm-repo-loop-test.mjs — THE FULL REPO HAND ON THE PM LOOP.
//
// USER SPEC: "the bot should be able to have full access to a repo, grep,
// ls, read, explore, push, pr, code review, issues, discussions,
// workflows, everything" — and the live repro: a PM quick chat with a
// bound repo watched the model reason "I don't see repo tools in my tool
// list", guess "ACTION: repo_list", and die on "unknown tool".
//
// The v071 pattern: slice the PURE blocks out of the real vendored
// pmsdk.js, run them in Node with a scripted transport + a fetch stub
// playing the engine's /api/tools/local seam. NOTHING is re-implemented —
// the loop under test is byte-for-byte the shipping code.
//
// Run: node scripts/v0816-pm-repo-loop-test.mjs   (from the repo root)
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
const protoBlock = sliceFrom('var PM_TOOLS_PROTOCOL =', 'function fetchLibBootstrap');
const parserBlock = sliceFrom('var INTENT_PHRASES', 'async function runToolLoop');
const loopBlock = sliceFrom('async function runToolLoop', 'window.PMBridge = {');

const mod = new Function(
  'async function fetchLibBootstrap(sessionId){ return "BOOTSTRAP-BODY"; }\n' +
  usageBlock + '\n' + protoBlock + '\n' + parserBlock + '\n' + loopBlock + '\n' +
  'return { runToolLoop, normUsage, mergeUsage, canonicalToolNameJS: (typeof canonicalToolNameJS === "function" ? canonicalToolNameJS : null) };'
)();
const { runToolLoop, canonicalToolNameJS } = mod;

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

function makeCore(rounds) {
  let i = 0;
  return {
    calls: 0,
    streamChatCompletions: async function* (body) {
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

// ── the engine fetch stub: the /api/tools/local seam (tools.go's route) ──
let fetchLog = [];
let workspaceCalls = [];   // { name, args, session } per workspace POST
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.startsWith('/api/tools/local')) {
    const q = new URLSearchParams(u.slice(u.indexOf('?') + 1));
    const name = q.get('name');
    let args = {};
    try { args = JSON.parse(q.get('args') || '{}'); } catch (e) {}
    if (name === 'workspace') {
      workspaceCalls.push({ name, args, session: q.get('session') });
      const action = args.action || 'help';
      if (action === 'list') {
        return { ok: true, status: 200, json: async () => ({ tool: 'workspace', result: '1 connected workspace(s):\n- me/fullrepo [id=aaaa00000001] github access=full branch=main' }) };
      }
      if (action === 'readme') {
        return { ok: true, status: 200, json: async () => ({ tool: 'workspace', result: 'README of me/fullrepo:\n# hello' }) };
      }
      if (action === 'issue_create') {
        return { ok: true, status: 200, json: async () => ({ tool: 'workspace', result: 'ISSUE OPENED — #11 Bug\nurl: https://e.test/issue/11' }) };
      }
      return { ok: true, status: 200, json: async () => ({ tool: 'workspace', result: 'workspace tool — act on this chat\'s CONNECTED cloud repos…' }) };
    }
    // the unknown-tool message now TEACHES the repo hand
    return { ok: true, status: 200, json: async () => ({ tool: name, result: 'error: unknown tool "' + name + '". Valid local tools: calculator, time_now… Repo tools: workspace {"action":"help"|…,"ws":"owner/repo","session":"<chat id>"} — the connected-repo tool.' }) };
  }
  return { ok: true, status: 200, json: async () => ({ result: '(tool ok)' }) };
};

// ══ 1. THE USER'S EXACT REPRO, FIXED: "ACTION: repo_list" → workspace
{
  workspaceCalls = [];
  const rounds = [
    [
      think('The system said repo tools exist… I don\'t see repo_list in the listed actions, but the session says a repo is bound. Let me try listing it.'),
      delta('ACTION: repo_list {"path": "/"}'),
      usageChunk({ prompt_tokens: 60, completion_tokens: 30, total_tokens: 90 })
    ],
    [ delta('The repo is me/fullrepo (full access). FINAL ANSWER: connected.') ]
  ];
  const core = makeCore(rounds);
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'what can you do with my repo?' }],
    tools: true, lib: false, sessionId: 's-repro',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  ok('THE REPRO FIXED: the guessed "repo_list" call ROUTED to the workspace tool (no unknown-tool dead-end)',
    workspaceCalls.length === 1 && workspaceCalls[0].name === 'workspace',
    'workspace calls: ' + JSON.stringify(workspaceCalls));
  ok('the aliased call carried the chat session (the bound repos resolve)',
    workspaceCalls.length === 1 && workspaceCalls[0].session === 's-repro',
    'session: ' + (workspaceCalls[0] && workspaceCalls[0].session));
  ok('the loop FINISHED with the model\'s answer (the observation fed back)',
    /me\/fullrepo/.test(res.text || ''), 'text=' + JSON.stringify((res.text || '').slice(0, 90)));
}

// ══ 2. THE PROPER CALL: ACTION: workspace {"action":"list"} chains
{
  workspaceCalls = [];
  const rounds = [
    [ delta('ACTION: workspace {"action": "list"}'), usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) ],
    [ think('full access — read the README next.'), delta('ACTION: workspace {"action": "readme", "ws": "me/fullrepo"}'), usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) ],
    [ delta('The README says "# hello". FINAL: repo reviewed.') ]
  ];
  const core = makeCore(rounds);
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'chain repo tools' }],
    tools: true, lib: false, sessionId: 's-chain',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  ok('the 2-call repo chain executed BOTH workspace verbs (list + readme)',
    workspaceCalls.length === 2 &&
    workspaceCalls[0].args.action === 'list' &&
    workspaceCalls[1].args.action === 'readme' && workspaceCalls[1].args.ws === 'me/fullrepo',
    'calls: ' + JSON.stringify(workspaceCalls));
  ok('the chain\'s final answer landed (no interruption)', /repo reviewed/.test(res.text || ''));
}

// ══ 3. THE VOCABULARY: the PM system message TEACHES the workspace tool
{
  const rounds = [[ delta('plain answer.') ]];
  const core = makeCore(rounds);
  const seen = [];
  const capture = { streamChatCompletions: async function* (body) {
    seen.push(body);
    yield delta('ok');
  } };
  await runToolLoop(capture, {
    messages: [{ role: 'user', content: 'hi' }],
    tools: true, lib: false, sessionId: 's-proto',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  const sys = seen[0] && seen[0].messages && seen[0].messages[0] && seen[0].messages[0].content || '';
  ok('the system message lists ACTION: workspace (the vocabulary the repro lacked)',
    /ACTION: workspace \{"action": "help"\}/.test(sys) && /pr_diff/.test(sys) && /issue_create/.test(sys) && /workflow_dispatch/.test(sys),
    'sys head: ' + JSON.stringify(sys.slice(0, 120)));
  ok('the system message carries the repo discipline (never claim you lack repo access)',
    /never claim you lack repo access/.test(sys));
}

// ══ 4. THE WRITE VERB: an issue_create ACTION rides the seam intact
{
  workspaceCalls = [];
  const rounds = [
    [ delta('ACTION: workspace {"action": "issue_create", "ws": "me/fullrepo", "title": "Bug", "body": "it broke", "labels": ["bug"]}'), usageChunk({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }) ],
    [ delta('ISSUE OPENED — #11. FINAL: filed.') ]
  ];
  const core = makeCore(rounds);
  const res = await runToolLoop(core, {
    messages: [{ role: 'user', content: 'file a bug' }],
    tools: true, lib: false, sessionId: 's-issue',
    onTool: () => {}, onProgress: () => {}, onDelta: () => {}, onThinking: () => {}
  });
  ok('issue_create rode the seam with every arg intact (labels array included)',
    workspaceCalls.length === 1 && workspaceCalls[0].args.title === 'Bug' &&
    JSON.stringify(workspaceCalls[0].args.labels) === '["bug"]',
    'args: ' + JSON.stringify(workspaceCalls[0] && workspaceCalls[0].args));
  ok('the loop finished on the observation', /filed/.test(res.text || ''));
}

// ══ 5. THE ALIAS MAP direct: canonicalToolNameJS lands repo names on workspace
{
  const map = canonicalToolNameJS;
  const cases = { repo_list: 1, repo_read: 1, repository: 1, github: 1, git: 1, code_repo: 1, workspace: 0, repo_files: 1 };
  let all = true;
  for (const k of Object.keys(cases)) {
    if (map(k) !== 'workspace') { all = false; console.log('  alias miss: ' + k + ' → ' + map(k)); }
  }
  ok('canonicalToolNameJS: every repo-name guess lands on "workspace"', all);
  ok('canonicalToolNameJS: non-repo names keep their own mappings',
    map('google') === 'web_search' && map('excel') === 'xlsx_create');
}

// ══ 6. SOURCE CONTRACTS — the engine + brain seams (the other paths)
{
  const eng = readFileSync('engine/internal/server/tools.go', 'utf8');
  ok('tools.go routes name=workspace to the shared verb switch',
    /if name == "workspace"/.test(eng) && /runWorkspaceAction/.test(eng));
  ok('the PM unknown-tool message TEACHES the workspace tool',
    /Repo tools: workspace/.test(eng));
  const chatgo = readFileSync('engine/internal/llm/chat.go', 'utf8');
  ok('llm/chat.go: repo aliases land on workspace (canonicalToolName)',
    /case "repo", "repos", "repository".*"repo_list"/.test(chatgo.replace(/\n\s+/g, ' ')));
  ok('llm/chat.go: workspace joined the fuzzy universe',
    /"workspace"\)/.test(chatgo));
  const sctx = readFileSync('engine/internal/server/sessionctx.go', 'utf8');
  ok('sessionctx NAMES the repo tools on every path',
    /THE REPO TOOLS on this chat/.test(sctx) && /`workspace` tool/.test(sctx));
  const agent = readFileSync('brain/agent.py', 'utf8');
  ok('brain: the tool discipline APPENDS to the engine\'s system prompt',
    /_tool_discipline_block\(\s*skills_auto=skills_auto/.test(agent));
  ok('brain: the discipline names the full verb set',
    /pr_diff \+ pr_review/.test(agent) && /issue_create/.test(agent) && /workflow_dispatch/.test(agent));
  const dtws = readFileSync('brain/tools/dt_workspace.py', 'utf8');
  ok('dt_workspace: the new verbs ride the shared /do REST bridge',
    /def do\(self, wid/.test(dtws) && /issue_create/.test(dtws) && /discussion_post/.test(dtws));
  const mirror = readFileSync('engine/internal/hfzero/brain/agent.py', 'utf8');
  ok('the hfzero mirror matches (the embedded brain)',
    /_tool_discipline_block\(\s*skills_auto=skills_auto/.test(mirror));
}

console.log('══════════════════════════════════════════════');
console.log(' v0.81.6 PM REPO LOOP: ' + PASS + ' pass / ' + FAIL + ' fail');
if (FAIL > 0) process.exit(1);
