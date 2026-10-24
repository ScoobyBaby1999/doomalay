# v1.63.0 THE SIX FIXES SHIP (PLAN-V163) — the user's six-list, all live-proven

- The ask (verbatim): (1) the walled-tier message becomes dynamic ("Opencode required you to setup Termux and install Opencode, setup termux by expanding the chat metadata -> Capabilities -> Termux. Install Opencode through the cloud provider menu, press the '+ install opencode' pill" — "we have it display either the first or second depending on what is installed and what is not, aswell as the download size, model, and the termux/opencode is installed dynamic messages"); (2) the model catalogue grows a cloud icon left of the ★ star, same size, opening the cloud provider screen — Android back pops to the catalogue, not the canvas; (3) after the checking pill, "keep that pill and not have it dissapear, and change it's text to opencode requires API key + termux setup + opencode install"; (4) the termux ladder's step 2 pill says "Open Termux (redirect icon) then hold and Paste", the auto-copy description dies, the paste under "Bootstrap once" rides primary/theme color, step 3 names "Additional Permissions and allow Run commands in Termux environment, optionally disable Manage app if unused"; (5) the "+ setup termux" pill "doesn't dynamically update to 'termux setup' once termux is setup"; (6) "the cell size for the canvas is too small… each cell should increase the size by ~x10… a countable number of cells and very few grids. Spatial loading can load one or few cells at a time, and one grid. And the stars and lines within the grid can load similarly, only when in the cameras viewport."
- v1.63.1 THE HONEST PILL (asks 3+5): THE ALWAYS-TRUTH LADDER (ocbridgeapi.go — the termux gates evaluate FIRST; walled no longer masks termux_installed/termux_ready) + THE REQUIREMENTS PILL (providerPills: "opencode requires " + the missing pieces — API key + termux setup + opencode install (one-time ~size_hint) — never empty, never disappearing; walled joins the termux action states) + THE THREE PILL CONVICTIONS: THE RACE (the µs-fast /api/opencode/bridge lands before the models/keys Promise.all opens the panel — the old `if (!opened) return` swallowed ocBridgeStartPoll forever, the pills froze), THE STACK NUKE (the poll's render() swapped contentEl.innerHTML unconditionally — a tick while TermuxSetup was stacked REPLACED the setup page), THE STALE POP (popPage restored the open-time html snapshot — the pre-setup pills). Fixed: the arm retries until open (THE LIVE CONVICTION: the callback's first arg is the fetch RESULT — the first draft's armPoll(tries) read the object as the counter and never retried; the counter lives outside), #prov-root marks our page (render() swaps only when the marker is present), popPage's onPop hook (connectoverlay.js — the restored page re-renders FRESH).
- v1.63.2 THE DYNAMIC WALL (ask 1): llm/ocpocket.go (OcPocketState + the OcPocketProbe hook var — no import cycle: the server arms it in New() with the termux status + the manager peek + the install flag + ocserve.AndroidZipSizeHint) + ocWalledAndroidMessage (chat.go): the SETUP PATH (nothing installed — the user's variant near-verbatim), the INSTALLED-TERMUX MIDPOINT ("Termux is installed — finish its setup"), the INSTALL PATH ("Termux is set up ✓ — one step left"), the HONEST WAIT (installing), the LIVE BRIDGE (up), each carrying the model ("big-pickle is one of them") + the live size; friendlyHTTPErrorFor carries req.Model (the 3-arg legacy shape kept for the pinned tests). Pins: TestV1632_WalledMessageLadder (7 shapes).
- v1.63.3 THE CLOUD GATE (ask 2): modelbrowser.js — the cloud glyph left of the ★ tab (the tab's own size, a hairline divider separating the action from the tabs) → ProvidersScreen.open(null, {usePushPage:true}) → pushPage (a REAL stack level) → handleBack → backOne → popPage → THE CATALOGUE (never the canvas). providers.js render() gained the usePushPage branch; the browser gained its own stack guard (#mb-wrap) + onPop fresh render (a catalog sync landing mid-stack can never swap the providers page away).
- v1.63.4 THE SETUP COPY (ask 4): "Open Termux ⌘" → "Open Termux ↗ then hold and Paste"; the auto-copy hint DEAD (markup + the .tsx-hint style — the tap's toast still confirms the copy); the paste phrase under "Bootstrap once" rides var(--accent); step ③ names the real screens. v1173 113/113 green with the new copy.
- v1.63.5 THE BIG CELLS (ask 6): THE CELL LAW (GRID_BASE 48 → 480, app.js's twin re-synced; the world = 34.1 cells/axis, 1,165 total) + RENDERCELLS — THE LIVE SPATIAL PATH (the battle-tested walk promoted with three cells-mode deltas: the TRUE far-field ramp at the bucket flushes, the A/B PARITY BREATH at flush (one batched fill per color×parity — the tiled path's own shimmer), the renderTiled-shaped stats + oneObject{mode:'cells'} + the modulation field (MOD_P_CELLS 320 → 32 big cells = the same 15,360px period)) — per-visible-cell LAZY records, batched quantized fills at device resolution, SHARP BY CONSTRUCTION (the periodic-tile Rref law collapses to 0.28–0.4 at ×10 cells; the live walk paints at DPR). THE PITCH LAW (the movers conviction: the twinkler density is the screen's 48px field — the ×10 cells thinned them ×10 live: 18 candidates, painted 0). THE HATCH RIDE (__doomalayLatticeTiled reaches the WORKER through the frame message). THE RE-PINS: v1620 §3 (the cells law + the tile machinery through the hatch — pair [4,6] jointCells 12 = EXACTLY the old 5,760px period, the "like 8 grids" law SURVIVES: 8.09; the floor = THE COUNTABLE GRID IS THE MAP VIEW — the sea never fades at 11.4px floor spacing), the v1620 walk (the neutral VLM verdict: "geometrically regular and aligned, no rendering defects, 8/10 clean, precise"), v1570's floor re-anchor.
- THE PROOF: scripts/v1630-six-fixes-rig.mjs 41/41 (§A the six laws in the source; §B the cloud gate live — the glyph left of the ★ at the tab's size, press → depth 2, ONE back → the catalogue; §C the always-on poll + the always pill live — the fetch-count ≥2/12s, the stack guard surviving 6s of ticks under the stacked setup page, the onPop fresh render; §E zero page errors) + THE BATTERY: v1620 55/55 + walk 9/9, v1570 46/46, v1173 113/113, v1422 26/26, v1310 58/58, v1424 46/46, v1350 62/62, v1400 51+58, v1428 48/48, v1590-serve-memory 18/18 (real 2.1.2 + real key), v1204 38/38, v1363 22/22, v1175-redteam 155/155, go ALL + vet + linux 55,356,185B + android-arm64 55,483,912B cross-compiles. THE PRE-EXISTING (byte-identical to origin/main, recorded, untouched): the v1590 census (63>6), v1391 1/10, v1040 A5+B1, v1423's lopsided clamp pin, v1380's pixi perf set (10), v1421 phaseA (env).

# v1.61.0 THE PATIENT HAND SHIP (PLAN-V161) — the hiccup-proof toolchain + the auto-retry sentinel

- The ask (verbatim): "Whenever a turn gets dropped due to network or another thing that requires the user to press continue. What we can do is start a time timer that probes the user for the connection or whatever started the hindrance. The timer can be customisable, default to like 5-10 mins per signal… every chat that gets interrupted for the same reason can join and listen to the appropriate dynamic timer. When the signal triggers (429 works, network is back) auto-continuation occurs (user doesn't have to tap continue) and the dynamic timer is killed, all listeners have their convo continue. Each probe we log in the chat… a pill or something is created or used to display retried x time. And the seconds or minutes left until next retry, if it works, the pill completes… and shows continued after X retries. Z:Y hours/minutes elapsed." + "I've attached 2 chat mds, one is a free bad model and the other a fromtier-ish model. The fromtier-ish model had a few hiccups, but the bad one had a lot. Why is that? How can we reduce this down to a near 0. Everytime they hiccup, instead of retrying, they try and make it simpler. We cannot have that… the model should never, ever, feel like it's restricted by our chatbot sandbox… We cannot have tool hiccups, we should permit just about any tool call… for everything the model tried now and failed, we should patch, nothing like this should ever happen… even the worst models should execute the best tools seamlessly, and should never downgrade the execution or simplify it."
- THE DIAGNOSIS (the two exports, every event named): kenny (openrouter/free — 5 termux arg hiccups + 2 parked turns + 3 forge transients + 1 DNS fetch) vs trippy (nvidia frontier-ish — 6 workspace drifts + 2 seam-exhausted mid-stream aborts). Both models emit the SAME mistake classes; the frontier model recovers in one retry, the free one SPIRALS ("Let me try a simpler approach" — kenny's own thinking, 4x; trippy abandoned an investigation after two arg errors) — the mistakes are cheap to repair mechanically, THE DERAILMENT is the cost. The law: the engine repairs what it can, retries what it can, and only speaks when it truly cannot — and when it speaks, the message FORBIDS simplification.
- v1.61.1 THE REPAIR HAND: argrepair.go — TagsToJSON (the legacy tag grammar hexdumped byte-exact from the kenny export: the ASCII pair spelled \u003c/arg_key\u003e\u003carg_value\u003e, 4x, always before an object value — mechanical JSON punctuation), SplitTaggedAction (the action field glued to its payload — kenny's "unknown termux action" death), RepairJSONQuotes (the early-close-quote reopen + THE QUOTE DEBT: the model's closing quote was BOTH the JSON close AND the -c argument's content — the close ate it and bash died on the unbalanced command; a reopened string with an odd quote count repays one into the value; the walk SUBSUMES the old repairJSON), UnwrapArgsEnvelope (the recursive args wrapping), THE TRUE CUT VERDICT (truncation judged on the REOPENED text — the naive walk misjudges early-close shapes; the pin convicted it), RetrySameCallDirective (the anti-simplification law on every verdict); the wiring at ALL THREE layers (the nativetools outer gate's tags+quotes rungs; the termux nested-args merge where all 5 kenny deaths landed + the action split + the command->exec inference; the workspacetool wrapper); THE ARG-INFERENCE ENGINE (kenny's path-as-ws longest-prefix split, trippy's read-continue per-session last-read map x4, the grep pattern/q/search aliases); THE LANDMINES (verbNeedsWS += patch/commit/sync/tag_create — the nil-deref PANICS the audit caught; wsArgInt <=100000 — the >=500->UNLIMITED inversion); THE SCHEMA TRUTH (the workspace Def teaches ALL 30 verbs + ~16 missing props; termux += patch; the args prop teaches both spellings); the 20 needs-texts + the gate faults carry the directive; the cut-fault text no longer teaches "split the work into smaller calls".
- v1.61.2 THE PATIENT WIRE: netx.IsTransient (the class set lifted from llm — ONE truth; the pin's live conviction: bare ": EOF" was missing — a connection slam surfaced as bare EOF; trippy's live conviction: "software caused connection abort" was missing entirely — the seam parked on the FIRST abort) + netx.RetryDo (the per-attempt request builder dodging the GetBody trap; transient+5xx only, validation 4xx never; the honest "(retried Nx)" counting the attempts MADE); the forge doAccept 3x 1s/3s; WebFetch 2x; ghLoginFor off the raw http.DefaultClient (the Android DNS fix never applied there) onto netx.Transport + retry.
- v1.61.3 THE RETRY SENTINEL: the park sites wrap RetryableError (the provider-hold expiry verdict — kenny's "Tap Continue" x2; the 429/503 ladder exhaustion with the provider's own Retry-After header captured + clamping the first probe; the seam-exhausted abort); ChatChunk carries RetryClass/RetryProvider/RetryAfterMS; retrysentinel.go — ONE shared dynamic timer per class|provider, chats JOIN the listener list, the cheap probes (the provider /models via the SAME DOOMALAY_BASE_URL_* override the turns ride — the rig's live conviction: the probe hit the REAL api while the turns rode the fake, an instant false recovery; the WakeNet broadcast short-circuit; the opencode bridge health for the free-limit with the auto-continue as the real quota test), THE RECOVERY FAN-OUT (every listener auto-continues through continueCore — the extraction of handleContinueTurn's engine, same lock contract/masking/nudge laws verbatim, nil-sender safe; staggered 1.5s; a busy chat re-listens with the honest busy pill), the manual send/tap/delete disarm (the last listener out kills the timer — "the dynamic timer is killed"), the kv durability rows + the boot re-arm with the attempt counts preserved, the config row + env rig knobs, GET/PUT /api/retry-sentinel; ocServeFailEvents arms the opencode free-limit class; auth/quota/modelgone NEVER arm — the tap stays the only way for those.
- v1.61.4 THE RETRY PILL: the PWA merges the persisted retry rows into ONE live pill (armed/probe/busy update in place, recovered closes) — chatpanel's handleEvent branch + the renderer + the 1s countdown ticker (tabular nums, the user's "seconds or minutes left until next retry"); THE THEME LAW (var(--warn) live / var(--ok) recovered, rgba(var(--*-rgb),a) surfaces — ZERO literals; the rig law: spin at 2.4s on the live tone); the emit's "retry" wire case (the frames carried NOTHING before the rig convicted it — the fields now lift top-level exactly like the error payload); the ✦ Auto-retry section (GLOBAL, all chats: the toggle + the 3 per-signal steppers, minutes 1-15, default 5); the export shows EVERY probe forever (md "> ↻", txt "[retry]", html — the plan's law: the export is ground truth).
- THE RIG (scripts/v1610-patient-hand-rig.mjs) — 17/17 LIVE on the real binary + the real WS + the fake provider + the fake bridge: LEG 1 the full arc (a real 429 parks a real turn; the sentinel arms with the 2s Retry-After clamp; the probe pills pace on the WS exactly as the PWA sees them; the recovered pill carries attempts 3 + the honest elapsed; the conversation CONTINUES ITSELF — the assistant text lands, NO tap); LEG 2 the shared timer (chat A parks + arms, chat B parks on the SAME signal + JOINS, BOTH recover on the ONE timer — the Go pin TestV1613_JoinAndFanout inspects the registry len==1 — and both replies land); LEG 3 the unfumble (kenny's byte-exact tagged call through the REAL /mcp route + the REAL bridge — the call EXECUTES, the observation carries the teach head; the device workspace armed via POST /api/workspaces/device + the rig-only DOOMALAY_TERMUX_EXTRA_ROOT knob). The rig's live convictions, all fixed: the emit retry case missing; the probe-base override gap; the count-based fake windows breaking under the interleaved auto-continues (the rig-controlled release law); the first-turn catalog sync eating the fake's 429 budget.
- The pins: 8 llm repair pins (the byte-exact kenny shapes through the chain; the quote-debt command intact; the truncation refusal) + 13 server repair/sentinel pins (kenny's 4 fatal shapes EXECUTE end-to-end on the executing fake bridge with the teach head; the truncation never touches the bridge; trippy's drifts execute with inference teaches; the panic regression; the sentinel's arm/probe/pace/disarm, the join+fanout, the Retry-After clamp, the boot re-arm with preserved attempts, the parked-tail-only law, the elapsed grammar) + the netx classifier table (every logged string byte-exact + the never-retry negatives) + the export fold + the full engine battery green on every package + vet clean.
# v1.62.0 THE HONEST FIELD SHIP (PLAN-V162, rebased live onto the parallel wave's v1.61.4) — the canvas honesty wave: the continuous clamp + the live-centroid pinch + the proportional stride + the eight tiles + the seen-only audit

- The ask (verbatim): "Now let's go back to the canvas please. I did great but it can still be better. For starters, when zooming out the entire canvas. The zoom out is so wonky and needs complete rework, to a certain extent it's good, then when it goes really far out it starts to do some weird thing where the grid seems to go diagonally before it snaps back, zooming out very far currently is confusing, as while the camera is zooming out it seems to loose protective of the grid or the grid seems to move aswell not just the camera. Another issue is that the further the user is zoomed out the faster the camera should pan, its very frustrating when a user zooms our all the way and still moves as if he is zoomed in close, so jumping from one end of the canvas still takes like 10 seconds worth of dragging if not more when all it should take is a zoom into the correct location, the more the user is zoomed out, the faster the camera should pan and it should move the grid further for the same amount of stride. Moreso, now that we can zoom out and see the full grid, the tiling is so noticeable. Let's instead make the grid consist of less tiles, make each time around x3 larger and reduce the total quantity, then apply a rigid rotation / flip (180,90,-90,-180) to each tile so they appear to look different, we strategically make it so that no similar rotation appears either adjacent to or next to one another. So that each tile is surrounded by different rotations - the rotations don't have to be dynamic or take compute either, we can make it deterministic and negligible performance wise. The entire grid should consist of like 8 tiles give or take, so the pattern would still be visible when the grid is scattered but much less obvious. Also verify we use spatial loading, and only render and animate any stars and icons that appear on camera. When they are off screen, the frontend should not render any elements and should reserve the computer for the backend doing all the actual work without the frontend UI."
- THE NAMING COLLISION, RESOLVED HONESTLY: the parallel bot shipped v1.61.x (THE REPAIR HAND / THE PATIENT WIRE / THE RETRY SENTINEL / THE RETRY PILL) mid-wave — my wave renumbered V161→V162 (the plan file, the sub-wave labels, the in-code comments) before pushing; the ship takes 1.62.0 past buildinfo 1.60.0 (the parallel wave's pending ship renumbers past it at their ship time — the standing law).
- v1.62.1 THE CONTINUOUS CLAMP (app.js): the old clampCamera law ±(half−vw/2) on the TOP-LEFT kept half a viewport of margin on the top/left while ALLOWING half a viewport of overrun past the bottom/right — and at the vw=WORLD_SIZE crossing it collapsed to ±0 while the degenerate branch demanded −vw/2=−half: an 8,192-world-unit HALF-SCREEN LURCH in ONE frame, twice per deep zoom-out on a phone (Y crosses at scale≈0.0515, X at the 0.0238 fit-all floor) — the user's "the grid seems to go diagonally before it snaps back"; mid-range the shrinking range dragged the camera in — the "the grid seems to move as well not just the camera". THE FIX is the canonical contain law every reference library uses (the research agent's sourced digest: xyflow getViewportForBounds / tldraw zoomToBounds / excalidraw centerScrollOn / pixi-viewport Clamp underflow-center): offset ∈ [−half, half−vw], the degenerate −vw/2 — CONTINUOUS at the crossing by construction (the edge range closes to the single point −half exactly where −vw/2 lands). PROVEN algebraically (the rig's own old-law/new-law sweep: the old lurches ≥4,000 units in one step — node-verified 8,199 — the new tracks ≤150 ≈<8px on screen) and LIVE (the setView sweep's max per-step delta <150 world units, was an 8,192 one-frame lurch; the crossing straddle ±0.3% = 74 units ≈3.8px, was ~8,200 ≈422px; a violent setView pins EXACTLY half−vw; at the floor the whole world fits both axes, the deep axis degenerate-centered −vh/2; a real drag cannot push past the edge — stops at half−vw ±1). The finger now reaches the EXACT world edge (the lopsided margin gone).
- v1.62.1 THE LIVE-CENTROID PINCH (app.js): the old code anchored the zoom at the centroid captured ONCE at gesture start and never followed its drift — the centroid's pan component was silently dropped (the content slipped under the fingers). THE FIX is pixi-viewport Pinch's own law: recompute the anchor at the LIVE centroid every move — the world point under the live centroid (given the START camera, so each event is idempotent) lands at the live centroid under the new scale: the zoom anchors exactly AND the centroid's drift pans 1:1. pinchCenter RETIRED.
- v1.62.2 THE PROPORTIONAL STRIDE (app.js): the PANNING branch added RAW SCREEN PIXELS to a WORLD-UNIT offset (offsetX += ddx) — 1:1 only at scale 1; at the 0.024 fit-all floor a 100px stride moved 2.4px of screen content and crossing the 16,384 world took ~10s of dragging (the user's "still moves as if he is zoomed in close"). THE FIX is the standard every map/canvas app uses (pixi Drag / Leaflet Map.Drag): ddx = −dx/scale — the content tracks the finger 1:1 at ANY zoom. LIVE with the real finger: 100px = 100 world @1.0 / 200 @0.5 / 800 @0.125 / 2,000 @0.05 — the EXACT 1/scale law; one 300px stride at 0.05 covers ≥30% of the whole world; the momentum cap rides the SCREEN law (MAX_PAN_VELOCITY/scale — the same 18px/16ms on-screen speed feel at every zoom). The ICON_DRAG twin (always dx/scale) unchanged.
- v1.62.3 THE EIGHT TILES (lattice.js): TL_PAIRS[0] 10×16 → 10×24 — the joint period lcm 80 → 120 cells = 5,760px: the whole 16,384 world at the map view now consists of 16,384/5,760 = 2.84² ≈ 8 TILE PERIODS (the user's "like 8 tiles give or take"), each 2.25× the AREA (the honest x3-reconciliation, PLAN-V162 §2: 3× LINEAR would leave ~2 tiles across the whole world, contradicting the 8-tile ask — recorded for the user). tlFillInstances — the per-instance paint replacing the single pattern fill: rot = (i+2j) mod 4 over the ABSOLUTE instance grid (the Latin-square law — Wang-tile de-tiling; (i+j) mod 4 FAILS the anti-diagonal, (i+2j) mod 4 puts ALL 8 neighbors ±1/±2/±3 off center — never equal) + the checkerboard mirror flip ((i+j) mod 2 — the "flip" of the user's "rotation / flip"); the user's list "(180, 90, −90, −180)" carries the −180≡180 redundancy — the four DISTINCT rigid classes are 0/90/180/270, recorded honestly; rotation about each instance's CENTER (corners map to corners — the square still tiles its neighbors seamlessly; only the INTERNAL star arrangement rotates); world-anchored + DETERMINISTIC (a world square keeps its transform forever — pan/zoom never re-rolls it; ~4 bit-ops per instance, the user's "negligible performance wise"); the >2,048-instance sub-pixel ceiling falls back to the plain pattern fill (the twinkler-walk guard's own shape — UNREACHABLE in the real regime, defense in depth: the far-field fade kills the sea before instances can explode — rig-proven 0 fallbacks across the whole sweep); tlPickPair's readability gate 0.75 → 0.70 (the widened rung's worst case Rref 0.734 keeps [10,24] winning in EVERY config — the 3% softening is imperceptible next to the level ladder's own 0.89–1.12 stretch window). THE EFFECTIVE joint period with rotations lands at 480 cells = 23,040px — BEYOND the whole world: no two visible tiles repeat. LIVE: pair [10,24] / jointCells 120 / instDraws 60 (the tidy default) & 4,420 (the living-sky config, 19 tiles) / fallbacks 0 / the ladder stable (zero re-bakes through the whole zoom-out); the VLM verdicts at the varied config: "Varied/Natural, random and organic, no two regions exact copies, no glitches" (the tidy default stays the uniform grid — rotation is invisible on a uniform lattice, honestly noted: the de-tiling reads exactly where the user SEES tiling — their device's variation config); the map view intact (farK→0, the sea gone, the edges visible, VLM clean); at 0.125 the sea is byte-identical (farK 1, full dots).
- v1.62.4 THE SEEN ONLY: the spatial-loading audit — every layer ALREADY the law (this wave VERIFIES + PINS, zero rebuild): off-view icons display:none (v1.42.2 THE FIELD) + the RIDE's zero at-rest icon writes (v1.57.2 — the census now position-snapshot-classified: p2's residual drift decays under any velocity threshold, so the classifier compares POSITIONS); atoms pad-cull per element (atoms.js); twinklers viewport-walk + the 16,384-cell hard ceiling (lattice.js); comets spawn on-screen + cull ±250; the lattice fills cover the viewport only; the worker owns the paint (the main thread reserved for the app + the backend — the user's "reserve the computer for the backend doing all the actual work"); the physics honest note: off-screen settling is O(N) arithmetic with ZERO DOM writes — the cull law is the RENDER's.
- THE REBASES (the standing law, three rounds): the parallel wave pushed v1.61.1/.2 mid-build (my wave renumbered V161→V162 first), then v1.61.3/.4 at ship time — all fast-forward clean, zero conflicts (their files: ocserve/chatpanel/providers; mine: app.js/lattice.js). THE RE-ANCHORS their waves forced: the v1590 rig's binding pin (their bound→persisted rename — re-pinned to the semantic, 46/46) + the v1570 walk's edge bound (my own law change — half−vw/2 → the CANONICAL half−vw, 16/16).
- PROOF: scripts/v1620-honest-field-rig.mjs 52/52 + scripts/v1620-honest-field-walk.mjs 9/9 (the REAL CDP two-finger pinch with a built-in +110/+90 centroid drift: NO snap on the way down (worst on-screen step 37.7px < 45px, ≤3× the median 33.7px), landed AT the floor ±0.5%, the whole world visible, the sea GONE at the map view; the real touch-drag 100px @0.05 ≈ 2,000 world units; the VLM tiling verdict). The rig's honest lessons: agent-browser's default viewport is 1280×577 (the rig must SET the phone class — at 1280 the 0.05 regime is degenerate on X, a DIFFERENT law); the CLI's cold start can exceed the app's 500ms long-press window (the menu opens + eats the gesture — the dispatched-event drag with retries); the walk's worst-step bound must ride ON-SCREEN px + a ≤3×-median spike detector (the world-unit bound reads false at the deepest zoom where everything's lever arm is 1/s²); the VLM pin's negative clauses must not match inside the VLM's own negations ("does NOT look like an obviously repeating wallpaper").
- Battery on the ship tree: go 18/18 + vet clean · v1570 46+16 (re-anchored) · v1590 46 (re-anchored) · v1421 24 · v1422 26 · v1424 46 · v1428 48 · v1350 62 · v1400 ×2 51+51 · the source-pin PASS (the census re-anchored) + v1391 10/10 · discipline 7+B1 (the pre-existing trio byte-identical to origin/main — this wave adds ZERO appenders; the rig's §5 pins no createElement in the new code) · linux 55,069,021B + android-arm64 55,462,439B cross-compiles.

# v1.60.0 THE MIRROR TONGUE SHIP (PLAN-V158, rebased live onto v1.59.0) — the opencode 1:1-native-parity wave: the informative pill + the open hands + the wide shelf + the steady pills

- The ask (verbatim): "OPENCODE WORKS! … our goal is to have opencode run natively like all other providers … mimic the native providers as 1:1 as we can get it, especially when it comes to its continuity and ability to hold turns without interruptions and its tool use capabilities (every tool and capability our native chat has, tools should also not return truncated or incomplete or broken or data with silent drops) … opencode tools show opencode:grep … and then a running description. This is Terrible, can't we have it show the same descriptions every other provider does … try reusing the one we have or inherit or something, keep Object Oriented practices. And make sure to test your results, grep should return regular hits, not be broken." + (this turn) "Since we are using actual opencode via termux let's also add to all our default tools the tools that come with opencode (explore, edit, ext) so the opencode model may pick and choose from a wider variety, use our apps native tools and it's own native tools via opencode termux. All tools should reflect from the simple placeholder we have using our persona system as it currently does."
- v1.60.1 THE INFORMATIVE PILL: ocToolSummary (ocservetools.go) — the verb+operand table (read→path-tail, glob/grep→pattern, edit/write→path-tail, patch→the first touched file, shell→command first line, websearch→query, webfetch→url, skill→id, execute→code first line, subagent→description, session_move→directory, the derived fallback for MCP/plugin/unknown tools — NEVER static); emitToolUse sends the BARE name + the derived summary so the PWA's toolPillLabelParts else-branch renders opencode pills byte-identically to native (the OOP reuse — zero new pill code); THE UNBOUNDED RESULT (clampServer 6000 DEAD → ClampMarked + ocObsBudget, the window-physics law inherited verbatim; metadata.truncated → the honest tail line); session.tool.progress → tool_stream pings (ocProgressLine — the serve's OWN statuses, never invented); session.tool.called as the no-duplicate belt (structured input marshaled when input.ended never rode); the id-first pairing on use+result+stream (chatpanel.js mergeToolResult + the stream matcher — parallel same-name calls never mis-merge); the forwardEvents tool_use_id passthrough (live + persisted paths).
- v1.60.2 THE OPEN HANDS + THE WIDE SHELF: the permission config becomes the V2 rules array (question deny — the headless honesty; the doomalay_* belt; the *.env/*.env.* secrets denies; the tavily websearch selection) — everything else rides the agent's own allow-all base policy (the v157 live proof: open hands pass the free gate); THE WIDE SHELF — the app's 31 tools ride the serve as a per-chat MCP server: ocServeChatDir writes <scratch>/chats/<chat-id>/{opencode.json,ws/} (the doomalay MCP entry: url /mcp/oc/<chat-id>, codemode:false = DIRECT bare-named tools, oauth:false, headers belt, generous timeouts) and Manager.MoveSession/CreateSessionInDir (POST /api/session/{id}/move — LIVE-PROBED) moves each serve session into its own dir (concurrency-safe by construction); the engine mounts /mcp/oc/{chatID} (a request-clone wrapper injecting X-Doomalay-Session — the same resolution path, zero new resolution code); sessionMcpTurn gains Fleet + Djournal (the live-probe conviction: "the fleet tool needs a live session on this server" WITH the header riding — the /mcp path never had the v1.47 arms); the {tools} MIRROR block (placeholderBlocks' sixth key — the persona system's OWN machinery) built LIVE from mcpbus.Defs() (bound: both shelves + the never-ACTION note; unbound: the honest native-only note; native: "" collapsed — zero native-prompt change), the serve-mode compose (systemPromptForMetricsMode) + the blocks preview honesty; WriteServeFile/ServeDir (the desktop fs + the termux jailed cat > — platform-aware, escape-refusing); ViaTermux + THE TERMUX AUTO-ENABLE (a pocket-bridge chat self-heals sess.Termux + the progress line); THE DYNAMIC PROGRESS ("Connecting to OpenCode…" + "OpenCode: <model> is thinking…" — the static "turn in flight" DEAD).
- v1.60.3 THE STEADY PILLS (providers.js): THE ALWAYS LAW — providerPills never answers [] for opencode (the checking pill renders from the FIRST paint); the full 3-state ladder (not-setup action / setting-up live with real bytes / setup dim) + the walled/unconfigured honest gates; THE ALWAYS-ON POLL (self-scheduling: 2s installing / 5s rest; single-flight + aborting + the ConnectOverlay-visibility guard — no leak after close); a fetch hiccup keeps the last truth (finish(null) never clears ocBridgeLatest).
- THE LIVE RESEARCH (v158-research, BEFORE the build — the standing law; the MITM-captured dance): the 2.1.2 serve attaches remote MCP servers (initialize 2025-11-25 → notifications/initialized → the GET stream → tools/list), the engine's /mcp answers healthy (tools/list 31 + tools/call calculator 17*23="391" through curl), the custom headers RIDE, tools/call carries _meta.ai.opencode/sessionID (the serve session — a third binding channel), per-directory configs attach per-session (the move vehicle), MCP tools ride Code Mode as tools.<server>.<tool> by default (codemode:false = DIRECT — the pill law), the direct calls pass the default allow-all headless, the Code Mode metadata shapes captured verbatim (toolCalls[].tool/status/input + success.error/truncated). CONTAMINATION CONVICTED: the first probe's "doomalay-tools sighting" was the model reading the engine's mcpbus source mid-turn (391 via execute + the chat title via a sqlite dump) — the rig now ties every pin to the tool's own frames.
- THE REBASE (the user's discipline — parallel agents pushing): v1.59.0 (THE HONEST RETURN: the serve memory binding persistence + the no-hang guard + the bottom-load + the ghost) landed mid-wave — resolved by hand (ocserve.go: both method sets; ocserveturn.go: their binding persistence + adoption MERGED with the per-chat config binding — a fresh session is born IN its config dir then the binding persists; an adopted session re-confirms the config dir; the pump keeps BOTH the model param (the budget law) and turnStartedAt (their guard); the fakeServe gains both route sets) — the WHOLE suite green on the merged tree, the rig re-proven 16/16 after.
- PROOF: 15 new Go pins (TestV1582 ×8: the per-chat config bytes, the toolsBlock laws, the serve compose, the /mcp/oc route + the binding proof (fleet names the chat), the sessionMcpTurn arms, the binding loop + the graceful degradation, the write/serve-dir laws, the opening-text laws; TestV1581 ×8: the summary table, the progress line, the budget laws, the informative-pill pump, the unbounded result, the serve-truncated verdict, the called belt, the parallel same-name id pairing; the open-hands config pin re-written for the V2 grammar) + the v1580 rig LIVE on the real 2.1.2 + the real key: 16/16 machinery pins PASS (the open-hands config bytes on disk; the per-chat binding config pointing at /mcp/oc/<chat>; THE MCP DANCE through the per-chat route — the initialize + tools/list POSTs in the engine log; the chatless 404; the never-prefix + never-static laws; the dynamic progress lines captured LIVE on the websocket exactly as the PWA sees them) — the model-dependent pins (the calculator pill, the fleet binding, the open-hands file tools, the >6000-char whole result, the merged catalog, the ledger, the continuity) rotate the LIVE catalog candidates with the honest-refusal law; the account's free-quota windows (burned by the day's extensive live probing — OpenCode's own ~11h rolling clock, every candidate answers "Free usage limit reached") hold them as HONEST-SKIP, re-runnable the moment a window rolls. The live-convicted rig bugs along the way: the SSE-frame newline law (a raw newline splits the event — the frames must be marshaled), the reused-unmarshal append trap, the events' flat wire shape, the ephemeral progress law (v0.23: live-WS only — the rig reads the frames LIVE), the WS replay boundary (ws_state replay_done — the reader must not break on replayed terminals), the catalog-wait law (the serve gate reads the LIVE registry — a cold catalog falls to the direct wall), the bridge-wait law (the first turn must never race the spawn).
- Battery on the ship tree: go ALL packages GREEN + vet clean · the full server suite (the v1.47/v1.13/v1.27/v1.58 pins together) · node --check on the touched PWA files · the v1580 rig 16/16 machinery pins LIVE · linux + android-arm64 cross-compiles.

# v1.55.0 THE LIVING PILL SHIP (PLAN-V155) — the user's five opencode-patch convictions, all fixed + live-proven: the honest ladder, the row of pills, the living catalog, the live effort, the live proof

- The ask (verbatim): "couple of things I noticed regarding the opencode patch from two turns ago that needs patching" — (1) the opencode row below PrivateMode and NVIDIA, no "addition box tooltip thing", Get API key → the console service-accounts deep link ("the org_xyz replaced by the users own workspace or whatever it is opencode does"); (2) pills across the whole cloud provider screen, left→right beside the link, generic for any provider; (3) the screen KEEPS WORKING during install + the pill goes "+ installing opencode.." in a different theme color, pinging the download (never static) with failed/retry carrying a checkpoint; (4) installed → the pill goes away or says "opencode setup"/"termux setup" dim; (5) "opencode zen returns no models — This must be fixed… For each finding from each provided, use it to integrate into our app… Just aslong as we have no static lists, not even fallback, we must derive all our cloud models dynamically."
- v1.55.1 THE HONEST LADDER (engine): THE NO-LONG-HOLD LAW — ocServeMu now guards only the manager POINTER (microsecond windows); every SLOW thing (provisioning, download, spawn, boot) runs under the new ocServeStartMu, so the 20-min install can never block GET /api/opencode/bridge, /api/models, or /api/keys — the v155-A audit convicted the old all-hold: every bridge GET queued behind the install until the WebView's 6-slot pool starved and the screen rendered "No providers"; THE LIVE PROGRESS (InstallProgress: stage deps|download|verify|unpack|configure|boot|installed + bytes/total; the dl.bytes sidecar poll every 2s — the pill pings REAL byte counts); THE CHECKPOINT LAW (the resumable curl); the bridge status answers installing with stage+bytes+total+percent (clamped 1..99)+attempt; the PWA poll never stacks (AbortController + single-flight).
- v1.55.2 THE ROW OF PILLS (web): THE ORDER LAW (FREE_ORDER + smartConnect PRIORITY: privatemodeai → nvidia → opencode); THE SAME-ROW LAW (the pocket-bridge state box GONE — the opencode card renders byte-identical to every provider; providerPills is a GENERIC left→right mechanism beside the Get API key link, opencode the first consumer); THE PILL LADDER ('+ install opencode' action · installing → 'installing opencode N%' on --accent-2 with the oc-pill-pulse breath (prefers-reduced-motion frozen) · install_failed → 'failed, retry' on --err-rgb with the honest last_error dim line, the retry resumes from the byte checkpoint · up/desktop → dim '✓ opencode setup' · gates → '+ setup termux' handing off to the existing TermuxSetup overlay · installed termux → dim '✓ termux setup'); THE SERVICE-ACCOUNTS LAW (the org-less https://opencode.ai/console/settings/service-accounts deep link, live-probed 200).
- v1.55.3 THE LIVING CATALOG (engine): models.dev fetched LIVE (OpenCode's own org's registry — "We also use it internally in opencode"; ETag/If-None-Match 304, disk-cached under DataDir for cold boots, 25s one-shot, 60s failure backoff, single-flight) REPLACES the build-time snapshot (modelsdev_snapshot.json.gz + the embed + the generator DELETED); every cloud model list derives dynamically (the user's law): the zen list keyed-first with the keyless belt (the list is documented public), the deprecated drop via the registry's OWN status field, free/paid from the live cost fields (the -free name lie loses to the live price), the healthy serve bridge's own GET /api/model catalogue merges in as the device-local truth (union + dedupe); THE NEGATIVE-CACHE LAW (a build whose provider groups errored is NEVER cached fresh — the next /api/models retries within a 60s backoff; a poisoned-empty group can never sit for the 10-minute TTL; the PWA's poisoned-cache law matches — the user's device sat on "no models" across restarts because a failed sync landed in localStorage); hf joins the ENGINE catalog (providers.json + the router list fetcher); THE BRAIN PROXY DIES (/api/models ALWAYS answers the engine's own Go catalog — desktop and Android byte-identical).
- v1.55.4 THE LIVE EFFORT (engine): models.dev's OWN reasoning_options is the per-model effort SOURCE (the exact documented ladders gpt-5.5 none→xhigh, minimax low→max; toggles kimi on/off; budget-token dials Claude — mandatory derived from the data: a ladder with no none/off rung = mandatory); the static blankets + pmFamilyEffort + the curated reasoning_catalog.json DIE for cloud models; THE VARIANT LAW (the chat's effort knob reaches the 2.x serve through the model's OWN variant ladder, fetched LIVE from the healthy serve's /api/model — a matching reasoningEffort rides SelectModel as the docs' '#variant' grammar); THE FREE DISPATCH reads the registry's cost-0/0 law (the big-pickle/-free literals DEAD); THE LIVE-PROBE LAW (the ProbeModel field + every providers.json probe pin DELETED — key validation probes pick from the provider's live roster, free first); THE LIVE LEDGER (the curated priceRules + ctxRules tables DEAD — prices/context from the live registry, unknown = honestly unpriced, the 65536 ctx floor).
- v1.55.5 THE LIVE PROOF (scripts/v1550-living-pill-rig.py, run LIVE with the user's real keys): DESKTOP 23/23 — the real-user key flow (the PWA's exact POST /api/keys × 5 providers); THE CATALOG TRUTH (opencode zen 46 models keyed — the convicted "no models" bug dead; big-pickle enriched from models.dev's own truth: free + 200k ctx + the metadata-poor honesty of a reasoning model with no reasoning_options; gpt-5.5's ladder VERBATIM ['none','low','medium','high','xhigh']; free laddered candidates beam-free/nemotron/longcat); every provider group non-empty live (openrouter 439 · nvidia 75 · mistral 44 · privatemodeai 9 · hf 138 · total 751); THE NEGATIVE-CACHE LAW live (the dead-zen error never caches fresh; the degraded read 9ms; ?refresh=1 bypasses + re-attempts 661ms; the other groups intact). ANDROID-CHAIN 27/27 — THE STARVATION TEST (through a throttled 1.8MB/s one-tap install: /api/models + /api/keys answer <2.5s on EVERY poll with the full provider data — the convicted screen-death bug is dead; the pill pings the monotonic sidecar bytes, percent clamped 1..99, stage download); THE CHECKPOINT TEST (the artifact server killed mid-flight at 18% → install_failed in 10s with attempt 1 + THE HONEST last_error; the partial zip SURVIVES; the ONE-TAP retry asks 'Range: bytes=19136512-' BYTE-EXACT against the partial; the resumed install lands UP; a REAL turn answers '39' through the resumed pocket bridge, ledger total 4308 cost 0); the pill ladder's live rungs; the PWA render law (v1552 28/28 + v1554 21/21).
- THE RIG CONVICTED TWO REAL BUGS (both fixed in the same push): (1) THE TRUE CHECKPOINT LAW — curl's own --retry betrayed the v1.55.1 assumption: on a MID-BODY drop curl's retry loop RESTARTS THE WHOLE TRANSFER FROM BYTE ZERO (the -C - offset is computed once per invocation and curl truncates the partial when its retry begins — caught red-handed in the instrumented jail: the partial fell 19.9MB → 0 exactly at the first retry), so the checkpoint only ever held across SEPARATE invocations; the fix moves the retry ladder into the SHELL — every attempt is a FRESH 'curl -C -' that re-stats the partial zip and asks Range — the resume now holds at EVERY level (within an install AND across install retries), rig-pinned byte-exact + the v1491 byte-pin updated to the new law (--retry GONE); (2) THE HONEST FAILURE — ocServeManager swallowed the real Start error and the install route answered "the bridge could not start (no data dir or key)" for a dead download; ocServeManagerErr now surfaces the truth (the route's last_error names the actual "pocket bridge: download failed: …" — the pill's honest dim line) while the nil,nil case keeps its own copy; the turn path stays byte-identical through the wrapper.
- The rig's own laws: NO model literals on its turn path (the free model is picked DYNAMICALLY from the live catalog — a real user's loop: move to the next free model when one honestly refuses); HONEST SKIP for the two upstream refusals a real user sees (the key's free-quota window "Free usage limit reached" — live-confirmed through the serve AND the direct zen probe; a geo-restricted model "not available in your country" — beam-free from this egress) with any OTHER error a hard fail; the v1510 usage_of transcription bug fixed (the ledger rides the terminal status event's top-level usage).
- THE MANUAL ANSWER: nothing — the pill system + the dynamic catalog ride the OTA + the engine upgrade; the phone keeps its same one tap. DEVICE MODE: the tunnel was DOWN at ship time (honest skip per the live-gate law) — the device red-team (the pill live on the real phone through the v1.55 version gate) runs at the next tunnel-up via the rig's --device mode.
- Battery on the ship tree: go 17/17 packages ALL GREEN + vet clean · v1552 pill pins 28/28 · v1554 zero-static pins 21/21 · the v1550 rig DESKTOP 23/23 + ANDROID-CHAIN 27/27 live · /api/health answers 1.55.0 live · linux + android-arm64 cross-compiles green.

# v1.54.0 THE LIBRARY SHIP (PLAN-V142's final phase + PLAN-V154) — hub types canvas + chat: whole worlds and single conversations as shareable bundles

- The ask (verbatim): "Now, let's finish what we originally deferred. It was called the library ship." — the deferred finale, unblocked by THE SURGEON (v1.52's surgical toolset, the user's own gate: "Not until we can have percise edits for artifacts and external and internal repos").
- THE SCOPE (PLAN-V142 §3.6 W6 REV 2): hub types `canvas` (.doomcanvas, tag doomalay-canvas, repo doomalay-canvases — the RepoSuffix field kills the double-s foot-gun) + `chat` (.doomchat, tag doomalay-chat, repo doomalay-chats) — "chats are a whole lib section themselves" (the REV 2 ask). The manager's browse row flipped live exactly as the v1.42.7 forward-wiring planned.
- v1.54.1 THE REGISTRY AND THE BIG PIPE (engine): the per-type payload caps moved to the registry ONE truth (LibrarySpec.PayloadMaxBytes: persona 64KB, theme 24MB — the old server special-case, canvas 96MB = the import ladder ceiling, chat 40MB); Item.Size rides the meta; THE MULTIPART PUBLISH (meta JSON part + raw payload bytes — no base64 inflation in the WebView, the JSON path byte-identical for every existing type); THE LFS SEED (ensureLFSAttributes: custom extensions are NOT in HF's default .gitattributes so a >10MB payload dies at the non-LFS wall — the repo's .gitattributes is seeded with *.doomcanvas/*.doomchat/*.doomtheme filter=lfs, idempotent, fixing the latent >10MB theme bug too); THE PAYLOAD-BYPASS LAW (publish/download/detail never drag big-type payloads into SQLite or JSON — meta rows only; the /downloads poison dies); THE STREAMING PAYLOAD ROUTE (GET /api/hub/{type}/payload/{repo}/{id}: gated on the downloaded row — the endorsement gate's twin — repo-matched, Content-Length verified, io.Copy proxy — the 8MB FetchFile ceiling never applies, the engine never buffers).
- v1.54.2 THE CANVAS DOOR (web): hub.js's maps + the canvas/chat dispatch (the payload streams → CanvasBundle.importBundle — the landing/switchTo/provenance already inside); the bundle card render (never a zip dump); hubpublish's blob prefill (the 📦 chip replaces the textarea) + apiMultipart (FormData — the browser streams Blob-backed parts); THE OVERLAY HOST (hubpublish/hubitem gain the ConnectOverlay-backed panel shim — a publish form opened from the manager rides the SANCTIONED overlay; the panel path stays byte-identical); the manager's ⤒ publish-to-library button (the auto-summary description from the tree+picks, the card art prefills from the canvas thumbnail) + WorldsManager.refresh.
- v1.54.3 THE CHAT DOOR (web): chatbundle.js (~490 LOC, dual-env) — the .doomchat container (manifest format 'doomalay-chat' + chats/<sid>.json + assets/*; the ladder: 8MB/entry · 40MB total · 1024 entries · 100:1 ratio · the chat-scoped whitelist (children/*.doomcanvas REJECTED — a chat is a leaf) · EXACTLY ONE conversation · the truncation/lying-CD rung); the OOP law: AssetsPublisher + ChatsPublisher run VERBATIM against a synthetic one-chat worldState — zero twin drift; the chat publish sheet (the export view's 💬 Publish .doomchat row → history/assets toggles + live size + export + publish); the download lands the icon via openChatBySession's materialize branch + opens the panel.
- v1.54.4 THE TRUST LADDER (web+engine): persona/preamble imports carry the 64KB cap + type gate (honest refuses, both the hubitem + hub twins); THE UNSELECTED LAW — a downloaded preamble lands ADDED, never active (the R7 no-auto-activation law; the old auto-select dies); bundle personas are FORCED mode:'inactive' at the border (the bundle's 'always' claim never survives); THE HONEST HISTORY (the rig convicted the old shape: a mid-replay throw escaped before the undo journal existed, leaking the born session — the replay is now best-effort post-birth: the birth is the commitment, history is cargo); the provenance chip (engine ListCanvases gains the $.imported.from JSON1 probe → CanvasRow.imported → the manager's ◇ chip).
- THE RIGS: scripts/v1540-library-rig.mjs 41/41 (the format law · the ladder · the import E2E with io stubs · the trust ladder · the rollback + honest-history · BYOK) + scripts/v1540-library-walk.mjs 55/55 (THE REAL FINGER vs a PROTOCOL-HONEST fake HF — scripts/fakehf.mjs implements the exact hf.go surface incl. the preupload→LFS causality: the whole publish→browse→download→land flow for BOTH types, the browse-row flip, the LFS seed + NDJSON truth asserted on the fake's state, the trust ladder LIVE (persona always→inactive, preamble unselected, auto-tools off, history rode), zero errors + theme pin + B1).
- THE RIG'S OWN CONVICTIONS (all fixed in-phase): the fakehf crash (writeHead-then-setHeader on the 404 repo-card path — the publish's first probe); the chatbundle local build() shadowing the module's async build() (the sheet's TypeError); the walk's missing IIFE invocation (agent-browser serializes a function object as {} — the double-encoding family).
- BATTERY on the final tree: go 17/17 packages ALL GREEN + vet clean · v1540 41+55 · v1428 48+30 · v1427 57+33 (the browse-row pins UPDATED — the forward-wired subtitle flipped, exactly as planned) · v1426 34+16 · v1425 45+28 · v1424 46+20 · v1421 24/24 · v1400-stream 51/51 (the stale SeamNudgeText pin fixed — the v1.50 rename) · v1350 ALL GREEN · v1310 58/58 · v1390 source-pin PASS (the baseline re-anchored — the line-keyed ledger, my +90 hub.js lines shifted it) · discipline 7+B1 (the pre-existing trio) · node --check clean.
- WILL NOT (documented): no bot-facing canvas/chat publish (hublibPMTypes untouched — already stale for python/preamble, a future wave); no WebIcon hub listing (the plan's own call); no moderation endpoint (out of scope, documented risk); no real writes to the user's HF account from the sandbox (the fake-HF protocol twin is the proving ground — a real publish is one tap from the user's device).


# v1.53.0 THE SECOND TONGUE SHIP (PLAN-V151) — the whole OpenCode integration speaks 2.x, big pickle proven live

- The ask (verbatim): "Ur next goal is to update all our opencode integration to 2.x, tell me if I MUST do anything manually, else you do it. And test opencode big pickle, have it test every tool capabilities in the app." THE SHIP: every phase v1.51.1-v1.51.4 landed and the v1510 rig proves the full chain live — DESKTOP 25/25 + ANDROID-CHAIN 27/27 with the user's real key, cost 0 everywhere.
- THE RESEARCH (all before any build; CAPTURED-TRUTH.md in the permanent folder): OpenCode 2 ships as npm `@opencode/cli` (2.1.2, the official install script's own words — GitHub releases stay 1.x-only); the 2.x serve is basic-auth under /api/; model selection lives on the session; the prompt is text-only (the 1.x shape-poison gate law is moot); the SSE vocabulary is entirely new; THE GATE PASSES on 2.x (real big-pickle turns, cost 0).
- v1.51.1 THE NEW TONGUE: the npm 2.1.2 pin (the registry's own sha512 integrity constants, byte-verified), basic auth on every request, the /api client family, the pump rewrite, the per-turn model law (SelectModel before every prompt), the 2.x gate-law permission config. v1.51.2 THE YOUNGER GUEST: the Android pin → opencode2 v1.0.3-rc3 (OpenCode 2.0.0-android, 72.5MB flat zip, SHA256-verified) + the legacy 1.x cleanup at install. v1.51.3 THE APP SURFACE: every user-facing byte names the 2.x truth. v1.51.4 THE LIVE PROOF: the v1510 rig + three real bugs fixed (key.env export lines; THE STABLE-PASSWORD LAW — the serve password derives from the key so a pocket serve outlives the engine and stays adoptable; Start's self-heal mode-check + spawn serialization).
- THE MANUAL ANSWER: nothing. The desktop engine downloads the pinned tarball itself; the phone keeps its same one tap (the upgrade cleans the retired 1.x files); no new gates.
- THE MERGED-TREE LAW honored against the parallel SURGEON wave (v1.52.x): rebase clean, 17 packages + the full rig green on the merged tree, buildinfo 1.53.0 chained over 1.52.8.

# v1.52.8 THE FIRST SPARK (v1.52.8) — the workspaces overlay's connect pill glows until the first workspace lands

- The ask (PLAN-V150's test 3, verbatim): "for them to make the connect workspace pill in the workspaces overlay glow an accent color when no workspaces are connected." THE SHIP: workspace.js — while /api/workspaces answers EMPTY, loadGlobals arms wsx-conn-glow on the pinned ＋ connect pill (#wsx-connect); the first workspace lands → the same re-render disarms it (the v1.48.3 plus-bind chain, the post-sign-in reopen, and every picker onSwap all ride loadGlobals); an API error never glows (unknown ≠ empty). THE GLOW: theme tokens only — a soft 1.8s ease-in-out box-shadow halo + border strengthen + label bloom, all rgba(var(--accent-rgb), …) (zero hardcoded colors — the file's edit-A6 law); [data-a1-grad] gradient themes coexist (that rule owns background-image/color only); @media (prefers-reduced-motion: reduce) freezes to a static glow. Pure PWA (the injected ws sheet + the one toggle) — the OTA carries it. buildinfo 1.52.8 (the next free dot over THE SURGEON's v1.52.1-7).

# v1.50 THE UNLOST MIND (PLAN-V150) — the trippy chatlog fixes, shipped

- The wave's full record lives in buildinfo (the 1.50.0 ship chain) + PLAN-V150-THE-UNLOST-MIND.md + the README section. The five fixes: THE WHOLE RETURN (every tool-level cap dies) · THE ONE TRUTH (the context-aware in-turn budget; the 6K cross-turn clamp + 12-pair stub law dead) · THE HONEST MASK (hides reach the production history builder) · THE SINGLE VOICE (deltas fold; the seal dedupes — a reply rides exactly once) · THE CONTINUE (the retry era ends: the WS continue frame + the 4th mode, no user event ever re-persisted).
- The rigs (scripts/v1500-unlost-mind-rig.py): RIG A 9/9 + the pre-fix flip conviction (the 14-call clamp storm + the amputated tail) · RIG B 5/5 (the original workspace-pill-glow prompt, 52 real tool rounds, the 146KB workspace.js whole) · RIG C 10/10 (the continue button end-to-end). Renumbered v1.49→v1.50 mid-ship: the parallel pocket-bridge wave claimed the v1.49.x sub-phases on origin; the version law (never share) held.

## v1.49 THE POCKET BRIDGE (PLAN-V149) — OpenCode's free models on Android: the native client through Termux, provisioned by the engine

- The user's ask verbatim: "We can run opencode directly on termux, let's port and move the opencode to android aswell. Chatting with it should work, if u want via termux, or another option, u research and decide what's best. But we want the opencode provider to work with as few gates as possible. If we require termux or another gate then so be it, better then nothing, we can work around that. Atleast opencode is available for Android. Since the doomalay app serves the android APK. Let's try hard to make Opencode work for Androids."
- v1.49.1 THE GUEST ROOM — the research found the truth before any build: the official CLI has NO Android build (anomalyco/opencode #10504/#12515/#21043); proot is the documented workaround but means ~250MB + ptrace; THE FIND is guysoft/opencode-termux (native aarch64 Android builds — Bun patched for seccomp/bionic, JSC ported, "all backend services [working]"). THE PIN: v0.2.1 = OpenCode 1.17.9 (Jun 25 2026, latest STABLE v1 line), zip 52MB, SHA256 0c77d4b8…a9b0 verified in-sandbox; flat layout (the wrapper LD_PRELOADs libtagfix + execs opencode.bin); 1.17.9 speaks the SAME serve API as the pinned desktop 1.19.3 — the ocserve client is byte-compatible. THE GUEST ROOM (ocserve/termux.go): the provisioner drives the install through the existing jailed exec (mkdirs → deps → SHA-verified download → unzip → the gate-law config via RunWithStdin → key.env 0600 via stdin → wake-lock + nohup spawn 127.0.0.1-only → pid/port files → the engine-side health poll on the shared loopback); THE REUSE LAW (bridge.port adoption, the stale pid-file kill); the bounded watchdog re-provision; the spawner law (env override; android→termux auto; the desktop exec-child byte-unchanged); Manager.SetTermux; the RAW-WORKDIR LAW caught at rig time (the Kotlin bridge passes workdir UNEXPANDED — the spawn cd's itself). Pins: the command shapes byte-pinned, the artifact pin + the 64-hex law (caught a transcription slip), the two gates' honest errors, the install order, idempotence, reuse, the real health-poll chain, the key-never-on-a-command-line pin.
- v1.49.2 THE OPEN HANDSHAKE — the app's surface: GET /api/opencode/bridge answers THE STATE LADDER (desktop|walled|unconfigured|termux_missing|not_bootstrapped|installing|install_failed|up|ready; THE ORDER LAW — a healthy serve is the most decisive truth); POST /api/opencode/bridge/install is the ONE-TAP gate (idempotent, single-flight, the detached 20-min install goroutine); an in-flight install never blocks a turn (the honest oc_bridge_installing terminal); the FreeTierError copy is platform-aware (Android names the pocket bridge); the opencode card renders the ladder inline (Install button; the Termux gates hand off to the EXISTING window.TermuxSetup flow — never duplicated; theme tokens only; the two-surface law held). Pins: the rungs in order, the single-flight, the up+port, the install route's honest answers, the no-key-leak.
- v1.49.3 THE LIVE PROOF — scripts/v1490-pocket-bridge-rig.py 22/22 GREEN (sandbox mode, no device): a fake termuxbridge (the Kotlin 4-route contract) whose /run REALLY executes the provisioner's commands in a jail + a linux-twin artifact (the real 1.19.3 binary in the guysoft layout) + a real engine — the FULL chain live: ONE TAP → the real download/sha/unzip/config/key/spawn → a REAL serve under the jail → a REAL big-pickle turn (thinking, the 391 answer, serve's own usage on the ledger: total 6931, reasoning 65) → the second turn reuse (25) → THE RESTART-REUSE LAW (engine 2 adopts, never stacks) → THE WATCHDOG LAW (kill → re-provision in ~63s → a third turn answers) → the honest rungs (keyless=walled, dead-bridge=unconfigured + the wall copy + a clean terminal). The rig's own lessons pinned: the events cut law (pre==0 = the whole log), the opencode.BIN cmdline matcher. DEVICE MODE rides the same rig over the tunnel (the /api/health version gate SKIPs pre-1.49 devices honestly; then the REAL aarch64 install → THE DECISION GATE: a real phone turn through the real native client — 144 = 1.17.9 passes the free-tier gate; FreeTierError = plan-B, opencode2 + the 2.x adapter, reserved in PLAN-V149).
- v1.49.0 THE SHIP (this commit) — buildinfo 1.49.0 (the record chained over 1.48.0); the README gains the pocket-bridge paragraph; this entry. THE MERGED-TREE LAW: no parallel-bot commit landed on main during the wave (checked before every push; the app/lib/bot branches untouched); the ship battery on the final tree: v1490 22/22 + the full go battery + vet + cross-compile. Honest limits: Termux must stay alive while chatting (wake-lock + the honest card status); the 52MB download is one-time (the card says it); the native line is frozen at 1.17.9 while the free-tier gate evolves — the device decision gate + plan-B reserve cover it; serve turns run OpenCode's own agent loop under the gate-law config (execution + writes denied); the desktop bridge is byte-unchanged.


## v1.48 THE SEEN SIGNAL (PLAN-V148) — the user's five-ask device report, every phase live-convicted

- v1.48.1 THE SINGLE ECHO — the user's report verbatim: "the users messages send twice when talking to bots. Each user message is duplicate and sent twice." Root cause: handleTurn persists the user event BEFORE buildHistoryCompacted runs, so the history already carried the in-flight message; the direct path appended it again (chat.go) and the brain path let agent.py append it again — [user M, user M] on EVERY provider since the v0.38 brain-history build (the UI transcript was never doubled; the MODEL wire was). THE FIX: trimInFlightUser (compact.go — drops ONE trailing user row ONLY on byte-equal match; redacted copies never match, no history byte ever dropped, repeated same-text keeps both real events) at both construction sites; personaMetrics.Turns lost its +1 (a "trigger at 3 turns" persona fired on the chat's FIRST turn). LIVE: the stub-provider probe counts the real wire payload — pre-fix "OBS MARKER…:2" (the symptom measured), post-fix ":1"; pins in echo_v1481_test.go (the real order persist→build→trim→append→exactly once; the brain law; the trim's conservative table; the turns metric).
- v1.48.2 THE LIVE STARS — the user's report verbatim: "the chat icon needs to be moved or refreshed for the orbiting stars to reflect, connecting a workspace doesn't send a signal to refresh the icon." Root cause: the signal chain existed (bind → fireWSChanged → Atoms.refresh → atoms-changed) but the worker clone cache never re-sent clones (entitiesSig hashed only count+x/y): a session bound at rest left a sessionId:'' clone and paintCore skips iconless rows. THE FIX: the sig folds a memoized per-entity session-hash + the atoms-changed listener forces ONE paintGridFrame(true, true) (the never-used forceEnts param). LIVE on a TRULY frozen canvas: stars 0→1 in one forced frame (entsMsgs +1), icon byte-unmoved; pre-fix flip: entsMsgs FLAT, stars invisible until the icon was nudged — the user's exact workaround convicted live.
- v1.48.3 THE DIRECT PLUS — the user's ask verbatim: "Pressing the + should add it to the chat directly. Instead of user presses + then also has to press include in this chat." The ＋ badge gains data-plus + its own click (stopPropagation — the row body keeps its expand) running the ONE shared plusBindToChat chain (POST bind → ✓ in chat re-render → refreshPills → fireWSChanged — the stars now really refresh — → toast). LIVE: one real DOM click binds (7/7); pre-fix flip: the click EXPANDED the row and bound nothing.
- v1.48.4 THE INFORMATIVE PILL — the user's ask verbatim: "replace the workspace static text with a dynamic text of the action being used (grep, view, ext..) and include the 'what' parameter aswell in the collapsed pill description." toolPillLabelParts' workspace branch covered 5 of 25+ verbs; the rest fell to the static 'workspace | summary' fallback. THE FIX: the full verb table off workspacetool.go's own param grammar (grep→query, view→what, pr_*→#number, create→name, unknowns→sliced verb+operand; a missing operand keeps the fallback body). LIVE: a real tool_call drives the real grep against the real bound repo — the pill reads 'grep | readme'; pre-fix 'workspace | octocat/Hello-World' convicted.
- v1.48.5 THE SERVE BRIDGE — the user's ask verbatim: "Have another go at making opencode free via the API." Live-probed to the truth: the hosted API's free tier (zen AND /inference/v1) is walled BELOW HTTP to OpenCode's own clients (byte-faithful CLI-identity replays still 403 FreeTierError; the wall is by design), while `opencode serve` — the genuine client — serves free models with our plain key at cost 0. THE GATE LAWS (live-convicted): default turn shape only (per-turn tools/system fields poison the turn AND the session); the project-level opencode.json permission config PASSES while removing execution + writes (the model: "I don't have a Bash tool available"); fresh sessions recover poisoned ones. THE BRIDGE: engine/internal/ocserve (binary discovery env → the managed download of the pinned 1.19.3 → PATH; Android answers unavailable honestly; the permission config; free-port spawn with the vault key; the bounded-backoff watchdog; the live-captured client shapes — prompt_async 204 + /event SSE part.delta/message.updated/session.idle) + server/ocserveturn.go (one serve session per app chat; persona+context ride the MESSAGE TEXT; the SSE→engine mapping through synthesizeRounds; serve tool parts → the pill grammar; serve's own tokens + the reasoning share → the v1.46.2 ledger; THE RECYCLE LAW: a wall drops the poisoned serve session and retries once on a fresh one — v1.48.1's trim rides the replay; a second wall answers with the bridge's OWN honest error + terminal). LIVE 9/9 on two real engines: the engine spawned a REAL serve child, a real big-pickle turn streamed thinking + the 17×23=391 answer + usage (total 6994, reasoning 86), the second turn reused the serve session; the unavailable bridge answers the honest wall copy + a clean terminal. Honest limits: DESKTOP-ONLY this wave (the glibc law — the HF-brain relay is the phone answer long-term, needs the user's infra call); OpenCode's gate actively evolves — the bridge is opportunistic free capacity with honest fallbacks; serve turns run OpenCode's OWN agent loop (its read/grep tools in the scratch dir, execution + writes denied), not the engine's 31-tool ReAct.
- v1.48.6 THE PROOF — scripts/v1480-the-seen-signal-rig.py 14/14 on the MERGED tree (the parallel bot's v1.42.8 THE VESSEL landed mid-wave; every phase probe re-ran post-merge, zero regressions): the five probes (echo 4/4, stars 10/10, plus 7/7, pill 5/5, bridge 9/9) + eight source pins + the go battery (server 54s + ocserve + llm 114s).
- v1.48.0 THE SHIP (this commit) — buildinfo 1.48.0 (the record chained over 1.47.0); the README gains the seen-signal paragraph; this entry. Pushed chain: afcf89c4 (echo) → bfb2d557 (stars) → 6b42fc9c (plus) → 84617c24 (pill) → a598d6f2 (bridge, on top of the parallel v1.42.8 vessel rebase) → 3abebd11 (proof) → this ship.

## v1.47 THE TWO HANDS (PLAN-V147) — two parallel bots' work, finished and shipped

- v1.47.1 THE JOURNAL HAND — the user's ask to the (quota-killed) Kenny bot, verbatim: "I want to port the journal into the app so all the users can use it. It should come as a native tool with the other 20+ tools." engine/internal/djournal: the authentic Go port of brain/tools/dt_journal.py function-by-function (write/read/search/review/moods/prompt/export/help; append-only <DataDir>/journal/entries.jsonl, ONE diary per install; the (date, created) dedup key with idempotent replays; same-date #2 ids; the 5-level mood normalization — numbers beat words beat emoji, bools rejected, out-of-range nil; per-ENTRY review averages with the ±0.2 trend dead zone; DAY streaks with the yesterday-grace; 45 day-of-year prompts; md/json exports that round-trip + atomically write the state dir AND sink the artifact card into the chat's drawer; corrupt lines skipped, never fatal; 6,000-char honest caps). THE PARITY LAWS: pyRound is Python's banker's rounding (half-to-even; Go's math.Round is half-away — the 2.5-tie glyph and the 0.5-tie bar column diverge without it), .date() keeps the timestamp's OWN-zone day, the JSON entry shape matches the Python dict's key order + null/[] semantics. PROVEN BY THE GOLD CROSS-CHECK: djournal_parity_test.go runs the SAME scenario through dt_journal.py itself AND the port — all 8 surfaces agree byte-for-byte (python3 dt_journal.py SELF-TEST OK on the same tree). The wiring: the 30th mcpbus Def (always armed), the Turn closure, the handler, ChatRequest.DjournalToolFn on both paths (the bus AND the degraded direct dispatch), the server runner with the bare-string tolerance + the artifact sink.
- v1.47.2 THE FLEET HAND — the user's ask to the (died-mid-research) Dock bot, verbatim: "implement a method to or tool you can use to check other chatbots that are active, and info about them — the canvas, the name, relevant metadata (sort of like a simple one with name/model - canvas - and essential info with a filter, then another method that expands and lists the full details of one chatbot, including its current actions and progress)." The 31st native tool over the engine's OWN truth (the A2A Agent Card grammar): roster (title — provider/model — canvas "Name" — RUNNING|idle · last Nh ago · N turns; running-first; the q filter over title/model/provider/canvas; cap 30 + honest overflow) + detail (identity with the ACTIVE persona resolved the live-turn way, the canvas home via the WorldState digest join, the armed capabilities, the CURRENT action from the live events tail, the progress with the v1.46.2 reasoning-usage line, the THIS-IS-YOU mark, the snapshot + ambiguity honesty). No new state, no new locks; one store addition (CountUserTurnsPerSession — a single GROUP BY for the whole roster).
- v1.47.3 THE BRIDGE PURGE — the user's directive riding the journal handoff, verbatim: "we can get rid of the fallback old pm bridge since we have native." The old PM bridge's five /api/tools/* GET routes + tools.go (215 lines) + the two thin skills.go HTTP wrappers DIE — the WebView-bridge chat that consumed them died with v1.44.0 THE NATIVE PM and a full-tree sweep found ZERO consumers (web, app, brain, docs). The dispatch cores stay (RunLocalTool/skillsDispatch/hublibDispatch are the mcpbus closures' bodies); the current surfaces all stay (the mcpbus, /mcp external consumers, /api/pm/local/v1/chat/completions — the co-located brain's REQUIRED PM bridge). The route-pinned tests re-pinned to the live seams with every assertion preserved (skills_test drives the dispatch cores directly; v28 rides runPersonaTool; v816 rides runWorkspaceAction).
- v1.47.4 THE PROOF — scripts/v1470-two-hands-rig.py 39/39 LIVE (a real engine + a real browser page on the engine's own WS chat protocol, real model turns that REALLY call the tools through OpenRouter's free tier — minimax/minimax-m3.1-flash:free, tool_call shape probe-verified): the write receipt with the mood glyph + streak, the diary file under DataDir/journal with the canonical JSONL, the read/review/export chain, the artifact card in the drawer, the roster with the canvas + the LIVE RUNNING truth (a long generation in one chat probed mid-turn by another chat's roster — the turn gauge), the five dead routes 404 while the brain's PM bridge answers its honest api-key-fallback=never 401, 13 source pins. The rig's own honesty: fresh sessions per action turn (flash models imitate earlier tool_calls when history exists), the persisted tool payloads are JSON-encoded strings, sync-playwright is thread-bound (the mid-turn probe rides websocket-client).
- v1.47.0 THE SHIP (this commit) — buildinfo 1.47.0 (the record chained over 1.46.0); the README gains the two-hands + retired-bridge paragraph; this entry. PROVENANCE: PM's key is quota-exhausted this month ("you have exceeded your organization's monthly limit of 1000000 prompt tokens" — the SAME 401 that killed the Kenny bot mid-plan, live-confirmed through the engine), so the pmlive gates SKIP honestly until the monthly reset and the rig's live turns ride the OpenRouter free tier. Regressions ALL GREEN: v1350 62/62, v1400 51/51+27/27+58/58, the full go battery 15 packages (the djournal package the 15th), vet clean, cross-compile linux 54,334,983B + android-arm64 54,642,970B. Honest limits: the journal's brain-side twin (dt_journal.py) still serves HF-space chats unchanged (the brain is out of the engine's reach by topology — the user's own law: "the python brain is fully for hugging face"); the fleet sees engine sessions only (brain-side swarm sub-agents are not sessions — on the tool's face); the roster is a snapshot, not a stream.

---
Task ID: v1.42.3
Agent: Main orchestrator (Z.ai Code sandbox — THE MANY WORLDS wave)
Task: PLAN-V142 §3.1 W1 — THE EDGE: the bounded world. The 7-second
metric formalized as the user's dial (65,536 default, 2^16,
float32-safe by 256x per R1), the camera can never leave, physics
walls settle flings at the edge, the edge line is theme-native.

Work Log:
- app.js: applyWorldSize (the sanctioned ladder 16k/32k/64k/128k/off,
  snap-to-ladder for strays) + clampCamera (both axes independent per
  the plan's corner law; a viewport wider than the world degenerates
  to centering) + conform-on-shrink (stranded icons pulled home) +
  the settings wiring (applied BEFORE the camera restore at boot so
  no stale snapshot escapes — the boot law; onChange coerces the
  select's string + gates on change).
- ALL NINE camera write sites clamped: finger pan, momentum, compass
  glide (every flight frame), setView, reset view, zoomAt, pinch, the
  boot restore, resize/orientationchange.
- physics.js: setBounds(half) + the soft damped walls inside the
  integration's full path (restitution 0.4 + tangential drag 0.9 — a
  fling reflects ONCE and settles; orbits exempt, the steering owns
  them; sleepers never reach the pass — conform owns them) + conform
  (the shrink migration: pulls asleep strays inside + dirties the
  static grid, honoring the v1.42.2 sleep law).
- The edge affordance: four fixed-position 2px lines,
  rgba(var(--border-strong-rgb), 0.35) — the theme-card border's own
  ink, ZERO literals (the pin holds). Skip-if-identical writes, O(1)
  per frame, refreshed on the latticeDue cadence + every full render
  + boot restore + resize + applyWorldSize.
- The World Size dial: Settings → Sizing (selectRow, five options).
- cameraProbe exported (the arrowsProbe read-back precedent — the
  rigs read the camera truth; W2's per-canvas camera builds on it).
- THE RIG (scripts/v1423-edge-rig.mjs, joins the battery) 33/33:
  source pins (all nine clamp sites, the ladder, the wall constants,
  the theme-var edge line, the boot-law ordering) + behavioral vm
  physics: the fling reflects + settles INSIDE + comes to rest, the
  corner law, conform snaps a stranded sleeper + dirties the grid,
  the differential twin (bounded stops at its wall / unbounded flies
  past the same point — the legacy law), the edge-settled entity
  sleeps + the resting edge world stays O(1).
- THE WALK (scripts/v1423-edge-walk.mjs — the real app, real UI)
  14/14: the dial renders + applies LIVE through the real select; six
  hard flings per direction MOVE the camera and NEVER exceed the
  bound (non-vacuous: movement asserted); the stale 50000-offset
  snapshot clamps at boot; a flung icon settles inside via stepSim;
  the edge line renders at the bound + fades when centered + dies
  when OFF; OFF keeps the legacy infinite world (14 flings past the
  old bound); zero page errors.
- CONVICTIONS DURING THE WALK (fixed): (1) the synthetic mouse
  gestures dispatched on document — the canvas-surface gate
  (onCanvasSurface) rightly rejects non-canvas targets; both walks
  now dispatch on #chatbots (the v1422 walk's pan ledger re-validated
  with REAL pans — still 24/24, still the 16.7ms vsync floor at
  100/250/500). (2) The first S2 assertions were VACUOUS (a covered
  canvas never moved the camera; x=0 passed ≤ bound trivially) —
  caught, fixed with movement assertions. (3) An external settings
  storage write is clobbered by the pagehide trailing-flush (the
  page's in-memory state outlives it) — a rig artifact, not an app
  bug (the UI's setState is the one true path); the walk rides the
  real select instead.
- Battery: v1423 rig 33/33 · v1423 walk 14/14 · v1422 rig 26/26 ·
  v1422 walk 24/24 (re-validated) · v1310 58/58 · v1400 58/58 · theme
  source-pin PASS · v1390 30/30 · v1391 10/10 · discipline 7 PASS +
  the documented pre-existing B1 · node --check clean · go build
  green.

Stage Summary:
- The world has edges and they are the user's dial. The camera cannot
  leave (nine clamped sites + the boot law), flung icons settle at
  the wall (soft damped, never bouncing forever), the edge is
  theme-native ink when visible, and OFF restores the infinite
  legacy. W1 done at the plan's S cost estimate (~180 LOC across 4
  files). Next: v1.42.4 THE LEDGER (engine canvases table + Worlds
  registry + the state.v2 migration).

---
Task ID: v1.42.2
Agent: Main orchestrator (Z.ai Code sandbox — THE MANY WORLDS wave)
Task: PLAN-V142 §3.0 W0 phase 2 — THE FIELD: the visibility law (DOM
render cost O(visible), not O(world)) + the sleep law (resting physics
~zero), per the house law (R11/R12 research already in the plan; the
code-evidence pass + rig first, no speculative rework).

Work Log:
- THE VISIBILITY LAW (app.js): renderIconsCulled/renderMembersCulled —
  the camera-authoritative DOM cull. We own the camera (offset/scale)
  and viewport (W/H): an icon's visibility is a two-comparison fact
  (CULL_PAD 320 covers glyph + label + badges + orbit lift at max zoom).
  Offscreen icons get display:none + skip their transform write entirely
  (the old moving-camera frame changed EVERY icon's transform string —
  a 500-icon world paid 500 style writes per pan frame). Un-culling
  resets __lastTf so the return frame re-renders. JS-driven per R11's
  caveat (transforms are visual, not layout — content-visibility's cull
  rect can't track them; the camera IS the truth). All THREE render
  sites wired: update()'s full render, tick()'s latticeDue branch, the
  orbit-members pass. content-visibility evaluated and DECLINED (the
  documented decision — the guaranteed path shipped).
- THE SLEEP LAW (physics.js): the two-tier broadphase. At-rest entities
  (exact vx=vy=0, no drag, no orbit) bin into a STATIC grid rebuilt only
  on transitions (wake/sleep/shove — the dirty flag); awake entities
  ride the per-substep fine grid. The broadphase walk only visits awake
  initiators × (fine + static) neighborhoods. A FULLY-resting world
  early-outs to O(1) (nothing awake = nothing can move or approach).
  The STILL-ASLEEP FAST PATH in integration (~4 reads + a branch per
  sleeper — the rig caught the first cut at 250µs/step for 600 and the
  fast path brought it under budget): external writes (an app nudge
  setting vx) fall through and re-derive honestly — safe by
  re-verification, not trust. Position corrections on sleepers dirty
  the static grid; contacts still fire through it (the TabGroups dots
  law); the drag plow's boost works on sleepers via the static path.
- The accepted edge, pinned honestly: two OVERLAPPING sleepers don't
  self-correct (they can't approach each other) — any nudge restores
  order. Documented in the rig, not hidden.
- THE RIG (scripts/v1422-framebudget-rig.mjs, joins the battery): 26/26
  — source pins (the cull owns all three sites; no uncalled full-world
  render loops remain) + behavioral vm physics (resting 600 vs 20 flat
  ratio, mover wakes + displaces the pile, drag plow boosts sleepers,
  contacts fire, orbits never sleep, ZERO static rebuilds across 100
  resting steps, elastic parity, the edge + its wake path).
- THE WALK (scripts/v1422-framebudget-walk.mjs — the real app, the real
  input wiring, agent-browser): 24/24 — 100/250/500-icon worlds (9%
  near the origin, 91% the aged far field 8k-76k px out): the far field
  culled exactly (display:none), the near field alive with transforms,
  the un-cull works (camera at a far icon → it reappears with a fresh
  transform), reload parity, zero page errors. THE LAW LEDGER: the
  scripted-pan avg rAF delta is 16.7ms at 100 AND 250 AND 500 (the
  vsync floor — 5× world growth added ZERO frame cost) + the resting
  500-world steps at ~free per direct world.step() probe.
- Battery: v1422 rig 26/26 · v1422 walk 24/24 · v1310 58/58 (the old
  frame-budget pins still hold) · v1400 58/58 · theme source-pin PASS ·
  v1390 30/30 · v1391 10/10 · discipline 7 PASS + the documented
  pre-existing B1 · go server+store ok · node --check clean.

Stage Summary:
- The install-age ledger's H4/H5 closed: a 500-icon world renders and
  steps like a 50-icon one; a resting world costs ~nothing per frame
  (the 33ms ambient cadence now rides a free step); pans cost O(visible)
  style writes. Option B (the full-Pixi icon rewrite) NOT needed — the
  rig + walk prove the laws hold with the DOM path (the plan's fallback
  discipline: measure first, rewrite never). W0 THE LONG HAUL is
  COMPLETE (v1.42.1 audit+hygiene + v1.42.2 the field); the queue moves
  to v1.42.3 THE EDGE (the bounded world).

---
Task ID: v1.42.1
Agent: Main orchestrator (Z.ai Code sandbox — THE MANY WORLDS wave)
Task: PLAN-V142 §3.0 W0 phase 1 — THE LONG HAUL: the install-age
degradation audit + rig-proven hygiene (H1/H2/H3), per the house law
(hypothesis → research → real plan → build → redteam; the R13 research
pass + this session's code-evidence pass came first).

Work Log:
- Rebased onto 586b133b (the parallel V144 wave's toolchain bump: go
  1.26.0 + CI 1.26.9 — adopted; full battery re-verified green under
  1.26.9 BEFORE any edit: 13/13 packages).
- H1 verdicts (code-evidence): WAL grows unbounded (journal_size_limit
  never set, no TRUNCATE checkpoint — the -wal file keeps its lifetime
  high-water size); hub_items grows ONLY on download/publish (discovery
  never persists — the plan's browse-cycle claim was overstated; rows
  are user data with an explicit delete, so NO eviction — the usage row
  surfaces it instead); metrics JSONL: VOID engine-side (obs is a capped
  in-memory ring; usage computes from events; hub metrics are remote HF
  datasets) — no fix needed, verdict recorded.
- H1 fix: store/maintain.go — Open() applies PRAGMA journal_size_limit
  (8MB); Maintain(force) = wal_checkpoint(TRUNCATE) + PRAGMA optimize +
  gated VACUUM (freelist ≥25% AND ≥7d since last, stamped in
  app_settings; force bypasses); the VACUUM path re-checkpoints so the
  shrink reaches the filesystem (the photostructure WAL-vacuum study).
- H3 verdict: healInterruptedTurns was THE boot storm —
  ListEvents(id, 0) for EVERY session on EVERY boot = O(lifetime
  chat_events), blocking server New() before /api/health ever answers
  (the "degrades the longer it's downloaded" shape, paid even when
  unused). Fix: store.TailPendingTurn — a DESC walk that stops at the
  FIRST user-or-terminal event (the full-scan verdict depends only on
  which comes last; common closed session = 1-2 index reads; a crashed
  mid-mega-turn walks only that turn's tail; LIMIT 20001 covers any
  realistic turn). PARITY-PROVEN against the old full-scan logic on 9
  shapes incl. the 2k-delta mega-pending (events_tail_v1421_test.go).
- H3 fix 2 (the OTA overlay): files only ever accumulate — a file
  deleted from the web tree (the sandboxpicker.js v1.17.1 case) is
  absent from every later manifest, never compared, never removed: it
  resurrects on every load forever. otaOverlaySweep removes overlay
  files absent from the CURRENT manifest (never on unreachable; never
  .tmp in-flights; once per manifest version) — wired into
  otaBackground + the post-apply path.
- H2 verdicts: iconreg already hard-capped (2MB/16 sets — no fix);
  modelcache has NO TTL (fix: 24h companion-stamp backstop in the
  hygiene module); chatscroll/chatdraft/chatbundle/exportlatest grow
  forever with dead-session entries (the four prune targets);
  state.v2 is W2's migration target (THE LEDGER), untouched here.
- H2 fix: web/storagehygiene.js — the daily sweep (once/24h, stamped):
  prunes the four per-chat maps to LIVE ids (canvas state icons ∪
  engine /api/chats; offline + nothing-live = skip, never a wrong
  wipe), enforces chatpanel's 60-cap properly, drops the stale model
  cache; + the Settings → Storage page (registerPage — the perfhud
  precedent, zero new surfaces): engine usage rows, localStorage
  footprint, Clean-stale-data + Maintain-now actions, theme vars only.
- New surfaces: GET /api/storage/usage (honest counts+sizes, no
  paths/payloads) + POST /api/storage/maintain {force} (busy engine =
  409 honest); maintenanceLoop (30s after boot, then 6h; skipped while
  turns stream — the busy-gate) — NEVER on the boot path.
- THE RIG (scripts/v1421-aged-state-rig.mjs, joins the battery): seeds
  a 90-day-equivalent DataDir (121 sessions via the REAL API · 46,531
  events · 1,500 hub rows · ghost freelist · stray overlay files)
  through a live booted engine: 24/24 — aged boot→health 853ms (budget
  4s), the heal closes exactly the 9 pending (incl. mega) + touches
  nothing closed, usage counts exact, forced maintain truncates the WAL
  on disk + reclaims the freelist + stamps, the overlay sweep kills
  the strays + keeps manifest files. Phase B node-requires the pure
  prune/collect core (12 more).
- CONVICTIONS DURING THE RIG (fixed): (1) the post-VACUUM checkpoint
  used bare db.Query — an unclosed *sql.Rows pins the ONE connection
  (MaxOpenConns=1) and everything after deadlocks (the maintain test
  caught it; QueryRow+Scan now). (2) The first seeder wrote raw session
  rows with NULL columns — ListSessions' scan rightly refuses NULL→
  string; the rig now creates sessions through the real API (and the
  prewarm log error is what convicted it).
- THE BROWSER WALK (agent-browser, the real app, zero page errors):
  aged localStorage seeded (3 dead scroll entries, dead draft/bundle/
  export, 48h-stale model cache) → sweep keeps exactly the live chat's
  entries + drops the rest + the stale cache; Settings → Storage
  renders every row with real data (88KB db, rows, vacuum age), both
  buttons act honestly ("removed 0 stale entries" post-sweep; "checkpoint
  ✓ · vacuum ran · wal 0B → 0B" + the stamp flips to "just now");
  computed styles resolve from the theme's OKLCH vars (the theme law).
- Battery: go 13/13 (14 new tests: maintain 10 · server 4) · v1421 rig
  24/24 · v1400 uninterrupted 58/58 (the turn lifecycle is untouched
  and proves it) · theme source-pin PASS (0 violations; the census gains
  storagehygiene's var-compositions) · v1390 30/30 · v1391 10/10 ·
  discipline audit 7 PASS + the documented pre-existing B1 · node
  --check clean · vet clean.

Stage Summary:
- The install-age ledger closes its first three hypotheses with fixes
  + receipts: boot is O(sessions) not O(lifetime events); the WAL is
  bounded + drained + vacuumed on an idle cadence; the overlay can't
  resurrect deleted files; WebView storage prunes to live chats daily;
  the user can SEE it all (Settings → Storage) and act (Clean +
  Maintain). H4/H5 (world-size creep, the cull-less DOM path) are
  measured next by v1.42.2 THE FIELD's frame-budget rig — the aged
  harness is in the battery to keep every later phase honest.


---
Task ID: v0700
Agent: Super Z (main, continued session)
Task: Land the in-flight v0.70 THEME ACCURACY WAVE (the previous session
died mid-surgery: DoomGates derived-gates + accurate ink + nebula text +
the v070 suite, all uncommitted with 19 failing checks).

Work Log:
- Diagnosed the 19 fails: systematic arg-order bugs in the suite's
  check/has/nohas calls (the JSON passed as the NAME), the active theme
  was midnight while paint() targeted nebula, agent-browser eval returns
  JSON-QUOTED strings (adopted the v0651 ev() unwrap), .fmt needed a
  seeded assistant message, .sm-row needed the send-menu open, the pills
  needed the metadata dropdown OPEN (display:none = zero rect = the PROJ
  painter correctly skips), ERRS printed nothing when empty, and trim1's
  walk matched the BASE .hi-counts b rule (narrowed to [data-text-grad]).
- REAL implementation bugs found + fixed: (1) the derived-gates selector
  list only carried the gate prefix on the FIRST selector — 2..N were
  UNGATED (on-accent ink would fire on solid themes, the v0.66 regression
  reborn); (2) .wsp-pub-go leaked into the derivation (the var(--wsp-c,
  var(--accent-2)) fallback spelling) — the skip now covers .wsp/.wsx/
  .hub-libpill selectors AND values referencing var(--wsp (the explicit
  families are tone/prov-scoped in index.html); .wsp-pub-go got explicit
  per-provider gate rules (github/selfhost→a1, gitea→a2, gitlab→a3,
  sourcehut→a4).
- v070-accuracy-redteam.sh REWRITTEN: 27/27 (nebula seeded + theme
  switched, the dropdown opens, an assistant turn seeds .fmt, in-browser
  color canonicalization for the ink checks, the v42 ERRS pattern).
- Regressions on the rebuilt binary: theme twins 165, uikit 140, go test
  ok, v0642 47/47, v0643 30/30, v0651 53/53, v0680 81/81.
- Released: commit 473e967 (v0.70.0 THE ACCURACY WAVE).

Stage Summary:
- The theme accuracy wave LANDED: pills follow their assigned variables
  through the derived gates, chat text rides text-1's field, nebula
  ships its own text family, and the model/sandbox/mind/workspace pills
  render their accents' viewport projections under gradients.

---
Task ID: v0710
Agent: Super Z (main, continued session)
Task: The user's four asks: (1) the #xyz bundle badge follows the card's
color, (2) PM usage/tokens-in/out tracking, (3) use a WHOLE bundle via
the library (+ the bot reads docs and decides which skill/ext fits),
(4) quick chat must know how to search/use the library — verify the
superpowers bundle e2e, deep research template awareness, and 20+-tool
chains that never get interrupted.

Work Log:
- (1) hub.js flagStyle: the badge painted only the design's FIRST STOP
  (a flat amber chip on superpowers' amber→red→violet mesh). It now
  paints the card's OWN art (the same GradientUI css incl. mesh/texture/
  blend, else the bunch's hash gradient); ink flips by the AVERAGE stop
  luminance.
- (2) ROOT CAUSE: PM turns persisted the RAW OpenAI chunk usage
  (prompt_tokens/completion_tokens) while server/usage.go parses
  input_tokens/output_tokens — every PM turn unmarshalled to TURNS WITH
  ZERO TOKENS. pmsdk normUsage maps either spelling, mergeUsage SUMS
  across ReAct rounds (llm.mergeUsage parity — a 12-round turn reported
  one round's cost), and chatpanel's persist boundary normalizes AGAIN
  (bridge-agnostic belt+suspenders).
- (3) THE WHOLE-BUNDLE SEAM: hub.js's bunch view grows a ▣ use-bundle
  pill (the download pill's chrome); applyBundle (chatpanel.js) arms the
  chat — libAuto on, the ▣ chip (the tpl-chip mechanics), a localStorage
  manifest keyed by session (no engine migration), segPlusLabel shows
  the bundle — and runPMTurn passes state.bundle; pmsdk prepends THE
  ATTACHED BUNDLE block (the member manifest with type/name/desc/repo/id
  + the 4-step decision protocol: review → pick → LOAD via skills/hublib
  actions → follow + say which).
- (4a) THE ALWAYS-ON VOCABULARY: the v0.60 lib gate only armed the
  ACTION protocol when the pill was ON — with it off the model never
  learned the actions and GUESSED skills (the user's report verbatim).
  PM_LIB_ACTIONS now rides EVERY PM system message (the server gates
  load/download; the text names the 🛠 pill so refusals become
  recommendations, not retry storms); the bootstrap + 1%-discipline ride
  only under the gate. skills.go's refusal messages name the pill first.
- (4b) DEEP RESEARCH KNOWS ITSELF (PM): the flag only suppressed web
  tools — the engine's stage pipeline never runs on PM, so the bot was
  blind AND methodology-less ("doesn't know it is using a template").
  The 8-stage methodology now rides the system message ('you are running
  it NOW') and the web tools stay ON. MAX_ROUNDS 24→40.
- TESTS: v071-pm-loop-test.mjs NEW 18/18 — the REAL loop extracted and
  driven (the v28 pattern): a 25-tool chain with reasoning between
  rounds runs UNINTERRUPTED and finishes; >40 rounds exhaust gracefully
  with a forced final answer; usage normalizes + sums (2500/1250 over 25
  rounds); the vocabulary rides lib-off; the bundle manifest rides. 
  v071-bundle-usage-test.sh + v071-mock-hub.py NEW 19/19 — a mock HF hub
  (the hub_test.go pattern, standalone python) feeds the REAL engine:
  the bunch card + badge render, THE BADGE PAINTS THE CARD'S ART
  (computed backgroundImage byte-equal), use-bundle arms chip+gate+
  manifest+localStorage, the PM turn (stubbed bridge) carries the bundle
  opts, and /api/sessions/{id}/usage counts prompt/completion as in/out.
  SUITE BUGS fixed in-run: the bunch cards ride a TYPE's grid (click
  .hub-libpill[data-lib=skill] first), the library+bunch stack TWO views
  (pop to root before the chip/input checks).
- Regressions (fresh binary): v070 27/27, v0642 47/47, v0643 30/30,
  v0651 53/53 (one known duck-glide timing flake, clean twice after),
  v0680 81/81, v0621 19, v0623 16, v0624 13, v0640 56, uikit 140, theme
  twins 165, interrupt 65, pm-parser 32, go test ok. The v065 theme
  suite (249 screens) restarted EXCLUSIVELY after the first run was
  collateral-killed by a parallel battery (the known agent-browser
  session collision — never run browser suites concurrently with it).
- Released: commit 6ae9698 (v0.71.0 THE BUNDLE WAVE).

Stage Summary:
- The badge wears the card's art; PM tokens are tracked (normalized,
  round-summed, aggregated); a bundle attaches WHOLE and the bot picks
  the member per task; the library vocabulary always rides so quick chat
  searches instead of guessing; deep research announces itself and uses
  the live web; 25-tool chains run uninterrupted.

---
Task ID: v0710-addendum
Agent: Super Z (main)
Task: The rebase onto upstream's parallel waves + the push.

Work Log:
- Upstream had advanced 12 commits mid-flight (v0.67.2 LIBRARY ACTS,
  v0.67.4-5 HONEST GRID + PERSISTENT BUNDLE DOWNLOAD, v0.68.3, and
  v0.69.0 THE ACTIVE-BUNDLE PILL + DOWNLOAD GATE + METADATA PERSONAS —
  a parallel session's complementary take on the same library asks).
- THE REBASE (4 conflicted files, all resolved by MERGING semantics):
  · chatpanel.js — the chip's ✕ keeps my bundle-detach AND calls their
    armTurnBundle; armTurnBundle now derives state.bundle FIRST (an
    attached bundle outranks the single template — tool events still
    override live, the next user message re-derives); applyBundle calls
    armTurnBundle (the instant-show their applyTemplate gives); my
    segPlusLabel bundle line REVERTED (their v0.68 spec: the + stays a
    plain '+', the dedicated #seg-lib-bundle segment owns the name).
  · hub.js — upstream's registry-driven download pill (dlState/bdlEntry/
    dlPillTitle/dlPillInner/is-running/is-done) + paintDlPill kept
    verbatim; my ▣ use-bundle pill rides beside it.
  · index.html — their .hub-bundle-dl-fill progress CSS + my
    .hub-bundle-use twin kept.
  · pmsdk.js — the PM_LIB_ACTIONS merge: their "library is an ASSET, not
    a detour" anti-guessing line + their search-on-ask line JOIN my
    NEVER-guess + 🛠-pill-gate line, all riding the always-on vocabulary;
    the 1%-discipline stays gate-scoped (PM_LIB_DISCIPLINE).
- VERIFICATION on the rebased tree (fresh binary): v071 19/19 (the
  critical merge validation — chip + segment coexist), v070 27/27,
  v0642 47/47, v0643 30/30, v0651 53/53, v0680 81/81, v0621 19,
  v0623 16, v0624 13, v0640 56, pm-loop 18, pm-parser 32, interrupt 65,
  theme twins 165, uikit 140, go test ./... ok. The v065 theme suite's
  key phases re-run chunked post-rebase (p00/p07/p08/p09/p10/p13/p15/
  p16): 108 screens, ZERO console errors.
- PUSHED: main 809346f..ca3b246; tags v0.70.0-accuracy-wave (cde660f)
  + v0.71.0-bundle-wave (ca3b246). No Kotlin was touched this session
  (web + Go only) — the APK CI compiles the unchanged Kotlin from the
  v0.69-green tree.

Stage Summary:
- main @ ca3b246 (v0.71.0-bundle-wave), both waves shipped and rebased
  clean onto the parallel sessions' library work; the two bundle models
  (their per-turn ACTIVE segment + my persistent whole-bundle attach)
  compose into one UX: attach ▣ → segment shows the bundle → the bot
  loads the member it picks → the segment refines to that member.

---
Task ID: v0981-wave
Agent: Super Z (main, continued session)
Task: Land the in-flight v0.97.1 CATALOGUE & SHEETS POLISH WAVE (previous
  session died mid phase-E: code was done, rig/rebuild/push were not), then
  begin the v0.98.2 research turn (element catalog + library swap study).

Work Log:
- REBASE: stashed the uncommitted wave, fast-forwarded main to origin/main
  (upstream parallel bot had pushed v0.97.0 THE CANVAS WAVE + v0.98.0 THE
  FINISH WAVE — 4 commits, zero overlap with this wave's files; only the
  engine binary conflicted, resolved by rebuild). Re-versioned the wave
  v0.97.1 -> v0.98.1 (upstream took the 0.97.x line).
- Fresh sandbox had NO Go: installed go1.25.0 to /home/z/sdk (go.mod wants
  1.25.0). Rebuilt the binary with the merged tree + ldflags 0.98.1.
- RIG DEBUG (9/19 -> 19/19): the code was RIGHT, the rig had bugs —
  (a) FOUR uncalled-IIFE evals (agent-browser serializes a function object
  as '{}' — the nvidia save click, the wsx-connect click etc silently
  no-oped); (b) True/yes translation missing on one ck; (c) the picker
  loader is real but unobservable post-hoc (fresh engine resolves the
  empty globals list in ~20ms — rig-proven loader seen 19ms gone 24ms) ->
  added the fetch delay harness (1.6s on /api/workspaces + discover only);
  (d) the github account must be POSTed BEFORE the first picker open
  (v0.98 C5's 60s hydrateAccounts cache reads an out-of-band later add as
  stale).
- ONE REAL CODE FIX: wireSheetDrag's fling detector used raw instantaneous
  velocity — a sub-frame move pair read as an enormous px/ms fling and
  dismissed on a gentle pull. Now rides gesture.js's own discipline (its
  v0.42 fix): the 4ms dt floor + 0.7/0.3 EMA.
- KEY REFRESH: .secrets rewritten with the user's new batch (github,
  opencode, privatemode, nvidia, openrouter, hf, mistral mstrl_, new
  tunnel) — nvidia + github live-validated against the real APIs.
- VERIFIED: rig v0981 19/19 ALL GREEN (incl. the real nvidia key save ->
  cache bust -> reopen auto-sync, and the real github account -> 12 repos
  in the connect box), go test ./... ok, uikit 140, theme twins 165,
  v098-panel-colors 21/21 (upstream's suite on the merged tree; needed
  cp engine/bin/doomalay-engine /tmp/doomalay-engine for its fixed path).
- PUSHED: main 0881d47a..94a064ff + tag v0.98.1-catalogue-sheets-wave.

Stage Summary:
- The 8-issue batch is now FULLY closed (1-3 here, 4-8 by the parallel
  waves). Engine 0.98.1. Next: the v0.98.2 research turn (every element on
  every screen -> the swappable-element set list + MIT/Apache library swap
  study for the color system + gradient text perf) — NO implementation.

---
Task ID: v0982-research
Agent: Super Z (main)
Task: The user's research turn: push the previous wave (done: v0.98.1 above),
  then browse the repo for EVERY element displayed in EVERY screen and group
  each into the allowed swappable-element set + the final library-swap study
  for the v0.98 color system plan. NO implementation.

Work Log:
- Five parallel census agents read the full web surface (canvas world, chat
  surface, settings/appearance, overlays/connect flows, artifacts/library/
  shared kit) — every element carries file:line.
- 16 web searches (scripts/research-v0982/) for MIT/Apache library
  candidates + license verification.
- Synthesized docs/RESEARCH-V0982-ELEMENT-CATALOG.md:
  * PART A: the ratified 22-member set (user's 16 + editor box, list
    renderer, library card [user-anticipated, census-confirmed] + toast,
    meter, node [census-forced]) with fold decisions.
  * PART B: the complete catalog — every element on every screen mapped
    to one member (~400 elements, per-surface tables).
  * PART C: the border vs surface-raised evidence (8 file:line findings —
    the user's complaint confirmed) + the 10-vars -> FIELD model mapping
    table.
  * PART D: the library swap study — ADOPT culori (MIT, replaces
    shadeHex/mixHex/quantColor/OKLab blends), material-color-utilities
    (Apache-2.0, the image->palette pipeline), PixiJS extensions
    (NineSliceSprite/FillGradient/RenderTexture — already vendored),
    DTCG token format (the .doomtheme v2 keys). REJECT Shoelace/Lion/UI5,
    Style Dictionary runtime, node-vibrant, chroma. PRUNE wunderbaum
    (dead since v0.42), the .artt-* tree CSS shipped twice, keys.js rogue
    overlay + its hardcoded rgba(0,0,0,.48), localmodels duplicate X,
    .ts-star-on hardcoded #f5b642.
  * PART E: gradient text lag root cause (background-clip:text mask tax +
    fixed-attachment unsupported on Android WebView -> the L2 emulation
    cost) + the 3-tier verdict (ink never a window / static titles use
    local gradients / animated heroes use Pixi FillGradient).
  * PART F: how it feeds v0.99/v0.100/v0.101.

Stage Summary:
- The element catalog is the Batch-2 input the color plan was waiting for;
  the library study picks 4 adoptions (2 of them free — already vendored)
  and kills 6 homegrown/duplicated systems. Research only — nothing
  implemented.
---
Task ID: v0991-research
Agent: Z.ai Code (main orchestrator)
Task: The user's final-research turn for the color system: find every
  MIT/Apache library that replaces a homegrown piece of PLAN-V098-COLOR-SYSTEM
  ("choose a library over home grown"), diagnose the nested-box lag +
  the border/surface-raised edit-cost asymmetry + the variable confusion,
  and produce the build order. NO implementation.

Work Log:
- Re-cloned @ 21ec824 (rebased onto the parallel wave's v0.98.1 + v0.98.2
  mid-session; the census was reconciled against RESEARCH-V0982, not
  duplicated).
- Four parallel research agents: (1) the repo census — 91 vars, 701
  var-consuming rules, per-family usage, the overlap evidence, the colors-tab
  structure, the canvas path, the .doomtheme shape (docs/CENSUS-V099-SLOT-SCAN.md);
  (2) color engines; (3) UI primitives; (4) text/atlas/bundle security.
  Every license/size/version verified first-hand (npm registry JSON, raw
  LICENSE files, measured gzip of shipped dist files); artifacts in
  tool-results/v099-research/.
- Wrote docs/RESEARCH-V099-LIBRARY-SCAN.md — the consolidated decision record:
  5 NEW adoptions beyond v0982 (@floating-ui/dom 1.8.0 MIT 4KB — picker/
  select anchoring; @tanstack/virtual-core 3.17.11 MIT 7KB — catalogue/library
  windowing; fflate 0.8.3 MIT 12.6KB — the .doomtheme v2 zip container;
  maxrects-packer 2.7.3 MIT 3.3KB — the field-atlas packer; Ajv 8.20
  standalone MIT ~KBs — untrusted-bundle validation), the 8-rung import
  security ladder, the nested-box recipe (cv:hidden/auto + accordion caps +
  the L2 read guard), the WebView-111 CSS floor + @property guardrails,
  and 2 CORRECTIONS on v0982 (chroma.js is BSD-3-Clause code — not Apache;
  Pixi Text+FillGradient carries upstream bugs #10595/#10926, so the GPU
  text tier rides BitmapText/RenderTexture bakes instead; vendored Pixi
  verified as v8.21.0, not 11.x).
- The census adjudicated the user's reports: border/surface-raised edits fan
  over ~86/~110 rules incl. every L2 window + gate re-mint vs the canvas's
  one debounced atlas rebake (the asymmetry is real); 5 overlap findings
  confirm the variable confusion (25 dual-family rules, 74+ dividers painted
  with surface vars, border-as-fills, the entangled raised-ring, the
  surface-3 ghost).
- Wrote PLAN-V099-THE-FIELD.md — the build order: the 7-field model (raised +
  hairlines become derived color-mix products), the phase cadence v0.99.3-.7
  + v0.99.0 ship (vendor -> slots -> reassign -> tab -> nested boxes), the
  v0.100 MASKS (pseudo-only, plate 3->2 layers, gradient-text tiers, virtual-
  core, consolidations), the v0.101 ASSETS (fflate/maxrects/Ajv/MCU, 9-slice
  members, icon-pack registry, .doomtheme v2 + security), the new v0.102
  LIBRARY wave (public sharing, per-user bundle looks).

Stage Summary:
- The library question is CLOSED for the color system: culori + floating-ui
  land in v0.99.3 (27.3KB gz total); virtual-core in v0.100; fflate +
  maxrects + compiled validators + MCU in v0.101; everything else verified
  and rejected with evidence. GradientUI, the Field/Mask core, the panel
  drag, and the icon registry stay homegrown because the open-source world
  has not solved them (proof on record).
- Research only — nothing implemented. The census + these two docs are the
  complete input set for the v0.99 build.

---
Task ID: v099.3 + v099.4 (pushed)
Agent: Z.ai Code (main orchestrator)
Task: THE FIELD phases 3+4 — vendoring + the 7-slot model (per PLAN-V099-THE-FIELD.md).

Work Log:
- v0.99.3: culori 4.0.2 IIFE + Floating UI core/dom 1.8.0 UMD vendored (MIT, LICENSEs filed); theme.js gains FieldMath (cssMix + luminance, exported); scripts/v099-calibrate.js = the calibration tool (fits against the v0.98.0 tag).
- v0.99.4: index.html :root = @property (7 fields + accent-4) + THE DERIVATION BLOCK + the 10 [data-theme] blocks rewritten to field values (carrying accent-4/semantics/tints/triplet statics); theme.js = FIELDS/LEGACY_FIELD_MAP/foldThemeOverrides/DERIVED_MIXES/TRIPLET_VARS + the applyTheme rewrite (field twins + aliases + culori triplets + on-accent/veil/bright gates + field-owned grad gates) + GATES slimmed (ACC 3, SURF 1) + deriveBorderTwins RETIRED; appearance.js = 6 field rows (ink = plain color input) + fold-seeded + legacy-aware resets; app.js/atoms/pixiworld/browserdock resolve real hexes through the upgraded resolvedThemeVar (the @property rgb()/color-mix boundary); canvasFingerprint reads --field-canvas.
- THE OKLAB DECISION (rig-caught): Chromium's color-mix(in oklch) paints near-achromatic inputs hue-powerless (oklch(… none) → warm-gray, 7/255 off calibration on midnight/mono) — switched the derivations to color-mix(in oklab): identical calibration fits (hue-adjacent pairs), culori parity PIXEL-EXACT.
- Rigs: v099-field-parity.sh NEW (5/5: CSS≡JS worst 0/channel, drift ≤ 0.028, 10-theme cascade, triplets, zero errors); test_theme_twins re-pinned (196); v0911 re-pinned to the field contract (12/12); v098 panel 21/21 (257 nodes); v097 29/29; v092 13/13; go green.
- Browser-verified: boot clean, all 10 themes cascade, ink edit live-writes --field-ink (tints follow), accent gradient edit fires data-a1-grad + writes both twin spellings + storage holds field keys, lookio legacy round-trip folds, fmt gradients + light-theme veil flip correct.

Stage Summary:
- PUSHED: main 504ee975 → 925b5820 (v0.99.3) → 58957a81 (v0.99.4).
- Next: v0.99.5 THE REASSIGNMENT (the census walk: 74 dividers → --border, plate stacks 3→2, the title family → fmt-a1, glyph catchers die, the 16 text-vs-accent rules → ink/fmt, modelbrowser border-strong text → ink tint).

---
Task ID: v099 wave (repo record)
Agent: Z.ai Code (main orchestrator)
Task: v0.99.5-.7 + the v0.99.0 ship — the repo-side record.

Work Log:
- 208b0acc v0.99.5: the census reassignment (one hairline owner; 2-layer plates; accent-text ban; title family → fmt-a1; glyph death) — v099-reassign-audit 6/6 NEW.
- 442f9240 v0.99.6: the 7-slot Colors tab + the floating picker (Floating UI debut; GradientUI slim 8→2; grid+fmt folded in; 126-node mount) — v098 panel rig re-pinned 21/21.
- 7874c91a v0.99.7: the nested-box recipe (settled cv:hidden; ≤2 accordion; cv:auto rows) — v099-settings-open 6/6 NEW.
- 2dbcdee6 + tag v0.99.0-the-field + release: version 0.99.0; full battery green; CI (APK + desktop + HF Space) ALL SUCCESS.

Stage Summary:
- v0.99 THE FIELD is COMPLETE AND SHIPPED.
- Next: v0.100 THE MASKS per PLAN-V099: (1) the cheap consolidations (toast ×6→1, keys.js→Overlay, localmodels double-✕, amber star→accent); (2) the gradient-text tiers (title family → local-box clip — one paint, no per-scroll projection); (3) L2 pseudo-only (the legacy inline bake retires — the deep PROJ surgery); (4) @tanstack/virtual-core on the catalogue + hub grid.

---
Task ID: v1.00.1 (pushed)
Agent: Z.ai Code (main orchestrator)
Task: THE TOUCH FIX — the user-reported picker-dead-on-Android bug (the 6th #sheet-root recurrence), fixed at the root + the v1.00/v1.01 plan docs.

Work Log:
- Re-cloned @ af028270 (sandbox reset again); rebase check: no parallel-bot movement.
- Root-caused from primary sources (W3C Touch Events L2 §9, MDN, Chrome docs, Playwright source — evidence in /home/z/my-project/tool-results/v100-research/): the v0.99.6 .slot-pop popover is body-appended → isInsideUI never learned it → touchstart preventDefault → the synthetic click suppressed → every click-wired control dead on touch; mouse clicks fire regardless (why every desktop rig was blind — Playwright #2903's own note).
- THE FIX — THE POSITIVE LIST (app.js): isInsideUI RETIRES; the canvas input owns ONLY #c + #chatbots (panel.js _wireDuck's v0.69 pattern). Touch/mouse/wheel/contextmenu gates flip to !onCanvasSurface → return. The class dies at the root: every present AND future body-appended overlay gets native taps. Wheel over the popover now scrolls it (the mouse twin, same fix).
- index.html: the popover's sticky head top:-12px → 0 (the ✕ VANISHED mid-scroll — pinned above the scrollport, clipped; the rig caught it); touch-action: manipulation on .slot-pop.
- THE REAL-TOUCH RIG (scripts/v1000-touch-test.mjs + v1000-touch-tap.sh): Playwright hasTouch + tap() = trusted CDP touches + raw CDP drag sequences; 19 assertions (class-death proof: a stop added by a real tap + touchstarts NOT prevented; refactor proof: canvas pan + preventDefault still engage; popover scroll; wheel twin; zero errors).
- NEGATIVE CONTROL PROVEN: against the old code the rig fails 6 (T3a/b/c, T4a, T7c, T8b — exactly the bug class); with the fix 19/19.
- DISCOVERED + documented: the Go build cache does NOT invalidate on embedded-file changes (measured: stashed web/app.js → fresh go build → binary served the OLD assets) — the wrapper now always builds with -a. Every rig that assumes a prebuilt binary after web-asset edits runs stale.
- Full battery green: touch 19/19 · twins 194 · uikit 140 · go vet+test 8 pkgs · v099 5/6/6 · v098 21/13/10 · v097 29 · v092 13 · v0911 12.
- PLAN-V100-THE-MASKS.md + PLAN-V101-THE-ASSETS.md written (the research-backed wave plans; BitmapText gradient = broken in pixi 8.21 (1px atlas span, verified from dist source) → the generateTexture bake; virtual-core vanilla wiring; the .doomtheme v2 ladder).

Stage Summary:
- PUSHED: main af028270 → 5554349e (v1.00.1). CI builds the APK with the fix.
- Next: v1.00.2 gradient-text tiers (the bake) → v1.00.3 L2 pseudo-only → v1.00.4 virtual-core → v1.00.5 consolidations → v1.00.0 ship; then v1.01 THE ASSETS.

---
Task ID: v1.00 + v1.01 waves (repo record)
Agent: Z.ai Code (main orchestrator)
Task: The user order: push v1.00 + v1.01 together; fix the picker overlay that doesn't register touches. Iron law per phase: plan → web search → real plan → build → red-team with real tests.

Work Log:
- 5554349e v1.00.1: THE POSITIVE LIST — isInsideUI retires; the canvas input owns ONLY #c + #chatbots; the #sheet-root class dies at the root (6th recurrence was the v0.99.6 popover). THE REAL-TOUCH RIG (v1000, Playwright hasTouch + CDP): 19/19 with the fix, 13/19 against the old code (negative-control proven). + the sticky-head top:0 fix (the ✕ vanished mid-scroll) + touch-action: manipulation. LANDMINE documented: the Go build cache does NOT invalidate on embedded web-asset changes — rigs must go build -a.
- 6f4abf8b v1.00.2: THE GRADIENT-TEXT TIERS (PART E) — the fmt family + the title family + the 2 accent-glyph stragglers drop background-attachment: fixed (local-box, one paint, zero projection; clip:text can never ride L2); the object track untouched. v1002 rig 6/6 (drag with live gradient text = ZERO longtasks).
- e2fb1c0b v1.00.3: THE PHANTOM PURGE — painted-set hygiene (image-none riders leave the set; the set-theme swatch class caught live with instrumented builds: the v0.98 flat-gradient plate catcher computes non-none in a mid-flip transient). The legacy-bake retirement proven (v1003 rig 5/5: every VISIBLE painted element rides L2). THE OFFSCREEN MINT prototyped + REVERTED (exposed a pre-existing settings-page-render/root-registry race — future wave, documented).
- 2ca3729d v1.00.4: @tanstack/virtual-core 3.17.11 vendored + loaded (window.VirtualCore, browser-verified). The WIRING = its own wave (the catalogue's DOM is already PAGE-capped — the anti-spaghetti call).
- 191893b7 v1.00.5: THE CHEAP CONSOLIDATIONS — toast ×8 → uikit DoomToast (delegates, zero call-site churn); keys.js rides THE OVERLAY SCREEN (the last hardcoded rgba(0,0,0,.48) scrim dies); the localmodels double-✕ gone; the amber ts-star themed (var(--warn) + triplet).
- 9e3bcc1e + tag v1.00.0-the-masks: version 1.00.0 SHIPPED. Battery: go 8 pkgs · v1000 19/19 · v1002 6/6 · v1003 5/5 · v099 5/6/6 · v098 21/13/10 · v097 29/29 · v092 13/13 · v0911 12/12 · twins 194 · uikit 140.
- 1f451188 v1.01.1: THE ASSETS VENDORS — fflate 0.8.3 (MIT UMD) + maxrects-packer 2.7.3 (MIT ESM .mjs — the dist min.js is plain CJS, ReferenceErrors in the browser) + material-color-utilities 0.4.0 (Apache-2.0, the +esm single-file). All browser-verified (fflate zip round-trip; MCU image→SchemeContent end-to-end; MCU.sourceColorFromImage needs a real IMAGE element — a canvas hangs its load path).
- 36cf2709 + tag v1.01.0-the-assets: THE IMAGE→PALETTE SUGGESTER — the canvas picker: pick an image → MCU quantize+score → SchemeContent dark-first → the 6-swatch proposal → apply writes the 7 fields (one-runtime-truth: MCU is generation-time only). v1012 rig 7/7 (real file upload end-to-end). Version 1.01.0.

Stage Summary:
- BOTH WAVES SHIPPED: v1.00.0-the-masks + v1.01.0-the-assets (CI building the APKs).
- The user's touch bug is FIXED AT THE ROOT and negative-control-proven.
- NEXT (per PLAN-V101): the field atlas (maxrects, 2048² clamp, MAX_TEXTURE_SIZE query), the 9-slice/icon registry, the .doomtheme v2 zip container + the 8-rung security ladder; then the virtual-core wiring wave; then v1.02 THE LIBRARY.

---
Task ID: v1.03.0 (the wave ship)
Agent: Z.ai Code (main orchestrator)
Task: THE EDITOR & THE PROJECTION — the user's 4-point color system order, shipped as one wave.

Work Log:
- v1.03.1 THE CARD (60a903d5): the flat --card derivation + the full nested-element reassignment; v1031 16/16 (re-pinned through the wave for the editor path).
- v1.03.2 THE TEXT STYLE PROMOTION (a9ab6daa): its own collapsible section; the v0.99.6 fmt-label regression fixed; v1032 10/10.
- v1.03.3 THE THEME EDITOR (2512b1a7): the reusable panel page + the tagged registry + the Overlay list; v1033 15/15.
- v1.03.4 THE WHEEL (2d3bf77f): the CSS-composed HSV disc + the H/S/V sliders + common/last-used; the fmt entries; the popover retired; v1034 11/11.
- v1.03.5 THE UNIVERSAL ANGLE (47fed386): linear/radial-orbit/mesh-rotation/pattern-transforms in css() + the canvas rasterizer (the worker shares lattice.js); the legacy dir normalization; v1035 10/10.
- v1.03.6 THE DOOM PROJECTION v2 (aef26551): the toggleable 2D canvas field projector — the crawl discovery, the override sheet, the once-per-theme field rasters, the 9-arg crop loop; v1036 10/10.
- SHIP: tag v1.03.0-the-editor + the release (CI: APK + desktop + HF Space all SUCCESS; 4 assets attached). The battery: v1031-v1036 + v098 24/24 + v1015 15/15 (L2b re-pinned: the v2 module replaced the stub BY DESIGN) + v099 5/6/6 + v1000 19/19 (re-pinned to the editor contract) + v1003 5/5 + twins 199 + uikit 140 + go (TestScreenshotRealRender fails on PRISTINE v1.02.0 in this sandbox — the reaper kills its Chromium; environmental, documented).
- LANDMINES: the browser daemon wedges under battery load (pkill -9 -f agent-browser resets; NEVER let a rig hit the bash timeout mid-command); engines must be script-spawned; the browser session's localStorage outlives the server data dir.

Stage Summary:
- THE 4-POINT ORDER IS DELIVERED: the card material, the text-style section, the Theme Editor (layout + wheel + types + universal angle + the tagged registry), and the doom projection v2 (the toggleable shared-field projector).
- The user's ask "render them once not once per element" is literal in the v2: one bitmap per field, one drawImage per consumer.
- Residue for the next wave: the pixiworld pill field bridge (the pills paint locally — the 56px precedent), the virtual-core catalogue wiring, the DTCG token namespacing, the settings-page/root-registry race (the v1.00.3 leftover).

---
Task ID: v1.04.0 (ship)
Agent: Z.ai Code (main orchestrator)
Task: The v1.04 wave — the user's five Theme-Editor fixes + THE RESTORE (the broken canvas doom projection deleted; the pre-v1.01.5 viewport-projection system ported back onto the field twins). The ship record.

Work Log:
- v1.04.1 THE FIVE FIXES (5d53b786): the wheel touch channel (gesture.js's ownsGesture + THE CHANNEL GATE — the body touchstart doesn't even record owned channels), the type tiles (the distinct outline family + inline SVG glyphs — the ⌧ tofu dead), the live angle banner (direct style writes + the makeWriter spec-pollution fix), the texture/import separation (the type selects; the row browses), the reset arrow (reset-before-open in the delegated handler).
- v1.04.5 THE RESTORE (d8e84f86): doomprojection.js replaced wholesale — the canvas system deleted, the pre-v1.01.5 painter ported (the transform-proof bake, the batched read/write paint, the L2 compositor layers, the observer family) + THE DOOM SHEET (the toggle's derived fixed-attachment mint with THE GATE MERGE) + THE ALLOW-LIST (the fmt text track + the derived solids never mint) + the full teardown (OFF = the v1.01.5 local light, byte-identical).
- THE REBASE DANCE: the parallel bot's shadow wave (v1.04.2/3/4: elevation tokens, shadow sweep, fallback canon) landed mid-session — three rebases, one silent wrong resolution (rebase --ours is the BASE branch — the rig caught the canvas stats shape), the restore recovered + re-proven.
- THE VERDICTS: v1042-the-restore 16/16, v1041 16/16, the full battery green on the FINAL merged tree (v1033/34/35/32/31, v1015, the bot's v1042-elevation 6/6 + v1043-shadow 5/5, v1000 19/19, v098 24/24, twins 199, uikit 140, go server). VLM: the seamless shared field confirmed, zero artifacts.
- THE SHIP: tag v1.04.0-the-restore — CI all green (the APK + the 3 desktop binaries + the HF Space); the release carries all 4 assets.

Stage Summary:
- The user's whole order delivered. The doom projection is the RESTORED system (toggleable in the Colors tab), not the broken canvas.
- Landmines banked: rebase --ours/--theirs is swapped vs merge (rig-caught); the agent-browser pool wedges need pkill -9 between batches; rig scroll assertions must force real deltas.
- The v1.05 candidates: the pixiworld pill bridge (the projection for the canvas pills), the root-registry race on fast overlay opens, the L2 layer-count budget on very long transcripts.

---
Task ID: v1.04.2-.5 + v1.05.0 ship (the discipline wave)
Agent: Super Z (main orchestrator)

Work Log:
- v1.04.2 THE ELEVATION TOKENS (455135d7): --shadow-ink = color-mix(in oklab,
  var(--field-canvas), #000 55%) in the derivation block + the --shadow-ink-rgb
  triplet (JS twin in applyTheme; the OKLAB mix lands at rgb(2,2,2) — the naive
  linear-RGB guess was wrong, the rig caught it). v1042 rig 6/6 (CSS≡JS parity
  via a srgb-forced probe; the live canvas-override → shadow re-tint proof).
- v1.04.3 THE SHADOW SWEEP (5f554b36): all 37 index.html literals + JS
  stragglers → rgba(var(--shadow-ink-rgb), α) exact-alpha parity; text-shadows
  → veil-ink; inset rings → --highlight-inset-rgb; the fmt h1 hairline →
  --border; hub.js ink-on-art upgraded to WCAG relative luminance +
  higher-contrast pick. v1043 rig 5/5 (grep gate + the live consumer proof).
- v1.04.4 THE FALLBACK CANON (2e5abe6f): DoomTheme.FALLBACKS = the one literal
  map; 12 consumer files re-pointed; settings.js seeds as CANON-TWINs (loads
  before theme.js — load-order fact); the atoms.js triplet-slot latent bug
  fixed. LEGACY_GRID exposed as the sentinel owner after the rig caught the
  reset-path first cut pinning the grid (FALLBACKS.canvas ≠ the sentinel).
- v1.04.5 THE ENFORCEMENT (7d246e21, rebased onto the parallel v1.04.0-the-restore
  wave — the fetch/rebase/merge protocol caught their 2 commits mid-flight):
  v1040-discipline-audit.sh 7 gates (the two rules fail builds now);
  docs/DISCIPLINE.md (the canonical zones + the surface ledger + the
  artifacts-sheet decision + the z-ladder); v1045-redteam.sh 11/11 (the
  human-imitation journey on both theme polarities — paper shadow ink
  (84,83,81) vs midnight (2,2,2); the purple-canvas shadow hue-follow; the
  reset-sentinel contract; zero console errors).
- SHIP v1.05.0-the-discipline: buildinfo 1.05.0 + tag + release (CI APK).
- Battery: v1040 7/7 · v1042 6/6 · v1043 5/5 · v1045 11/11 · v1031 16/16 ·
  v098 24/24 · twins 199 · uikit 140 · go green.

Stage Summary:
- THE TWO STANDING RULES ARE SELF-ENFORCING: no hardcoded chrome colors
  outside the documented canonical zones (the audit fails on new ones), and
  every front-facing surface rides the Panel / the Overlay Screen / the
  documented chrome ladder. Shadow color is a theme product. The next
  improvement on these axes would be the DTCG namespacing refactor — noted
  as FUTURE residue; doing it now would be the spaghetti the user capped.

---
Task ID: v1.06.0 ship (completion)
Agent: Super Z (main orchestrator)

Work Log:
- v1.05.1 THE GLASS WINDOW: gesture.js writeVis → element-scoped height on .panel-body (the per-frame inherited-var subtree sweep is dead; the var rides only while the projection is enabled). BENCH on the same tree: 12-14x cheaper per frame.
- v1.05.2 THE STUCK SWITCH: setEnabled commit-first + rollback + self-heal on DOM traces; stage-guarded teardown + registry-independent orphan sweep ([data-proj] + new [data-proj-bake] markers); paint() strips disconnected windows (the view-stack resurrection leak); the vis-var seed at enable.
- v1.05.3 THE PROOF: scripts/v106-fluid-wave-test.py — 22 checks, both trees. BEFORE: 4 genuine failures (the stuck switch reproduced; the stash leak; the var residue). AFTER: 21/21 (the plan's 22 checks + the CTA count). The look: panel-region delta 0.22%.
- Pushed 6350a0a2..821a12a3 (3 phase commits); no parallel movement at fetch time.

Stage Summary:
- The wave ships as v1.06.0-the-fluid-wave (tag next) — the panel glide rides the compositor, the toggle cannot wedge, the projection's toggle-off is registry-independent.

---
Task ID: v107-wave
Agent: Super Z (main)
Task: THE CANVAS OPT WAVE (PLAN-V107) — the user's three asks: (1) the grid
still not 60fps + visible tiling, bake everything not moving (O(k)); (2)
below ~30% zoom (up close) the grid over-calculates and snaps — fix
thoroughly, ideally predetermined paths; (3) restore life — more dynamic,
very few points/lines moving fast, tiling no longer perceivable.

Work Log:
- REBASE: local tree was f4a8353a + the unpushed v0971 wave — the parallel
  bot landed v0.98.1 (= the same issues 1-3 scope) plus v0.99-v1.06.0 (the
  FIELD color system, the editor, the restore, the discipline, the fluid
  wave). Hard reset to origin/main c2d1ff1f; nothing of mine was lost.
- MEASURED the worst-case doom grid live (headless 412×915): 29 tile fills
  per full frame, 15fps at rest (the v0.97 ambient cadence gate), 6
  rebakes inside one pinch sweep (pending=true mid-gesture), VLM-confirmed
  tiling period ~1.5-2 screens. Root causes code-proven: bgKey (bgView.zx)
  churns the bake fingerprint EVERY FRAME once scale>1; colors sample
  through the LIVE bgView fold at bake scale (the color snap); the cheap
  frame wiped #c2 without repainting the over layer (the icons' front
  layer vanished/flickered at rest).
- RESEARCH: RESEARCH-V084's standing verdict holds (canvas2d + worker +
  createPattern; Pixi owns the conditional world layer; no second WebGL
  context for the grid). MDN CanvasPattern.setTransform; multires LOD
  ladders (mipmaps/krpano analog); game-art repetition wisdom (period ≥
  2-4× viewport or break with a second scale).
- v1.06.1 THE ZOOM LADDER (a82d094d): reference-space color sampling
  (zoom-stable), bgKey OUT of the fingerprint, canonical level bakes
  (level = 1.25× quantum of scale; set = pure function of params+level),
  LRU byte-capped ladder cache (TL_BUDGET 96→32MB per set, cap 128MB),
  async-only bakes (onBakeReady → repaint-wanted), levels floored at 0
  (zoom-out rides level 0 supersampled), ladder instruments. Storm dead:
  full 6× sweep = 4 async bakes (was 6+ synchronous), fast fling = 1,
  pan = 0, warm revisits = instant.
- v1.06.2 THE FILL DIET (bb73c29c): the bg mirror-quad (2×2 flipped
  arrangement baked once → ONE pattern fill; BG_TILE_MULT 2→1.35) +
  over-tiles for the top band only (29→21 fills; the v0812 contract
  verified live: dots+lines still route at amp≥50).
- v1.06.3 THE LIFE WAVE (bb1c4bd2): renderOverLayer (the cheap frame is
  lossless for #c2 — the vanish/flicker fix), the modulation field (256²
  theme-tinted value noise, soft-light, 320-cell period, 0.9× parallax +
  2.5px/s drift — the tiling kill), comets (≤3, 4-10s apart, glowing
  heads + gradient tails), twinklers (~5% of cells, some fast blinkers),
  cadence 66→33ms, TEMPO 0.6, hero pulse spread 1.8→3.4, cometsLive rides
  the 60fps cheap-frame gate. VLM: organic large-scale variation, no
  tiling read, premium maintained.
- v1.06.4 THE PROOF: scripts/v107-canvas-proof.sh 15/15 (storm dead, budget
  holds, grid alive, theme owns everything, zero errors). Battery: v1040
  7/7, v0899 12/12, v0852 14/14 (RIG REPAIRED — the camera-pan assert was
  proven PRE-EXISTING-failing on the untouched v1.06.0 tree; the rig's
  document-level synthetic mousedown is correctly rejected by
  onCanvasSurface; the repair targets #c like a real finger), v0831 13/13,
  v0812 7/7, v0901 15/15, twins 199, uikit 140, go test green.

Stage Summary:
- THE THREE ASKS ANSWERED: (1) 29→21 fills + one-fill bg + async-only
  bakes — the 60fps path is structural; (2) deep zoom = predetermined
  level swaps (a seen level is ZERO work; unseen = one async bake, ever)
  — no snap (geometry exact through swaps; sharpness-only landings);
  (3) the field modulates (soft-light, 320-cell period), comets fly,
  twinklers blink (some fast), the breath runs 2× faster at 30fps ambient
  — tiling no longer perceivable (VLM-verified).
- The wave completes at v1.07.0 (the left dot moves). CI builds the APK.
- NOT done (deliberate, anti-spaghetti): band merging (AMP_BANDS stays 5 —
  the parallax depth reads), negative zoom-out levels (level 0
  supersampling is free), cross-faded level swaps (the ≤1.12× sharpness
  delta is invisible), comets during zoom-out extremes only skipping
  twinklers below 10px spacing (density guard).
Task ID: v1.06.0 CI + release
Agent: Super Z (main orchestrator)

Work Log:
- CI on the tag: Build Desktop ✅ · Build Android APK ✅ · Build HF Space ✅.
- Release live: v1.06.0-the-fluid-wave — app-debug.apk 22.9MB + 3 desktop binaries.

Stage Summary:
- WAVE SHIPPED. The panel's motion cost is compositor-shaped (12-14x cheaper per frame), the projection toggle cannot wedge, and the proof rig is permanent at scripts/v106-fluid-wave-test.py.

---
Task ID: v1.07.0 ship (completion)
Agent: Super Z (main orchestrator)

Work Log:
- v1.06.1 THE SURFACE EXEMPTION: PROJ_RE drops surface-1 — the panel body
  + overlay card (the viewport-sized, most-rebaked windows) render their
  gradients LOCAL in both toggle states; the accents keep projecting.
- v1.06.2 THE TEXT FIELD: fmt-[a-z0-9]+ joins PROJ_RE + ROOT_GATE_RE
  merges the [data-fmt-grad~=…] gate — the Blink probe proved fixed +
  background-clip:text coexist; in-panel text rides the legacy bake.
- v1.06.3 THE CHROME FOLLOW + THE WHITE PILL + THE LIVE SWITCH:
  · the white pill ROOT-CAUSED on the rig: the carry branch's
    unconditional inline image/color strip deleted the metadata pills'
    OWN tint (the [style*=] catchers lost their match → the UA
    buttonface gray); the L2 suppression also REPLACES the author's
    values. THE OWNERSHIP LAW: the painter strips only painter-written
    props (__projSuppressed); the author's background is SAVED at
    suppression (restoreAuthorBg) and RESTORED at drop/strip; zero-rect
    carries take constants only.
  · the chrome-follow: :where(html[data-doom-proj][data-s1-grad])
    windows the Layer-3 family + .app-range track/thumb on the surface
    field LOCALLY (zero painter cost — surface is out of the allow-list).
  · the live switch: wireInputs syncs the app-switch track/thumb in
    place — the doom projection pill updates without a settings reopen.
- v1.06.4 THE SHADOW & THE HIGHLIGHT EXPOSED: --field-shadow /
  --field-highlight override slots (the Colors tab's Shadow + Highlight
  rows, seeding from DoomTheme.derivedShadowHex/derivedHighlightHex);
  applyTheme: override wins, default rides the CSS color-mix/static.
  The v1045 redteam joined the on-disk doctrine (v1045-mix-serve.py —
  the stale embedded tree was reading empty tokens; 11/11 after).
- THE REBASE PROTOCOL caught the parallel canvas-opt wave (their
  v1.06.1-.3: zoom ladder / fill diet / life wave) mid-ship; rebased
  amicably — zero file overlap with this wave; the rig re-ran 22/22 on
  the merged tree.

Stage Summary:
- THE WAVE SHIPS as v1.07.0-the-selective-field — the projection is
  selective (surface local, text + accents + chrome in), the painter's
  hands are owned, the switch is live, the elevation tokens are
  user-editable. Battery: v107 22/22 · v106 21/21 · v1045 11/11 ·
  v1040 7/7.

---
Task ID: v1.08.1 CI + release
Agent: Super Z (main orchestrator)

Work Log:
- THE SHIP RACE, twice over: the rebase protocol caught the parallel
  canvas-opt wave mid-ship (their v1.06.1-.3 phases, then their
  v1.07.0-the-canvas-opt-wave ship) — rebased amicably both times (the
  only conflicts: buildinfo's Version line + the shared worklog). The
  ledger shifted: this wave ships as v1.08.1.
- v1.08.0's APK CI died in the stamp step: MINOR "08" is an invalid
  OCTAL literal in bash $(( )) (05/06/07 silently worked). v1.08.1
  fixes the workflow with 10# forcing.
- A stale v1.07.0-the-selective-field tag + release (created by the
  first partially-rejected push) was deleted on the remote.
- CI on v1.08.1: Build Android APK ✅ · Build Desktop ✅ · Build HF
  Space ✅. Release live: app-debug.apk 22.9MB + 3 desktop binaries.

Stage Summary:
- WAVE SHIPPED. Battery on the shipped tree: v107 rig 22/22 · v106
  fluid 21/21 · v1045 redteam 11/11 (on-disk doctrine) · v1040
  discipline 7/7.

---
Task ID: v1.09.0 ship (completion)
Agent: Super Z (main orchestrator)

Work Log:
- THE SEAMLESS FIELD wave (PLAN-V109-THE-SEAMLESS-FIELD.md) — the user's
  four reports + two research asks, four phase commits:
- v1.08.2 THE STEADY HAND: the pill oscillation root-caused on the rig
  (painted-series [1,7,1,7,1,7]) — the L2 suppression rewrote the inline
  background-color, BREAKING the [data-aN-grad] [style*="background-color:
  rgba(var(--accent-N-rgb)"] catcher that matched the pills into SEL; the
  next paint dropped them, the restore re-spelled them, the paint after
  re-baked — the projected↔local flicker. Fix: the READ phase's per-element
  body is a shared closure; suppressed windows re-enter it (a painter asset,
  not a stranger) + THE OWNERSHIP TEST (the snapshot lifts the color too +
  carries the computed attachment; a suppressed element the CSS claimed
  locally yields: stats.yielded).
- v1.08.3 THE FULL SPECTRUM: the settings toggles + sliders wear the FULL
  gradient at box scale. THE GATE-WINDOW LAW: gate-led rules declare
  attachment:local !important — the minted plain fixed can never out-rank
  it and the painter's first-encounter probe opts the element out (zero
  painter cost). Checked tracks = the accent field; unchecked = the LAYERED
  window (surface live → surface; surface flat → the accent shows through
  a surface-3 veil); sliders = the same layered window. The doom-switch
  rule generalizes; the thumb stays solid (the pseudo-strip leak — refused).
- v1.08.4 THE SEAMLESS FIELD: the Layer-1 rule painted the SAME local
  gradient on THREE stacked boxes (header restart = the tiling report).
  ONE field, THREE windows: shared --panel-field-h scale, the header/body
  windows offset by --panel-head-off/--panel-field-top; gesture.js syncs
  at rest through a CSSOM rule (#panel-field-vars — observer-invisible),
  debounced behind writeVis; the closed sheet keeps its last geometry;
  fallback = the exact v1.08.1 look.
- v1.08.5 THE COAST: the text lag root = the legacy bake's per-event
  writes (scrollRebake: ~1400 writes / 14 scroll steps / 129 windows —
  rig-measured) + the per-frame var recalc/raster during the drag. Text
  windows now COAST (flagged at decision time INCLUDING the carry path —
  the rig caught two storm shapes: the reset-on-steady-paint flag and the
  un-flagged carries); scrollRebake skips them; first sight still bakes
  once; the motion edge performs ONE batched disconnect; paint() un-coasts.
  RESEARCH: no OSS library changes the math (they all ship clip:text) —
  docs/RESEARCH-V109-TEXT-AND-PANEL-PERF.md.
- Battery on the shipped tree: v109 rig 30/30 (NEW, permanent) · v107
  22/22 (the fmt-h2 check updated for the coast contract: first-sight
  bake) · v106 21/21 · v1045 11/11 · v1040 7/7 · uikit 140. The twins
  suite: 198/199 — the "page 6 slot banners" assertion FAILS ON THE
  UNTOUCHED v1.08.1 BASELINE TOO (proven pre-existing, out of scope).
  go test rides CI (no go toolchain in this sandbox).

Stage Summary:
- THE WAVE SHIPS as v1.09.0-the-seamless-field. The projection's pills
  hold one steady bake, the toggles/sliders show the full gradient, the
  header continues the body's field, and projected text costs nothing
  during motion. Next session: sideload the APK, re-judge the flicker +
  the toggle/slider look + the header seam + the panel glide with
  projection ON.

---
Task ID: v1.10.0 ship (THE WEIGHTLESS WAVE)
Agent: Super Z (main orchestrator)

Work Log:
- THE WEIGHTLESS WAVE (PLAN-V110-THE-WEIGHTLESS-WAVE.md) — the user's
  four v1.09.0 post-ship reports, four phase commits:
- v1.09.1 THE DRIFT COAST: the anchor glide's remaining cost = the
  per-frame inherited-var invalidation sweeps (the --proj-tx/--proj-ty
  CSSOM rule writes per root per frame), the shrinking slide's scroller
  clamp firing scrollRebake per frame, and ANY mid-glide paint un-coasting
  the text back to var form (re-arming the per-frame glyph rasters). The
  coast generalized to the WHOLE field: motionTick returns while coasting
  (the L2 transforms hold their rest compensation — everything rides
  rigidly, the text coast's own drift contract), scrollRebake gates on
  coasting, coastText covers every LEGACY window (text incl. the vis form
  + the non-L2 fallbacks; one cached matrix read per root per edge), the
  setVars same-value guard, and run() defers full paints while a motion
  window is open + the gesture stamp is fresh (the settle lands one frame
  after the window closes; its trailing motionTick re-syncs the vars).
- v1.09.2 THE FULLSCREEN FIELD: --panel-field-h = the FULL-DOCK extent
  (fieldTop + visForY(0)) instead of the current dock's bodyH — docking
  anywhere REVEALS a sub-window of the one fullscreen field; the no-repeat
  extent is >= every window, so the ink leak is geometrically impossible;
  per-dock re-syncs die (the performant shape the user prescribed).
- v1.09.3 THE STILL HAND: the zoom ladder's bake never arms mid-gesture —
  the hosts report the zoom-gesture state per frame (zg: pinch active or
  a wheel burst within 200ms), the worker holds, the stretched current set
  renders (exact by world-proportionality), and the RELEASE frame (the
  two->one-finger transition — the rig caught that CDP and real fingers
  lift one at a time; the touches===0 branch never saw pinching true)
  arms the debounce — ONE bake ~150ms after settle.
- v1.09.4 THE RARE SKY: comets 4-10s -> 18-44s (cap 3 -> 2, first spawn
  6-16s), three size/distance classes (FAR 60% thin dim fast background /
  MID 30% / NEAR 10% thick bright slow foreground) with the tail width,
  head glow and the parallax factor spread per class; lastComet rides the
  debug blob (the instrument). Zero new color literals (the gate holds).
- THE RIG: scripts/v110-weightless-wave-test.py (permanent) — §A the drift
  coast (frozen vars per frame pair, single-step settle paints, the defer
  counter, the settle re-anchor) · §B the fullscreen field (dock-independent
  scale, the extent covers every window, the header shares the scale) ·
  §C the still hand (bakeGen frozen mid-gesture for pinch AND wheel, one
  settle bake each) · §D the rare sky (first spawn >= 5s, <= 3 in 46s, the
  class bounds). The v110-zoom-probe.py caught the release-frame miss.
- Battery on the shipped tree: v110 rig 22/22 (NEW) · v109 30/30 · v106
  21/21 · v1045 11/11 · v1040 7/7 · uikit 140 · twins 198/199 (the
  pre-existing page-6-slot-banners baseline failure, documented).
  v107-canvas-proof: 13/15 on the STALE embedded binary (07:27 build; no
  go toolchain in this sandbox to re-embed the current tree — the rig
  hits the engine port directly, unlike the on-disk v106/v109/v110 rigs).
  Its two fails (rest-cadence FPS under load, theme-flip sampling) are on
  that stale snapshot; its zoom-storm contract is SUPERSEDED by the v110
  §C proof on the disk tree (bakeGen frozen mid-gesture is strictly
  stronger than "no frame pays a bake").

Stage Summary:
- THE WAVE SHIPS as v1.10.0-the-weightless-wave. The glide is compositor
  work + one layout write, the surface field is one fullscreen material
  that docks reveal instead of re-fit, the zoom gesture recomputes nothing
  and lands one sharp bake at settle, and the sky is quiet and varied.
  Next session: sideload the APK, re-judge the glide with projected text,
  the field at every dock, the pinch feel, and the star cadence.

---
Task ID: v1.12.0 (THE BREATHING FIELD)
Agent: Super Z (main orchestrator)

Task: The user's four v1.10.0 post-ship reports — (1) the projection
updates once at rest (should be ~2Hz) + "the panel itself gets slower
the more custom colors it holds… the canvas itself feels slow to
respond", (2) revert the sliders (narrow, clean; the gradient or the
first color), (3) comets only when scatter > 0.4 and x10 rarer, (4)
amplify parallax must reuse the existing dots/lines (no new brighter
stars, nothing over the icons) and amplify the parallax while zooming
AND panning.

Work Log:
- THE PROFILER first (the user: "I don't know why"): v111-perf-probe.py
  — two theme configs (LEAN default vs RICH many-custom-colors), real
  CDP input, raw-websocket devtools.timeline traces (playwright filters
  the Tracing domain — the honest timeline needed a second, direct CDP
  connection). Findings: the glide's dominant cost is style recalc
  (UpdateLayoutTree 445-524ms/window) driven by the per-frame inherited
  --panel-vis-h write, plus a gradient raster storm in rich themes
  (RasterTask 31 -> 1029 events) — the per-frame var re-resolve of
  every painted window whose formula calcs the var. JS measured
  near-idle (the user's own exoneration of doom projection's JS).
  Canvas pan/zoom measured clean.
- v1.10.1 THE BREATH: run() allows a full re-anchor paint every 500ms
  while a motion window is open (the user's exact cadence); the coast
  still freezes between breaths; the settle lands exact.
- v1.10.2 THE HONEST SKY: decoded the amplifier's three mis-features on
  the tree — the amp-only hero fireflies (tiled, bright, over icons),
  the static glow (brighter than the amp-0 grid), the over-icons split
  (sizeVar >= 80 over icons). All retired; the band split (the same
  dots/lines at per-depth parallax) stays. Comets: the scatter > 40
  gate (the user's 0.4 on the app's 0-100 sliders) + x10 cadence
  (180-440s, first 60-160s).
- v1.10.3 THE TRUE DEPTH: per-band zoom parallax — each band's drawn
  period scales by S^((pf-1)*kZ): the planes diverge under zoom,
  world-true at scale 1 and amp 0; pattern-matrix math only.
- v1.10.4 THE NATIVE HAND: the slider gate rules retired; native
  rendering returns; accent-color = var(--accent) = the first gradient
  stop (research: accent-color is <color> only — the user's accepted
  fallback). Toggles keep the full spectrum.
- v1.10.5 THE MEASURED FIX: the inherited var lands at most every 500ms
  during motion and always at the rest writes; the layout stays exact
  per frame (the element-scoped inline height). Measured: UpdateLayout
  Tree 445.7 -> 71.1ms (lean) / 524.5 -> 110.3ms (rich).
- THE RIG: scripts/v111-breathing-field-test.py (20 checks — the breath,
  the coast between breaths, the honest sky, the comet gate, the zoom
  depth incl. byte-flat-at-zoom, the native hand, the var throttle).
  The pinch needed a corridor-checked center + a quiet-canvas gate (a
  CDP simultaneous lift and an icon under a finger both eat gestures —
  the chase is documented in the rig).
- Battery on the shipped tree: v111 20/20 (NEW, permanent) · v110 22/22
  (§A writes/bumps + §D cadence asserts updated to the breath + x10
  contracts, documented) · v109 30/30 (§B slider + §D_motion asserts
  updated to the native-hand + breath contracts, documented) · v106
  21/21 · v1045 11/11 · v1040 7/7 · uikit 140 · twins 198/199 (the
  documented pre-existing page-6 baseline failure).
- SCOPE BOUNDARY (the spaghetti line): the remaining rich-theme glide
  raster storm is inherent to fixed-attachment gradients on elements a
  resizing panel repaints — layer-promoting every painted window would
  trade main-thread paint for N viewport-sized GPU layers on a weak
  device (memory + swap); documented, not built.

Stage Summary:
- WAVE SHIPS as v1.12.0-the-breathing-field (the parallel bot's HF TRUTH WAVE took v1.11.0 mid-flight; the rebase-before-push protocol merged amicably — no file overlap beyond the buildinfo version chain). The projection breathes at
  2Hz mid-motion, the amplifier keeps only the honest parallax (plus
  zoom depth), the sky obeys the scatter gate at x10 rarity, the
  sliders are native again, and the measured recascade storm is gone.
  Next session: the user sideloads the APK and re-judges the glide feel
  with many custom colors, the amplifier look, the comet rarity, and
  the native sliders.

---
Task: v1.13.x-v1.14.0 THE MCP WAVE (PLAN-V113 — the mcp-go conviction)
Agent: the MCP bot (mark3labs/mcp-go replacement of the ACTION tool system)

Work Log:
- v1.13.1 THE BUS: the mcpbus lands as pure addition — 28 tool Defs as the
  single source of truth, the in-process MCP client, Observer hooks, Turn
  ctx plumbing; CI go 1.23 -> 1.25.5 (mcp-go v1.1.1 requires it).
- v1.13.2 THE HANDOFF: the chat loop runs the MCP bus as the PRIMARY tool
  path (BusFailure -> sticky direct-dispatch fallback; tools-rejecting
  providers blacklist + answer honestly without tools); ChatRequest gains
  SessionID for trace attribution.
- v1.13.3 THE GUT: the ACTION text protocol is DELETED (~1,500 lines:
  parseAction family, glue parsers, alias/Levenshtein layers, the ReAct
  preamble-hold state machine, DSML reinject, the kill-switch); ~40 server
  teaching texts rewritten to tool-call phrasing; live verdict 19/19 against
  the real NVIDIA key (nemotron-3.5-lightning: calculator chain, live
  web_search, zip_create artifact).
- v1.13.4 THE CHAIN: external MCP servers attach onto the bus (stdio on
  desktop, streamable-HTTP everywhere incl. Android) under name_ namespaces
  with auto-paginated tools/list + raw-schema proxies; /mcp serves external
  consumers the same registry; config via DOOMALAY_MCP_SERVERS or
  <dataDir>/mcp_servers.json. Live: engine B chains engine A (56 tools).
- v1.13.5 THE LAST ACTION: pmsdk.js (the PM E2E browser loop) drops the
  ACTION grammar for tools[] from /mcp + native tool_calls delta assembly;
  ground-truth probe proved PM's E2E API passes OpenAI tools[] natively;
  X-Doomalay-Session resolves session turns for external callers.
- v1.13.6 THE REDTEAM: the 67-check adversarial rig (deterministic stub
  personas — nvidia/openrouter scenarios, groq the reject carrier — plus
  mcpdemo, a standalone 100-tool streamable-HTTP MCP server with
  boom/hang/boom_panic fault injectors). Two engine bugs convicted, fixed,
  and pinned: (1) the honesty line's execution side — a cut/malformed call
  said "NOT executed" then executed anyway with bus-coerced {} (Skip/SkipText
  now make the fault text the tool's answer: one call_id, one tool message);
  (2) THE THIRD CARRIER — openrouter turns never reached the bus (plugin-first
  routing + always-on WebSearch); every tools-capable provider now runs the
  tool_calls loop first, the OpenRouter web plugin ladders down to the
  blacklisted/anthropic-wire fallback. Rig 67/67.

Stage Summary:
- THE MCP WAVE is complete and shipped as v1.14.0-the-mcp-wave. MCP is the
  tool system end to end: one calling convention, 28 internal tools, any
  number of external servers (the 100+ tools horizon made real by mcpdemo
  and /mcp), ACTION dead on every path, honest degrade contracts pinned by
  the rig. Parallel bots (tiktoken accuracy, OTel hooks/traces) plug into
  the bus's Observer sockets — no file overlap, no conflicts.

---
Task ID: v1.14.5
Agent: Main orchestrator (the real-key E2E wave, fresh session)

Task: The user's fresh keys + the old NVIDIA key — "solely test the chat bot
and check for errors. If you found no errors then dont do anything."

Work Log:
- Sandbox reset recovery (3rd time): re-cloned doomalay (main @ 53191635 =
  v1.14.4 head — the parallel HONEST-ENGINE wave shipped v1.14.1..v1.14.4 on
  top of my v1.13.6/v1.14.0, rebased in), reinstalled Go 1.25.5, rebuilt the
  engine, keys at /home/z/keys.env. Tunnel down — sandbox testing.
- OpenCode deep-probe (11 web searches + gateway source reads): oc_sk_ keys
  authenticate on ALL THREE lanes (zen/v1, zen/go/v1, inference) but the
  account has NO Go subscription (EntitlementError) and NO prepaid funds
  ("Insufficient account funds" on every paid model), and the free tier is
  hard-walled to the OpenCode app (FreeTierError survives the full 4-condition
  client gate: opencode UA + ses_ session + stream:true + bash/read tools).
  The engine's honest-degrade path verified end-to-end (403 error frame +
  idle + the guidance message). Header contract correct: zen/go 400
  MissingSessionID reproduced + bypassed with a stable ses_ header.
- LIVE MATRIX (fresh keys, the engine's real /api/keys flow): NVIDIA valid —
  the live roster flagship nemotron-3-super-120b-a12b chains calculator +
  time_now + zip_create flawlessly (4s turns, grounded answers, full trace
  lifecycle); OpenRouter valid — lfm-2.5-2.6b:free (the 2.6B weak model!)
  chains instantly, nemotron:free completes through a 229s free-tier queue
  with honest "waiting on OpenRouter" notices; Mistral key now VALID (was
  invalid) — currently 429-capacity-limited, the engine's 3-retry backoff
  (4s→14s) + honest stop is exactly the strictly-429 contract; PM E2E probe
  5/5 (attestation + refreshSecret + plain + tools passthrough).
- THE PRE-MADE HORDE re-run: 23/23 with the fleet (fs/memory/think/sqlite =
  29 community tools + the internal 28 = 57-tool merged registry).
- REAL-USER UI E2E (agent-browser, engine-served PWA, persistent engine via
  a double-fork daemonizer — the sandbox reaps normal background spawns):
  13-round self-knowledge conversation: R1 stock-trading opener (bot knows
  artifacts + capabilities), R2 lib search → RECOMMENDS THE KRONOS REPO
  (4 hublib queries with visible retry reasoning), R3 personas (knows Noir
  Detective + download/activate WITHOUT being asked), R4 workspaces (knows
  GitHub/HF/Gitea/GitLab/Sourcehut + what the workspace tool does), R6
  usage/context (EXACT ledger numbers: 159,964 in / 4,364 out, ≈$0.04,
  62.7% of 262k, correct rate math), R7 five-tool chain incl. COMMUNITY
  fs_write_file/fs_read_text_file grounded, R8 artifact card, R9 web search
  with 5-source disclosures, essay + queued follow-up.
- FPS: 60fps 0 drops (max 20ms gap) at empty, semi-saturated, heavy (12
  rounds + 2 workspaces + artifacts), and DURING active streaming. Zero
  console errors, zero engine errors.
- Queue: QUEUED badge + remove + auto-drain after the running turn.
  Interrupt: clean stop + "the reply was interrupted — tap Retry". Resend:
  Retry re-sends and completes on the switched model.
- Workspaces: GitHub PAT through the real connect flow (✓ logged in
  @ScoobyBaby1999 → doomalay repo bound FULL access) + HF access token
  (doomalay-kronos dataset bound FULL) → the workspace tool turn did PARALLEL
  ls+grep across both, grounded summary (143 HF entries, six Kronos skills).
- TRUE PM E2E PATH (the earlier GLM 5.3 pick had landed on NVIDIA's copy of
  the model — PM-unique glm-latest picked instead): the browser loaded the
  full pmsdk E2E chain (wasm attestation), tool executions went through
  POST /mcp (the mcp-go bus first), grounded "33 × 3 = 99 + Tokyo 01:10 JST".

THE FINDINGS (the only errors found — all small, all fixed):
1. THE STALE AUTO-PICK: nemotron-3.5-lightning-30b-a3b was deprovisioned
   from NIM (live roster check: 502/404) but THREE hardcoded lists still
   led with it (engine knownGoodProbes + the PWA's KNOWN_GOOD and
   FALLBACK_MODELS) — every one-press connect inherited a dead-then-flaky
   model (live-observed: a 3.5-minute round-one stall, then repeated
   "no response from Nvidia" waits). All three now lead with the live
   nemotron-3-super-120b-a12b. Verified live: fresh one-press connect lands
   on the live model.
2. THE SANDBOX TEACHING GAP (R5): asked "what sandbox am I on / what do the
   others offer", the model honestly said "I don't have any information
   about selectable sandboxes" — the session preamble never taught the
   concept. sessionctx.go now carries the sandbox line (current sandbox +
   the four switchable types). Verified live: full correct table answer.
3. v1143 community-chain-test model id healed (the stale lightning → live
   super; 23/23 re-proven).

Stage Summary:
- The system is HEALTHY end to end under real keys: tools chain reliably on
  every chat-capable provider (strong AND weak models), rendering is
  sequential and delta-correct at a locked 60fps, queue/interrupt/resend all
  behave, the bot never stops except strictly-429 (displayed, retried 3x),
  community MCP tools ride the bus, PM executes tools mcp-first like everyone
  else, and both workspace connects work with full access. The one thing the
  user must do OUTSIDE the app: add credits (zen pay-per-use) or the Go
  subscription (with Global region privacy) at opencode.ai for the fresh
  OpenCode key to chat — the key itself is valid and the engine degrades
  honestly meanwhile.

═══ v1.15 THE CHOICE WAVE (2026-10-08) ═══

The user's four fronts, delivered as PLAN-V115 (four phases, ship v1.16.0):

1. v1.15.1 THE CHOICE (baec254f) — the autopickers are dead: no hardcoded
   model lists anywhere (engine knownGoodProbes deleted → live-derived
   ladder, free-first, capped at 5; ResolveAutoModel scores pure catalog
   data; the PWA's KNOWN_GOOD/FALLBACK + the one-press silent pick + the
   reminder GUI deleted). Every connect flow now FORCES the user's pick
   through the model screen in TEACH MODE: the Ready (key-backed) filter
   preset, the teaching provider first + expanded, and the short banner
   ("Pick your model — this is the model screen. Reopen it anytime from the
   👾 model pill in your chat's header."). Caught live: modelpicker called
   smartConnect() with no callback → the screen never opened (fixed+pinned).
   Live E2E through the real NVIDIA key: card → teach screen → pick →
   unlocked chat → exact reply.

2. v1.15.2 THE DECOUPLE (9f0bb201) — isolation proven under genuine
   overlap: scripts/v1152-slow-stub.mjs (slow carrier, per-request markers)
   + scripts/v1152-decouple-rig.mjs (speaks the PWA's own ChatClient
   contract). 30/30: parallel streams, busy isolation, abort isolation,
   socket-kill + server-side turn survival + &since resume, replay
   reconstruction, the stale-frame guard. Live UI redteam: 3 chatbots
   (nvidia/groq/openrouter personas) flipped mid-stream — 0 foreign
   markers; browser panel navigated while a chat streamed; PWA RELOAD
   MID-TURN — the turn survived, replayed, completed all 40 deltas.
   Convicted+fixed: the DOOMALAY_BASE_URL override didn't hold for the
   specialized model fetchers (nvidia/opencode/PM/openrouter) — now the
   mirror contract is honest.

3. v1.15.3 THE TRIM (820f0df4) — the chat/session files: dead code out
   (chatpanel's unreachable pre-v0.48 persona duplicate still teaching the
   DELETED ACTION grammar — actively harmful since v1.13.3; persona.js's
   ## Tools/## Library rewritten to native tool-call phrasing; the last
   engine remnant strings healed). Complexity: buildHistory is BOUNDED
   (ListEventsTail + the hide-only query + a doubling tail walk —
   O(window) per turn, exactness fallback for mid-delta-run tails);
   updateMessageEl is an O(1) mi→el cache (was a full-DOM querySelector
   per 180ms tick); sessionLocks/chatPipes get reapIdleChat (never while
   a turn runs — the resume-swap invariant, pinned by test).

4. v1.15.4 THE SHELL PLAN (e10b112a) — PLAN-V116-THE-SHELL-WAVE.md: the
   design for bash/shell/real-Linux in Quick Chat (WS /api/term + creack/pty
   engine side with the android build-gate, xterm.js in the OVERLAY per the
   container law with theme-var-fed colors, the jailed one-shot shell MCP
   tool with blocklist/caps/cooldown, the Termux bridge for local Android)
   — v1.16.x builds it phase by phase.

Ship v1.16.0: buildinfo carries the wave. Full battery green throughout
(decouple 30/30 · v1136 67/67 · choice 19/19 · v1153 pins · llm · server ·
isolation 12 · round-flow · interrupt 65).

---
## v1.18.0 — THE TERMUX WAVE (PLAN-V117, shipped 2026-10-08)

The user's directive: Termux comes to the APK first; only quick chat
exists; the +sandbox becomes a +capabilities overlay (stackable, the
future library); the setup must be one-click or as close as possible; a
live delta update system so users download only what changed.

- **v1.17.1 THE PIVOT** — sandboxpicker.js deleted (665 lines incl. the
  whole HF sub-picker family); capabilities.js born (the capability
  library on the ConnectOverlay: stackable toggle rows + action rows +
  the APK-only Termux row); gatelock = model + optional caps; quick by
  birth (chatbot.js + sessionBody + engine default); chat_sessions.termux
  column; sessionctx capabilities teaching.
- **v1.17.2 THE BRIDGE** — RUN_COMMAND manifest permissions + queries;
  TermuxBridge.kt (intent sender, PendingIntent results, honest ladder);
  TermuxBridgeServer (token-authed loopback); engine --termux-bridge +
  termuxbridge client + /api/termux/status (cached probe, honest ladder)
  + /api/termux/act. APK CI green (Kotlin compiles).
- **v1.17.3 THE SETUP** — termux/setup.sh (the curl bootstrap); the
  setup overlay (4 auto-advancing step cards, 3s poll, READY card, Done
  pop-back); the F-Droid 1002 + the one-liner.
- **v1.17.4 THE LIVE UPDATE** — internal/ota + otaapi (status/check/
  download, sha256-verified atomic downloads, ota-first static overlay =
  restart-free apply); web/ota.js banner; CI manifest generation; the
  old generate-patch-manifest.py retired.
- **v1.17.5 THE REDTEAM** — the 108-check rig (fake bridge + fake OTA
  against the live engine) + agent-browser E2E. Convicted + fixed:
  quick-by-birth engine gap; renderTypePills undefined (killed the real
  browser render while source rigs stayed green); pre-session caps lost
  on reload (icon.caps stash); late pill repaint. The honest gap: the
  com.termux intent round-trip needs real hardware —
  docs/TERMUX-DEVICE-TEST.md is the checklist.

The Termux capability is inert by design this wave — workspaces + the
MCP tool layer (termux_exec + file verbs, jailed to the approved
workspace) is PLAN-V118, the next wave.

---
Task ID: v1.23.1
Agent: Main orchestrator (THE PILL WAVE)
Task: PLAN-V123 §1 — THE LINK (dynamic F-Droid stable URL) + THE PACING (the 4s exec cooldown dies).

Work Log:
- Research receipts: fetched F-Droid API v1 live — suggestedVersionCode 1002 (0.118.3 stable) while packages[0] AND [1] are betas today (the user's "2nd link" heuristic would grab a beta — the suggested-code match is the honest pick); RUN_COMMAND = one broadcast (100KB cap, no incremental channel → streaming must originate inside Termux); engine serves 127.0.0.1:8080 on the APK (the checkin pattern proves Termux→loopback works).
- fdroid.go (NEW): resolveFdroidTermuxURL (5s timeout, 6h TTL cache, one-flight) + pickFdroidURL (suggested-match → first non-prerelease (beta/rc/alpha leading-boundary markers) → frozen 1002) + warmFdroidURL (every status poll warms it in the background).
- handleTermuxAct: open_fdroid resolves + rides the URL via the NEW bridge ActWithURL; TermuxBridge.kt honors it ONLY under the https://f-droid.org/ allowlist (frozen constant = the fallback). Kotlin diff ~20 lines.
- THE PACING: termuxExecCooldown/termuxExecLast deleted; the 12/min rolling cap stays; help/sessionctx/example texts updated; TestV1231_Exec_NoCooldown_CapHolds + re-pins (termuxtool_test shrinkPacing, sessionctx_test "12 per minute per chat", v1203 rig 61/61, v1211 rig 30/30 — the immediate second exec RUNS now).
- Whitespace law incidents (2, both fixed): the Edit tool space-ified tab-styled termuxbridge/client.go + termuxapi.go — python tab-restore, diffs surgical (client.go = ActWithURL only; termuxapi.go = warm + the fdroid act branch).
- The mirror wave shipped v1.22.0 mid-build → my wave = v1.23.x → v1.24.0 (no collision); rebased clean, battery re-run green post-rebase.
- Battery: fdroid_test 3/3 · full server suite ok · termuxbridge ok · vet clean · linux+android builds · v1202 66/66 · v1204 38/38 · v1213 25/25 · v1212 23/23. Pushed 40fa32fc (origin/main).

Stage Summary:
- The Get-Termux tap always serves F-Droid's CURRENT stable link (never manually updated again; offline = the frozen link); exec runs rapid-fire with only the 12/min cap. Engine+Kotlin ride the APK (OTA carries nothing of this phase).

---
Task ID: v1.23.2
Agent: Main orchestrator (THE PILL WAVE)
Task: PLAN-V123 §2 — THE ONE PILL: merge the tool call + result pills, derive the real exec label, the loading bar.

Work Log:
- chatpanel.js: toolPillLabelParts + termuxArgsOf (the pure label derivation: first token + the ONE generic 'install' join, pkg verb, summary fallback) + mergeToolResult (the pairing-to-last-pending reducer, ei2, resPayload) + refreshToolRow (in-place repaint) — all exported for the rig.
- messageHTML tool branch: the merged/pending/progress states, the dim tail + live dot, the expanded three-truth-rows (tool/query/result); toolDetailHTML: args pretty-print (object or JSON string), the merged result read, THE LOADING BAR (pending) + the streamText seam for v1.23.3.
- The WS tool_result handler merges (replay identical — persistence untouched, append-only law); the PM onTool twin merges the result half + persists the RAW args; pmsdk passes args + prefers the nested args.command summary (the 'exec' flat-key vagueness dies).
- The hide flows honor ei2 (the live hide loop, regenerate, commitEditStash — masking either half drops the vessel).
- openToolFullView reads msg.res (the borrow walk stays for standalone legacy pills).
- index.html: the tail/live-dot/bar/stream CSS (theme vars only + prefers-reduced-motion honesty); mobile 390px verified.
- THE BROWSER WALK (agent-browser + a live engine, zero console errors): the seeded session replayed through the real app renders ONE merged pill ('pip install numpy', result tone, both-spans label+tail) + ONE pending pill ('ls -la' + live dot; expanded = tool/query/result + the 3.375px animated slide bar); the full view opens/closes; the X works.
- Battery: v1232 rig 39/39 (NEW) · v1171 67/67 · v1212 23/23 · interrupt 65 · v1175 155/155 · v0935 13/13. Pushed d69544ca.

Stage Summary:
- One pill per action, the program as the placeholder, the query as the tail, the loading bar while in flight — live, replayed, and pre-merge chats alike. The PWA side lands OTA. The stream (v1.23.3) fills the same vessel.

---
Task ID: v1.44.0 (THE NATIVE PM — the wave record)
Agent: Main orchestrator (PLAN-V144, the user's ask: "Try to make PM run engine side and not in a web layer if possible so it's native like the other providers")

The wave, one line per phase (the full records live in the phase commits):
- v1.44.1 THE VENDOR (586b133) — the MIT chat-path closure vendored at engine/internal/pm; the TOFU attest getter; go 1.26 toolchain; PLAN-V144 ships.
- v1.44.2 THE PIN (d64244e) — the vault-persisted mesh CA + active manifest + cached secret (AES-256-GCM, the __STATE__ namespace); TOFU headless, verified ONLY by the one-shot WASM oracle (/api/pm/bootstrap); /api/pm/state + reverify; the provider-card pill; drift = the honest re-verify error, never silent re-pin.
- v1.44.3 THE WIRE (048e1c7) — llm.Chat speaks PM natively (llm/pmwire.go: the synthetic SSE response over the decrypted stream; every downstream ladder unmodified); the "no secret for ID" retry-once; /api/keys/value's standing plaintext hole DIED behind single-use handshake tickets.
- v1.44.4 THE STRIP (5621b75) — the web layer's PM twins deleted (~700 lines in chatpanel + the 835-line pmsdk turn bridge → the 176-line oracle); PM turns ride the engine WS; the connect-moment nudge upgrades TOFU pins; 7 bridge rigs retired, 3 updated.
- v1.44.5 THE BRAIN (cf94cb3) — the Node sidecar retired (pmproxy.mjs + both 6MB wasm copies deleted); the engine's local PM bridge (POST /api/pm/local/v1/chat/completions, api-key-fallback=never, constant-time); the brain catalogs point at {DOOMALAY_ENGINE_URL}.
- v1.44.6 THE PROOF (db55dfe) — scripts/v1440-pm-native-rig.mjs 27/27 live (the 300+ token unbroken stream, the mid-turn socket cut + armed-truth resume, effort, model + provider switches, re-verify, revoked-key honesty, the source pins); v1400 58/58 + v1350 62/62 + all four pmlive gates; the rig convicted the pre-existing mergeUsage TotalTokens drop (fixed).
- v1.44.7 THE SHIP (this commit) — buildinfo 1.44.0; the README/OTA/TERMUX/SECURITY doc notes; this record.

The honest limits, on the record: the manifest-mismatch drift conviction is offline-proven (pmstate's fake-cert battery — the live deployment has not rotated its CA during the wave); the forced 45-minute secret renewal is offline-proven (the floor + import laws) with live cached-secret reuse proven across turns; PM agent turns need a CO-LOCATED engine (a standalone HF-space brain honestly skips PM at registration — the space runs brain-only, no engine to speak the protocol; the old Node sidecar covered that shape at the price of a 6MB wasm + a second protocol copy).

## v1.45 THE HONEST PM (PLAN-V145) — the user's device-test report, root-caused and fixed

- v1.45.1 THE ANDROID WIRE (b2ab324e) — the vendored PM client dialed with Go's DEFAULT dialer while every other engine outbound rides netx.DialContext (the engine's own law: "the Android DNS fix applies everywhere"); on Android there is no /etc/resolv.conf so PM was the ONE provider that died on real devices while Nvidia/OpenRouter streamed (the user's "network unreachable… even tho I was connected to the internet"); pmstate wires netx.Transport() (also dropping the vendored 5s HTTP/2 health-check ping that killed mid-request connections on lossy mobile links); PROVENANCE delta 8; TestManagerDialsViaNetx pins the law; DOOMALAY_PM_API_BASE joins the rig knobs.
- v1.45.2 THE HONEST NET (425d7edf) — the two outage shapes get opposite honesty: PROVIDER-SCOPED (anyOtherProviderHealthy — another provider's recent success is positive evidence the network works): the texts NEVER blame "network" and netProviderHoldLoop is a BOUNDED hold (DOOMALAY_PROVIDER_HOLD_MS, prod 2min) ending in the honest provider-down verdict with the session lock RELEASED (the old infinite suspension held the chat hostage — every fresh send hit "busy", live-convicted on the Sky transcript); DEVICE-OFFLINE: the v1.39.3 patient engine byte-for-byte. The hiccup counter tells the truth (the old hardcoded "/2" counted past itself live). pmstate drift-checks pinned-CA INIT failures.
- v1.45.3 THE PILL OBJECT (240dc7a8) — ONE ActivityPill INSTANCE PER CHAT STATE (the user's law: "each chat should be isolated and have its own instance completely"): the pill OWNS its row, binds to ITS OWN chat's #chat-messages, never queries the shared panel body — the cross-chat isolation the scattered v0.35 isOwner guards tried to enforce over ONE shared DOM is now STRUCTURAL; bind() re-paints the CURRENT phase on reopen (the stash's baked text can never flash).
- v1.45.4 THE QUIET ORACLE (827dbcd4) — pmOracleNudge DELETED (it auto-loaded the 6.1MB wasm + ran the attestation handshake at every PM chat open/model pick — a guaranteed failing download at the user's first PM moment on a device where PM is unreachable); PM connects and runs with ZERO wasm; the provider card's explicit "verify attestation" button is the ONLY oracle trigger, with honest copy ("your PrivateMode chats work; the attestation check is optional").
- v1.45.5 THE PROOF (73449dd4) — scripts/v1450-honest-pm-rig.py 26/26 (a real browser, real keys, the user's exact device shape: honest texts + the true counter on the wire, the bounded terminal in the transcript, the lock released, ZERO cross-chat pill texts across rapid 3-provider switching, the stash path clean, ZERO auto-wasm requests); regressions green (v1350 62/62, v1400 51+27+58, v1440 25/25 with the R9e flip, all pmlive gates, go 14/14).
- v1.45.6/v1.45.0 THE SHIP (this commit) — buildinfo 1.45.0; the README/OTA notes; this record.

Honest limits: the Android DNS conviction is by-construction (netx is the proven Android path the working providers ride; live Android proof needs the user's device — the tunnel was down this session; TestManagerDialsViaNetx guards the wiring); the license wall stands (contrast BSL-1.1 → AGPL-3.0 after the change date — the wasm stays the only legal attestation verifier, now strictly on-demand).

## v1.46 THE CLEAN MIND (PLAN-V146) — the duplicate-reasoning report, root-caused and fixed live

The user's post-v1.45.0 device report verbatim: "the pm native reasoning shows duplicate texts. Every word appears twice in it's reasoning for some reason… I'm not sure what else uve missed in that regard. But it seems native can still use some work."

- v1.46.1 THE ALIAS LAW (0ae29d88) — live-probed against the real deployment (glm-5.3 + gpt-oss-120b, plain + tool rounds, streaming + non-streaming, a throwaway engine/cmd probe, never committed): PM's gateway (system_fingerprint vllm-0.31.0-tp4-ep-2e04e944) emits EVERY reasoning delta in BOTH wire spellings byte-equal ('{"reasoning":"The","reasoning_content":"The"}' — the vLLM compat shim for the rename "reasoning used to be called reasoning_content", docs.vllm.ai); the engine's v1.14.6 normalization merged Reasoning+ReasoningOR on the assumption "only one shape is ever non-empty per chunk in practice" — convicted FALSE for PM: every word of PM-native reasoning doubled. reasoning.go gains mergeWireReasoning — the two spellings are DOCUMENTED ALIASES of ONE channel: byte-equal pair = ONE copy; single-spelling senders (OpenRouter reasoning / NIM reasoning_content) byte-identical to before; a both-non-empty-and-different delta keeps the historical concatenation (no wire byte ever dropped); both chat.go merge sites consume the merge; reasoning_v1461_test.go pins the LIVE-CAPTURED frames byte-for-byte. RED-TEAMED LIVE: the pre-fix flip through the full engine reproduces the user's exact symptom (adjacent-duplicate rate 0.47: "TheThe user user asks asks:: What What is is 2 2++22?? Answer Answer in in one one word word.."); the fix streams clean (rate 0.000–0.036 across repeated live runs).
- v1.46.2 THE REASONING LEDGER (e238bbdb) — the live capture showed glm-5.3 spending 53 of 56 completion tokens REASONING for a one-word answer while the LEDGER dropped the OpenAI detail block (completion_tokens_details.reasoning_tokens parsed nowhere): llm.Usage gains ReasoningTokens (0 = unreported, never invented); the per-chunk overwrite keeps the final's honest numbers; mergeUsage SUMS across tool rounds from birth (the v1.44.6 TotalTokens lesson); the live event + the persisted status usage + both usage endpoints (session totals + per-model, fleet per-provider + grand) carry the share; the usage panel renders the 🧠 thinking-tokens stat + per-model/provider chips (theme tokens only — var(--accent-3); old sessions parse 0 — additive JSON, no migration); usage_v1462_test.go pins the aggregation (incl. the old-shape event contributing 0).
- v1.46.3 THE PROOF (2936a138) — pmlive gate TestLivePMReasoningClean: a REAL glm-5.3 turn through llm.Chat's own pipeline asserts no doubled words (rate < 0.20), the answer intact, the usage carrying the reasoning share; the RELIABLE reasoning trigger is empirical ("Think step by step: 17×23" forced the channel 3/3; bare "2+2" reasoned only 2/3 — glm's dynamic reasoning skips recall facts intermittently; a flaky gate is a lying gate). scripts/v1460-clean-mind-rig.py 16/16: RA the alias law LIVE through the engine's own WS chat protocol (a real browser page, real key, the persisted thinking events read back — no doubled words, answer intact, turn idle); RB the ledger live end-to-end; RC the source pins (mergeWireReasoning + both sites + zero raw concatenation, the live-captured fixtures, the detail-block parse, the merge sum, the 🧠 stat on both views, theme tokens only, the pmlive gate). Regressions ALL GREEN: v1350 62/62, v1400 51+27+58, v1440 27/27, v1450 26/26, go battery 14/14, all pmlive gates; the UI-driven agent-browser pass (the thinking bubble renders undoubled — rate 0.022; the usage panel shows 🧠 54; /api/sessions/:id/usage answers reasoningTokens 54 of 58 output).
- v1.46.4/v1.46.0 THE SHIP (this commit) — buildinfo 1.46.0 (the record chained); the README's PM paragraph gains the reasoning-honesty record; this entry.

Honest limits: glm's dynamic reasoning SKIPS recall facts intermittently (the capital-of-France prompt reasoned 0/2 live; bare "2+2" 2/3) — every gate uses the empirically-forced trigger; old persisted sessions keep their historical (possibly doubled) thinking text — history is never rewritten, new turns stream clean; the parallel bot's variant (the user's "another bot working in parallel") had NOT landed when this wave shipped — if it lands later, the v1460 rig's RC pins are the verification either way.
## v1.42.7 THE MANAGER (PLAN-V142 §3.4 W4 — the worlds overlay)

- v1.42.7 THE MANAGER (this commit) — the three-zone worlds overlay on the sanctioned ConnectOverlay surface: (1) YOUR CANVASES rows (thumbnail · name · N icons · SIZE · updated, the active badge) where tap = the ONE switchTo jump and long-press/⋯ = the action sheet (rename · duplicate · delete — publish deliberately deferred to the bundle wave, a dead button would lie); (2) BROWSE WORLDS, forward-wired to the canvas hub type — today it honestly opens the hub home (the type ships with v1.43.0; the same call + subtitle flip to the real pre-filter with ZERO changes when it registers); (3) + CREATE NEW CANVAS with the generic canvas_N first-free law (ONE helper shared with the Settings page, catching legacy 'Canvas N' names). The rename is LOCAL-ONLY (rides the engine row; UpsertCanvas's no-clobber law keeps state — pinned by TestV1427_StateBytesProbe + the rig); the BACK-STACK (the visited chain, browser semantics — revisit truncates) gives the manager its '↩ back to X' home-base chip; the PORTAL CONTEXT (the hole panel's '⊞ all worlds…' opens the manager with {fromPortal}) makes tap = re-target + the DIVE (deletePair → createPair at the hole's spot → transition), and create in portal mode wires the pair per W3's two-way law then dives; the active row disables ('you are here' — a portal never targets its own world). Engine: CanvasRow.StateBytes (COALESCE(length(state),0) — additive JSON). app.js: the '⊞ + Canvas' menu row + doomalay.openLibrary(type) (the dock-library law extracted, ONE path for the dock glyph and the manager's browse row).
- The proof: scripts/v1427-manager-rig.mjs 57/57 (entry real · rows honest · jump · back-stack · create canvas_2-with-canvas_1-seeded · sheet via ⋯ AND the 480ms long-press hold · rename no-clobber · duplicate · delete incl. last-refuses + active-switches-away-first · browse forward-wiring · portal context end-to-end incl. the two-way law · zero errors + theme pin + B1) + scripts/v1427-manager-walk.mjs 33/33 (the real finger: the menu every time, the jump, the back chip, create, rename+dup via the sheet, the portal dive).
- The harness convictions on the record: agent-browser DOUBLE-ENCODES raw-string eval results (abJson needs JSON.stringify in the eval or the raw string parse-throws to null — the T2/T11 'null' failures were this, NOT app bugs); the v1421 rig's OTA manifest server raced the engine's one boot-time fetch on this faster hardware (the engine boots in ~130ms, python's http.server needs ~150-300ms — startManifestServer now awaits readiness; A8 was a harness race, not an app bug).
- Battery: go 14/14 · v1427 57+33 · v1426 34+16 · v1425 45+28 · v1424 46+20 · v1421 24/24 (harness race fixed) · v1400 51/51 · v1350 62/62 · v1310 58+27 · v1391 10/10 + source-pin PASS · census re-anchored (worldsmanager.js, zero violations) · discipline 7+B1 (the pre-existing trio only — byte-identical to origin/main) · node --check clean. gofmt deliberately NOT applied (the engine's committed Go files predate gofmt — surgical diffs only, the house norm this wave).

## v1.42.8 THE VESSEL (PLAN-V142 §3.5 W5 — the .doomcanvas container)

- v1.42.8 THE VESSEL (this commit) — a world travels as ONE file. publishers.js (the OOP component contract, dual-env window+node): six publishers in DEPENDENCY ORDER (assets 10 → iconsets 20 → settings 30 → chats 40 → layout 50 → portals 60) + the CanvasPublisher composite (order 100 — the canvas row lands LAST on import, the cheapest undo is "nothing was born"). AssetsPublisher OWNS the namespace (extracts each chat's background/texture/icon media, per-file ≤6MB, total ≤24MB, materializes FIRST so chats reference staged bytes); IconsetsPublisher rides the registry's own sanitize ladder at import (the v1016-proven tag/attr whitelist; the undo removes added sets); SettingsPublisher whitelists EXACTLY the canvas-scope pick list (CANVAS_KEYS mirrors app.js's CANVAS_SCOPE_KEYS — the parity is probed + rig-asserted); ChatsPublisher carries chats/<sid>.json (the SAFE session pick + tweaks + history ≤8MB via the 200-turn fold + asset refs) and imports with THE BIRTH SPLIT (POST accepts the shape subset; the persona/preamble family rides the PATCH — the engine's own create law) with hide-mask TRANSLATION (old seqs → new seqs through the append map); LayoutPublisher owns canvas.json (camera+family+icons+dots); PortalsPublisher owns children/<uuid>.doomcanvas (nested worlds, depth ≤3, the parent pays the child's bytes into the budget BEFORE recursion, the filename's cid maps to the reborn row for the hole rebind).
- canvasbundle.js — the container: collect (ONE fetch pass, everything ON — the sheet's toggles only FILTER, the preview IS the truth) → build (manifest.json format 'doomalay-canvas' formatVersion '1.0' + the fflate zip, level 6) → THE 8-RUNG READ LADDER (R1 caps BOTH sizes 8MB/entry · 96MB total · 1024 entries · the 100:1 ratio, all pre-inflation in fflate's central-directory filter — a filtered entry is a REJECTION, hostile by shape; R2 the truncation detector — data.length must equal the declared size (the declared-LARGER shape convicted live; the declared-smaller shape amputates and dies at the JSON/image-sniff rungs); R3 names — no ../, depth ≤8; R4 the whitelist + the x-* forward-compat namespace (OCI-style: unknown extensions are data, unknown surfaces are attacks); R5 MAJOR.MINOR — reject greater MAJOR, accept any MINOR, ignore unknown manifest fields; R6 every chats/*.json + canvas.json parse; R7 nesting ≤3 with the recursive budget; R8 THE ROLLBACK DRIVER — per-publisher applyImport in dependency order, each writing an undo journal; ANY throw reverse-walks the journals with the honest 'rolled back' report) → the landing (the ONE switchTo + the thumb; a failed landing is a WARNING — the rows are real).
- THE SANITIZE LAWS (rig-asserted): keys STRUCTURALLY ABSENT (the BYOK scan walks every bundle JSON for key-shaped field names — zero); hooks_config + tool_allowlist + every auto-tool (web_search/lib_auto/skills_auto/template_auto/termux) STRUCTURALLY ABSENT (imports land them OFF — the R7 no-auto-activation law, engine-verified: the reborn session's WebSearch/TemplateAuto/LibAuto/Termux all false); settings structurally canvas-scope; requires[] warns per missing provider key; personas/preambles ride the PATCH (preamble_sel resets — never auto-activates); the icon caps land with auto-tools off; the provenance mark rides state.imported (name/author/at) and SURVIVES saves (worldProvenance round-trips through applyWorldState ↔ saveNow; worldsProbe.provenance surfaces it).
- THE WIRE-SHAPE CONVICTION (live, the real engine): the session GET marshals PascalCase Go names ("WebSearch", "ManuallyRenamed") while POST/PATCH speak snake_case — the symmetric io stub LIED (it echoed my snake keys back); pickSession now maps GET(Pascal) → canonical(snake) with the snake twin as fallback, and THE RIG'S STUB IS SHAPE-HONEST (PascalCase records, event_type/content events, {canvas:{id}} responses) so it can never lie again. The events wire: export.json events ride event_type/content; the append response carries lowercase seq.
- worldsmanager.js: the sheet's ⤒ 'publish .doomcanvas' row (the v1.42.7 dead-button debt PAID) → the publish sheet on ConnectOverlay (the toggle tree with the locked canvas row + per-chat leaves + the history row + per-asset leaves + the linked-worlds group, the LIVE size readout recomputed per flip — no re-fetch, the collected per-file sizes are the math); the '⤓ import .doomcanvas' row in the create zone (the file input lives INSIDE the overlay content — the B1 law) → the honest import report (the world landed · chats reborn · linked worlds · warnings incl. the provider-key notices); app.js: getWorldStateForExport (saveNow's exact shape, minus the write — the live truth, never a stale row) + captureThumb exposed + the CANVAS_KEYS parity probe.
- THE THEME CENSUS CONVICTIONS (pre-existing, this wave's files surfaced them): --ui-tiny-fs + --ui-large-fs were referenced by the v1.42.4-7 code but NEVER DEFINED (the silent inherit — 30 uses across 5 files rendered at parent sizes); both now land as REAL :root ladder steps (micro 10.5 < tiny 11 < small 12 < ui 14 < large 16); --bg (holes.js's ring gradients — the v1.42.6 rings' outer stop was transparent-garbage) replaced by --field-canvas (5 sites); the census re-anchored 140 → 142 vars; the source-pin baseline re-anchored (the +5 index.html lines shifted the line-keyed ledger).
- THE HARNESS CONVICTIONS (both convicted live, both fixed for every engine-booting rig): (1) THE STALE-PAGE FLUSH — the previous run's app page SURVIVES in agent-browser; when the new engine boots on the same port, its calm-sync trailing flush PUTs the OLD world's state (ghost portal holes included) into the FRESH engine's db — convicted by a createPair wrapper tracing every pair birth (the ghost pair's origin was a DELETED world from an earlier run); (2) THE HISTORY POLLUTION — the tab's accumulated history (50+ entries across re-runs) desyncs the overlay's marker chain and the drain overshoots past the app root (the walk's page landed on names.json — window.Holes dead). BOTH die with agent-browser close --all at boot (a pristine browser per run: fresh page, fresh history).
- REDTEAM: scripts/v1428-vessel-rig.mjs 48/48 (the pure core — the contract, the safe picks, the 8-rung ladder probes incl. the bomb/ratio/traversal/depth/unknown/version/truncation/count rungs, the import E2E with the shape-honest stubs, BYOK, the ROLLBACK (a mid-driver throw → the created session undone, no canvas row born), the caps) + scripts/v1428-vessel-walk.mjs 30/30 (the real finger: the manager → the sheet → the tree → the LIVE size drop on the history flip → the export (lastBuilt passes its OWN ladder in-page) → the import through a REAL File on the REAL input → the report → the world LANDS (switchTo + the probe's active + icons + provenance) + the engine parity (the reborn session's auto-tools off, the history rode, the hole retargets to the reborn child, the child reborn as its own row) + zero errors + theme pin + B1).
- Battery: go 15/15 (the djournal package the 15th) · v1428 48+30 · v1427 57+33 (deterministic ×3 after the harness law; the rig's sheet pins updated to the four-button truth + the flaky T11 two-way check hardened to a poll) · v1426 34+16 · v1425 45+28 · v1424 46+20 · v1421 24/24 · v1400 ALL GREEN · v1350 ALL GREEN · v1310 58/58 · v1390 source-pin PASS (re-anchored) · v1391 10/10 (142 vars) · census re-anchored · discipline 7+B1 (the pre-existing trio, byte-identical to origin/main) · node --check clean.
- Honest limits: persona badge images are persona-scoped and do not ride yet (a follow-up's ref shape); the import report caps at 6 warnings (the rest ride the console); the export's zip is level-6 deflate (store-only bundles for huge assets can ride a later level knob); the truncation ladder's declared-smaller shape relies on the JSON/image-sniff rungs (defense in depth, both shapes reject).

## v1.57 THE BOUNDED FIELD (PLAN-V157 — the manageable canvas + the ×2 render)

- v1.57.1 THE TRUE BOUNDS (40994023) — default 16,384 + the worldSizeV157 one-time migration + the adaptive fit-all min zoom (min(W,H)/WORLD_SIZE clamped [1/64, 0.125] at all four clamp sites + the post-resize re-clamp + minScaleLive on the probe) + the far-field fade (spacing-keyed, byte-identical at today's scales; the map view past it) + the 8k rung.
- v1.57.2 THE RIDE (b0e41312) — the #chatbots container camera + camera-free icon locals (the orbit tilt folds the camera back in); doomalay.setRide/rideProbe the A/B; the census: 0 plain-icon writes vs 44 legacy on the same sweep.
- v1.57.3 THE ONE FRAME (7b55ebb5) — the input-recency clock (inputOwnsFrame): tick defers the step + the render to the coalesced update while the finger moves (<48ms), hands back on hold; stepCalls/framePaints the instrument.
- v1.57.4 THE PROOF (eb7902e9) — v1570-bounded-field-rig 46/46 + the walk 16/16 + the full battery (v1350-v1428, go 18 ok, vet, cross-compiles, census re-anchored, source-pin PASS); the convictions: the eaten `var segMode` (legacy-fallback caught via lastError), the sleeper-pair broadphase law, the steps-per-paint rest cadence (60/30 by design — count rAF frames), the +22-line ledger shift.
- v1.58.0 THE SHIP (this commit) — buildinfo 1.58.0; the README note; this record.

## v1.56 THE WHOLE TOOLS (the user's law: the tooling is the sole focus)

- v1.56.0 (2d911dc) — the user's ask verbatim: "Focus on fixing all tool hiccups, we want every single tool to not be truncated, greps to return all hits and work like a sophisticated grep even if we must use an opensource library I don't mind at all. Anything as long as we have a very robust tooling system. This is the sole focus."

**THE SOPHISTICATED GREP.** A new engine package (`internal/grep`) is the ONE matcher — RE2 by default (linear time, no catastrophic backtracking), the .NET engine (`regexp2`, promoted from an indirect dep to a direct one) when RE2 refuses the syntax (lookahead, lookbehind, backreferences) — and the fallback is REPORTED (`engine=regexp2`), never silent. EVERY matching line in every file is reported: the old "first hit per file" fold is DEAD (the old grep reported ONE hit per file and dropped the rest). The forge layer runs that matcher over the fetched files, so the result carries every hit, every context line (-A/-B/-C) and the true per-file counts — the forge's own code search is used only to find the CANDIDATE PATHS (its API returns at most one match per file). The flags ride the tool schema so the model can find them: `include`/`exclude` globs (`**`, `*`, `?`, `{a,b}`), `context`/`before`/`after`, `case_sensitive`, `word`, `invert`, `count`, `files_only`, `fixed`, `max_per_file`, `limit`. A pattern that is not a valid regex degrades to a LITERAL and says so (a search never fails because of a stray "(").

**NO SILENT CAPS.** Every ceiling that can bite is REPORTED: the per-file ceiling (the reason rides the result), the hit limit (the reason + the true total + the resume cursor), the skipped oversized files (counted, never dropped), the unresolved branch-mismatch files (reported as bare paths — never the bogus "path:0").

**THE WHOLE OBSERVATIONS.** The in-turn observation budget's floor rises 24KB → 256KB (a 256KB tool result now rides whole on any model; the window's physics still bounds the rest, and the marker carries the totals). The tree verb's summary default is DEAD — a 1,459-entry tree used to answer a DIFFERENT question than the one asked (a directory summary the model read as "the repo has 12 files"); the summary is now opt-in (`{"summary":true}`). The batch read's 40-line trim is DEAD (the whole file rides). `regex_extract`'s silent 50-match cap is DEAD (ALL matches ride; the count says how many exist and how many were shown). The journal's per-entry + per-line snips are DEAD on BOTH twins (the engine + the Python brain — the reply cap matches at 64,000). The brain's artifact read/preview/tree, the explore batch read (24,000) and the workspace/explore grep folds (60/80 rows) all ride whole now.

**THE LISTS PAGE.** The GitHub list verbs (issues, pulls, commits, releases, workflow runs, user repos) WALK the pages instead of stopping at 30/20/50 — a 200-issue repo no longer looks like it has 30. A limit of 0 now means ALL (the silent default is DEAD); the REST twins' defaults follow (the grep route, the view route, the discover route).

**THE DEVICE GREP.** The Termux hand's grep is a REAL grep: ripgrep when the device has it (it does — rg 15.2.0), GNU `grep -E` otherwise, with the context/case/word/invert/count/files-only flags and the glob filters, still jailed (the pattern rides as a positional argument — zero interpolation).

**THE HICCUP FLAG.** Every tool hiccup is DETECTED (the truncation markers, the Termux 100KB cap marker, the refusals, the failed calls) and SPOKEN: a notice chunk, an `obs.ToolFault` trace event, and a warning-toned bubble (⚠ + the theme's error tokens) in the transcript. A clean result stays silent (a false alarm would train the user to ignore the flag).

**THE PROOF.** `scripts/v1560-whole-tools-pin.py` (61 source pins) + `scripts/v1560-whole-tools-rig.py` (15 LIVE checks against a real engine + a local fake GitHub: 5 hits where the old fold found 3, the regex matched only its own line, the globs filtered, the count mode counted, the limit said so, the view route answered). The new package's own pins (12) + the workspace grep's model-facing pins (7) + the hiccup flag's pins (5) + the whole-engine Go suites green (grep · forge · llm · mcpbus · server · store · djournal · surgeon · hub · netx · obs · ota · pmstate · config · archive · hfzero) + vet + node --check + the cross-compiles (linux 55.9MB · linux/arm64 53.3MB · android/arm64 56.2MB).

**HONEST LIMITS.** The ocserve suite's two failures (TestEnsureBinaryVerifiesIntegrity, TestV1491SpawnerKind) are PRE-EXISTING device-shape pins — they fail identically on the clean tree. The forge's code-search rate limit (10 req/min authenticated) still bounds the CANDIDATE path — the engine pages it and the walk falls back to the universal tree scan when the limit bites. The brain (HF-space) twins were changed for the caps, the grep folds and the journal snips; their own dt_spec rule-9 ceiling text is now honest rather than amputating.

## v1.56.1 THE UNBOUNDED OUTPUT (the user's follow-up)

The user's ask: *"Then try to remove the termux cap if possible and the in turn observation 256kb cap if that doesn't cause issues."*

**THE 100KB DEVICE CAP IS DEAD.** Termux's `RUN_COMMAND` returns ONE result Bundle capped at 100 KB — that was the last ceiling in the device hand (a 320 KB read or a 3,000-hit grep came back amputated). The answer was the law already in the tree: the device output rides the **loopback stream**, and the Bundle never sees it. So:

- EVERY jailed verb (`exec`, `pkg`, `ls`, `read`, `grep`, `find`) now rides the **streaming wrapper** — the old non-streaming path is gone from the file verbs.
- The wrapper POSTs the **COMPLETE log file** (`?full=1`) at the end — the engine *replaces* its buffer with it, so even a burst that cut the incremental flushes loses nothing.
- The engine's own stream buffer rises 2 MB → **8 MB** (the only ceiling left; when it fires, the marker carries the TRUE totals).
- The 100 KB marker survives **only** for the fallback path (the loopback never answered) — and there it says the truth.
- **Proved live**: `TestV1561_DeviceOutputIsNotBundleCapped` (a 320 KB file read arrives with 10,000/10,000 lines) + `TestV1561_DeviceGrepIsNotBundleCapped` (3,000 hits, all of them) — the real wrapper, the real `curl`, the real engine mux.

**THE OBSERVATION CEILING IS NOW THE WINDOW.** The 256 KB fixed floor is dead. The budget is the **window's physics alone** (90 % of the model's documented window minus what the in-turn history already holds), with a **1 MB floor capped at a QUARTER of the model's own window** — a 1 M-context model rides a ~3.4 MB result whole, a 128 K model ~437 KB, and a 32 K model gets a ~62 KB floor (the floor must never eat the window it lives in). The honest marker still carries the totals when physics really says no.

**Battery:** the server suite green (the Termux teach pin re-anchored to the new law), llm · grep · forge green, vet clean, `scripts/v1560-whole-tools-pin.py` (64 source pins) + the live rig (15 checks).

## v1.64 THE ARMED SHELF (the chat-tail + opencode-armed wave)

The user's ask verbatim: "We still have issues where the chat loads weird, long chats get preserved malformed, with messages unordered, the bottom chunk of tools and reasoning calls after the final response doesn't save and gets lost. Also opening a chat still points us at the top not the bottom… Opening the chat for a user should load bottom up not top down. The most recent chats are what's important, older messages can stay dormant until scrolled to… give a very generous amount (a month or couple worth of messages - 50ish mb maybe uncompressed). Another thing, opencode zen has a bug where it uses its own pills, our tools are not armed natively… Moreso it seems opencode can think for so long and nothing happens. We get the thinking pill for minutes on end with no visual feedback… one chat has the thinking pill for so long, another gets a direct reply. It's a bug from our end. Focus on fixing opencode, test it yourself. We are not rate limited, if you hit rate limits it's a false positive."

**v1.64.1 THE NATIVE SHELF** — the device's own serve-side diagnosis convicted THE UNMOVED ADOPTEE: an adopted session whose serve-side directory was still the ROOT resolved the ROOT config (no mcp block) — 30 running tools armed ZERO sessions natively. The adoption path now RE-HOMES the session into its per-chat dir (the live-proven per-location-instance law: the destination's instance re-resolves config + MCP). codemode flipped true→false: every doomalay tool is a FIRST-CLASS doomalay_<tool> (the permission config's own allow-rules arm them), never bundled inside Code Mode's execute (whose nested calls rode EPHEMERAL progress frames — the "bottom chunk doesn't save" half). The {tools} block teaches the DIRECT grammar; the pump strips the doomalay_ prefix so the pills render bare like native ones; ocToolSummary rides mcpbus.DefaultSummary (the ONE truth the native path uses).

**v1.64.2 THE LIVING WIRE** — StreamEvents restructured as streamOnce + a reconnect loop (bounded backoff) until the turn's terminal; THE BYTE WATCHDOG: the serve heartbeats every 15s — a connection silent 45s without a byte is convicted dead, cancelled, reconnected (the silently-dead SSE blocking in ReadString forever was the "one chat thinks for minutes, another answers instantly" arbitrariness). The quiet probe emits the honest elapsed ping ("still working… Ns in this turn") every tick it finds the turn alive; session.step.started rides as a progress line; outcome=interrupted is an honest failure, never an empty success.

**v1.64.3 THE UNLOST TAIL** — THE SERVE TRUTH RECONCILE: an engine kill mid-turn leaves the engine log mid-stream while the serve (wake-locked in Termux) COMPLETES the turn; the boot heal's "interrupted by engine restart" splice (+ v1.52.3's synthesized never-ran results) over the dangling window was the unordered, tail-less transcript. At OPEN (the events GET, manager peek) or the next SEND (handleTurn's top, before the user row, with the turn's own manager builder — the fresh-boot half the rig convicted: a fresh engine has no manager until the first turn), the serve's durable transcript (ListSessionMessages — the live-captured 2.1.2 content-part shapes, cursor-paginated, limit≤200 or it 400s) REPLACES the whole dangling window in ONE transaction (SpliceSessionEvents: delete > afterUserSeq, insert monotonic, the serve's own timestamps): reasoning→thinking rows, tool parts→tool_use/tool_result pill pairs (bare names + the summary law), text→assistant round rows, the idle marker→the honest terminal with the serve's own tokens/cost; failed/interrupted outcomes map the honest error (the 429 sentinel shape); unknown part types degrade to notices, never silent drops. Idempotent (a spliced log ends in a REAL terminal). THE OPEN LAW: every fresh open lands at the BOTTOM — the v0.34 "back where the user left off" localStorage restore (the stale 0 that pointed at the top) is DEAD. The bootstrap caps at the TAIL WINDOW (?tail=2500 + older:true) — a 50MB lifetime log never rides the open; older history loads ONE page (?before=<seq>&n=1000) when the reader scrolls to the top of the mounted window (the data-mi renumber + pixel compensation); THE GENEROUS WINDOW: 48MB of event content per session (the user's "50ish mb"), oldest-first via the (seq,bytes) walk, NEVER a pending turn's window.

**v1.64.4 THE WALL WALK + THE LIVE PROOF** — live-convicted: the free-limit wall is PER-MODEL (each free model carries its own ~1-3-turn window; a 429 on one says nothing about the roster — the user's "we are not rate limited" is half-right: it's a false positive for the ROSTER). On a wall the turn rides the NEXT cost-0 opencode-zen model from the live catalogue: SAME serve session (the context survives — the old session-recycle for the free class is dead), ONE honest notice, ONE retry; the exhausted roster answers the honest per-model terminal naming the rolling-clock reset. The walk is PER-TURN (the chat's model choice never silently changes). THE LIVE PROOF (scripts/v1640-armed-shelf-live.mjs — the real 2.1.2, the real key, real kills): S1 THE DIRECT ARM END-TO-END GREEN (calculator called bare-named, 17*23→391 through the engine's own /mcp/oc/<sid>, the pill rows PERSIST, the per-chat config codemode:false + the route, the serve's own log "mcp connected server=doomalay tools=31") · S4 THE RECONCILE GREEN (the mid-flight kill, the orphaned serve completes, the open honestly keeps the healed log on a fresh boot, the SEND lands the serve's tail whole — the splice gone, no never-ran lie, seqs monotonic, the engine log records it) · S5 THE OPEN LAWS GREEN (the 2500-event tail + older=true + the dormant page + older=false at the head) · the honest WALL-DEFERRED verdicts when the free windows are all full (the windows open on OpenCode's rolling clock — the rig hunts them with the real questions riding the probes).

**The proofs**: v1641 3/3 (the re-home idempotence, the directory-less build, the failed-move degradation, the bare-name pill, the direct grammar) · v1642 4/4 (the mid-turn reconnect, the honest wait, the interrupted verdict, the step ping) · v1643 5/5 (the splice grammar end-to-end + idempotence + the three degradations + the mapping shapes + the tail/before pages + the route + the retention with the pending-turn sanctuary) · v1644 3/3 (the walk, the exhausted roster, the empty roster) · the v1640 rig live · v1590 46/46 re-proven on the new code · v1421 24 · v1422 26 · v1424 46 · v1428 48 · v1350 62 · v1400 51 · go battery ALL GREEN + vet clean + cross-compiles (linux 55.4MB, android-arm64 55.6MB) · the v1390 census + pin baseline re-anchored (the parallel wave's Retry Pill CSS shifted index.html's crop literals — source-pin PASS, v1391 10/10) · discipline 7+B1 (the pre-existing trio only).

**Honest limits**: the free windows are tiny (~1-3 turns each) and open on OpenCode's rolling clock — the live rig's model halves (the S2 memory recall, the S3 stall pings on a real window) defer honestly when the roster is full (both are unit-pinned; the S3 no-hang + watchdog halves are live-proven every run); a live-client that already folded the healed log keeps its stale rows until the next open (the DB is clean; a reload fixes); the retention trim rides Maintain's cadence.

---
Task ID: v165-wave (the loud system: v164 research → PLAN-V165 → build → rebase onto the parallel v1.64.0 → ship)
Agent: Main orchestrator (THE LOUD SYSTEM wave)

Task: The user's four asks: (1) the opencode shell pill's collapsed header shows a static "shell" — make it the command's first word, "dynamically derived similarly to how our termux exec tool is"; (2) every system-injected prompt must be DYNAMIC ("add the tool it did verbatim back to it"; the proceed carries "the tail of the message for context") and RENDERED — "reuse the message box that appears when a model hiccups but add another state to it… displaying the prompt that we injected… never a silent injection"; (3) the collapsed headers get compound-command awareness (scan for || and && and other relevant syntax, "CD & grep or mkdir & ls as the header", cap at 2-3 commands); (4) hublib and web_search don't work for opencode ("hublib isn't exposed", "web_search doesn't work without a travily key, websearch ideally should work with simple google, duckduckgo, another opensource browser as it does with the other providers") + verify opencode can use GitHub tools (view releases, all that).

Work Log:
- Researched all four targets before any build (the standing law): the pill grammar (chatpanel.js termuxArgsOf exec branch = the program-token regex; the opencode shell pill rides the else-branch title=p.name), the injection corpus (nativetools.go: seam 347 + proceed 412 + answer-force 426 + budget 630; chat.go:403 the direct seam; server chat.go:2361 the continue nudge; the anti-degrade warnings ride tool results via the RetrySameCallDirective const at ~27 sites), the rendering vehicle (the hiccup box = the persisted notice event + .msg-notice with data-code states), the fold/export laws (forwardEvents' persist switch; foldEvents' accumulator overwrite), the websearch truth (opencode v2 docs: Exa/Firecrawl/Parallel/Tavily/TinyFish — ALL key-required; OUR doomalay_web_search IS the keyless Tavily-if-key → DDG → DDG-Lite → Bing ladder, exposed via /mcp/oc + armed on sessionMcpTurn), and THE TEACHING BUG (toolsBlockFor's pick line said "your native ones for files/shell/web" — actively teaching the model to use its keyless-broken native websearch).
- v1.65.1 THE SPEAKING HEADER: chatpanel.js commandTitleParts — ONE shared derivation (the termux-exec law widened): the first non-empty line, the QUOTE-AWARE compound scan (&& || ; | & outside ' " ` with $( ) paren-depth skipping), the ≤3-token cap + the honest '…'; the termux exec branch routes through it (singles byte-identical); the NEW opencode shell branch (fam === 'shell' — unambiguous, no app tool is named shell) titles the program + bodies the remainder (singles) or the full head line (compounds); the commandTitleParts rig seam joins module.exports.
- v1.65.2 THE LOUD INJECTION: llm/injected.go (EmitInjected — the non-blocking injected chunk; ProceedInjectionText — the dynamic tail); the wired sites (both seams + the dynamic proceed + the answer-force + the budget + the continueCore nudge via the new emitInjectedRow); RetryDirectiveFor in argrepair.go (the call VERBATIM, 480-byte honest clamp, the const stays the tail) swept through all ~27 termux/workspace/native sites; the server wire (the chunk-loop stamp {message, code:"injected"}, the forwardEvents persist case, the emit() case, the tail-read bookkeeping list); the PWA (the handleEvent injected branch with the replay lift, the role-injected renderer through the hiccup box's own classes with data-code=injected, the --accent CSS state + the ⌁ glyph + the 'system injected:' lead); the exports (the injectedMessage helper + the fold case + all four renderers: md "⌁ system injected:", txt "[system injected]", html, csv).
- THE LIVE CONVICTION THE RIG CAUGHT: foldEvents' assistant_delta case overwrites rows[len(rows)-1] with the accumulator — an injected row riding between deltas was CLOBBERED the moment the next delta landed (the Go unit test passed with a clean 3-event sequence; the rig's real 7-event arc convicted it). THE ACCUMULATOR BREAK: the injected case nils curAssistant/curThinking (the tool row's law) — an injected prompt is a user-side row; it ends the reply run; the post-injection deltas open a NEW assistant row. Pinned as the regression (TestV1652_ExportFoldSurvivesDeltaClobber).
- v1.65.3 THE OPEN SHELF: the toolsBlockFor pick line rewritten (web search → doomalay_web_search FIRST — keyless, the DDG/Bing ladder "as it does with the other providers"; the native websearch = the paid-key fallback; GitHub/repos → doomalay_workspace; the hub library → doomalay_hublib).
- THE REBASE: the parallel bot shipped v1.64.0 THE ARMED SHELF mid-flight (their PLAN-V164 + the v1640-armed-shelf-live rig + the first-class doomalay_<name> binding); per the +1 law my wave renumbered V164→V165 (the plan file, the rig v1640→v1650, the test files injected_v1642→injected_v1652, the in-code labels by NAME — the parallel wave's own v1.64 labels stand); ONE conflict (ocservetools.go) hand-merged: their first-class-tools law + my job-routing pick line, one coherent block.
- THE GOLDEN PATH (the real free window): the engine-driven opencode serve turn (the merged tree) — the model's native websearch FAILED (LIVE-CONVICTION of the user's report: no Tavily key), the model reached for the shelf (web_search pills + shell curl/git) and answered BOTH asks (the websearch-docs URL + the repo's latest tag v1.64.0-the-armed-shelf — which is how the parallel ship was discovered mid-run); the pills read 'curl & head' + 'git & head' in the real PWA (the compound-derived titles LIVE).
- PROOF: scripts/v1650-loud-system-rig.mjs 55 GREEN on the merged tree (§A 21 source pins · §B 16 derivation pins through the real chatpanel.js module seam · §C the loud arc LIVE: the dynamic proceed row on the WS + asserted inside round 2's request + re-delivered on replay + rendered as the hiccup box's new state in the real panel + carried by the md export · §D the open shelf LIVE: the /mcp/oc catalog carries web_search+hublib+workspace, a REAL keyless web_search answers, hublib answers, the vault-GITHUB_PAT-authenticated workspace views the user's OWN repo's releases · §E zero page errors) + the v1652 Go pins (llm: the verbatim law, the dynamic tail, the non-blocking chunk, the loud proceed integration with the request-side assertion; server: the wire persist, the tail-read skip, the export rows, THE ACCUMULATOR-BREAK regression) + the full battery on the merged tree: go 18/18 + vet clean.
- Harness convictions: the seam stub (global.WebSocket = FakeWS for the chatpanel require) CLOBBERED Node's real WebSocket — the rig's own live legs hung until the capture/restore; the fake provider's catalog sync consumed the announcement round (the /models route must answer separately); the session create answers ID (capital); the sandbox's DDG egress times out but Bing answers (the ladder's own fallback) and GitHub authenticates via the vault's GITHUB_PAT.

Stage Summary:
- v1.65.0 THE LOUD SYSTEM SHIPPED: the command pills SPEAK (the opencode shell header = the command's own program, compound-aware 'cd & grep', capped, quote-aware — 1:1 with the termux exec law, live-proven 'curl & head'/'git & head' in the real PWA); the system's injections are LOUD (every injected prompt rides a first-class persisted event through the hiccup box's NEW accent-toned ⌁ state — live, replayed, exported — and the texts are DYNAMIC: the proceed carries the announcement's tail, the anti-simplify order carries the call verbatim); the shelf is OPEN (web search rides the keyless DDG/Bing doomalay_web_search FIRST — the native websearch's paid-key wall live-convicted — hublib named, GitHub releases verified through the vault-authenticated workspace). The parallel bot's v1.64.0 ARMED SHELF stands untouched beneath (their first-class doomalay_<name> binding + this wave's teaching merged in one file). PROOF: v1650 55 GREEN + the v1652 Go pins + go 18/18 + vet + the golden path live on the real serve.

---
Task ID: v167-wave
Agent: Main orchestrator (THE PATIENT CANVAS wave)
Task: The user's 2026-10-23 four-list: (1) the complex multi-pipe shell command pill loading indefinitely + the chat throttling/halting (a new chat or a provider switch "fixes" it — pills in EVERY chat load indefinitely or lag while the bot continues past); (2) the silent 429 (no visual indication the chat chained a timer — opencode = a very long uninsightful wait; OpenRouter = an interrupt/stop); (3) the orbiting stars' huge zoom-out performance drop (orbit slower, exponential slowdown then freeze, find a library, negligible cost); (4) the canvas size limits (8-64/128k, no infinite grid). Methodology per the standing law: hypothesis → web research → PLAN-V167 → phased build → rig + redteam.

Work Log:
- Sandbox was CLEARED again (~/doomalay gone) — rebuilt via rebuild-sandbox.sh (clone at 2f6173ac = v1.65.0, Go SDK, engine build OK, keys restored).
- RESEARCHED before any build: the opencode v2 API (the sub-agent's docs+source study — POST /api/session/{id}/interrupt is the v2 abort, empty body → {interrupted:bool}; /api/event is VOLATILE BY CONTRACT with a 4096 dropping queue — "events during disconnection are missed… build state reconciliation on top of REST reads"); the star-rendering landscape (the second sub-agent — Pixi v8.21 already vendored exports ParticleContainer+Particle; the LOD ladder full→thin→freeze→cull is canonical; three.js = a second GL context +600KB; pixi-particles is dead for v8); the code audit (the pump's own comment admits frames missed in gaps are only covered by the TERMINAL probe; oc_free_walled carries NO retry_class; the SSE reader has NO error-frame branch — OpenRouter's mid-stream kill shape was silently dropped; the zombie guard didn't exist; the atoms run at full rAF forever with no zoom law).
- v1.67.1 THE INTERRUPT HAND: Manager.InterruptSession (the researched v2 abort) + THE STALL CEILING (ocServeStallCeiling, 5min default, DOOMALAY_OC_STALL_CEILING_MS; absolute silence = no live frames AND no record mutation → interrupt → ocClosePendingPills (the honest "the command never returned within N minute(s)") → the oc_stalled error + terminal → the lock releases) + THE ZOMBIE GUARD before every Prompt (an orphaned in-flight turn is interrupted; a stale one whose interrupt fails is recycled wholesale) + session.execution.interrupted is a first-class terminal + the honest-wait ping names the pending tool + the ceiling.
- v1.67.2 THE UNLOST MID-TURN: the probe tick reads the durable transcript (ListSessionMessages, ONE read serving three laws — the missed-tool-result reconcile re-emits from the record (idempotent by call ID, the pill closes in place by tool_use_id); the record-activity tracker (the first observation is the BASELINE — never refreshes; a CHANGED stamp between ticks is LIFE); the ended check hands SessionIdleSince the verdict — a quiet ALIVE tick costs exactly one transcript read) + THE TURN-END BELT in the PWA (any pill still pending at a terminal closes honestly, live AND on replay).
- v1.67.3 THE LOUD 429: openAIStreamError + the scan-loop frame branch (a 429/rate-limit mid-stream frame → wrapRetryable("429") — the sentinel arms; every other frame surfaces as the honest stream error) + the oc_free_walled terminal carries retry_class=429/provider=opencode + the 429 fail path PREPENDS the "auto-retry timer is armed" progress line + the PWA error bubble names the listener (retryClassLabel + "the timer probes and CONTINUES this conversation itself; no tap needed").
- v1.67.4 THE NEGLIGIBLE STARS: THE ZOOM TEMPO LAW in AtomCore (starTempoFactor: 1 at ≥0.75, exp(-k·(0.75-s)) through the band (10× slower at the edge), 0 below 0.45 — FROZEN; starFrameCadenceMS: 30fps → 4fps; MOTION_TEMPO 0.5→0.25) + paintCore multiplies the factor (both hosts) + ambientActive's atoms branch parks when frozen (zero frames; update() re-arms on zoom) + the atom-only frame's cadence clock (time-based, drift-corrected) + the pixi layer's quantized star clock (lastStarStepMs — the on-demand driver self-parks between steps; zero frames frozen; the driver keeps ticking while alive).
- v1.67.5 THE FINITE PLATE: the dial's "Off — infinite" rung is dead; the sanctioned ladder is [8192..131072]; a saved 0 migrates once (worldSizeV167).
- THE RIG (scripts/v1670-patient-canvas-rig.mjs): a FAKE opencode 2.x serve speaking the Manager's own endpoint map (provider/model/session/message/model/move/interrupt/delete/prompt/event — the turn's event burst is CLIENT-GATED like the real serve) + a fake OpenRouter answering 200-then-the-429-error-frame. The rig's own live convictions: req.on('close') fires IMMEDIATELY for bodyless GETs (the SSE client deregistered itself — res.on('close') is the law); the wsTurn needs ownTurn gating (the replay's historic terminals ended the collection early).
- v1.67.6 THE PROOF: the rig 34/34 ALL GREEN (LEG A the stuck turn: the ceiling fires → the interrupt POSTs → the pill closes → THE SAME CHAT accepts a new prompt; LEG B the lost result re-emits from the durable record through a real connection gap → the pill closes → the answer lands; LEG C the 429 frame surfaces WITH retry_class → the sentinel arms → THE PILL SHOWS + the wall arms + the arm line + the PWA law; LEG D the tempo/cadence math + the pixi parity + the finite-plate laws) + the v1672 Go pins (6: the frame branch, the pill closes, the stall shape NEVER arms, the wall arms, the 429 arm line, interrupted-is-terminal) + go ALL + vet clean + the cross-compiles (linux 55.5MB + android-arm64 55.6MB) + the REDTEAM in a real browser: zero page errors, the tempo law LIVE (f(0.6)=0.316, f(0.4)=0 frozen, cadence 250ms), the dial's exactly-5 rungs, a REAL openrouter turn answering through the real key (terminal idle, the transcript persisted thinking→deltas→assistant→idle).
- A mid-wave regression caught + fixed: the first probe-loop draft made 3 REST reads/tick and refreshed activity on the BASELINE — TestV1642_HonestWait convicted it (0 pings); the shipped shape is ONE read/tick with the baseline never refreshing and the ended check FIRST (the test passes byte-unchanged).

Stage Summary:
- v1.67.0 THE PATIENT CANVAS SHIPPED: the stuck turn dies honestly at the ceiling (the interrupt + the honest pill closes + the lock releases + the zombie guard), the lost result re-emits from the durable record (and the turn-end belt closes every residual pill), every 429 arms the sentinel VISIBLY (the frame + the wall + the arm line + the error text naming the listener), the stars are negligible (2× slower base, exponential zoom band, frozen below 0.45 with zero frames, the cadence law, the pixi quantized clock), and the canvas is finite (8k–128k, no infinite rung). PROOF: the v1670 rig 34/34 + the v1672 pins + go ALL + vet + the cross-compiles + the real-browser redteam (zero errors, the law live, a real provider turn). The parallel bot shipped nothing during the wave (clean push, no rebase needed).

---
Task ID: v171-wave (the honest reconcile: the device export conviction → the rig → the anchor + the recycle → ship)
Agent: Main orchestrator (Z.ai Code, session web-b99ac3b8, continued)
Task: The user's pocket-bridge conviction — "we have major tooling issues, a lot of tools never finish the output" — with the device export doomalay-sky-6adbbb21 (the opencode provider on the real phone, the pre-v1.70 engine).

Work Log:
- Dissected the export's raw event stream: 14 logical tool calls but 93 tool events — every prior turn's tool_use/tool_result pair REPLAYED into each new turn (2, then 6, then 7, then 9, then 12 pairs — quadratic growth), all landing on the silence-probe cadence with the serve's own "Tool execution interrupted" text; plus the oc_stalled death loop (the conviction interrupted the turn, the auto-retry's continuation on the SAME serve session answered `git log` in 0s then hung FOREVER on `ls -d */`).
- Root-caused both: (1) v1.67.2's mid-turn reconcile trims its window by the newest IDLE marker — the pocket serve (live-verified against the harness's real 2.1.2 + its SQLite) writes NO idle rows for interrupted turns, so the trim saw the WHOLE session as the window and every fresh pump (per-turn dedupe maps) re-emitted all prior pills; (2) v1.67.1's stall ceiling interrupts but never recycles the session — the wedged bash state survives into every later turn.
- Wrote scripts/v1710-replay-rig.mjs (the fake 2.1.2 serve + the real binary, four legs: the pocket replay shape, the idle belt, the stall recycle, the turn anchor) — CONVICTED the pre-fix build 17/22 with the device's exact signatures reproduced byte-for-byte.
- THE FIXES: v1.71.1 THE TURN ANCHOR (ocAnchorTurnWindow — the reconcile window is time-anchored to the turn's own start, ZERO grace on the same-host clock law; the idle trim stays as the belt within the window; a no-stamp message drops safely) + v1.71.2 THE STALL RECYCLE (the oc_stalled conviction DELETEs the wedged serve session + forgets the binding; the next message starts a FRESH serve session; the honest message says so).
- Re-ran the rig 22/22 ALL GREEN; the v1670 rig re-proven 34/34; TestV1710 x4; go build + vet; the ocserve + llm suites; the server suite chunked green (the full-process run OOMs in this sandbox — the dev stack's memory, environmental, the same note as the v1.70 ship); the linux/amd64 + android/arm64 cross-compiles.
- Shipped buildinfo 1.71.0 (ONE past v1.70.0) + the README v1.71 section + this record.

Stage Summary:
- The replay is dead: a prior turn's tool part can NEVER re-emit (the time anchor is immune to the idle-marker situation entirely); the missed-result recovery within the turn keeps working (the rig's LEG D + the v1670 rig's LEG B both hold).
- The death loop is dead: a stall conviction costs the wedged serve session (by design — the honest message says so) and the next turn rides a fresh bash.
- The rig convicted FIRST (17/22 with the exact device signatures) and passes 22/22 after — the evidence chain is reproducible against any build.

---
Task ID: v169-wave-completion (the chain record: v1.69.1–3 + v1.70 + v1.71 parallel ships recovered post-context-loss; v1.71.1/.2 authored + shipped as v1.72.0)
Agent: Main orchestrator (THE SHARED CANVAS — phases §v1.69.4 + §v1.69.5, renumbered by the +1 law twice)

Task: Complete PLAN-V169-THE-SHARED-CANVAS: the bundle-management dashboard + fork tags + the canvasespanel sharing section (§v1.169.4) and the full two-device live proof (§v1.169.5). The earlier phases (v1.69.1 THE DOCUMENT, v1.69.2 THE ROOM, v1.69.3 THE HANDSHAKE) shipped in a prior context-lost session (f1f63d6e, 3946de2c, d6c32195); the parallel bot shipped v1.70.0 THE ROBUST FIELD and v1.71.0 THE HONEST RECONCILE mid-wave — both renumbering triggers, both rebased clean (zero conflicts, disjoint files).

Work Log:
- Rebuilt the cleared sandbox (~/doomalay + the Go SDK via rebuild-sandbox.sh) and audited everything before any build: three parallel Explore agents mapped the hub/publish/.doomcanvas machinery (the deletedFile NDJSON op proven client-side in forge/hf.go since v0.93.5 — the unpublish recipe was IN-REPO), the shipped collab phases 1–3 (the full route map, the ACL, the gated portals, the mounts), and the rig harness laws (the deployment law config, the check-passing pattern, the battery list).
- v1.71.1 THE DASHBOARD (97f1190d): hub CommitFile.Delete + Service.Unpublish (the sweep: meta+payload+companions+card art + index regen; the double authorship gate) + POST /api/hub/{type}/unpublish + ItemsMine + the Item lineage fields; the PWA MY PUBLISHED view (the third pill, exclusive with the downloads pill; grouped management rows; the unpublish confirm bar) + hubitem's ownership-probe FAB + the fork chips everywhere; the canvasespanel ⇄ share row + the shared-count chip + the worldsmanager parity row; THE CODE IS THE LOCATOR (Pair accepts an empty canvas — GetCollabInviteByCode; the collision-free mint; the claim + approved poll carry the canvas) + collabui's canvas-optional pair + THE RETURNING GUEST boot re-activation; manifest 1.1 (parentUuid/parentAuthor/parentName + contentHash; imported.uuid stamped at import); the canvas-row probes (imported_uuid/imported_author/shared_count); the journal GC wired (the checkpoint's calm, threshold 256).
- v1.71.2 THE LIVE PROOF (4c01c489): scripts/v1720-shared-canvas-rig.mjs (port 8720) — LEG A the golden path (the code-only handshake arc + two REAL SharedDocSession devices on one canvas through the real wire, convergence both sides, the gated portal live), LEG B the redteam ladder, LEG C the perf pins (solo parity + O(members) + the calm window + dormancy), LEG D reconnect+replay, LEG E the format-1.1 lineage round-trip through the real bundle modules.
- THE HARNESS CONVICTION: rebuild-sandbox.sh hard-resets the tree — a mid-session rebuild WIPED the uncommitted Go phase (the JS survived, made after) — re-applied every Go edit and COMMITTED IMMEDIATELY after the first green build; the law is now in the plan file.
- THE RIG'S THREE LIVE CONVICTIONS, ALL FIXED: (1) THE POST-CATCHUP DRIFT LAW (collabcore activate) — the drift derived from the STALE pre-catchup snapshot, so a fresh guest's catch-up icon.adds came back as icon.removes that gutted the shared doc server-side; the earlier rigs never caught it (their mocks pre-seeded local==baseline, the catch-up never ran); (2) THE NEVER-REWINDING CLOCK (store AppendCanvasOps) — after a journal trim the next batch restarted at seq 1, stranding every reader whose cursor sat above the restart (the base is now MAX(journal max, fold_seq); the v1691 pin honestly re-anchored to the new numbering + a tail pin added); (3) THE ONE-LIVE-INVITE LAW AT THE DB LEVEL — the invites PK is (canvas_id, code), so a new-code mint orphaned the old claimed row beside the fresh one; MintInvite now clears the canvas's every prior row before the upsert.

Stage Summary:
- v1.72.0 THE SHARED CANVAS SHIPPED (the tag v1.72.0-the-shared-canvas): PLAN-V169 complete — phases 1–3 from the prior session + THE DASHBOARD + THE LIVE PROOF, all live-proven under the deployment law. PROOF: the v1720 rig 64/64 GREEN ×3 stable + the collab regressions (v1691 32/32 re-anchored, v1692 27/27, v1693 27/27) + v1428 vessel 48/48 + TestV1711 ×10 (the hub pins: the sweep's deletedFile ops + the authorship gate + the mine filter + the sanitizers; the collab pins: the code-only pair + the collision-free mint + the honest miss + the journal GC; the server pins: the wire arc + the row probes) + go build + vet + the full battery 19/19 + the linux/android-arm64 cross-compiles.

---
Task ID: v173-the-patient-flow (PLAN-V173 complete: v1.73.1 THE NET ARM · v1.73.2 THE JOB LAYER · v1.73.3 THE HONEST CLOCK + THE AFTER-THE-FACT UI · v1.73.4 THE LIVE PROOF — shipped as v1.73.0)
Agent: Main orchestrator (Z.ai Code sandbox — session web-b99ac3b8)

Task: The user's continuity architecture, verbatim: "I thought each tool call was it's own process with its own pid, so the chatbot can call as many tools and each tool act as a subagent, not interfering with the chat. Our top priority is continuity, we already have an issue where our timer handler doesn't pick up network interrupts and add the chat to the continuation timer witha visual queue or hint. And now we have issues where tool calls that take a lot of time interrupt the chat flow completely? Wouldn't it make more sense if that long tool call gets its own pid with its own allocated resources, goes on for however long and then returns when its done?… That way a model can try one tool call, do other methods, decide weather to kill the old pid tool call or not. The UI be dealt with after the fact, tool calls that take a long time can re-render once complete, possibly in a different theme color indicating they took time, we can even display the time it took for each tool call if we don't already."

Work Log:
- Resumed the context-lost tree (PLAN-V173 + the half-built jobmgr/jobwrap mid-refactor, handlers.go brace-broken): repaired the split, gofmt'd the churn (the space-indented files kept their house style), and rebuilt green.
- v1.73.1 THE NET ARM: ocServeFailEvents (the oc-bridge's ONE classifier) learned the net class — netx.IsTransient (the regex that runs the turn-level pause ladder, extended with the Node/undici forms: "fetch failed", ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN, "socket hang up") + the gateway statuses 502/503/504 → retry_class=net/retry_provider=opencode; the NET arm line ("network interrupted — the auto-retry timer is armed… no tap needed") precedes the error + the sentinel's pill. Auth/stall/interrupted never arm. Pinned: TestV1731 ×6 (the arm shape, every transport form, the never-arms, the 429 ordering, the netx forms, the sentinel accepts net).
- v1.73.2 THE JOB LAYER: engine/internal/jobmgr (the lane manager: Job{j_id, working→completed|failed|cancelled, terminal-never-transitions}, Begin/Settle/Status/Kill/List/DrainSettled, the 8-per-chat capacity guard, the event sink, the dispatch-start clock, SettledBlock/Line) + mcpbus/jobwrap.go (withGrace + jobDispatch). THE WRAP PLACEMENT CONVICTION (live, the rig's LEG C): handlerFor alone left the chained proxies unwrapped; Bus.CallTool alone left the /mcp + /mcp/oc HTTP ROUTES unwrapped (they dispatch through the mcp-go server directly — the serve's /mcp/oc slow call took the FULL 15s and stalled the serve turn); the final law: the wrap rides the SERVER MIDDLEWARE (composed with the v1.13.2 panic containment) — every surface at once. THE DETACHED LANE CONVICTION (the wrap pins): the lane's context must NOT ride the MCP request's cancellation — the in-process transport cancels the REQUEST ctx when the handler returns the ticket, and a child ctx died with it (the lane settled instantly as "(cancelled)"); context.WithoutCancel keeps the VALUES (the Turn rides ctx) while shedding the request's deadline. The trio (job_status/job_kill/job_list) is always-on, never wrapped, never gated; the kill is cooperative (best-effort, MCP's law). THE DELIVERY: the sink → the persisted "job" chat row (emit's new case lifts the payload top-level); the native loop drains the settled ring at EVERY round top (round 0 included — jobs settled after a turn's end deliver on the next turn's first round) as the loud history row; the serve path's opening text carries them. The census re-anchored: 34 tools, 23 always-on (+ the chained 123).
- v1.73.3 THE HONEST CLOCK + THE AFTER-THE-FACT UI: Result.DurationMS on the bus + ChatChunk.DurationMS → the live event top-level (ALWAYS on tool_result — 0 is honest for an in-process call) → INSIDE the persisted replay JSON; the serve's own tool pills clocked (the use row's first-seen time is the start — the serve's frames carry no per-tool timestamps); the direct-dispatch fallback gets a forwarding-channel clock. The PWA (chatpanel.js + index.html, theme tokens only): fmtDurationMs (ms/s/m-s shared by pills + job rows), the per-pill duration chip (tool-pill-dur), THE SLOW TONE (SLOW_TOOL_MS 30s default, window override → data-slow → the --warn composition), the job event branch + the job row (✓ --ok / ✗ --err / ⊘ dim + the collapsible result). The exports: jobLine (the glyph + the tool + the verb + the honest duration + the clamped result) in md/txt/html + the fold. Pinned: TestV1733 ×6 (the persist-inside, the emit lift + the DB row, the export lines, the PWA source pins, the serve-pump clock, the delivery drains).
- v1.73.4 THE LIVE PROOF: scripts/v1730-patient-flow-rig.mjs (port 8730, THE DEPLOYMENT LAW) — a fake 2.1.2 serve (the v1670 shape + netfail/servejob modes), a fake OpenAI provider (the scripted rounds keyed on the last tool result: the slow_probe call → the ticket → the calculator → job_status → the answer; the kill script), and a SLOW external MCP chain server (the rigslow_slow_probe tool, 15s — the chain has no SSRF guard, the configured-server world). 34/34 ×3 stable: LEG A the net arm end-to-end (the undici failure shape → retry_class=net → the arm line → the pill → THE AUTO-CONTINUE answers with no tap — the mode flips mid-collection like a real network healing); LEG B the native lane (THE CONTINUITY PROOF: the turn ends idle in 5.1s while the 15s lane runs; the calculator fires mid-lane; job_status answers RUNNING; the completion row lands after the fact with the honest ≥12s duration + the slow probe's own text); LEG C the serve-path lane (the fake serve's model calls the chained tool THROUGH the engine's /mcp/oc/<chat> route — the round-trip carries the ticket at the 3s window, never the 15s wait; the turn continues; the completion lands); LEG D the kill (STOPPED best-effort, the cancelled row, the never-transition law); LEG E the honest clock (duration_ms on every tool_result + the PWA/CSS source pins).
- THE TUNNEL LIVE LEG (the user's live engine at the new URL — deliver-mills-dealt-ridge, confirmed v1.71.0-the-honest-reconcile): the tool flow HELD on the real device — a real nvidia glm-5.3-flash turn's time_now pill OPENED + CLOSED with the live result + the answer composing. The sibling symptoms caught in the wild: the chat WS dropped at ~30s idle (Cloudflare's kill — the reconnect+replay law owns it; a chat-WS keepalive is a future candidate), the nvidia deepseek-v4.1-flash endpoint answered NOTHING for 150s (provider-side capacity — the honest wait ladder spoke every 15s, the engine never hung silently), and the tunnel itself went 1033 minutes later (the device offline — the network-interrupt world this wave arms for). One test chat may remain undeleted on the device (the 530 hit mid-delete when the tunnel died): "v173 rig check (deleted after)" — delete it at the next tunnel-up.
- THE BATTERY: the v1730 rig 34/34 ×3 + the v1670 rig 34/34 + the v1720 rig 22/22 + the v1710 replay rig 22/22 + TestV1731 ×6 + the jobmgr pins ×7 + the mcpbus wrap pins ×8 + TestV1733 ×6 + the mcpbus census (34/23/123) + the v1134 external re-anchor + go build + vet + the package batteries (llm 118s, mcpbus, jobmgr, netx, ocserve, store, collab, obs, config, djournal, forge; the server suite green in chunks — the monolithic run OOM-kills in this 4GB sandbox with the Next.js dev server resident, the documented environmental limit) + discipline 7+B1 (the pre-existing appender trio) + the census CSV + the source-pin baseline regenerated (the line shifts; zero new literals — every new color is a token composition) + the linux 55,729,153B + android-arm64 56,054,529B cross-compiles.

Stage Summary:
- v1.73.0 THE PATIENT FLOW SHIPPED: every tool call that outlives its grace window gets its own lane (own goroutine, own detached context, its own clock), the model continues unblocked, the completions land after the fact as first-class rows, the model can kill its own lanes, the duration rides every result, and the network interrupt arms the continuation timer with the visible hint + the no-tap auto-continue.
- The honest architecture note: the lane is a goroutine + a detached context (the user's "own pid" — the engine is one process; the isolation is the cancellation domain + the independent lifecycle + the kill handle, which is what the pid metaphor wants: non-interference + killability + after-the-fact delivery).
- The next session MUST rebase before pushing (the parallel wave is active on the same repo) and check the tunnel for the leftover test chat at the next tunnel-up.

---
Task ID: v174-ship (THE SURE HAND — the tool-reliability wave: the user's seven bullets, PLAN-V174 complete, shipped as v1.74.0 after the +1-law rebase over the parallel UNBOUNDED LANES wave)
Agent: Main orchestrator (Z.ai Code sandbox — session web-1b97ea69)

Task: The user's seven bullets verbatim: (1) "Still so many tool hiccups… the rate at which models fail to land tool calls is too high" (2) "Auto retry got armed which was correct but displayed that it will try to continue in 0:00?? Armed for 429 rate limit. Me manually pressing continue without waiting worked" (3) "The chat seemed to break out of its shell or intent to download something external when it wanted to rebase?!?! It started talking about how it wants to use termux instead cause our tools where causing issues?" (4) "One time I caught it saying we gave truncated returns??" (5) "Many times it felt like the model had to solve problems that it really shouldn't have" (6) "Sometimes the model does a tool call, it fails, but executes successfully. But the model goes on like regular as if it hadn't just failed" (7 — MOST IMPORTANT) "Our surgical editing tools + Json or text tools are very limited and bad… we rely too much on JSON and text parsing when models don't seem like they want to do that… the model always has to find workarounds to surgically edit files, it has to create patches and fix mistakes that shouldn't happen because the toolset we have for editing is bad and we rely too much on a rigid structure. Isn't there some open source project/s that can help us with this."

Work Log:
- Rebuilt the cleared sandbox (Go 1.25.5 at /home/z/sdk/go; the repo at v1.73.0 f9fa4bd); four parallel agents ran FIRST per the standing loop: three deep audits (the landing path + the phantom failure + the 0:00 pill; the surgeon + the truncation inventory; the workspace escape surface + the friction catalog) + one web-research agent (the open-source answer: aider's Apache-2.0 edit contract + the polyglot landing data, Roo/Cline's bounded fuzzy + line-number stripping, Anthropic's str_replace anchors, jsonrepair's ISC algorithm with Go ports, the ast-grep/tree-sitter verdict). PLAN-V174-THE-SURE-HAND.md committed before any build (b803bfe).
- v1.74.1 THE HONEST FAULT LINE (51a2276): the head-line law (the error/refusal classes judge ONLY the observation's head + the exec shape's exit_code — content lines NEVER count) + the structured IsError verdict through busExecute into the hiccup notice + the repeat-cache gate + the jobwrap once-delivery drain + the honest panic/cancellation texts. Pins TestV1741 ×6 + the once-delivery pins ×2 + the v1701 classifier re-anchored.
- v1.74.2 THE SURGEON'S OATH (0709f71): surgeon/partial.go + lenient.go — ApplyEditsPartial (the good edits land in one commit; the misses get the actual-lines re-ask + the already-applied hint + the don't-re-send law), the leniency ladder (normalization/CRLF/cat-n stripping → exact → indent-flex → elision → bounded fuzzy ≥0.90 reported), the read anchors (forge FileContent.RangeInfo + line_numbers + termux read's range parity), the schema honesty (edits=ARRAY via PropArray, termux args=OBJECT via the new PropObject + mcp-go WithObject), THE LATENT PANIC in flexMatch killed (the never-panic guard — live-convicted by the numbered-strip pin). Pins TestV1742 ×10 surgeon + ×5 server (the e2e 2-of-3 PUT proves the commit carries ONLY the applied edits) + the mcpbus termux-schema pin re-anchored.
- v1.74.3 THE TERMUX TAIL (ed5a70c): the 100KB tail law (the patch read rides the stream path + the announced-size check + the refusal — the old bundle path SILENTLY DESTROYED the tail of every >100KB file it patched), the LIVE detector (the bridge's stdout_original_length finally decoded — the reflection was dead code), the honest grep (the literal \n NOTE dead, the TRUE candidate count, the scan-position cursor, the resume param on the verb + the schema).
- v1.74.4 THE DEEP PARSE (3c9d76b): jsonrepair.go — the ISC subset ported in-house (unquoted keys/values, comments, fences, trailing commas, Python literals, NaN, concat, missing colons; bare numbers stay bare) as the ladder's deepest rung AND the native gate's rung 4; the cut verdict survives; the comment-adjacent close fix in RepairJSONQuotes; the loud web teach texts. Pins TestV1744 ×4 + the mcpbus empty-query pin re-anchored.
- v1.74.5 THE 0:00 CLOCK (e96c60f): the order law (the arm fires BELOW the error row's persist — the v1.61.3 comment finally true; the armRetry capture block), the Disarm closing row ("continued without the timer"), the countdown honesty (probing…/timer ended — the frozen 0:00 dead). Pins TestV1745 ×3 + the v1731 source pin re-anchored.
- v1.74.6 THE HONEST DOOR (2db358f): the API-only truth in both manifest blocks (no clone/rebase/merge — sync is the rebase eye, real git on the device), the complete teaches (30-of-30 + 18-of-18 verbs), the serve scratch-dir truth, the device-row split. Pins TestV1746 ×4.
- v1.74.7 THE LIVE PROOF (5ea4dd1): scripts/v1740-sure-hand-rig.mjs (port 8740; the fake chained-MCP tool server + the fake GitHub + the fake OpenAI provider). THE SHADOW CONVICTION — the rig's first fire caught v1.74.1's own Go SHADOW ('observation, degraded, callFailed := …' in the else-if scope shadowed the loop-scoped observation): EVERY tool result arrived EMPTY on the wire to the provider on every multi-round native-tools turn; the v1730 regression rig convicted it live (34/34 → 27/34 → the fix → 34/34) — '=' not ':=' + the loop-scoped declaration + the comment that teaches the law. The v1136 malformed pin re-anchored (the old fixture — an unquoted arithmetic value — now LANDS through the deep parse; the unrecoverable class is prose).
- THE REBASE (68bab09): the parallel bot's UNBOUNDED LANES wave (3 commits built on my phase 6) wholesale-REFORMATTED the files the wave's laws live in; the auto-merge silently reverted five shipped laws (the order law, the 3-value busExecute + the structured verdict, the deep rung, the honest-clock channel, the dropped jobmgr.SetEventSink completion rail — the v1730 rig convicted the sink loss live 34→27). The amicable resolution: their pure-reformat rewrites of server/chat.go + llm/chat.go + llm/mcpbridge.go dropped (the -w diffs prove zero real change), their REAL additions kept (toolrunner.go, the jobmgr capacity config, store/turnstate.go, server/debug.go, the WithProgress wrappers), the completion rail restored. THE LESSON: a parallel wave that reformats a whole file eats every surgical law in it — the rigs are the only law (both regressions were caught by rigs, never by unit tests).

Stage Summary:
- v1.74.0 THE SURE HAND SHIPPED (the tag v1.74.0-the-sure-hand): the phantom failure, the 0:00 clock, the rebase trap, the truncated tail, the surgeon's oath (the open-source answer — aider's contract ported), the deep parse (jsonrepair ported), and the honest door — all seven bullets answered. PROOF: the v1740 rig 39/39 ×3 stable + the regressions (v1730 34/34, v1670 34/34, v1720 64/64, v1710 22/22) + TestV1741–V1746 + the full batteries (llm 117s, mcpbus 36.5s, surgeon, forge, jobmgr, termuxbridge, store, the server chunks) + vet clean + the cross-compiles (linux 55,908,233B + android-arm64 56,290,241B).
- The tunnel was DOWN all session — the device redteam (the real APK: the phantom-failure UI, the partial-apply pills, the termux tail) runs at the next tunnel-up, and the leftover "v173 rig check (deleted after)" chat from the v173 session still wants deleting.
