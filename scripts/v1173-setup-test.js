#!/usr/bin/env node
// v1173-setup-test.js — v1.17.3 THE SETUP pins (node-side).
//
// THE SETUP: termux/setup.sh (the curl bootstrap — lives in git, fetched
// by curl, NOT in the APK) + the setup overlay page (termuxsetup.js —
// the three-tap ladder on the ConnectOverlay, live-polled against the
// two v1.17.2 endpoints) + the capability-library row rewire (the unready
// ⌨ Termux row opens the setup page instead of toasting).
//
// This rig pins the source contracts (setup.sh's non-fatal shape, the
// script wiring, the rewire, the theme-var law, the no-leak teardown)
// and exercises the pure behavior the DOM is too heavy to fake here
// (_stepStates — the step-state ladder computation, unit-tested across
// the full status ladder: empty → installed → +bridge → +permission →
// +storage/ready, plus the diagnostic mappings).
'use strict';

var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var WEB = path.join(ROOT, 'engine', 'internal', 'server', 'web');
var SETUP_SH = path.join(ROOT, 'termux', 'setup.sh');

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}
function src(file) { return fs.readFileSync(file, 'utf8'); }

var ONE_LINER = 'curl -fsSL https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh | bash';

// ── 1. SOURCE PINS: termux/setup.sh — the curl bootstrap ──────────────
console.log('v1.17.3 THE SETUP pins — setup.sh:');
(function () {
  ok(fs.existsSync(SETUP_SH), 'termux/setup.sh exists at the repo root (git, not the APK)');

  var sh = src(SETUP_SH);

  // bash -n: the script parses as real bash (Termux's shebang header)
  var res = cp.spawnSync('bash', ['-n', SETUP_SH], { encoding: 'utf8' });
  ok(res.status === 0, 'setup.sh passes bash -n', res.stderr);

  // the Termux shebang header comment (the repo's install-android idiom)
  ok(sh.indexOf('#!/data/data/com.termux/files/usr/bin/bash') === 0, 'setup.sh carries the Termux shebang header');

  // NON-FATAL BY DESIGN: set -u, NEVER set -e (comment lines stripped —
  // the header DOCUMENTS the no-errexit law, the code must live it)
  var shCode = sh.split('\n').filter(function (l) { return l.trim().indexOf('#') !== 0; }).join('\n');
  ok(/\bset -u\b/.test(sh), 'setup.sh sets set -u (undefined vars are errors)');
  ok(!/\bset -e\b/.test(shCode) && !/\bset -o errexit\b/.test(shCode),
    'setup.sh has NO set -e (a failed optional step must not kill the run)');

  // step a: the allow-external-apps guard (append ONLY if not present)
  ok(sh.indexOf('allow-external-apps = true') >= 0, 'setup.sh writes allow-external-apps = true');
  ok(/grep -Eq[^\n]*allow-external-apps/.test(sh), 'setup.sh guards the append with a grep (idempotent — never duplicated)');
  ok(sh.indexOf('mkdir -p "$HOME/.termux"') >= 0, 'setup.sh creates ~/.termux before writing properties');
  ok(sh.indexOf('termux-reload-settings') >= 0, 'setup.sh reloads the settings after the write');
  ok(sh.indexOf('close + reopen Termux') >= 0, 'setup.sh honestly tells how to recover a failed reload');

  // step b: termux-setup-storage — the warning echo comes BEFORE it
  ok(sh.indexOf('termux-setup-storage') >= 0, 'setup.sh runs termux-setup-storage (interactive)');
  ok(sh.indexOf('A DIALOG WILL APPEAR') >= 0 &&
     sh.indexOf('A DIALOG WILL APPEAR') < sh.indexOf('termux-setup-storage;'),
    'setup.sh warns about the All-Files dialog BEFORE termux-setup-storage runs');
  ok(sh.indexOf('Allow all files access') >= 0, 'setup.sh tells the user exactly which button to tap');
  ok(/termux-setup-storage;[^\n]*\n[^\n]*echo[^\n]*storage setup did not finish/.test(sh) === false &&
     sh.indexOf('storage setup did not finish') >= 0,
    'setup.sh reports an unfinished storage setup honestly (non-fatal)');

  // step c: pkg update + coreutils (the file tools the next wave needs)
  ok(sh.indexOf('pkg update -y') >= 0, 'setup.sh runs pkg update -y');
  ok(sh.indexOf('pkg install -y coreutils') >= 0, 'setup.sh installs coreutils');
  ok(/pkg update -y[^\n]*\n?[^\n]*\|\|[^\n]*non-fatal/.test(sh) ||
     sh.indexOf('pkg update failed (network?) — non-fatal') >= 0,
    'pkg update failure is caught + echoed honestly (non-fatal)');

  // step d: the default workspace dir
  ok(sh.indexOf('$HOME/storage/shared/Doomalay') >= 0, 'setup.sh creates the default workspace dir');
  ok(sh.indexOf('-d "$HOME/storage/shared"') >= 0, 'setup.sh checks storage is live before creating it');

  // step e: the final honest line
  ok(sh.indexOf('doomalay termux setup complete — return to the Doomalay app') >= 0,
    'setup.sh ends with the exact "return to the Doomalay app" line');

  // the one-liner: the file itself advertises the exact curl command
  ok(sh.indexOf('https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh') >= 0,
    'setup.sh header carries the raw one-liner URL (self-consistent)');
})();

