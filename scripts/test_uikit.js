#!/usr/bin/env node
// test_uikit.js — node-side verification of the uikit.js v0.44
// contract (GradientUI v2 + the pure helpers). Loads the file through
// the module.exports path (no DOM) and asserts:
//   · every dir recipe string shape (incl. swirl wrap stop, mesh 4
//     radials + base, all 5 patterns, checker tile suffix)
//   · tex layering (css ends with url("data:…"))
//   · 1-color passthrough (bare hex) for auto/h/v/diag/diag2/radial
//   · 1-color pattern synthesis (navy gets a 2nd stop)
//   · backward compat ('#abc', ['#a','#b'], {colors:[…]})
//   · norm() fallbacks on garbage, solid()/twins() shape,
//     random() bounds, darken/lighten clamp, angle default 135,
//     MAX=15, editor markup hooks, the wire contract surface
// plus GradientUI._selftest() itself.
// Prints 'SELF-TEST OK' + exit 0 on success; failures + exit 1.

'use strict';

var path = require('path');
var uikit = require(path.join(__dirname, '..', 'engine', 'internal', 'server', 'web', 'uikit.js'));
var G = uikit.GradientUI;
var darken = uikit.darken;
var lighten = uikit.lighten;
var rgba = uikit.rgba;
var hexToRgb = uikit.hexToRgb;

var fails = [];
var n = 0;
function ok(name, cond) {
  n++;
  if (!cond) fails.push(name);
}
function eq(name, got, want) {
  n++;
  if (got !== want) {
    fails.push(name + ' — got ' + JSON.stringify(got) +
      ', want ' + JSON.stringify(want));
  }
}
function has(name, hay, needle) { ok(name, hay.indexOf(needle) >= 0); }
function lacks(name, hay, needle) { ok(name, hay.indexOf(needle) < 0); }

var A = '#aabbcc', B = '#ccbbaa', C = '#123456';
var TEX = 'data:image/jpeg;base64,ZZ==';

// ── backward compat + norm ─────────────────────────────────────────
eq('compat bare hex', G.css(A), A);
eq('compat array', G.css(['#a', '#b']), 'linear-gradient(135deg, #a, #b)');
eq('compat object no dir', G.css({ colors: ['#a', '#b'] }), 'linear-gradient(135deg, #a, #b)');
eq('compat #abc', G.css('#abc'), '#abc');

eq('norm null', G.norm(null).colors.join(), '#38bdf8,#a78bfa');
eq('norm undefined', G.norm(undefined).colors.join(), '#38bdf8,#a78bfa');
eq('norm {}', G.norm({}).colors.join(), '#38bdf8,#a78bfa');
eq('norm colors:[]', G.norm({ colors: [] }).colors.join(), '#38bdf8,#a78bfa');
eq('norm colors garbage', G.norm({ colors: 'nope' }).colors.join(), '#38bdf8,#a78bfa');
eq('norm bare string', G.norm(A).colors.join(), A);
eq('norm array', G.norm(['#a', '#b']).colors.join(), '#a,#b');
eq('norm bad dir', G.norm({ colors: ['#a'], dir: 'zzz' }).dir, 'auto');
eq('norm good dir', G.norm({ colors: ['#a'], dir: 'swirl' }).dir, 'swirl');
eq('norm caps at 15', G.norm({
  colors: (function () { var a = []; for (var i = 0; i < 20; i++) a.push('#000000'); return a; })()
}).colors.length, 15);
eq('norm drops non-strings', G.norm({ colors: ['#a', 7, null, '#b'] }).colors.join(), '#a,#b');
eq('norm angle 45', G.norm({ colors: ['#a'], dir: 'diag', angle: 45 }).angle, 45);
eq('norm angle clamp', G.norm({ colors: ['#a'], angle: 999 }).angle, 360);
eq('norm angle 0 kept', G.norm({ colors: ['#a'], angle: 0 }).angle, 0);
ok('norm angle dropped', G.norm({ colors: ['#a'], angle: 'x' }).angle === undefined);
eq('norm tex kept', G.norm({ colors: ['#a'], tex: TEX }).tex, TEX);
ok('norm tex dropped', G.norm({ colors: ['#a'], tex: 5 }).tex === undefined);

// ── recipes ────────────────────────────────────────────────────────
eq('css 1-color auto', G.css({ colors: [A], dir: 'auto' }), A);
eq('css 1-color h', G.css({ colors: [A], dir: 'h' }), A);
eq('css 1-color v', G.css({ colors: [A], dir: 'v' }), A);
eq('css 1-color diag', G.css({ colors: [A], dir: 'diag' }), A);
eq('css 1-color diag2', G.css({ colors: [A], dir: 'diag2' }), A);
eq('css 1-color radial', G.css({ colors: [A], dir: 'radial' }), A);

