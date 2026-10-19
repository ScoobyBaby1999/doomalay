# PLAN-V144 — THE NATIVE PM

The user's ask: *"Try to make PM run engine side and not in a web layer if
possible so it's native like the other providers."*

This is the wave that moves PrivateMode chat turns out of the WebView and
into the Go engine — the same turn pipeline, the same tools, the same
uninterrupted-turn law as every other provider. The research pass ran
first (per the house law), and its verdict changed the plan's shape:
**the migration is not only possible, it is live-proven** — a full
encrypted PM turn streamed from pure Go in this session (287 decrypted
SSE chunks, real key, real model), with zero WASM and zero JS.

---

## 0. WHERE PM LIVES TODAY (the honest map)

Three PM paths exist on the current tree:

1. **The WebView bridge** (`engine/internal/server/web/vendor/pm/` +
   `pmsdk.js` + the PM half of `chatpanel.js`): PM turns bypass the
   engine entirely. The browser runs the vendored npm SDK (v1.55.0) and
   its Go-compiled WASM (6.1 MB gz), duplicating the engine's turn
   machinery client-side — `pmMetadataBlock` twins
   `chatMetadataPreamble`, `pmLibraryPreamble` twins `libraryPreamble`,
   `pmSessionContext` twins `sessionctx.go`, plus the PM ACTION loop,
   the PM client error ladder, the PM hide-control special case, and the
   "PrivateMode turns must never wait for the engine WS" carve-out.
   ~1,500+ lines of twins that drift from their engine originals.
2. **The brain sidecar** (`brain/pmproxy.mjs` + `pm_sidecar.py`): the
   Python brain cannot speak PM's E2E protocol, so it spawns a Node
   shim on loopback:8530 that runs the SAME vendored SDK. "The same
   architecture as the app's WebView bridge, moved server-side."
3. **The engine**: labels, notices, and one key endpoint
   (`/api/keys/value` — the PLAINTEXT key hole, allowed ONLY for PM
   because the WebView bridge needs the raw key). The engine has never
   spoken PM's wire.

WHY it was built this way (vendor/pm/README.md): *"PrivateMode's chat
API requires their E2E-encryption protocol (remote attestation +
AES-GCM) which is implemented in the SDK's WASM module. The Go engine
cannot speak it."* **That verdict was wrong**, and §1 proves it.

---

## 1. THE RESEARCH VERDICTS (sources first, per the house law)

