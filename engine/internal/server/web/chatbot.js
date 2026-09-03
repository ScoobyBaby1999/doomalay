// chatbot.js — ChatIcon: a GridIcon representing a chat conversation.
//
// ChatIcon extends GridIcon (the modular base). It adds name, family,
// iconIndex. The slide-up panel shows chat UI (placeholder for now —
// the real chat interface comes in a future commit).
//
// Also exports NamePicker + IconPicker (unchanged from v0.7.0).
//
// Depends on: window.Physics.Entity (from physics.js)
//             window.GridIcon.GridIcon (from gridicon.js)
//             window.DoomalayConfig (set by app.js)
//
// Exposes: window.ChatIcon = { ChatIcon, NamePicker, IconPicker }
// Registers: GridIcon.register('chat', factory)

(function () {
  'use strict';

  const GridIcon = window.GridIcon.GridIcon;
  const register = window.GridIcon.register;

  // ── NamePicker ─────────────────────────────────────────────────
  // Picks a name not currently in use anywhere on the canvas.
  // If every name is in use, allows repeats.
  class NamePicker {
    constructor(names) {
      this.names = Array.isArray(names) ? [...names] : [];
    }
    pick(usedNames) {
      const used = usedNames instanceof Set ? usedNames : new Set(usedNames);
      const available = this.names.filter(n => !used.has(n));
      const pool = available.length > 0 ? available : this.names;
      if (pool.length === 0) return "Chatbot";
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // ── IconPicker ─────────────────────────────────────────────────
  // One IconPicker per family. No-repeat-until-exhausted rule, per-family.
  class IconPicker {
    constructor(family, iconSet) {
      this.family = family;
      this.iconSet = Array.isArray(iconSet) ? iconSet : [];
    }
    pick(usedIndices) {
      if (this.iconSet.length === 0) return -1;
      const used = usedIndices instanceof Set ? usedIndices : new Set(usedIndices);
      const allIndices = this.iconSet.map((_, i) => i);
      const available = allIndices.filter(i => !used.has(i));
      const pool = available.length > 0 ? available : allIndices;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // ── ChatIcon ────────────────────────────────────────────────────
  // A GridIcon representing a chat conversation.
  let nextId = 1;

  class ChatIcon extends GridIcon {
    constructor({ id, name, family, iconIndex, x, y, vx = 0, vy = 0, radius = 28 }) {
      super({ id: id || ('chat_' + nextId++), type: 'chat', x, y, radius });
      this.name = name;
      this.family = family;
      this.iconIndex = (typeof iconIndex === 'number') ? iconIndex : -1;
      this.vx = vx;
      this.vy = vy;

      // Build the DOM element: icon circle + name label.
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

    _renderIcon() {
      const cfg = window.DoomalayConfig;
      const fam = (cfg && cfg.families && cfg.families[this.family]) ||
                  (cfg && cfg.families && cfg.families.default) ||
                  { color: '#4a4a5e', icons: [] };
      const iconSet = fam.icons || [];

      this._iconEl.innerHTML = '';
      this._iconEl.style.background = '';

      if (this.iconIndex >= 0 && this.iconIndex < iconSet.length) {
        const img = document.createElement('img');
        img.src = iconSet[this.iconIndex];
        img.alt = this.name;
        img.draggable = false;
        this._iconEl.appendChild(img);
      } else {
        this._iconEl.style.background = fam.color || '#4a4a5e';
        this._iconEl.textContent = (this.name || '?').charAt(0).toUpperCase();
      }
    }

    setFamily(family, iconIndex) {
      this.family = family;
      if (typeof iconIndex === 'number') this.iconIndex = iconIndex;
      this._renderIcon();
    }

    setName(name) {
      this.name = name;
      this._nameEl.textContent = name;
      this._renderIcon();
    }

    // ── Panel content (overrides GridIcon) ──────────────────────
    getPanelTitle() { return this.name || 'Chat'; }
    getPanelSubtitle() {
      const cfg = window.DoomalayConfig;
      const fam = (cfg && cfg.families && cfg.families[this.family]) || {};
      return (fam.label || this.family) + ' · ' + this.id;
    }
    getAvatarHTML() {
      const cfg = window.DoomalayConfig;
      const fam = (cfg && cfg.families && cfg.families[this.family]) || {};
      if (this.iconIndex >= 0 && fam.icons && this.iconIndex < fam.icons.length) {
        return '<img src="' + fam.icons[this.iconIndex] + '" alt="' + this.name + '">';
      }
      return (this.name || '?').charAt(0).toUpperCase();
    }
    getPanelBodyHTML() {
      return '<div class="placeholder">' +
        'Chat interface goes here.<br>' +
        'Each chat has its own conversation, settings, and storage.<br><br>' +
        '<span style="color:#3a3a45;font-size:12px">Bot ID: ' + this.id + '</span>' +
        '</div>';
    }

    // ── Serialization ────────────────────────────────────────────
    serialize() {
      const base = super.serialize();
      base.name = this.name;
      base.family = this.family;
      base.iconIndex = this.iconIndex;
      return base;
    }

    static deserialize(data) {
      return new ChatIcon({
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

  // Register the 'chat' type so GridIcon.create() can build these from saved data.
  register('chat', function (data) { return ChatIcon.deserialize(data); });

  window.ChatIcon = { ChatIcon, NamePicker, IconPicker };
})();
