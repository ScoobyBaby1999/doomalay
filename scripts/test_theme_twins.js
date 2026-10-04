#!/usr/bin/env node
// test_theme_twins.js — node-side verification of the v0.44 VAR-TWIN
// color system (W2-B2: theme.js + formatter.js + appearance.js over
// uikit.js GradientUI v2). The harness stubs the minimal browser
// surface (window / document / Settings) the three IIFEs touch at
// LOAD time, so the REAL modules run their REAL boot + apply paths:
//
//   · theme.js     — deriveTwins (hex-only → gradient 'none', spec →
//                    solid+css pairs, tex stripped, patterns on
//                    1 color), hexTriplet (the -rgb math),
//                    gridSpecFor / effectiveGridSpecs / effectiveGrid
//                    (spec resolution + the legacy HEX contract),
//                    and applyTheme itself writing the twins (boot)
//   · formatter.js — applyScheme writing --fmt-<slot> twins, the
//                    -ink vars, and the :root data-fmt-grad list
//                    (set on multi-color slots, absent when solid) —
//                    plus parity with theme's deriveTwins
//   · appearance.js— the shared fmt row builder (data-fmt-slot /
//                    data-fmt-scope hooks, the '· this chat' marker,
//                    noTex editors with dir pills) and the full
//                    appearance page render (tv-/gc-/fmt- editors,
//                    NO legacy color inputs anywhere). v0.98 C3 made
//                    the row editors LAZY (banner + empty shell until
//                    the user expands) — the rig EXPANDS every row
//                    through the module's real wireColorRows click
//                    path before the editor-markup assertions.
//
// Prints 'SELF-TEST OK' + exit 0 on success; failures + exit 1.

'use strict';

var path = require('path');
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

// ── 1. uikit first — its node export path (no window yet) ──────────
var uikit = require(path.join(WEB, 'uikit.js'));
var G = uikit.GradientUI;
if (!G) { console.log('SELF-TEST FAILED: uikit exports missing'); process.exit(1); }

// ── 2. the stub browser surface ─────────────────────────────────────
// A recording documentElement: style.setProperty/removeProperty and
// setAttribute/removeAttribute all land in `rec` (reset per scenario).
var rec = { props: {}, attrs: {}, removed: [], unattr: [] };
function resetRec() {
  rec = { props: {}, attrs: {}, removed: [], unattr: [] };
}
var docEl = {
  style: {
    setProperty: function (k, v) { rec.props[k] = String(v); },
    removeProperty: function (k) { delete rec.props[k]; rec.removed.push(k); }
  },
  setAttribute: function (k, v) { rec.attrs[k] = String(v); },
  removeAttribute: function (k) { delete rec.attrs[k]; rec.unattr.push(k); },
  // v0.79.1: applyTheme's topology fingerprint reads data-fmt-grad
  getAttribute: function (k) { return (k in rec.attrs) ? rec.attrs[k] : null; }
};
var rafQueue = [];
var settingsState = {
  theme: 'midnight',
  // v0.99.4: the FOLD exercise — a legacy --accent SPEC override + a
  // derived-era --bg-app hex (dropped by design) + a legacy --text-1
  // gradient (ink is solid-only → first color)
  themeOverrides: {
    midnight: {
      '--accent': { colors: ['#ff00aa', '#00ffcc'], dir: 'h' },
      '--bg-app': '#123456',
      '--text-1': { colors: ['#feedcc', '#abcdef'], dir: 'v' }
    }
  },
  chatScheme: 'teal',
  fmtOverrides: {},
  // legacy never-customized grid hexes
  bg: '#0a0a0b', lineColor: '#131318', dotColor: '#2e2e3a', originColor: '#4a4a5e'
};
var registeredPages = {};
var settingsStub = {
  registerPage: function (id, opts) { registeredPages[id] = opts; },
  getState: function () { return settingsState; },
  setState: function (patch) { Object.assign(settingsState, patch); },
  rerender: function () { rec.rerender = (rec.rerender || 0) + 1; },
  onChange: function () {}
};
global.window = {
  GradientUI: G,
  Settings: settingsStub,
  addEventListener: function () {}
};
global.document = {
  documentElement: docEl,
  querySelector: function () { return null; },   // drain safety path
  getElementById: function (id) { return id === 'chat-root' ? chatRoot : null; }
};

