// webpanel.js — v0.85.3 THE MULTI-TAB BROWSER · PART 2: THE PANEL VIEW.
// v0.87.1 THE BIB FOCUS WAVE — ONE PANEL: the side panel (the gradient
// selector that didn't work) and the APK "docked" twin are GONE. On
// BIB-capable builds the native sheet is the one and only panel
// (WebTabs.openNative fires it — the master panel never opens); on
// every other surface (desktop / HF Space / self-host / phone
// browsers) THIS view, rendered in the master panel's body exactly
// where a chat's ChatPanel renders, is the one browser panel:
//   · THE OMNIBOX row (address + go + the ↗ external escape);
//   · THE FRAME: the engine's /api/preview verdict decides — frameable
//     pages render in a sandboxed IFRAME; frame-refusers (X-Frame-
//     Options / CSP frame-ancestors — the v0.63.4 lesson) get the
//     honest card (title + favicon + og-image + description + [open in
//     a window] [open externally]) instead of a blank white rect;
//   · TAB STATE: every navigation updates the entity (url, title,
//     favicon — "the canvas icon should ideally try and be dynamic
//     from whatever the website icon is they are visiting") and the
//     panel CLOSE saves the scroll position (same-origin frames read +
//     restore it exactly; cross-origin frames are the browser's sealed
//     box — saved best-effort, honestly);
//   · v0.87.2: the FAST favicon refresh — the icons (canvas disc +
//     the panel circle) repaint from the engine's fast verdict the
//     moment navigation starts, long before the full preview lands;
//   · v0.87.3: THE REDIRECT GUARD — the cross-domain guard banner at
//     the top of the frame (the sandboxed frame can't pop windows out
//     of the app; same-origin cross-domain self-navigations get the
//     ask-first banner);
//   · v0.87.4: the tweaks (text sizes / colors / the pinned icon) live
//     in webtweaks.js — opened from the circular tab icon in the panel
//     header, NOT from a side panel.
//
// Exposes: window.WebPanel = { render, navigate, _teardown }
(function () {
  'use strict';

  var START_URL = 'https://duckduckgo.com';
  var activeCtx = null;   // { icon, panel, root, frame, omni, verdict }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

    // v0.87.4: the per-tab browser tweaks (text sizes / colors / the
    // pinned icon) apply the moment the panel paints — webtweaks.js
    if (window.WebTweaks && typeof window.WebTweaks.apply === 'function') {
      window.WebTweaks.apply(icon);
    }

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
      '<div class="wt-frame" role="region" aria-label="Web page"></div>';

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

    // v0.87.2: THE FAST ICON REFRESH — the moment a navigation starts,
    // the icons (the canvas disc + the panel-header circle) repaint from
    // the engine's FAST favicon verdict; the full preview keeps its
    // role (the frame verdict + og card) and lands after. A user-pinned
    // icon (image / custom gradient) is never touched.
    if (typeof ctx.icon.refreshIcon === 'function') ctx.icon.refreshIcon(url);

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
    // v0.87.3: allow-popups + allow-popups-to-escape-sandbox are GONE —
    // a sandboxed frame can no longer mint escaping windows (the ad
    // "redirect the user" escape hatch dies at birth; the guard banner
    // owns every approved cross-domain move). Top navigation was never
    // allowed (no allow-top-navigation) — unchanged.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    f.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    f.setAttribute('title', hostOf(url) || 'page');
    f.src = url;
    // scroll restore (same-origin only — a cross-origin frame's scroll
    // is sealed; restore is best-effort by design) + v0.87.2: the load
    // listener also feeds the entity's URL + fast icon refresh on
    // in-frame navigations (same-origin frames only — the sealed box
    // stays honest) + v0.87.3: the same-origin redirect guard.
    f.addEventListener('load', function () {
      try {
        var loc = f.contentWindow && f.contentWindow.location;
        if (loc && loc.href && /^https?:/i.test(loc.protocol || 'https:')) {
          var href = loc.href;
          onFrameNavigated(ctx, href);
        }
      } catch (e) { /* cross-origin — sealed */ }
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
    // v0.87.4: every fresh frame re-applies the websites' tweaks (the
    // zoom + the filter ride the iframe node itself)
    if (window.WebTweaks && typeof window.WebTweaks.apply === 'function') {
      window.WebTweaks.apply(ctx.icon);
    }
  }

  // v0.87.3: an in-frame navigation the parent CAN see (same-origin
  // frames only — cross-origin frames are the browser's sealed box and
  // honestly stay invisible to us). The entity's address updates; a
  // cross-REGISTRABLE-domain move gets the guard banner.
  function onFrameNavigated(ctx, href) {
    if (!activeCtx || activeCtx !== ctx) return;
    var icon = ctx.icon;
    if (!icon || href === icon.url) return;
    var fromHost = hostOf(icon.url);
    var toHost = hostOf(href);
    if (fromHost && sameRegistrableDomain(fromHost, toHost)) {
      // a same-site move (subdomain shuffle) — the tab just follows
      icon.setTabState({ url: href });
      if (ctx.omni) ctx.omni.value = href;
      if (typeof icon.refreshIcon === 'function') icon.refreshIcon(href);
      return;
    }
    // a cross-domain self-navigation — the guard asks first
    showGuard(ctx, href, toHost);
  }

  // ── v0.87.3: THE REDIRECT GUARD BANNER (the web twin) ──────────────
  // "we should put a sort of pop notification at the top of the panel
  // that asks the user if they want to be redirected to xyz website,
  // with a redirect icon. If the user presses the redirect icon they
  // are redirected, if not (they press anywhere else) they stay in the
  // same page" — press the ⇱ to accept; tap anywhere else and the move
  // is ignored. The honest platform note: a same-origin frame that
  // navigates itself cross-domain already swapped its document — there
  // is no pre-facto cancel in the web sandbox; "stay" restores the
  // tab's saved address AND its saved scroll (best the platform
  // offers, exact for same-origin frames). Cross-origin frames never
  // reach this code (their location is sealed). The NATIVE sheet's
  // guard (PanelBrowserSheet) cancels the navigation BEFORE it happens
  // — the true zero-refresh stay.
  function showGuard(ctx, targetUrl, toHost) {
    if (!ctx || !ctx.frame) return;
    hideGuard(ctx);
    var fromHost = hostOf(ctx.icon.url) || 'this page';
    var g = document.createElement('div');
    g.className = 'wt-guard';
    g.setAttribute('role', 'alert');
    g.innerHTML =
      '<span class="wt-guard-ico" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24"><path d="M4 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</span>' +
      '<span class="wt-guard-txt"><b>' + esc(fromHost) + '</b> wants to redirect you to <b>' + esc(toHost) + '</b></span>' +
      '<button class="wt-guard-go" type="button" aria-label="Redirect to ' + esc(toHost) + '">go ⇱</button>';
    ctx.frame.appendChild(g);
    ctx.guard = g;

    var settle = function (accept) {
      hideGuard(ctx);
      document.removeEventListener('pointerdown', onDoc, true);
      if (accept) {
        // the user pressed the redirect icon — follow the move
        ctx.icon.setTabState({ url: targetUrl });
        if (ctx.omni) ctx.omni.value = targetUrl;
        if (typeof ctx.icon.refreshIcon === 'function') ctx.icon.refreshIcon(targetUrl);
      } else {
        // "they stay in the same page" — restore the tab's saved
        // address + scroll (a reload is the platform's only rollback
        // here; the native sheet's guard is the true no-refresh stay)
        var saved = ctx.icon.url;
        navigate(saved, ctx, { restore: true });
      }
    };
    g.querySelector('.wt-guard-go').addEventListener('click', function (e) {
      e.stopPropagation();
      settle(true);
    });
    var onDoc = function (e) {
      if (g.contains(e.target)) return;   // the accept pill owns its tap
      settle(false);
    };
    // "they press anywhere else" — one tap anywhere settles it as stay
    document.addEventListener('pointerdown', onDoc, true);
    ctx.guardSettle = settle;
    // a 12s expiry — an ignored banner should not outstay its welcome
    ctx.guardTimer = setTimeout(function () { settle(false); }, 12000);
  }

  function hideGuard(ctx) {
    if (!ctx) return;
    if (ctx.guardTimer) { clearTimeout(ctx.guardTimer); ctx.guardTimer = null; }
    if (ctx.guard && ctx.guard.parentNode) ctx.guard.parentNode.removeChild(ctx.guard);
    ctx.guard = null;
    ctx.guardSettle = null;
  }

  // registrable-domain compare ("isn't the same relative domain - not
  // exact"): example.com ≡ sub.example.com; example.com ≠ other.com.
  // The approximated eTLD+1 (a small second-level-TLD list covers the
  // common co.uk-style suffixes — honest, no PSL dependency).
  var SLD2 = {
    'co.uk': 1, 'org.uk': 1, 'ac.uk': 1, 'gov.uk': 1, 'me.uk': 1,
    'com.au': 1, 'net.au': 1, 'org.au': 1, 'co.nz': 1, 'net.nz': 1,
    'co.jp': 1, 'ne.jp': 1, 'or.jp': 1, 'ac.jp': 1, 'co.za': 1,
    'com.br': 1, 'com.mx': 1, 'com.ar': 1, 'co.in': 1, 'net.in': 1,
    'com.sg': 1, 'com.hk': 1, 'com.tw': 1, 'com.cn': 1, 'com.tr': 1
  };
  function registrableDomain(host) {
    if (!host) return '';
    var parts = String(host).toLowerCase().split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    var last2 = parts.slice(-2).join('.');
    if (SLD2[last2] && parts.length >= 3) return parts.slice(-3).join('.');
    return last2;
  }
  function sameRegistrableDomain(a, b) {
    return registrableDomain(a) === registrableDomain(b);
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
      hideGuard(activeCtx);
    }
    activeCtx = null;
  }

  window.WebPanel = {
    render: function (bodyEl, icon, panel) { render(bodyEl, icon, panel); },
    navigate: function (input) {
      if (activeCtx) navigate(input, activeCtx);
    },
    _teardown: teardown,
    // v0.87.4: the tweaks view applies through the live context (the
    // root node survives a view-stash — the styles stick and show the
    // moment the view pops)
    _ctx: function () { return activeCtx; },
    // v0.87.3: the rig surface (the DoomalayDebug pattern) — the domain
    // math + the guard's banner, directly drivable from the E2E rigs
    // (a same-origin frame that self-navigates cross-domain cannot be
    // staged against real sites — the sealed-box truth — so the rig
    // drives the exact same code path the frame's load event would).
    _debug: {
      registrableDomain: registrableDomain,
      sameRegistrableDomain: sameRegistrableDomain,
      showGuard: function (targetUrl) {
        var ctx = activeCtx;
        if (!ctx) return false;
        showGuard(ctx, targetUrl, hostOf(targetUrl));
        return true;
      },
      hideGuard: function () {
        if (activeCtx) hideGuard(activeCtx);
        return !!activeCtx;
      }
    }
  };
})();
