#!/usr/bin/env node
// v1290-maximal-rig.cjs — v1.29.0 THE MAXIMAL HAND (PLAN-V129 §4).
//
// The user's report (the Doobie chatlog, live device): "we have a 60
// second termux timeout. When we shouldn't. Also, we don't have maximal
// termux capabilities as we should."
//
// This rig pins the WAVE across all its surfaces:
//   · §1 THE LONG BUDGET: the engine's exec default 600000 (10 min), the
//     1800000 (30 min) clamp, pkg's 600000, the honest two-truth TIMEOUT
//     text on BOTH paths, the client hard cap 1805s
//   · §2 THE KOTLIN TWIN: DEFAULT_RUN_TIMEOUT_MS 600_000 + MAX 1_800_000
//     (both sides of the bridge match — one budget, no layer refusing
//     the other); THE TAUGHT LAW: the help/manifest/preamble teach the
//     budget ladder + the noexec $HOME law; the stale "12 per minute"
//     help claim is DEAD (it lied since v1.26.2)
//   · §3 THE DEVICE COMMANDS LIGHT: the Kotlin api_installed lookup, the
//     engine Status field + the /status passthrough, the setup ready
//     card's honest live/locked line
//   · the behavior itself (default budget received by the bridge, the
//     clamp, the timeout observation) lives in the Go suite —
//     TestV1203_Exec_Echo (the 600000 default pin), TestV1203_Exec_
//     TimeoutClamp (1800000), TestV1203_Exec_Timeout_Honest (the
//     two-truth text), TestV1283_* (the api_installed passthrough)

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const go = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxtool.go'), 'utf8');
const gorun = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxstreamrun.go'), 'utf8');
const goclient = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'termuxbridge', 'client.go'), 'utf8');
const goapi = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxapi.go'), 'utf8');
const gotest = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxtool_test.go'), 'utf8');
const def = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'mcpbus', 'def.go'), 'utf8');
const ctxgo = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'sessionctx.go'), 'utf8');
const kt = fs.readFileSync(path.join(ROOT, 'platforms', 'android', 'app', 'src', 'main', 'java', 'com', 'doomalay', 'engine', 'TermuxBridge.kt'), 'utf8');
const tsx = fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'web', 'termuxsetup.js'), 'utf8');
const streamRig = fs.readFileSync(path.join(ROOT, 'scripts', 'v1233-live-stream-rig.mjs'), 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (!cond) fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
}

// ══ 1. §1 THE LONG BUDGET — the engine ══════════════════════════════
console.log('§1 the engine: the 60s default is dead, the budget is long');
ok('the exec default is 600000 (10 min)',
  /timeoutMS := 600000/.test(go));
ok('the 30-minute ceiling clamps (1800000)',
  /if timeoutMS > 1800000 \{\n\s*timeoutMS = 1800000\n\s*\}/.test(go));
ok('pkg rides 600000 too (the slow-network toolchain headroom)',
  /pkgCmd, "", 600000\)/.test(go));
ok('the honest two-truth TIMEOUT text (one-shot path)',
  /TIMEOUT — the %ds exec budget ended; the command may still be running in Termux \(pass timeout_ms up to 1800000, or session_start it for unbounded\)/.test(go));
ok('the same text on the STREAMING path (the twins share one law)',
  /TIMEOUT — the %ds exec budget ended; the command may still be running in Termux \(pass timeout_ms up to 1800000, or session_start it for unbounded\)/.test(gorun));
ok('the old "Termux killed the command" lie is dead everywhere',
  !/Termux killed the command/.test(go) && !/Termux killed the command/.test(gorun));
ok('the client hard cap follows the bridge max +5s slack (1805s)',
  /const clientHardCap = 1805 \* time\.Second/.test(goclient));
ok('the old 185s belt is gone', !/185 \* time\.Second/.test(goclient));

// ══ 2. §2 THE KOTLIN TWIN + THE TAUGHT LAW ═════════════════════════
console.log('§2 the Kotlin twin + the taught law');
ok('the Kotlin DEFAULT matches the engine (600_000)',
  /private const val DEFAULT_RUN_TIMEOUT_MS = 600_000L/.test(kt));
ok('the Kotlin MAX matches the engine clamp (1_800_000)',
  /private const val MAX_RUN_TIMEOUT_MS = 1_800_000L/.test(kt));
ok('the Kotlin MIN stays 1s (a sane floor)',
  /private const val MIN_RUN_TIMEOUT_MS = 1_000L/.test(kt));

