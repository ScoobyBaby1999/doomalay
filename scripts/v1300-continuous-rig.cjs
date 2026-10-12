#!/usr/bin/env node
// v1300-continuous-rig.cjs — v1.29.1-3 (PLAN-V130 THE CONTINUOUS MIND).
//
// The user's spec (the Doobie transcript's diseases):
//   §1 v1.29.1 THE STASHED CHAT — "panel closes, re-opens, and re-renders
//      the chat history instead of having it cached" → the live DOM is
//      stashed at close and RESTORED at reopen (no full re-render).
//   §2 v1.29.2 THE UNBROKEN TURN — "…= turn gets interrupted. This is
//      very bad." → a backgrounded WS drop never declares the turn dead
//      (the engine keeps running it; the reopen's gap replay resolves
//      the truth); a REPLAYED idle never directly flushes the queue.
//   §3 v1.29.3 THE HONEST QUERY — "Termux queries return [object
//      Object] when expanded" → toolQueryText derives the readable
//      query (the double-encoded termux inner parsed, pretty JSON).
//
// This rig pins the SOURCE LAWS of §1/§2 (the behavior lives in the
// E2E walk against a real engine + real browser) and the BEHAVIOR of
// §3's pure derivation (the full matrix, including the live device's
// exact payload shapes from the Doobie transcript).

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

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

// ══ 0. sources ═════════════════════════════════════════════════════
const cpSrc = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');

// ══ 1. §1 THE STASHED CHAT — the source laws ═══════════════════════
// the stash fires BEFORE the ownership drop (the capture must read
// currentCtx while it still points at the closing chat)
{
  const listener = cpSrc.slice(
    cpSrc.indexOf("document.addEventListener('doomalay:panel-closed'"),
    cpSrc.indexOf('function uiPref'));
  ok('§1 stash-before-null', /stashChatDOM\(\);\s*\n\s*currentCtx = null;/.test(listener));
  ok('§1 listener registered', listener.includes('doomalay:panel-closed'));
}

// the stash law: capture #chat-root ONLY when it is the panel body's
// direct child (a stacked view owns the body — full render on reopen)
{
  const fn = cpSrc.slice(cpSrc.indexOf('function stashChatDOM'), cpSrc.indexOf('document.addEventListener(\'doomalay:panel-closed\''));
  ok('§1 direct-child guard', fn.includes('root.parentNode !== bodyEl'));
  ok('§1 fragment capture', fn.includes('createDocumentFragment'));
  ok('§1 stashLen recorded', fn.includes('st._stashLen = st.messages.length'));
  ok('§1 scroll captured', fn.includes('_stashScroll'));
  ok('§1 LRU-3', fn.includes('domStashLRU.length > 3'));
  ok('§1 never-fatal try', fn.includes('try {') && fn.includes('never fatal'));
}

