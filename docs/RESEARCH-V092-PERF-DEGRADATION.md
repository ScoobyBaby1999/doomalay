# RESEARCH-V092 — THE PERFORMANCE DEGRADATION, ROOT-CAUSED

> The user's ask: "the performance of the app in general is still poor…
> it feels like it runs at a 30-50% lower frame rate when I have my themes
> set to something crazy with gradients all over, especially whilst in a
> panel… fresh boot is at its best and it then degrades fast… busy panels
> (settings colors and general tabs) are noticeably slower than sizing
> and performance. Lets focus on researching and implementing drastic
> changes… our goal is to double the current performance at least. Read
> the docs in the repo, the ones to do with the colors and performance
> research. We might have missed the root."
>
> 11 web searches + 3 live measurement rigs (a real Chromium against the
> real engine binary), 2026-10-02. The rigs:
> `scripts/v092-degradation-profile.py` (settings cycling, empty world),
> `scripts/v092-degradation-soak2.py` (8 bound sessions + transcripts +
> panel opens + drags, 12 min), `scripts/v092-orbit-paint-test.py`
> (a formed tab group, zero input, isolated).

## What we already knew (the repo's own priors)

- v0.83.3/v0.84.1/v0.85.2/.3: the lattice caches, the atom-only frame,
  the worker painter, the Pixi world layer — the CANVAS side is cached
  and measured (59-60fps solid, 33-44fps mesh worst case on a phone).
- v0.89.7/.8 + v0.91.x: the color rework Track 1 — OKX, color-mix
  Layer-3 chrome, the colors-tab dere-projection (534 → ≤60 projected).
- RESEARCH-V084's own sentence, still true: "the mesh-gradient ambient
  is the remaining 44fps case" and "PROJ's retirement for BIG surfaces
  (needs the scroll-driven animation / @property groundwork — the honest
  endgame per the research)".

## The measurements (this wave — measured, not felt)

### Rig 1 — settings cycling, EMPTY world, 10 min
heap 10MB FLAT · nodes 257 FLAT · fps 56 FLAT · zero errors.
No leak in the settings path. The tab-open costs are one-time per open.

### Rig 2 — the realistic world, 12 min (8 sessions with 12-event
transcripts, 8 bound icons, gradient mesh on all 7 surface vars,
ambient ON, panel opens + transcript scrolls + icon drags + canvas pans)
heap 10MB FLAT · nodes 195 FLAT · fps 56 FLAT · chatKids 3 STABLE ·
longTasks 3 total · zero errors. **NO JS-heap leak, NO DOM leak, NO
listener leak in the chat/panel/drag path.** Degradation over time is
NOT a JavaScript memory leak on the main heap.

### Rig 3 — THE ORBIT TEST (the smoking gun)
A world with 2 icons; `TabGroups.collide` forms the group; ambient ON;
then ZERO input for 8s intervals:

| phase | paints/s | motions/s | fps |
|---|---|---|---|
| no group (control) | ~0.1-0.4 | ~0.1 | 58 |
| **group orbiting** | **25-30.8** | **92.5** | 56 (headless) |
| group released | 0.4 | 0 | 58 |

**~30 full projection paints + ~92 motion ticks per second, forever,
while ANY tab group exists** — a 77× churn over the resting canvas.
Every paint = the SEL walk + `getBoundingClientRect` per projected
element + background-position/size style writes; every motion tick =
matrix reads + `--proj-tx/--proj-ty` CSSOM writes → style recalc of
every projected element. With a gradient theme (the projected set is
live) this is a per-frame style-recalc + raster storm. On the phone's
GPU: viewport-sized gradient re-rasters at ~30/s + tile-cache churn →
the exact 30-50% frame-rate loss, plus sustained heat → thermal
throttling → "degrades fast, fresh boot is best" (a restart cools the
SoC and empties the raster caches).

THE MECHANISM (traced in code): `TabGroups.step()` runs every ambient
tick → the grouped members' `icon.render()` writes `el.style.transform`
per drift frame (gridicon.js's ambient-write guard only skips IDENTICAL
strings — drift strings change) → `DoomProjection`'s MutationObserver
sees an UNTRACKED style write → its classifier sets `full = true` →
`mark()` → a FULL paint next rAF. `ambientActive()` includes
`TabGroups.active()`, so the loop never rests while a group exists —
the churn is sustained from the moment a group forms until it dissolves.

