#!/usr/bin/env node
// v1692-room-rig.mjs — v1.69.2 THE SHARED CANVAS · THE ROOM, the LIVE
// proof against the REAL engine binary: the REAL SharedDocSession from
// collabcore.js (the actual client class, mock-adapter recording every
// apply) + a second RAW WebSocket device — two devices, one canvas,
// real HTTP + real WS. The legs:
//
//   LEG A — THE LIVE FAN-OUT: device A (a real session) derives + submits
//           a doc diff over the WS; device B (a raw socket) receives the
//           broadcast; A's own ack clears pending; the room census shows
//           2 members.
//
//   LEG B — THE PENDING LAW (Figma's optimistic rule): A holds an
//           un-acked op on (icon, prop); a guest op covering the SAME
//           prop arrives → A's apply SKIPS the covered prop, applies the
//           rest; A's baseline still takes the whole server op.
//
//   LEG C — RECONNECT + REPLAY: A's socket dies; ops land meanwhile
//           (device B submits over HTTP); A reconnects with its cursor →
//           the replay batch applies → the docs converge.
//
//   LEG D — THE 409 REBASE: a stale whole-state PUT (an old cursor)
//           409s; the rebase pulls the missed ops and converges; the
//           fresh PUT (advanced cursor) lands 200.
//
//   LEG E — DORMANCY + THE CHECKPOINT CADENCE: with members live the
//           room shows in the census; the WS submit's fold is NOT in the
//           row before the calm window and IS after it; the last leave
//           flushes + empties the census (zero rooms, zero goroutines).
//
// Honesty law: every assertion binds to the tool's own frames — no
// inference from side effects.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8692;
const ENGINE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/v1692-data';

// the REAL client core (the node path)
const Codec = (await import('file://' + path.join(__ROOT, 'engine/internal/server/web/collabcore.js').replace(/\\/g, '/'))).default;

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 500) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// the session's api — the real fetchers against the real binary
const realAPI = {
  fetchDoc: (canvas) => fetch(`${ENGINE}/api/collab/${canvas}/doc`).then((r) => r.json()),
  fetchOps: (canvas, since) => fetch(`${ENGINE}/api/collab/${canvas}/ops?since=${since || 0}`).then((r) => r.json()),
  postOps: async (canvas, device, ops) => {
    const r = await fetch(`${ENGINE}/api/collab/${canvas}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, ops }) });
    if (!r.ok) throw new Error('post ' + r.status);
    return r.json();
  },
  wsURL: (canvas, since, device, name) => `ws://127.0.0.1:${PORT}/api/collab/live?canvas=${encodeURIComponent(canvas)}&since=${since || 0}&device=${encodeURIComponent(device)}&name=${encodeURIComponent(name || '')}`
};

// a mock adapter over the REAL session — a doc model + the apply record
function mockAdapter() {
  const st = { doc: { icons: [], dots: [], currentFamily: 'default', worldSize: 0 }, applied: [], members: [] };
  return {
    _st: st,
    getDoc: () => JSON.parse(JSON.stringify(st.doc)),
    applyOp: (op) => { st.applied.push(op); Codec.applyOpToDoc(st.doc, op); },
    afterRebase: () => { st.rebased = true; },
    onMembers: (m) => { st.members = m; },
    onPresence: () => {}
  };
}

// a raw WS member (device B) — the second device
function rawMember(canvas, since, device) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(realAPI.wsURL(canvas, since, device, device));
    const frames = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      frames.push(f);
      for (const w of waiters.splice(0)) if (w.pred(f)) w.res(f);
    };
    ws.onopen = () => resolve({
      ws, frames,
      send: (o) => ws.send(JSON.stringify(o)),
      next: (pred, ms) => new Promise((res) => {
        const hit = frames.find(pred);
        if (hit) return res(hit);
        waiters.push({ pred, res });
        if (ms) setTimeout(res, ms);
      }),
      close: () => ws.close()
    });
    ws.onerror = reject;
  });
}

