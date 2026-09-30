#!/usr/bin/env node
// v0765 THE 30+ TOOL CHAIN (local brain path). One conversation, 30+
// separate tool calls, mixed tools (shell, python_repl, file ops, journal,
// calculator, think…) — the user's core reliability requirement.
const SESS = process.argv[2];
const WAIT = parseInt(process.argv[3] || '900', 10);

const PROMPT = `RELIABILITY TEST — you must make at least 32 SEPARATE tool calls in this ONE turn (not batched into few calls; each step = its own tool call). Work through this numbered battery, one tool call per step:

1. shell: pwd
2. shell: whoami
3. shell: uname -a
4. shell: ls -la
5. shell: echo chain-start > chain.txt
6. shell: cat chain.txt
7. shell: echo step7 >> chain.txt
8. shell: wc -l chain.txt
9. shell: grep -c step chain.txt
10. shell: cp chain.txt chain2.txt
11. shell: ls
12. shell: mkdir -p sub/deep
13. shell: mv chain2.txt sub/deep/
14. shell: ls sub/deep
15. python_repl: print('py-step15', 6*7)
16. python_repl: open('sub/deep/out.txt','w').write('python was here')
17. shell: cat sub/deep/out.txt
18. shell: sha256sum chain.txt | cut -c1-16
19. shell: base64 chain.txt | head -1
20. shell: df -h / | tail -1
21. shell: free -m | head -2
22. shell: date -u
23. shell: python3 --version
24. shell: seq 1 10 | sort -rn | head -3
25. shell: find . -name '*.txt' | sort
26. shell: tar czf t.tgz chain.txt && ls -la t.tgz
27. shell: rm t.tgz && echo cleaned
28. journal: create a note "chain test at step 28"
29. shell: cat chain.txt sub/deep/out.txt
30. shell: rm -rf sub && echo sub-removed
31. shell: env | grep -c PATH (never print secrets)
32. shell: echo chain-done > final.txt && cat final.txt

Then FINAL REPORT (must include): (a) the NUMBER of tool calls you made, (b) which steps failed and why, (c) the output of step 15, 18, 24. Keep it under 12 lines.`;

function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false;
    const sendTs = Date.now() / 1000 - 1;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'send', message: text })); console.log(`[ws] sent 32-step chain`); };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data.toString());
        const isNew = (e.ts || 0) >= sendTs - 5;
        if (!isNew) return; // replayed history only
        events.push(e);
        const ts = new Date((e.ts || Date.now() / 1000) * 1000).toISOString().slice(11, 19);
        if (e.type === 'tool_use') console.log(`[${ts}] #${events.filter(x=>x.type==='tool_use').length} tool_use: ${e.name}`);
        else if (e.type === 'tool_result') console.log(`[${ts}] -> ${String(e.text || e.output || '').slice(0, 110).replace(/\n/g, ' ⏎ ')}`);
        else if (e.type === 'status' && e.state) console.log(`[${ts}] status:${e.state}${e.detail ? ' — ' + String(e.detail).slice(0, 120) : ''}`);
        else if (e.type === 'error') console.log(`[${ts}] ERROR: ${JSON.stringify(e).slice(0, 250)}`);
        if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) setTimeout(finish, 1500);
      } catch {}
    };
    ws.onerror = (err) => { console.log('[ws] ERROR', String(err.message || err)); finish(); };
    setTimeout(finish, waitMs * 1000);
  });
}

(async () => {
  const evs = await wsTurn(SESS, PROMPT, WAIT);
  const types = {};
  for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
  const nTools = (types.tool_use || 0);
  console.log('=== CHAIN RESULT ===');
  console.log('event counts:', JSON.stringify(types));
  console.log(`TOOL CALLS: ${nTools} ${nTools >= 30 ? '✓ 30+ PASS' : '✗ BELOW 30'}`);
  let final = '';
  for (const e of evs) if (e.type === 'assistant' || e.type === 'assistant_delta') final += (e.text || e.delta || '');
  console.log('final report:', final.slice(-700).replace(/\n/g, ' ⏎ ') || '(EMPTY)');
})();
