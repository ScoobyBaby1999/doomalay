#!/usr/bin/env node
// v1321-workertail-rig.mjs — v1.32.1 THE OFF-THREAD TAIL battery (PLAN-V133 §1).
//
// The worker formatter, proven on the real code:
//   §A source pins      — the worker file, the router, THE SANITIZE LAW's
//                         shape, the fallbacks, the perfhud rows
//   §B PARITY           — the worker's html/artifacts are BYTE-EQUAL to the
//                         sync pipeline's across a hostile corpus (both
//                         sides run the REAL code in VMs against the REAL
//                         vendored marked)
//   §C THE SANITIZE LAW — worker output reaches the DOM only through
//                         applyRendered, which sanitizes first (a DOMPurify
//                         stub proves the gate sits between)
//   §D LATEST-WINS      — a stale apply is dropped and counted; a newer
//                         apply lands; other containers are untouched
//   §E THE FALLBACKS    — no Worker / spawn throw / worker error /
//                         ok:false ×3 → the sync pipeline (byte-identical
//                         pre-wave behavior)
//   §F the ledger       — the REAL perfhud module: fmtw counters move,
//                         drops bump, the rows render
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) { console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n═ ' + t); }

const fmtSrc = read('formatter.js');
const wkSrc = read('formatter.worker.js');
const phSrc = read('perfhud.js');
const cpSrc = read('chatpanel.js');
const markedSrc = read('vendor/format/marked.min.js');
// strip block + line comments (the pins judge CODE, not prose)
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

// ══ §A source pins ═══════════════════════════════════════════════════
section('§A source pins — the split is real, the law is shaped right');
ok('worker: importScripts the vendored marked', /importScripts\('\/vendor\/format\/marked\.min\.js'\)/.test(wkSrc));
ok('worker: the SAME marked options as ensureMarked', /setOptions\(\{ gfm: true, breaks: true, headerIds: false, mangle: false \}\)/.test(wkSrc));
ok('worker: carries the artifact extractor copy', /function extractArtifacts\(/.test(wkSrc) && /%%DOOMALAY-ARTIFACT-/.test(wkSrc));
ok('worker: carries the streaming-fence collapse copy', /function collapseStreamingFences\(/.test(wkSrc));
ok('worker: the protocol is {id, ok, html, artifacts}', /postMessage\(\{ id: id, ok: true, html: html, artifacts: artifacts \}\)/.test(wkSrc));
ok('worker: NEVER touches a DOM (code has no document, no innerHTML)', !/document\.|innerHTML/.test(stripComments(wkSrc)));
ok('worker: NEVER references DOMPurify in code (the decision: it stays main)', !/DOMPurify/i.test(stripComments(wkSrc)));

ok('formatter: eligibility = streaming + full/thinking ONLY', /opts\.streaming &&\s*\n?\s*\(opts\.mode === 'full' \|\| opts\.mode === 'thinking'\)/.test(fmtSrc));
ok('formatter: the router exists (eligible → fmtwSubmit, else renderIntoSync)', /if \(fmtwEligible\(opts\)\) return fmtwSubmit\(/.test(fmtSrc) && /return renderIntoSync\(el, text, opts\);/.test(fmtSrc));
ok('formatter: THE SANITIZE LAW — applyRendered sanitizes BEFORE innerHTML', /function applyRendered\(el, html, artifacts, opts\) \{[\s\S]{0,220}el\.innerHTML = sanitize\(html\);/.test(fmtSrc));
ok('formatter: the worker reply applies ONLY via applyRendered', /applyRendered\(job\.el, res\.html, res\.artifacts \|\| \[\], job\.opts\)/.test(fmtSrc));
ok('formatter: latest-wins reads the per-container id', /fmtw\.latest\.get\(job\.el\) !== res\.id/.test(fmtSrc) && /PH\.bump\('fmtwDrops'\)/.test(fmtSrc));
ok('formatter: a worker-level error retires the worker (sync forever)', /fmtw\.w\.onerror = function \(\) \{[\s\S]{0,120}fmtw\.failed = true;/.test(fmtSrc));
ok('formatter: three ok:false results retire the worker too', /if \(\+\+fmtw\.errs >= 3\) fmtw\.failed = true;/.test(fmtSrc));
ok('formatter: Worker-less environments fail OVER to sync (the spawn try/catch retires it)', /try \{\s*\n\s*fmtw\.w = new Worker\('[^']*'\);[\s\S]{0,200}catch \(e\) \{\s*\n\s*fmtw\.failed = true;/.test(fmtSrc));
ok('formatter: __fmtw introspection exposed for the rigs', /__fmtw: function \(\)/.test(fmtSrc));
ok('chatpanel: ZERO changes (no fmtw coupling — the client owns the queue)', !/fmtw/.test(cpSrc));

ok('perfhud: the fmtw ledger branch', /kind === 'fmtw'[\s\S]{0,220}P\.fmtwCount\+\+/.test(phSrc));
ok('perfhud: the drop counter bumps', /kind === 'fmtwDrops'[\s\S]{0,60}P\.fmtwDrops\+\+/.test(phSrc));
ok('perfhud: the page carries the worker row', /row\('pf-fmtw', 'Formatter worker'/.test(phSrc) && /set\('pf-fmtw'/.test(phSrc));

// ══ the shared VM helpers ════════════════════════════════════════════
// A minimal esc-capable document stub (formatter's esc uses a real div).
function docStub() {
  return {
    documentElement: {
      style: { setProperty() {}, removeProperty() {} },
      setAttribute() {}, removeAttribute() {}
    },
    head: { appendChild() {} },
    createElement(tag) {
      const el = {
        tagName: tag, _t: '', children: [], _html: '', _htmlSet: false,
        style: { setProperty() {}, removeProperty() {}, cssText: '' },
        set textContent(v) { this._t = String(v == null ? '' : v); this._htmlSet = false; },
        get textContent() { return this._t; },
        // REAL DOM SEMANTICS (the esc() contract): after textContent, the
        // innerHTML getter returns the ESCAPED text — a plain getter that
        // returns '' broke the user/plain parity in the rig only.
        get innerHTML() {
          if (this._htmlSet) return this._html;
          return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
        set innerHTML(v) { this._html = String(v); this._htmlSet = true; },
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.unshift(c); return c; },
        removeChild(c) { return c; },
        querySelector() { return null; },
        querySelectorAll() { const a = []; a.forEach = Array.prototype.forEach; return a; },
        addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
        classList: { add() {}, remove() {}, contains() { return false; } },
        getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
        closest() { return null; }, focus() {}, select() {}, remove() {}
      };
      return el;
    },
    addEventListener() {}, getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    body: { appendChild() {}, removeChild() {} }
  };
}
function fakeEl() { return docStub().createElement('div'); }

function makeWorkerVM() {
  const sb = { console, URL, TextEncoder };
  sb.self = sb;
  sb.importScripts = function () {};      // marked is pre-loaded below
  vm.createContext(sb);
  vm.runInContext(markedSrc, sb);         // the REAL vendored marked → globalThis.marked
  vm.runInContext(wkSrc, sb);             // the REAL worker: self.onmessage assigned
  return sb;
}
// the sync-side slice: the REAL production string pipeline (extract →
// collapse → marked → wrap), captured at applyRendered (pre-sanitize).
function makeSyncVM() {
  const a0 = fmtSrc.indexOf('  var ART_RE =');
  const a1 = fmtSrc.indexOf('  // ── The renderer');
  const b0 = fmtSrc.indexOf('  function renderIntoSync(');
  const b1 = fmtSrc.indexOf('  function collapseLongCode(');
  const sliced = fmtSrc.slice(a0, a1) + '\n' + fmtSrc.slice(b0, b1);
  const sb = { console, URL, TextEncoder };
  sb.window = sb; sb.self = sb;
  sb.document = docStub();
  sb.applyRendered = (el, html, artifacts, opts) => {
    sb.__captured.push({ html, artifacts, opts });
  };
  sb.__captured = [];
  vm.createContext(sb);
  vm.runInContext(markedSrc, sb);
  vm.runInContext('(function(){\n' + sliced + '\nglobalThis.renderIntoSync = renderIntoSync; globalThis.extractArtifacts = extractArtifacts; })()', sb);
  return sb;
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ══ §B PARITY — the corpus ═══════════════════════════════════════════
section('§B PARITY — worker html === sync html, byte-for-byte, on the real code');
const CORPUS = [
  { name: 'paragraphs', text: 'Hello **world**. Some _emphasis_ and ~~strike~~ and `inline code`.' },
  { name: 'headings', text: '# H one\n\n## H two\n\n### H three\n\nbody text' },
  { name: 'lists+tasks', text: '- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [x] done\n- [ ] open' },
  { name: 'table', text: '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |' },
  { name: 'quote', text: '> quoted line\n> second line\n\nafter' },
  { name: 'code js', text: '```js\nfunction f(x) { return x + 1; }\n```' },
  { name: 'code unknown lang', text: '```weirdlang\nsome tokens :: --==\n```' },
  { name: 'code no lang', text: '```\nplain fence body\nline two\n```' },
  { name: 'links', text: '[site](https://example.com/x) and bare https://example.com/y and <https://example.com/z>' },
  { name: 'artifact closed', text: 'before\n\n```artifact file=notes.md encoding=utf8\n# Notes\nbody line\n```\n\nafter' },
  { name: 'artifact streaming open', text: 'before\n\n```artifact file=big.bin encoding=base64\nAAAABBBBCCCC\nstill open…', streaming: true },
  { name: 'hostile script', text: 'hello <script>alert(1)</script> world <img src=x onerror="alert(2)"> done' },
  { name: 'hostile js link', text: '[click](javascript:alert(1)) and [b](data:text/html,<script>)' },
  { name: 'empty', text: '' },
  { name: 'unicode+crlf', text: 'line one\r\nwith Ünïcödé ✻ 中文 emoji 🎨\r\n\r\nsecond ¶' },
  { name: 'thinking headings', text: '## plan\n\nthink the steps **carefully**\n\n### sub', mode: 'thinking' },
  { name: 'big mixed', text: ('# Report\n\nintro paragraph with **bold**.\n\n```python\ndef f():\n    return 42\n```\n\n| k | v |\n|---|---|\n| a | 1 |\n\n> quote\n\n- item one\n- item two\n\n' + 'tail text '.repeat(120)) }
];
const wvm = makeWorkerVM();
const svm = makeSyncVM();
let parityJobs = 0;
for (const c of CORPUS) {
  for (const streaming of (c.streaming ? [true] : [false, true])) {
    const mode = c.mode || 'full';
    // worker side
    const job = { id: ++parityJobs, mode, text: c.text, streaming };
    wvm.__res = null;
    wvm.postMessage = (m) => { wvm.__res = m; };
    wvm.onmessage({ data: job });
    const res = wvm.__res;
    ok('parity ' + c.name + ' (streaming=' + streaming + '): worker answered ok', !!res && res.ok === true && res.id === job.id, res && res.err);
    // sync side
    svm.__captured.length = 0;
    svm.renderIntoSync(fakeEl(), c.text, { mode, streaming });
    const cap = svm.__captured[0];
    ok('parity ' + c.name + ' (streaming=' + streaming + '): html BYTE-EQUAL',
      !!cap && cap.html === res.html,
      (!cap) ? 'no sync capture' : 'first diff @' + (() => {
        const a = cap.html, b = res.html;
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i + ' [' + a.slice(Math.max(0, i - 30), i + 30) + '] vs [' + b.slice(Math.max(0, i - 30), i + 30) + ']';
        return 'length ' + a.length + '/' + b.length;
      })());
    ok('parity ' + c.name + ' (streaming=' + streaming + '): artifacts DEEP-EQUAL', deepEq(cap.artifacts, res.artifacts));
  }
}

// ══ the full-module sandbox (law / latest-wins / fallback) ═══════════
function makeFmtVM(opts) {
  const o = opts || {};
  const moves = {}, bumps = {};
  const sb = { console, URL, TextEncoder, setTimeout, clearTimeout };
  sb.window = sb; sb.self = sb;
  sb.document = docStub();
  sb.performance = { now: () => Date.now() };
  sb.PerfHUD = {
    markStart: () => 0,
    ledger: (k) => { moves[k] = (moves[k] || 0) + 1; },
    bump: (k) => { bumps[k] = (bumps[k] || 0) + 1; }
  };
  sb.__moves = moves; sb.__bumps = bumps;
  if (o.purify) sb.DOMPurify = { sanitize: (h) => 'SZ::' + h };
  if (o.workerClass) sb.Worker = o.workerClass;
  vm.createContext(sb);
  vm.runInContext(markedSrc, sb);
  vm.runInContext(fmtSrc, sb);
  return sb;
}
class FakeWorker {
  constructor(url) {
    FakeWorker.last = this;
    this.url = url;
    this.sent = [];
    this.terminated = false;
  }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
}
FakeWorker.last = null;

// ══ §C THE SANITIZE LAW ══════════════════════════════════════════════
section('§C THE SANITIZE LAW — worker output never becomes DOM unsanitized');
{
  const sb = makeFmtVM({ purify: true, workerClass: FakeWorker });
  const el = fakeEl();
  sb.Formatter.renderInto(el, 'x <img src=y onerror=pwn(1)> y', { mode: 'full', streaming: true });
  const fw = FakeWorker.last;
  ok('law: the worker spawned for the eligible render', !!fw && /formatter\.worker\.js/.test(fw.url), fw && fw.url);
  ok('law: the job went out with the raw text', fw.sent.length === 1 && fw.sent[0].text.includes('onerror'));
  // the worker's RAW html comes back — hostile on purpose
  fw.onmessage({ data: { id: fw.sent[0].id, ok: true, html: '<div class="fmt fmt-full"><p>x <img src=y onerror=pwn(1)> y</p></div>', artifacts: [] } });
  ok('law: the applied DOM is the SANITIZER\u2019s output (SZ:: prefix proves the gate ran)',
    el.innerHTML.startsWith('SZ::') && el.innerHTML.includes('onerror'), el.innerHTML.slice(0, 60));
  ok('law: the sanitize stub received EXACTLY the worker html (nothing bypassed)',
    el.innerHTML === 'SZ::' + '<div class="fmt fmt-full"><p>x <img src=y onerror=pwn(1)> y</p></div>');
  const m = sb.Formatter.__fmtw();
  ok('law: the introspection says the worker path is live', m.spawned === true && m.failed === false && m.seq === 1, JSON.stringify(m));
}

// ══ §D LATEST-WINS ═══════════════════════════════════════════════════
section('§D LATEST-WINS — a stale apply is dropped and counted; a newer lands');
{
  const sb = makeFmtVM({ workerClass: FakeWorker });
  const el = fakeEl(), el2 = fakeEl();
  sb.Formatter.renderInto(el, 'first', { mode: 'full', streaming: true });
  const fw = FakeWorker.last;
  const id1 = fw.sent[0].id;
  sb.Formatter.renderInto(el, 'second', { mode: 'full', streaming: true });
  const id2 = fw.sent[1].id;
  ok('latest: two jobs submitted for one container', fw.sent.length === 2 && id2 === id1 + 1);
  // the STALE reply arrives after the newer submission
  fw.onmessage({ data: { id: id1, ok: true, html: '<div class="fmt fmt-full"><p>STALE</p></div>', artifacts: [] } });
  ok('latest: the stale apply is DROPPED (el untouched)', el.innerHTML === '');
  ok('latest: the drop is counted on the ledger', sb.__bumps.fmtwDrops === 1, JSON.stringify(sb.__bumps));
  // the fresh reply lands
  fw.onmessage({ data: { id: id2, ok: true, html: '<div class="fmt fmt-full"><p>second</p></div>', artifacts: [] } });
  ok('latest: the fresh apply lands', el.innerHTML === '<div class="fmt fmt-full"><p>second</p></div>', el.innerHTML.slice(0, 50));
  // an unrelated container is unaffected by el's drama
  sb.Formatter.renderInto(el2, 'other', { mode: 'full', streaming: true });
  const id3 = fw.sent[2].id;
  fw.onmessage({ data: { id: id3, ok: true, html: '<div class="fmt fmt-full"><p>other</p></div>', artifacts: [] } });
  ok('latest: another container applies independently', el2.innerHTML === '<div class="fmt fmt-full"><p>other</p></div>');
  // an unknown id is owned by nobody
  let threw = false;
  try { fw.onmessage({ data: { id: 99999, ok: true, html: '<div>ghost</div>' } }); } catch (e) { threw = true; }
  ok('latest: an unknown reply id is ignored safely', !threw && el2.innerHTML !== '<div>ghost</div>');
}

// ══ §E THE FALLBACKS ═════════════════════════════════════════════════
section('§E THE FALLBACKS — every failure lands on the sync pipeline');
{
  // no Worker at all (rig/VM shape)
  const sb = makeFmtVM({});
  const el = fakeEl();
  const r = sb.Formatter.renderInto(el, 'no worker here', { mode: 'full', streaming: true });
  ok('fallback: Worker-less applies SYNCHRONOUSLY (marked rendered it)', el.innerHTML.includes('no worker here'));
  ok('fallback: the introspection reports failed=true', sb.Formatter.__fmtw().failed === true);
  ok('fallback: the sync path returns the real artifacts shape', r && Array.isArray(r.artifacts));
}
{
  // a Worker whose constructor throws
  class BoomWorker { constructor() { throw new Error('no workers in this webview'); } }
  const sb = makeFmtVM({ workerClass: BoomWorker });
  const el = fakeEl();
  sb.Formatter.renderInto(el, 'boom spawn', { mode: 'full', streaming: true });
  ok('fallback: a spawn throw lands sync + retires the worker', el.innerHTML.includes('boom spawn') && sb.Formatter.__fmtw().failed === true);
}
{
  // the worker errors at the protocol level (ok:false) — first call falls
  // back per-call, three calls retire the worker
  class SickWorker extends FakeWorker {
    postMessage(m) { this.sent.push(m); }
  }
  const sb = makeFmtVM({ workerClass: SickWorker });
  const el = fakeEl();
  for (let i = 0; i < 3; i++) {
    sb.Formatter.renderInto(el, 'sick ' + i, { mode: 'full', streaming: true });
    const fw = FakeWorker.last;
    fw.onmessage({ data: { id: fw.sent[fw.sent.length - 1].id, ok: false, err: 'marked exploded' } });
  }
  ok('fallback: three ok:false → every call still RENDERED (sync)', el.innerHTML.includes('sick 2'));
  ok('fallback: the worker is retired after the third protocol error', sb.Formatter.__fmtw().failed === true);
}
{
  // eligibility: the streaming:false paths and user mode never touch the worker
  const sb = makeFmtVM({ workerClass: FakeWorker });
  const el = fakeEl();
  FakeWorker.last = null;
  sb.Formatter.renderInto(el, 'final render', { mode: 'full', streaming: false });
  ok('fallback: streaming:false stays sync (the final render)', el.innerHTML.includes('final render') && FakeWorker.last === null);
  FakeWorker.last = null;
  sb.Formatter.renderInto(el, 'user words', { mode: 'user' });
  ok('fallback: user mode stays sync', el.innerHTML.includes('user words') && FakeWorker.last === null);
  FakeWorker.last = null;
  sb.Formatter.renderInto(el, 'plain text', { mode: 'plain' });
  ok('fallback: plain mode stays sync', el.innerHTML.includes('plain text') && FakeWorker.last === null);
  // and a stable-chunk render (streaming:false with full mode) stays sync too
  FakeWorker.last = null;
  sb.Formatter.renderInto(el, 'stable chunk', { mode: 'full', streaming: false });
  ok('fallback: the stable-chunk render stays sync (the two-tier contract)', el.innerHTML.includes('stable chunk') && FakeWorker.last === null);
}

// ══ §F the ledger — the REAL perfhud module ══════════════════════════
section('§F THE LEDGER — the real perfhud moves the fmtw counters');
{
  const sb = { console, URL, TextEncoder, setTimeout, clearTimeout, performance };
  sb.window = sb; sb.self = sb;
  sb.document = docStub();
  sb.requestAnimationFrame = function () { return 0; };
  sb.cancelAnimationFrame = function () {};
  sb.PerformanceObserver = undefined;
  // perfhud subscribes unconditionally at boot (Settings.onChange line 367)
  sb.Settings = {
    registerPage: function () {},
    onChange: function () {},
    getState: function () { return {}; },
    setState: function () {}
  };
  sb.__errs = [];
  vm.createContext(sb);
  try { vm.runInContext(phSrc, sb); }
  catch (e) { sb.__errs.push(e.message); }
  ok('perfhud: the real module evaluates in the vm', sb.__errs.length === 0 && !!sb.PerfHUD, sb.__errs.join('; '));
  const P = sb.DoomalayPerf;
  const t0 = sb.PerfHUD.markStart('fmtw');
  sb.PerfHUD.ledger('fmtw', t0 - 7);            // pretend 7ms passed
  ok('perfhud: ledger(fmtw) moves fmtwCount + fmtwMsWorst', P.fmtwCount === 1 && P.fmtwMsWorst >= 7, JSON.stringify({ c: P.fmtwCount, w: P.fmtwMsWorst }));
  sb.PerfHUD.bump('fmtwDrops');
  sb.PerfHUD.bump('fmtwDrops');
  ok('perfhud: bump(fmtwDrops) counts the drops', P.fmtwDrops === 2, P.fmtwDrops);
  ok('perfhud: the fmt ledger is untouched by fmtw traffic', P.fmtCount === 0 && P.renders === 0, JSON.stringify({ f: P.fmtCount, r: P.renders }));
}

// ══ the verdict ══════════════════════════════════════════════════════
console.log('\n════════════════════════════════════════════');
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + n + '/' + n + ' — v1.32.1 THE OFF-THREAD TAIL battery');
