#!/usr/bin/env node
// v1340-ownership-rig.cjs — PLAN-V134 THE OWNERSHIP WAVE.
//
// §1 v1.33.1 THE RETURNING MODEL: the stash-restore tail wires the panel
//     header's model button (app.js hides it per-open; the restore mirror
//     skipped updateHeaderBtn — the pill vanished after close/reopen).
// §2 v1.33.2 THE HONEST TAILS: the collapsed pill speaks the verb + the
//     dynamic X (read notes.txt · skills load superpowers · template X ·
//     persona X · hublib download X · workspace read X) — the tail after
//     the last slash, purely derived.
// §3 v1.33.3 THE SETTLED SETUP: source pins (the ready card never says
//     "locked"; Done kills before pop; the caps onExit re-renders fresh +
//     auto-stacks ON).
// §4 v1.33.4 THE UNASKED RETURN: source pins (the sheet's rootOrigin
//     exemption; the done page's success-only auto-return; MainActivity
//     consumes doomalay://).
// §5 v1.33.5 THE ISOLATED MINDS: behavior — a backgrounded PM turn's
//     events NEVER paint into the foreground chat (the ownerState law),
//     refreshToolRow is owner-gated, and pmsdk's bootstrap cache is
//     session-keyed.

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');
const KOTLIN = path.join(__dirname, '..', 'platforms', 'android', 'app', 'src', 'main', 'java', 'com', 'doomalay', 'engine');
const GO = path.join(__dirname, '..', 'engine', 'internal', 'server');

// ── the stub browser surface (the v1232 rig's pattern) ──────────────
const sandboxLS = {};
global.localStorage = {
  getItem: (k) => Object.prototype.hasOwnProperty.call(sandboxLS, k) ? sandboxLS[k] : null,
  setItem: (k, v) => { sandboxLS[k] = String(v); },
  removeItem: (k) => { delete sandboxLS[k]; }
};
global.window = { ChatTypes: { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } }, addEventListener: function () {} };
global.document = { addEventListener: function () {}, createElement: () => ({ style: {} }) };
global.location = { protocol: 'http:', host: 'test' };
function FakeWS() {}
FakeWS.prototype.send = function () {};
global.WebSocket = FakeWS;

const P = require(path.join(WEB, 'chatpanel.js'));
const cpSrc = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');
const pmsdkSrc = fs.readFileSync(path.join(WEB, 'vendor', 'pm', 'pmsdk.js'), 'utf8');

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

// ══ §1 v1.33.1 THE RETURNING MODEL ══════════════════════════════════
// The restore tail (restoreStashedChat's "renderHost tail wiring (minus
// the rebuild)") must include updateHeaderBtn — the v0.14 per-open hide
// made the pill vanish on every stash-restored reopen.
(function () {
  // the restore tail block, from its own comment anchor to the WS re-point
  const tailAnchor = cpSrc.indexOf('the renderHost tail wiring (minus the rebuild)');
  const wsAnchor = cpSrc.indexOf('the WS: re-point the callbacks', tailAnchor);
  const tail = cpSrc.slice(tailAnchor, wsAnchor);
  ok('§1: the restore tail wires updateHeaderBtn (the mirror completes)', /updateHeaderBtn\(\s*state,\s*icon,\s*bodyEl,\s*panel\s*\)/.test(tail), tail.slice(0, 200));
  ok('§1: the fix cites the user report + the per-open hide law', /v1\.33\.1 THE RETURNING MODEL/.test(tail) && /per-open reset/.test(tail));
  // renderHost's own line stays (the non-stash path never regresses)
  const rhTail = cpSrc.slice(cpSrc.indexOf('wireHeader(bodyEl, icon, state, type, ctx);'), cpSrc.indexOf('wireHeader(bodyEl, icon, state, type, ctx);') + 400);
  ok('§1: renderHost keeps its own updateHeaderBtn call', /updateHeaderBtn\(\s*state,\s*icon,\s*bodyEl,\s*panel\s*\)/.test(rhTail));
  // the hide law stays honest in app.js (the reset the fix answers)
  const appSrc = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  ok('§1: app.js still hides the button per-open (the law the mirror must answer)', /panel-model-btn/.test(appSrc));
})();