eq('css auto', G.css({ colors: [A, B], dir: 'auto' }), 'linear-gradient(135deg, ' + A + ', ' + B + ')');
eq('css h', G.css({ colors: [A, B], dir: 'h' }), 'linear-gradient(90deg, ' + A + ', ' + B + ')');
eq('css v', G.css({ colors: [A, B], dir: 'v' }), 'linear-gradient(180deg, ' + A + ', ' + B + ')');
eq('css diag default 135', G.css({ colors: [A, B], dir: 'diag' }), 'linear-gradient(135deg, ' + A + ', ' + B + ')');
eq('css diag angle 45', G.css({ colors: [A, B], dir: 'diag', angle: 45 }), 'linear-gradient(45deg, ' + A + ', ' + B + ')');
eq('css diag angle 0', G.css({ colors: [A, B], dir: 'diag', angle: 0 }), 'linear-gradient(0deg, ' + A + ', ' + B + ')');
eq('css diag2', G.css({ colors: [A, B], dir: 'diag2' }), 'linear-gradient(315deg, ' + A + ', ' + B + ')');
eq('css radial', G.css({ colors: [A, B], dir: 'radial' }), 'radial-gradient(circle at 50% 35%, ' + A + ', ' + B + ')');

// swirl — the closing stop wraps the sweep back to the first color
eq('css swirl 2', G.css({ colors: [A, B], dir: 'swirl' }),
  'conic-gradient(from 240deg at 55% 45%, ' + A + ', ' + B + ', ' + A + ')');
eq('css swirl 1 synthesizes', G.css({ colors: [A], dir: 'swirl' }),
  'conic-gradient(from 240deg at 55% 45%, ' + A + ', ' + lighten(A, 25) + ', ' + A + ')');

// mesh — 4 radials cycling the palette + the base linear
var mesh = G.css({ colors: [A, B], dir: 'mesh' });
eq('css mesh exact', mesh,
  'radial-gradient(at 20% 25%, ' + A + ' 0px, transparent 55%), ' +
  'radial-gradient(at 80% 15%, ' + B + ' 0px, transparent 50%), ' +
  'radial-gradient(at 75% 80%, ' + A + ' 0px, transparent 55%), ' +
  'radial-gradient(at 15% 85%, ' + B + ' 0px, transparent 50%), ' +
  'linear-gradient(' + B + ')');
