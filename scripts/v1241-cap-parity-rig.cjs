#!/usr/bin/env node
// v1241-cap-parity-rig.cjs — v1.24.1 THE TERMUX PILL PARITY (PLAN-V125 §1).
//
// The user's law: once Termux is set up, the row speaks the SAME pill the
// other rows speak — the description stays STATIC ("what this row is") and
// the chip flips on/off with the stack state; the mutating
// "stacked/tap-to-stack" sub lines are dead.
//
//   · the chip matrix (unready → 'set up…'; ready → on/off from the state)
//   · the sub never moves (unready, ready, stacked — one string)
//   · the other rows are untouched (library toggle, workspaces count,
//     persona) — the parity change is scoped to the termux row
//   · the tap flow source contracts (flip → persist → repaint — unchanged
//     machinery; the unready tap still opens the setup ladder)

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log('  PASS ' + name); }
  else console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
}

const caps = require(path.join(WEB, 'capabilities.js'));
const STATIC_SUB = 'local Linux sandbox (commands, package installs, local storage)';

// ── 1. THE CHIP MATRIX ─────────────────────────────────────────────────
console.log('v1.24.1 THE TERMUX PILL PARITY — the chip matrix:');
{
  const un = caps.rowsFor({}, { termux: { available: true, ready: false } }).find(r => r.key === 'termux');
  ck('unready → setup chip', caps.chipFor(un).cls === 'setup' && caps.chipFor(un).text === 'set up…',
    JSON.stringify(caps.chipFor(un)));

  const off = caps.rowsFor({ termux: false }, { termux: { available: true, ready: true } }).find(r => r.key === 'termux');
  ck('ready + unstacked → off chip', caps.chipFor(off).cls === 'off' && caps.chipFor(off).text === 'off',
    JSON.stringify(caps.chipFor(off)));

  const on = caps.rowsFor({ termux: true }, { termux: { available: true, ready: true } }).find(r => r.key === 'termux');
  ck('ready + stacked → on chip', caps.chipFor(on).cls === 'on' && caps.chipFor(on).text === 'on',
    JSON.stringify(caps.chipFor(on)));
}

// ── 2. THE SUB NEVER MOVES ─────────────────────────────────────────────
console.log('the static-sub law:');
{
  [false, true].forEach(function (ready) {
    [false, true].forEach(function (stacked) {
      const row = caps.rowsFor({ termux: stacked }, { termux: { available: true, ready: ready } })
        .find(r => r.key === 'termux');
      ck('sub is static (ready=' + ready + ', stacked=' + stacked + ')', row.sub === STATIC_SUB, row.sub);
    });
  });
  const src = fs.readFileSync(path.join(WEB, 'capabilities.js'), 'utf8');
  ck('the mutating sub lines are dead in source',
    src.indexOf('tap to stack on this chat') < 0 && src.indexOf('stacked on this chat') < 0);
}

// ── 3. THE OTHER ROWS UNTOUCHED (parity is scoped) ─────────────────────
console.log('the other rows keep their own law:');
{
  const rows = caps.rowsFor({ libAuto: true }, { personaName: 'Lippy', wsCount: 2, termux: { available: true, ready: true } });
  const lib = rows.find(r => r.key === 'lib_auto');
  ck('library toggle still on/off', caps.chipFor(lib).text === 'on' && caps.chipFor({ kind: 'toggle', on: false }).text === 'off');
  const ws = rows.find(r => r.key === 'workspaces');
  ck('workspaces count chip untouched', ws.chip.text === '2 bound', ws.chip.text);
  const p = rows.find(r => r.key === 'persona');
  ck('persona chip untouched', p.chip.text === 'set', p.chip.text);
  ck('row order preserved: lib → workspaces → termux → persona',
    ['lib_auto', 'workspaces', 'termux', 'persona'].every(function (k, i) { return rows[i].key === k; }),
    rows.map(r => r.key).join(','));
}

// ── 4. THE TAP FLOW (source contracts — machinery unchanged) ───────────
console.log('the tap flow:');
{
  const src = fs.readFileSync(path.join(WEB, 'capabilities.js'), 'utf8');
  ck('the ready tap flips st.termux (not the setup open)', src.indexOf('st.termux = !st.termux;') >= 0);
  ck('the unready tap still opens the setup ladder', src.indexOf('openTermuxSetup(ctx, extras);') >= 0);
  ck('the flip persists + repaints in place', /st\.termux = !st\.termux;\s*\n\s*persist\(ctx\);\s*\n\s*repaintTermuxRow\(ctx, extras\);/.test(src));
  ck('the row DOM renders the chip via chipFor (the parity flows through rowHTML)',
    src.indexOf("chipHTML(row)") >= 0 && src.indexOf('cap-chip-') >= 0);
  ck('the CSS knows on/off/setup (theme vars only)',
    src.indexOf('.cap-chip.on') >= 0 && src.indexOf('.cap-chip.off') >= 0 && src.indexOf('.cap-chip.setup') >= 0);
}

console.log('\n' + (pass === total ? 'ALL ' + total + ' PASS' : (total - pass) + ' FAIL of ' + total));
process.exit(pass === total ? 0 : 1);
