// gesture.js — v0.42 THE ALWAYS-TALL SHEET (background-gap + settle-jank fix).
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
    panelEl.style.transform = 'translate3d(0,' + y + 'px,0)';
  }
  function writeVis(y) {
    panelEl.style.setProperty('--panel-vis-h', visForY(y) + 'px');
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
  function ownsGesture(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('input[type="range"], textarea, .no-sheet-drag');
  }

  function attach(panel, opts) {
    panelEl = panel;
    onStateChange = (opts && opts.onStateChange) || null;
    H = window.innerHeight;
    measureChrome();

    var track = {
      active: false, y0: 0, t0: 0, lastY: 0, lastT: 0, vy: 0,
      fromAnchor: false, hijacked: false, baseFrac: 0, baseY: 0,
      bodyStart: null
    };

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

      var next = decide(track.vy, dy);
      var settleFrom = curY; // where the sheet visually sits right now (sub-pixel)

      if (next === 'CLOSE') {
        dismiss(settleFrom, closeFn);
        return;
      }
      // The settle: apply the target state (class + events), then ONE
      // continuous spring — the finger hands the sheet to physics and it
      // GLIDES to the snap point while the window stretches along.
      applyState(next);
      var v = track.vy * 1000 * 0.25; // seed with a quarter of release velocity (momentum feel)
      springY(settleFrom, yForState(next), v);
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
        var next = states[pos] !== undefined ? pos : 'default';
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
        applyState('default');
        stopAll();
        panelEl.style.transition = 'none';
        if (curY >= H - 1) writeY(H);           // closed: stay closed
        else renderY(yForState('default'));     // visible: snap home instantly
      },
      justDragged: function () { return performance.now() - lastDragEndedAt < 350; }
    };

    // ── CLASS-DRIVEN CLOSES (scrim tap and friends) ─────────────────
    // panel.close() drops .open directly — with the CSS transform rules
    // gone, the slide-down motion has to come from us. Watch the class:
    // when 'open' is REMOVED while the sheet is still on screen, run the
    // same 0.25s slide the old stylesheet did (vis frozen → rigid card).
    function slideClosed() {
      track.active = false;
      track.bodyStart = null;
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

    return anchorAPI;
  }

  window.PanelGestures = { attach: attach };
})();
