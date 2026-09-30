#!/usr/bin/env node
// v0765 HF-space E2E — engine-driven (the REAL user flow): HF-sandbox
// session on the local engine, WS turns, watch every event.
const SESS = process.argv[2];
const MSG = process.argv[3];
const WAIT = parseInt(process.argv[4] || '420', 10);

function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false;
    const sendTs = Date.now() / 1000 - 1;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'send', message: text })); console.log(`[ws] sent: ${text.slice(0, 90)}`); };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data.toString());
        events.push(e);
        const ts = new Date((e.ts || Date.now() / 1000) * 1000).toISOString().slice(11, 19);
        if (e.type === 'status') console.log(`[${ts}] status: ${e.state}${e.detail ? ' — ' + String(e.detail).slice(0, 140) : ''}`);
        else if (e.type === 'progress') console.log(`[${ts}] progress: ${String(e.message || e.text || '').slice(0, 160)}`);
        else if (e.type === 'tool_use') console.log(`[${ts}] tool_use: ${e.name} ${(JSON.stringify(e.input || {}) || '').slice(0, 110)}`);
        else if (e.type === 'tool_result') console.log(`[${ts}] tool_result: ${String(e.text || e.output || '').slice(0, 180).replace(/\n/g, ' ⏎ ')}`);
        else if (e.type === 'assistant_delta') { } // too chatty
        else if (e.type === 'assistant') console.log(`[${ts}] assistant: ${String(e.text || '').slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
        else if (e.type === 'error') console.log(`[${ts}] ERROR: ${JSON.stringify(e).slice(0, 220)}`);
        else console.log(`[${ts}] ${e.type}: ${JSON.stringify(e).slice(0, 120)}`);
        if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) setTimeout(finish, 1200);
      } catch {}
    };
    ws.onerror = (err) => { console.log('[ws] ERROR', String(err.message || err)); finish(); };
    setTimeout(finish, waitMs * 1000);
  });
}

(async () => {
  const evs = await wsTurn(SESS, MSG, WAIT);
  const types = {};
  for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
  console.log('---');
  console.log('event counts:', JSON.stringify(types));
  let final = '';
  for (const e of evs) if (e.type === 'assistant' || e.type === 'assistant_delta') final += (e.text || e.delta || '');
  console.log('assistant text (tail 600):', final.slice(-600).replace(/\n/g, ' ⏎ ') || '(EMPTY)');
})();
