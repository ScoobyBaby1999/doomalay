#!/usr/bin/env node
// v0765-brain-path-redteam.mjs — the LOCAL-BRAIN quick-chat workspace E2E
// (desktop scenario: strands agent + dt_workspace + the new pr verb).
const SESS = process.argv[2];
if (!SESS) { console.error('usage: node v0765-brain-path-redteam.mjs <sessionId>'); process.exit(1); }
const PROMPTS = [
  "Which cloud workspace repo is connected to this chat? (workspace action=list) One line.",
  "Open a pull request on the connected repo: branch 'bot/brain-path' (create it via a write to notes/brain-e2e.md with content 'brain path E2E', then PR it into main, title 'Bot E2E: brain-path write + PR'). Use the workspace tool's write and pr actions. Give me the PR url at the end.",
];
function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false, sendTs = 0;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { sendTs = Date.now() / 1000 - 1; ws.send(JSON.stringify({ type: 'send', message: text })); };
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data.toString()); events.push(e);
      if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) setTimeout(finish, 2500); } catch {} };
    ws.onerror = () => finish();
    setTimeout(finish, waitMs || 560000);
  });
}
(async () => {
  for (let i = 0; i < PROMPTS.length; i++) {
    console.log(`\n-- turn ${i + 1}: ${PROMPTS[i].slice(0, 80)}…`);
    const evs = await wsTurn(SESS, PROMPTS[i]);
    let reply = '';
    for (const e of evs) {
      if (e.type === 'assistant_delta') reply += (e.text || '');
      if (e.type === 'tool_use' && (e.ts||0) >= Date.now()/1000 - 570) console.log(`   [tool_use] ${e.name} ${String(e.summary||'').slice(0,70)}`);
      if (e.type === 'tool_result' && (e.ts||0) >= Date.now()/1000 - 570) console.log(`   [tool_result] ${String(e.text||'').slice(0,220)}`);
      if (e.type === 'error') console.log(`   [error] ${JSON.stringify(e).slice(0,240)}`);
    }
    console.log(`   REPLY: ${reply.replace(/\s+/g,' ').slice(0, 420)}`);
  }
})();
