// pmsdk.js — the PrivateMode ATTESTATION ORACLE (v1.44.4 THE STRIP).
//
// WHY THIS EXISTS: PrivateMode's chat API rides an end-to-end encryption
// protocol — remote attestation of the deployment + an AES-GCM session
// secret, all implemented in the official SDK's WASM module. Since
// v1.44.3 THE WIRE the engine speaks that protocol ITSELF (pure Go,
// engine/internal/pm + the pmstate pin), so PM chat turns ride the
// engine WebSocket like every provider. What the ENGINE may not do is
// VERIFY the attestation: the only verifier is Edgeless's contrast/sdk
// (BSL-1.1 — we may never compile it). THIS bridge is the one thing
// that still legally runs it: the MIT-distributed wasm artifact.
//
// The contract (PLAN-V144 §V4): at PM connect (the first turn's
// handshake, the Re-verify button, or a fresh boot's first PM action)
// the wasm runs verify() — the FULL Contrast attestation verification —
// and the verdict is reported to the engine (POST /api/pm/bootstrap),
// which pins the deployment's mesh CA as verified. No PM turn ever runs
// here; the wasm is a bootstrap utility ONLY.
//
// Exposed: window.PMBridge = { available(), rerunOracle() }

import { PrivatemodeCore } from './privatemode-ai.js';

var core = null;         // the PrivatemodeCore instance
var coreKey = null;      // the key core was constructed with (re-init on change)
var verifyPromise = null;

function pmError(message) {
  var e = new Error(message);
  e.isPM = true;
  return e;
}

async function getCore() {
  // v1.44.3 THE WIRE: the standing key endpoint is DEAD — mint the
  // scoped single-use handshake ticket first (60s TTL, one redemption;
  // the engine serves the raw key ONLY against it). The turn path no
  // longer needs the key anywhere: the engine speaks PM's protocol
  // natively; this bridge is the connect-time oracle + the (dying at
  // v1.44.4) WebView turn path.
  var tRes = await fetch('/api/pm/handshake-ticket', { method: 'POST' });
  if (!tRes.ok) {
    if (tRes.status === 400) throw pmError('No PrivateMode API key saved yet — connect the provider first (+ Model → Connect Cloud Provider).');
    throw pmError('PM handshake ticket failed (' + tRes.status + ')');
  }
  var t = await tRes.json();
  var res = await fetch('/api/keys/value?env_var=PRIVATEMODEAI_API_KEY&ticket=' + encodeURIComponent(t.ticket || ''));
  if (!res.ok) throw pmError('engine key endpoint failed (' + res.status + ')');
  var data = await res.json();
  if (!data || !data.has_key) {
    throw pmError('No PrivateMode API key saved yet — connect the provider first (+ Model → Connect Cloud Provider).');
  }
  if (core && coreKey === data.key) return core;
  if (core && typeof core.close === 'function') {
    try { core.close(); } catch (e) { /* already closed */ }
  }
  core = new PrivatemodeCore({
    apiKey: data.key,
    // The WebView is the trusted app runtime (keys are already stored
    // on this device; PM's own web app holds the key client-side too).
    dangerouslyAllowBrowser: true,
    browserWasmURL: '/vendor/pm/privatemode.wasm'
  });
  coreKey = data.key;
  verifyPromise = null;
  return core;
}
function ensureVerified(c) {
  if (!verifyPromise) {
    // v0.16 FIX: the SDK contract is verify() THEN refreshSecret() —
    // verify() alone leaves the encryption secret unset and every chat
    // turn dies with "no secret available: call Initialize() and
    // UpdateSecret() first". refreshSecret() establishes the AES-GCM
    // session secret; retryWithSecretRefresh keeps it fresh mid-stream.
    // v0.16b: PM's /v1/attest endpoint is intermittently slow ("context
    // deadline exceeded" — observed live in 1-of-3 fresh boots) — retry
    // the whole verify+secret handshake up to 3× with backoff so a
    // transient attest blip never kills a chat turn.
    verifyPromise = (async () => {
      var lastErr = null;
      for (var attempt = 1; attempt <= 3; attempt++) {
        try {
          await c.verify();
          await c.refreshSecret();
          // v1.44.2 THE PIN: the handshake just SUCCEEDED — this is the
          // one-shot oracle moment. The wasm ran the FULL Contrast
          // attestation verification (the thing the engine may never
          // compile — its SDK is BSL-1.1). Report the verdict so the
          // engine pins the mesh CA as verified; fire-and-forget so a
          // failed report NEVER kills the turn (the next handshake
          // retries — the pin stays TOFU/unverified until then).
          reportBootstrap(c);
          return true;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
        }
      }
      throw lastErr;
    })().catch(function (e) {
      verifyPromise = null; // a failed attestation must be retried next turn
      throw e;
    });
  }
  return verifyPromise;
}
// ── v1.44.2 THE PIN: the one-shot WASM oracle report ────────────────
// After a successful verify()+refreshSecret() handshake, POST the
// verdict + the exported secret to the engine's /api/pm/bootstrap. The
// engine fetches its OWN attest doc and pins the mesh CA it extracts,
// marking the pin verified=true ONLY because this oracle (Edgeless's
// own verifier, distributed as an MIT wasm artifact) succeeded in the
// same window. Until this lands, an engine pinned headlessly stays
// TOFU — honestly surfaced as unverified in the provider card.
// NOTE (phase law): the chat-turn bridge below stays until v1.44.4
// THE STRIP retires it; from then on PM turns ride the engine and
// this oracle is the ONLY thing the web layer runs.
function u8ToB64(u8) {
  var s = '';
  try {
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  } catch (e) { return ''; }
}

