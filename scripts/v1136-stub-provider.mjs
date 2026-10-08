#!/usr/bin/env node
// v1136-stub-provider.mjs — v1.13.6 THE REDTEAM's deterministic OpenAI-wire
// stub provider (PLAN-V113 §6).
//
// The rig points the engine's providers at this stub via the power-feature
// base-URL overrides (DOOMALAY_BASE_URL_NVIDIA/_OPENROUTER/_GROQ). The
// stub plays a PERSONA per seeded key (the Bearer token names it), which
// makes one process carry the whole provider matrix:
//
//   stub-nvidia-key      → the full scenario engine (golden chains, faults)
//   stub-openrouter-key  → the same scenarios (the concurrency carrier)
//   stub-groq-key        → the REJECT persona (400 on any tools-bearing
//                          request — the honest-degrade carrier, chosen
//                          because groq turns have no provider plugin in
//                          the way)
//
// Scenario selection is keyed off the LAST USER MESSAGE'S EXACT TEXT and
// the COUNT/CONTENT of role:"tool" messages in the conversation — never
// substring matching over the whole body (the v1.13.6 rig lesson: the
// armed tool list contains every tool name, so body-wide substring
// matching caused phase collisions and an infinite model loop).
//
// Endpoints:
//   POST /v1/chat/completions · /chat/completions — SSE, scripted
//   GET  /v1/models · /models — validation probes
//   GET  /log — the request log (the rig asserts on it)
//   POST /reset — clear the log (replay determinism)
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT || 8610);
const log = [];
let reqid = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── the scenarios ────────────────────────────────────────────────────
// Each: round1(rounds without matching tool results) → emit calls;
// done(toolMsgs) → switch to the final answer.
const SCENARIOS = {
  'STUB CHAIN': {
    prose: 'Let me compute that and check the clock.',
    calls: [
      { id: 'call_chain_calc', name: 'calculator', args: '{"expr":"37*14"}' },
      { id: 'call_chain_time', name: 'time_now', args: '{"tz":"Asia/Tokyo"}' },
    ],
    done: (t) => t.some(m => (m.content || '').includes('518')) && t.some(m => /tokyo|JST|UTC|\d{2}:\d{2}/i.test(m.content || '')),
    answer: '37*14 = 518 exactly. The current time in Tokyo is served by the time_now tool.',
  },
  'STUB ZIP': {
    calls: [
      { id: 'call_zip', name: 'zip_create', args: '{"name":"bundle.zip","files":[{"name":"a.txt","content":"hello"},{"name":"b.txt","content":"world"}]}' },
    ],
    done: (t) => t.some(m => /Saved as artifact|bundle\.zip/i.test(m.content || '')),
    answer: 'The archive bundle.zip is ready — a.txt says hello and b.txt says world.',
  },
  'STUB EXTERNAL': {
    calls: [
      { id: 'call_ext', name: 'demo_tool_42', args: '{"n":7}' },
    ],
    done: (t) => t.some(m => (m.content || '').includes('tool_42 computed 7*6=42')),
    answer: 'The external MCP fleet answered: tool_42 computed 7*6=42.',
  },
  'STUB BOOM': {
    calls: [{ id: 'call_boom', name: 'demo_boom', args: '{}' }],
    done: (t) => t.length >= 1,
    answer: 'The boom tool failed honestly (a tool-level error) — I reported it and moved on.',
  },
  'STUB HANG': {
    calls: [{ id: 'call_hang', name: 'demo_hang', args: '{}' }],
    done: (t) => t.length >= 1,
    answer: 'The hang tool timed out at the per-call deadline — the turn survived.',
  },
  'STUB PANIC': {
    calls: [{ id: 'call_panic', name: 'demo_boom_panic', args: '{}' }],
    done: (t) => t.length >= 1,
    answer: 'The panicking tool was contained — its failure came back as a tool error and the turn survived.',
  },
  'STUB CUT': {
    // the v1.13.6 honesty-line probe: arguments cut MID-STRING
    calls: [{ id: 'call_cut', name: 'calculator', args: '{"expr":"37*1' }],
    done: (t) => t.some(m => /CUT OFF|NOT executed/i.test(m.content || '')),
    answer: 'Understood — the cut-off call never executed. I would re-send it complete.',
  },
  'STUB BAD': {
    // the v1.13.6 honesty-line probe: unrecoverable malformed arguments
    calls: [{ id: 'call_bad', name: 'calculator', args: '{"expr": 37*14}' }],
    done: (t) => t.some(m => /malformed/i.test(m.content || '')),
    answer: 'Right — those arguments were malformed. I would re-emit the call.',
  },
  'STUB SEARCH': {
    calls: [{ id: 'call_search', name: 'web_search', args: '{"query":"Model Context Protocol"}' }],
    done: (t) => t.length >= 1,
    answer: 'Searched the live web and summarized the top results with sources.',
  },
  'STUB ANSWER': {
    calls: [],
    done: () => true,
    answer: 'A plain streaming answer with no tool calls: 518.',
  },
};

