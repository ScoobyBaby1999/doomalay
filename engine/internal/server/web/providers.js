// providers.js — the cloud provider picker (ported from doomalaysocreate).
//
// Opens as a blur-background overlay with the provider catalog. A smooth
// iPhone-style Free ⇄ Paid slider replaces the old tabs + "⬆ Paid" button:
// tap or drag the thumb, it slides and recolors (green = free, gold = paid).
//
// Each provider card: color dot, name, description, key input, ✓/✕/~
// validation, and a GOLD "Get API key ↗" link that opens the in-app
// redirect browser (redirect.js) straight on the provider's API-key page —
// sign in there if needed and land right back on the key screen.
//
// Validation (v0.12): the server now reports "valid" / "invalid" /
// "unverified" and only calls a key invalid when the provider itself
// rejected it. Cards show the reason when we couldn't verify.
//
// Also registers the "Cloud" settings page (Settings → Cloud → Connect
// Cloud Providers) so keys can be managed outside a chat.
//
// Exposes: window.ProvidersScreen

(function () {
  'use strict';

  // The free/paid split. Curated 2026-09 from live testing (descriptions,
  // base URLs and key-page deep links are in engine's providers.json).
  var FREE_ORDER = ['opencode', 'privatemodeai', 'nvidia', 'openrouter', 'cloudflare', 'groq', 'together', 'mistral'];
  var PAID_ORDER = ['anthropic', 'openai', 'deepseek'];

  var GOLD = '#E8B44A';
  var EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

  function open(onPick, opts) {
    opts = opts || {};
    var activeTab = 'free';
    var providers = {};
    var catalogModels = [];   // models from the last /api/models fetch
    var keys = {};
    var validation = {};
    var opened = false;

    // Fetch the provider catalog + current keys, then render.
    Promise.all([
      fetch('/api/models').then(function (r) { return r.json(); }),
      fetch('/api/keys').then(function (r) { return r.json(); })
    ]).then(function (results) {
      providers = (results[0] && results[0].providers) || {};
      catalogModels = (results[0] && results[0].models) || [];
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
        slider() +
        '<div id="provider-list" style="margin-top:18px;display:flex;flex-direction:column;gap:10px">' +
        providerList() +
        '</div>' +
        '</div>';

      // First render: open the overlay (or replace content if already open).
      // Subsequent renders (after slider flip / key save): just swap
      // innerHTML (no fade — the user is already looking at it).
      //
      // onSwap: wireEvents must run AFTER the DOM swap. replaceContent()
      // defers the swap by 150ms (fade-out) — wiring synchronously here
      // attached listeners to the OLD content (v0.10.1 dead-buttons bug).
      if (!opened) {
        if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
          window.ConnectOverlay.replaceContent(html, {
            onClose: opts.onClose,
            onSwap: wireEvents
          });
        } else {
          window.ConnectOverlay.open(html, {
            onClose: opts.onClose,
            onSwap: wireEvents
          });
        }
        opened = true;
      } else {
        var contentEl = window.ConnectOverlay.getContentEl();
        contentEl.innerHTML = html;
        wireEvents();
      }
    }

    function header() {
      return '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
        '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Cloud Providers</h2>' +
        '<button id="prov-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
        '</div>';
    }

    // ── The Free ⇄ Paid slider (iPhone segmented feel) ────────────
    // Tap anywhere to flip, or drag the thumb — it slides smoothly and
    // the colors crossfade: emerald for Free, gold for Paid.
    function slider() {
      var isFree = activeTab === 'free';
      var thumbLeft = isFree ? '3px' : 'calc(50% + 1px)';
      var thumbBg = isFree ? 'rgba(52,211,153,0.16)' : 'rgba(232,180,74,0.16)';
      var thumbBorder = isFree ? 'rgba(52,211,153,0.45)' : 'rgba(232,180,74,0.5)';
      var freeColor = isFree ? '#34d399' : '#71717a';
      var paidColor = isFree ? '#71717a' : GOLD;
      return '<div id="fp-slider" style="position:relative;height:38px;border-radius:19px;background:#14141a;border:1px solid #1a1a22;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:pan-y">' +
        '<div id="fp-thumb" style="position:absolute;top:3px;left:' + thumbLeft + ';width:calc(50% - 4px);height:calc(100% - 8px);border-radius:16px;background:' + thumbBg + ';border:1px solid ' + thumbBorder + ';box-shadow:0 2px 8px rgba(0,0,0,0.35);transition:left 0.3s ' + EASE + ',background 0.3s ease,border-color 0.3s ease"></div>' +
        '<span id="fp-label-free" style="position:absolute;left:0;width:50%;height:100%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:' + freeColor + ';transition:color 0.3s ease;pointer-events:none">Free</span>' +
        '<span id="fp-label-paid" style="position:absolute;right:0;width:50%;height:100%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:' + paidColor + ';transition:color 0.3s ease;pointer-events:none">Paid</span>' +
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
      if (val && val.checking) {
        valHTML = '<span style="font-size:11px;color:#71717a">⟳ validating…</span>';
      } else if (val && val.state === 'valid') {
        valHTML = '<span style="font-size:11px;color:#34d399">✓ ' + (val.model_count ? val.model_count + ' models' : 'key works') + '</span>';
      } else if (val && val.state === 'invalid') {
        valHTML = '<span style="font-size:11px;color:#f87171" title="' + escAttr(val.reason || '') + '">✕ invalid' + (val.reason ? ' — ' + short(val.reason) : '') + '</span>';
      } else if (val && val.state === 'unverified') {
        valHTML = '<span style="font-size:11px;color:#E8B44A" title="' + escAttr(val.reason || '') + '">◦ saved · unverified' + (val.reason ? ' (' + short(val.reason) + ')' : '') + '</span>';
      }
      // Cloudflare also needs an Account ID (stored as its own vault entry).
      var needAccount = !!cfg.extra_env_var;

      // Returning-user shortcut: key already saved + models synced → a
      // one-tap "Use" button so they don't have to re-paste the key.
      var provModels = [];
      for (var m = 0; m < catalogModels.length; m++) {
        if (catalogModels[m].provider === name) provModels.push(catalogModels[m]);
      }
      var useHTML = (isActive && onPick && provModels.length)
        ? '<button data-use="' + name + '" style="margin-top:8px;width:100%;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.4);color:#34d399;padding:9px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Use ' + provModels.length + ' models →</button>'
        : '';

      return '<div style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;padding:14px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:' + (cfg.color || '#4a4a5e') + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;flex-shrink:0">' + (cfg.label || name).charAt(0) + '</div>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span style="font-size:14px;font-weight:600;color:#e0e0e8">' + (cfg.label || name) + '</span>' +
        (cfg.free_tier ? '<span style="font-size:10px;color:#34d399;background:rgba(52,211,153,0.15);padding:2px 6px;border-radius:4px">Free</span>' : '<span style="font-size:10px;color:' + GOLD + ';background:rgba(232,180,74,0.12);padding:2px 6px;border-radius:4px">Paid</span>') +
        (isActive ? '<span style="font-size:10px;color:#71717a;background:rgba(113,113,122,0.15);padding:2px 6px;border-radius:4px">Active</span>' : '') +
        valHTML +
        '</div>' +
        '<p style="font-size:11px;color:#71717a;margin:2px 0 0;line-height:1.4">' + (cfg.description || '') + '</p>' +
        '</div>' +
        '</div>' +
        // Key input (disabled once a key is saved — paste new to replace)
        '<div style="display:flex;gap:6px">' +
        '<input type="password" ' + (isActive ? 'disabled ' : '') + 'placeholder="' + (isActive ? 'key saved (paste new to replace)' : cfg.env_var) + '" id="key-' + name + '" style="flex:1;background:#0a0a0e;border:1px solid #2a2a35;color:#e0e0e8;padding:8px 10px;border-radius:6px;font-size:12px;font-family:monospace;outline:none;min-width:0">' +
        '<button data-save="' + name + '" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">' + (isActive ? 'Update' : 'Save') + '</button>' +
        '</div>' +
        (needAccount
          ? '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<input type="text" placeholder="' + (cfg.extra_env_var || 'Account ID') + ' (required)" id="acct-' + name + '" style="flex:1;background:#0a0a0e;border:1px solid #2a2a35;color:#e0e0e8;padding:8px 10px;border-radius:6px;font-size:12px;font-family:monospace;outline:none;min-width:0">' +
            '<span style="font-size:10px;color:#71717a;align-self:center;flex-shrink:0">' + (keys[cfg.extra_env_var] && keys[cfg.extra_env_var].has_key ? '✓ saved' : '') + '</span>' +
            '</div>'
          : '') +
        useHTML +
        // Gold "Get API key" link → in-app redirect browser
        '<a href="' + cfg.signup_url + '" data-getkey="' + name + '" target="_blank" rel="noreferrer" style="font-size:12px;font-weight:600;color:' + GOLD + ';margin-top:8px;display:inline-flex;align-items:center;gap:4px;text-decoration:none;cursor:pointer;touch-action:manipulation">Get API key <span style="font-size:13px">↗</span></a>' +
        '</div>';
    }

    function wireEvents() {
      var contentEl = window.ConnectOverlay.getContentEl();

      // Close
      contentEl.querySelector('#prov-close').addEventListener('click', window.ConnectOverlay.close);

      wireSlider(contentEl);

      // Save buttons
      contentEl.querySelectorAll('[data-save]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.dataset.save;
          saveKey(name, btn);
        });
      });

      // "Use N models →" — returning users with an active key pick a
      // model without re-pasting anything.
      contentEl.querySelectorAll('[data-use]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.dataset.use;
          var firstModel = null;
          for (var i = 0; i < catalogModels.length; i++) {
            if (catalogModels[i].provider === name) { firstModel = catalogModels[i]; break; }
          }
          if (firstModel) {
            window.ConnectOverlay.close();
            onPick(name, firstModel.id);
          }
        });
      });

      // Gold "Get API key" links → open the in-app redirect browser.
      contentEl.querySelectorAll('[data-getkey]').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var name = link.dataset.getkey;
          var cfg = providers[name];
          if (cfg && cfg.signup_url && window.RedirectPanel) {
            window.RedirectPanel.open(cfg.signup_url);
          } else if (cfg && cfg.signup_url) {
            window.open(cfg.signup_url, '_blank', 'noopener');
          }
        });
      });
    }

    // ── Slider wiring: tap flips, drag slides ──────────────────────
    function wireSlider(contentEl) {
      var sliderEl = contentEl.querySelector('#fp-slider');
      if (!sliderEl) return;
      var thumb = sliderEl.querySelector('#fp-thumb');
      var labelFree = sliderEl.querySelector('#fp-label-free');
      var labelPaid = sliderEl.querySelector('#fp-label-paid');
      var dragging = false;
      var startX = 0;
      var startLeft = 0;
      var halfWidth = 0;

      function setSide(side, animate) {
        var isFree = side === 'free';
        if (activeTab === side) return;
        activeTab = side;
        if (!animate) thumb.style.transition = 'none';
        else thumb.style.transition = 'left 0.3s ' + EASE + ',background 0.3s ease,border-color 0.3s ease';
        thumb.style.left = isFree ? '3px' : 'calc(50% + 1px)';
        thumb.style.background = isFree ? 'rgba(52,211,153,0.16)' : 'rgba(232,180,74,0.16)';
        thumb.style.borderColor = isFree ? 'rgba(52,211,153,0.45)' : 'rgba(232,180,74,0.5)';
        labelFree.style.color = isFree ? '#34d399' : '#71717a';
        labelPaid.style.color = isFree ? '#71717a' : GOLD;
        // Re-render the list after the thumb settles.
        setTimeout(render, 180);
      }

      function sideForX(x) {
        var rect = sliderEl.getBoundingClientRect();
        return (x - rect.left) < rect.width / 2 ? 'free' : 'paid';
      }

      sliderEl.addEventListener('pointerdown', function (e) {
        dragging = true;
        startX = e.clientX;
        halfWidth = sliderEl.getBoundingClientRect().width / 2;
        startLeft = thumb.getBoundingClientRect().left - sliderEl.getBoundingClientRect().left;
        thumb.style.transition = 'none';
        sliderEl.setPointerCapture && sliderEl.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      sliderEl.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX;
        var min = 3, max = halfWidth + 4; // 3px … ~50%+1
        var left = Math.max(min, Math.min(max, startLeft + dx));
        thumb.style.left = left + 'px';
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        var side = (e && e.clientX !== undefined) ? sideForX(e.clientX) : activeTab;
        setSide(side, true);
      }
      sliderEl.addEventListener('pointerup', endDrag);
      sliderEl.addEventListener('pointercancel', endDrag);
      // Keyboard / click fallback (tap without drag fires click).
      sliderEl.addEventListener('click', function (e) {
        if (dragging) return;
        setSide(sideForX(e.clientX), true);
      });
      // Prevent double-flip: pointerup handled the drag case; click fires
      // after pointerup — only act if the pointer didn't move (a tap).
    }

    // ── Save a key: POST, validate, refresh, auto-pick ─────────────
    function saveKey(name, btn) {
      var cfg = providers[name];
      var input = window.ConnectOverlay.getContentEl().querySelector('#key-' + name);
      var acctInput = window.ConnectOverlay.getContentEl().querySelector('#acct-' + name);
      var key = input ? input.value.trim() : '';
      if (!key) return;

      btn.disabled = true;
      btn.textContent = 'Saving…';

      var steps = [];
      // Cloudflare: store the Account ID as its own vault entry first.
      if (cfg && cfg.extra_env_var && acctInput && acctInput.value.trim()) {
        steps.push(fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env_var: cfg.extra_env_var, provider: name, key: acctInput.value.trim() })
        }));
      }
      steps.push(fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_var: cfg.env_var, provider: name, key: key })
      }));

      Promise.all(steps.map(function (p) {
        return p.then(function (r) {
          if (!r.ok) {
            // Surface the server's reason (e.g. allowlist rejection),
            // not just the status code.
            return r.text().then(function (body) {
              var msg = '';
              try { msg = JSON.parse(body).error || body; } catch (e) { msg = body; }
              throw new Error('HTTP ' + r.status + (msg ? ': ' + msg : ''));
            });
          }
          return r;
        });
      })).then(function () {
        validation[name] = { checking: true };
        render();
        return fetch('/api/keys/validate?env_var=' + encodeURIComponent(cfg.env_var))
          .then(function (r) { return r.json(); });
      }).then(function (data) {
        validation[name] = {
          state: data.state || (data.valid ? 'valid' : 'invalid'),
          model_count: data.model_count,
          reason: data.reason
        };
        // Re-fetch keys + models
        return Promise.all([
          fetch('/api/keys').then(function (r) { return r.json(); }),
          fetch('/api/models?refresh=1').then(function (r) { return r.json(); })
        ]);
      }).then(function (results) {
        keys = results[0] || {};
        providers = (results[1] && results[1].providers) || providers;
        catalogModels = (results[1] && results[1].models) || catalogModels;
        render();
        // If valid + onPick provided, call it with the first model
        if (validation[name] && validation[name].state === 'valid' && onPick) {
          var models = (results[1] && results[1].models) || [];
          var firstModel = null;
          for (var i = 0; i < models.length; i++) {
            if (models[i].provider === name) { firstModel = models[i]; break; }
          }
          if (firstModel) {
            window.ConnectOverlay.close();
            onPick(name, firstModel.id);
          } else if (validation[name].model_count === 0 && (validation[name].reason || '').length > 0) {
            // Provider verified the key but sync returned no models —
            // still proceed with a chat-usable default if onPick exists.
            // (Some providers gate /models behind extra scopes.)
          }
        }
      }).catch(function (e) {
        console.error('save key failed', e);
        validation[name] = { state: 'unverified', reason: e.message };
        render();
      });
    }
  }

  // ── helpers ─────────────────────────────────────────────────────
  function short(s) {
    s = String(s || '');
    return s.length > 48 ? s.slice(0, 48) + '…' : s;
  }
  function escAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // ── Settings page: Cloud ────────────────────────────────────────
  // Registered with the Settings system so the user can connect cloud
  // providers from Settings → Cloud without opening a chat first.
  if (window.Settings) {
    window.Settings.registerPage('cloud', {
      title: 'Cloud',
      icon: '☁️',
      render: function (getState, setState) {
        // Async status fill-in (the div exists by the time this resolves).
        setTimeout(function () {
          fetch('/api/keys').then(function (r) { return r.json(); }).then(function (keys) {
            var el = document.getElementById('cloud-prov-status');
            if (!el) return;
            var names = [];
            for (var env in keys) {
              if (keys[env] && keys[env].has_key && !env.endsWith('_EXTRA')) {
                names.push(keys[env].provider || env);
              }
            }
            el.innerHTML = names.length
              ? '<span style="color:#34d399">✓ ' + names.length + ' connected: ' + names.join(', ') + '</span>'
              : '<span style="color:#71717a">No cloud providers connected yet.</span>';
          }).catch(function () {});
        }, 0);
        return '<div class="settings-section expanded">' +
          '<h3 data-section-toggle><span>Cloud Providers</span><span class="chevron">▶</span></h3>' +
          '<div class="section-body">' +
          '<p class="hint" style="margin:0 0 12px">Connect a cloud provider with an API key to chat with models like Kimi, Llama, Claude and GPT. Keys are stored encrypted on this device only.</p>' +
          '<div id="cloud-prov-status" style="font-size:12px;margin:0 0 12px"><span style="color:#71717a">Checking…</span></div>' +
          '<button data-action="connect-cloud" style="background:' + GOLD + ';border:none;color:#0a0a0b;padding:12px 16px;border-radius:10px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;width:100%">Connect Cloud Providers</button>' +
          '</div>' +
          '</div>';
      }
    });
  }

  window.ProvidersScreen = { open: open };
})();
