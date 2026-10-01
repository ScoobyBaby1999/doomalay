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
//            window.WebTabs = { createAt, createAtCenterAndOpen, all, count,
//                                openNative, sheetTabOf }
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
                   iconMode = 'auto', gradient = null, imageData = '',
                   tweaks = null, x, y,
                   vx = 0, vy = 0, radius = 28 }) {
      super({ id: id || newWebId(), type: 'web', x, y, radius });
      this.url = url;
      this.title = title || '';
      this.favicon = favicon || '';
      this.scrollY = Number(scrollY) || 0;
      this.iconMode = ['auto', 'gradient', 'image'].indexOf(iconMode) >= 0 ? iconMode : 'auto';
      this.gradient = gradient || null;   // null → the live theme pair
      // v0.87.4: the uploaded icon (a small square dataURL, ≤128px) —
      // PINNED: while set (iconMode 'image'), the dynamic favicon
      // refresh never re-derives the icon (the user's addendum).
      this.imageData = imageData || '';
      // v0.87.4: the per-tab browser tweaks blob (text sizes, colors,
      // filters — webtweaks.js owns the shape; absent = defaults).
      this.tweaks = tweaks || null;
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
      if (typeof st.favicon === 'string' && st.favicon) {
        this.favicon = st.favicon;
        // v0.87.2: which host this favicon speaks for (the fast-refresh
        // race guard — a late fallback never clobbers a better icon)
        this._favHost = hostOf(this.url);
      }
      if (typeof st.scrollY === 'number' && st.scrollY >= 0) this.scrollY = st.scrollY;
      this._renderIcon();
      this._notifyIcon();
      this.save();
    }

    // v0.87.1: iconSrc — the single resolution every mirror of the tab
    // icon consults (the canvas disc, the panel-header circle, the native
    // sheet's circle): the site favicon in 'auto' mode, the uploaded image
    // in 'image' mode, null in 'gradient' mode (the caller paints the
    // gradient). The DYNAMIC favicon refresh (refreshIcon, v0.87.2) only
    // ever touches 'auto' — a user-changed icon (image / custom gradient)
    // is PINNED and never re-derived from the site (the user's addendum:
    // "if the user changes the icon of the tab it shouldn't keep
    // dynamically reflecting the new website logo").
    iconSrc() {
      if (this.iconMode === 'image' && this.imageData) return this.imageData;
      if (this.iconMode === 'auto' && this.favicon) return this.favicon;
      return null;
    }

    // v0.87.1: _notifyIcon — every icon mutation (setTabState / setIconMode
    // / setImageIcon / setGradient / refreshIcon) ends here: one event,
    // every live mirror (the panel circle, future surfaces) repaints from
    // it. The canvas disc repaints inside _renderIcon itself.
    _notifyIcon() {
      try {
        document.dispatchEvent(new CustomEvent('doomalay:tab-icon', {
          detail: { id: this.id, icon: this }
        }));
      } catch (e) {}
    }

    setIconMode(mode) {
      // v0.87.4: 'image' joins the modes (the uploaded icon); anything
      // unknown falls back to 'auto' (the dynamic site icon).
      this.iconMode = (mode === 'gradient' || mode === 'image') ? mode : 'auto';
      this._renderIcon();
      this._notifyIcon();
      this.save();
    }

    setGradient(spec) {
      this.gradient = spec || null;
      if (this.gradient) this.iconMode = 'gradient';
      this._renderIcon();
      this._notifyIcon();
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
      var showImage = this.iconMode === 'image' && this.imageData;
      if (showImage) {
        const img = document.createElement('img');
        img.src = this.imageData;
        img.alt = this.title || this.host() || 'tab';
        img.draggable = false;
        this._iconEl.appendChild(img);
      } else if (showFavicon) {
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

    // v0.87.1: themeGradientCSS — exposed so app.js's panel circle (and
    // any future mirror) paints the same gradient the canvas disc does.
    themeGradientCSS() { return themeGradientCSS(this.gradient); }

    // ── v0.87.2: THE FAST ICON REFRESH ─────────────────────────────
    // "I love how the canvas tab icon updates to show the website being
    // used… But it does so very slowly, let's have it quickly refresh
    // both icons to reflect the website that is being browsed."
    // refreshIcon(url) — the entity's address follows immediately; the
    // ICON re-derives through the engine's FAST favicon verdict (a
    // short-timeout <link rel=icon> parse with a favicon.ico probe and
    // the DuckDuckGo icon service as the fallback — linkpreview.go's
    // ?fast=1 lane, ~10× quicker than the full page verdict).
    //   · PINNED icons never re-derive: "if the user changes the icon
    //     of the tab it shouldn't keep dynamically reflecting the new
    //     website logo" — iconMode 'image'/'gradient' refresh the
    //     ADDRESS but keep the user's icon.
    //   · same-host moves never re-fetch (the favicon cannot have
    //     changed — DuckDuckGo result pages flip URLs constantly and
    //     would spam the endpoint).
    //   · a late fast answer never clobbers a better one that already
    //     landed (_favHost tracks which host the live favicon speaks
    //     for; the full verdict's favicon outranks the fallback).
    refreshIcon(url) {
      var u = url || this.url;
      if (!u || !/^https?:\/\//i.test(u)) return;
      // the favicon's OWN host ledger decides (_favHost — set when the
      // current icon landed): robust to EVERY call order, because the
      // guard's accept path (and the sheet sync) setTabState({url})
      // BEFORE calling here — a prevHost compare would collapse to
      // "unchanged" after the caller already moved the address (the
      // red-team caught both orderings).
      if (u !== this.url) this.setTabState({ url: u });
      var hostChanged = !this.favicon || (this._favHost || '') !== hostOf(u);
      if (this.iconMode !== 'auto') { this._pushNativeIcon(); return; }
      if (!hostChanged) return;   // same site — the icon holds
      var self = this;
      fetch('/api/preview?fast=1&url=' + encodeURIComponent(u))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (v) {
          if (!v || self.url !== u) return;       // the tab moved on
          var st = {};
          if (v.favicon) st.favicon = v.favicon;
          if (v.title) st.title = v.title;
          if (st.favicon || st.title) self.setTabState(st);
          self._pushNativeIcon();
        })
        .catch(function () { /* offline / unknown host — the icon stays */ });
    }

    // v0.87.1: push the tab's icon to the NATIVE sheet's circle (the
    // BIB builds' twin of the panel circle). No-op everywhere else.
    _pushNativeIcon() {
      try {
        var b = window.__doomalayKotlin;
        if (b && typeof b.panelIcon === 'function' &&
            window.WebTabs && window.WebTabs.sheetTabOf() === this) {
          b.panelIcon(JSON.stringify({
            id: this.id,
            icon: this.iconSrc() || '',
            gradient: (this.iconMode === 'gradient')
          }));
        }
      } catch (e) { /* bridge hiccup — the next refresh retries */ }
    }

    // v0.87.4: setImageIcon — the uploaded icon (a square dataURL from
    // the CropUI path in webtweaks.js). PINNED by design: the dynamic
    // favicon refresh checks iconMode and never overwrites it.
    setImageIcon(dataURL) {
      this.imageData = dataURL || '';
      this.iconMode = this.imageData ? 'image' : 'auto';
      this._renderIcon();
      this._notifyIcon();
      this.save();
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
      // v0.87.1: iconSrc() is the single resolution — the avatar, the
      // canvas disc, the panel circle and the native circle all agree.
      var src = this.iconSrc();
      if (src) {
        return '<img src="' + src + '" alt="' + (this.title || this.host()) + '">';
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
      base.imageData = this.imageData || '';
      base.tweaks = this.tweaks || null;
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
        imageData: data.imageData || '',
        tweaks: data.tweaks || null,
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
    },
    // v0.87.1: openNative — THE ONE PANEL on BIB-capable builds. The
    // doomalay master panel NEVER opens for a web tab there (the user
    // spec: "We only want one panel. Remove the one with the gradient
    // selector that doesn't work and the mini browser in panel view") —
    // the native sheet (a real top-level WebView) is the browser panel,
    // and the tab's state syncs back to the entity through the global
    // panel-state listener below (entity-level, not panel-level —
    // nothing needs the master panel to be open).
    openNative: function (icon) {
      if (!icon || !window.InAppBrowser) return false;
      sheetTab = icon;
      var u = icon.url || '';
      if (!u) { icon.url = u = 'https://duckduckgo.com'; }
      // v0.91.1: THE GROUP CONTRACT — the orbit's web-tab ids (the native
      // pool's protection set: tabs orbiting the same center act as a
      // group — their live instances survive the budget's LRU) + the
      // canvas's alive web ids (its sweep truth) ride every open,
      // refreshed per tap. Read defensively from the orbit's own state
      // (tabgroups.js is the parallel bot's file — this reads, never
      // edits).
      var group = [];
      try {
        var dot = icon._orbit && icon._orbit.dot;
        if (dot && dot.members) {
          dot.members.forEach(function (m) {
            if (m && m.type === 'web' && m.id) group.push(m.id);
          });
        }
      } catch (e) { group = []; }
      var alive = WebTabs.all().map(function (t) { return t.id; });
      var tier = window.InAppBrowser.open(u, {
        purpose: 'web',
        // the tab identity rides the opts — the native sheet's circle
        // (right of the dash, left of the ‹ back pill) paints from it;
        // group/alive ride along for the pool (v0.91.1)
        tab: {
          id: icon.id,
          icon: icon.iconSrc() || '',
          gradient: icon.iconMode === 'gradient',
          group: group,
          alive: alive
        }
      });
      return tier === 'native-panel';
    },
    // v0.87.1: the sheet's tab (for the state sync + the tweaks handoff)
    sheetTabOf: function () { return sheetTab; }
  };
  window.WebTabs = WebTabs;

  // ── v0.87.1: THE ENTITY-LEVEL SHEET SYNC ──────────────────────────
  // The native sheet broadcasts {open, ducked} on every state change
  // (PanelBrowserSheet.notifyState — fires on dock moves, ducks, closes
  // and every finished page from v0.87.2). The entity — not any panel —
  // owns the tab state: whenever the sheet reports in, the current URL
  // syncs back (the tab "saves the current website address it holds")
  // and a host change triggers the FAST favicon refresh (v0.87.2 —
  // only in 'auto' icon mode; a user-chosen image/gradient icon is
  // PINNED and never re-derived).
  var sheetTab = null;
  document.addEventListener('doomalay:panel-state', function (e) {
    var icon = sheetTab;
    if (!icon) return;
    // v0.91.1: the ACTIVE tab's identity rides the state (notifyState's
    // tabId) — the sync lands ONLY on the sheet's CURRENT tab (a plain
    // link open while a tab browsed used to write its URL into the stale
    // tab's entity — dead now). An absent tabId (pre-v0.91 bridges)
    // keeps the legacy behavior.
    var tid = e && e.detail && e.detail.tabId;
    if (tid && tid !== icon.id) return;
    try {
      var u = window.InAppBrowser && window.InAppBrowser.currentURL();
      if (u && /^https?:\/\//i.test(u) && u !== icon.url) {
        // the address follows + the fast favicon refresh runs (PINNED
        // icons keep the user's choice — only 'auto' re-derives)
        icon.refreshIcon(u);
      }
    } catch (err) { /* bridge hiccup — the next event retries */ }
  });

  window.WebIcon = { WebIcon: WebIcon };
})();
