#!/usr/bin/env node
// v1710-shared-canvas-rig.mjs — v1.71.2 THE SHARED CANVAS · THE LIVE
// PROOF (PLAN-V169 §v1.69.5, renumbered by the +1 law over the parallel
// v1.70.0): the FULL two-device arc against the REAL engine binary —
// the REAL SharedDocSession clients (collabcore.js), the code-only
// handshake, the redteam ladder, the perf pins, the reconnect, and the
// format-1.1 lineage round-trip through the real bundle modules. Legs:
//
//   LEG A — THE GOLDEN PATH: the owner seeds a canvas; the owner mints;
//           a FOREIGN guest claims CODE-ONLY (no canvas in the request —
//           the plan's conviction: a foreign device under the deployment
//           law has no host rows); THE TAP; the poll answers the token +
//           THE CANVAS; two REAL SharedDocSession devices go live (the
//           owner on the global bearer, the guest on the device token);
//           A moves an icon → B applies; A renames → B reflects; A
//           creates a chat icon → B materializes it; A adds a dot → B
//           groups it; B's doc converges on the server's doc.
//
//   LEG B — THE REDTEAM LADDER: the wrong code = the honest 404; a second
//           claim = 409; a 6-digit guessing burst = 429; the guest token
//           is BLIND to an unshared canvas (401 + the doc filtered);
//           THE GATED PORTALS (the hole to the unseen canvas is unknown
//           to the guest, visible to the owner); THE REVOCATION (B's live
//           socket dies mid-stream, the token 401s, the census cleans).
//
//   LEG C — THE PERF PINS: SOLO PARITY (an unshared canvas never births a
//           room — the census empty, ZERO journal rows); the fan-out is
//           O(members) (one submit, every member's own frame log sees the
//           same batch); THE CHECKPOINT CALM (the WS fold is not in the
//           row before the 2s window, is after); DORMANCY (the last
//           leave flushes + empties the census).
//
//   LEG D — RECONNECT: B's socket dies; ops land meanwhile; the REAL
//           client's reconnect ladder rejoins + replays the gap; the
//           docs converge again.
//
//   LEG E — THE FORMAT-1.1 LINEAGE ROUND-TRIP (pure node, the real
//           canvasbundle + publishers modules): a bundle built from an
//           IMPORTED canvas carries parentUuid/parentAuthor/parentName +
//           contentHash (sha256 of canvas.json); the import stamps
//           imported.uuid so the chain survives; a re-export names the
//           first bundle as its parent (the fork law).
//
// Honesty law: every assertion binds to the tool's own frames.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8710;
const ENGINE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/v1710-data';
const CFG = '/tmp/v1710-config.yaml';
const OWNER_BEARER = 'rig-owner-secret-token';

