#!/usr/bin/env node
// v1202-local-hand-test.js — v1.20.2 THE LOCAL HAND pins (node-side).
//
// THE LOCAL HAND: connect-a-workspace → local device storage actually
// works on the APK through Termux (window.showDirectoryPicker doesn't
// exist in the Android WebView — the user's report: "nothing in that
// screen works. The app never requests device storage permission"). The
// engine grows the jailed /api/termux/fs surface + the termux rows' file
// verbs (the cloud rows' REST twins), the PWA's device page branches into
// THE TERMUX BROWSER on APK builds, and the bridge's /run route learns
// EXTRA_STDIN so file writes ride `bash -c 'cat > "$1"' _ <path>` with
// the content as stdin — zero shell-escaping surface.
//
// This rig pins the source contracts (routes registered, the jail script
// bytes, the stdin law across Go + Kotlin, the theme-var law) and
// exercises the pure behavior the DOM is too heavy to fake here
// (termuxCrumbs + termuxRelPath — required straight off the module tail,
// the termuxsetup.js node path).
'use strict';

var path = require('path');
var fs = require('fs');

var ROOT = path.join(__dirname, '..');
var WEB = path.join(ROOT, 'engine', 'internal', 'server');
var GO = path.join(ROOT, 'engine', 'internal');
var KT = path.join(ROOT, 'platforms', 'android', 'app', 'src', 'main', 'java', 'com', 'doomalay', 'engine');

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}
function src(file) { return fs.readFileSync(file, 'utf8'); }

// ── 1. SOURCE PINS: the routes (server.go) ─────────────────────────────
console.log('v1.20.2 THE LOCAL HAND pins — the routes:');
(function () {
  var s = src(path.join(GO, 'server', 'server.go'));
  ok(s.indexOf('s.mux.HandleFunc("GET /api/termux/fs", s.handleTermuxFSList)') >= 0,
    'GET /api/termux/fs is registered (the jailed listing)');
  ok(s.indexOf('s.mux.HandleFunc("POST /api/termux/fs", s.handleTermuxFSMkdir)') >= 0,
    'POST /api/termux/fs is registered (the jailed mkdir)');
  ok(s.indexOf('v1.20.2 THE LOCAL HAND: the jailed device-storage FS surface') >= 0,
    'the fs route block carries the v1.20.2 header right after the v1.17.2 termux routes');
  ok(s.indexOf('v1.20.2 THE LOCAL HAND: device rows saved with a termux_path') >= 0,
    'the workspaces block documents the termux dispatch after POST /api/workspaces/device');
  ok(s.indexOf('s.mux.HandleFunc("GET /api/workspaces/{id}/file", s.handleWorkspaceFile)') >= 0 &&
    s.indexOf('s.mux.HandleFunc("PUT /api/workspaces/{id}/file", s.handleWorkspacePutFile)') >= 0,
    'the v0.44 file-verb routes stay THE one REST surface (no second pattern)');
})();

