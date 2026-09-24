# PLAN — v0.57 THE VISION SWEEP WAVE

User red-team of v0.56 (5 items) → root causes found by 3 audit agents + live empirical tests.
Goal: **every page looks good under randomized gradients/options** — no tiling, no bleed,
hierarchy everywhere, everything theme-driven.

## EMPIRICAL FACTS (verified live)

1. **The overlay card DOES follow gradients + patterns** (mesh verified) — the twin works.
2. **The scrim is the bleed**: `color-mix(var(--bg-app) 55%, #000)` is **OPAQUE** and painted
   with the user's overlay-background color → the whole screen outside the card = flat wash
   of that color; the app behind is INVISIBLE. (User items 2/3/5.)
3. **Patterns are continuous across panel+cards** (fixed field works, checker verified) —
   BUT hierarchy collapses: nav pills vanish (they paint the SAME surface-1 field as the
   panel), text hard to read (no calming layer on cards). (User item 1.)
4. **`GradientUI.norm()` only accepts `pat-*` dirs** — `dir:'checker'` → `'auto'` (test
   artifact, not an app bug — randomizer must use canonical dirs).
5. `.msg-user` (user bubbles) + 5 more rules paint the twin WITHOUT `fixed` → local
   squeezed copies (the tiling). ~60 more painters are SOLID-only (flat same-color pills).

## THE DESIGN — THE LAYER SYSTEM (answers "make them seamless")

One continuous field per var (`background-attachment: fixed`, anchored to the transformed
panel/overlay-card = "cropping" per the user's quick-hack) + **veils for hierarchy**:

- **Layer 0 — canvas**: bg-panel pattern (app.js paint).
- **Layer 1 — big surfaces**: the panel + overlay card = the var's FULL field, no veil.
- **Layer 2 — cards on surfaces** (sections, hub cards, rows, bubbles, big cards):
  the SAME surface-1 field window + `--veil-card` (color-mix bg-app 24%, translucent) +
  the gradient border ring → seamless AND hierarchical.
- **Layer 3 — pills/tabs/chips/inputs/small buttons**: the **surface-2** field window
  (+ border ring). NEVER surface-1 (the invisibility bug).
- **Headers** (h3, chat-header, pub-head-bar): the **bg-app** field window + `--veil-head`
  (38%) — matches the v0.49 "overlay background = headers/scrims" semantics.
- **State pops** (hover/active/on): accent tints (flat veils, momentary).

## PHASES

### A. theme.js — the missing plumbing
1. `RGB_PAIRS += '--bg-panel' → '--bg-panel-rgb'`; applyTheme derives it from the computed
   --bg-panel EVERY apply (base themes + overrides both covered).
2. `--border-strong-gradient` twin: when --border is overridden, deriveBorderTwins' sweep
   also written to --border-strong-gradient (same sweep — same family of color).
3. No new twins for ok/warn/err (veils stay veils).

### B. index.html — the layer system + hardcoded kills
1. `:root` tokens: `--veil-card: color-mix(in srgb, var(--bg-app) 24%, transparent)`,
   `--veil-head: color-mix(in srgb, var(--bg-app) 38%, transparent)`,
   `--on-brand: #fff`, `--on-ok: #06251a` (chrome constants, like --on-accent).
2. **REBUILD the twin groups**:
   - Layer-1 group (twin+fixed, NO veil): `#chat-panel, .panel-header, .panel-body`
     (+ keep harmless dead selectors out).
   - Layer-2 CARD rule (3 layers: veil + surface-1 field + border ring, fixed×3,
     clips padding/padding/border-box): `.settings-section, .hub-card, .pv-row,
     .msg-assistant, .ts-row, .hmsg-card, .starter-chip, .fmt-codecard, .fmt-yt,
     .art-panel, .art-row, .art-ed-body, .art-sheet, .cm-s-doomalay.CodeMirror,
     .hp-sec, #send-menu, .kb-card, .cv-section, .mb-more, .wsx-opt, .src-wrap,
     .hub-wrap, .fmt-code, .fmt-pre, .code-card` (+ usage cards classes).
   - Layer-3 group (surface-2 twin+fixed): existing inputs/selects/textareas/switch
     tracks + `.err-switch, .chat-jump, .ts-chip, .art-rename-input, .art-sheet-input,
     .art-toast, .hub-searchico, .hub-libpill, .hub-bunch-chip, .hub-nav, .hp-icocell,
     .hi-fab, .hp-color, .hp-mini, .hp-pick, .dx-pill, .gr-color, .gr-mini, .crop-btn,
     .hp-focus-btn, .tw-iconcell, .chat-find-chip, .sm-ghost, #chat-send-more, .gr-dir,
     .cv-input, .cv-chip, .cv-badge, .cv-count-chip, .wsx-input, .wsx-act, .wsc-brsel,
     .kbd, .pv-btn, .gr-editor, .gr-swatches, .gr-tools, #pe-name, #ph-key, #ph-val`.
   - REMOVE from surface-1 group: `.settings-nav .tab` (→ Layer-3 group + active accent
     veil), `.pill, .chip, .kbd, .dock-strip, .pv-btn` (re-homed).
   - The INLINE catchers (surface-1/2): add the veil layer to surface-1 (Layer-2 callers)
     and keep surface-2 catchers plain (Layer-3). Keep border-image catchers.
   - HEADERS rule: `.settings-section h3, #chat-header, .pub-head-bar` →
     `background-image: linear-gradient(var(--veil-head), var(--veil-head)),
     var(--bg-app-gradient, none); background-attachment: fixed, fixed;`
     (replaces the flat color-mix backgrounds; #chat-header inline bg stripped from
     chatpanel.js so this rule owns it).
   - THE SCRIM family: `#chat-scrim, .art-scrim, .kb-scrim` (keys.js), `.crop-ui`,
     `#media-zoom` → `rgba(var(--bg-panel-rgb), <same alpha>)` (theme-anchored veil;
     app visible through the panel-scrim; media viewers stay near-opaque but themed).
3. **The tiling six**: add `background-attachment: fixed` to `.msg-user` (959),
   `.dx-pill[data-on]:not([data-tone])` (3081), `.pv-btn-primary` (2368), `.ts-stage-n`
   (1364), `.cwd i` (1639).
4. **State gaps**: `.color-row-reset:hover` / `.chat-find-btn:hover` /
   `.hub-card:active` → `background-color:`-only (image survives the press);
   `.app-switch input:checked ~ .app-switch-track` (877) gets the accent twin + fixed
   inline in the rule.
5. **Hardcoded kills**: dock glass ×7 → `color-mix(surface-1 72%, transparent)` + blur /
   hover `color-mix(surface-2 80%, transparent)`; `#menu` #1a1a20 → surface-2 (joins
   Layer-3 group); `.fmt-codehead` #17171f / `.art-unsaved` #1a1420 / `.art-row:active`
   #181822 / CodeMirror gutters #101018 / `.fmt-yt-thumb` #0a0a10 → bg-panel color-mixes.
   (Black box-shadows + white hairlines stay — lighting, not color.)

