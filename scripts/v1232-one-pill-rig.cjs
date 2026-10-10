#!/usr/bin/env node
// v1232-one-pill-rig.cjs — v1.23.2 THE ONE PILL (PLAN-V123 §2).
//
// The pill-merge law, driven as the real module drives it:
//   · the label derivation matrix (the program placeholder + its query
//     tail — no static program lists, the ONE generic install sub-verb)
//   · the merge reducer (use → result folds onto ONE vessel; the pairing
//     law pairs the LAST pending same-name pill; result-only degrades to
//     the standalone legacy pill; both engine ids ride the vessel)
//   · the source contracts (the PM loop passes args; the nested command
//     wins the summary; the persistence carries args; the hide flow
//     honors ei2; the full view reads the merged result)
//   · the CSS contract (theme vars only, the loading bar, the live dot,
//     the reduced-motion honesty)

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

// ── the stub browser surface (the interrupt-fix rig's pattern) ──────
const sandboxLS = {};
global.localStorage = {
  getItem: (k) => Object.prototype.hasOwnProperty.call(sandboxLS, k) ? sandboxLS[k] : null,
  setItem: (k, v) => { sandboxLS[k] = String(v); },
  removeItem: (k) => { delete sandboxLS[k]; }
};
global.window = {
  ChatTypes: { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } },
  addEventListener: function () {}
};
global.document = { addEventListener: function () {}, createElement: () => ({ style: {} }) };
global.location = { protocol: 'http:', host: 'test' };
function FakeWS() {}
FakeWS.prototype.send = function () {};
global.WebSocket = FakeWS;

const P = require(path.join(WEB, 'chatpanel.js'));
const pmsdk = fs.readFileSync(path.join(WEB, 'vendor', 'pm', 'pmsdk.js'), 'utf8');
const cpSrc = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (!cond) fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
}
function eq(name, got, want) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(name + ' — got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
}

// ══ 1. THE LABEL DERIVATION MATRIX ═══════════════════════════════════
// The user's ask: "exec" was vague — the pill names WHAT the exec is.
const L = (payload) => P.toolPillLabelParts({ payload });

// exec: the program is the placeholder, the command's remainder the tail
eq('python -V → label python, tail -V',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'python -V' } } }),
  { label: 'python', tail: '-V' });
eq('pip install numpy → label "pip install" (the ONE generic join)',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'pip install numpy' } } }),
  { label: 'pip install', tail: 'numpy' });
eq('pkg install python → label "pkg install"',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'pkg install python' } } }),
  { label: 'pkg install', tail: 'python' });
eq('mkdir e2e → label mkdir', 
  L({ name: 'termux', args: { action: 'exec', args: { command: 'mkdir e2e-project' } } }),
  { label: 'mkdir', tail: 'e2e-project' });
eq('ls alone → label ls, no tail',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'ls' } } }),
  { label: 'ls', tail: '' });
eq('bash -c script → label bash',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'bash -c "for i in 1 2 3; do echo $i; done"' } } }),
  { label: 'bash', tail: '-c "for i in 1 2 3; do echo $i; done"' });
// the args ride as a JSON STRING on the engine events — same derivation
eq('string args (the engine event shape) parse identically',
  L({ name: 'termux', args: '{"action":"exec","args":{"command":"python -m http.server 8000"}}' }),
  { label: 'python', tail: '-m http.server 8000' });
// the pkg VERB: the action IS the install
eq('pkg verb → "pkg install numpy"',
  L({ name: 'termux', args: { action: 'pkg', args: { name: 'numpy' } } }),
  { label: 'pkg install numpy', tail: '' });
// non-termux tools: today's law (summary || name)
eq('web_search keeps its summary label',
  L({ name: 'web_search', summary: 'best termux keyboards 2026' }),
  { label: 'best termux keyboards 2026', tail: '' });
eq('no summary → the tool name',
  L({ name: 'workspace' }),
  { label: 'workspace', tail: '' });
// garbage honesty: empty command → empty label, never a crash
eq('empty exec → honest empty label',
  L({ name: 'termux', args: { action: 'exec', args: {} } }),
  { label: '', tail: '' });
ok('garbage args never crash the derivation',
  L({ name: 'termux', args: 'not json' }).label === 'termux' &&
  L({ name: 'termux', args: { action: 'exec' } }).label === '' &&
  L({ name: 'termux', args: 42 }).label === 'termux' &&
  L(null).label === 'tool');

// ══ 2. THE MERGE REDUCER ═════════════════════════════════════════════
// The user's ask: 2 pills per action → ONE pill (call + result merged).
const mkUse = (name, args, ei) => ({
  role: 'tool', tool: true, text: 'use', ts: 1, ei,
  payload: { name, args, summary: 'the-summary' }
});
const msgs = () => [
  { role: 'user', text: 'install numpy', ts: 0 },
  mkUse('termux', { action: 'exec', args: { command: 'pip install numpy' } }, 11),
  { role: 'assistant', text: 'working…', ts: 2 },
  mkUse('web_search', null, 13)
];

// the result folds into the pending use — ONE vessel, both ids
{
  const m = msgs();
  const got = P.mergeToolResult(m, { name: 'termux', text: 'OBSERVATION:\nEXEC DONE' }, 12);
  ok(got === m[1], 'the result merges into the pending termux use pill');
  eq('the merged vessel carries the result text', m[1].res, 'OBSERVATION:\nEXEC DONE');
  eq('the merged vessel carries BOTH engine ids (use ei + result ei2)', [m[1].ei, m[1].ei2], [11, 12]);
  ok(m.length === 4, 'the merge adds NO new message (one pill, not two)');
}