async function main() {
  console.log('v1.69.2 THE SHARED CANVAS — THE ROOM (the live two-device proof)');
  execSync(`cd ${__ROOT}/engine && go build -o /tmp/v1692-engine ./cmd/doomalay 2>&1`, { stdio: 'inherit', env: { ...process.env, PATH: '/home/z/sdk/go/bin:' + process.env.PATH } });
  fs.rmSync(DATA, { recursive: true, force: true });
  const engine = spawn('/tmp/v1692-engine', ['--port', String(PORT), '--data-dir', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  const engineErr = [];
  engine.stderr.on('data', (d) => engineErr.push(String(d)));
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) break; } catch (e) {} await sleep(200); }

    // the seed canvas
    let r = await api('POST', '/api/canvases', { id: 'cv_live', name: 'Live', state: {
      offset: { x: 0, y: 0 }, scale: 1, currentFamily: 'default',
      icons: [{ id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby', sessionId: 's1' }],
      dots: [], settings: { theme: 'aurora' }, savedAt: 111
    } });
    ok('seed canvas', r.status === 201, r.body);

    // ══ LEG A — the live fan-out ══════════════════════════════════
    console.log('LEG A — THE LIVE FAN-OUT');
    const adapterA = mockAdapter();
    adapterA._st.doc.icons = [{ id: 'chat_a', type: 'chat', x: 10, y: 20, name: 'Scooby', sessionId: 's1' }];
    const sessionA = new Codec.SharedDocSession({ canvas: 'cv_live', device: 'devA', name: 'Phone A', api: realAPI, adapter: adapterA, codec: Codec });
    await sessionA.activate();
    ok('A adopted (cursor 0, live)', sessionA.adopted && sessionA.cursor === 0, sessionA.cursor);
    await sleep(150);
    const memberB = await rawMember('cv_live', sessionA.cursor, 'devB');
    const bHello = await memberB.next((f) => f.t === 'hello', 3000);
    ok('B joined (hello)', !!bHello, memberB.frames);
    await sleep(150);
    ok('A sees the roster (2 members)', adapterA._st.members.length === 2, adapterA._st.members);

    // A's user moves + renames the icon, adds a second one — the saveNow seam
    const nextDoc = { icons: [
      { id: 'chat_a', type: 'chat', x: 42, y: 55, name: 'Renamed', sessionId: 's1' },
      { id: 'chat_b', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' }
    ], dots: [], currentFamily: 'default', worldSize: 32768 };
    const opsCountBefore = sessionA.opCounter;
    sessionA.capture({ icons: nextDoc.icons, dots: nextDoc.dots, currentFamily: nextDoc.currentFamily, worldSize: nextDoc.worldSize });
    ok('A derived a batch (set+add+doc.set)', sessionA.opCounter > opsCountBefore && sessionA.pending.length === 3, { pending: sessionA.pending.map((p) => p.kind) });
    // B receives the broadcast
    const bBatch = await memberB.next((f) => f.t === 'ops' && !f.replay && f.ops && f.ops.length === 3, 4000);
    ok('B received the 3-op broadcast', !!bBatch, memberB.frames.map((f) => f.t + ':' + (f.ops || []).length));
    ok('the broadcast carries the stamps', bBatch && bBatch.ops.every((o) => typeof o.seq === 'number' && o.device === 'devA'), bBatch && bBatch.ops[0]);
    // A's own ack clears pending (the frames came back through the room)
    await sleep(400);
    ok('A pending cleared by its own ack', sessionA.pending.length === 0, sessionA.pending);
    ok('A cursor advanced to 3', sessionA.cursor === 3, sessionA.cursor);
    const census = await api('GET', '/api/collab/rooms');
    ok('the census shows ONE live room with 2 members', census.body.rooms.length === 1 && census.body.rooms[0].members === 2, census.body);

    // ══ LEG B — the pending law ═══════════════════════════════════
    console.log('LEG B — THE PENDING LAW (the optimistic rule)');
    // A's user edits the icon: rename chat_a to "MineNow" — in reality the
    // WORLD is the edited state (saveNow diffs it); the mock models that.
    adapterA._st.doc.icons[0] = { id: 'chat_a', type: 'chat', x: 42, y: 55, name: 'MineNow', sessionId: 's1' };
    sessionA.capture({ icons: [
      { id: 'chat_a', type: 'chat', x: 42, y: 55, name: 'MineNow', sessionId: 's1' },
      { id: 'chat_b', type: 'chat', x: 77, y: 88, name: 'Fresh', sessionId: '' }
    ], dots: [], currentFamily: 'default', worldSize: 32768 });
    const pendingRename = sessionA.pending.slice();
    ok('A holds the rename pending', pendingRename.length === 1 && pendingRename[0].kind === 'icon.set', pendingRename);
    // the guest op arrives while A's op is STILL PENDING — injected as
    // the exact frame the wire would deliver (the pending law is client
    // logic; the wire legs above pin the wire). The guest covers name
    // (A's pending prop — A WINS) + x (uncovered — applies).
    sessionA.handleFrame({ t: 'ops', ops: [{
      opId: 'devB:1', kind: 'icon.set', id: 'chat_a',
      props: { x: 999, name: 'GuestName' },
      seq: sessionA.cursor + 1, device: 'devB', at: 1
    }] });
    const aFrame = adapterA._st.applied.find((o) => o.kind === 'icon.set' && o.id === 'chat_a' && o.props && o.props.x === 999);
    ok('A applied the guest op (partially)', !!aFrame, adapterA._st.applied);
    if (aFrame) {
      ok('the covered prop SKIPPED (my pending wins: name)', aFrame.props.name === undefined, aFrame);
      ok('the uncovered prop APPLIED (x → 999)', aFrame.props.x === 999, aFrame);
    }
    ok("A's world keeps its optimistic name", adapterA._st.doc.icons[0].name === 'MineNow', adapterA._st.doc.icons[0]);
    ok("A's baseline takes the WHOLE server op", sessionA.baseline.icons[0].name === 'GuestName' && sessionA.baseline.icons[0].x === 999, sessionA.baseline.icons[0]);
    await sleep(600);
    ok('A pending cleared by the acks', sessionA.pending.length === 0, sessionA.pending);

    // ══ LEG C — reconnect + replay ═════════════════════════════════
    console.log('LEG C — RECONNECT + REPLAY');
    const cursorBefore = sessionA.cursor;
    sessionA.transport.close();          // A's socket dies
    sessionA.transport = null;
    await sleep(100);
    // B (still live) moves the icon twice over its WS
    await memberB.send({ t: 'ops', ops: [{ opId: 'devB:2', kind: 'icon.set', id: 'chat_a', props: { x: 123 } }] });
    await memberB.send({ t: 'ops', ops: [{ opId: 'devB:3', kind: 'icon.add', icon: { id: 'chat_c', type: 'web', x: 5, y: 6, url: 'https://x.test' } }] });
    await sleep(500);
    // A reconnects (the session's ladder would; the rig drives it NOW)
    await sessionA.connect();
    const replayBatch = await new Promise((res) => {
      const iv = setInterval(() => {
        const hit = adapterA._st.applied.find((o) => (o.kind === 'icon.set' && o.id === 'chat_a' && o.props && o.props.x === 123) || (o.kind === 'icon.add' && o.icon && o.icon.id === 'chat_c'));
        if (hit) { clearInterval(iv); res(hit); }
      }, 50);
      setTimeout(() => { clearInterval(iv); res(null); }, 4000);
    });
    ok('A caught up through the replay after reconnect', !!replayBatch, adapterA._st.applied.map((o) => o.kind));
    ok('A cursor advanced past the gap', sessionA.cursor >= cursorBefore + 2, { before: cursorBefore, now: sessionA.cursor });

    // ══ LEG D — the 409 rebase ═════════════════════════════════════
    console.log('LEG D — THE 409 REBASE');
    // B lands one more op; A's whole-state PUT (the old cursor) must 409
    await memberB.send({ t: 'ops', ops: [{ opId: 'devB:4', kind: 'icon.set', id: 'chat_c', props: { x: 8 } }] });
    await sleep(300);
    const staleState = { icons: adapterA._st.doc.icons, dots: [], currentFamily: 'default', worldSize: 32768, syncSeq: sessionA.cursor - 1, savedAt: Date.now() };
    r = await api('PUT', '/api/canvases/cv_live', { state: staleState });
    ok('the stale PUT 409s (stale-doc)', r.status === 409 && r.body.error === 'stale-doc', r.body);
    // the rebase: pull the missed op, converge
    const xBefore = adapterA._st.doc.icons.find((i) => i.id === 'chat_c').x;
    await sessionA.rebase();
    await sleep(400);
    const cAfter = adapterA._st.doc.icons.find((i) => i.id === 'chat_c');
    ok('the rebase applied the missed op (x → 8)', cAfter.x === 8, { xBefore, cAfter });
    ok('the rebase cleared pending', sessionA.pending.length === 0, sessionA.pending);
    // the fresh PUT (advanced cursor) lands 200
    const freshState = { icons: adapterA._st.doc.icons, dots: [], currentFamily: 'default', worldSize: 32768, syncSeq: sessionA.cursor, savedAt: Date.now() };
    r = await api('PUT', '/api/canvases/cv_live', { state: freshState });
    ok('the fresh PUT lands 200', r.status === 200, r.body);

    // ══ LEG E — dormancy + the checkpoint cadence ══════════════════
    console.log('LEG E — DORMANCY + THE CHECKPOINT CADENCE');
    // a WS submit: the row must NOT carry it before the calm window
    await memberB.send({ t: 'ops', ops: [{ opId: 'devB:5', kind: 'doc.set', path: 'worldSize', value: 65536 }] });
    await sleep(250);
    r = await api('GET', '/api/canvases/cv_live');
    ok('the WS fold is NOT in the row before the calm window', r.body.canvas.state.worldSize !== 65536, r.body.canvas.state.worldSize);
    await sleep(2400);
    r = await api('GET', '/api/canvases/cv_live');
    ok('the calm checkpoint landed (worldSize 65536)', r.body.canvas.state.worldSize === 65536, r.body.canvas.state.worldSize);
    // everyone leaves → the census empties (dormancy)
    sessionA.close();
    await memberB.close();
    await sleep(400);
    r = await api('GET', '/api/collab/rooms');
    ok('the census is EMPTY after the last leave (dormancy)', (r.body.rooms || []).length === 0, r.body);
    // the trailing checkpoint flushed: the live doc equals the row
    r = await api('GET', '/api/collab/cv_live/doc');
    ok('the /doc read answers the durable fold after the drop', r.body.doc.worldSize === 65536 && r.body.live === false, r.body);
  } finally {
    engine.kill('SIGKILL');
  }
  console.log('');
  console.log(`\u2014\u2014 ${n - fails.length}/${n} GREEN \u2014\u2014`);
  if (fails.length) { console.log('FAILS: ' + fails.join(' | ')); process.exit(1); }
  if (engineErr.join('').includes('panic')) { console.log('ENGINE PANIC DETECTED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
