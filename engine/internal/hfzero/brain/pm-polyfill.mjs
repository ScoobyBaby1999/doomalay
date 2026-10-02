// pm-polyfill.mjs — MUST be imported BEFORE the SDK (the first import in
// pmproxy.mjs). ESM evaluates a module's imports before its own body, so a
// polyfill written inline in pmproxy.mjs runs AFTER wasm_exec.js has already
// thrown ("globalThis.crypto is not available, polyfill required") —
// live-found on the space (Node 18.20: WebCrypto only became a global in
// Node 19; the dev sandbox's Node 24 never saw it). Browsers have
// globalThis.crypto natively — this module is a no-op there and is NOT part
// of the engine's web vendor tree.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
