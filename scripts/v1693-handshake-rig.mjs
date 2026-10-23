#!/usr/bin/env node
// v1693-handshake-rig.mjs — v1.69.3 THE SHARED CANVAS · THE HANDSHAKE,
// the LIVE proof against the REAL engine binary: the full pairing arc
// (mint → claim → poll → THE TAP → the token) + the live room on the
// credential + THE GATED PORTALS + THE REVOCATION (the socket dies
// mid-stream). The legs:
//
//   LEG A — THE HANDSHAKE ARC: the owner mints (a 6-digit code); the
//           joiner claims (a foreign device, no credential — the pair
//           path serves exactly this); the poll says pending; THE TAP;
//           the poll answers approved with the token + device; a second
//           poll CONVERGES (the deterministic mint); the wrong code
//           answers the honest miss (404 — no oracle).
//
//   LEG B — THE CREDENTIALED ROOM: the token joins the LIVE WS; the
//           guest's op submits fold + broadcast; THE AUTHOR LAW (the
//           credential names the author — a spoofed body device never
//           lands); the guest reads /doc with the token.
//
//   LEG C — THE GATED PORTALS: a hole to an UNSEEN canvas is unknown to
//           the guest (filtered from /doc); the owner sees it; a hole
//           to the SHARED canvas itself rides through.
//
//   LEG D — THE REVOCATION: with the guest LIVE in the room, the owner
//           revokes → the guest's socket dies mid-stream → the token
//           401s on every surface; the roster no longer names the device.
//
// Honesty law: every assertion binds to the tool's own frames.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8693;
const ENGINE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/v1693-data';
const CFG = '/tmp/v1693-config.yaml';
const OWNER_BEARER = 'rig-owner-secret-token';

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// owner requests carry the global bearer; guest requests carry NOTHING
// (or a device token in the query) — the deployment law the tunnel
// demands (auth_token set → the loopback trust is DEAD → the ACL bites).
async function api(method, p, body, bearer) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  if (bearer) { init.headers = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + bearer }); }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}
const owner = (method, p, body) => api(method, p, body, OWNER_BEARER);

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      frames.push(f);
      for (const w of waiters.splice(0)) if (w.pred(f)) w.res(f);
    };
    ws.onopen = () => resolve({
      ws, frames, closed: new Promise((res) => { ws.onclose = () => res(true); }),
      send: (o) => ws.send(JSON.stringify(o)),
      next: (pred, ms) => new Promise((res) => {
        const hit = frames.find(pred);
        if (hit) return res(hit);
        waiters.push({ pred, res });
        if (ms) setTimeout(() => res(null), ms);
      }),
      close: () => ws.close()
    });
    ws.onerror = reject;
  });
}

