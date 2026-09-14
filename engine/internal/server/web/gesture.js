// gesture.js — v0.17 SNAP-POINT PANEL GESTURES (bottom-sheet physics).
//
// User spec: "Sliding down hard, or sliding the panel down with an
// exaggerated motion should lower the panel even if the slide wasn't
// held from the anchor point. Similar to scrolling down reels. Moreso,
// scrolling up or sliding your finger up from the anchor point should
// full screen the panel, sliding it down with an exaggerated motion
// should return it to default, not minimize it."
//
// THREE SNAP STATES (like reels):
//   full   (100vh)  ← finger-up fling FROM the anchor (handle/header), or
//                     any upward fling while the sheet is already tracking
//   default(85vh)   ← the normal chat height; exaggerated downward fling
//                     from full returns here (NOT to peek)
//   peek   (~22vh)  ← exaggerated downward fling from default lowers the
//                     sheet to a peek; another hard fling (or big drag) past
//                     peek CLOSES the panel
//
// HOW "NOT FROM THE ANCHOR" WORKS: the chat body scrolls (pan-y). When
// the body is scrolled to the TOP and the finger moves DOWN, the sheet
// takes over the gesture (the classic bottom-sheet pattern) — so a hard
// downward swipe ANYWHERE on the chat lowers it. Upward snaps only arm
// from the anchor zone to avoid hijacking scroll.

(function () {
  'use strict';

  var panelEl = null;   // #chat-panel
  var states = { peek: 0.22, default: 0.85, full: 1.0 };
  var currentState = 'default';

  // velocity tuning
  var FLING_VY = 0.55;        // px/ms — "exaggerated" fast swipe
  var DRAG_FRAC = 0.35;       // dragged > 35% of height → intent
  var MAX_TRACK_MS = 320;     // velocity window

  function attach(panel) {
    panelEl = panel;
    // full-state layout: taller sheet + flat top corners
    setHeight('default', false);

    var track = {
      active: false, y0: 0, t0: 0, lastY: 0, lastT: 0, vy: 0,
      fromAnchor: false, moved: 0, hijacked: false, startTop: 0
    };

    function stateFrac() { return states[currentState]; }
    function panelH() { return window.innerHeight; }

    function setHeight(next, animate) {
      currentState = next;
      panelEl.classList.toggle('panel-full', next === 'full');
      panelEl.classList.toggle('panel-peek', next === 'peek');
      var h = Math.round(states[next] * 100) + 'vh';
      panelEl.style.transition = animate === false ? 'none' : '';
      panelEl.style.height = h;
      if (animate === false) {
        requestAnimationFrame(function () { panelEl.style.transition = ''; });
      }
      window.dispatchEvent(new CustomEvent('doomalay:panel-state', { detail: { state: next } }));
    }

    function snapFor(vy, dy) {
      var order = ['peek', 'default', 'full'];
      var idx = order.indexOf(currentState);
      var far = Math.abs(dy) > panelH() * DRAG_FRAC;
      if (vy < -FLING_VY || (dy < 0 && far)) {
        // user spec: "scrolling up or sliding your finger up from the
        // anchor point should full screen the panel" — ANY upward anchor
        // intent goes straight to full.
        return 'full';
      }
      if (vy > FLING_VY || (dy > 0 && far)) {            // downward intent
        return order[Math.max(0, idx - 1)];              // step down one
      }
      // slow + short: settle to the NEAREST of the two neighbors
      var frac = stateFrac() + dy / panelH();
      var best = currentState, dist = Math.abs(frac - stateFrac());
      for (var i = 0; i < order.length; i++) {
        var d = Math.abs(frac - states[order[i]]);
        if (d < dist) { dist = d; best = order[i]; }
      }
      return best;
    }

    function begin(y, fromAnchor, e) {
      track.active = true;
      track.y0 = track.lastY = y;
      track.t0 = track.lastT = performance.now();
      track.vy = 0;
      track.moved = 0;
      track.fromAnchor = !!fromAnchor;
      track.hijacked = false;
      track.baseFrac = states[currentState];
      if (e && e.cancelable && track.fromAnchor) e.preventDefault();
    }

    function move(y) {
      if (!track.active) return;
      var now = performance.now();
      var dy = y - track.y0;
      track.moved = Math.max(track.moved, Math.abs(dy));
      // velocity over a short window
      if (now - track.lastT > 0) {
        var instVy = (y - track.lastY) / (now - track.lastT);
        track.vy = track.vy * 0.7 + instVy * 0.3;
      }
      track.lastY = y;
      track.lastT = now;

      // live drag: translate the sheet (rubber-band the extremes)
      var h = panelH();
      var frac = track.baseFrac + dy / h;
      if (frac > 1) frac = 1 + (frac - 1) * 0.25;       // past full: damp
      var px = Math.round((1 - frac) * h);
      if (currentState === 'full' && frac > 1) {
        // dragging down from full: sheet follows fractionally
        panelEl.style.height = Math.round(Math.min(1, frac) * 100) + 'vh';
      } else {
        panelEl.style.transform = 'translateY(' + Math.max(0, px) + 'px)';
      }
    }

    function end(closeFn) {
      if (!track.active) return;
      track.active = false;
      var dy = track.lastY - track.y0;
      panelEl.style.transform = '';

      var vy = track.vy;
      var downward = dy > 0;
      var hard = downward && (vy > FLING_VY || Math.abs(dy) > panelH() * DRAG_FRAC);

      // past-peek fling → close
      if (currentState === 'peek' && downward && (vy > FLING_VY * 0.8 || dy > panelH() * 0.18)) {
        panelEl.style.height = Math.round(states.default * 100) + 'vh';
        if (closeFn) closeFn();
        return;
      }
      var next = snapFor(vy, dy);
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
                                  // must not kill it (v0.17 bug: it reset
                                  // track.active mid-fling → dead gestures)
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

    var closeHook = null;
    return {
      setCloseHook: function (fn) { closeHook = fn; },
      state: function () { return currentState; },
      setHeight: setHeight,
      reset: function () { setHeight('default', false); }
    };
  }

  window.PanelGestures = { attach: attach };
})();
