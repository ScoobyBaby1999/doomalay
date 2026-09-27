// linkviewer.js — v0.63.5: THE TAP IS THE OPEN (PLAN-V0635).
//
// USER SPEC: "instead of having the browser in browser be it's own new
// screen, we have the browser in browser render as the panel screen…
// Opening a link would display it on the panel, so the user may have a
// link open with the panel sitting at half position, see the app canvas
// in the background."
//
// So the document-level delegate now docks THE PANEL BROWSER directly
// (browserdock.js — InAppBrowser v2): one tap on ANY external link and
// the browser is a PANEL SCREEN — the strip toolbar (↻ pill = copy +
// refresh, the dash, ‹ ⧉ ✕), full/half docking, the chat root stashed
// and restored untouched underneath. Frameable pages load in the dock's
// iframe; youtube rewires to the embed; media rides native tags; blocked
// pages never dock at all — v0.63.6 THE AUTO-ROUTE (browserdock.js)
// hands them straight to the full-screen browser-in-browser; only a
// popup-blocked desktop keeps the og/screenshot card.
// (YouTube links never get here — formatter.js cards them with the
// in-place player + Document PiP; getkey/hostile links are wired by the
// providers panel and ride the synchronous fallback tiers.)
//
// The inline lv-card painter stays EXPORTED (window.LinkViewer.openCard /
// _paint) — the tests exercise it and it remains the degenerate path if
// the dock script ever fails to load — but a plain link tap never shows
// it anymore: the tap IS the open.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hostOf(u) {
    try { return new URL(u, location.href).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  function isExternal(href) {
    if (!/^https?:\/\//i.test(href)) return false;
    try { return new URL(href, location.href).origin !== location.origin; }
    catch (e) { return false; }
  }

  // ── the delegate ───────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (a.closest('.lv-card')) return;        // links inside our own cards
    if (a.closest('.fmt-yt')) return;         // formatter's YT cards self-manage
    if (a.dataset.getkey) return;             // providers panel (E2 wires it)
    if (a.hasAttribute('download')) return;   // exports etc.
    var href = a.getAttribute('href') || '';
    if (!isExternal(href)) return;
    e.preventDefault();                       // the app NEVER navigates away
    // v0.63.5: THE TAP IS THE OPEN — the browser docks ON THE PANEL as a
    // panel screen (the user's clarified spec). The inline card painter
    // below stays exported for the tests + the degenerate path only.
    if (window.InAppBrowser && window.InAppBrowser.open) {
      window.InAppBrowser.open(href);
    } else {
      openCard(a, href);
    }
  });

  // ── the card lifecycle ─────────────────────────────────────────────
  function openCard(a, href) {
    var next = a.nextElementSibling;
    if (next && next.classList && next.classList.contains('lv-card')) {
      if (next.getAttribute('data-lv-url') === href) {
        next.style.display = next.style.display === 'none' ? '' : 'none';
        return; // toggle
      }
      next.remove(); // stale card for another url
    }
    var card = document.createElement('div');
    card.className = 'lv-card';
    card.setAttribute('data-lv-url', href);
    a.parentNode.insertBefore(card, a.nextSibling);
    paintLoading(card, href);
    fetch('/api/preview?url=' + encodeURIComponent(href))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { paint(card, href, d); })
      .catch(function () { paintFallback(card, href); });
  }

  function headRow(d, href) {
    var host = hostOf(href) || hostOf(d.final_url || '') || '';
    var favi = d.favicon ? '<img class="lv-favi" src="' + esc(d.favicon) + '" loading="lazy" alt="" onerror="this.style.visibility=\'hidden\'">' :
      '<span class="lv-favi"></span>';
    return '<div class="lv-head">' + favi +
      '<span class="lv-title" title="' + esc(d.title || host) + '">' + esc(d.title || host) + '</span>' +
      '<span class="lv-host">' + esc(host) + '</span>' +
      '<button class="lv-x" type="button" title="close" aria-label="close">✕</button></div>';
  }

  function paintLoading(card, href) {
    card.innerHTML = headRow({ title: 'loading…' }, href) +
      '<div class="lv-body"><div class="lv-loadbar"></div></div>';
    wireClose(card);
  }

  function paintFallback(card, href) {
    var host = hostOf(href) || 'link';
    card.innerHTML = headRow({ title: host }, href) +
      '<div class="lv-body"><span class="lv-note">preview unavailable —</span> ' +
      '<button class="lv-open" type="button">' + MAX() + 'open</button></div>';
    wireClose(card);
    wireOpen(card, href);
  }

  function wireClose(card) {
    var x = card.querySelector('.lv-x');
    if (x) x.addEventListener('click', function () { card.style.display = 'none'; });
  }

  // v0.63.4: the card's open button rides the FALLBACK tiers directly
  // (the E2 bridge viewer on APK / the desktop popup) — a blocked page
  // can never dock (frame guards), so one tap to the full-screen browser
  // beats a two-tap trip through the dock's og-card.
  function wireOpen(card, href) {
    var b = card.querySelector('.lv-open');
    if (b) b.addEventListener('click', function () {
      if (window.InAppBrowser && window.InAppBrowser.fallback) {
        window.InAppBrowser.fallback(href);
      }
    });
  }

  // ⤢ maximize — "bigger, still in the app" (the dock open button uses
  // the same glyph; ⧉ box+arrow means LEAVE — browserdock.js owns that).
  function MAX() {
    return (window.__pbIcons && window.__pbIcons.max) ||
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  }

  // ⤢ + "open in the dock" — the frameable / pdf card's bigger view: the
  // full panel browser (browserdock.js) with the strip toolbar, copy,
  // refresh and the app's own back stack. The 16:10 inline crop stays
  // for scanning the transcript; this is the "actually browse it" tap.
  function wireDock(card, href) {
    var b = card.querySelector('.lv-dock');
    if (b) b.addEventListener('click', function () {
      if (window.InAppBrowser && window.InAppBrowser.open) {
        window.InAppBrowser.open(href);
      }
    });
  }

  // ── v0.62.3→v0.63.4: THE BROWSING TIERS moved to browserdock.js ────
  // InAppBrowser v2: open(url) docks THE PANEL BROWSER (this panel's
  // own view, the strip toolbar, full/half docking); fallback(url)
  // keeps the E2 full-screen tiers (APK ViewerActivity / desktop
  // popup / tab); external(url) is the ⧉ box+arrow leave-the-app
  // action. The getkey flow + webview-hostile pages ride fallback()
  // synchronously — the v0.62.3 contract is unchanged.

  // ── the per-tier body ──────────────────────────────────────────────
  function paint(card, href, d) {
    if (!d || !d.type) { paintFallback(card, href); return; }
    var body = '';
    switch (d.type) {
      case 'image':
        body = '<img class="lv-img" src="' + esc(href) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="' + esc(d.title || '') + '">';
        break;
      case 'video':
        body = '<video class="lv-video" src="' + esc(href) + '" controls preload="metadata" playsinline></video>';
        break;
      case 'audio':
        body = '<audio style="width:100%" src="' + esc(href) + '" controls preload="metadata"></audio>';
        break;
      case 'pdf':
        body = '<iframe class="lv-frame tall" src="' + esc(href) + '" loading="lazy" title="' + esc(d.title || 'pdf') + '"></iframe>' +
          '<div class="lv-openwrap"><button class="lv-open lv-dock" type="button">' + MAX() + 'open</button></div>';
        break;
      case 'html':
        if (d.frameable && !d.login_redirect) {
          body = '<iframe class="lv-frame" src="' + esc(href) + '" loading="lazy" referrerpolicy="no-referrer" title="' + esc(d.title || 'page') + '"></iframe>' +
            '<div class="lv-openwrap"><button class="lv-open lv-dock" type="button">' + MAX() + 'open</button></div>';
        } else {
          body = '';
          // v0.62.4: the T3 tier — the engine's retina screenshot of the
          // page (desktop/self-host; absent on Android, where the in-app
          // browser covers it). Card art beats a bare og-card.
          if (d.screenshot_url) {
            body += '<img class="lv-ogimg lv-shot" src="' + esc(d.screenshot_url) + '" loading="lazy" alt="' + esc(d.title || 'screenshot') + '" onerror="this.remove()">';
          } else if (d.og_image) {
            body += '<img class="lv-ogimg" src="' + esc(d.og_image) + '" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">';
          }
          if (d.description) body += '<div class="lv-desc">' + esc(d.description) + '</div>';
          body += d.login_redirect ?
            '<span class="lv-note">this site needs its own sign-in page —</span> ' :
            '<span class="lv-note">this site blocks embedding —</span> ';
          body += '<button class="lv-open" type="button">' + MAX() + 'open</button>';
        }
        break;
      default:
        paintFallback(card, href);
        return;
    }
    card.innerHTML = headRow(d, href) + '<div class="lv-body">' + body + '</div>';
    wireClose(card);
    wireOpen(card, href);
    wireDock(card, href);   // v0.63.4: the frameable/pdf ⤢ opens THE DOCK
    // image → the MediaZoom pinch-zoom overlay on tap
    var img = card.querySelector('.lv-img');
    if (img && window.MediaZoom) {
      img.addEventListener('click', function () {
        window.MediaZoom.open(img.currentSrc || img.src, img.alt || '');
      });
    }
  }

  // Expose for tests + E2 (the in-app browser reuses the tiers)
  window.LinkViewer = {
    openCard: openCard,
    isExternal: isExternal,
    _paint: paint
  };
})();
