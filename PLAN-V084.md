# PLAN-V084 — THE ATOM ORBITS + THE PERSONA BADGES + THE RENDERER PATH

User spec (3 tasks, verbatim intent):

1. **ATOM ORBITS** — "Let's make each connected workspace spawn a small orbiting
   star around the chat that orbits like an atom not a 2d plane basic circle. It
   goes back and forth behind and above the icon. A chat with 10 workspaces has
   10 stars. Like an atom, we cap each level of orbit to a set number of stars
   then jump to another slightly further level of orbit orbiting another axis.
   Cap the workspaces per chat at like 50 I guess.... Or 24? Idk... Ur call."

2. **PERSONA BADGES** — "Let's have each persona be a badge around the chat. By
   default a persona has no badge, but a user can select a badge and associate
   it with a persona, it may be a basic solid color outline around the edge of
   the circle for the chatbot icon, or a gradient, or an image, basically our
   coloring system. The persona should accept an image that has custom looks or
   designs, a badge shouldn't strictly be just a color variation to the borders
   of the icon. In the persona overlay screen when the persona is selected,
   let's change the delete pill to just be a trash icon colored to a theme
   color. Let's make sure all the pills (always active, trigger, ext) use theme
   colors. And next to the name, between the name box and the placeholders we
   can add another face card or something pill that opens an overlay screen that
   allows the user to select the badge that will render around the icon when
   this persona is selected. Update all the persona library stuff to accept this
   new addition, as downloaded personas should include the custom badge, even if
   it was an uploaded image not our default basic color system."

3. **RENDERER PATH RESEARCH** — "Let's research and document what we should do,
   if we should stay as is or add some languages or libraries or maybe even game
   engine like godot to the app. Here is why; the app is currently laggy and
   feels slow and unresponsive… We want to render tens and even hundreds of
   chats and icons… dynamic connections with animated UI… each chatbot to have
   its own UI tweaks… a network of chats managed by a panel with judges… should
   eventually look like a nebula and galaxy… We shouldn't be facing any lag or
   unresponsiveness yet as we intend to introduce SO much more load."

(v0.83.x is taken by the parallel agent's weight-pendulum wave — this wave is
v0.84.1 → v0.84.3 + the v0.84.0 wave release. Engine version 0.83.0 → 0.84.0.)

---

## v0.84.1 — THE ATOM ORBITS (task 1)

### The math (fake-3D electron shells on the 2D canvases)
- Each chat icon with N bound workspaces carries N stars in SHELLS:
  capacities `[4, 6, 8, 8, 8]` (level 1 closest… level 5 furthest) → 34 slots,
  **chat binding cap = 32** (my call per the user's "50 or 24, ur call": 32
  fills 4 shells + a partial 5th — enough to read as a big atom, few enough to
  stay cheap: worst case 32 arcs + 5 ellipse strokes per icon per frame).
- Shell radius (screen px at scale 1): `46, 60, 74, 88, 102` — each "slightly
  further" as specced.
- Each shell orbits on its OWN AXIS: a stable tilt pair `(α, β)` per level —
  `[22°,0°], [64°,45°], [38°,120°], [78°,210°], [8°,300°]` — so level 2's ring
  visibly swings a different plane than level 1's.
- Star state is STATELESS per frame (stable hashes on icon.id + shell + slot,
  exactly the grid's hashCell discipline): phase, angular speed (0.35–0.8
  rad/s, direction ±), so panning/reloads never pop.
- Projection: unit circle `(u,v)` in the shell plane → 3D basis vectors
  `e1 = (cosβ, sinβ·cosα', …)`, `e2` orthogonal → `p = R(u·e1 + v·e2)`;
  screen `(p.x, p.y)`, DEPTH = `p.z`.
- **"Back and forth behind and above the icon"**: stars paint on the over-icons
  canvas `#c2` (z 150 > `#chatbots` z 100):
  - front side (z ≥ 0): full alpha + a small glow — reads ABOVE the icon;
  - back side (z < 0): dimmed to 55% AND clipped OUTSIDE the icon disc
    (evenodd clip: full-canvas rect + disc circle) — the star visually slides
    BEHIND the disc, exactly the classic atom-nucleus occlusion.
