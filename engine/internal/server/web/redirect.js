// redirect.js — the in-app redirect browser screen.
//
// Opens when the user taps "Get API key →" on a provider card. Instead of
// yanking the user out of the app, we slide up a full-screen panel that:
//   - shows the provider's sign-in / API-key page in an iframe (best effort —
//     some sites block embedding with X-Frame-Options)
//   - has a VERY NARROW header: [✕] ... domain ... [↗]
//       ✕  = slides the panel back DOWN, returning to whatever screen the
//             user was on before (the providers overlay stays mounted
//             underneath, so closing reveals it exactly as it was)
//       ↗  = opens the link in the REAL browser (Chrome), taking the user
//             out of the app completely. On Android the WebView routes
//             external URLs to Chrome via shouldOverrideUrlLoading.
//   - if the page hasn't confirmed a load after a few seconds, shows a slim
//     "not loading?" strip (most provider portals block embedding).
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

    // ── The iframe (best-effort embed of the provider's page) ───
    iframeEl = document.createElement('iframe');
    iframeEl.id = 'redirect-iframe';
    iframeEl.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    iframeEl.style.cssText =
      'flex:1;width:100%;border:none;background:#0e0e12;';
    panelEl.appendChild(iframeEl);

    // ── The "not loading?" strip (most portals block embedding) ─
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

    document.body.appendChild(panelEl);
  }

  // Open the redirect screen for a URL. Slides up over everything
  // (z-index 4000 > the connect overlay's 3000), so whatever the user
  // was looking at stays mounted underneath — closing slides back down
  // and reveals it untouched.
  function open(url, opts) {
    if (!url) return;
    opts = opts || {};
    ensureElements();
    closing = false;
    currentURL = url;
    try {
      domainEl.textContent = new URL(url).hostname;
    } catch (e) {
      domainEl.textContent = url;
    }
    hintEl.style.display = 'none';
    iframeEl.src = url;

    // Show the hint strip after a grace period — the iframe fires "load"
    // even when a site is X-Frame-Options blocked (it loads an error
    // page), so we can't reliably detect failure. Instead, give the user
    // the escape hatch after a few seconds.
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      if (isOpen()) hintEl.style.display = 'flex';
    }, 5000);

    panelEl.style.transition = 'transform 0.34s ' + EASE;
    panelEl.style.visibility = 'visible';
    // Force reflow so the slide-up transition fires.
    void panelEl.offsetWidth;
    panelEl.style.transform = 'translateY(0)';
  }

  // Slide the panel back DOWN and return to the app — the screen the user
  // was on before the redirect is still mounted underneath.
  function close() {
    if (!panelEl || panelEl.style.visibility === 'hidden' || closing) return;
    closing = true;
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    // Stop the panel from eating taps while it slides down (same fix as
    // connectoverlay's close — the 310ms slide-out still covered the app).
    panelEl.style.pointerEvents = 'none';
    panelEl.style.transition = 'transform 0.30s ' + EASE;
    panelEl.style.transform = 'translateY(100%)';
    setTimeout(function () {
      panelEl.style.visibility = 'hidden';
      panelEl.style.pointerEvents = '';
      // Drop the iframe content (stops any in-flight loads / audio).
      iframeEl.src = 'about:blank';
      hintEl.style.display = 'none';
      closing = false;
    }, 310);
  }

  // Open the current URL in the real browser — out of the app completely.
  // On Android, MainActivity's shouldOverrideUrlLoading routes external
  // URLs to Chrome. Desktop dev: a new tab.
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