// ── 2. SOURCE PINS: THE JAIL (termuxfs.go) ─────────────────────────────
console.log('v1.20.2 THE LOCAL HAND pins — the jail scripts:');
(function () {
  var t = src(path.join(GO, 'server', 'termuxfs.go'));
  ok(t.indexOf('readlink -f -- %s') >= 0,
    'the scripts resolve through readlink -f (symlinks + .. collapse before the check)');
  ok(t.indexOf('exit 42') >= 0,
    'the jail refuses with exit 42 (the engine maps it to the 400)');
  ok(t.indexOf('/storage/emulated/0|/storage/emulated/0/*|/data/data/com.termux/files/home|/data/data/com.termux/files/home/*') >= 0,
    'the two safe roots spell the exact case pattern');
  ok(t.indexOf('shopt -s nullglob dotglob') >= 0,
    'the listing includes dotted entries (dotglob) and survives empty folders (nullglob)');
  ok(t.indexOf('TRUNCATED|$total') >= 0,
    'the 500-cap prints the honest TRUNCATED|<total> line');
  ok(t.indexOf('500') >= 0 && t.indexOf('termuxFSListCap   = 500') >= 0,
    'the cap constant is 500');
  ok(t.indexOf('shared|shared/*) p="$HOME/storage/shared${p#shared}"') >= 0 &&
    t.indexOf('downloads|downloads/*) p="$HOME/storage/downloads${p#downloads}"') >= 0 &&
    t.indexOf('documents|documents/*) p="$HOME/storage/documents${p#documents}"') >= 0 &&
    t.indexOf('home|home/*) p="$HOME${p#home}"') >= 0,
    'the four ROOT aliases map to the Termux-side paths');
  ok(t.indexOf('grep -qP \'[\\x00-\\x08\\x0e-\\x1f]\'') >= 0,
    'the read sniffs binaries INSIDE the termux script (the control-char grep)');
  ok(t.indexOf('bash -c \'\'') === -1 && t.indexOf('termuxWriteCommand') >= 0 &&
    t.indexOf('cat > "$rp"') >= 0 && t.indexOf("return \"bash -c '\" + inner + \"' _ \"") >= 0,
    'THE EXTRA_STDIN LAW: the write rides bash -c \'<inner>\' _ <quoted-path>');
  ok(t.indexOf('RunWithStdin(ctx, script, "", termuxFSTimeoutMS, stdin)') >= 0,
    'the stdin-carrying runs go through RunWithStdin');
  ok(t.indexOf('"termux bridge not configured on this engine"') >= 0,
    'the no-bridge honest error text is pinned (HTTP 200, never 5xx)');
  ok(t.indexOf('LastIndexByte') >= 0,
    'the listing parses from the RIGHT (names containing | stay whole)');
  ok(t.indexOf('TRUNCATED|') >= 0 && t.indexOf('parseTermuxEntryLine') >= 0,
    'malformed lines are skipped by the parser, never fatal');
})();

// ── 3. SOURCE PINS: the workspace rows (workspaces.go + client.go) ────
console.log('v1.20.2 THE LOCAL HAND pins — the rows + the bridge client:');
(function () {
  var w = src(path.join(GO, 'server', 'workspaces.go'));
  ok(w.indexOf('TermuxPath string `json:"termux_path"`') >= 0,
    'handleWorkspaceDevice grows the optional termux_path field');
  ok(w.indexOf('Kind: "termux", Host: "device", Owner: "this device"') >= 0,
    'termux rows save Kind termux / Host device / Owner this device');
  ok(w.indexOf('"termux": true, "termux_path": tp, "display_path": tp') >= 0,
    'the meta carries termux + termux_path + display_path');
  ok(w.indexOf('map[string]any{"termux": true}') >= 0,
    'the wsJSON extra mirrors the device:true pattern');
  ok(w.indexOf('if tw := s.termuxWSFor(r); tw != nil') >= 0,
    'the GET file verb dispatches termux rows into termuxfs.go');
  ok(w.indexOf('if ws.Kind == "termux"') >= 0,
    'the PUT file verb dispatches termux rows into termuxfs.go');
  ok(w.indexOf('"device": true, "display_path": strings.TrimSpace(req.Path)') >= 0,
    'the desktop device flow stays byte-identical');

  var c = src(path.join(GO, 'termuxbridge', 'client.go'));
  ok(c.indexOf('func (c *Client) Run(ctx context.Context, command, workdir string, timeoutMS int) (*RunResult, error)') >= 0,
    'Run keeps its exact signature (every existing caller untouched)');
  ok(c.indexOf('func (c *Client) RunWithStdin(ctx context.Context, command, workdir string, timeoutMS int, stdin string) (*RunResult, error)') >= 0,
    'RunWithStdin is the stdin-carrying twin');
  ok(c.indexOf('if stdin != "" {\n\t\tbody["stdin"] = stdin\n\t}') >= 0,
    'the stdin rides the bridge body only when non-empty');
})();

