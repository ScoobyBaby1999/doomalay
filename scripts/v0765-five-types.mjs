#!/usr/bin/env node
// v0765 THE FIVE TYPES E2E — persona, skill, script, template, theme +
// the mixed bundle (superpowers-obra), driven as a real user through the
// engine WS with the lib pills ON.
const SESS = process.argv[2];

const PROMPT = `Prove this app's library end-to-end. Use your hub library tools and do ALL of this in one turn:
1. search type=persona, pick one, download it — confirm
2. search type=skill, pick one, download it — confirm
3. search type=script, pick one, download it — confirm
4. search type=template, pick one, download it — confirm
5. search type=theme, pick one, download it — confirm
6. browse bundles (action=bundles) and download the superpowers-obra bundle — the MIX (skills+scripts+docs) — confirm how many items landed
7. Final report: one line per type with the item name you downloaded, the bundle's item count, and the exact per-type local counts (the download observations tell you).`;

function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false;
    const sendTs = Date.now() / 1000 - 1;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'send', message: text })); console.log(`[ws] sent five-types test`); };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data.toString());
        if ((e.ts || 0) < sendTs - 5) return;
        events.push(e);
        const ts = new Date((e.ts || Date.now() / 1000) * 1000).toISOString().slice(11, 19);
        if (e.type === 'tool_use') console.log(`[${ts}] tool_use: ${e.name} ${String(e.summary || '').slice(0, 90)}`);
        else if (e.type === 'tool_result') console.log(`[${ts}] ↳ ${String(e.text || e.output || '').slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
        else if (e.type === 'status' && e.state) console.log(`[${ts}] status:${e.state}`);
        else if (e.type === 'error') console.log(`[${ts}] ERROR: ${JSON.stringify(e).slice(0, 200)}`);
        if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) setTimeout(finish, 1500);
      } catch {}
    };
    ws.onerror = (err) => { console.log('[ws] ERROR', String(err.message || err)); finish(); };
    setTimeout(finish, waitMs * 1000);
  });
}

(async () => {
  const evs = await wsTurn(SESS, PROMPT, parseInt(process.argv[3] || '2400', 10));
  const types = {};
  for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
  console.log('=== FIVE TYPES RESULT ===');
  console.log('event counts:', JSON.stringify(types));
  let final = '';
  for (const e of evs) if (e.type === 'assistant' || e.type === 'assistant_delta') final += (e.text || e.delta || '');
  console.log('final report:', final.slice(-900).replace(/\n/g, ' ⏎ ') || '(EMPTY)');
})();
