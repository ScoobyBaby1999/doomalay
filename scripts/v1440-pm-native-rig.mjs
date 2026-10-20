// v1440-pm-native-rig.mjs — v1.44.6 THE PROOF (PLAN-V144 §6): the live
// red-team battery for NATIVE PM — every flow the wave shipped, driven
// the way the real app drives them, against a real engine + the real
// deployment, with the real key:
//
//   PM_KEY=<key> [MISTRAL_KEY=<key>] node scripts/v1440-pm-native-rig.mjs
//
// ARMS:
//   R1  boot + key + the honest fresh state (unpinned, key present)
//   R2  THE UNBROKEN STREAM, PM arm — a 300+ token streaming turn over
//       the WS: thinking events from reasoning_content, content deltas,
//       the idle verdict, honest usage, and the TOFU pin landing
//   R3  THE SEAMLESS CUT, PM arm — socket killed mid-stream; the turn
//       keeps running engine-side; the &since resume shows the truth
//       (the v1.39/v1400 law owns PM now)
//   R4  effort: a max-effort turn rides the chat_template_kwargs body
//       and completes (the effort registry's PMAI case, live)
//   R5  model switch mid-chat (glm-5.3-flash → glm-flash-latest)
//   R6  provider switch (PM → mistral → PM, when MISTRAL_KEY is set; the foreign provider's own verdict — 429 included — is the honest terminal)
//   R7  re-verify: reverify clears → the next turn TOFU re-pins headless
//       (verified:false — the honest state; the UI oracle owns upgrades)
//   R8  revoked-key honesty: a second engine with a bogus key answers
//       the honest 401-class error, never a silent success
//   R9  the source pins: the strip's structural laws (oracle-only pmsdk,
//       no PM branches in chatframework/chatpanel, the nudge, the
//       ticket gate, the local bridge route, the catalogs' bridge URL)
//
// NOT rig-provable live (documented honestly): the manifest-mismatch
// drift conviction (needs the deployment to rotate its CA —
// offline-proven in pmstate's fake-cert battery) and the forced
// 45-minute secret renewal (needs the hour to pass — the renewal floor
// + import laws are offline-proven; R2/R5/R7 prove cached-secret reuse
// across turns). The UI surfaces (pill, oracle button flow, tickets in
// the real WebView) were agent-browser-proven in the v1.44.2-v1.44.4
// phase records.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PM_KEY = process.env.PM_KEY || '';
const MISTRAL_KEY = process.env.MISTRAL_KEY || '';
if (!PM_KEY) { console.error('PM_KEY env required — the rig is LIVE'); process.exit(1); }

