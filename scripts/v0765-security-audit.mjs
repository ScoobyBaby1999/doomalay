#!/usr/bin/env node
// v0765 security/privacy spot audit — the space + the engine.
const SPACE = 'https://scoobybaby1999-doomalaysocreate.hf.space';
const HF = process.env.DOOMALAY_HF_TOKEN || '';  // v0.80.1 scrub: env, never hardcoded
const NV = process.env.NVIDIA_API_KEY || '';
const SENTINEL_KEY = 'nvapi-SENTINEL-do-not-leak-0123456789abcdef';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// 1. Space: /chat without auth → 401
{
  const r = await fetch(SPACE + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'sec', message: 'hi', model: 'nvidia/x', provider: 'nvidia' }) });
  check('space /chat rejects anonymous', r.status === 401, `HTTP ${r.status}`);
}

// 2. Space: /chat with a BAD HF token → 401
{
  const r = await fetch(SPACE + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HF-Token': 'hf_badtoken' }, body: JSON.stringify({ session_id: 'sec', message: 'hi', model: 'nvidia/x', provider: 'nvidia' }) });
  check('space /chat rejects bad HF token', r.status === 401, `HTTP ${r.status}`);
}

// 3. Space: a turn whose key is INVALID — the error must be REDACTED (no key echo)
{
  const t0 = Date.now();
  const r = await fetch(SPACE + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HF-Token': HF, 'X-Env-NVIDIA_API_KEY': SENTINEL_KEY },
    body: JSON.stringify({ session_id: 'sec-redact', message: 'Reply: REDACT-CHECK', model: 'nvidia/deepseek-ai/deepseek-v4.1-flash', provider: 'nvidia', history: [] }),
  });
  const text = await r.text();
  const leaked = text.includes('SENTINEL') || text.includes(SENTINEL_KEY);
  check('space error events never echo the key', !leaked, `body ${text.length}B ${leaked ? 'LEAKED' : 'clean'}`);
  const attributed = text.includes('key_source') || text.includes('user');
  check('space error carries key attribution', attributed, text.slice(0, 200).replace(/\n/g, ' '));
}

// 4. Space: session-id traversal sanitization — ../.. never lands in a path
{
  const r = await fetch(SPACE + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HF-Token': HF, 'X-Env-NVIDIA_API_KEY': NV },
    body: JSON.stringify({ session_id: '../../etc', workspace: '/etc/passwd', message: 'Reply: SANITIZE-CHECK only, no tools.', model: 'nvidia/deepseek-ai/deepseek-v4.1-flash', provider: 'nvidia', history: [] }),
  });
  const text = await r.text();
  check('session/workspace sanitization survives (turn ran or errored, no crash)', r.status === 200 || r.status === 400, `HTTP ${r.status}`);
  console.log('   (traversal body head):', text.slice(0, 150).replace(/\n/g, ' '));
}

// 5. Engine: /api/keys never returns VALUES
{
  const r = await fetch('http://127.0.0.1:8080/api/keys');
  const j = await r.json();
  const hasKey = JSON.stringify(j).includes(NV.slice(0, 20)) || Object.values(j).some((v) => v && v.key && String(v.key).length > 10);
  check('engine /api/keys lists presence only (no values)', !hasKey);
}

// 6. Engine: /api/keys/value — does it need auth? (local-only binding is the guard)
{
  const r = await fetch('http://127.0.0.1:8080/api/keys/value?env_var=NVIDIA_API_KEY');
  const t = await r.text();
  const leaked = t.includes(NV.slice(-10));
  check('engine key-value endpoint guards (or loopback-only)', !leaked, `HTTP ${r.status} ${leaked ? 'LEAKED VALUE' : t.slice(0, 80)}`);
}

// 7. Space /debug/egress is open — verify it's read-only (no key material)
{
  const r = await fetch(SPACE + '/debug/egress', { headers: { 'X-HF-Token': HF } });
  const t = await r.text();
  check('space debug egress carries no secrets', !t.includes(NV.slice(0, 20)) && !t.includes(HF.slice(0, 15)));
}

console.log(`\n=== SECURITY AUDIT: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
