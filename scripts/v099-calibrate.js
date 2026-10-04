#!/usr/bin/env node
// v099-calibrate.js — THE FIELD derivation calibration (v0.99.4 prep).
//
// THE FIELD model replaces the per-theme hand-tuned surface/border/text
// ramps with ONE derivation: color-mix(in oklch, <field-a>, <field-b> X%)
// in the :root block. This script reads the 10 [data-theme] blocks'
// CURRENT values out of index.html and computes, per derived variable,
// the mix percentage that best fits ALL themes at once (least-squares in
// OKLab, then rounded to a whole percent) — so the shipped derivation is
// measured against the looks the user already approved, not guessed.
//
// Outputs: the percentage table (stdout) — pasted into the :root FIELD
// block of index.html + mirrored into theme.js's JS derivation table.
//
// Usage: node scripts/v099-calibrate.js

'use strict';
var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

// culori: the vendored IIFE defines `var culori` at script scope —
// indirect eval puts it on globalThis (the same file the browser loads).
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');
(0, eval)(fs.readFileSync(path.join(WEB, 'vendor', 'culori', 'culori.min.js'), 'utf8'));
var C = globalThis.culori;
if (!C) { console.error('culori failed to load'); process.exit(1); }

// THE OLD TREE — the pre-v0.99 statics this calibration fits against
// (the hand-tuned looks the user approved). Read from git so the tool
// stays the honest record after the tree carries fields.
var html = execSync('git show v0.98.0-the-finish-wave:engine/internal/server/web/index.html').toString();

// ── parse the :root + [data-theme] blocks ──────────────────────────
function parseBlock(src) {
  var out = {};
  var re = /(--[\w-]+)\s*:\s*([^;]+);/g, m;
  while ((m = re.exec(src))) out[m[1]] = m[2].trim();
  return out;
}
function themeBlocks() {
  var blocks = {};
  // :root (midnight)
  var root = /:root\s*\{([\s\S]*?)\}/.exec(html);
  if (root) blocks.midnight = parseBlock(root[1]);
  // MERGE per-var (the cascade's semantics): later one-liner blocks
  // (the --bg-app-rgb statics near L5387) extend, not replace.
  var re = /\[data-theme="([\w-]+)"\]\s*\{([\s\S]*?)\}/g, m;
  while ((m = re.exec(html))) {
    var id = m[1], vals = parseBlock(m[2]);
    if (!blocks[id]) blocks[id] = {};
    for (var k in vals) blocks[id][k] = vals[k];
  }
  return blocks;
}
var blocks = themeBlocks();
var ids = Object.keys(blocks);

// ── oklab distance (perceptual; matches how the eye reads a ramp) ──
function lab(hex) { return C.oklab(C.parse(hex)); }
function dist2(a, b) {
  var A = lab(a), B = lab(b);
  return (A.l - B.l) ** 2 + (A.a - B.a) ** 2 + (A.b - B.b) ** 2;
}
function cssMix(a, b, t) {
  if (!a || !b) return null;
  return C.formatHex(C.interpolate([a, b], 'oklch')(t));
}

// bestT: the percentage minimizing total squared oklab distance across
// all themes for mix(aField, bField, t) ≈ target.
function bestT(fieldOf, run) {
  var best = { t: 0, err: Infinity, per: [] };
  for (var t = 0; t <= 100; t += 0.5) {
    var err = 0, per = [];
    ids.forEach(function (id) {
      var b = blocks[id];
      var a = fieldOf(b), c = run(b);
      if (!a || !c) return;
      var mixed = cssMix(a[0], a[1], t / 100);
      var d = dist2(mixed, c);
      err += d; per.push({ id: id, d: Math.sqrt(d) });
    });
    if (err < best.err) best = { t: t, err: err, per: per };
  }
  return best;
}

// THE FIELD inputs per theme block (current values):
//   surface = --surface-1, ink = --text-1, canvas = --bg-panel
function S(b) { return [b['--surface-1'], b['--text-1']]; }
var rows = [
  ['--surface-2',   function (b) { return S(b); }, function (b) { return b['--surface-2']; }],
  ['--surface-3',   function (b) { return S(b); }, function (b) { return b['--surface-3']; }],
  ['--raised-chrome',function (b) { return S(b); }, function (b) { return b['--surface-2']; }],
  ['--border',      function (b) { return S(b); }, function (b) { return b['--border']; }],
  ['--border-strong', function (b) { return S(b); }, function (b) { return b['--border-strong']; }],
  ['--raised-ring', function (b) { return S(b); }, function (b) { return b['--border']; }],
  ['--text-2',      function (b) { return [b['--text-1'], b['--surface-1']]; }, function (b) { return b['--text-2']; }],
  ['--text-3',      function (b) { return [b['--text-1'], b['--surface-1']]; }, function (b) { return b['--text-3']; }],
  ['--text-3-dim',  function (b) { return [b['--text-1'], b['--surface-1']]; }, function (b) { return b['--text-3-dim']; }],
  // bg-app: mix(canvas, surface, t) — overlays sit between the world and the plate
  ['--bg-app',      function (b) { return [b['--bg-panel'], b['--surface-1']]; }, function (b) { return b['--bg-app']; }]
];

console.log('THE FIELD CALIBRATION — best-fit color-mix percentages across ' + ids.length + ' themes');
console.log('(a,b)=the two FIELD inputs; t = the winning whole %; dE = mean oklab distance per theme at t)\n');
rows.forEach(function (row) {
  var r = bestT(row[1], row[2]);
  var mean = r.per.length ? (r.per.reduce(function (s, p) { return s + p.d; }, 0) / r.per.length) : 0;
  var worst = r.per.reduce(function (w, p) { return Math.max(w, p.d); }, 0);
  console.log(
    row[0].padEnd(16) + ' t=' + String(r.t).padStart(4) + '%   meanΔ=' +
    mean.toFixed(4) + '  worstΔ=' + worst.toFixed(4) +
    '   [' + r.per.map(function (p) { return p.id + ':' + p.d.toFixed(3); }).join(' ') + ']'
  );
});

// sanity: the edge passthroughs + a known CSS parity spot-check
console.log('\nparity spot-checks (JS cssMix vs CSS color-mix expectations):');
console.log('  cssMix(#ffffff, #000000, 0.5) =', cssMix('#ffffff', '#000000', 0.5));
console.log('  cssMix(#a78bfa, #f472b6, 0.25) =', cssMix('#a78bfa', '#f472b6', 0.25));
console.log('  cssMix(#14141a, #e0e0e8, 0) =', cssMix('#14141a', '#e0e0e8', 0));
console.log('  cssMix(#14141a, #e0e0e8, 1) =', cssMix('#14141a', '#e0e0e8', 1));