// ══ §2 v1.33.2 THE HONEST TAILS ═════════════════════════════════════
// The collapsed pill speaks the verb + the dynamic X (the user's law:
// "read X", "skills load X" — the tail after the last slash, derived).
(function () {
  const L = (p) => P.toolPillLabelParts({ payload: p });
  // the tail law units
  eq('§2: pathTail — the last segment after /', P.pathTail('/storage/emulated/0/Doomalay/proj/notes.txt'), 'notes.txt');
  eq('§2: pathTail — backslashes count ("up to the last \\")', P.pathTail('C:\\x\\y\\main.go'), 'main.go');
  eq('§2: pathTail — trailing slashes resolve to the last non-empty', P.pathTail('/a/b/'), 'b');
  eq('§2: pathTail — a bare name is its own tail', P.pathTail('notes.txt'), 'notes.txt');
  eq('§2: pathTail — empty is empty (the caller keeps its fallback)', P.pathTail(''), '');
  eq('§2: pathTail — the 40 clamp', P.pathTail('/' + 'x'.repeat(60)).length, 40);
  // the file verbs: read/write/append/ls/rm/mkdir speak the verb + the path TAIL
  eq('§2: read → "read notes.txt"',
    L({ name: 'termux', args: { action: 'read', args: { path: '/home/x/proj/notes.txt' } }, summary: '/home/x/proj/notes.txt' }),
    { label: '/home/x/proj/notes.txt', tail: '', title: 'read', body: 'notes.txt' });
  eq('§2: write → "write main.go"',
    L({ name: 'termux', args: { action: 'write', args: { path: '/src/main.go', content: 'hi' } }, summary: '/src/main.go' }).title, 'write');
  eq('§2: write body = the tail', L({ name: 'termux', args: { action: 'write', args: { path: '/src/main.go' } } }).body, 'main.go');
  eq('§2: append → "append log.md"', L({ name: 'termux', args: { action: 'append', args: { path: '/var/log.md' } } }).title, 'append');
  eq('§2: ls → "ls src"', L({ name: 'termux', args: { action: 'ls', args: { path: '/home/x/src' } } }).body, 'src');
  eq('§2: grep keeps the PATTERN as the X (what you grep for)',
    L({ name: 'termux', args: { action: 'grep', args: { pattern: 'TODO', path: '/x' } }, summary: '/x' }).body, 'TODO');
  // the PM double-encoded string args form (the device's real shape)
  eq('§2: read (string args, the device shape) → read + tail',
    L({ name: 'termux', args: '{"action":"read","args":"{\\"path\\":\\"/a/b/c.txt\\"}"}' }),
    { label: 'termux', tail: '', title: 'read', body: 'c.txt' });
  // the library families
  eq('§2: skills load → "skills load superpowers"',
    L({ name: 'skills', args: '{"action":"load","skill":"superpowers"}' }),
    { label: 'skills', tail: '', title: 'skills load', body: 'superpowers' });
  eq('§2: skills load (object args) rides too',
    L({ name: 'skills', args: { action: 'load', skill: 'superpowers' } }).title, 'skills load');
  eq('§2: skills read → "skills read SKILL.md"',
    L({ name: 'skills', args: { action: 'read', skill: 'superpowers', path: 'skills/superpowers/SKILL.md' } }).body, 'SKILL.md');
  eq('§2: skills search → "skills search brainstorming"',
    L({ name: 'skills', args: { action: 'search', q: 'brainstorming' } }).body, 'brainstorming');
  eq('§2: template_show → "template react-methods"',
    L({ name: 'template_show', args: { id: 'react-methods' } }),
    { label: 'template_show', tail: '', title: 'template', body: 'react-methods' });
  eq('§2: persona_set → "persona The Architect"',
    L({ name: 'persona_set', args: { name: 'The Architect', text: '...' } }).title, 'persona');
  eq('§2: persona_set body = the name', L({ name: 'persona_set', args: { name: 'The Architect' } }).body, 'The Architect');
  eq('§2: persona_set import → X = the from name',
    L({ name: 'persona_set', args: { from: 'hub-persona-x', activate: true } }).body, 'hub-persona-x');
  eq('§2: persona_activate → "persona <id>"',
    L({ name: 'persona_activate', args: { id: 'p2' } }).body, 'p2');
  eq('§2: hublib download → "hublib download 12345"',
    L({ name: 'hublib', args: { action: 'download', type: 'skill', repo: 'o/r', id: '12345' } }),
    { label: 'hublib', tail: '', title: 'hublib download', body: '12345' });
  eq('§2: hublib search → "hublib search q"',
    L({ name: 'hublib', args: { action: 'search', q: 'tdd' } }).body, 'tdd');
  eq('§2: workspace read → "read notes.txt" (the file being read)',
    L({ name: 'workspace', args: { action: 'read', ws: 'myrepo', path: 'docs/notes.txt' } }),
    { label: 'workspace', tail: '', title: 'read', body: 'notes.txt' });
  eq('§2: workspace put → "put main.go"',
    L({ name: 'workspace', args: { action: 'put', ws: 'myrepo', path: 'src/main.go', content: 'x' } }).title, 'put');
  // the fallbacks stay honest (never a blank pill; unknown families keep v1.24.5)
  eq('§2: skills load with no skill name → body keeps the summary',
    L({ name: 'skills', args: { action: 'load' }, summary: 'load' }).body, 'load');
  eq('§2: unknown family keeps the v1.24.5 law',
    L({ name: 'web_search', summary: 'best keyboards' }),
    { label: 'best keyboards', tail: '', title: 'web_search', body: 'best keyboards' });
  eq('§2: no args at all → the old law byte-identical',
    L({ name: 'workspace' }),
    { label: 'workspace', tail: '', title: 'workspace', body: '' });
  // exec/pkg UNCHANGED (v1.26.1's law rides untouched)
  eq('§2: exec keeps the program token',
    L({ name: 'termux', args: { action: 'exec', args: { command: 'python3 -V' } } }),
    { label: 'python3', tail: '-V', title: 'python3', body: '-V' });
  eq('§2: pkg keeps its law',
    L({ name: 'termux', args: { action: 'pkg', args: { packages: ['cowsay'] } } }),
    { label: 'pkg install cowsay', tail: '', title: 'pkg', body: 'install cowsay' });
})();