// the #chat-root stub — appearance.js's per-chat twin paint targets it
var chatRec = { props: {}, attrs: {}, removed: [], unattr: [] };
var chatRoot = {
  style: {
    setProperty: function (k, v) { chatRec.props[k] = String(v); },
    removeProperty: function (k) { delete chatRec.props[k]; chatRec.removed.push(k); }
  },
  setAttribute: function (k, v) { chatRec.attrs[k] = String(v); },
  removeAttribute: function (k) { delete chatRec.attrs[k]; chatRec.unattr.push(k); }
};
global.requestAnimationFrame = function (fn) { rafQueue.push(fn); return rafQueue.length; };
global.getComputedStyle = function () {
  // v0.99.4: the FIELD statics the real :root/[data-theme] blocks carry
  // (midnight) — the derivation chain (culori mixes → triplets → gates)
  // resolves from these when the stub has no readable stylesheets.
  var FIELD_STATIC = {
    '--field-surface': '#14141a', '--field-ink': '#e0e0e8',
    '--field-canvas': '#101016', '--field-accent-1': '#a78bfa',
    '--field-accent-2': '#38bdf8', '--field-accent-3': '#f472b6',
    '--accent-4': '#34d399', '--accent': '#a78bfa'
  };
  return { getPropertyValue: function (n) { return FIELD_STATIC[n] || ''; } };
};
// v0.99.3: culori — the vendored IIFE defines `var culori` at script
// scope; the indirect eval lands it on globalThis so theme.js's
// FieldMath boots live (the same file the browser <script>s).
(0, eval)(require('fs').readFileSync(
  path.join(WEB, 'vendor', 'culori', 'culori.min.js'), 'utf8'));

// ── assertions ──────────────────────────────────────────────────────
var fails = [];
var n = 0;
function ok(name, cond) { n++; if (!cond) fails.push(name); }
function eq(name, got, want) {
  n++;
  if (got !== want) {
    fails.push(name + ' — got ' + JSON.stringify(got) +
      ', want ' + JSON.stringify(want));
  }
}
function has(name, hay, needle) { ok(name, hay.indexOf(needle) >= 0); }
function lacks(name, hay, needle) { ok(name, hay.indexOf(needle) < 0); }

// ══ 3. theme.js — boot runs applyTheme against the stub ─════════════
var T = require(path.join(WEB, 'theme.js'));
eq('theme exports deriveTwins', typeof T.deriveTwins, 'function');
eq('theme exports hexTriplet', typeof T.hexTriplet, 'function');
eq('theme exports gridSpecFor', typeof T.gridSpecFor, 'function');
eq('theme exports foldThemeOverrides', typeof T.foldThemeOverrides, 'function');

// ── v0.99.4 THE FOLD (pure) ─────────────────────────────────────────
var folded = T.foldThemeOverrides({
  '--surface-1': '#111111', '--field-surface': '#222222',
  '--text-1': { colors: ['#feedcc', '#abcdef'], dir: 'v' },
  '--bg-panel': '#131313', '--accent': '#ff00aa',
  '--accent-2': '#00ffcc', '--accent-3': '#abcdef',
  '--bg-app': '#090909', '--surface-2': '#191919',
  '--surface-3': '#262626', '--border': '#2a2a35', '--accent-4': '#34d399'
});
eq('fold surface (field key wins)', folded['--field-surface'], '#222222');
eq('fold ink (legacy gradient → FIRST COLOR, solid-only)', folded['--field-ink'], '#feedcc');
eq('fold canvas', folded['--field-canvas'], '#131313');
eq('fold accent-1', folded['--field-accent-1'], '#ff00aa');
eq('fold accent-2', folded['--field-accent-2'], '#00ffcc');
eq('fold accent-3', folded['--field-accent-3'], '#abcdef');
ok('fold DROPS --bg-app', folded['--bg-app'] === undefined);
ok('fold DROPS --surface-2', folded['--surface-2'] === undefined);
ok('fold DROPS --surface-3', folded['--surface-3'] === undefined);
ok('fold DROPS --border', folded['--border'] === undefined);
ok('fold DROPS --accent-4', folded['--accent-4'] === undefined);