// ── 2. SOURCE PINS: termuxsetup.js — the setup overlay page ───────────
console.log('v1.17.3 THE SETUP pins — termuxsetup.js:');
(function () {
  var tsx = src(path.join(WEB, 'termuxsetup.js'));
  ok(tsx.indexOf(ONE_LINER) >= 0, 'termuxsetup.js shows the exact bootstrap one-liner');
  ok(tsx.indexOf('https://github.com/termux/termux-app/releases') >= 0,
    'termuxsetup.js carries the GitHub releases mirror link');

  // wired into index.html, right after capabilities.js
  var idx = src(path.join(WEB, 'index.html'));
  var capAt = idx.indexOf('src="capabilities.js"');
  var tsxAt = idx.indexOf('src="termuxsetup.js"');
  ok(tsxAt > capAt && capAt >= 0, 'index.html loads termuxsetup.js after capabilities.js');

  // the two v1.17.2 endpoints ONLY (no new HTTP paths)
  var apis = tsx.match(/\/api\/[a-z0-9\/_-]*/g) || [];
  var bad = apis.filter(function (a) {
    return a !== '/api/termux/status' && a !== '/api/termux/act';
  });
  ok(bad.length === 0, 'termuxsetup.js speaks ONLY the two v1.17.2 endpoints (' + bad.join(', ') + ')');
  ok(tsx.indexOf('?refresh=1') >= 0, 'termuxsetup.js forces refresh probes (first fetch / after actions / verify stage)');

  // the container law: the ConnectOverlay is the ONLY surface
  ok(tsx.indexOf('ConnectOverlay.pushPage') >= 0, 'the setup page pushes onto the ConnectOverlay (nested over the library)');
  ok(tsx.indexOf('window.ConnectOverlay.open(') >= 0, 'cold-open renders on the ConnectOverlay root');
  ok(tsx.indexOf('artifacts-overlay') < 0 && tsx.indexOf('document.body.appendChild(overlay') < 0,
    'no other overlay surface is touched');

  // THE HONESTY NOTE + the page strings (the source escapes the
  // apostrophe — pin on the escape-free tail)
  ok(tsx.indexOf('own security needs three taps from you') >= 0,
    'the three-tap honesty note rides at the top');
  ok(tsx.indexOf('⌨ Termux setup') >= 0 && tsx.indexOf('a real Linux shell for your chats') >= 0,
    'the header reads "⌨ Termux setup / a real Linux shell for your chats"');
  ok(tsx.indexOf('⌨ Termux is ready') >= 0, 'the final READY card string');
  ok(tsx.indexOf('not available on this build/device') >= 0, 'the honest unavailable card string');
  ok(tsx.indexOf('Get Termux') >= 0 && tsx.indexOf('Open Termux') >= 0 && tsx.indexOf('Open settings') >= 0,
    'the three action buttons (fdroid / termux / permission settings)');
  ok(tsx.indexOf('open_fdroid') >= 0 && tsx.indexOf('open_termux') >= 0 &&
     tsx.indexOf('open_permission_settings') >= 0, 'the three legal act whats');

  // the poll: 3s, and the teardown law (interval cleared on every path)
  ok(/POLL_MS\s*=\s*3000/.test(tsx), 'the poll ticks every 3 seconds');
  ok(tsx.indexOf('setInterval') >= 0 && tsx.indexOf('clearInterval') >= 0, 'the interval is created AND cleared');
  ok(tsx.indexOf("onClose: function () { kill(inst); }") >= 0, 'the overlay close hook kills the instance (no leak on close)');
  ok(tsx.indexOf('alive(inst)') >= 0 && /if \(!alive\(inst\)\) \{ kill\(inst\); return; \}/.test(tsx),
    'the liveness watch catches the back-pop teardown path (no leak on pop)');

  // the copy + external-link idioms (the repo's own)
  ok(tsx.indexOf('window.Formatter.copyText') >= 0, 'copy rides the repo helper (formatter.js, execCommand fallback)');
  ok(tsx.indexOf('window.InAppBrowser.open') >= 0 && tsx.indexOf("window.open(url, '_blank')") >= 0,
    'the GitHub link opens via the PWA external-link pattern (BIB panel first, tab fallback)');

  // THE THEME-VAR LAW: zero hardcoded hex colors
  var hexes = tsx.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) || [];
  ok(hexes.length === 0, 'termuxsetup.js carries zero hardcoded hex colors (' + hexes.join(' ') + ')');
  ok(tsx.indexOf('var(--on-accent)') >= 0, 'the chips ride --on-accent (the accent family)');
})();