const help = go.slice(go.indexOf('termuxHelpText'));
ok('the help exec line teaches the ladder (10 min default, 30 min max)',
  /10 min default, 30 min max via timeout_ms; longer jobs → session_start/.test(help));
ok('the help teaches THE EXEC PHYSICS block (the noexec law, zero discovery burns)',
  /THE EXEC PHYSICS \(Android's two real laws, so you never burn calls discovering them\)/.test(help) &&
  /FUSE-mounted noexec — a binary compiled there CANNOT execute/.test(help) &&
  /cp mybin \$HOME\/ && chmod 755 \$HOME\/mybin && \$HOME\/mybin/.test(help));
ok('the stale "12 per minute" help claim is DEAD (it lied since v1.26.2)',
  !/12 per minute/.test(help));
ok('the help pacing line tells the truth (unbound + the optional ✦ arm)',
  /exec pacing is UNBOUND by default; the user can arm an optional per-minute burst cap in ✦ tweaks → Termux/.test(help));
ok('the help names BOTH termux-api pieces (the package + the companion app)',
  /The termux-api package \+ the Termux:API companion app \(F-Droid\) add the device commands/.test(help));

ok('the manifest Desc teaches the budget ladder',
  /exec budget: 10 minutes by default, 30 minutes max \(pass timeout_ms\); anything longer runs as a background session/.test(def));
ok('the manifest Desc teaches the noexec law',
  /Compiled binaries only execute from \$HOME — the bound folders are FUSE noexec/.test(def));

ok('the system preamble teaches the budget + the noexec law',
  /10-minute budget by default, 30 min max via timeout_ms/.test(ctxgo) &&
  /shared storage is FUSE noexec/.test(ctxgo) &&
  /copy it to \$HOME and chmod 755 first/.test(ctxgo));
ok('the preamble "12 per minute" lie is dead too',
  !/12 per minute/.test(ctxgo));

ok('the v1233 stream rig pins the two-truth text',
  /TIMEOUT — the 2s exec budget ended; the command may still be running in Termux/.test(streamRig));

// ══ 3. §3 THE DEVICE COMMANDS LIGHT ═════════════════════════════════
console.log('§3 the device commands light: the unlock, made visible');
ok('the Kotlin bridge looks up the Termux:API companion app',
  /private const val TERMUX_API_PACKAGE = "com\.termux\.api"/.test(kt) &&
  /fun isApiInstalled\(ctx: Context\): Boolean/.test(kt));
ok('the Kotlin /status carries api_installed',
  /o\.put\("api_installed", TermuxBridge\.isApiInstalled\(ctx\)\)/.test(kt));
ok('the engine Status struct decodes api_installed (additive)',
  /APIInstalled\s+bool\s+`json:"api_installed"`/.test(goclient));
ok('the engine /api/termux/status passes it through',
  /"api_installed":\s+apiInstalled/.test(goapi));
ok('the setup ready card speaks the live state',
  /device commands live — battery · wifi ·/.test(tsx));
ok('the setup ready card teaches the device-commands unlock (both pieces)',
  // v1.33.3 (the ownership wave) re-voiced the teach BY DESIGN: the
  // error-weighted "locked" died; the companion-app law stays.
  /Termux:API companion app/.test(tsx) && /pkg install termux-api/.test(tsx));
ok('the ready card line rides the legal surfaces only (the theme-vars law)',
  /\.tsx-ready-api\{[^}]*var\(--surface-1\)[^}]*var\(--surface-2\)/.test(tsx));

// ══ 4. THE GO BEHAVIOR PINS EXIST ═══════════════════════════════════
console.log('the Go behavior pins ride the suite');
ok('the 600000 default pin (TestV1203_Exec_Echo)',
  /if lastTimeout != 600000 \{/.test(gotest));
ok('the 1800000 clamp pin (TestV1203_Exec_TimeoutClamp)',
  /if lastTimeout != 1800000 \{/.test(gotest));
ok('the two-truth TIMEOUT pin (TestV1203_Exec_Timeout_Honest)',
  /TIMEOUT — the 1s exec budget ended; the command may still be running in Termux/.test(gotest));
ok('the api_installed passthrough pins exist (termuxapi_test.go)',
  fs.readFileSync(path.join(ROOT, 'engine', 'internal', 'server', 'termuxapi_test.go'), 'utf8')
    .includes('func TestV1283_TermuxStatus_ApiInstalledPassthrough'));

// ══ the verdict ═════════════════════════════════════════════════════
console.log('');
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('PASS ' + n + '/' + n + ' — the maximal hand is pinned');
