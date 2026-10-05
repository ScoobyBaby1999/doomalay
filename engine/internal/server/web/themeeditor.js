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
    // [tile label, spec dir, needs canvas-family]
    ['linear', 'auto', false],
    ['radial', 'radial', false],
    ['mesh', 'mesh', false],
    ['pinstripe', 'pat-pinstripe', true],
    ['checker', 'pat-checker', true],
    ['texture', 'tex', true]
  ];
  // v1.04.1 F2: THE TILE GLYPHS — real inline SVG (stroke=currentColor,
  // lucide-style geometry), replacing the text-only pills whose locked
  // state rendered the '⌧' U+2327 glyph (tofu on Android fonts — "the
  // icons for pinstripe, checkers, and texture have broken icons":
  // exactly the three canvas-only types that lock on non-canvas fields).
  var SVG_OPEN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  var TYPE_ICONS = {
    'auto': SVG_OPEN + '<line x1="4" y1="20" x2="20" y2="4"/><line x1="9" y1="21" x2="21" y2="9" opacity="0.45"/></svg>',
    'radial': SVG_OPEN + '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>',
    'mesh': SVG_OPEN + '<circle cx="7" cy="8" r="2.2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="6.5" r="2.2" fill="currentColor" stroke="none"/><circle cx="12" cy="15" r="2.2" fill="currentColor" stroke="none"/><circle cx="5.5" cy="17" r="1.6" fill="currentColor" stroke="none" opacity="0.55"/><circle cx="18.5" cy="16" r="1.6" fill="currentColor" stroke="none" opacity="0.55"/></svg>',
    'pat-pinstripe': SVG_OPEN + '<line x1="5" y1="4" x2="5" y2="20"/><line x1="10" y1="4" x2="10" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/><line x1="20" y1="4" x2="20" y2="20" opacity="0.45"/></svg>',
    'pat-checker': SVG_OPEN + '<rect x="4" y="4" width="7" height="7" fill="currentColor" stroke="none"/><rect x="13" y="13" width="7" height="7" fill="currentColor" stroke="none"/><rect x="13" y="4" width="7" height="7" opacity="0.35"/><rect x="4" y="13" width="7" height="7" opacity="0.35"/></svg>',
    'tex': SVG_OPEN + '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="9" cy="9" r="1.6" fill="currentColor" stroke="none"/><path d="M20.5 15.2l-4.6-4.6a1.4 1.4 0 0 0-2 0L4 20.5"/></svg>'
  };
  var LOCK_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" ' +
    'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

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
  // v1.04.1 F3: the queue flag is a CLOSURE variable — the old
  // q._teQueued stamped the flag ON the spec object itself, and the
  // spec is exactly what writeThemeVar persists into themeOverrides:
  // every dragged editor left a stray _teQueued:false in the saved
  // state (data pollution in the .doomtheme exports).
  function makeWriter(write) {
    var queued = false;
    return function (spec) {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        try { write(spec); } catch (e) { /* the caller owns errors */ }
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

  // ── the type tiles html ──────────────────────────────────────────
  // v1.04.1 F2: a DISTINCT family from the app's standard pill set
  // (user spec: "the type column pills a different style from our set
  // list of objects — something else from this"): outline tiles, no
  // chrome fill — the glyph + the label stacked, selected = the accent
  // ring + tint, locked = the padlock badge (a real SVG — the old ⌧
  // text glyph was the broken icon). F4: the texture tile SELECTS the
  // type — it no longer browses (the tex row below owns the import).
  function typesHtml(spec, solid, canvas) {
    var cur = (spec && spec.tex && spec.tex.length > 4) ? 'tex' : (spec.dir || 'auto');
    var h = '';
    TYPE_OPTIONS.forEach(function (o) {
      var locked = solid || (o[2] && !canvas);
      var active = !locked && (o[1] === 'tex' ? (cur === 'tex') : (cur === o[1] && cur !== 'tex'));
      h += '<button type="button" class="te-tile' + (active ? ' on' : '') + (locked ? ' lock' : '') +
        '" data-te-type="' + o[1] + '"' + (locked ? ' disabled aria-label="' + esc(o[0]) + ' — not available for this variable"' : ' aria-label="' + esc(o[0]) + ' gradient"') + '>' +
        '<span class="te-tile-ico">' + (TYPE_ICONS[o[1]] || '') + '</span>' +
        '<span class="te-tile-lab">' + esc(o[0]) + '</span>' +
        (locked ? '<span class="te-tile-lock">' + LOCK_ICON + '</span>' : '') +
        '</button>';
    });
    return h;
  }

  // v1.04.1 F4: THE TEX ROW — the image import, SEPARATED from the
  // texture type (user spec: "separate the texture functionality from
  // the browse an image functionality — maybe we may find it useful
  // later to do something different when a texture is imported"). The
  // row only renders for the canvas family (the only tex-capable
  // fields); when a texture is active it also offers the drop.
  function texRowHtml(spec, solid, canvas) {
    if (solid || !canvas) return '';
    var has = !!(spec && spec.tex && spec.tex.length > 4);
    return '<div class="te-tex-row"' + (has ? ' data-te-tex="on"' : '') + '>' +
      '<button type="button" class="te-tex-btn" data-te-tex-import>' +
        '<span class="te-tile-ico">' + TYPE_ICONS.tex + '</span>' +
        (has ? 'replace image' : 'import image') +
      '</button>' +
      (has ? '<button type="button" class="te-tex-btn" data-te-tex-clear aria-label="drop the texture">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        'clear' +
      '</button>' : '') +
    '</div>';
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
              '<div data-te-texrow>' + texRowHtml(spec, solid, !!target.canvas) + '</div>' +
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
          var tr = el.querySelector('[data-te-texrow]');
          if (tr) tr.innerHTML = texRowHtml(spec, solid, !!target.canvas);
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

        // v1.04.1 F4: the image import, extracted to its own seam (the
        // texture TYPE no longer owns the browse — a future import can
        // do something different with the asset here).
        function openTexImport() {
          var fi = document.createElement('input');
          fi.type = 'file';
          fi.accept = 'image/*';
          fi.addEventListener('change', function () {
            var f = fi.files && fi.files[0];
            if (!f) return;
            var rd = new FileReader();
            rd.onload = function () {
              spec.tex = String(rd.result || '');
              shape();   // the tex PRESENCE is the texture mode
            };
            rd.readAsDataURL(f);
          });
          fi.click();
        }

        // v1.04.1 F3: the banner's LIVE paint — one direct style write
        // (no innerHTML, no re-render, no stops/types rebuild). The
        // SAME shape applyHsv uses; the app-wide write stays rAF-
        // coalesced through writeLive.
        function paintBannerLive() {
          var b = banner();
          if (!b) return;
          var bc = cssOf(spec, { scale: 1 });
          if (bc.charAt(0) === '#') { b.style.backgroundImage = 'none'; b.style.backgroundColor = bc; }
          else { b.style.backgroundColor = 'transparent'; b.style.backgroundImage = bc; }
          // the anchor row's banner (the Colors tab behind the editor)
          // follows too — the element reference survives the stash.
          if (target.row) {
            var bEl = target.row.querySelector('.slot-row-banner');
            if (bEl) {
              var v = (window.GradientUI && window.GradientUI.css)
                ? window.GradientUI.css(spec, { scale: 0.28 }) : spec.colors[0];
              if (v.charAt(0) === '#') { bEl.style.backgroundImage = 'none'; bEl.style.backgroundColor = v; }
              else { bEl.style.backgroundColor = 'transparent'; bEl.style.backgroundImage = v; }
            }
          }
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
              // v1.04.1 F4: the texture tile SELECTS the type — it never
              // browses directly anymore (the tex row owns the import).
              // The MODE is the tex PRESENCE (norm carries no 'tex' dir —
              // css() layers the url() under whatever dir is set): with an
              // image loaded the tile is already active (re-commit); with
              // none there is nothing to select — the import is the entry.
              if (spec.tex && spec.tex.length > 4) {
                shape();
              } else {
                openTexImport();
              }
            } else {
              spec.dir = d;
              spec.tex = '';   // leaving the texture mode drops the layer
              shape();
            }
            return;
          }
          // v1.04.1 F4: THE TEX ROW — the import (browse an image) is a
          // SEPARATE affordance from the type. A future import may do
          // something different with the asset (the user's stated
          // direction); this seam is where it lands.
          if (t.closest('[data-te-tex-import]')) { openTexImport(); return; }
          if (t.closest('[data-te-tex-clear]')) {
            spec.tex = '';   // the mode is the tex presence — drop = linear
            shape();
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
            // v1.04.1 F3 (user report: "changing the angle slider doesn't
            // update the banner live in a performant method without
            // re-rendering the whole panel every change"): the banner
            // paints DIRECTLY per input event — one style write, zero
            // innerHTML, zero view rebuilds. The app-wide theme apply
            // stays rAF-coalesced (one write per frame max) below.
            paintBannerLive();
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
