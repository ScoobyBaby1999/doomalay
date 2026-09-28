# PLAN — v0.69/v0.70: THE FIVE FIXES + THE ACCURACY WAVE

Session start: main @ 2a0744d (v0.68.2), tree clean. Sandbox was reset (Go
reinstalled user-local 1.23.4; .secrets GONE — only the git remote token
survives; no PM key for live probes — the fix is derived from the error
text + docs + registry, all verified).

## USER ITEMS

1. PM GLM 5.3 400 (reasoning_effort literal_error)   → v0.69.1 (engine)
2. skills library unavailable (brain/agent_skills)   → v0.69.1 (engine)
3. Parallax back to pre-v0.66/67 feel                → v0.69.2 (web)
4. Overlay taps must NOT duck the panel              → v0.69.2 (web+Kotlin)
5. BIB release slightly-above-half → dock at half    → v0.69.2 (Kotlin)
6. THEME ACCURACY: chat text + pills follow their
   assigned variable fields correctly                → v0.70.0 (web)

## DIAGNOSES (verified)

1. **PM glm-5.3**: OR registry says z-ai/glm-5.3 supports ["max","high",
   "low"] default "max" → we preselect "max" and send reasoning_effort:
   "max". PM's DEPLOYED validator rejects (allowed: 'none','minimal',…
   the standard ladder — docs page says low/high/max but the API says
   otherwise; the sent value must be 'max' since low/high are in any
   standard ladder). SECOND bug: mentionsEffortParam() doesn't recognize
   Pydantic validation errors ("literal_error"/"Input should be"/
   "validation error") → the 400-resilience retry-without-param never
   fires → raw error surfaces.
   FIX: providerNativeLevels["privatemodeai"] = {none,minimal,low,
   medium,high}; snap Default into the filtered ladder after
   filterNativeLevels; mentionsEffortParam learns the Pydantic shapes.

2. **skills**: the engine's skillsDir() wants brain/agent_skills on disk;
   APK + Desktop builds ship ONLY the engine binary (only the HF Docker
   copies brain/). BUT the engine already EMBEDS the whole brain
   (hfzero.brainFS, synced by make sync-hfzero — 308K/21 files for
   agent_skills). FIX: skillsDir() gains a fallback — extract the
   embedded agent_skills once per engine build into
   <DataDir>/brain/agent_skills (stamped with buildinfo.Version;
   re-extract on stamp mismatch), then serve it like a real dir.

3. **Parallax**: ALL motion changes landed in v0.67's DEEP FIELD (v0.66
   didn't touch app.js). PF_LINE=1-0.38·d, PF_DOT=1-0.20·d, bg
   deepening 0.35-0.09·d, default d=60. FIX: default d=0 (byte-identical
   flat lattice + bg 0.35), keep the slider; one-time migration
   (saved 60 → 0, marker-guarded); grid-effects-reset → 0. app.js defaults
   60→0 in both readers; appearance.js hint copy stays.

4. **Overlay duck**: panel.js _wireDuck ducks on ANY touch outside
   #chat-panel (overlays included); MainActivity's WebView listener ducks
   the BIB on ANY touch (overlays included). FIX (user's words: "only
   when the background, canvas, or canvas icon is tapped"):
   - web: positive list — target.id==='c' || target.closest('#chatbots')
     for touchstart + touchmove + the desktop mouse close.
   - Kotlin: ACTION_DOWN → async elementFromPoint hit-test (evaluate
     Javascript) → onSpaTouch() only for canvas/icons; ACTION_MOVE → new
     onSpaMove() which only RETRIGGERS when already ducked.

5. **BIB half-line release**: release() closes on downward fling
   (vy>FLING_VY) or big drag REGARDLESS of position — a release while the
   sheet still sits above the half dock hides it. FIX: the half-line
   guard — curFrac = 1-(dragStartOffset+dy)/h; a downward release with
   curFrac >= DEFAULT_FRAC-0.03 never closes → springs to the default
   dock. Below the line: existing ladder untouched. Duck path untouched.

6. **THEME ACCURACY** (audit-verified gaps):
   a. #pill-workspace still uses the v0.52 inline pattern (no gradient
      twin) + the audit saw it drop out after re-render → adopt
      projPillStyle.
   b. projPillStyle paints on-accent ink ALWAYS — solid-accent pills show
      white labels on quiet tints ("lousily"). FIX: ink = var(accent-N);
      the [style*=] catchers flip it to on-accent when the gradient is
      live (they already set color !important).
   c. Public-library pills (.hub-libpill[data-tone][data-on=1]) are
      class-based tints never in any gate → never window. FIX: explicit
      per-tone gate rules (persona→a2, template/doc→a1, skill→a3,
      script→a4, base→a2).
   d. .hub-publish (tone-scoped) never windows → per-tone gate rules via
      the .hub-root[data-tone] scope.
   e. Connect pills: .wsx-conn (a1+a2 tint gradient), .wsx-ico (k-github
      a1/k-gitea a2/k-gitlab a3/k-device a1), .wsp-pill[data-on=1] +
      .wsp-signin (provider-scoped) → explicit per-accent gate rules
      (github/selfhost=a1, gitea=a2, gitlab=a3, sourcehut=a4).
   f. THE SYSTEMATIC PASS: theme.js derives per-accent glyph/window
      selector lists FROM THE STYLESHEETS at runtime (the PROJ walker
      pattern) and injects the gates — every static rule with
      color:var(--accent-N) → glyph; background/border rgba(var(--
      accent-N-rgb)) or background:var(--accent-N) → window. Skips:
      pseudo selectors, gate/catcher rules themselves, indirection vars
      (--wsp/--hub-tone), @keyframes. Zero effect on solid themes.
   g. text-grad list trim: .hi-counts b (text-2) and
      .chat-working-stalled (warn) are NOT text-1 consumers → remove.
   h. nebula ships NO text-1/2/3/3-dim overrides (only theme missing
      them) → metadata/sub-headers "follow no theme". FIX: add a
      violet-tinted text family.

## PHASES

P1 v0.69.1 (engine, Go): items 1+2 + unit tests + go test ./... + build.
P2 v0.69.2 (feel): items 3+4+5 + rebuild + live red-team (agent-browser
   synthetic touches + the BIB logic audit) + regression suites v0642/
   v0643/v0651/v0680.
P3 v0.70.0 (themes): item 6 + the v065 theme suite (subset) + a new
   focused red-team script (v070) auditing pill families' computed
   styles live + regressions.
P4 push: fetch/rebase, one tag per wave, CI green.
