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
        Settings.rerender();
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
  function schemeThemeSwatches(current, scope) {
    var themes = (window.DoomTheme && window.DoomTheme.themes) || {};
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:8px 0 4px">';
    Object.keys(themes).forEach(function (id) {
      var t = themes[id];
      var sel = id === current;
      html += '<button data-action="set-theme" data-theme="' + id + '"' + (scope ? ' data-scope="' + scope + '"' : '') + ' ' +
        'style="display:flex;flex-direction:column;gap:6px;align-items:flex-start;' +
        'background:var(--surface-2);border:1.5px solid ' + (sel ? 'var(--accent)' : 'var(--border)') + ';' +
        'border-radius:12px;padding:10px;cursor:pointer;font-family:inherit;color:inherit;' +
        (sel ? 'box-shadow:0 0 0 2px rgba(var(--accent-rgb),0.25);' : '') + '">' +
        '<span style="display:flex;width:100%">' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + t.accent + ';display:inline-block"></i>' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + t.accent2 + ';display:inline-block;margin-left:2px"></i>' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + t.accent3 + ';display:inline-block;margin-left:2px"></i>' +
        '</span>' +
        (t.light ? '<span style="font-size:var(--ui-micro-fs);color:var(--text-3);font-weight:600">light</span>' : '') +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;color:var(--text-1)">' + t.label + '</span>' +
        '</button>';
    });
    html += '</div>' +
      '<p class="hint" style="margin:2px 0 0">The theme retints the whole app — panels, pills, chat accents, grid. Each pairs with a matching chat scheme; pick a different one below if you like.</p>';
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
    // the banner: a thin gradient strip previewing the spec's paint
    var bannerCss = 'background:linear-gradient(135deg,';
    if (colors.length === 1) {
      bannerCss += colors[0] + ',' + colors[0];
    } else {
      bannerCss += colors.join(',');
    }
    bannerCss += ');';
    var fmtAttr = (opts.fmtSlot ? ' data-fmt-slot="' + opts.fmtSlot + '"' : '') +
      (opts.fmtScope ? ' data-fmt-scope="' + opts.fmtScope + '"' : '');
    return '<div class="color-row-collapsed" data-color-row="' + pfx + '"' + fmtAttr + '>' +
      '<div class="color-row-head" data-color-toggle="' + pfx + '">' +
        '<span class="color-row-name">' + label + '</span>' +
        '<span class="color-row-banner" style="' + bannerCss + '"></span>' +
        '<button class="color-row-reset" data-color-reset="' + pfx + '" title="reset this row" aria-label="reset this row">↺</button>' +
        '<span class="color-row-arrow">▶</span>' +
      '</div>' +
      '<div class="color-row-body" data-color-body="' + pfx + '">' + editorHtml + '</div>' +
    '</div>';
  }

  // wireColorRows — click handlers for the collapsed color rows (expand/
  //    collapse + per-row reset). Called once after the settings page
  //    renders (and by tweaks.js on its own root).
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
        if (row) row.classList.toggle('expanded');
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

  function gridColorRow(key, label, spec) {
    var G = window.GradientUI;
    var pfx = 'gc-' + key;             // e.g. gc-bg / gc-lineColor
    queueEditorWire(pfx + '-gr', spec,
      function () { writeGridKey(key, spec); },
      function () { writeGridKey(key, spec); Settings.rerender(); });
    // v0.45 ITEM 5: collapsed color row — banner + expand arrow + per-row reset
    var onReset = function () {
      var defaults = { bg: '#0a0a0b', lineColor: '#131318',
        dotColor: '#2e2e3a', originColor: '#4a4a5e' };
      writeGridKey(key, defaults[key]);
      Settings.rerender();
    };
    rowResetFns[pfx] = onReset;
    return colorRowCollapsed({
      pfx: pfx, label: label, spec: spec,
      editorHtml: (G ? G.editor(pfx, spec, { noTex: true }) :
        '<span class="color-hex">' + String((spec.colors || [])[0] || '') + '</span>'),
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
      '<p class="hint">The infinite canvas behind the chats. Left at the theme\u2019s palette until you pick your own — gradients (up to 15 colors, any direction or pattern) paint straight onto the canvas for horizontal / vertical / diagonal / radial sweeps.</p>' +
      gridColorRow('bg', 'Background', g.bg) +
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
    var editorHtml = (G && G.editor)
      ? G.editor('fmt-' + key, spec, { noTex: true })
      : '<span class="color-hex">' + String(spec.colors[0] || '') + '</span>';
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
        (customized ? ' <span style="font-size:var(--ui-micro-fs);color:var(--accent);font-weight:600">· this chat</span>' : ''),
      spec: spec, editorHtml: editorHtml,
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
  function writeThemeVar(varName, spec) {
    var s = Settings.getState();
    var cur = s.theme || 'midnight';
    var all = Object.assign({}, s.themeOverrides || {});
    all[cur] = Object.assign({}, all[cur] || {});
    all[cur][varName] = spec;
    Settings.setState({ themeOverrides: all }); // persists + applies live
  }

  function themeCustomizeSection() {
    var s = Settings.getState();
    var cur = s.theme || 'midnight';
    var themes = (window.DoomTheme && window.DoomTheme.themes) || {};
    var t = themes[cur] || {};
    var ov = (s.themeOverrides && s.themeOverrides[cur]) || {};
    var customCount = Object.keys(ov).length;
    var rows = '';
    var customizable = (window.DoomTheme && window.DoomTheme.customizable) || [];
    var G = window.GradientUI;
    customizable.forEach(function (c) {
      var pfx = 'tv-' + String(c.var || '').replace(/^--/, '');  // '--accent' → 'tv-accent'
      var stored = ov[c.var];
      var spec;
      if (stored) {
        // the stored override: a gradient spec or a legacy hex — norm
        // folds either (a COPY: wire() mutates the editor's live spec)
        spec = (G && G.norm) ? G.norm(stored) :
          { colors: [String((stored && typeof stored === 'object' && stored.colors) ? stored.colors[0] : stored)], dir: 'auto' };
      } else {
        // not customized: the theme's CURRENT computed hex, as a 1-color
        // spec (what the editor offers is what the app looks like now)
        var live = cssVarLive(c.var);
        var liveHex = /^#[0-9a-fA-F]{6}$/.test(live || '') ? live : '#000000';
        spec = { colors: [liveHex], dir: 'auto' };
      }
      queueEditorWire(pfx + '-gr', spec,
        function () { writeThemeVar(c.var, spec); },
        function () { writeThemeVar(c.var, spec); Settings.rerender(); });
      var editorHtml = (G ? G.editor(pfx, spec, { noTex: true }) :
        '<span class="color-hex">' + String(spec.colors[0] || '') + '</span>');
      var onReset = function () {
        var sR = Settings.getState();
        var curR = sR.theme || 'midnight';
        var allR = Object.assign({}, sR.themeOverrides || {});
        if (allR[curR]) {
          delete allR[curR][c.var];
          if (!Object.keys(allR[curR]).length) delete allR[curR];
        }
        Settings.setState({ themeOverrides: allR });
        Settings.rerender();
      };
      rowResetFns[pfx] = onReset;
      // v0.45 ITEM 5: collapsed color row with per-row reset (clears just THIS var's override)
      rows += colorRowCollapsed({
        pfx: pfx,
        label: c.label + (stored ? ' <span style="font-size:var(--ui-micro-fs);color:var(--accent);font-weight:600">· customized</span>' : ''),
        spec: spec, editorHtml: editorHtml,
        onReset: onReset
      });
    });
    return section('Customize ' + (t.label || 'Theme'),
      '<p class="hint">Tune <b>' + (t.label || 'this theme') + '</b> itself — any var can stay a solid or grow into a gradient (up to 15 colors, any direction, the patterns included). Changes ride on top of the palette and persist for this theme only (each theme keeps its own customizations). ' + (customCount ? customCount + ' var' + (customCount > 1 ? 's' : '') + ' customized so far.' : '') + '</p>' +
      rows +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button data-action="theme-custom-reset" style="flex:1;background:transparent;border:1px solid var(--border);color:var(--text-3);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer">reset this theme</button>' +
      '</div>'
    );
  }

  function cssVarLive(name) {
    // the EFFECTIVE var (theme block + any live overrides)
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { return ''; }
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
      return pageRender(
        section('Theme', '' +
          themeSwatches()
        ) +
        themeCustomizeSection() +
        gridSection() +
        section('Chat Colors', '' +
          '<p class="hint">The markdown color scheme for messages — a family of 2–3 adjacent hues. Pick a preset, or fine-tune every slot below: each may stay a solid or grow into a gradient (multi-color slots paint gradient TEXT in headings, emphasis, bold and links).</p>' +
          schemeSwatches() +
          fmtColorRow('a1', 'Accent 1', 'headings · keywords') +
          fmtColorRow('a2', 'Accent 2', 'subheads · code') +
          fmtColorRow('a3', 'Accent 3', 'emphasis · links') +
          fmtColorRow('bright', 'Bright text', 'bold') +
          fmtColorRow('link', 'Links', '') +
          '<button data-action="chat-colors-reset" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;border-radius:8px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer;margin-top:6px">reset to preset defaults</button>'
        )
      );
    }
  });

  Settings.registerPage('sizing', {
    title: 'Sizing',
    icon: '📐',
    render: function (getState, setState) {
      var s = getState();
      return (
        section('Text Size', '' +
          '<p class="hint">Every piece of text in the app scales through one of three sizes — no more 30-variable tweakfests.</p>' +
          sizeSlider('chatTextSize', 'Chat text', 'Message bubbles · 0 = 12px · 100 = 24px (replies, questions).') +
          sizeSlider('uiTextSize', 'General text', 'Labels, buttons, headers, inputs · 0 = 12px · 100 = 17px.') +
          sizeSlider('smallTextSize', 'Small text', 'Pills, thinking bubbles, hints, meta, tool cards · 0 = 9.5px · 100 = 15px.')
        ) +
        section('Grid Size', '' +
          rangeRow('gridSize', 'Grid Spacing', getState().gridSize || 1, 1, 5, 0.5,
            'Scales the grid spacing. 1× = default (48px). 5× = largest (240px), fewer squares.')
        ) +
        // v0.45 ITEM 6: grid quick options — hide / scatter / size / rotate
        section('Grid Effects', '' +
          '<p class="hint">Quick tweaks for the canvas grid: hide the lines or dots, scatter them off-grid, vary their size, or rotate them. Scatter, size and rotation use a stable per-cell hash (the same cell always looks the same — no shimmer on pan/zoom).</p>' +
          toggleRow('hideGridLines', 'Hide grid lines', s.hideGridLines) +
          toggleRow('hideDots', 'Hide dots', s.hideDots) +
          gridSlider('gridScatter', 'Scatter', s.gridScatter || 0, '0 = on-grid · 100 = up to ±60px displacement.') +
          gridSlider('gridSizeVariation', 'Size variation', s.gridSizeVariation || 0, '0 = uniform · 100 = ±50% radius/length.') +
          gridSlider('gridRotation', 'Rotation', s.gridRotation || 0, '0 = axis-aligned · 100 = up to ±60°.') +
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
      return (
        section('Text', '' +
          selectRow('fontFamily', 'Font', s.fontFamily, [
            { value: 'system', label: 'System Default' },
            { value: 'serif', label: 'Serif' },
            { value: 'monospace', label: 'Monospace' }
          ])
        ) +
        section('Default Chat Names', '' +
          '<p class="hint">Names used when creating new chatbots. One per line.</p>' +
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
        )
      );
    }
  });

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
      Settings.setState({
        hideGridLines: false, hideDots: false,
        gridScatter: 0, gridSizeVariation: 0, gridRotation: 0
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
        ';width:20px;height:20px;background:#fff;border-radius:50%;transition:left 0.15s"></span>' +
      '</label>' +
    '</div>';
  }
  // v0.45 ITEM 6: a 0-100 slider for the grid effects (scatter/size/rotation).
  function gridSlider(key, label, value, hint) {
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" ' +
      'data-range-display="' + key + '" data-suffix="">' + value + '</span>' +
      '</div>' +
      '<input type="range" class="app-range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="0" max="100" step="1" value="' + value + '" ' +
      'style="accent-color:var(--accent);height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
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