let ok = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── engine lifecycle ──────────────────────────────────────────────
function buildEngine(tag) {
  const bin = `/tmp/doomalay-v1440-${tag}`;
  const r = spawnSync('go', ['build', '-o', bin, './cmd/doomalay'], { cwd: join(ROOT, 'engine'), stdio: 'inherit' });
  if (r.status !== 0) throw new Error('engine build failed');
  return bin;
}
async function bootEngine(tag) {
  const bin = buildEngine(tag);
  const dir = mkdtempSync(join(tmpdir(), `v1440-${tag}-`));
  const port = tag === 'a' ? 8095 : 8096;
  const proc = spawn(bin, ['--port', String(port), '--data-dir', dir, '--bind', '127.0.0.1'], {
    env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logChunks = [];
  proc.stdout.on('data', d => logChunks.push(d));
  proc.stderr.on('data', d => logChunks.push(d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { proc, base, dir, port, log: () => logChunks.join('') };
    } catch {}
  }
  throw new Error(`engine ${tag} did not come up:\n` + logChunks.join(''));
}
async function stopEngine(e) {
  try { e.proc.kill('SIGTERM'); } catch {}
  await sleep(300);
  try { rmSync(e.dir, { recursive: true, force: true }); } catch {}
}

async function api(base, path, opts) {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// ── the WS chat driver (the browser's own protocol) ────────────────
function wsChat(base, sessionID, { since } = {}) {
  const url = `ws://127.0.0.1:${base.split(':').pop()}/api/chat?session_id=${sessionID}${since ? `&since=${since}` : ''}`;
  const ws = new WebSocket(url);
  const events = [];
  let lastSeq = 0; // the PER-SESSION seq (msg.seq) — &since speaks this, NOT the global event id (msg.i)
  const waiters = [];
  function pumpWaiters() {
    while (waiters.length && waiters[0].pred(events)) {
      const w = waiters.shift();
      w.resolve();
    }
  }
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (typeof msg.seq === 'number' && msg.seq > lastSeq) lastSeq = msg.seq;
    events.push(msg);
    pumpWaiters();
  });
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', e => rej(new Error('ws error: ' + (e.message || 'connection'))));
  });
  return {
    ws, events, opened,
    get lastSeq() { return lastSeq; },
    send(payload) { ws.send(JSON.stringify({ session_id: sessionID, ...payload })); },
    waitFor(pred, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const w = {
          pred,
          resolve() {
            if (!settled) { settled = true; clearTimeout(t); resolve(); }
          },
        };
        const t = setTimeout(() => {
          if (!settled) {
            settled = true;
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error(`timeout waiting for ${label} (lastSeq=${lastSeq}, ${events.length} events)`));
          }
        }, timeoutMs);
        waiters.push(w);
        pumpWaiters(); // safe: w.resolve is TDZ-free (t is already assigned)
      });
    },
    close() { try { ws.close(); } catch {} },
    // waitForOrTimeout: same as waitFor but resolves false on timeout
    // (never throws) — for arms where an external provider's luck must
    // not fail the rig.
    waitForOrTimeout(pred, timeoutMs, label) {
      return this.waitFor(pred, timeoutMs, label).then(() => true, () => false);
    },
  };
}
const isIdle = evs => evs.some(e => e.type === 'status' && e.state === 'idle');
const isErr = evs => evs.some(e => e.type === 'status' && e.state === 'error');

async function createSession(base, over) {
  const r = await api(base, '/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'v1440 rig', sandbox: 'quick', provider: 'privatemodeai', model: 'privatemodeai/glm-5.3-flash', ...over }),
  });
  if (r.status !== 201) throw new Error('session create: ' + r.status + ' ' + r.text);
  return r.json.ID || r.json.id;
}

