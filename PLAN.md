# Doomalay Improvement Plan — Items 1-7

**Working copy:** `/home/z/doomalay` (clone of `ScoobyBaby1999/doomalay` @ `v0.44.0-gradient-crop-templates`)
**Strategy file:** `/home/z/STRATEGY.md` (the saved workflow prompt)
**Real app frontend:** `engine/internal/server/web/` (vanilla JS SPA, embedded in Go engine, served at :8080)
**NOT the real app:** `app/` (Vite+React skeleton rebuild at v0.1.0 — ignore for items 1-6)

---

## Architecture confirmed
- `engine/internal/server/web/*.js` = the running PWA (vanilla JS, no build step)
- `engine/internal/server/*.go` = Go HTTP/WS API + embed
- `brain/*.py` = Python Strands agent (templates, personas, tools)
- `platforms/hf-space/` = Docker image (manual setup today)
- `platforms/android/` = Kotlin APK wrapping Go engine + PWA

## Item-by-item plan (file:line citations from EXPLORE-MAP-1 + RESEARCH-HF-1)

### ITEM 1 — Faster panel slide-down
**Current:** gesture.js `dismiss()` (≈340-365) runs a spring (stiffness 260, ~300-400ms); `.open` stays on `#chat-scrim` during the WHOLE spring, so `isInsideUI()` (app.js:697-738) keeps blocking canvas until spring ends → the "1s" delay.
**Fix:**
- Release the scrim from `isInsideUI()` the moment close BEGINS (not on spring end). Add a `closing` flag on panel; `isInsideUI` returns false when `panel.closing === true`.
- Shorten the dismiss spring (stiffness 260 → ~420, damping up) and the `riseTo` close transition (250ms → ~160ms).
- Keep `transitionend` + setTimeout fallback but reduce the fallback (340ms → 220ms).
**Files:** `engine/internal/server/web/gesture.js`, `panel.js`, `app.js` (isInsideUI)
**Verify:** agent-browser: tap icon → panel opens → tap scrim/close → measure time until canvas drag works again (target < 250ms).

### ITEM 2 — Remove web-search pill + default-on web search
**Current:** pill at `chatpanel.js:2468-2480` (`⌕ web`), toggles `state.webSearch` (default FALSE). Engine `brain/agent.py:69` `web_search: bool = False`; the web_search TOOL is always loaded — flag only adds a system-prompt note (`agent.py:783-784`).
**Fix:**
- Delete the pill markup + its state toggle + the PATCH that persists `webSearch`.
- In `brain/agent.py`, default `web_search=True` (the tool is always available anyway; the note becomes always-on). Keep the `deepResearch` → template flow untouched.
- If the engine/PM path gates tools on `state.webSearch`, switch that gate to always-include web_search/fetch tools.
**Files:** `engine/internal/server/web/chatpanel.js`, `brain/agent.py` (and check `engine/internal/llm/*` + `brain/server.py` for the PM gate)
**Verify:** agent-browser: composer has no `⌕ web` pill; ask a time-sensitive question → web_search tool fires.

### ITEM 3 — Canvas background IS the app background
**Current:** `--bg-app` (theme.js CUSTOMIZABLE, index.html:192 `body { background: var(--bg-app) }`) is INVISIBLE because `<canvas id="c">` (index.html:2869) covers the body. The visible bg is `t.bg` (Grid Colors → Background) painted at `app.js:123` via `effectiveGrid(s).bg`.
**Fix:** Unify — make the canvas bg derive from the `--bg-app` spec (so the customizable "App background" row drives the canvas). Two viable approaches:
  - (A) app.js reads `getComputedStyle(--bg-app-gradient)` → paints canvas with it (keeps gradient on canvas).
  - (B) Drop the separate Grid Background row; alias `s.bg` ← `themeOverrides[cur]['--bg-app']`.