const Codec = (await import('file://' + path.join(__ROOT, 'engine/internal/server/web/collabcore.js').replace(/\\/g, '/'))).default;
const CB = (await import('file://' + path.join(__ROOT, 'engine/internal/server/web/canvasbundle.js').replace(/\\/g, '/'))).default;

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(typeof extra === 'object' ? JSON.stringify(extra) : extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

// the deployment law (the v1693 conviction): auth_token set → the
// loopback trust is DEAD; the owner is the bearer, the guests are device
// tokens — the tunnel's own shape.
async function api(method, p, body, token) {
  const init = { method };
  init.headers = {};
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  if (token) {
    if (token === OWNER_BEARER) init.headers.Authorization = 'Bearer ' + OWNER_BEARER;
    else init.headers['X-Doomalay-Device'] = token;
  }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}
const owner = (method, p, body) => api(method, p, body, OWNER_BEARER);

// the real session's api — the token rides the QUERY (a browser WS cannot
// set headers; the engine's own law)
function tokenedAPI(token) {
  return {
    fetchDoc: (c) => fetch(`${ENGINE}/api/collab/${encodeURIComponent(c)}/doc?token=${encodeURIComponent(token)}`).then((r) => r.json()),
    fetchOps: (c, since) => fetch(`${ENGINE}/api/collab/${encodeURIComponent(c)}/ops?since=${since || 0}&token=${encodeURIComponent(token)}`).then((r) => r.json()),
    postOps: (c, dev, ops) => fetch(`${ENGINE}/api/collab/${encodeURIComponent(c)}/ops?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: dev, ops })
    }).then((r) => { if (!r.ok) throw new Error('post ' + r.status); return r.json(); }),
    wsURL: (c, since, dev, name) => `ws://127.0.0.1:${PORT}/api/collab/live?canvas=${encodeURIComponent(c)}&since=${since || 0}&device=${encodeURIComponent(dev)}&name=${encodeURIComponent(name || '')}&token=${encodeURIComponent(token)}`
  };
}

// the mock adapter over the REAL session — the doc model + the apply record
function mockAdapter() {
  const st = { doc: { icons: [], dots: [], currentFamily: 'default', worldSize: 0 }, applied: [], members: [], presence: [] };
  return {
    _st: st,
    getDoc: () => JSON.parse(JSON.stringify(st.doc)),
    applyOp: (op) => { st.applied.push(op); Codec.applyOpToDoc(st.doc, op); },
    afterRebase: () => { st.rebased = true; },
    onMembers: (m) => { st.members = m; },
    onPresence: () => {}
  };
}

function rawMember(canvas, since, device, token) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${PORT}/api/collab/live?canvas=${encodeURIComponent(canvas)}&since=${since || 0}&device=${encodeURIComponent(device)}&name=raw&token=${encodeURIComponent(token || OWNER_BEARER)}`;
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

// the icon fields the convergence compares (order-stable by id)
function iconMap(doc) {
  const out = {};
  (doc.icons || []).forEach((ic) => { out[ic.id] = { type: ic.type, x: ic.x, y: ic.y, name: ic.name }; });
  return out;
}

async function main() {
  console.log('v1.71.2 THE SHARED CANVAS — THE LIVE PROOF');
  execSync(`cd ${__ROOT}/engine && go build -o /tmp/v1710-engine ./cmd/doomalay 2>&1`, { stdio: 'inherit', env: { ...process.env, PATH: '/home/z/sdk/go/bin:' + process.env.PATH } });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.writeFileSync(CFG, `port: ${PORT}\ndata_dir: ${DATA}\nauth_token: "${OWNER_BEARER}"\n`);
  const engine = spawn('/tmp/v1710-engine', ['--config', CFG], { stdio: ['ignore', 'pipe', 'pipe'] });
  const engineErr = [];
  engine.stderr.on('data', (d) => engineErr.push(String(d)));
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) break; } catch (e) {} await sleep(200); }

    // the sealed engine + the public shell (the deployment law)
    let r = await fetch(ENGINE + '/');
    ok('the static shell loads without any credential', r.status === 200);
    r = await fetch(ENGINE + '/api/canvases');
    ok('the engine API is sealed without the bearer', r.status === 401, r.status);

    // the host canvas: a chat + a hole to an UNSEEN canvas
    r = await owner('POST', '/api/canvases', { id: 'cv_live', name: 'Live', state: {
      offset: { x: 0, y: 0 }, scale: 1, currentFamily: 'default',
      icons: [
        { id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby', sessionId: 's1' },
        { id: 'hole_x', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_unseen', pairId: 'pair_x' }
      ], dots: [], savedAt: 1
    } });
    ok('seed the host canvas (the bearer)', r.status === 201, r.body);

    // ══ LEG A — THE GOLDEN PATH ═══════════════════════════════════
    console.log('LEG A — THE GOLDEN PATH (two real devices, one real handshake)');
    r = await owner('POST', '/api/collab/cv_live/invite', {});
    ok('the owner mints a 6-digit code', r.status === 200 && /^\d{6}$/.test(r.body.code || ''), r.body);
    const code = r.body.code;
    // the wrong code answers the honest miss FIRST (no oracle, before the claim)
    r = await api('POST', '/api/collab/pair', { code: '000001', name: 'Evil' });
    ok('the wrong code answers the honest 404', r.status === 404, r.body);
    // THE CODE-ONLY CLAIM — NO canvas in the body at all
    r = await api('POST', '/api/collab/pair', { code, name: 'Pixel 9' });
    ok('the foreign guest claims CODE-ONLY (no canvas) → the poll cursor', r.status === 200 && (r.body.device_code || '').length > 32, r.body);
    ok('the claim carries the RESOLVED canvas + its name', r.body.canvas === 'cv_live' && r.body.canvas_name === 'Live', r.body);
    const dc = r.body.device_code;
    // the second claim on the code → 409 (single-use)
    r = await api('POST', '/api/collab/pair', { code, name: 'Second' });
    ok('a second claim on the code is refused 409', r.status === 409, r.body);
    // pending
    r = await api('GET', '/api/collab/pair?device_code=' + dc);
    ok('the poll says pending', r.body.status === 'pending', r.body);
    // THE TAP
    r = await owner('POST', '/api/collab/cv_live/invite/approve', {});
    ok('THE TAP (the human handshake) lands', r.status === 200, r.body);
    // the poll answers the token + THE CANVAS
    r = await api('GET', '/api/collab/pair?device_code=' + dc);
    ok('the approved poll answers the token', r.body.status === 'approved' && (r.body.token || '').length > 32, r.body);
    ok('the approved poll carries THE CANVAS (the guest activation truth)', r.body.canvas === 'cv_live' && r.body.canvas_name === 'Live', r.body);
    const guestToken = r.body.token;
    const guestDev = r.body.device_id;

    // two REAL sessions: the OWNER (global bearer via query) + the GUEST
    const adapterA = mockAdapter();
    adapterA._st.doc.icons = [
      { id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby', sessionId: 's1' },
      { id: 'hole_x', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_unseen', pairId: 'pair_x' }
    ];
    const sessionA = new Codec.SharedDocSession({ canvas: 'cv_live', device: 'devA', name: 'Owner Phone', api: tokenedAPI(OWNER_BEARER), adapter: adapterA, codec: Codec });
    await sessionA.activate();
    ok('A (the owner, global bearer) adopted with NO drift (the local world matched the server)', sessionA.adopted && sessionA.cursor === 0, sessionA.cursor);

    // THE GUEST LAW: a real guest materializes from the SERVED doc (which
    // the gated-portals law has ALREADY filtered — the hole to the unseen
    // canvas is unknown to them) — so the guest's world can never drift a
    // removal for an icon it cannot see. The mock starts EMPTY, exactly
    // like a fresh device.
    const adapterB = mockAdapter();
    const sessionB = new Codec.SharedDocSession({ canvas: 'cv_live', device: guestDev, name: 'Pixel 9', api: tokenedAPI(guestToken), adapter: adapterB, codec: Codec, guest: true });
    if (process.env.V1710_DEBUG) {
      const probe = await fetch(`${ENGINE}/api/collab/cv_live/doc?token=${encodeURIComponent(guestToken)}`);
      console.log('  [dbg-B] pre-activate doc GET status', probe.status, (await probe.text()).slice(0, 220));
    }
    await sessionB.activate();
    if (process.env.V1710_DEBUG) {
      console.log('  [dbg-B] adopted:', sessionB.adopted, 'cursor:', sessionB.cursor, 'doc:', J(adapterB._st.doc).slice(0, 220));
    }
    ok('B (the guest, the device token) materialized from the served doc', sessionB.adopted && iconMap(adapterB._st.doc)['chat_a'] && iconMap(adapterB._st.doc)['chat_a'].x === 10, iconMap(adapterB._st.doc));
    if (process.env.V1710_DEBUG) {
      const jrn = await tokenedAPI(OWNER_BEARER).fetchOps('cv_live', 0);
      console.log('  [dbg-B] journal at B-activate:', J(jrn));
    }
    ok('B\'s view carries NO portal it has no right to see (the gated law, live)', !iconMap(adapterB._st.doc)['hole_x'], iconMap(adapterB._st.doc));
    await sleep(250);
    ok('A sees the 2-member roster', adapterA._st.members.length === 2, adapterA._st.members);

    // A's user moves + renames the icon + creates a new chat + adds a dot.
    // THE REAL saveNow LAW: the user's edit lands on the WORLD first — the
    // world IS the state; capture only derives the diff (the rig's mock
    // mirrors the app: mutate the adapter's doc, THEN capture).
    const nextDoc = {
      icons: [
        { id: 'chat_a', type: 'chat', x: 42, y: 55, name: 'Renamed', sessionId: 's1' },
        { id: 'chat_new', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' },
        { id: 'hole_x', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_unseen', pairId: 'pair_x' }
      ],
      dots: [{ id: 'dot_1', name: 'group', members: ['chat_a'] }],
      currentFamily: 'aurora', worldSize: 32768
    };
    adapterA._st.doc.icons = nextDoc.icons.map((x) => x);
    adapterA._st.doc.dots = nextDoc.dots.map((x) => x);
    adapterA._st.doc.currentFamily = nextDoc.currentFamily;
    adapterA._st.doc.worldSize = nextDoc.worldSize;
    sessionA.capture(nextDoc);
    ok('A derived + submitted the batch', sessionA.pending.length > 0, sessionA.pending.map((p) => p.kind));
    // B applies through the REAL wire
    await sleep(700);
    const bIconA = adapterB._st.doc.icons.filter((i) => i.id === 'chat_a')[0];
    ok('B sees the MOVE (x/y applied)', bIconA && bIconA.x === 42 && bIconA.y === 55, bIconA);
    ok('B sees the RENAME (name reflected)', bIconA && bIconA.name === 'Renamed', bIconA);
    ok('B MATERIALIZED the new chat icon', adapterB._st.doc.icons.some((i) => i.id === 'chat_new' && i.name === 'Fresh' && i.x === 77), adapterB._st.doc.icons);
    ok('B synced the dot', (adapterB._st.doc.dots || []).length === 1 && adapterB._st.doc.dots[0].id === 'dot_1', adapterB._st.doc.dots);
    ok('B synced the family + the plate size', adapterB._st.doc.currentFamily === 'aurora' && adapterB._st.doc.worldSize === 32768, { f: adapterB._st.doc.currentFamily, w: adapterB._st.doc.worldSize });
    await sleep(400);
    ok('A pending cleared by its own ack', sessionA.pending.length === 0, sessionA.pending);
    // CONVERGENCE: B's doc == the SERVER's doc AS THE GUEST SEES IT (the
    // twin law on the shared truth; the owner's private view of the hole
    // is the gated law, pinned above + in LEG B)
    const serverDoc = await tokenedAPI(guestToken).fetchDoc('cv_live');
    ok('B\'s doc converged on the server\'s doc (the twin law)', J(iconMap(adapterB._st.doc)) === J(iconMap({ icons: serverDoc.doc.icons })), { server: iconMap({ icons: serverDoc.doc.icons }), b: iconMap(adapterB._st.doc) });
    const aNoHoles = {}; Object.keys(iconMap(adapterA._st.doc)).forEach((k) => { if (k !== 'hole_x') aNoHoles[k] = iconMap(adapterA._st.doc)[k]; });
    ok('A\'s doc converged on the same shared truth', J(aNoHoles) === J(iconMap({ icons: serverDoc.doc.icons })), { a: aNoHoles, server: iconMap({ icons: serverDoc.doc.icons }) });
    ok('the owner STILL sees the portal (the gated law never filters the owner)', !!iconMap(adapterA._st.doc)['hole_x'], iconMap(adapterA._st.doc));

    // ══ LEG B — THE REDTEAM LADDER ════════════════════════════════
    console.log('LEG B — THE REDTEAM LADDER');
    // the guest token is BLIND to an unshared canvas
    r = await owner('POST', '/api/canvases', { id: 'cv_unseen', name: 'Unseen', state: { icons: [{ id: 'i1', type: 'chat', x: 0, y: 0 }], dots: [], savedAt: 1 } });
    ok('the unseen canvas seeds', r.status === 201, r.body);
    r = await api('GET', '/api/collab/cv_unseen/doc', undefined, guestToken);
    ok('the guest token is BLIND to the unshared canvas (401)', r.status === 401, r.status);
    // THE GATED PORTALS: the guest's /doc strips the hole to the unseen canvas
    const guestDoc = await tokenedAPI(guestToken).fetchDoc('cv_live');
    ok('THE GATED PORTALS — the hole to the unseen canvas is UNKNOWN to the guest', !guestDoc.doc.icons.some((i) => i.id === 'hole_x'), guestDoc.doc.icons.map((i) => i.id));
    const ownerDoc = await tokenedAPI(OWNER_BEARER).fetchDoc('cv_live');
    ok('the owner SEES the hole (never filtered)', ownerDoc.doc.icons.some((i) => i.id === 'hole_x'), ownerDoc.doc.icons.map((i) => i.id));
    // THE REVOCATION: B live → revoke → the socket dies + the token 401s
    ok('B is live in the room', sessionB.transport && sessionB.transport.ws && sessionB.transport.ws.readyState === 1);
    const bwsBefore = sessionB.transport.ws; // the reconnect ladder may replace the transport — pin THIS socket
    r = await owner('POST', '/api/collab/cv_live/members/' + guestDev + '/revoke', {});
    ok('the owner revokes the guest', r.status === 200, r.body);
    await sleep(500);
    ok('B\'s socket DIED mid-stream', bwsBefore.readyState >= 2, bwsBefore.readyState);
    r = await api('GET', '/api/collab/cv_live/doc', undefined, guestToken);
    ok('the revoked token 401s everywhere', r.status === 401, r.status);
    let census = await owner('GET', '/api/collab/rooms');
    ok('the census still shows the owner\'s room', census.body.rooms.length === 1 && census.body.rooms[0].canvas === 'cv_live', census.body);
    const roster = await owner('GET', '/api/collab/cv_live/members');
    ok('the roster no longer names the revoked device', !(roster.body.members || []).some((m) => m.id === guestDev), roster.body.members);

    // ══ LEG C — THE PERF PINS ═════════════════════════════════════
    console.log('LEG C — THE PERF PINS');
    // SOLO PARITY: an unshared canvas never births a room + never journals
    r = await owner('POST', '/api/canvases', { id: 'cv_solo', name: 'Solo', state: { icons: [{ id: 'i1', type: 'chat', x: 0, y: 0 }], dots: [], savedAt: 1 } });
    ok('a solo canvas seeds', r.status === 201, r.body);
    r = await owner('PUT', '/api/canvases/cv_solo', { state: { icons: [{ id: 'i1', type: 'chat', x: 5, y: 5 }], dots: [], savedAt: 2 } });
    ok('the solo save rides the plain v1.67 PUT path (200)', r.status === 200, r.status);
    census = await owner('GET', '/api/collab/rooms');
    ok('SOLO PARITY — the unshared canvas NEVER births a room', !census.body.rooms.some((x) => x.canvas === 'cv_solo'), census.body.rooms.map((x) => x.canvas));
    const soloOps = await tokenedAPI(OWNER_BEARER).fetchOps('cv_solo', 0);
    ok('SOLO PARITY — the unshared canvas writes ZERO journal ops', (soloOps.ops || []).length === 0, soloOps);
    // THE FAN-OUT is O(members): A + two raw members all receive the same batch
    const memberC = await rawMember('cv_live', sessionA.cursor, 'devC');
    await memberC.next((f) => f.t === 'hello', 3000);
    // the world already carries the move (the saveNow law — mutate-then-capture)
    adapterA._st.doc.icons = [
      { id: 'chat_a', type: 'chat', x: 99, y: 99, name: 'Renamed', sessionId: 's1' },
      { id: 'chat_new', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' },
      { id: 'hole_x', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_unseen', pairId: 'pair_x' }
    ];
    adapterA._st.doc.dots = [{ id: 'dot_1', name: 'group', members: ['chat_a'] }];
    adapterA._st.doc.currentFamily = 'aurora';
    adapterA._st.doc.worldSize = 32768;
    sessionA.capture(adapterA._st.doc);
    let row = await owner("GET", "/api/canvases/cv_live");
    const rowIcons = (row.body.canvas && row.body.canvas.state && row.body.canvas.state.icons) || [];
    ok('THE CALM WINDOW — the WS fold is not force-flushed into the row', !rowIcons.some((i) => i.id === 'chat_a' && i.x === 99), rowIcons.filter((i) => i.id === 'chat_a'));
    await sleep(700);
    ok('A\'s own ack cleared its pending (the author never self-applies through the wire)', sessionA.pending.length === 0, sessionA.pending);
    const cBatch = await memberC.next((f) => f.t === 'ops' && !f.replay && f.ops && f.ops.some((o) => o.kind === 'icon.set'), 4000);
    ok('the fan-out reached the third member (O(members))', !!cBatch, memberC.frames.map((f) => f.t));
    await sleep(2500);
    row = await owner("GET", "/api/canvases/cv_live");
    const rowIcons2 = (row.body.canvas && row.body.canvas.state && row.body.canvas.state.icons) || [];
    ok('THE CHECKPOINT CALM — after the window the row carries the fold', rowIcons2.some((i) => i.id === 'chat_a' && i.x === 99), rowIcons2.filter((i) => i.id === 'chat_a'));
    // DORMANCY: everyone leaves → the census empties (A stays last)
    memberC.close();
    sessionA.close();
    await sleep(3500); // the HTTP idle drop + the trailing checkpoint
    census = await owner('GET', '/api/collab/rooms');
    ok('DORMANCY — the last leave empties the census (zero rooms)', (census.body.rooms || []).length === 0, census.body);

    // ══ LEG D — RECONNECT (a fresh guest; the revoked one is dead) ═
    console.log('LEG D — RECONNECT + REPLAY');
    r = await owner('POST', '/api/collab/cv_live/invite', {});
    ok('LEG D mints', r.status === 200 && /^\d{6}$/.test(r.body.code || ''), r.body);
    const code2 = r.body.code;
    r = await api('POST', '/api/collab/pair', { code: code2, name: 'Tablet' });
    ok('LEG D claims code-only', r.status === 200 && r.body.device_code, r.body);
    const dc2 = r.body.device_code;
    r = await owner('POST', '/api/collab/cv_live/invite/approve', {});
    ok('LEG D approves', r.status === 200, r.body);
    r = await api('GET', '/api/collab/pair?device_code=' + dc2);
    ok('LEG D polls the token', r.body.status === 'approved' && r.body.token, r.body);
    const t2 = r.body.token, d2 = r.body.device_id;
    const adapterD = mockAdapter();
    const sessionD = new Codec.SharedDocSession({ canvas: 'cv_live', device: d2, name: 'Tablet', api: tokenedAPI(t2), adapter: adapterD, codec: Codec, guest: true });
    await sessionD.activate();
    ok('D adopted the converged doc', sessionD.adopted && iconMap(adapterD._st.doc)['chat_a'] && iconMap(adapterD._st.doc)['chat_a'].x === 99, iconMap(adapterD._st.doc));
    // A comes back + moves the icon while D's socket is killed
    const sessionA2 = new Codec.SharedDocSession({ canvas: 'cv_live', device: 'devA', name: 'Owner Phone', api: tokenedAPI(OWNER_BEARER), adapter: adapterA, codec: Codec });
    await sessionA2.activate();
    sessionD.transport.ws.close(); // the socket dies
    await sleep(150);
    adapterA._st.doc.icons = [
      { id: 'chat_a', type: 'chat', x: 111, y: 222, name: 'Moved Again', sessionId: 's1' },
      { id: 'chat_new', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' },
      { id: 'hole_x', type: 'hole', x: 50, y: 60, targetWorldId: 'cv_unseen', pairId: 'pair_x' }
    ];
    adapterA._st.doc.dots = [{ id: 'dot_1', name: 'group', members: ['chat_a'] }];
    sessionA2.capture(adapterA._st.doc);
    ok('A moved the icon while D was dark', sessionA2.pending.length > 0, sessionA2.pending.map((p) => p.kind));
    // the REAL reconnect ladder (0.5s first rung + jitter)
    await sleep(3500);
    if (process.env.V1710_DEBUG) {
      const dbgCensus = await owner('GET', '/api/collab/rooms');
      const dbgOps = await tokenedAPI(t2).fetchOps('cv_live', 0);
      console.log('  [dbg] A2 pending:', J(sessionA2.pending), 'cursor:', sessionA2.cursor, 't open:', sessionA2.transport && sessionA2.transport.ws && sessionA2.transport.ws.readyState);
      console.log('  [dbg] D pending:', J(sessionD.pending), 'cursor:', sessionD.cursor, 't open:', sessionD.transport && sessionD.transport.ws && sessionD.transport.ws.readyState);
      console.log('  [dbg] census:', J(dbgCensus.body));
      console.log('  [dbg] ops tail:', J((dbgOps.ops || []).slice(-4).map((o) => ({ seq: o.seq, k: JSON.parse(o.op).kind, id: JSON.parse(o.op).id }))));
    }
    const dIcon = iconMap(adapterD._st.doc)['chat_a'];
    ok('D\'s reconnect ladder rejoined + REPLAYED the gap', dIcon && dIcon.x === 111 && dIcon.y === 222 && dIcon.name === 'Moved Again', dIcon);
    const srv2 = await tokenedAPI(t2).fetchDoc('cv_live');
    ok('D converged with the server again', J(iconMap(adapterD._st.doc)) === J(iconMap({ icons: srv2.doc.icons })), { d: iconMap(adapterD._st.doc), srv: iconMap({ icons: srv2.doc.icons }) });
    sessionD.close();
    sessionA2.close();

    // the guessing burst → the rate limit (THE LAST pair-consuming leg —
    // the 10/min/IP window already carries the earlier claims)
    let lastPair = 0;
    for (let i = 0; i < 8; i++) { const rr = await api('POST', '/api/collab/pair', { code: '8' + String(i).padStart(5, '0'), name: 'Bot' + i }); lastPair = rr.status; }
    ok('the guessing burst hits the rate limit (429)', lastPair === 429, lastPair);

    // ══ LEG E — THE FORMAT-1.1 LINEAGE ROUND-TRIP (pure node) ═════
    console.log('LEG E — THE FORMAT-1.1 LINEAGE ROUND-TRIP');
    const canvasState = JSON.stringify({ offset: { x: 0, y: 0 }, scale: 1, currentFamily: 'aurora', icons: [{ id: 'chat_a', type: 'chat', x: 1, y: 2 }], dots: [], savedAt: 5 });
    const collected = {
      files: { 'canvas.json': canvasState, 'settings.json': J({ theme: 'midnight' }) },
      tree: [], requires: [], warnings: [],
      canvasName: 'Fork World', appVersion: '1.71.0-rig',
      imported: { from: 'Origin World', author: 'alice', at: 't', appVersion: '1.0', uuid: 'cvb_origin01', parentUuid: '' },
      childBytes: {}, chatHistoryBytes: {}
    };
    const bytes1 = await CB.build(collected, {});
    const v1 = CB.read(bytes1);
    ok('the 1.1 bundle passes its own read ladder (MAJOR≤1)', v1.ok, v1.why);
    ok('the manifest is FORMAT 1.1', v1.manifest.formatVersion === '1.1', v1.manifest.formatVersion);
    ok('the lineage stamped: parentUuid + parentAuthor + parentName',
      v1.manifest.parentUuid === 'cvb_origin01' && v1.manifest.parentAuthor === 'alice' && v1.manifest.parentName === 'Origin World',
      { p: v1.manifest.parentUuid, a: v1.manifest.parentAuthor, n: v1.manifest.parentName });
    const wantHash = crypto.createHash('sha256').update(canvasState).digest('hex');
    ok('contentHash = sha256 of canvas.json (the content fingerprint)', v1.manifest.contentHash === wantHash, { got: v1.manifest.contentHash, want: wantHash });

    // the import: a minimal io; the created row carries the chain
    const posted = [];
    const lineageIO = {
      getJSON: async (url) => {
        if (url === '/api/health') return { status: 'ok', version: '1.71.0-rig' };
        if (url === '/api/keys') return {};
        throw new Error('unexpected GET ' + url);
      },
      postJSON: async (url, body) => {
        if (url === '/api/canvases') { posted.push(body); return { canvas: { ID: 'cv_new', id: 'cv_new' } }; }
        throw new Error('unexpected POST ' + url);
      },
      del: async () => { throw new Error('unexpected DEL'); }
    };
    const imp = await CB.importBundle(bytes1, { io: lineageIO, quiet: true, IconReg: null });
    ok('the 1.1 import lands', imp.ok, imp.why);
    const created = posted[0];
    ok('the created row stamps imported.uuid (the chain survives)', created && created.state && created.state.imported && created.state.imported.uuid === v1.manifest.uuid,
      created && created.state && created.state.imported);
    ok('the created row keeps the parent chain', created && created.state && created.state.imported && created.state.imported.parentUuid === 'cvb_origin01',
      created && created.state && created.state.imported);

    // the re-export: the forked canvas names the FIRST bundle as parent
    const collected2 = JSON.parse(JSON.stringify(collected));
    collected2.imported = created.state.imported;
    const bytes2 = await CB.build(collected2, {});
    const v2 = CB.read(bytes2);
    ok('the re-export CHAINS (parentUuid = the first bundle\'s uuid)', v2.ok && v2.manifest.parentUuid === v1.manifest.uuid,
      { first: v1.manifest.uuid, reexport: v2.manifest.parentUuid });
    ok('the pre-1.1 reader law: a 1.0 manifest stays importable (back-compat untouched)', (function () {
      const old = JSON.parse(J(v1.manifest)); old.formatVersion = '1.0';
      const m42 = JSON.parse(J(v1.manifest)); m42.formatVersion = '2.0';
      const mk = (m) => CB.read((function () { const files = Object.assign({}, v1.files, { 'manifest.json': J(m) }); return bytesOf(files); })());
      return mk(old).ok && !mk(m42).ok;
    })(), 'the 1.0 opens + a 2.0 refuses');

    // the engine log: no panics
    if (engineErr.join('').includes('panic')) { ok('the engine never panicked', false, engineErr.join('').slice(0, 400)); }
    else ok('the engine never panicked', true);
  } finally {
    engine.kill('SIGKILL');
  }
  console.log('\u2014\u2014 ' + (n - fails.length) + '/' + n + ' GREEN \u2014\u2014');
  if (fails.length) { console.log('FAILS: ' + fails.join(' | ')); process.exit(1); }
}

// bytesOf(files) — the rig's own zip writer via the module's vendored fflate
function bytesOf(files) {
  const fpath = path.join(__ROOT, 'engine/internal/server/web/vendor/fflate.js');
  const fflate = require2(fpath);
  const entries = {};
  Object.keys(files).forEach((k) => { entries[k] = (typeof files[k] === 'string') ? fflate.strToU8(files[k]) : files[k]; });
  return fflate.zipSync(entries, { level: 6 });
}

main().catch((e) => { console.error('RIG CRASH:', e); process.exit(1); });
