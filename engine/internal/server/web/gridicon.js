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
    render(offsetX, offsetY, scale) {
      const s = scale || 1;
      const sx = (this.x - offsetX) * s;
      const sy = (this.y - offsetY) * s;
      this.el.style.transform =
        'translate3d(' + sx + 'px,' + sy + 'px,0) translate(-50%,-50%) scale(' + s + ')';
    }

    // ── Tap-flash animation ──────────────────────────────────────
    flash() {
      this.el.classList.add('tapped');
      const self = this;
      setTimeout(function () { self.el.classList.remove('tapped'); }, 400);
    }

    // ── Serialization ────────────────────────────────────────────
    serialize() {
      return {
        type: this.type,
        id: this.id,
        x: this.x, y: this.y,
        vx: this.vx, vy: this.vy,
        radius: this.radius
      };
    }
  }

  window.GridIcon = { GridIcon, register, create };
})();
