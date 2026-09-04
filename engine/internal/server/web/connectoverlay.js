// connectoverlay.js — reusable full-screen overlay with blur background.
//
// Used by the sandbox picker, model picker, and any nested panel that needs
// to overlay the entire screen with a blurred backdrop. Content-agnostic:
// the caller provides HTML, the overlay handles show/hide/blur/scrim-tap.
//
// Exposes: window.ConnectOverlay

(function () {
  'use strict';

  // Singleton overlay element — created lazily on first open.
  let overlayEl = null;
  let contentEl = null;
  let scrimEl = null;
  let onCloseCb = null;

  function ensureElements() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'connect-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;z-index:3000;display:none;' +
      'align-items:center;justify-content:center;padding:20px;';
    scrimEl = document.createElement('div');
    scrimEl.style.cssText =
      'position:absolute;inset:0;background:rgba(0,0,0,0.5);' +
      'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
    contentEl = document.createElement('div');
    contentEl.style.cssText =
      'position:relative;z-index:1;width:100%;max-width:480px;max-height:85vh;' +
      'overflow-y:auto;background:#0e0e12;border:1px solid #1a1a22;' +
      'border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,0.6);' +
      '-webkit-overflow-scrolling:touch;';
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
    contentEl.innerHTML = html;
    overlayEl.style.display = 'flex';
    onCloseCb = opts.onClose || null;
    // Prevent body scroll
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!overlayEl || overlayEl.style.display === 'none') return;
    overlayEl.style.display = 'none';
    document.body.style.overflow = '';
    var cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb();
  }

  function isOpen() {
    return overlayEl && overlayEl.style.display !== 'none';
  }

  function getContentEl() { return contentEl; }

  window.ConnectOverlay = { open: open, close: close, isOpen: isOpen, getContentEl: getContentEl };
})();
