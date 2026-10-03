#!/usr/bin/env node
// test_dsml_v0954.js — v0.95.4 THE DSML FILTER pins (both languages' shapes).
// The live bug: deepseek-family markup streamed into the VISIBLE transcript
// while the calls inside never executed. These pins drive the JS helpers
// exactly as pmsdk.js uses them (the Go twin is pinned in dsml_v0954_test.go).

var fs = require('fs');
var path = require('path');
var src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'internal', 'server', 'web', 'vendor', 'pm', 'pmsdk.js'), 'utf8');
eval(src.match(/function dsmlClean[\s\S]*?\n}/)[0]);
eval(src.match(/function convertDSMLToActions[\s\S]*?\n\nfunction /)[0].replace(/\nfunction $/, ''));

var pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label); }
}

console.log('v0.95.4 DSML helper pins (JS):');

// deepseek's canonical closers (slash INSIDE the tag block)
var canon = 'Let me compute.<｜DSML｜calls>\n' +
  '<｜DSML｜invoke name="calculator">\n' +
  '<｜DSML｜parameter name="expression">2+2*10<｜DSML｜/parameter>\n' +
  '<｜DSML｜/invoke>\n' +
  '<｜DSML｜/calls>\nDone.';
var r1 = convertDSMLToActions(canon);
ok(!r1.includes('DSML'), 'canonical: no markup survives');
ok(/ACTION: calculator \{"expression":"2\+2\*10"\}/.test(r1), 'canonical: the call converts to an ACTION line');
ok(r1.includes('Let me compute.') && r1.includes('Done.'), 'canonical: visible prose survives');

// the HTML-style closers (slash outside — models aren't consistent)
var html = 'x<｜DSML｜calls><｜DSML｜invoke name="hash"><｜DSML｜parameter name="text">abc</｜DSML｜parameter></｜DSML｜invoke><｜DSML｜/calls>y';
var r2 = convertDSMLToActions(html);
ok(!r2.includes('DSML'), 'html-style: no markup survives');
ok(/ACTION: hash /.test(r2), 'html-style: the call converts');

// an UNTERMINATED block (stream cut mid-call) — visible stream strips the tail
var cut = 'abc<｜DSML｜calls><｜DSML｜invoke name="file_write"><｜DSML｜parameter name="content">half of a fil';
ok(dsmlClean(cut) === 'abc', 'unterminated: the visible stream strips the partial block tail');

// clean text passes through byte-identical (fast path)
ok(convertDSMLToActions('hello world') === 'hello world', 'clean text passes through');
ok(dsmlClean('plain <tagless> text') === 'plain <tagless> text', 'plain angle brackets untouched');

// multiple invokes in one block → multiple ACTION lines
var multi = '<｜DSML｜calls>' +
  '<｜DSML｜invoke name="calculator"><｜DSML｜parameter name="expression">1+1<｜DSML｜/parameter><｜DSML｜/invoke>' +
  '<｜DSML｜invoke name="time_now"><｜DSML｜parameter name="tz">UTC<｜DSML｜/parameter><｜DSML｜/invoke>' +
  '<｜DSML｜/calls>';
var r3 = convertDSMLToActions(multi);
ok((r3.match(/ACTION: /g) || []).length === 2, 'multiple invokes → multiple ACTION lines');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
