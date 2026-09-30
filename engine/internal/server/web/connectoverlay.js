// connectoverlay.js — reusable full-screen overlay (crisp background).
//
// Used by the sandbox picker, model picker, and any nested panel that needs
// to overlay the entire screen. Content-agnostic: the caller provides
// HTML, the overlay handles show/hide/scrim-tap. v0.76: the background
// renders UNTOUCHED behind the open overlay (no veil, no backdrop blur).
//
// Has smooth open/close transitions (fade + scale) — not instant.
//
// v0.46 (user spec A1/A3/A4/A6): THE OVERLAY SCREEN is one of the two
// sanctioned modifiable surfaces (the other: the sliding chat panel). New
// rules baked into the shell itself:
//   · STATIC ✕ — top-right, on EVERY instance, rendered once as overlay
//     chrome (survives content swaps; that is the one static render).
//     Tapping it closes the whole overlay.
//   · NAV STACK — pushPage()/popPage() give callers real nesting: the
//     Android back gesture (and Esc) pop ONE level, not everything —
//     "2 overlays deep" backs out to the previous page, all the way out
//     only when already at the root. Each level rides a history entry.
//   · THEME EVERYTHING — scrim, shadow and chrome all derive from theme
//     vars (color-mix on --bg-app / --surface-*) — zero hard-coded colors.
//
// Legacy surface (unchanged contract): open / close / isOpen / getContentEl /
// replaceContent. replaceContent still swaps the CURRENT page in place (no
// new stack level) — model picker & friends behave exactly as before.
//
// Exposes: window.ConnectOverlay

