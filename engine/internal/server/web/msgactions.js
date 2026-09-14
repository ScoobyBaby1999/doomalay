// msgactions.js — v0.17 message LONG-PRESS ACTIONS + copy affordances.
//
// User spec: "The user should be able to highlight text, select, and copy
// text from the chat easily." — plus a creative extra: long-press any
// message → action sheet (copy · quote · regenerate) with a light haptic
// on Android (navigator.vibrate).
//
// Text selection itself is CSS (user-select:text on .msg-bubble) — this
// module adds the action sheet + per-message quick actions.

(function () {
  'use strict';

  var sheetEl = null;
  var LONG_PRESS_MS = 450;

  function ensureSheet() {
    if (sheetEl && sheetEl.isConnected) return sheetEl;
    sheetEl = document.createElement('div');
    sheetEl.id = 'msg-action-sheet';
    sheetEl.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);' +
      'background:#1a1a22;border:1px solid #2a2a35;border-radius:14px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.6);padding:6px;display:none;' +
      'z-index:3500;min-width:180px;opacity:0;transition:opacity .18s, transform .18s;' +
      'font-family:inherit';
    document.body.appendChild(sheetEl);
    return sheetEl;
  }

  function haptic() {
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
  }

  // wireMessages(container, handlers) — attach long-press to every message
  // bubble. handlers: { onQuote(text), onRegenerate() }
  function wire(container, handlers) {
    if (!container) return;
    var timer = null;
    var pressEl = null;

    var clear = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      pressEl = null;
    };

    container.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return clear();
      var bubble = e.target.closest && e.target.closest('.msg-bubble');
      if (!bubble || bubble.closest('.fmt-codecard') || e.target.closest('a, button, input, textarea')) return clear();
      pressEl = bubble;
      var touch = e.touches[0];
      timer = setTimeout(function () {
        timer = null;
        if (pressEl) showSheet(pressEl, handlers);
        pressEl = null;
      }, LONG_PRESS_MS);
    }, { passive: true });

    container.addEventListener('touchmove', function () {
      if (timer) clear();
    }, { passive: true });
    container.addEventListener('touchend', clear, { passive: true });
    container.addEventListener('touchcancel', clear, { passive: true });

    // mouse right-press / long mouse-hold (desktop testing)
    container.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var bubble = e.target.closest && e.target.closest('.msg-bubble');
      if (!bubble || e.target.closest('a, button, input, textarea')) return;
      pressEl = bubble;
      timer = setTimeout(function () {
        timer = null;
        if (pressEl) showSheet(pressEl, handlers);
        pressEl = null;
      }, LONG_PRESS_MS * 1.5);
    });
    container.addEventListener('mousemove', function () { if (timer) clear(); });
    window.addEventListener('mouseup', clear);
  }

  function showSheet(bubble, handlers) {
    haptic();
    var sheet = ensureSheet();
    var role = bubble.getAttribute('data-msg-role') || '';
    var text = bubble.getAttribute('data-msg-raw') || bubble.textContent || '';
    var isAssistant = role === 'assistant';
    var isUser = role === 'user';

    var actions = [];
    actions.push({ icon: '⧉', label: 'copy', run: function () {
      window.Formatter.copyText(text);
    }});
    if (handlers && handlers.onQuote && (isAssistant || isUser)) {
      actions.push({ icon: '❝', label: 'quote', run: function () {
        handlers.onQuote(text);
      }});
    }
    if (isAssistant && handlers && handlers.onRegenerate) {
      actions.push({ icon: '↻', label: 'regenerate', run: function () {
        handlers.onRegenerate();
      }});
    }

    sheet.innerHTML = '';
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'msg-action-btn';
      b.innerHTML = '<span class="msg-action-ico">' + a.icon + '</span>' + esc(a.label);
      b.addEventListener('click', function () {
        hideSheet();
        a.run();
      });
      sheet.appendChild(b);
    });

    sheet.style.display = 'block';
    var openedAt = performance.now();
    requestAnimationFrame(function () {
      sheet.style.opacity = '1';
      sheet.style.transform = 'translate(-50%,0)';
    });

    // any tap outside closes — but ignore events within 400ms of open:
    // the long-press's own touch-release fires a synthetic mousedown
    // right after the sheet appears, which instantly dismissed it
    // (the user never saw the sheet).
    setTimeout(function () {
      var closer = function (ev) {
        if (performance.now() - openedAt < 400) return;
        if (!sheet.contains(ev.target)) {
          hideSheet();
          document.removeEventListener('touchstart', closer, true);
          document.removeEventListener('mousedown', closer, true);
        }
      };
      document.addEventListener('touchstart', closer, true);
      document.addEventListener('mousedown', closer, true);
    }, 30);
  }

  function hideSheet() {
    if (!sheetEl) return;
    sheetEl.style.opacity = '0';
    sheetEl.style.transform = 'translate(-50%,20px)';
    setTimeout(function () {
      if (sheetEl && sheetEl.style.opacity === '0') sheetEl.style.display = 'none';
    }, 200);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  window.MsgActions = { wire: wire, hide: hideSheet };
})();