- Shell ellipses: one faint rotated-ellipse stroke per shell (theme
  `--border-strong` at low alpha) so the orbits themselves read.
- Colors: theme tokens only — star fill `--accent`, glow via radial gradient of
  the same, ellipse `--border-strong`/35%.
- Culling: icons whose projected center is off-viewport skip entirely;
  `DoomalayDebug.atoms = {chats, stars, shells}` joins the honest instrument.

### The plumbing
- New `web/atoms.js` (`window.Atoms`): `refresh(icon)` (GET
  `/api/sessions/{sid}/workspaces` → count), `refreshAll()`, `setCount(sid, n)`
  (test hook + the live path), `active()` (any icon > 0 stars), `paint(ctx2,
  offsetX, offsetY, scale, t)`.
- `app.js`: paint call after `renderGrid()` in both `update()` and `tick()`;
  `ambientActive() || Atoms.active()` keeps rAF alive; boot refreshAll for
  restored icons; listens `doomalay:workspaces-changed` (detail.sessionId) →
  one-icon refresh.
- `workspace.js`: bind/unbind PATCH/DELETE paths + the pill's live count fetch
  dispatch `doomalay:workspaces-changed`; `chatpanel.js` applyBundle
  (session swap) refreshes its icon.
- **Server cap 32**: `handleSessionWorkspaceBind` counts current bindings →
  409 `"this chat already orbits 32 workspaces — unbind one first"` (before
  connect-inline work, after wid resolution).
- Rig `scripts/v0841-atom-orbits-test.sh` (agent-browser): 10 workspaces → 10
  stars in 2 shells (4+6) with different axes/radii; 40 set → capped 32;
  behind-star clipped inside disc rect / front-star drawn over it; rAF alive
  with animate toggles OFF; debug counters; zero console errors.

## v0.84.2 — THE PERSONA BADGES (task 2)

### The spec (rides PersonaSpec JSON — `badge`, absent = none)
```json
{ "kind": "solid",    "token": "accent" }
{ "kind": "gradient", "from": "accent", "to": "accent-2", "angle": 90 }
{ "kind": "image",    "rev": 3 }   // bytes engine-side, rev'd
```
- Token whitelist (THEME TOKENS — nothing hard-coded survives): `accent,
  accent-2, ok, warn, err, notice, text-1, text-2, text-3, surface-3,
  border-strong`. Solid/gradient reference CSS vars → the whole theme system
  re-tints badges live, exactly like every other chrome.
- Image badge: `PUT/GET/DELETE /api/sessions/{id}/personabadge/{pid}` — the
  icon route's exact contract (magic sniff, rev bump, bgRecord kv row
  `chat.pbadge.<sid>.<pid>`, immutable cache GET). Client CropUI square ≤256.

### The render (canvas icon ring)
- `chatbot.js`: `_badgeRingEl` — an absolutely-positioned ring div around the
  icon disc (inset −6px, border-radius 50%): solid → `background: var(--t)`;
  gradient → `linear-gradient(angle, var(--from), var(--to))`; image →
  `background-image: url(/api/sessions/{sid}/personabadge/{pid}?v=rev)`. A
  radial-gradient CSS mask carves the center out → a true RING for all kinds
  (an uploaded image wraps its pixels around the ring — a custom-look badge,
  never "just a border color"). `setPersonaBadge(badge)`.
