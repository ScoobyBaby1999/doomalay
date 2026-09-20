// panel.js — the MASTER PANEL (content-agnostic) + its VIEW STACK.
//
// v0.27 USER SPEC (the panel consolidation round):
//   "How about we use our existing master panel (the one we use for the
//    chatbot and settings) and have that be the reusable panel since it
//    works. We should ideally only have 2 panel types. The one the
//    chatbot and settings uses, and the one that gets overlayed when we
//    press connect cloud provider or select to change models… Remove all
//    other panels from the system. We only re-use the base 2."
//
// So the v0.26 "Sheet" experiment is DELETED (it was born broken on
// Android: app.js's isInsideUI() never learned about #sheet-root, so the
// document-level touch handlers preventDefault()ed every touch on it —
// dead buttons, a grid that panned behind it, and only the clunky
// swipe-down to escape). Everything the Sheet used to host (personas,
// placeholders, usage, export) now renders as a VIEW on THIS panel:
//
//   panel.open({...})        root content (the chat, settings) — unchanged
//   panel.pushView(view)     stack a view over the root (‹ back appears)
//   panel.popView()          back one view (last pop restores the root)
//   panel.replaceView(view)  re-render the current view in place
//   panel.closeViews()       drop every view, restore the root content
//   panel.back()             pop a view, else false (for Android back)
//
// A view is { title, render() -> html, onMount(bodyEl), onClose() }.
// The ROOT content is never destroyed by a view: its DOM (the whole
// #chat-root — messages, drafts, scroll position) is stashed into a
// detached DocumentFragment and restored on the way back out, exactly as
// it was. The panel header switches to view mode: the model button hides,
// a ‹ back button takes its place, the title shows the view's name and a
// ✕ appears on the far right (closes all views, keeps the panel open).
//
// Gestures stay the panel's own battle-tested ones (gesture.js — full /
// default snap points, the scroll chain, close-on-fling) because the
// views render directly into .panel-body, the scroller the chain already
// understands. Scrim tap / handle fling close the whole panel as before.
//
// Exposes: window.Panel = Panel