// ── 3. SOURCE PINS: the capability-library row rewire ────────────────
console.log('v1.17.3 THE SETUP pins — the capabilities row rewire:');
(function () {
  var cap = src(path.join(WEB, 'capabilities.js'));
  ok(cap.indexOf('window.TermuxSetup.open(ctx') >= 0,
    'capabilities: the unready Termux row opens window.TermuxSetup (the toast is replaced)');
  ok(cap.indexOf('openTermuxSetup') >= 0, 'capabilities: the openTermuxSetup helper');
  ok(cap.indexOf('onExit: function () { probeTermux(ctx, extras, true); }') >= 0,
    'capabilities: the row re-probes (forced) when the setup page exits — flips to ready');
  ok(cap.indexOf("toast('Termux needs setup first')") >= 0,
    'capabilities: the honest fallback toast when TermuxSetup is missing (defensive)');
  ok(cap.indexOf("'set up…'") >= 0 && cap.indexOf('.cap-chip.setup') >= 0,
    'capabilities: the unready chip is the tappable "set up…" hint (accent tint)');
  var hexes = cap.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) || [];
  ok(hexes.length === 0, 'capabilities.js stays hex-free (' + hexes.join(' ') + ')');
  ok(cap.indexOf('probeTermux(ctx, extras, force)') >= 0, 'probeTermux takes the force flag (?refresh=1)');
})();

