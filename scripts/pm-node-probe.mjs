// pm-node-probe.mjs — ground truth: can the vendored Privatemode SDK run a
// live E2E-encrypted chat from plain Node? (evidence before architecture)
// Usage: node pm-node-probe.mjs <apiKey>
import { PrivatemodeCore } from '/home/z/my-project/doomalay/engine/internal/server/web/vendor/pm/privatemode-ai.js';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = process.argv[2];
if (!key) { console.error('usage: node pm-node-probe.mjs <apiKey>'); process.exit(1); }

const t0 = Date.now();
// decompress the wasm to a temp file (the SDK reads a PATH in Node)
const gz = readFileSync('/home/z/my-project/doomalay/engine/internal/server/web/vendor/pm/privatemode.wasm.gz');
const dir = mkdtempSync(join(tmpdir(), 'pmwasm-'));
const wasmPath = join(dir, 'privatemode.wasm');
const raw = gunzipSync(gz);
writeFileSync(wasmPath, raw);
console.log(`wasm decompressed: ${(gz.length / 1e6).toFixed(1)}MB gz → ${(raw.length / 1e6).toFixed(1)}MB (${Date.now() - t0}ms)`);

const core = new PrivatemodeCore({ apiKey: key, wasmURL: wasmPath });
console.log('core created (isBrowser=' + core.isBrowser + ')');
await core.verify();
console.log(`verify OK (${Date.now() - t0}ms)`);
await core.refreshSecret();
console.log(`refreshSecret OK (${Date.now() - t0}ms)`);

// non-stream
const r = await core.chatCompletions({
  model: 'glm-latest',
  messages: [{ role: 'user', content: 'Reply with exactly: NODE E2E OK' }],
  max_tokens: 2000,
});
console.log('chat:', JSON.stringify(r.body.choices?.[0]?.message?.content || r.body).slice(0, 200));

// stream
let streamed = '';
for await (const chunk of core.streamChatCompletions({
  model: 'glm-latest',
  messages: [{ role: 'user', content: 'Reply with exactly: STREAM OK' }],
  stream: true, max_tokens: 2000,
})) {
  streamed += chunk.choices?.[0]?.delta?.content || '';
}
console.log('stream:', JSON.stringify(streamed.slice(0, 100)));
console.log('TOTAL ms:', Date.now() - t0);
process.exit(0);
