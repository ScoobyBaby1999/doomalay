# PLAN-V124 — THE TERMINAL PULSE

The user's verdict on v1.21.3: "the progress bar looks great, but is on the
wrong panel." The bar was built on the app's Termux setup overlay; the intent
was always the **Termux terminal itself** — the screen the user actually
stares at while the bootstrap runs. This wave removes the app-side bar and
builds the real thing: a live ASCII progress bar rendered by
`termux/setup.sh` on the Termux terminal, tracking the script's own 4 steps,
with the honest leave/stay note. The parked 5-point task (blob truncation,
reply structure) stays parked, its own future wave.

## RESEARCH VERDICTS (web, pre-build)

1. **Safe-to-leave is CONDITIONAL — the note must be earned.** Termux wiki:
   `termux-wake-lock` holds a wakelock so Android never enters deep sleep
   (progress keeps running in the background; the script manages the unlock
   itself). Without it, Doze can pause CPU/network while the user is away,
   and ActivityManager may kill backgrounded Termux under memory pressure.
   → The script acquires `termux-wake-lock` at start; while it holds,
     autonomous phases print **"↩ it's ok to go back to the app now — setup
     keeps running in the background"**; if the lock is unavailable, those
     phases print **"⏳ please wait — keep Termux open until setup finishes"**.
2. **The interactive step never says "safe to leave".** Phase ② (storage)
   waits on a human tapping the Android dialog — progress is paused on the
   user by definition. → Its note is always
   **"⏳ please wait — tap \"Allow\" on the storage dialog"**.
3. **Redraw mechanics:** the standard single-writer idiom — `\r` + `\033[K`
   (erase-line) with a cursor-up (`\033[1A\r\033[K`) for a 2-line block.
   No cursor-paging gymnastics; both lines scroll together at the viewport
   bottom, so the redraw stays aligned. Widths: `$COLUMNS` is unset in
   non-interactive shells → `tput cols` per frame with a clamped fallback.
4. **Honest download progress:** parsing apt's machine-readable progress
   (`APT::Progress::Fd`) through the `pkg` wrapper is fragile across apt
   versions. Instead: apt's own output is the truth — it streams to a log
   and the newest line ("Get:3 … [2,345 kB]", "Fetched 8,345 kB in 3s")
   rides the bar's second line live. Real bytes, zero fake percentages.
5. **The bar advances only on real completions** — one of the 4 steps done
   = +25% and 5 more filled cells. The braille spinner (the frames the user
   already liked) provides motion, never fake percent.

## THE SPLIT

**REMOVED (v1.24.1)** — the app-overlay PULSE (`termuxsetup.js`): `_barFor`
+ the spin constants + `paintPulse` + the `#tsx-pulse` markup + `.tsx-pulse*`
CSS + the 130ms spin heartbeat + the `probing`/`spinFrame` instance fields +
the `_barFor` exports. `scripts/v1213-pulse-rig.cjs` retires with it. The
ladder (rows, chips, quiet gate) stays exactly as shipped.

**BUILT (v1.24.1)** — the terminal bar inside `termux/setup.sh`:
- **Single-writer law:** a background watcher subshell owns ALL terminal
  painting in TTY mode; the main thread only writes a tiny state file
  (atomic `mv`) and a print-queue file (atomic `mv` drain). Zero
  parent/child interleaving races.
- **The 2-line live block:** line 1 = spinner + pct + 20-cell █/░ bar
  (cells adapt 8..20 to the terminal width; Termux portrait is ~39 cols) +
  "n/4 label" + elapsed seconds when they fit; line 2 = the phase note,
  overridden live by the newest apt log line during the packages phase.
- **Static history:** each phase prints `▶ n/4 · label — <what>` and, when
  done, its honest `✓`/`⚠` line (the old script's outcome texts preserved).
- **Notes:** the safe text only while the wake lock is held on autonomous
  phases; the dialog-wait text on ②; the keep-open text when no wakelock.
- **Non-TTY mode:** piped/redirected output degrades to the plain step
  lines (no escapes, no watcher) — CI and logs stay clean.
- **Idempotent re-runs:** storage already granted → phase ② skips with a
  ✓; props already set → phase ① stays fast (existing behavior).
- **Cleanup:** `trap EXIT` kills the watcher, releases the wakelock (only
  if the script set it), removes the state files. Non-fatal law everywhere.
- **`--render-demo`:** the real phase/draw machinery with the real actions
  stubbed — a human-eye render of every phase, both note variants, the
  narrow and wide widths. The rig's driving wheel.

## PHASES

- **v1.24.1 THE TERMINAL PULSE** — the removal + the terminal bar + the new
  `scripts/v1241-terminal-pulse-rig.cjs` (bash `--render-demo` byte
  assertions across widths/notes/phases + source greps: no `_barFor` /
  `tsx-pulse` leftovers, the exact note texts, the wake-unlock) + the v1173
  pins stay green (the bootstrap one-liner shape is unchanged).
- **v1.24.2 (conditional)** — whatever the redteam convicts.
- **v1.25.0 — the wave ship.** buildinfo 1.25.0 + the wave record, tag
  `v1.25.0-the-terminal-pulse`, CI (APK + Desktop + HF).

## BATTERY (real tests, real user imitation)

1. `bash -n` + the demo rig (node) across DM_COLS 39/60/80, both note
   variants, non-TTY plain mode.
2. **The live harness** — the REAL `setup.sh` run end-to-end in the sandbox
   with stubs (fake `pkg`, `termux-setup-storage`, `termux-wake-lock`,
   `curl` for the checkin) under a pty (`script -qec`): frames advance,
   ✓/⚠ lines land, the checkin curl hits the fake URL with the right flags,
   the wake lock is acquired AND released, no unbound-variable crashes.
3. The Go + JS batteries stay green; both builds (linux + android) compile.
4. The agent-browser walk on the setup overlay (fake bridge): the ladder
   paints, **no `#tsx-pulse` node**, zero console errors — plus the parked
   Preamble ask folded in: import one from the hub → lands ACTIVE.

## WILL NOT (this wave)

- No engine/Go changes (the bar is pure script + pure removal).
- No change to the bootstrap one-liner shape or the checkin protocol.
- No apt percentage parsing, no fake sub-step motion, no `set -e`.
- The parked 5-point task (blob truncation, reply structure) stays parked.
