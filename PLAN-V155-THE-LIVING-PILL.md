# PLAN-V155 — THE LIVING PILL

The user's device report on the v1.53 APK (verbatim asks, mapped to root causes):

1. **The cloud provider screen**: opencode moves BELOW privatemodeai and Nvidia; its
   "Get API key" becomes a regular row link (no addition box); the link lands on the
   opencode console **service-accounts** page (the org id resolved by opencode after
   login — probe verified `https://opencode.ai/console/settings/service-accounts`
   serves 200 and the SPA resolves the user's own workspace, exactly "the org_xyz
   replaced by the users own workspace or whatever it is opencode does").
2. **A generic pill system on the whole provider screen**: pills spawn left→right
   next to "Get API key", attachable to ANY provider. OpenCode's pills:
   `+ install opencode`, `+ setup termux` (→ the existing TermuxSetup overlay),
   `installing opencode..` (live, different theme tone, pings download progress),
   `failed, retry` (resumes from checkpoints — never loses progress), and dim
   `opencode setup` / `termux setup` pills when installed.
3. **The install window must not kill the screen**: today, while opencode installs,
   the provider screen "doesn't work and returns no providers".
4. **The opencode zen model catalogue returns NO models** — must be fixed, and ALL
   cloud model lists must be derived DYNAMICALLY ("no static lists, not even
   fallback"), applying the docs findings (console/models pricing/endpoints/model-list,
   models variants/options/aliases/reasoning/prompt-caching, models.dev) to opencode
   AND openrouter AND every other provider where applicable.

## RESEARCH CONVICTED (all live, saved /home/z/my-project/v155-research/ + the 155-A/155-B worklog entries)

- **The starvation bug (ask 3) is a mutex hang + connection-pool exhaustion**:
  `ocServeManager` (ocserveturn.go:42-85) holds `ocServeMu` for the ENTIRE install;
  `GET /api/opencode/bridge`'s first ladder case calls `ocServeManagerNow()` which
  locks the SAME mutex → every status poll blocks until the install finishes
  (the "installing" rung is unreachable while installing). The PWA poll
  (providers.js:117-128, 2s interval) has no AbortController → the WebView's
  6-connections-per-host limit exhausts in ~12s → `/api/models` + `/api/keys` queue
  behind blocked polls → their 4s caps fire → providerList renders
  "No providers in this tab." (providers.js:320-322). THE USER'S EXACT SYMPTOM.
- **The zen catalog bug (ask 4)**: the hosted list endpoint WORKS (live-probed:
  `GET https://opencode.ai/inference/v1/models` = `/zen/v1/models` → 200, 46 ids with
  a valid key, 87 keyless; docs document it keyless). The engine's fetch
  (models_v2.go fetchOpenCodeModels, 9s cap, any error → nil) fails on a busy phone
  radio (or during the install starvation) → the group ships 0 models →
  **that empty result is cached for 10 minutes** (catalogV2TTL) and the PWA
  additionally localStorage-caches it (`doomalay.modelcache.v1`) — "no models"
  persists long after the network recovers.
- **models.dev is the dynamic metadata source the law demands** (and it is
  OpenCode's own org's registry — anomalyco/models.dev): `GET api.json` → 232
  providers, opencode 130 models (cost/limits/reasoning/reasoning_options/tool_call/
  interleaved), openrouter 389, nvidia 107, mistral 39, huggingface 84,
  privatemode-ai 11. Per-model: `reasoning_options` = the variants/effort truth
  ([{type:"effort",values:[low..max]}] | toggle | budget_tokens), `cost`
  (input/output/cache_read/cache_write/tiers — verified EXACT against console docs),
  `limit.context/output`, `status` (alpha|beta|deprecated). The engine already has
  a models.dev consumer (modelsdev.go) — but fed by an EMBEDDED SNAPSHOT
  (catalog/modelsdev_snapshot.json.gz, 103KB static list — the law's first
  violation). Live fetch with ETag/304 revalidation + disk cache replaces it.
- **The 2.x serve catalogue is never consulted**: the pocket serve exposes
  `GET /api/model` (71+ models with per-model variants reasoningEffort
  low/medium/high/xhigh/max, limit.context/output, cost — captured in v151 research)
  and no engine code path reads it. On Android, when the bridge is up, this is the
  richest dynamic source for the opencode group.
- **Static lists to kill (the "no static lists, not even fallback" audit)**:
  the embedded models.dev snapshot; reasoning_catalog.json (effort SOURCE 4);
  pricing.go static per-family prices; the triplicated zen free literals
  (models_v2.go:452-458 / opencode_free.go:23-27 / catalog.go:594-615);
  effort.go's static per-provider blankets + pmFamilyEffort; providers.json
  probe_model pins; family.go toolsKws literals; the /api/models brain proxy
  (serves the brain's static catalogs on desktop — engine Go path goes always).
- **Other providers can all be dynamic** (live-probed): openrouter
  `openrouter.ai/api/v1/models` (keyless, 468, richest), nvidia
  `integrate.api.nvidia.com/v1/models` (keyless, 83), mistral
  `api.mistral.ai/v1/models` (keyed, 53, real server aliases[]), hf
  `router.huggingface.co/v1/models` (keyless, 135) — hf is BRAIN-ONLY today
  (not in the engine catalog); privatemode `api.privatemode.ai/v1/models`
  (keyed, 13, tasks[]). models.dev enriches them all.
- **The download has no checkpoints** (termux.go tmCmdDownload): single-shot
  `curl -fL --retry 3` — a retry restarts from byte zero; no progress is exposed
  (binary installing/failed only). `curl -C -` resume + a byte-progress sidecar
  file + stage tracking fixes both the pill's live ping and the retry law.

## THE PHASES

### v1.55.1 THE HONEST LADDER (engine + poll)
- ocserve Manager gains an atomic install snapshot: {phase, stage, bytes, total,
  attempt, err} — updated by the provisioner at every stage; readable WITHOUT any
  lock. The long install work runs detached (it already is a detached goroutine —
  now it stops holding `ocServeMu` across minutes; the mutex only guards manager
  pointer bookkeeping, single-flight stays).
- `GET /api/opencode/bridge` NEVER blocks: running-flag first (answers `installing`
  + stage + bytes + percent instantly), then a bounded (250ms) manager peek for the
  healthy/`up` case. Additive response fields: `stage`, `progress_bytes`,
  `progress_total`, `attempt`.
- termux.go: the download becomes resumable (`curl -fL -C - --retry 5
  --retry-all-errors --connect-timeout 20` — the partial zip IS the checkpoint),
  with a sidecar byte-progress file written by a stat loop in the same exec, and a
  corrupt-SHA honest rejection (bad zip deleted, no bogus resume). Stage ladder:
  deps → download → verify → unpack → configure → spawn; the retry path skips
  completed stages (install-check + idempotent stages) and resumes the download
  from its byte offset.
- providers.js poll: AbortController + single-flight (never stacks), so the pool
  never starves again.
- PINS: ocserve/ocbridgeapi tests — the non-blocking law (status answers during an
  in-flight install in ms, not minutes), the progress fields, the resume command
  shape (byte-pinned), the stage ladder, single-flight, the corrupt-SHA rule.

### v1.55.2 THE ROW OF PILLS (PWA provider screen)
- providers.js: `FREE_ORDER` → privatemodeai, nvidia, opencode, openrouter,
  cloudflare, groq, together, mistral (+ hf once v1.55.3 adds it);
  `smartConnect` PRIORITY aligned (privatemodeai → nvidia → opencode).
- engine catalog providers.json: opencode `signup_url` →
  `https://opencode.ai/console/settings/service-accounts` (the org-less form —
  opencode resolves the user's own workspace after login).
- The opencode card LOSES its bridge state box (bridgeHTML) — the row renders
  byte-identical to every other provider row (Get API key included). The validation
  reason line stays (same shape as all providers).
- THE GENERIC PILL SYSTEM: `providerPills(name, ocBridge)` → ordered pill list
  rendered left→right next to "Get API key" (flex row, gap, wrap; theme tokens only
  — accent tone for actions, live tone (--accent-2) + pulse for installing, err tone
  for failed, dim (--text-3/surface) for done states). Attachable to ANY provider —
  opencode is the first consumer:
  - `+ setup termux` (when termux_missing/not_bootstrapped) → opens the EXISTING
    TermuxSetup overlay (the two-surface law); installed → dim `termux setup` pill.
  - `+ install opencode` (ready) → POST /api/opencode/bridge/install;
    `up`/`desktop` → dim `opencode setup` pill.
  - `installing opencode.. N%` (live pill — different theme tone, pulse animation,
    prefers-reduced-motion respected) — the poll (v1.55.1) updates it with real
    download bytes; NEVER static.
  - `failed, retry` (install_failed) → re-POST install; the engine resumes from the
    byte checkpoint (progress never lost).
- PINS: js-source pins on the order, the removed box, the pill tones (no hardcoded
  colors), the org-less service-accounts URL.

### v1.55.3 THE LIVING CATALOG (engine — the no-static-lists law)
- NEW modelsdev live DB (modelsdev_live.go): `GET https://models.dev/api.json`
  (gzip, If-None-Match ETag → 304 keep; disk-cached beside the engine's data so
  restarts don't re-download 6MB) parsed into provider→model maps with the FULL
  schema (cost incl. cache_read/write + tiers, limit.context/output, reasoning,
  reasoning_options, tool_call, structured_output, modalities, status, name).
  `LookupSpec` consults the LIVE DB (engine→models.dev provider id mapping is
  structural config, like base URLs). The embedded snapshot
  (catalog/modelsdev_snapshot.json.gz) + its generator are DELETED from the serving
  path — no static model list, not even fallback. If models.dev is unreachable:
  groups still render from the provider's own live list, metadata-poor (honest),
  with the sync error surfaced.
- opencode zen: availability from `GET https://opencode.ai/inference/v1/models`
  (keyed; 401/network → keyless retry; deprecated ids dropped via models.dev
  status); metadata merged from models.dev/opencode (context/output/pricing incl.
  cache tiers/free = cost 0); when the pocket bridge is UP, `GET /api/model`
  (the serve's own catalogue) merges in its per-model variants/cost/limits — the
  device-local truth. The zen free literals DIE (all three copies) — free is
  `cost.input==0 && cost.output==0` from live data.
- nvidia: `integrate.api.nvidia.com/v1/models` (keyless ok) + models.dev/nvidia
  merge (context, cost, free = cost 0 — replaces the build.nvidia.com scrape
  dependency where models.dev answers; the scrape remains as a secondary dynamic
  source only when models.dev lacks the model).
- mistral: keyed list (real `aliases[]`, `capabilities`, deprecation) + models.dev
  merge. privatemodeai: list + models.dev/privatemode-ai merge. openrouter: the
  reasoning registry stays the availability truth + models.dev reasoning_options
  enriches effort levels. The generic OpenAI-compat fetchers (groq/together/
  openai/anthropic/deepseek) merge models.dev metadata by provider id.
- **hf joins the ENGINE catalog** (the brain-only gap): provider card
  (router.huggingface.co/v1, HF_TOKEN) + dynamic fetcher (keyless
  router /v1/models + models.dev/huggingface) — desktop's brain path no longer the
  only hf surface.
- THE NEGATIVE-CACHE LAW: a provider group that returned ZERO models with an error
  is NEVER cached as fresh — the next /api/models retries it (light 60s per-provider
  backoff); the response marks it honestly in syncStatus. The PWA
  (modelbrowser.js) never localStorage-caches a catalog with errored-empty groups.
- `/api/models` (server/models.go): the brain proxy is REMOVED — the engine's
  dynamic catalog is always the truth (the brain's static catalogs never reach the
  PWA again); desktop and Android become identical.
- PINS: live-fetch shapes against local httptest servers (models.dev etag/304,
  the zen merge keyed/keyless/deprecated-drop, free-from-cost, hf group presence,
  negative-cache law, brain-proxy removal).

### v1.55.4 THE LIVE EFFORT (engine — reasoning/variants wiring)
- fetchedModel.Effort (SOURCE 1, the top precedence) is populated from
  models.dev `reasoning_options` for every merged provider: effort values →
  EffortLevels (canonical ladder), "none" → CanDisable, budget_tokens →
  EffortBudget, toggle → the on/off vocabulary. The static blankets
  (effort.go per-provider ladders incl. the opencode {"low","high"} entry),
  pmFamilyEffort, and the curated reasoning_catalog.json SOURCE 4 DIE for cloud
  models (the chain becomes: live per-model → live registry → honest nothing).
- The serve variant law: when a turn goes through the pocket/desktop serve and the
  picked model exposes variants (serve /api/model reasoningEffort), SelectModel
  sends the `#effort` variant suffix — the user's effort knob reaches the 2.x serve
  (the direct zen path already speaks reasoning_effort).
- The probe-model pins DIE: key validation probes pick their model from the LIVE
  catalog (prefer live cost==0 → first list entry); catalog.go isFreeProbeModel /
  providers.json probe_model / family.go toolsKws literals replaced by live-data
  derivations.
- pricing.go static per-family prices: the ledger prefers the live models.dev
  cost (incl. cache_read/cache_write/tiers); the static table is deleted from the
  serving path (honest "unknown" when live data lacks a model).
- PINS: effort resolution from live reasoning_options (gpt-5.5 none→xhigh ladder,
  big-pickle toggle, claude budget_tokens), the serve variant suffix byte-shape,
  probe-model dynamic selection, zero effort ladders left in the statics.

### v1.55.5 THE LIVE PROOF (the rig — act as the user)
- scripts/v1550-living-pill-rig.py — LIVE, real engine, real keys:
  1. THE STARVATION TEST (the convicted bug): an in-flight install (fake bridge
     jail, the v149/v151 rig pattern) — /api/models and /api/keys answer in ms
     DURING the install; the bridge GET answers `installing` with growing bytes.
  2. THE CHECKPOINT TEST: kill the download mid-flight → install_failed → retry
     POST → curl `-C -` resumes from the partial zip's byte offset (proved by
     byte counts, not a second full download).
  3. THE CATALOG TRUTH: opencode zen group ships real models with context,
     pricing, effort levels from models.dev (big-pickle free/cost-0/200k-ctx);
     openrouter/nvidia/mistral/privatemodeai/hf groups non-empty + enriched;
     a failure is never 10-minute-cached; PWA cache law.
  4. THE ZERO-STATIC LAW: grep pins — no model-name literals in the serving path;
     the snapshot file gone; the blankets gone.
  5. THE PILL LADDER (PWA redteam): row order, the missing box, pill states
     (action/live/failed/dim), theme-token-only styling, the org-less
     service-accounts link.
- Real-user pass: the full flow on the sandbox twin — open providers, add key,
  see models, install flow, retry, chat a free model through the serve.

### v1.55.0 THE SHIP
- buildinfo next-free-dot (re-fetch main first — the parallel library wave owns
  1.54.x; expect 1.55.0), README living-pill paragraph, repo worklog head entry,
  vet + full battery green, linux + android-arm64 cross-compiles, /api/health
  answers live, tag push. THE REBASE LAW before every push.