**V1 — The WASM is Go. The protocol is Go. All of it.**
`privatemode.wasm` is a `GOOS=js` Go binary (the npm package ships
`wasm_exec.js`, Go's own bridge). Its source is public:
`github.com/edgelesssys/privatemode-public` (the renamed
`edgelesssys/continuum`), at `sdk/wasm/main.go` — a thin `syscall/js`
wrapper over pure-Go packages under `internal/oss/`:
`privatemode` (the client), `encbody`+`oae` (AES-GCM body framing),
`secretclient`+`secretexchange` (the ML-KEM-768+X25519 HPKE key
agreement), `secretmanager`+`updater` (1-hour secret lifecycle),
`attest` (attestation fetch), `httpapi`, `auth`, `constants`, `sse`,
`forwarder`, `openai`, `mutators`, `persist`, `requestid`.

**V2 — The license is clean for everything EXCEPT attestation
verification.** The repo root LICENSE: source under `chat/`,
`internal/oss/`, `privatemode-proxy/`, and `sdk/` is **MIT**
(LICENSE.MIT confirmed). The one non-MIT dependency is
`github.com/edgelesssys/contrast/sdk` (BSL-1.1, Additional Use Grant:
None → AGPL-3.0 after 4 years) used solely inside
`attest.GetAttestedMeshCA` → `contrastClient.ValidateAttestation`
(SNP quote verification + manifest transition chain). Compiling that
into our engine is prohibited; reimplementing it is security-critical
clean-room work we will NOT hand-roll. **Consequence:** the engine
never verifies attestation itself. It doesn't need to — see V4.

**V3 — The official SDK itself caches the verified mesh CA.**
`internal/oss/secretmanager/updater/updater.go`: the Updater stores
`meshCA` and only calls the (BSL) attestation path when `meshCA == nil`
or after a failed exchange. Hourly secret renewals — the common case —
are pure MIT Go: `ExchangeSecret` = ML-KEM HPKE
(`crypto/hpke`, Go 1.26 stdlib) + leaf cert chained to the cached CA +
ECDSA signature over H(publicKey ‖ encapsulatedKey). **Trust
transfer:** the pinned-CA model is byte-identical in security shape to
what the official client does in-memory — we persist it and, at
bootstrap, we gate the pin behind the WASM oracle (V4).

**V4 — The one-shot WASM oracle.** The npm `privatemode-ai` package is
MIT, and its WASM artifact contains Edgeless's own attestation
verifier — the thing we may not compile, we are licensed to RUN as the
distributed MIT artifact. Design: at provider connect, the UI's
existing vendored SDK runs `verify()` once. Its success is the
attestation oracle. In the same window the engine fetches its own
`/privatemode/v1/attest` response (plain HTTPS), extracts `mesh_ca`
(wire format live-observed this session: `{AttestationDoc:
base64(JSON{mesh_ca: base64(PEM), manifests: [...], …})}`), and pins
it, marked `verified=true`. Headless engines (no UI yet) may pin with
`verified=false` and an honest "unverified first contact — open the
app to run the verification handshake" status. The WASM stays a
bootstrap utility ONLY — no PM turn ever runs in the web layer again.

**V5 — Live-proven in this session (the spike).** A scratch module
with the vendored MIT packages + a TOFU attest getter ran, with the
user's real key, on Go 1.26.9:
`initialized → secret id=+UM7… 32 bytes exp=+1h → models list
(glm-5.3, deepseek-ocr-2, …) → StreamChatCompletions → 287 decrypted
chunks (glm-5.3, reasoning_tokens: 281)`. No WASM. No JS. No BSL
code. The crypto chain end-to-end: TOFU attest pin → ML-KEM-768 HPKE
exchange → AES-GCM(OAE-framed) request → encrypted SSE response →
decrypted OpenAI chunks. (`pmspike/`, preserved for the phase tests.)

**V6 — The toolchain bump is required and safe.** `crypto/hpke` ships
in Go 1.26 (1.25 has only `crypto/mlkem`). Continuum's go.mod:
`go 1.26.0`. Our engine pins 1.25.5 (go.mod + 3 CI workflows). All our
builds are `CGO_ENABLED=0` static (Makefile incl.
`GOOS=android GOARCH=arm64` via jniLibs — the pattern the APK already
uses for the engine itself), so 1.25.5 → 1.26.9 is a mechanical bump
validated by CI.

**V7 — The wire the engine must already builds is right.** chat.go
already composes PM bodies (`effort.go`: PMAI `chat_template_kwargs`
case at the effort dispatch; `providerLabel` case at :723). The
encryption is a transport-layer swap: same JSON in, same OpenAI SSE
out — decrypted in between. Every engine turn feature lights up for
PM the moment the wire is native: native tools (glm-5.3 has
`tool_calling`), the ReAct ACTION ladder, effort pills, personas,
templates, deep research, uninterrupted-turn, persistence, and the
`delta.reasoning_content` → thinking events (observed live in the
spike's usage block).

**V8 — Alternatives considered and rejected.**
(a) *Compile the official proxy from source* — MIT-flagged
`privatemode-proxy/` but statically links the BSL `contrast/sdk`; a
build is a derivative work → prohibited.
(b) *Run Edgeless's prebuilt proxy sidecar* — published only as a
Docker image (`ghcr.io/edgelesssys/privatemode/privatemode-proxy`,
multi-arch amd64/arm64 — confirmed by layer pull this session); the
binary is nix-glibc dynamic (`/nix/store/...-glibc-2.44` loader —
confirmed by layer extraction), so no Windows/macOS story, and
Android would need glibc-loader gymnastics. A child process is also
just less native than in-process.
(c) *WASM-in-engine (wazero + wasm_exec host)* — GOOS=js binaries need
a full JS object model (fetch/streams/promises/`js.FuncOf`); prior art
(`prep/wasmexec`, MIT, archived) covers only the core runtime; effort
VH, fragility H, and SDK updates break host assumptions. Rejected in
favor of V4's one-shot oracle + pure-Go turns.
(d) *Status quo* — the user explicitly asked to leave it.

---

## 2. THE PHASES

The wave ships as v1.44.x phases; buildinfo rides at v1.44.0 per the
user's numbering law. Each phase lands green (lint + tests + rig)
before the next begins, per the rebase discipline.

### v1.44.1 — THE VENDOR (engine/internal/pm)
- Vendor the MIT client into `engine/internal/pm/` from
  `privatemode-public` `internal/oss/` (import-rewritten, upstream
  header comments and LICENSE.MIT preserved verbatim, PROVENANCE.md
  recording source repo + commit + the one local delta:
  `oss/attest` → the TOFU getter + the `pmspike` compatibility patches
  (errors.AsType→As on 1.26 this becomes unnecessary — keep upstream
  code unpatched where the toolchain allows; the ONLY semantic change
  is attest).
- Trim to the chat path: keep auth/constants/httpapi/httputil/openai/
  requestid/persist/mutators/secretexchange/oae/sse/forwarder/
  encbody/secretclient/secretmanager(+updater)/logging/compat/model/
  usage/privatemode(chat only: chatcompletions.go, privatemode.go);
  drop transcriptions/unstructured/embeddings/anthropic/middleware/
  process/tlsconfig/ocsp*.
- `constants.version` pins `"v1.59.0"` (the vendored protocol
  generation; the live API's minimum-client gate rejected our probe
  below v1.46 — observed).
- go.mod: engine `go 1.25.5` → `1.26.0`; CI: the three
  `go-version: '1.25.5'` pins → `'1.26.9'`; new deps:
  tidwall/gjson+sjson, google/uuid, avast/retry-go/v5,
  k8s.io/utils/clock (+ bcrypt only if auth.go's import survives the
  trim).
- Local spike parity test: `pm_v1440_live_test.go` (build tag
  `pmlive`, env PM_KEY) reproducing the session spike: TOFU attest →
  exchange → stream ≥1 chunk. NOT run in CI (needs a real key); run in
  the phase's live verification.

### v1.44.2 — THE PIN (vault state + the one-shot oracle)
- Vault: `pm_state` row (encrypted at rest like every key): {meshCA
  PEM, secret id/data/exp, manifest b64, verified flag, pinned_at}.
- Engine API: `POST /api/pm/bootstrap` {verified, manifest, secretId,
  secretData, exp} — the UI oracle posts its handshake result;
  `GET /api/pm/state` — {pinned, verified, secret_expires_in} for the
  connect UI + the honesty pill; `POST /api/pm/reverify` — clears the
  pin, asks the UI oracle to run again.
- The bootstrap contract: the engine does its own `/attest` fetch and
  pins `mesh_ca` it extracts; the pin is marked `verified=true` ONLY
  if the wasm oracle reported verify() success in the same window.
  TOFU (`verified=false`) is allowed headless with the honest status
  surface. On exchange failure with a stale pin: the turn errors with
  "PM deployment changed — re-verify (open the app / Re-verify
  button)" — never silent re-pin.
- Web: `pmsdk.js` shrinks from the 934-line turn bridge to the ~120-line
  `verifyOracle()` — fetch key via existing `/api/keys/value`, run
  wasm `verify()`+`refreshSecret()`+`exportSecret()`, POST to
  `/api/pm/bootstrap`. The vendor wasm/JS files stay (oracle only).

### v1.44.3 — THE WIRE (llm.Chat speaks PM natively)
- `engine/internal/llm`: PM transport in the provider dispatch — when
  `Provider == "privatemodeai"`, requests route through the engine's
  PM client instead of `httpPostJSONStream`: same ChatRequest → same
  body JSON → encrypted OAE frames → decrypted SSE → the standard
  chunk parser. Effort/thinking/tools ride unmodified (V7).
- Secret lifecycle engine-side: the pm package owns a per-key Client
  (mutex-guarded; upstream Client is not thread-safe) with the 45-min
  renewal clock, the honest failure ladder (unauthorized → key
  revoked message; attest/secret network failures → the net-pause
  ladder speaks them), and key-rotation invalidation.
- Server: PM sessions resolve their key from the vault like every
  provider; `/api/keys/value`'s PM-only plaintext hole is REMOVED
  once the oracle fetches the key through a scoped bootstrap token
  (the oracle runs before any turn; the raw-key endpoint dies).
- Model catalog: the probe path for PM lists `/v1/models` (already
  unencrypted — observed live) through the engine as today.

### v1.44.4 — THE STRIP (the web layer loses the twins)
- chatpanel.js: the PM turn path, `pmMetadataBlock`,
  `pmLibraryPreamble`, `pmSessionContext`, the PM ACTION loop, the PM
  client-error ladder, the PM hide-control special case, and the
  "never wait for the engine WS" carve-out all die — PM turns now ride
  the engine WS like every provider.
- sessions.go: the PM local-bridge notices (v1.10.5 D5) become
  PM-native notices (PM no longer implies "no sandbox tools" on HF —
  the ENGINE serves the turn wherever the engine runs; keep the
  honest notice only where true: PM on HF now CAN use sandbox tools,
  because the turn runs engine-side on the space).
- webpanel/modelpicker: PM entries point at the engine listing (they
  already do); the client-side PM model ladder (v0.89.2) retires.

### v1.44.5 — THE BRAIN (the sidecar retires)
- The brain's `providers_catalog.json` PM entry points at the
  engine's local PM bridge (the engine exposes
  `/api/pm/local/v1/chat/completions` — plain OpenAI on loopback,
  encrypted upstream; per-request key passthrough like the official
  proxy's `--api-key-fallback=never`).
- `brain/pmproxy.mjs`, `brain/pm_sidecar.py`, `brain/vendor/pm/` and
  the hfzero twins retire. The brain needs Node no longer.

### v1.44.6 — THE PROOF (red-team per the house law)
- `scripts/v1440-pm-native-rig.mjs` (live, real key): bootstrap-oracle
  flow; a 300+ token streaming turn (uninterrupted-turn law);
  thinking events from reasoning_content; effort pill bodies; native
  tools round (glm-5.3 `tool_calling`); mid-turn socket kill + resume
  (the UNBROKEN STREAM law, PM arm); model switch mid-chat; PM→other
  provider switch; secret-expiry forced renewal; revoked-key honesty;
  unverified-TOFU status pill; re-verify flow; the manifest-mismatch
  honest error (simulate via stale pin).
- Regression: v1350/v1400 rigs still green (the turn law owns PM
  now); the 62/62 + 58/58 chains re-run.
- The pmspike parity stays green under Go 1.26.9.

### v1.44.7 — THE SHIP
- buildinfo 1.44.0; README vendor note (PM runs engine-side; the wasm
  is the connect-time oracle, MIT artifact); OTA doc note; the
  worklog's record chains.
- The rebase law: fetch origin, diff, merge, push; CI green on the
  three workflows.

---

## 3. COST TABLE

| Phase | Files touched (est.) | Risk | Live gate |
|---|---|---|---|
| v1.44.1 vendor | +~40 files engine/internal/pm, go.mod, 3 CI yml | low (spike-proven) | pmlive test |
| v1.44.2 pin | vault+, server keys/pm.go, pmsdk.js −800 | med (trust UX) | oracle handshake |
| v1.44.3 wire | llm/chat.go + pm transport, server resolve | med (turn law) | 300-token stream |
| v1.44.4 strip | chatpanel.js −1500, sessions.go | med (regressions) | v1350+v1400 rigs |
| v1.44.5 brain | catalog, brain −3 files | low | space smoke |
| v1.44.6 proof | +rig | med (red-team) | rig green |
| v1.44.7 ship | buildinfo, docs | low | CI green |

## 4. THE WILL-NOT BOUNDARY

- NO hand-rolled SNP/attestation verification (BSL clean-room is out;
  the wasm oracle owns verification).
- NO PM turn in the WebView ever again; the oracle is connect-time
  only.
- NO silent TOFU upgrade: an unverified pin always shows itself.
- NO protocol shortcuts: the exchange keeps the full leaf-chain +
  signature verification (V3) — the threat model is not negotiable.
- NO new theme-surface in this wave; the PM status pill uses existing
  theme tokens (the theme law).

## 5. OPEN QUESTIONS (defaults proposed)

1. **Prompt-cache salt scope** — per-engine persistent salt (proxy
   parity) vs per-session. DEFAULT: per-engine, persisted (their
   shared-cache default; better prefix-cache hits).
2. **The `/api/keys/value` hole timing** — v1.44.3 kills it the
   moment the oracle no longer needs the raw key; oracle instead
   posts the secret (it holds the key already at bootstrap via the
   scoped value fetch, replaced by a one-time token exchange).
   DEFAULT: keep the endpoint for v1.44.2, kill in v1.44.3.
3. **HF-space PM** — the space runs engine-side now: PM turns work
   there with sandbox tools (a capability UPGRADE vs the "local
   bridge" era). The old notices are deleted, not reworded.
   DEFAULT: proceed; honest changelog note.
4. **Old pinned-manifest mismatch UX** — engine-side the manifest
   byte-compare lives only in the oracle; the engine compares
   manifests[0] when the pinned manifest exists (TOFU getter does
   this — live-observed field), honest error on drift. DEFAULT:
   compare when pinned, warn-not-fail if absent.

— researched and live-proven 2026-10-19; the spike transcript and the
vendor provenance ride with the v1.44.1 commit.