async function main() {
  console.log('v1.69.3 THE SHARED CANVAS — THE HANDSHAKE (the live proof)');
  execSync(`cd ${__ROOT}/engine && go build -o /tmp/v1693-engine ./cmd/doomalay 2>&1`, { stdio: 'inherit', env: { ...process.env, PATH: '/home/z/sdk/go/bin:' + process.env.PATH } });
  fs.rmSync(DATA, { recursive: true, force: true });
  // THE DEPLOYMENT LAW: auth_token set — the loopback trust is dead, the
  // owner is the bearer, the guests are device tokens (the tunnel shape).
  fs.writeFileSync(CFG, `port: ${PORT}\ndata_dir: ${DATA}\nauth_token: "${OWNER_BEARER}"\n`);
  const engine = spawn('/tmp/v1693-engine', ['--config', CFG], { stdio: ['ignore', 'pipe', 'pipe'] });
  const engineErr = [];
  engine.stderr.on('data', (d) => engineErr.push(String(d)));
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) break; } catch (e) {} await sleep(200); }

    // the health + static shell stay public
    let r = await fetch(ENGINE + '/');
    ok('the static shell loads without any credential', r.status === 200);
    r = await fetch(ENGINE + '/api/canvases');
    ok('the engine API is sealed without the bearer (the tunnel law)', r.status === 401, r.status);

    // the host canvas: a chat + a hole to an UNSEEN canvas
    r = await owner('POST', '/api/canvases', { id: 'cv_live', name: 'Live', state: {
      currentFamily: 'default',
      icons: [
        { id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby' },
        { id: 'hole_x', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_unseen', pairId: 'pair_x' }
      ], dots: [], savedAt: 1
    } });
    ok('seed the host canvas (the bearer)', r.status === 201, r.body);

    // ══ LEG A — THE HANDSHAKE ARC ═════════════════════════════════
    console.log('LEG A — THE HANDSHAKE ARC');
    r = await owner('POST', '/api/collab/cv_live/invite', {});
    ok('the owner mints a 6-digit code', r.status === 200 && /^\d{6}$/.test(r.body.code || ''), r.body);
    const code = r.body.code;
    // the wrong code → the honest miss (no oracle)
    r = await api('POST', '/api/collab/pair', { canvas: 'cv_live', code: '000001', name: 'Evil' });
    ok('the wrong code answers the honest 404', r.status === 404, r.body);
    // the joiner claims
    r = await api('POST', '/api/collab/pair', { canvas: 'cv_live', code, name: 'Pixel 9' });
    ok('the joiner claims → the device_code poll cursor', r.status === 200 && (r.body.device_code || '').length > 32, r.body);
    const dc = r.body.device_code;
    // the second claim on the same code → 409 (single-use)
    r = await api('POST', '/api/collab/pair', { canvas: 'cv_live', code, name: 'Second' });
    ok('a second claim on the code is refused 409', r.status === 409, r.body);
    // the poll: pending
    r = await api('GET', '/api/collab/pair?device_code=' + dc);
    ok('the poll says pending', r.status === 200 && r.body.status === 'pending', r.body);
    // THE TAP
    r = await owner('POST', '/api/collab/cv_live/invite/approve', {});
    ok('THE TAP lands', r.status === 200, r.body);
    // the poll: approved + the token
    r = await api('GET', '/api/collab/pair?device_code=' + dc);
    ok('the poll answers approved with the credential', r.status === 200 && r.body.status === 'approved' && (r.body.token || '').length >= 32 && (r.body.device_id || '').startsWith('dev_'), r.body);
    const token = r.body.token, device = r.body.device_id;
    // the idempotency: a second poll converges
    r = await api('GET', '/api/collab/pair?device_code=' + dc);
    ok('the second poll converges on the SAME credential', r.body.token === token && r.body.device_id === device, r.body);

    // ══ LEG B — THE CREDENTIALED ROOM ═════════════════════════════
    console.log('LEG B — THE CREDENTIALED ROOM');
    // the OWNER is live in the room first (the host side)
    const ownerSock = await wsOpen(`ws://127.0.0.1:${PORT}/api/collab/live?canvas=cv_live&since=0&device=host&name=Host&token=${encodeURIComponent(OWNER_BEARER)}`);
    const oHello = await ownerSock.next((f) => f.t === 'hello', 3000);
    ok('the owner joined live (the bearer via query — the WS law)', !!oHello, ownerSock.frames);
    // the GUEST joins with the token (a WS with no other credential)
    const guest = await wsOpen(`ws://127.0.0.1:${PORT}/api/collab/live?canvas=cv_live&since=0&device=spoofed&name=Pixel%209&token=${encodeURIComponent(token)}`);
    const gHello = await guest.next((f) => f.t === 'hello', 3000);
    ok('the guest joined live on the credential', !!gHello, guest.frames);
    if (gHello) ok('the credential named the guest (never the query param)', gHello.members.some((m) => m.id === device), gHello.members);
    // a random token cannot join
    let refused = false;
    try {
      const bad = new WebSocket(`ws://127.0.0.1:${PORT}/api/collab/live?canvas=cv_live&since=0&device=bad&token=deadbeef`);
      await new Promise((res) => { bad.onopen = () => res(); bad.onclose = () => res(); bad.onerror = () => res(); });
      refused = bad.readyState >= 2; // closed/closing
    } catch (e) { refused = true; }
    ok('a random token cannot join the room', refused);
    // THE AUTHOR LAW live: the guest submits over HTTP with a spoofed body
    r = await api('POST', '/api/collab/cv_live/ops?token=' + encodeURIComponent(token), {
      device: 'spoofed',
      ops: [{ opId: 'g:1', kind: 'icon.set', id: 'chat_a', props: { x: 42, name: 'Guest Edit' } }]
    });
    ok('the guest op submit lands', r.status === 200, r.body);
    const gFrame = (r.body.ops || [])[0] || {};
    ok('THE AUTHOR LAW: the credential names the author', gFrame.device === device && gFrame.device !== 'spoofed', gFrame);
    // the owner heard the broadcast
    const oBatch = await ownerSock.next((f) => f.t === 'ops' && !f.replay && (f.ops || []).some((o) => o.opId === 'g:1'), 4000);
    ok('the owner received the guest op live', !!oBatch, ownerSock.frames.map((f) => f.t));
    // the guest reads /doc with the token
    r = await api('GET', '/api/collab/cv_live/doc?token=' + encodeURIComponent(token));
    ok('the guest reads /doc on the credential', r.status === 200 && r.body.doc, r.status);

    // ══ LEG C — THE GATED PORTALS ═════════════════════════════════
    console.log('LEG C — THE GATED PORTALS');
    const gIcons = ((r.body || {}).doc || {}).icons || [];
    ok('the hole to the UNSEEN canvas is unknown to the guest', !gIcons.some((i) => i.id === 'hole_x'), gIcons.map((i) => i.id));
    r = await owner('GET', '/api/collab/cv_live/doc');
    const oIcons = ((r.body || {}).doc || {}).icons || [];
    ok('the owner sees the hole (never filtered)', oIcons.some((i) => i.id === 'hole_x'), oIcons.map((i) => i.id));

    // ══ LEG D — THE REVOCATION ════════════════════════════════════
    console.log('LEG D — THE REVOCATION');
    r = await owner('GET', '/api/collab/cv_live/members');
    ok('the roster names the device', (r.body.members || []).some((m) => m.id === device && m.name === 'Pixel 9'), r.body.members);
    // the guest is LIVE — the revoke must kill the socket mid-stream
    const guestClosed = guest.closed; // resolves true when the socket dies
    r = await owner('POST', `/api/collab/cv_live/members/${device}/revoke`, {});
    ok('the owner revokes', r.status === 200, r.body);
    const died = await Promise.race([guestClosed.then(() => true), sleep(4000).then(() => false)]);
    ok('the live socket died mid-stream', died === true);
    // the token is dead everywhere
    r = await api('GET', '/api/collab/cv_live/doc?token=' + encodeURIComponent(token));
    ok('the revoked token 401s the doc', r.status === 401, r.status);
    r = await api('GET', '/api/collab/my?token=' + encodeURIComponent(token));
    ok('the revoked token 401s /my', r.status === 401, r.status);
    // the roster no longer names the device
    r = await owner('GET', '/api/collab/cv_live/members');
    ok('the roster no longer names the device', !(r.body.members || []).some((m) => m.id === device), r.body.members);
    ownerSock.close();
  } finally {
    engine.kill('SIGKILL');
  }
  console.log('');
  console.log(`\u2014\u2014 ${n - fails.length}/${n} GREEN \u2014\u2014`);
  if (fails.length) { console.log('FAILS: ' + fails.join(' | ')); process.exit(1); }
  if (engineErr.join('').includes('panic')) { console.log('ENGINE PANIC DETECTED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