// ── SSE emission ──────────────────────────────────────────────────────
function sseHead(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
}
function sseEvent(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}
function sseDone(res, usage) {
  sseEvent(res, { id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}
function streamText(res, text) {
  sseHead(res);
  // stream in a few words at a time so the assembly path is exercised
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    sseEvent(res, {
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: 'stub-model',
      choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: words[i] } : { content: (i ? ' ' : '') + words[i] }, finish_reason: null }],
    });
  }
  sseDone(res, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
}
function streamCalls(res, calls, prose = '') {
  sseHead(res);
  // v0.93.3 THE ROUND SEGMENT contract: the model may narrate ("Let me
  // compute that…") in the SAME round as its tool calls — prose first,
  // then the calls, so the engine's round_end segmentation is exercised.
  if (prose) {
    sseEvent(res, {
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: 'stub-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: prose }, finish_reason: null }],
    });
  }
  sseEvent(res, {
    id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: 'stub-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) }, finish_reason: null }],
  });
  sseEvent(res, { id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── the server ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.replace(/\?.*$/, '');

  // validation probes
  if (req.method === 'GET' && (url === '/models' || url === '/v1/models' || url === '/auth/key')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stub/model-a' }, { id: 'stub/model-b' }] }));
    return;
  }

  if (req.method === 'GET' && url === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }
  if (req.method === 'POST' && url === '/reset') {
    log.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  const isChat = req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions');
  if (!isChat) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stub: unknown route ' + req.method + ' ' + url } }));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}

  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const persona = auth.includes('groq') ? 'groq' : auth.includes('openrouter') ? 'openrouter' : 'nvidia';
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const toolMsgs = msgs.filter(m => m.role === 'tool');
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const lastText = String(lastUser?.content || '').trim();
  const toolsCount = Array.isArray(body.tools) ? body.tools.length : 0;

  const entry = {
    id: ++reqid, t: Date.now(), persona, last_user: lastText.slice(0, 80),
    tools_count: toolsCount, tool_msgs: toolMsgs.length,
    tool_msg_texts: toolMsgs.map(m => String(m.content || '').slice(0, 120)),
    stream: !!body.stream, max_tokens: body.max_tokens,
  };
  log.push(entry);

  // the REJECT persona: any tools-bearing request 400s (the honest-degrade
  // carrier); tool-less requests answer plainly.
  if (persona === 'groq') {
    if (toolsCount > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'this model does not support tools or function calling' } }));
      return;
    }
    if (body.max_tokens === 1) { // the chat_probe
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'stub-probe', object: 'chat.completion', model: 'stub-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    streamText(res, 'I can still answer plainly: 518.');
    return;
  }

  // non-stream probe shape (max_tokens=1 chat_probe)
  if (body.max_tokens === 1 && !body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'stub-probe', object: 'chat.completion', model: 'stub-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }

  const sc = SCENARIOS[lastText];
  if (!sc) {
    // unknown script → plain acknowledgment (never a loop)
    streamText(res, `(stub) no scenario for "${lastText.slice(0, 60)}" — answering plainly.`);
    return;
  }
  await sleep(20); // a breath of realism
  if (sc.calls.length === 0 || sc.done(toolMsgs)) {
    streamText(res, sc.answer);
  } else {
    streamCalls(res, sc.calls, sc.prose || '');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`v1136 stub provider on http://127.0.0.1:${PORT} — personas: nvidia/openrouter (scenarios), groq (reject)`);
});
