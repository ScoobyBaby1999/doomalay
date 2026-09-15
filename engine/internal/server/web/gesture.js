// gesture.js — v0.18 TWO-POSITION PANEL GESTURES (bottom-sheet physics).
//
// USER SPEC (v0.18 redteam):
//   "Let's only have 2 positions, full screen, and the default screen.
//    A big sliding down motion or gesture should slide the panel
//    completely and close it whether it is full screen or not.
//    When opening a panel, default to the half-ish screen default
//    position, but remember the user's preference — next time the panel
//    should open to default OR full depending on what position the user
//    had for that chat before they closed it."
//
// TWO SNAP STATES:
//   full   (100vh) — anchor up-gesture / upward fling lands here
//   default(62vh)  — the normal chat height (top ~38% of the screen stays
//                    empty — the user can still see the grid behind)
//
// CLOSING: any EXAGGERATED downward motion closes the panel completely —
// a hard fling (velocity) or a big drag (distance) — from EITHER state.
// The old third "peek" position is GONE (it caused confusion: users
// expected the chat to lower completely and it got stuck at 15%).
//
// HOW "NOT FROM THE ANCHOR" WORKS: the chat body scrolls (pan-y). When
// the body is scrolled to the TOP and the finger moves DOWN, the sheet
// takes over the gesture (the classic bottom-sheet pattern) — so a hard
// downward swipe ANYWHERE on the chat closes it. Upward snaps only arm
// from the anchor zone to avoid hijacking scroll.

