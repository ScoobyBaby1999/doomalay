#!/usr/bin/env node
// v1245-pill-title-rig.cjs — v1.24.5 THE PILL TITLE (PLAN-V125 §5).
//
// The user's spec: the ONE pill (collapsed + expanded + the overlay
// screen) grows a ONE-WORD TITLE showing the actual operation — ls,
// grep, file_write, bash, mkdir… — never a generic 'exec', derived
// programmatically from the payload.
//
// This rig pins:
//   · the TITLE/BODY derivation matrix (every verb: exec → the program
//     token; pkg → 'pkg' + 'install <name>'; write/append →
//     'file_write'; read → 'file_read'; ls/rm/mkdir/grep/find/cmds/help
//     → themselves; session_* → 'session'; other tools → the tool name
//     + the summary body; legacy results → name + text; garbage
//     honesty)
//   · label/tail keep their shapes (the activity line's law — re-pins
//     of the v1232 matrix, subset-compared)
//   · the head markup contract: the .tool-pill-name chip between the
//     ico and the text span; the text span renders the BODY (the static
//     tail render is dead — the body carries it; the LIVE stream line
//     stays)
//   · the overlay contract: .tv-name shows the TITLE (the raw tool name
//     moves to title/aria); tvSubFor prefers the body (no echo of the
//     name above it)
//   · the CSS contract (0.62× fs, 600, surface-2, hair border, radius,
//     flex-shrink 0, theme vars only)

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

// the stub browser surface (the v1232 pattern)
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
function eqLT(name, parts, want) {
  eq(name, { label: parts.label, tail: parts.tail }, want);
}

// ══ 1. THE TITLE/BODY MATRIX ════════════════════════════════════════
console.log('v1.24.5 THE PILL TITLE — the title/body matrix:');
const L = (payload) => P.toolPillLabelParts({ payload });

// exec: the title is the PROGRAM token (one word); the body = the
// command's remainder after it — the install join is a label-only
// nicety, the sub-verb rides the body
eq('python -V → title python, body -V',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'python -V' } } }),
  { label: 'python', tail: '-V', title: 'python', body: '-V' });
eq('pip install numpy → title pip (ONE word), body "install numpy"',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'pip install numpy' } } }),
  { label: 'pip install', tail: 'numpy', title: 'pip', body: 'install numpy' });
eq('bash -c → title bash, body the flags+script',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'bash -c "ls -la"' } } }),
  { label: 'bash', tail: '-c "ls -la"', title: 'bash', body: '-c "ls -la"' });
eq('mkdir e2e-project → title mkdir, body e2e-project',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'mkdir e2e-project' } } }),
  { label: 'mkdir', tail: 'e2e-project', title: 'mkdir', body: 'e2e-project' });
eq('grep -rn pattern . → title grep',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'grep -rn TODO .' } } }).title,
  'grep');
eq('ls alone → title ls, body empty',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'ls' } } }),
  { label: 'ls', tail: '', title: 'ls', body: '' });
eq('string args (the engine event shape) derive identically',
  L({ name: 'termux', args: '{"action":"exec","args":{"command":"python -m http.server 8000"}}' }),
  { label: 'python', tail: '-m http.server 8000', title: 'python', body: '-m http.server 8000' });

// ══ v1.26.1 THE STRING ARGS — the device's REAL shapes ═══════════════
// The live Faqous events (v1.26.0 device, glm-5.3-flash through the PM
// arm) carry the inner args as a JSON STRING — the MCP manifest's own
// declared type (mcpbus/def.go "args": string). The matrix above only
// ever pinned the OBJECT inner; the string form is the exact hole that
// blanked every exec pill's title on the real device.
console.log('v1.26.1 THE STRING ARGS — the device shapes (the blank-title hole):');
eq('PM/device shape: inner args as a JSON STRING → title cal, body "10 2026"',
  L({ name: 'termux', args: { action: 'exec', args: '{"command": "cal 10 2026"}' } }),
  { label: 'cal', tail: '10 2026', title: 'cal', body: '10 2026' });
eq('WS/device shape: outer string + inner string (double-encoded)',
  L({ name: 'termux', args: '{"action":"exec","args":"{\\"command\\": \\"sed s/hello/SALUT/i hello.sh\\"}"}' }),
  { label: 'sed', tail: 's/hello/SALUT/i hello.sh', title: 'sed', body: 's/hello/SALUT/i hello.sh' });
