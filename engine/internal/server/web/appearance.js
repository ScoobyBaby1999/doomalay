// appearance.js — v0.44 the Colors / Sizing / General settings pages.
//
// USER SPEC (v0.24, the theme round):
//   "Currently we have chat colors, this is to be reworked to colors in
//    general, and chat colors and advanced formatting is included inside
//    the colors in general... The grid colors that we also have currently
//    should be moved into the general colors section aswell. Chat text
//    size and grid size should also merge, all resizing changes should
//    merge to one section aswell... change chat text size to text size
//    and offer a scale for chat text size, general text size, small text
//    size, ext."
//
// USER SPEC (v0.44, the color-system round):
//   "Let's rework the color system entirely. Everywhere in the chat where
//    we offer the user to change color. For each option it must use the
//    gradient system, even in settings. So a text, pill, of any visuals
//    feature may be colored gradient instead of solid. Using our current
//    gradient system. Most things will probably offer 1 color by default,
//    user can add up to 15... allow the user to change the direction and
//    aesthetic of the gradient."
//
// EVERY color row on these pages is now a compact GradientUI editor
// (uikit.js): theme-customize vars, the four grid colors, and the five
// chat-markdown slots all store gradient SPECS ({colors[1..15], dir,
// angle?} — legacy hexes still load fine, norm() folds them). The
// editors write back through Settings.setState exactly like the old
// color inputs did; theme.js / formatter.js translate specs into the
// VAR-TWIN pairs (--X solid + --X-gradient image) that index.html's
// consumer rules paint.
//
// Pages:
//   🎨 Colors  — the app theme (10 palettes) · customize THIS theme
//               (gradient editors per var) · grid colors (spec-capable,
//               theme-driven until customized) · chat colors (markdown
//               scheme presets + per-slot gradient editors)
//   📐 Sizing  — chat text · general text · small text · grid size
//   ⚙️ General — font family · default chatbot names · view reset
//
// All sections are collapsible (smooth grid-rows unfold) and collapsed by
// default. All changes apply live and persist to localStorage.
//
// v0.30: the row builders are PARAMETERIZED (…UI functions at the bottom)
// and exported as window.AppearanceUI — the per-chat ✦ tweaks view
// (tweaks.js) renders the SAME controls over its own store instead of
// duplicating this markup. The fmt routing branches on
// data-scope="chat" so one handler serves both stores.
// v0.44: AppearanceUI.wireFmtEditors(rootEl) wires the shared fmt rows
// AFTER a host view inserts them (the tweaks view calls it on its own
// root; the settings page's own wiring runs on the page token root).