ok('mesh has 4 radials', (mesh.match(/radial-gradient\(/g) || []).length === 4);
ok('mesh ends with base linear', /linear-gradient\(#[0-9a-f]{6}\)$/.test(mesh));
eq('css mesh 1-color base', G.css({ colors: [A], dir: 'mesh' }).slice(-('linear-gradient(' + darken(A, 20) + ')').length),
  'linear-gradient(' + darken(A, 20) + ')');

// patterns
eq('css pat-navy 2', G.css({ colors: [A, B], dir: 'pat-navy' }),
  'repeating-linear-gradient(45deg, ' + A + ' 0 14px, ' + B + ' 14px 28px)');
var navy1 = G.css({ colors: [A], dir: 'pat-navy' });
eq('css pat-navy 1 synth', navy1,
  'repeating-linear-gradient(45deg, ' + A + ' 0 14px, ' + darken(A, 18) + ' 14px 28px)');
ok('pat-navy 1 has 2 stops', navy1.split(' ').indexOf(darken(A, 18)) >= 0 && darken(A, 18) !== A);

eq('css pat-pinstripe 2', G.css({ colors: [A, B], dir: 'pat-pinstripe' }),
  'repeating-linear-gradient(90deg, transparent 0 18px, rgba(170,187,204,.35) 18px 19px), ' +
  'linear-gradient(160deg, ' + A + ', ' + B + ')');
has('css pat-pinstripe 1 synth', G.css({ colors: [A], dir: 'pat-pinstripe' }),
  'linear-gradient(160deg, ' + A + ', ' + lighten(A, 18) + ')');

eq('css pat-gingham 3', G.css({ colors: [A, B, C], dir: 'pat-gingham' }),
  'repeating-linear-gradient(0deg, rgba(170,187,204,.55) 0 40px, transparent 40px 80px), ' +
  'repeating-linear-gradient(90deg, rgba(204,187,170,.35) 0 40px, transparent 40px 80px), ' +
  'linear-gradient(' + C + ')');
has('css pat-gingham 1 base synth', G.css({ colors: [A], dir: 'pat-gingham' }),
  'linear-gradient(' + lighten(A, 30) + ')');

eq('css pat-sunburst 2', G.css({ colors: [A, B], dir: 'pat-sunburst' }),
  'repeating-conic-gradient(from 0deg at 50% 100%, ' + A + ' 0deg 15deg, ' + B + ' 15deg 30deg)');
has('css pat-sunburst 1 synth', G.css({ colors: [A], dir: 'pat-sunburst' }),
  'repeating-conic-gradient(from 0deg at 50% 100%, ' + A + ' 0deg 15deg, ' + lighten(A, 18) + ' 15deg 30deg)');

// v0.49: the checker is a self-tiling SVG data-URL (the old `0 0 / 32px
// 32px` suffix is invalid inside background-image — the reported bug)
var checker = G.css({ colors: [A, B], dir: 'pat-checker' });
has('css pat-checker svg tile', checker, 'data:image/svg+xml');
has('css pat-checker base fill', checker, encodeURIComponent('fill="' + A + '"'));
has('css pat-checker alt fill', checker, encodeURIComponent('fill="' + B + '"'));
ok('checker no shorthand suffix', checker.indexOf(' 0 0 / ') < 0);
has('css pat-checker 1 synth', G.css({ colors: [A], dir: 'pat-checker' }),
  encodeURIComponent('fill="' + darken(A, 18) + '"'));

// ── texture layering ───────────────────────────────────────────────
var texed = G.css({ colors: [A, B], dir: 'auto', tex: TEX });
eq('css tex exact', texed, 'linear-gradient(135deg, ' + A + ', ' + B + "), url('" + TEX + "')");
ok('css tex ends with url()', texed.slice(-(("url('" + TEX + "')").length)) === "url('" + TEX + "')");
eq('css tex 1-color flat layer', G.css({ colors: [A], dir: 'v', tex: TEX }),
  'linear-gradient(180deg, ' + A + ', ' + A + "), url('" + TEX + "')");
has('css tex pattern dir keeps recipe', G.css({ colors: [A], dir: 'pat-navy', tex: TEX }), "url('" + TEX + "')");

// ── solid / twins ──────────────────────────────────────────────────
eq('solid first color', G.solid(['#112233', '#445566']), '#112233');
eq('solid bare hex', G.solid('#ff0000'), '#ff0000');
eq('solid fallback', G.solid(null), '#38bdf8');
eq('solid pattern', G.solid({ colors: ['#abc'], dir: 'pat-checker' }), '#abc');
var tw = G.twins({ colors: [A, B], dir: 'h' });
ok('twins shape', tw && typeof tw.solid === 'string' && typeof tw.css === 'string');
eq('twins solid', tw.solid, A);
eq('twins css', tw.css, 'linear-gradient(90deg, ' + A + ', ' + B + ')');
var tw2 = G.twins(A);
ok('twins bare', tw2.solid === A && tw2.css === A);

// ── random / helpers / constants ───────────────────────────────────
eq('random n=3', G.random(3).length, 3);
ok('random hex format', G.random(5).every(function (x) { return /^#[0-9a-f]{6}$/.test(x); }));
eq('random n=1', G.random(1).length, 1);
eq('random cap 15', G.random(99).length, 15);
(function () {
  var good = true;
  for (var i = 0; i < 80; i++) {
    var len = G.random().length;
    if (len < 2 || len > 15) { good = false; break; }
  }
  ok('random omitted is 2..15', good);
})();

eq('MAX is 15', G.MAX, 15);
eq('BLENDED flag', G.BLENDED, true);

eq('darken gray', darken('#ffffff', 50), '#808080');
eq('lighten gray', lighten('#000000', 50), '#808080');
eq('darken clamps to black', darken('#ffffff', 150), '#000000');
eq('lighten clamps to white', lighten('#000000', 150), '#ffffff');
eq('darken garbage passthrough', darken('#a', 20), '#a');
eq('rgba format', rgba('#38bdf8', 0.35), 'rgba(56,189,248,.35)');
var hr = hexToRgb('#38bdf8');
ok('hexToRgb 6-digit', hr && hr.r === 56 && hr.g === 189 && hr.b === 248);
var h3 = hexToRgb('#abc');
ok('hexToRgb 3-digit', h3 && h3.r === 170 && h3.g === 187 && h3.b === 204);
ok('hexToRgb invalid', hexToRgb('zz') === null);

// ── editor markup (esc is pure → node-safe) ────────────────────────
var spec = { colors: [A, B], dir: 'swirl', tex: TEX };
var m = G.editor('x', spec);
has('editor preview bar', m, 'gr-preview-bar');
has('editor preview styled', m, 'background-image:conic-gradient');
has('editor count N / 15', m, '2 / 15');
['auto', 'h', 'v', 'diag', 'diag2', 'radial', 'swirl', 'mesh'].forEach(function (d) {
  has('editor style pill ' + d, m, 'data-gr-dir="' + d + '"');
});
['pat-navy', 'pat-pinstripe', 'pat-gingham', 'pat-sunburst', 'pat-checker'].forEach(function (d) {
  has('editor pattern pill ' + d, m, 'data-gr-dir="' + d + '"');
});
has('editor pattern row label', m, '>patterns<');
has('editor selected dir data-on', m, 'data-gr-dir="swirl" data-on="1"');
lacks('editor unselected auto', m, 'data-gr-dir="auto" data-on="1"');
has('editor texture pick', m, 'data-gr-tex-pick');
has('editor texture file', m, 'data-gr-tex-file');
has('editor texture thumb', m, 'data-gr-tex-thumb');
has('editor texture remove', m, 'data-gr-tex-rm');
has('editor swatch input', m, 'class="gr-color" data-gr="0"');
has('editor add button', m, 'data-gr-add="1"');
has('editor shuffle button', m, 'data-gr-shuffle="1"');
has('editor random button', m, 'data-gr-random="1"');

var mNoTex = G.editor('x', spec, { noTex: true });
lacks('noTex hides pick', mNoTex, 'data-gr-tex-pick');
lacks('noTex hides file', mNoTex, 'data-gr-tex-file');
lacks('noTex hides remove', mNoTex, 'data-gr-tex-rm');

var mNoDir = G.editor('x', spec, { noDir: true });
lacks('noDir hides style rows', mNoDir, 'data-gr-dir');
lacks('noDir hides pattern label', mNoDir, '>patterns<');
has('noDir keeps texture', mNoDir, 'data-gr-tex-pick');

var mDiag = G.editor('x', { colors: ['#a', '#b'], dir: 'diag', angle: 45 });
has('angle slider renders', mDiag, 'data-gr-angle="1"');
has('angle value 45', mDiag, '>45°<');
has('angle label', mDiag, '>angle<');
var mDiagDef = G.editor('x', { colors: ['#a', '#b'], dir: 'diag' });
has('angle default 135', mDiagDef, 'value="135"');
var mAuto = G.editor('x', { colors: ['#a', '#b'], dir: 'auto' });
lacks('no angle for auto', mAuto, 'data-gr-angle="1"');

var mPat = G.editor('x', { colors: ['#a', '#b'], dir: 'pat-navy' });
has('pattern selected data-on', mPat, 'data-gr-dir="pat-navy" data-on="1"');
lacks('style row not selected', mPat, 'data-gr-dir="auto" data-on="1"');

var mNoTexNoTex = G.editor('x', { colors: [A, B], dir: 'auto' });
lacks('no texture controls without tex', mNoTexNoTex, 'data-gr-tex-rm');
lacks('no thumb without tex', mNoTexNoTex, 'data-gr-tex-thumb');
has('texture pick always offered', mNoTexNoTex, 'data-gr-tex-pick');

// ── wire contract surface ──────────────────────────────────────────
['norm', 'css', 'solid', 'twins', 'editor', 'wire', 'random',
  'textureFromFile', '_selftest'].forEach(function (fn) {
  ok('API ' + fn + ' is a function', typeof G[fn] === 'function');
});
ok('MAX constant', G.MAX === 15);
ok('BLENDED constant', G.BLENDED === true);

// wire accepts both shapes (spec object honored; legacy colors array
// wrapped as {colors, dir:auto, _legacy:true} and kept by reference)
(function () {
  var legacy = ['#a', '#b'];
  var callCount = { live: 0, rebuild: 0 };
  // el is a duck: querySelector/querySelectorAll return nothing, so
  // wire only exercises the spec-flooring path — good enough to prove
  // the contract fields + in-place array handling never throw.
  var el = {
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };
  G.wire(el, { colors: legacy, live: function () { callCount.live++; }, rebuild: function () { callCount.rebuild++; } });
  ok('wire legacy floors colors in place', legacy.length >= 1);
  var specObj = { colors: [], dir: 'auto' };
  G.wire(el, { spec: specObj });
  ok('wire spec floors empty colors', specObj.colors.join() === '#38bdf8,#a78bfa');
  G.wire(el, {});
  // no throw, no return value — contract holds
})();

// ── the module's own selftest ─────────────────────────────────────
var self = G._selftest();
ok('_selftest reports ok', self && self.ok === true);
if (self && self.failures && self.failures.length) {
  self.failures.forEach(function (f) { console.log('  selftest ✗ ' + f); });
}

// ── verdict ────────────────────────────────────────────────────────
if (fails.length) {
  console.log('SELF-TEST FAILED (' + fails.length + ' of ' + n + ' assertions):');
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('SELF-TEST OK (' + n + ' assertions)');
process.exit(0);
