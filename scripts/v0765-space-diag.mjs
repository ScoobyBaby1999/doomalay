#!/usr/bin/env node
// v0765 space latency diagnostic + medium tool chain (background turn).
// The curl timing INSIDE the space discriminates: HF-IP throttling vs app path.
const SESS = process.argv[2];
const NVKEY = process.env.NVIDIA_API_KEY || '';  // v0.80.1 scrub: env, never hardcoded
const MSG = `Diagnostic turn — do exactly these steps as SEPARATE tool calls (not batched):
1. shell: time a raw API call from inside this container:
   time curl -s -o /dev/null -w '%{http_code} %{time_total}s' -X POST https://integrate.api.nvidia.com/v1/chat/completions -H 'Authorization: Bearer ${NVKEY}' -H 'Content-Type: application/json' -d '{"model":"deepseek-ai/deepseek-v4.1-flash","messages":[{"role":"user","content":"Say OK"}],"max_tokens":5}'
   (report the http code and time_total EXACTLY)
2. shell: pwd && whoami && id
3. shell: uname -a && cat /etc/os-release | head -3
4. shell: python3 --version && node --version && git --version
5. shell: mkdir -p /tmp/chaintest && echo "chain-ok-$(date +%s)" > /tmp/chaintest/a.txt && cat /tmp/chaintest/a.txt
6. shell: grep -c chain /tmp/chaintest/a.txt && wc -l /tmp/chaintest/a.txt
7. shell: df -h / | tail -1 && free -m | head -2
At the end: report (a) the curl http code + time_total, (b) how many tool calls you made, (c) any failures. Keep the final report under 10 lines.`;

function wsTurn(sess, text, waitMs) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:8080/api/chat?session_id=${encodeURIComponent(sess)}`);
    let done = false;
    const sendTs = Date.now() / 1000 - 1;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(events); } };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'send', message: text })); console.log(`[ws] sent turn`); };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data.toString());
        events.push(e);
        const ts = new Date((e.ts || Date.now() / 1000) * 1000).toISOString().slice(11, 19);
        if (e.type === 'tool_use') console.log(`[${ts}] tool_use: ${e.name} call#${events.filter(x=>x.type==='tool_use').length}`);
        else if (e.type === 'tool_result') console.log(`[${ts}] tool_result: ${String(e.text || e.output || '').slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
        else if (e.type === 'status' && e.state) console.log(`[${ts}] status:${e.state}${e.detail ? ' — ' + String(e.detail).slice(0, 120) : ''}`);
        else if (e.type === 'error') console.log(`[${ts}] ERROR: ${JSON.stringify(e).slice(0, 250)}`);
        else if (e.type === 'assistant') console.log(`[${ts}] assistant: ${String(e.text || '').slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
        if (e.type === 'status' && (e.state === 'idle' || e.state === 'error') && (e.ts || 0) >= sendTs) setTimeout(finish, 1500);
      } catch {}
    };
    ws.onerror = (err) => { console.log('[ws] ERROR', String(err.message || err)); finish(); };
    setTimeout(finish, waitMs * 1000);
  });
}

(async () => {
  const evs = await wsTurn(SESS, MSG, parseInt(process.argv[3] || '900', 10));
  const types = {};
  for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
  console.log('=== FINAL ===');
  console.log('event counts:', JSON.stringify(types));
  let final = '';
  for (const e of evs) if (e.type === 'assistant' || e.type === 'assistant_delta') final += (e.text || e.delta || '');
  console.log('answer tail:', final.slice(-500).replace(/\n/g, ' ⏎ ') || '(EMPTY)');
})();