eq("the user's example batch — python3 / du / curl all derive",
  [L({ name: 'termux', args: { action: 'exec', args: '{"command": "python3 -c \\"print(1)\\""}' } }).title,
   L({ name: 'termux', args: { action: 'exec', args: '{"command": "du -sh ."}' } }).title,
   L({ name: 'termux', args: { action: 'exec', args: '{"command": "curl -s https://api.github.com/zen"}' } }).title].join(','),
  'python3,du,curl');
eq('a leading POSIX assignment is grammar, not the program (FOO=1 python3 → python3)',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'FOO=1 python3 -c "print(2**10)"' } } }),
  { label: 'python3', tail: '-c "print(2**10)"', title: 'python3', body: '-c "print(2**10)"' });
eq('several assignments skip together (A=1 B=2 ls → ls)',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'A=1 B=2 ls -la' } } }),
  { label: 'ls', tail: '-la', title: 'ls', body: '-la' });
eq('a flat command (no nested args — the runner-tolerated shape) derives too',
  L({ name: 'termux', args: { action: 'exec', command: 'du -sh . ; find . -type f | wc -l' } }),
  { label: 'du', tail: '-sh . ; find . -type f | wc -l', title: 'du', body: '-sh . ; find . -type f | wc -l' });
eq('a pure assignment command (no program) is honest: the first word',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'FOO=bar' } } }).title, 'FOO=bar');
eq('a garbage-huge token clamps at 28 (the chip never blows)',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'x'.repeat(60) + ' y' } } }).title.length, 28);
eq('the transcript pkg shape (packages ARRAY) → install cowsay',
  L({ name: 'termux', args: { action: 'pkg', args: { op: 'install', packages: ['cowsay'] } } }),
  { label: 'pkg install cowsay', tail: '', title: 'pkg', body: 'install cowsay' });
eq('pkg with several packages joins them',
  L({ name: 'termux', args: { action: 'pkg', args: { packages: ['cowsay', 'jq'] } } }).body,
  'install cowsay jq');
eq('the transcript ls shape (inner string) → the path body',
  L({ name: 'termux', args: { action: 'ls', args: '{"path": "/storage/emulated/0/Documents"}' } }).body,
  '/storage/emulated/0/Documents');

// pkg: title 'pkg', body 'install <name>' (the plan's exact shape)
eq('pkg verb → title pkg, body "install numpy"',
  L({ name: 'termux', args: { action: 'pkg', args: { name: 'numpy' } } }),
  { label: 'pkg install numpy', tail: '', title: 'pkg', body: 'install numpy' });

// the file verbs: write/append → file_write, read → file_read
eq('write → title file_write, body the path',
  L({ name: 'termux', args: { action: 'write', args: { path: '/home/x/notes.md', content: 'hi' } }, summary: '/home/x/notes.md' }),
  { label: '/home/x/notes.md', tail: '', title: 'file_write', body: '/home/x/notes.md' });
eq('append → title file_write too',
  L({ name: 'termux', args: { action: 'append', args: { path: '/home/x/log.md' } }, summary: '/home/x/log.md' }).title,
  'file_write');
eq('read → title file_read, body the path',
  L({ name: 'termux', args: { action: 'read', args: { path: '/home/x/a.txt' } }, summary: '/home/x/a.txt' }).title,
  'file_read');
eq('read without a summary → body from the inner path',
  L({ name: 'termux', args: { action: 'read', args: { path: '/home/x/a.txt' } } }).body,
  '/home/x/a.txt');

// the listing verbs speak themselves
eq('ls verb → title ls',
  L({ name: 'termux', args: { action: 'ls', args: { path: '/home/x' } }, summary: '/home/x' }).title, 'ls');
eq('rm verb → title rm',
  L({ name: 'termux', args: { action: 'rm', args: { path: '/home/x/a' } }, summary: '/home/x/a' }).title, 'rm');
eq('mkdir verb → title mkdir',
  L({ name: 'termux', args: { action: 'mkdir', args: { path: '/home/x/new' } }, summary: '/home/x/new' }).title, 'mkdir');
eq('grep verb → title grep',
  L({ name: 'termux', args: { action: 'grep', args: { pattern: 'TODO', path: '/x' } }, summary: '/x' }).title, 'grep');
