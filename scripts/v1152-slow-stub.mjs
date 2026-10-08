#!/usr/bin/env node
// v1152-slow-stub.mjs — v1.15.2 THE DECOUPLE REDTEAM's slow carrier.
//
// An OpenAI-wire stub that streams SLOWLY (many small deltas over seconds)
// so three chatbots' turns genuinely OVERLAP in time — the precondition
// for any cross-bot leak to show itself. Every reply embeds a PER-REQUEST
// marker (PERSONA + request id + delta index) so the rig can prove, from
// the persisted transcripts alone, that no chat ever received another
// chat's text.
//
// Personas (the Bearer token names them, mirroring v1136-stub-provider):
//   stub-nvidia-key     → NV markers
//   stub-groq-key       → GR markers
//   stub-openrouter-key → OR markers
//
// Endpoints: POST /v1/chat/completions (SSE, slow) · GET /v1/models ·
// GET /log · POST /reset · POST /hold (pause streams) · POST /release
import http from 'node:http';

const PORT = Number(process.env.SLOW_STUB_PORT || 8620);
const DELTA_MS = Number(process.env.SLOW_DELTA_MS || 220);
const DELTAS = Number(process.env.SLOW_DELTAS || 36); // ~8s per turn

const log = [];
let reqid = 0;
let held = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = req.url.replace(/\?.*$/, '');
  if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'stub/slow-a' }, { id: 'stub/slow-b' }, { id: 'stub/slow-c' }
    ] }));
    return;
  }
  if (req.method === 'GET' && url === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }
  if (req.method === 'POST' && url === '/reset') {
    log.length = 0; held = false;
    res.writeHead(200); res.end('{"ok":true}');
    return;
  }
  if (req.method === 'POST' && url === '/hold') { held = true; res.writeHead(200); res.end('{"ok":true}'); return; }
  if (req.method === 'POST' && url === '/release') { held = false; res.writeHead(200); res.end('{"ok":true}'); return; }

  const isChat = req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions');
  if (!isChat) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'slow-stub: ' + req.method + ' ' + url } }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}

  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const persona = auth.includes('groq') ? 'GR' : auth.includes('openrouter') ? 'OR' : 'NV';
  const id = ++reqid;
  const marker = `${persona}-${id}`;
  log.push({ id, persona, marker, t: Date.now(), stream: !!body.stream });

  // the chat_probe shape answers instantly
  if (body.max_tokens === 1 && !body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'stub-probe', object: 'chat.completion', model: 'stub-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const ev = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  ev({ id: 'chatcmpl-slow', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: { role: 'assistant', content: `BEGIN ${marker} ` }, finish_reason: null }] });
  for (let i = 1; i <= DELTAS; i++) {
    while (held) await sleep(150); // the hold gate (mid-stream pause control)
    await sleep(DELTA_MS);
    if (res.destroyed) return;
    ev({ id: 'chatcmpl-slow', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: { content: `${marker}:${i} ` }, finish_reason: null }] });
  }
  ev({ id: 'chatcmpl-slow', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: DELTAS + 4, total_tokens: DELTAS + 104 } });
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`v1152 slow-stub on :${PORT}`));
process.on('SIGTERM', () => process.exit(0));
