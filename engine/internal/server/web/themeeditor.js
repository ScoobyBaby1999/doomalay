// themeeditor.js — v1.03.3 THE THEME EDITOR (PLAN-V103 §4).
//
// THE USER SPEC: "Clicking to edit any color should bring up a new
// reusable panel page called Theme Editor… we show variables at fixed
// locations that update depending on what color or thing is pressed.
// At the top we should have 2 columns, 1 column with the name of the
// color variable that is being changed, next to it a box or pill that
// says 'Expand all tagged elements' which opens an overlay screen
// displaying a list of every single element that uses that color.
// Beneath that we should have 1 wide row with the colors banner,
// displaying its current gradient and color. Under that we reserve 2
// half-sized rows to display the colors making the gradient (5-6 max).
// We make the shuffle random pills smaller and more polished, and
// change the add color pill to a simple + that appears next to the
// latest color. Beneath them let's have 2 columns, on the left, the
// gradient type pills + angle slider; on the right, the color wheel
// (the wheel lands in v1.03.4 — the interim color input holds the
// column until then)."
//
// Architecture: ThemeEditor.open(target) pushes a PANEL VIEW (the
// panel's own navigation stack — ‹ back returns to the Colors tab).
// The target carries everything the page needs, INJECTED by the caller
// (appearance.js owns the spec seeding + the write path):
//   { kind: 'field', suffix, label, hint, spec, solid, canvas,
//     write(spec), extras?(bodyEl) }
// The editor never mutates the theme model directly — every change
// funnels through target.write (the same writeThemeVar path the
// popover used), so persistence + live apply + the .doomtheme fold
// semantics are the caller's single seam.
(function () {
  'use strict';

  // ── THE TAGGED REGISTRY — what "Expand all tagged elements" lists ──
  // Derived from docs/CENSUS-V099-SLOT-SCAN.md +
  // RESEARCH-V0982-ELEMENT-CATALOG.md (the 22-member taxonomy),
  // re-based on the v1.03.1 CARD assignments (nested boxes follow the
  // derived card, not the surface field directly).
  var TAGGED = {
    'surface': [
      ['The chat panel', 'the sliding panel\u2019s body + header — the main chat surface (Layer 1)'],
      ['Overlay screens', 'the rounded overlay card — providers, keys, recovery, the model browser'],
      ['The canvas chrome', 'the settings gear + the dock capsule — windows over the world'],
      ['Every nested card', 'the card color derives from it (settings sections, bubbles, tool pills)'],
      ['Borders + rings', 'every hairline, border + raised chrome derives from it'],
      ['The name pills', 'the chat icon name pills + sandbox badges (the card glass)']
    ],
    'ink': [
      ['All text', 'every label, paragraph + title rides this ink — the solid text track'],
      ['Text tints', 'the dimmer tiers (text-2/3) derive from it'],
      ['Borders + chrome', 'every hairline + raised control derives from it'],
      ['Card material', 'the card color mixes it into the surface'],
      ['Pill labels', 'the chat metadata + button labels']
    ],
    'canvas': [
      ['The world', 'the infinite grid canvas — the app\u2019s backdrop field'],
      ['The app background', 'the bg-app mix (this canvas + a touch of surface) behind everything'],
      ['The lattice', 'every dot, line + star paints over this field']
    ],
    'accent-1': [
      ['Your bubbles', 'the messages you send'],
      ['Sandbox + persona pills', 'the chat metadata pills that carry the primary tone'],
      ['Stars + halos', 'the canvas atom accents + the focus rings'],
      ['The default titles', 'the fmt Accent 1 stop defaults to it in the base scheme'],
      ['Primary actions', 'FABs, the selected states + the active pills']
    ],
    'accent-2': [
      ['Model + artifacts pills', 'the chat metadata pills for the model + artifacts'],
      ['Workspace chips', 'the workspace pill tint'],
      ['Secondary accents', 'the second family across the hub + overlays'],
      ['The default subheads', 'the fmt Accent 2 stop defaults to it in the base scheme']
    ],
    'accent-3': [
      ['The mind pill', 'the compact-mind metadata pill'],
      ['Third-family accents', 'the third accent family across the app'],
      ['The default emphasis', 'the fmt Accent 3 stop defaults to it in the base scheme']
    ]
  };
  var TAGGED_FMT = {
    'a1': [
      ['Headings + titles', 'every gradient title — section headers, artifact + card names'],
      ['Chatbot names', 'the icon name labels on the canvas'],
      ['Gatelock titles', 'the +model/+sandbox step titles'],
      ['Panel names', 'the panel header\u2019s chat name']
    ],
    'a2': [
      ['Subheads', 'the secondary heading tier'],
      ['Code tokens', 'the inline code + fenced code accent']
    ],
    'a3': [
      ['Emphasis', 'the emphasized text tier'],
      ['Links', 'the clickable text accent']
    ],
    'bright': [['Bold text', 'the bright/bold tier inside messages']],
    'link': [['Links', 'the link color in chat bodies']]
  };

  var MAX_STOPS = 6;   // v1.03: 15 → 6 (user spec: "a more reasonable 5-6")
  var TYPE_OPTIONS = [
    // [pill label, spec dir, needs canvas-family]
    ['linear', 'auto', false],
    ['radial', 'radial', false],
    ['mesh', 'mesh', false],
    ['pinstripe', 'pat-pinstripe', true],
    ['checker', 'pat-checker', true],
    ['texture', 'tex', true]
  ];

  // ── v1.03.4: THE WHEEL — the color math (culori, already vendored;
  // research verdict: no maintained MIT wheel lib exists — iro=MPL,
  // farbtastic=GPL, reinvented=WTFPL) ───────────────────────────────
  function CULORI() { return (typeof window !== 'undefined' && window.culori) || null; }
  function hexToHsv(hex) {
    var c = CULORI();
    var d = { h: 0, s: 0, v: 1 };
    if (!c) return d;
    try {
      var rgb = c.parse(String(hex || ''));
      if (!rgb) return d;
      var hsv = c.converter('hsv')(rgb);
      if (!hsv) return d;
      return { h: hsv.h || 0, s: hsv.s || 0, v: (hsv.v == null ? 1 : hsv.v) };
    } catch (e) { return d; }
  }
  function hsvToHex(h, s, v) {
    var c = CULORI();
    if (!c) return '#000000';
    try {
      return c.formatHex(c.converter('rgb')({ mode: 'hsv', h: h, s: s, v: v })) || '#000000';
    } catch (e) { return '#000000'; }
  }
  var HSV = { h: 0, s: 0, v: 1 };   // the wheel's live state (the SELECTED stop)

  // the curated COMMON COLORS (research-banked: the Open Color dark-
  // first set + the neutral ramp — 16 swatches)
  var COMMON = ['#FFFFFF', '#CED4DA', '#868E96', '#495057', '#212529', '#0B0C0E',
                '#FA5252', '#F08C00', '#FFD43B', '#74B816', '#2F9E44', '#0CA678',
                '#66D9E8', '#4DABF7', '#5F3DC4', '#B197FC'];

  // the LAST USED (spectrum's canonical pattern: max 7, hex-normalized
  // dedup, most-recent-first, localStorage-persisted, device-local —
  // deliberately NOT part of the .doomtheme state)
  var RECENT_KEY = 'doomalay.recentColors';
  function loadRecent() {
    try { var l = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(l) ? l.filter(function (x) { return /^#[0-9a-fA-F]{6}$/.test(x); }).slice(0, 7) : []; }
    catch (e) { return []; }
  }
  function saveRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 7))); } catch (e) {}
  }
  function pushRecents(hexes) {
    var l = loadRecent();
    (hexes || []).forEach(function (hx) {
      if (!/^#[0-9a-fA-F]{6}$/.test(hx)) return;
      l = l.filter(function (x) { return x.toLowerCase() !== hx.toLowerCase(); });
      l.unshift(hx.toLowerCase());
    });
    saveRecent(l);
  }

  function swatchHtml(list, attr) {
    var h = '';
    (list || []).forEach(function (c) {
      h += '<button type="button" class="te-sw" style="background:' + c + '" data-te-sw="' + c + '" aria-label="use ' + c + '"></button>';
    });
    return h || '<span class="te-sw-empty">—</span>';
  }


  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // G — the gradient engine (already vendored page-wide)
  function G() { return window.GradientUI || null; }

  function cssOf(spec, opts) {
    var g = G();
    try { return g ? g.css(spec, opts || {}) : (spec.colors[0] || '#000'); }
    catch (e) { return spec.colors[0] || '#000'; }
  }

  // ── the live write: rAF-coalesced, one write per frame max ────────
  function makeWriter(write) {
    var q = null;
    return function (spec) {
      q = spec;
      if (q._teQueued) return;
      q._teQueued = true;
      requestAnimationFrame(function () {
        if (q) { q._teQueued = false; try { write(q); } catch (e) { /* the caller owns errors */ } }
      });
    };
  }

  // ── the tagged overlay page ─────────────────────────────────────
  function openTagged(label, entries) {
    var CO = window.ConnectOverlay;
    if (!CO || !CO.pushPage) return;
    var rows = '';
    (entries || []).forEach(function (e, i) {
      rows +=
        '<div class="te-tag-row" style="animation:teRowIn .18s ease-out both ' + (i * 0.016).toFixed(3) + 's">' +
          '<div class="te-tag-name">' + esc(e[0]) + '</div>' +
          '<div class="te-tag-desc">' + esc(e[1]) + '</div>' +
        '</div>';
    });
    CO.pushPage(
      '<div class="te-tag-head">' +
        '<div class="te-tag-title">tagged · ' + esc(label).toLowerCase() + '</div>' +
        '<div class="te-tag-sub">' + (entries ? entries.length : 0) + ' element' + ((entries && entries.length === 1) ? '' : 's') + ' carry this color</div>' +
      '</div>' +
      '<div class="te-tag-list">' + (rows || '<div class="te-tag-desc">nothing carries this color yet</div>') + '</div>',
      { onSwap: function () {} }
    );
  }

  // ── the stops grid html ──────────────────────────────────────────
  function stopsHtml(spec, sel, canEdit) {
    var h = '<div class="te-stops-grid">';
    var n = spec.colors.length;
    for (var i = 0; i < n; i++) {
      h += '<button type="button" class="te-stop' + (i === sel ? ' sel' : '') + '" data-te-stop="' + i + '" ' +
        'style="background:' + spec.colors[i] + '" aria-label="color ' + (i + 1) + '" ' +
        (canEdit ? '' : 'disabled') + '>' +
        (i === sel && n > 2 ? '<span class="te-rm" data-te-rm="' + i + '" role="button" aria-label="remove this color">×</span>' : '') +
        '</button>';
    }
    if (n < MAX_STOPS) {
      h += '<button type="button" class="te-add" data-te-add aria-label="add a color"' + (canEdit ? '' : ' disabled') + '>+</button>';
    }
    h += '</div>';
    return h;
  }

  // ── the type pills html ──────────────────────────────────────────
  function typesHtml(spec, solid, canvas) {
    var cur = (spec && spec.tex && spec.tex.length > 4) ? 'tex' : (spec.dir || 'auto');
    var h = '';
    TYPE_OPTIONS.forEach(function (o) {
      var locked = solid || (o[2] && !canvas);
      var active = !locked && (o[1] === 'tex' ? (cur === 'tex') : (cur === o[1] && cur !== 'tex'));
      h += '<button type="button" class="te-type' + (active ? ' on' : '') + (locked ? ' lock' : '') +
        '" data-te-type="' + o[1] + '"' + (locked ? ' disabled aria-label="' + esc(o[0]) + ' — not available for this variable"' : ' aria-label="' + esc(o[0]) + ' gradient"') + '>' +
        esc(o[0]) + (locked ? '<span class="te-lock" aria-hidden="true">⌧</span>' : '') +
        '</button>';
    });
    return h;
  }

  // ── THE PAGE ─────────────────────────────────────────────────────
  function open(target) {
    // the panel: the MASTER panel (the one the settings gear opened —
    // Settings.panelOf), falling back to the live chat's panel
    var panel = (window.Settings && window.Settings.panelOf && window.Settings.panelOf()) ||
      (window.ChatPanel && window.ChatPanel.current() &&
        window.ChatPanel.current().panel) || null;
    if (!panel || !panel.pushView) return;
    if (!target || !target.spec) return;

    var spec = target.spec;
    var g = G();
    if (g && g.norm) spec = g.norm(spec);
    // v1.03.5: THE LEGACY DIR NORMALIZATION — the editor speaks the six
    // families only; stored legacy dirs map to their nearest family
    // (h/v/diag/diag2 → linear with the carried angle; swirl → radial;
    // pat-navy → pinstripe; gingham/sunburst → checker). The stored
    // spec keeps its legacy dir until the first write.
    var LEGACY_DIR_MAP = { 'h': 'auto', 'v': 'auto', 'diag': 'auto', 'diag2': 'auto',
                           'swirl': 'radial', 'pat-navy': 'pat-pinstripe',
                           'pat-gingham': 'pat-checker', 'pat-sunburst': 'pat-checker' };
    var LEGACY_ANGLE = { 'h': 90, 'v': 180, 'diag2': 315 };
    if (spec && LEGACY_DIR_MAP[spec.dir]) {
      var legacyDir = spec.dir;
      spec = { colors: spec.colors.slice(), dir: LEGACY_DIR_MAP[legacyDir],
               angle: (typeof spec.angle === 'number') ? spec.angle : LEGACY_ANGLE[legacyDir],
               tex: spec.tex };
    }
    // v1.03: the stop cap — 15 → 6. A stored >6 spec trims to its first
    // six on open (with a toast note; the trim persists on first write).
    var trimmed = false;
    if (spec.colors && spec.colors.length > MAX_STOPS) {
      spec = { colors: spec.colors.slice(0, MAX_STOPS), dir: spec.dir, angle: spec.angle, tex: spec.tex };
      trimmed = true;
    }
    var solid = !!target.solid;
    var sel = 0;
    var writeLive = makeWriter(function (s) { target.write(s); });
    if (trimmed && window.Hub && window.Hub.toast) {
      window.Hub.toast('trimmed to ' + MAX_STOPS + ' colors — the new cap');
    }

    var view = {
      title: 'Theme Editor',
      render: function () {
        var bannerCss = cssOf(spec, { scale: 1 });
        var bStyle = bannerCss.charAt(0) === '#'
          ? 'background-color:' + bannerCss + ';'
          : 'background-image:' + bannerCss + ';';
        return '<div class="te-page" data-te-root>' +
          // Row 1 — 2 columns: the variable name | the tagged pill
          '<div class="te-head">' +
            '<div class="te-name">' +
              '<b>' + esc(target.label || 'Color') + '</b>' +
              (target.hint ? '<span class="te-hint">' + esc(target.hint) + '</span>' : '') +
            '</div>' +
            '<button type="button" class="te-tagged" data-te-tagged aria-label="expand all tagged elements">' +
              '<span aria-hidden="true">⤢</span> Expand all tagged elements' +
            '</button>' +
          '</div>' +
          // Row 2 — the wide colors banner
          '<div class="te-banner" data-te-banner style="' + bStyle + '" aria-hidden="true"></div>' +
          // Rows 3-4 — the two half rows of stops
          '<div class="te-stops-wrap">' +
            '<div data-te-stops>' + stopsHtml(spec, sel, !solid) + '</div>' +
            '<div class="te-tools">' +
              '<button type="button" class="te-tool" data-te-shuffle aria-label="shuffle the colors" title="shuffle" ' + (solid ? 'disabled' : '') + '>⤨</button>' +
              '<button type="button" class="te-tool" data-te-random aria-label="randomize the colors" title="random" ' + (solid ? 'disabled' : '') + '>↻</button>' +
            '</div>' +
          '</div>' +
          // the 2 columns
          '<div class="te-cols">' +
            '<div class="te-left">' +
              '<div class="te-col-title">type</div>' +
              '<div class="te-types" data-te-types>' + typesHtml(spec, solid, !!target.canvas) + '</div>' +
              '<div class="te-col-title">angle</div>' +
              '<div class="te-angle">' +
                '<input type="range" min="0" max="360" step="5" value="' + (spec.angle || 0) + '" data-te-angle ' +
                  'aria-label="gradient angle"' + (solid ? ' disabled' : '') + '>' +
                '<span class="te-angle-v" data-te-angle-v>' + (spec.angle || 0) + '°</span>' +
              '</div>' +
            '</div>' +
            '<div class="te-right">' +
              '<div class="te-col-title">color</div>' +
              // v1.03.4: THE WHEEL — the CSS-composed HSV disc (conic hue
              // × the radial white overlay × the value darkener) + the
              // handle; the slim H/S/V sliders + the hex readout under
              // it; the common + last-used rows below (user spec)
              '<div class="te-wheel" data-te-wheel aria-label="color wheel — drag to pick the hue and saturation">' +
                '<div class="te-wheel-disc"></div>' +
                '<div class="te-wheel-white"></div>' +
                '<div class="te-wheel-val" data-te-wval></div>' +
                '<div class="te-wheel-handle" data-te-whandle></div>' +
              '</div>' +
              '<div class="te-hex-ro" data-te-hex>' + esc(spec.colors[sel] || '') + '</div>' +
              '<div class="te-srow"><span class="te-slab">H</span>' +
                '<input type="range" min="0" max="360" step="1" value="0" data-te-sl="h" aria-label="hue"></div>' +
              '<div class="te-srow"><span class="te-slab">S</span>' +
                '<input type="range" min="0" max="100" step="1" value="0" data-te-sl="s" aria-label="saturation"></div>' +
              '<div class="te-srow"><span class="te-slab">V</span>' +
                '<input type="range" min="0" max="100" step="1" value="100" data-te-sl="v" aria-label="value"></div>' +
              '<div class="te-col-title">common</div>' +
              '<div class="te-swatches" data-te-common>' + swatchHtml(COMMON) + '</div>' +
              '<div class="te-col-title">last used</div>' +
              '<div class="te-swatches" data-te-recent>' + swatchHtml(loadRecent()) + '</div>' +
            '</div>' +
          '</div>' +
          (target.extras ? '<div class="te-extras" data-te-extras></div>' : '') +
        '</div>';
      },
      onMount: function (root) {
        var el = root.querySelector('[data-te-root]');
        if (!el) return;

        function banner() { return el.querySelector('[data-te-banner]'); }
        function stopsBox() { return el.querySelector('[data-te-stops]'); }
        function typesBox() { return el.querySelector('[data-te-types]'); }

        function refreshStatic() {
          var bc = cssOf(spec, { scale: 1 });
          var b = banner();
          if (b) {
            if (bc.charAt(0) === '#') { b.style.backgroundImage = 'none'; b.style.backgroundColor = bc; }
            else { b.style.backgroundColor = 'transparent'; b.style.backgroundImage = bc; }
          }
          var t = typesBox();
          if (t) t.innerHTML = typesHtml(spec, solid, !!target.canvas);
          var ang = el.querySelector('[data-te-angle]');
          var angv = el.querySelector('[data-te-angle-v]');
          if (ang && document.activeElement !== ang) ang.value = String(spec.angle || 0);
          if (angv) angv.textContent = (spec.angle || 0) + '°';
        }
        function refreshStops() {
          var sb = stopsBox();
          if (sb) sb.innerHTML = stopsHtml(spec, sel, !solid);
          syncWheelFromStop();
          refreshStatic();
        }
        function shape() {
          // a shape change: write + rebuild the dynamic parts in place
          // (the view stays mounted — no scroll jump, no full rerender)
          target.write(spec);
          refreshStops();
        }

        // ── v1.03.4: THE WHEEL ──────────────────────────────────────
        // the disc = conic hue × the radial white overlay (s fades toward
        // the center) × the value darkener (v). The handle rides the
        // (h, s) polar position. All CSS — GPU-composited, zero rasters.
        var wheelEl = null, handleEl = null, valEl = null;
        function wheelEls() {
          wheelEl = wheelEl || el.querySelector('[data-te-wheel]');
          handleEl = handleEl || el.querySelector('[data-te-whandle]');
          valEl = valEl || el.querySelector('[data-te-wval]');
        }
        function syncWheelFromStop() {
          HSV = hexToHsv(spec.colors[sel]);
          paintWheel();
        }
        function paintWheel() {
          wheelEls();
          if (handleEl) {
            var phi = (HSV.h) * Math.PI / 180;   // 0° = top, clockwise
            var x = 50 + 50 * HSV.s * Math.sin(phi);
            var y = 50 - 50 * HSV.s * Math.cos(phi);
            handleEl.style.left = x + '%';
            handleEl.style.top = y + '%';
            handleEl.style.background = hsvToHex(HSV.h, HSV.s, 1);
            handleEl.style.borderColor = (HSV.v > 0.55) ? 'var(--surface-1)' : '#fff';
          }
          if (valEl) valEl.style.opacity = String(Math.max(0, Math.min(1, 1 - HSV.v)));
          var sl = { h: el.querySelector('[data-te-sl=h]'), s: el.querySelector('[data-te-sl=s]'), v: el.querySelector('[data-te-sl=v]') };
          if (sl.h && document.activeElement !== sl.h) sl.h.value = String(Math.round(HSV.h));
          if (sl.s && document.activeElement !== sl.s) sl.s.value = String(Math.round(HSV.s * 100));
          if (sl.v && document.activeElement !== sl.v) sl.v.value = String(Math.round(HSV.v * 100));
          // the slider tracks (S + V depend on the current h/v)
          if (sl.s) sl.s.style.background = 'linear-gradient(to right, ' + hsvToHex(HSV.h, 0, HSV.v) + ', ' + hsvToHex(HSV.h, 1, HSV.v) + ')';
          if (sl.v) sl.v.style.background = 'linear-gradient(to right, #000000, ' + hsvToHex(HSV.h, HSV.s, 1) + ')';
          var hx = el.querySelector('[data-te-hex]');
          if (hx) hx.textContent = hsvToHex(HSV.h, HSV.s, HSV.v);
        }
        function applyHsv() {
          var hex = hsvToHex(HSV.h, HSV.s, HSV.v);
          spec.colors[sel] = hex;
          var stop = el.querySelector('.te-stop.sel');
          if (stop) stop.style.background = hex;
          var b = banner();
          if (b) {
            var bc2 = cssOf(spec, { scale: 1 });
            if (bc2.charAt(0) === '#') { b.style.backgroundImage = 'none'; b.style.backgroundColor = bc2; }
            else { b.style.backgroundColor = 'transparent'; b.style.backgroundImage = bc2; }
          }
          paintWheel();
          writeLive(spec);
        }
        function wheelPointToHsv(ev) {
          wheelEls();
          if (!wheelEl) return;
          var r = wheelEl.getBoundingClientRect();
          if (!r.width) return;
          var dx = ev.clientX - (r.left + r.width / 2);
          var dy = ev.clientY - (r.top + r.height / 2);
          var rad = Math.sqrt(dx * dx + dy * dy) / (r.width / 2);
          HSV.s = Math.max(0, Math.min(1, rad));
          var phi = Math.atan2(dx, -dy) * 180 / Math.PI;   // 0° = top, clockwise
          if (phi < 0) phi += 360;
          HSV.h = phi;
        }
        (function wireWheel() {
          wheelEls();
          if (!wheelEl) return;
          var dragging = false;
          wheelEl.addEventListener('pointerdown', function (ev) {
            dragging = true;
            try { wheelEl.setPointerCapture(ev.pointerId); } catch (e) {}
            wheelPointToHsv(ev);
            applyHsv();
            ev.preventDefault();
          });
          wheelEl.addEventListener('pointermove', function (ev) {
            if (!dragging) return;
            wheelPointToHsv(ev);
            applyHsv();
          });
          var up = function () { dragging = false; };
          wheelEl.addEventListener('pointerup', up);
          wheelEl.addEventListener('pointercancel', up);
        })();

        // the delegated wiring (one root listener — survives rebuilds)
        el.addEventListener('click', function (ev) {
          var t = ev.target;
          // the × must be checked BEFORE the stop (the × lives INSIDE
          // the stop button — the stop branch would swallow it)
          var rm = t.closest ? t.closest('[data-te-rm]') : null;
          if (rm) {
            ev.stopPropagation();
            if (spec.colors.length > 2) {
              spec.colors.splice(sel, 1);
              if (sel >= spec.colors.length) sel = spec.colors.length - 1;
              shape();
            }
            return;
          }
          var stopB = t.closest ? t.closest('[data-te-stop]') : null;
          if (stopB) {
            sel = parseInt(stopB.getAttribute('data-te-stop'), 10) || 0;
            refreshStops();
            return;
          }
          if (t.closest('[data-te-add]')) {
            if (spec.colors.length < MAX_STOPS) {
              var gg = G();
              var c = '#808090';
              try { if (gg && gg.random) c = gg.random(1)[0]; } catch (e) {}
              spec.colors.push(c);
              sel = spec.colors.length - 1;
              shape();
            }
            return;
          }
          if (t.closest('[data-te-shuffle]')) {
            var gs = G();
            if (gs && gs.random && spec.colors.length) {
              // shuffle = same count, new hues (the GradientUI contract)
              var r = gs.random(spec.colors.length);
              for (var si = 0; si < r.length && si < spec.colors.length; si++) {
                spec.colors[si] = r[si];
              }
              shape();
            }
            return;
          }
          if (t.closest('[data-te-random]')) {
            var gr = G();
            if (gr && gr.random) {
              try {
                var keep = spec.dir;
                var cnt = Math.max(2, Math.min(MAX_STOPS, 2 + Math.floor(Math.random() * (MAX_STOPS - 1))));
                spec.colors = gr.random(cnt);
                spec.dir = keep;
              } catch (e) {}
              sel = 0;
              shape();
            }
            return;
          }
          var typeB = t.closest ? t.closest('[data-te-type]') : null;
          if (typeB && !typeB.disabled) {
            var d = typeB.getAttribute('data-te-type');
            if (d === 'tex') {
              // the texture path: a hidden file input reads the dataURL
              var fi = document.createElement('input');
              fi.type = 'file';
              fi.accept = 'image/*';
              fi.addEventListener('change', function () {
                var f = fi.files && fi.files[0];
                if (!f) return;
                var rd = new FileReader();
                rd.onload = function () {
                  spec.tex = String(rd.result || '');
                  spec.dir = 'auto';
                  shape();
                };
                rd.readAsDataURL(f);
              });
              fi.click();
            } else {
              spec.dir = d;
              spec.tex = '';
              shape();
            }
            return;
          }
          if (t.closest('[data-te-tagged]')) {
            var entries = TAGGED[target.suffix] || TAGGED_FMT[target.suffix] || null;
            openTagged(target.label || target.suffix, entries);
            return;
          }
        });

        // the live-value controls
        el.addEventListener('input', function (ev) {
          var t = ev.target;
          if (t.matches('[data-te-sl]')) {
            var dim = t.getAttribute('data-te-sl');
            var n = parseFloat(t.value) || 0;
            if (dim === 'h') HSV.h = Math.max(0, Math.min(360, n));
            else if (dim === 's') HSV.s = Math.max(0, Math.min(1, n / 100));
            else if (dim === 'v') HSV.v = Math.max(0, Math.min(1, n / 100));
            applyHsv();
            return;
          }
          if (t.matches('[data-te-angle]')) {
            spec.angle = parseInt(t.value, 10) || 0;
            var angv = el.querySelector('[data-te-angle-v]');
            if (angv) angv.textContent = spec.angle + '°';
            writeLive(spec);
          }
        });

        // the swatch clicks (common + last used)
        el.addEventListener('click', function (ev) {
          var sw = ev.target.closest ? ev.target.closest('[data-te-sw]') : null;
          if (!sw) return;
          var c = sw.getAttribute('data-te-sw');
          if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
          spec.colors[sel] = c;
          var stop = el.querySelector('.te-stop.sel');
          if (stop) stop.style.background = c;
          syncWheelFromStop();
          var b = banner();
          if (b) {
            var bc2 = cssOf(spec, { scale: 1 });
            if (bc2.charAt(0) === '#') { b.style.backgroundImage = 'none'; b.style.backgroundColor = bc2; }
            else { b.style.backgroundColor = 'transparent'; b.style.backgroundImage = bc2; }
          }
          writeLive(spec);
        });

        // the canvas extras (grid children + the MCU suggester) —
        // injected by the caller so the editor owns no canvas logic
        if (target.extras) {
          var ex = el.querySelector('[data-te-extras]');
          if (ex) { try { target.extras(ex); } catch (e) { console.error('te extras', e); } }
        }

        // the initial wheel paint (the selected stop's color)
        syncWheelFromStop();
      },
      onClose: function () {
        // v1.03.4: the close-time recents capture — every applied color
        // becomes a "last used" (the selected stop first in the list)
        try {
          var ordered = [];
          if (spec.colors && spec.colors.length) {
            var rest = spec.colors.slice();
            var picked = rest.splice(sel, 1)[0];
            if (picked) ordered.push(picked);
            ordered = ordered.concat(rest);
          }
          // pushRecents unshifts per hex — pass the reverse so the final
          // list reads most-recent-first (the selected stop at the head)
          pushRecents(ordered.reverse());
        } catch (e) {}
      }
    };
    panel.pushView(view);
  }

  window.ThemeEditor = { open: open, tagged: TAGGED, maxStops: MAX_STOPS };
})();