// ── 4. SOURCE PINS: THE KOTLIN STDIN EDIT (the one shared file) ───────
console.log('v1.20.2 THE LOCAL HAND pins — TermuxBridge.kt (the surgical stdin edit):');
(function () {
  var k = src(path.join(KT, 'TermuxBridge.kt'));
  ok(k.indexOf('stdin: String? = null, // v1.20.2: stdin') >= 0,
    'runCommand grows the default-valued stdin param (existing call sites unchanged)');
  ok(k.indexOf('putExtra("com.termux.RUN_COMMAND_STDIN", stdin)') >= 0,
    'the intent carries the RUN_COMMAND_STDIN extra');
  ok(k.indexOf('if (stdin != null) putExtra("com.termux.RUN_COMMAND_STDIN", stdin)') >= 0,
    'the extra is set only when stdin is non-null');
  ok(k.indexOf('if (o.has("stdin") && !o.isNull("stdin") && o.optString("stdin", "").isNotEmpty())') >= 0,
    'handleRun parses the body\'s optional "stdin" field');
  ok(k.indexOf('TermuxBridge.runCommand(ctx, command, workdir, timeoutMs, stdinExtra)') >= 0,
    'handleRun forwards stdinExtra into runCommand');
  // the merge seam: agent A (checkin route) + this wave (stdin) both touch
  // the file — pin that the edit stays tiny + localized.
  var v1202 = k.split('\n').filter(function (l) { return l.indexOf('v1.20.2') >= 0; });
  ok(v1202.length <= 8, 'the v1.20.2-marked Kotlin lines stay surgical (≤ 8, got ' + v1202.length + ')');
})();

// ── 5. SOURCE PINS: the PWA (workspace.js) ─────────────────────────────
console.log('v1.20.2 THE LOCAL HAND pins — workspace.js:');
(function () {
  var js = src(path.join(WEB, 'web', 'workspace.js'));
  ok(js.indexOf("termux: '📱'") >= 0,
    "kindIcon maps termux → 📱");
  ok(js.indexOf('function apkBuild()') >= 0 &&
    js.indexOf('window.__doomalayKotlin') >= 0,
    'the APK gate (the capabilities.js apkGate pattern, __doomalayKotlin + ?apk=1)');
  ok(js.indexOf('if (apkBuild()) {\n      termuxStatusCached(true).then') >= 0,
    'openDevicePage branches on the APK gate BEFORE the File-Access flow');
  ok(js.indexOf('window.showDirectoryPicker') >= 0 &&
    js.indexOf('openTermuxBrowserPage();\n        else openTermuxTeachPage();') >= 0,
    'ready → THE TERMUX BROWSER, not-ready → the teach page; desktop keeps showDirectoryPicker');
  ok(js.indexOf("Termux isn\\u2019t set up — device folders ride it") >= 0,
    "the honest teach row text");
  ok(js.indexOf('window.TermuxSetup.open(currentPicker || {}, {') >= 0,
    'the teach button opens the v1.17.3 setup overlay (the capabilities.js open(ctx, opts) idiom)');
  ok(js.indexOf("toast('device workspace saved — reads + writes ride Termux')") >= 0,
    "the use-folder toast");
  ok(js.indexOf("termux_path: resolved") >= 0,
    'the CTA POSTs the resolved path as termux_path');
  ok(js.indexOf('{ action: \'mkdir\', path: resolved, name: nm }') >= 0,
    'the ＋ create-folder button POSTs the mkdir verb');
  ok(js.indexOf("your files never leave the phone") >= 0,
    "the root picker carries the stays-on-phone note");
  ok(js.indexOf("alias: 'shared'") >= 0 && js.indexOf("alias: 'downloads'") >= 0 &&
    js.indexOf("alias: 'documents'") >= 0 && js.indexOf("alias: 'home'") >= 0,
    'the four ROOT PICKER rows (shared/downloads/documents/home)');
  ok(js.indexOf('function termuxCrumbs(') >= 0 && js.indexOf('📍') >= 0,
    'the crumb bar renders the current path');
  ok(js.indexOf('wtx-list') >= 0 && js.indexOf('scrollbar-color:var(--border-strong)') >= 0,
    'the listing area scrolls with the thin themed scrollbar');
  ok(js.indexOf('loaderHTML(\'wtx-load\'') >= 0 && js.indexOf("id=\"wtx-retry\">retry") >= 0,
    'loading + error states: the wsx loader idiom + the retry button');
  ok(js.indexOf('function loadTermuxLevel(') >= 0,
    'the drawer termux tree (GET /api/termux/fs per level)');
  ok(js.indexOf('function openTermuxFile(') >= 0 &&
    js.indexOf('PUT', { }) >= 0 && js.indexOf("'/file', 'PUT', {\n            path: rel,\n            content:") >= 0,
    'the termux editor commits PUT {path, content} to the ws file verb');
  ok(js.indexOf("w.kind !== 'device' && w.kind !== 'termux'") >= 0,
    'the cloud drawer section excludes termux rows');
  ok(js.indexOf("w.kind === 'device' || w.kind === 'termux'") >= 0,
    'the device drawer section includes termux rows');
  ok(js.indexOf("module.exports = { termuxCrumbs: termuxCrumbs, termuxRelPath: termuxRelPath }") >= 0,
    'the pure helpers export module-style (the termuxsetup.js node path)');
  // THE THEME-VAR LAW: zero hardcoded hex colors
  var hexes = js.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) || [];
  ok(hexes.length === 0, 'workspace.js carries zero hardcoded hex colors (' + hexes.join(' ') + ')');
})();

