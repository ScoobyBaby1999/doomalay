#!/usr/bin/env node
// v1136-pm-tools-probe.mjs — PrivateMode ground truth for the provider
// matrix: the E2E-wasm path with REAL key + a tools[] round.
//
// PM's direct api.privatemode.ai/v1 refuses plain requests ("minimum
// client version is v1.46 — upgrade the proxy") — the only real-user path
// is the vendored E2E SDK (verify → refreshSecret → encrypted turn), same
// as the panel's PMBridge. This probe answers: does the key work, and does
// PM's E2E API pass OpenAI tools[] through natively (the v1.13.5 finding,
// re-verified with today's key)?
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = pjoin(HERE, '../engine/internal/server/web/vendor/pm');
const key = process.argv[2] || (() => {
  for (const line of readFileSync('/home/z/keys.env', 'utf8').split('\n')) {
    const m = line.match(/^PRIVATEMODE_KEY=(.*)$/);
    if (m) return m[1].trim();
  }
  return '';
})();
if (!key) { console.error('usage: node v1136-pm-tools-probe.mjs [apiKey] (or /home/z/keys.env)'); process.exit(1); }

const { PrivatemodeCore } = await import(pjoin(VENDOR, 'privatemode-ai.js'));

const t0 = Date.now();
const gz = readFileSync(pjoin(VENDOR, 'privatemode.wasm.gz'));
const dir = mkdtempSync(join(tmpdir(), 'pmwasm-'));
const wasmPath = join(dir, 'privatemode.wasm');
writeFileSync(wasmPath, gunzipSync(gz));
console.log(`wasm decompressed (${(gz.length / 1e6).toFixed(1)}MB gz → ${(gunzipSync.length ? '' : '')}${(readFileSync(wasmPath).length / 1e6).toFixed(1)}MB)`);

const core = new PrivatemodeCore({ apiKey: key, wasmURL: wasmPath });
await core.verify();
console.log(`✓ verify OK (${Date.now() - t0}ms) — the key is LIVE`);
await core.refreshSecret();
console.log(`✓ refreshSecret OK (${Date.now() - t0}ms)`);

// 1. plain turn (the sanity round)
const r = await core.chatCompletions({
  model: 'glm-latest',
  messages: [{ role: 'user', content: 'Reply with exactly: PM E2E OK' }],
  max_tokens: 2000,
});
console.log('✓ plain chat:', JSON.stringify(r.body.choices?.[0]?.message?.content || r.body).slice(0, 120));

// 2. the TOOLS round — the matrix question
const tr = await core.chatCompletions({
  model: 'glm-latest',
  messages: [{ role: 'user', content: 'What is 6*7? Use the calculator tool.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a math expression and return the result.',
      parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
    },
  }],
  max_tokens: 2000,
});
const msg = tr.body.choices?.[0]?.message || {};
const calls = msg.tool_calls || [];
console.log(`✓ tools round: finish_reason=${tr.body.choices?.[0]?.finish_reason} tool_calls=${calls.length}`);
if (calls.length) {
  console.log(`  call: ${calls[0].function?.name} ${calls[0].function?.arguments}`);
  console.log('  → PM E2E passes OpenAI tools[] through NATIVELY (the v1.13.5 finding holds)');
} else {
  console.log(`  (no tool_calls — content: ${JSON.stringify(msg.content || '').slice(0, 150)})`);
}
console.log(`TOTAL ms: ${Date.now() - t0}`);
process.exit(calls.length ? 0 : 2);
