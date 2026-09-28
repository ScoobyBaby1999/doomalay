// browserdock.js — v0.64.2 THE PANEL-STATE CHANNEL · v0.64.0 THE
// NATIVE PANEL BROWSER ROUTER (PLAN-V0640 + PLAN-V0642). Exposes:
// window.InAppBrowser (v3).
//
// USER SPEC: "If we can somehow render the native WebView into a
// scrollable snapable panel, a feature or push that is solely reserved
// for the APK versions and other versions that support it.. let's do so
// it's worth it.. even if only the APK can display the panel browser and
// all other applications render the browser in browser. While the app
// as a whole should work across multiple devices with the same
// functionality, we can make an exception to this specifically. As it is
// so much easier to be redirected in desktops then it is on phones.
// When using phones people don't like being redirected everywhere."
//
// THE VERDICT, EMBODIED: the v0.63.x dock was an IFRAME inside the SPA —
// X-Frame-Options / CSP frame-ancestors (anti-clickjacking headers
// enforced by the browser engine on iframes) made most big sites refuse,
// and no JS can ever lift a third party's frame guards. The full-screen
// browser-in-browser loads EVERY page because it is a NATIVE WebView —
// a TOP-LEVEL context those guards do not govern. So the panel browser
// is now THE SAME NATIVE WEBVIEW, docked as a native bottom sheet over
// the untouched app (PanelBrowserSheet.kt): the pill strip (↻ + the
// link, tap = copy), the dash, ‹ ⧉ ✕, two snap docks (full 100% /
// default 62%), drag/fling/scrim dismiss, its OWN real history, the
// shared cookie profile, video fullscreen. It loads every page the
// browser-in-browser loads — same engine, top-level navigation, ZERO
// iframes, ZERO embeddability detection. The APK-only capability is
// detected, never assumed:
//
// ROUTING (InAppBrowser v3):
//   open(url, {purpose:'getkey'|hostile}) → fallback() SYNC — the
//     v0.62.3 contract is unchanged (key consoles and webview-hostile
//     pages ride the full-screen viewer tiers).
//   open(url) where __doomalayKotlin.openPanel exists (the v0.64 APK)
//     → THE NATIVE PANEL: bridge openPanel(url, {theme snapshot}).
//     Returns 'native-panel'. The SPA never navigates, never renders a
//     frame of the page — the sheet docks over it, resumable (its
//     WebView history survives closes).
//   open(url) EVERYWHERE ELSE (desktop, HF Space, self-host, phone
//     browsers, pre-v0.64 APKs) → fallback() IMMEDIATELY — the
//     popup/tab browser-in-browser. "For desktops, we should not
//     hesitate to redirect users": no iframe dock, no verdict fetch, no
//     embeddability detection — a real window that loads every page.
//   fallback(url) — the E2 tiers verbatim (apk-viewer / popup / tab).
//   external(url) — the ⧉ box+arrow semantics, verbatim.
//   isOpen()/currentURL()/close() — the bridge getters (panelOpen /
//     panelUrl / panelClose): the native sheet owns the browser state.
//     back()/canBack() stay exported for the old contract but are the
//     native sheet's business now — Android back is consumed NATIVELY
//     (MainActivity.onBackPressed) before doomalay.handleBack is ever
//     consulted, and the desktop path never docks.
//
// v0.64.2 THE PANEL-STATE CHANNEL (the SECRET THIRD DOCK'S other
// half): the native sheet calls window.__doomalayPanelState({open,
// ducked}) on every state change (PanelBrowserSheet.notifyState). The
// "filter" over the canvas while the sheet is up is the SPA's OWN
// #chat-scrim dim (the chat panel's backdrop) — so the channel keeps
// the two layers coherent:
//   open    → the scrim suspends its pointer-events: a press on the
//             visible app must reach the CANVAS (it pans it, and the
//             native listener ducks the sheet to the 30% peek) — the
//             scrim's own tap-to-close would eat the press and close
//             the chat instead.
//   ducked  → the canvas is IN FOCUS: the scrim's dim lifts (its
//             0.25s CSS opacity transition rides the sheet's glide).
//   closed  → both restored — the dim + the scrim's tap-to-close
//             behave exactly as before the sheet ever existed.
//
// RETIRED WITH THE IFRAME DOCK (v0.63.4–63.6): the panel view, the
// frame sandbox + bust-guard, the /api/preview verdict on the open
// path, the auto-route, the strip DOM + .pb-* CSS, panel.js's
// _setStripMode. Git history keeps them; nothing references them.
(function () {
  'use strict';

  // ── the theme snapshot (rides every openPanel call — nothing on the
  //    Kotlin side is ever hardcoded) ───────────────────────────────
  function themeSnapshot() {
    var cs = getComputedStyle(document.documentElement);
    var pick = function (v) { var s = cs.getPropertyValue(v).trim(); return s || ''; };
    return {
      accent: pick('--accent'),
      bgPanel: pick('--bg-panel') || pick('--bg-app'),
      surface: pick('--surface-2'),
      text1: pick('--text-1'),
      text3: pick('--text-3'),
      border: pick('--border')
    };
  }

  // ── v0.64.2: THE PANEL-STATE CHANNEL ───────────────────────────
  // The native sheet's {open, ducked} broadcasts land here (see the
  // header). Inline styles ride on top of #chat-scrim's .open class
  // rules (inline > class), so the class system is never touched —
  // clearing the inline styles restores the world exactly. Desktop /
  // HF / self-host never register a native sheet, so this is never
  // called there — zero impact off the APK.
  function panelState(s) {
    var scrim = document.getElementById('chat-scrim');
    if (scrim) {
      if (s && s.open) {
        // the sheet owns the layer: the scrim may keep its dim but
        // never eats a tap (a canvas press ducks the sheet + pans)
        scrim.style.pointerEvents = 'none';
        // ducked = the canvas holds the focus: lift the dim
        scrim.style.opacity = s.ducked ? '0' : '';
      } else {
        scrim.style.pointerEvents = '';
        scrim.style.opacity = '';
      }
    }
    try {
      document.dispatchEvent(new CustomEvent('doomalay:panel-state',
        { detail: (s && typeof s === 'object') ? s : {} }));
    } catch (e) {}
  }
  window.__doomalayPanelState = panelState;

  // ══ THE FALLBACK TIERS (v0.62.3 verbatim — the full-screen
  //    browser-in-browser + the desktop window) ═════════════════════
  function fallbackTier(url, opts) {
    opts = opts || {};
    var bridge = window.__doomalayKotlin;
    if (bridge && typeof bridge.openInApp === 'function') {
      try {
        bridge.openInApp(url, JSON.stringify({
          theme: themeSnapshot(),
          hostile: !!opts.hostile,
          purpose: opts.purpose || 'link'
        }));
        return { tier: 'apk-viewer', ok: true };
      } catch (e) { /* bridge hiccup — fall through */ }
    }
    var w = null;
    try { w = window.open(url, '_blank', 'width=760,height=900,noopener'); } catch (e1) {}
    if (!w) {
      try { w = window.open(url, '_blank'); } catch (e2) {}
    }
    return w ? { tier: 'popup', ok: true } : { tier: 'tab', ok: false };
  }
  function fallback(url, opts) { return fallbackTier(url, opts).tier; }

  // the box+arrow: leave the app entirely — the site's NATIVE app
  // claims its domain (ACTION_VIEW), Chrome Custom Tab as the fallback,
  // the system browser as the last resort. Desktop: a plain new tab.
  function external(url) {
    var bridge = window.__doomalayKotlin;
    if (bridge && typeof bridge.openExternal === 'function') {
      try { bridge.openExternal(url); return 'apk-external'; } catch (e) {}
    }
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    return 'tab';
  }

  // ══ THE ROUTER ════════════════════════════════════════════════════
  function open(url, opts) {
    opts = opts || {};
    // the E2 flows keep their synchronous tiers: key consoles are
    // frame-blocked by design, hostile pages can't ride a WebView at all.
    if (opts.purpose === 'getkey' || opts.hostile) return fallback(url, opts);
    if (!/^https?:\/\//i.test(url)) return fallback(url, opts);

    // THE NATIVE PANEL — every shell that carries openPanel (the v0.64
    // APK). The sheet is a real top-level native WebView: it loads
    // every page the browser-in-browser loads, docks over the
    // untouched SPA, and owns its own history.
    var bridge = window.__doomalayKotlin;
    if (bridge && typeof bridge.openPanel === 'function') {
      try {
        bridge.openPanel(url, JSON.stringify({ theme: themeSnapshot() }));
        return 'native-panel';
      } catch (e) { /* bridge hiccup — the redirect below catches it */ }
    }

    // Everything else: straight to the browser-in-browser (a popup on
    // desktop, the full-screen viewer on old APKs) — no hesitation.
    return fallback(url, opts);
  }

  // the native state getters — the sheet owns the browser state; the
  // bridge reads are wrapped so a dead native layer can never throw.
  function bridgeCall(method, dflt) {
    var bridge = window.__doomalayKotlin;
    if (bridge && typeof bridge[method] === 'function') {
      try { return bridge[method](); } catch (e) { /* fall through */ }
    }
    return dflt;
  }

  // ── the public surface (v3) ───────────────────────────────────────
  window.InAppBrowser = {
    open: open,
    fallback: fallback,
    external: external,
    back: function () { return false; },   // native: MainActivity.onBackPressed
    canBack: function () { return false; },
    close: function () { bridgeCall('panelClose', null); return true; },
    isOpen: function () { return !!bridgeCall('panelOpen', false); },
    currentURL: function () { return bridgeCall('panelUrl', null); }
  };
})();
