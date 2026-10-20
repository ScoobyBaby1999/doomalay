# PLAN-V145 — THE HONEST PM

The user's post-v1.44.0 device report, verbatim: *"I had an issue where network was
unreachable when I initially used pm as a provider. Even tho I was connected to the
internet… Privatemode ai still says network hiccup retrying then pm unreachable…
The pills seem to leak whenever a fresh chat is created… This means we built our pill
system non modularly without OOP concepts… each chat should be isolated and have its
own instance completely… PM should work like the rest without the need for a separate
bridge sandbox."*

Research verdicts (this session, live-proven where noted):

- **V1 — THE ANDROID WIRE GAP (root cause of "pm is unreachable").** The engine's
  own providers dial through `netx.DialContext` — netx.go's own law: *"the Android
  DNS fix applies everywhere. Every engine client that talks to the outside world
  … should use this"* (system resolver → DoH fallback → try-each-address). The
  vendored PM client (`pmstate.NewManager → httputil.NewClient()`) uses Go's
  DEFAULT dialer. On Android `/etc/resolv.conf` does not exist and Go's pure
  resolver is unreliable — PM's dials die on-device while Nvidia/OpenRouter work.
  Live-proven equivalent: pointing the engine at a dead endpoint reproduces the
  user's exact pill sequence (probe: `network hiccup — retry 1/2` → `network still
  paused — PrivateMode unreachable` → suspension forever).
- **V2 — THE 5s HTTP/2 HEALTH PING.** The vendored transport sets
  `HTTP2.SendPingTimeout = 5s` (Go source verified: no frame for 5s → PING; no PING
  response in 15s → the connection is KILLED mid-request). The engine's own
  transports carry no health-check pings. On lossy mobile links the PM client kills
  connections every other provider rides through.
- **V3 — THE FALSE "NETWORK" BLAME + THE HOSTAGE TURN.** Any single-provider
  outage enters the engine-wide net-pause texts ("network paused — X unreachable")
  and the INFINITE patient-engine suspension, while the user's network is fine
  (other providers streaming — live-proven in the hunt: Nvidia answered while PM
  pill said "network"). The suspended turn holds the session lock forever; every
  new send = busy reject (live-proven on the Sky transcript). Cosmetic bug
  convicted too: the hiccup counter hardcodes "/2" while counting past it
  ("retry 5/2" — rig-compressed rungs exposed it).
- **V4 — THE STALE-PIN LOOP.** `pmstate` drift-checks only on UpdateSecret
  failures; an `InitializeWithPinnedCA` failure (rotated mesh CA) surfaces as a
  transport-class error → net-looped forever instead of the honest
  `ErrPMDeploymentChanged`.
- **V5 — THE LICENSE WALL (re-verified this session).** edgelesssys/contrast
  LICENSE: BSL-1.1, Additional Use Grant: None, Change Date "four years from a
  MINOR version publish", Change License AGPL-3.0-only. The attestation verifier
  may never be compiled into the engine — not now (BSL), not after the change date
  (AGPL). The wasm oracle cannot be legally replaced. The honest reading of the
  user's ask: PM must WORK with zero bridge involvement — which the TOFU pin
  already delivers (unverified pins serve turns today); what must die is the
  AUTO-wasm (`pmOracleNudge` loads the 6.1MB module on PM chat open / model pick
  and fires a failing verify on every device where PM is unreachable — noise the
  user saw at first use).
- **V6 — THE PILL SYSTEM.** Live MutationObserver hunt across 3 live provider
  chats + rapid switching: the happy paths attribute correctly. The user-visible
  leaks line up with: (a) the DOM stash baking the `.chat-working` row into
  `state._domStash` (stale text flash on reopen), (b) the row-move DEL/ADD pairs
  on keep-it-last (`container.appendChild(row)` — a visible re-paint of the
  outgoing row), (c) the silence fallback reading `state.provider`. The demand is
  architectural: ONE PILL INSTANCE PER CHAT (OOP), owning its own DOM, never
  querying the shared panel body. That is what we build.

## The phases

### v1.45.1 THE ANDROID WIRE (engine)
- `pmstate.NewManager`: the manager's `httpClient` becomes
  `&http.Client{Transport: netx.Transport()}` — the Android DNS fix + no 5s
  health ping. Tests keep injecting fakes via the field (same package).
- The attest getter, the wire, and the brain's local bridge all ride the manager's
  client — one line fixes every path.
- `pm/PROVENANCE.md`: record the local delta (the vendored httputil.NewClient is
  no longer used by the engine's manager; netx is wired — Android DNS + mobile-safe
  ping policy).
- Unit pin: the manager's transport `DialContext` IS netx.DialContext.
- Live proof: the pmlive gates stay green (real key, real deployment).

### v1.45.2 THE HONEST NET (engine)
- `cooldown.go` gains success tracking: `RecordProviderSuccess` already clears on
  expiry — add `lastSuccessAt per provider` + `anyOtherProviderHealthy(provider)`
  (a different keyed provider succeeded within 10 minutes AND is not in an active
  net cooldown).
- `netPauseLadder` grows the honest mode: provider-scoped when
  `anyOtherProviderHealthy(provider)` (device-offline keeps today's behavior
  byte-for-byte — the v1400 law untouched).
  - Provider-scoped texts NEVER say "network": `"%s is unreachable — retrying in
    %ds (your connection is fine)"`, heartbeat `"%s still unreachable — next
    attempt in %ds"`, enter-notice `"connection to %s keeps failing — holding the
    turn for now"`, and the honest terminal after the bounded hold:
    `"%s is unreachable right now — this looks like a problem on their side (your
    connection is fine). Tap Retry when you want to try again."`
  - BOUNDED HOLD: the rungs, then a capped suspension
    (`DOOMALAY_PROVIDER_HOLD_MS`, default 2 minutes — rig-compressible), then the
    terminal error. The lock releases; the chat is usable; the partial work + the
    error persist (the standard error affordances own the retry).
  - Device-offline (no other provider healthy): the INFINITE patient engine, the
    wake channel, today's texts — unchanged.
  - The counter: `network hiccup — retry %d/%d` with the REAL quick-rung count;
    provider-scoped hiccups name the provider: `%s connection hiccup — retry %d/%d`.
