# PLAN-V163 — THE SIX FIXES (the user's 2026-10-22 list)

The user's six asks, verbatim-mapped:

1. **THE DYNAMIC WALL** — the FreeTierError chat message ("OpenCode's free
   models are walled…POCKET BRIDGE…") becomes DYNAMIC: it names the
   phone's own missing rungs (termux setup vs opencode install — "display
   either the first or second depending on what is installed and what is
   not"), plus the download size, the model, and the installed-state
   truths. (chat.go friendlyHTTPError + a llm→server probe hook.)
2. **THE CLOUD GATE** — the model catalogue header grows a cloud icon LEFT
   of the ★ tab (same size) that opens the cloud provider screen; Android
   back pops back to the CATALOGUE (pushPage — a real stack level), not
   the canvas.
3. **THE HONEST PILL** — after the "checking opencode…" pill, the gate pill
   NEVER disappears; its text becomes the DYNAMIC requirements ladder:
   "opencode requires API key + termux setup + opencode install" (only the
   missing pieces).
4. **THE SETUP COPY** — termux setup step ②: the pill reads "Open Termux ↗
   then hold and Paste"; the auto-copy explanation hint DIES; the paste
   line under "Bootstrap once" rides the theme accent; step ③'s
   description names the real screens (Additional Permissions → Run
   commands in Termux environment; optionally disable Manage app).
5. **THE LIVING TERMUX PILL** — the "+ setup termux" pill flips to
   "✓ termux setup" the moment termux is ready. ROOT CAUSES (live-audited):
   (a) THE POLL RACE — `fetchOcBridge(cb)`'s `if (!opened) return` swallows
   `ocBridgeStartPoll()` when the bridge status (µs-fast) lands before the
   models/keys Promise.all opens the panel → the poll NEVER ARMS → the
   pills freeze forever; (b) THE STACK NUKE — the poll's `render()`
   swaps `contentEl.innerHTML` unconditionally, so a poll tick while
   TermuxSetup (or any pushed page) is stacked on top REPLACES that page;
   (c) THE STALE POP — popPage restores the providers html SNAPSHOT from
   open-time, so the pill shows the pre-setup truth. FIXES: arm the poll
   unconditionally (retry-until-opened), the marker guard (`#prov-root`
   present = we own the scroller; else skip the swap + fetch), and an
   `onPop` hook (connectoverlay fires it when the page is restored) that
   re-fetches + re-renders FRESH.
6. **THE BIG CELLS** — "each cell should increase the size by ~x10…
   a countable number of cells and very few grids. Spatial loading can
   load one or few cells at a time, and one grid. And the stars and lines
   within the grid can load similarly, only when in the camera's
   viewport."
   - `GRID_BASE` 48 → **480** (THE CELL LAW): the 16,384 world = ~34
     cells/axis (~1,166 total) — countable; one grid.
   - **renderCells** — the LIVE per-cell spatial path, promoted from the
     battle-tested legacy walk (v0723 contracts, kept alive as the fallback
     through every wave): per-visible-cell LAZY records (the LC cache —
     a cache miss IS a cell "load"), batched quantized fills, the A/B
     parity breath at flush (the tiled path's own shimmer), the far-field
     ramp, paintModulation, the near-view per-dot pulse/orbit with an
     honest LOD (static+breath below 24px spacing — the pulse is invisible
     there), and the renderTiled stats shape (+`mode:'cells'`).
   - WHY NOT TILES: the periodic-tile budget at 480px cells collapses the
     bake raster to 0.28–0.4 (vs today's ~1.56) — 2.5–5× upscaled mush;
     Rref = √(budget/(4·spacing²·units)) cannot buy raster at ×10 spacing
     under any sane heap. The live cell walk paints at device resolution —
     sharp by construction — and its per-frame count is bounded by the
     countable world (~1,156 dots + ~2,300 segs at the absolute fit-all
     floor; <50 at normal zooms) — inside the proven v0.94.1 envelope
     (~1,100 dots + ~2,900 segs) with the batcher folding them into a
     handful of fills.
   - `MOD_P_CELLS` 320 → **32** (the SAME pixel period as the old
     320×48 = 15,360px ≈ the world — the modulation field keeps its
     span).
   - The render gate: `legacy flag → renderLegacy; big cells
     (GRID_BASE·gridSize ≥ 240) → renderCells; else renderTiled` + the
     `__doomalayLatticeTiled` escape hatch (the rigs pin the tile
     machinery through it).
   - The tiled path stays byte-identical (the gridSize slider ≥ 1 makes it
     unreachable in-app; the machinery + its pins live on through the
     hatch).
   - HONEST LOSSES (recorded): the tile-instance rotation/mirror variety
     law (v1.62.3) — moot: the cells field has NO repeats (each cell is
     its own world hash); the zoomAdj band divergence (v1.10.3) — the
     cells bands stay world-anchored (the tiled path's paint-space trick);
     the far-field sea-fade at the map view — unreachable at 480px cells
     (the floor spacing is 11.4px ≥ the 6px full-on rung; the user's
     countable-grid ask supersedes the sea-less map view).

## Sub-waves

- **v1.63.1 THE HONEST PILL** — tasks 3+5 (providers.js + ocbridgeapi.go).
- **v1.63.2 THE DYNAMIC WALL** — task 1 (chat.go + the llm probe hook).
- **v1.63.3 THE CLOUD GATE** — task 2 (modelbrowser.js + connectoverlay.js
  onPop + providers usePushPage).
- **v1.63.4 THE SETUP COPY** — task 4 (termuxsetup.js).
- **v1.63.5 THE BIG CELLS** — task 6 (lattice.js + the rig re-pins:
  v1620 §3 through the hatch + the cells pins; v1570's floor pins
  re-anchored to the big-cell truth).
- **v1.63.0 THE SHIP** — buildinfo + README + worklog + the v1630 rig +
  the battery + cross-compiles, pushed under THE REBASE LAW.

## Proof

`scripts/v1630-six-fixes-rig.mjs`: §A the providers pill ladder (the race
arm, the marker guard, the requirements text, the termux flip, the onPop
fresh render); §B the dynamic wall (the three message variants + the
model/size inclusions, live via the real engine); §C the cloud gate (the
icon, the pushPage depth, back = catalogue); §D the copy laws (source
pins); §E the cells law (GRID_BASE 480, mode cells, the countable world,
spatial records, sharp live paint, the hatch). Plus the standing battery:
go ALL + vet + v1620 (re-pinned) + v1570 (re-anchored) + the rest green.
