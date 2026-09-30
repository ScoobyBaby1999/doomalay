#!/usr/bin/env node
// v0765-live-workspace-redteam.mjs — THE v0.76.5 LIVE RED-TEAM.
// Drives REAL model turns (NVIDIA deepseek-v4.1-flash, direct path with
// the brain OFF — the APK quick-chat scenario) over the engine WS and
// verifies the workspace hand end-to-end:
//   turn 1 — the model SEES the connected workspace (the manifest) and
//             reports it (list).
//   turn 2 — history + code: view commits, read README.
//   turn 3 — PUSH: put a file onto a NEW feature branch (auto-created).
//   turn 4 — PR: open the pull request from that branch.
//   turn 5 — issues + discussions + fork surface.
// Usage: node scripts/v0765-live-workspace-redteam.mjs <sessionId>
const BASE = 'http://127.0.0.1:8080';
const SESS = process.argv[2];
if (!SESS) { console.error('usage: node v0765-live-workspace-redteam.mjs <sessionId>'); process.exit(1); }

const PROMPTS = [
  "Which cloud workspace repo is connected to this chat? Use your workspace tool (action=list) and answer in one line.",
  "Show me the last commits of the connected repo and then read its README — use the workspace tool. Answer with the commit subjects and the README's first heading, <=6 lines.",
  "Push a change: create file notes/bot-e2e.md with the content 'Written by the Doomalay bot during live E2E — direct path.' on a NEW branch 'bot/e2e-direct' of the connected repo. Use the workspace tool's put. Then confirm the branch + file.",
  "Now open a pull request from that branch into main, titled 'Bot E2E: direct-path put + PR'. Use the workspace tool's pr action. Give me the PR url.",
  "Check the repo's issues and discussions (workspace view), and tell me one thing each. Also: could you fork this repo if I only had read access? One line.",
];

function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false;
    let sendTs = 0;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { sendTs = Date.now() / 1000 - 1; ws.send(JSON.stringify({ type: 'send', message: text })); };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data.toString());
        events.push(e);
        if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) {
          setTimeout(finish, 1500);
        }
      } catch {}
    };
    ws.onerror = (err) => { events.push({ type: 'ws_error', message: String(err.message || err) }); finish(); };
    setTimeout(finish, waitMs || 480000);
  });
}

(async () => {
  console.log(`== v0.76.5 live workspace red-team on session ${SESS} (NVIDIA direct path) ==`);
  let assistantText = '';
  for (let i = 0; i < PROMPTS.length; i++) {
    console.log(`\n-- turn ${i + 1}: ${PROMPTS[i].slice(0, 90)}…`);
    const evs = await wsTurn(SESS, PROMPTS[i]);
    const types = evs.map((e) => e.type);
    console.log(`   events (${types.length}): ${JSON.stringify(types.slice(0, 30))}`);
    assistantText = '';
    for (const e of evs) {
      if (e.type === 'tool_use') {
        console.log(`   [tool_use] ${e.name} ${String(e.summary || '').slice(0, 60)}`);
      } else if (e.type === 'tool_result') {
        console.log(`   [tool_result] ${JSON.stringify(String(e.text || '').slice(0, 220))}`);
      } else if (e.type === 'assistant_delta') {
        assistantText += (e.text || '');
      } else if (e.type === 'error') {
        console.log(`   [error] ${JSON.stringify(e).slice(0, 260)}`);
      } else if (e.type === 'status' && (e.state === 'idle' || e.state === 'error')) {
        console.log(`   [status ${e.state}]`);
      }
    }
    console.log(`   REPLY: ${assistantText.replace(/\s+/g, ' ').slice(0, 500)}`);
  }
})();