function reportBootstrap(c) {
  try {
    var s = c.exportSecret(); // {id, data(base64), expiresAtUnix}
    var mf = '';
    try { mf = c._manifestBytes ? u8ToB64(c._manifestBytes) : ''; } catch (e) { /* informational only */ }
    fetch('/api/pm/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verified: true,
        manifest: mf,
        secret_id: (s && s.id) || '',
        secret_data: (s && s.data) || '',
        exp_unix: (s && s.expiresAtUnix) || 0
      })
    }).then(function (r) {
      if (!r.ok) console.warn('[pm-oracle] bootstrap ' + r.status + ' — the pin stays as-is; retried at the next handshake');
    }).catch(function (e) {
      console.warn('[pm-oracle] bootstrap failed (offline?) — the pin stays as-is; retried at the next handshake');
    });
  } catch (e) {
    console.warn('[pm-oracle] exportSecret failed — reporting verified without a secret seed');
    try {
      fetch('/api/pm/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified: true })
      }).catch(function () { /* fire-and-forget */ });
    } catch (e2) { /* never break the turn */ }
  }
}

// ── v1.44.2 THE PIN: the re-verify hook ──────────────────────
// The providers screen's Re-verify button clears the engine pin, then
// asks the oracle to run again IMMEDIATELY (the button's promise:
// verification happens NOW, not "at the next chat"). The wasm core is
// reused when alive — verify() re-runs the FULL attestation
// verification against the CURRENT deployment doc — and a fresh boot
// re-fetches everything. On success the oracle's reportBootstrap fires
// and the engine re-pins verified; on failure the pin stays cleared
// and the honest error surfaces to the caller.
async function rerunOracle() {
  var c = await getCore();  // loads the wasm + key when not alive yet
  verifyPromise = null;     // force a fresh handshake
  await ensureVerified(c);  // verify + refreshSecret → reportBootstrap fires
  return true;
}

window.PMBridge = {
  available: function () { return typeof WebSocket !== 'undefined' && typeof WebAssembly !== 'undefined'; },
  // v1.44.2 THE PIN: the honest re-verify drive (providers.js).
  rerunOracle: rerunOracle
};
