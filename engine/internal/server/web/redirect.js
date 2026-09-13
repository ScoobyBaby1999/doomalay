// redirect.js — the in-app redirect browser screen.
//
// Opens when the user taps "Get API key →" on a provider card.
//
// v0.13 PROBE-FIRST flow (fixes the three redirect regressions):
//   1. Ask the ENGINE to probe the URL first (GET /api/probe-embed):
//      it walks the redirect chain, reads X-Frame-Options / CSP
//      frame-ancestors, and detects SSO/identity-provider moves.
//   2. EMBEDDABLE → slide up the panel with the iframe (the nice UX).
//   3. BLOCKED (NVIDIA / PrivateMode portals, opencode's OAuth) → don't
//      even try the iframe (that's what rendered "net::ERR_BLOCKED_BY_
//      RESPONSE" / Google's 403 in v0.12). Instead show a clean portal
//      card explaining why + a big "Open in browser ↗" button that
//      launches Chrome (MainActivity routes external URLs). The key-paste
//      screen is still underneath — come back and paste.
//
// Header (42px): [✕ | domain | ↗] — ✕ slides down (the screen underneath
// stays mounted), ↗ always opens the real browser.
//
// Exposes: window.RedirectPanel = { open, close, isOpen }
(function () {
  'use strict';

  var panelEl = null;
  var iframeEl = null;
  var domainEl = null;
  var hintEl = null;
  var hintTimer = null;
  var currentURL = '';
  var closing = false;

  // The slide curve — iPhone-feel: fast start, soft landing.
  var EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

  function ensureElements() {
    if (panelEl) return;

    panelEl = document.createElement('div');
    panelEl.id = 'redirect-panel';
    panelEl.style.cssText =
      'position:fixed;inset:0;z-index:4000;visibility:hidden;' +
      'background:#0a0a0e;transform:translateY(100%);' +
      'display:flex;flex-direction:column;';

    // ── The very narrow header ──────────────────────────────────
    var header = document.createElement('div');
    header.style.cssText =
      'flex-shrink:0;height:42px;display:flex;align-items:center;' +
      'background:#0e0e12;border-bottom:1px solid #1a1a22;' +
      'padding:0 6px;touch-action:manipulation;';

    // ✕ — slides the redirect panel down, back to the app.
    var closeBtn = document.createElement('button');
    closeBtn.id = 'redirect-close';
    closeBtn.setAttribute('aria-label', 'Close and return to app');
    closeBtn.style.cssText =
      'background:transparent;border:none;color:#e0e0e8;font-size:20px;' +
      'cursor:pointer;padding:6px 12px;flex-shrink:0;font-family:inherit;' +
      'border-radius:8px;line-height:1;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function () { close(); });

    // The domain label — where the user currently is.
    domainEl = document.createElement('span');
    domainEl.style.cssText =
      'flex:1;text-align:center;font-size:12px;color:#71717a;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'padding:0 4px;user-select:none;';

    // ↗ — opens the link in the real browser (out of the app entirely).
    var extBtn = document.createElement('button');
    extBtn.id = 'redirect-external';
    extBtn.setAttribute('aria-label', 'Open in browser');
    extBtn.style.cssText =
      'background:transparent;border:none;color:#E8B44A;cursor:pointer;' +
      'padding:6px 12px;flex-shrink:0;font-family:inherit;border-radius:8px;' +
      'display:flex;align-items:center;justify-content:center;';
    extBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>' +
      '</svg>';
    extBtn.addEventListener('click', function () { openExternal(); });

    header.appendChild(closeBtn);
    header.appendChild(domainEl);
    header.appendChild(extBtn);
    panelEl.appendChild(header);

    // ── The iframe (embeddable pages) ──────────────────────────
    iframeEl = document.createElement('iframe');
    iframeEl.id = 'redirect-iframe';
    iframeEl.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    iframeEl.style.cssText =
      'flex:1;width:100%;border:none;background:#0e0e12;';
    panelEl.appendChild(iframeEl);

    // ── The "not loading?" strip ────────────────────────────────
    hintEl = document.createElement('div');
    hintEl.style.cssText =
      'flex-shrink:0;display:none;align-items:center;gap:8px;' +
      'padding:9px 14px;background:#14141a;border-top:1px solid #1a1a22;' +
      'font-size:12px;color:#71717a;cursor:pointer;touch-action:manipulation;';
    hintEl.innerHTML =
      '<span style="flex:1">Page not loading? This site may block embedding.</span>' +
      '<span style="color:#E8B44A;font-weight:600;flex-shrink:0">Open in browser ↗</span>';
    hintEl.addEventListener('click', function () { openExternal(); });
    panelEl.appendChild(hintEl);

    // ── The blocked-portal card (replaces the iframe) ───────────
    var blockedEl = document.createElement('div');
    blockedEl.id = 'redirect-blocked';
    blockedEl.style.cssText =
      'flex:1;display:none;flex-direction:column;align-items:center;' +
      'justify-content:center;padding:32px 24px;overflow-y:auto;';
    panelEl.appendChild(blockedEl);

    document.body.appendChild(panelEl);
  }

  // Open the redirect screen for a URL. PROBE FIRST (v0.13):
  // the engine checks embeddability before we build an iframe.
  function open(url, opts) {
    if (!url) return;
    opts = opts || {};
    ensureElements();
    closing = false;
    currentURL = url;
    var host = url;
    try { host = new URL(url).hostname; } catch (e) {}
    domainEl.textContent = host;

    slideUp();

    // While probing: subtle loading shimmer in the iframe area.
    iframeEl.style.display = '';
    blockedEl().style.display = 'none';
    hintEl.style.display = 'none';
    iframeEl.src = 'about:blank';

    fetch('/api/probe-embed?url=' + encodeURIComponent(url))
      .then(function (r) { return r.json(); })
      .then(function (verdict) {
        if (!isOpen() || currentURL !== url) return; // closed / navigated meanwhile
        if (verdict && verdict.embeddable) {
          iframeEl.src = url;
          armHintTimer();
        } else {
          showBlockedCard(host, (verdict && verdict.reason) || 'this site blocks embedding');
        }
      })
      .catch(function () {
        // Engine unreachable → best-effort iframe (old behavior).
        if (isOpen() && currentURL === url) {
          iframeEl.src = url;
          armHintTimer();
        }
      });
  }

  function armHintTimer() {
    if (hintTimer) clearTimeout(hintTimer);
    // Even an "embeddable" verdict can be wrong (JS-driven logins) — keep
    // the escape hatch armed, but shorter since the probe already passed.
    hintTimer = setTimeout(function () {
      if (isOpen()) hintEl.style.display = 'flex';
    }, 4000);
  }

  function blockedEl() { return panelEl.querySelector('#redirect-blocked'); }

  // The clean "can't open inside the app" card.
  function showBlockedCard(host, reason) {
    iframeEl.style.display = 'none';
    iframeEl.src = 'about:blank';
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hintEl.style.display = 'none';

    var el = blockedEl();
    el.innerHTML =
      '<div style="width:64px;height:64px;border-radius:18px;background:#14141a;border:1px solid #2a2a35;display:flex;align-items:center;justify-content:center;font-size:30px;margin-bottom:20px">🔒</div>' +
      '<h3 style="font-size:17px;font-weight:600;color:#e0e0e8;margin:0 0 8px;text-align:center">' + escHTML(host) + '</h3>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 6px;text-align:center;max-width:340px;line-height:1.5">' +
        'This portal opens outside the app.' +
      '</p>' +
      '<p style="font-size:11px;color:#4a4a5e;margin:0 0 28px;text-align:center;max-width:340px;line-height:1.5">' +
        escHTML(reason) +
      '</p>' +
      '<button id="redirect-open-ext" style="background:#E8B44A;border:none;color:#0a0a0b;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;box-shadow:0 4px 16px rgba(232,180,74,0.25);display:flex;align-items:center;gap:8px">' +
        'Open in browser <span style="font-size:16px">↗</span>' +
      '</button>' +
      '<p style="font-size:11px;color:#4a4a5e;margin:20px 0 0;text-align:center;max-width:320px;line-height:1.5">Create or copy your API key in the browser, come back to the app, and paste it below.</p>';
    el.style.display = 'flex';

    var btn = el.querySelector('#redirect-open-ext');
    if (btn) btn.addEventListener('click', function () {
      openExternal();
      // Slide down AFTER launching Chrome so the key-paste screen is
      // waiting when the user returns to the app.
      setTimeout(function () { close(); }, 350);
    });
  }

  function escHTML(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function slideUp() {
    panelEl.style.transition = 'transform 0.34s ' + EASE;
    panelEl.style.visibility = 'visible';
    // Force reflow so the slide-up transition fires.
    void panelEl.offsetWidth;
    panelEl.style.transform = 'translateY(0)';
  }

  // Slide the panel back DOWN and return to the app.
  function close() {
    if (!panelEl || panelEl.style.visibility === 'hidden' || closing) return;
    closing = true;
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    // Stop the panel from eating taps while it slides down.
    panelEl.style.pointerEvents = 'none';
    panelEl.style.transition = 'transform 0.30s ' + EASE;
    panelEl.style.transform = 'translateY(100%)';
    setTimeout(function () {
      panelEl.style.visibility = 'hidden';
      panelEl.style.pointerEvents = '';
      iframeEl.style.display = '';
      iframeEl.src = 'about:blank';
      blockedEl().style.display = 'none';
      hintEl.style.display = 'none';
      closing = false;
    }, 310);
  }

  // Open the current URL in the real browser. On Android, MainActivity's
  // shouldOverrideUrlLoading routes external URLs to Chrome.
  function openExternal() {
    if (!currentURL) return;
    var a = document.createElement('a');
    a.href = currentURL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function isOpen() {
    return panelEl && panelEl.style.visibility !== 'hidden';
  }

  window.RedirectPanel = {
    open: open,
    close: close,
    isOpen: isOpen
  };
})();