// the pairing law: the LAST pending same-name pill wins (sequential turns)
{
  const m = [
    mkUse('termux', { action: 'exec', args: { command: 'echo one' } }, 1),
    { ...mkUse('termux', { action: 'exec', args: { command: 'echo two' } }, 2) },
  ];
  // first result pairs with the LAST pending
  const first = P.mergeToolResult(m, { name: 'termux', text: 'result-two' }, 3);
  ok(first === m[1] && m[1].res === 'result-two', 'the pairing law folds onto the LAST pending pill');
  const second = P.mergeToolResult(m, { name: 'termux', text: 'result-one' }, 4);
  ok(second === m[0] && m[0].res === 'result-one', 'the second result pairs with the next pending above');
  ok(P.mergeToolResult(m, { name: 'termux', text: 'late' }, 5) === null, 'no pending left → null (the standalone fallback)');
}

// different tools never cross-merge
{
  const m = msgs();
  ok(P.mergeToolResult(m, { name: 'workspace', text: 'listed' }, 20) !== m[3],
    'a workspace result never folds into a web_search pill');
  ok(P.mergeToolResult(m, { name: 'web_search', text: 'hits' }, 21) === m[3],
    'the same-name web_search result folds correctly');
}

// a resolved vessel never re-merges (idempotent replay)
{
  const m = msgs();
  P.mergeToolResult(m, { name: 'termux', text: 'first' }, 12);
  const again = P.mergeToolResult(m, { name: 'termux', text: 'dup' }, 99);
  ok(again === null, 'a resolved vessel never re-merges (replay idempotence)');
}

// the result payload rides the vessel (sources etc.)
{
  const m = msgs();
  P.mergeToolResult(m, { name: 'web_search', text: '', sources: [{ title: 't', url: 'u' }] }, 14);
  eq('the result payload (sources) rides the vessel', m[3].resPayload.sources, [{ title: 't', url: 'u' }]);
}

// ══ 3. THE SOURCE CONTRACTS ══════════════════════════════════════════
// the PM loop passes the RAW args (the label derives at render)
ok(/opts\.onTool && opts\.onTool\(\{ name: name, summary: summary, args: argsObj \}\)/.test(pmsdk),
  'pmsdk: the use event carries the RAW args object');
// the nested command wins the summary (the "exec" vagueness dies)
ok(/for \(var nk of \['command', 'path', 'pattern', 'name', 'query'\]\)/.test(pmsdk) &&
  /argsObj\.args\[nk\]/.test(pmsdk) &&
  pmsdk.indexOf("for (var nk of ['command'") < pmsdk.indexOf("for (var sk of ['query'"),
  'pmsdk: the nested args scan runs BEFORE the flat key scan');
// the PM persist carries args (the replay derives the same label)
ok(/args: ev\.args/.test(cpSrc), 'chatpanel: the PM persist JSON carries args');
// the hide flow honors ei2 (the merged vessel drops when either half hides)
ok(/hm\.ei2 && hideSet\[hm\.ei2\]/.test(cpSrc), 'chatpanel: the hide flow checks ei2');
// the full view reads the merged result
ok(/msg\.res !== undefined \? msg\.res :/.test(cpSrc), 'chatpanel: openToolFullView reads the merged result');
// the WS merge call sites
ok(/mergeToolResult\(state\.messages, pay2, ev\.i\)/.test(cpSrc), 'chatpanel: the WS tool_result merges');
ok(/mergeToolResult\(state\.messages, \{ name: ev\.name, text: String\(ev\.result/.test(cpSrc), 'chatpanel: the PM result half merges');
// the vessel renders ONE pill (the messageHTML law)
ok(/var merged = msg\.res !== undefined;/.test(cpSrc), 'chatpanel: messageHTML derives the merged state');
ok(/tool-pill-live/.test(cpSrc) && /tool-pill-tail/.test(cpSrc), 'chatpanel: the head renders the tail + live dot');

// ══ 4. THE CSS CONTRACT ══════════════════════════════════════════════
ok(/\.tool-pill-tail\s*{[^}]*var\(--text-3\)/.test(css), 'css: the tail rides the theme text token');
ok(/\.tool-pill-live\s*{[^}]*rgb\(var\(--accent-2-rgb\)\)/.test(css), 'css: the live dot rides the accent token');
ok(/\.tool-pill-bar\s*{[^}]*var\(--surface-2\)/.test(css), 'css: the loading bar track rides surface-2');
ok(/\.tool-pill-bar::after\s*{[^}]*rgb\(var\(--accent-2-rgb\)\)/.test(css), 'css: the loading bar fill rides the accent');
ok(/@keyframes tool-pill-slide/.test(css), 'css: the slide animation exists');
ok(/prefers-reduced-motion: reduce/.test(css) && /\.tool-pill-bar::after { animation: none/.test(css),
  'css: reduced-motion users get a static bar (the honest alternative)');
ok(!/--#[0-9a-fA-F]{3,8}/.test(css.slice(css.indexOf('.tool-pill-tail'), css.indexOf('.tool-pill-stream') + 400)),
  'css: zero hardcoded hex in the new pill block');

// ══ report ═══════════════════════════════════════════════════════════
const byes = fails.length ? '\n  FAIL - ' + fails.join('\n  FAIL - ') : '';
console.log(`v1232 one-pill rig: ${n - fails.length}/${n}${byes}`);
process.exit(fails.length ? 1 : 0);
