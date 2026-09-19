// uikit.js — v0.33 THE SHARED UI KIT: pills, gradients, and the cropper.
//
// USER SPEC (Batch 10): "since we are already re-using many methods, like
// the gallery picker, the panel everything is displayed on, and the color
// gradient, let's also rework the pills system we have… a modular
// reusable pill system… the pills all follow the themes as well… less
// rounded and looking more like a hand drawn png with better coloring."
//
// Three reusable widgets, one file, zero app deps (pure vanilla — loaded
// before every view module, used by hub.js / hubpublish.js / tweaks.js):
//
//   UIPills    the modular pill system. ONE builder → ONE look:
//              matte surfaces, organic hand-drawn corner radii (each
//              pill in a group gets a slightly different corner set —
//              drawn, not stamped), a 1px offset sketch stroke, and
//              theme-driven tints (accent / persona purple / template
//              green — [data-theme] swaps the palettes).
//   GradientUI the 1–10 color gradient editor (the v0.31 2–3 picker
//              grew up): swatches with per-color remove, ＋ add
//              (max 10), ⤨ shuffle, live preview callbacks, plus
//              random() which now picks a RANDOM STOP COUNT (2–10) —
//              "not strictly 2 or 3 colors".
//   CropUI     the drag-to-crop overlay. The chat-background pipeline
//              (cover) stays as is; the hub card image gets this: the
//              image is dragged under a fixed-aspect frame and the
//              crop is taken from the ORIGINAL pixels — no stretch, no
//              forced fit, resolution and clarity kept (long edge
//              capped only at maxEdge, default 1024).
//
// Exposes: window.UIPills, window.GradientUI, window.CropUI

