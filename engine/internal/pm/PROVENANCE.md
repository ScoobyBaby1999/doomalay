# Provenance — engine/internal/pm

The PrivateMode (api.privatemode.ai) native client, vendored so the Go
engine speaks PM's end-to-end encryption protocol itself — no WASM, no
JS runtime, no WebView — as part of v1.44 THE NATIVE PM
(../../PLAN-V144-THE-NATIVE-PM.md).

## Source

- Upstream repo: `github.com/edgelesssys/privatemode-public` (the public
  mirror of Edgeless Systems' Continuum monorepo)
- Upstream commit: `17ad265a79a39f30596ae2f12ec64ccbd9127275` (2026-10-13)
- Upstream path: `internal/oss/<pkg>` → here: `engine/internal/pm/<pkg>`
- License: the upstream repo root LICENSE grants view/audit rights for
  the whole tree and adds: *"The source code under `chat/`,
  `internal/oss/`, `privatemode-proxy/`, and `sdk/` is additionally
  licensed under MIT. See LICENSE.MIT"* — every file vendored here comes
  from `internal/oss/` (LICENSE.MIT is copied alongside this file).
  Upstream per-file `SPDX-License-Identifier: MIT` headers are preserved
  verbatim in every vendored file.

## Local deltas (the complete list)

1. **`attest/` — REPLACED** (the only package not byte-identical in
   shape). Upstream `internal/oss/attest` verifies the coordinator's
   SNP attestation through `github.com/edgelesssys/contrast/sdk`, which
   is **BSL-1.1 (Additional Use Grant: None)** — we may not compile it.
   Our replacement keeps the same `Getter` interface and wire protocol
   (POST `/privatemode/v1/attest` with a 32-byte nonce, base64 doc
   unwrap, manifest byte-compare, PEM mesh-CA extraction) but performs
   **no attestation verification**. TRUST CONTRACT: the pinned mesh CA
   is established at provider-connect time by the one-shot WASM oracle
   — the app's vendored npm `privatemode-ai` SDK (an MIT-distributed
   artifact embedding Edgeless's own verifier), which runs the full
   Contrast attestation verification we cannot compile. The engine's
   pin is TOFU (trust-on-first-use) gated by the oracle's success; a
   pin without oracle verification is surfaced honestly as unverified.
   Wire shape live-observed 2026-10-19:
   `{AttestationDoc: base64(JSON{version, attestation_type, manifests:
   [base64…], policies, mesh_ca: base64(PEM), root_ca,
   raw_attestation_doc})}`.
2. **`privatemode/privatemode.go`** — the `contrastsdk` import and the
   `contrastClient := contrastsdk.New()…` construction in `Initialize`
   are removed (our attest.Getter takes no contrast client); everything
   else is upstream.
3. **`privatemode/aserr.go`** (new) — `errors.AsType[*ResponseError]` →
   an `errors.As` shim (`toResponseError`). Upstream targets Go 1.26's
   `errors.AsType`; the engine pins Go 1.26 toolchain but keeps this
   shim for clarity. Same in **`forwarder/errors.go`**
   (`toFwdError`).
4. **`constants/constants.go`** — `var version = "0.0.0-dev"` (upstream
   ldflags-injected) is pinned to `"v1.59.0"`, the protocol generation
   of the vendored code (the live API enforces a minimum client
   version; observed 2026-10-19: bare versions below v1.46 are
   rejected with *"The minimum client version is v1.46"*).
5. **Trimmed to the chat path** (upstream `internal/oss` also serves
   their proxies): not vendored — `anthropic`, `unstructured`,
   `transcriptions`/`embeddings` (privatemode pkg files), `ocsp`,
   `ocspheader`, `middleware`, `process`, `tlsconfig`, `contrast`.
   Test files (`*_test.go`) are not vendored.
6. **Import paths** rewritten from
   `github.com/edgelesssys/continuum/internal/oss/<pkg>` to
   `github.com/ScoobyBaby1999/doomalay/engine/internal/pm/<pkg>`.

## Dependencies added to engine/go.mod

`github.com/tidwall/gjson` + `sjson` (openai/mutators), `github.com/google/uuid`
(requestid), `github.com/avast/retry-go/v5` (secretmanager/updater),
`k8s.io/utils/clock` (secretmanager), `golang.org/x/crypto` (auth
bcrypt). Go toolchain: `go 1.26.0` (the `crypto/hpke` stdlib package —
ML-KEM-768+X25519 HPKE for the secret exchange — ships in Go 1.26).

## Why not the official proxy / the WASM?

Evaluated and rejected in PLAN-V144 §V8: the prebuilt
`privatemode-proxy` is a Docker-image-only, nix-glibc dynamic binary
(no Windows/macOS, Android loader gymnastics, a child process is less
native); running GOOS=js WASM in-engine needs a full JS object model
(fetch/streams/promises) with high fragility. The one-shot WASM oracle
at connect time + pure-Go turns is the strongest legal, portable and
native shape. The WASM artifact ships in the npm `privatemode-ai`
package under MIT — the same artifact the app has always vendored.
