#!/usr/bin/env node
// v073-live-redteam.mjs — THE v0.73 LIVE RED-TEAM (NVIDIA, real hub).
// Drives REAL model turns over the engine's chat WS and verifies the
// everything-is-a-bundle contract end-to-end:
//   turn 1 — the model names the SIX types + both gates, and filters the
//             live bundles with q= (its own tool call, verbatim output).
//   turn 2 — the model autonomously downloads the Noir Detective persona
//             and ARMS it (persona_set from) — the deterministic
//             "PERSONA ACTIVE — Noir Detective" marker must land in the
//             event log + the session row.
// Usage: node scripts/v073-live-redteam.mjs [sessionId]
const BASE = 'http://127.0.0.1:8080';
const SESS = process.argv[2] || '6abb7a21d6999e17fea09f40';

const PROMPTS = [
  "Quick question: what item TYPES does this app's public library serve, and which two switches gate whether you can USE them vs DOWNLOAD new ones? Use your hublib tool (action=bundles, q=superpowers) to name the bundle you'd use for methodology work, then answer in <=6 lines.",
  "I saw a 'Noir Detective' persona in the hub library (type=persona). Find it, download it, and make it your ACTIVE persona — then greet me fully in character.",
];

function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false;
    let sendTs = 0; // events older than the send are REPLAYED history — never end on those
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { sendTs = Date.now() / 1000 - 1; ws.send(JSON.stringify({ type: 'send', message: text })); };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data.toString());
        events.push(e);
        // the engine signals turn end via status {state: idle|error} — but
        // only count it from THIS turn (ts after the send; replays are old)
        if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) {
          setTimeout(finish, 1200);
        }
      } catch {}
    };
    ws.onerror = (err) => { events.push({ type: 'ws_error', message: String(err.message || err) }); finish(); };
    setTimeout(finish, waitMs || 420000);
  });
}

(async () => {
  console.log(`== live red-team on session ${SESS} (NVIDIA) ==`);
  for (let i = 0; i < PROMPTS.length; i++) {
    console.log(`\n-- turn ${i + 1}: ${PROMPTS[i].slice(0, 80)}…`);
    const evs = await wsTurn(SESS, PROMPTS[i]);
    const types = evs.map((e) => e.type);
    console.log(`   events (${types.length}): ${JSON.stringify(types.slice(0, 24))}`);
    for (const e of evs) {
      if (['tool_use', 'tool_result'].includes(e.type)) {
        const s = JSON.stringify(e);
        console.log(`   [${e.type}] ${s.slice(0, 500)}`);
      } else if (e.type === 'error') {
        console.log(`   [error] ${JSON.stringify(e).slice(0, 200)}`);
      } else if (e.type === 'status' && (e.state === 'idle' || e.state === 'error')) {
        console.log(`   [status ${e.state}]`);
      }
    }
    const text = evs.filter((e) => e.type === 'assistant' || e.role === 'assistant')
      .map((e) => String(e.text || e.content || '')).join('');
    if (text) console.log(`   assistant: ${text.slice(0, 900)}`);
  }
  const row = await fetch(`${BASE}/api/sessions/${SESS}`).then((r) => r.json()).catch(() => null);
  const personas = row && (row.Personas || row.personas || '');
  console.log(`\n== session personas: ${String(personas).slice(0, 300)}`);
  const ok = /Noir Detective/.test(String(personas)) && /always/.test(String(personas));
  console.log(ok ? 'PASS: Noir Detective is the always-active persona' : 'FAIL: persona not active');
  process.exit(ok ? 0 : 1);
})();
