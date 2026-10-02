# PLAN-V092 — THE PERFORMANCE WAVE (double it, measured)

User spec: "The app is still generally laggy… runs at a 30-50% lower
frame rate when I have my themes set to something crazy with gradients
all over, especially whilst in a panel… fresh boot at its best, then it
degrades fast… busy panels (settings colors and general tabs) noticeably
slower than sizing and performance… our goal is to double the current
performance at least. We might have missed the root."

The root, found and measured (RESEARCH-V092): the tab-group orbit drift
sustains ~30 full projection paints/s + ~92 motion ticks/s forever —
each one re-anchoring and re-rastering every gradient surface in the
DOM. No leak (12-min soak: heap/nodes/fps FLAT); a burn. Fresh boots
are fast until the first group forms.

## v0.92.1 — THE ORBIT REST (the churn killer)

**(a) The chatbot disc + name pill leave the projection model.**
`index.html`'s `.chatbot .icon, .chatbot .name` 3-layer window
(`background-attachment: fixed, fixed, fixed`) goes LOCAL
(`scroll, scroll, scroll`). Precedent: v0.91.3 dere-projected the
gradient editor previews with the exact argument — "viewport projection
at 52px is invisible" — the disc is 56px, the name pill is smaller.
Solid themes: byte-identical (no gradient vars → the plate + border
ring render the same). Gradient themes: the disc shows the gradient at
its own box instead of a 56px window into the viewport field.
Webtab icons were never projected (literal gradient strings — STYLE_RE
never matched) — nothing to do there.

**(b) The projection observer learns ORBIT NOISE.**
theme.js's MutationObserver classifier: a style write on an element
that is NEITHER a tracked projection root (`__projTracked`) NOR a
painted window (`__projPainted`) whose OLD→NEW diff is pure
transform/translate cannot move any box but its own — it is provably
inert for the painter (transform never affects sibling/descendant
layout). Skip it: no mark(), no motion(). This is what makes the orbit
FREE even with other projected elements on the page (panels, sections):
the member's transform write stops waking the painter entirely.

GATES (the new rig `scripts/v092-orbit-rest-test.sh`):
1. with a group orbiting + mesh gradients + ambient + zero input:
   paints/s ≤ 1 (measured today: 25-31) and motions/s ≤ 2 (today: 92);
2. the disc still renders the theme's gradient (computed
   background-image on `.chatbot .icon` contains the gradient stops);
3. the projected set still contains the panel's big surfaces (open the
   chat panel → painted count > 0 — the coherent field survives);
4. the panel glide still re-anchors (drag the panel, settle, verify no
   window drift via __projPos stability at rest);
5. theme twins 165 + uikit 140 pass (byte-stability for solid themes);
6. zero console errors.

## v0.92.2 — THE BUSY-PANEL PARITY CHECK (measure, then fix)

Re-measure the settings tab open costs (long tasks + paint counts) for
colors / general / sizing / performance with v0.92.1 in. Expected: the
remaining gap collapses (the colors tab's residual lag was the projected
members + the per-open rebake churn). If any tab still measures ≥2× the
sizing baseline, apply the same local-attachment dere-projection to that
tab's specific hot elements (the four big cards are the candidates).
Gate: the rig numbers, not feelings.

**MEASURED (post-v0.92.1, mesh gradients + ambient ON, cold → warm):**

| tab | cold paints | warm paints | motions | DOM nodes | long tasks |
|---|---|---|---|---|---|
| appearance (colors) | 11 | 3 | 4-7 | 979 | 0 new |
| general | 4 | 3 | 4 | 201 | 0 new |
| sizing | 3 | — | 4 | 257 | 0 new |
| performance | 3 | — | 4 | 199 | 0 new |

WARM PARITY ACHIEVED: every tab reopens at 3 paints — the colors tab's
cold open (11) is its one-time editor DOM mount (979 nodes — the
gradient editors themselves), with ZERO new long tasks. No further
dere-projection needed; the parity gate is met.

## v0.92.3 — THE NATIVE MEMORY GUARDS (degradation insurance)

MainActivity: `onTrimMemory` bridges into the web layer —
`window.__doomalayTrim(level)` (app.js): the ambient loop parks (the
lattice worker's frame posts, the atoms, the tab-group orbits rest)
until the next real user interaction (pointerdown) or a return to
visibility (visibilitychange→visible). The user's settings are NEVER
mutated (their animate toggles stay as chosen; the pause is a pressure
response, not a preference write). The trim level rides DoomalayPerf
(the honest instrument). Gate: the orbit freezes under trim(15),
resumes on pointerdown, settings untouched — pinned in
v092-orbit-rest-test.sh (13/13).

## Verification order (every phase)

orbit-rest rig → soak2 (12 min, flat) → theme twins + uikit → the
existing visual gates (v065-theme-suite) → engine rebuild → push (after
the rebase dance: pull, diff, merge errors, then publish).

## Not-doing (this wave)

- Track 2 (the Pixi mesh-gradient shader) — gated on post-v0.92 device
  numbers from the user.
- PROJ retirement for panels/sections — v0.92.1(b) removes the churn;
  the at-rest look is untouched.
- The deck budget change — no measured need.
