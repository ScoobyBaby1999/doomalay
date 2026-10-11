// v1241-terminal-pulse-rig.cjs — PLAN-V124 THE TERMINAL PULSE battery:
// the bar lives in termux/setup.sh now (on the Termux terminal itself),
// so the rig drives the REAL script — the renderer demo across widths and
// note variants, the source pins, the plain-mode degradation, and the
// LIVE HARNESS (the real script under a pty with stubbed Termux commands
// + a real checkin HTTP server). The app-side contract (no bar leftovers)
// is pinned too.
const { execFileSync, spawnSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SH = path.join(ROOT, 'termux', 'setup.sh');
const WEB = path.join(ROOT, 'engine', 'internal', 'server', 'web');

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log(`  PASS ${name}`); }
  else console.log(`  FAIL ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`);
}
function run(args, env, timeoutMs) {
  const r = spawnSync('bash', args, {
    encoding: 'utf8', timeout: timeoutMs || 45000,
    env: Object.assign({}, process.env, env || {}),
    maxBuffer: 32 * 1024 * 1024
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('v1.24.1 THE TERMINAL PULSE — setup.sh syntax + source pins:');
(function () {
  const syn = run(['-n', SH]);
  ck('bash -n (the script parses)', syn.status === 0, syn.out);
  const sh = fs.readFileSync(SH, 'utf8');
  // the non-fatal law (a real `set -e` COMMAND, not the doc mention)
  ck('`set -u` only, never a real `set -e`',
    /^\s*set -u/m.test(sh) && !/^\s*set -e\b/m.test(sh));
  ck('the never-fatal arg law is documented',
    /unknown args are ignored, never fatal/i.test(sh));
  // the honest notes — the user's exact ask (the apostrophe is spelled
  // with the '\'' dance in the source, so the pin checks the spine)
  ck('the SAFE note ("it is ok to go back to the app")',
    sh.includes('ok to go back to the app now — setup keeps running in the background'));
  ck('the SAFE note starts with ↩', sh.includes("DM_NOTE_SAFE='↩ it'"));
  ck('the HOLD note ("please wait — keep Termux open")',
    sh.includes('please wait — keep Termux open until setup finishes'));
  ck('the DIALOG note ("please wait — tap Allow")',
    sh.includes('please wait — tap "Allow" on the storage dialog'));
  ck('phase ② always takes the dialog note (the interactive law)',
    /if \[ "\$1" = "2" \]; then\s*\n\s*printf '%s' "\$DM_NOTE_DIALOG"/.test(sh));
  // the wake lock earns the safe note
  ck('termux-wake-lock is acquired at start', /termux-wake-lock >\/dev\/null 2>&1; then DM_SAFE=1/.test(sh));
  ck('termux-wake-unlock releases it at exit (never leaks the lock)',
    /termux-wake-unlock >\/dev\/null 2>&1/.test(sh));
  ck('the unlock is guarded to the script\'s own lock (not the demo)',
    /DM_SAFE:-0.*= "1".*\n.*-z "\$DEMO"|\$\{DM_SAFE:-0\}" = "1" \] && \[ -z "\$DM_DEMO"/.test(sh) ||
    (sh.indexOf('termux-wake-unlock') > sh.indexOf('DM_SAFE=0') &&
     sh.includes('[ -z "$DM_DEMO" ]')));
  // the single-writer machinery
  ck('the state file is written atomically (tmp + mv)',
    /DM_STMP"[^\n]*2>\/dev\/null && mv -f "\$DM_STMP" "\$DM_STATE"/.test(sh));
  ck('the print queue drains by atomic mv (the single-writer law)',
    /mv -f "\$DM_QUEUE" "\$qf"/.test(sh));
  ck('the in-place redraw uses cursor-up + erase (\\033[1A\\r\\033[K)',
    sh.includes('\\033[1A\\r\\033[K'));
  ck('the watcher exits on the done marker', /mode" = "done"/.test(sh));
  ck('the EXIT trap reaps the watcher + cleans the state dir',
    /trap __dm_cleanup EXIT/.test(sh) && /rm -rf "\$DM_STATEDIR"/.test(sh));
  // honesty: real progress only
  ck('the bar fills one quarter per completed step (units * 25)',
    /units \* 25/.test(sh) && /units \* cells \/ 4/.test(sh));
  ck('apt output is the download truth (the newest line rides the bar)',
    /tail -n 1 "\$log"/.test(sh));
  ck('the demo touches nothing (no pkg/mkdir inside the demo block)',
    (() => {
      const d = sh.slice(sh.indexOf('THE RENDER DEMO'), sh.indexOf('# ── the header'));
      return !/\bpkg\b/.test(d) && !/mkdir -p "\$HOME\/\.termux"/.test(d) &&
             !/termux-setup-storage$/.test(d.trim());
    })());
  // the v1.17.3 contracts that survive
  ck('the raw one-liner URL stays in the header',
    sh.includes('https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh'));
  ck('the checkin curl keeps its two honest flags',
    sh.includes('curl -fsS --max-time 6 "${DOOMALAY_CHECKIN_URL}?storage=${__storage_flag}&props=${__props_flag}"'));
})();

console.log('v1.24.1 — the app-side removal pins (termuxsetup.js):');
(function () {
  const tsx = fs.readFileSync(path.join(WEB, 'termuxsetup.js'), 'utf8');
  ck('NO _barFor anywhere', !tsx.includes('_barFor(') && !tsx.includes('_barFor:'));
  ck('NO tsx-pulse markup/CSS ids', !tsx.includes('tsx-pulse'));
  ck('NO paintPulse', !tsx.includes('paintPulse'));
  ck('NO spinner heartbeat (130ms)', !tsx.includes('130)'));
  ck('_stepStates still exported (the ladder keeps its truth)',
    tsx.includes('_stepStates: _stepStates'));
  ck('the removal note points at the terminal bar',
    tsx.includes('THE TERMINAL PULSE') && tsx.includes('termux/setup.sh'));
  ck('the foot line teaches where the bar went',
    tsx.includes('the live ASCII progress bar runs on the Termux terminal itself'));
  // the module still loads + the ladder still computes
  const m = require(path.join(WEB, 'termuxsetup.js'));
  const s = m._stepStates({ available: true });
  ck('the ladder still computes (4 steps, first active)',
    s.steps.length === 4 && s.steps[0].active === true && !s.ready);
})();

console.log('v1.24.1 — the renderer demo (the real script, stubbed actions):');
// a tiny terminal emulator for the ops the bar uses (move-up, erase,
// carriage return) — the honest way to measure what a real Termux screen
// would RENDER. The bar is transient (each frame erases the last), so the
// emulator SNAPSHOTs every rendered row at every write and remembers the
// widest bar line + every bar shape ever shown.
function emulate(raw) {
  const screen = [''];
  let row = 0, i = 0, maxBarLen = 0, maxAnyLen = 0;
  const barShapes = new Set();
  const snap = () => {
    const l = screen[row] || '';
    if (l.length > maxAnyLen) maxAnyLen = l.length;
    if (/[█░]/.test(l)) {
      if (l.length > maxBarLen) maxBarLen = l.length;
      barShapes.add(l);
    }
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\x1b') {
      const m = /^\x1b\[([0-9]*)([A-Za-z])/.exec(raw.slice(i));
      if (m) {
        const n = m[1] === '' ? 1 : +m[1];
        if (m[2] === 'A') { row = Math.max(0, row - n); }
        else if (m[2] === 'K') { screen[row] = ''; }   // erase after \r = the whole line
        i += m[0].length; continue;
      }
      i++; continue;
    }
    if (c === '\r') { i++; continue; }               // our writes always start at col 0
    if (c === '\n') { row++; screen[row] = ''; i++; continue; }
    screen[row] = (screen[row] || '') + c;
    snap();
    i++;
  }
  return { maxBarLen, maxAnyLen, barShapes: [...barShapes] };
}
(function () {
  // wide + please-wait notes
  const w = run([SH, '--render-demo'], { DM_COLS: '60' });
  ck('the wide demo exits 0', w.status === 0);
  const frames = (w.out.match(/\x1b\[1A\r\x1b\[K/g) || []).length;
  ck('the bar redraws in place (cursor-up frames present)', frames >= 10, frames);
  const pcts = [...w.out.matchAll(/([0-9]+)% · \[/g)].map(m => +m[1]);
  ck('the pct walks 0 → 25 → 50 → 75 (never beyond, never fake)',
    pcts.includes(0) && pcts.includes(25) && pcts.includes(50) && pcts.includes(75) &&
    !pcts.some(p => p > 75), [...new Set(pcts)].join(','));
  const cells = [...w.out.matchAll(/· \[([█░]+)\]/g)].map(m => m[1].length);
  ck('wide: 20 cells exactly', cells.length > 0 && cells.every(c => c === 20), [...new Set(cells)].join(','));
  const spinners = [...w.out.matchAll(/([⠋⠙⠹⠸⠼⠴⠦⠧]) \d+% /g)].map(m => m[1]);
  ck('the braille spinner animates', new Set(spinners).size >= 4, [...new Set(spinners)].join(''));
  ck('the hold note renders without the wake lock',
    w.out.includes('please wait — keep Termux open until setup finishes'));
  ck('the dialog note renders on phase ②',
    w.out.includes('please wait — tap "Allow" on the storage dialog'));
  ck('the safe note does NOT render without the wake lock (honesty)',
    !w.out.includes("it's ok to go back to the app"));
  ck('the apt activity rides the bar (↓ Get:/Fetched)',
    /↓ (Get:|Fetched:)/.test(w.out));
  ck('the four ▶ phase headers render',
    ['1/4', '2/4', '3/4', '4/4'].every(n => w.out.includes('▶ ' + n)));
  ck('the four ✓ verdicts render',
    ['1/4 external apps allowed', '2/4 storage access granted',
     '3/4 packages ready', '4/4 workspace ready'].every(v => w.out.includes('✓ ' + v)));
  ck('the completion line renders (the pinned exact text)',
    w.out.includes('doomalay termux setup complete — return to the Doomalay app'));
  ck('no stray spinner after done (the block is gone at exit)',
    !/\[█░+\][^\x1b]*$/.test(w.out.slice(-200)));

  // the SAFE variant — the user's ask: the note only when leaving is safe
  const s = run([SH, '--render-demo'], { DM_DEMO_SAFE: '1', DM_COLS: '60' });
  ck('the safe demo exits 0', s.status === 0);
  const safeN = (s.out.match(/it's ok to go back to the app now/g) || []).length;
  const holdN = (s.out.match(/please wait — keep Termux open/g) || []).length;
  const dlgN = (s.out.match(/please wait — tap "Allow"/g) || []).length;
  ck('the safe note rides the autonomous phases', safeN >= 3, safeN);
  ck('zero hold notes when the wake lock is held', holdN === 0, holdN);
  ck('phase ② STILL says please wait (the dialog is interactive)', dlgN >= 1, dlgN);

  // the narrow portrait — Termux's real width, measured on the RENDERED
  // screen across every frame (the emulator applies cursor-up + erase the
  // way a real terminal does, so no raw-byte interleaving lies)
  const n = run([SH, '--render-demo'], { DM_COLS: '39' });
  ck('the narrow demo exits 0', n.status === 0);
  const nar = emulate(n.out);
  ck('narrow: no RENDERED bar line ever overflows 39 columns',
    nar.barShapes.length > 0 && nar.maxBarLen <= 39, nar.maxBarLen);
  const nCells = [...nar.barShapes.join('\n').matchAll(/· \[([█░]+)\]/g)].map(m => m[1].length);
  ck('narrow: cells shrink but never below 8',
    nCells.length > 0 && nCells.every(c => c >= 8 && c < 20), [...new Set(nCells)].join(','));
  ck('narrow: the elapsed drops before the bar does',
    nar.barShapes.every(l => !/· \d+s$/.test(l.trim())));
  // the wide demo's bar, measured the same way (statics soft-wrap —
  // terminal-natural — so the width law is the bar's alone)
  const wEm = emulate(w.out);
  ck('wide: no RENDERED bar line ever overflows 60 columns',
    wEm.maxBarLen <= 60, wEm.maxBarLen);
  const wCells = [...wEm.barShapes.join('\n').matchAll(/· \[([█░]+)\]/g)].map(m => m[1].length);
  ck('wide: 20 cells on every frame', wCells.length > 0 && wCells.every(c => c === 20),
    [...new Set(wCells)].join(','));
})();

console.log('v1.24.1 — the plain-mode degradation (piped output, real script, empty PATH extras):');
(function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-plain-'));
  const r = run([SH], { HOME: home, PATH: '/usr/bin:/bin', DM_COLS: '' }, 60000);
  ck('the plain run exits 0', r.status === 0, r.out.slice(0, 300));
  ck('plain: ZERO escape sequences', !/\x1b\[/.test(r.out));
  ck('plain: the ▶/✓ ladder prints through',
    r.out.includes('▶ 1/4') && r.out.includes('✓ 4/4 workspace skipped') === false &&
    /✓ [1-4]\/4/.test(r.out));
  ck('plain: the missing pkg is honest + non-fatal',
    r.out.includes('pkg not found — skipping package updates (non-fatal)'));
  ck('plain: the missing storage command is honest + non-fatal',
    r.out.includes('termux-setup-storage not found — storage stays off (non-fatal)'));
  ck('plain: the completion line still lands',
    r.out.includes('doomalay termux setup complete — return to the Doomalay app'));
  ck('plain: the props write landed inside the temp HOME (nothing leaked)',
    fs.readFileSync(path.join(home, '.termux', 'termux.properties'), 'utf8').includes('allow-external-apps = true'));
  fs.rmSync(home, { recursive: true, force: true });
})();

console.log('v1.24.1 — THE LIVE HARNESS (the real script under a pty, stubbed Termux, real checkin server):');
(async function () {
  // the checkin server: records the query it was hit with
  let checkinQuery = '';
  const srv = http.createServer((req, res) => {
    checkinQuery = req.url || '';
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  // the stub dir: the Termux commands + pkg + curl, all recording
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-stub-'));
  const rec = path.join(stub, 'events.log');
  const stubs = {
    'termux-wake-lock': '#!/bin/bash\necho lock >> ' + JSON.stringify(rec) + '\n',
    'termux-wake-unlock': '#!/bin/bash\necho unlock >> ' + JSON.stringify(rec) + '\n',
    'termux-reload-settings': '#!/bin/bash\necho reload >> ' + JSON.stringify(rec) + '\n',
    'termux-setup-storage': '#!/bin/bash\necho storage >> ' + JSON.stringify(rec) + '\nmkdir -p "$HOME/storage/shared"\n',
    'pkg': '#!/bin/bash\necho "pkg $*" >> ' + JSON.stringify(rec) + '\necho "Get:2 https://packages-cf.termux.dev/apt/termux-main Packages [2,345 kB]"\nsleep 1\necho "Fetched 9,812 kB in 4s (2,451 kB/s)"\nexit 0\n',
    'curl': '#!/bin/bash\necho "curl $*" >> ' + JSON.stringify(rec) + '\nexec /usr/bin/curl "$@"\n'
  };
  for (const [name, body] of Object.entries(stubs)) {
    const p = path.join(stub, name);
    fs.writeFileSync(p, body); fs.chmodSync(p, 0o755);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-live-'));

  // run the REAL script under a real pty via `script` (the TTY branch lives).
  // ASYNC on purpose: the in-process checkin server needs the event loop
  // alive while the pty run blocks — a spawnSync here would freeze the
  // server and the checkin curl would time out (the first conviction of
  // this rig, fixed by construction).
  const checkin = 'http://127.0.0.1:' + port + '/checkin';
  let ptyRun;
  try {
    const r = await execFileP('script', ['-qec',
      `bash '${SH}' --checkin '${checkin}'`, '/dev/null'], {
      timeout: 90000, maxBuffer: 32 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        HOME: home, PATH: stub + ':/usr/bin:/bin', TERM: 'xterm-256color'
      })
    });
    ptyRun = { status: 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    ptyRun = { status: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
  const out = ptyRun.stdout || '';
  ck('the live run exits 0', ptyRun.status === 0, (ptyRun.stderr || '').slice(0, 200));
  ck('live: the bar drew under a real pty (cursor-up frames)', (out.match(/\x1b\[1A/g) || []).length >= 5);
  ck('live: the wake lock was ACQUIRED', fs.readFileSync(rec, 'utf8').includes('lock'));
  ck('live: the wake lock was RELEASED at exit (never leaks)', fs.readFileSync(rec, 'utf8').includes('unlock'));
  ck('live: the storage stub ran + ~/storage went live', fs.existsSync(path.join(home, 'storage', 'shared')));
  ck('live: the workspace dir was created', fs.existsSync(path.join(home, 'storage', 'shared', 'Doomalay')));
  ck('live: pkg ran update + coreutils', /pkg update -y/.test(fs.readFileSync(rec, 'utf8')) &&
    /pkg install -y coreutils/.test(fs.readFileSync(rec, 'utf8')));
  ck('live: the checkin curl landed with the two honest flags',
    checkinQuery.includes('storage=1') && checkinQuery.includes('props=1'), checkinQuery);
  ck('live: the props write landed in the temp HOME',
    fs.readFileSync(path.join(home, '.termux', 'termux.properties'), 'utf8').includes('allow-external-apps = true'));
  ck('live: the pinned completion line rendered', out.includes('doomalay termux setup complete'));
  ck('live: the notified line rendered', out.includes('doomalay app notified — setup state is live'));

  srv.close();
  fs.rmSync(stub, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });

  console.log(`\nTHE TERMINAL PULSE battery: ${pass}/${total}`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => { console.error('harness crashed:', e); process.exit(1); });
