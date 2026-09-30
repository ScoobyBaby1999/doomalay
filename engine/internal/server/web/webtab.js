// webtab.js — v0.85.3 THE MULTI-TAB BROWSER · PART 1: THE CANVAS ENTITY.
//
// USER SPEC (verbatim): "Let's rework how the browser in browser panel
// works and try to add support for multiple tabs. Each tab has its own
// icon and acts kind of like its own chatbot, holding down the canvas
// should yield two options, new chat (rename it to new bot) and new tab.
// New bot creates a chat panel, new tab creates a browser in browser
// panel, that saves the current website address it holds and scroll
// position within that website, ext.. therefore we expand our browser in
// browser to allow for multiple tabs, or multiple icons within the
// canvas. The canvas icon should ideally try and be dynamic from
// whatever the website icon is they are visiting, if that's complex,
// let's just have it a placeholder icon for now. With a method to change
// it using our gradient coloring theme system."
//
// THE MODEL — a browser TAB is a canvas ENTITY, exactly like a chat:
//   · WebIcon (GridIcon type 'web') — draggable, physics-enabled,
//     serialized into the SAME saved layout as chats (position, velocity
//     — plus the TAB STATE: url / title / favicon / scrollY);
//   · tapping it opens the BROWSER-IN-BROWSER panel (webpanel.js) at
//     its saved address — "each tab has its own icon and acts kind of
//     like its own chatbot";
//   · multiple tabs = multiple icons on the canvas (the "multiple icons
//     within the canvas" arm of the spec);
//   · THE ICON: dynamic from the site's favicon (the engine's
//     /api/preview verdict carries it — reliable, no client-side
//     cross-origin scraping); when there is none (or the user prefers
//     the placeholder), the disc paints a GRADIENT from the coloring
//     theme system: the entity's own spec when customized, else the
//     THEME's accent → accent-2 (live-resolved each render — every
//     theme switch re-tints it) + the globe glyph.
//
// STATE PERSISTENCE — everything the spec lists ("the current website
// address it holds and scroll position within that website, ext.."):
//   url, title, favicon, scrollY (saved best-effort — same-origin
//   iframes are readable; cross-origin ones are the browser's business
//   and the engine's /api/preview carries the address truth), plus the
//   icon's gradient spec + iconMode.
//
// Exposes: window.WebIcon = { WebIcon }
// Registers: GridIcon.register('web', factory)
//            window.WebTabs = { createAt, createAtCenterAndOpen, all, count }
(function () {
  'use strict';

  const GridIcon = window.GridIcon.GridIcon;
  const register = window.GridIcon.register;

  const GLOBE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:26px;height:26px;fill:currentColor;opacity:.92"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2 12h20" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  function newWebId() {
    return 'web_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  // themeGradientCSS — the DISC's gradient paint. A customized spec
  // rides verbatim; the default follows the LIVE theme vars (accent →
  // accent-2) so every theme switch re-tints every placeholder tab.
  function themeGradientCSS(spec) {
    if (spec && Array.isArray(spec.colors) && spec.colors.length) {
      var stops = spec.colors.filter(function (c) { return /^#[0-9a-fA-F]{6}$/.test(c); });
      if (stops.length) {
        var dir = (spec && spec.dir) || 'auto';
        var ang = (typeof (spec && spec.angle) === 'number') ? spec.angle : 135;
        var to = 'to bottom right';
        if (dir === 'h') to = 'to right';
        else if (dir === 'v') to = 'to bottom';
        else if (dir === 'diag2') to = 'to top right';
        else if (dir === 'radial') {
          return 'radial-gradient(circle at 35% 30%, ' + stops.join(', ') + ')';
        } else if (dir === 'auto' && ang !== 135) {
          to = ang + 'deg';
        }
        return 'linear-gradient(' + to + ', ' + stops.join(', ') + ')';
      }
    }
    var acc = 'var(--accent)', acc2 = 'var(--accent-2)';
    return 'linear-gradient(135deg, ' + acc + ', ' + acc2 + ')';
  }

  class WebIcon extends GridIcon {
    constructor({ id, url = '', title = '', favicon = '', scrollY = 0,
                   iconMode = 'auto', gradient = null, x, y,
                   vx = 0, vy = 0, radius = 28 }) {
      super({ id: id || newWebId(), type: 'web', x, y, radius });
      this.url = url;
      this.title = title || '';
      this.favicon = favicon || '';
      this.scrollY = Number(scrollY) || 0;
      this.iconMode = (iconMode === 'gradient') ? 'gradient' : 'auto';
      this.gradient = gradient || null;   // null → the live theme pair
      this.vx = vx; this.vy = vy;

      const icon = document.createElement('div');
      icon.className = 'icon';
      this._iconEl = icon;
      this.el.appendChild(icon);

      const nameLabel = document.createElement('div');
      nameLabel.className = 'name';
      this._nameEl = nameLabel;
      this.el.appendChild(nameLabel);

      this._renderIcon();
    }

    // ── the tab's live state ─────────────────────────────────────
    host() { return hostOf(this.url); }

    setTabState(st) {
      st = st || {};
      if (typeof st.url === 'string' && st.url && st.url !== this.url) {
        this.url = st.url;
      }
      if (typeof st.title === 'string' && st.title) this.title = st.title;
      if (typeof st.favicon === 'string' && st.favicon) this.favicon = st.favicon;
      if (typeof st.scrollY === 'number' && st.scrollY >= 0) this.scrollY = st.scrollY;
      this._renderIcon();
      this.save();
    }

    setIconMode(mode) {
      this.iconMode = (mode === 'gradient') ? 'gradient' : 'auto';
      this._renderIcon();
      this.save();
    }

    setGradient(spec) {
      this.gradient = spec || null;
      if (this.gradient) this.iconMode = 'gradient';
      this._renderIcon();
      this.save();
    }

    save() {
      if (typeof window.doomalay !== 'undefined' && window.doomalay.scheduleSave) {
        window.doomalay.scheduleSave();
      }
    }

    // ── the disc: favicon → gradient placeholder ────────────────
    _renderIcon() {
      this._iconEl.innerHTML = '';
      this._iconEl.style.backgroundColor = '';
      this._iconEl.style.backgroundImage = '';
      this._iconEl.style.color = '';
      this._iconEl.title = this.title || this.url || '';

      var showFavicon = this.iconMode === 'auto' && this.favicon;
      if (showFavicon) {
        const img = document.createElement('img');
        img.src = this.favicon;
        img.alt = this.title || this.host() || 'tab';
        img.draggable = false;
        // a dead favicon (site dropped it / offline) falls back to the
        // gradient placeholder instead of the broken-image glyph
        img.addEventListener('error', () => {
          if (this._iconEl.contains(img)) {
            this._iconEl.innerHTML = '';
            this._paintGradient();
          }
        });
        this._iconEl.appendChild(img);
      } else {
        this._paintGradient();
      }
      this._nameEl.textContent = this.host() || (this.title || 'New Tab');
    }

    _paintGradient() {
      this._iconEl.style.backgroundImage = themeGradientCSS(this.gradient);
      this._iconEl.style.color = 'var(--text-1)';
      this._iconEl.innerHTML = '<span class="wt-glyph">' + GLOBE_SVG + '</span>';
    }

    // ── Panel content (overrides GridIcon) ──────────────────────
    getPanelTitle() { return this.host() || this.title || 'New Tab'; }
    getPanelSubtitle() { return this.url ? 'browser tab · ' + this.url : 'browser tab'; }
    getAvatarHTML() {
      if (this.iconMode === 'auto' && this.favicon) {
        return '<img src="' + this.favicon + '" alt="' + (this.title || this.host()) + '">';
      }
      return '<span class="wt-avatar" style="background-image:' + themeGradientCSS(this.gradient) + '">' + GLOBE_SVG + '</span>';
    }
    // app.js hands the body to WebPanel.render (the live browser view).
    getPanelBodyHTML() { return '<div class="wt-loading">Loading…</div>'; }

    // ── Serialization ────────────────────────────────────────────
    serialize() {
      const base = super.serialize();
      base.url = this.url;
      base.title = this.title;
      base.favicon = this.favicon;
      base.scrollY = this.scrollY;
      base.iconMode = this.iconMode;
      base.gradient = this.gradient;
      return base;
    }

    static deserialize(data) {
      return new WebIcon({
        id: data.id,
        url: data.url || '',
        title: data.title || '',
        favicon: data.favicon || '',
        scrollY: data.scrollY || 0,
        iconMode: data.iconMode || 'auto',
        gradient: data.gradient || null,
        x: data.x, y: data.y,
        vx: data.vx || 0, vy: data.vy || 0,
        radius: data.radius || 28
      });
    }
  }

  register('web', function (data) { return WebIcon.deserialize(data); });

  // ── THE CONTROLLER ────────────────────────────────────────────────
  // window.WebTabs — the creation paths the dock's ＋ sub-expansion and
  // the long-press menu call. createAtCenterAndOpen mirrors the chat
  // path exactly: viewport center, the creation nudge, open via the
  // canvas tap sequence (flash → 150ms → panel).
  var WebTabs = {
    createAt: function (worldX, worldY, opts) {
      opts = opts || {};
      var icon = new WebIcon({
        x: worldX, y: worldY,
        url: opts.url || '',
        title: opts.title || '',
        favicon: opts.favicon || ''
      });
      if (typeof window.doomalay !== 'undefined' && window.doomalay.addEntity) {
        window.doomalay.addEntity(icon);
      }
      return icon;
    },
    all: function () {
      var w = (typeof window.doomalay !== 'undefined') ? window.doomalay.world : null;
      var list = w && w.entities ? w.entities : [];
      return list.filter(function (e) { return e && e.type === 'web'; });
    },
    count: function () { return WebTabs.all().length; },
    createAtCenterAndOpen: function (opts) {
      if (typeof window.doomalay !== 'undefined' && window.doomalay.createWebTabAtCenterAndOpen) {
        return window.doomalay.createWebTabAtCenterAndOpen(opts);
      }
      return null;
    }
  };
  window.WebTabs = WebTabs;

  window.WebIcon = { WebIcon: WebIcon };
})();