(The fresh-boot clue checks out literally: a fresh boot has no groups
formed yet — the churn starts with the first collision.)

### The web-search layer (11 searches, the applicable findings)

- **CSS `background-attachment: fixed` costs a paint per scroll/frame**
  (CSS-Tricks "The Fixed Background Attachment Hack"; Vehikl; Chen
  Hui Jing) — our PROJ painter emulates it with per-frame
  background-position writes = the same repaint cost per motion tick.
  The proven native pattern: the background on its OWN layer, moved
  with transform (compositor-only, no repaint).
- **CSS custom-property writes are expensive at scale**
  (Chromium issue 457696384; web.dev's @property benchmark) — our
  `--proj-tx/ty` poke per tick forces style recalc on every descendant
  that consumes the vars.
- **Chromium layer/raster memory**: "large numbers of layers increase
  compositing cost and memory use; the rasterizer must create textures
  for layers" (Inside Chrome's Compositor; Paul Serban's layer-promotion
  pitfalls) — sustained re-raster churn keeps the tile cache hot,
  grows GPU memory pressure, and on memory-constrained phones pushes
  Chromium toward raster-cache eviction → jank that a restart clears.
- **Thermal**: Android's thermal manager silently throttles sustained
  GPU/CPU load (Unity/Kryozon reports: "half within 1-2 minutes of
  gameplay") — matches "degrades fast" + "fresh boot is best".
- **Android's WebView memory docs**: the multi-process model, trim
  memory, the Renderer Importance API — the native-side levers for
  v0.92.3 (our MainActivity currently has NO onTrimMemory handling).
- Scroll-driven animations + @property: compositor-thread only for
  transform/opacity — NOT for background-position; the honest endgame
  for big-surface projection remains Track 2 territory (a transform-
  carried gradient layer), gated on device numbers.

## The diagnosis, tied together

The app never leaked — it BURNED. The sustained cost has one dominant,
measured root: **the tab-group orbit drift wakes the entire projection
painter ~30×/s and the motion var path ~92×/s, forever, and every wake
re-anchors + re-rasters every gradient surface in the DOM.** The v0.91.x
waves retired the SMALL controls; the big surfaces (panels, sections, the
chatbot disc) still carry projected viewport-fixed windows, and the
orbit churn re-anchors all of them per frame. On a phone GPU that is the
30-50% loss with gradients; over minutes it is heat + raster-cache
pressure; after a restart it is gone (until the first group forms).

## What this wave does about it (the plan, one line each)

1. **v0.92.1 THE ORBIT REST** — the chatbot disc + name pill leave the
   projection model (LOCAL scroll-attachment gradients — the v0.91.3
   precedent: a 56px window can't show viewport projection), and the
   projection observer learns that a pure-transform style write on an
   untracked, unpainted element is provably inert (transform moves no
   box but its own). Orbit drift → 0 paints/s, 0 motions/s.
2. **v0.92.2 THE BUSY-PANEL PARITY CHECK** — measure colors/general vs
   sizing/performance open costs with the churn gone; fix what the
   numbers still show.
3. **v0.92.3 THE NATIVE MEMORY GUARDS** — MainActivity onTrimMemory →
   the JS pause bridge (ambient + deck), so Android's memory pressure
   actually reaches the web layer.
4. **Track 2 (the Pixi mesh shader) stays gated** on post-v0.92 device
   numbers — the 33-44fps mesh-ambient worst case is the next candidate
   if the canvas still sags after the churn dies.

## Not-doing (documented for the next wave)

- Retiring PROJ for panels/sections (the transform-layer endgame) —
  v0.92.1 removes the CHURN without touching the at-rest look; the
  panel surfaces only re-anchor on real layout changes now.
- Any WASM/Rust rewrite of color math (v0.91's verdict stands — the
  cost is not JS math).
- The deck MAX_LIVE budget change (6 parked iframes) — no measured
  need; the trim bridge covers the pressure case.
