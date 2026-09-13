// panel.js — the slide-up panel manager (content-agnostic).
//
// A reusable, content-agnostic panel that slides up from the bottom of
// the screen. Any caller can open it with title + subtitle + avatar HTML
// + body HTML. Closes by dragging the handle down or tapping the scrim.
//
// The panel doesn't know or care what's inside it — the caller provides
// the content. This lets the SAME panel serve chats, polls, monitors,
// settings, etc. Each icon type just provides different content via
// its getPanelContent() methods.
//
// Exposes: window.Panel = Panel

(function () {
  'use strict';

  class Panel {
    constructor(opts) {
      this.panelEl  = opts.panelEl;
      this.scrimEl  = opts.scrimEl;
      this.handleEl = opts.handleEl;
      this.headerEl = opts.headerEl || null;  // the panel-header (also draggable)
      this.avatarEl = opts.avatarEl;
      this.nameEl   = opts.nameEl;
      this.subEl    = opts.subEl;
      this.bodyEl   = opts.bodyEl;

      this.currentContext = null;  // whatever the caller passed to open()
      this.onClose = null;

      this._wireDragging();
      var self = this;
      this.scrimEl.addEventListener('click', function () { self.close(); });
    }

    // Open the panel with the given content.
    // `context` is stored (not used by Panel itself) so the caller can
    // retrieve it later via `panel.currentContext` — e.g. to know which
    // icon the panel is showing for.
    // `onClose` is called when the panel closes (optional).
    open({ title, subtitle, avatarHTML, bodyHTML, context, onClose }) {
      this.currentContext = context || null;
      this.onClose = onClose || null;
      this.nameEl.textContent = title || '';
      this.subEl.textContent = subtitle || '';
      this.avatarEl.innerHTML = avatarHTML || '';
      this.bodyEl.innerHTML = bodyHTML || '';
      var self = this;
      // requestAnimationFrame ensures the browser has rendered the panel
      // in its hidden state before we add .open, so the CSS transition fires.
      requestAnimationFrame(function () {
        self.scrimEl.classList.add('open');
        self.panelEl.classList.add('open');
      });
    }

    close() {
      this.scrimEl.classList.remove('open');
      this.panelEl.classList.remove('open');
      var cb = this.onClose;
      this.currentContext = null;
      this.onClose = null;
      if (cb) cb();
    }

    isOpen() { return this.panelEl.classList.contains('open'); }

    _wireDragging() {
      var startY = 0, offset = 0, dragging = false;
      var self = this;

      var start = function (clientY) {
        dragging = true;
        startY = clientY;
        offset = 0;
        self.panelEl.style.transition = 'none';
      };
      var move = function (clientY) {
        if (!dragging) return;
        offset = clientY - startY;
        if (offset < 0) offset = 0;  // only allow dragging DOWN
        self.panelEl.style.transform = 'translateY(' + offset + 'px)';
      };
      var end = function () {
        if (!dragging) return;
        dragging = false;
        self.panelEl.style.transition = '';
        var panelH = self.panelEl.offsetHeight;
        var threshold = Math.min(120, panelH * 0.25);
        if (offset > threshold) self.close();
        self.panelEl.style.transform = '';
      };

      // Touch on handle.
      this.handleEl.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        e.preventDefault(); e.stopPropagation();
        start(e.touches[0].clientY);
      }, { passive: false });
      this.handleEl.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 1) return;
        e.preventDefault(); e.stopPropagation();
        move(e.touches[0].clientY);
      }, { passive: false });
      this.handleEl.addEventListener('touchend', function (e) {
        e.stopPropagation(); end();
      });

      // Mouse on handle (desktop testing).
      this.handleEl.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        start(e.clientY);
      });

      // Also wire the header (avatar + name + subtitle) as a drag zone,
      // so the user doesn't have to grab the tiny handle bar. The header
      // is the whole top strip above the body — much easier to grab.
      // v0.14: interactive children (the far-left model button etc.) are
      // EXEMPT — their taps must produce clicks, not drags.
      if (this.headerEl) {
        var isInteractive = function (target) {
          return !!(target && target.closest &&
            target.closest('button, a, input, textarea, select, [data-nodrag]'));
        };
        this.headerEl.addEventListener('touchstart', function (e) {
          if (e.touches.length !== 1) return;
          if (isInteractive(e.target)) return; // let the control receive the tap
          e.preventDefault(); e.stopPropagation();
          start(e.touches[0].clientY);
        }, { passive: false });
        this.headerEl.addEventListener('touchmove', function (e) {
          if (e.touches.length !== 1) return;
          if (isInteractive(e.target)) return;
          e.preventDefault(); e.stopPropagation();
          move(e.touches[0].clientY);
        }, { passive: false });
        this.headerEl.addEventListener('touchend', function (e) {
          if (isInteractive(e.target)) return;
          e.stopPropagation(); end();
        });
        this.headerEl.addEventListener('mousedown', function (e) {
          if (isInteractive(e.target)) return;
          e.preventDefault(); e.stopPropagation();
          start(e.clientY);
        });
      }

      window.addEventListener('mousemove', function (e) { if (dragging) move(e.clientY); });
      window.addEventListener('mouseup', function () { if (dragging) end(); });
    }
  }

  window.Panel = Panel;
})();
