# PrivateMode AI SDK (vendored, v1.55.0)

Files: privatemode-ai.js, wasm.js, wasm_exec.js, errors.js from the official
`privatemode-ai` npm package (https://www.npmjs.com/package/privatemode-ai,
repo: github.com/edgelesssys/continuum sdk/js) + privatemode.wasm.gz
(gzip-compressed privatemode.wasm, 5.9MB vs 27.7MB raw).

WHY: PrivateMode's chat API requires their E2E-encryption protocol
(remote attestation + AES-GCM) which is implemented in the SDK's WASM
module. The Go engine cannot speak it; PM's own docs say non-JS clients
must run their local proxy container (impossible on Android). The WebView
IS a JS runtime, so PM chat turns run client-side through this SDK —
exactly how PM's own web app works. The API sends
`access-control-allow-origin: *`, so the cross-origin WASM fetches work.

The wasm is served decompressed-on-the-fly: /vendor/pm/privatemode.wasm
responds with Content-Encoding: gzip + Content-Type: application/wasm.