- `pmstate`: `InitializeWithPinnedCA` failure → the drift check (CA changed =
  `ErrPMDeploymentChanged`; unchanged = the honest init error surfaces).
- Law note: THE UNBROKEN TURN (v1.35) is untouched — the engine never kills a turn
  over its OWN wire; a provider's bounded unreachability is the provider's verdict,
  honestly surfaced with the work preserved. Documented in the commit.

### v1.45.3 THE PILL OBJECT (web layer)
- `ActivityPill` class — ONE INSTANCE PER CHAT STATE:
  - Owns its row element (create/destroy/move), its phase text, elapsed, stall
    escalation, the ⇄ switch chip — all the renderActivity/hideActivity logic
    moves INSIDE, scoped to `this.state`.
  - `bind(container)`: (re)binds to THIS chat's own `#chat-messages` after
    renderHost / stash-restore; paints `state._actText` IMMEDIATELY (no stale
    flash, no 500ms blank).
  - The pill renders ONLY into its own container — it never queries
    `currentCtx.bodyEl`. Visibility = "my state is the owner AND my container is
    the live one" — checked via `currentCtx.state === this.state` plus its own
    `container.isConnected`.
  - `set(text)` / `bump()` / `hide()` / `tick()`: per-state storage
    (`state._actText`, `_lastActAt`, `_turnStartAt`) as today, painted only when
    visible; the 500ms watch interval calls `state._pill.tick()`.
  - The stash: the row rides the chat's own DOM naturally (same chat — correct by
    construction); restore adopts the row via `bind()` and re-paints the CURRENT
    phase (no baked-stale text).
- `getOrCreateState` constructs `state._pill = new ActivityPill(state)`;
  `renderHost`/`restoreStashedChat` call `state._pill.bind(freshContainer)`;
  `setActivity`/`bumpActivity`/`hideActivity`/`renderActivity`/`tickThinkingMeta`
  call sites become thin delegates (no behavior change for callers).
- The silence fallback reads `this.state.provider` (already per-state — now
  provably scoped inside the object).

### v1.45.4 THE QUIET ORACLE (web layer)
- `pmOracleNudge` DELETED — PM chat open / model pick loads ZERO wasm. PM works
  TOFU-native exactly like every provider.
- providers.js PM card: the pin pill copy turns honest-quiet: "engine-pinned
  (trust-on-first-use)" + "attestation check: optional" — the Re-verify button
  stays as the ONLY wasm trigger (on-demand, labeled "verify the deployment's
  attestation (downloads the verifier once)").
- The PM connect flow: key save + catalog sync — no oracle, no ticket mint.
- Zero PM-bridge mentions in the chat UI.

### v1.45.5 THE PROOF
- `scripts/v1450-honest-pm-rig.mjs`:
  - R1 dead-PM + live-Nvidia: the honest provider-scoped texts (assert the pill
    stream NEVER says "network" while Nvidia is healthy), the bounded hold → the
    honest terminal → the session UNLOCKED (a fresh send reaches the ladder), the
    counter texts.
  - R2 the counter + mode unit pins (Go).
  - R3 the pill isolation hunt (the MutationObserver battery): 3 live provider
    chats, rapid switching — every logged pill text that names a provider must
    match the open chat's provider; zero cross-chat texts.
  - R4 the stash path: pill live → panel close → reopen: the first observed text
    equals the live phase (no stale flash).
  - R5 the quiet oracle: PM chat open + model pick loads no wasm (network
    request count for /vendor/pm/* == 0); Re-verify still runs it on demand.
  - R6 regressions: v1350 + v1400 + v1440 rigs green; go battery; node --check;
    cross-compile linux + android-arm64.
- Honest limits (documented in the rig header): the Android DNS conviction is
  by-construction (netx is the proven Android path the working providers ride;
  live Android proof needs the user's device — the tunnel was down this session);
  device-offline infinite mode is covered by the v1400 battery.

### v1.45.6 THE SHIP
- buildinfo 1.45.0 + README/OTA/SECURITY notes + the worklog record chain +
  tag v1.45.0-the-honest-pm.

## The will-NOT boundary
- No hand-rolled attestation verifier (V5 — the license wall is permanent; AGPL
  after the change date). The wasm stays the optional, on-demand verifier.
- No change to the device-offline patient engine (the user's law, v1.39.3).
- No per-provider UI special-casing: the honest net mode applies to every
  provider equally — PM "works like the rest" because the rest get the same
  honesty.
- No new pills, no new surfaces — the ActivityPill is a refactor of the ONE
  existing activity row into per-chat objects.
