#!/usr/bin/env node
// v1363-pending-ui-rig.mjs — v1.35.3 THE HONEST READY (PLAN-V136 §v1.35.3).
// The setup page's pure functions under node (the v1173 export path):
//   U1  the ready card tells the WHOLE truth when a ledger is pending —
//       the automatic-completion line + the `finish setup now` button —
//       and stays silent (no pending line) when it is not
//   U2  the companion-app teach + the live-state line ride untouched (the
//       v1290/v1.33.3 pins hold — additive law)
//   U3  the ladder teaches the pending state on the bootstrap row's own
//       diagnostic slot (a state, never an error tone) — and keeps the
//       quiet-gate + props teachings primary when they apply
//   U4  the wiring pins: the online listener arms one forced fetch and dies
//       with the instance; the finish button POSTs /api/termux/resume and
//       never rebuilds the page (textContent in place)
//   U5  the theme-vars law: the new card line rides var(--surface-1) etc.,
//       zero hardcoded colors
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsxPath = process.cwd() + '/engine/internal/server/web/termuxsetup.js';
const tsx = require(tsxPath);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

const READY_BASE = {
  available: true, installed: true, api_installed: false, permission: true,
  bridge_ok: true, storage_ok: true, props_ok: true, ready: true,
  bootstrap_done: true, checkin_storage: true, checkin_props: true,
};

console.log('v1.35.3 THE HONEST READY — the pending shapes:');

// ── U1: the card's whole truth ─────────────────────────────────
{
  const pending = tsx._readyCardFor({ ...READY_BASE, pkgs_pending: true }, false);
  ok('U1: the pending card names the automatic completion',
    /packages finish installing when you're back online — this completes automatically/.test(pending));
  ok('U1: the pending card carries the finish button',
    /id="tsx-btn-pkgs"/.test(pending) && /finish setup now/.test(pending));
  ok('U1: the pending card still lands the ready title (the shell works NOW)',
    /Termux is ready/.test(pending));

  const clean = tsx._readyCardFor({ ...READY_BASE }, false);
  ok('U1: the clean card carries NO pending line',
    !/tsx-ready-pkgs/.test(clean) && !/finish setup now/.test(clean));

  const paid = tsx._readyCardFor({ ...READY_BASE, pkgs_pending: false }, false);
  ok('U1: pkgs_pending=false reads as the clean card',
    !/finish setup now/.test(paid));
}

// ── U2: the v1290/v1.33.3 pins hold untouched ──────────────────
{
  const pending = tsx._readyCardFor({ ...READY_BASE, pkgs_pending: true }, false);
  ok('U2: the companion-app teach survives (both pieces)',
    /Termux:API companion app/.test(pending) && /pkg install termux-api/.test(pending));
  const live = tsx._readyCardFor({ ...READY_BASE, pkgs_pending: true, api_installed: true }, false);
  ok('U2: the live-state line survives (device commands live — battery · wifi ·)',
    /device commands live — battery · wifi ·/.test(live));
  ok('U2: the api_installed=true voice survives',
    /device commands live — battery · wifi ·/.test(live));
}

// ── U3: the ladder's pending teach ─────────────────────────────
{
  const withPending = tsx._stepStates({
    ...READY_BASE, ready: true, pkgs_pending: true,
  });
  ok('U3: the bootstrap row teaches the pending state when it is done',
    /packages pending \(no network at bootstrap\)/.test(withPending.steps[1].error || ''));
  ok('U3: the ladder still reports ready (the shell works)',
    withPending.ready === true);

  const gatedLadder = tsx._stepStates({
    ...READY_BASE, ready: false, permission: false, props_ok: false, pkgs_pending: true,
  });
  ok('U3: the props teaching stays primary over the pending note',
    /allow-external-apps is still off/.test(gatedLadder.steps[1].error || '') &&
    !/packages pending/.test(gatedLadder.steps[1].error || ''));

  const noPending = tsx._stepStates({ ...READY_BASE, ready: true });
  ok('U3: no pending → no teach on the bootstrap row',
    (noPending.steps[1].error || '') === '');
}

// ── U4: the wiring pins (source-level — the DOM lives in the PWA) ──
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(tsxPath, 'utf8');
  ok('U4: the online listener arms ONE forced fetch',
    /addEventListener\('online', inst\.onOnline\)/.test(src) &&
    /fetchStatus\(inst, true\);\s*\n\s*\};\s*\n\s*window\.addEventListener\('online'/.test(src));
  ok('U4: the online listener dies with the instance (no leaks)',
    /removeEventListener\('online', inst\.onOnline\)/.test(src));
  ok('U4: the online listener stands down when the card latched',
    /if \(inst\.dead \|\| inst\.halted \|\| inst\.ready\) return;\s*\n\s*if \(!window\.ConnectOverlay\.isOpen\(\)\) return;\s*\n\s*fetchStatus\(inst, true\);/.test(src));
  ok('U4: the finish button POSTs the resume executor',
    /postJSON\('\/api\/termux\/resume', \{\}\)/.test(src));
  ok('U4: the pending line flips IN PLACE (textContent, never innerHTML)',
    /line\.textContent = txt;/.test(src) &&
    /line\.textContent = 'packages ready ✓ — everything the offline setup owed is paid';/.test(src) &&
    !/tsx-ready-pkgs"\)\.innerHTML/.test(src));
  ok('U4: the ready latch waits for the FULL truth (the pending card keeps polling)',
    /var fullReady = s\.ready && status\.pkgs_pending !== true;/.test(src) &&
    /if \(fullReady\) inst\.ready = true;/.test(src));
  ok('U4: the card path wires BOTH ready and pending handlers',
    /onSwap: function \(\) \{ wireReady\(inst\); wirePending\(inst\); \}/.test(src));
}

// ── U5: the theme-vars law (zero hardcoded colors) ─────────────
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(tsxPath, 'utf8');
  const pkgsRule = src.match(/\.tsx-ready-pkgs\{[^}]*\}/);
  ok('U5: the pending line rule exists and rides the theme vars',
    !!pkgsRule && /var\(--surface-1\)/.test(pkgsRule[0]) && /var\(--text-2\)/.test(pkgsRule[0]) &&
    /var\(--border\)/.test(pkgsRule[0]));
  const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok('U5: no hardcoded hex colors anywhere in the file',
    hex.length === 0, JSON.stringify(hex.slice(0, 5)));
  const rgb = (src.match(/rgba?\(\s*[0-9]/g) || []).filter(m => !m.startsWith('rgba(var'));
  ok('U5: no hardcoded rgb() colors (rgba(var(--…)) is the legal family)',
    rgb.length === 0, JSON.stringify(rgb.slice(0, 5)));
}

console.log('\nv1363 pending-ui rig: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
