#!/usr/bin/env node
// v1174-ota-test.js — v1.17.4 THE LIVE UPDATE pins (node-side).
//
// The delta OTA wave: only what changed, never the whole APK. This rig
// pins the source contracts (ota.js registered at the END of the script
// list, the opt-out flag, the banner action wiring, theme vars only) and
// exercises the pure behavior the DOM is too heavy to fake here (the
// state→banner mapping, the KB formatter). It also generates a manifest
// for the CURRENT tree with the real CI script and validates the JSON
// shape the engine parses.
'use strict';

var path = require('path');
var fs = require('fs');
var execSync = require('child_process').execSync;
var crypto = require('crypto');

var REPO = path.join(__dirname, '..');
var WEB = path.join(REPO, 'engine', 'internal', 'server', 'web');
var SCRIPTS = path.join(REPO, 'scripts');

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}
function src(file) { return fs.readFileSync(path.join(WEB, file), 'utf8'); }

// ── 1. SOURCE PINS: the registration + the wiring ─────────────────────
console.log('v1.17.4 THE LIVE UPDATE pins:');
(function () {
  ok(fs.existsSync(path.join(WEB, 'ota.js')), 'ota.js exists');

  var idx = src('index.html');
  ok(idx.indexOf('src="ota.js"') >= 0, 'index.html loads ota.js');
  // THE MERGE NOTE: our tag rides AFTER app.js (the last existing script
  // when this wave was built) — a different position from the parallel
  // termuxsetup.js tag, so the merge stays clean.
  var appAt = idx.indexOf('src="app.js"');
  var otaAt = idx.indexOf('src="ota.js"');
  ok(appAt >= 0 && otaAt > appAt, 'the ota.js tag comes after app.js (the end-of-list position)');

  var ota = src('ota.js');
  ok(ota.indexOf('window.Ota') >= 0, 'ota.js exposes window.Ota');
  ok(ota.indexOf("/api/ota/status") >= 0, 'ota.js polls GET /api/ota/status');
  ok(ota.indexOf("'/api/ota/download'") >= 0 && ota.indexOf("method: 'POST'") >= 0, 'ota.js POSTs /api/ota/download for the Update action');
  ok(ota.indexOf('doomalay-ota-optout') >= 0, 'the persistent opt-out flag is localStorage "doomalay-ota-optout"');
  ok(/sessionStorage/.test(ota), 'the dismiss ✕ hides for the session only (sessionStorage)');
  ok(ota.indexOf('800') >= 0 && ota.indexOf('window.location.reload()') >= 0, 'applied → reload after 800ms');
  ok(ota.indexOf('releases/latest') >= 0 && ota.indexOf("window.open(RELEASES_URL, '_blank')") >= 0,
    'engine_update_required → the GitHub releases link via the PWA open-external pattern');
  ok(/POLL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(ota) && /setInterval\(poll,\s*POLL_MS\)/.test(ota),
    'the 5-minute heartbeat poll');
  ok(/busy\s*=\s*true/.test(ota) && /updating…/.test(ota), 'the Update button shows a busy state while downloading');
  ok(ota.indexOf('applied — reload') >= 0, 'the post-download banner flips to "applied — reload"');

  // never spam: one banner at a time, cleared when state returns current
  ok(ota.indexOf('lastKey') >= 0 && ota.indexOf('hideBanner()') >= 0, 'one banner at a time + clear on current');

  // z-index below the ConnectOverlay (3000)
  var z = /z-index:(\d+)/.exec(ota);
  ok(!!z && parseInt(z[1], 10) < 3000, 'the banner z-index stays below the ConnectOverlay (found ' + (z ? z[1] : 'none') + ')');

  // theme vars only — zero hardcoded colors in the style strings
  var hexes = ota.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok(hexes.length === 0, 'no hardcoded hex colors in ota.js (' + hexes.join(' ') + ')');
  ['var(--surface-2)', 'var(--text-1)', 'var(--border)', 'var(--accent)', 'rgba(var(--accent-rgb)'].forEach(function (v) {
    ok(ota.indexOf(v) >= 0, 'the banner rides the theme var ' + v);
  });

  // the node module path (this rig's own require)
  ok(/module\.exports/.test(ota), 'ota.js exports the pure mapping for the node rig');

  // the engine side: the endpoints + the overlay are wired
  var srv = fs.readFileSync(path.join(REPO, 'engine', 'internal', 'server', 'server.go'), 'utf8');
  ok(srv.indexOf('GET /api/ota/status') >= 0 && srv.indexOf('POST /api/ota/check') >= 0 && srv.indexOf('POST /api/ota/download') >= 0,
    'server.go registers the three OTA endpoints');
  ok(srv.indexOf('s.otaOverlay(http.FileServer(http.FS(distFS)))') >= 0, 'the static handler rides the ota-first overlay (THE APPLY MECHANISM)');
  var otaapi = fs.readFileSync(path.join(REPO, 'engine', 'internal', 'server', 'otaapi.go'), 'utf8');
  ok(otaapi.indexOf('engine/internal/server/web/') >= 0, 'the only patchable root is engine/internal/server/web/');
  ok(/os\.Stat\(disk\)/.test(otaapi) && otaapi.indexOf('path.Clean(p) != p') >= 0, 'the overlay path traversal guard (clean relative paths only)');
})();