(function () {
  'use strict';

  const Settings = window.Settings;

  // ── v0.44 GRADIENT-EDITOR WIRING ─────────────────────────────────
  // render() returns HTML STRINGS, but GradientUI.wire() needs the LIVE
  // elements — and settings.js inserts the string synchronously right
  // after render() returns (panel.open → bodyEl.innerHTML). So: every
  // appearance-page render bumps a TOKEN (the page HTML wraps in
  // [data-appr-render="r<token>"]), the row builders queue their
  // {editor id, spec, live, rebuild} entries, and one requestAnimationFrame
  // later the queue drains against the token root. A newer render before
  // the rAF fires simply resets the queue (the drain reads the LATEST
  // entries; superseded elements are already gone from the DOM). Each
  // element is therefore wired EXACTLY ONCE — re-renders replace the DOM,
  // and the token lookup never crosses into another panel's view (the
  // per-chat tweaks rows are wired by the transitional bridge below / a
  // native wireFmtEditors call from tweaks.js).
  var renderToken = 0;
  var pendingWires = [];
  var wireRaf = 0;

  function queueEditorWire(elId, spec, onLive, onRebuild) {
    pendingWires.push({ id: elId, spec: spec, live: onLive, rebuild: onRebuild });
  }

  // pageRender — the appearance page's render wrapper: bump the token,
  // wrap, schedule. v0.44.1 CRITICAL FIX: the queue must NOT be reset
  // here — the page's render() call is `pageRender(sectionA() + sectionB() + …)`
  // and JavaScript evaluates that ARGUMENT (every section building +
  // queueEditorWire pushing) BEFORE pageRender itself runs. The old
  // `pendingWires = []` executed AFTER the pushes and WIPED the fresh
  // queue — no appearance editor ever wired (only the fmt registry
  // worked; live-observed in the W5 redteam). Stale wires from a
  // superseded render are instead dropped by draining the queue into a
  // DEDUP map at drain time (last entry per editor id wins), and the
  // drain clears the queue as it reads it.
  function pageRender(inner) {
    renderToken++;
    scheduleEditorWiring();
    return '<div data-appr-render="r' + renderToken + '">' + inner + '</div>';
  }

  function scheduleEditorWiring() {
    if (wireRaf) return;             // one flight — it drains the LATEST queue
    var run = function () {
      wireRaf = 0;
      drainEditorWires();
    };
    if (typeof requestAnimationFrame === 'function') {
      wireRaf = requestAnimationFrame(run);
    } else { setTimeout(run, 0); }
  }

  function drainEditorWires() {
    var queue = pendingWires;
    pendingWires = [];
    // v0.44.1: dedupe by editor id — LAST entry wins. A superseded render
    // may have queued wires for the same ids before its rAF fired; both
    // point at the same (fresh) DOM ids, so double-wiring would
    // double-fire. The last queue entry is the newest render's.
    var byId = {};
    var order = [];
    queue.forEach(function (w) {
      if (!byId[w.id]) order.push(w.id);
      byId[w.id] = w;
    });
    var G = window.GradientUI;
    if (!G || !G.wire) return;
    var root = document.querySelector('[data-appr-render="r' + renderToken + '"]');
    if (!root || !root.isConnected) return;   // panel closed / replaced
    order.forEach(function (id) {
      var w = byId[id];
      var el = root.querySelector('#' + w.id);
      if (el) G.wire(el, { spec: w.spec, live: w.live, rebuild: w.rebuild });
    });
    // the fmt slot rows built through the shared builder (scope "" —
    // the per-chat rows are wired by bridgeFmtChatRows / tweaks.js)
    wireFmtEditors(root);
    // v0.45 ITEM 5: wire the collapsed color rows (expand/collapse + per-row reset)
    wireColorRows(root);
  }

  // ── v0.54 refreshEditorInPlace — swap ONE row's editor markup +
  // re-wire, keeping the row the user is working in EXPANDED. The old
  // rebuild path ran Settings.rerender(), which preserved sections +
  // scroll but COLLAPSED the open color row — every dir pill tap or
  // color add slammed the editor shut (the "prototypish" churn the
  // user reported). Returns false when the row left the DOM (panel
  // closed/superseded) — callers fall back to the full rerender.
  function refreshEditorInPlace(pfx, spec, edOpts, rewire) {
    var G = window.GradientUI;
    var ed = document.getElementById(pfx + '-gr');
    var row = (ed && ed.closest) ? ed.closest('.color-row-collapsed') : null;
    var body = row ? row.querySelector('[data-color-body]') : null;
    if (!G || !ed || !row || !body || !document.contains(ed)) return false;
    body.innerHTML = G.editor(pfx, spec, edOpts || {});
    try { rewire(); } catch (e) { /* never fatal */ }
    // the '· customized' marker appears once an override exists
    // v0.77.7: the marker wears the .crc-mark CLASS — its color lives in
    // index.html (var(--accent)), so the derived gates convert it to a
    // real accent-1 GLYPH WINDOW when accent-1 is a gradient, and the
    // text-grad override retires the z-fight (the old inline
    // color:var(--accent) painted OVER the parent's clipped text-1
    // field — both colors rendering over each other, the user's report).
    var name = row.querySelector('.color-row-name');
    if (name && !name.querySelector('.crc-mark')) {
      name.insertAdjacentHTML('beforeend',
        ' <span class="crc-mark">· customized</span>');
    }
    return true;
  }

  // ── the shared fmt row registry + wiring (tweaks.js reuses the rows) ─
  var fmtSpecs = {};   // 'slot|scope' → the live spec the row was built with
  var FMT_SLOTS_ALL = ['a1', 'a2', 'a3', 'bright', 'link'];

  // wireFmtEditors(rootEl) — wire every [data-fmt-slot] row under rootEl:
  //   live()    → route the write (chat scope → ChatTweaks.setFmtSlot,
  //               global → Settings.setState({fmtOverrides}))
  //   rebuild() → write + re-render: chat scope re-renders ONLY the row's
  //               own editor in place (the tweaks view's DOM is not ours
  //               to rebuild); global re-renders the whole settings page
  //               (Settings.rerender preserves expanded sections + scroll)
  function wireFmtEditors(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    var rows = rootEl.querySelectorAll('[data-fmt-slot]');
    rows.forEach(wireFmtRow);
  }

  function wireFmtRow(rowEl) {
    var G = window.GradientUI;
    if (!G || !G.wire) return;
    var slot = rowEl.getAttribute('data-fmt-slot');
    var scope = rowEl.getAttribute('data-fmt-scope') || '';
    var spec = fmtSpecs[slot + '|' + scope];
    if (!slot || !spec) return;
    var editorEl = rowEl.querySelector('.gr-editor');
    // idempotent: the flag lives on the EDITOR element (fresh markup =
    // fresh flag) so the local rebuild re-wire + any host-side native
    // wiring + the transitional observer never stack duplicate handlers
    if (!editorEl || editorEl._fmtWired) return;
    editorEl._fmtWired = 1;
    var live = function () { routeFmtWrite(slot, scope, spec); };
    var rebuild = function () {
      routeFmtWrite(slot, scope, spec);
      if (scope === 'chat') {
        // LOCAL in-place rebuild — swap the editor's own markup + re-wire
        // (works regardless of the host view's re-render internals)
        var host = editorEl.parentNode;
        if (host) {
          host.innerHTML = G.editor('fmt-' + slot, spec, { noTex: true });
          wireFmtRow(rowEl);
        }
      } else {
        // v0.54: the GLOBAL rows refresh in place too (no full rerender
        // that would collapse the row) — the chat-scope pattern, applied
        routeFmtWrite(slot, scope, spec);
        var ok = refreshEditorInPlace('fmt-' + slot, spec, { noTex: true },
          function () { wireFmtRow(rowEl); });
        if (!ok) Settings.rerender();
      }
    };
    G.wire(editorEl, { spec: spec, live: live, rebuild: rebuild });
  }

  function routeFmtWrite(slot, scope, spec) {
    if (scope === 'chat') {
      // the per-chat tweaks store (tweaks.js accepts specs — the scoped
      // handler contract v0.30 kept verbatim)
      if (window.ChatTweaks) window.ChatTweaks.setFmtSlot(slot, spec);
      // tweaks.apply() repaints --fmt-<slot> from the RAW store values,
      // which can't express a gradient — restore the real twins on
      // #chat-root right AFTER (see paintChatFmtTwins)
      paintChatFmtTwins();
      return;
    }
    var s = Settings.getState();
    var ov = Object.assign({}, s.fmtOverrides || {});
    ov[slot] = spec;
    Settings.setState({ fmtOverrides: ov });
  }

  // paintChatFmtTwins — the per-chat twin paint on #chat-root (the same
  // slot treatment formatter.applyScheme gives :root). Called after every
  // chat-scope write; uses the fmtSpecs registry the builder filled when
  // the tweaks view rendered (the LIVE spec objects — wire() mutates
  // them in place, so the registry is always current for the open view).
  // Exposed on AppearanceUI so a future spec-aware tweaks.js can reuse
  // exactly this writer.
  function paintChatFmtTwins() {
    var derive = (window.DoomTheme && window.DoomTheme.deriveTwins) || null;
    var root = document.getElementById('chat-root');
    if (!derive || !root || !root.style) return;
    var gradSlots = [];
    FMT_SLOTS_ALL.forEach(function (k) {
      var spec = fmtSpecs[k + '|chat'];
      if (!spec) return;                        // view not rendered — nothing to paint
      var twins = derive(spec);
      root.style.setProperty('--fmt-' + k, twins.solid);
      root.style.setProperty('--fmt-' + k + '-gradient', twins.grad);
      if (twins.grad !== 'none') {
        gradSlots.push(k);
        root.style.setProperty('--fmt-' + k + '-ink', 'transparent');
      } else {
        root.style.removeProperty('--fmt-' + k + '-ink');
      }
    });
    // the chat's OWN gradient list — a slot the GLOBAL side paints as a
    // gradient but THIS chat owns as a solid opts out via its own ink
    // override (index.html's [data-fmt-grad] rules explain the mechanism)
    if (root.setAttribute) {
      if (gradSlots.length) root.setAttribute('data-fmt-grad', gradSlots.join(' '));
      else if (root.removeAttribute) root.removeAttribute('data-fmt-grad');
    }
  }

  // ── v0.44 TRANSITIONAL BRIDGE — auto-wire the tweaks view's fmt rows ─
  // The per-chat ✦ tweaks view (tweaks.js — NOT this file's to touch)
  // renders the SAME fmt rows through the shared builder, but has no
  // wiring hook of its own: the OLD color inputs were served by the
  // global 'input' listener the editor conversion removed. Bridge, with
  // ZERO touches to tweaks.js: ONE MutationObserver on document.body
  // watches for [data-fmt-scope="chat"] rows appearing anywhere (the
  // tweaks view renders into the chat panel's body) and wires them via
  // wireFmtRow (idempotent — a native AppearanceUI.wireFmtEditors call
  // from tweaks.js would set the editor flag first, in the same
  // synchronous stack, and this observer would then skip).
  // TRANSITIONAL: when tweaks.js wires its rows natively + applies specs
  // on #chat-root itself, DELETE this block — the routing stays
  // identical (setFmtSlot(slot, spec) + the twin paint).
  var CHAT_ROW_SEL = '[data-fmt-slot][data-fmt-scope="chat"]';
  function bridgeFmtChatRows() {
    if (typeof MutationObserver !== 'function') return;
    if (!document.body) return;
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var nd = nodes[j];
          if (nd.nodeType !== 1) continue;      // skip text / comment nodes
          if (nd.matches && nd.matches(CHAT_ROW_SEL)) wireFmtRow(nd);
          if (nd.querySelectorAll) {
            nd.querySelectorAll(CHAT_ROW_SEL).forEach(wireFmtRow);
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  bridgeFmtChatRows();

  // ── theme picker ───────────────────────────────────────────────
  // A swatch card per theme: 3 accent dots on the theme's own surface
  // colors, so the picker previews the real feel.
  function themeSwatches() {
    var current = Settings.getState().theme || 'midnight';
    return schemeThemeSwatches(current, '');
  }

  // v0.30: the swatch grid, PARAMETERIZED — the same builder drives the
  // settings page (global) and any scoped view that reuses it.
  // v1.01.5: THE SELF-COLORED CHIPS (user spec: "the theme boxes are the
  // only thing in the app that can have their own colors that don't
  // follow the user defined gradients but actually reflect the theme
  // itself. And should not be white rendered boxes"). Every color is a
  // RAW HEX from the theme model (DoomTheme.themePreview — the static
  // [data-theme] block + the THEMES accents): card = the theme's own
  // surface, the strip = its canvas, the dots = its accents, the label
  // = its own ink. ZERO CSS vars — a live surface gradient or a bright
  // custom ink can never wash or whiten them.
  function schemeThemeSwatches(current, scope) {
    var themes = (window.DoomTheme && window.DoomTheme.themes) || {};
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:8px 0 4px">';
    Object.keys(themes).forEach(function (id) {
      var t = themes[id];
      var sel = id === current;
      var p = (window.DoomTheme && window.DoomTheme.themePreview)
        ? window.DoomTheme.themePreview(id) : null;
      var surf = (p && p.surface) || '#14141a';
      var ink = (p && p.ink) || '#e0e0e8';
      var canv = (p && p.canvas) || '#101016';
      var acc = (p && p.accents) || [t.accent, t.accent2, t.accent3];
      html += '<button data-action="set-theme" data-theme="' + id + '"' + (scope ? ' data-scope="' + scope + '"' : '') + ' ' +
        'style="display:flex;flex-direction:column;gap:6px;align-items:flex-start;' +
        'background:' + surf + ';border:1.5px solid ' + (sel ? (acc[0] || t.accent) : 'rgba(255,255,255,0.10)') + ';' +
        'border-radius:12px;padding:10px;cursor:pointer;font-family:inherit;' +
        (sel ? 'box-shadow:0 0 0 2px ' + (acc[0] || t.accent) + '40;' : '') + '">' +
        '<span style="display:flex;width:100%;gap:2px;align-items:center">' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + acc[0] + ';display:inline-block"></i>' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + acc[1] + ';display:inline-block"></i>' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + acc[2] + ';display:inline-block"></i>' +
          '<i style="width:10px;height:6px;border-radius:3px;background:' + canv + ';display:inline-block;flex-shrink:0"></i>' +
        '</span>' +
        (t.light ? '<span style="font-size:var(--ui-micro-fs);color:' + ink + '99;font-weight:600">light</span>' : '') +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;color:' + ink + '">' + t.label + '</span>' +
        '</button>';
    });
    html += '</div>';
    // v0.56: no intro hint (user spec — remove the text descriptions in
    // theme / customize; the swatches are self-descriptive).
    return html;
  }

  // ── grid colors (theme-driven until the user customizes) ───────
  // v0.44: each row is a compact GradientUI editor (noTex — the canvas
  // can't paint textures). The initial spec = the RESOLVED grid spec
  // (effectiveGridSpecs: the user's stored spec/hex, else the theme's
  // palette as a 1-color spec) — the editor starts where the grid
  // actually looks. live() writes the mutated spec into Settings (app.js
  // repaints the canvas via Settings.onChange); rebuild() re-renders the
  // page so the editor's shape (new swatches/dir pills) is fresh.
  function writeGridKey(key, spec) {
    var patch = {};
    patch[key] = spec;
    Settings.setState(patch);
  }

  // ── v0.45 ITEM 5: colorRowCollapsed — a color row that shows just the
  //    [name] [pattern banner preview] [▶ expand] [↺ per-row reset] by
  //    default; clicking the row expands the full GradientUI editor below.
  //    onReset clears ONLY this row's override (no global wipe). The
  //    fmt-slot wiring picks up the data-fmt-slot attr inside the expanded
  //    editor the same way the old flat row did.
  function colorRowCollapsed(opts) {
    var pfx = opts.pfx;
    var label = opts.label;
    var spec = opts.spec || { colors: ['#000000'], dir: 'auto' };
    var editorHtml = opts.editorHtml || '';
    var onReset = opts.onReset;
    var colors = (spec && spec.colors) ? spec.colors : ['#000000'];
    // v0.54: the banner previews the TRUE paint — the exact recipe
    // (mesh / checker / stripes / rays) at a small scale, not the old
    // always-135°-linear strip that made every option look identical.
    // The wire() side keeps it LIVE (paintBanner in uikit.js).
    var bannerCss;
    var G = window.GradientUI;
    if (G && G.css) {
      var cssVal = G.css(spec, { scale: 0.28 });
      bannerCss = cssVal.charAt(0) === '#'
        ? ('background-color:' + cssVal + ';')
        : ('background-image:' + cssVal + ';');
    } else {
      bannerCss = 'background:linear-gradient(135deg,';
      if (colors.length === 1) {
        bannerCss += colors[0] + ',' + colors[0];
      } else {
        bannerCss += colors.join(',');
      }
      bannerCss += ');';
    }
    var fmtAttr = (opts.fmtSlot ? ' data-fmt-slot="' + opts.fmtSlot + '"' : '') +
      (opts.fmtScope ? ' data-fmt-scope="' + opts.fmtScope + '"' : '');
    // v0.98 C3: opts.lazy → the editor builds on first expand (the shell
    // mounts empty; buildLazyEditor fills it from rowEditorBuilders).
    var lazyAttr = (opts.lazy && !editorHtml) ? ' data-lazy-pfx="' + pfx + '"' : '';
    return '<div class="color-row-collapsed" data-color-row="' + pfx + '"' + fmtAttr + '>' +
      '<div class="color-row-head" data-color-toggle="' + pfx + '">' +
        '<span class="color-row-name">' + label + '</span>' +
        '<span class="color-row-banner" style="' + bannerCss + '"></span>' +
        '<button class="color-row-reset" data-color-reset="' + pfx + '" title="reset this row" aria-label="reset this row">↺</button>' +
        '<span class="color-row-arrow">▶</span>' +
      '</div>' +
      '<div class="color-row-body" data-color-body="' + pfx + '"' + lazyAttr + '>' + editorHtml + '</div>' +
    '</div>';
  }

  // wireColorRows — click handlers for the collapsed color rows (expand/
  //    collapse + per-row reset). Called once after the settings page
  //    renders (and by tweaks.js on its own root).
  //    v1.03.4: the GLOBAL fmt rows (scope '') open the THEME EDITOR
  //    instead of expanding inline (user spec: "clicking to edit any
  //    color should bring up a new reusable panel page") — the per-chat
  //    tweaks rows (scope 'chat') keep their inline editors.
  var FMT_ROW_META = {
    a1: ['Accent 1', 'headings · keywords'],
    a2: ['Accent 2', 'subheads · code'],
    a3: ['Accent 3', 'emphasis · links'],
    bright: ['Bright text', 'bold'],
    link: ['Links', 'links in chat bodies']
  };
  function seedFmtSpec(stop) {
    var s = Settings.getState();
    var sch = s.chatScheme || (window.DoomTheme && window.DoomTheme.themes &&
      window.DoomTheme.themes[s.theme] && window.DoomTheme.themes[s.theme].scheme) || 'teal';
    var presets = (window.Formatter && window.Formatter.schemes && window.Formatter.schemes[sch]) || {};
    var stored = (s.fmtOverrides && s.fmtOverrides[stop]) || presets[stop] || { colors: ['#38bdf8'] };
    var GG = window.GradientUI;
    return (GG && GG.norm) ? GG.norm(stored) :
      { colors: [String((stored && typeof stored === 'object' && stored.colors) ? stored.colors[0] : stored)], dir: 'auto' };
  }
  function openFmtEditor(stop, anchorRow) {
    var meta = FMT_ROW_META[stop] || [stop, ''];
    if (!(window.ThemeEditor && window.ThemeEditor.open)) return;
    window.ThemeEditor.open({
      kind: 'fmt',
      suffix: stop,
      label: meta[0],
      hint: meta[1] + ' — the text gradient track',
      spec: seedFmtSpec(stop),
      solid: false, canvas: false,
      row: anchorRow || null,
      write: function (sp) {
        routeFmtWrite(stop, '', sp);
        if (anchorRow) {
          var bEl = anchorRow.querySelector('.color-row-banner');
          if (bEl) {
            var GG = window.GradientUI;
            var v = (GG && GG.css) ? GG.css(sp, { scale: 0.28 }) : sp.colors[0];
            if (v.charAt(0) === '#') { bEl.style.backgroundImage = 'none'; bEl.style.backgroundColor = v; }
            else { bEl.style.backgroundColor = 'transparent'; bEl.style.backgroundImage = v; }
          }
        }
      }
    });
  }
  function wireColorRows(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    var heads = rootEl.querySelectorAll('[data-color-toggle]');
    heads.forEach(function (h) {
      if (h._colorWired) return; h._colorWired = 1;
      h.addEventListener('click', function (e) {
        // don't toggle when the reset pill was tapped
        if (e.target && e.target.closest && e.target.closest('[data-color-reset]')) return;
        var pfx = h.getAttribute('data-color-toggle');
        var row = h.closest('.color-row-collapsed');
        if (!row) return;
        // v1.03.4: the GLOBAL fmt rows open the Theme Editor page
        var fmtSlot = row.getAttribute('data-fmt-slot');
        var fmtScope = row.getAttribute('data-fmt-scope') || '';
        if (fmtSlot && !fmtScope && window.ThemeEditor) {
          openFmtEditor(fmtSlot, row);
          return;
        }
        var wasExpanded = row.classList.contains('expanded');
        row.classList.toggle('expanded');
        if (!wasExpanded) buildLazyEditor(row);   // v0.98 C3: first expand builds
      });
    });
    var resets = rootEl.querySelectorAll('[data-color-reset]');
    resets.forEach(function (r) {
      if (r._resetWired) return; r._resetWired = 1;
      r.addEventListener('click', function (e) {
        e.stopPropagation();
        // find the row's onReset via the registry (set when the row was built)
        var pfx = r.getAttribute('data-color-reset');
        var fn = rowResetFns[pfx];
        if (fn) { try { fn(); } catch (err) { console.error('color row reset', err); } }
      });
    });
  }
  var rowResetFns = {};   // pfx → onReset closure (set by colorRowCollapsed callers)
  // v0.98 C3: THE LAZY EDITOR — the colors tab mounted ~979 nodes because
  // every collapsed color row built its full GradientUI editor eagerly
  // (18 editors, ~50 nodes each, collapsed-but-in-DOM + the wire sweeps).
  // The rows now mount as banner + empty shell; the editor builds on
  // FIRST expand — one row, user-initiated, ~50 nodes at a time.
  var rowEditorBuilders = {};   // pfx → function(bodyEl) builds + wires the editor

  function buildLazyEditor(row) {
    var body = row.querySelector('[data-color-body]');
    if (!body) return;
    var pfx = body.getAttribute('data-lazy-pfx');
    if (!pfx) return;                       // already built (or never lazy)
    body.removeAttribute('data-lazy-pfx');
    var build = rowEditorBuilders[pfx];
    if (!build) return;
    try { build(body); } catch (err) { console.error('lazy editor build', err); }
  }

  function gridColorRow(key, label, spec) {
    var G = window.GradientUI;
    var pfx = 'gc-' + key;             // e.g. gc-bg / gc-lineColor
    var edOpts = { noTex: true };
    var live = function () { writeGridKey(key, spec); };
    var rebuild = function () {
      writeGridKey(key, spec);
      // v0.54: in-place refresh — the row stays open across shape changes
      if (!refreshEditorInPlace(pfx, spec, edOpts, function () {
        var el = document.getElementById(pfx + '-gr');
        if (el && G && G.wire) G.wire(el, { spec: spec, live: live, rebuild: rebuild });
      })) Settings.rerender();
    };
    // v0.98 C3: the editor builds on first expand (lazy) — the mount drops
    // the eager G.editor() HTML build + the queueEditorWire sweep.
    if (G && G.editor && G.wire) {
      rowEditorBuilders[pfx] = function (body) {
        body.innerHTML = G.editor(pfx, spec, edOpts);
        var el = body.querySelector('#' + pfx + '-gr');
        if (el) G.wire(el, { spec: spec, live: live, rebuild: rebuild });
      };
    }
    // v0.45 ITEM 5: collapsed color row — banner + expand arrow + per-row reset
    var onReset = function () {
      var defaults = { bg: '#0a0a0b', lineColor: '#131318',
        dotColor: '#2e2e3a', originColor: '#4a4a5e' };
      writeGridKey(key, defaults[key]);
      Settings.rerender();
    };
    rowResetFns[pfx] = onReset;
    return colorRowCollapsed({
      pfx: pfx, label: label, spec: spec, lazy: true,
      editorHtml: '',
      onReset: onReset
    });
  }

  function gridSection() {
    var s = Settings.getState();
    // v0.44: resolve through the theme's SPEC view (legacy hex picks +
    // specs + "never customized" all fold in; app.js consumes the same
    // resolver when it paints the canvas).
    var g = (window.DoomTheme && window.DoomTheme.effectiveGridSpecs)
      ? window.DoomTheme.effectiveGridSpecs(s)
      : { bg: { colors: [s.bg], dir: 'auto' },
          lineColor: { colors: [s.lineColor], dir: 'auto' },
          dotColor: { colors: [s.dotColor], dir: 'auto' },
          originColor: { colors: [s.originColor], dir: 'auto' } };
    return section('Grid Colors', '' +
      // v0.56: no intro hint (user spec); the per-row labels carry the
      // meaning — lines, dots, origin marker.
      gridColorRow('lineColor', 'Grid Lines', g.lineColor) +
      gridColorRow('dotColor', 'Dots', g.dotColor) +
      gridColorRow('originColor', 'Origin Marker', g.originColor) +
      '<button data-action="grid-colors-reset" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;margin-top:8px;width:100%">follow theme again</button>'
    );
  }

  // ── chat colors (markdown scheme + advanced slots) ─────────────
  function schemeSwatches() {
    return schemeChatSwatches(Settings.getState().chatScheme || 'teal', '');
  }

  // v0.30: the markdown-scheme preset row, PARAMETERIZED (settings page
  // + the per-chat tweaks view — same markup, different store).
  function schemeChatSwatches(current, scope) {
    var schemes = (window.Formatter && window.Formatter.schemes) || {};
    var html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px">';
    Object.keys(schemes).forEach(function (id) {
      var sc = schemes[id];
      var sel = id === current;
      html += '<button data-action="chat-scheme" data-scheme="' + id + '"' + (scope ? ' data-scope="' + scope + '"' : '') + ' ' +
        'style="display:flex;align-items:center;gap:6px;background:' +
        (sel ? 'var(--surface-3)' : 'transparent') + ';border:1px solid ' +
        (sel ? 'var(--border-strong)' : 'var(--border)') + ';border-radius:10px;padding:8px 12px;' +
        'cursor:pointer;font-family:inherit;color:' + (sel ? 'var(--text-1)' : 'var(--text-2)') + ';font-size:calc(var(--ui-small-fs) - 1px);font-weight:600">' +
        '<span style="display:flex">' +
          '<i style="width:12px;height:12px;border-radius:50%;background:' + sc.a1 + ';display:inline-block"></i>' +
          '<i style="width:12px;height:12px;border-radius:50%;background:' + sc.a2 + ';display:inline-block;margin-left:-3px"></i>' +
          '<i style="width:12px;height:12px;border-radius:50%;background:' + sc.a3 + ';display:inline-block;margin-left:-3px"></i>' +
        '</span>' + sc.label + '</button>';
    });
    html += '</div>';
    return html;
  }

  function fmtColorRow(key, label, hint) {
    var s = Settings.getState();
    var ov = s.fmtOverrides || {};
    var preset = (window.Formatter && window.Formatter.schemes[s.chatScheme || 'teal']) || {};
    // v0.44: val may be a legacy hex OR a stored gradient spec — the row
    // builder norm()s either into the editor's live spec.
    var val = ov[key] || preset[key] || '#22d3ee';
    return fmtColorRowUI(key, label, hint, val, false, '');
  }

  // v0.30→v0.44: the fmt color row, PARAMETERIZED — `customized` shows
  // the per-slot override marker (the tweaks view passes it for slots
  // THIS chat owns; the settings page never does — its rows show global
  // values). v0.44: the color input + hex readout are gone — a compact
  // GradientUI editor (pfx 'fmt-'+key, noTex — text slots can't blend a
  // texture) renders instead. `val` may be a hex or a spec. The row's
  // WIRING (scope-aware writes) lives in wireFmtEditors — the settings
  // page drains it from its token root; tweaks.js calls
  // AppearanceUI.wireFmtEditors on its own view root.
  function fmtColorRowUI(key, label, hint, val, customized, scope) {
    var G = window.GradientUI;
    // the live spec: norm'd COPY (wire() mutates it in place; writes go
    // through routeFmtWrite) — legacy hexes fold into a 1-color spec
    var spec = (G && G.norm) ? G.norm(val) :
      { colors: [String((val && typeof val === 'object' && val.colors) ? val.colors[0] : val)], dir: 'auto' };
    fmtSpecs[key + '|' + (scope || '')] = spec;
    // v0.98 C3: the fmt editor builds on first expand (lazy) — wireFmtRow
    // wires it the moment it lands (idempotent via editorEl._fmtWired).
    if (G && G.editor && G.wire) {
      rowEditorBuilders['fmt-' + key] = function (body) {
        body.innerHTML = G.editor('fmt-' + key, spec, { noTex: true });
        var row = body.closest('[data-color-row]');
        if (row) wireFmtRow(row);
      };
    }
    var editorHtml = '';
    var onReset = function () {
      if (scope === 'chat' && window.ChatTweaks) {
        window.ChatTweaks.setFmtSlot(key, null);
      } else {
        var s = Settings.getState();
        var ov = Object.assign({}, s.fmtOverrides || {});
        delete ov[key];
        Settings.setState({ fmtOverrides: ov });
        Settings.rerender();
      }
    };
    rowResetFns['fmt-' + key] = onReset;
    // v0.45 ITEM 5: collapsed color row with per-row reset
    return colorRowCollapsed({
      pfx: 'fmt-' + key, label: label + (hint ? ' <span style="font-size:var(--ui-micro-fs);color:var(--text-3);font-weight:500">' + hint + '</span>' : '') +
        (customized ? ' <span class="crc-mark crc-mark--chat">· this chat</span>' : ''),
      spec: spec, editorHtml: editorHtml, lazy: true,
      fmtSlot: key, fmtScope: scope,
      onReset: onReset
    });
  }

  // (v0.44) — the old global 'input' listeners for the fmt color inputs
  // and the live .color-hex readouts are DELETED: every color surface on
  // this page renders a GradientUI editor whose live/rebuild wiring in
  // wireFmtRow / queueEditorWire routes the writes (the scoped-write
  // semantics — data-scope="chat" → ChatTweaks.setFmtSlot — moved there,
  // verbatim). No input[type=color] with data-setting-key remains on the
  // settings pages, so the readout listener had nothing left to serve.
  // ── sizing sliders ─────────────────────────────────────────────
  function sizeSlider(key, label, hint, def) {
    var s = Settings.getState();
    var v = (typeof s[key] === 'number') ? s[key] : (def || 50);
    return sizeSliderUI(key, label, hint, v, '');
  }

  // v0.30: the size slider row, PARAMETERIZED (settings page + tweaks view).
  function sizeSliderUI(key, label, hint, v, scope) {
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" data-range-display="' + key + '" data-suffix="">' + v + '</span>' +
      '</div>' +
      '<input type="range" class="app-range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="0" max="100" step="1" value="' + v + '" ' +
      (scope ? 'data-scope="' + scope + '" ' : '') +
      'style="accent-color:var(--accent);height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }

  // ── v0.26→v0.44: customize the CURRENT theme (user spec: "The user
  // should be able to not only select a theme, but also customise it to
  // their liking"). Per-theme overrides live in settings.themeOverrides —
  // theme.js applies them as inline CSS VAR-TWINS (which beat the
  // [data-theme] block) and auto-derives the -rgb triplets from the
  // solid. v0.44: each row is a compact GradientUI editor (pfx
  // 'tv-<var-suffix>', noTex — texture is a chat-bg/hub feature, static
  // theme-var consumers can't blend it); the initial spec is the stored
  // override (hex or spec) or the live computed hex as a 1-color spec —
  // the editor always starts where the app looks right now. live()
  // writes the spec back into themeOverrides (theme.js re-applies the
  // twins immediately, exactly like the old input handler did); rebuild()
  // re-renders the page so the editor's shape is fresh.
  // ══ v0.99.6 THE SLOT PICKER — one floating popover per field ════
  // The Colors tab is 2 nesting levels deep (section → slot row); the
  // GradientUI internals live INSIDE the popover (Floating UI anchored,
  // flip/shift-guarded), not nested in the row. One singleton popover
  // element; the content builds per open (the v0.98 lazy pattern, one
  // editor at a time, now floating).
  // ── v1.01.2: THE IMAGE→PALETTE SUGGESTER (MCU, generation-time only)
  // ─────────────────────────────────────────────────────────────────
  // The user picks an image → MCU quantizes+scores the source color →
  // SchemeContent (dark-first, matching the active theme's light flag)
  // → a 7-slot PROPOSAL previewed in the popover. Apply writes the
  // seven fields as 1-color specs through the normal writeThemeVar
  // path (the user accepts or rejects; culori OKLCH stays the one
  // runtime truth — MCU never runs again after the apply).
  function mcuSuggestSection(body) {
    if (!window.MCU) return;   // the module never loaded — no section
    var sec = document.createElement('div');
    sec.className = 'slot-pop-grid-sec';
    sec.innerHTML =
      '<div class="slot-pop-grid-title">suggest from an image</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<button type="button" class="slot-pop-btn" data-act="mcu-pick" style="flex:0 0 auto;min-width:120px">🖼 pick an image</button>' +
        '<span style="font-size:var(--ui-micro-fs);color:var(--text-3);flex:1;min-width:120px">a 7-slot proposal from its palette — accept or ignore</span>' +
      '</div>' +
      '<input type="file" accept="image/png,image/jpeg,image/webp" data-mcu-file="1" style="display:none" aria-hidden="true">' +
      '<div class="mcu-preview" style="display:none;margin-top:10px">' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button type="button" class="slot-pop-btn" data-act="mcu-apply" style="color:var(--text-1);font-weight:600">use these colors</button>' +
          '<button type="button" class="slot-pop-btn" data-act="mcu-dismiss">dismiss</button>' +
        '</div>' +
      '</div>';
    body.appendChild(sec);
    var file = sec.querySelector('input[type=file]');
    var preview = sec.querySelector('.mcu-preview');
    var strip = preview.querySelector('div');
    var proposal = null;

    sec.querySelector('[data-act=mcu-pick]').addEventListener('click', function () {
      file.value = '';
      file.click();
    });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var img = new Image();
        img.onload = function () {
          window.MCU.sourceColorFromImage(img).then(function (src) {
            try {
              var cur = Settings.getState().theme || 'midnight';
              var isLight = !!(window.DoomTheme.themes[cur] || {}).light;
              var scheme = new window.MCU.SchemeContent(
                window.MCU.Hct.fromInt(src), isLight ? 0 : 1, 0);
              proposal = {
                surface: window.MCU.hexFromArgb(scheme.surfaceContainer),
                ink: window.MCU.hexFromArgb(scheme.onSurface),
                canvas: window.MCU.hexFromArgb(scheme.surfaceDim),
                'accent-1': window.MCU.hexFromArgb(scheme.primary),
                'accent-2': window.MCU.hexFromArgb(scheme.secondary),
                'accent-3': window.MCU.hexFromArgb(scheme.tertiary)
              };
              var labels = { surface: 'surface', ink: 'ink', canvas: 'canvas',
                'accent-1': 'accent 1', 'accent-2': 'accent 2', 'accent-3': 'accent 3' };
              var sw = '';
              for (var k in proposal) {
                sw += '<span style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:52px">' +
                  '<span style="width:52px;height:36px;border-radius:8px;border:1px solid var(--border);background:' + proposal[k] + '"></span>' +
                  '<span style="font-size:var(--ui-micro-fs);color:var(--text-3)">' + labels[k] + '</span></span>';
              }
              strip.innerHTML = sw;
              preview.style.display = 'block';
            } catch (e) {
              if (window.DoomToast) window.DoomToast('could not read that image');
            }
          }).catch(function () {
            if (window.DoomToast) window.DoomToast('could not read that image');
          });
        };
        img.onerror = function () {
          if (window.DoomToast) window.DoomToast('could not read that image');
        };
        img.src = String(rd.result);
      };
      rd.readAsDataURL(f);
    });
    sec.querySelector('[data-act=mcu-dismiss]').addEventListener('click', function () {
      preview.style.display = 'none';
      proposal = null;
    });
    sec.querySelector('[data-act=mcu-apply]').addEventListener('click', function () {
      if (!proposal) return;
      var map = {
        surface: '--field-surface', ink: '--field-ink', canvas: '--field-canvas',
        'accent-1': '--field-accent-1', 'accent-2': '--field-accent-2',
        'accent-3': '--field-accent-3'
      };
      for (var k in map) {
        if (proposal[k]) writeThemeVar(map[k], { colors: [proposal[k]], dir: 'auto' });
      }
      preview.style.display = 'none';
      proposal = null;
      Settings.rerender();   // the slot rows re-seed from the new fields
      if (window.DoomToast) window.DoomToast('palette applied');
    });
  }

  // v1.03.4: THE FLOATING PICKER IS RETIRED — the slot rows and the fmt
  // stops open the THEME EDITOR page (themeeditor.js). The popover
  // singleton (slotPopover/closeSlotPopover/openSlotPopover) and
  // popoverEditor are deleted; wireSlotRows keeps only the row-to-
  // builder delegation + the reset pills.
  // one delegated listener wires every slot row forever (the panel body
  // re-renders per tab switch; delegation survives it)
  var slotRowsWired = false;
  function wireSlotRows() {
    if (slotRowsWired) return;
    slotRowsWired = true;
    document.addEventListener('click', function (e) {
      // v1.04.1 F5 (user report: "the reset arrow doesn't work"): the
      // RESET branch runs FIRST — the reset button lives INSIDE
      // .slot-row-head (which carries data-slot-open), so the open
      // branch's closest() matched the PARENT and swallowed the reset
      // click before it ever reached the reset handler. The v0.45
      // colorRowCollapsed wiring had this exact guard ("don't toggle
      // when the reset pill was tapped"); the slot rows never got it.
      var resetBtn = e.target.closest ? e.target.closest('[data-slot-reset]') : null;
      if (resetBtn) {
        var fn = slotResetFns[resetBtn.getAttribute('data-slot-reset')];
        if (fn) { e.preventDefault(); e.stopPropagation(); fn(); }
        return;
      }
      var openBtn = e.target.closest ? e.target.closest('[data-slot-open]') : null;
      if (openBtn) {
        var rowEl = openBtn.closest('.slot-row');
        var field = openBtn.getAttribute('data-slot-open');
        var builder = slotBuilders[field];
        if (rowEl && builder) {
          e.preventDefault();
          e.stopPropagation();
          builder(rowEl);
        }
        return;
      }
    }, true);
  }
  var slotBuilders = {};   // field → (anchorRow) => opens the Theme Editor
  var slotResetFns = {};   // field → () => clears the override + rerenders

  // slotRow(opts) — the 2nd-level row: banner + name + reset + chevron;
  // tapping opens the floating picker (no inline expansion, no nesting).
  function slotRow(opts) {
    var G = window.GradientUI;
    var spec = opts.spec || { colors: ['#000000'], dir: 'auto' };
    var bannerCss;
    if (G && G.css) {
      var cssVal = G.css(spec, { scale: 0.28 });
      bannerCss = cssVal.charAt(0) === '#'
        ? ('background-color:' + cssVal + ';')
        : ('background-image:' + cssVal + ';');
    } else {
      bannerCss = 'background:' + spec.colors[0] + ';';
    }
    return '<div class="slot-row">' +
      '<div class="slot-row-head" data-slot-open="' + opts.field + '" role="button" tabindex="0" aria-label="edit ' + opts.label + '">' +
        '<span class="slot-row-name">' + opts.label +
          (opts.customized ? ' <span class="crc-mark">· customized</span>' : '') +
          (opts.hint ? '<span class="hint">' + opts.hint + '</span>' : '') +
        '</span>' +
        '<span class="slot-row-banner" style="' + bannerCss + '"></span>' +
        '<button type="button" class="slot-row-reset" data-slot-reset="' + opts.field + '" title="reset this field" aria-label="reset ' + opts.label + '">↺</button>' +
        '<span class="slot-row-arrow">▶</span>' +
      '</div>' +
    '</div>';
  }

  // v0.99.4: field → the LEGACY override keys that fold into it (the
  // row's reset clears them all so a saved pre-v0.99 override dies with
  // the row, not on the next boot's fold).
  var LEGACY_FIELD_KEYS = {
    '--field-surface': ['--surface-1'],
    '--field-ink': ['--text-1'],
    '--field-canvas': ['--bg-panel'],
    '--field-accent-1': ['--accent'],
    '--field-accent-2': ['--accent-2'],
    '--field-accent-3': ['--accent-3']
  };
  function LEGACY_FIELD_KEYS_FOR(field) { return LEGACY_FIELD_KEYS[field] || []; }

  function writeThemeVar(varName, spec) {
    var s = Settings.getState();
    var cur = s.theme || 'midnight';
    var all = Object.assign({}, s.themeOverrides || {});
    all[cur] = Object.assign({}, all[cur] || {});
    all[cur][varName] = spec;
    Settings.setState({ themeOverrides: all }); // persists + applies live
  }

  // v1.03.3: seedFieldSpec(c) — the CURRENT spec for a field, read
  // FRESH from the live state (stored override → the canvas resolution
  // → the live computed hex). Rendered at row-build time AND re-read at
  // Theme-Editor-open time — a stored spec that changed since render
  // (imports, resets, the MCU suggester) can never open stale.
  function seedFieldSpec(c) {
    var GG = window.GradientUI;
    var st = Settings.getState();
    var cur = st.theme || 'midnight';
    var ovL = (st.themeOverrides && st.themeOverrides[cur]) || {};
    var folded = (window.DoomTheme && window.DoomTheme.foldThemeOverrides)
      ? window.DoomTheme.foldThemeOverrides(ovL) : ovL;
    var stored = folded[c.field];
    if (stored) {
      // the stored override: a gradient spec or a legacy hex — norm
      // folds either (a COPY: the editor mutates its own live spec)
      var sp = (GG && GG.norm) ? GG.norm(stored) :
        { colors: [String((stored && typeof stored === 'object' && stored.colors) ? stored.colors[0] : stored)], dir: 'auto' };
      // v0.99.4: the ink field is SOLID-ONLY — a folded legacy text-1
      // spec degrades to its first color (banner + editor agree)
      if (c.solid && sp.colors.length > 1) sp = { colors: [sp.colors[0]], dir: 'auto' };
      // v0.49: the CANVAS field keeps its stored texture dataURL alive
      // (norm carries it) — the canvas paints it; CSS twins strip it.
      return sp;
    }
    if (c.canvas && window.DoomTheme && window.DoomTheme.canvasBgSpec) {
      // the canvas row seeds from the RESOLVED canvas spec (the theme's
      // grid bg when never customized — what the canvas paints now).
      var cbRaw = window.DoomTheme.canvasBgSpec(st);
      return (GG && GG.norm) ? GG.norm(cbRaw) :
        { colors: [String((cbRaw && cbRaw.colors) || [])[0] || '#0a0a0b'], dir: 'auto' };
    }
    // not customized: the field's CURRENT computed hex, as a 1-color
    // spec (what the editor offers is what the app looks like now)
    var live = cssVarLive(c.field);
    var liveHex = /^#[0-9a-fA-F]{6}$/.test(live || '') ? live : '#000000';
    return { colors: [liveHex], dir: 'auto' };
  }

  function themeCustomizeSection() {
    var s = Settings.getState();
    var cur = s.theme || 'midnight';
    var themes = (window.DoomTheme && window.DoomTheme.themes) || {};
    var t = themes[cur] || {};
    var ov = (s.themeOverrides && s.themeOverrides[cur]) || {};
    // v0.99.4: the FOLD view — a saved legacy key ('--surface-1', '--text-1',
    // '--bg-panel', '--accent'…) still seeds its field row here.
    var ovFolded = (window.DoomTheme && window.DoomTheme.foldThemeOverrides)
      ? window.DoomTheme.foldThemeOverrides(ov) : ov;
    var customCount = Object.keys(ovFolded).length;
    var rows = '';
    var fields = (window.DoomTheme && window.DoomTheme.fields) || [];
    var G = window.GradientUI;
    fields.forEach(function (c) {
      // '--field-accent-1' → 'tv-accent-1'; the ink row keeps its own pfx
      var pfx = 'tv-' + (c.suffix || String(c.field || '').replace(/^--field-/, ''));
      // v1.03.3: the seeding lives in seedFieldSpec (render-time here;
      // click-time fresh inside the slotBuilder)
      var spec = seedFieldSpec(c);
      // ONLY the canvas field offers the texture picker (bumpmaps —
      // app.js's canvas renderer paints them with a real 'color'
      // composite pass); every other field hides it.
      var edOpts = { noTex: !c.canvas };
      var tvLive = function () { writeThemeVar(c.field, spec); };
      var tvRebuild = function () {
        writeThemeVar(c.field, spec);
        // v0.54: in-place refresh — the row stays open (no full rerender
        // slamming the editor shut on every dir pill tap)
        if (!refreshEditorInPlace(pfx, spec, edOpts, function () {
          var el = document.getElementById(pfx + '-gr');
          if (el && G && G.wire) G.wire(el, { spec: spec, live: tvLive, rebuild: tvRebuild });
        })) Settings.rerender();
      };
      // v0.98 C3: the editor builds on first expand (lazy).
      // v0.99.4: the INK field is solid-only — a plain color input (ink
      // is never a window; the fmt field owns text gradients).
      if (c.solid) {
        var inkHex = spec.colors[0] || '#e0e0e8';
        rowEditorBuilders[pfx] = function (body) {
          body.innerHTML =
            '<div style="padding:12px;display:flex;align-items:center;gap:10px">' +
            '<input type="color" id="' + pfx + '-solid" value="' + (/^#[0-9a-fA-F]{6}$/.test(inkHex) ? inkHex : '#e0e0e8') + '" ' +
            'style="width:56px;height:44px;min-height:44px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);padding:4px;cursor:pointer" ' +
            'aria-label="Ink color">' +
            '<span style="font-size:var(--ui-small-fs);color:var(--text-3)">every text color derives from this one ink — solid only</span>' +
            '</div>';
          var inp = body.querySelector('#' + pfx + '-solid');
          if (inp) inp.addEventListener('input', function () {
            writeThemeVar(c.field, inp.value);
          });
        };
      } else if (G && G.editor && G.wire) {
        rowEditorBuilders[pfx] = function (body) {
          body.innerHTML = G.editor(pfx, spec, edOpts);
          var el = body.querySelector('#' + pfx + '-gr');
          if (el) G.wire(el, { spec: spec, live: tvLive, rebuild: tvRebuild });
        };
      }
      var editorHtml = '';
      var onReset = function () {
        var sR = Settings.getState();
        var curR = sR.theme || 'midnight';
        var allR = Object.assign({}, sR.themeOverrides || {});
        if (allR[curR]) {
          // v0.99.4: clear the FIELD key AND any legacy key that folds
          // into it (a saved '--surface-1' override resets with the row)
          delete allR[curR][c.field];
          (LEGACY_FIELD_KEYS_FOR(c.field) || []).forEach(function (lk) {
            delete allR[curR][lk];
          });
          if (!Object.keys(allR[curR]).length) delete allR[curR];
        }
        Settings.setState({ themeOverrides: allR });
        Settings.rerender();
      };
      rowResetFns[pfx] = onReset;
      // v0.99.6: the SLOT ROW (2nd nesting level; the editor lives in the
      // floating popover, not nested here)
      rows += slotRow({
        field: c.suffix, label: c.label, hint: c.hint, spec: spec,
        customized: !!ovFolded[c.field]
      });
      var thisPfx = pfx, thisSpec = spec, thisOpts = edOpts;
      // v0.99.6: the DOM-field pickers are SLIM (linear/radial + angle +
      // stops); ONLY the canvas picker keeps patterns + texture (the
      // lattice bakes them natively).
      if (!c.canvas && !edOpts.noDir) thisOpts = Object.assign({}, edOpts, { slim: true });
      // v1.03.3: THE THEME EDITOR — the slot rows open the reusable
      // panel page (the user's point 4: "clicking to edit any color
      // should bring up a new reusable panel page"). The popover path
      // (v0.99.6) retires; everything the page needs is INJECTED here:
      // the seeded spec, the write seam (writeThemeVar + the anchor
      // row's live banner — the element reference survives the view
      // stack's root stash), and the canvas extras (grid children +
      // the MCU suggester) as full-width sections.
      slotBuilders[c.suffix] = function (anchorRow) {
        if (!(window.ThemeEditor && window.ThemeEditor.open)) return;
        window.ThemeEditor.open({
          kind: 'field',
          suffix: c.suffix,
          label: c.label,
          hint: c.hint,
          spec: seedFieldSpec(c),   // v1.03.3: FRESH at click time
          solid: !!c.solid,
          canvas: !!c.canvas,
          row: anchorRow || null,
          write: function (s) {
            writeThemeVar(c.field, s);
            // the anchor row's banner + marker follow LIVE (the element
            // reference works even while the root DOM is view-stashed)
            if (anchorRow) {
              var bEl = anchorRow.querySelector('.slot-row-banner');
              if (bEl) {
                var v = (G && G.css) ? G.css(s, { scale: 0.28 }) : s.colors[0];
                if (v.charAt(0) === '#') { bEl.style.backgroundImage = 'none'; bEl.style.backgroundColor = v; }
                else { bEl.style.backgroundColor = 'transparent'; bEl.style.backgroundImage = v; }
              }
              var nm = anchorRow.querySelector('.slot-row-name');
              if (nm && !nm.querySelector('.crc-mark')) {
                nm.insertAdjacentHTML('beforeend', ' <span class="crc-mark">· customized</span>');
              }
            }
          },
          extras: c.canvas ? function (box) {
            // the CANVAS editor's full-width sections — the grid
            // children (the world's lines/dots/origin) + the image→
            // palette suggester (v1.01.2), carried over from the
            // popover's picker body.
            var gs = document.createElement('div');
            gs.className = 'slot-pop-grid-sec';
            var specS = window.DoomTheme.effectiveGridSpecs(Settings.getState());
            gs.innerHTML = '<div class="slot-pop-grid-title">grid children</div>' +
              gridColorRow('lineColor', 'Grid Lines', specS.lineColor) +
              gridColorRow('dotColor', 'Dots', specS.dotColor) +
              gridColorRow('originColor', 'Origin Marker', specS.originColor);
            box.appendChild(gs);
            wireColorRows(gs);
            var fr = document.createElement('div');
            fr.className = 'slot-pop-actions';
            fr.innerHTML = '<button type="button" class="slot-pop-btn" data-act="grid-reset">follow theme again</button>';
            box.appendChild(fr);
            fr.querySelector('[data-act=grid-reset]').addEventListener('click', function () {
              Settings.setState({
                bg: '#0a0a0b', lineColor: '#131318',
                dotColor: '#2e2e3a', originColor: '#4a4a5e'
              });
            });
            mcuSuggestSection(box);
          } : null
        });
      };
      slotResetFns[c.suffix] = onReset;
    });
    return section('The Fields · ' + (t.label || 'Theme'),
      // v1.03.6: THE DOOM PROJECTION SWITCH (user spec: "make the doom
      // projection a toggleable switch in the colors tab") — one shared
      // gradient field for every surface + accent element.
      '<div class="setting-row" style="align-items:center;justify-content:space-between">' +
        '<label style="min-width:0">Doom projection' +
          '<span class="hint" style="display:block">one shared gradient field — same-color elements render it together</span></label>' +
        '<label class="app-switch" style="position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0">' +
          '<input type="checkbox" data-setting-key="doomProjection" data-setting-event="change" ' + (s.doomProjection ? 'checked' : '') +
          ' style="opacity:0;width:0;height:0;position:absolute">' +
          '<span class="app-switch-track" style="position:absolute;inset:0;background:' + (s.doomProjection ? 'var(--accent)' : 'var(--surface-3)') +
          ';border-radius:12px;transition:background 0.15s"></span>' +
          '<span class="app-switch-thumb" style="position:absolute;top:2px;left:' + (s.doomProjection ? '20px' : '2px') +
          ';width:20px;height:20px;background:var(--on-accent);border-radius:50%;transition:left 0.15s"></span>' +
        '</label>' +
      '</div>' +
      // v1.03.2: 6 field rows — the TEXT STYLE row PROMOTED to its own
      // collapsible section header directly beneath this one (user spec
      // point 3: "move text style… to a collapsible header that expands
      // the text colors, place the new header as a row under the fields").
      rows +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button data-action="theme-custom-reset" style="flex:1;background:transparent;border:1px solid var(--border);color:var(--text-3);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer">reset this theme</button>' +
      '</div>'
    ) + textStyleSection();
  }

  // ── v1.03.2: THE TEXT STYLE SECTION — promoted from the nested 7th
  // slot row to its own collapsible header under "The Fields" (user
  // point 3). Expanding reveals the text colors directly: the a1
  // preview strip + the scheme presets + the 5 fmt stops (in-place
  // lazy editors — the same machinery the tweaks view uses) + the
  // reset. Also fixes the v0.99.6 popover regression this replaces:
  // its fmt rows were built as fmtColorRow(k, spec, 'global') — the
  // SPEC landed in the LABEL slot ("#22d3ee global" row titles). ────
  function textStyleSection() {
    var s = Settings.getState();
    var pinned = !!((s.chatScheme && s.chatScheme !== 'teal') ||
      (s.fmtOverrides && Object.keys(s.fmtOverrides).length > 0));
    var G = window.GradientUI;
    // resolve the 5 stop specs (override ?? scheme preset) — the same
    // resolution formatter.applyScheme performs
    var sch = s.chatScheme || (window.DoomTheme && window.DoomTheme.themes &&
      window.DoomTheme.themes[s.theme] && window.DoomTheme.themes[s.theme].scheme) || 'teal';
    var presets = (window.Formatter && window.Formatter.schemes && window.Formatter.schemes[sch]) || {};
    var fmtSpecsNow = {};
    FMT_SLOTS_ALL.forEach(function (k) {
      fmtSpecsNow[k] = (s.fmtOverrides && s.fmtOverrides[k]) || presets[k] || { colors: ['#38bdf8'] };
    });
    // the a1 preview strip (the title-gradient stop — the row banner's
    // successor, now at the head of the expanded body)
    var a1 = fmtSpecsNow.a1;
    var bannerCss;
    if (G && G.css) {
      var v = G.css(a1, { scale: 0.28 });
      bannerCss = v.charAt(0) === '#' ? ('background-color:' + v + ';') : ('background-image:' + v + ';');
    } else {
      bannerCss = 'background:' + a1.colors[0] + ';';
    }
    // the 5 stops — the PROPER parameterization (fmtColorRowUI: key,
    // label, hint, val, customized, scope — the same names the tweaks
    // view carries; the settings page is the GLOBAL scope '')
    var FMT_LABELS = {
      a1: ['Accent 1', 'headings · keywords'],
      a2: ['Accent 2', 'subheads · code'],
      a3: ['Accent 3', 'emphasis · links'],
      bright: ['Bright text', 'bold'],
      link: ['Links', '']
    };
    var rows = '';
    FMT_SLOTS_ALL.forEach(function (k) {
      rows += fmtColorRowUI(k, FMT_LABELS[k][0], FMT_LABELS[k][1],
        fmtSpecsNow[k], false, '');
    });
    return section('Text style' + (pinned ? ' <span class="crc-mark">· customized</span>' : ''),
      '<div style="height:10px;border-radius:5px;margin:10px 0 2px;' + bannerCss + '" aria-hidden="true"></div>' +
      schemeSwatches() +
      rows +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button data-action="chat-colors-reset" style="flex:1;background:transparent;border:1px solid var(--border);color:var(--text-3);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer">reset chat colors</button>' +
      '</div>'
    );
  }

  function cssVarLive(name) {
    // the EFFECTIVE var (theme block + any live overrides).
    // v0.99.4: the FIELD vars are @property-registered (<color>) so the
    // engine serializes them as 'rgb(r, g, b)' — the editors need the
    // canonical hex, so the computed string normalizes here.
    var v = '';
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) { return ''; }
    if (!v) return v;
    var m = /^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/.exec(v);
    if (!m) return v;
    function h2(x) { var s = Number(x).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h2(m[1]) + h2(m[2]) + h2(m[3]);
  }

  // (v0.44) — the old data-theme-var 'input' listener is DELETED: the
  // customize rows are GradientUI editors wired through queueEditorWire
  // (writeThemeVar keeps the exact persist+apply-live semantics the old
  // handler had).

  // ── register the three pages ───────────────────────────────────
  Settings.registerPage('appearance', {
    title: 'Colors',
    icon: '🎨',
    render: function (getState, setState) {
      const s = getState();
      // v0.99.6: TWO sections — the grid children live in the Canvas
      // picker, the fmt family in the Text style picker. 2 nesting levels.
      wireSlotRows();
      return pageRender(
        section('Theme', '' +
          themeSwatches()
        ) +
        themeCustomizeSection()
      );
    }
  });

  Settings.registerPage('sizing', {
    title: 'Sizing',
    icon: '📐',
    render: function (getState, setState) {
      var s = getState();
      // v0.56 (user spec): NO descriptions anywhere in Sizing — the
      // sliders + their live value displays are self-descriptive.
      return (
        section('Text Size', '' +
          sizeSlider('chatTextSize', 'Chat text', '') +
          sizeSlider('uiTextSize', 'General text', '') +
          sizeSlider('smallTextSize', 'Small text', '')
        ) +
        section('Grid Size', '' +
          rangeRow('gridSize', 'Grid Spacing', getState().gridSize || 1, 1, 5, 0.5, '')
        ) +
        // v0.45 ITEM 6: grid quick options — hide / scatter / size / rotate
        // v0.75 THE TWO COLUMNS: every effect is per-side now (dots/lines).
        // Amplify parallax rides full-width above the columns (it deepens
        // the whole canvas — the new v0.75 method: deep star layers + a
        // deeper backdrop, NEVER the v0.67 line/dot lag that read worse).
        section('Grid Effects', '' +
          gridSlider('spaceParallax', 'Amplify parallax',
            (typeof s.spaceParallax === 'number') ? s.spaceParallax : 0,
            'size-depth — YOUR biggest dots + lines sweep closest (past the icons), the smallest sit furthest · 0 = default') +
          gridEffectsColumns(s) +
          '<button data-action="grid-effects-reset" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;border-radius:8px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer;margin-top:6px">reset effects</button>'
        )
      );
    }
  });

  Settings.registerPage('general', {
    title: 'General',
    icon: '⚙️',
    render: function (getState, setState) {
      const s = getState();
      // v0.56 (user spec): NO descriptions in General either — and the
      // old "My Look" section is now IMPORT / EXPORT THEME (the buttons
      // say what they do).
      // v0.74: hydrate the Connected Accounts rows right after the DOM
      // lands (registerPage has no mount hook — the render IS the hook).
      setTimeout(hydrateAccounts, 0);
      return (
        section('Text', '' +
          selectRow('fontFamily', 'Font', s.fontFamily, [
            { value: 'system', label: 'System Default' },
            { value: 'serif', label: 'Serif' },
            { value: 'monospace', label: 'Monospace' }
          ])
        ) +
        section('Default Chat Names', '' +
          '<textarea data-setting-key="names" data-setting-transform="lines" rows="8" ' +
          'style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);' +
          'padding:8px 10px;border-radius:6px;font-size:calc(var(--ui-fs) - 1px);font-family:inherit;' +
          'resize:vertical;min-height:120px;line-height:1.5">' +
          s.names.join('\n') + '</textarea>'
        ) +
        section('View', '' +
          '<button data-action="reset-view" style="background:var(--surface-2);border:1px solid var(--border);' +
          'color:var(--text-1);padding:10px 16px;border-radius:8px;font-size:var(--ui-fs);font-family:inherit;' +
          'cursor:pointer;width:100%">Reset View (zoom 1×, pan to origin)</button>'
        ) +
        // v0.74 (user spec): CONNECTED ACCOUNTS — the log-out / disconnect
        // surface. Every connected service gets a row: status + the action.
        // Async hydration (the placeholder pattern — the page renders
        // instantly, the rows fill in).
        section('Connected Accounts', '' +
          '<div id="acct-rows" style="display:flex;flex-direction:column;gap:8px">' +
            '<div style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3)">checking your connections…</div>' +
          '</div>' +
          '<p style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim);margin:8px 0 0;line-height:1.45">' +
            'Logging out removes the saved token from this device only — the account itself is untouched.</p>' +
          '<p style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim);margin:6px 0 0;line-height:1.45">' +
            'Provider keys ride only the turn that uses them (your key, your bill) — but a shared Space still processes the chat itself, so keep secrets out of it.</p>'
        ) +
        // v0.52 (user spec item 8): the LOOK BUNDLE — export the entire
        // settings state (photos + bump maps included — they are dataURLs
        // inside the gradient specs) as ONE .doomtheme file; a friend
        // imports it and their app looks 1:1 the same.
        // v0.56: renamed per user spec ("change the name of the my look pill
        // to import/export theme").
        section('Import / Export Theme', '' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button data-action="export-look" style="flex:1 1 140px;background:var(--surface-2);border:1px solid var(--border);' +
          'color:var(--text-1);padding:10px 14px;border-radius:8px;font-size:var(--ui-fs);font-family:inherit;cursor:pointer">⤓ Export theme</button>' +
          '<button data-action="import-look" style="flex:1 1 140px;background:var(--surface-2);border:1px solid var(--border);' +
          'color:var(--text-1);padding:10px 14px;border-radius:8px;font-size:var(--ui-fs);font-family:inherit;cursor:pointer">⤒ Import a theme</button>' +
          '</div>'
        ) +
        // v1.01.6: THE ICON REGISTRY — the swappable sets (Iconify JSON
        // as data; the builtin Lucide stays the base layer).
        section('Icon Set', '' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
          (function () {
            var R = window.IconReg; if (!R) return '';
            var html = '';
            R.sets().forEach(function (st) {
              var on = (R.active() || '') === st.id;
              html += '<button data-action="icon-set-use" data-set="' + st.id + '" style="flex:1 1 110px;min-height:40px;padding:8px 10px;border-radius:10px;' +
                'font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;font-family:inherit;cursor:pointer;' +
                (on ? 'background:var(--accent);color:var(--on-accent);border:1px solid transparent;' :
                     'background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);') +
                '">' + st.name + ' · ' + st.count + '</button>';
            });
            return html;
          })() +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button data-action="icon-set-import" style="flex:1 1 140px;background:var(--surface-2);border:1px solid var(--border);' +
          'color:var(--text-1);padding:10px 14px;border-radius:8px;font-size:var(--ui-fs);font-family:inherit;cursor:pointer">⤒ Import icon set (.json)</button>' +
          (window.IconReg && window.IconReg.active() ?
            '<button data-action="icon-set-remove" data-set="' + window.IconReg.active() + '" style="flex:0 1 140px;background:transparent;border:1px solid rgba(var(--err-rgb),0.5);' +
            'color:var(--err);padding:10px 14px;border-radius:8px;font-size:var(--ui-fs);font-family:inherit;cursor:pointer">Remove</button>' : '') +
          '</div>' +
          '<p style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim);margin:8px 0 0;line-height:1.45">' +
            'Iconify-JSON sets (the offline format — no runtime fetch): every icon in the app follows the active set. Sanitized on import, capped at 512 icons.</p>'
        )
      );
    }
  });

  // ── v0.74: CONNECTED ACCOUNTS hydration + actions ───────────────
  function acctJSON(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function acctRow(name, sub, connected, action, btnLabel, btnKind) {
    return '<div style="display:flex;align-items:center;gap:10px;min-height:44px;padding:9px 12px;' +
      'border-radius:10px;background:var(--surface-2);border:1px solid var(--border)">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:calc(var(--ui-small-fs));font-weight:600;color:var(--text-1)">' + name + '</div>' +
        '<div style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3);margin-top:1px">' + sub + '</div>' +
      '</div>' +
      // NOTE: data-acct (NOT data-action) — these rows land AFTER the
      // settings page's wireInputs pass, so the generic dispatcher never
      // sees them; hydrateAccounts attaches direct listeners instead.
      '<button data-acct="' + action + '" style="flex-shrink:0;min-height:36px;padding:8px 14px;border-radius:9px;' +
        'font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;font-family:inherit;cursor:pointer;' +
        (connected
          ? 'background:transparent;border:1px solid rgba(var(--accent-2-rgb),0.55);color:var(--accent-2)'
          : 'background:var(--accent);color:var(--on-accent);border:none;background-image:var(--accent-gradient,none);') +
        '">' + btnLabel + '</button>' +
      '</div>';
  }

  // v0.98 C5: the accounts fetch is session-cached (60s TTL) — the General
  // tab re-mounts on every open and re-fired all three fetches; the async
  // innerHTML then landed mid-panel-life as observer-triggered repaints.
  // acctAction() clears the cache so the rows go honest after any action.
  var acctCache = { t: 0, res: null };

  function paintAcctRows(res) {
    var cur = document.getElementById('acct-rows');
    if (!cur) return;
    var hf = res[0] || {};
    var accts = res[1].accounts || [];
    var keys = res[2] || {};
    var gh = null, gt = null;
    (accts || []).forEach(function (a) {
      if (a.kind === 'github') gh = a;
      if (a.kind === 'gitea') gt = a;
    });
    var keyCount = 0;
    Object.keys(keys).forEach(function (k) { if (keys[k] && keys[k].has_key) keyCount++; });
    var html = '';
    // Hugging Face
    html += acctRow('🤗 Hugging Face',
      hf.connected ? ('connected as ' + (hf.user || 'you')) : 'not connected — sandbox chats + the Hub need it',
      !!hf.connected,
      hf.connected ? 'acct-hf-out' : 'acct-hf-in',
      hf.connected ? 'log out' : 'connect', 0);
    // GitHub
    var ghIn = !!(gh && gh.signed_in);
    html += acctRow('🐙 GitHub',
      ghIn ? ('signed in as ' + (gh.login || 'you')) : 'not connected — hub publishing + workspace forges',
      ghIn,
      ghIn ? 'acct-gh-out' : 'acct-gh-in',
      ghIn ? 'log out' : 'connect', 0);
    // Gitea — only surfaces when it's actually signed in (self-hosted
    // forges aren't a default row).
    if (gt && gt.signed_in) {
      html += acctRow('🔧 Gitea',
        'signed in as ' + (gt.login || 'you'), true, 'acct-gt-out', 'log out', 0);
    }
    // Cloud providers (BYOK vault)
    html += acctRow('☁️ Cloud providers',
      keyCount ? (keyCount + ' API key' + (keyCount === 1 ? '' : 's') + ' set — your chats bill YOUR keys')
                 : 'no API keys yet — bring your own for every chat',
      keyCount > 0, 'acct-keys', 'manage', 0);
    cur.innerHTML = html;
    // The rows land AFTER wireInputs ran — attach the listeners directly.
    cur.querySelectorAll('[data-acct]').forEach(function (btn) {
      btn.addEventListener('click', function () { acctAction(btn.dataset.acct); });
    });
  }

  function hydrateAccounts() {
    var host = document.getElementById('acct-rows');
    if (!host) return;
    if (acctCache.res && (Date.now() - acctCache.t) < 60000) {
      paintAcctRows(acctCache.res);   // v0.98 C5: cached — no fetch, no async repaint
      return;
    }
    Promise.all([
      acctJSON('/api/hf/account').catch(function () { return { connected: false, user: '' }; }),
      acctJSON('/api/workspaces/accounts').catch(function () { return { accounts: [] }; }),
      acctJSON('/api/keys').catch(function () { return {}; })
    ]).then(function (res) {
      var cur = document.getElementById('acct-rows');
      if (!cur || cur !== host) return; // the page moved on — stop
      acctCache = { t: Date.now(), res: res };
      paintAcctRows(res);
    }).catch(function () {
      var cur2 = document.getElementById('acct-rows');
      if (cur2 === host) {
        host.innerHTML = '<div style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3)">couldn\'t load your connections — reopen this page to retry.</div>';
      }
    });
  }

  // acctAction — the one implementation behind both the direct row
  // listeners and the doomalay:action dispatch.
  function acctAction(action) {
    acctCache = { t: 0, res: null };
    if (action === 'acct-hf-out') {
      acctJSON('/api/hub/auth/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { hydrateAccounts(); })
        .catch(function (err) { if (window.toast) window.toast('HF log out failed: ' + err.message); });
      return;
    }
    if (action === 'acct-hf-in') {
      if (window.HFConnect) window.HFConnect.openConnectPanel({ onDone: function () { hydrateAccounts(); } });
      return;
    }
    if (action === 'acct-gh-out' || action === 'acct-gt-out') {
      var kind = action === 'acct-gh-out' ? 'github' : 'gitea';
      acctJSON('/api/workspaces/accounts?kind=' + kind, { method: 'DELETE' })
        .then(function () { hydrateAccounts(); })
        .catch(function (err) { if (window.toast) window.toast('log out failed: ' + err.message); });
      return;
    }
    if (action === 'acct-gh-in') {
      if (window.GHConnect) window.GHConnect.openConnectPanel({ onDone: function () { hydrateAccounts(); } });
      return;
    }
    if (action === 'acct-keys') {
      if (window.ProvidersScreen) window.ProvidersScreen.open(null, {});
      return;
    }
  }

  // theme + grid actions (dispatched via doomalay:action)
  window.addEventListener('doomalay:action', function (e) {
    var d = e.detail || {};
    // v0.30: SCOPED actions — anything carrying data-scope="chat" belongs
    // to the per-chat tweaks view (tweaks.js owns the store + re-render).
    if (d.data && d.data.scope === 'chat' && window.ChatTweaks) {
      if (d.action === 'chat-scheme' && d.data.scheme) window.ChatTweaks.setScheme(d.data.scheme);
      else if (d.action === 'chat-colors-reset') window.ChatTweaks.resetColors();
      else if (d.action === 'tweaks-sizes-reset') window.ChatTweaks.resetSizes();
      return;
    }
    // v0.52: the look bundle actions (lookio.js)
    if (d.action === 'export-look') {
      if (window.LookIO) window.LookIO.exportLook();
      return;
    }
    if (d.action === 'import-look') {
      if (window.LookIO) window.LookIO.pickImport();
      return;
    }
    // v1.01.6: THE ICON REGISTRY actions (the swappable sets).
    if (d.action === 'icon-set-import') {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,.json';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) { if (window.DoomToast) window.DoomToast.show('icon set too big (4MB cap)', 'err'); return; }
        var fr = new FileReader();
        fr.onload = function () {
          var json;
          try { json = JSON.parse(String(fr.result)); } catch (e) {
            if (window.DoomToast) window.DoomToast.show('not valid JSON', 'err'); return; }
          var r = window.IconReg.importIconify(json, (f.name || 'set').replace(/\.json$/i, ''));
          if (window.DoomToast) window.DoomToast.show(
            r.ok ? ('icon set "' + r.name + '" — ' + r.count + ' glyphs') : ('import failed: ' + r.err),
            r.ok ? 'ok' : 'err');
          if (r.ok) Settings.rerender();
        };
        fr.readAsText(f);
      };
      inp.click();
      return;
    }
    if (d.action === 'icon-set-use' && d.data && typeof d.data.set === 'string') {
      var r2 = window.IconReg.useSet(d.data.set);
      if (r2.ok) Settings.rerender();
      return;
    }
    if (d.action === 'icon-set-remove' && d.data && d.data.set) {
      window.IconReg.removeSet(d.data.set);
      Settings.rerender();
      return;
    }
    // v0.74: the Connected Accounts actions (also reachable via acctAction
    // — the hydrated rows use direct listeners).
    if (typeof d.action === 'string' && d.action.indexOf('acct-') === 0) {
      acctAction(d.action);
      return;
    }
    if (d.action === 'set-theme' && d.data && d.data.theme) {
      Settings.setState({ theme: d.data.theme });
      // v0.26 LIVE UPDATE: re-render the page so the swatch selection,
      // grid inputs and customize rows reflect the NEW theme immediately
      // (the old UI kept stale values until the panel was reopened).
      Settings.rerender();
    } else if (d.action === 'theme-custom-reset') {
      var s0 = Settings.getState();
      var cur0 = s0.theme || 'midnight';
      var all0 = Object.assign({}, s0.themeOverrides || {});
      delete all0[cur0];
      Settings.setState({ themeOverrides: all0 });
      Settings.rerender();
    } else if (d.action === 'chat-scheme' && d.data && d.data.scheme) {
      Settings.setState({ chatScheme: d.data.scheme, fmtOverrides: {} });
      Settings.rerender();
    } else if (d.action === 'chat-colors-reset') {
      Settings.setState({ chatScheme: 'teal', fmtOverrides: {} });
      Settings.rerender();
    } else if (d.action === 'grid-colors-reset') {
      // v0.25 FIX: back to "follow the theme" = wipe to the LEGACY default
      // hexes (the marker effectiveGrid treats as never-customized). The old
      // reset stored CSS-VAR STRINGS ('var(--bg-app)') which broke everything
      // downstream: color inputs showed black, effectiveGrid passed the
      // string through, and ctx.fillStyle='var(--bg-app)' is INVALID on
      // canvas → silently ignored → the grid kept STALE colors that matched
      // neither the theme nor the settings (the reported bug).
      Settings.setState({
        bg: '#0a0a0b', lineColor: '#131318',
        dotColor: '#2e2e3a', originColor: '#4a4a5e'
      });
      // v0.26: re-render — the inputs must show the theme's palette NOW.
      Settings.rerender();
    } else if (d.action === 'grid-effects-reset') {
      // v0.45 ITEM 6: reset just the grid effects (hide/scatter/size/rotation)
      // v0.69: the deep field resets to its DEFAULT (0) — the pre-v0.67
      // flat lattice is the shipped look; the spacey stack is opt-in.
      // v0.75: BOTH columns reset (all the per-side twins) + the legacy
      // keys (imported looks read them) + the amplifier.
      Settings.setState({
        hideGridLines: false, hideDots: false,
        gridScatter: 0, gridSizeVariation: 0, gridRotation: 0,
        dotScatter: 0, lineScatter: 0,
        dotSizeVariation: 0, lineSizeVariation: 0,
        dotSizeBias: 0, lineSizeBias: 0,
        dotRotation: 0, lineRotation: 0,
        dotAnimate: false, lineAnimate: false,
        spaceParallax: 0
      });
      Settings.rerender();
    }
  });

  // ── HTML helpers ──────────────────────────────────────────────
  // Sections are collapsible — collapsed by default. The header has a
  // chevron that rotates when expanded. settings.js wires the toggle.
  // v0.25: ONE .section-inner wrapper owns the 0fr→1fr grid transition
  // (multiple direct children broke the animation + overlapped).
  // v0.30: exported (AppearanceUI.section) — the tweaks view builds the
  // SAME collapsible sections.
  function section(title, inner) {
    return '<div class="settings-section">' +
      '<h3 data-section-toggle><span>' + title + '</span><span class="chevron">▶</span></h3>' +
      '<div class="section-body"><div class="section-inner">' + inner + '</div></div>' +
      '</div>';
  }
  function row(label, control) {
    return '<div class="setting-row">' +
      '<label>' + label + '</label>' +
      '<div class="control">' + control + '</div>' +
      '</div>';
  }
  function selectRow(key, label, value, options) {
    let opts = '';
    for (const o of options) {
      const sel = o.value === value ? ' selected' : '';
      opts += '<option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
    }
    return row(label,
      '<select data-setting-key="' + key + '" data-setting-event="change" ' +
      'style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:10px 12px;min-height:44px;border-radius:10px;font-size:var(--ui-fs);font-family:inherit;width:100%">' +
      opts + '</select>');
  }
  // rangeRow — a slider with a value display + hint below.
  function rangeRow(key, label, value, min, max, step, hint) {
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" ' +
      'data-range-display="' + key + '">' + value + '×</span>' +
      '</div>' +
      '<input type="range" class="app-range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" ' +
      'style="accent-color:var(--accent);height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }
  // v0.45 ITEM 6: a toggle row (switch) for the hide-lines/hide-dots grid options.
  function toggleRow(key, label, checked) {
    return '<div class="setting-row" style="align-items:center;justify-content:space-between">' +
      '<label>' + label + '</label>' +
      '<label class="app-switch" style="position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0">' +
        '<input type="checkbox" data-setting-key="' + key + '" data-setting-event="change" ' + (checked ? 'checked' : '') +
        ' style="opacity:0;width:0;height:0;position:absolute">' +
        '<span class="app-switch-track" style="position:absolute;inset:0;background:' + (checked ? 'var(--accent)' : 'var(--surface-3)') +
        ';border-radius:12px;transition:background 0.15s"></span>' +
        '<span class="app-switch-thumb" style="position:absolute;top:2px;left:' + (checked ? '20px' : '2px') +
        ';width:20px;height:20px;background:var(--on-accent);border-radius:50%;transition:left 0.15s"></span>' +
      '</label>' +
    '</div>';
  }
  // v0.45 ITEM 6: a 0-100 slider for the grid effects (scatter/size/rotation).
  // v0.75: min/max parameterized (the size-bias slider spans -100..100);
  // existing 0-100 callers pass nothing and keep the old behavior.
  function gridSlider(key, label, value, hint, min, max) {
    if (typeof min !== 'number') min = 0;
    if (typeof max !== 'number') max = 100;
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" ' +
      'data-range-display="' + key + '" data-suffix="">' + value + '</span>' +
      '</div>' +
      '<input type="range" class="app-range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="' + min + '" max="' + max + '" step="1" value="' + value + '" ' +
      'style="accent-color:var(--accent);height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }

  // v0.75 THE TWO COLUMNS — one for the dots, one for the lines, every
  // option duplicated per side (user spec: "let's have two columns when
  // grid effects is expanded, one for dots and one for the lines… the
  // options are basically duplicated"). The legacy shared keys still
  // leak through numOr() (an imported pre-v0.75 look keeps painting).
  function numOr(v, legacy) {
    if (typeof v === 'number') return v;
    if (typeof legacy === 'number') return legacy;
    return 0;
  }
  function gridEffectsColumns(s) {
    var legSc = s.gridScatter, legSv = s.gridSizeVariation, legRo = s.gridRotation;
    function col(title, hideKey, hideOn, animKey, animOn, scKey, scVal, svKey, svVal, biKey, biVal, roKey, roVal) {
      return '<div style="flex:1 1 160px;min-width:150px;display:flex;flex-direction:column;gap:8px;' +
        'background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:10px">' +
        '<div style="font-size:calc(var(--ui-small-fs) + 1px);font-weight:600;color:var(--text-1);' +
          'letter-spacing:0.02em">' + title + '</div>' +
        toggleRow(hideKey, 'Hide', hideOn) +
        toggleRow(animKey, 'Animate', animOn) +
        gridSlider(scKey, 'Scatter', scVal, '', 0, 100) +
        gridSlider(svKey, 'Size variation', svVal, '', 0, 100) +
        gridSlider(biKey, 'Size bias', biVal, '− min: big stars rare · + max: small stars rare · bias alone spreads sizes too (v0.83)', -100, 100) +
        gridSlider(roKey, 'Rotation', roVal, '', 0, 100) +
        '</div>';
    }
    return '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">' +
      col('Dots',
        'hideDots', !!s.hideDots,
        'dotAnimate', !!s.dotAnimate,
        'dotScatter', numOr(s.dotScatter, legSc),
        'dotSizeVariation', numOr(s.dotSizeVariation, legSv),
        'dotSizeBias', (typeof s.dotSizeBias === 'number') ? s.dotSizeBias : 0,
        'dotRotation', numOr(s.dotRotation, legRo)) +
      col('Lines',
        'hideGridLines', !!s.hideGridLines,
        'lineAnimate', !!s.lineAnimate,
        'lineScatter', numOr(s.lineScatter, legSc),
        'lineSizeVariation', numOr(s.lineSizeVariation, legSv),
        'lineSizeBias', (typeof s.lineSizeBias === 'number') ? s.lineSizeBias : 0,
        'lineRotation', numOr(s.lineRotation, legRo)) +
      '</div>';
  }

  // v0.30: the shared builders — the tweaks view (tweaks.js) renders the
  // same controls over the per-chat store: same UI, same method, no copy.
  window.AppearanceUI = {
    section: section,
    schemeChatSwatches: schemeChatSwatches,
    fmtColorRow: fmtColorRowUI,
    sizeSlider: sizeSliderUI,
    colorRowCollapsed: colorRowCollapsed,
    wireColorRows: wireColorRows,
    // v0.44: wire the shared fmt editor rows after a host view inserts
    // them — the per-chat tweaks view calls this on ITS root (scope
    // "chat" rows route into ChatTweaks.setFmtSlot and rebuild locally);
    // the settings page's own rows are wired by the page-token drain.
    wireFmtEditors: wireFmtEditors,
    // v0.44: the #chat-root twin writer for the per-chat fmt slots —
    // a spec-aware tweaks.js can reuse exactly this paint
    paintChatFmtTwins: paintChatFmtTwins
  };
})();
