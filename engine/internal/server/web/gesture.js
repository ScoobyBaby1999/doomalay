// gesture.js — v0.19 TWO-POSITION PANEL GESTURES + THE SCROLL CHAIN.
//
// USER SPEC (v0.19, the "smooth game" round):
//   "Make it easier to dock the chat back to half size when in fullscreen —
//    more leniency for the drag-and-drop space for it to dock.
//    Make scrolling much, much easier: currently scrolling drops the chat
//    and doesn't actually scroll the chat. We have to make it clear and
//    very easy and comfortable to differentiate between scrolling the
//    panel down or up, scrolling the chat itself, and scrolling a pill
//    inside the chat like a response."
//
// THE SCROLL CHAIN (who wins a gesture, in order):
//   1. INNER SCROLLABLE (tool pill details, code cards, the editor):
//      if the finger is inside one and it can still scroll in the
//      gesture's direction, IT scrolls — the panel never interferes.
//   2. THE CHAT BODY: finger down/up scrolls the conversation normally.
//   3. THE PANEL SHEET: only takes over when everything above is
//      exhausted — i.e. the innermost scroller AND the chat body are
//      both pinned at the top AND the finger keeps pulling DOWN past a
//      real slop (24px, was 8 — casual swipes no longer grab the sheet).
//
// SNAPPING (two positions only — v0.18 spec unchanged):
//   full (100vh) / default (62vh).
//   DOCKING LENIENCY from full: a modest downward drag (>10% of the
//   height) or a gentle downward velocity docks at default. Closing from
//   full needs INTENT: a hard fling or a really big (>55%) drag.
//   From default, down is the dismiss direction — but with the same
//   intent bar: hard fling (vy > 0.55 px/ms) or a deliberate >32% drag
//   (was 10% — a scroll-speed swipe used to kill the chat).
//   The ANCHOR zone (handle + panel header) always gives full drag
//   control — the reliable place to dock/close on purpose.

