// chatbot.js — Chatbot entity + name/icon pickers.
//
// Depends on: window.Physics.Entity (from physics.js)
//             window.DoomalayConfig (set by app.js — holds the loaded
//             names + families config)
//
// Exposes: window.Chatbot = { Chatbot, NamePicker, IconPicker }
//
// Rules implemented here:
//   • NamePicker — picks a name not currently in use anywhere on the
//     canvas. If every name is in use, allows repeats. This is the
//     "no-repeat-until-exhausted" rule from the spec.
//   • IconPicker — same rule, but per-family (each family has its own
//     icon set, so each family has its own no-repeat cycle).
//   • When the active model family changes, all chatbots re-pick an
//     icon from the new family's set (still no-repeat).

(function () {
  'use strict';

  const Entity = window.Physics.Entity;

  // ── NamePicker ─────────────────────────────────────────────────
  // The pool of names is the user-editable list from /config/names.json.
  // `pick(usedNames)` returns a name from the pool that's not currently
  // in `usedNames` (a Set of names already assigned to chatbots on the
  // canvas). If every name is in use, falls back to a random pick from
  // the full pool — this is the "reuse names" case from the spec.
  class NamePicker {
    constructor(names) {
      this.names = Array.isArray(names) ? [...names] : [];
    }

    pick(usedNames) {
      const used = usedNames instanceof Set ? usedNames : new Set(usedNames);
      const available = this.names.filter(n => !used.has(n));
      const pool = available.length > 0 ? available : this.names;
      if (pool.length === 0) return "Chatbot";  // ultimate fallback
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // ── IconPicker ─────────────────────────────────────────────────
  // One IconPicker per family. `pick(usedIndices)` returns an index
  // into the family's `iconSet` array that's not currently in
  // `usedIndices`. If every index is in use (or iconSet is empty),
  // allows repeats (or returns -1 for "use placeholder").
  class IconPicker {
    constructor(family, iconSet) {
      this.family = family;
      this.iconSet = Array.isArray(iconSet) ? iconSet : [];
    }

    pick(usedIndices) {
      if (this.iconSet.length === 0) return -1;  // no real icons → placeholder
      const used = usedIndices instanceof Set ? usedIndices : new Set(usedIndices);
      const allIndices = this.iconSet.map((_, i) => i);
      const available = allIndices.filter(i => !used.has(i));
      const pool = available.length > 0 ? available : allIndices;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // ── Chatbot ────────────────────────────────────────────────────
  // A chatbot is an Entity with a name, family, iconIndex, and a
  // corresponding DOM element. The element is created in the
  // constructor and appended to #chatbots by the caller.
  let nextId = 1;

  class Chatbot extends Entity {
    constructor({ id, name, family, iconIndex, x, y, vx = 0, vy = 0, radius = 28 }) {
      super({ id: id || ('cb_' + nextId++), x, y, radius, mass: 1 });
      this.name = name;
      this.family = family;
      this.iconIndex = (typeof iconIndex === 'number') ? iconIndex : -1;
      this.vx = vx;
      this.vy = vy;

      // Build the DOM element once. Subsequent updates only touch
      // innerHTML / inline styles, not the element itself.
      this.el = document.createElement('div');
      this.el.className = 'chatbot';
      this.el.dataset.id = this.id;

      const icon = document.createElement('div');
      icon.className = 'icon';
      this._iconEl = icon;
      this.el.appendChild(icon);

      const nameLabel = document.createElement('div');
      nameLabel.className = 'name';
      nameLabel.textContent = this.name;
      this._nameEl = nameLabel;
      this.el.appendChild(nameLabel);

      this._renderIcon();
    }

    // Re-render the icon based on family + iconIndex.
    // If the family has real icons and iconIndex is valid → use the SVG.
    // Otherwise → placeholder: colored circle with the first letter of
    // the chatbot's name.
    _renderIcon() {
      const cfg = window.DoomalayConfig;
      const fam = (cfg && cfg.families && cfg.families[this.family]) ||
                  (cfg && cfg.families && cfg.families.default) ||
                  { color: '#4a4a5e', icons: [] };
      const iconSet = fam.icons || [];

      this._iconEl.innerHTML = '';
      this._iconEl.style.background = '';  // clear any inline bg from prior render

      if (this.iconIndex >= 0 && this.iconIndex < iconSet.length) {
        // Real icon — SVG/PNG file
        const img = document.createElement('img');
        img.src = iconSet[this.iconIndex];
        img.alt = this.name;
        img.draggable = false;
        this._iconEl.appendChild(img);
      } else {
        // Placeholder: family color + first letter of name
        this._iconEl.style.background = fam.color || '#4a4a5e';
        this._iconEl.textContent = (this.name || '?').charAt(0).toUpperCase();
      }
    }

    // Update family + icon (called by setFamily() in app.js when the
    // active model family changes).
    setFamily(family, iconIndex) {
      this.family = family;
      if (typeof iconIndex === 'number') this.iconIndex = iconIndex;
      this._renderIcon();
    }

    setName(name) {
      this.name = name;
      this._nameEl.textContent = name;
      this._renderIcon();  // placeholder shows the first letter, so re-render
    }

    // Position the DOM element on screen. World (this.x, this.y) →
    // screen (sx, sy) by subtracting the canvas pan offset.
    render(offsetX, offsetY) {
      const sx = this.x - offsetX;
      const sy = this.y - offsetY;
      // translate3d for GPU acceleration; translate(-50%, -50%) to
      // center the element on (sx, sy).
      this.el.style.transform =
        'translate3d(' + sx + 'px,' + sy + 'px,0) translate(-50%,-50%)';
    }

    // Serialize for localStorage persistence.
    serialize() {
      return {
        id: this.id,
        name: this.name,
        family: this.family,
        iconIndex: this.iconIndex,
        x: this.x, y: this.y,
        vx: this.vx, vy: this.vy,
        radius: this.radius
      };
    }

    // Restore from localStorage data.
    static deserialize(data) {
      return new Chatbot({
        id: data.id,
        name: data.name,
        family: data.family,
        iconIndex: data.iconIndex,
        x: data.x, y: data.y,
        vx: data.vx || 0, vy: data.vy || 0,
        radius: data.radius || 28
      });
    }
  }

  window.Chatbot = { Chatbot, NamePicker, IconPicker };
})();