- Prefer (A) so gradients actually paint on canvas (canvas can't use CSS var()).
**Files:** `engine/internal/server/web/app.js` (renderGrid bg fill), `theme.js` (expose `--bg-app` spec), `appearance.js` (relabel "App background" → drives canvas bg).
**Verify:** agent-browser: change App background to a 3-color gradient → canvas grid bg shows the gradient.

### ITEM 4 — Color setters actually match labels + follow gradient/pattern
**Current:** 9 customizable vars (theme.js:152-162): `--bg-app, --bg-panel, --surface-1, --surface-2, --border, --text-1, --accent, --accent-2, --accent-3`. Each writes twin pair `--X` (solid) + `--X-gradient` (image) + `--X-rgb` (accents). But index.html consumer rules are inconsistent: some use `var(--X)` (solid only, ignores gradient), some `var(--X-gradient)`, some hardcoded hexes.
**Fix:** Audit every consumer rule in index.html for the 9 vars. Standardize: backgrounds/borders that CAN be gradients use `background-image: var(--X-gradient); background-color: var(--X)` (gradient over solid). Text/icons use `var(--X)` solid (gradients don't render on `color:`). Replace all hardcoded hexes in consumer rules with `var(--X)`. Add a test harness assertion (scripts/test_theme_twins.js already exists — extend).
**Files:** `engine/internal/server/web/index.html` (consumer CSS), `theme.js`, `scripts/test_theme_twins.js`
**Verify:** agent-browser: set each of the 9 vars to a distinct 3-color gradient → confirm each labeled UI element paints the gradient where a gradient is sensible.

### ITEM 5 — Neaten color-settings UI (collapsed rows + per-row reset)
**Current:** color rows are `<div class="setting-row"><label>…</label>{GradientUI.editor(...)}</div>` (appearance.js:316-327, 397-413, 495-499) — editors ALWAYS expanded (swatches+tools+dir+angle visible). Section collapse exists (grid-template-rows:0fr→1fr) but only at SECTION level. Per-row reset does NOT exist (only global resets: grid-colors-reset, theme-custom-reset, chat-colors-reset).
**Fix:** Restructure each color row to:
```
[color-name] [pattern banner preview = .gr-preview-bar] [▶ expand arrow] [↺ reset pill]
  ↳ collapsed: full GradientUI editor (swatches+tools+dir+angle) revealed on row click
```
- Add a `ColorRow` wrapper (appearance.js) that holds the collapsed banner + a `<details>`-like expander + a reset button that clears THAT var's override (`delete themeOverrides[cur][var]` / reset grid key to legacy default).
- Reuse GradientUI.editor's `.gr-preview-bar` as the banner.
- Keep section-level collapse too (no regression).
**Files:** `engine/internal/server/web/appearance.js`, `uikit.js` (GradientUI — extract banner API if needed), `index.html` (CSS for the row layout)
**Verify:** agent-browser: open Colors page → rows show banner+arrow+reset, collapsed; click a row → editor expands; click reset → that row reverts to default.

### ITEM 6 — Grid quick options (hide lines/dots, scatter, size, rotate)
**Current:** `renderGrid()` at `app.js:103-160`. Lines at 130-141 (vertical+horizontal strokes). Dots at 143-151 (`ctx.arc`, `DOT_RADIUS=1.4`). `gridSpacing()=GRID_BASE(48)*gridSize` at 71-83. Only dots+lines exist already (good — item 6 is partly ADD controls, partly wire existing render).
**Fix:** Add settings: `hideGridLines`, `hideDots`, `gridScatter` (0-100 → max px displacement), `gridSizeVariation` (0-100 → max radius/length % delta), `gridRotation` (0-100 → max degrees). Use a stable `hashGrid(x,y)` (deterministic per grid cell) so jitter is stable across redraws. Wrap line loop in `if(!s.hideGridLines)`; dot loop in `if(!s.hideDots)`; inside loops apply jitter: `dx = (hash-0.5)*scatter`, `r = DOT_RADIUS * (1 + (hash2-0.5)*sizeVar)`, `rotate = (hash3-0.5)*2*rotDeg`.
**Files:** `engine/internal/server/web/app.js` (renderGrid), `settings.js` (defaults), `appearance.js` (Sizing page controls), `index.html` (CSS)
**Verify:** agent-browser: toggle hide lines → lines disappear; scatter=50 → dots visibly displaced but stable; size=40 → dots vary in radius; rotation=30 → lines tilt.

### ITEM 7 — HF space import (DO LAST; BLOCKED on paid-plan decision)
**Research done (RESEARCH-HF-1 in worklog.md):**
- OAuth: PKCE (S256), `/oauth/authorize` + `/oauth/token`, scopes `openid profile email contribute-repos`. `@huggingface/hub` SDK (`oauthLoginUrl` + `oauthHandleRedirectIfPresent`). No refresh_token (8h expiry).
- Clone: `POST /api/spaces/{ns}/{repo}/duplicate` {repository, private, hardware:"cpu-basic", secrets:[...]}.
- Status: `GET /api/spaces/{ns}/{repo}` → `runtime.stage` enum. Logs: `GET /api/spaces/{ns}/{repo}/logs/{build|run}?tail=N` (SSE). Wake: `POST .../restart?factory=true`.
- **BLOCKER:** duplicating a Docker-SDK Space requires the user to be on a PAID HF plan (PRO/Team). Free only allows Static/ZeroGPU. doomalay's hf-space is `sdk: docker`. → Need user decision: (a) require PRO, (b) redesign the cloned template as a Static space (limits capabilities), (c) use HF Jobs instead.
- docker-in-docker: confirmed unsupported → each chat = its own Space (matches design).
**Plan (after items 1-6):**
- Frontend: `connectoverlay.js` → "Connect HF" button → PKCE redirect → callback handler → success screen → background-clone → redirect to app.
- Backend (Go engine): `/api/hf/oauth/start`, `/api/hf/oauth/callback`, `/api/hf/space/clone`, `/api/hf/space/{id}/status`, `/api/hf/space/{id}/logs` (SSE proxy), `/api/hf/space/{id}/restart`.
- Per-chat option: "Use dedicated HF Space" (off by default → shared space; on → clone new).
- Live status pill: building/restarting/running/sleeping/error + tail logs.
**Files:** `engine/internal/server/web/connectoverlay.js`, `hub.js` (new hf.js?), `engine/internal/server/hf*.go`, `brain/` (if brain-side), `platforms/hf-space/` (template space to clone).
**Verify:** full E2E OAuth → clone → status pill → per-chat space. (Needs user's HF account + the paid-plan decision.)

---

## Risks / Open questions for the user
1. **HF paid plan (item 7 blocker):** duplicating a Docker-SDK Space needs PRO/Team. Which path? (require PRO / Static template / HF Jobs)
2. **Testing without Go engine:** `go` is not installed in sandbox. I can serve `web/` statically for UI testing (agent-browser), but chat/API features need the engine. Options: (a) install Go in sandbox, (b) user runs the engine on their device + tunnel, (c) frontend-only testing for now.
3. **Working directory:** I cloned doomalay to `/home/z/doomalay` (persistent). The Next.js project at `/home/z/my-project` is untouched (worklog.md + STRATEGY.md live there). Confirm this is OK.
4. **Push workflow:** before pushing, I'll `git pull --rebase`, resolve conflicts, then push to `main`. Should I push to `main` directly or a feature branch + PR?

## Sequencing
1. Items 1-6 (frontend, no blockers) — implement now, each with agent-browser verification.
2. Item 7 — after user answers the paid-plan question.
3. Final red-team pass (imitate real user, golden paths).
4. Rebase + push.
5. Create 15-min cron `webDevReview`.
