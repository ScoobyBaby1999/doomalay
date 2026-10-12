# PLAN-V133 — THE DEFERRED DEBT

Ship: **v1.33.0-the-deferred-debt** · phases: v1.32.1 / v1.32.2 / v1.32.3
Basline: v1.32.0-the-frame-budget (c9254ff0). The three items the frame-budget
review explicitly deferred, now paid in the agreed order.

## 0 · THE CENSUS (what the deferral said, what the tree says now)

| Deferred item | The blocker then | What the recon found now |
|---|---|---|
| Worker formatter (→ v1.32) | The DOMPurify decision (issue #577: DOM-only — the doobie transcript's "all three are worker-safe" was wrong) | `formatter.js` pipeline = extractArtifacts → marked.parse → DOMPurify → DOM postProcess + Prism. marked v12 UMD = officially worker-safe (markedjs docs say "run marked on a worker"); Prism UMD handles WorkerGlobalScope but highlight is final-render-only (v0.22 law) and DOM-bound (`highlightElement`); DOMPurify stays MAIN. `renderInto`'s return value is NEVER captured by any call site; streaming renders carry NO `_fmtSig` stamp (chatpanel 6830) → an async apply cannot corrupt the salvage cache. |
| Static cache headers (engine wave) | The "no-cache-on-everything" finding needed the OTA analysis | CONFIRMED: `noCacheFS` stamps `no-cache` on every static response; embedded assets carry NO validator (embed.FS ModTime is zero → no Last-Modified, no ETag) → every reload re-downloads the whole tree. ONLY the PM wasm route has its own rule. The constraint: the ota-first overlay serves patches at the SAME URLs → `max-age/immutable` would serve stale bytes after a patch. THE FIX IS THE VALIDATOR, not the lifetime: sha256 ETag + If-None-Match → 304. ETag flips the moment an overlay patch lands → OTA correctness is structural. |
| Vite/esbuild + gzip/immutable + lazy wasm | "needs the embed/OTA analysis" | DONE (this plan §3): the OTA manifest hashes EVERY file under `web/` from the repo tree (generate-ota-manifest.py) — per-file deltas are the OTA's whole economy; a bundler collapses them into fat artifacts, gates every parallel bot's push behind a build, and forks the manifest's source-of-truth. The PM wasm is ALREADY lazy (`pmsdk.getCore()` runs on the first PM turn — the 6.1MB .wasm.gz never fetches on a non-PM boot). Verdict: esbuild/Vite DEFERS to the React-islands strangle wave; gzip+ETag ships NOW (engine wave); lazy-wasm gets a rig pin. |
| React islands / Pixi-in-worker | later strangles, per the agreed order | NOT THIS WAVE (the boundary, unchanged). |

## §1 · v1.32.1 THE OFF-THREAD TAIL — the worker formatter

**The DOMPurify decision (the record):** sanitize stays on MAIN. Issue #577 is
explicit — DOMPurify needs a DOM; the worker options are a linkedom/jsdom shim
(a new vendored dependency inside the security-critical component) or
main-thread sanitize. The expensive string half (marked parse) moves; the
cheap trust half (sanitize) stays. The worker returns RAW marked HTML at the
exact same trust level as today's pre-sanitize string — it never touches the
DOM unsanitized.

**Edit sites:**
- NEW `web/formatter.worker.js` — classic worker; `importScripts('/vendor/format/marked.min.js')`; the SAME marked options ({gfm:true, breaks:true, headerIds:false, mangle:false} in try/catch); copies of extractArtifacts + collapseStreamingFences; job {id, mode, text, streaming} → {id, ok, html, artifacts}.
- `formatter.js` — the async client: lazy worker spawn on the first streaming full/thinking render; per-container latest-wins (monotonic job id per el); apply path = the EXISTING main-thread DOM work (sanitize → innerHTML → cursor → thinking stats → postProcess → collapseLongCode) refactored into `applyRendered()`; sync fallback (no Worker / worker error / rig shapes) = today's exact behavior; PerfHUD ledger('fmtw') for submit→apply.
- `perfhud.js` — three ledger rows (fmtw jobs / ms-worst / drops), row() + refreshPage per the v0.88 value-change gate.
- `chatpanel.js` — ZERO changes (the decisive recon fact: streaming renders are stamp-free and return-value-free; the two-tier watermark math is per-call idempotent).

**Stream-shape laws:** stable-chunk renders (streaming:false) stay sync; only
the per-tick repeated parses (no-tier render 6797, tail render 6819, thinking
streams) go to the worker; a stale apply lands nowhere (latest-wins + detached
node writes are no-ops).

**Proof (rig + walk):** `scripts/v1321-workertail-rig.mjs` — parity corpus
(12 markdown shapes: tables, fences, artifacts, hostile payloads) worker-html
=== sync-html; THE SANITIZE LAW (hostile payload → applied DOM has no
onerror/javascript: — worker output sanitized before innerHTML, always);
latest-wins (5 rapid ticks → 1 apply, last text); fallback (Worker deleted →
sync path renders). `scripts/v1321-workertail-walk.mjs` — real engine + slow
streaming stub + agent-browser: a real streamed turn moves the fmtw rows,
zero page errors, transcript renders.

## §2 · v1.32.2 THE HONEST VALIDATOR — the engine's static layer

**The shape:** keep `Cache-Control: no-cache` (the OTA law — revalidate
always), ADD the validator that no-cache has been missing:

- NEW `engine/internal/server/webstatic.go` — the static handler that replaces
  `http.FileServer(http.FS(distFS))`: sha256 ETag per path (embedded bytes are
  immutable → computed once, cached); own RFC-7232 weak-comparison
  If-None-Match gate → 304 (Etag + Vary + Cache-Control on the 304, no body —
  Go's ServeContent INM handling has the #41536 gotchas, so the gate is OURS);
  gzip variants for compressible types (lazy-cached bytes, `W/"<etag>-gz"`
  validator per RFC-7232's content-coding rule, `Vary: Accept-Encoding`);
  dir-index (/ → index.html); fs.ValidPath traversal guard.
- `otaapi.go` otaOverlay — overlay hits gain the same ETag/gzip/304 treatment
  (hash cached keyed path+size+modtime — a patch flips the ETag the next
  request after the file lands).
- `server.go` — swap the handler; the PM wasm route gains its ETag (its
  existing max-age rule stays untouched).

**Proof:** `engine/internal/server/v1322_static_test.go` — 200+ETag; exact
INM → 304 empty; weak W/ → 304; mismatched list → 200; gzip
Content-Encoding + W/ validator + Vary; identity-cached client revalidating
against the -gz variant → 200; no-cache on EVERY response; **THE OTA
CORRECTNESS PROOF** (overlay patch → ETag flips → old INM misses → 200 new
bytes); traversal rejected; "/" → index.html; range requests still work.
Live rig: the engine binary + curl (304 round-trip, gzip, the OTA patch
through the v1310 stub pattern) + an agent-browser pass whose CDP network log
shows 304s on the second load.

## §3 · v1.32.3 THE EMBED TRUTH — the analysis the deferral asked for

`RESEARCH-V132-EMBED-OTA.md`: the embed/OTA/APK-wall analysis with the
verdicts — (1) pure-web changes ride OTA (manifest = every web/ file, raw-URL
resolution, same-URL overlay); engine/Go changes need the APK (the standard
wave flow); (2) esbuild/Vite DEFERS to the React-islands strangle wave (the
four reasons: per-file delta economics, the hand-edit/no-build-gate culture,
manifest source-of-truth fork, hashed-name immutability is its real home);
(3) the PM wasm is verified already-lazy + the rig pin (no
/vendor/pm/privatemode.wasm request on a non-PM boot — CDP network log).
React islands / Pixi-in-worker: the agreed later strangles, untouched.

## §4 · THE SHIP — v1.33.0

buildinfo + the wave record; the rebase protocol (fetch → diff → merge → the
parallel bot's APK if they shipped); the full battery (all standing rigs +
the two new ones); tag `v1.33.0-the-deferred-debt`; push; CI green
(APK + Desktop + HF Space).

## THE WILL-NOT BOUNDARY (the spaghetti line)

- NO linkedom/jsdom in the worker — the sanitize law keeps DOMPurify on main.
- NO `max-age`/`immutable` on any static URL this wave — without content-
  hashed filenames it fights the same-URL OTA overlay; it returns with the
  bundler wave.
- NO bundler (Vite/esbuild) — deferred with reasons to the React-islands
  strangle wave.
- NO React islands, NO Pixi-in-worker — the agreed later strangles.
- NO chatpanel.js restructuring for the async path — the formatter client
  owns the queue; the panel's call shape stays byte-identical.