// ── 6. BEHAVIOR: the pure helpers (required off the module tail) ───────
console.log('v1.20.2 THE LOCAL HAND behavior — termuxCrumbs + termuxRelPath:');
(function () {
  var W = require(path.join(WEB, 'web', 'workspace.js'));
  ok(typeof W.termuxCrumbs === 'function' && typeof W.termuxRelPath === 'function',
    'workspace.js loads under node and exports both pure helpers');

  // crumbs: the shared root elides to 📱 storage, segments chain absolute
  var c1 = W.termuxCrumbs('/storage/emulated/0/Doomalay/notes');
  ok(c1.length === 3, 'the shared path crumbles into root + 2 segments');
  ok(c1[0].label === '📱 storage' && c1[0].path === '/storage/emulated/0',
    'the shared root elides to 📱 storage with its absolute path');
  ok(c1[1].label === 'Doomalay' && c1[1].path === '/storage/emulated/0/Doomalay' &&
    c1[2].label === 'notes' && c1[2].path === '/storage/emulated/0/Doomalay/notes',
    'each crumb carries its own absolute jump path');

  // crumbs: the termux home elides to ⌂ home
  var c2 = W.termuxCrumbs('/data/data/com.termux/files/home/work');
  ok(c2.length === 2 && c2[0].label === '⌂ home' && c2[0].path === '/data/data/com.termux/files/home' &&
    c2[1].path === '/data/data/com.termux/files/home/work',
    'the termux home root elides to ⌂ home');

  // crumbs: the bare roots + the degenerate shapes
  ok(W.termuxCrumbs('/storage/emulated/0').length === 1, 'the bare shared root is one crumb');
  ok(W.termuxCrumbs('').length === 0 && W.termuxCrumbs(null).length === 0,
    'empty/null path → no crumbs (the root-picker screen)');
  ok(W.termuxCrumbs('shared').length === 0,
    'a non-absolute path → no crumbs (never a broken bar)');

  // rel paths: the drawer tree's file taps
  ok(W.termuxRelPath('/storage/emulated/0/Doomalay', '/storage/emulated/0/Doomalay/a/b.txt') === 'a/b.txt',
    'the rel path strips the root');
  ok(W.termuxRelPath('/storage/emulated/0/Doomalay', '/storage/emulated/0/Doomalay') === '',
    'the root itself rels to "" (the workspace root)');
  ok(W.termuxRelPath('/storage/emulated/0/Doomalay', '/storage/emulated/0/other/x') === '',
    'a path outside the root rels to "" (honest, never a wrong file)');
  ok(W.termuxRelPath('', '/anything') === '', 'a missing root rels to ""');
})();

// ── summary ─────────────────────────────────────────────────────────────
console.log('');
console.log('v1202-local-hand: ' + pass + ' passed, ' + fail + ' failed, ' + (pass + fail) + ' total');
process.exit(fail ? 1 : 0);