(function () {
  'use strict';

  var panelEl = null;   // #chat-panel
  var states = { default: 0.62, full: 1.0 };
  var currentState = 'default';
  var onStateChange = null;

  // velocity tuning
  var FLING_VY = 0.55;        // px/ms — "exaggerated" fast swipe
  var UP_DRAG_FRAC = 0.22;    // dragged up > 22% of height → full intent
  var FULL_CLOSE_FRAC = 0.45; // from full: a REALLY big slow drag → close
  var CLOSE_FRAC = 0.10;      // from default: a deliberate 10%+ pull closes

  function attach(panel, opts) {
    panelEl = panel;
    onStateChange = (opts && opts.onStateChange) || null;
    setHeight((opts && opts.initial) || 'default', false);

    var track = {
      active: false, y0: 0, t0: 0, lastY: 0, lastT: 0, vy: 0,
      fromAnchor: false, hijacked: false, baseFrac: 0
    };

    function stateFrac() { return states[currentState]; }
    function panelH() { return window.innerHeight; }

    function setHeight(next, animate) {
      currentState = next;
      panelEl.classList.toggle('panel-full', next === 'full');
      var h = Math.round(states[next] * 100) + 'vh';
      panelEl.style.transition = animate === false ? 'none' : '';
      panelEl.style.height = h;
      if (animate === false) {
        requestAnimationFrame(function () { panelEl.style.transition = ''; });
      }
      if (onStateChange) { try { onStateChange(next); } catch (e) {} }
      window.dispatchEvent(new CustomEvent('doomalay:panel-state', { detail: { state: next } }));
    }

    // Where does this gesture END? (no side effects — end() acts on it)
    function decide(vy, dy) {
      var h = panelH();
      var downward = dy > 0;
      var upward = dy < 0;
      // EXAGGERATED DOWN, any state → close ("reels" feel).
      if (downward && vy > FLING_VY) return 'CLOSE';
      // Upward intent → full.
      if (upward && (vy < -FLING_VY || Math.abs(dy) > h * UP_DRAG_FRAC)) return 'full';
      // From full: only a REALLY big slow drag closes — a moderate one
      // (≈180-300px) settles down to default so both positions stay
      // comfortably reachable.
      if (downward && currentState === 'full' && dy > h * FULL_CLOSE_FRAC) return 'CLOSE';
      // From default: down is the DISMISS direction (nothing sits below
      // default) — a deliberate 10%+ pull closes.
      if (downward && currentState === 'default' && dy > h * CLOSE_FRAC) return 'CLOSE';
      // Otherwise settle to the NEAREST of the two positions.
      // (frac = coverage after the drag: down REDUCES it — v0.18 sign fix;
      // v0.17 had +dy/h which made downward drags settle the WRONG way and
      // the panel never tracked the finger — the "isn't too accurate" feel.)
      var frac = Math.min(1, Math.max(0, stateFrac() - dy / h));
      var best = currentState, dist = Math.abs(frac - stateFrac());
      for (var k in states) {
        var d = Math.abs(frac - states[k]);
        if (d < dist) { dist = d; best = k; }
      }
      return best;
    }

    function begin(y, fromAnchor, e) {
      track.active = true;
      track.y0 = track.lastY = y;
      track.t0 = track.lastT = performance.now();
      track.vy = 0;
      track.fromAnchor = !!fromAnchor;
      track.hijacked = false;
      track.baseFrac = states[currentState];
      if (e && e.cancelable && track.fromAnchor) e.preventDefault();
    }

    function move(y) {
      if (!track.active) return;
      var now = performance.now();
      var dy = y - track.y0;
      // velocity over a short window
      if (now - track.lastT > 0) {
        var instVy = (y - track.lastY) / (now - track.lastT);
        track.vy = track.vy * 0.7 + instVy * 0.3;
      }
      track.lastY = y;
      track.lastT = now;

      // live drag: translate the sheet so it FOLLOWS THE FINGER.
      // v0.18 SIGN FIX: dragging DOWN (dy>0) must REDUCE coverage —
      // frac = baseFrac - dy/h. v0.17 had +dy/h: downward drags clamped at
      // zero movement and the sheet sat dead under the finger.
      var h = panelH();
      var frac = track.baseFrac - dy / h;
      if (frac > 1) frac = 1 + (frac - 1) * 0.25;       // past full: damp
      var px = Math.round((1 - frac) * h);
      if (px < 0) px = 0;                                // never above full
      panelEl.style.transform = 'translateY(' + px + 'px)';
    }

    function end(closeFn) {
      if (!track.active) return;
      track.active = false;
      var dy = track.lastY - track.y0;
      panelEl.style.transform = '';

      var next = decide(track.vy, dy);
      if (next === 'CLOSE') {
        // Restore a sane height for the next open, then slide away.
        panelEl.style.height = Math.round(states.default * 100) + 'vh';
        if (closeFn) closeFn();
        return;
      }
      setHeight(next, true);
    }

    // ── Wire the ANCHOR zone: handle + panel header ──────────────
    var anchor = panelEl.querySelector('.handle');
    var header = panelEl.querySelector('.panel-header');

    function wireAnchor(el) {
      if (!el) return;
      el.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        if (e.target.closest && e.target.closest('button, a, input, textarea, select, [data-nodrag]')) return;
        begin(e.touches[0].clientY, true, e);
      }, { passive: false });
      el.addEventListener('touchmove', function (e) {
        if (!track.active) return;
        e.preventDefault();
        move(e.touches[0].clientY);
      }, { passive: false });
      el.addEventListener('touchend', function () { end(closeHook); });
    }
    wireAnchor(anchor);
    wireAnchor(header);
    // NOTE: panel.js also wires drag-to-close on handle/header. gesture.js
    // REPLACES that behavior — panel.js detects window.PanelGestures and
    // skips its own wiring (see panel.js v0.17 guard).

    // ── Wire the BODY: hijack only when scrolled to top + moving down ──
    var body = panelEl.querySelector('.panel-body');
    if (body) {
      body.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        if (track.active) return; // an ANCHOR gesture (handle/header) is
                                  // already running — this bubbled event
                                  // must not kill it.
        track.bodyStart = {
          y: e.touches[0].clientY, top: body.scrollTop, t: performance.now(),
          hijackable: body.scrollTop <= 0
        };
        track.active = false;
      }, { passive: true });
      body.addEventListener('touchmove', function (e) {
        var bs = track.bodyStart;
        if (!bs || !bs.hijackable || e.touches.length !== 1) return;
        if (track.active && !track.hijacked) return; // anchor drag in progress
        var y = e.touches[0].clientY;
        var dy = y - bs.y;
        if (dy > 8) {                      // pull down from the top → take over
          if (!track.active) {
            if (e.cancelable) e.preventDefault();
            begin(y, false, e);
            track.hijacked = true;
          }
          move(y);
          if (e.cancelable) e.preventDefault();
        }
      }, { passive: false });
      body.addEventListener('touchend', function () {
        if (track.active && track.hijacked) {
          track.hijacked = false;
          end(closeHook);
        }
        track.bodyStart = null;
      });
    }

    // viewport resize (rotation / split-screen): vh heights recompute on
    // their own, but the state class stays consistent.
    window.addEventListener('resize', function () {
      panelEl.style.height = Math.round(states[currentState] * 100) + 'vh';
    });

    var closeHook = null;
    return {
      setCloseHook: function (fn) { closeHook = fn; },
      state: function () { return currentState; },
      setHeight: setHeight,
      // open at a remembered position (called by panel.open — no animation)
      openAt: function (pos) {
        setHeight(states[pos] !== undefined ? pos : 'default', false);
      },
      reset: function () { setHeight('default', false); }
    };
  }

  window.PanelGestures = { attach: attach };
})();
