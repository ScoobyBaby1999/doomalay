#!/usr/bin/env node
// v1361-ledger-rig.mjs — v1.35.1 THE PENDING LEDGER (PLAN-V136 §v1.35.1).
// The real script under a controlled sandbox: stubbed pkg/curl/termux tools,
// a sandboxed $HOME, a real checkin HTTP server. Convictions:
//   S1  the OFFLINE setup writes the ledger (pkgs=pending) + resume.sh,
//       banners honestly, and checkins with the third flag pkgs=0
//   S2  the OFFLINE resume is a fast no-op (seconds, ledger untouched,
//       no checkin bell — the probe is the law)
//   S3  the ONLINE resume completes the pending steps (ledger pkgs=ok)
//       + the bell rides (resume=1&pkgs=1)
//   S4  the ONLINE setup writes the all-ok ledger + the byte-exact banner
//   S5  the still-failing online resume stays honest (pkgs=pending again,
//       bell pkgs=0)
//   S6  the render demo touches NOTHING (no ledger dir, either shape)
//   S7  source pins: the ledger machinery, the heredoc resume, the atomic
//       writes, the third checkin flag, the re-pointed v1241 contract
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const SH = path.join(ROOT, 'termux', 'setup.sh');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

// ── the sandbox: a fake $HOME + a stub bin dir ─────────────────
function makeSandbox(t, { online, pkgWorks }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1361-home-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);

  // curl stub: mirrors answer per `online`; /checkin* URLs are recorded
  const curlHits = [];
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/usr/bin/env node\n` +
    `const url = process.argv.filter(a => a.startsWith('http'))[0] || '';\n` +
    `if (url.includes('/checkin')) {\n` +
    `  require('fs').appendFileSync(${JSON.stringify(path.join(home, 'curl-hits.log'))}, url + '\\n');\n` +
    `  process.exit(0);\n}\n` +
    `process.exit(${online ? 0 : 7});\n`);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);

  // pkg stub: succeeds or fails per `pkgWorks` (apt-like exit codes)
  fs.writeFileSync(path.join(bin, 'pkg'),
    `#!/usr/bin/env node\nprocess.exit(${pkgWorks ? 0 : 100});\n`);
  fs.chmodSync(path.join(bin, 'pkg'), 0o755);

  // the termux tool stubs (the setup flow's non-network surfaces)
  for (const tool of ['termux-wake-lock', 'termux-wake-unlock', 'termux-reload-settings']) {
    fs.writeFileSync(path.join(bin, tool), '#!/usr/bin/env node\nprocess.exit(0);\n');
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  // termux-setup-storage: "grants" storage (creates ~/storage/shared)
  fs.writeFileSync(path.join(bin, 'termux-setup-storage'),
    `#!/usr/bin/env node\n` +
    `require('fs').mkdirSync(${JSON.stringify(path.join(home, 'storage', 'shared'))}, { recursive: true });\n` +
    `process.exit(0);\n`);
  fs.chmodSync(path.join(bin, 'termux-setup-storage'), 0o755);

  return { home, bin, curlLog: path.join(home, 'curl-hits.log') };
}

function runSetup(sb, args) {
  const env = {
    ...process.env,
    HOME: sb.home,
    PATH: sb.bin + ':' + (process.env.PATH || ''),
    DM_COLS: '60',
  };
  return spawnSync('bash', [SH, ...args], { env, encoding: 'utf8', timeout: 60000 });
}

