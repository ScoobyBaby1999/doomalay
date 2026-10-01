// webtweaks.js — v0.87.4 THE BROWSER TWEAKS PANEL.
//
// USER SPEC: "Pressing the circular icon that reflects the websites icon
// in the panel header (the one left of the back arrow). Should open
// panel similar to the tweaks panel found in the chatbot. The user can
// ideally change the text sizes of the websites and the browser itself,
// change the colors of the browser and websites, and change the icon of
// the browser exactly like how they can change an icon of a chatbot
// (upload image)."
//
// The chatbot tweaks panel's (tweaks.js) browser twin — same design
// language (settings-section collapsibles, chips, sliders, the
// GradientUI editor, the CropUI upload pipeline), scoped to ONE tab
// and persisted on the entity (icon.tweaks — the saved layout carries
// it, exactly like the chat's own tweaks blob):
//
//   · BROWSER ICON — the pinned-icon system: [site icon (auto) |
//     gradient | image]; the gradient editor customizes the disc; the
//     upload crops a square ≤128px dataURL onto the entity. A pinned
//     icon (image / custom gradient) NEVER re-derives from the site —
//     "if the user changes the icon of the tab it shouldn't keep
//     dynamically reflecting the new website logo".
//   · TEXT SIZE — "the text sizes of the websites and the browser
//     itself": the chrome scales through the scoped --wt-fs var; the
//     websites scale through the iframe's CSS zoom (the honest
//     cross-origin lever — a sealed page can't be restyled from
//     outside, but every browser scales it visually).
//   · COLORS — "the colors of the browser and websites": the chrome
//     tints through a GradientUI spec layered over the theme surfaces
//     (scoped --wt-c1/--wt-c2 vars + color-mix — zero hardcoded
//     colors, the theme stays the default); the websites tint through
//     CSS filter presets (dim/warm/paper/contrast/gray) + brightness.
//
// The web entry: app.js's panel circle (right of the dash) calls
// WebTweaks.open(panel, icon). The native handoff: PanelBrowserSheet's
// circle dismisses the sheet + spaEval's WebTweaks.openFor(tabId) —
// which rides window.doomalay.openWebTweaksFor (the master panel opens
// with the browser view + the tweaks stacked over it).
//
// Exposes: window.WebTweaks = { open, openFor, apply }
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var DEFAULTS = {
    fs: 100,            // the browser chrome text scale, 85–140 (%)
    fsSite: 100,        // the websites scale (CSS zoom), 60–180 (%)
    tintMode: 'theme',  // 'theme' | 'custom' (a GradientUI tint)
    tintGrad: null,     // {colors, dir, angle?} when custom
    filter: 'none',     // none|dim|warm|paper|contrast|gray
    bright: 100         // the websites brightness, 55–145 (%)
  };

  function blobOf(icon) {
    if (!icon.tweaks) icon.tweaks = {};
    for (var k in DEFAULTS) {
      if (icon.tweaks[k] === undefined) {
        icon.tweaks[k] = (typeof DEFAULTS[k] === 'object') ? null : DEFAULTS[k];
      }
    }
    return icon.tweaks;
  }

  function save(icon) {
    if (typeof icon.save === 'function') icon.save();
    else if (window.doomalay && window.doomalay.scheduleSave) window.doomalay.scheduleSave();
  }

  // ── the FILTER presets (the websites' color lever) ─────────────────
  var FILTERS = {
    none: { label: 'none', css: '' },
    dim: { label: 'dim', css: 'brightness(0.82)' },
    warm: { label: 'warm', css: 'sepia(0.28) saturate(1.08)' },
    paper: { label: 'paper', css: 'sepia(0.42) contrast(0.95) brightness(1.03)' },
    contrast: { label: 'contrast', css: 'contrast(1.18) saturate(1.1)' },
    gray: { label: 'grayscale', css: 'grayscale(0.92)' }
  };

  function filterCSS(t) {
    var f = FILTERS[t.filter] ? FILTERS[t.filter].css : '';
    var b = Number(t.bright) || 100;
    var parts = [];
    if (f) parts.push(f);
    if (b !== 100) parts.push('brightness(' + (b / 100).toFixed(2) + ')');
    return parts.join(' ');
  }

  // ── APPLY — live, onto the panel's .wt-root (even while stashed
  // behind a view — the node survives the stash; the styles stick and
  // show the moment the view pops) ───────────────────────────────────
  function apply(icon) {
    var ctx = (window.WebPanel && window.WebPanel._ctx) ? window.WebPanel._ctx() : null;
    if (!ctx || !ctx.root || !ctx.icon || ctx.icon !== icon) return;
    var t = blobOf(icon);
    var root = ctx.root;
    // the chrome text scale — every .wt- text rule multiplies by it
    root.style.setProperty('--wt-fs', ((Number(t.fs) || 100) / 100).toFixed(3));
    // the chrome tint — scoped stops layered over the theme surfaces
    root.classList.toggle('custom-tint', t.tintMode === 'custom' && !!(t.tintGrad && t.tintGrad.colors && t.tintGrad.colors.length));
    if (t.tintMode === 'custom' && t.tintGrad && t.tintGrad.colors && t.tintGrad.colors.length) {
      root.style.setProperty('--wt-c1', t.tintGrad.colors[0] || '');
      root.style.setProperty('--wt-c2', t.tintGrad.colors[1] || t.tintGrad.colors[0] || '');
    } else {
      root.style.removeProperty('--wt-c1');
      root.style.removeProperty('--wt-c2');
    }
    // the websites scale — the iframe's CSS zoom (the cross-origin lever)
    if (ctx.iframe) {
      ctx.iframe.style.zoom = ((Number(t.fsSite) || 100) / 100).toFixed(3);
      var f = filterCSS(t);
      ctx.iframe.style.filter = f || '';
    }
  }

  // ── THE VIEW ─────────────────────────────────────────────────────
  var cur = null;   // { panel, icon } while the view is open

  function chip(id, on, label) {
    return '<button type="button" class="wtw-chip' + (on ? ' on' : '') +
      '" data-wtw="' + id + '">' + label + '</button>';
  }

  function sliderRow(key, label, hint, min, max, val, suffix) {
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<label>' + label + '</label>' +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" data-wtw-display="' + key + '">' +
          val + (suffix || '%') + '</span>' +
      '</div>' +
      '<input type="range" class="app-range" data-wtw-range="' + key + '" min="' + min +
        '" max="' + max + '" step="1" value="' + val + '"' +
        ' style="accent-color:var(--accent);height:32px;cursor:pointer;touch-action:none">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }

  function buildView() {
    var icon = cur.icon;
    var t = blobOf(icon);
    var A = window.AppearanceUI || {};
    var sec = A.section || function (title, inner) {
      return '<div class="settings-section"><h3 data-section-toggle><span>' + title +
        '</span><span class="chevron">▶</span></h3><div class="section-body"><div class="section-inner">' +
        inner + '</div></div></div>';
    };
    var G = window.GradientUI;
    var host = icon.host() || 'this tab';

    // the gradient editor's live spec: the entity's own or a fresh pair
    var gSpec = (icon.gradient && icon.gradient.colors && icon.gradient.colors.length)
      ? icon.gradient
      : { colors: ['#38bdf8', '#a78bfa'], dir: 'auto' };
    var tSpec = (t.tintGrad && t.tintGrad.colors && t.tintGrad.colors.length)
      ? t.tintGrad
      : { colors: ['#38bdf8', '#a78bfa'], dir: 'auto' };

    return {
      title: 'browser tweaks · ' + host,
      render: function () {
        return (
          '<p class="pv-hint">this tab\'s own browser look — the icon, the text sizes and the colors. Everything applies instantly and saves to the tab; other tabs keep their own.</p>' +
          sec('Browser Icon',
            '<p class="hint">The icon this tab wears on the canvas, in the panel header and on the browser chrome\'s circle. A pinned icon (your image or a custom gradient) stops following the site — the dynamic favicon only re-derives in "site icon (auto)" mode.</p>' +
            '<div class="wtw-chiprow">' +
              chip('mode-auto', icon.iconMode === 'auto', 'site icon (auto)') +
              chip('mode-grad', icon.iconMode === 'gradient', 'gradient') +
              chip('mode-img', icon.iconMode === 'image', 'image') +
            '</div>' +
            '<div class="wtw-editor">' + (G ? G.editor('wtwicon', gSpec, { noTex: true }) : '') + '</div>' +
            '<button id="wtw-icon-pick" class="wtw-btn">🖼 browse an image…</button>' +
            '<input type="file" id="wtw-icon-file" accept="image/*" style="display:none">' +
            (icon.iconMode === 'image' && icon.imageData
              ? '<button id="wtw-icon-remove" class="wtw-btn wtw-btn-ghost">✕ back to the site icon</button>'
              : '') +
            '<p class="hint" id="wtw-icon-status">' +
              (icon.iconMode === 'image' && icon.imageData
                ? 'your image is pinned — it overrides the site\'s icon everywhere.'
                : icon.iconMode === 'gradient'
                  ? 'the gradient is pinned — it overrides the site\'s icon.'
                  : 'the site\'s own favicon, refreshed live as you browse.') +
            '</p>'
          ) +
          sec('Text Size',
            '<p class="hint">"the text sizes of the websites and the browser itself" — the chrome scales its labels and pills; the websites scale through the browser zoom (the honest cross-origin lever: a sealed page can\'t be restyled from outside, but every browser scales it).</p>' +
            sliderRow('fs', 'Browser chrome', 'The omnibox, the cards, the guard banner — this panel\'s own text.', 85, 140, t.fs, '%') +
            sliderRow('fsSite', 'Websites', 'The pages inside the tab (the zoom).', 60, 180, t.fsSite, '%')
          ) +
          sec('Colors',
            '<p class="hint">"change the colors of the browser and websites" — the chrome tints with a gradient layered over the theme (the theme stays the default); the websites tint through reading-mode filters + brightness.</p>' +
            '<div class="wtw-chiprow">' +
              chip('tint-theme', t.tintMode !== 'custom', 'follow theme') +
              chip('tint-custom', t.tintMode === 'custom', 'custom tint') +
            '</div>' +
            '<div class="wtw-editor">' + (G ? G.editor('wtwtint', tSpec, { noTex: true }) : '') + '</div>' +
            '<div class="wtw-chiprow" style="margin-top:10px">' +
              Object.keys(FILTERS).map(function (k) {
                return chip('flt-' + k, t.filter === k, FILTERS[k].label);
              }).join('') +
            '</div>' +
            sliderRow('bright', 'Website brightness', 'Layered over the filter — the pages\' own light.', 55, 145, t.bright, '%') +
            '<button id="wtw-reset-colors" class="wtw-btn wtw-btn-ghost" style="margin-top:8px">↺ reset colors to the theme</button>'
          )
        );
      },
      onMount: function (el) {
        wireSections(el);
        wireIcon(el);
        wireRanges(el);
        wireChips(el);
        wireEditors(el);
      },
      onClose: function () {
        cur = null;
      }
    };
  }

  function wireSections(el) {
    el.querySelectorAll('[data-section-toggle]').forEach(function (h) {
      h.addEventListener('click', function () {
        var s = h.parentElement;
        if (s) s.classList.toggle('expanded');
      });
    });
  }

  function wireRanges(el) {
    el.querySelectorAll('input[data-wtw-range]').forEach(function (r) {
      r.addEventListener('input', function () {
        if (!cur) return;
        var k = r.getAttribute('data-wtw-range');
        var v = parseInt(r.value, 10) || 100;
        blobOf(cur.icon)[k] = v;
        var d = el.querySelector('[data-wtw-display="' + k + '"]');
        if (d) d.textContent = v + '%';
        apply(cur.icon);
        save(cur.icon);
      });
    });
  }

  function wireChips(el) {
    el.querySelectorAll('[data-wtw]').forEach(function (c) {
      c.addEventListener('click', function () {
        if (!cur) return;
        var id = c.getAttribute('data-wtw');
        var icon = cur.icon;
        var t = blobOf(icon);
        if (id === 'mode-auto') {
          icon.setIconMode('auto');       // dynamic again — the favicon follows
        } else if (id === 'mode-grad') {
          if (icon.iconMode === 'gradient' && icon.gradient) {
            icon.gradient = null;          // reset to the theme pair
          }
          icon.setIconMode('gradient');
        } else if (id === 'mode-img') {
          var file = el.querySelector('#wtw-icon-file');
          if (file) file.click();         // the upload pipeline
        } else if (id === 'tint-theme') {
          t.tintMode = 'theme';
          save(icon); apply(icon);
        } else if (id === 'tint-custom') {
          t.tintMode = 'custom';
          save(icon); apply(icon);
        } else if (id.indexOf('flt-') === 0) {
          t.filter = id.slice(4);
          save(icon); apply(icon);
        }
        rebuild();
      });
    });
    var reset = el.querySelector('#wtw-reset-colors');
    if (reset) reset.addEventListener('click', function () {
      if (!cur) return;
      var t = blobOf(cur.icon);
      t.tintMode = 'theme';
      t.tintGrad = null;
      t.filter = 'none';
      t.bright = 100;
      save(cur.icon); apply(cur.icon);
      rebuild();
    });
  }

  // ── the icon pipeline: pick → CROP → ≤128px dataURL → entity ──────
  function wireIcon(el) {
    var pick = el.querySelector('#wtw-icon-pick');
    var file = el.querySelector('#wtw-icon-file');
    var status = el.querySelector('#wtw-icon-status');
    if (!pick || !file) return;
    pick.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (!f || !cur) return;
      if (!window.CropUI) {
        if (status) status.textContent = 'the cropper is not available';
        return;
      }
      if (status) status.textContent = 'opening the cropper…';
      window.CropUI.open({
        file: f,
        aspect: 1,                 // SQUARE — the disc renders circular
        maxEdge: 128,              // the entity storage stays tiny
        maxBytes: 60 * 1024,       // a dataURL on the saved layout
        format: 'image/png',
        onDone: function (b64, dims) {
          if (!cur) return;
          var url = 'data:' + (dims && dims.mime ? dims.mime : 'image/png') + ';base64,' + b64;
          cur.icon.setImageIcon(url);    // PINNED — never re-derives
          if (status) status.textContent = 'your image is pinned — it overrides the site\'s icon everywhere.';
          rebuild();
        },
        onErr: function (msg) {
          if (status) status.textContent = 'could not use that image (' + msg + ')';
        }
      });
    });
    var rm = el.querySelector('#wtw-icon-remove');
    if (rm) rm.addEventListener('click', function () {
      if (!cur) return;
      cur.icon.setImageIcon('');         // falls back to 'auto'
      rebuild();
    });
  }

  // ── the GradientUI editors: the disc's spec + the chrome tint ─────
  function wireEditors(el) {
    var G = window.GradientUI;
    if (!G || !cur) return;
    var icon = cur.icon;
    var t = blobOf(icon);
    var iconEd = el.querySelector('.wtw-editor #wtwicon-editor') || el.querySelector('.wtw-editor');
    // the icon editor (first .wtw-editor) drives the entity's own spec
    var editors = el.querySelectorAll('.wtw-editor');
    if (editors[0]) {
      var gSpec = (icon.gradient && icon.gradient.colors && icon.gradient.colors.length)
        ? icon.gradient : { colors: ['#38bdf8', '#a78bfa'], dir: 'auto' };
      G.wire(editors[0], {
        spec: gSpec,
        live: function () {
          icon.setGradient({ colors: gSpec.colors.slice(), dir: gSpec.dir, angle: gSpec.angle });
        },
        rebuild: function () { rebuild(); }
      });
    }
    if (editors[1]) {
      var tSpec = (t.tintGrad && t.tintGrad.colors && t.tintGrad.colors.length)
        ? t.tintGrad : { colors: ['#38bdf8', '#a78bfa'], dir: 'auto' };
      G.wire(editors[1], {
        spec: tSpec,
        live: function () {
          t.tintMode = 'custom';
          t.tintGrad = { colors: tSpec.colors.slice(), dir: tSpec.dir, angle: tSpec.angle };
          save(icon); apply(icon);
        },
        rebuild: function () { rebuild(); }
      });
    }
  }

  // rebuild() — re-render the view, preserving the open sections + the
  // scroll (the tweaks.js pattern; the gradient editor rebuilds on
  // add/remove — the sections must not fold under the user's thumbs)
  function rebuild() {
    if (!cur || !cur.panel || !cur.panel.replaceView) return;
    var body = cur.panel.bodyEl;
    var openTitles = [];
    if (body) {
      body.querySelectorAll('.settings-section.expanded').forEach(function (s) {
        var h = s.querySelector('h3');
        if (h) openTitles.push(h.textContent.trim());
      });
    }
    var scroll = body ? body.scrollTop : 0;
    cur.panel.replaceView(buildView());
    requestAnimationFrame(function () {
      if (!cur || !cur.panel) return;
      var nb = cur.panel.bodyEl;
      if (!nb) return;
      nb.querySelectorAll('.settings-section').forEach(function (s) {
        var h = s.querySelector('h3');
        if (h && openTitles.indexOf(h.textContent.trim()) >= 0) s.classList.add('expanded');
      });
      nb.scrollTop = scroll;
    });
  }

  // ── the entries ───────────────────────────────────────────────────
  // v0.87.5: open(panel, icon, opts) — opts.fromSheet marks the NATIVE
  // handoff (app.js's openWebTweaksFor): the user's real browser is the
  // native sheet (paused, its WebView state intact). When the tweaks
  // view closes (‹ back / ✕ / Android back / Escape), the view's
  // onClose re-opens the SHEET — not the SPA's browser twin (the old
  // flow stranded the user on the SPA's card for frame-refusing sites —
  // the "two pills + a website description" screen).
  function open(panel, icon, opts) {
    if (!panel || !icon) return;
    cur = { panel: panel, icon: icon, fromSheet: !!(opts && opts.fromSheet) };
    var v = buildView();
    if (cur.fromSheet) {
      v.onClose = function () {
        var ic = cur && cur.icon, p = cur ? cur.panel : panel;
        cur = null;
        // back to THEIR browser: the sheet resumes (no reload — the
        // WebView was only onPause'd; scroll, forms and history all
        // survive), and the master panel steps away (ONE panel).
        try {
          if (ic && window.WebTabs && typeof window.WebTabs.openNative === 'function' &&
              window.InAppBrowser) {
            window.WebTabs.openNative(ic);
          }
        } catch (e) {}
        try { if (p && p.close) p.close(); } catch (e) {}
      };
    }
    panel.pushView(v);
  }

  // openFor(tabId) — the NATIVE handoff: PanelBrowserSheet's circle
  // dismisses the sheet and calls this; app.js owns the panel + the
  // open machinery (window.doomalay.openWebTweaksFor).
  function openFor(tabId) {
    if (window.doomalay && typeof window.doomalay.openWebTweaksFor === 'function') {
      return window.doomalay.openWebTweaksFor(tabId);
    }
    return false;
  }

  window.WebTweaks = { open: open, openFor: openFor, apply: apply };
})();
