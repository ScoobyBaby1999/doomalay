// ui.js — menu + bottom sheets + toast. Vanilla, no deps.
//
// Exposes: window.DoomalayUI
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────
// v0.7.0's long-press menu was un-interactable on real touch devices: the
// document-level touch handlers called preventDefault() on every touch that
// wasn't "inside the UI", which — combined with `touch-action:none` on
// html/body — suppressed the synthetic click events the menu buttons needed.
// On desktop (mouse) everything worked, which is why the bug slipped past
// the headless dogfood.
//
// The fix here is structural:
//   1. NO document-level touch/mouse interception in this file. Menus and
//      sheets are plain DOM with plain click listeners.
//   2. A full-screen BACKDROP element sits between the app layer and the
//      UI layer while any menu/sheet is open. Canvas gestures can't race
//      the menu because they never receive events while the backdrop is up.
//   3. Every menu/sheet has an ✕ close button. Every button has a ≥44px hit
//      area and :active visual feedback so taps visibly REGISTER.
//   4. touch-action is per-element: `none` only where a gesture is being
//      hand-tracked (canvas, panel drag areas); `manipulation` everywhere
//      else so taps always produce clicks.

(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────
  const menuEl = document.getElementById('menu');
  const backdropEl = document.getElementById('backdrop');
  const sheetEl = document.getElementById('sheet');
  const sheetTitleEl = document.getElementById('sheetTitle');
  const sheetCloseEl = document.getElementById('sheetClose');
  const sheetBodyEl = document.getElementById('sheetBody');
  const toastEl = document.getElementById('toast');

  let openKind = null;       // 'menu' | 'sheet' | null
  let currentSheet = null;   // id of the open sheet builder
  let menuActionHandler = null;

  // ── Toast (transient feedback — "taps register" feedback) ────
  let toastTimer = null;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, ms || 2200);
  }

  // ── Backdrop (blocks canvas gestures while UI is open) ───────
  function showBackdrop() { backdropEl.classList.add('show'); }
  function hideBackdrop() { backdropEl.classList.remove('show'); }

  // ── Menu (long-press dropdown) ───────────────────────────────
  // Items: [{action, label, icon}]
  function showMenu(x, y, items, onAction) {
    menuActionHandler = onAction || null;
    // Build buttons.
    menuEl.innerHTML = '';
    items.forEach(function (it) {
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.dataset.action = it.action;
      const icon = document.createElement('span');
      icon.className = 'menu-icon';
      icon.textContent = it.icon || '•';
      const label = document.createElement('span');
      label.textContent = it.label;
      btn.appendChild(icon);
      btn.appendChild(label);
      menuEl.appendChild(btn);
    });
    // ✕ close affordance — always present, top-right of the menu.
    const close = document.createElement('button');
    close.className = 'menu-close';
    close.setAttribute('aria-label', 'Close menu');
    close.textContent = '✕';
    close.addEventListener('click', function () { hideMenu(); });
    menuEl.appendChild(close);

    // Position, clamped to the viewport with margins.
    menuEl.classList.remove('hidden');
    openKind = 'menu';
    showBackdrop();
    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    const r = menuEl.getBoundingClientRect();
    const mx = Math.max(12, Math.min(window.innerWidth - r.width - 12, x - r.width / 2));
    const my = Math.max(12, Math.min(window.innerHeight - r.height - 12, y - r.height / 2));
    menuEl.style.left = Math.round(mx) + 'px';
    menuEl.style.top = Math.round(my) + 'px';
  }

  function hideMenu() {
    menuEl.classList.add('hidden');
    if (openKind === 'menu') openKind = null;
    if (openKind === null) hideBackdrop();
    menuActionHandler = null;
  }

  menuEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button.menu-item');
    if (!btn) return;
    const action = btn.dataset.action;
    // Capture the handler BEFORE hideMenu() — hideMenu nulls
    // menuActionHandler (v0.8.0 bug: the action never fired because the
    // handler was cleared one line too early).
    const handler = menuActionHandler;
    // Visual press feedback is handled by CSS :active. Hide first so the
    // sheet that opens next doesn't fight the menu for z-space.
    hideMenu();
    if (handler) handler(action);
  });

  // ── Bottom sheet ─────────────────────────────────────────────
  // Sheets are used for: Model Picker, API Keys, Local Models.
  // A sheet builder is: function(bodyEl, ctx) → fills bodyEl with content.
  const sheetBuilders = {};

  function registerSheet(id, builder) { sheetBuilders[id] = builder; }

  function openSheet(id, ctx) {
    const builder = sheetBuilders[id];
    if (!builder) return;
    currentSheet = id;
    sheetTitleEl.textContent = (ctx && ctx.title) || '';
    sheetBodyEl.innerHTML = '';
    sheetEl.classList.remove('hidden');
    sheetEl.classList.remove('closing');
    sheetEl.classList.add('open');
    openKind = 'sheet';
    showBackdrop();
    try {
      builder(sheetBodyEl, ctx || {});
    } catch (err) {
      sheetBodyEl.innerHTML = '<div class="sheet-error">Failed to build sheet: ' +
        String(err && err.message || err) + '</div>';
    }
  }

  function closeSheet() {
    if (openKind !== 'sheet') return;
    sheetEl.classList.remove('open');
    sheetEl.classList.add('closing');
    openKind = null;
    currentSheet = null;
    setTimeout(function () {
      // Only fully hide if we're still closed (rapid reopen cancels it).
      if (!sheetEl.classList.contains('open')) {
        sheetEl.classList.add('hidden');
      }
      sheetEl.classList.remove('closing');
    }, 200);
    hideBackdrop();
  }

  sheetCloseEl.addEventListener('click', function () { closeSheet(); });
  backdropEl.addEventListener('click', function () {
    if (openKind === 'menu') hideMenu();
    else if (openKind === 'sheet') closeSheet();
    // NOTE: the chat panel manages its own dim layer, NOT this backdrop.
  });

  // ── Shared small builders ────────────────────────────────────
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(cls, text) {
    const b = el('button', cls, text);
    return b;
  }

  // Spinner row ("Loading…").
  function loadingRow(msg) {
    const row = el('div', 'loading-row');
    const dot = el('span', 'spinner');
    row.appendChild(dot);
    row.appendChild(el('span', null, msg || 'Loading…'));
    return row;
  }

  // ── MODEL PICKER sheet ───────────────────────────────────────
  // Context: { onPick(modelId, provider, label) }
  // Layout:
  //   [Local models — 1-tap download demo]
  //   [Search box]
  //   [Provider sections: color chip, label, Free/Key badges, models]
  registerSheet('models', function (body, ctx) {
    body.appendChild(loadingRow('Loading providers + models…'));

    window.DoomalayAPI.models().then(function (data) {
      body.innerHTML = '';

      // ── Local models section (flow demo — engine wiring comes later) ──
      const localSection = el('div', 'sheet-section');
      localSection.appendChild(el('div', 'sheet-section-title', 'On-device (local)'));
      const localNote = el('div', 'sheet-note',
        'Download once, chat offline, zero API cost. Tap a model to download it.');
      localSection.appendChild(localNote);

      const LOCAL_MODELS = [
        { id: 'local:llama-3.2-1b',   name: 'Llama 3.2 1B',   size: '0.6 GB', tag: 'Fastest' },
        { id: 'local:qwen-2.5-1.5b',  name: 'Qwen 2.5 1.5B',  size: '1.0 GB', tag: 'Balanced' },
        { id: 'local:phi-3-mini',     name: 'Phi-3 Mini',     size: '2.2 GB', tag: 'Smart' },
        { id: 'local:llama-3.1-8b',   name: 'Llama 3.1 8B',   size: '4.7 GB', tag: 'Best' }
      ];

      LOCAL_MODELS.forEach(function (m) {
        const row = el('div', 'model-row local-model');
        const info = el('div', 'model-info');
        info.appendChild(el('div', 'model-name', m.name + '  ·  ' + m.size));
        info.appendChild(el('div', 'model-sub', 'On-device · ' + m.tag + ' · no API key needed'));
        const dl = button('btn btn-small', 'Download');
        dl.addEventListener('click', function () {
          // Demo flow: animated progress → "Ready". Registers taps; the
          // real download pipeline (llama.cpp weights fetch + MMKV store)
          // lands in a later version.
          row.classList.add('downloading');
          dl.disabled = true;
          dl.textContent = '0%';
          let pct = 0;
          const timer = setInterval(function () {
            pct += 3 + Math.floor(Math.random() * 9);
            if (pct >= 100) {
              clearInterval(timer);
              row.classList.remove('downloading');
              row.classList.add('downloaded');
              dl.classList.add('btn-success');
              dl.textContent = '✓ Ready';
              toast(m.name + ' downloaded (demo — engine wiring soon)');
            } else {
              dl.textContent = Math.min(pct, 99) + '%';
            }
          }, 180);
        });
        row.appendChild(info);
        row.appendChild(dl);
        localSection.appendChild(row);
      });
      body.appendChild(localSection);

      // ── Search ──
      const searchWrap = el('div', 'search-wrap');
      const search = el('input', 'search-input');
      search.type = 'search';
      search.placeholder = 'Search models…';
      searchWrap.appendChild(search);
      body.appendChild(searchWrap);

      const cloudSection = el('div', 'sheet-section');
      body.appendChild(cloudSection);

      const render = function (query) {
        cloudSection.innerHTML = '';
        cloudSection.appendChild(el('div', 'sheet-section-title', 'Cloud providers'));
        const q = (query || '').toLowerCase();

        const providers = data.providers || {};
        const models = (data.models || []).filter(function (m) {
          return !q || m.id.toLowerCase().indexOf(q) !== -1 ||
                 (m.provider || '').toLowerCase().indexOf(q) !== -1;
        });

        // Group models by provider.
        const groups = {};
        models.forEach(function (m) {
          const p = m.provider || 'other';
          if (!groups[p]) groups[p] = [];
          groups[p].push(m);
        });

        // Render EVERY provider in the catalog (like the old Providers UI)
        // even when no models are synced — key status + Add key buttons +
        // signup links are useful without a key. Providers with synced
        // models also list their models as tappable rows.
        const providerNames = Object.keys(providers)
          .filter(function (p) { return !q || p.toLowerCase().indexOf(q) !== -1; })
          .concat(Object.keys(groups).filter(function (g) { return !providers[g]; }))
          .sort();

        if (providerNames.length === 0) {
          const empty = el('div', 'sheet-note');
          if (q) {
            empty.textContent = 'No providers or models match "' + query + '".';
          } else {
            empty.textContent = 'No providers loaded — is the engine running?';
          }
          cloudSection.appendChild(empty);
          return;
        }

        providerNames.forEach(function (pName) {
          const cfg = providers[pName] || {};
          const status = (data.syncStatus || []).filter(function (s) {
            return s.provider === pName;
          })[0];
          const providerModels = groups[pName] || [];

          const group = el('div', 'provider-group');
          const header = el('div', 'provider-header');

          const chip = el('span', 'provider-chip');
          chip.style.background = cfg.color || '#4a4a5e';
          chip.textContent = (cfg.label || pName).charAt(0).toUpperCase();
          header.appendChild(chip);

          const titles = el('div', 'provider-titles');
          const titleRow = el('div', 'provider-title-row');
          titleRow.appendChild(el('span', 'provider-label', cfg.label || pName));
          if (cfg.free_tier) titleRow.appendChild(el('span', 'badge badge-free', 'Free tier'));
          if (status && status.has_key) titleRow.appendChild(el('span', 'badge badge-key', 'Key ✓'));
          titles.appendChild(titleRow);
          titles.appendChild(el('div', 'provider-sub',
            providerModels.length > 0
              ? (providerModels.length + ' models synced')
              : ((cfg.description || '') + (status && status.has_key ? ' · syncing…' : ''))));
          header.appendChild(titles);

          if (!(status && status.has_key)) {
            const addKey = button('btn btn-small', 'Add key');
            addKey.addEventListener('click', function () {
              closeSheet();
              window.DoomalayUI.openSheet('keys', { provider: pName });
            });
            header.appendChild(addKey);
          }
          group.appendChild(header);

          providerModels.forEach(function (m) {
            const row = el('div', 'model-row tappable');
            const info = el('div', 'model-info');
            info.appendChild(el('div', 'model-name', m.id));
            info.appendChild(el('div', 'model-sub', cfg.label || pName));
            row.appendChild(info);
            // Whole row is the tap target (big hit area).
            row.addEventListener('click', function () {
              if (ctx.onPick) ctx.onPick(m.id, pName, m.label || m.id);
            });
            group.appendChild(row);
          });
          cloudSection.appendChild(group);
        });
      };

      search.addEventListener('input', function () {
        render(search.value);
      });
      render('');
    }).catch(function (err) {
      body.innerHTML = '';
      body.appendChild(el('div', 'sheet-error',
        'Could not load models: ' + (err && err.message || err)));
    });
  });

  // ── API KEYS sheet ───────────────────────────────────────────
  // Context: { provider?: 'groq', onSaved?: fn }
  registerSheet('keys', function (body, ctx) {
    body.appendChild(loadingRow('Loading providers…'));

    Promise.all([
      window.DoomalayAPI.models(),
      window.DoomalayAPI.listKeys()
    ]).then(function (results) {
      const data = results[0];
      const keys = results[1] || {};
      body.innerHTML = '';

      body.appendChild(el('div', 'sheet-note',
        'Paste an API key to enable that provider. Keys are stored in the ' +
        'engine vault on this device and never leave it except to call the provider.'));

      const providers = data.providers || {};
      const names = Object.keys(providers).sort();

      names.forEach(function (pName) {
        const cfg = providers[pName];
        const keyInfo = keys[cfg.env_var];
        const active = keyInfo && keyInfo.has_key;

        const group = el('div', 'provider-group');
        const header = el('div', 'provider-header');

        const chip = el('span', 'provider-chip');
        chip.style.background = cfg.color || '#4a4a5e';
        chip.textContent = (cfg.label || pName).charAt(0).toUpperCase();
        header.appendChild(chip);

        const titles = el('div', 'provider-titles');
        const titleRow = el('div', 'provider-title-row');
        titleRow.appendChild(el('span', 'provider-label', cfg.label || pName));
        if (cfg.free_tier) titleRow.appendChild(el('span', 'badge badge-free', 'Free tier'));
        if (active) titleRow.appendChild(el('span', 'badge badge-key', 'Active ✓'));
        titles.appendChild(titleRow);
        titles.appendChild(el('div', 'provider-sub', cfg.description || ''));
        header.appendChild(titles);

        const link = button('btn btn-small', 'Get key ↗');
        link.addEventListener('click', function () {
          window.open(cfg.signup_url, '_blank');
          toast('Opening ' + (cfg.label || pName) + ' key page…');
        });
        header.appendChild(link);
        group.appendChild(header);

        // Expandable key form (auto-expanded if this provider was passed
        // in ctx, or collapsed if a key is already set).
        const form = el('div', 'key-form' + (ctx.provider === pName || !active ? '' : ' collapsed'));
        const input = el('input', 'key-input');
        input.type = 'password';
        input.placeholder = cfg.env_var;
        input.autocapitalize = 'off';
        input.autocomplete = 'off';
        input.spellcheck = false;

        let extraInput = null;
        if (cfg.extra_env_var) {
          extraInput = el('input', 'key-input');
          extraInput.type = 'text';
          extraInput.placeholder = cfg.extra_env_var + ' (account id)';
          extraInput.autocapitalize = 'off';
          form.appendChild(extraInput);
        }

        const save = button('btn btn-primary', 'Save key');
        const actions = el('div', 'key-actions');
        actions.appendChild(save);

        if (active) {
          const remove = button('btn btn-danger', 'Remove');
          remove.addEventListener('click', function () {
            window.DoomalayAPI.deleteKey(cfg.env_var).then(function () {
              toast((cfg.label || pName) + ' key removed');
              document.dispatchEvent(new CustomEvent('doomalay:keys-changed'));
              window.DoomalayUI.openSheet('keys', ctx);
            }).catch(function (err) {
              toast('Remove failed: ' + (err && err.message || err));
            });
          });
          actions.appendChild(remove);
        }

        form.appendChild(input);
        form.appendChild(actions);
        group.appendChild(form);

        // Tap header → expand/collapse form.
        header.classList.add('tappable');
        header.addEventListener('click', function () {
          form.classList.toggle('collapsed');
        });

        save.addEventListener('click', function () {
          const val = input.value.trim();
          if (!val) { toast('Paste a key first'); input.focus(); return; }
          save.disabled = true;
          save.textContent = 'Saving…';
          window.DoomalayAPI.setKey(cfg.env_var, pName, val,
            extraInput ? extraInput.value.trim() : '').then(function () {
            toast((cfg.label || pName) + ' key saved ✓');
            document.dispatchEvent(new CustomEvent('doomalay:keys-changed'));
            if (ctx.onSaved) ctx.onSaved(pName);
            window.DoomalayUI.openSheet('keys', ctx);
          }).catch(function (err) {
            save.disabled = false;
            save.textContent = 'Save key';
            toast('Save failed: ' + (err && err.message || err));
          });
        });

        body.appendChild(group);
      });

      if (names.length === 0) {
        body.appendChild(el('div', 'sheet-error', 'No providers loaded — is the engine running?'));
      }
    }).catch(function (err) {
      body.innerHTML = '';
      body.appendChild(el('div', 'sheet-error',
        'Could not load providers: ' + (err && err.message || err)));
    });
  });

  // ── Public API ───────────────────────────────────────────────
  window.DoomalayUI = {
    toast: toast,
    showMenu: showMenu,
    hideMenu: hideMenu,
    registerSheet: registerSheet,
    openSheet: openSheet,
    closeSheet: closeSheet,
    isMenuOpen: function () { return openKind === 'menu'; },
    isSheetOpen: function () { return openKind === 'sheet'; },
    el: el,
    button: button
  };
})();
