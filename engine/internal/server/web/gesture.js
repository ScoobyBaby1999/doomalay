// gesture.js — v0.65.1 THE PARITY WAVE (the secret third dock for the
//                    REGULAR panel) on v0.42 THE ALWAYS-TALL SHEET.
//
// USER SPEC (v0.42, three complaints, one root cause): the sheet used to be
// a RIGID card whose HEIGHT swapped per state, so:
//   1. "during smooth snap animations the background shows" — dragging up
//      from default translated the 62dvh card upward, its bottom edge
//      left the screen bottom and the canvas peeked through the gap.
//   2. "snapping down, a black box / background bounces up from the
//      bottom" — the shrink settle's no-teleport compensation
//      (comp = nowPx − prevPx + drag) goes NEGATIVE on shrink: the sheet
//      sat translated up with a bottom gap for the ENTIRE settle spring.
//   3. "jittery / low fps / small vibrations during slides" — the height
//      swap forced a full relayout exactly as the spring started,
//      Math.round() quantized the transform every frame, and the CSS
//      transform transition fought the rAF spring in some paths.
//
// THE v0.42 MODEL (canonical always-tall bottom sheet):
//   · #chat-panel is PERMANENTLY 100dvh tall. NOTHING ever writes its
//     height again — the sheet surface reaches from its top edge PAST the
//     physical screen bottom at every offset ("infinitely stretched
//     downwards"): the bottom edge sits at H + Y ≥ H, so it is glued to
//     the screen bottom and a background gap is geometrically impossible.
//   · Position is driven ONLY by transform: translate3d(0, Ypx, 0) with
//     Y ∈ [0, innerHeight]: 0 = full, (1−0.62)·H = default, H = closed.
//     Sub-pixel values — no rounding (rounding was the micro-stutter).
//   · .panel-body (THE scroller every view renders into) is sized by the
//     --panel-vis-h custom property this file writes in the SAME frame as
//     the transform: vis = innerHeight − Y − chrome. The content window's
//     bottom rides the screen bottom at every Y — an upward drag visibly
//     STRETCHES the sheet, sticky composers and every view's scrollport
//     stay inside the visible window, and the chat's own #chat-root
//     height:100% keeps working unchanged.
//   · THE SETTLE: one continuous motion — Y springs to the target with
//     the same critically-damped spring (release-velocity seeded) while
//     the window var follows in the same frame. No height writes, no
//     getBoundingClientRect in the loop.
//   · OPEN / CLOSE look EXACTLY like v0.41: the open rise is the same
//     0.25s cubic-bezier(0.32,0.72,0,1) (set inline, removed after); the
//     gesture close is the same fling spring; the class-driven closes
//     (scrim tap → panel.close()) slide the sheet down the same 0.25s —
//     a class observer picks those up now that the CSS transform rules
//     are gone.
//
// PRESERVED VERBATIM (battle-tested through v0.19–v0.41):
//   · the scroll chain (inner scroller → chat body → sheet after 24px
//     slop at the top), slider ownership, the anchor soft-tap zones,
//     per-chat position memory (openAt), panel-state events, justDragged,
//     every intent threshold (FLING_VY, DOCK_VY, the drag fractions and
//     the velocity projection) — the "when to close" feel is untouched.