eq('find verb → title find',
  L({ name: 'termux', args: { action: 'find', args: { pattern: '*.md' } }, summary: '*.md' }).title, 'find');
eq('cmds verb → title cmds',
  L({ name: 'termux', args: { action: 'cmds' } }).title, 'cmds');
eq('help verb → title help',
  L({ name: 'termux', args: { action: 'help' } }).title, 'help');

// session_* folds to 'session'
eq('session_start → title session',
  L({ name: 'termux', args: { action: 'session_start', args: { command: 'python -m http.server' } } }).title,
  'session');
eq('session_list → title session',
  L({ name: 'termux', args: { action: 'session_list' } }).title, 'session');
eq('session_log → title session',
  L({ name: 'termux', args: { action: 'session_log', args: { id: 's1' } } }).title, 'session');

// other tools: title = the tool's own name, body = the summary
eq('web_search → title web_search, body the query',
  L({ name: 'web_search', summary: 'best termux keyboards 2026' }),
  { label: 'best termux keyboards 2026', tail: '', title: 'web_search', body: 'best termux keyboards 2026' });
eq('hublib → title hublib',
  L({ name: 'hublib', summary: 'superpowers' }).title, 'hublib');
eq('workspace no summary → title workspace, body empty',
  L({ name: 'workspace' }),
  { label: 'workspace', tail: '', title: 'workspace', body: '' });

// legacy standalone result: title = the tool name, body = the text
eq('a standalone result → title the tool name, body the text',
  P.toolPillLabelParts({ result: true, text: 'EXEC DONE (0)', payload: { name: 'termux', text: 'EXEC DONE (0)' } }),
  { label: 'EXEC DONE (0)', tail: '', title: 'termux', body: 'EXEC DONE (0)' });
eq('a standalone result with args speaks the verb title',
  P.toolPillLabelParts({ result: true, text: 'ok', payload: { name: 'termux', text: 'ok', args: { action: 'write', args: { path: '/x' } } } }).title,
  'file_write');

// garbage honesty: never a crash, never a generic 'exec'
eq('empty exec → honest empty title',
  L({ name: 'termux', args: { action: 'exec', args: {} } }),
  { label: '', tail: '', title: '', body: '' });
ok('garbage args never crash the derivation',
  L({ name: 'termux', args: 'not json' }).title === 'termux' &&
  L({ name: 'termux', args: 42 }).title === 'termux' &&
  L(null).title === 'tool' &&
  L({ name: 'termux' }).title === 'termux');
ok('the title is NEVER the generic "exec"',
  ['exec'].indexOf(L({ name: 'termux', args: { action: 'exec', args: { command: 'ls' } } }).title) < 0);

// ══ 2. label/tail UNCHANGED (the activity line's law — v1232 subset) ═
console.log('label/tail keep their shapes (the v1232 law, subset-pinned):');
eqLT('exec label law unchanged',
  L({ name: 'termux', args: { action: 'exec', args: { command: 'pip install numpy' } } }),
  { label: 'pip install', tail: 'numpy' });
eqLT('pkg label law unchanged',
  L({ name: 'termux', args: { action: 'pkg', args: { name: 'numpy' } } }),
  { label: 'pkg install numpy', tail: '' });
eqLT('write label law unchanged (summary || name)',
  L({ name: 'termux', args: { action: 'write', args: { path: '/x' } }, summary: '/x' }),
  { label: '/x', tail: '' });
eqLT('web_search label law unchanged',
  L({ name: 'web_search', summary: 'q' }), { label: 'q', tail: '' });

// ══ 3. THE HEAD MARKUP CONTRACT ════════════════════════════════════
console.log('the head markup contract:');
ok('the .tool-pill-name chip renders between the ico and the text span',
  /'<span class="tool-pill-ico">'[\s\S]{0,900}'<span class="tool-pill-name">' \+ esc\(parts\.title\)/.test(cpSrc));
ok('the chip renders only when a title exists (empty exec → no chip)',
  /\(parts\.title \? '<span class="tool-pill-name">' \+ esc\(parts\.title\) \+ '<\/span>' : ''\)/.test(cpSrc));
ok('the text span renders the BODY (the dim remainder)',
  /'<span class="tool-pill-text">' \+ esc\(parts\.body\)/.test(cpSrc));
