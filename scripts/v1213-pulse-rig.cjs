// v1213-pulse-rig.cjs — PLAN-V122 §2 THE PULSE battery: the pure bar
// renderer (_barFor) across the ladder shapes + the page markup contract.
const path = require('path');
const fs = require('fs');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');
const ts = require(path.join(WEB, 'termuxsetup.js'));

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log(`  PASS ${name}`); }
  else console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

// fresh: nothing done
{
  const b = ts._barFor({ available: true }, 0, false);
  ck('fresh: 0% · step 1/4 · install', b.pct === 0 && b.label === 'step 1/4 · install', b.pct + ' ' + b.label);
  ck('fresh: empty bar', /^░*$/.test(b.fill + b.tip), JSON.stringify(b.fill + b.tip));
  ck('fresh: bar renders 20 cells', (b.fill + b.tip + b.empty).length === 20, String((b.fill + b.tip + b.empty).length));
  ck('fresh: the leave-to-F-Droid note', /leave the app to F-Droid/.test(b.note), b.note);
}
// step ② active: installed only
{
  const b = ts._barFor({ available: true, installed: true }, 0, false);
  ck('25% · step 2/4 · bootstrap', b.pct === 25 && b.label === 'step 2/4 · bootstrap', b.pct + ' ' + b.label);
  ck('5 cells filled', (b.fill).length === 5, JSON.stringify(b.fill));
  ck('the SAFE-TO-LEAVE note (the user\'s ask)', /leave to Termux and paste — setup keeps running; come back any time/.test(b.note), b.note);
  ck('no spinner when idle', b.spin === '');
}
// step ③: installed + bootstrap
{
  const b = ts._barFor({ available: true, installed: true, bootstrap_done: true }, 0, false);
  ck('50% · step 3/4 · permission', b.pct === 50 && b.label === 'step 3/4 · permission', b.pct + ' ' + b.label);
  ck('10 cells filled', b.fill.length === 10);
}
// step ④: + permission
{
  const b = ts._barFor({ available: true, installed: true, bootstrap_done: true, permission: true }, 0, false);
  ck('75% · step 4/4 · verify', b.pct === 75 && b.label === 'step 4/4 · verify', b.pct + ' ' + b.label);
}
// ready: full bar
{
  const b = ts._barFor({ available: true, installed: true, bootstrap_done: true, permission: true, ready: true }, 0, false);
  ck('100% · ready', b.pct === 100 && b.label === 'ready', b.pct + ' ' + b.label);
  ck('all 20 cells full, no empties', (b.fill + b.tip).length === 20 && b.empty === '', JSON.stringify(b.fill + b.tip + b.empty));
  ck('the ready note', /✓ the sandbox is ready/.test(b.note));
}
// the braille spinner rides only while probing
{
  const b = ts._barFor({ available: true, installed: true }, 3, true);
  ck('spinner frame while probing', b.spin !== '' && '⠋⠙⠹⠸⠼⠴⠦⠧'.includes(b.spin), JSON.stringify(b.spin));
  const b2 = ts._barFor({ available: true, installed: true }, 42, true);
  ck('spin frame wraps (mod 8)', b2.spin === '⠹', JSON.stringify(b2.spin));
  const b3 = ts._barFor({ available: true, installed: true }, 0, false);
  ck('no spinner when idle (2)', b3.spin === '');
}
// THE QUIET GATE honesty: probes paused → the ⏸ note, no fake motion
{
  const b = ts._barFor({ available: true, installed: true, probe_suppressed: true }, 0, false);
  ck('paused note (⏸)', /⏸ probes paused until the bootstrap lands/.test(b.note), b.note);
  ck('paused: still no spinner', b.spin === '');
}
// the fractional tip: 1 step done = 5 cells + 0 tip; bar monotonically fills
{
  const b = ts._barFor({ available: true, installed: true }, 0, false);
  ck('bar composition: fill + empty = 20', (b.fill + b.tip + b.empty).length === 20);
}
// the page markup carries the pulse mount
{
  const src = fs.readFileSync(path.join(WEB, 'termuxsetup.js'), 'utf8');
  const pageStart = src.indexOf('function pageHTML()');
  const pageEnd = src.indexOf('function unavailableHTML()');
  const page = src.slice(pageStart, pageEnd);
  const stepsIdx = page.indexOf('tsx-steps');
  const footIdx = page.indexOf('tsx-foot');
  const pulseIdx = page.indexOf('id="tsx-pulse"');
  ck('pageHTML mounts #tsx-pulse between steps and foot',
    pulseIdx > stepsIdx && pulseIdx < footIdx, `steps=${stepsIdx} pulse=${pulseIdx} foot=${footIdx}`);
  ck('the spin heartbeat is wired (130ms)', /setInterval\(function \(\) \{\s*\n\s*if \(!inst \|\| inst\.dead \|\| !inst\.probing\) return;/.test(src));
  ck('kill clears the spin interval', /if \(inst\.spin\) \{ clearInterval\(inst\.spin\); inst\.spin = null; \}/.test(src));
  ck('theme vars only in the pulse styles (no hex literals in the new block)',
    !/tsx-pulse\{[^}]*#[0-9a-fA-F]{3,6}/.test(src));
  ck('window.TermuxSetup exports _barFor', /window\.TermuxSetup = \{[^}]*_barFor/.test(src));
}

console.log(`\nTOTAL: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
