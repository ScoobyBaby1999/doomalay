#!/usr/bin/env node
// v073 turn-3 red-team: the superpowers discipline on a live model turn.
// The model must: browse the bundle detail, pick the fitting skill,
// LOAD it (SKILL LOADED marker), then work following the methodology.
const SESS = process.argv[2];
const PROMPT = "I want to build a small CLI tool that turns Markdown notes into flashcards. Use the superpowers bundle properly: check the bundle, pick the right FIRST skill for where I am right now (just an idea), load it, and run one step of that methodology with me. Keep it tight — say which skill you loaded and why.";

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
    ws.onerror = () => { finish(); };
    setTimeout(finish, waitMs || 420000);
  });
}

(async () => {
  const evs = await wsTurn(SESS, PROMPT);
  for (const e of evs) {
    if (['tool_use', 'tool_result'].includes(e.type)) {
      console.log(`[${e.type}] ${String(e.text || e.summary || '').slice(0, 220)}`);
    } else if (e.type === 'error') {
      console.log(`[error] ${String(e.text).slice(0, 200)}`);
    }
  }
  const text = evs.filter((e) => e.type === 'assistant_delta').map((e) => String(e.text || '')).join('');
  console.log(`\nASSISTANT: ${text.slice(0, 1200)}`);
  const loaded = evs.some((e) => /SKILL LOADED/.test(String(e.text || '')));
  console.log(loaded ? '\nPASS: skill loaded via live turn' : '\nFAIL: no SKILL LOADED marker');
  process.exit(loaded ? 0 : 1);
})();
