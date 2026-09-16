// providers.js — the cloud provider picker (ported from doomalaysocreate).
//
// Opens as a blur-background overlay with the provider catalog. A smooth
// iPhone-style Free ⇄ Paid slider replaces the old tabs + "⬆ Paid" button:
// tap or drag the thumb, it slides and recolors (green = free, gold = paid).
//
// Each provider card: color dot, name, description, key input, ✓/✕/~
// validation, and a GOLD "Get API key ↗" link.
//
// v0.14 (user spec #2): the in-app iframe embedding is GONE — it was the
// source of the ERR_BLOCKED_BY_RESPONSE white screens and the broken
// back-gesture behavior (iframes added entries to the WebView back list;
// the back gesture navigated the WebView instead of returning to the app).
// "Get API key ↗" now opens the REAL browser immediately (Chrome via
// MainActivity's external-URL routing) and the provider card shows a
// waiting hint: copy the key in the browser, come back, paste. The app
// screen never navigates, so returning (back gesture / recents) lands
// exactly where the user left off.
//
// Validation (v0.12): the server reports "valid" / "invalid" /
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

  var GOLD = 'var(--warn)';
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
    // v0.20: the engine now NEVER blocks /api/models on the network —
    // cold boots return the STATIC provider cards instantly
    // (partial:true) while the live model sync runs in the background.
    // We render immediately and poll until the full lists land, so
    // "connect cloud provider" is instant and never empty.
    var modelsP = fetch('/api/models')
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; });
    var keysP = fetch('/api/keys')
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; });
    var gotLive = false;
    var isPartial = false;
    Promise.all([withTimeout(modelsP, 4000, null), keysP]).then(function (results) {
      gotLive = results[0] !== null;
      providers = (results[0] && results[0].providers) || {};
      catalogModels = (results[0] && results[0].models) || [];
      isPartial = !!(results[0] && results[0].partial);
      keys = results[1] || {};
      render();
      if (isPartial) pollUntilComplete();
      // v0.13: returning users — quietly re-validate saved keys so the
      // Active badges are fresh (stale validations from a past session
      // no longer linger as yellow "unverified").
      backgroundRevalidate();
    }).catch(function (e) {
      console.error('providers fetch failed', e);
      render();
    });
    // Late catalog (only possible when the 4s cap fired — belt and
    // suspenders) — fill the cards in.
    modelsP.then(function (d) {
      if (!d || !d.models || gotLive) return;
      providers = d.providers || providers;
      catalogModels = d.models || catalogModels;
      if (opened) render();
    }).catch(function () {});

    // v0.20: partial (static) catalog — the background sync is running.
    // Re-fetch every 2s (each hit is an instant cache read once the sync
    // lands) and re-render until the catalog is complete.
    function pollUntilComplete() {
      var tries = 0;
      (function next() {
        tries++;
        fetch('/api/models')
          .then(function (r) { return r.json(); })
          .catch(function () { return null; })
          .then(function (d) {
            if (!d || !opened) return;
            providers = d.providers || providers;
            catalogModels = d.models || catalogModels;
            if (d.partial && tries < 8) {
              render();
              setTimeout(next, 2000);
            } else {
              isPartial = false;
              render();
            }
          });
      })();
    }

    // Re-validate every saved key (once per open, best-effort, staggered
    // so we don't hammer providers that rate-limit validation calls).
    var revalidated = false;
    function backgroundRevalidate() {
      if (revalidated) return;
      revalidated = true;
      var envVars = [];
      for (var env in keys) {
        if (keys[env] && keys[env].has_key && !env.endsWith('_EXTRA')) envVars.push(env);
      }
      var i = 0;
      function next() {
        if (i >= envVars.length) return;
        var env = envVars[i++];
        // find provider name for the badge
        var pname = (keys[env] && keys[env].provider) || '';
        fetch('/api/keys/validate?env_var=' + encodeURIComponent(env))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.state) {
              validation[pname] = { state: d.state, model_count: d.model_count, reason: d.reason };
              render();
            }
          })
          .catch(function () {})
          .then(function () { setTimeout(next, 400); });
      }
      setTimeout(next, 300);
    }

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
      var reminder = '';
      if (opts.reminder) {
        // v0.17 one-press connect reminder mode: the chat is ALREADY
        // unlocked behind this overlay — this GUI is just a nudge that
        // more providers can be connected. ✕ or scrim tap dismisses.
        reminder = '<div style="background:rgba(var(--ok-rgb),0.08);border:1px solid rgba(var(--ok-rgb),0.3);' +
          'border-radius:10px;padding:9px 12px;margin-bottom:12px;font-size: var(--ui-small-fs);color:var(--ok);line-height:1.5">' +
          '✓ chat is ready — you can tap ✕ and start talking right now. ' +
          '<span style="color:var(--text-3)">This screen is just a reminder you can connect more providers.</span></div>';
      }
      // v0.20: the model lists are still syncing in the background —
      // cards are live, model counts arrive in seconds.
      if (isPartial) {
        reminder += '<div style="background:rgba(var(--accent-rgb),0.08);border:1px solid rgba(var(--accent-rgb),0.3);' +
          'border-radius:10px;padding:9px 12px;margin-bottom:12px;font-size: var(--ui-small-fs);color:var(--accent);line-height:1.5">' +
          '⟳ syncing live model lists — provider cards are ready now, models fill in within seconds.</div>';
      }
      return reminder + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
        '<h2 style="font-size: calc(var(--ui-fs) + 4px);font-weight:600;color:var(--text-1);margin:0">Cloud Providers</h2>' +
        '<button id="prov-close" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
        '</div>';
    }

    // ── The Free ⇄ Paid slider (iPhone segmented feel) ────────────
    // Tap anywhere to flip, or drag the thumb — it slides smoothly and
    // the colors crossfade: emerald for Free, gold for Paid.
    function slider() {
      var isFree = activeTab === 'free';
      var thumbLeft = isFree ? '3px' : 'calc(50% + 1px)';
      var thumbBg = isFree ? 'rgba(var(--ok-rgb),0.16)' : 'rgba(var(--warn-rgb),0.16)';
      var thumbBorder = isFree ? 'rgba(var(--ok-rgb),0.45)' : 'rgba(var(--warn-rgb),0.5)';
      var freeColor = isFree ? 'var(--ok)' : 'var(--text-3)';
      var paidColor = isFree ? 'var(--text-3)' : GOLD;
      return '<div id="fp-slider" style="position:relative;height:38px;border-radius:19px;background:var(--surface-1);border:1px solid var(--surface-2);cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:pan-y">' +
        '<div id="fp-thumb" style="position:absolute;top:3px;left:' + thumbLeft + ';width:calc(50% - 4px);height:calc(100% - 8px);border-radius:16px;background:' + thumbBg + ';border:1px solid ' + thumbBorder + ';box-shadow:0 2px 8px rgba(0,0,0,0.35);transition:left 0.3s ' + EASE + ',background 0.3s ease,border-color 0.3s ease"></div>' +
        '<span id="fp-label-free" style="position:absolute;left:0;width:50%;height:100%;display:flex;align-items:center;justify-content:center;font-size: calc(var(--ui-fs) - 1px);font-weight:600;color:' + freeColor + ';transition:color 0.3s ease;pointer-events:none">Free</span>' +
        '<span id="fp-label-paid" style="position:absolute;right:0;width:50%;height:100%;display:flex;align-items:center;justify-content:center;font-size: calc(var(--ui-fs) - 1px);font-weight:600;color:' + paidColor + ';transition:color 0.3s ease;pointer-events:none">Paid</span>' +
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
        cards = '<div style="text-align:center;color:var(--text-3);padding:40px 20px">No providers in this tab.</div>';
      }
      return cards;
    }

    function providerCard(name, cfg) {
      var keyInfo = keys[cfg.env_var];
      var isActive = keyInfo && keyInfo.has_key;
      var val = validation[name];
      // v0.14: friendly text for network-flavored reasons — the raw Go
      // error ("network: post https://… : dial tcp …") is too noisy.
      var badgeReason = String((val && val.reason) || '').replace(/^network:\s*/i, '');
      if (/^(post |fetch |dial |lookup |timeout)/i.test(badgeReason)) badgeReason = 'provider unreachable — will retry';
      else badgeReason = short(badgeReason);
      var valHTML = '';
      if (val && val.checking) {
        // v0.24: bright theme accent (was grey var(--text-3) — unreadable against
        // the dark card; user asked for a color from the selected theme).
        valHTML = '<span class="dd-validating" style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--accent-2,var(--accent-2))">⟳ validating…</span>';
      } else if (val && val.state === 'valid') {
        valHTML = '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--ok)">✓ ' + (val.model_count ? val.model_count + ' models' : 'key works') + '</span>';
      } else if (val && val.state === 'invalid') {
        valHTML = '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--err)" title="' + escAttr(val.reason || '') + '">✕ invalid' + (val.reason ? ' — ' + short(val.reason) : '') + '</span>';
      } else if (val && val.state === 'unverified') {
        valHTML = '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--warn)" title="' + escAttr(val.reason || '') + '">◦ saved · unverified' + (badgeReason ? ' (' + badgeReason + ')' : '') + '</span>';
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
        ? '<button data-use="' + name + '" style="margin-top:8px;width:100%;background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.4);color:var(--ok);padding:9px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Use ' + provModels.length + ' models →</button>'
        : '';

      // v0.13 MODULAR ACTIVE INDICATOR: the card gets the shared dd-active
      // ring (tinted with the provider's own color) + a green check-dot
      // next to the name. One mechanism (uiactive.js), used everywhere.
      var activeClass = isActive ? ' dd-active' : '';
      var activeStyle = isActive ? ' --dd-accent:' + (cfg.color || 'var(--ok)') + ';' : '';
      var activeDot = isActive ? window.UIActive.dotHTML() : '';

      return '<div style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:12px;padding:14px;transition:border-color 0.2s, box-shadow 0.25s' + activeStyle + '" class="prov-card' + activeClass + '" data-prov="' + name + '">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:' + (cfg.color || 'var(--border-strong)') + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size: var(--ui-small-fs);flex-shrink:0">' + (cfg.label || name).charAt(0) + '</div>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span style="font-size: var(--ui-fs);font-weight:600;color:var(--text-1)">' + (cfg.label || name) + '</span>' +
        activeDot +
        (cfg.free_tier ? '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--ok);background:rgba(var(--ok-rgb),0.15);padding:2px 6px;border-radius:4px">Free</span>' : '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:' + GOLD + ';background:rgba(var(--warn-rgb),0.12);padding:2px 6px;border-radius:4px">Paid</span>') +
        (isActive ? '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--ok);background:rgba(var(--ok-rgb),0.15);padding:2px 6px;border-radius:4px;border:1px solid rgba(var(--ok-rgb),0.3)">Active</span>' : '') +
        valHTML +
        '</div>' +
        '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:2px 0 0;line-height:1.4">' + (cfg.description || '') + '</p>' +
        '</div>' +
        '</div>' +
        // Key input (disabled once a key is saved — paste new to replace)
        '<div style="display:flex;gap:6px">' +
        '<input type="password" placeholder="' + (isActive ? 'key saved (paste new to replace)' : cfg.env_var) + '" id="key-' + name + '" style="flex:1;background:var(--bg-app);border:1px solid var(--border);color:var(--text-1);padding:8px 10px;border-radius:6px;font-size:12px;font-family:monospace;outline:none;min-width:0">' +
        '<button data-save="' + name + '" style="background:var(--border-strong);border:none;color:var(--text-1);padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">' + (isActive ? 'Update' : 'Save') + '</button>' +
        '</div>' +
        (needAccount
          ? '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<input type="text" placeholder="' + (cfg.extra_env_var || 'Account ID') + ' (required)" id="acct-' + name + '" style="flex:1;background:var(--bg-app);border:1px solid var(--border);color:var(--text-1);padding:8px 10px;border-radius:6px;font-size:12px;font-family:monospace;outline:none;min-width:0">' +
            '<span style="font-size: calc(var(--ui-small-fs) - 2px);color:var(--text-3);align-self:center;flex-shrink:0">' + (keys[cfg.extra_env_var] && keys[cfg.extra_env_var].has_key ? '✓ saved' : '') + '</span>' +
            '</div>'
          : '') +
        useHTML +
        // Gold "Get API key" link → opens the REAL browser (v0.14: no more
        // in-app embedding). A waiting hint appears on the card — the user
        // copies the key in the browser and pastes it right here.
        '<a href="' + cfg.signup_url + '" data-getkey="' + name + '" target="_blank" rel="noreferrer" style="font-size: var(--ui-small-fs);font-weight:600;color:' + GOLD + ';margin-top:8px;display:inline-flex;align-items:center;gap:4px;text-decoration:none;cursor:pointer;touch-action:manipulation">Get API key <span style="font-size: calc(var(--ui-fs) - 1px)">↗</span></a>' +
        '<div id="getkey-hint-' + name + '" style="display:none;margin-top:8px;font-size: calc(var(--ui-small-fs) - 1px);color:' + GOLD + ';background:rgba(var(--warn-rgb),0.08);border:1px solid rgba(var(--warn-rgb),0.22);border-radius:8px;padding:8px 10px;line-height:1.5">↗ Opened <b>' + escHTMLInline(hostOf(cfg.signup_url)) + '</b> in your browser. Copy your API key there, come back, and paste it above.</div>' +
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
          // v0.16: use the smart auto-pick (known-good working models for
          // NVIDIA, free + popular families everywhere else) — NOT the
          // alphabetically-first model (claude-fable-5, 01-ai/yi-large…).
          var grouped = {};
          for (var i = 0; i < catalogModels.length; i++) {
            var cm = catalogModels[i];
            if (cm.provider === name) {
              (grouped[cm.provider] = grouped[cm.provider] || []).push(cm);
            }
          }
          var groups = [];
          for (var pn in grouped) groups.push({ name: pn, models: grouped[pn] });
          var pick = pickAutoModel({ groups: groups }, name);
          var pickId = pick || null;
          if (!pickId) {
            for (var j = 0; j < catalogModels.length; j++) {
              if (catalogModels[j].provider === name) { pickId = catalogModels[j].id; break; }
            }
          }
          if (pickId) {
            window.ConnectOverlay.close();
            onPick(name, pickId);
          }
        });
      });

      // Gold "Get API key" links (v0.14): open the REAL browser immediately
      // and reveal the waiting hint. No embedding — the app screen stays
      // put, so the back gesture returns here exactly as left.
      contentEl.querySelectorAll('[data-getkey]').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var name = link.dataset.getkey;
          var cfg = providers[name];
          if (cfg && cfg.signup_url) {
            openInSystemBrowser(cfg.signup_url);
            var hint = contentEl.querySelector('#getkey-hint-' + name);
            if (hint) hint.style.display = 'block';
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
        thumb.style.background = isFree ? 'rgba(var(--ok-rgb),0.16)' : 'rgba(var(--warn-rgb),0.16)';
        thumb.style.borderColor = isFree ? 'rgba(var(--ok-rgb),0.45)' : 'rgba(var(--warn-rgb),0.5)';
        labelFree.style.color = isFree ? 'var(--ok)' : 'var(--text-3)';
        labelPaid.style.color = isFree ? 'var(--text-3)' : GOLD;
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
        // v0.13 FIX: auto-pick whenever the key is NOT explicitly invalid
        // and the provider has models — "unverified" (engine couldn't reach
        // the validator, or the provider's models endpoint glitched) must
        // NOT dead-end the workflow anymore. v0.12 required state === 'valid',
        // which is why "+ model doesn't update / chatbot doesn't appear".
        // v0.15: prefer a FREE model for the auto-pick — models[0] is
        // alphabetical junk (claude-fable-5, 01-ai/yi-large) and often a
        // PAID model, which 401s/free-tier-exhausts on fresh accounts.
        var v = validation[name];
        var notInvalid = !v || v.state !== 'invalid';
        if (notInvalid && onPick) {
          var pick = pickAutoModel(results[1], name);
          if (pick) {
            // v0.17: NO auto-close — the user spec says the provider GUI
            // stays open after key validation; only the ✕ or a scrim tap
            // closes it. The model IS applied (chat unlocks behind the
            // overlay) so dismissing it lands on a ready chat.
            onPick(name, pick);
            flashSavedHint(name, '✓ connected — tap ✕ to start chatting');
          } else {
            // Key saved but 0 models synced — force a refresh and retry once.
            fetch('/api/models?refresh=1').then(function (r) { return r.json(); }).then(function (d2) {
              var pick2 = pickAutoModel(d2, name);
              if (pick2) {
                onPick(name, pick2);
                flashSavedHint(name, '✓ connected — tap ✕ to start chatting');
              } else {
                // Models endpoint down but key accepted — pick the chat-probe
                // model from the catalog config as a usable default.
                var cfg2 = (d2 && d2.providers && d2.providers[name]) || null;
                if (cfg2 && cfg2.probe_model) {
                  onPick(name, name + '/' + cfg2.probe_model);
                  flashSavedHint(name, '✓ connected — tap ✕ to start chatting');
                }
              }
            }).catch(function () {});
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
  function escHTMLInline(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function hostOf(u) {
    try { return new URL(u).hostname; } catch (e) { return u; }
  }
  // Open a URL in the system browser. On Android the WebView's
  // shouldOverrideUrlLoading hands external URLs to Chrome — a synthetic
  // anchor click (target=_blank) triggers exactly that path. The WebView
  // itself never navigates, so the app returns to THIS screen.
  function openInSystemBrowser(url) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
              ? '<span style="color:var(--ok)">✓ ' + names.length + ' connected: ' + names.join(', ') + '</span>'
              : '<span style="color:var(--text-3)">No cloud providers connected yet.</span>';
          }).catch(function () {});
        }, 0);
        return '<div class="settings-section expanded">' +
          '<h3 data-section-toggle><span>Cloud Providers</span><span class="chevron">▶</span></h3>' +
          '<div class="section-body"><div class="section-inner">' +
          '<p class="hint" style="margin:0 0 12px">Connect a cloud provider with an API key to chat with models like Kimi, Llama, Claude and GPT. Keys are stored encrypted on this device only.</p>' +
          '<div id="cloud-prov-status" style="font-size: var(--ui-small-fs);margin:0 0 12px"><span style="color:var(--text-3)">Checking…</span></div>' +
          '<button data-action="connect-cloud" style="background:' + GOLD + ';border:none;color:var(--bg-app);padding:14px 16px;min-height:48px;border-radius:10px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;width:100%">Connect Cloud Providers</button>' +
          '</div></div>' +
          '</div>';
      }
    });
  }

  // v0.15: best auto-pick model for a provider — a FREE one (works on any
  // account), scored by family popularity so users land on a capable
  // default (Kimi/DeepSeek/Qwen/Llama) instead of "01-ai/yi-large".
  // v0.16: NVIDIA NIM is account-gated per model — ~70% of the catalog
  // 404s for a fresh key while a live-verified set always serves. Those
  // rank ABOVE the popularity score so the auto-pick actually chats.
  function pickAutoModel(catalog, name) {
    if (!catalog) return null;
    var KNOWN_GOOD = {
      nvidia: ['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-super-120b-a12b',
               'z-ai/glm-5.3-flash', 'openai/gpt-oss-20b', 'nvidia/nemotron-3-ultra-550b-a55b',
               'google/gemma-4-31b-it'],
      // v0.25: opencode auto-pick → FREE models only (big-pickle first —
      // paid zen models 400 CreditsError on keys without a payment method).
      opencode: ['big-pickle', 'nemotron-3.5-lightning-free',
                 'deepseek-v4-flash-free', 'mimo-v2.5-free']
    };
    var POPULAR = ['kimi-k', 'deepseek', 'qwen', 'llama', 'nemotron', 'gpt', 'claude', 'gemini', 'mistral'];
    var group = null;
    var groups = catalog.groups || [];
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].name === name) { group = groups[g]; break; }
    }
    var candidates = [];
    if (group && group.models) {
      for (var i = 0; i < group.models.length; i++) {
        var m = group.models[i];
        if (m.isFree) candidates.push(m);
      }
      if (!candidates.length) candidates = group.models.slice();
    }
    if (!candidates.length) {
      // Fall back to the flat v0.12 list.
      var flat = catalog.models || [];
      for (var f = 0; f < flat.length; f++) {
        if (flat[f].provider === name) return flat[f].id;
      }
      return null;
    }
    // v0.16: live-verified working models outrank everything (they are
    // also genuinely popular families).
    var inKnownGood = function (id) {
      var kg = KNOWN_GOOD[name];
      if (!kg) return -1;
      for (var k = 0; k < kg.length; k++) {
        if (id === kg[k] || id === name + '/' + kg[k]) return k;
      }
      return -1;
    };
    var best = null, bestScore = -1;
    for (var c = 0; c < candidates.length; c++) {
      var cm = candidates[c];
      var rawId = String(cm.rawId || cm.id || '').toLowerCase();
      var score = 0;
      var kgIdx = inKnownGood(String(cm.rawId || cm.id || ''));
      if (kgIdx >= 0) score = 1000 - kgIdx;
      for (var p = 0; p < POPULAR.length; p++) {
        if (rawId.indexOf(POPULAR[p]) >= 0) { score += POPULAR.length - p; break; }
      }
      if (cm.isFree) score += 100;
      if (score > bestScore) { bestScore = score; best = cm; }
    }
    return best ? (best.id || (name + '/' + (best.rawId || ''))) : null;
  }

  // ── v0.18: one-press smart connect ─────────────────────────────
  // "pressing connect cloud provider should be a one button press, it
  // should use the cloud provider option and unlock the restriction and
  // start the chat unless the user does not have any cloud providers or
  // API keys." — finds a connected provider (priority: the 3 the app is
  // built around), auto-picks its best model, fires onPick. Returns the
  // number of connected providers so the caller can decide whether to
  // ALSO show the dismissible reminder GUI.
  //
  // v0.18 REDTEAM FIXES (the "nothing happens" / "chatbot doesn't update"
  // reports):
  //   1. KEYS FIRST — /api/keys is a local vault read (instant). The old
  //      Promise.all gated the unlock on /api/models, which on a cold
  //      engine does a LIVE 11-provider sync (up to 15s per provider on
  //      congested mobile data) — one-press felt dead the whole time.
  //   2. The catalog fetch is capped at 2.5s (race-timeout). A late or
  //      failed sync no longer blocks the unlock.
  //   3. Verified FALLBACK model ids — pickAutoModel returning null (empty
  //      sync) used to leave the gatelock stuck while the reminder GUI
  //      claimed "chat is ready". Now a known-good model is always picked.
  var FALLBACK_MODELS = {
    // NOTE: slot convention = 'provider/' + the id the PROVIDER'S API
    // expects. NVIDIA NIM's API ids carry their own org prefix
    // ("nvidia/nemotron-…") — the engine strips exactly one "nvidia/"
    // per turn, so the slot keeps both. (Verified live: bare
    // "nemotron-…" → NIM 404; org-prefixed → 200.)
    nvidia: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
    privatemodeai: 'privatemodeai/kimi-k2.6',
    opencode: 'opencode/kimi-k2.6'
  };

  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, ms); })
    ]);
  }

  function smartConnect(onPick) {
    return fetch('/api/keys').then(function (r) { return r.json(); })
      .catch(function () { return {}; })
      .then(function (keys) {
        keys = keys || {};
        var connected = [];
        for (var env in keys) {
          if (keys[env] && keys[env].has_key && !env.endsWith('_EXTRA')) {
            connected.push(keys[env].provider || env);
          }
        }
        if (!connected.length) return { connected: 0, picked: false };
        var PRIORITY = ['nvidia', 'privatemodeai', 'opencode'];
        var choice = null;
        for (var i = 0; i < PRIORITY.length; i++) {
          if (connected.indexOf(PRIORITY[i]) >= 0) { choice = PRIORITY[i]; break; }
        }
        if (!choice) choice = connected[0];

        var catalogP = fetch('/api/models')
          .then(function (r) { return r.json(); })
          .catch(function () { return null; });
        return withTimeout(catalogP, 2500, null).then(function (catalog) {
          var model = pickAutoModel(catalog, choice);
          if (!model && catalog && catalog.providers && catalog.providers[choice]) {
            var cfg = catalog.providers[choice];
            if (cfg.probe_model) model = choice + '/' + cfg.probe_model;
          }
          if (!model) model = FALLBACK_MODELS[choice] || null;
          if (model && onPick) onPick(choice, model);
          return { connected: connected.length, picked: !!model, provider: choice, model: model };
        });
      });
  }

  function flashSavedHint(providerName, msg) {
    var card = window.ConnectOverlay.getContentEl();
    if (!card) return;
    var el = card.querySelector('#use-btn-' + providerName) ||
             card.querySelector('#save-' + providerName);
    if (el) {
      var old = el.textContent;
      el.textContent = msg;
      el.style.color = 'var(--ok)';
      setTimeout(function () {
        if (el.isConnected) { el.textContent = old; el.style.color = ''; }
      }, 2400);
    }
  }

  window.ProvidersScreen = { open: open, smartConnect: smartConnect, pickAutoModel: pickAutoModel };
})();