// ── 2. BEHAVIOR: the state→banner mapping (pure) ─────────────────────
(function () {
  var O = require(path.join(WEB, 'ota.js'));

  // update_available → the honest banner with N files + ~KB
  var u = O._render({ state: 'update_available', manifest: { changed: 2, changed_bytes: 14321 } });
  ok(u.show === true && u.kind === 'update', 'update_available renders');
  ok(u.text === 'Update available · 2 files · ~14 KB', 'the text counts files + KB: ' + JSON.stringify(u.text));
  ok(u.action === 'Update' && u.dismissible === true, 'the Update action + dismiss');

  var one = O._render({ state: 'update_available', manifest: { changed: 1, changed_bytes: 512 } });
  ok(one.text === 'Update available · 1 file · ~0.5 KB', 'singular "file" + sub-KB honesty: ' + JSON.stringify(one.text));

  // engine_update_required → the full-app-update banner
  var e = O._render({ state: 'engine_update_required' });
  ok(e.show === true && e.kind === 'engine', 'engine_update_required renders');
  ok(e.text === 'full app update needed', 'the engine-update text: ' + JSON.stringify(e.text));

  // the non-actionable states render NOTHING (never spam, never lie)
  ['current', 'unreachable', 'disabled'].forEach(function (st) {
    var s = O._render({ state: st });
    ok(s.show === false, 'state ' + st + ' renders no banner');
  });

  // malformed payloads degrade to no banner (honest, never a guess)
  ok(O._render(null).show === false, 'a null payload renders no banner');
  ok(O._render({}).show === false, 'an empty payload renders no banner');
  ok(O._render({ state: 'update_available' }).text === 'Update available · 0 files · ~0 KB',
    'a missing manifest summary degrades to 0 files / ~0 KB');

  // the KB formatter
  ok(O._fmtKb(0) === '~0 KB', 'fmtKb(0)');
  ok(O._fmtKb(400) === '~0.4 KB', 'fmtKb(400) keeps the sub-KB tenth');
  ok(O._fmtKb(1024) === '~1 KB', 'fmtKb(1024)');
  ok(O._fmtKb(14321) === '~14 KB', 'fmtKb(14321)');
  ok(O._fmtKb(20 * 1048576) === '~20480 KB', 'fmtKb at the plan cap');
})();

// ── 3. THE MANIFEST: generate for the CURRENT tree + validate ────────
(function () {
  var out = path.join(require('os').tmpdir(), 'v1174-patch-manifest-rig.json');
  var stdout = execSync('python3 ' + JSON.stringify(path.join(SCRIPTS, 'generate-ota-manifest.py')) + ' v1.17.4-rig ' + JSON.stringify(out), { cwd: REPO }).toString();
  ok(/files=\d+/.test(stdout), 'the generator runs on the current tree: ' + stdout.trim().split('\n')[0]);

  var m = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok(m.version === 'v1.17.4-rig' && m.ref === 'v1.17.4-rig' && m.min_engine === 'v1.17.4-rig',
    'version/ref/min_engine all stamped from the tag');
  ok(Array.isArray(m.files) && m.files.length > 100, 'the manifest carries the whole web tree (' + m.files.length + ' files)');
  var allUnder = m.files.every(function (f) { return f.path.indexOf('engine/internal/server/web/') === 0; });
  ok(allUnder, 'every path is repo-root-relative under the web tree');
  var keysOk = m.files.every(function (f) { return Object.keys(f).sort().join(',') === 'path,sha256,size'; });
  ok(keysOk, 'every entry is exactly {path, sha256, size}');
  var shaOk = m.files.every(function (f) { return /^[0-9a-f]{64}$/.test(f.sha256); });
  ok(shaOk, 'every sha256 is 64 lowercase hex');
  var paths = m.files.map(function (f) { return f.path; });
  ok(paths.slice().sort().join('\n') === paths.join('\n'), 'the file list is deterministically sorted');
  ok(new Set(paths).size === paths.length, 'no duplicate paths');

  // spot-check 3 real hashes + sizes against the working tree
  var spot = [m.files[0], m.files[Math.floor(m.files.length / 2)], m.files[m.files.length - 1]];
  spot.forEach(function (f) {
    var real = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f.path))).digest('hex');
    ok(real === f.sha256 && fs.statSync(path.join(REPO, f.path)).size === f.size, 'hash + size verified: ' + f.path);
  });

  // the engine parses the exact same shape (key drift = a manifest with
  // zero files — the Go test pins the struct; this pins the generator)
  ok(m.files.some(function (f) { return /ota\.js$/.test(f.path); }), 'the manifest covers ota.js itself');
})();

// ── summary ───────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