const ledgerOf = (sb) => {
  try { return fs.readFileSync(path.join(sb.home, '.doomalay-setup', 'state'), 'utf8'); }
  catch { return ''; }
};
// the checkin bell is heard through the STUB's own record (the stub curl
// never opens a real socket — the server below exists for a future rig)
const bellsOf = (sb) => {
  try { return fs.readFileSync(sb.curlLog, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
};

// ── the real checkin server (records the exact query) ──────────
const checkinQueries = [];
const srv = http.createServer((req, res) => {
  checkinQueries.push(req.url || '');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const checkinURL = 'http://127.0.0.1:' + srv.address().port + '/' +
  crypto.randomUUID() + '/checkin';

console.log('v1.35.1 THE PENDING LEDGER — the real script, sandboxed:');

// ── S1: the OFFLINE setup — ledger + resume.sh + honest banner ──
{
  const sb = makeSandbox(null, { online: false, pkgWorks: false });
  const r = runSetup(sb, ['--checkin', checkinURL]);
  const led = ledgerOf(sb);
  const resumePath = path.join(sb.home, '.doomalay-setup', 'resume.sh');
  ok('S1: the run completes (exit 0) despite the offline pkg', r.status === 0, 'exit=' + r.status);
  ok('S1: the ledger records pkgs=pending', led.includes('pkgs=pending'), JSON.stringify(led));
  ok('S1: the ledger records the storage truth (the stub grants)', led.includes('storage=granted'), JSON.stringify(led));
  ok('S1: the ledger records the workspace truth', led.includes('workspace=ok'), JSON.stringify(led));
  ok('S1: resume.sh exists + is executable',
    fs.existsSync(resumePath) && (fs.statSync(resumePath).mode & 0o111) !== 0);
  ok('S1: the baked checkin URL rides its own file',
    fs.readFileSync(path.join(sb.home, '.doomalay-setup', 'checkin'), 'utf8').includes(checkinURL));
  ok('S1: the pending banner is honest (the app finishes it automatically)',
    r.stdout.includes('1 step pending: packages') &&
    r.stdout.includes('the Doomalay app finishes this automatically'));
  ok('S1: the pending banner keeps the completion prefix (the v1.24.1 contract)',
    r.stdout.includes('doomalay termux setup complete'));
  ok('S1: the checkin bell carries pkgs=0 (the third honest flag)',
    bellsOf(sb).some(q => q.includes('props=1') && q.includes('pkgs=0')),
    JSON.stringify(bellsOf(sb)));

  // ── S1b: the storage-DENIED shape — the ledger says where things stand ──
  const sbb = makeSandbox(null, { online: false, pkgWorks: false });
  // the denied stub: exits 1, creates nothing
  fs.writeFileSync(path.join(sbb.bin, 'termux-setup-storage'),
    '#!/usr/bin/env node\nprocess.exit(1);\n');
  const rb = runSetup(sbb, ['--checkin', checkinURL]);
  ok('S1b: the denied-storage run still completes', rb.status === 0);
  ok('S1b: the ledger says storage=missing + workspace=skipped',
    ledgerOf(sbb).includes('storage=missing') && ledgerOf(sbb).includes('workspace=skipped'),
    JSON.stringify(ledgerOf(sbb)));

  // ── S2: the OFFLINE resume — a fast, harmless no-op ──
  const ledBefore = led;
  const t0 = Date.now();
  const rr = spawnSync('bash', [resumePath, '--checkin', checkinURL], {
    env: { ...process.env, HOME: sb.home, PATH: sb.bin + ':' + (process.env.PATH || '') },
    encoding: 'utf8', timeout: 30000,
  });
  const dt = Date.now() - t0;
  ok('S2: the offline resume exits 0 fast (the probe is the law)',
    rr.status === 0 && dt < 15000, 'exit=' + rr.status + ' dt=' + dt + 'ms');
  ok('S2: the offline resume leaves the ledger untouched',
    ledgerOf(sb) === ledBefore);
  ok('S2: the offline resume fires NO bell', bellsOf(sb).length === 1,
    // exactly the ONE setup checkin, none from the resume
    JSON.stringify(bellsOf(sb)));

  // ── S3: the network returns — the ONLINE resume finishes it ──
  // (a fresh sandbox bin with online curl + a WORKING pkg)
  const sb2 = makeSandbox(null, { online: true, pkgWorks: true });
  // copy the ledger + resume.sh + checkin from the offline device shape
  fs.mkdirSync(path.join(sb2.home, '.doomalay-setup'), { recursive: true });
  fs.copyFileSync(path.join(sb.home, '.doomalay-setup', 'state'), path.join(sb2.home, '.doomalay-setup', 'state'));
  fs.copyFileSync(path.join(sb.home, '.doomalay-setup', 'resume.sh'), path.join(sb2.home, '.doomalay-setup', 'resume.sh'));
  fs.copyFileSync(path.join(sb.home, '.doomalay-setup', 'checkin'), path.join(sb2.home, '.doomalay-setup', 'checkin'));
  checkinQueries.length = 0;
  const rr2 = spawnSync('bash', [path.join(sb2.home, '.doomalay-setup', 'resume.sh'), '--checkin', checkinURL], {
    env: { ...process.env, HOME: sb2.home, PATH: sb2.bin + ':' + (process.env.PATH || '') },
    encoding: 'utf8', timeout: 30000,
  });
  ok('S3: the online resume exits 0', rr2.status === 0, 'exit=' + rr2.status);
  ok('S3: the ledger flips to pkgs=ok', ledgerOf(sb2).includes('pkgs=ok'), JSON.stringify(ledgerOf(sb2)));
  ok('S3: the bell rides (resume=1&pkgs=1)',
    bellsOf(sb2).some(q => q.includes('resume=1') && q.includes('pkgs=1')),
    JSON.stringify(bellsOf(sb2)));

  // ── S5: the resume with the network up but pkg STILL failing ──
  const sb3 = makeSandbox(null, { online: true, pkgWorks: false });
  fs.mkdirSync(path.join(sb3.home, '.doomalay-setup'), { recursive: true });
  fs.copyFileSync(path.join(sb.home, '.doomalay-setup', 'state'), path.join(sb3.home, '.doomalay-setup', 'state'));
  fs.copyFileSync(path.join(sb.home, '.doomalay-setup', 'resume.sh'), path.join(sb3.home, '.doomalay-setup', 'resume.sh'));
  checkinQueries.length = 0;
  const rr3 = spawnSync('bash', [path.join(sb3.home, '.doomalay-setup', 'resume.sh')], {
    env: { ...process.env, HOME: sb3.home, PATH: sb3.bin + ':' + (process.env.PATH || '') },
    encoding: 'utf8', timeout: 30000,
  });
  ok('S5: the still-failing resume exits 0 (non-fatal law)', rr3.status === 0);
  ok('S5: the ledger stays honest (pkgs=pending)',
    ledgerOf(sb3).includes('pkgs=pending'), JSON.stringify(ledgerOf(sb3)));
  ok('S5: no bell without a handed/baked URL', bellsOf(sb3).length === 0,
    JSON.stringify(bellsOf(sb3)));
}

// ── S4: the ONLINE setup — all-ok ledger + the byte-exact banner ──
{
  const sb = makeSandbox(null, { online: true, pkgWorks: true });
  const r = runSetup(sb, ['--checkin', checkinURL]);
  ok('S4: the online setup completes', r.status === 0);
  ok('S4: the ledger is all-ok', ledgerOf(sb).includes('pkgs=ok'), JSON.stringify(ledgerOf(sb)));
  ok('S4: the banner is byte-exact (the v1.24.1 contract)',
    r.stdout.includes('doomalay termux setup complete — return to the Doomalay app'));
  ok('S4: the checkin carries pkgs=1',
    bellsOf(sb).some(q => q.includes('pkgs=1')), JSON.stringify(bellsOf(sb)));
}

// ── S6: the render demo touches NOTHING (both shapes) ──────────
{
  for (const pending of [false, true]) {
    const sb = makeSandbox(null, { online: false, pkgWorks: false });
    const env = {
      ...process.env, HOME: sb.home, PATH: sb.bin + ':' + (process.env.PATH || ''),
      DM_COLS: '60', DM_DEMO_PENDING: pending ? '1' : '',
    };
    spawnSync('bash', [SH, '--render-demo'], { env, encoding: 'utf8', timeout: 60000 });
    ok('S6: the render demo writes no ledger (pending=' + pending + ')',
      !fs.existsSync(path.join(sb.home, '.doomalay-setup')));
  }
}

// ── S7: the source pins (the machinery, the additive contract) ──
{
  const sh = fs.readFileSync(SH, 'utf8');
  ok('S7: the ledger lives at ~/.doomalay-setup/state',
    sh.includes('.doomalay-setup') && sh.includes('state'));
  ok('S7: ledger writes are atomic (tmp + mv)',
    sh.includes('> "${DM_LEDGER}.tmp"') && sh.includes('mv -f "${DM_LEDGER}.tmp" "$DM_LEDGER"'));
  ok('S7: resume.sh is generated by a quoted heredoc (no expansion)',
    sh.includes("<<'RESUME_EOF'"));
  ok('S7: the resume probe is self-bounded (max-time + connect-timeout, no timeout dep)',
    sh.includes('--max-time 6 --connect-timeout 5'));
  ok('S7: the checkin carries the third honest flag',
    sh.includes('&pkgs=${__pkgs_flag}'));
  // the resume heredoc body must NOT contain the interactive dialog command
  // (the storage permission is never auto-retried — PLAN-V136 spaghetti line)
  const resumeStart = sh.indexOf("<<'RESUME_EOF'");
  const resumeEnd = sh.indexOf('RESUME_EOF', resumeStart + 14);
  const resumeBody = sh.slice(resumeStart, resumeEnd);
  ok('S7: the storage permission is NEVER auto-retried (no setup-storage in resume.sh)',
    !resumeBody.includes('termux-setup-storage'));
}

srv.close();
console.log('\nv1361 ledger rig: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
