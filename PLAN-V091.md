# PLAN-V091 — THE GROUP TABS WAVE (tabs that act as a real browser's tabs)

The user's spec, verbatim intent:

> "we still don't have tabs that act as a group. Tabs orbiting the same center
> should act as a group. … switching between 2 or more different tab icons in
> the canvas should not just reload one tab to whichever that tab icon's url
> was — instead, it should spawn two separate instances or tabs. So that the
> user can jump between two or more tabs without the page reloading, as if the
> user had the page loaded the whole time. … Get it from an opensource library
> if that's easier. Something that supports all that plus what we already
> have."

## ROOT CAUSE (verified in code)

- **APK (the user's device — BIB builds)**: `PanelBrowserSheet.open()` holds
  ONE `webView` field; a tap on another orbiting tab icon lands in
  `openPanel(url, opts)` → `if (w.url != url) w.loadUrl(url)` — the ONE
  instance is reloaded to the new URL. Tab A's live page (scroll, forms, unsent
  text, JS) is destroyed. THIS is the complaint.
- **Desktop/web (master panel)**: already correct — v0.88.1 THE TAB KEEP-ALIVE
  (the iframe deck: sessions per icon id, display-toggle switches, zero
  reloads; `webpanel.js` + the v0881 rig). Untouched by this wave.

## RESEARCH VERDICT (web-searched before building — 4 searches, 3 docs read)

1. **The official Android WebView-memory guide** (developer.android.com):
   *"apps just get one renderer process for all WebViews"* — memory scales
   sub-linearly with instance count; *"Apps are expected to call
   WebView.destroy() when finished with an instance"* — eviction must destroy
   explicitly.
2. **The no-reload switch pattern**: multiple WebView instances in one
   layout, switched via `setVisibility(VISIBLE/GONE)` — the native twin of
   the empirically-verified iframe-deck discipline (display toggles preserve
   the browsing context; re-parenting/destroy destroys it).
3. **Open-source libraries (AgentWeb & kin)**: they ship their OWN browser
   chrome (activities/toolbars) — foreign UI, theme-incompatible with the
   themed sheet, and they would REPLACE everything the sheet already
   implements (the strip, the guard, the duck, the chain gestures, the
   loading pill, the redirect guard, live CSS-var theming). **NOT easier.**
   The pool is ~150 lines inside the existing sheet.
4. `flutter_inappwebview` keepAlive is Flutter-only — the APK is native
   Kotlin + the Go engine. N/A.

**Decision: build the NATIVE TAB POOL directly** (the pattern open-source
Android browsers implement internally), riding everything we already have.

## v0.91.1 — THE NATIVE TAB POOL (PanelBrowserSheet.kt + webtab.js contract)

### Kotlin — PanelBrowserSheet.kt

1. **TabHolder** `{ id: String, web: WebView, lastActive: Long }`; the ledger
   `tabs = LinkedHashMap<String, TabHolder>` (id → holder). The `webView`
   field keeps pointing at the **active** holder's WebView — every existing
   chrome path (refresh, back, guard, chain, editor, theme, ext/close) keeps
   working unchanged.
2. **buildTabWebView()** — the current `WebView(activity).apply { … }` block
   extracted verbatim into a factory (settings, cookies, the chain touch
   listener, the WebViewClient with the redirect guard, the WebChromeClient
   with video fullscreen, the download listener). Callback changes:
   `onPageStarted/onPageFinished` update the OWNING holder's url + the
   pill/loading/back state ONLY when `view === webView` (background tabs load
   silently — a browser never lets a background tab hijack the visible
   chrome); `notifyState()` fires only for the active tab.
3. **resolveTab(id, url)**:
   - existing holder → **visibility swap, NO loadUrl** (the live page is the
     truth — exactly "as if the user had the page loaded the whole time");
     pause the outgoing (`onPause()`), resume the incoming (`onResume()`),
     `pillText`/`backBtn` re-read from the incoming WebView, `hideGuard()`.
   - fresh → `buildTabWebView()` + add into the body UNDER the loading
     overlay + `loadUrl(url)`.
   - no id (plain links / getkey / non-tab opens) → the **EPHEMERAL slot**
     `"_ext"` which keeps today's exact behavior (`loadUrl` when the url
     differs) — and, as an improvement, no longer clobbers a live tab's page.
