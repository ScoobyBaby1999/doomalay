// settings.js — modular settings system with pages.
//
// Settings are organized into pages (Appearance, Chats, Models, etc.).
// Each page registers a render function that returns HTML for the panel
// body. The settings icon opens the panel with a page nav + the active
// page's content.
//
// Settings state lives in a single object, persisted to localStorage.
// Pages read from getState() and write via setState(). On every change,
// listeners are notified so the app can re-render live.
//
// Exposes: window.Settings = { registerPage, openInPanel, getState, setState, onChange }

(function () {
  'use strict';

  const STORAGE_KEY = 'doomalay.settings.v1';

  // Default settings. Appearance page adds grid colors + names here.
  // These are available even before the page registers, so the app
  // can read them on init.
  const defaultState = {
    // ── v0.24: the THEME (drives every UI color via CSS vars) ────
    theme: 'midnight',
    // ── v0.26: per-theme customizations — {themeId: {'--accent': '#…'}}
    themeOverrides: {},
    // ── v0.17→v0.24: chat formatting (scheme + sizes) ───────────
    chatScheme: 'teal',            // 'follow-theme' handling lives in theme.js
    fmtOverrides: {},           // per-slot CSS-variable overrides
    chatTextSize: 50,           // 0–100 (12px–24px, 50 → 16px) — message text
    uiTextSize: 50,             // v0.24: 0–100 (12px–17px) — general UI text
    smallTextSize: 50,          // v0.24: 0–100 (9.5px–15px) — pills, hints, meta
    // ── Appearance (grid) — LEGACY default hexes; equal values mean
    //    "never customized" → theme.js swaps in the theme's grid palette
    gridSize: 1,           // 1× = default (48px), up to 5× = 240px
    bg: '#0a0a0b',
    lineColor: '#131318',
    dotColor: '#2e2e3a',
    originColor: '#4a4a5e',
    // ── v0.45 ITEM 6: grid quick options (hide / scatter / size / rotate) ──
    hideGridLines: false,   // toggle the connecting grid lines
    hideDots: false,        // toggle the dots
    gridScatter: 0,         // 0-100 → max px displacement per dot/line intersection
    gridSizeVariation: 0,   // 0-100 → max % radius/length delta
    gridRotation: 0,        // 0-100 → max degrees of rotation per line/dot
    // ── v0.75 THE TWO COLUMNS: every grid effect is per-side (dots/lines) ──
    // (the legacy shared keys above still migrate in — see loadState)
    dotScatter: 0, lineScatter: 0,         // 0-100 → max px displacement
    dotSizeVariation: 0, lineSizeVariation: 0, // 0-100 → ±170% (v0.75 doubled range)
    dotSizeBias: 0, lineSizeBias: 0,       // -100..100 → favors smaller/larger
    dotRotation: 0, lineRotation: 0,       // 0-100 → max degrees of rotation
    dotAnimate: false, lineAnimate: false,  // v0.75 animate: twinkle / drift
    // v0.67 THE DEEP FIELD: parallax depth between the canvas planes
    // (lines lag the icons, dots sit between; 0 = flat lattice, 100 =
    // the full spacey stack). v0.69: ships 0 — the user preferred the
    // pre-v0.67 flat lattice ("the older one was much better"); the
    // Tweaks slider still dials it up on request.
    spaceParallax: 0,
    // ── Text ──────────────────────────────────────────────────
    fontFamily: 'system',
    // ── Default chatbot names (editable) ───────────────────────
    names: [
      'Scooby', 'Doobie', '4rth Grade', 'Crippy', 'Lippy', 'Trippy',
      'Baby', 'Boonboon', 'Dock', 'Faqous', 'Lip', 'Sky', 'Kenny'
    ]
  };

  let state = loadState();
  const listeners = [];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Object.assign({}, defaultState);
      const saved = JSON.parse(raw);
      // Merge: saved overrides defaults, but names must be an array.
      const merged = Object.assign({}, defaultState, saved);
      if (!Array.isArray(merged.names)) merged.names = defaultState.names;
      // v0.69: the deep field ships OFF (the pre-v0.67 flat lattice is
      // the default again). Anyone who ran v0.67/68 carries the OLD
      // default (60) in localStorage — reset it ONCE; a deliberately
      // chosen value (anything ≠ 60) survives untouched.
      if (saved.spaceParallax === 60 && !saved.spaceParallaxV69) {
        merged.spaceParallax = defaultState.spaceParallax;
        merged.spaceParallaxV69 = true;
      }
      // v0.75 TWO COLUMNS: the shared effect keys split into per-side
      // twins (dots/lines). Anyone carrying a legacy value gets it copied
      // to BOTH sides once — the look they dialed in survives the split.
      // (Renderers also fall back to the legacy key when a twin is absent,
      // so an IMPORTED pre-v0.75 look bundle works without a reload.)
      if (!saved.gridV75) {
        if (typeof merged.gridScatter === 'number' && typeof saved.dotScatter !== 'number') {
          merged.dotScatter = merged.lineScatter = merged.gridScatter;
        }
        if (typeof merged.gridSizeVariation === 'number' && typeof saved.dotSizeVariation !== 'number') {
          merged.dotSizeVariation = merged.lineSizeVariation = merged.gridSizeVariation;
        }
        if (typeof merged.gridRotation === 'number' && typeof saved.dotRotation !== 'number') {
          merged.dotRotation = merged.lineRotation = merged.gridRotation;
        }
        merged.gridV75 = true;
      }
      return merged;
    } catch (e) { return Object.assign({}, defaultState); }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('Settings save failed', e); }
  }

  // ── v0.79.1: DEBOUNCED PERSISTENCE ───────────────────────────
  // The theme editors + sliders fire setState per INPUT EVENT (the
  // native color wheel fires up to ~120/s). JSON.stringify of the
  // whole state + a synchronous localStorage.setItem PER EVENT was
  // a measurable slice of the "barely usable 8fps" theme-drag (the
  // panel-perf wave, PLAN-V079 §B). The in-memory state and every
  // listener stay IMMEDIATE — only the storage write moves, 300ms
  // after the last change. pagehide/visibility flush so a kill/ship
  // mid-debounce never loses the edit (the app's own state file does
  // the same trailing-flush pattern).
  let saveTimer = 0;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      save();
    }, 300);
  }
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    save();
  }
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave();
  });

  function getState() { return state; }

  function setState(patch) {
    Object.assign(state, patch);
    saveSoon();   // v0.79.1: debounced (was: save() per event)
    // Notify listeners (the app redraws the grid on color change, etc.).
    for (const cb of listeners) { try { cb(state); } catch (e) {} }
  }

  function onChange(cb) { listeners.push(cb); }

  // v0.26: rerender() — re-render the OPEN settings page, preserving
  // which sections are expanded and the scroll position. The theme live-
  // update bug: the grid-color inputs + the selected theme swatch render
  // ONCE with the old theme's values and went stale until the panel was
  // closed and reopened. Any action that changes what the page shows
  // (set-theme, grid reset, chat-scheme pick) now calls this.
  function rerender() {
    if (!panelRef || !panelRef.isOpen || !panelRef.isOpen()) return;
    var body = panelRef.bodyEl;
    var openTitles = [];
    body.querySelectorAll('.settings-section.expanded').forEach(function (s) {
      var h = s.querySelector('h3');
      if (h) openTitles.push(h.textContent.trim());
    });
    var scroll = body.scrollTop;
    renderSettings();
    // restore expansion by section title + the scroll position
    requestAnimationFrame(function () {
      var nb = panelRef.bodyEl;
      if (!nb) return;
      nb.querySelectorAll('.settings-section').forEach(function (s) {
        var h = s.querySelector('h3');
        if (h && openTitles.indexOf(h.textContent.trim()) >= 0) s.classList.add('expanded');
      });
      nb.scrollTop = scroll;
    });
  }

  // ── Page registry ─────────────────────────────────────────────
  const pages = {};
  let pageOrder = [];

  function registerPage(id, opts) {
    pages[id] = { id: id, title: opts.title, icon: opts.icon || '', render: opts.render };
    pageOrder.push(id);
  }

  function listPages() {
    return pageOrder.map(function (id) { return pages[id]; }).filter(Boolean);
  }

  // ── Open settings in a panel ───────────────────────────────────
  // The settings UI has a nav (list of pages) + the active page's content.
  // Selecting a page re-renders the body.
  let activePageId = null;
  let panelRef = null;

  function openInPanel(panel) {
    panelRef = panel;
    if (!activePageId) {
      const list = listPages();
      activePageId = pages['appearance'] ? 'appearance' : (list[0] && list[0].id) || null;
    }
    renderSettings();
  }

  function renderSettings() {
    if (!panelRef) return;
    const list = listPages();
    const active = pages[activePageId];

    // Nav HTML — horizontal tabs.
    let navHTML = '<div class="settings-nav">';
    for (const p of list) {
      const cls = p.id === activePageId ? 'tab active' : 'tab';
      navHTML += '<button class="' + cls + '" data-page="' + p.id + '">' +
                 (p.icon ? p.icon + ' ' : '') + p.title + '</button>';
    }
    navHTML += '</div>';

    // Body HTML — the active page's render().
    let bodyHTML = navHTML;
    if (active) {
      bodyHTML += '<div class="settings-page">' + active.render(getState, setState) + '</div>';
    } else {
      bodyHTML += '<div class="placeholder">No settings pages registered.</div>';
    }

    panelRef.open({
      title: 'Settings',
      subtitle: active ? active.title : '',
      avatarHTML: '<svg viewBox="0 0 24 24" style="width:24px;height:24px;fill:currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.62l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.42-.49-.42h-3.84c-.24 0-.43.17-.47.42l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.48.12.62l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.62l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
      bodyHTML: bodyHTML,
      context: { type: 'settings', id: 'settings' } // v0.25: id → panel opens full + remembers its own height
    });

    // Wire up nav tab clicks.
    const tabs = panelRef.bodyEl.querySelectorAll('.settings-nav .tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        activePageId = tab.dataset.page;
        renderSettings();
      });
    });

    // Wire up any inputs the page rendered (data-setting-key).
    wireInputs(panelRef.bodyEl, setState);
  }

  // v0.30: wireInputs — the generic settings-input wiring, EXTRACTED so the
  // per-chat tweaks view (tweaks.js) drives the SAME controls with its own
  // store (the user spec: "try to show the same UI and use the same method
  // we have for the settings without duplication"). Contract:
  //   · [data-setting-key] inputs → apply({key: value}) (color/text/number/
  //     checkbox; data-setting-transform="lines|number" honored) — inputs
  //     carrying data-custom are left to their page module (the fmt colors)
  //   · the neighboring [data-range-display] updates live
  //   · [data-section-toggle] headers fold/unfold their section
  //   · [data-action] buttons dispatch doomalay:action with the button's
  //     whole dataset — data-scope="chat" rides along for the scoped
  //     handlers in appearance.js to pick up
  function wireInputs(rootEl, apply) {
    if (!rootEl || typeof apply !== 'function') return;
    const els = rootEl.querySelectorAll('[data-setting-key]');
    els.forEach(function (el) {
      if (el.dataset.custom) return; // page-module-managed inputs (fmt colors)
      const key = el.dataset.settingKey;
      const ev = el.dataset.settingEvent || 'input';
      // v0.79.1: RANGE sliders are rAF-coalesced (latest-wins, the
      // trailing change flushes) — a fast drag fired the full setState
      // cascade per OS event (up to ~120/s), stacking paints per frame.
      if (el.type === 'range' && ev === 'input') {
        let rafId = 0;
        const fireNow = function () {
          let val = el.type === 'checkbox' ? el.checked : el.value;
          const transform = el.dataset.settingTransform;
          if (transform === 'number') val = parseFloat(val);
          const patch = {};
          patch[key] = val;
          apply(patch);
          const display = rootEl.querySelector('[data-range-display="' + key + '"]');
          if (display) {
            const suffix = display.dataset.suffix !== undefined ? display.dataset.suffix : '×';
            display.textContent = val + suffix;
          }
        };
        el.addEventListener('input', function () {
          const display = rootEl.querySelector('[data-range-display="' + key + '"]');
          if (display) {
            const suffix = display.dataset.suffix !== undefined ? display.dataset.suffix : '×';
            display.textContent = el.value + suffix;
          }
          if (rafId) return;
          rafId = requestAnimationFrame(function () { rafId = 0; fireNow(); });
        });
        el.addEventListener('change', function () {
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          fireNow();
        });
        return;
      }
      el.addEventListener(ev, function () {
        let val = el.type === 'checkbox' ? el.checked : el.value;
        const transform = el.dataset.settingTransform;
        if (transform === 'lines') {
          val = val.split('\n').map(function (s) { return s.trim(); })
                   .filter(function (s) { return s.length > 0; });
        } else if (transform === 'number') {
          val = parseFloat(val);
        }
        const patch = {};
        patch[key] = val;
        apply(patch);
        // Live-update the range display next to the slider.
        const display = rootEl.querySelector('[data-range-display="' + key + '"]');
        if (display) {
          const suffix = display.dataset.suffix !== undefined ? display.dataset.suffix : '×';
          display.textContent = val + suffix;
        }
      });
    });

    // Wire up collapsible section headers (tap to toggle).
    const sectionHeaders = rootEl.querySelectorAll('[data-section-toggle]');
    sectionHeaders.forEach(function (h) {
      h.addEventListener('click', function () {
        const section = h.parentElement;
        if (section) section.classList.toggle('expanded');
      });
    });

    // Wire up buttons with data-action (for things like "reset view").
    const btns = rootEl.querySelectorAll('[data-action]');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const action = btn.dataset.action;
        // Dispatch a custom event so app.js or other modules can handle it.
        // v0.17: include the button's dataset + node so page modules can
        // carry custom payloads (e.g. which color scheme was picked).
        // v0.30: data-scope="chat" rides along in the dataset — the scoped
        // handlers branch on it (per-chat tweaks vs global settings).
        window.dispatchEvent(new CustomEvent('doomalay:action', {
          detail: { action: action, data: btn.dataset, btn: btn }
        }));
      });
    });
  }

  window.Settings = {
    registerPage: registerPage,
    listPages: listPages,
    openInPanel: openInPanel,
    rerender: rerender,
    wireInputs: wireInputs,
    getState: getState,
    setState: setState,
    onChange: onChange
  };
})();