(function () {
  'use strict';

  // v0.18: per-chat panel-position memory. Keyed by the context's id
  // (the icon id) — "did THIS chat's panel sit at full or default when the
  // user closed it?" Reopening that chat restores that height; chats with
  // no memory open at the default (half-ish screen).
  var POS_KEY = 'doomalay.panelpos.v1';
  function readPosMap() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function rememberedPos(id) {
    var m = readPosMap();
    if (id && (m[id] === 'full' || m[id] === 'default')) return m[id];
    // v0.25: SETTINGS opens at FULL height by default — the 62vh sheet
    // was the "cramped, overlapping" Android complaint (drag down docks
    // it at 62vh, and the choice is remembered like any chat's).
    return id === 'settings' ? 'full' : 'default';
  }
  function rememberPos(id, pos) {
    if (!id) return;
    if (pos !== 'full' && pos !== 'default') return;
    var m = readPosMap();
    m[id] = pos;
    try { localStorage.setItem(POS_KEY, JSON.stringify(m)); } catch (e) {}
  }

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

      // ── v0.27 THE VIEW STACK ────────────────────────────────────
      this.viewStack = [];      // [{title, render, onMount, onClose}]
      this._rootFrag = null;    // the stashed root DOM (chat / settings)
      this._rootHeader = null;  // stashed header text/avatar/model-btn
      this._rootScroll = 0;     // .panel-body scroll to restore

      // v0.17→v0.18: SNAP-POINT GESTURES (full / default only +
      // close-on-fling — "like scrolling down reels") replace the simple
      // drag-to-close when gesture.js is loaded. The remembered per-chat
      // position is applied on every open() and saved on close().
      if (window.PanelGestures) {
        var selfG = this;
        this.gestures = window.PanelGestures.attach(this.panelEl, {
          onStateChange: function () { selfG._syncPosNow(); }
        });
        this.gestures.setCloseHook(function () { selfG.close(); });
      } else {
        this._wireDragging();
      }
      var self = this;
      this.scrimEl.addEventListener('click', function () { self.close(); });

      // view-mode chrome: ‹ back (far left) + ✕ (far right) live in the
      // panel header itself — the same strip gesture.js already treats
      // as the drag anchor, with buttons exempt from drags.
      this._backBtn = this.panelEl.querySelector('#panel-view-back');
      this._xBtn = this.panelEl.querySelector('#panel-view-x');
      this._modelBtn = this.panelEl.querySelector('#panel-model-btn');
      // v0.34: #panel-star-btn removed — favorites live in the model
      // browser's ★ tab now (see modelbrowser.js).
      if (this._backBtn) this._backBtn.addEventListener('click', function () { self.popView(); });
      if (this._xBtn) this._xBtn.addEventListener('click', function () { self.closeViews(); });
      // desktop nicety: Escape pops a view (the panel itself stays for
      // the scrim/drag/gesture closes — same as the chat always behaved)
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || !self.viewStack.length) return;
        e.stopPropagation();
        self.popView();
      }, true);
    }

    // Open the panel with the given ROOT content.
    // `context` is stored (not used by Panel itself) so the caller can
    // retrieve it later via `panel.currentContext` — e.g. to know which
    // icon the panel is showing for. `onClose` fires when the panel closes.
    open({ title, subtitle, avatarHTML, bodyHTML, context, onClose }) {
      // A fresh root render discards any open views (their content was
      // never the source of truth — the caller is re-rendering anyway).
      this._teardownViews();
      this._dropStash();
      this.currentContext = context || null;
      this.onClose = onClose || null;
      this.nameEl.textContent = title || '';
      this.subEl.textContent = subtitle || '';
      this.avatarEl.innerHTML = avatarHTML || '';
      this.bodyEl.innerHTML = bodyHTML || '';
      var self = this;
      // v0.18: open at the REMEMBERED position for this chat (no memory →
      // the half-ish default). Applied while still hidden so the slide-up
      // animation lands at the right height — no visible jump.
      if (this.gestures) {
        this.gestures.openAt(rememberedPos(this.currentContext && this.currentContext.id));
      }
      // requestAnimationFrame ensures the browser has rendered the panel
      // in its hidden state before we add .open, so the CSS transition fires.
      requestAnimationFrame(function () {
        self.scrimEl.classList.add('open');
        self.panelEl.classList.add('open');
      });
    }

    close() {
      // v0.18: remember where this chat's panel was sitting (full vs
      // default) BEFORE tearing it down — the next open restores it.
      this._syncPosNow();
      this.scrimEl.classList.remove('open');
      this.panelEl.classList.remove('open');
      this._teardownViews(); // fire view onClose hooks + drop the stack
      this._dropStash();
      var cb = this.onClose;
      this.currentContext = null;
      this.onClose = null;
      if (cb) cb();
    }

    isOpen() { return this.panelEl.classList.contains('open'); }

    // ── v0.27: THE VIEW STACK ──────────────────────────────────────
    viewDepth() { return this.viewStack.length; }

    // Push a view over whatever is showing. The first push stashes the
    // root; further pushes just stack (persona list → editor → trigger).
    pushView(view) {
      if (!view) return;
      if (!this.viewStack.length) this._stashRoot();
      this.viewStack.push(view);
      this._renderTopView();
    }

    // Re-render the current view in place (quick updates — the memory
    // ladder cycling, placeholder adds, mode pill refreshes).
    replaceView(view) {
      if (!this.viewStack.length) return this.pushView(view);
      if (view) this.viewStack[this.viewStack.length - 1] = view;
      this._renderTopView();
    }

    // The view currently on top (null while the root content shows) —
    // lets a view's ASYNC logic (fetches, debounced searches) check it is
    // still the visible view before re-rendering, so a covered view's
    // late callback never clobbers whatever the user is looking at now.
    topView() {
      return this.viewStack.length ? this.viewStack[this.viewStack.length - 1] : null;
    }

    // Back one view. The LAST pop restores the stashed root content.
    // Returns true when a view was popped (Android back eats it).
    popView() {
      if (!this.viewStack.length) return false;
      var v = this.viewStack.pop();
      if (v && v.onClose) { try { v.onClose(); } catch (e) { console.error('view onClose', e); } }
      if (this.viewStack.length) { this._renderTopView(); return true; }
      this._restoreRoot();
      return true;
    }

    // Drop every view and restore the root — the panel itself stays open.
    closeViews() {
      if (!this.viewStack.length) return;
      this._teardownViews();
      this._restoreRoot();
    }

    // Drop every view WITHOUT restoring the stash — for callers that
    // are about to re-render the root content themselves (renderHost).
    // closeViews() restores; dropViews() just discards.
    dropViews() {
      if (!this.viewStack.length) return;
      this._teardownViews();
      this._dropStash();
    }

    // Android back: pop a view if one is open, else report "not mine".
    back() {
      if (this.viewStack.length) return this.popView();
      return false;
    }

    _renderTopView() {
      if (!this.viewStack.length) return;
      var v = this.viewStack[this.viewStack.length - 1];
      // header switches to view mode (model button hides, ‹ + ✕ appear)
      this._setViewHeader(true, v.title || '');
      var html = '';
      try { html = v.render ? v.render() : ''; } catch (e) { console.error('view render', e); }
      this.bodyEl.classList.add('pv-mode');
      this.bodyEl.innerHTML = String(html || '');
      this.bodyEl.scrollTop = 0;
      if (v.onMount) { try { v.onMount(this.bodyEl); } catch (e) { console.error('view onMount', e); } }
    }

    _stashRoot() {
      this._rootFrag = document.createDocumentFragment();
      while (this.bodyEl.firstChild) this._rootFrag.appendChild(this.bodyEl.firstChild);
      this._rootScroll = this.bodyEl.scrollTop;
      var mb = this._modelBtn;
      this._rootHeader = {
        name: this.nameEl.textContent,
        sub: this.subEl.textContent,
        avatar: this.avatarEl.innerHTML,
        modelDisplay: mb ? mb.style.display : '',
        modelHTML: mb ? mb.innerHTML : ''
      };
    }

    _restoreRoot() {
      this._setViewHeader(false);
      this.bodyEl.classList.remove('pv-mode');
      if (this._rootFrag) {
        this.bodyEl.innerHTML = '';
        this.bodyEl.appendChild(this._rootFrag);
        this._rootFrag = null;
        var rh = this._rootHeader || {};
        this.nameEl.textContent = rh.name || '';
        this.subEl.textContent = rh.sub || '';
        this.avatarEl.innerHTML = rh.avatar || '';
        if (this._modelBtn) {
          // restore exactly what updateHeaderBtn left there (display is
          // '' (css default none) or 'flex' when a model is connected)
          if (rh.modelHTML) this._modelBtn.innerHTML = rh.modelHTML;
          this._modelBtn.style.display = rh.modelDisplay || '';
        }
        this.bodyEl.scrollTop = this._rootScroll;
      }
      this._rootHeader = null;
      // v0.33: a stacked view may have deferred the chat root's one-shot
      // async repaint (it can't write bodyEl while a view is open) —
      // poke the document; chatpanel.js listens and paints now that the
      // root is visible again.
      try { document.dispatchEvent(new CustomEvent('doomalay:root-restored')); } catch (e) {}
    }

    // fire onClose hooks + clear the stack + view chrome. KEEPS the
    // stash — closeViews() still needs it to restore the root.
    _teardownViews() {
      for (var i = 0; i < this.viewStack.length; i++) {
        var v = this.viewStack[i];
        if (v && v.onClose) { try { v.onClose(); } catch (e) {} }
      }
      this.viewStack = [];
      this.bodyEl.classList.remove('pv-mode');
      this._setViewHeader(false);
    }

    // discard the stashed root (open()/close() replace the body anyway)
    _dropStash() {
      this._rootFrag = null;
      this._rootHeader = null;
    }

    _setViewHeader(on, title) {
      if (this._backBtn) this._backBtn.style.display = on ? 'flex' : 'none';
      if (this._xBtn) this._xBtn.style.display = on ? 'flex' : 'none';
      if (this._modelBtn && on) this._modelBtn.style.display = 'none';
      if (on) {
        this.nameEl.textContent = title;
        this.nameEl.style.cursor = 'default';
        this.nameEl.removeAttribute('title');
      } else {
        this.nameEl.style.cursor = '';
        this.nameEl.setAttribute('title', 'Tap to rename');
      }
    }

    // live-persist the panel position for the current chat (full/default)
    _syncPosNow() {
      if (this.gestures && this.currentContext && this.currentContext.id) {
        try { rememberPos(this.currentContext.id, this.gestures.state()); } catch (e) {}
      }
    }

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