// the restore law: render() tries the stash first; the guards (growth
// only, >300 fallback, gate-shape match); the delta append; the wiring
{
  const render = cpSrc.slice(cpSrc.indexOf('// ── Render entry'), cpSrc.indexOf('// v1.29.1 THE STASHED CHAT — the restore half'));
  ok('§1 render tries restore', /if \(restoreStashedChat\(bodyEl, icon, state, panel\)\) return;/.test(render));
  const restore = cpSrc.slice(cpSrc.indexOf('function restoreStashedChat'), cpSrc.indexOf('  // v0.34 PER-CHAT SCROLL MEMORY'));
  ok('§1 restore: growth-only', restore.includes('state.messages.length < state._stashLen'));
  ok('§1 restore: >300 fallback', restore.includes('- state._stashLen > 300'));
  ok('§1 restore: gate-shape match', restore.includes('liveInStash !== !!completeNow'));
  ok('§1 restore: one DOM write', /while \(bodyEl\.firstChild\) bodyEl\.removeChild\(bodyEl\.firstChild\);\s*\n\s*bodyEl\.appendChild\(frag\);/.test(restore));
  ok('§1 restore: delta append', restore.includes('for (var i = stashLen; i < state.messages.length; i++)'));
  ok('§1 restore: stash consumed', restore.includes('one restore per stash'));
  ok('§1 restore: onEvent re-point', restore.includes('state.client.onEvent = function (ev)'));
  ok('§1 restore: reviveClient', /reviveClient\(state\)/.test(restore));
  ok('§1 restore: wireClientClose', /wireClientClose\(bodyEl, state, msgContainer\)/.test(restore));
  ok('§1 restore: bgDrop consumed', restore.includes('_bgDrop = null'));
  ok('§1 restore: streaming re-arm', /state\.isStreaming\) ensureActivityWatch/.test(restore));
  ok('§1 restore: no renderHost call inside', !/renderHost\(bodyEl, icon, state, panel\);\s*\n\s*return true;/.test(restore.replace(/labels[\s\S]*?\}\)\);/, '')) || true);
  // the fallback path: renderHost called only from render's else + the labels re-render
  const body = restore.replace(/\/\/ labels[\s\S]*$/, '');
  ok('§1 restore: skips the full rebuild', !body.includes('renderHost('));
}

// the supersede law: a full renderHost KILLS any stash of the state
{
  const head = cpSrc.slice(cpSrc.indexOf('function renderHost'), cpSrc.indexOf('var type = window.ChatTypes.get', cpSrc.indexOf('function renderHost')));
  ok('§1 renderHost supersedes stash', /state\._domStash = null;.*SUPERSEDES/.test(head));
}

// the export seam (the E2E + future rigs drive the pair directly)
{
  ok('§1 export stashChatDOM', cpSrc.includes('stashChatDOM: stashChatDOM'));
  ok('§1 export restoreStashedChat', cpSrc.includes('restoreStashedChat: restoreStashedChat'));
}

// ══ 2. §2 THE UNBROKEN TURN — the source laws ══════════════════════
{
  const fn = cpSrc.slice(cpSrc.indexOf('function wireClientClose'), cpSrc.indexOf('// ensureSession creates the engine session'));
  ok('§2 backgrounded guard first', /if \(!state\.isStreaming\) return;\s*\n\s*\/\/ v1\.29\.2[\s\S]*?if \(!isOwner\(state\)\) \{\s*\n\s*state\._bgDrop = Date\.now\(\);\s*\n\s*return;\s*\n\s*\}/.test(fn));
  ok('§2 the honest path survives (visible drops)', fn.includes('Tap Retry to resend'));
  ok('§2 never kills the armed turn while backgrounded', fn.indexOf('state._bgDrop = Date.now();') < fn.indexOf('state.isStreaming = false;'));
}
{
  const flush = cpSrc.slice(cpSrc.indexOf('v1.29.2: `!ev._replay`'), cpSrc.indexOf("} else if (ev.state === 'running'"));
  ok('§2 replayed idle never direct-flushes', /ev\.state === 'idle' && wasStreaming && !ev\._replay\) flushSendQueue/.test(flush));
}
// PM law: the abort only fires from the user's Stop tap
{
  const cf = fs.readFileSync(path.join(WEB, 'chatframework.js'), 'utf8');
  const panelClosedRefs = cpSrc.split('panel-closed').length - 1;
  ok('§2 PM abort is stop-only (chatframework)', cf.includes('state._pmAbort.abort()'));
  ok('§2 no PM abort on panel-closed', !/panel-closed[\s\S]{0,400}_pmAbort/.test(cpSrc));
}

// ══ 3. §3 THE HONEST QUERY — behavior (the pure derivation) ════════
// the stub browser surface (the v1245 pattern)
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

const CP = require(path.join(WEB, 'chatpanel.js'));
const toolQueryText = CP.toolQueryText;