(function () {
  'use strict';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  // ══ UIPills — the modular pill system ═════════════════════════════
  //
  // Every pill in the app routes through here so they share ONE visual
  // language (the CSS lives in index.html's .dx-pill block). Pills are
  // compact — "as little as possible without compromising visuals" —
  // and theme-aware through CSS variables, never hardcoded colors.
  var UIPills = {
    // pill(opts) → '<button class="dx-pill …" …>…</button>'
    //   opts.label   visible text (required)
    //   opts.icon    optional prefix glyph (emoji or html) — rendered
    //                inside its own span so emoji + text align
    //   opts.on      selected state → data-on="1"
    //   opts.tone    'persona' | 'template' — the selected state tints
    //                purple / green (theme-dependent); default = accent
    //   opts.cls     extra classes ('dx-pill--sm' etc.)
    //   opts.attrs   {name: value} extra attributes (data-sort=…)
    pill: function (opts) {
      opts = opts || {};
      var attrs = '';
      Object.keys(opts.attrs || {}).forEach(function (k) {
        attrs += ' ' + k + '="' + escAttr(opts.attrs[k]) + '"';
      });
      var cls = 'dx-pill' + (opts.cls ? ' ' + opts.cls : '');
      if (opts.tone) attrs += ' data-tone="' + escAttr(opts.tone) + '"';
      if (opts.on) attrs += ' data-on="1"';
      if (opts.id) attrs += ' id="' + escAttr(opts.id) + '"';
      return '<button type="button" class="' + cls.trim() + '"' + attrs + '>' +
        (opts.icon ? '<span class="dx-pill-ico">' + opts.icon + '</span>' : '') +
        '<span class="dx-pill-label">' + esc(opts.label || '') + '</span>' +
        '</button>';
    },

    // chip(label, opts) → a non-interactive tag chip. opts.rm is an
    // attribute string for the remove button ('data-untag="3"') — omit
    // it for plain display chips (the item detail's tags).
    chip: function (label, opts) {
      opts = opts || {};
      return '<span class="dx-chip">' + esc(label) +
        (opts.rm ? '<button type="button" class="dx-chip-x" ' + opts.rm +
          ' title="remove" aria-label="remove">✕</button>' : '') +
        '</span>';
    }
  };

  // ══ GradientUI — the 1–10 color gradient editor ═══════════════════
  //
  // One editor, two consumers: the publish card design and the chat
  // background. MIN 1 color (a single stop = a solid fill), MAX 10.
  // The caller owns the colors array; wire() mutates it and calls back.
  var MAX_COLORS = 10;

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) {
      var v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * v).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  var GradientUI = {
    MAX: MAX_COLORS,

    // random(n) → array of hex stops. n omitted → a RANDOM count (2–10):
    // the walk stays hue-adjacent (≤ ~200° span) with S/L inside the
    // readable bands, so even 10 stops read as one tasteful sweep.
    random: function (n) {
      var count = (typeof n === 'number' && n >= 1)
        ? Math.max(1, Math.min(MAX_COLORS, Math.round(n)))
        : (2 + Math.floor(Math.random() * (MAX_COLORS - 1)));
      if (count === 1) return [hslToHex(Math.floor(Math.random() * 360),
        60 + Math.floor(Math.random() * 21), 50)];
      var base = Math.floor(Math.random() * 360);
      var span = 40 + Math.floor(Math.random() * 160); // 40°..200°
      var s1 = 60 + Math.floor(Math.random() * 21);    // 60–80%
      var l1 = 45 + Math.floor(Math.random() * 21);    // 45–65%
      var out = [];
      for (var i = 0; i < count; i++) {
        var t = count === 1 ? 0 : i / (count - 1);
        out.push(hslToHex(base + span * t, s1, l1 + (t * 8)));
      }
      return out;
    },

    // css(colors) → a linear-gradient string; a single stop returns the
    // solid color itself (CSS gradients need ≥2 stops).
    css: function (colors, angle) {
      var c = (colors || []).filter(function (x) { return !!x; });
      if (!c.length) return '';
      if (c.length === 1) return c[0];
      return 'linear-gradient(' + (angle || 135) + 'deg, ' + c.join(', ') + ')';
    },

    // editor(pfx, colors) → the editor markup. Every control carries
    // data-gr-* hooks; ids are namespaced by pfx so two editors can
    // coexist (the publish form + the tweaks background view).
    editor: function (pfx, colors, opts) {
      opts = opts || {};
      var c = colors && colors.length ? colors : ['#38bdf8', '#a78bfa'];
      var sw = '';
      for (var i = 0; i < c.length; i++) {
        sw += '<span class="gr-swatch">' +
          '<input type="color" class="gr-color" data-gr="' + i + '" value="' + escAttr(c[i]) + '"' +
          ' aria-label="gradient color ' + (i + 1) + '">' +
          (c.length > 1
            ? '<button type="button" class="gr-rm" data-gr-rm="' + i + '" title="remove this color" aria-label="remove color ' + (i + 1) + '">✕</button>'
            : '') +
          '</span>';
      }
      return (
        '<div class="gr-editor" id="' + escAttr(pfx) + '-gr">' +
          '<div class="gr-swatches">' + sw + '</div>' +
          '<div class="gr-tools">' +
            '<button type="button" class="gr-mini" data-gr-add="1"' +
              (c.length >= MAX_COLORS ? ' disabled' : '') + '>＋ color</button>' +
            '<button type="button" class="gr-mini" data-gr-shuffle="1">⤨ shuffle</button>' +
            (opts.randomBtn !== false
              ? '<button type="button" class="gr-mini" data-gr-random="1">↻ random</button>' : '') +
            '<span class="gr-count">' + c.length + ' / ' + MAX_COLORS + '</span>' +
          '</div>' +
          (c.length >= MAX_COLORS
            ? '<div class="gr-cap">10 colors is the maximum</div>' : '') +
        '</div>'
      );
    },

    // wire(el, h) — h = { colors, live, rebuild }
    //   colors   the live array (mutated in place)
    //   live()   a color VALUE changed → update the preview in place
    //   rebuild() add/remove/shuffle changed the shape → re-render
    wire: function (el, h) {
      if (!el || !h || !h.colors) return;
      var colors = h.colors;
      el.querySelectorAll('.gr-color').forEach(function (inp) {
        inp.addEventListener('input', function () {
          colors[parseInt(inp.getAttribute('data-gr'), 10) || 0] = inp.value;
          if (h.live) h.live();
        });
      });
      el.querySelectorAll('[data-gr-rm]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (colors.length <= 1) return; // min 1 — the ✕ hides at 1
          colors.splice(parseInt(b.getAttribute('data-gr-rm'), 10) || 0, 1);
          if (h.rebuild) h.rebuild();
        });
      });
      var add = el.querySelector('[data-gr-add]');
      if (add) add.addEventListener('click', function () {
        if (colors.length >= MAX_COLORS) return;
        colors.push(GradientUI.random(1)[0]);
        if (h.rebuild) h.rebuild();
      });
      var shuf = el.querySelector('[data-gr-shuffle]');
      if (shuf) shuf.addEventListener('click', function () {
        var r = GradientUI.random(colors.length); // same count, new hues
        for (var i = 0; i < r.length; i++) colors[i] = r[i];
        if (h.rebuild) h.rebuild();
      });
      var rnd = el.querySelector('[data-gr-random]');
      if (rnd) rnd.addEventListener('click', function () {
        var r = GradientUI.random();              // NEW random count
        colors.length = 0;
        for (var i = 0; i < r.length; i++) colors.push(r[i]);
        if (h.rebuild) h.rebuild();
      });
    }
  };

  // ══ CropUI — the drag-to-crop overlay ═════════════════════════════
  //
  // The image sits UNDER a fixed-aspect crop frame (the card's). The
  // user drags it around (pan) and zooms (slider, 1–4× the cover
  // scale); apply() crops the frame's region from the ORIGINAL bitmap
  // — the output is never stretched, only re-encoded at up to maxEdge
  // on the long edge so clarity survives even on wide screens.
  var CropUI = (function () {
    var st = null; // the live overlay state

    function close() {
      if (!st) return;
      try { if (st.url) URL.revokeObjectURL(st.url); } catch (e) {}
      if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
      document.removeEventListener('keydown', onKey, true);
      st = null;
    }

    function onKey(e) {
      if (!st) return;
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter') { e.stopPropagation(); apply(); }
    }

    function cancel() {
      var cb = st && st.onCancel;
      close();
      if (cb) cb();
    }

    function apply() {
      if (!st || !st.img) return;
      var f = st.frame;                 // the frame rect (CSS px)
      var s = st.cover * st.zoom;       // px per source pixel
      var sx = Math.max(0, Math.min(st.nat.w, -st.x / s));
      var sy = Math.max(0, Math.min(st.nat.h, -st.y / s));
      var sw = Math.min(st.nat.w - sx, f.w / s);
      var sh = Math.min(st.nat.h - sy, f.h / s);
      var out = Math.min(1, st.maxEdge / Math.max(sw, sh));
      var cw = Math.max(1, Math.round(sw * out));
      var ch = Math.max(1, Math.round(sh * out));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      cv.getContext('2d').drawImage(st.img, sx, sy, sw, sh, 0, 0, cw, ch);
      var dataURL;
      try { dataURL = cv.toDataURL('image/png'); } catch (e) { dataURL = ''; }
      if (!dataURL || dataURL.indexOf('base64,') < 0) {
        if (st.onErr) st.onErr('could not encode the crop');
        return;
      }
      var b64 = dataURL.slice(dataURL.indexOf('base64,') + 7);
      var cb = st.onDone;
      close();
      if (cb) cb(b64, { width: cw, height: ch });
    }

    // position + clamp the image under the frame
    function place() {
      if (!st) return;
      var dw = st.nat.w * st.cover * st.zoom;
      var dh = st.nat.h * st.cover * st.zoom;
      st.x = Math.max(st.frame.w - dw, Math.min(0, st.x));
      st.y = Math.max(st.frame.h - dh, Math.min(0, st.y));
      st.imgEl.style.width = dw + 'px';
      st.imgEl.style.height = dh + 'px';
      st.imgEl.style.transform = 'translate(' + st.x + 'px,' + st.y + 'px)';
    }

    function reset() {
      if (!st) return;
      st.zoom = 1;
      var dw = st.nat.w * st.cover;
      var dh = st.nat.h * st.cover;
      st.x = (st.frame.w - dw) / 2;
      st.y = (st.frame.h - dh) / 2;
      var z = st.el.querySelector('.crop-zoom');
      if (z) z.value = '1';
      place();
    }

    // fit the fixed-aspect frame into the stage — deterministic: the
    // fit box is measured + sized in JS, then the image clamps to it
    function measure() {
      if (!st || !st.el) return;
      var sr = st.el.querySelector('.crop-stage').getBoundingClientRect();
      var fw = Math.max(60, sr.width), fh = fw / st.aspect;
      if (fh > sr.height) { fh = Math.max(60, sr.height); fw = fh * st.aspect; }
      var fit = st.el.querySelector('.crop-fit');
      fit.style.width = fw + 'px';
      fit.style.height = fh + 'px';
      st.frame = { w: fw, h: fh };
      st.cover = Math.max(fw / st.nat.w, fh / st.nat.h);
      place();
    }

    function open(opts) {
      if (st) close();
      opts = opts || {};
      var aspect = (typeof opts.aspect === 'number' && opts.aspect > 0) ? opts.aspect : 1.5;

      var gotImg = function (img, url) {
        st = {
          el: null, img: img, url: url || '',
          nat: { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height },
          aspect: aspect, maxEdge: opts.maxEdge || 1024,
          zoom: 1, x: 0, y: 0, frame: { w: 0, h: 0 }, cover: 1,
          onDone: opts.onDone || null, onCancel: opts.onCancel || null,
          onErr: opts.onErr || null
        };
        if (!st.nat.w || !st.nat.h) { if (opts.onErr) opts.onErr('not readable'); close(); return; }
        build();
      };

      // the source: a File/Blob, a data URL, or an already-loaded Image
      if (opts.img) { gotImg(opts.img, ''); return; }
      var src = opts.file || opts.blob || opts.src;
      if (!src) { if (opts.onErr) opts.onErr('nothing to crop'); return; }
      var url = (typeof src === 'string') ? src : URL.createObjectURL(src);
      var img = new Image();
      img.onload = function () { gotImg(img, typeof src === 'string' ? '' : url); };
      img.onerror = function () {
        if (typeof src !== 'string') URL.revokeObjectURL(url);
        if (opts.onErr) opts.onErr('not readable');
      };
      img.src = url;
    }

    function build() {
      var el = document.createElement('div');
      el.className = 'crop-ui';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'crop the image');
      el.innerHTML =
        '<div class="crop-top">' +
          '<button type="button" class="crop-btn crop-x" aria-label="cancel">✕</button>' +
          '<div class="crop-title">drag to crop</div>' +
          '<button type="button" class="crop-btn crop-ok" aria-label="apply crop">apply ✓</button>' +
        '</div>' +
        '<div class="crop-stage">' +
          '<div class="crop-fit">' +
            '<img class="crop-img" alt="" draggable="false">' +
            '<div class="crop-frame"></div>' +
          '</div>' +
        '</div>' +
        '<div class="crop-ctl">' +
          '<button type="button" class="crop-btn" data-crop-reset="1" title="reset" aria-label="reset">↺</button>' +
          '<input type="range" class="crop-zoom" min="1" max="4" step="0.01" value="1" aria-label="zoom">' +
          '<span class="crop-hint">drag the image · zoom with the slider</span>' +
        '</div>';
      document.body.appendChild(el);
      st.el = el;
      st.frameEl = el.querySelector('.crop-frame');
      st.imgEl = el.querySelector('.crop-img');
      st.imgEl.src = st.url || st.img.src;

      // wire the buttons
      el.querySelector('.crop-x').addEventListener('click', cancel);
      el.querySelector('.crop-ok').addEventListener('click', apply);
      el.querySelector('[data-crop-reset]').addEventListener('click', function () { reset(); });
      el.querySelector('.crop-zoom').addEventListener('input', function (e) {
        var oldZ = st.zoom;
        st.zoom = parseFloat(e.target.value) || 1;
        // zoom around the frame's center
        var cx = st.frame.w / 2, cy = st.frame.h / 2;
        st.x = cx + (st.x - cx) * (st.zoom / oldZ);
        st.y = cy + (st.y - cy) * (st.zoom / oldZ);
        place();
      });
      el.querySelector('.crop-stage').addEventListener('dblclick', function () { reset(); });

      // drag (pointer events cover touch + mouse)
      var stage = el.querySelector('.crop-stage');
      var drag = null;
      stage.addEventListener('pointerdown', function (e) {
        if (!st) return;
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: st.x, oy: st.y };
        stage.setPointerCapture(e.pointerId);
        stage.classList.add('grabbing');
        e.preventDefault();
      });
      stage.addEventListener('pointermove', function (e) {
        if (!st || !drag || e.pointerId !== drag.id) return;
        st.x = drag.ox + (e.clientX - drag.x);
        st.y = drag.oy + (e.clientY - drag.y);
        place();
      });
      var up = function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        stage.classList.remove('grabbing');
      };
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);

      document.addEventListener('keydown', onKey, true);
      st._onResize = function () { if (st) { measure(); reset(); } };
      window.addEventListener('resize', st._onResize);

      // first layout
      requestAnimationFrame(function () {
        if (!st) return;
        measure();
        reset();
      });
    }

    // measure() needs the resize listener torn down with the overlay
    var _close = close;
    close = function () {
      if (st && st._onResize) window.removeEventListener('resize', st._onResize);
      _close();
    };

    return {
      open: open,
      close: function () { if (st) cancel(); },
      isOpen: function () { return !!st; }
    };
  })();

  window.UIPills = UIPills;
  window.GradientUI = GradientUI;
  window.CropUI = CropUI;
})();
