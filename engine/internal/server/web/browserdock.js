// browserdock.js — v0.63.4 THE PANEL BROWSER (PLAN-PANEL-BROWSER).
//
// USER SPEC: "instead of the full screen thing, we have the BROWSER IN
// BROWSER itself be in the PANEL! so that the user can DOCK the browser
// itself and move it between the full and half screen position." The
// browser is a VIEW on the master panel (panel.js pushView): every
// battle-tested gesture still applies — drag the strip to dock full /
// half, fling down closes, scrim closes, and the chat root waits
// untouched underneath (stashed + restored by the view stack).
//
// THE STRIP (the handle bar — the "iphone dash" the user described):
//   [ (↻) the link… ]      ——      [ ‹ ] [ ⧉ ] [ ✕ ]
//   · the pill — slightly opaque, fully rounded, theme colors. Tap =
//     COPY the full link (clipboard API → execCommand fallback → toast).
//   · ↻ INSIDE the pill, left of the text — reloads the page.
//   · ‹ — back through OUR navigation stack (the URLs opened through
//     the app). Web-verified: cross-origin contentWindow.history.back()
//     throws SecurityError — a parent can never drive a foreign frame's
//     history, and link-clicks inside the page are invisible to us. The
//     native viewer (a real WebView with its own history) covers the rest.
//   · ⧉ — THE BOX+ARROW (Lucide external-link — the YouTube "open in
//     app" shape, the user's icon spec): leaves the app entirely.
//     bridge openExternal() → ACTION_VIEW (the site's native app claims
//     its domain) → Chrome Custom Tab → system browser; desktop: a tab.
//   · ✕ — pops the dock view; whatever was underneath restores.
//
// ROUTING (InAppBrowser v2 — the E2 tiers are now the FALLBACK):
//   open(url, {purpose:'getkey'|hostile}) → fallback() SYNC (the key
//     consoles are frame-blocked by design; the v0.62.3 contract holds).
//   open(url) → THE DOCK: strip + loadbar immediately, iframe loading
//     optimistically, GET /api/preview in parallel — youtube → the embed
//     rewrite (the pill keeps the ORIGINAL link); frame-blocked →
//     v0.63.6 THE AUTO-ROUTE: the dock hands the URL straight to the
//     FULL-SCREEN browser-in-browser (the fallback tiers — a native
//     WebView is a TOP-LEVEL context, immune to X-Frame-Options and
//     CSP frame-ancestors) and closes itself. THE PANEL BROWSER ONLY
//     EVER OPENS FOR PAGES IT CAN DISPLAY (the user's spec). A desktop
//     popup fired async can be popup-blocked — that rare case keeps the
//     og/screenshot card with a ⤢ open. Media → native tags. Verdict
//     failures keep the optimistic load.
//     v0.63.5: html/youtube frames carry the NO-TOP-NAVIGATION sandbox
//     (allow-scripts/forms/popups/same-origin/presentation — everything
//     a page needs, but a frame-buster can NEVER navigate the app's top
//     window away) + the same-URL rapid-reopen guard turns a bust loop
//     into the blocked card instead of a reload spiral.
//   fallback(url) — bridge hostile?CustomTab:ViewerActivity → popup →
//     tab (v0.62.3 verbatim). external(url) — box+arrow semantics.
//   back/canBack/close/isOpen/currentURL — dock controls (app.js gives
//     Android back to the dock's own stack FIRST while browsing).
//
// THEME: every color rides CSS vars (.pb-* in index.html) — the pill's
// translucency is opacity over --surface-2, nothing hardcoded.
//
// Exposes: window.InAppBrowser (v2)
(function () {
  'use strict';

  // ── the icons (Lucide v1.47 ISC — same corpus as icons.js) ─────────
  function icon(path, size) {
    size = size || 15;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  var I_REFRESH = icon('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>', 14);
  var I_BACK    = icon('<path d="m15 18-6-6 6-6"/>', 17);
  var I_EXT     = icon('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 16);
  var I_X       = icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 15);
  var I_MAX     = icon('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>', 14);
  window.__pbIcons = { refresh: I_REFRESH, back: I_BACK, ext: I_EXT, x: I_X, max: I_MAX };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── the toast (theme vars only — .pb-toast in index.html) ──────────
  var toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'pb-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1600);
  }

  function copyText(text) {
    // 127.0.0.1 is a secure context, so the async clipboard API exists
    // in the APK WebView too; the execCommand path covers older views.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  // ── the theme snapshot (kept for the fallback bridge tier) ─────────
  function themeSnapshot() {
    var cs = getComputedStyle(document.documentElement);
    var pick = function (v) { var s = cs.getPropertyValue(v).trim(); return s || ''; };
    return {
      accent: pick('--accent'),
      bgPanel: pick('--bg-panel') || pick('--bg-app'),
      surface: pick('--surface-2'),
      text1: pick('--text-1'),
      text3: pick('--text-3'),
      border: pick('--border')
    };
  }

  // ══ THE FALLBACK TIERS (v0.62.3 verbatim — now the backup) ════════
  // v0.63.6: split into fallbackTier() — the AUTO-ROUTE needs to KNOW
  // whether a tier actually fired (an async window.open on desktop can
  // be popup-blocked and return null; the APK bridge always fires).
  // The public fallback() keeps its string contract for the E2 suites.
  function fallbackTier(url, opts) {
    opts = opts || {};
    var bridge = window.__doomalayKotlin;
    if (bridge && typeof bridge.openInApp === 'function') {
      try {
        bridge.openInApp(url, JSON.stringify({
          theme: themeSnapshot(),
          hostile: !!opts.hostile,
          purpose: opts.purpose || 'link'
        }));
        return { tier: 'apk-viewer', ok: true };
      } catch (e) { /* bridge hiccup — fall through */ }
    }
    var w = null;
    try { w = window.open(url, '_blank', 'width=760,height=900,noopener'); } catch (e1) {}
    if (!w) {
      try { w = window.open(url, '_blank'); } catch (e2) {}
    }
    return w ? { tier: 'popup', ok: true } : { tier: 'tab', ok: false };
  }
  function fallback(url, opts) { return fallbackTier(url, opts).tier; }

  // the box+arrow: leave the app entirely — the site's NATIVE app
  // claims its domain (ACTION_VIEW), Chrome Custom Tab as the fallback,
  // the system browser as the last resort. Desktop: a plain new tab.
  function external(url) {
    var bridge = window.__doomalayKotlin;
    if (bridge && typeof bridge.openExternal === 'function') {
      try { bridge.openExternal(url); return 'apk-external'; } catch (e) {}
    }
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    return 'tab';
  }

  // ══ THE DOCK ═══════════════════════════════════════════════════════
  var stack = [];        // [{url, embed, title, blocked, media}]
  var live = false;      // the dock view is in the panel's stack
  var lastOpen = null;   // {url, t} — the frame-buster loop guard
  var view = {
    title: 'browser',
    chrome: 'browser',   // panel.js: .panel-browser strip mode while top
    render: function () { return '<div class="pb-root" id="pb-root"></div>'; },
    onMount: function () {
      live = true;
      // v0.63.6: the AUTO-ROUTE may have emptied the stack while this
      // view was covered — resurfacing onto an empty dock closes it
      // instead of painting a blank page.
      if (!current()) {
        if (dockIsTop()) { var p0 = panelInst(); if (p0) p0.popView(); }
        return;
      }
      dockRender();
    },
    onClose: function () {
      live = false;
      stack = [];
      paintStrip();
    }
  };

  function panelInst() {
    var c = (window.ChatPanel && window.ChatPanel.current()) || {};
    return c.panel || null;
  }
  function dockIsTop() {
    var p = panelInst();
    return !!(p && live && p.topView && p.topView() === view);
  }

  function open(url, opts) {
    opts = opts || {};
    // the E2 flows keep their synchronous tiers: key consoles are
    // frame-blocked by design, hostile pages can't ride a WebView at all.
    if (opts.purpose === 'getkey' || opts.hostile) return fallback(url, opts);
    if (!/^https?:\/\//i.test(url)) return fallback(url, opts);

    var p = panelInst();
    if (!p || !p.pushView) return fallback(url, opts); // no panel → old tiers

    var entry = { url: url };
    if (!live) {
      stack = [entry];
      p.pushView(view);          // onMount → dockRender
    } else if (dockIsTop()) {
      var top = stack[stack.length - 1];
      if (top && top.url === url) {
        // v0.63.5: the frame-buster guard. A page that keeps forcing a
        // top navigation (window.open / target=_top) lands back here via
        // the native handleUrl bridge on every attempt — two re-opens of
        // the SAME url inside 1.5s means a loop: show the blocked card,
        // never reload the frame again. A human re-tap that fast is a
        // no-op anyway (their page is already showing).
        if (lastOpen && lastOpen.url === url && (Date.now() - lastOpen.t) < 1500) {
          top.busted = top.busted || { title: hostOf(url), url: url };
          dockRender();
          return 'panel';
        }
        lastOpen = { url: url, t: Date.now() };
        dockRender(); return 'panel'; // re-open: refresh focus
      }
      if (stack.length > 29) stack.shift();
      stack.push(entry);
      dockRender();
    } else {
      // covered by another view: queue it — onMount re-renders the top
      stack.push(entry);
    }
    lastOpen = { url: url, t: Date.now() };
    fetchVerdict(entry);
    return 'panel';
  }

  function hostOf(u) {
    try { return new URL(u, location.href).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  // the parallel /api/preview verdict (1h server cache) — youtube
  // rewrites to the embed, blocked pages AUTO-ROUTE to the full-screen
  // browser (v0.63.6 — the dock pops itself; only a popup-blocked
  // desktop keeps the card), media swaps to native tags.
  function fetchVerdict(entry) {
    fetch('/api/preview?url=' + encodeURIComponent(entry.url))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { applyVerdict(entry, d); })
      .catch(function () { /* keep the optimistic load */ });
  }
  function applyVerdict(entry, d) {
    if (stack.indexOf(entry) < 0) return;                 // stale — popped
    var isTop = stack[stack.length - 1] === entry;
    if (!d || !d.type) return;
    if (d.type === 'youtube') {
      entry.embed = d.embed || entry.url;
      entry.title = d.title || '';
      if (isTop) dockRender();
      return;
    }
    if (d.type === 'html') {
      if (!d.frameable || d.login_redirect) {
        entry.blocked = d;                                // frame guards / login wall
        if (isTop) dockRender();
      } else if (isTop) {
        entry.title = d.title || entry.title || '';        // already loading
        paintStrip();
      }
      return;
    }
    if (d.type === 'image' || d.type === 'video' || d.type === 'audio' || d.type === 'pdf') {
      entry.media = d.type;
      entry.title = d.title || '';
      if (isTop && d.type !== 'pdf') dockRender();          // pdf stays an iframe
    }
  }

  // ── rendering ──────────────────────────────────────────────────────
  function current() { return stack[stack.length - 1] || null; }

  function dockRender() {
    var root = document.getElementById('pb-root');
    var e = current();
    if (!root || !e) return;
    paintStrip();
    // v0.63.6: the bust-loop guard keeps its card (a page that ESCAPED
    // the sandbox must not auto-open the viewer without a fresh tap —
    // the escape itself re-opened us, not the user); a verdict-based
    // block AUTO-ROUTES to the full-screen browser-in-browser.
    if (e.busted) { renderBlocked(root, e); return; }
    if (e.blocked) {
      if (!autoRoute(e)) renderBlocked(root, e);   // popup-blocked desktop
      return;
    }
    if (e.media === 'image' || e.media === 'video' || e.media === 'audio') {
      renderMedia(root, e);
      return;
    }
    mountFrame(root, e);                                    // html / pdf / youtube / optimistic
  }

  // v0.63.6: THE AUTO-ROUTE — "panel browser only even opens when the
  // website it displays can be displayed. Otherwise the browser in
  // browser is displayed." The verdict says this page can NEVER render
  // in the dock's iframe (X-Frame-Options / CSP frame-ancestors / a
  // cross-domain sign-in wall)? Hand the URL to the FULL-SCREEN
  // browser-in-browser — a top-level browsing context where those
  // anti-clickjacking guards don't apply — and pull the entry out of
  // the dock. Returns false when no tier could fire (a desktop popup
  // blocked outside a user gesture) so the caller keeps the card.
  function autoRoute(e) {
    var r = fallbackTier(e.url, { purpose: 'link' });
    if (!r.ok) return false;
    var p = panelInst();
    var i = stack.indexOf(e);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length) {
      if (dockIsTop()) dockRender();       // the page beneath returns
    } else if (p && dockIsTop()) {
      p.popView();                         // the emptied dock closes itself
    }
    return true;
  }

  function mountFrame(root, e) {
    var src = e.embed || e.url;
    // v0.63.5: the NO-TOP-NAVIGATION sandbox for html/youtube — every
    // capability a normal iframe gives (scripts, forms, popups, the
    // page's own origin storage, presentation/PiP) EXCEPT the right to
    // navigate our top window: frame-buster JS dies quietly on every
    // platform and the desktop SPA can never be navigated away. PDFs
    // keep the plain frame — the browser's built-in PDF viewer rides
    // its own chrome-extension origin.
    var isPdf = e.media === 'pdf' || /\.pdf(?:[?#]|$)/i.test(e.url);
    var sb = isPdf ? '' :
      ' sandbox="allow-scripts allow-forms allow-popups' +
      ' allow-popups-to-escape-sandbox allow-same-origin allow-presentation"';
    root.innerHTML =
      '<div class="pb-loadbar" id="pb-loadbar"></div>' +
      '<iframe class="pb-frame" id="pb-frame" src="' + esc(src) + '"' + sb +
      ' referrerpolicy="no-referrer" allowfullscreen allow="' +
      'fullscreen; picture-in-picture; encrypted-media; clipboard-write"' +
      ' title="' + esc(e.title || src) + '"></iframe>';
    var bar = root.querySelector('#pb-loadbar');
    var fr = root.querySelector('#pb-frame');
    var spin = document.getElementById('pb-refresh');
    if (spin) spin.classList.add('loading');
    var done = function () {
      if (bar && bar.parentNode) bar.remove();
      if (spin) spin.classList.remove('loading');
    };
    if (fr) fr.addEventListener('load', done, { once: true });
    setTimeout(done, 20000);                                // never spin forever
  }

  function renderMedia(root, e) {
    var inner = '';
    if (e.media === 'image') {
      inner = '<img src="' + esc(e.url) + '" alt="' + esc(e.title || '') + '" decoding="async" referrerpolicy="no-referrer">';
    } else if (e.media === 'video') {
      inner = '<video src="' + esc(e.url) + '" controls playsinline preload="metadata"></video>';
    } else {
      inner = '<audio src="' + esc(e.url) + '" controls preload="metadata"></audio>';
    }
    root.innerHTML = '<div class="pb-mediawrap">' + inner + '</div>';
    // v0.63.5: the docked image taps into the pinch-zoom overlay (the
    // v0.62.1 MediaZoom capability lives on inside the panel browser).
    var img = root.querySelector('img');
    if (img && window.MediaZoom) {
      img.addEventListener('click', function () {
        window.MediaZoom.open(img.currentSrc || img.src, img.alt || '');
      });
    }
    var spin = document.getElementById('pb-refresh');
    if (spin) spin.classList.remove('loading');
  }

  function renderBlocked(root, e) {
    var d = e.blocked || e.busted || {};
    var art = '';
    if (d.screenshot_url) {
      art = '<img class="pb-shot" src="' + esc(d.screenshot_url) + '" loading="lazy" alt="" onerror="this.remove()">';
    } else if (d.og_image) {
      art = '<img class="pb-shot" src="' + esc(d.og_image) + '" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">';
    }
    root.innerHTML = '<div class="pb-blocked">' + art +
      (d.title ? '<div class="pb-btitle">' + esc(d.title) + '</div>' : '') +
      (d.description ? '<div class="pb-bdesc">' + esc(d.description) + '</div>' : '') +
      '<div class="pb-note">' + (d.login_redirect ?
        'this site needs its own sign-in page' :
        e.busted ? 'this page refuses to stay embedded' :
        'this site blocks embedding') + '</div>' +
      '<button class="pb-open" type="button">' + I_MAX + 'open</button></div>';
    var b = root.querySelector('.pb-open');
    if (b) b.addEventListener('click', function () { fallback(e.url); });
    var spin = document.getElementById('pb-refresh');
    if (spin) spin.classList.remove('loading');
  }

  function paintStrip() {
    var e = current();
    var urlEl = document.getElementById('pb-url');
    var pill = document.getElementById('pb-pill');
    var backBtn = document.getElementById('pb-back');
    if (urlEl) urlEl.textContent = e ? e.url : '';
    if (pill) pill.setAttribute('title', e ? e.url : '');
    if (backBtn) {
      if (stack.length > 1) backBtn.removeAttribute('disabled');
      else backBtn.setAttribute('disabled', 'disabled');
    }
  }

  // ── the strip chrome (wired ONCE at boot; state read at click) ────
  function wireStrip() {
    var refresh = document.getElementById('pb-refresh');
    var pill = document.getElementById('pb-pill');
    var back = document.getElementById('pb-back');
    var ext = document.getElementById('pb-ext');
    var close = document.getElementById('pb-close');
    if (back) back.innerHTML = I_BACK;
    if (ext) ext.innerHTML = I_EXT;
    if (close) close.innerHTML = I_X;
    if (refresh) refresh.innerHTML = I_REFRESH;
    if (refresh) refresh.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var e = current();
      var root = document.getElementById('pb-root');
      if (e && root && !e.blocked && !e.busted) mountFrame(root, e);   // fresh iframe = full reload
    });
    if (refresh) refresh.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault(); ev.stopPropagation();
      refresh.click();
    });
    if (pill) pill.addEventListener('click', function () {
      var e = current();
      if (!e) return;
      copyText(e.url).then(function (ok) {
        toast(ok ? 'link copied' : 'copy failed');
      });
    });
    if (back) back.addEventListener('click', function () {
      if (stack.length > 1) { stack.pop(); dockRender(); }
    });
    if (ext) ext.addEventListener('click', function () {
      var e = current();
      if (e) external(e.url);
    });
    if (close) close.addEventListener('click', function () {
      var p = panelInst();
      if (p && dockIsTop()) p.popView();
    });
  }
  wireStrip();

  // ── the public surface ─────────────────────────────────────────────
  window.InAppBrowser = {
    open: open,
    fallback: fallback,
    external: external,
    back: function () {
      if (!canBack()) return false;
      stack.pop();
      dockRender();
      return true;
    },
    canBack: function () { return !!(dockIsTop() && stack.length > 1); },
    close: function () {
      var p = panelInst();
      if (p && dockIsTop()) { p.popView(); return true; }
      return false;
    },
    isOpen: function () { return live; },
    currentURL: function () { var e = current(); return e ? e.url : null; },
    // test seam: the stack + a canned-verdict pump
    _stack: function () { return stack.slice(); },
    _verdict: applyVerdict
  };
})();