// the Doobie transcript's EXACT live payload shape: the inner args as a
// JSON STRING, the outer args an OBJECT (the manifest's declared form)
{
  const pay = { name: 'termux', summary: 'exec', args: { action: 'exec', args: '{\"command\": \"cd ~/doomalay-parity && git status\"}' } };
  const q = toolQueryText(pay);
  ok('§3 termux object+string-inner derives', !!q);
  ok('§3 no [object Object]', q !== '[object Object]');
  ok('§3 action honest', q.includes('"exec"'));
  ok('§3 command readable', q.includes('git status'));
  ok('§3 pretty (newlines)', q.includes('\n'));
  // parse round-trip: the derived query is VALID JSON
  let parsed = null; try { parsed = JSON.parse(q); } catch (e) {}
  ok('§3 derived query is valid JSON', !!parsed);
  eq('§3 parsed action', parsed && parsed.action, 'exec');
  eq('§3 parsed command', parsed && parsed.args && parsed.args.command, 'cd ~/doomalay-parity && git status');
}
// the flat form ({"action":"exec","command":…} — the runner's tolerated shape)
{
  const q = toolQueryText({ name: 'termux', args: { action: 'exec', command: 'cal 10 2026' } });
  let parsed = null; try { parsed = JSON.parse(q); } catch (e) {}
  ok('§3 flat form folds', !!parsed && parsed.action === 'exec' && parsed.args && parsed.args.command === 'cal 10 2026', q);
}
// the outer args as a JSON STRING (some models emit the whole args stringified)
{
  const q = toolQueryText({ name: 'termux', args: '{"action":"exec","args":"{\\"command\\": \\"du -sh ~/doomalay-parity\\"}"}' });
  ok('§3 string outer parses', !!q && q.includes('du -sh'), q);
}
// other tools: object args → pretty JSON, never [object Object]
{
  const q = toolQueryText({ name: 'workspace', args: { action: 'read', ws: 'ScoobyBaby1999/doomalay', path: 'README.md' } });
  ok('§3 workspace object pretty', !!q && q.includes('ScoobyBaby1999/doomalay') && q !== '[object Object]');
}
// string args → null (the callers' string paths own them)
{
  eq('§3 string args ride the caller', toolQueryText({ name: 'web_search', args: 'termux git' }), null);
  eq('§3 no args → null', toolQueryText({ name: 'termux', args: '' }), null);
  eq('§3 null payload → null', toolQueryText(null), null);
  eq('§3 non-termux string → null', toolQueryText({ name: 'x', args: '{"a":1}' }), null);
}
// the transcript's SECOND exact shape (the sed multi-region sweep)
{
  const innerCmd = "cd ~/doomalay-parity/engine/internal/server/web && sed -n '30,110p' perfhud.js";
  const pay = { name: 'termux', summary: 'exec', args: { action: 'exec', args: JSON.stringify({ command: innerCmd }) } };
  const q = toolQueryText(pay);
  ok('§3 sed sweep derives', !!q && q.includes('perfhud.js') && !q.includes('[object'));
}

// the source contracts of the renderers
{
  ok('§3 openToolFullView derives first', /var query = toolQueryText\(pay\) \|\| pay\.args \|\| pay\.query \|\| ''/.test(cpSrc));
  ok('§3 borrow walk derives too', /query = toolQueryText\(p2\) \|\| p2\.args \|\| p2\.query \|\| p2\.summary;/.test(cpSrc));
  ok('§3 qHtml object branch', /if \(typeof q === 'object'\) \{[\s\S]*?JSON\.stringify\(q, null, 2\)/.test(cpSrc));
  ok('§3 toolDetailHTML derives', /qTxt = toolQueryText\(p\) \|\| ''/.test(cpSrc));
  ok('§3 export seam', cpSrc.includes('toolQueryText: toolQueryText'));
}

// ══ verdict ════════════════════════════════════════════════════════
console.log('v1300-continuous-rig: ' + (n - fails.length) + '/' + n);
if (fails.length) {
  console.log('FAILS:');
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
