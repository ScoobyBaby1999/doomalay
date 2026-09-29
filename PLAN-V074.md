# PLAN — v0.74 "friendly fallback" (re-implementation of the live-verified v0.72 wave)

Status: RECOVERY — the original implementation was verified live (age card rendered,
BYOK proven on the community space, accounts UI hydrated) but the local commit
8048bb30 was lost to sandbox reset #9. The community Space still runs the brain
fix (verified: brain/reqenv.py present, /health ok, mode hf-token-auth).
The parallel bot's bundle wave took the v0.72/v0.73 tags → this ships as v0.74.

Rebase state: fresh clone @ a9644334 (v0.73.0). Disjoint zones except
engine/internal/server/chat.go (their turn-bundle lines; my remoteBrainFor lines — no
textual overlap). No merge needed.

## PHASES

### Phase 1 — engine server: the age gate (hfspace.go + server.go)
- `writeErrorCode(w, status, msg, code)` — writeError's sibling with a code field.
- `isAccountAgeError(msg)` — ci-substring pattern table: "30 day", "30-day",
  "30 days", "thirty day", "too young", "account age", "at least 30", "older than 30",
  "less than 30", "newer than 30". Runs ONLY on the /api/repos/create error path.
- `handleHFSpaceCreate`: age check FIRST (before ZeroGPU-quota + PRO so they can't
  shadow it) → 403 {error: friendly one-liner, code:"account_age"}.
- `handleHFSpaceDockerCreate`: same check in its create-error branch.

### Phase 2 — brain BYOK (brain/reqenv.py NEW + server.py + agent.py + tools/dt_hf.py)
- reqenv.py: ContextVar REQ_ENV + extract(request) + bind/unbind + req_keys +
  resolve_key(env_var) (per-request first, os.environ last) + has_key.
- server.py /chat: req_env per-request dict; DELETE the os.environ write loop;
  api_key = req_env or os.environ; thread run_turn(api_key=…); bind REQ_ENV at
  event_stream top (task-local: one response, one context), reset in finally.
- server.py /models + /judge: extract + bind, no os.environ writes.
- agent.py run_turn: api_key=None param (os.environ fallback for old callers),
  threaded to the LLM client + llm_info (sub-agents already thread it).
- tools/dt_hf.py _get_token: per-request ContextVar first, explicit env override,
  os.environ last.

### Phase 3 — engine third-party env filter (chat.go + hfspace.go)
- `thirdPartyRemoteEnv()`: vault.AsEnv() filtered to PROVIDER_KEY_ALLOWLIST vars +
  DOOMALAY_HF_TOKEN/HF_TOKEN/HUGGINGFACE_TOKEN. GITHUB_PAT / space tokens / the
  rest of the vault NEVER cross to a shared/public remote.
- remoteBrainFor: shared + public modes use the filtered env; own keeps full.
- fanOutRemoteEnv: "public:"-prefixed remotes + sharedBrain → filtered; own → full.

### Phase 4 — sandboxpicker.js: the age card (the user's spec)
- getJSON: attach err.code from the response body.
- wireCreate catch: code==="account_age" → renderAgeCard(form, onPick).
- renderAgeCard — themed, ConnectOverlay (one of the two overlay screens):
  LARGER/BRIGHTER headline (accent, bold) → "Hugging Face needs your account to be
  30+ days old to create a Space"; ⚠ shared warning FIRST ("never share secrets or
  personal info"); the community link (tap-to-copy + paste-in-"use a public space"
  instruction); 🔑 BYOK note; [add your own key] (ProvidersScreen) + ONE-TAP
  [use the community space for this chat] (onPick public doomalaysocreate).
- .hf-age-* style family, theme vars only, 44px touch targets.

### Phase 5 — appearance.js: Connected Accounts (General page)
- section('Connected Accounts'): HF row (/api/hf/account; connect →
  HFConnect.openConnectPanel; log out → POST /api/hub/auth/disconnect),
  GitHub row (/api/workspaces/accounts; connect → GHConnect.openConnectPanel;
  log out → DELETE ?kind=github), Gitea row (only when signed in), Cloud providers
  row (/api/keys count → manage → ProvidersScreen.open). Async hydration,
  device-only removal note, data-action dispatch.

### Phase 6 — sync + tests + gates
- make sync-hfzero; new hfspace_v074_test.go (pattern table, age-gate 403+code,
  non-age passthrough, thirdPartyRemoteEnv filter); buildinfo 0.74.0;
  go build/vet/test, node --check, py_compile, test_theme_twins, test_uikit.
- Live rig: engine + mock HF age error → the card renders; one-tap connects;
  accounts rows hydrate; log-out flips the row.

### Phase 7 — ship
- Brain files re-uploaded to ScoobyBaby1999/doomalaysocreate (repo-consistent:
  my BYOK + the parallel bot's bundle hands ride together).
- Push main + tag v0.74.0-friendly-fallback + release. Rebase check before push.
