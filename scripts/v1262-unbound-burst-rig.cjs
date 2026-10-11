#!/usr/bin/env node
// v1262-unbound-burst-rig.cjs — v1.26.2 THE UNBOUND BURST (PLAN-V127 §2).
//
// The user's ask: "remove the parralell burst thing, or better yet, set
// the default to unbound and add a frontend tweak-able variable in the
// per chat tweaks screen to set an optional limit… default unbound."
//
// This rig pins the LAW across both sides:
//   · the ENGINE: the compiled 12/min const is DEAD; the cap is the
//     chat's own — termuxExecCapOf reads chat.tweaks.<sid> live
//     (absent/0/negative/garbage → unbound; ≤1000 clamp); the gate
//     takes the cap; the refusal speaks N + the ✦ tweaks path
//   · the ✦ TWEAKS SCREEN: the Termux section (switch + slider + value)
//     between Bot Library and Background; OFF writes NOTHING (the
//     lean-blob law), ON writes execCap; reset-everything clears it;
//     the unbounded default is taught in the hints
//   · the behavior itself (the rolling window, the refusal verdict, the
//     unbound 20-burst) lives in the Go suite — TestV1262_UnboundDefault,
//     TestV1262_CapOfMatrix, TestV1203_Exec_RateCap (the blob-armed pin)

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const tw = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'web', 'tweaks.js'), 'utf8');
const go = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxtool.go'), 'utf8');
const gotest = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxtool_test.go'), 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (!cond) fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
}

// ══ 1. THE ENGINE LAW ═══════════════════════════════════════════════
console.log('the engine: the cap is the chat\'s own, unbound by default');
ok('the compiled 12/min const is DEAD', !/const termuxExecCap/.test(go));
ok('the window var stays (tests shrink it)', /termuxExecWindow = 60 \* time\.Second/.test(go));
ok('termuxExecCapOf reads the chat tweaks blob live',
  /func \(s \*Server\) termuxExecCapOf\(sessionID string\) int/.test(go) &&
  /s\.db\.GetSetting\(chatTweaksKey\(sessionID\)\)/.test(go));
ok('absent / 0 / negative / garbage → unbound (0)',
  /if err != nil \|\| raw == "" \{\n\s*return 0\n\s*\}/.test(go) &&
  /if t\.ExecCap < 0 \{\n\s*return 0\n\s*\}/.test(go) &&
  /if json\.Unmarshal\(\[\]byte\(raw\), &t\) != nil \{\n\s*return 0\n\s*\}/.test(go));
ok('the ≤1000 clamp (a fat-fingered blob can never pin the window log)',
  /if t\.ExecCap > 1000 \{\n\s*return 1000\n\s*\}/.test(go));
ok('the gate takes the chat\'s cap (not a const)',
  /func \(s \*Server\) termuxExecGate\(sessionID string, cap int\) \(capped bool\)/.test(go) &&
  /if len\(kept\) >= cap \{/.test(go));
ok('the gate never runs when the cap is unbound',
  /if cap := s\.termuxExecCapOf\(sessionID\); cap > 0 && s\.termuxExecGate\(sessionID, cap\)/.test(go));
ok('the refusal speaks N + the ✦ tweaks path (the honest teach)',
  /exec rate cap — this chat's burst cap is %d one-shot execs per minute \(armed in ✦ tweaks → Termux\)/.test(go));
ok('the anti-burst comment teaches the new default (unbound)',
  /the compiled 12\/min const is GONE/.test(go));

// ══ 2. THE ✦ TWEAKS SCREEN ══════════════════════════════════════════
console.log('the ✦ tweaks screen: the Termux section');
ok('the Termux section renders between Bot Library and Background',
  /sec\('Bot Library',[\s\S]{0,2600}sec\('Termux',[\s\S]{0,3200}sec\('Background',/.test(tw));
ok('the section teaches the unbound default',
  /Unbound by default \(the bursts still run jailed, blocklisted and streamed\)/.test(tw));
ok('the switch row (the app-switch idiom): #tw-exec-cap-toggle + track + thumb',
  /id="tw-exec-cap-toggle"/.test(tw) && /id="tw-exec-cap-track"/.test(tw) && /id="tw-exec-cap-thumb"/.test(tw));
ok('the slider: #tw-exec-cap-slider, 5..120, /minute value label',
  /id="tw-exec-cap-slider" min="5" max="120"/.test(tw) && /id="tw-exec-cap-val"/.test(tw));
ok('the state value speaks unbound/capped',
  /id="tw-exec-cap-state"[\s\S]{0,80}capArmed \? 'capped' : 'unbound'/.test(tw));
ok('the render derives armed/display from the blob (the typeof-number guard)',
  /var capArmed = typeof t\.execCap === 'number' && t\.execCap > 0;/.test(tw) &&
  /var capSliderVal = Math\.max\(5, Math\.min\(120, capDisplay\)\);/.test(tw));
ok('the wiring re-derives (never render-state-dependent)',
  /var capArmed = typeof \(state\._tweaks && state\._tweaks\.execCap\) === 'number'/.test(tw));
ok('capWrite: armed writes the number, OFF DELETES the key (the lean-blob law)',
  /function capWrite\(armed, v\) \{\n\s*touch\(state\);\n\s*if \(armed\) state\._tweaks\.execCap = v;\n\s*else delete state\._tweaks\.execCap;/.test(tw));
ok('the toggle persists immediately (the change handler calls capWrite)',
  /capPaint\(capArmed, capNow\);\n\s*capWrite\(capArmed, capNow\);/.test(tw));
ok('the slider paints live + persists on release (the mind-slider idiom)',
  /capSlider\.addEventListener\('input'[\s\S]{0,160}capPaint\(true, v\)/.test(tw) &&
  /capSlider\.addEventListener\('change'[\s\S]{0,200}if \(capArmed\) capWrite\(true, capNow\)/.test(tw));
ok('reset-everything clears the burst cap (back to the unbound default)',
  /v1\.26\.2: reset everything includes the exec burst cap[\s\S]{0,120}delete state\._tweaks\.execCap;/.test(tw));
ok('the honest engine-version note (old binaries keep their pacing)',
  /applies once the device runs engine v1\.26\.2\+/.test(tw));
ok('no session-row twin — the blob is the single source (no PATCH lib_auto-style dual-write here)',
  !/lib_auto/.test(tw.slice(tw.indexOf('sec(\'Termux\''), tw.indexOf('sec(\'Background\''))));

// ══ 3. THE GO BEHAVIOR PINS EXIST ═══════════════════════════════════
console.log('the Go suite carries the behavior:');
ok('TestV1262_UnboundDefault (the 20-exec burst runs free)',
  /func TestV1262_UnboundDefault\(t \*testing\.T\)/.test(gotest));
ok('TestV1262_CapOfMatrix (the strict parse matrix)',
  /func TestV1262_CapOfMatrix\(t \*testing\.T\)/.test(gotest));
ok('TestV1203_Exec_RateCap arms the cap via the tweaks blob',
  /SetSetting\(chatTweaksKey\("capwin"\), `\{"execCap":12\}`\)/.test(gotest));
ok('the refusal pin demands the ✦ tweaks teach',
  /strings\.Contains\(out, "✦ tweaks"\)/.test(gotest));

console.log('');
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('v1.26.2 THE UNBOUND BURST rig: ' + n + '/' + n);
