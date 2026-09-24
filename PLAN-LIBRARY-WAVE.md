# v0.58 — THE LIBRARY POLISH WAVE (the user's 14-point red-team)

Base: fd90e6e (v0.57.0-vision-sweep). All 14 points mapped to phases below.
Standing rules: theme colors only (item Designs = per-item DATA, like user-picked
card art — allowed); new UI rides the panel (library views already do); plan →
research → build → red-team; rebase before push.

## The 14 points → what they actually are
1. Category tones everywhere → CSS var pair `--hub-tone/-rgb` on `.hub-root[data-tone]`;
   publish pill / search focus / sort actives / bunch chip / my-pill all re-point to it.
2. Bundle badge → left-edge horizontal "for sale" flag at ~90% height (just above the
   foot), `#tag` bold + smaller `bundle`; bunch cards get ART: design from
   (a) builtin override for `superpowers-obra` (my chosen mesh), else (b) newest
   member's design, else (c) deterministic idGradient(bunch id) → every bunch is
   brandable by its publisher's card design ("any user can create any bundle and set
   it to their color": publish items with a bunch id + a card design).
3. Bundle relevance → already enforced (byType[c.type] > 0 filter, hub.js:492-494);
   verify live in red-team, no code change expected.
4. Show-bundles toggle → mini switch in .hub-ctlrow between steppers and publish
   (localStorage doomalay.hubbundles.v1, default ON). ON = bunch cards shown AND
   member items hidden. OFF = no bunch cards, all items shown.
5. Cols/rows polish → compact slider-look stepper: flatter −/+ chevrons, center value
   window with tone tint, tabular numbers; fix rows cap bug (handler clamps 10 but
   spec says 100 → unify at 100).
6. Marquee names → `.hub-card-name-in` inner span; JS measures overflow → sets
   `--slide-d`; slow alternate keyframes (~26px/s, holds at both ends). Grid cards
   (items + bunches).
7. Detail page → title `lib · name`; iPhone-crisp hero (veil-ink scrim + text-shadow,
   bigger title, cleaner meta/chips, toned chips); payload flows directly from hero;
   heart/download fabs → circular 62px IconLib SVGs, OPAQUE pill backgrounds, 2×
   visual weight; footer pills: "download first" (endorse w/o download), transient
   "downloading…" / "endorsing…" via hold-mode toast.
8. My-xyz pill → shows for ALL 4 types ("my personas/skills/templates/themes"),
   updates on tab switch + dock-open (default tab persona); acts as a FILTER
   (GET /api/hub/{type}/downloads), no TemplateSheet redirect. Deep research becomes
   a card TEMPLATE: engine builtin item (mesh red→grey design, 8 stages) + port the
   stage tree ("simplified view") into the payload viewer with [stages | raw] toggle.
9. Scroll preservation → panel.pushView snapshots scrollTop onto the covered view;
   popView restores it; replaceView gains {keepScroll}; hubpublish rebuild harvests
   input values first + keeps scroll + expanded sections. Collection placeholder
   "e.g. superpowers-obra" → generic ("e.g. my-toolkit").
10. Stage counts → engine: Item.StageCount; scan.go counts at scan (payload in hand,
    currently discarded); Publish auto-counts template JSON (stages[].length) unless
    manual `stageCount` given; card foot shows "~N stages" right of downloads
    (wide two-tab gap); publish form gains optional # stages (templates only).
11. Skills format → they ARE .md (registry PayloadExt ".md"); fix the publish form
    labels/placeholders (skill = .md + SKILL.md guidance; theme = .doomtheme;
    template = .json). Answer to user: port is accurate for the single-file SKILL.md
    core; multi-file scripts are flattened by design (single-payload hub model).
12. Re-publish → downloaded templates: download fab becomes edit fab → HubPublish
    prefilled (name/desc/tags/icon/design/payload/stages); dirty-guard blocks
    unedited publish ("make an edit first").
13. Use template → templates get a use fab: applyTemplate to the connected chat;
    no chat → footer "connect a chat first".
14. Endorse hotbox → .hub-card-stat[data-heart] padding+negative-margin trick →
    ≥44px hit target; works at half-height panel.

## Phases
- P1 ENGINE: StageCount on Item (+scan-time count, +publish auto/manual); CollectionSummary.Design
  (+superpowers override map + newest-member rule); builtin.go (BuiltinRepo
  "doomalay/builtin", deep-research item + 8-stage payload ported from
  brain/templates.py); wire Items()/remoteItem/resolvePayload/Download/Endorse;
  serve hearted/downloaded booleans on item/download/endorse/publish responses.
  Gate: go build/vet/test.
- P2 PANEL: scroll snapshot/restore + replaceView keepScroll.
- P3 HUB.JS: tone vars + re-pointed chrome; bundles toggle; badge flag + bunch art
  (paintCardBg for [data-bunch], idColors split); marquee scan; ~N stages stat;
  hotbox CSS hook; hold-toast API; my-xyz filter (all types, downloads-backed);
  rows cap 100; grid heart w/o download → "download first" footer + detail open.
- P4 HUBITEM: lib · name; hero restyle; fabs redesign (use/edit/download/heart per
  state); footer transient states; formatted stage-tree payload + [stages | raw]
  toggle; keepScroll after actions; seed session maps from served hearted/downloaded.
- P5 HUBPUBLISH: per-type payload labels; generic eg + bundle-design hint; rebuild
  with harvest + keepScroll + section/focus restore; #hp-stages (template); re-publish
  prefill + dirty-guard.
- P6 CSS (index.html): all of the above + stepper slider-look + toggle switch +
  flag + marquee keyframes + hi-* restyle.
- P7 GATES + RED-TEAM: node --check, uikit, theme twins, go gates, build-engine,
  fresh engine run, agent-browser sweep (412×915) over every flow above, VLM
  batches, REAL HF publish/download/endorse/re-publish round-trip with the token.
- P8 SHIP: fetch/rebase check, commit, tag v0.58.0-library-polish, release, CI +
  assets verify, worklog.

## Non-goals (explicit)
- No new overlay screens (everything rides existing panel views).
- No multi-file skill payloads (hub model is single-file; scripts stay out of scope).
- No bundle-builder multi-picker UI (bunch = collection field; art = newest member
  design — documented in the form hint).