// ── 4. BEHAVIOR: _stepStates — the step-state ladder (pure) ───────────
console.log('v1.17.3 THE SETUP behavior — _stepStates:');
(function () {
  var T = require(path.join(WEB, 'termuxsetup.js'));
  var S = T._stepStates;
  ok(typeof S === 'function', 'termuxsetup.js loads under node and exports _stepStates');
  ok(T.BOOTSTRAP_CMD === ONE_LINER, 'BOOTSTRAP_CMD is the exact one-liner contract');

  function keys(s) { return s.steps.map(function (x) { return x.key; }).join(','); }
  function states(s) { return s.steps.map(function (x) { return (x.done ? '✓' : (x.active ? 'now' : '·')); }).join(' '); }
  function errs(s) { return s.steps.map(function (x) { return x.error ? 'E' : '-'; }).join(''); }

  // the ladder shape is stable
  var e0 = S(null);
  ok(keys(e0) === 'install,bootstrap,permission,verify', 'the four steps keep their order');

  // empty / missing status → the unavailable card condition
  ok(S(null).unavailable === true && S({}).unavailable === true && S({ available: false }).unavailable === true,
    'no status / available:false → unavailable (the honest card)');
  ok(S({ available: true }).unavailable === false, 'available:true renders the ladder');

  // rung 0: nothing there yet (the install step is the live focus)
  var s0 = S({ available: true });
  ok(s0.ready === false && states(s0) === 'now · · ·', 'empty device: nothing done, install in focus');
  ok(s0.steps[0].active === true, 'the install step is the active focus');
  ok(errs(s0) === '----', 'no diagnostics on a clean empty status');

  // rung 1: installed only
  var s1 = S({ available: true, installed: true, version_name: '0.118.3' });
  ok(states(s1) === '✓ now · ·', 'installed-only: step ① done, bootstrap in focus');
  ok(s1.steps[1].active === true, 'bootstrap is the active step');
  ok(s1.ready === false, 'not ready yet');

  // rung 2: + bridge_ok (the bootstrap round-trip worked)
  var s2 = S({ available: true, installed: true, bridge_ok: true });
  ok(states(s2) === '✓ ✓ now ·', 'installed + bridge_ok: steps ①② done, permission in focus');
  ok(s2.steps[2].active === true, 'permission is the active step');

  // rung 3: + permission (the ladder is one short)
  var s3 = S({ available: true, installed: true, bridge_ok: true, permission: true, storage_ok: false });
  ok(states(s3) === '✓ ✓ ✓ now', 'permission granted: steps ①②③ done, verify in focus');
  ok(s3.steps[3].active === true && s3.ready === false, 'verify is the live step, not ready yet');
  ok(s3.steps[3].error.indexOf('storage') >= 0, 'the honest storage note rides under verify');

  // rung 4: + storage/props/ready — the READY condition
  var s4 = S({ available: true, installed: true, bridge_ok: true, permission: true,
               storage_ok: true, props_ok: true, ready: true });
  ok(s4.ready === true, 'the ready condition');
  ok(states(s4) === '✓ ✓ ✓ ✓', 'all four steps done');
  ok(s4.steps.every(function (x) { return x.active === false; }), 'no active step when ready');
  ok(errs(s4) === '----', 'no diagnostics when ready');

  // diagnostics: last_error lands under the ACTIVE step (where the user
  // is stuck) — a dead bridge with Termux installed → bootstrap
  var s5 = S({ available: true, installed: true, bridge_ok: false, last_error: 'probe: bridge timeout' });
  ok(s5.steps[1].error.indexOf('probe: bridge timeout') >= 0, 'last_error lands under the active (bootstrap) step');
  ok(s5.steps[0].error === '' && s5.steps[3].error === '', 'the other steps stay quiet');

  // diagnostics: nothing installed → the error rides the install step
  var s6 = S({ available: true, installed: false, last_error: 'probe: no termux package' });
  ok(s6.steps[0].error.indexOf('probe: no termux package') >= 0, 'last_error under install when it is the active step');

  // diagnostics: the bridge answered but props are off → bootstrap note
  var s7 = S({ available: true, installed: true, bridge_ok: true, permission: true,
               storage_ok: true, props_ok: false, ready: false });
  ok(s7.steps[1].error.indexOf('allow-external-apps') >= 0, 'the props note lands under bootstrap');

  // ready ignores props_ok (the engine's contract: ready = bridge &&
  // storage && installed && permission — props is informational)
  var s8 = S({ available: true, installed: true, bridge_ok: true, permission: true,
               storage_ok: true, props_ok: false, ready: true });
  ok(s8.ready === true, 'props_ok is informational — ready is the engine\'s word');
})();

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