(function () {
  'use strict';

  // Singleton overlay element — created lazily on first open.
  var overlayEl = null;
  var cardEl = null;    // the rounded box (v0.46): hosts the static ✕ + the scroller
  var contentEl = null; // the scroller — getContentEl() contract kept
  var scrimEl = null;
  var xEl = null;       // the static ✕ — one render, all instances
  var onCloseCb = null;
  var closing = false;
  // v0.35 RACE FIX ("panels stopped opening"): close() fades out over
  // 250ms and a replaceContent() swap takes 150ms — if an open() lands
  // inside one of those windows, the still-pending timer would HIDE the
  // freshly-opened overlay (open → instantly invisible, looked dead).
  // Every open/close/replace bumps this generation; stale timers check it
  // and abort instead of fighting a newer action.
  var gen = 0;

  // ── v0.46: the nav stack + history integration ─────────────────────
  var navStack = [];    // [{html, opts}] — level 1 = the opening page
  var histDepth = 0;    // history entries WE pushed (one per stack level)
  var suppress = 0;     // popstates from our own history.go/back drains

  // ── v0.76.6 THE HISTORY FLOOR (the about:blank kill) ─────────────
  // RED-TEAM FINDING (live, this suite): open +model → close → open
  // +sandbox → close — the second close's drainHistory() issued a
  // batch history.go(-n) with n desynced by the FIRST drain's still-
  // pending async transition: the walk went PAST the app's first
  // history entry and the whole SPA landed on about:blank — dead
  // screen, unrecoverable without a reload. Integer counters can never
  // be trusted across async history transitions; the WORLD can:
  //   · every step validates the CURRENT entry is ours
  //     (history.state.__connectOverlay) before issuing back();
  //   · drains walk ONE entry at a time, re-driven by the popstate
  //     handler, which re-syncs histDepth from the landing marker
  //     (marker k ⇒ k+1 backs to the base);
  //   · landing on a non-marker entry (the app root, another screen,
  //     the browser's initial blank) ENDS the walk — the floor. The
  //     worst case is a couple of extra backs through our own dead
  //     entries; never a step below our zone.
  function oursNow() {
    try { return !!(history.state && typeof history.state.__connectOverlay === 'number'); }
    catch (e) { return false; }
  }
  function resyncDepth() {
    histDepth = oursNow() ? (history.state.__connectOverlay + 1) : 0;
  }

  function pushEntry() {
    try {
      history.pushState({ __connectOverlay: histDepth }, '');
      histDepth++;
    } catch (e) { /* non-browser context */ }
  }

  function consumeEntry() {
    if (histDepth > 0 && oursNow()) {
      suppress++;
      histDepth--;
      try { history.back(); } catch (e) { suppress--; histDepth++; }
    } else {
      histDepth = 0;   // not standing on our entry — the floor; nothing to consume
    }
  }

  // one validated step of a drain; the popstate handler re-drives the
  // next until the floor (a non-marker entry) or histDepth 0.
  function stepDrain() {
    if (histDepth <= 0) return;
    if (!oursNow()) { histDepth = 0; return; }   // THE FLOOR
    suppress++;
    histDepth--;
    try { history.back(); } catch (e) { suppress--; histDepth++; }
  }

  function drainHistory() {
    stepDrain();
  }

  // ONE back press (gesture / Esc): pop a level, or close at the root.
  function backOne() {
    if (!isOpen() || closing) return;
    if (navStack.length > 1) {
      popPage();
    } else {
      closeNow();
    }
  }

  window.addEventListener('popstate', function () {
    if (suppress > 0) {
      suppress--;                                     // our own step landed
      resyncDepth();                                  // the world is the truth
    } else {
      if (histDepth > 0) histDepth--;                 // the browser ate one of ours
      if (isOpen()) { backOne(); return; }            // user back gesture
      resyncDepth();
    }
    // finish an in-flight close-drain / clean our orphaned entries
    if (histDepth > 0 && !isOpen()) stepDrain();
  });

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!isOpen() || closing) return;
    e.preventDefault();
    e.stopPropagation();
    if (navStack.length > 1) {
      popPage();
      consumeEntry();
    } else {
      closeNow();
      drainHistory();
    }
  });

  function ensureElements() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'connect-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;z-index:3000;visibility:hidden;' +
      'align-items:center;justify-content:center;padding:20px;';
    scrimEl = document.createElement('div');
    scrimEl.style.cssText =
      'position:absolute;inset:0;' +
      // v0.57 THE BLEED FIX (user spec: "the background and the app should
      // still be visible with the overlay screen rendered on top instead
      // of the current leakage of colors"): the scrim no longer paints the
      // user-customizable OVERLAY background (--bg-app — its color washed
      // the whole screen outside the card = the leak).
      // v0.74: the backdrop BLUR is gone (the user's overlay-effects
      // report: "remove all these effects and just render the canvas
      // over whatever was before") — a full-screen blur was one of the
      // heaviest first-paint costs on WebView (plus its notorious clip
      // bugs).
      // v0.77 THE POST-PROCESS REMOVAL (user spec: "remove the blur and
      // other post process effects we apply to the background or anything
      // that isn't the overlay screen"): the 0.55 dark veil is gone TOO —
      // the background renders UNTOUCHED while the overlay is open (the
      // card carries its own opaque background + border + shadow for
      // separation). The element stays as the tap-to-close surface.
      'opacity:0;transition:opacity 0.25s ease;';
    cardEl = document.createElement('div');
    cardEl.style.cssText =
      'position:relative;z-index:1;width:100%;max-width:480px;max-height:85vh;' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      // v0.49: overlay screens follow the OVERLAY BACKGROUND (--bg-app) —
      // user spec: "surface or overlay background to change the background
      // of the overlay". The [style*] twin rule in index.html layers the
      // --bg-app gradient over it.
      'background:var(--bg-app);border:1px solid var(--surface-2);' +
      'border-radius:16px;box-shadow:0 16px 48px ' +
      'rgba(var(--bg-panel-rgb), 0.5);' +
      'opacity:0;transform:scale(0.95) translateY(10px);' +
      'transition:opacity 0.25s ease, transform 0.25s ease;';
    contentEl = document.createElement('div');
    contentEl.style.cssText =
      'flex:1;min-height:0;overflow-y:auto;' +
      '-webkit-overflow-scrolling:touch;' +
      'touch-action:pan-y;';   // native scrolling — do NOT let the document
                               // touch handlers preventDefault these
    // v0.46 (user spec A4): THE STATIC ✕ — one render for every instance.
    // Overlay chrome, not page content: it survives replaceContent/pushPage
    // swaps. Pages keep their top-right 44px clear (see wsx-head padding).
    // v0.56 (user spec: "make our overlay screens hardcoded X be smaller
    // (x2 smaller) and not have a pill or background box, just a naked
    // X"): 34px pill → a 17px naked glyph — no border, no fill, no ring.
    xEl = document.createElement('button');
    xEl.id = 'connect-overlay-x';
    xEl.type = 'button';
    xEl.setAttribute('aria-label', 'close');
    xEl.title = 'close';
    xEl.textContent = '✕';
    xEl.style.cssText =
      'position:absolute;top:7px;right:9px;z-index:6;width:17px;height:17px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:transparent;border:none;border-radius:0;padding:0;' +
      'color:var(--text-3);font-size:13px;font-family:inherit;' +
      'cursor:pointer;-webkit-tap-highlight-color:transparent;' +
      'touch-action:manipulation;line-height:1;';
    xEl.addEventListener('click', function (e) {
      e.stopPropagation();
      close();
    });
    cardEl.appendChild(contentEl);
    cardEl.appendChild(xEl);
    overlayEl.appendChild(scrimEl);
    overlayEl.appendChild(cardEl);
    document.body.appendChild(overlayEl);
    scrimEl.addEventListener('click', function (e) {
      if (e.target === scrimEl) close();
    });
  }

  // Renders a page: swap innerHTML, fire onSwap (the v0.10.1 contract —
  // callers wire their events through it, right after the DOM lands).
  function renderPage(html, opts) {
    opts = opts || {};
    contentEl.innerHTML = html;
    contentEl.scrollTop = 0;
    onCloseCb = opts.onClose || null;
    if (opts.onSwap) { try { opts.onSwap(); } catch (e) { console.error(e); } }
  }

  function open(html, opts) {
    opts = opts || {};
    ensureElements();
    // v0.81.5 RAISE-ON-OPEN: this overlay and #artifacts-overlay are
    // BOTH z-index:3000 body-level singletons — at equal z the LATER
    // node in the DOM paints on top. Both were appended once at first
    // use and never moved, so whichever overlay happened to be created
    // first stayed UNDER the other for the whole session (the user's
    // report: the cloud file editor + commit screen rendered BELOW the
    // workspaces drawer — connecting a workspace uses this picker
    // first, so #connect-overlay was always the older node and every
    // file view opened beneath the drawer, forcing a back-out to reach
    // it). Re-appending an existing node MOVES it to the end of <body>:
    // the most-recently-opened overlay always wins, order-independent.
    // No z-index changes — the 3400+ chrome (keys sheet, action sheets,
    // toasts, crop/media-zoom) must stay above.
    document.body.appendChild(overlayEl);
    gen++; // invalidate any in-flight close/replace timers
    closing = false;
    navStack = [{ html: html, opts: opts }];
    renderPage(html, opts);
    pushEntry();
    // Show the overlay (visibility:visible + flex)
    overlayEl.style.visibility = 'visible';
    overlayEl.style.display = 'flex';
    // Force reflow so the transition fires (not instant)
    void cardEl.offsetWidth;
    // Animate in
    scrimEl.style.opacity = '1';
    cardEl.style.opacity = '1';
    cardEl.style.transform = 'scale(1) translateY(0)';
    document.body.style.overflow = 'hidden';
  }

  // v0.46: push a NESTED page (a real level — the back gesture pops it).
  function pushPage(html, opts) {
    if (!overlayEl || overlayEl.style.visibility === 'hidden') {
      open(html, opts);
      return;
    }
    opts = opts || {};
    var myGen = ++gen;
    navStack.push({ html: html, opts: opts });
    // Fade out current content
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'scale(0.98) translateY(4px)';
    setTimeout(function () {
      if (myGen !== gen) return; // superseded — a newer action owns the overlay now
      renderPage(html, opts);
      void contentEl.offsetWidth; // reflow
      contentEl.style.opacity = '1';
      contentEl.style.transform = 'scale(1) translateY(0)';
    }, 150);
    pushEntry();
  }

  // v0.46: pop ONE nested page (gesture back / Esc). Returns false at root.
  function popPage() {
    if (navStack.length <= 1) return false;
    var page = navStack[navStack.length - 2];
    navStack.length = navStack.length - 1;
    var myGen = ++gen;
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'scale(0.98) translateY(4px)';
    setTimeout(function () {
      if (myGen !== gen) return;
      renderPage(page.html, page.opts);
      void contentEl.offsetWidth;
      contentEl.style.opacity = '1';
      contentEl.style.transform = 'scale(1) translateY(0)';
    }, 150);
    return true;
  }

  function pageDepth() { return navStack.length; }

  // Visual close NOW (the history side is the caller's business).
  function closeNow() {
    if (!overlayEl || overlayEl.style.visibility === 'hidden' || closing) return;
    closing = true;
    var myGen = ++gen; // invalidate in-flight replace swaps too
    // Stop the overlay from eating taps WHILE it fades out (v0.12 fix):
    // for the 250ms close animation the overlay still sat at z-index 3000
    // intercepting touches — a fast tap right after picking a model landed
    // on the invisible scrim instead of the chat UI underneath.
    overlayEl.style.pointerEvents = 'none';
    // Animate out
    scrimEl.style.opacity = '0';
    cardEl.style.opacity = '0';
    cardEl.style.transform = 'scale(0.95) translateY(10px)';
    setTimeout(function () {
      // v0.35: an open() arrived after this close began — the overlay is
      // showing NEW content; the stale close must NOT hide it.
      if (myGen !== gen) { closing = false; return; }
      overlayEl.style.visibility = 'hidden';
      overlayEl.style.display = 'none';
      overlayEl.style.pointerEvents = '';
      document.body.style.overflow = '';
      closing = false;
      navStack = [];
      var cb = onCloseCb;
      onCloseCb = null;
      if (cb) cb();
    }, 250);
  }

  function close() {
    closeNow();
    drainHistory();
  }

  // Replace content WITHOUT closing/reopening the overlay (smooth transition
  // between nested pickers — e.g. model picker → providers screen). Fades
  // the old content out, swaps, fades new content in.
  //
  // IMPORTANT: the swap happens in a setTimeout (fade-out first). Callers
  // that wire event listeners to the new DOM MUST pass `opts.onSwap` — it
  // fires right after innerHTML is assigned. (v0.10.1 bug: providers.js +
  // localmodels.js wired their buttons synchronously, i.e. against the OLD
  // content — the new save buttons / model rows were never wired.)
  //
  // v0.46: this is now an IN-PLACE swap of the CURRENT page (no new stack
  // level, no history entry) — legacy callers keep their exact behavior.
  // Callers that want real nesting (back gesture pops a level) use pushPage.
  function replaceContent(html, opts) {
    if (!overlayEl || overlayEl.style.visibility === 'hidden') {
      open(html, opts);
      return;
    }
    opts = opts || {};
    var myGen = ++gen; // a newer open/close during the fade cancels this swap
    if (navStack.length > 0) {
      navStack[navStack.length - 1] = { html: html, opts: opts };
    } else {
      navStack = [{ html: html, opts: opts }];
    }
    // Fade out current content
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'scale(0.98) translateY(4px)';
    setTimeout(function () {
      if (myGen !== gen) return; // superseded — a newer action owns the overlay now
      renderPage(html, opts);
      void contentEl.offsetWidth; // reflow
      // Fade in new content
      contentEl.style.opacity = '1';
      contentEl.style.transform = 'scale(1) translateY(0)';
    }, 150);
  }

  function isOpen() {
    return overlayEl && overlayEl.style.visibility !== 'hidden' && !closing;
  }

  // v0.62: the APK back-gesture entry — ONE press pops ONE nested page
  // (the Android path can't ride the popstate handler: MainActivity
  // intercepts the gesture and calls window.doomalay.handleBack(), which
  // used to close the WHOLE overlay — the user landed on the chat instead
  // of the previous overlay page). Mirrors the popstate branch exactly:
  // nested → popPage + consume the history entry; root → close + drain.
  function backOne() {
    if (!isOpen() || closing) return false;
    if (navStack.length > 1) {
      popPage();
      consumeEntry();
    } else {
      closeNow();
      drainHistory();
    }
    return true;
  }

  function getContentEl() { return contentEl; }

  window.ConnectOverlay = {
    open: open,
    close: close,
    isOpen: isOpen,
    getContentEl: getContentEl,
    replaceContent: replaceContent,
    pushPage: pushPage,
    popPage: popPage,
    pageDepth: pageDepth,
    backOne: backOne
  };
})();