4. **open()** rewritten around `resolveTab`: exitEdit → theme opts →
   setTabFromOpts (the circle already re-paints per open) → ensureViews →
   applyTheme → resolveTab → the existing dock/show logic verbatim →
   notifyState → evictTabs() + sweepTabs(alive).
5. **Budget** (the iframe deck's philosophy, native numbers):
   `MAX_LIVE_TABS = 5` non-protected, `HARD_CAP_TABS = 9` (protected count
   too), the active tab is never evicted. LRU by `lastActive`; eviction =
   `removeView` + `destroy()` (the official guide's explicit destruction).
   **Protected = the orbit group's web-tab ids** (from `opts.tab.group`).
6. **Pause discipline**: `beginClose()`/activity `onPause()` pause ALL
   holders; `open()`/`onResume()` resume the ACTIVE one. Background tabs are
   "still active just idle/paused" (JS timers + rendering halted; DOM/scroll
   preserved).
7. **notifyState()** payload gains `tabId` (the active holder's id, `""` for
   the ephemeral slot) alongside `{open, ducked, url}`.
8. **sweepTabs(alive)**: holders whose id is not in the alive list (the tab
   was deleted from the canvas) die — except the active one and `"_ext"`.

### JS — webtab.js

9. **openNative()**: the `opts.tab` payload gains:
   - `group`: the web-tab ids in this icon's current orbit (read defensively
     from `icon._orbit.dot.members` — no edits to tabgroups.js, the parallel
     bot's file; failure → `[]`); this is the native protection set, pushed
     fresh on EVERY tap (group form/dissolve before a tap updates the truth
     on the next tap — honest, documented).
   - `alive`: `WebTabs.all().map(id)` — the native sweep's truth.
10. **The entity sync gate**: the `doomalay:panel-state` listener syncs the
    URL only when `e.detail.tabId === sheetTab.id` (absent tabId → legacy
    behavior — old APK + new JS and vice versa stay correct). Kills the
    stale-tab clobber (a plain-link open while a tab browsed used to write
    its URL into the wrong entity).

### NOT doing (the honest scope)

- No tab-strip UI in the sheet — **the canvas IS the tab strip** (the orbit
  group); switching = tapping the other icon. The product's whole philosophy.
- No changes to the desktop master-panel path (already keep-alive; rig-pinned
  by v0881).
- No live push of group membership on dissolve (rides the next openNative —
  documented above).
- No scroll-restore on eviction (an evicted tab reloads at its saved address;
  live tabs never reload, which is the spec).

## v0.91.2 — THE HARDENING (red-team + rigs)

- **The rig `scripts/v0911-group-tabs-test.sh`**:
  (a) the REAL openNative payload contract (a mocked `__doomalayKotlin`
  recorder: tab {id, icon, gradient, group[], alive[]} correct for orbiting
  tabs, empty for strays);
  (b) the REAL sync gate (a synthetic `doomalay:panel-state` with tabId: the
  right entity syncs; a stale tab does NOT);
  (c) the POOL LOGIC MIRROR — resolveTab/evict/protect/sweep ported 1:1 to a
  JS mirror: fresh open = 1 load; switch = 0 loads (visibility swap); switch
  back = 0 loads; eviction respects MAX_LIVE/hard cap; grouped tabs
  protected; deleted tabs swept; active never evicted;
  (d) regressions: v0881 (the web keep-alive), v0882, v0901/2/3 (the orbit
  wave), theme twins, uikit.
- Kotlin compile-review (the v0891 discipline — CI builds the APK; kotlinc is
  not in this sandbox): every edit mirrors existing idioms in the file; the
  diff is read line-by-line against the field map (all `webView` reference
  sites audited: 383, 446, 462-463, 770, 802, 952, 1250, 1255, 1753, 1926,
  the chainRule, handleBack).
- Red-team cases: rapid switches during loads; guard pending on switch;
  eviction mid-load; the omnibox commit → the active tab; the ducked peek
  with a GONE webview; fullscreen video + switch (the cover blocks input);
  `beginClose` with a background tab mid-load; rotation mid-switch.

## v0.91.0 — THE WAVE SHIP

- `buildinfo.Version` → `0.91.0`; commit, tag `v0.91.0-the-group-tabs-wave`,
  release (CI builds the APK + desktop + HF space on the tag).
- Rebase discipline: `git fetch` + diff + merge check before EVERY push (the
  parallel bot is active in v0.89.x+ — zero expected overlap in
  PanelBrowserSheet.kt/webtab.js, but tabgroups.js is theirs — I only READ
  it).
