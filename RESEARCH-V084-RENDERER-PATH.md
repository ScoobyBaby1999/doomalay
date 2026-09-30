# RESEARCH-V084 — THE RENDERER PATH (stay, or add languages / libraries / a game engine?)

User spec (verbatim): "Let's research and document what we should do, if we should
stay as is or add some languages or libraries or maybe even game engine like godot
to the app. Here is why; the app is current laggy and feels slow and unresponsive,
as if the load is already taking its toll. And we haven't even started in terms of
UI complexity.. we want to render tens and even hundreds of chats and icons, we
want some to have dynamic connections that have animated UI and change depending
on what is going on between a network of chatbots. We want each chatbot to have
its own UI tweaks (atom orbiting workspaces, persona badges, and so much more I
haven't said yet). A network of chats managed by a panel with judges using all our
complexity should eventually look like a nebula and galaxy, with many chats having
many connections with their own orbits, massive manager chatbots emitting light
that reflects off other chatbots like stars, ext.. we are going to go crazy yet,
we haven't started. We shouldn't be facing any lag or unresponsiveness yet as we
intend to introduce SO much more load."

---

## 1. WHERE THE LAG ACTUALLY IS (measured, not guessed)

The frame budget on a mid-tier Android System WebView is ~16.6ms (60fps) shared
between: JS sim + paint, style/layout, compositing, and the WebView's own chrome.

| Hotspot | Evidence | Status |
|---|---|---|
| **The lattice repaint** (per-dot gradient sampling, per-glow `createRadialGradient`, 75k hash calls/frame) | v0.83.3's honest A/B: solid themes 38→59fps / 43→60fps; mesh-gradient worst case 33→44fps at phone-physical fill (1236×2745, amp100, both anims) | **FIXED for the cached case** (v0.83.3 lattice cache: per-cell derived records, prerendered glow sprites, cached samplers/CanvasGradients, DPR cap 2). Mesh-gradient ambient is the remaining 44fps case. |
| **Full repaints for tiny animations** | Before v0.84.1, ANY moving element (atom stars) would force the full `renderGrid()` per frame even when the grid was pixel-stable | **FIXED structurally** (v0.84.1 atom-only frame: resting grid untouched, only the star layer clears + repaints). The pattern is now established for every future "one small thing moves" feature. |
| **The DOM icon layer** | Every `.chatbot` is a positioned element with `will-change: transform` (a compositor layer hint). At ~100 icons that is 100+ layers × texture memory at DPR ≤2 — plus the projection painter (`DoomProjection`) re-anchoring gradient windows, and full-panel `innerHTML` re-renders on state changes | Bounded today (tens of icons), **the real ceiling for "hundreds of chats"** — see Phase 3. |
| **The chat panel chrome** | Full `innerHTML` rebuilds of the panel body on render, CodeMirror instances for editors, the view-stack detach/reattach | Perceived "sluggish UI" more than FPS — separate workstream (surgical DOM updates), NOT a renderer problem. |
| **WebView startup** | ~2s boot (asset load + engine session fetch + icon restore) | Perceived lag; orthogonal to the renderer (an app-shell/defer problem). |

**Conclusion 1:** "the app is laggy" decomposes into (a) the lattice — now cached
and measured at ~60fps worst-normal / 44fps worst-mesh, (b) panel DOM churn — a
surgical-update workstream, (c) an icon-layer ceiling that only matters at the
hundreds-scale we are heading toward. There is no evidence today that demands
throwing away the renderer — and no measurement yet of the NEBULA target load.

---

## 2. THE VERDICT ON THE OPTIONS (web-researched)

### 2a. Godot 4 web export — **NO**
Researched (Godot docs "Exporting for the Web" + community/HN threads):
- **Threads require SharedArrayBuffer** → the serving origin must send
  cross-origin-isolation headers (COOP+COEP). Our engine serves from localhost
  inside the Android WebView (WebViewAssetLoader-style) and from HF Spaces; both
  would need header plumbing, and any embedded third-party script breaks under
  COEP. Without threads, Godot web drops to single-threaded wasm with worse jank.
- **Payload**: the wasm shell alone is tens of MB untrimmed (aggressive trimming
  gets ~10-20MB) — vs our current ~34MB total engine binary that already carries
  the Go runtime, PM wasm, editor vendored stack.
- **iOS Safari/WebViews are known-broken** for Godot 4 web exports (HN: "Godot 4
  web exports 100% do not work properly on MacOS Safari / iOS").
- **The killer**: Godot replaces the DOM. Our ENTIRE product surface — theme.js's
  CSS-var theme system with gradient twins + projection painter, the master panel
  + overlay screen architecture (the standing rule), CodeMirror editors, a11y,
  the Android back-gesture bridge — is DOM/CSS. In Godot we would rebuild all of
  it in a scene tree and lose the WebView integration the APK already ships.

### 2b. Unity WebGL / Flutter web — **NO**
Same DOM-replacement problem, worse payloads (Unity IL2CPP wasm is enormous;
Flutter's canvaskit adds ~2MB and its own rasterizer). Neither runs well in
mobile WebViews at our scale. Not researched further — the DOM argument alone
disqualifies them for THIS app.

### 2c. PixiJS (or another WebGL2 2D scene graph) for the WORLD LAYER — **YES, at Phase 3**
Researched: PixiJS batches thousands of moving sprites into very few draw calls
(texture atlas + geometry batching — the exact "tens/hundreds of icons with
per-icon animation" workload); v8 renders through WebGPU with WebGL2 and
Canvas2D fallbacks; core payload ~450KB gzipped — acceptable next to our vendored
stack. Android System WebView follows desktop Chromium: WebGL2 has been
universal for years; WebGPU is arriving on the same cadence (and Pixi falls back
cleanly where it is missing). The nebula target — hundreds of chats, animated
connection edges, additive-blend light halos ("manager chatbots emitting light
that reflects off other chatbots like stars") — is precisely a GPU particle/
sprite workload that DOM and Canvas2D will never sustain.

### 2d. OffscreenCanvas + Web Worker for the canvas paint — **YES, at Phase 2**
Researched: OffscreenCanvas (`transferControlToOffscreen`) moves the canvas 2D
context into a worker; the main thread only composites the transferred frame.
Supported in Chromium since 69 — the Android System WebView base — so the whole
installed base qualifies. This is the single biggest "app feels unresponsive"
fix that does NOT change our rendering model: the same paint code, on a thread
that never blocks on panel innerHTML, gesture handlers, or CodeMirror. The
lattice cache (v0.83.3) already removed the per-frame allocation churn that
would have made worker message-passing painful.

### 2e. Rust/WASM (or another compiled language) — **LATER, OPTIONAL**
The current physics (hundreds of entities, velocity integration) is trivially
cheap in JS — WASM would not measurably change today's profile. It becomes
worth it when the nebula's sim math saturates a frame budget (galaxy-scale
force layouts, thousands of edges) — and then it slots into the SAME worker
from Phase 2 (a wasm module the worker drives; no new UI stack). Note: WASM
threads hit the same SharedArrayBuffer/cross-origin-isolation wall as Godot;
single-threaded wasm still accelerates pure math.

### 2f. "Stay as is" — **YES for now, with the measurement discipline**
v0.83.3 proved the vanilla canvas hits ~60fps with caching discipline, and the
v0.84.1 atom-only frame established the cheap-frame pattern for every small
animation we add (orbits, badges, future per-chatbot tweaks). The RIGHT next
move is not a rewrite — it is the perf HUD + the worker + the planned WebGL
escape hatch, each gated by a measured bar.

---

## 3. THE PHASED PLAN (each phase gated; no big-bang rewrite)

**The bar (same gates for every phase):** 60fps desktop / 48fps sustained on a
mid-tier Android System WebView, at the phase's target load, measured by the
in-app FPS instrument (`DoomalayDebug.fps`), zero console errors.

- **Phase 0 — DONE (shipped)**: the v0.83.3 lattice cache (per-cell derived
  records, prerendered glow sprites, cached samplers/gradients, DPR ≤2) and the
  v0.84.1 atom-only frame. Measured: 38→59fps / 43→60fps solid; 33→44fps
  mesh worst case; resting-grid never repaints for small animations.

- **Phase 1 — measure + the remaining structural wins (next wave, vanilla)**:
  - a perf HUD behind Settings (fps, frame ms, cache hit-rate, DOM node count,
    compositor layer count) so EVERY future claim is measured, not felt;
  - the mesh-gradient ambient case (44fps → target 55+): the mesh spot table
    should cache like v0.83.3 cached the samplers (it is the one paint that
    still rebuilds per frame);
  - the icon-layer budget: keep every per-icon effect a child of the ONE
    `.chatbot` element (the v0.84.2 badge ring does exactly this — no new
    compositor layers), and cap DOM work per frame (`icon.render` writes one
    transform — keep it that way);
  - the panel's perceived sluggishness: surgical DOM updates for the hot paths
    (toolbar, transcript appends) — a separate workstream from the renderer.

- **Phase 2 — OffscreenCanvas the grid painter into a worker**:
  `#c` (and later `#c2`) become `transferControlToOffscreen` canvases; the
  worker owns renderGrid + the atom pass; the main thread sends
  {offset,scale,settings} on change and receives frames. The atom-only-frame
  discipline moves into the worker (it clears + repaints only the star layer
  when nothing else moved). Gate: 60fps at amp100 + both anims + 200 icons on
  the mid-phone bar, AND the panel/gesture threads stay idle during canvas
  paint (no long tasks > 8ms on the main thread).

- **Phase 3 — the PixiJS world layer (the icon ceiling)**:
  when chat count or per-icon animation cost actually breaches the Phase-2 bar,
  move the WORLD (icons as sprites from a texture atlas, atom stars, connection
  edges, light halos) onto a Pixi v8 stage mounted where `#c`/`#c2` sit today
  (WebGPU → WebGL2 → Canvas2D fallback chain). The DOM keeps the panel,
  overlays, theme chrome and all input handling; theme tokens feed Pixi colors
  through the same resolver (`--accent` etc.) so the theme system re-tints the
  world layer live. Icons render to textures once per (icon, rev); effects ride
  Pixi's object model (particles, additive BLEND_MODE for the emitted-light
  look). Gate: 300 chats + orbits + animated connections at the bar.

- **Phase 4 — the nebula**: the connection graph + force layout INSIDE the
  worker (Phase 2's), edges as Pixi Graphics/rope with animated flow, manager
  light as additive sprite halos, a star-field backdrop as a particle
  container, LOD + culling (far chats collapse to 2px dots, off-screen chats
  skip entirely — the atom pass already culls). Gate: 1,000 nodes + 2,000
  animated edges at the bar.

- **Phase 5 — WASM sim (optional)**: only if the worker's JS math saturates
  the budget at Phase-4 scale; a single-threaded wasm module in the same
  worker. Not before — no measured need.

**What we never do:** adopt a game engine (Godot/Unity) or an SPA framework
rewrite; move the chat UI, panels, overlays, or theming off the DOM; add a
second rendering stack before the measured bar is actually breached.

---

## 4. WHY THIS SHAPE (the constraints that decided it)

1. **The DOM is the product.** The theme system (CSS vars + gradient twins +
   projection painter), the two-screen rule (Panel/Overlay), CodeMirror,
   a11y/back-gesture bridges — all DOM. The renderer migration must stay
   UNDER the UI, never replace it.
2. **The WebView is Chromium.** OffscreenCanvas (≥69) and WebGL2 are
   effectively universal in Android System WebView; WebGPU arrives with the
   Chromium cadence and Pixi's fallback chain covers the gap. Desktop and HF
   Spaces get the same code path.
3. **The engine is local.** ~450KB (Pixi) vs tens of MB (Godot) matters more
   when the binary ships inside an APK and boots from a phone.
4. **Every phase is reversible and gated.** If Phase 2 hits the bar and Phase 3
   never becomes necessary, we simply stop — no rewrite debt.

## 5. TL;DR

Stay vanilla + measured through Phase 1; move the canvas paint into a worker
(Phase 2); adopt PixiJS for the world layer when the icon/connection counts
demand it (Phase 3); build the nebula on that foundation (Phase 4); consider
WASM math only if measurement demands it (Phase 5). Godot/Unity/Flutter are
rejected: payload, WebView compat, and the loss of the DOM-based theme and
panel architecture the whole app is built on.
