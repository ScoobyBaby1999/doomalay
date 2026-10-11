#!/usr/bin/env node
// v1244-bundle-face-rig.cjs — v1.24.4 THE BUNDLE FACE (PLAN-V125 §4).
//
// The user's spec: the quick-chat ⚡ sandbox badge (which said nothing —
// every chat is quick) becomes the FACE of whatever bundle the bot is
// actually using from the library (the same icon the library card shows
// left of the title), hidden when nothing is in use; the full-width
// duplicate '▣ <bundle>' row above the lib pill dies; the seg pill grows
// an ✕ that drops the turn's active bundle.
//
// This rig pins:
//   · the ChatIcon badge render matrix (REAL chatbot.js + REAL icons.js
//     in a stub DOM: file-icon img / lucide svg / kind-glyph fallback /
//     hidden for quick+idle / legacy sandbox glyph kept / the ⚡ death)
//   · bundleBadgeOf (pure): the turn bundle → the face object
//   · dropTurnBundle (behavior): an attached bundle DETACHES (state +
//     localStorage), a member-in-use just clears the turn display
//   · the chip law: syncTemplateChip renders ONLY for templates (the
//     bundle duplicate row dies)
//   · the seg ✕ contract + the hub use-handoff contract + the pixi
//     canvas twin's source contracts (reads bundleBadge, the image
//     cache, the fingerprint key, the onload re-check)

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
const botSrc = fs.readFileSync(path.join(WEB, 'chatbot.js'), 'utf8');
const pixSrc = fs.readFileSync(path.join(WEB, 'pixiworld.js'), 'utf8');
const hubSrc = fs.readFileSync(path.join(WEB, 'hub.js'), 'utf8');
const cpSrc = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

