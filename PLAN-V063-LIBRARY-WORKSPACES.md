# PLAN-V063-LIBRARY-WORKSPACES — the library + workspaces + sign-in wave

The user's directive (2026-09-27, this session): 7 library items + 3
workspaces items + 2 random items. Methodology unchanged: build per phase,
red-team as a real user, release per phase (one push each).

Recovery note: 5th sandbox reset — Go reinstalled, engine rebuilt
(/tmp/doomalay-engine), rig at /home/z/e2e (up.sh), HF connected as
ScoobyBaby1999, PM key + GH PAT in the vault, origin armed for pushes.
Baseline: ae10e49 (v0.62.4.1, the parallel bot's screenshot tier).

## Phase 1 — v0.63.1-library-polish (items 1-7, library)

1. **docs hidden**: LibrarySpec.Hidden flag (hub.go, doc=true);
   handleHubLibraries filters hidden specs. The type stays REGISTERED —
   bundle member sections, one-press download, /api/hub/doc/* serving,
   repo-file routes all keep working (they iterate All() / CollectionItems,
   not the /libraries response). JS needs no change (fetchLibraries reads
   the API; pills render what's there; default type = first non-hidden =
   persona).
2. **repo-tree memory**: hubrepo.js — module-level openPaths{repo:{path:1}}
   recorded on folder toggle; after mount, restore sequentially by depth
   (poll for the branch element, row.click() replays the lazy load).
   Survives popView (file preview back), bunchRepaint, view switches.
3. **bundle flag**: .hub-bundle-flag bottom 62px → 81px (+30%);
   drop the <i>bundle</i> text from collectionCardHTML (cards page).
4. **sections collapsed by default**: bunch view (hub.js ~440) + mine view
   (~813-835) — per-view folded map; .hub-bunch-sec-h gets cursor:pointer +
   a right-side rotating chevron; click toggles one section. Collapsed =
   default for every section.
5. **deep research x5**: builtin.go deepResearchPayload — every stage
   max_tokens ×5 (800→4000, 600→3000, 1200→6000, 1000→5000, 2000→10000,
   600→3000, 2500→12500, 1200→6000); output_rules max_words 4000→20000.
6. **repo-view availability**: hubitem.js + hub.js — repoUsable(item):
   repo empty || 'doomalay/builtin' → unavailable now; else async probe
   GET /api/hub/repo/{repo}/tree?path=/ (module cache, 401/404 → bad) →
   repaint pill to unavailable. Unavailable = a disabled segment reading
   "repo view unavailable" (keeps the row layout, explains itself).
7. **accent-4 + category accents**: index.html — --accent-4 + -rgb in
   :root + all 10 [data-theme] blocks + the gradient-twin rule;
   theme.js — THEMES accent4 hexes, RGB_PAIRS += accent-4, CUSTOMIZABLE
   += Accent 4 (settings row auto-renders via appearance.js iteration).
   Tone remap (hub cards/pills/hi-root): default+doc → --accent (primary),
   template → --accent, persona → --accent-2, skill → --accent-3 (kept),
   script → --accent-4 (was --notice). Wait: template & persona both need
   distinct → template → --accent, persona → --accent-2, skill stays
   --accent-3, script → --accent-4, doc → --accent (hidden anyway).
   Also [cards|repo]/[stages|raw] segments (.hi-viewseg): wider, polished.
   VERIFY the swatch path for accent4 (appearance seeds from computed cssVar
   — automatic).

## Phase 2 — v0.63.2-workspaces-split (items 1-3, workspaces)

1. **two pages**: pickerHTML slims to head + "▣ your workspaces" list +
   the ＋ connect pill (the provider pills grid + provider section MOVE to
   the connect page). openConnectPage pushes the REWRITTEN connect page:
   provider pills grid at top + renderProvSection (sign-in / create /
   public-repo bar / repos box; selfhost = device/local rows). The old
   connectHTML hero+chips+create/device rows are RETIRED. Post-sign-in
   reopen lands on the CONNECT page (not the picker). checkOAuthReturn
   parked create/cloud resumes keep working (functions stay).
2. **picker polish**: "your workspaces" title indented right a bit;
   wsx-list min-height keeps the overlay large when empty; the connect
   pill compact (min-height ~36px, no meta sub-line, tighter gradient);
   provider colors: github → --accent (primary), gitea → --accent-2,
   gitlab → --accent-3, sourcehut → --accent-4, selfhost → neutral base
   (no-brand, local) — replacing the hardcoded brand RGB in BOTH the
   .wsp[data-prov] scope rules AND the PROVIDERS table (--kp/--kpc ride
   the accent vars now).
3. **sign-in text**: '⏾ sign in to X' → plain 'sign in to X' text (the
   pill emoji above carries the icon); same for the forms' signin title.

## Phase 3 — v0.63.3-hf-copy-signin (random items 1-2)

1. **HF description** (sandboxpicker.js hfCardDesc): tc1=--accent,
   tc2=--accent-2 small-text rows:
   - "Linux Sandbox" (tc1) . "Access to bash, python, node, java …
     package installs …" (tc2)
   - "Your own ZeroGPU space, runs on dynamically allocated resources."
   - footnote (tc1): "° 2 per free account • sleeps by usage • 1 GB"
   - footnote (tc1): "° wakes in ~2 mins, installs are ephemeral (tc2),
     brain reinstalls packages automatically after sleep."
2. **sign-in panels** (hfconnect/ghconnect/gitea token page): big circular
   service icon (🤗 / 🐙 / 🍵, 64px tinted circle) above the sign-in pill;
   descriptions shortened to "press authorize…" + a safety line (encrypted
   vault on-device, never see/store the password).

## Gates per phase
go build + vet + test (8/8), node --check on every touched JS, agent-browser
live red-team on :8080 (412×915 mobile viewport), VLM screenshot check,
git push + tag + release. Engine serves web via go:embed → REBUILD + restart
the rig after every web edit.
