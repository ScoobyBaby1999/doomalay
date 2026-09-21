// gesture.js — v0.38 THE PANEL PHYSICS REWORK (the "satisfying sheet").
//
// USER SPEC (v0.38): "the panel scrolling needs to be flawless… it just has
// to feel much better, especially in knowing when to close and when to stay
// open, when to drag down and follow the finger to mid position, and how
// smooth and satisfying it feels doing so."
//
// THE JANK ROOT CAUSES THIS REWORK KILLS:
//   1. The CSS transform transition stayed ON during the drag — every
//      finger write restarted a 250ms ease, so the sheet perpetually
//      lagged the finger ("floaty", not 1:1).
//   2. Snapping changed HEIGHT instantly (no height transition existed)
//      while the transform eased — a visible double-motion teleport.
//   3. Only two positions; a "mid" drag from full had no natural target.
//   4. vh heights vs innerHeight drag math drifted apart on dynamic
//      toolbars (100vh ≠ window.innerHeight on mobile browsers).
//
// THE NEW MODEL:
//   · THREE snap points: closed (0) / default (62dvh) / full (100dvh).
//   · During the drag: transition:none + the sheet tracks the finger
//     (a 0.8-per-frame convergence lerp — kills sensor jitter, still
//     1:1 to the eye) with rubber-banding past full.
//   · On release: VELOCITY PROJECTION (position + vy·140ms) picks the
//     target; the intent thresholds (fling/drag fractions) remain as
//     tie-breakers so casual scrolls never close the sheet.
//   · THE SETTLE: set the new height instantly, compensate the transform
//     so nothing teleports on screen, then run a critically-damped spring
//     to zero — ONE continuous motion from finger to rest.
//   · CLOSE animates the sheet fully down (spring), THEN fires the hook.
//
// PRESERVED VERBATIM (battle-tested through v0.19–v0.29):
//   · the scroll chain (inner scroller → chat body → sheet after 24px
//     slop at the top), slider ownership, the anchor soft-tap zones,
//   per-chat position memory (openAt), panel-state events, justDragged.

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

  // v0.38: viewport height — dvh tracks the DYNAMIC viewport (mobile
  // toolbars); innerHeight stays the drag-math source of truth so the
  // finger and the sheet always agree.
  function panelH() { return window.innerHeight; }
  function vhFrac() {
    // the effective fraction the current vh-based height represents
    var h = panelEl.getBoundingClientRect().height;
    return panelH() > 0 ? h / panelH() : states[currentState];
  }

  // v0.29: elements that OWN their touch gestures — the sheet must never
  // hijack a drag meant for them.
  function ownsGesture(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('input[type="range"], textarea, .no-sheet-drag');
  }

  function attach(panel, opts) {
    panelEl = panel;
    onStateChange = (opts && opts.onStateChange) || null;
    setHeight((opts && opts.initial) || 'default', false);

    var track = {
      active: false, y0: 0, t0: 0, lastY: 0, lastT: 0, vy: 0,
      fromAnchor: false, hijacked: false, baseFrac: 0,
      bodyStart: null
    };

    // ── THE SPRING (critically damped — no overshoot, no bounce lag) ──
    var springRaf = 0;
    function stopSpring() {
      if (springRaf) { cancelAnimationFrame(springRaf); springRaf = 0; }
    }
    // settleFromPx: animate transform px → 0 with a critically-damped
    // spring. Stiffness tuned for ~260ms settle from typical drag deltas.
    function springToZero(fromPx, onDone) {
      stopSpring();
      var x = fromPx;
      var v = track.vy * 1000 * 0.25; // seed with a quarter of release velocity (momentum feel)
      if (v > 2400) v = 2400; if (v < -2400) v = -2400;
      var lastT = performance.now();
      var stiffness = 170, damping = 2 * Math.sqrt(stiffness) * 1.02;
      function step(now) {
        var dt = Math.min(0.05, (now - lastT) / 1000);
        lastT = now;
        var a = -stiffness * x - damping * v;
        v += a * dt;
        x += v * dt;
        if (Math.abs(x) < 1.5 && Math.abs(v) < 40) { // snap the last sub-2px (imperceptible)
          panelEl.style.transform = '';
          panelEl.style.transition = '';
          springRaf = 0;
          if (onDone) onDone();
          return;
        }
        panelEl.style.transform = 'translateY(' + Math.round(x) + 'px)';
        springRaf = requestAnimationFrame(step);
      }
      springRaf = requestAnimationFrame(step);
    }

    function setHeight(next, animate, compensateFromPx) {
      var prevPx = panelEl.offsetHeight; // LAYOUT height (transforms ignored)
      currentState = next;
      panelEl.classList.toggle('panel-full', next === 'full');
      var h = Math.round(states[next] * 100) + 'dvh';
      panelEl.style.transition = 'none';
      panelEl.style.height = h;
      if (compensateFromPx !== undefined && compensateFromPx !== null) {
        // THE NO-TELEPORT SETTLE: the height just changed under the sheet;
        // offset the transform by exactly the visual delta so the screen
        // shows NO jump, then spring the transform to zero.
        var nowPx = panelEl.offsetHeight; // layout height after the change
        // visual continuity: the sheet's on-screen top must not move when the
        // height changes under it. oldVisualTop = (H − prevH) + drag;
        // newLayoutTop = (H − newH); transform = oldVisualTop − newLayoutTop
        // = newH − prevH + drag.
        var comp = nowPx - prevPx + compensateFromPx;
        panelEl.style.transform = 'translateY(' + Math.round(comp) + 'px)';
        panelEl.getBoundingClientRect(); // force layout so the next frame animates
        springToZero(comp);
      } else {
        panelEl.style.transform = '';
        if (animate === false) {
          requestAnimationFrame(function () { panelEl.style.transition = ''; });
        } else {
          panelEl.style.transition = '';
        }
      }
      if (onStateChange) { try { onStateChange(next); } catch (e) {} }
      window.dispatchEvent(new CustomEvent('doomalay:panel-state', { detail: { state: next } }));
    }

    // Where does this gesture END? (no side effects — end() acts on it)
    // v0.38: VELOCITY PROJECTION leads; the intent thresholds confirm.
    function decide(vy, dy) {
      var h = panelH();
      var downward = dy > 0;
      var upward = dy < 0;
      var projected = dy + vy * PROJECTION_MS; // where the finger WANTS to land
      var fromFrac = vhFrac();
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
      stopSpring();
      track.y0 = track.lastY = y;
      track.t0 = track.lastT = performance.now();
      track.vy = 0;
      track.fromAnchor = !!fromAnchor;
      track.hijacked = false;
      track.baseFrac = vhFrac();
      // v0.38 THE FIX: no transition while the finger drives the sheet —
      // every write lands THIS frame (1:1 tracking, zero lag).
      panelEl.style.transition = 'none';
      if (e && e.cancelable && track.fromAnchor) e.preventDefault();
    }

    // 1:1 finger tracking with a whisper of jitter smoothing (0.8/frame).
    var dragRaf = 0, dragTargetPx = 0, dragNowPx = 0;
    function dragRender() {
      dragRaf = 0;
      dragNowPx += (dragTargetPx - dragNowPx) * 0.8;
      if (Math.abs(dragTargetPx - dragNowPx) < 0.4) dragNowPx = dragTargetPx;
      panelEl.style.transform = 'translateY(' + Math.round(dragNowPx) + 'px)';
      if (dragNowPx !== dragTargetPx) dragRaf = requestAnimationFrame(dragRender);
    }

    function move(y) {
      if (!track.active) return;
      var now = performance.now();
      var dy = y - track.y0;
      if (now - track.lastT > 0) {
        var instVy = (y - track.lastY) / (now - track.lastT);
        track.vy = track.vy * 0.7 + instVy * 0.3;
      }
      track.lastY = y;
      track.lastT = now;

      // live drag: the sheet tracks the finger 1:1 FROM ANY STATE.
      // v0.38 ROOT-CAUSE FIX: the old px = (1-frac)*h mapping was only
      // correct when dragging FROM FULL — from default it translated
      // (1−baseFrac)·h + dy ≈ 3.4× the finger ("hyper", the floaty-jank
      // the user felt). The rest position of EVERY snap is translateY 0
      // (the height does the work), so the drag delta IS the translate.
      var h = panelH();
      var frac = track.baseFrac - dy / h;
      var px;
      if (frac > 1) {
        // past full: rubber-band the upward overshoot (never detaches)
        px = -Math.round((frac - 1) * h * 0.25);
      } else {
        px = Math.round(dy);
      }
      dragTargetPx = px;
      if (!dragRaf) {
        var cur = parseFloat(panelEl.style.transform.replace(/[^0-9.-]/g, ''));
        dragNowPx = isNaN(cur) ? 0 : cur;
        dragRaf = requestAnimationFrame(dragRender);
      }
    }

    function end(closeFn) {
      if (!track.active) return;
      track.active = false;
      if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
      var dy = track.lastY - track.y0;

      var next = decide(track.vy, dy);
      var settleFrom = dragNowPx; // where the sheet visually sits right now
      panelEl.style.transform = 'translateY(' + Math.round(settleFrom) + 'px)';

      if (next === 'CLOSE') {
        // Animate the dismiss: spring the sheet fully down, then close.
        // The close hook removes .open (the CSS fade handles scrim+panel).
        var h = panelH();
        // animate height to ~0 via transform: from settleFrom to h
        (function dismiss() {
          var x0 = settleFrom, target = h;
          var v = Math.max(track.vy * 1000 * 0.5, 900);
          var lastT = performance.now();
          var stiffness = 260, damping = 2 * Math.sqrt(stiffness);
          function step(now) {
            var dt = Math.min(0.05, (now - lastT) / 1000);
            lastT = now;
            var a = stiffness * (target - x0) - damping * v;
            v += a * dt;
            x0 += v * dt;
            if (x0 >= target - 1) {
              panelEl.style.height = Math.round(states.default * 100) + 'dvh';
              if (closeFn) closeFn();
              // AFTER the close hook (same tick — nothing paints between):
              // the closed state's own styles take over; clearing here keeps
              // the NEXT open from inheriting a stray inline transform.
              panelEl.style.transform = '';
              panelEl.style.transition = '';
              return;
            }
            panelEl.style.transform = 'translateY(' + Math.round(x0) + 'px)';
            requestAnimationFrame(step);
          }
          requestAnimationFrame(step);
        })();
        return;
      }
      // The settle: instant height + transform compensation + spring = the
      // finger hands the sheet to physics and it GLIDES to the snap point.
      setHeight(next, true, settleFrom);
    }

    // ── Wire the ANCHOR zone: handle + panel header ──────────────
    // v0.19: elements like #panel-name (tap-to-rename) must still work as
    // DRAG ORIGINS — a stationary touch stays a tap, a touch that moves
    // >12px becomes a panel drag.
    var lastDragEndedAt = 0;
    var anchorAPI = {
      setCloseHook: null,
      state: function () { return currentState; },
      setHeight: function (next, animate) { setHeight(next, animate !== false); },
      openAt: function (pos) {
        setHeight(states[pos] !== undefined ? pos : 'default', false);
      },
      reset: function () { setHeight('default', false); },
      justDragged: function () { return performance.now() - lastDragEndedAt < 350; }
    };

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
        track.bodyStart = {
          y: e.touches[0].clientY,
          t: performance.now(),
          sc: innerScroller(e.target),
          noSheet: ownsGesture(e.target)
        };
        track.active = false;
      }, { passive: true });
      body.addEventListener('touchmove', function (e) {
        var bs = track.bodyStart;
        if (!bs || e.touches.length !== 1) return;
        if (bs.noSheet) return; // sliders own their drags
        if (track.active && !track.hijacked) return; // anchor drag in progress
        var y = e.touches[0].clientY;
        var dy = y - bs.y;

        if (dy <= 0) return; // upward = plain scrolling, never ours
        if (bs.sc && bs.sc.scrollTop > 0) return; // inner scroller still owns it

        if (dy > BODY_SLOP) {
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
        if (track.active && track.hijacked) {
          track.hijacked = false;
          end(closeHook);
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

    // viewport resize (rotation / split-screen): dvh heights recompute on
    // their own, but the state class stays consistent.
    window.addEventListener('resize', function () {
      panelEl.style.height = Math.round(states[currentState] * 100) + 'dvh';
    });

    var closeHook = null;
    anchorAPI.setCloseHook = function (fn) { closeHook = fn; };
    return anchorAPI;
  }

  window.PanelGestures = { attach: attach };
})();
