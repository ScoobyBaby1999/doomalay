#!/usr/bin/env node
// v076 space probe — BUG#3 verification: does a /chat turn with tool_use
// survive to completion on the shared community space? Streams SSE, logs
// every event type, checks for tool_result + final answer + [DONE].
const SPACE = process.argv[2] || 'https://scoobybaby1999-doomalaysocreate.hf.space';
const TOKEN = process.env.DOOMALAY_HF_TOKEN || '';  // v0.80.1 scrub: env, never hardcoded
const NV = process.env.NVIDIA_API_KEY || '';

const body = {
  session_id: 'probe-' + Date.now(),
  message: process.argv[3] || 'Use your bash tool to run exactly: ls -la /data | head -20 — then tell me in one line what you see.',
  model: process.argv[4] || 'nvidia/deepseek-ai/deepseek-v4.1-flash',
  provider: 'nvidia',
  history: [],
};

const t0 = Date.now();
const res = await fetch(SPACE + '/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-HF-Token': TOKEN,
    'X-Env-NVIDIA_API_KEY': NV,
  },
  body: JSON.stringify(body),
});

console.log('HTTP', res.status, res.statusText);
if (!res.ok) { console.log(await res.text()); process.exit(1); }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const counts = {};
let sawToolUse = false, sawToolResult = false, sawDone = false, finalText = '';
outer: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const evLine = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!evLine) continue;
    const d = JSON.parse(evLine.slice(6));
    counts[d.type] = (counts[d.type] || 0) + 1;
    if (d.type === 'tool_use') { sawToolUse = true; console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] tool_use: ${d.name} ${String(d.input || d.summary || '').slice(0, 90)}`); }
    if (d.type === 'tool_result') { sawToolResult = true; console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] tool_result: ${String(d.output || d.text || '').slice(0, 140).replace(/\n/g, ' ⏎ ')}`); }
    if (d.type === 'text') finalText += (d.text || d.delta || '');
    if (d.type === 'error') console.log(`!! error event: ${JSON.stringify(d).slice(0, 300)}`);
    if (d.type === 'done' || d.done) { sawDone = true; }
  }
}
console.log('---');
console.log('event counts:', JSON.stringify(counts));
console.log('tool_use:', sawToolUse, '| tool_result:', sawToolResult, '| done marker:', sawDone);
console.log('final text (tail 400):', finalText.slice(-400).replace(/\n/g, ' ⏎ '));
console.log('elapsed', ((Date.now()-t0)/1000).toFixed(1) + 's');
const pass = sawToolUse && sawToolResult && finalText.trim().length > 20;
console.log(pass ? 'BUG3 CHECK: PASS (tool loop survived to final answer)' : 'BUG3 CHECK: ' + (sawToolUse ? 'FAIL (tool_use seen but stream died)' : 'NO TOOL USE — prompt needs adjustment'));