(function () {
  'use strict';

  var panelEl = null;   // #chat-panel
  var states = { default: 0.62, full: 1.0 };
  var currentState = 'default';
  var onStateChange = null;

  // velocity / intent tuning (v0.19)
  var FLING_VY = 0.55;        // px/ms — a genuinely hard swipe
  var DOCK_VY = 0.18;        // px/ms — gentle downward motion docks (from full)
  var BODY_SLOP = 24;        // px of pull-down before the sheet grabs (was 8)
  var UP_DRAG_FRAC = 0.22;    // dragged up > 22% of height → full intent
  var FULL_DOCK_FRAC = 0.10;  // from full: > 10% down drag docks at default
  var FULL_CLOSE_FRAC = 0.55; // from full: > 55% slow drag closes (was 45)
  var CLOSE_FRAC = 0.32;      // from default: > 32% deliberate drag closes (was 10)

  function attach(panel, opts) {
    panelEl = panel;
    onStateChange = (opts && opts.onStateChange) || null;
    setHeight((opts && opts.initial) || 'default', false);

    var track = {
      active: false, y0: 0, t0: 0, lastY: 0, lastT: 0, vy: 0,
      fromAnchor: false, hijacked: false, baseFrac: 0,
      bodyStart: null
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
      // Upward intent → full.
      if (upward && (vy < -FLING_VY || Math.abs(dy) > h * UP_DRAG_FRAC)) return 'full';
      if (currentState === 'full') {
        // EXAGGERATED down from full → close ("reels" feel — v0.18 spec).
        if (downward && vy > FLING_VY) return 'CLOSE';
        // Big deliberate slow drag → close.
        if (downward && dy > h * FULL_CLOSE_FRAC) return 'CLOSE';
        // v0.19 DOCKING LENIENCY: a moderate drag or a gentle downward
        // motion docks back to half. This is the generous drop zone the
        // user asked for — nearly any deliberate downward motion docks.
        if (downward && (dy > h * FULL_DOCK_FRAC || vy > DOCK_VY)) return 'default';
        return 'full';
      }
      // From default: down is the DISMISS direction.
      if (downward && vy > FLING_VY) return 'CLOSE';
      if (downward && dy > h * CLOSE_FRAC) return 'CLOSE';
      return 'default';
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

    // v0.24 SMOOTH DRAG: the sheet used to track the finger 1:1 — twitchy
    // ("make scrolling feel a tad bit more smooth and less hyper to move",
    // per the user). A rAF lerp now eases the sheet toward the finger every
    // frame — it still feels attached, but micro-jitter is smoothed away.
    // The settle (end) still snaps to the decided position via CSS.
    var dragRaf = 0, dragTargetPx = 0, dragNowPx = 0;
    function dragRender() {
      dragRaf = 0;
      dragNowPx += (dragTargetPx - dragNowPx) * 0.68;
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

      // live drag: translate the sheet so it FOLLOWS THE FINGER.
      // Dragging DOWN (dy>0) REDUCES coverage: frac = baseFrac − dy/h.
      var h = panelH();
      var frac = track.baseFrac - dy / h;
      if (frac > 1) frac = 1 + (frac - 1) * 0.25;       // past full: damp
      var px = Math.round((1 - frac) * h);
      if (px < 0) px = 0;                                // never above full
      dragTargetPx = px;                                 // v0.24: eased follow
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
    // v0.19: elements like #panel-name (tap-to-rename) must still work as
    // DRAG ORIGINS — a stationary touch stays a tap (the click fires), a
    // touch that moves >12px becomes a panel drag (and suppresses the
    // click via a flag the click handler can check).
    var lastDragEndedAt = 0;
    var anchorAPI = {
      setCloseHook: null, // filled below once closeHook exists
      state: function () { return currentState; },
      setHeight: setHeight,
      // open at a remembered position (called by panel.open — no animation)
      openAt: function (pos) {
        setHeight(states[pos] !== undefined ? pos : 'default', false);
      },
      reset: function () { setHeight('default', false); },
      // tap handlers (rename) use this to ignore the click after a drag.
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
          // Don't own the gesture yet — wait to see if it's a drag.
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
              // It IS a drag — take over (this also suppresses the tap).
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
    }
    var anchor = panelEl.querySelector('.handle');
    var header = panelEl.querySelector('.panel-header');
    wireAnchor(anchor);
    wireAnchor(header);
    // Exposed so tap handlers (rename) can ignore the click that follows
    // a drag (the browser still fires it on the lifted finger).
    // → anchorAPI.justDragged (declared above with the API object).
    // NOTE: panel.js also wires drag-to-close on handle/header. gesture.js
    // REPLACES that behavior — panel.js detects window.PanelGestures and
    // skips its own wiring (see panel.js v0.17 guard).

    // ── The scroll chain for the chat body ────────────────────────
    //
    // v0.19 ROOT-CAUSE NOTE: the old code checked `body.scrollTop <= 0`
    // — but .panel-body NEVER scrolls (chatpanel.js mounts #chat-root
    // at height:100% inside it; #chat-scroll does the actual scrolling).
    // hijackable was therefore ALWAYS true → every downward swipe in the
    // chat grabbed the sheet and a 10% pull closed it. "Scrolling drops
    // the chat" — fixed by walking the REAL scroll chain below.
    //
    // innerScroller returns the innermost element between `target` and
    // `.panel-body` that can scroll vertically — a tool-pill detail, a code
    // card, or #chat-scroll itself (the conversation). Whatever it
    // returns owns the gesture until it's pinned at its top.
    //
    // v0.24 FIX (user report: "trying to scroll in the settings panel when
    // I expand many collapsed boxes the panel closes and does not scroll"):
    // settings pages put their content DIRECTLY in .panel-body — there is
    // no intermediate scroller, and the walk below used to stop at body
    // WITHOUT ever considering it. innerScroller returned null → every
    // downward swipe in a tall settings page hijacked the sheet → CLOSE.
    // The body itself is a legit scroller now (chat mode unaffected: there
    // #chat-root sits at height:100% inside body, so body never scrolls —
    // the walk finds #chat-scroll first).
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
        if (track.active) return; // an ANCHOR gesture (handle/header) is
                                  // already running — this bubbled event
                                  // must not kill it.
        track.bodyStart = {
          y: e.touches[0].clientY,
          t: performance.now(),
          sc: innerScroller(e.target)   // may be null → nothing to scroll
        };
        track.active = false;
      }, { passive: true });
      body.addEventListener('touchmove', function (e) {
        var bs = track.bodyStart;
        if (!bs || e.touches.length !== 1) return;
        if (track.active && !track.hijacked) return; // anchor drag in progress
        var y = e.touches[0].clientY;
        var dy = y - bs.y;

        if (dy <= 0) return; // upward = plain scrolling, never ours

        // LEVEL 1+2 of the scroll chain: the innermost scroller (pill /
        // code card / the conversation itself) consumes the gesture while
        // it can still scroll up. LIVE check — mid-gesture handoff works:
        // the pill scrolls to its top, then the sheet takes over.
        if (bs.sc && bs.sc.scrollTop > 0) return;

        // LEVEL 3: everything is pinned at the top and the finger keeps
        // pulling down. Require REAL intent (slop) before grabbing the
        // sheet, so casual scrolling never drops the chat.
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

    // viewport resize (rotation / split-screen): vh heights recompute on
    // their own, but the state class stays consistent.
    window.addEventListener('resize', function () {
      panelEl.style.height = Math.round(states[currentState] * 100) + 'vh';
    });

    var closeHook = null;
    anchorAPI.setCloseHook = function (fn) { closeHook = fn; };
    return anchorAPI;
  }

  window.PanelGestures = { attach: attach };
})();