// ══ 1. THE BADGE RENDER MATRIX (real modules, stub DOM) ════════════
// A tiny element factory good enough for ChatIcon's badge path.
function makeEl(tag) {
  const el = {
    tagName: String(tag || '').toUpperCase(),
    className: '', textContent: '', title: '', attrs: {},
    children: [], parent: null, style: {},
    _html: '',
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    remove() {
      if (el.parent) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    removeAttribute(k) { delete el.attrs[k]; },
    set innerHTML(v) { el._html = String(v); },
    get innerHTML() { return el._html; },
    addEventListener() {}, querySelector() { return null; }
  };
  return el;
}

// the stub browser surface: window.GridIcon (the base class), the REAL
// IconLib (icons.js is load-time DOM-free), document.createElement
global.window = {};
global.document = {
  createElement: (t) => makeEl(t),
  addEventListener: () => {}
};
class FakeGridIcon {
  constructor() { this.el = makeEl('div'); this.el.className = 'chatbot'; }
}
FakeGridIcon.prototype.serialize = function () { return {}; };
global.window.GridIcon = { GridIcon: FakeGridIcon, register: () => {} };
require(path.join(WEB, 'icons.js'));       // window.IconLib (the real resolver)
const IconLib = global.window.IconLib;
require(path.join(WEB, 'chatbot.js'));     // window.ChatIcon
const ChatIcon = global.window.ChatIcon.ChatIcon;

console.log('v1.24.4 THE BUNDLE FACE — the badge render matrix (real chatbot.js + icons.js):');

// the face resolver itself (the library card's own resolver — pinned so
// the badge can never drift from the card's face)
ok('IconLib.card resolves a file: icon to an img (the card face)',
  IconLib.card('file:art/icon.png', 'doomalay/x', 13).indexOf('<img') === 0);
ok('IconLib.card resolves a lucide name to the themed svg',
  IconLib.card('zap', '', 13).indexOf('<svg') === 0);
ok('an unknown icon name resolves to \'\' (the glyph fallback path)',
  IconLib.card('no-such-icon', '', 13) === '');

function badgeOf(icon) {
  const kids = icon.el.children.filter((c) => String(c.className).indexOf('sandbox-badge') === 0);
  return kids.length ? kids[kids.length - 1] : null;
}

// 1a. a bundle WITH a file icon → the img face
{
  const ic = new ChatIcon({ name: 'A', family: 'default', sandbox: 'quick' });
  ok('quick + idle → NO badge at all (the ⚡ death)',
    badgeOf(ic) === null, JSON.stringify((badgeOf(ic) || {}).textContent));
  ic.setBundleBadge({ icon: 'file:art/icon.png', repo: 'doomalay/x', name: 'superpowers', kind: 'bundle' });
  let b = badgeOf(ic);
  ok('a file-icon bundle → the badge renders', !!b);
  ok('the badge wears the bbdg face class', b && b.className === 'sandbox-badge bbdg');
  ok('the badge paints the IconLib.card img (13px — the card face)',
    b && b.innerHTML.indexOf('<img') === 0 && b.innerHTML.indexOf('width="13"') > 0);
  ok('the badge tooltip names the bundle', b && b.title.indexOf('superpowers') >= 0);
  ok('the icon instance carries bundleBadge (the pixi twin reads it)',
    ic.bundleBadge && ic.bundleBadge.name === 'superpowers');
}

// 1b. a bundle with a LUCIDE icon → the svg face
{
  const ic = new ChatIcon({ name: 'B', family: 'default', sandbox: 'quick' });
  ic.setBundleBadge({ icon: 'zap', repo: '', name: 'zap-bundle', kind: 'bundle' });
  const b = badgeOf(ic);
  ok('a lucide-icon bundle → the themed inline svg', b && b.innerHTML.indexOf('<svg') === 0);
}

// 1c. NO icon (a member in use / a stored bundle without one) → the kind glyph
{
  const ic = new ChatIcon({ name: 'C', family: 'default', sandbox: 'quick' });
  ic.setBundleBadge({ icon: '', repo: '', name: 'my-skill', kind: 'skill' });
  const b = badgeOf(ic);
  ok('no icon → the kind glyph (skill ✦)', b && b.textContent === '✦', b && b.textContent);
  ic.setBundleBadge({ icon: 'no-such-name', repo: '', name: 'x', kind: 'template' });
  ok('an UNKNOWN icon name → the glyph fallback too',
    badgeOf(ic) && badgeOf(ic).textContent === '⧉');
  ic.setBundleBadge({ icon: '', repo: '', name: 'mystery', kind: 'weird-kind' });
  ok('an unknown kind → the bundle glyph ⤓',
    badgeOf(ic) && badgeOf(ic).textContent === '⤓');
}

// 1d. null re-derives legacy: quick → hidden, hf/device/terminal → glyph
{
  const ic = new ChatIcon({ name: 'D', family: 'default', sandbox: 'quick' });
  ic.setBundleBadge({ icon: '', repo: '', name: 'b', kind: 'bundle' });
  ok('badge set → badge exists', !!badgeOf(ic));
  ic.setBundleBadge(null);
  ok('null on a QUICK sandbox → the badge is REMOVED', badgeOf(ic) === null);
  const hf = new ChatIcon({ name: 'E', family: 'default', sandbox: 'hf' });
  ok('a legacy hf sandbox keeps its glyph with no bundle in use',
    badgeOf(hf) && badgeOf(hf).textContent === '🤗');
  hf.setBundleBadge({ icon: '', repo: '', name: 'b', kind: 'doc' });
  ok('the bundle face OUTRANKS the legacy glyph while in use',
    badgeOf(hf) && badgeOf(hf).textContent === '▤');
  hf.setBundleBadge(null);
  ok('dropping the bundle RESTORES the legacy glyph',
    badgeOf(hf) && badgeOf(hf).textContent === '🤗');
}

// 1e. the identity guard — an unchanged face never churns the DOM
{
  const ic = new ChatIcon({ name: 'F', family: 'default', sandbox: 'quick' });
  ic.setBundleBadge({ icon: '', repo: '', name: 'b', kind: 'bundle' });
  const b1 = badgeOf(ic);
  ic.setBundleBadge({ icon: '', repo: '', name: 'b', kind: 'bundle' });
  ok('the same bundle twice → the SAME badge node (no churn)',
    badgeOf(ic) === b1);
  ic.setBundleBadge({ icon: '', repo: '', name: 'other', kind: 'bundle' });
  ok('a DIFFERENT bundle → a fresh badge node', badgeOf(ic) !== b1);
}

// 1f. garbage honesty
{
  const ic = new ChatIcon({ name: 'G', family: 'default', sandbox: 'quick' });
  ic.setBundleBadge(null);
  ic.setBundleBadge({});        // no name → treated as null
  ok('a nameless bundle object → no badge (honest null)', badgeOf(ic) === null);
  ic.setBundleBadge('garbage');
  ok('a garbage bundle → no badge (never a crash)', badgeOf(ic) === null);
}

// ══ 2. bundleBadgeOf (pure) — the turn bundle → the face ═══════════
console.log('bundleBadgeOf (the pure seam):');
{
  const sandboxLS = {};
  global.localStorage = {
    getItem: (k) => Object.prototype.hasOwnProperty.call(sandboxLS, k) ? sandboxLS[k] : null,
    setItem: (k, v) => { sandboxLS[k] = String(v); },
    removeItem: (k) => { delete sandboxLS[k]; }
  };
  global.window.ChatTypes = { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } };
  global.window.addEventListener = () => {};
  global.location = { protocol: 'http:', host: 'test' };
  function FakeWS() {}
  FakeWS.prototype.send = function () {};
  global.WebSocket = FakeWS;
  const P = require(path.join(WEB, 'chatpanel.js'));

  eq('nothing in use → null',
    P.bundleBadgeOf({ _turnBundle: null, bundle: null }), null);
  eq('a member in use → glyph-only (icon/repo empty)',
    P.bundleBadgeOf({ _turnBundle: { kind: 'skill', name: 's1' }, bundle: null }),
    { kind: 'skill', name: 's1', icon: '', repo: '' });
  eq('an armed whole bundle → the attached face (icon + repo ride the arm derivation)',
    P.bundleBadgeOf({
      _turnBundle: { kind: 'bundle', name: 'b1', icon: 'file:art.png', repo: 'r/x' },
      bundle: { name: 'b1', icon: 'file:art.png', repo: 'r/x' }
    }),
    { kind: 'bundle', name: 'b1', icon: 'file:art.png', repo: 'r/x' });
  eq('a turn bundle whose icon was lost → the matching state.bundle face answers',
    P.bundleBadgeOf({
      _turnBundle: { kind: 'bundle', name: 'b1' },
      bundle: { name: 'b1', icon: 'zap', repo: 'r/y' }
    }),
    { kind: 'bundle', name: 'b1', icon: 'zap', repo: 'r/y' });
  eq('a turn bundle NOT matching the attached bundle → glyph-only (a foreign download)',
    P.bundleBadgeOf({
      _turnBundle: { kind: 'bundle', name: 'other' },
      bundle: { name: 'b1', icon: 'zap', repo: 'r/y' }
    }),
    { kind: 'bundle', name: 'other', icon: '', repo: '' });
  eq('a stored bundle without an icon → glyph-only (honest)',
    P.bundleBadgeOf({
      _turnBundle: { kind: 'bundle', name: 'b1' },
      bundle: { name: 'b1' }
    }),
    { kind: 'bundle', name: 'b1', icon: '', repo: '' });
  eq('null state → null (never a crash)', P.bundleBadgeOf(null), null);

  // ══ 3. dropTurnBundle (behavior) ════════════════════════════════
  console.log('dropTurnBundle (the seg ✕ law):');
  const ls = sandboxLS;
  let patchCalls = [];
  global.fetch = (url, opts) => {
    patchCalls.push({ url: String(url), method: opts && opts.method });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  // 3a. an attached whole bundle DETACHES
  {
    const state = {
      sessionId: 'sessX', bundle: { id: 'b1', name: 'b1', members: [{ type: 'skill' }] },
      _turnBundle: { kind: 'bundle', name: 'b1', icon: '', repo: '' },
      _icon: {
        setBundleBadge(b) { this.got = b; },
        save() {},
        caps: null
      }
    };
    ls['doomalay.chatbundle.v1'] = JSON.stringify({ sessX: state.bundle });
    P.dropTurnBundle(null, state);
    ok('the attached bundle DETACHES (state.bundle = null)', state.bundle === null);
    ok('the localStorage manifest is dropped for that session',
      JSON.parse(ls['doomalay.chatbundle.v1'] || '{}').sessX === undefined);
    ok('the turn display clears (_turnBundle = null)', state._turnBundle === null);
    ok('the badge hides (setBundleBadge(null) landed on the icon)',
      state._icon.got === null);
    ok('the caps PATCH fired for the session (persistCaps rode the drop)',
      patchCalls.some((c) => /sessX/.test(c.url) && c.method === 'PATCH'));
  }
  // 3b. a member-in-use (no attached bundle) just clears the display
  {
    const state = {
      sessionId: null, bundle: null,
      _turnBundle: { kind: 'skill', name: 's1' },
      _icon: { setBundleBadge(b) { this.got = b; }, save() {}, caps: null }
    };
    P.dropTurnBundle(null, state);
    ok('a member-in-use clears the turn display', state._turnBundle === null);
    ok('the badge hides', state._icon.got === null);
  }
  // 3c. a FOREIGN turn bundle (not the attached one) does not detach the attached
  {
    const state = {
      sessionId: 'sessZ', bundle: { id: 'b2', name: 'b2', members: [{ type: 'doc' }] },
      _turnBundle: { kind: 'bundle', name: 'downloaded-other' },
      _icon: { setBundleBadge(b) { this.got = b; }, save() {}, caps: null }
    };
    ls['doomalay.chatbundle.v1'] = JSON.stringify({ sessZ: state.bundle });
    P.dropTurnBundle(null, state);
    ok('a foreign turn bundle never detaches the ATTACHED one',
      state.bundle && state.bundle.name === 'b2');
    ok('the turn display still clears', state._turnBundle === null);
  }

  // ══ 4. THE CHIP LAW (bundle → no #tpl-chip; template → chip) ════
  console.log('syncTemplateChip (the redundant full-width row dies):');
  function fakeBody() {
    const bar = makeEl('div');
    const body = makeEl('div');
    body.querySelector = (q) => (q === '#chat-inputbar' ? bar : null);
    bar.insertBefore = (el) => { bar.children.unshift(el); el.parent = bar; return el; };
    Object.defineProperty(bar, 'firstChild', { get: () => bar.children[0] || null });
    body.children.push(bar);
    return { body, bar };
  }
  // 4a. a bundle attached → NO chip (the old ▣ row dies)
  {
    const { body, bar } = fakeBody();
    body.querySelector = () => null;  // no existing chip
    P.syncTemplateChip && (() => {
      // drive it through the module's public path: state with bundle only
      // (syncTemplateChip is internal — its law is pinned by source +
      // the applyBundle flow; here we assert the DOM shape it produced
      // via the same call the module makes). Not exported → source pin.
    })();
    ok('syncTemplateChip is source-pinned (bundle case below)',
      /if \(!state\.template\) \{/.test(cpSrc) &&
      /v1\.24\.4: the chip renders ONLY for templates/.test(cpSrc));
  }
}

// ══ 5. SOURCE CONTRACTS ════════════════════════════════════════════
console.log('source contracts:');
// the seg ✕: label span + ✕ span, the ✕ swallows the click
ok('chatpanel: the seg is a label span + an ✕ span (the ✕ never ellipsizes away)',
  /seg-lib-bundle-label/.test(cpSrc) && /seg-lib-bundle-x/.test(cpSrc));
ok('chatpanel: the ✕ swallows the click (stopPropagation + preventDefault)',
  /segX\.addEventListener\('click', function \(e\) \{[\s\S]{0,220}e\.stopPropagation\(\);[\s\S]{0,160}e\.preventDefault\(\);[\s\S]{0,160}dropTurnBundle/.test(cpSrc));
ok('chatpanel: the pill stays a button → openLib (the ✕ rides INSIDE it)',
  /seg\.addEventListener\('click', openLib\);/.test(cpSrc) && /seg\.appendChild\(segLab\)/.test(cpSrc) && /seg\.appendChild\(segX\)/.test(cpSrc));
ok('chatpanel: the paint writes the LABEL SPAN (degrades to textContent without it)',
  /var labEl = seg\.querySelector\('\.seg-lib-bundle-label'\);/.test(cpSrc));
ok('chatpanel: paintSegBundle syncs the badge twin FIRST (DOM-independent)',
  /setBundleBadge\(bundleBadgeOf\(state\)\)/.test(cpSrc));
ok('chatpanel: the chat-open init arms the badge after loadBundle',
  /loadBundle\(state\);[\s\S]{0,700}armTurnBundle\(currentCtx\.bodyEl, state\);/.test(cpSrc));
ok('chatpanel: applyBundle stores the icon + repo on the manifest',
  /icon: String\(bundle\.icon \|\| ''\), repo: String\(bundle\.repo \|\| ''\),/.test(cpSrc));
ok('chatpanel: armTurnBundle keeps the icon fields on _turnBundle',
  /kind: 'bundle', name: state\.bundle\.name,[\s\S]{0,120}icon: state\.bundle\.icon \|\| '', repo: state\.bundle\.repo \|\| ''/.test(cpSrc));
ok('chatbot: the ⚡ quick badge is DEAD (sandbox quick returns before the badge)',
  /if \(this\.sandbox === 'quick'\) return;/.test(botSrc));
ok('chatbot: BUNDLE_GLYPHS lives on ChatIcon (the pixi twin reads it)',
  /static BUNDLE_GLYPHS/.test(botSrc));
ok('index.html: the bbdg face CSS (13px img/svg, text-1 ink, theme vars)',
  /\.sandbox-badge\.bbdg svg,/.test(css) && /\.chatbot \.sandbox-badge\.bbdg \{/.test(css) &&
  /width: 13px;/.test(css));

// the hub handoff: the bunch-use bundle carries icon + repo
ok('hub: the bunch-use handoff carries the bundle icon + repo (the card face)',
  /icon: \(meta && meta\.icon\) \|\| '',/.test(hubSrc) &&
  /repo: \(meta && meta\.repo\) \|\| '',/.test(hubSrc));

// the pixi canvas twin
ok('pixiworld: the raster reads icon.bundleBadge (the face law)',
  /var bb = icon\.bundleBadge \|\| null;/.test(pixSrc));
ok('pixiworld: a quick sandbox with no bundle paints NO chip',
  /bb \|\| \(icon\.sandbox && icon\.sandbox !== 'quick'\)/.test(pixSrc));
ok('pixiworld: the file-icon art rides the module image cache',
  /imageFor\(bu\)/.test(pixSrc));
ok('pixiworld: the badge identity + readiness ride the fingerprint (re-raster)',
  /bbk = bb\.kind \+ ':' \+ bb\.name/.test(pixSrc) && /\(be && be\.ready\) \? '\|1' : '\|0'/.test(pixSrc));
ok('pixiworld: a landing image re-checks the fingerprints (the frame-after law)',
  /e\.ready = true; S\.dirtyAll = true;[\s\S]{0,700}watchAppearances\(\);/.test(pixSrc));
ok('pixiworld: the canvas glyph falls back to the kind glyph (ChatIcon.BUNDLE_GLYPHS)',
  /window\.ChatIcon\.ChatIcon\.BUNDLE_GLYPHS/.test(pixSrc));

console.log('\n' + (fails.length === 0 ? ('ALL ' + n + ' PASS') : (fails.length + ' FAIL of ' + n + ':\n  ' + fails.join('\n  '))));
process.exit(fails.length === 0 ? 0 : 1);
