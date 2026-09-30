// webpanel.js — v0.85.3 THE MULTI-TAB BROWSER · PART 2: THE PANEL VIEW.
//
// The browser-in-browser PANEL a web tab opens (the master panel's body,
// exactly where a chat's ChatPanel renders — "each tab has its own icon
// and acts kind of like its own chatbot"). Two surfaces:
//
// THE APK (BIB-capable, window.__doomalayKotlin.openPanel): the NATIVE
//   panel browser (PanelBrowserSheet — a real top-level WebView that
//   loads every page) owns the browse: WebPanel fires
//   InAppBrowser.open(icon.url, {purpose:'web'}) on open, paints a
//   compact "docked in the panel browser" card behind it, and syncs the
//   entity's URL back from the bridge whenever the sheet reports state
//   (doomalay:panel-state) — the tab SAVES its current address. The
//   sheet's own WebView holds the live scroll; the entity carries the
//   address + favicon + title (the engine verdict refreshes both).
//
// EVERYWHERE ELSE (desktop / HF Space / self-host / phone browsers):
//   the full in-panel browser —
//   · THE OMNIBOX row (address + go + the ↗ external escape);
//   · THE FRAME: the engine's /api/preview verdict decides — frameable
//     pages render in a sandboxed IFRAME; frame-refusers (X-Frame-
//     Options / CSP frame-ancestors — the v0.63.4 lesson) get the
//     honest card (title + favicon + og-image + description + [open in
//     a window] [open externally]) instead of a blank white rect;
//   · TAB STATE: every navigation updates the entity (url, title,
//     favicon — the site's icon from the verdict, "the canvas icon
//     should ideally try and be dynamic from whatever the website icon
//     is they are visiting") and the panel CLOSE saves the scroll
//     position (same-origin frames read + restore it exactly; cross-
//     origin frames are the browser's sealed box — saved best-effort,
//     honestly);
//   · THE ICON ROW: the placeholder disc's GRADIENT rides the coloring
//     theme system — the GradientUI editor (uikit) edits the entity's
//     own spec live; a favicon toggle switches between the site's icon
//     and the gradient.
//
// Exposes: window.WebPanel = { render, navigate }
(function () {
  'use strict';

  var START_URL = 'https://duckduckgo.com';
  var activeCtx = null;   // { icon, panel, root, frame, omni, verdict }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isBibCapable() {
    var b = window.__doomalayKotlin;
    return !!(b && typeof b.openPanel === 'function');
  }

  // ── omnibox input → a real URL (search queries ride DuckDuckGo) ──
  function normalizeInput(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(v) && v.indexOf(' ') < 0) {
      return 'https://' + v;
    }
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  // ── the verdict (engine /api/preview — cached 1h engine-side) ─────
  function fetchVerdict(url) {
    return fetch('/api/preview?url=' + encodeURIComponent(url))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return null; });
  }

  // ══ THE RENDER ════════════════════════════════════════════════════
  function render(bodyEl, icon, panel) {
    if (!bodyEl || !icon) return;
    teardown();
    bodyEl.innerHTML = '';   // drop the static placeholder HTML

    var root = document.createElement('div');
    root.className = 'wt-root';
    bodyEl.appendChild(root);

    var ctx = { icon: icon, panel: panel, root: root, frame: null, omni: null, verdict: null };
    activeCtx = ctx;

    // THE OMNIBOX (always present — the tab's address, editable)
    root.innerHTML =
      '<div class="wt-bar">' +
        '<input class="wt-omni" type="text" inputmode="url" enterkeyhint="go"' +
          ' placeholder="search or type a url" value="' + esc(icon.url || '') + '"' +
          ' aria-label="Address or search query">' +
        '<button class="wt-go" type="button" aria-label="Go">' +
          '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        '<button class="wt-ext" type="button" aria-label="Open in your browser" title="Open in your browser">' +
          '<svg viewBox="0 0 24 24"><path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="wt-frame" role="region" aria-label="Web page"></div>' +
      '<div class="wt-side"></div>';

    ctx.omni = root.querySelector('.wt-omni');
    ctx.frame = root.querySelector('.wt-frame');
    var goBtn = root.querySelector('.wt-go');
    var extBtn = root.querySelector('.wt-ext');

    ctx.omni.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); navigate(ctx.omni.value, ctx); }
    });
    goBtn.addEventListener('click', function () { navigate(ctx.omni.value, ctx); });
    extBtn.addEventListener('click', function () {
      var u = normalizeInput(ctx.omni.value) || icon.url || START_URL;
      if (window.InAppBrowser) window.InAppBrowser.external(u);
      else if (window.Hub && window.Hub.toast) window.Hub.toast('opened externally');
    });

    // the icon row (favicon toggle + the gradient editor) — the side
    // panel keeps the browser chrome clean
    buildSidePanel(root.querySelector('.wt-side'), icon);

    // v0.85.3 APK: the native sheet owns the browse — fire it on open.
    if (isBibCapable()) {
      wireNativeSync(ctx);
      var u0 = icon.url || START_URL;
      paintDocked(ctx, u0);
      if (window.InAppBrowser) window.InAppBrowser.open(u0, { purpose: 'web' });
      return;
    }

    // the SPA browser: land on the tab's saved address (or the start
    // page's omnibox-focus first-run feel — empty tab = focus, no load)
    if (icon.url) navigate(icon.url, ctx, { restore: true });
    else ctx.omni.focus();
  }

  // ── navigation: verdict → iframe | card; state → entity ──────────
  function navigate(input, ctx, opts) {
    opts = opts || {};
    var url = normalizeInput(input);
    if (!url) return;
    ctx.omni.value = url;
    ctx.frame.innerHTML = '<div class="wt-loading"><span>·</span><span>·</span><span>·</span></div>';

    fetchVerdict(url).then(function (v) {
      if (!activeCtx || activeCtx !== ctx || !ctx.frame) return;   // superseded
      ctx.verdict = v;
      var kind = (v && v.type) || 'html';
      var frameable = !!(v && v.frameable) || kind === 'image' || kind === 'video' ||
        kind === 'audio' || kind === 'pdf' || kind === 'youtube';

      // the entity's saved state — the address, the title, the site's
      // favicon (the dynamic canvas icon, straight from the verdict)
      var st = { url: (v && v.url) || url };
      if (v && v.title) st.title = v.title;
      if (v && v.favicon) st.favicon = v.favicon;
      ctx.icon.setTabState(st);

      if (frameable && !v.login_redirect) {
        paintFrame(ctx, (v && v.url) || url, opts.restore);
      } else {
        paintCard(ctx, (v && v.url) || url, v, !!v && !!v.login_redirect);
      }
    });
  }

  function paintFrame(ctx, url, restore) {
    var f = document.createElement('iframe');
    f.className = 'wt-iframe';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    f.setAttribute('title', hostOf(url) || 'page');
    f.src = url;
    // scroll restore (same-origin only — a cross-origin frame's scroll
    // is sealed; restore is best-effort by design)
    f.addEventListener('load', function () {
      try {
        if (restore && ctx.icon.scrollY > 0 &&
            f.contentWindow && f.contentWindow.document) {
          f.contentWindow.scrollTo(0, ctx.icon.scrollY);
        }
      } catch (e) { /* cross-origin — sealed */ }
    });
    ctx.frame.innerHTML = '';
    ctx.frame.appendChild(f);
    ctx.iframe = f;
  }

  function paintCard(ctx, url, v, loginRedirect) {
    var host = hostOf(url) || url;
    var title = (v && v.title) || host;
    var fav = (v && v.favicon) || '';
    var desc = (v && v.description) || '';
    var img = (v && v.image) || '';
    var why = loginRedirect
      ? 'this page sits behind a sign-in redirect — it cannot embed'
      : 'this site refuses to be embedded (X-Frame-Options / CSP) — the honest card, never a blank frame';
    ctx.frame.innerHTML =
      '<div class="wt-card">' +
        (fav ? '<img class="wt-card-fav" src="' + esc(fav) + '" alt="">' : '') +
        '<div class="wt-card-title">' + esc(title) + '</div>' +
        '<div class="wt-card-url">' + esc(host) + '</div>' +
        (desc ? '<div class="wt-card-desc">' + esc(desc) + '</div>' : '') +
        (img ? '<img class="wt-card-img" src="' + esc(img) + '" alt="" loading="lazy">' : '') +
        '<div class="wt-card-why">' + esc(why) + '</div>' +
        '<div class="wt-card-row">' +
          '<button type="button" class="wt-card-btn wt-win">⧉ open in a window</button>' +
          '<button type="button" class="wt-card-btn wt-ext2">↗ open externally</button>' +
        '</div>' +
      '</div>';
    var winBtn = ctx.frame.querySelector('.wt-win');
    if (winBtn) winBtn.addEventListener('click', function () {
      if (window.InAppBrowser) window.InAppBrowser.fallback(url, {});
    });
    var ext2 = ctx.frame.querySelector('.wt-ext2');
    if (ext2) ext2.addEventListener('click', function () {
      if (window.InAppBrowser) window.InAppBrowser.external(url);
    });
    ctx.iframe = null;
  }

  // ── the APK native-sheet path ─────────────────────────────────────
  function paintDocked(ctx, url) {
    var host = hostOf(url) || (url ? url : 'new tab');
    ctx.frame.innerHTML =
      '<div class="wt-docked">' +
        '<div class="wt-dock-pill">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h20" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>' +
          '<span class="wt-dock-host">' + esc(host) + '</span>' +
        '</div>' +
        '<div class="wt-dock-note">docked in the panel browser — it loads every page a real browser can. its address saves to this tab when you close it.</div>' +
      '</div>';
  }

  function wireNativeSync(ctx) {
    var handler = function (e) {
      if (!activeCtx || activeCtx !== ctx) return;
      var s = (e && e.detail) || {};
      if (s.open === false || s.ducked === undefined) {
        // sheet closed (or state unknown) — sync the tab's address
        try {
          var u = window.InAppBrowser && window.InAppBrowser.currentURL();
          if (u && /^https?:\/\//i.test(u) && u !== ctx.icon.url) {
            ctx.icon.setTabState({ url: u });
            ctx.omni.value = u;
            paintDocked(ctx, u);
          }
        } catch (err) { /* bridge hiccup */ }
      }
    };
    document.addEventListener('doomalay:panel-state', handler);
    ctx._nativeSync = function () {
      document.removeEventListener('doomalay:panel-state', handler);
    };
  }

  // ── the side panel: the icon row (favicon toggle + GradientUI) ────
  function buildSidePanel(sideEl, icon) {
    if (!sideEl) return;
    var G = window.GradientUI;
    var spec = (icon.gradient && icon.gradient.colors && icon.gradient.colors.length)
      ? icon.gradient
      : { colors: ['#38bdf8', '#a78bfa'], dir: 'auto' };

    sideEl.innerHTML =
      '<div class="wt-side-h">tab icon</div>' +
      '<div class="wt-side-row">' +
        '<button type="button" class="wt-chip' + (icon.iconMode === 'auto' ? ' on' : '') + '" data-wt-mode="auto">site icon (auto)</button>' +
        '<button type="button" class="wt-chip' + (icon.iconMode === 'gradient' ? ' on' : '') + '" data-wt-mode="gradient">gradient</button>' +
      '</div>' +
      '<div class="wt-side-editor">' + (G ? G.editor('wt', spec, { noTex: true }) : '') + '</div>' +
      '<div class="wt-side-note">the gradient paints the canvas disc when the site has no icon (or you prefer it). the default rides the theme\'s accent pair.</div>';

    sideEl.querySelectorAll('.wt-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var mode = chip.getAttribute('data-wt-mode');
        if (mode === 'gradient' && icon.iconMode === 'gradient' && icon.gradient) {
          // pressing "gradient" while already on a CUSTOM spec resets to
          // the theme-following default (the accent pair) — the one-tap
          // path back after experimenting
          icon.gradient = null;
          icon._renderIcon();
          icon.save();
          buildSidePanel(sideEl, icon);
          return;
        }
        icon.setIconMode(mode);
        sideEl.querySelectorAll('.wt-chip').forEach(function (c) { c.classList.toggle('on', c === chip); });
        if (window.doomalay && window.doomalay.scheduleSave) window.doomalay.scheduleSave();
      });
    });

    if (G) {
      var edEl = sideEl.querySelector('.wt-side-editor');
      G.wire(edEl, {
        spec: spec,
        live: function () {
          icon.setGradient({ colors: spec.colors.slice(), dir: spec.dir, angle: spec.angle });
        },
        rebuild: function () {
          buildSidePanel(sideEl, icon);
        }
      });
    }
  }

  // ── lifecycle: save the scroll + detach when the panel goes ───────
  function saveScrollNow() {
    var ctx = activeCtx;
    if (!ctx || !ctx.iframe) return;
    try {
      var y = ctx.iframe.contentWindow && ctx.iframe.contentWindow.scrollY;
      if (typeof y === 'number' && y >= 0 && Math.abs(y - ctx.icon.scrollY) > 8) {
        ctx.icon.scrollY = y;
        if (typeof ctx.icon.save === 'function') ctx.icon.save();
      }
    } catch (e) { /* cross-origin — sealed */ }
  }
  // best-effort scroll sampling while the tab browses (same-origin)
  setInterval(saveScrollNow, 2000);

  function teardown() {
    if (activeCtx) {
      saveScrollNow();
      if (typeof activeCtx._nativeSync === 'function') activeCtx._nativeSync();
    }
    activeCtx = null;
  }

  // a fresh render for another tab tears the old one down first
  var _render = render;

  window.WebPanel = {
    render: function (bodyEl, icon, panel) { _render(bodyEl, icon, panel); },
    navigate: function (input) {
      if (activeCtx) navigate(input, activeCtx);
    },
    _teardown: teardown
  };
})();