ok('the STATIC tail render is DEAD (the body carries it — no duplication)',
  !/\(parts\.tail \? ' <span class="tool-pill-tail">'/.test(cpSrc));
ok('the LIVE stream line stays (pending + streamText)',
  /tool-pill-tail tool-pill-tail-live/.test(cpSrc));
ok('the live dot stays', /tool-pill-live/.test(cpSrc));
ok('the label still feeds the activity line (running <label>…)',
  /'running ' \+ \(toolPillLabelParts\(sMsg\)\.label \|\| sName\)/.test(cpSrc));

// the CSS contract
ok('the CSS: .tool-pill-name exists (the chip)',
  /\.tool-pill-name\s*{/.test(css));
ok('the CSS: 0.62× the chat fs, 600 weight',
  /\.tool-pill-name\s*{[^}]*font-size: calc\(var\(--chat-fs\) \* 0\.62\);[^}]*font-weight: 600;/.test(css) ||
  (/\.tool-pill-name\s*{[\s\S]{0,240}font-size: calc\(var\(--chat-fs\) \* 0\.62\)/.test(css) &&
   /\.tool-pill-name\s*{[\s\S]{0,240}font-weight: 600/.test(css)));
ok('the CSS: surface-2 fill + hair border + radius (theme vars only)',
  /\.tool-pill-name\s*{[\s\S]{0,300}background: var\(--surface-2\);[\s\S]{0,120}border: 1px solid var\(--border\);/.test(css) &&
  /border-radius: calc\(5px \* var\(--chat-scale\)\);/.test(css));
ok('the CSS: flex-shrink 0 (a long query never crowds the verb away)',
  /\.tool-pill-name\s*{[\s\S]{0,300}flex-shrink: 0;/.test(css));
ok('the CSS: the body text dims to text-3 (the plan\'s dim law)',
  /\.tool-pill-text \{ color: var\(--text-3\); \}/.test(css));

// ══ 4. THE OVERLAY CONTRACT ════════════════════════════════════════
console.log('the overlay contract (tv-name speaks the verb):');
ok('openToolFullView derives the title (toolPillLabelParts)',
  /var tp = toolPillLabelParts\(msg\);[\s\S]{0,120}var tvTitle = tp\.title \|\| name;/.test(cpSrc));
ok('the tv-name renders the TITLE (not the raw tool name)',
  /'<span class="tv-name"'[\s\S]{0,220}>' \+ esc\(tvTitle\) \+ '<\/span>'/.test(cpSrc));
ok('the raw tool name moves to the tooltip + aria (title attribute)',
  /tvTitle !== name \? ' title="' \+ escAttr\(name\)/.test(cpSrc));
ok('the sub passes the TITLE as the name (a label equal to it never echoes)',
  /var sub = tvSubFor\(msg, tvTitle\);/.test(cpSrc));
// the tvSub body preference (the pure seam)
const S = (payload, name) => P.tvSubFor({ payload }, name || (payload && payload.name) || 'tool');
eq('tvSubFor prefers the BODY (title-stripped)',
  S({ name: 'termux', args: { action: 'exec', args: { command: 'python -m pip install numpy' } } }, 'python'),
  '-m pip install numpy');
eq('tvSubFor: pkg → "install <name>"',
  S({ name: 'termux', args: { action: 'pkg', args: { name: 'numpy' } } }, 'pkg'),
  'install numpy');
eq('tvSubFor: a web_search summary body',
  S({ name: 'web_search', summary: 'best keyboards 2026' }, 'web_search'),
  'best keyboards 2026');
eq('tvSubFor: no body → the label+tail fallback',
  S({ name: 'termux', args: 'not json' }, 'termux'), '');
eq('tvSubFor: the device exec shape (inner string) sub = the command remainder',
  S({ name: 'termux', args: { action: 'exec', args: '{"command": "cal 10 2026"}' } }, 'cal'),
  '10 2026');
{
  const long = 'x'.repeat(200);
  const got = S({ name: 'termux', args: { action: 'exec', args: { command: 'python ' + long } } }, 'python');
  eq('tvSubFor: the 90-char clamp holds', [got.length, got.slice(-1)], [91, '…']);
}

console.log('\n' + (fails.length === 0 ? ('ALL ' + n + ' PASS') : (fails.length + ' FAIL of ' + n + ':\n  ' + fails.join('\n  '))));
process.exit(fails.length === 0 ? 0 : 1);
