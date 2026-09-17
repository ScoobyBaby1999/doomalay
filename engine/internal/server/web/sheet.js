// sheet.js — v0.26 THE REUSABLE UI OVERLAY (the "cloud provider style"
// master panel the user specced):
//
//   "The usage panel opens a UI overlay similar to the one we are aiming
//    to create, but isn't reusable and is broken... Our reusable UI should
//    have a title, and X botton, be modular and as compartmentalized as
//    possible, and follow android gesture navigations, and allow for multi
//    step processes or quick re-renders (instead of overlaying many panels
//    above each other, we use one master panel that is unbelievably
//    efficient at changing and rendering different UI."
//
// DESIGN — ONE master panel, a VIEW STACK, zero dependencies:
//   Sheet.open({ title, render, onClose, full })   open the panel with a root view
//   Sheet.push({ title, render })                  multi-step: push a view (‹ back appears)
//   Sheet.replace({ title, render })               quick re-render of the CURRENT view
//   Sheet.pop()                                    back one view (root view → close)
//   Sheet.close()                                  close everything
//   Sheet.back()                                   Android back: pop-or-close
//
// A view is { title, render(bodyEl), onMount?(bodyEl) }. render returns
// an HTML string or an Element; onMount runs AFTER the DOM is in (wire
// events there — replacing re-runs it cleanly).
//
// ANDROID GESTURES:
//   · swipe DOWN on the handle/head → the panel follows the finger; a
//     fling or >120px drag closes it (the same snap behavior as the main
//     app panel — gesture.js's PanelGestures pattern, reimplemented
//     locally so the sheet owns its own lifecycle)
//   · scrim tap closes (ghost-tap guarded — a tap that lands <400ms
//     after open is ignored; the persona editor learned this the hard way)
//   · Escape closes; Android hardware back → app.js handleBack → Sheet.back()
//
// Exposes: window.Sheet = { open, push, pop, replace, close, back, isOpen, setBusy }
(function () {
  'use strict';

  var root = null, panelEl = null, titleEl = null, bodyEl = null,
    backBtn = null, xBtn = null, scrimEl = null, handleEl = null;
  var stack = [];          // [{title, render, onMount}]
  var onCloseCb = null;
  var openedAt = 0;
  var closing = false;
  var busy = false;        // a view flagged "working" ignores close gestures

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function ensureDOM() {
    if (root && root.isConnected) return;
    root = document.createElement('div');
    root.id = 'sheet-root';
    root.innerHTML =
      '<div class="sheet-scrim"></div>' +
      '<div class="sheet-panel" role="dialog" aria-modal="true">' +
        '<div class="sheet-handle-zone"><div class="sheet-handle"></div></div>' +
        '<div class="sheet-head">' +
          '<button class="sheet-back" aria-label="Back" style="display:none">‹</button>' +
          '<div class="sheet-title"></div>' +
          '<button class="sheet-x" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="sheet-body"></div>' +
      '</div>';
    document.body.appendChild(root);
    panelEl = root.querySelector('.sheet-panel');
    titleEl = root.querySelector('.sheet-title');
    bodyEl = root.querySelector('.sheet-body');
    backBtn = root.querySelector('.sheet-back');
    xBtn = root.querySelector('.sheet-x');
    scrimEl = root.querySelector('.sheet-scrim');
    handleEl = root.querySelector('.sheet-handle-zone');

    scrimEl.addEventListener('click', function (e) {
      if (e.target !== scrimEl) return;
      if (performance.now() - openedAt < 400) return; // ghost tap
      close();
    });
    xBtn.addEventListener('click', function () {
      if (performance.now() - openedAt < 400) return;
      close();
    });
    backBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); back(); }
    }, true);

    wireSwipeClose();
  }

  // ── swipe-down-to-close (handle + head are the drag zones) ─────────
  function wireSwipeClose() {
    var startY = 0, offset = 0, dragging = false, pid = null;
    var isInteractive = function (t) {
      return !!(t && t.closest && t.closest('button, a, input, textarea, select, [data-nodrag]'));
    };
    var zone = function (t) { return !!(t.closest && t.closest('.sheet-head, .sheet-handle-zone')); };

    var start = function (y, id) {
      if (busy) return;
      dragging = true; startY = y; offset = 0; pid = id;
      panelEl.style.transition = 'none';
    };
    var move = function (y) {
      if (!dragging) return;
      offset = Math.max(0, y - startY);
      panelEl.style.transform = 'translateY(' + offset + 'px)';
    };
    var end = function () {
      if (!dragging) return;
      dragging = false;
      panelEl.style.transition = '';
      panelEl.style.transform = '';
      if (offset > 120) close();
      offset = 0; pid = null;
    };

    panelEl.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.target;
      if (isInteractive(t) || !zone(t)) return;
      start(e.touches[0].clientY, e.touches[0].identifier);
    }, { passive: true });
    panelEl.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = null;
      for (var i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === pid) t = e.touches[i];
      if (t) { e.preventDefault(); move(t.clientY); }
    }, { passive: false });
    panelEl.addEventListener('touchend', end);
    panelEl.addEventListener('touchcancel', end);

    // Desktop dogfood: mouse drag on the same zones.
    panelEl.addEventListener('mousedown', function (e) {
      var t = e.target;
      if (isInteractive(t) || !zone(t)) return;
      e.preventDefault();
      start(e.clientY, 'mouse');
    });
    window.addEventListener('mousemove', function (e) { if (dragging) move(e.clientY); });
    window.addEventListener('mouseup', end);
  }

  // ── view rendering ──────────────────────────────────────────────────
  function renderView() {
    if (!stack.length) return;
    var v = stack[stack.length - 1];
    titleEl.textContent = v.title || '';
    var out = v.render ? v.render(bodyEl) : '';
    if (typeof out === 'string') bodyEl.innerHTML = out;
    else if (out && out.nodeType) { bodyEl.innerHTML = ''; bodyEl.appendChild(out); }
    backBtn.style.display = stack.length > 1 ? '' : 'none';
    bodyEl.scrollTop = 0;
    if (v.onMount) { try { v.onMount(bodyEl); } catch (e) { console.error('sheet onMount', e); } }
  }

  // ── public API ─────────────────────────────────────────────────────
  function open(view) {
    ensureDOM();
    stack = [];
    onCloseCb = view && view.onClose || null;
    stack.push(view);
    renderView();
    openedAt = performance.now();
    closing = false;
    // CRITICAL (v0.26, caught live by Playwright's actionability check):
    // clearing the inline display (='') falls back to the CSS
    // #sheet-root { display:none } — the sheet DOM existed but stayed
    // INVISIBLE (JS clicks still landed on the hidden nodes, which is why
    // eval-driven probes passed while the real UI never showed). Set it.
    root.style.display = 'block';
    requestAnimationFrame(function () { root.classList.add('open'); });
  }

  function push(view) {
    if (!root || !stack.length) return open(view);
    stack.push(view);
    renderView();
  }

  function replace(view) {
    if (!root || !stack.length) return open(view);
    stack[stack.length - 1] = view;
    renderView();
  }

  function pop() {
    if (!root) return;
    if (stack.length > 1) { stack.pop(); renderView(); return; }
    close();
  }

  function back() { if (isOpen()) { pop(); return true; } return false; }

  function close() {
    if (!root || closing) return;
    closing = true;
    root.classList.remove('open');
    var cb = onCloseCb;
    setTimeout(function () {
      if (root.classList.contains('open')) { closing = false; return; }
      root.style.display = 'none';
      bodyEl.innerHTML = '';
      stack = [];
      closing = false;
    }, 240);
    if (cb) { try { cb(); } catch (e) {} }
    onCloseCb = null;
  }

  function isOpen() { return !!(root && root.classList.contains('open')); }
  function depth() { return stack.length; }
  function setBusy(b) { busy = !!b; }

  window.Sheet = {
    open: open,
    push: push,
    pop: pop,
    replace: replace,
    close: close,
    back: back,
    isOpen: isOpen,
    depth: depth,
    setBusy: setBusy,
    esc: esc
  };
})();
