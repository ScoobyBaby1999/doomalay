// webpanel.js — v0.85.3 THE MULTI-TAB BROWSER · PART 2: THE PANEL VIEW.
// v0.87.1 THE BIB FOCUS WAVE — ONE PANEL (the side panel + the APK docked
// twin are gone; on BIB builds the native sheet is the one and only
// browser panel — webtab.js's WebTabs.openNative fires it).
// v0.88.1 THE TAB KEEP-ALIVE — the user spec: "if we go from one tab icon
// to another, the entire page gets refreshed, let's try not to do that.
// Instead, let's try to have them act like real tabs while trying to
// maintain performance. We want it so that clicking or jumping from one
// tab to another maintains each tab as if it where untouched and still
// active just idle/paused… connected tabs are grouped and don't need
// refreshing, they remember their state, scroll position, text in search
// boxes even if incomplete and unsearched, or message boxes like a
// messaging site… Like how they do computers."
//
// THE ARCHITECTURE (empirically verified in the target Chromium family
// — the Android WebView's engine): toggling display:none on an iframe
// PRESERVES its browsing context 100% (document, scroll, forms, JS
// state); ONE re-parent (appendChild to any other parent, even within
// the same document) DESTROYS it. Therefore:
//   · THE DECK — one persistent element (data-wt-keep), a permanent
//     child of the panel body, SPARED by every body wipe (panel.js's
//     wipeBody checks data-wt-keep). Every tab's iframe lives in the
//     deck, absolutely positioned + rect-synced (a rAF tracker) over
//     its session's .wt-frame placeholder. It NEVER changes parent.
//   · SESSIONS — one context object per tab, stable for its lifetime:
//     the wt-root (omnibox + the frame placeholder — no iframes
//     inside, so re-parenting is safe) parks in #wt-park (a 0×0
//     hidden host in document.body) whenever the body wipes; the
//     iframe hides via display:none. Tab switches, view push/pop,
//     panel close/reopen = display toggles ONLY → zero reloads, the
//     page exactly as the user left it (scroll, unsent omnibox text,
//     in-page form state, JS).
//   · navigate() is the ONLY thing that loads a URL (the omnibox, a
//     fresh tab, the guard's stay-rollback) — and it REUSES the
//     session's live iframe (a real navigation by the user's intent).
//   · THE BUDGET — MAX_LIVE frames stay parked (LRU eviction beyond;
//     grouped tabs are protected once 0.88.2's collision dots land).
//
// v0.87.2: the FAST favicon refresh rides every navigation start.
// v0.87.3: THE REDIRECT GUARD — the cross-domain banner at the top of
// the frame (sandboxed frames can't pop windows out of the app).
// v0.87.4: the tweaks (text sizes / colors / the pinned icon) live in
// webtweaks.js — opened from the circular tab icon in the panel header.
//
// Exposes: window.WebPanel = { render, navigate, _teardown, _ctx, _park,
//                               _debug }
(function () {
  'use strict';

  var START_URL = 'https://duckduckgo.com';

  // ── the persistent hosts + the session ledger ─────────────────────
  var deck = null;            // the permanent iframe host (data-wt-keep)
  var park = null;            // parked session roots (#wt-park)
  var sessions = new Map();   // tabId → ctx (the ctx IS the session)
  var activeCtx = null;

  var MAX_LIVE = 6;           // the parked-frame budget (non-grouped)
  var HARD_CAP = 12;          // the absolute ceiling (incl. protected)

  function ensurePark() {
    if (!park || !park.parentNode) {
      park = document.createElement('div');
      park.id = 'wt-park';
      document.body.appendChild(park);
    }
    return park;
  }

  function ensureDeck(bodyEl) {
    if (!deck) {
      deck = document.createElement('div');
      deck.className = 'wt-deck';
      deck.setAttribute('data-wt-keep', '1');
      deck.setAttribute('aria-hidden', 'true');
    }
    if (deck.parentNode !== bodyEl) {
      // the only re-parent the deck can ever suffer is a BODY CHANGE
      // (never in practice — one panel — but honest if it happens:
      // any iframes inside would die, so they are dropped first)
      dropAllFrames();
      bodyEl.insertBefore(deck, bodyEl.firstChild);
    }
    return deck;
  }

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

  // ══ THE RENDER — a session attach, never a rebuild ─══════════════
  function render(bodyEl, icon, panel) {
    if (!bodyEl || !icon) return;
    teardown();                       // bookkeeping for the outgoing ctx
    ensureDeck(bodyEl);
    ensurePark();
    // v0.88.1: drop open()'s loading placeholder (and anything else
    // stale) around the deck — the placeholder's opaque .wt-loading
    // overlay would otherwise paint OVER the live frame twin and eat
    // its pointer events (the red-team's fresh-eyes catch: every DOM
    // assertion passed while the dots covered the page)
    if (panel && typeof panel.wipeBody === 'function') panel.wipeBody(null);
    else {
      var kids = Array.prototype.slice.call(bodyEl.childNodes);
      for (var i = 0; i < kids.length; i++) {
        var kn = kids[i];
        if (kn.nodeType === 1 && kn.dataset && kn.dataset.wtKeep) continue;
        bodyEl.removeChild(kn);
      }
    }

    var ctx = sessions.get(icon.id);
    if (!ctx) {
      ctx = {
        icon: icon, panel: panel,
        root: null, omni: null, frame: null, iframe: null,
        verdict: null, mode: 'new', lastActive: 0
      };
      sessions.set(icon.id, ctx);
    }
    ctx.panel = panel;
    ctx.icon = icon;

    // THE KEEP-ALIVE: a session with a root NEVER re-navigates — the
    // root attaches (park → body), the live frame re-shows, the page
    // is exactly as the user left it. Fresh sessions navigate below.
    if (ctx.root) {
      bodyEl.appendChild(ctx.root);
    } else {
      buildRoot(bodyEl, ctx);
    }
    activate(ctx);

    // v0.87.4: the per-tab tweaks apply the moment the panel paints
    if (window.WebTweaks && typeof window.WebTweaks.apply === 'function') {
      window.WebTweaks.apply(icon);
    }

    evictIfNeeded(icon);
    sweepOrphans();

    if (ctx.mode === 'new') {
      // the SPA browser: land on the tab's saved address (or the start
      // page's omnibox-focus first-run feel — empty tab = focus, no load)
      if (icon.url) navigate(icon.url, ctx, { restore: true });
      else ctx.omni.focus();
    }
  }

  function buildRoot(bodyEl, ctx) {
    var root = document.createElement('div');
    root.className = 'wt-root';
    root.setAttribute('data-wt-root', '1');
    bodyEl.appendChild(root);
    ctx.root = root;

    // THE OMNIBOX (always present — the tab's address, editable)
    root.innerHTML =
      '<div class="wt-bar">' +
        '<input class="wt-omni" type="text" inputmode="url" enterkeyhint="go"' +
          ' placeholder="search or type a url" value="' + esc(ctx.icon.url || '') + '"' +
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
      var u = normalizeInput(ctx.omni.value) || ctx.icon.url || START_URL;
      if (window.InAppBrowser) window.InAppBrowser.external(u);
      else if (window.Hub && window.Hub.toast) window.Hub.toast('opened externally');
    });
  }

  // ── THE SYNC LOOP — the active frame rides its placeholder's rect ─
  // The placeholder (in the session root) is the layout authority; the
  // iframe (in the deck) is its absolutely-positioned twin. One rAF
  // pass glues them (the panel's slide gestures, dock changes, window
  // resizes and view stacks all ride the same per-frame truth).
  function syncFrame() {
    var ctx = activeCtx;
    var shown = false;
    if (ctx && ctx.iframe && ctx.mode === 'frame' && deck && deck.isConnected) {
      var p = ctx.panel;
      var depth = (p && p.viewDepth) ? p.viewDepth() : 0;
      if (p && p.isOpen && p.isOpen() && depth === 0) {
        var ph = ctx.frame.getBoundingClientRect();
        if (ph.width > 8 && ph.height > 8) {
          var dk = deck.getBoundingClientRect();
          var f = ctx.iframe;
          if (f.style.display === 'none') f.style.display = 'block';
          f.style.left = (ph.left - dk.left) + 'px';
          f.style.top = (ph.top - dk.top) + 'px';
          f.style.width = ph.width + 'px';
          f.style.height = ph.height + 'px';
          shown = true;
        }
      }
    }
    if (!shown && ctx && ctx.iframe && ctx.iframe.style.display !== 'none') {
      // covered (a view stacks over) / panel closed / switching — the
      // context stays ALIVE, only the pixels rest
      ctx.iframe.style.display = 'none';
    }
    requestAnimationFrame(syncFrame);
  }
  requestAnimationFrame(syncFrame);

  function activate(ctx) {
    if (activeCtx && activeCtx !== ctx && activeCtx.iframe) {
      activeCtx.iframe.style.display = 'none';
    }
    activeCtx = ctx;
    if (ctx) ctx.lastActive = Date.now();
  }

  // ── navigation: verdict → frame | card; state → entity ──────────
  // v0.88.1: navigate is the ONLY loader — and it REUSES the session's
  // live frame (a real navigation by the user's intent; the platform
  // resets the document — expected, honest).
  function navigate(input, ctx, opts) {
    opts = opts || {};
    var url = normalizeInput(input);
    if (!url) return;
    ctx.omni.value = url;
    ctx.frame.innerHTML = '<div class="wt-loading"><span>·</span><span>·</span><span>·</span></div>';

    // v0.87.2: THE FAST ICON REFRESH — the moment a navigation starts,
    // the icons (the canvas disc + the panel-header circle) repaint from
    // the engine's FAST favicon verdict. A user-pinned icon is never
    // touched.
    if (typeof ctx.icon.refreshIcon === 'function') ctx.icon.refreshIcon(url);

    fetchVerdict(url).then(function (v) {
      if (sessions.get(ctx.icon.id) !== ctx || !ctx.frame) return;   // superseded / dead
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
    ctx._restoreScroll = !!restore;
    var f = ctx.iframe;
    if (!f) {
      f = document.createElement('iframe');
      f.className = 'wt-iframe';
      // v0.87.3: allow-popups + allow-popups-to-escape-sandbox are GONE —
      // a sandboxed frame can no longer mint escaping windows (the ad
      // "redirect the user" escape hatch dies at birth; the guard banner
      // owns every approved cross-domain move). Top navigation was never
      // allowed (no allow-top-navigation) — unchanged.
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      f.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      f.style.display = 'none';
      // v0.88.1: the load listener is wired ONCE per frame node — the
      // ctx (a stable session object) survives every re-attach, so the
      // closure stays valid for the session's whole life.
      f.addEventListener('load', function () { onFrameLoad(ctx); });
      deck.appendChild(f);       // THE DECK — and there it stays
      ctx.iframe = f;
    }
    f.setAttribute('title', hostOf(url) || 'page');
    ctx.mode = 'frame';
    ctx.frame.innerHTML = '';    // drop the loading dots / the old card
    // v0.87.4: every frame paint re-applies the websites' tweaks (the
    // zoom + the filter ride the iframe node itself)
    if (window.WebTweaks && typeof window.WebTweaks.apply === 'function') {
      window.WebTweaks.apply(ctx.icon);
    }
    if (f.getAttribute('src') !== url) f.src = url;
  }

  // the frame's load pass: same-origin in-frame navigation awareness
  // (the entity's URL follows; cross-REGISTRABLE-domain moves get the
  // guard) + the one-shot scroll restore. Cross-origin frames are the
  // browser's sealed box — honestly invisible to us.
  function onFrameLoad(ctx) {
    if (sessions.get(ctx.icon.id) !== ctx) return;   // a dead session
    var f = ctx.iframe;
    if (!f) return;
    try {
      var loc = f.contentWindow && f.contentWindow.location;
      if (loc && loc.href && /^https?:/i.test(loc.protocol || 'https:')) {
        onFrameNavigated(ctx, loc.href);
      }
    } catch (e) { /* cross-origin — sealed */ }
    try {
      if (ctx._restoreScroll && ctx.icon.scrollY > 0 &&
          f.contentWindow && f.contentWindow.document) {
        f.contentWindow.scrollTo(0, ctx.icon.scrollY);
      }
    } catch (e) { /* cross-origin — sealed */ }
    ctx._restoreScroll = false;
  }

  // v0.89.1 (user spec): OUR OWN SITES are exempt from the redirect
  // guard — "exclude hugging face, GitHub, and other sites we use from
  // the redirect flow where the popup asks if we want to be redirected".
  // Target-based, keyed on the REGISTRABLE domain (every subdomain
  // rides). Kept in lockstep with the native twin (PanelBrowserSheet.kt
  // trustedHosts).
  var TRUSTED_HOSTS = {
    'huggingface.co': 1, 'hf.co': 1, 'github.com': 1, 'gitea.com': 1,
    'gitlab.com': 1, 'sourcehut.org': 1, 'privatemode.ai': 1,
    'opencode.ai': 1, 'nvidia.com': 1
  };

  // v0.87.3: an in-frame navigation the parent CAN see (same-origin
  // frames only). The entity's address updates; a cross-REGISTRABLE-
  // domain move gets the guard banner.
  function onFrameNavigated(ctx, href) {
    if (activeCtx !== ctx) return;
    var icon = ctx.icon;
    if (!icon || href === icon.url) return;
    var fromHost = hostOf(icon.url);
    var toHost = hostOf(href);
    if (fromHost && (sameRegistrableDomain(fromHost, toHost) ||
                     TRUSTED_HOSTS[registrableDomain(toHost)])) {
      // v0.89.1: a same-registrable move, or a landing on one of OUR
      // service sites — follows silently (no banner, no rollback).
      icon.setTabState({ url: href });
      if (ctx.omni) ctx.omni.value = href;
      if (typeof icon.refreshIcon === 'function') icon.refreshIcon(href);
      return;
    }
    showGuard(ctx, href, toHost);
  }

  // ── v0.87.3: THE REDIRECT GUARD BANNER (the web twin) ──────────────
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
    // v0.88.1: a card session DROPS its live frame — the site refuses
    // embedding; a kept iframe would only render an error rect.
    dropFrame(ctx);
    ctx.mode = 'card';
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
  }

  // ── THE BUDGET — LRU eviction (grouped tabs protected) ────────────
  function dropFrame(ctx) {
    if (ctx.iframe) {
      if (ctx.iframe.parentNode) ctx.iframe.parentNode.removeChild(ctx.iframe);
      ctx.iframe = null;
    }
  }
  function dropAllFrames() {
    sessions.forEach(function (ctx) { dropFrame(ctx); });
  }
  function isProtected(ctx) {
    // 0.88.2's collision groups protect their members from eviction
    // ("only tabs that are connected or associated with each other
    // remain untouched and act as grouped loaded tabs")
    try {
      return !!(window.TabGroups && window.TabGroups.isGrouped &&
        window.TabGroups.isGrouped(ctx.icon));
    } catch (e) { return false; }
  }
  function evictIfNeeded(activating) {
    var live = [];
    sessions.forEach(function (ctx) {
      if (ctx.iframe) live.push(ctx);
    });
    var count = live.length;
    if (count <= MAX_LIVE) return;
    // LRU: the oldest non-protected frames go first; the activating tab
    // never goes
    var cands = live.filter(function (c) {
      return !isProtected(c) && c.icon !== activating;
    });
    cands.sort(function (a, b) { return a.lastActive - b.lastActive; });
    while (live.length > MAX_LIVE && cands.length) {
      var victim = cands.shift();
      if (victim.iframe) { dropFrame(victim); live.splice(live.indexOf(victim), 1); }
    }
    // the hard cap — even protected frames yield past the ceiling
    if (live.length > HARD_CAP) {
      var rest = live.filter(function (c) { return c.icon !== activating; });
      rest.sort(function (a, b) { return a.lastActive - b.lastActive; });
      while (live.length > HARD_CAP && rest.length) {
        var v2 = rest.shift();
        if (v2.iframe) { dropFrame(v2); live.splice(live.indexOf(v2), 1); }
      }
    }
  }
  function sweepOrphans() {
    // sessions whose tab entity left the canvas (deleted tabs) die with
    // their frames — the deck never holds ghosts
    var alive = new Set();
    if (window.WebTabs && window.WebTabs.all) {
      window.WebTabs.all().forEach(function (ic) { alive.add(ic.id); });
    }
    var dead = [];
    sessions.forEach(function (ctx, id) {
      if (!alive.has(id)) dead.push(id);
    });
    dead.forEach(function (id) {
      var ctx = sessions.get(id);
      if (ctx) {
        if (ctx === activeCtx) teardown();
        dropFrame(ctx);
        if (ctx.root && ctx.root.parentNode) ctx.root.parentNode.removeChild(ctx.root);
        sessions.delete(id);
      }
    });
  }

  // ── lifecycle: save the scroll + deactivate when the panel goes ───
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
  // v0.94.4 (F6): the 2s FOREVER poll is RETIRED — the scroll position
  // saves on real scroll events (debounced 500ms; scrollend where
  // supported) + on teardown/hide (below). A poller that fires every
  // 2 seconds for the life of the page was CPU-governor/battery noise
  // on mobile for a value that only changes when the user scrolls.
  // NB: scroll events live on the IFRAME'S WINDOW (content scrolling
  // never bubbles to the parent element), and a same-origin navigation
  // REPLACES that window — the listeners re-attach on every load.
  var scrollSaveT = 0;
  function queueScrollSave() {
    if (scrollSaveT) return;
    scrollSaveT = setTimeout(function () { scrollSaveT = 0; saveScrollNow(); }, 500);
  }
  function bindScrollSave() {
    try {
      var cw = ctx.iframe.contentWindow;
      if (!cw) return;
      cw.addEventListener('scroll', queueScrollSave, { passive: true });
      if ('onscrollend' in cw) {
        cw.addEventListener('scrollend', function () {
          if (scrollSaveT) { clearTimeout(scrollSaveT); scrollSaveT = 0; }
          saveScrollNow();
        }, { passive: true });
      }
    } catch (e) { /* cross-origin — sealed */ }
  }
  bindScrollSave();
  try { ctx.iframe.addEventListener('load', bindScrollSave); } catch (e) {}

  function teardown() {
    var out = activeCtx;
    if (out) {
      saveScrollNow();
      hideGuard(out);
      // v0.88.1: the OUTGOING frame hides here (the red-team catch: the
      // sync loop only manages the ACTIVE ctx — without this, a
      // switched-away frame kept painting under the next session (and
      // over a card) — the keep-alive's display discipline must hold on
      // every exit, not just the covered-view path)
      if (out.iframe) out.iframe.style.display = 'none';
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
    // v0.88.1: the park (panel.js's wipes move data-wt-root nodes here
    // instead of destroying them)
    _park: function () { return park; },
    // v0.88.1: the rig surface + future mirrors — the domain math, the
    // guard, the session ledger (the no-reload proofs live here)
    _debug: {
      registrableDomain: registrableDomain,
      sameRegistrableDomain: sameRegistrableDomain,
      deck: function () { return deck; },
      park: function () { return park; },
      sessionOf: function (iconId) { return sessions.get(iconId) || null; },
      // v0.88.1: the rig surface — drives the frame paint directly (the
      // engine refuses loopback previews by design (SSRF guard), so the
      // same-origin state proof (scroll + a DOM marker) needs this)
      paintFrameFor: function (iconId, url) {
        var ctx = sessions.get(iconId);
        if (!ctx) return false;
        paintFrame(ctx, url, false);
        return true;
      },
      liveFrames: function () {
        var n = 0;
        sessions.forEach(function (c) { if (c.iframe) n++; });
        return n;
      },
      showGuard: function (targetUrl) {
        var ctx = activeCtx;
        if (!ctx) return false;
        showGuard(ctx, targetUrl, hostOf(targetUrl));
        return true;
      },
      hideGuard: function () {
        if (activeCtx) hideGuard(activeCtx);
        return !!activeCtx;
      },
      // v0.89.1: the rig surface for the TRUSTED-HOSTS exemptions —
      // drives the real decision path (onFrameNavigated) on a live ctx
      // and reads the exemption table.
      onFrameNavigated: function (ctx, href) {
        onFrameNavigated(ctx, href);
        return true;
      },
      trustedHosts: function () { return TRUSTED_HOSTS; }
    }
  };
})();
