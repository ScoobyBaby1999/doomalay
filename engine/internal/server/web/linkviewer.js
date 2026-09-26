// linkviewer.js — v0.62.1: THE UNIVERSAL LINK CARD (PLAN-V063 Phase E1).
//
// Every external link the chat (or any panel) renders opens IN THE APP:
// one click → the engine's /api/preview verdict → the best tier the link
// supports. Never a blank tab-out again:
//   image          → inline + MediaZoom on tap
//   video / audio  → native tags (desktop video controls carry PiP)
//   pdf            → the browser's PDF viewer iframe
//   frameable html → sandboxed lazy iframe (deepseek et al. — the v062
//                    frame probe verified who allows framing)
//   blocked html   → the og-card (favicon + title + description) + open ↗
//   (YouTube links never get here — formatter.js cards them with the
//    in-place player + Document PiP.)
//
// Bare URLs stay compact until tapped — transcripts never become
// galleries unless asked. One document-level delegate covers every
// message, current and future (streams included).
//
// THEME: every color rides CSS vars (.lv-* in index.html) — nothing
// hardcoded, the theme system owns it all.
//
// Exposes: window.LinkViewer = { openCard, isExternal, _paint (tests) }
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
    openCard(a, href);
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
      '<button class="lv-open" type="button">open ↗</button></div>';
    wireClose(card);
    wireOpen(card, href);
  }

  function wireClose(card) {
    var x = card.querySelector('.lv-x');
    if (x) x.addEventListener('click', function () { card.style.display = 'none'; });
  }

  function wireOpen(card, href) {
    var b = card.querySelector('.lv-open');
    if (b) b.addEventListener('click', function () {
      // E1: a popup on desktop, a tab elsewhere. E2 (the in-app browser)
      // upgrades this to the APK viewer / themed path.
      var w = null;
      try { w = window.open(href, '_blank', 'width=760,height=900'); } catch (e) {}
      if (!w) try { w = window.open(href, '_blank'); } catch (e2) {}
    });
  }

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
        body = '<iframe class="lv-frame tall" src="' + esc(href) + '" loading="lazy" title="' + esc(d.title || 'pdf') + '"></iframe>';
        break;
      case 'html':
        if (d.frameable && !d.login_redirect) {
          body = '<iframe class="lv-frame" src="' + esc(href) + '" loading="lazy" referrerpolicy="no-referrer" title="' + esc(d.title || 'page') + '"></iframe>';
        } else {
          body = '';
          if (d.og_image) body += '<img class="lv-ogimg" src="' + esc(d.og_image) + '" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">';
          if (d.description) body += '<div class="lv-desc">' + esc(d.description) + '</div>';
          body += d.login_redirect ?
            '<span class="lv-note">this site needs its own sign-in page —</span> ' :
            '<span class="lv-note">this site blocks embedding —</span> ';
          body += '<button class="lv-open" type="button">open ↗</button>';
        }
        break;
      default:
        paintFallback(card, href);
        return;
    }
    card.innerHTML = headRow(d, href) + '<div class="lv-body">' + body + '</div>';
    wireClose(card);
    wireOpen(card, href);
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
