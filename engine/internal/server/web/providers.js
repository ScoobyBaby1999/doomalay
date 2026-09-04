// providers.js — the cloud provider picker (ported from doomalaysocreate).
//
// Opens as a blur-background overlay with the provider catalog. Two tabs:
//   - Free (default): opencode, privatemodeai, nvidia, openrouter, cloudflare, etc.
//   - Paid (hidden behind a header icon toggle): anthropic, openai, deepseek, etc.
//
// Each provider card: color dot, name, description, key input, ✓/✕ validation.
// On save → POST /api/keys → validates → on success, calls onPick(provider, model).
//
// Exposes: window.ProvidersScreen

(function () {
  'use strict';

  // The free/paid split. Matches the old project's ordering.
  var FREE_ORDER = ['opencode', 'privatemodeai', 'nvidia', 'openrouter', 'cloudflare', 'github-models', 'groq', 'together', 'mistral'];
  var PAID_ORDER = ['anthropic', 'openai', 'deepseek'];

  function open(onPick, opts) {
    opts = opts || {};
    var activeTab = 'free';
    var providers = {};
    var keys = {};
    var validation = {};
    var opened = false;

    // Fetch the provider catalog + current keys, then render.
    Promise.all([
      fetch('/api/models').then(function (r) { return r.json(); }),
      fetch('/api/keys').then(function (r) { return r.json(); })
    ]).then(function (results) {
      providers = (results[0] && results[0].providers) || {};
      keys = results[1] || {};
      render();
    }).catch(function (e) {
      console.error('providers fetch failed', e);
      render();
    });

    function render() {
      var html =
        '<div style="padding:20px">' +
        header() +
        tabs() +
        '<div id="provider-list" style="margin-top:16px;display:flex;flex-direction:column;gap:10px">' +
        providerList() +
        '</div>' +
        '</div>';

      // First render: open the overlay (or replace content if already open).
      // Subsequent renders (after tab switch / key save): just swap innerHTML
      // (no fade needed — the user is already looking at it).
      if (!opened) {
        if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
          window.ConnectOverlay.replaceContent(html, { onClose: opts.onClose });
        } else {
          window.ConnectOverlay.open(html, { onClose: opts.onClose });
        }
        opened = true;
      } else {
        var contentEl = window.ConnectOverlay.getContentEl();
        contentEl.innerHTML = html;
      }
      wireEvents();
    }

    function header() {
      return '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
        '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Cloud Providers</h2>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
        '<button id="prov-tab-toggle" style="background:#1a1a22;border:1px solid #2a2a35;color:#71717a;padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit">' +
        '⬆ Paid</button>' +
        '<button id="prov-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
        '</div>' +
        '</div>';
    }

    function tabs() {
      return '<div style="display:flex;gap:4px;border-bottom:1px solid #1a1a22;padding-bottom:0">' +
        '<button id="tab-free" style="background:transparent;border:none;color:' + (activeTab === 'free' ? '#e0e0e8' : '#71717a') + ';padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;border-bottom:2px solid ' + (activeTab === 'free' ? '#4a4a5e' : 'transparent') + ';font-family:inherit">Free</button>' +
        '<button id="tab-paid" style="background:transparent;border:none;color:' + (activeTab === 'paid' ? '#e0e0e8' : '#71717a') + ';padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;border-bottom:2px solid ' + (activeTab === 'paid' ? '#4a4a5e' : 'transparent') + ';font-family:inherit">Paid</button>' +
        '</div>';
    }

    function providerList() {
      var order = activeTab === 'free' ? FREE_ORDER : PAID_ORDER;
      var cards = '';
      for (var i = 0; i < order.length; i++) {
        var name = order[i];
        var cfg = providers[name];
        if (!cfg) continue; // provider not in catalog
        cards += providerCard(name, cfg);
      }
      // Add any providers not in the order list
      for (var pname in providers) {
        if (order.indexOf(pname) !== -1) continue;
        var isFree = providers[pname].free_tier;
        if ((activeTab === 'free' && isFree) || (activeTab === 'paid' && !isFree)) {
          cards += providerCard(pname, providers[pname]);
        }
      }
      if (!cards) {
        cards = '<div style="text-align:center;color:#71717a;padding:40px 20px">No providers in this tab.</div>';
      }
      return cards;
    }

    function providerCard(name, cfg) {
      var keyInfo = keys[cfg.env_var];
      var isActive = keyInfo && keyInfo.has_key;
      var val = validation[name];
      var valHTML = '';
      if (val && val.checking) valHTML = '<span style="font-size:11px;color:#71717a">⟳ validating…</span>';
      else if (val && val.valid) valHTML = '<span style="font-size:11px;color:#34d399">✓ ' + (val.model_count || 0) + ' models</span>';
      else if (val && val.error) valHTML = '<span style="font-size:11px;color:#f87171">✕ invalid</span>';

      return '<div style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;padding:14px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:' + (cfg.color || '#4a4a5e') + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;flex-shrink:0">' + (cfg.label || name).charAt(0) + '</div>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="font-size:14px;font-weight:600;color:#e0e0e8">' + (cfg.label || name) + '</span>' +
        (cfg.free_tier ? '<span style="font-size:10px;color:#34d399;background:rgba(52,211,153,0.15);padding:2px 6px;border-radius:4px">Free</span>' : '') +
        (isActive ? '<span style="font-size:10px;color:#71717a;background:rgba(113,113,122,0.15);padding:2px 6px;border-radius:4px">Active</span>' : '') +
        valHTML +
        '</div>' +
        '<p style="font-size:11px;color:#71717a;margin:2px 0 0;line-height:1.4">' + (cfg.description || '') + '</p>' +
        '</div>' +
        '</div>' +
        // Key input (only show if not active, or always show for editing)
        '<div style="display:flex;gap:6px">' +
        '<input type="password" placeholder="' + cfg.env_var + '" id="key-' + name + '" style="flex:1;background:#0a0a0e;border:1px solid #2a2a35;color:#e0e0e8;padding:8px 10px;border-radius:6px;font-size:12px;font-family:monospace;outline:none"' +
        (isActive ? ' disabled placeholder="key saved (paste new to replace)"' : '') + '>' +
        '<button data-save="' + name + '" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap">' + (isActive ? 'Update' : 'Save') + '</button>' +
        '</div>' +
        '<a href="' + cfg.signup_url + '" target="_blank" rel="noreferrer" style="font-size:11px;color:#71717a;margin-top:6px;display:inline-block;text-decoration:none">Get API key →</a>' +
        '</div>';
    }

    function wireEvents() {
      var contentEl = window.ConnectOverlay.getContentEl();

      // Close
      contentEl.querySelector('#prov-close').addEventListener('click', window.ConnectOverlay.close);

      // Tab toggle (the "⬆ Paid" button is the hidden paid tab toggle)
      contentEl.querySelector('#prov-tab-toggle').addEventListener('click', function () {
        activeTab = activeTab === 'free' ? 'paid' : 'free';
        render(); // re-render with new tab
      });
      contentEl.querySelector('#tab-free').addEventListener('click', function () { activeTab = 'free'; render(); });
      contentEl.querySelector('#tab-paid').addEventListener('click', function () { activeTab = 'paid'; render(); });

      // Save buttons
      contentEl.querySelectorAll('[data-save]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.dataset.save;
          var cfg = providers[name];
          var input = contentEl.querySelector('#key-' + name);
          var key = input.value.trim();
          if (!key) return;

          // Disable button while saving
          btn.disabled = true;
          btn.textContent = 'Saving…';

          // POST /api/keys
          fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ env_var: cfg.env_var, provider: name, key: key })
          }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            // Validate the key
            validation[name] = { checking: true };
            render();
            return fetch('/api/keys/validate?env_var=' + encodeURIComponent(cfg.env_var));
          }).then(function (r) { return r.json(); }).then(function (data) {
            validation[name] = { valid: data.valid, model_count: data.model_count, error: data.error };
            // Re-fetch keys + models
            return Promise.all([
              fetch('/api/keys').then(function (r) { return r.json(); }),
              fetch('/api/models?refresh=1').then(function (r) { return r.json(); })
            ]);
          }).then(function (results) {
            keys = results[0] || {};
            providers = (results[1] && results[1].providers) || providers;
            render();
            // If valid + onPick provided, call it
            if (validation[name] && validation[name].valid && onPick) {
              // Auto-pick the first model from this provider
              var models = (results[1] && results[1].models) || [];
              var firstModel = null;
              for (var i = 0; i < models.length; i++) {
                if (models[i].provider === name) { firstModel = models[i]; break; }
              }
              if (firstModel) {
                window.ConnectOverlay.close();
                onPick(name, firstModel.id);
              }
            }
          }).catch(function (e) {
            console.error('save key failed', e);
            validation[name] = { valid: false, error: e.message };
            render();
          });
        });
      });
    }
  }

  window.ProvidersScreen = { open: open };
})();