// ── the arms ───────────────────────────────────────────────────────
try {
  console.log('R1 — boot + key + the honest fresh state');
  const eng = await bootEngine('a');
  try {
    await api(eng.base, '/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'privatemodeai', key: PM_KEY }) });
    let st = (await api(eng.base, '/api/pm/state')).json;
    check('R1: key present, unpinned, unverified', st.key_present === true && st.pinned === false && st.verified === false, JSON.stringify(st));

    console.log('R2 — THE UNBROKEN STREAM (PM arm): a 300+ token streamed turn');
    const sid = await createSession(eng.base, {});
    const chat = wsChat(eng.base, sid);
    await chat.opened;
    chat.send({ type: 'send', message: 'Write a vivid 350-word story about a lighthouse keeper who discovers the light has been guiding something unexpected. Just the story, no preamble.' });
    await chat.waitFor(isIdle, 120000, 'the 350-word turn to finish');
    const deltas = chat.events.filter(e => e.type === 'assistant_delta');
    const thinking = chat.events.filter(e => e.type === 'thinking');
    const content = deltas.map(e => e.text || '').join('');
    const idleEv = chat.events.find(e => e.type === 'status' && e.state === 'idle');
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    if (!idleEv || !idleEv.usage || !(idleEv.usage.total_tokens > 100)) {
      console.log('     [debug] all status events:', JSON.stringify(chat.events.filter(e => e.type === 'status')));
    }
    check('R2: content streamed (>=250 words of story)', words >= 250, `${words} words`);
    check('R2: the turn terminated idle with usage', !!idleEv && idleEv.usage && (idleEv.usage.total_tokens || 0) > 100, JSON.stringify(idleEv && idleEv.usage));
    check('R2: zero terminal errors', !isErr(chat.events));
    console.log(`     (${deltas.length} content deltas, ${thinking.length} thinking events, ${words} words, ${idleEv && idleEv.usage && idleEv.usage.total_tokens} tokens)`);
    st = (await api(eng.base, '/api/pm/state')).json;
    check('R2: the TOFU pin landed engine-side (pinned, honestly unverified)', st.pinned === true && st.verified === false && st.secret_expires_in > 0, JSON.stringify(st));

    console.log('R3 — THE SEAMLESS CUT (PM arm): socket killed mid-stream, engine keeps the turn');
    const sid3 = await createSession(eng.base, { title: 'v1440 cut' });
    const cut1 = wsChat(eng.base, sid3);
    await cut1.opened;
    cut1.send({ type: 'send', message: 'Count slowly from 1 to 40, one number per line, no commentary.' });
    await cut1.waitFor(evs => evs.filter(e => e.type === 'assistant_delta').length >= 3, 60000, 'the first deltas');
    const seqAtCut = cut1.lastSeq;
    console.log(`     [r3] at cut: ${cut1.events.length} events, lastSeq=${seqAtCut}, deltas=${cut1.events.filter(e => e.type === 'assistant_delta').length}`);
    cut1.close(); // the kill
    await sleep(2500);
    const cut2 = wsChat(eng.base, sid3, { since: seqAtCut });
    await cut2.opened;
    // the v1400 armed-truth law: the turn keeps running engine-side — the
    // log is the truth; the resume shows it. Poll BOTH (the WS feed and
    // the persisted log) for the turn's idle terminal.
    let logIdle = false, wsIdle = false;
    const cutDeadline = Date.now() + 150000;
    while (Date.now() < cutDeadline && !(logIdle && wsIdle)) {
      await sleep(2000);
      if (!logIdle) {
        const log = await api(eng.base, `/api/sessions/${sid3}/events`);
        if (log.json && JSON.stringify(log.json).includes('"idle"')) logIdle = true;
      }
      wsIdle = cut2.events.some(e => e.type === 'status' && e.state === 'idle');
    }
    const resumed = cut2.events.filter(e => e.type === 'assistant_delta').map(e => e.text || '').join('');
    check('R3: the turn survived the cut engine-side (the log shows the idle terminal)', logIdle);
    check('R3: the &since resume streamed the post-cut content', resumed.replace(/\s/g, '').length > 10, JSON.stringify(resumed.slice(0, 60)));
    check('R3: the resumed socket saw the terminal (the armed-truth law, WS arm)', wsIdle, `events=${cut2.events.length} types=${JSON.stringify([...new Set(cut2.events.map(e => e.type))])}`);
    if (!wsIdle) {
      const raw = await api(eng.base, `/api/sessions/${sid3}/events`);
      console.log('     [debug] log raw head:', raw.text.slice(0, 300));
      console.log('     [debug] cut2 readyState:', cut2.ws.readyState, 'events:', cut2.events.length);
      console.log('     [debug] engine tail:', eng.log().split('\n').slice(-10).join(' | '));
    }

    console.log('R4 — effort: the max-effort body rides chat_template_kwargs');
    const sid4 = await createSession(eng.base, { title: 'v1440 effort' });
    const chat4 = wsChat(eng.base, sid4);
    await chat4.opened;
    chat4.send({ type: 'send', message: 'In one sentence: what is a lighthouse for?', effort: 'max' });
    await chat4.waitFor(isIdle, 120000, 'the effort turn');
    check('R4: the max-effort PM turn completed (the PMAI body accepted)', !isErr(chat4.events) && chat4.events.some(e => e.type === 'assistant_delta'));

    console.log('R5 — model switch mid-chat');
    const sid5 = await createSession(eng.base, { title: 'v1440 switch' });
    const chat5 = wsChat(eng.base, sid5);
    await chat5.opened;
    chat5.send({ type: 'send', message: 'Say exactly: ONE OK' });
    await chat5.waitFor(isIdle, 120000, 'the first-model turn');
    check('R5a: glm-5.3-flash turn ok', !isErr(chat5.events));
    await api(eng.base, `/api/sessions/${sid5}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'privatemodeai/glm-flash-latest', provider: 'privatemodeai' }) });
    const seqAfterFirst = chat5.lastSeq;
    chat5.send({ type: 'send', message: 'Say exactly: TWO OK', model: 'privatemodeai/glm-flash-latest', provider: 'privatemodeai' });
    await chat5.waitFor(evs => evs.some(e => (e.seq || 0) > seqAfterFirst && e.type === 'assistant_delta') && evs.some(e => (e.seq || 0) > seqAfterFirst && e.type === 'status' && e.state === 'idle'), 120000, 'the switched-model turn');
    const two = chat5.events.filter(e => (e.seq || 0) > seqAfterFirst && e.type === 'assistant_delta').map(e => e.text || '').join('');
    check('R5b: glm-flash-latest served the switched turn', /TWO/i.test(two), JSON.stringify(two.slice(0, 40)));

    if (MISTRAL_KEY) {
      console.log('R6 — provider switch (PM → mistral → PM; the foreign provider\'s own verdict — 429 included — is the honest terminal)');
      await api(eng.base, '/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'mistral', key: MISTRAL_KEY }) });
      const sid6 = await createSession(eng.base, { title: 'v1440 prov' });
      const chat6 = wsChat(eng.base, sid6);
      await chat6.opened;
      const seqBeforeMs = chat6.lastSeq;
      chat6.send({ type: 'send', message: 'Say exactly: MS OK', provider: 'mistral', model: 'mistral/mistral-small-latest' });
      // THE SWITCH MECHANICS are the assertion: the engine must accept the
      // provider switch and drive the foreign pipeline to an honest
      // TERMINAL — idle on success, error on the provider's own verdict
      // (a 429 rate limit is mistral's honest answer, not a switch bug).
      await chat6.waitForOrTimeout(
        evs => evs.some(e => (e.seq || 0) > seqBeforeMs && e.type === 'status' && (e.state === 'idle' || e.state === 'error')),
        150000, 'the mistral terminal');
      const msTerminal = chat6.events.find(e => (e.seq || 0) > seqBeforeMs && e.type === 'status' && (e.state === 'idle' || e.state === 'error'));
      const msTypes = [...new Set(chat6.events.filter(e => (e.seq || 0) > seqBeforeMs).map(e => e.type))];
      check('R6a: the engine drove the switched mistral turn to an honest terminal', !!msTerminal,
        JSON.stringify(msTypes) + ' :: ' + JSON.stringify(chat6.events.filter(e => (e.seq || 0) > seqBeforeMs).slice(0, 5).map(e => ({ t: e.type, s: e.state, m: (e.message || e.text || '').slice(0, 60) }))));
      console.log(`     (mistral terminal: ${msTerminal && msTerminal.state})`);
      const seqBeforeBack = chat6.lastSeq;
      chat6.send({ type: 'send', message: 'Say exactly: BACK OK', provider: 'privatemodeai', model: 'privatemodeai/glm-5.3-flash' });
      await chat6.waitFor(evs => evs.some(e => (e.seq || 0) > seqBeforeBack && e.type === 'assistant_delta') && evs.some(e => (e.seq || 0) > seqBeforeBack && e.type === 'status' && e.state === 'idle'), 120000, 'the back-to-PM turn');
      const back = chat6.events.filter(e => (e.seq || 0) > seqBeforeBack && e.type === 'assistant_delta').map(e => e.text || '').join('');
      check('R6b: back on PM, the encrypted wire served again', /BACK/i.test(back), JSON.stringify(back.slice(0, 40)));
    } else {
      console.log('R6 — SKIPPED (MISTRAL_KEY not set; the switch itself is engine-generic)');
    }

    console.log('R7 — re-verify: clear → the next headless turn TOFU re-pins');
    await api(eng.base, '/api/pm/reverify', { method: 'POST' });
    st = (await api(eng.base, '/api/pm/state')).json;
    check('R7a: reverify cleared the pin', st.pinned === false);
    const sid7 = await createSession(eng.base, { title: 'v1440 reverify' });
    const chat7 = wsChat(eng.base, sid7);
    await chat7.opened;
    chat7.send({ type: 'send', message: 'Say exactly: REPIN OK' });
    await chat7.waitFor(isIdle, 120000, 'the post-reverify turn');
    check('R7b: the post-reverify turn streams on the fresh pin', !isErr(chat7.events));
    st = (await api(eng.base, '/api/pm/state')).json;
    check('R7c: the headless turn re-pinned TOFU (honestly unverified)', st.pinned === true && st.verified === false, JSON.stringify(st));
  } finally {
    await stopEngine(eng);
  }

  console.log('R8 — revoked-key honesty (a second engine, a bogus key)');
  const eng2 = await bootEngine('b');
  try {
    await api(eng2.base, '/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'privatemodeai', key: 'pm-bogus-key-not-real' }) });
    const sid8 = await createSession(eng2.base, { title: 'v1440 revoked' });
    const chat8 = wsChat(eng2.base, sid8);
    await chat8.opened;
    chat8.send({ type: 'send', message: 'hello' });
    await chat8.waitFor(isErr, 120000, 'the honest revoked-key error');
    const errEv = chat8.events.find(e => (e.type === 'error') || (e.type === 'status' && e.state === 'error'));
    const errText = JSON.stringify(chat8.events.filter(e => e.type === 'error' || e.type === 'status'));
    check('R8: the bogus key surfaced an honest error (never a silent success)', !!errEv);
    check('R8: the error speaks auth/key language', /401|unauthorized|invalid|key|api/i.test(errText), errText.slice(0, 160));
  } finally {
    await stopEngine(eng2);
  }

  console.log('R9 — the source pins (the strip’s structural laws)');
  const read = p => readFileSync(join(ROOT, p), 'utf8');
  const pmsdk = read('engine/internal/server/web/vendor/pm/pmsdk.js');
  const framework = read('engine/internal/server/web/chatframework.js');
  const panel = read('engine/internal/server/web/chatpanel.js');
  const serverGo = read('engine/internal/server/server.go');
  const keysGo = read('engine/internal/server/keys.go');
  const pmlocal = read('engine/internal/server/pmlocal.go');
  const catalog = read('brain/providers_catalog.json');
  check('R9a: pmsdk is oracle-only (no streamChat/runToolLoop exports)', !/streamChat:/.test(pmsdk) && !/runToolLoop/.test(pmsdk));
  check('R9b: pmsdk carries the oracle + re-verify drive', /reportBootstrap/.test(pmsdk) && /rerunOracle/.test(pmsdk));
  check('R9c: chatframework has no PM branch (every quick chat rides runWSTurn)', !/privatemodeai/.test(framework));
  check('R9d: chatpanel has no PM turn twins (no runPMTurn/pmSystemContext/pmDocsLadder)', !/runPMTurn|pmSystemMessage|pmDocsLadder/.test(panel));
  check('R9e: ZERO auto-wasm in the chat UI (the v1.44.4 nudge died in v1.45.4 THE QUIET ORACLE — PM chats ride the TOFU pin; the provider card\'s explicit button is the only wasm trigger)', !/pmOracleNudge/.test(panel) && !/rerunOracle/.test(panel));
  check('R9f: the ticket gate guards the key endpoint', /consumePMTicket/.test(keysGo));
  check('R9g: the local bridge route is registered', /\/api\/pm\/local\/v1\/chat\/completions/.test(serverGo));
  check('R9h: the bridge enforces api-key-fallback=never (constant-time)', /subtle\.ConstantTimeCompare/.test(pmlocal));
  check('R9i: the brain catalog points at the engine bridge', /\{DOOMALAY_ENGINE_URL\}\/api\/pm\/local\/v1\/chat\/completions/.test(catalog));
} catch (e) {
  fail++;
  fails.push('RIG ERROR: ' + e.message);
  console.error('RIG ERROR:', e.message);
}

console.log('\n════════════════════════════════════════════');
console.log(`${ok} ok, ${fail} FAIL — v1.44.6 THE PROOF (v1440 pm-native rig)`);
if (fails.length) fails.forEach(f => console.log('  ✗ ' + f));
process.exit(fail > 0 ? 1 : 0);
