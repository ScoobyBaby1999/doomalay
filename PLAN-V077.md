# PLAN-V077 — THE FEEDBACK WAVE (5 fixes on the shipped v0.75)

User feedback on the v0.75 grid-effects + panels, verbatim asks:
1. "Amplify parallax is not very noticeable, change method again or make it
   more noticeable please."
2. "We can turn on the toggle to animate but we cannot turn it off. It gets
   stuck."
3. "Let's change the animation for lines to be more clear, its barley
   noticeable. Either make them shoot like shooting stars back and forth,
   moving slowly at first, then at a exponential curve they move fast to the
   new location then back at another exponential curve with slight
   variations... Or keep it the way it is but make it more noticeable by
   shrinking them either by width or height or both at random variations.
   Ur choice."
4. "The panel still sometimes get stuck at the 30% dock... The panel gets
   stuck at 30% dock and doesn't go down or render taps, the only way to
   remove it is by gesture navigating back."
5. "Please remove the blur and other post process effects we apply to the
   background or anything that isn't the overlay screen when we open any
   overlay screen." (overlay screen = anything that is NOT the panel or the
   browser-in-browser panel.)

## THE DIAGNOSES (all reproduced live on the rig before writing a line)

### #2 THE TOGGLE — REPRODUCED (repro-toggle.py, Playwright + CDP real touch)
T1 clean tap → toggles ON ✓. T2 tap + 30px DOWNWARD drift → NOTHING (no
click, no change). T3 tap + 30px UPWARD drift → NOTHING. T4 clean tap →
toggles OFF ✓. Two independent killers:
  (a) gesture.js's body-touchmove sheet hijack preventDefaults any
      downward drift > 24px (BODY_SLOP) when the scroller sits at its top —
      the synthetic click dies. The checkbox is NOT in ownsGesture's
      exemption list (only input[type=range], textarea, .no-sheet-drag).
  (b) Chromium dispatches the click at the TOUCH-END point: any drift that
      leaves the tiny 42×24px switch lands the click on a neighbor — the
      label never sees it.
FIX: a real hit-slop (::after inset:-11px -16px → a 62×46px tap zone that
still paints the 42×24 visual) + checkboxes/switches join ownsGesture (a
sloppy tap on a toggle never starts a sheet drag and never gets
preventDefaulted). Touch targets ≥44px = the accessibility floor.

### #4 THE STUCK 30% DOCK — REPRODUCED (repro-dockstuck4.py attempt 0)
The race: a canvas touch landing DURING the close-dismiss (~150ms window)
→ panel.js _wireDuck fires duckForCanvas() → gesture.js springY() calls
stopAll() → stopDismiss() kills the closing spring MID-FLIGHT → the panel
re-ducks (y=546) — but dismiss() had already added `.closing` +
`pointer-events:none`, and the ONLY code that clears them (the spring's
completion / panel.open()) never runs. Result observed on the rig:
`closing:true, pe:none, open:true, y:301` + hit-test says touches land on
`#c` (the canvas!) — the panel is completely interaction-dead (pointer-
events:none skips it in hit-testing), "doesn't go down or render taps",
and only a full close→open cycle (the Android back gesture) recovers.
FIX: a closing panel is NEVER duckable — `if (panelEl.classList.contains
('closing')) return;` in duckForCanvas + the same guard on the _wireDuck
trigger (defense in depth). The touch still pans the canvas (untouched)
and the dismiss completes on its own.

### #1 AMPLIFY PARALLAX — diagnosed by reading the shipped method
The v0.75.1 star layers are nearly invisible: layer 2's radius is
dotR*0.32 ≈ 0.45px (SUB-PIXEL on a phone), alphas 0.28–0.58, and the
backdrop camera only slows 0.35 → 0.20. The depth is there but beneath
perception. FIX: rebuild the amplifier as a THREE-layer stack with REAL
contrast — a NEAR layer panning FASTER than the lattice (pf 1.6, big
bright orbs, ~8/viewport — foreground parallax is the strongest depth
cue), a MID layer (pf 0.5), a dense FAR layer (pf 0.16), and the backdrop
camera deepening 0.35 → 0.10 at full amp. amp 0 stays the byte-identical
default (zero stars, camera 0.35, flat lattice) — the standing contract.

### #3 LINES ANIMATION — chosen: the shooting-star shuttle (user's first
option), with the size variation of the second folded in: each segment
shuttles along its own (rotated) axis between two points — slow start,
exponential rush to the far end (ease-in, k per segment), back on another
exponential curve (different k) — per-segment variation on distance,
duration, sharpness, direction, phase, dash length and width (all from the
stable cell hashes — zero per-element state, no drift).

### #5 OVERLAY BLUR — the two full-screen post-processes found:
connectoverlay.js's scrim (backdrop-filter blur(8px) + a 0.55 dark veil —
the shared container for providers/model-browser/model-picker/sandbox-
picker/workspace pickers/local models/gh+hf connect) and index.html's
.art-scrim (blur(6px) + rgba(0,0,0,0.55) — the artifacts drawer). Both
become fully transparent (the elements stay as the tap-to-close surfaces;
the overlay cards keep their own opaque backgrounds + borders + shadows).
The small floating chrome (gear, dock strip, name pills) blurs only its
own little glass — not the background — untouched. The panel + the
browser panel are NOT overlay screens (user's definition) — untouched.

## THE IMPLEMENTATION (one commit + tag per fix)

- v0.77.1 — gesture.js + panel.js: the closing-guard (fix #4)
- v0.77.2 — index.html + gesture.js: the switch hit-slop + ownsGesture (fix #2)
- v0.77.3 — app.js: the amplifier stack + camera (fix #1)
- v0.77.4 — app.js: the shooting-star shuttle (fix #3)
- v0.77.5 — connectoverlay.js + index.html: the transparent scrims (fix #5)
- release v0.77.0 (the wave), v0.77 version bump, the p21 suite contract kept
  (stars > 0 at amp 100, 0 at default; flat lattice at 0).

## GATES
go build/vet/test · node --check on every touched web file · the theme
twins suite (p21 amplifier contract) · uikit · the live rig: re-run
repro-toggle.py (T2/T3 must now toggle OFF) + repro-dockstuck4.py (the
race must complete the close, never stick) + visual shots of the new
amplifier + the shooting-star lines + the overlay-open background crisp.