### C. connectoverlay.js — the bleed fix (user items 2/3/5)
- scrim: `color-mix(var(--bg-app) 55%, #000)` → `rgba(var(--bg-panel-rgb), 0.55)` +
  blur (authentic app visible, darkened; no more overlay-color leak outside the card).
- card shadow: same swap.

### D. JS files
- localmodels.js:67 / providers.js:342 / recovery.js:77 CTAs: `var(--border-strong)` →
  `var(--accent)` (ride the accent field; catchers already handle the twin).
- modelpicker badge + chatbot.js:138 icon tiles: keep border-strong — new catchers
  `[style*="background:var(--border-strong)"]` (+no-space) → `--border-strong-gradient`.
- modelbrowser.js rgba(0,0,0,0.14) ×4 → `color-mix(in srgb, var(--bg-app) 14%, transparent)`.
- uiactive.js #06251a → `var(--on-ok)`; artifacts.js #71717a → `var(--text-3)`;
  providers.js `color:#fff` → `var(--on-brand)`;
  tweaks.js:656 + hubpublish fallbacks `#38bdf8/#a78bfa` → `var(--accent)/var(--accent-2)`.
- chatpanel.js: strip the inline #chat-header bg (CSS rule owns it now).
- Injected sheets (keys/chatsview/workspace/modelbrowser/chatpanel send-menu/uikit gr-*):
  add twin+fixed to their theme-var painters; workspace `.wsv-pre` gets fixed.

### E. The randomizer + THE VISION SWEEP (user item 4)
- Randomizer (agent-browser eval, seeded): all 9 customizable rows + grid colors +
  fmtOverrides — 2–6 colors from a vivid pool, dirs random among h/v/diag/diag2/radial/
  swirl/mesh/pat-navy/pat-pinstripe/pat-gingham/pat-sunburst/pat-checker (70% gradient /
  30% pattern); 3 seeds + all 10 preset themes (incl. light Paper/Frost for the scrim).
- Session setup via engine API (create chat + PM-append messages) for chat screens.
- Screenshot EVERY screen per the 10-a stage map (~40 shots) → /home/z/sweep-v057/.
- VLM audit each batch: seams/tiling, invisible boxes, bleed, readability, off-theme
  colors, broken layout. FIX + re-sweep until clean. This is the acceptance gate.

### F. Gates + ship
- node --check touched JS; uikit selftest; theme twins test; go build/vet/test;
  engine REBUILD (web/ is embedded); rebase check; push; tag v0.57.0-vision-sweep;
  release; verify CI assets; worklog.