// applyTheme ran at require time (Settings stub present) — the field
// twin writes are already in rec:
eq('applyTheme field solid twin', rec.props['--field-accent-1'], '#ff00aa');
eq('applyTheme field gradient twin', rec.props['--field-accent-1-gradient'],
  'linear-gradient(90deg, #ff00aa, #00ffcc)');
eq('applyTheme ALIAS gradient twin', rec.props['--accent-gradient'],
  'linear-gradient(90deg, #ff00aa, #00ffcc)');
eq('applyTheme rgb triplet from solid', rec.props['--accent-rgb'], '255,0,170');
ok('applyTheme writes NO --accent solid (CSS alias owns it)', rec.props['--accent'] === undefined);
ok('applyTheme DROPS the derived-era --bg-app key', rec.props['--bg-app'] === undefined);
ok('applyTheme drops the --bg-app gradient twin', rec.props['--bg-app-gradient'] === undefined);
// the legacy --text-1 override folded to ink: SOLID ONLY (no window)
eq('applyTheme ink fold (first color)', rec.props['--field-ink'], '#feedcc');
ok('ink NEVER gets a gradient twin', rec.props['--field-ink-gradient'] === undefined);
// the derived triplets (culori parity with the :root color-mix block)
ok('derived triplet --text-3-rgb present', typeof rec.props['--text-3-rgb'] === 'string');
ok('derived triplet --surface-2-rgb present', typeof rec.props['--surface-2-rgb'] === 'string');
ok('derived triplet --bg-app-rgb present', typeof rec.props['--bg-app-rgb'] === 'string');
// the ink override drives the veil/bright gates off the SURFACE (not text)
ok('veil-ink derived', rec.props['--veil-ink'] === '#000000');
// FieldMath — the culori CSS-parity core
ok('fieldMath available', !!(T.fieldMath && T.fieldMath.available));
eq('fieldMath cssMix edge 0', T.fieldMath.cssMix('#14141a', '#e0e0e8', 0), '#14141a');
eq('fieldMath cssMix edge 1', T.fieldMath.cssMix('#14141a', '#e0e0e8', 1), '#e0e0e8');
ok('fieldMath cssMix midpoint is a hex', /^#[0-9a-f]{6}$/.test(T.fieldMath.cssMix('#ffffff', '#000000', 0.5) || ''));
ok('fieldMath luminance sane', (T.fieldMath.luminance('#ffffff') || 0) > 0.9);

// ── deriveTwins: hex-only → 'none', spec → solid+css pair ───────────
eq('twins.hex.solid', T.deriveTwins('#aabbcc').solid, '#aabbcc');
eq('twins.hex.css', T.deriveTwins('#aabbcc').css, '#aabbcc');
eq('twins.hex.grad none', T.deriveTwins('#aabbcc').grad, 'none');
var tw = T.deriveTwins({ colors: ['#aabbcc', '#ccbbaa'], dir: 'h' });
eq('twins.spec.solid', tw.solid, '#aabbcc');
eq('twins.spec.css', tw.css, 'linear-gradient(90deg, #aabbcc, #ccbbaa)');
eq('twins.spec.grad is css', tw.grad, tw.css);
// 1-color + EVERY simple dir → the literal 'none' twin
['auto', 'h', 'v', 'diag', 'diag2', 'radial'].forEach(function (d) {
  eq('twins 1-color ' + d + ' → none', T.deriveTwins({ colors: ['#aabbcc'], dir: d }).grad, 'none');
});
// tex is stripped from theme vars (storage-only)
var twTex = T.deriveTwins({ colors: ['#aabbcc', '#ccbbaa'], dir: 'h', tex: 'data:image/png;base64,Q' });
lacks('twins tex stripped', twTex.css, 'url(');
eq('twins tex grad', twTex.grad, 'linear-gradient(90deg, #aabbcc, #ccbbaa)');
// 1-color PATTERN synthesizes a 2nd stop → a real gradient twin
ok('twins 1-color pat-navy is a gradient', T.deriveTwins({ colors: ['#aabbcc'], dir: 'pat-navy' }).grad !== 'none');
// angle rides through
eq('twins diag angle', T.deriveTwins({ colors: ['#aabbcc', '#ccbbaa'], dir: 'diag', angle: 45 }).css,
  'linear-gradient(45deg, #aabbcc, #ccbbaa)');

// ── the no-uikit fallback (uikit failed to load) ────────────────────
var savedG = global.window.GradientUI;
global.window.GradientUI = undefined;
eq('fallback hex solid', T.deriveTwins('#aabbcc').solid, '#aabbcc');
eq('fallback hex grad', T.deriveTwins('#aabbcc').grad, 'none');
eq('fallback spec solid', T.deriveTwins({ colors: ['#112233', '#445566'], dir: 'h' }).solid, '#112233');
eq('fallback spec grad', T.deriveTwins({ colors: ['#112233', '#445566'], dir: 'h' }).grad, 'none');
global.window.GradientUI = savedG;

// ── hexTriplet — the -rgb derivation math ───────────────────────────
eq('triplet #a78bfa', T.hexTriplet('#a78bfa'), '167,139,250');
eq('triplet #38bdf8', T.hexTriplet('#38bdf8'), '56,189,248');
eq('triplet #ff00aa', T.hexTriplet('#ff00aa'), '255,0,170');
eq('triplet #000000', T.hexTriplet('#000000'), '0,0,0');
eq('triplet 3-digit null', T.hexTriplet('#abc'), null);
eq('triplet garbage null', T.hexTriplet('var(--accent)'), null);
eq('triplet null null', T.hexTriplet(null), null);

// ── gridSpecFor — spec-or-hex resolution ─────────────────────────────
var SP = { colors: ['#111111', '#222222'], dir: 'v' };
ok('gridSpec spec passthrough', T.gridSpecFor(SP, '#0a0a0b', '#0b0912') === SP);
eq('gridSpec custom hex', JSON.stringify(T.gridSpecFor('#abcdef', '#0a0a0b', '#0b0912')),
  JSON.stringify({ colors: ['#abcdef'], dir: 'auto' }));
eq('gridSpec legacy default → theme', JSON.stringify(T.gridSpecFor('#0a0a0b', '#0a0a0b', '#0b0912')),
  JSON.stringify({ colors: ['#0b0912'], dir: 'auto' }));
eq('gridSpec legacy default case-insensitive', JSON.stringify(T.gridSpecFor('#0A0A0B', '#0a0a0b', '#0b0912')),
  JSON.stringify({ colors: ['#0b0912'], dir: 'auto' }));
eq('gridSpec css-var garbage → theme', JSON.stringify(T.gridSpecFor('var(--bg-app)', '#0a0a0b', '#0b0912')),
  JSON.stringify({ colors: ['#0b0912'], dir: 'auto' }));
var ARR = ['#111111', '#222222'];
ok('gridSpec legacy array passthrough', T.gridSpecFor(ARR, '#0a0a0b', '#0b0912') === ARR);

// ── effectiveGridSpecs — the spec view ───────────────────────────────
var gs = T.effectiveGridSpecs({ theme: 'nebula', bg: '#0a0a0b', lineColor: '#131318', dotColor: '#2e2e3a', originColor: '#4a4a5e' });
eq('specs never-customized bg', JSON.stringify(gs.bg), JSON.stringify({ colors: ['#0b0912'], dir: 'auto' }));
eq('specs never-customized line', gs.lineColor.colors[0], '#171225');
var gs2 = T.effectiveGridSpecs({ theme: 'nebula', bg: SP, lineColor: '#abcdef', dotColor: '#2e2e3a', originColor: '#4a4a5e' });
ok('specs spec wins', gs2.bg === SP);
eq('specs custom hex folds', JSON.stringify(gs2.lineColor), JSON.stringify({ colors: ['#abcdef'], dir: 'auto' }));
eq('specs untouched key follows theme', gs2.dotColor.colors[0], '#2e2748');

// ── effectiveGrid — the LEGACY HEX contract is unchanged ─────────────
Object.keys(T.themes).forEach(function (id) {
  var got = T.effectiveGrid({ theme: id, bg: '#0a0a0b', lineColor: '#131318', dotColor: '#2e2e3a', originColor: '#4a4a5e' });
  var want = T.themes[id].grid;
  eq('hex contract ' + id + '.bg', got.bg, want.bg);
  eq('hex contract ' + id + '.line', got.lineColor, want.line);
  eq('hex contract ' + id + '.dot', got.dotColor, want.dot);
  eq('hex contract ' + id + '.origin', got.originColor, want.origin);
});
// solid derivation from specs: first VALID hex; all-invalid → theme
eq('effectiveGrid spec solid', T.effectiveGrid({ theme: 'midnight', bg: SP, lineColor: '#131318', dotColor: '#2e2e3a', originColor: '#4a4a5e' }).bg, '#111111');
eq('effectiveGrid invalid stops skipped',
  T.effectiveGrid({ theme: 'midnight', bg: { colors: ['nope', '#445566'], dir: 'h' }, lineColor: '#131318', dotColor: '#2e2e3a', originColor: '#4a4a5e' }).bg, '#445566');
eq('effectiveGrid all-invalid → theme',
  T.effectiveGrid({ theme: 'midnight', bg: { colors: ['nope', 'also no'], dir: 'h' }, lineColor: '#131318', dotColor: '#2e2e3a', originColor: '#4a4a5e' }).bg, '#0a0a0b');

// ══ 4. formatter.js — boot ran; drive applyScheme directly ══════════
// (the boot chain even exercised theme pairing: DoomTheme.pendingScheme
// → chatScheme 'teal', no overrides)
require(path.join(WEB, 'formatter.js'));
var F = global.window.Formatter;
ok('formatter loaded on the stub window', !!F);
resetRec();
F.applyScheme('teal', null);
eq('fmt preset solid a1', rec.props['--fmt-a1'], '#22d3ee');
eq('fmt preset solid bright', rec.props['--fmt-bright'], '#e8fbff');
['a1', 'a2', 'a3', 'bright', 'link'].forEach(function (k) {
  eq('fmt preset ' + k + ' gradient none', rec.props['--fmt-' + k + '-gradient'], 'none');
});
ok('fmt preset no attr', rec.unattr.indexOf('data-fmt-grad') >= 0);
lacks('fmt preset no ink', Object.keys(rec.props).join(), '-ink');

// a spec override on a1 → twins + ink + the attr list
resetRec();
F.applyScheme('teal', { a1: { colors: ['#22d3ee', '#f472b6'], dir: 'h' } });
eq('fmt spec solid', rec.props['--fmt-a1'], '#22d3ee');
eq('fmt spec gradient', rec.props['--fmt-a1-gradient'], 'linear-gradient(90deg, #22d3ee, #f472b6)');
eq('fmt spec ink transparent', rec.props['--fmt-a1-ink'], 'transparent');
eq('fmt attr single', rec.attrs['data-fmt-grad'], 'a1');
eq('fmt other slots still solid', rec.props['--fmt-link-gradient'], 'none');

// two gradient slots → space-separated list
resetRec();
F.applyScheme('teal', {
  a1: { colors: ['#22d3ee', '#f472b6'], dir: 'v' },
  link: { colors: ['#67e8f9', '#f0abfc'], dir: 'diag2' }
});
eq('fmt attr multi', rec.attrs['data-fmt-grad'], 'a1 link');

// back to solid → attr absent + ink removed (the fresh-user path)
resetRec();
F.applyScheme('teal', { a1: '#22d3ee' });
ok('fmt solid attr removed', rec.unattr.indexOf('data-fmt-grad') >= 0);
eq('fmt solid gradient none', rec.props['--fmt-a1-gradient'], 'none');
ok('fmt solid ink removed', rec.removed.indexOf('--fmt-a1-ink') >= 0);

// tex on a fmt slot is stripped (text-clip can't blend a texture)
resetRec();
F.applyScheme('teal', { a1: { colors: ['#22d3ee', '#f472b6'], dir: 'h', tex: 'data:image/png;base64,Q' } });
lacks('fmt tex stripped', rec.props['--fmt-a1-gradient'], 'url(');

// pattern on 1 color still paints a gradient → tagged in the attr
resetRec();
F.applyScheme('teal', { a3: { colors: ['#38bdf8'], dir: 'pat-navy' } });
eq('fmt 1-color pattern attr', rec.attrs['data-fmt-grad'], 'a3');

// PARITY: formatter's twin derivation ≡ theme's deriveTwins
[{ colors: ['#aabbcc', '#ccbbaa'], dir: 'h' },
 { colors: ['#aabbcc'], dir: 'auto' },
 { colors: ['#aabbcc', '#ccbbaa'], dir: 'swirl' },
 { colors: ['#aabbcc'], dir: 'pat-gingham' },
 { colors: ['#aabbcc', '#ccbbaa'], dir: 'diag', angle: 45 }
].forEach(function (input, i) {
  resetRec();
  F.applyScheme('teal', { a2: input });
  var want = T.deriveTwins(input);
  eq('parity ' + i + ' solid', rec.props['--fmt-a2'], want.solid);
  eq('parity ' + i + ' gradient', rec.props['--fmt-a2-gradient'], want.grad);
});

// ── the canonical derivation on the public surface ──────────────
ok('DoomTheme.deriveTwins exposed', typeof global.window.DoomTheme.deriveTwins === 'function');
eq('DoomTheme.deriveTwins hex → none', global.window.DoomTheme.deriveTwins('#aabbcc').grad, 'none');

// ══ 5. appearance.js — the shared builder + the full page render ════
require(path.join(WEB, 'appearance.js'));
var A = global.window.AppearanceUI;
ok('appearance loaded on the stub window', !!A);
ok('appearance exposes wireFmtEditors', typeof A.wireFmtEditors === 'function');
A.wireFmtEditors({});   // non-DOM root → early return, no throw

// ── v0.98: the LAZY-EXPAND driver (the real user flow, node-side) ──
// v0.98 C3 made the color-row editors LAZY: render() mounts the banner
// + an EMPTY shell; the editor markup only exists after the user clicks
// the row head. The rig therefore expands before asserting editor
// internals — through the module's REAL path: wireColorRows attaches
// the REAL click handler to a stub head, the click runs the REAL
// buildLazyEditor, which invokes the REAL rowEditorBuilders[pfx]
// closure the render registered; that closure writes the REAL
// GradientUI.editor markup into the stub body. The captured markup is
// spliced back into the html exactly where the (now-filled) body shell
// sits — data-lazy-pfx consumed, editor inside: the post-expand DOM
// shape, byte-for-byte what the eager render used to emit.
function stubColorRowDom(pfx) {
  var body = {
    _html: '',
    _built: false,
    getAttribute: function (k) { return (k === 'data-lazy-pfx' && !this._built) ? pfx : null; },
    removeAttribute: function (k) { if (k === 'data-lazy-pfx') this._built = true; },
    querySelector: function () { return null; },   // nothing to re-find in a stub
    closest: function () { return null; }
  };
  Object.defineProperty(body, 'innerHTML', {
    get: function () { return this._html; },
    set: function (h) { this._html = h; }
  });
  var row = {
    classList: {
      _expanded: false,
      contains: function (c) { return c === 'expanded' && this._expanded; },
      toggle: function (c) { if (c === 'expanded') this._expanded = !this._expanded; }
    },
    querySelector: function (sel) { return sel === '[data-color-body]' ? body : null; }
  };
  var clicks = [];
  var head = {
    addEventListener: function (t, fn) { if (t === 'click') clicks.push(fn); },
    getAttribute: function (k) { return k === 'data-color-toggle' ? pfx : null; },
    closest: function (sel) { return sel === '.color-row-collapsed' ? row : null; },
    click: function () {
      clicks.forEach(function (fn) {
        fn({ target: { closest: function () { return null; } } });
      });
    }
  };
  return { head: head, body: body };
}

// expandLazyEditors(html) — expand every lazy row in a rendered html
// string: one wiring pass over a stub root (the real wireColorRows),
// then a click per head; each real buildLazyEditor fills a stub body
// whose captured markup is spliced into the string in place.
function expandLazyEditors(html) {
  var re = /<div class="color-row-body" data-color-body="([^"]+)" data-lazy-pfx="([^"]+)"><\/div>/g;
  var rows = [], m;
  while ((m = re.exec(html))) rows.push({ at: m.index, len: m[0].length, body: m[1], pfx: m[2] });
  if (!rows.length) return html;
  var doms = rows.map(function (r) { return stubColorRowDom(r.pfx); });
  A.wireColorRows({
    querySelectorAll: function (sel) {
      return sel === '[data-color-toggle]' ? doms.map(function (d) { return d.head; }) : [];
    }
  });
  doms.forEach(function (d) { d.head.click(); });
  var out = '', last = 0;
  rows.forEach(function (r, i) {
    out += html.slice(last, r.at) +
      '<div class="color-row-body" data-color-body="' + r.body + '">' + doms[i].body._html + '</div>';
    last = r.at + r.len;
  });
  return out + html.slice(last);
}

// the shared fmt row builder (tweaks.js reuses THIS exact signature)
var row = A.fmtColorRow('a1', 'Accent 1', 'headings', '#22d3ee', false, '');
row = expandLazyEditors(row);   // v0.98: expand the row's lazy editor first
has('fmt row slot hook', row, 'data-fmt-slot="a1"');
lacks('fmt row no scope attr', row, 'data-fmt-scope');
has('fmt row editor id', row, 'id="fmt-a1-gr"');
has('fmt row preview bar', row, 'gr-preview-bar');
lacks('fmt row noTex (no pick)', row, 'data-gr-tex-pick');
has('fmt row has dir pills', row, 'data-gr-dir="swirl"');
lacks('fmt row no legacy color input', row, 'data-setting-key');
lacks('fmt row no hex readout', row, 'data-color-hex');
has('fmt row single swatch value', row, 'value="#22d3ee"');
lacks('fmt row no this-chat marker', row, '· this chat');

var chatRow = A.fmtColorRow('link', 'Links', '', '#67e8f9', true, 'chat');
has('chat row scope attr', chatRow, 'data-fmt-scope="chat"');
has('chat row marker', chatRow, '· this chat');
var specRow = A.fmtColorRow('a1', 'Accent 1', '', { colors: ['#22d3ee', '#f472b6'], dir: 'h' }, false, '');
specRow = expandLazyEditors(specRow);   // v0.98: expand, then count the swatches
ok('spec row renders 2 swatches', (specRow.match(/class="gr-color"/g) || []).length === 2);

// paintChatFmtTwins — the per-chat #chat-root twin paint (chat-scope
// rows registered above feed it: a1 is a spec, link a legacy hex)
A.fmtColorRow('a1', 'Accent 1', '', { colors: ['#22d3ee', '#f472b6'], dir: 'h' }, true, 'chat');
chatRec = { props: {}, attrs: {}, removed: [], unattr: [] };
A.paintChatFmtTwins();
eq('chat twin solid a1', chatRec.props['--fmt-a1'], '#22d3ee');
eq('chat twin gradient a1', chatRec.props['--fmt-a1-gradient'], 'linear-gradient(90deg, #22d3ee, #f472b6)');
eq('chat twin ink a1', chatRec.props['--fmt-a1-ink'], 'transparent');
eq('chat solid link', chatRec.props['--fmt-link'], '#67e8f9');
eq('chat link gradient none', chatRec.props['--fmt-link-gradient'], 'none');
ok('chat solid link ink removed', chatRec.removed.indexOf('--fmt-link-ink') >= 0);
eq('chat attr lists only the gradient slot', chatRec.attrs['data-fmt-grad'], 'a1');
// a back-to-solid re-registration clears the chat attribute
A.fmtColorRow('a1', 'Accent 1', '', '#22d3ee', true, 'chat');
chatRec = { props: {}, attrs: {}, removed: [], unattr: [] };
A.paintChatFmtTwins();
eq('chat solid a1 gradient none', chatRec.props['--fmt-a1-gradient'], 'none');
ok('chat attr cleared when no gradient slots', chatRec.unattr.indexOf('data-fmt-grad') >= 0);

// the full appearance page render — through the REAL registered page
var page = registeredPages.appearance;
ok('appearance page registered', !!page);
resetRec();
var html = page.render(settingsStub.getState, settingsStub.setState);
html = expandLazyEditors(html);   // v0.98: expand ALL color rows before the editor assertions
has('page token wrapper', html, 'data-appr-render="r');
has('page theme editor surface', html, 'id="tv-surface-gr"');
has('page theme editor accent1', html, 'id="tv-accent-1-gr"');
has('page theme editor accent2', html, 'id="tv-accent-2-gr"');
has('page theme editor accent3', html, 'id="tv-accent-3-gr"');
// v0.99.4: the INK row is solid-only — a plain color input, no editor
has('page ink solid input', html, 'id="tv-ink-solid"');
lacks('page ink has NO gradient editor', html, 'id="tv-ink-gr"');
lacks('page NO surface-raised row', html, 'id="tv-surface-2-gr"');
lacks('page NO border row', html, 'id="tv-border-gr"');
lacks('page NO bg-app row', html, 'id="tv-bg-app-gr"');
// the canvas background row (field-keyed, texture-capable, seeded from
// canvasBgSpec); the Grid Colors section carries no own Background row.
has('page canvas field editor (customize)', html, 'id="tv-canvas-gr"');
lacks('page grid NO own bg row', html, 'id="gc-bg-gr"');
has('page grid editor origin', html, 'id="gc-originColor-gr"');
has('page fmt row a1', html, 'data-fmt-slot="a1"');
has('page fmt row link', html, 'data-fmt-slot="link"');
lacks('page NO legacy theme color input', html, 'data-theme-var');
lacks('page NO legacy grid color input', html, 'data-setting-key="bg"');
lacks('page NO legacy fmt color input', html, 'data-custom="fmt"');
lacks('page NO hex readouts', html, 'data-color-hex=');
has('page customized marker (stored override)', html, '· customized');
// the stored --accent spec (folded to --field-accent-1) renders 2 swatches
var accentSeg = html.split('id="tv-accent-1-gr"')[1].split('id="tv-accent-2-gr"')[0];
ok('page accent editor 2 swatches', (accentSeg.match(/class="gr-color"/g) || []).length === 2);

// the scheduled drain fires against the stub document (querySelector →
// null → the safe early-return path) — no throw
var queued = rafQueue.length;
ok('page render scheduled the wiring raf', queued >= 1);
rafQueue.splice(0).forEach(function (fn) { fn(); });
ok('drain ran without a DOM', true);

// a second render bumps the token (re-render safety)
var html2 = page.render(settingsStub.getState, settingsStub.setState);
var tok1 = /data-appr-render="r(\d+)"/.exec(html);
var tok2 = /data-appr-render="r(\d+)"/.exec(html2);
ok('page token bumps', !!(tok1 && tok2 && parseInt(tok2[1], 10) > parseInt(tok1[1], 10)));
rafQueue.splice(0).forEach(function (fn) { fn(); });

// ══ verdict ══════════════════════════════════════════════════════════
if (fails.length) {
  console.log('SELF-TEST FAILED (' + fails.length + ' of ' + n + ' assertions):');
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('SELF-TEST OK (' + n + ' assertions)');
process.exit(0);