// ══ §3 v1.33.3 THE SETTLED SETUP (source pins; the live walk owns the rest) ══
(function () {
  const tsx = fs.readFileSync(path.join(WEB, 'termuxsetup.js'), 'utf8');
  const caps = fs.readFileSync(path.join(WEB, 'capabilities.js'), 'utf8');
  ok('§3: the ready card never speaks the error-reading "locked" line', !/device commands locked/.test(tsx.replace(/\/\/[^\n]*/g, '')));
  ok('§3: the optional-unlock law rides (the companion app is named as separate + optional)',
    /optional — device commands/.test(tsx) && /companion app — a separate/.test(tsx) && /fully ready without it/.test(tsx));
  // Done kills FIRST (synchronous onExit) then pops
  const doneIdx = tsx.indexOf('v1.17.5 redteam fix: Done pops back');
  const doneBlock = tsx.slice(doneIdx, doneIdx + 1800);
  ok('§3: Done kills the instance BEFORE the pop (onExit fires synchronously)',
    /kill\(inst\);[\s\S]{0,300}popPage\(\)/.test(doneBlock), doneBlock.slice(0, 240));
  // the root fix: wire() re-appends the row from the cached extras (every render of the caps page)
  ok('§3: wire() re-appends the termux row from cached extras (the stale-snapshot vanish dies at the root)',
    /if \(extras\.termux\) paintTermuxRow\(ctx, extras\);/.test(caps) && /VANISHING ROW/.test(caps));
  ok('§3: paintTermuxRow is the idempotent append (replaced in place, never duplicated)', /function paintTermuxRow\(ctx, extras\)/.test(caps));
  ok('§3: the auto-stack law rides (onReady: ready + session + off → ON through persist)',
    /onReady: function \(status\)/.test(caps) && /st\.termux = true;/.test(caps) && /AUTO-STACK/.test(caps));
  ok('§3: the onExit lands the last status in extras synchronously + probes in the background',
    /onExit: function \(lastStatus\)/.test(caps) && /termuxRowState\(lastStatus/.test(caps));
  ok('§3: the setup passes onReady through the ready transition (before the card renders)', /opts\.onReady/.test(tsx));
})();

// ══ §4 v1.33.4 THE UNASKED RETURN (source pins) ═════════════════════
(function () {
  const sheet = fs.readFileSync(path.join(KOTLIN, 'PanelBrowserSheet.kt'), 'utf8');
  const main = fs.readFileSync(path.join(KOTLIN, 'MainActivity.kt'), 'utf8');
  const done = fs.readFileSync(path.join(GO, 'oauthdone.go'), 'utf8');
  ok('§4: the sheet records rootOrigin (the open URL\'s own origin)', /rootOrigin/.test(sheet));
  ok('§4: the guard consults rootOrigin (the flow\'s origin never asks)', /rootOrigin[\s\S]{0,400}guardShouldAsk|guardShouldAsk[\s\S]{0,400}rootOrigin/.test(sheet));
  ok('§4: MainActivity consumes doomalay:// in handleUrl (the main webview never loads the scheme)', /doomalay:\/\//.test(main.slice(main.indexOf('private fun handleUrl'), main.indexOf('private fun handleUrl') + 900)));
  ok('§4: the done page auto-returns on success only + opener-null only', /doomalay:\/\/return/.test(done) && /opener/.test(done) && /errMsg === ""|!errMsg|ok\b/.test(done));
})();

// ══ §5 v1.33.5 THE ISOLATED MINDS ════════════════════════════════════
// A backgrounded PM turn's events NEVER paint into the foreground chat
// (the user's report: reasoning + tool calls leaking into fresh PM chats,
// the blank reasoning box). The ownerState law at every PM append site +
// the refreshToolRow owner gate + the session-keyed bootstrap cache.
(function () {
  // the 7 PM-path appendMessage sites all pass state as ownerState (the
  // WS twin's law) — anchored inside the PM turn's callback region
  // (runPMTurnInner through the persist tail).
  const pmStart = cpSrc.indexOf('runPMTurnInner');
  const pmEnd = cpSrc.indexOf('function stopTurnIfStreaming');
  const pmRegion = cpSrc.slice(pmStart, pmEnd);
  const ungated = pmRegion.match(/appendMessage\(\s*msgContainer,[^;]*?bodyEl,\s*icon\s*\)/g) || [];
  eq('§5: ZERO ungated appendMessage sites in the PM region (all 7 pass ownerState)', ungated.length, 0,
    JSON.stringify(ungated));
  const gated = (pmRegion.match(/appendMessage\(\s*msgContainer,[^;]*?bodyEl,\s*icon,\s*state\s*\)/g) || []).length;
  ok('§5: the PM region carries ≥7 ownerState-gated append sites', gated >= 7, 'found ' + gated);
  ok('§5: refreshToolRow is owner-gated (isOwner)', /function refreshToolRow\(bodyEl, state, mi\) \{\s*\n\s*if \(!state \|\| !isOwner\(state\)\) return; \/\/ v1\.33\.5/.test(cpSrc));
  ok('§5: the thinking-append site cites the blank-box leak it kills', /blank-reasoning-box leak dies/.test(cpSrc));

  // the pmsdk cache — behavioral: two sessions → two fetches; the same
  // session inside the TTL → one; a second session NEVER inherits the
  // first's bootstrap (the cross-chat bleed the report described).
  const vm = require('vm');
  const sIdx = pmsdkSrc.indexOf('var _pmBootstrapCache');
  const eIdx = pmsdkSrc.indexOf('// ── v1.13.5 THE LAST ACTION');
  ok('§5: pmsdk cache slice extractable', sIdx > 0 && eIdx > sIdx);
  const slice = pmsdkSrc.slice(sIdx, eIdx);
  const fetched = [];
  const sandbox = {
    fetch: function (u) {
      fetched.push(String(u));
      const sid = /session=([^&]+)/.exec(String(u));
      return Promise.resolve({ json: function () {
        return Promise.resolve({ result: { bootstrap: 'for-' + (sid ? sid[1] : 'none') } });
      } });
    },
    Promise: Promise,
    encodeURIComponent: encodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(slice + '\nthis.__flb = fetchLibBootstrap; this.__cache = _pmBootstrapCache;', sandbox);
  const flb = sandbox.__flb;
  return flb('sess-A').then(function (a) {
    eq('§5: session A bootstrap fetches with its session', fetched.length, 1);
    eq('§5: session A gets its own bootstrap', a.bootstrap, 'for-sess-A');
    return flb('sess-B').then(function (b) {
      eq('§5: session B does NOT inherit A\'s cache (a second fetch)', fetched.length, 2);
      eq('§5: session B gets its OWN bootstrap', b.bootstrap, 'for-sess-B');
      return flb('sess-A').then(function (a2) {
        eq('§5: session A inside the TTL → the cached answer (no third fetch)', fetched.length, 2);
        eq('§5: the TTL hit returns A\'s bootstrap', a2.bootstrap, 'for-sess-A');
        // a failed bootstrap never poisons the entry
        fetched.length = 0;
        sandbox.fetch = function () { fetched.push('err-fetch'); return Promise.resolve({ json: function () { return Promise.resolve({ error: 'gate off' }); } }); };
        return flb('sess-C').catch(function () {
          eq('§5: a failed bootstrap rejects honestly', true, true);
          eq('§5: the failed entry never caches (a retry refetches)', fetched.length, 1);
          return flb('sess-C').catch(function () { eq('§5: the retry refetches again (nothing cached)', fetched.length, 2); });
        });
      });
    });
  }).then(function () {
    console.log('v1340 ownership rig: ' + n + ' checks');
    if (fails.length) {
      console.log('FAILS:');
      fails.forEach(function (f) { console.log('  ✗ ' + f); });
      process.exit(1);
    }
  }).catch(function (e) {
    console.log('RIG CRASH: ' + (e && e.message));
    process.exit(1);
  });
})();