(function () {
  'use strict';

  var panelEl = null;   // #chat-panel
  var states = { default: 0.62, full: 1.0 };
  var currentState = 'default';
  var onStateChange = null;

  // velocity / intent tuning (v0.19 values kept — they encode hard-won
  // "casual scrolls must not close the chat" lessons)
  var FLING_VY = 0.55;         // px/ms — a genuinely hard swipe
  var DOCK_VY = 0.18;          // px/ms — gentle downward motion docks (from full)
  var BODY_SLOP = 24;          // px of pull-down before the sheet grabs
  var UP_DRAG_FRAC = 0.22;     // dragged up > 22% of height → full intent
  var FULL_DOCK_FRAC = 0.10;   // from full: > 10% down drag docks at default
  var FULL_CLOSE_FRAC = 0.55;  // from full: > 55% slow drag closes
  var CLOSE_FRAC = 0.32;       // from default: > 32% deliberate drag closes
  var PROJECTION_MS = 140;     // v0.38: release velocity horizon

  // ── v0.65.1: THE SECRET THIRD DOCK (BIB parity — PLAN-V0643/44) ──
  // The same contract the native panel browser (PanelBrowserSheet.kt)
  // shipped in v0.64.2, constant for constant: a press on the app
  // behind the half-docked panel glides it to a 30% peek and hands the
  // canvas focus back; the peek holds ~3s, retriggered by every touch
  // on the app behind it (and by interaction with the peek itself);
  // expiry glides home. The full dock never ducks. currentState is
  // NEVER touched — the per-chat position memory (full/default) is
  // unaffected, and decide() stays verbatim for non-ducked gestures.
  var DUCK_FRAC = 0.30;        // the peek fills ~30% of the screen
  var DUCK_HOLD_MS = 3000;     // the retriggerable temporary hold
  var DUCK_TAP_SLOP = 10;      // px — a still press on the peek (not a scroll)
  // v0.72: THE EASY SLIDE-DOWN (user spec: "we have to make it easier
  // for them to be slide down and go out of render… if the user slides
  // down when the panel is 30% dock the panel should go away"). While
  // DUCKED, the body chain grabs after 12px (not 24) and IGNORES the
  // inner-scroller gate — a downward slide on the peek is DISMISS
  // intent, not content scrolling (the peek is a 3-second glance, the
  // canvas owns the focus). And a downward VELOCITY counts even when
  // the travel is short (a flick, not a drag).
  var DUCK_BODY_SLOP = 10;     // px of pull-down before a DUCKED body grabs
                               // (== DUCK_TAP_SLOP, so the press rule and the
                               // grab rule partition every touch exactly:
                               // <10 still press → restore, >10 drag → close)
  var DUCK_FLING_VY = 0.2;     // px/ms — a downward flick closes the peek (the EMA
                               // needs ~3 samples to converge, so a real flick's
                               // 1.5-3 px/ms crosses by the 2nd-3rd move; a slow
                               // deliberate nudge sits under 0.1 and never trips —
                               // 0.2 keeps a 2x margin between them while riding
                               // out real-event timer jitter)

  // ── v0.42 THE ALWAYS-TALL GEOMETRY ──────────────────────────────
  // H is the drag-math source of truth (innerHeight — dynamic toolbars),
  // matching the sheet's 100dvh box. curY is THE position: everything on
  // screen is a function of it.
  var H = 0;            // cached window.innerHeight (resize re-derives)
  var curY = 0;         // current sheet offset in px (0 full … H closed)
  var chromeH = 0;      // handle + header + sheet border/paddings (incl. the
                        // safe-area padding — counted so the visible window
                        // ends ABOVE the home indicator, like the old sheet
                        // padding did, while the box itself hangs off-screen)

  function panelH() { return H; }
  function vhFrac() {
    // the effective fraction the current offset represents
    return H > 0 ? 1 - curY / H : states[currentState];
  }
  function yForState(name) { return (1 - states[name]) * H; }
  function visForY(y) {
    var v = H - y - chromeH;
    return v > 0 ? v : 0;      // closed clamps to a zero-height window
  }

  // THE two writes. writeY positions the (infinitely tall) sheet;
  // renderY does both in the SAME frame so the content window bottom
  // lands on the screen bottom the instant the sheet moves.
  function writeY(y) {
    curY = y;
    // v0.78.3: the gesture flag — the projection observer reads this to
    // classify the per-frame inline-style CASCADE (--panel-vis-h stretches
    // #chat-input's autogrow + #chat-jump's bottom + siblings) as drag
    // noise → motion, not full paints. That cascade was the REAL drag
    // jank (a full projection paint per drag frame, invisible to the
    // v0.76.5 test which only counted the panel's own writes).
    window.__doomalayGestureAt = performance.now();
    panelEl.style.transform = 'translate3d(0,' + y + 'px,0)';
    // v0.72: every position write re-anchors the projection windows —
    // the painter (theme.js PROJ) converts fixed-attachment gradients
    // into explicit viewport-fitted offsets inside this transformed
    // root, but it only repaints when POKED. The old pokes came from
    // the CANVAS physics tick alone — with the canvas idle (the common
    // case) a panel glide (spring/rise/drag/settle — all rAF writes,
    // no CSS transitions, no mutations) left every pill inside showing
    // the region it occupied BEFORE the move, forever, until some
    // unrelated scroll or mutation happened (the "tiling issues" —
    // windows sampling regions that don't match where they sit).
    // v0.74: the poke became the CHEAP motion() path — the panel is a
    // translation-only root, so the painter just updates its
    // --proj-tx/--proj-ty vars (one CSSOM write) and every window
    // re-anchors in the browser's own style pass. The old full paint
    // per frame (a getComputedStyle + getBoundingClientRect PER WINDOW
    // per frame) was the panel-glide jank itself.
    // v1.01.5: the projection motion() call is RETIRED with the painter
    // — local gradient windows ride the compositor (transform-only
    // moves re-anchor for free in the browser's own style pass; there is
    // nothing to compensate anymore).
  }
  // v1.05.1 THE GLASS WINDOW — the visible window's size lands as an
  // ELEMENT-SCOPED style write on .panel-body (style recalc for ONE
  // element; layout dirties only the scroller box + its sticky/bottom-
  // anchored children). The OLD write — the unregistered + inherited
  // --panel-vis-h custom property on the panel ROOT — marked the whole
  // #chat-panel subtree (handle + header + the full transcript DOM) for
  // style recalc EVERY motion frame before the same layout ran (the
  // measured slide lag: the drag loop + both springs all pay it; the
  // web.dev/@property invalidation model — unregistered inherited var
  // changes sweep the receiving subtree — and the pure-web-bottom-sheet
  // write-up's "never animate height on a large DOM per frame" both name
  // exactly this). The VAR still rides — but ONLY when the doom
  // projection is enabled: its L2 window transforms + the bottom-anchored
  // window formulas consume it LIVE per frame (the projection's own
  // opt-in tax, unchanged). Projection OFF (the default): zero var
  // writes, zero subtree sweeps — the glide rides the compositor.
  var visBodyEl = null;
  function visBody() {
    if (visBodyEl && visBodyEl.isConnected) return visBodyEl;
    visBodyEl = panelEl ? panelEl.querySelector('.panel-body') : null;
    return visBodyEl;
  }
  function writeVis(y) {
    var b = visBody();
    if (!b) return;
    var v = visForY(y) + 'px';
    if (b.style.height !== v) b.style.height = v;   // element-scoped — no inherited sweep
    if (window.DoomProjection && window.DoomProjection.enabled &&
        window.DoomProjection.enabled()) {
      panelEl.style.setProperty('--panel-vis-h', v);   // the projection's live window var
    }
    queueFieldSync();
  }

  // ── v1.08.4 THE SEAMLESS FIELD — the surface field's rest sync ────
  // (PLAN-V109 §3; the user: "the panels header doesn't sync with the
  // rest of the gradient sometimes, but repeats it"). The sheet root,
  // the header and the body render ONE shared gradient at the scale
  // --panel-field-h, the header/body windows offset by --panel-head-off
  // / --panel-field-top (index.html Layer-1). The vars are GEOMETRY
  // facts measured at REST — the sheet's padding-top + the handle +
  // the header + the rest window height. They ride a CSSOM rule (the
  // painter's own var-sheet trick): CSSOM mutations bypass the
  // MutationObserver, so the sync never wakes the projection painter
  // and never dirties the tracked root's inline style. The sync is
  // DEBOUNCED behind writeVis — during motion the writes stream every
  // frame and the timer never fires; when the writes stop (rest), the
  // vars land once. The field is the panel's MATERIAL: its size freezes
  // during the stretch and the growing window REVEALS more of it.
  var fieldTimer = 0, fieldSheetEl = null, fieldRule = null;
  function fieldVarsRule() {
    if (fieldRule && fieldSheetEl && fieldSheetEl.isConnected) return fieldRule;
    try {
      fieldSheetEl = document.createElement('style');
      fieldSheetEl.id = 'panel-field-vars';
      document.head.appendChild(fieldSheetEl);
      fieldSheetEl.sheet.insertRule('#chat-panel {}', 0);
      fieldRule = fieldSheetEl.sheet.cssRules[0];
    } catch (e) { fieldRule = null; }
    return fieldRule;
  }
  function syncFieldVars() {
    if (!panelEl) return;
    var r = fieldVarsRule();
    if (!r) return;
    try {
      var cs = window.getComputedStyle(panelEl);
      var padTop = parseFloat(cs.paddingTop) || 0;
      var handle = panelEl.querySelector('.handle');
      var header = panelEl.querySelector('.panel-header');
      var headOff = padTop + (handle ? handle.offsetHeight : 0);
      var headerH = header ? header.offsetHeight : 0;
      var fieldTop = headOff + headerH;
      var b = visBody();
      var bodyH = b ? (parseFloat(b.style.height) || b.offsetHeight || 0) : 0;
      if (!bodyH) return;   // the closed sheet — keep the last rest geometry
      r.style.setProperty('--panel-head-off', headOff.toFixed(1) + 'px');
      r.style.setProperty('--panel-field-top', fieldTop.toFixed(1) + 'px');
      // v1.09.2 THE FULLSCREEN FIELD — the user: the surface "does not fill
      // the panel as if it where fully docked in the full scree position,
      // instead, it tries recalculates to fit whatever position the panel
      // is docked at ... causin the ink color below it to leak .. we can
      // just project as a full screen panel if it makes it easier".
      // The field's scale becomes the FULL-DOCK extent — fieldTop plus the
      // window height at y=0 (visForY(0) = H - chromeH) — a per-open
      // geometry CONSTANT: docking anywhere REVEALS a sub-window of the
      // one fullscreen field instead of re-fitting it per dock (the
      // gradient stops never move), and the no-repeat image extent is ≥
      // every possible window, so the band below it (the ink leak) is
      // geometrically impossible — stale sync or not. The performant
      // shape the user asked for: per-dock re-syncs die (the vars only
      // move when the chrome/viewport facts do) and the field never
      // re-rasters per dock.
      var chromeFull = chromeH || ((parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderTopWidth) || 0) + headOff + headerH);
      var fieldH = fieldTop + Math.max(0, H - chromeFull);
      r.style.setProperty('--panel-field-h', fieldH.toFixed(1) + 'px');
    } catch (e) {}
  }
  function queueFieldSync() {
    if (fieldTimer) clearTimeout(fieldTimer);
    fieldTimer = setTimeout(function () { fieldTimer = 0; syncFieldVars(); }, 190);
  }
  function renderY(y) { writeY(y); writeVis(y); }

  // chrome = everything above .panel-body inside the sheet + the sheet's
  // own bottom padding (safe area). Measured OUTSIDE the animation loops
  // (attach, state changes, resize) — .panel-full tightens padding-top
  // 8→4px, which shifts the window by exactly that much.
  function measureChrome() {
    if (!panelEl) return;
    var cs = window.getComputedStyle(panelEl);
    var c = (parseFloat(cs.paddingTop) || 0) +
            (parseFloat(cs.borderTopWidth) || 0) +
            (parseFloat(cs.paddingBottom) || 0);
    var handle = panelEl.querySelector('.handle');
    var header = panelEl.querySelector('.panel-header');
    if (handle) c += handle.offsetHeight;
    if (header) c += header.offsetHeight;
    chromeH = c;
  }

  // one-off (NOT per-frame): where the sheet visually sits right now —
  // used only when interrupting the 0.25s open/close transition, so a
  // finger grabbing the sheet mid-flight takes over from the exact
  // on-screen position instead of the logical landing spot.
  function readComputedY(fallback) {
    try {
      var m = window.getComputedStyle(panelEl).transform;
      if (!m || m === 'none' || m.slice(0, 6) !== 'matrix') return fallback;
      var open = m.indexOf('(');
      if (open < 0) return fallback;
      var parts = m.slice(open + 1, m.length - 1).split(',');
      // matrix(a,b,c,d,tx,ty) → ty = parts[5]; matrix3d(…,tx,ty,tz,1) → parts[13]
      var y = parseFloat(parts.length === 16 ? parts[13] : parts[5]);
      return isNaN(y) ? fallback : y;
    } catch (e) { return fallback; }
  }

  // v0.29: elements that OWN their touch gestures — the sheet must never
  // hijack a drag meant for them.
  // v0.77: checkboxes + switches join the list — the animate-toggle-off
  // bug (reproduced on the rig): a finger drifting >24px down on a 42×24
  // switch ran the sheet hijack's preventDefault, which killed the
  // synthetic click — the toggle could never be turned off with a sloppy
  // tap. A tap on a toggle is always the toggle's, never the sheet's.
  // v1.04.1 F1 (user report: "when the user is touch dragging the color
  // wheel… the panel should not register these touches — I prefer if
  // the panel where to not even listen to that channel, and only listen
  // to touches of certain channels"): the Theme Editor's interactive
  // surfaces join the list — the wheel drag (pointer capture +
  // touch-action:none) was being eaten by the body hijack's
  // preventDefault (a >24px drift cancelled the wheel's pointer stream
  // and started the sheet glide). The touchstart handler below now
  // doesn't even RECORD a bodyStart for these channels.
  function ownsGesture(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('input[type="range"], input[type="checkbox"], .app-switch, textarea, .no-sheet-drag, .te-wheel, [data-te-wheel], [data-own-touch]');
  }

  function attach(panel, opts) {
    panelEl = panel;
    onStateChange = (opts && opts.onStateChange) || null;
    var onDuckChange = (opts && opts.onDuckChange) || null;
    H = window.innerHeight;
    measureChrome();

    var track = {
      active: false, y0: 0, t0: 0, lastY: 0, lastT: 0, vy: 0,
      fromAnchor: false, hijacked: false, baseFrac: 0, baseY: 0,
      fromDuck: false, bodyStart: null
    };

    // ── v0.65.1: THE DUCK ENGINE ──────────────────────────────────
    var ducked = false;
    var duckTimer = 0;
    function yForDuck() { return (1 - DUCK_FRAC) * H; }
    function fireDuck() {
      try { window.__doomalayPanelDuck = ducked; } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('doomalay:panel-duck',
        { detail: { ducked: ducked } })); } catch (e) {}
      if (onDuckChange) { try { onDuckChange(ducked); } catch (e) {} }
    }
    function resetDuckTimer() {
      if (duckTimer) clearTimeout(duckTimer);
      duckTimer = setTimeout(function () { duckTimer = 0; unduck(); }, DUCK_HOLD_MS);
    }
    function duckForCanvas() {
      if (curY >= H - 1) return;           // not on screen — nothing to duck
      if (currentState === 'full') return; // the full dock never ducks
      // v0.77 THE CLOSING GUARD (the stuck-30% bug, reproduced on the rig):
      // a canvas touch arriving DURING the close-dismiss (~150ms window)
      // used to run springY() → stopAll() → stopDismiss() — the closing
      // spring died mid-flight with `.closing` + pointer-events:none
      // already armed and nothing left to clear them: the panel re-docked
      // at 30% completely interaction-dead (hit-tests skipped it — every
      // touch fell through to the canvas), "doesn't go down or render
      // taps", and only a full close→open cycle (the Android back)
      // recovered. A CLOSING panel is never duckable — the touch still
      // pans the canvas (the document handler is untouched) and the
      // dismiss completes on its own.
      if (panelEl.classList.contains('closing')) return;
      if (ducked) { resetDuckTimer(); return; }
      ducked = true;
      springY(curY, yForDuck(), 0);        // the glide (the settle spring)
      resetDuckTimer();
      fireDuck();
    }
    // the hold expired — home to the half dock, dim restored.
    // v0.72: THE EXPIRY GUARD — a finger still on the sheet (an anchor
    // drag running, or a body press being held) IS interaction: the
    // hold RETRIGGERS instead of firing. The old behavior rose the
    // panel mid-press, and the drag that followed started from the
    // half dock — not ducked — so the slide-down went back to the hard
    // decide() ladder (the "hard to slide away" report's other half).
    function unduck() {
      if (duckTimer) { clearTimeout(duckTimer); duckTimer = 0; }
      if (!ducked) return;
      if (track.active || track.bodyStart) { resetDuckTimer(); return; }
      ducked = false;
      if (curY < H - 1) springY(curY, yForState(currentState), 0);
      fireDuck();
    }
    // a real grab / a re-open / a close: the duck dies. With restore,
    // the sheet glides home to its ORIGINAL dock first.
    function cancelDuck(restore) {
      if (duckTimer) { clearTimeout(duckTimer); duckTimer = 0; }
      if (!ducked) return;
      ducked = false;
      if (restore && curY < H - 1) springY(curY, yForState(currentState), 0);
      fireDuck();
    }

    // ── MOTION OWNERSHIP ───────────────────────────────────────────
    // Exactly ONE writer drives the sheet at a time: the drag loop, the
    // settle spring, the dismiss spring, or the 0.25s transition. Every
    // handoff goes through the matching stop*() so a stale rAF can never
    // fight the new one (the old dismiss loop was uncancellable — two
    // writers fought if you grabbed the sheet mid-close).
    var springRaf = 0;    // the settle spring
    var dismissRaf = 0;   // the gesture-close spring
    var dragRaf = 0;      // the finger-tracking loop
    var dragTargetY = 0, dragNowY = 0;
    var rising = false;   // the 0.25s open/close CSS transition is armed
    var riseTimer = 0, riseEnd = null;

    function stopSpring() { if (springRaf) { cancelAnimationFrame(springRaf); springRaf = 0; } }
    function stopDismiss() { if (dismissRaf) { cancelAnimationFrame(dismissRaf); dismissRaf = 0; } }
    function stopDragLoop() { if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; } }
    function stopAll() { stopSpring(); stopDismiss(); stopDragLoop(); stopRise(); }
    function stopRise() {
      if (riseTimer) { clearTimeout(riseTimer); riseTimer = 0; }
      if (riseEnd) { panelEl.removeEventListener('transitionend', riseEnd); riseEnd = null; }
      if (!rising) return;
      rising = false;
      // freeze the sheet exactly where the transition has got it
      panelEl.style.transition = 'none';
      writeY(readComputedY(curY));
      panelEl.style.transition = '';
    }

    // ── THE 0.25s TRANSITION (open rise + class-driven close slide) ──
    // The exact curve the stylesheet used from v0.17 to v0.41 — set
    // inline now that no CSS transform/transition rules exist.
    var RISE_MS = 170;   // v0.45 ITEM 1: faster close slide (250→170ms)
    function riseTo(targetY, freezeVis, after) {
      stopAll();
      var fromY = curY;                       // stopAll froze a mid-flight sheet at its visual spot
      panelEl.style.transition = 'none';
      writeY(fromY);
      if (!freezeVis) writeVis(targetY);      // open: window sized for the LANDING state
      void panelEl.offsetWidth;               // flush — commit the start before arming the curve
      panelEl.style.transition = 'transform ' + RISE_MS + 'ms cubic-bezier(0.32,0.72,0,1)';
      writeY(targetY);
      rising = true;
      function finish() {
        if (!rising) return;
        rising = false;
        if (riseTimer) { clearTimeout(riseTimer); riseTimer = 0; }
        if (riseEnd) { panelEl.removeEventListener('transitionend', riseEnd); riseEnd = null; }
        panelEl.style.transition = '';
        writeY(targetY);                      // exact landing — no sub-pixel residue
        if (!freezeVis) writeVis(targetY);
        if (after) after();
      }
      riseEnd = function (e) {
        if (e && e.target !== panelEl) return;           // bubbled from children
        if (e && e.propertyName && e.propertyName !== 'transform') return;
        finish();
      };
      panelEl.addEventListener('transitionend', riseEnd);
      riseTimer = setTimeout(finish, RISE_MS + 90);      // fallback (hidden tab swallows events)
    }

    // ── THE SETTLE SPRING (critically damped — no overshoot, no lag) ──
    // v0.42: it animates Y → targetY (the always-tall offset), writing the
    // transform AND the window var in the same frame. Stiffness kept from
    // v0.38 (~260ms settle from typical drag deltas); release velocity is
    // seeded at a quarter strength for the momentum feel.
    function springY(fromY, targetY, v0) {
      stopAll();
      panelEl.style.transition = 'none';
      var x = fromY - targetY;
      var v = v0;
      if (v > 2400) v = 2400; if (v < -2400) v = -2400;
      var lastT = performance.now();
      var stiffness = 170, damping = 2 * Math.sqrt(stiffness) * 1.02;
      renderY(fromY);                          // re-paint the window for the (possibly new) chrome
      function step(now) {
        var dt = Math.min(0.05, (now - lastT) / 1000);
        lastT = now;
        var a = -stiffness * x - damping * v;
        v += a * dt;
        x += v * dt;
        if (Math.abs(x) < 1.5 && Math.abs(v) < 40) { // snap the last sub-2px (imperceptible)
          springRaf = 0;
          renderY(targetY);                    // exact rest — both writes, one frame
          return;
        }
        renderY(targetY + x);
        springRaf = requestAnimationFrame(step);
      }
      springRaf = requestAnimationFrame(step);
    }

    // ── STATE APPLICATION (the old setHeight, minus the height) ─────
    // Same contract: toggles .panel-full, fires onStateChange and the
    // 'doomalay:panel-state' window event at exactly the old trigger
    // points (attach / openAt / settle / setHeight / reset).
    function applyState(next) {
      currentState = next;
      panelEl.classList.toggle('panel-full', next === 'full');
      measureChrome();   // .panel-full tightens padding-top (8→4px)
      if (onStateChange) { try { onStateChange(next); } catch (e) {} }
      window.dispatchEvent(new CustomEvent('doomalay:panel-state', { detail: { state: next } }));
    }

    function setHeight(next, animate) {
      applyState(next);
      var targetY = yForState(next);
      if (animate === false) {
        stopAll();
        panelEl.style.transition = 'none';
        renderY(targetY);                      // instant, both writes
      } else {
        springY(curY, targetY, 0);             // glide to the state's offset
      }
    }

    // Where does this gesture END? (no side effects — end() acts on it)
    // v0.38: VELOCITY PROJECTION leads; the intent thresholds confirm.
    function decide(vy, dy) {
      var h = panelH();
      var downward = dy > 0;
      var upward = dy < 0;
      var projected = dy + vy * PROJECTION_MS; // where the finger WANTS to land
      var fromFrac = track.baseFrac;           // the resting fraction the gesture STARTED from
      var toFrac = fromFrac - projected / h;

      // The three landings on the fraction line: 0 (closed) / .62 (default) / 1 (full).
      // Upward intent → full.
      if (upward && (vy < -FLING_VY || Math.abs(dy) > h * UP_DRAG_FRAC || toFrac >= 0.82)) return 'full';
      if (currentState === 'full') {
        if (downward && vy > FLING_VY) return 'CLOSE';
        if (downward && dy > h * FULL_CLOSE_FRAC) return 'CLOSE';
        if (downward && (toFrac <= 0.30 || dy > h * FULL_DOCK_FRAC || vy > DOCK_VY)) return 'default';
        return 'full';
      }
      // From default: down is the DISMISS direction.
      if (downward && vy > FLING_VY) return 'CLOSE';
      if (downward && dy > h * CLOSE_FRAC) return 'CLOSE';
      if (upward && toFrac >= 0.82) return 'full';
      return 'default';
    }

    function begin(y, fromAnchor, e) {
      track.active = true;
      stopAll();          // kills any spring/dismiss/transition — the finger is boss now
      track.y0 = track.lastY = y;
      track.t0 = track.lastT = performance.now();
      track.vy = 0;
      track.fromAnchor = !!fromAnchor;
      track.hijacked = false;
      track.baseY = curY;                       // where the sheet sits (mid-flight included)
      track.baseFrac = H > 0 ? 1 - curY / H : states[currentState];
      // v0.65.1: a grab at the duck remembers it — end() then applies
      // THE DOCKED RULES (the hold dies either way: the finger is boss)
      track.fromDuck = ducked;
      if (duckTimer) { clearTimeout(duckTimer); duckTimer = 0; }
      // no transition while the finger drives the sheet — every write
      // lands THIS frame (1:1 tracking, zero lag).
      panelEl.style.transition = 'none';
      if (e && e.cancelable && track.fromAnchor) e.preventDefault();
    }

    // 1:1 finger tracking with a whisper of jitter smoothing (0.8/frame).
    // v0.42: the sheet's TOP EDGE follows the finger — the offset target
    // is baseY + dy, clamped/rubber-banded. Sub-pixel throughout: the
    // old Math.round quantized the transform and read as micro-vibration.
    function dragRender() {
      dragRaf = 0;
      dragNowY += (dragTargetY - dragNowY) * 0.8;
      if (Math.abs(dragTargetY - dragNowY) < 0.4) dragNowY = dragTargetY;
      renderY(dragNowY);                        // stretch write: transform + window, same frame
      if (dragNowY !== dragTargetY) dragRaf = requestAnimationFrame(dragRender);
    }

    function move(y) {
      if (!track.active) return;
      var now = performance.now();
      var dy = y - track.y0;
      // v0.42 note: the sub-frame dt floor guards the scroll-chain hijack,
      // whose rebase (y0 = y − 6) calls begin()+move() in the SAME event —
      // that first "move" is 6px of REBASE, not finger motion, and when it
      // crosses a performance.now() millisecond boundary the raw dt=1ms
      // sample read as a 6 px/ms fling and randomly dismissed the sheet on
      // gentle pulls (latent since v0.19; real fingers never produce
      // sub-frame move pairs, so the floor changes nothing for them).
      if (now - track.lastT > 4) {
        var instVy = (y - track.lastY) / (now - track.lastT);
        track.vy = track.vy * 0.7 + instVy * 0.3;
      }
      track.lastY = y;
      track.lastT = now;

      // live drag from ANY state: raw = where the finger puts the top edge
      var raw = track.baseY + dy;
      if (raw < 0) {
        // past full: rubber-band the upward overshoot (never detaches —
        // the sheet surface still reaches past the screen bottom)
        dragTargetY = raw * 0.25;
      } else if (raw > H) {
        // below closed the sheet is already fully gone — Y never exceeds H
        dragTargetY = H;
      } else {
        dragTargetY = raw;
      }
      if (!dragRaf) {
        dragNowY = curY;
        dragRaf = requestAnimationFrame(dragRender);
      }
    }

    // ── THE GESTURE CLOSE (dismiss spring, rigid slide) ─────────────
    // vis stays FROZEN (no window writes): the sheet slides away as one
    // rigid card exactly like v0.41 — the content never squashes on exit.
    function dismiss(fromY, closeFn) {
      stopAll();
      cancelDuck(false);   // v0.65.1: a closing sheet owes no duck
      panelEl.style.transition = 'none';
      // v0.45 ITEM 1: unblock canvas the INSTANT the fling-close begins.
      // The scrim loses .open (→ pointer-events:none) + the panel goes
      // pointer-events:none, so touches pass straight through to the grid
      // while the sheet finishes its slide-away. .open stays on panelEl
      // so the class-observer does NOT fire slideClosed() mid-spring
      // (that would kill this spring via stopAll and hijack the slide).
      panelEl.classList.add('closing');
      panelEl.style.pointerEvents = 'none';
      var scrim = document.getElementById('chat-scrim');
      if (scrim) scrim.classList.remove('open');
      var x = fromY, target = H;
      var v = Math.max(track.vy * 1000 * 0.5, 900);
      var lastT = performance.now();
      var stiffness = 440, damping = 2 * Math.sqrt(stiffness);   // v0.45 ITEM 1: 260→440 snappier
      function step(now) {
        var dt = Math.min(0.05, (now - lastT) / 1000);
        lastT = now;
        var a = stiffness * (target - x) - damping * v;
        v += a * dt;
        x += v * dt;
        if (x >= target - 1) {
          dismissRaf = 0;
          writeY(H);                            // exactly closed
          if (closeFn) closeFn();
          // AFTER the hook (same tick — nothing paints between): reset
          // for the next open. Silent: the old dismiss never fired state
          // events either (panel.close() already read the position).
          currentState = 'default';
          panelEl.classList.remove('panel-full');
          panelEl.classList.remove('closing');   // v0.45 ITEM 1
          panelEl.style.pointerEvents = '';       // v0.45 ITEM 1
          measureChrome();
          return;
        }
        writeY(x);                              // transform ONLY — rigid
        dismissRaf = requestAnimationFrame(step);
      }
      dismissRaf = requestAnimationFrame(step);
    }

    function end(closeFn) {
      if (!track.active) return;
      track.active = false;
      stopDragLoop();
      var dy = track.lastY - track.y0;

      var next;
      if (track.fromDuck) {
        // v0.65.1: THE DOCKED RULES — a grab that started at the 30%
        // peek: a deliberate DOWNWARD slide (the anchor's own slop
        // filtered the jitter; 10px confirms intent for body hijacks)
        // slides the panel down and CLOSES it; an upward slide — or a
        // mere tap (dy≈0, the natural anchor case) — returns it to the
        // ORIGINAL dock ("goes back to it's original position" — the
        // half dock, never full).
        // v0.72: THE EASY SLIDE-DOWN — a downward FLING counts even
        // when the travel is short (vy > DUCK_FLING_VY; a 6px flick at
        // speed is unambiguous intent, and the ducked body hijack's
        // rebase eats most of a short drag's dy).
        if (duckTimer) { clearTimeout(duckTimer); duckTimer = 0; }
        var wasDucked = ducked;
        ducked = false;
        if (wasDucked) fireDuck();
        next = (dy > DUCK_TAP_SLOP || track.vy > DUCK_FLING_VY) ? 'CLOSE' : 'default';
      } else {
        next = decide(track.vy, dy);
      }

      if (next === 'CLOSE') {
        dismiss(curY, closeFn);
        return;
      }
      // The settle: apply the target state (class + events), then ONE
      // continuous spring — the finger hands the sheet to physics and it
      // GLIDES to the snap point while the window stretches along.
      applyState(next);
      var v = track.vy * 1000 * 0.25; // seed with a quarter of release velocity (momentum feel)
      springY(curY, yForState(next), v);
    }

    // ── Wire the ANCHOR zone: handle + panel header ──────────────
    // v0.19: elements like #panel-name (tap-to-rename) must still work as
    // DRAG ORIGINS — a stationary touch stays a tap, a touch that moves
    // >12px becomes a panel drag.
    var lastDragEndedAt = 0;
    var anchorAPI = {
      setCloseHook: null,
      state: function () { return currentState; },
      setHeight: function (next, animate) { cancelDuck(false); setHeight(next, animate !== false); },
      openAt: function (pos) {
        var next = states[pos] !== undefined ? pos : 'default';
        cancelDuck(false);   // v0.65.1: a re-open kills any stale duck; the spring below lands
        applyState(next);
        if (curY >= H - 1) {
          // closed → the 0.25s rise (identical curve to the old CSS one).
          // The window var is sized for the LANDING state before the sheet
          // moves, so the content glides up rigid — exactly v0.41's look.
          riseTo(yForState(next), false, null);
        } else {
          // already on screen (switching chats / remembered states): glide
          // there with the settle spring — the bottom stays glued.
          springY(curY, yForState(next), 0);
        }
      },
      reset: function () {
        cancelDuck(false);   // v0.65.1
        applyState('default');
        stopAll();
        panelEl.style.transition = 'none';
        if (curY >= H - 1) writeY(H);           // closed: stay closed
        else renderY(yForState('default'));     // visible: snap home instantly
      },
      justDragged: function () { return performance.now() - lastDragEndedAt < 350; },
      // ── v0.65.1: THE THIRD DOCK's public surface (panel.js wires the
      // triggers; the geometry + the timer live here) ─────────────────
      duckForCanvas: function () { duckForCanvas(); },
      retriggerDuck: function () { if (ducked) resetDuckTimer(); },
      cancelDuck: function (restore) { cancelDuck(!!restore); },
      isDucked: function () { return ducked; },
      // v0.63.4: the handle strip grows a browser toolbar while the
      // docked browser is up (panel.js _setStripMode) — re-run the chrome
      // math + repaint the window var at the CURRENT offset so the
      // visible window ends where it should (no jump, no gap).
      remeasure: function () {
        if (!panelEl) return;
        measureChrome();
        renderY(curY);
      }
    };

    // ── CLASS-DRIVEN CLOSES (scrim tap and friends) ─────────────────
    // panel.close() drops .open directly — with the CSS transform rules
    // gone, the slide-down motion has to come from us. Watch the class:
    // when 'open' is REMOVED while the sheet is still on screen, run the
    // same 0.25s slide the old stylesheet did (vis frozen → rigid card).
    function slideClosed() {
      track.active = false;
      track.bodyStart = null;
      cancelDuck(false);   // v0.65.1: a closing sheet owes no duck
      // v0.45 ITEM 1: class-driven close (scrim tap / ✕) — unblock canvas
      // immediately so the grid is live while the 0.17s slide runs.
      panelEl.classList.add('closing');
      panelEl.style.pointerEvents = 'none';
      riseTo(H, true, function () {
        // silent reset for the next open (same as the dismiss spring's end)
        currentState = 'default';
        panelEl.classList.remove('panel-full');
        panelEl.classList.remove('closing');   // v0.45 ITEM 1
        panelEl.style.pointerEvents = '';       // v0.45 ITEM 1
        measureChrome();
      });
    }
    var clsObs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var old = (muts[i].oldValue || '').split(/\s+/);
        if (old.indexOf('open') === -1) continue;         // 'open' wasn't there → not a close
        if (panelEl.classList.contains('open')) continue; // still there → not a close
        if (curY < H - 1) slideClosed();
        break;
      }
    });
    clsObs.observe(panelEl, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    function wireAnchor(el) {
      if (!el) return;
      var pending = null; // {y, soft} — soft = started on a tap-zone
      el.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { pending = null; return; }
        var soft = !!(e.target.closest && e.target.closest('button, a, input, textarea, select, .name-edit')) ||
          !!(e.target.closest && e.target.closest('[data-nodrag]'));
        if (soft) {
          pending = { y: e.touches[0].clientY, soft: true };
          return;
        }
        pending = null;
        begin(e.touches[0].clientY, true, e);
      }, { passive: false });
      el.addEventListener('touchmove', function (e) {
        if (!track.active) {
          if (pending && pending.soft && e.touches.length === 1) {
            if (Math.abs(e.touches[0].clientY - pending.y) > 12) {
              pending = null;
              if (e.cancelable) e.preventDefault();
              begin(e.touches[0].clientY, true, e);
            }
          }
          return;
        }
        if (e.cancelable) e.preventDefault();
        move(e.touches[0].clientY);
      }, { passive: false });
      el.addEventListener('touchend', function () {
        pending = null;
        if (track.active) lastDragEndedAt = performance.now();
        end(closeHook);
      });
      el.addEventListener('touchcancel', function () {
        pending = null;
        if (track.active) lastDragEndedAt = performance.now();
        end(closeHook);
      });

      // v0.38: MOUSE/STYLUS dragging on the anchor (desktop + precision
      // pens). Pointer events with capture — the finger can slide off the
      // handle without losing the drag. Touch stays on the battle-tested
      // touch listeners above; this only handles non-touch pointers.
      var mouseActive = false, mouseLast = 0;
      el.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch') return; // touch path owns those
        if (e.target.closest && (e.target.closest('button, a, input, textarea, select, .name-edit, [data-nodrag]'))) return;
        mouseActive = true;
        mouseLast = 0;
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        begin(e.clientY, true, null);
        e.preventDefault();
      });
      el.addEventListener('pointermove', function (e) {
        if (!mouseActive || e.pointerType === 'touch') return;
        move(e.clientY);
      });
      function mouseUp(e) {
        if (!mouseActive || (e && e.pointerType === 'touch')) return;
        mouseActive = false;
        lastDragEndedAt = performance.now();
        end(closeHook);
      }
      el.addEventListener('pointerup', mouseUp);
      el.addEventListener('pointercancel', mouseUp);
    }
    var anchor = panelEl.querySelector('.handle');
    var header = panelEl.querySelector('.panel-header');
    wireAnchor(anchor);
    wireAnchor(header);

    // ── The scroll chain for the chat body (PRESERVED VERBATIM) ─────
    function isScrollable(el) {
      if (el.nodeType !== 1 || el.scrollHeight <= el.clientHeight + 2) return false;
      var st = window.getComputedStyle(el);
      return st.overflowY === 'auto' || st.overflowY === 'scroll' ||
             st.overflow === 'auto' || st.overflow === 'scroll';
    }
    function innerScroller(target) {
      var el = target && target.closest ? target : null;
      while (el && el !== body && el !== panelEl) {
        if (isScrollable(el)) return el;
        el = el.parentElement;
      }
      if (body && isScrollable(body)) return body; // settings & other body-scrolling pages
      return null;
    }

    var body = panelEl.querySelector('.panel-body');
    if (body) {
      body.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        if (track.active) return; // an ANCHOR gesture is already running
        // v1.04.1 F1: THE CHANNEL GATE — a touch on an element that owns
        // its gesture (the wheel, the sliders, the switches…) is not even
        // RECORDED (the user's exact shape: "the panel should not even
        // listen to that channel"). No bodyStart → the touchmove handler
        // below is a no-op for the whole gesture → no hijack, no
        // preventDefault, the owned surface keeps its full pointer
        // stream. The ducked-peek interaction timer also skips these.
        if (ownsGesture(e.target)) return;
        if (ducked) resetDuckTimer();   // v0.65.1: touching the peek = interacting
        track.bodyStart = {
          y: e.touches[0].clientY,
          t: performance.now(),
          sc: innerScroller(e.target),
          noSheet: ownsGesture(e.target),
          maxDy: 0
        };
        track.active = false;
      }, { passive: true });
      body.addEventListener('touchmove', function (e) {
        var bs = track.bodyStart;
        if (!bs || e.touches.length !== 1) return;
        if (ducked) resetDuckTimer();   // v0.65.1: scrolling the peek keeps it
        if (bs.noSheet) return; // sliders own their drags
        if (track.active && !track.hijacked) return; // anchor drag in progress
        var y = e.touches[0].clientY;
        var dy = y - bs.y;
        // v0.65.1: how far this body touch travelled (a still press on
        // the ducked peek is a press, not a scroll)
        bs.maxDy = Math.max(bs.maxDy || 0, Math.abs(dy));

        if (dy <= 0) return; // upward = plain scrolling, never ours
        // v0.72: THE EASY SLIDE-DOWN — while DUCKED, a downward pull is
        // DISMISS intent even when the content is scrolled (the peek is
        // a glance; the scroller gate only applies to the real docks),
        // and the grab slop halves (10px vs 24 — the release rule then
        // closes on the rebased dy or a flick). NOTE: duckGrab is just
        // `ducked` — NOT `!track.active`: once the hijack fires, the
        // following moves belong to the drag and must reach move();
        // gating them on !track.active re-armed the scroller gate
        // mid-drag and the release saw a 6px dy (the bug this line
        // fixed after its own first test).
        var duckGrab = ducked;
        if (!duckGrab && bs.sc && bs.sc.scrollTop > 0) return; // inner scroller still owns it

        var slop = duckGrab ? DUCK_BODY_SLOP : BODY_SLOP;
        if (dy > slop) {
          if (!track.active) {
            if (e.cancelable) e.preventDefault();
            // rebase so the sheet doesn't jump by the slop amount
            track.y0 = y - 6;
            track.lastY = y;
            track.t0 = track.lastT = performance.now();
            begin(track.y0, false, e);
            track.hijacked = true;
          }
          move(y);
          if (e.cancelable) e.preventDefault();
        }
      }, { passive: false });
      body.addEventListener('touchend', function () {
        var bs = track.bodyStart;
        if (track.active && track.hijacked) {
          track.hijacked = false;
          end(closeHook);
        } else if (ducked && bs && (bs.maxDy || 0) < DUCK_TAP_SLOP && curY < H - 1) {
          // v0.65.1: THE PRESS RULE — a still press on the ducked
          // panel's content returns it to its ORIGINAL dock (the tap's
          // own target still gets its click — nothing here is prevented)
          cancelDuck(true);
        }
        track.bodyStart = null;
      });
      body.addEventListener('touchcancel', function () {
        if (track.active && track.hijacked) {
          track.hijacked = false;
          end(closeHook);
        }
        track.bodyStart = null;
      });
    }

    // viewport resize (rotation / split-screen / keyboard): the 100dvh box
    // reflows on its own; re-derive the offset from the current FRACTION so
    // the sheet keeps its exact on-screen proportion, and rewrite the
    // window var for the new geometry.
    window.addEventListener('resize', function () {
      var frac = H > 0 ? 1 - curY / H : states[currentState];
      H = window.innerHeight;
      measureChrome();
      renderY((1 - frac) * H);
    });

    var closeHook = null;
    anchorAPI.setCloseHook = function (fn) { closeHook = fn; };

    // ── v0.42 INITIAL STATE: closed before anything paints ───────────
    // No CSS transform rule hides the sheet anymore — THIS inline write is
    // the hidden state. It runs synchronously during attach (script load),
    // before the first frame can show the 100dvh surface.
    panelEl.style.transition = 'none';
    writeVis(H);        // zero-height window while off-screen
    writeY(H);          // fully below the viewport
    applyState((opts && opts.initial) || 'default');
    try { window.__doomalayPanelDuck = false; } catch (e) {}   // v0.65.1: the native channel's guard reads this

    return anchorAPI;
  }

  window.PanelGestures = { attach: attach };
})();