- The ACTIVE persona's badge shows: `app.js` boot +
  `doomalay:persona-saved` (persona.js already dispatches it on every persist)
  → GET session → resolveActive-lite (always > shuffle-pick > none; triggers
  need live metrics the canvas doesn't have — documented in the view) →
  `setPersonaBadge(active.badge)`.

### The editor UI (persona.js)
- Delete pill → a TRASH glyph (inline SVG, stroke `var(--err)`) — armed state
  keeps the confirm semantics ("sure?" text stays, icon returns after 2.6s).
- ALL pills verified theme-colored (mode pills already ride MODES rgb vars;
  action pills ride surface-1/surface-2/text-2; publish/save accent).
- NEW badge pill between the name box and the `{ } placeholders` pill: a live
  ring swatch + "badge" — opens `badgeView(p)` on the master panel's view
  stack (the app's overlay screen system, per the standing rule):
  - none / solid (theme-token swatch grid) / gradient (from+to token grids +
    angle presets 0/45/90/135/180/270) / image (CropUI upload → PUT → rev);
  - LIVE preview: a mini icon disc wearing the ring;
  - save → `p.badge` + persist() (canvas ring refresh rides the event).
- Persona list rows: a small ring swatch when the persona carries a badge.

### The library round-trip (hub)
- `hub.Item` + `PublishRequest` gain `Badge` (`*PersonaBadge`) +
  `badge_png_base64`. Publish: image badge bytes commit at
  `items/<id>/badge.png`; the stored badge carries `file` (the repo path).
  Solid/gradient sanitize through the same token whitelist.
- Download (`POST /api/hub/{type}/download` → item carries badge):
  - `hubitem.js importPersona` + `hub.js importPersonaInto`: copy the badge
    spec; for `kind:'image'` fetch the repo-file bytes → PUT to the chat's
    personabadge route → rewrite `{kind:'image', rev}` — a downloaded persona
    keeps its CUSTOM badge even when it was an uploaded image, never our basic
    color system.
- `hubpublish.js`: persona publish carries the persona's badge (solid/
  gradient spec or the engine-stored image bytes → badge_png_base64); the
  persona editor's ⇧ publish pill passes it.
- Persona DELETE best-effort DELETEs the badge image row.
- Tests: Go — badge spec sanitize/round-trip through Personas JSON; the 3
  personabadge routes (rev bump, sniff, 404s); hub publish+download carries
  the badge (fake HF server pattern). Rig `v0842-persona-badges-test.sh` —
  ring painted for solid/gradient/image on the canvas icon; trash pill; badge
  view opens + saves; persona-saved → canvas refresh; import applies badge.

## v0.84.3 — THE RENDERER PATH RESEARCH DOC (task 3)

`RESEARCH-V084-RENDERER-PATH.md` — web-researched, code-evidenced:
- WHERE THE LAG ACTUALLY IS today (full renderGrid repaints per frame with
  per-dot gradient sampling + per-glow createRadialGradient allocations; the
  projection painter; full-panel innerHTML re-renders; DOM icon layers).
- The verdict on the options (web-verified): Godot/Unity web = NO (30–60MB
  wasm, SharedArrayBuffer cross-origin isolation, iOS broken, loses the DOM/
  CSS theme system the whole app is built on); PixiJS/WebGL scene graph = the
  right heavy-artillery for the nebula target (~100k sprites batched, v8
  WebGPU/WebGL + Canvas2D fallback, ~450KB); OffscreenCanvas+Worker = the
  main-thread freedom fix (Chromium ≥69 — the Android WebView base).
- THE PHASED PLAN: 0) measure (fps meter + frame budget instrument), 1) cheap
  structural wins now (dirty-rect star layer, pre-baked sprite canvases,
  cached gradients), 2) OffscreenCanvas the grid painter into a worker,
  3) PixiJS world layer under the DOM UI (icons become sprites; panel/overlays
  stay DOM), 4) the nebula target (connections as GLines, light emission as
  additive blend sprites). Each phase gated by the perf bar: 60fps desktop /
  48fps mid-phone with 200 icons + orbits + connections.

---

## Build order
v0.84.1 → v0.84.2 → v0.84.3 (doc) → version 0.84.0 + wave tag
`v0.84.0-the-atom-badges-wave`, CI dispatched on tag refs (the Task-3 lesson),
releases PATCHed with notes, full red-team bar green.

Shared files across phases: `app.js`, `chatbot.js`, `persona.js`,
`hub.js/hubitem.js`, `index.html`, `personas.go`, `workspaces.go` — sequential
phases, no parallel agents on these files this wave.
