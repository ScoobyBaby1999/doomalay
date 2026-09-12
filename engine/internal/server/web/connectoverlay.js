// connectoverlay.js — reusable full-screen overlay with blur background.
//
// Used by the sandbox picker, model picker, and any nested panel that needs
// to overlay the entire screen with a blurred backdrop. Content-agnostic:
// the caller provides HTML, the overlay handles show/hide/blur/scrim-tap.
//
// Has smooth open/close transitions (fade + scale) — not instant.
// Exposes: window.ConnectOverlay

(function () {
  'use strict';

  // Singleton overlay element — created lazily on first open.
  var overlayEl = null;
  var contentEl = null;
  var scrimEl = null;
  var onCloseCb = null;
  var closing = false;

  function ensureElements() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'connect-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;z-index:3000;visibility:hidden;' +
      'align-items:center;justify-content:center;padding:20px;';
    scrimEl = document.createElement('div');
    scrimEl.style.cssText =
      'position:absolute;inset:0;background:rgba(0,0,0,0.5);' +
      'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'opacity:0;transition:opacity 0.25s ease;';
    contentEl = document.createElement('div');
    contentEl.style.cssText =
      'position:relative;z-index:1;width:100%;max-width:480px;max-height:85vh;' +
      'overflow-y:auto;background:#0e0e12;border:1px solid #1a1a22;' +
      'border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,0.6);' +
      '-webkit-overflow-scrolling:touch;' +
      'touch-action:pan-y;' +   // native scrolling — do NOT let the document
                                 // touch handlers preventDefault these
      'opacity:0;transform:scale(0.95) translateY(10px);' +
      'transition:opacity 0.25s ease, transform 0.25s ease;';
    overlayEl.appendChild(scrimEl);
    overlayEl.appendChild(contentEl);
    document.body.appendChild(overlayEl);
    scrimEl.addEventListener('click', function (e) {
      if (e.target === scrimEl) close();
    });
  }

  function open(html, opts) {
    opts = opts || {};
    ensureElements();
    closing = false;
    contentEl.innerHTML = html;
    // Wire events AFTER the DOM swap — callers pass onSwap for this.
    if (opts.onSwap) { try { opts.onSwap(); } catch (e) { console.error(e); } }
    // Show the overlay (visibility:visible + flex)
    overlayEl.style.visibility = 'visible';
    overlayEl.style.display = 'flex';
    // Force reflow so the transition fires (not instant)
    void contentEl.offsetWidth;
    // Animate in
    scrimEl.style.opacity = '1';
    contentEl.style.opacity = '1';
    contentEl.style.transform = 'scale(1) translateY(0)';
    onCloseCb = opts.onClose || null;
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!overlayEl || overlayEl.style.visibility === 'hidden' || closing) return;
    closing = true;
    // Stop the overlay from eating taps WHILE it fades out (v0.12 fix):
    // for the 250ms close animation the overlay still sat at z-index 3000
    // intercepting touches — a fast tap right after picking a model landed
    // on the invisible scrim instead of the chat UI underneath.
    overlayEl.style.pointerEvents = 'none';
    // Animate out
    scrimEl.style.opacity = '0';
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'scale(0.95) translateY(10px)';
    setTimeout(function () {
      overlayEl.style.visibility = 'hidden';
      overlayEl.style.display = 'none';
      overlayEl.style.pointerEvents = '';
      document.body.style.overflow = '';
      closing = false;
      var cb = onCloseCb;
      onCloseCb = null;
      if (cb) cb();
    }, 250);
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
  function replaceContent(html, opts) {
    if (!overlayEl || overlayEl.style.visibility === 'hidden') {
      open(html, opts);
      return;
    }
    opts = opts || {};
    // Fade out current content
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'scale(0.98) translateY(4px)';
    setTimeout(function () {
      contentEl.innerHTML = html;
      void contentEl.offsetWidth; // reflow
      onCloseCb = opts.onClose || null;
      // Wire events AFTER the DOM swap.
      if (opts.onSwap) { try { opts.onSwap(); } catch (e) { console.error(e); } }
      // Fade in new content
      contentEl.style.opacity = '1';
      contentEl.style.transform = 'scale(1) translateY(0)';
    }, 150);
  }

  function isOpen() {
    return overlayEl && overlayEl.style.visibility !== 'hidden';
  }

  function getContentEl() { return contentEl; }

  window.ConnectOverlay = {
    open: open,
    close: close,
    isOpen: isOpen,
    getContentEl: getContentEl,
    replaceContent: replaceContent
  };
})();
