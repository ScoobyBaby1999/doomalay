// gridicon.js — Base class for anything on the infinite grid.
//
// A GridIcon is a draggable, physics-enabled circle on the canvas with an
// associated DOM element. Subclasses (ChatIcon, PollIcon, MonitorIcon, …)
// override getPanelContent() to define what the slide-up panel shows when
// the icon is tapped.
//
// This is the modular base: any new icon type just extends GridIcon and
// registers itself. The app, panel, and physics don't need to know the
// specific type — they work with GridIcon instances uniformly.
//
// Exposes: window.GridIcon = { GridIcon, register, create }
//
// Subclasses MUST override:
//   getPanelTitle()      — string shown in the panel header
//   getPanelSubtitle()   — string shown under the title
//   getAvatarHTML()      — HTML string for the 40px avatar circle
//   getPanelBodyHTML()   — HTML string for the panel body
// Subclasses MAY override:
//   serialize()          — must include type + base fields
//   static deserialize()  — factory registered via register()

(function () {
  'use strict';

  const Entity = window.Physics.Entity;

  // v1.36.2 THE HELD THING (PLAN-V137 §2): the pin glyph — a lucide-shaped
  // pin drawn in currentColor so the badge's ink rides the theme's accent
  // (zero hard-coded colors; the .pin-badge CSS owns the ring + base).
  const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>';

  // Registry of icon types → factory functions.
  // Each factory takes a data object and returns a GridIcon instance.
  const registry = {};

  function register(type, factory) {
    registry[type] = factory;
  }

  function create(data) {
    // Migration: old saved data (v0.7.0) has no type field — treat as 'chat'.
    const type = data.type || 'chat';
    const factory = registry[type];
    if (!factory) {
      console.warn('GridIcon: unknown type "' + type + '"');
      return null;
    }
    return factory(data);
  }

  function generateId(type) {
    return type + '_' + Date.now().toString(36) + '_' +
           Math.floor(Math.random() * 1000);
  }

  // GridIcon — the base class.
  class GridIcon extends Entity {
    constructor({ id, type, x, y, radius = 28 }) {
      super({ id: id || generateId(type), x, y, radius, mass: 1 });
      this.type = type;
      // Create the base DOM element. Subclasses append children in their
      // constructor (after calling super).
      this.el = document.createElement('div');
      this.el.className = 'chatbot';  // shared CSS class (icon + name styles)
      this.el.dataset.id = this.id;
      this.el.dataset.type = type;
    }

    // ── Panel content (subclasses override) ──────────────────────
    getPanelTitle()    { return 'Icon'; }
    getPanelSubtitle() { return this.type; }
    getAvatarHTML()    { return ''; }
    getPanelBodyHTML() { return '<div class="placeholder">No content.</div>'; }

    // ── Position the DOM element on screen ───────────────────────
    // v0.88.2: a grouped tab's ORBIT owns x/y (tabgroups.js writes it
    // every frame); the tilted 3D plane's depth rides here — a subtle
    // scale swing + a y-lift (the stars' parallax language, tied to the
    // Parallax slider through tabgroups' depthK/liftK). v0.88.1-era: the
    // AMBIENT ICON-WRITE GUARD below stays (identical transforms skip
    // the style write; the orbit's slow drift changes the string rarely —
    // motion still writes because the string genuinely changes).
    render(offsetX, offsetY, scale) {
      // v1.57.2 THE RIDE (PLAN-V157 §2): when window.__doomalayIconRide
      // is on, the CAMERA lives on the #chatbots container (app.js
      // paintCameraRide writes translate3d(−ox·s, −oy·s)·scale(s) ONCE
      // per camera frame) and this icon's transform is CAMERA-FREE — a
      // plain icon writes its world position once and NEVER changes
      // during pans/momentum/glides/pinches (the __lastTf guard becomes
      // real during camera motion; before the ride, every camera frame
      // rewrote every in-view icon's string — 60 icons × 60fps =
      // 3,600 style writes/sec).
      // The orbit tilt (_orbitScale/_orbitLift) is a SCREEN-relative
      // effect — the legacy position is (x−ox)·scale·os, i.e. the
      // position scales by os AROUND THE SCREEN CENTER, which no
      // container transform can express. It rides by folding the camera
      // back in LOCALLY:
      //     px = x·os + ox·(1−os),  py = y·os + oy·(1−os) − lift/scale
      // Container·local ≡ the legacy matrix, term for term:
      //     screen_x = scale·px − scale·ox = scale·os·(x−ox)    ✓ legacy sx
      //     screen_y = scale·py − scale·oy = scale·os·(y−oy) − lift ✓ legacy sy
      //     visual scale = container·scale(scale) × local·scale(os)   ✓
      if (window.__doomalayIconRide) {
        const os = this._orbitScale || 1;
        const lift = (this._orbitLift || 0) / (scale || 1);
        const px = this.x * os + offsetX * (1 - os);
        const py = this.y * os + offsetY * (1 - os) - lift;
        const tf = 'translate3d(' + px + 'px,' + py + 'px,0) translate(-50%,-50%) scale(' + os + ')';
        if (this.__lastTf === tf) return;
        this.__lastTf = tf;
        this.el.style.transform = tf;
        try {
          if (window.DoomalayPerf) window.DoomalayPerf.iconWrites =
            (window.DoomalayPerf.iconWrites || 0) + 1;   // v1.57.2: the honest instrument
        } catch (e) {}
        return;
      }
      // legacy: the camera baked into every icon (the pre-v1.57.2 A/B
      // path — the v0.88.2 orbit notes above still govern both paths)
      const s = (scale || 1) * (this._orbitScale || 1);
      const sx = (this.x - offsetX) * s;
      const sy = (this.y - offsetY) * s - (this._orbitLift || 0);
      const tf = 'translate3d(' + sx + 'px,' + sy + 'px,0) translate(-50%,-50%) scale(' + s + ')';
      if (this.__lastTf === tf) return;
      this.__lastTf = tf;
      this.el.style.transform = tf;
      try {
        if (window.DoomalayPerf) window.DoomalayPerf.iconWrites =
          (window.DoomalayPerf.iconWrites || 0) + 1;   // v1.57.2: the honest instrument
      } catch (e) {}
    }

    // ── Tap-flash animation ──────────────────────────────────────
    flash() {
      this.el.classList.add('tapped');
      const self = this;
      setTimeout(function () { self.el.classList.remove('tapped'); }, 200);
    }

    // ── v1.36.2: THE PIN (the icon-hold menu's pin row) ──────────
    // A pinned icon wears the themed pin badge (top-left, the sandbox
    // badge's mirror) + rides serialize() so the pin survives reloads.
    // The pin ALSO gates the off-screen indicator (app.js computeArrows:
    // only pinned icons get one — the user's default-off law) and floats
    // the chat to the Pinned section of the all-chats panel.
    refreshPinBadge() {
      const old = this._pinBadgeEl;
      if (!this.pinned) {
        this._pinBadgeEl = null;
        if (old) old.remove();
        return;
      }
      if (old) return;   // already worn — the identity guard (no DOM churn)
      const badge = document.createElement('div');
      badge.className = 'pin-badge';
      badge.innerHTML = PIN_SVG;
      badge.title = 'pinned — first in all chats · carries the off-screen indicator';
      badge.setAttribute('aria-label', badge.title);
      this.el.appendChild(badge);
      this._pinBadgeEl = badge;
    }

    // ── Serialization ────────────────────────────────────────────
    serialize() {
      return {
        type: this.type,
        id: this.id,
        x: this.x, y: this.y,
        vx: this.vx, vy: this.vy,
        radius: this.radius,
        pinned: !!this.pinned   // v1.36.2: the pin survives reloads
      };
    }
  }

  window.GridIcon = { GridIcon, register, create, PIN_SVG };
})();
