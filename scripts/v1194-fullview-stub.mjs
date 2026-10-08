#!/usr/bin/env node
// v1194-fullview-stub.mjs — v1.19.4 THE FULL VIEW redteam carrier.
//
// An OpenAI-wire stub that plays a TWO-ROUND tool turn with a HUGE tool
// result:
//   round 1 → a web_fetch tool_call for {url: STUB/big}
//   (the engine executes it — the fetch pulls an 80 KB page from THIS stub)
//   round 2 → the final prose answer
// Everything else (a no-tools model list, a /big page) rides the same server.
import http from 'node:http';

const PORT = Number(process.env.V1194_STUB_PORT || 8631);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BIG = ('# The Full View\n\n' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n\n')
  .repeat(650); // ~80 KB

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

const server = http.createServer(async (req, res) => {
  const url = req.url.replace(/\?.*$/, '');
  if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stub/toolful' }] }));
    return;
  }
  if (req.method === 'GET' && (url === '/big' || url === '/v1/big')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('THE FULL VIEW PAGE\n\n' + BIG);
    return;
  }
  if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
    let body = '';
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    const hasToolResult = (parsed.messages || []).some(m => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (!hasToolResult) {
      // round 1: narrate, then call web_fetch against THIS stub's /big
      sse(res, { choices: [{ delta: { content: 'Reading the page with the fetch tool.' } }] });
      await sleep(120);
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_tv1', type: 'function', function: { name: 'web_fetch', arguments: '' } }] } }] });
      await sleep(60);
      const bigUrl = 'https://raw.githubusercontent.com/torvalds/linux/master/Documentation/admin-guide/kernel-parameters.txt';
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url: bigUrl }) } }] } }] });
      await sleep(60);
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      // round 2: the final answer, streamed
      const toolOut = (parsed.messages || []).filter(m => m.role === 'tool').map(m => String(m.content || '').length).join(',');
      const words = ['The', 'page', 'is', 'read', '—', 'full', 'content', 'delivered', '(' + toolOut + ' bytes).'];
      for (const w of words) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(60); }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404); res.end('nope');
});

server.listen(PORT, '127.0.0.1', () => console.log('v1194 stub on ' + PORT));
