// chatpanel.js — the chat panel UI for a ChatIcon.
//
// v0.13 WORKFLOW (the user-specified flow):
//   1. New chat icon → tap → panel shows [+ Sandbox] [+ Model]
//   2. Pick a sandbox → pick a model (cloud/local)
//   3. If the model needs extra steps (connecting a cloud provider), the
//      overlay chain handles it, then RETURNS here — the picker callback
//      lands, both boxes fill, and the chat REVEALS itself.
//   4. The reveal is a smooth SCROLL: the panel body becomes one scroll
//      container — config strip on top (always scrollable back up), chat
//      below with a sticky input bar. The user can scroll back to the
//      sandbox/provider badges at any time.
//   5. Sandbox + model are CHANGEABLE ANYTIME: the badges in the config
//      strip (and in the chat header) are tappable — they reopen the
//      pickers. (Design call: changeable beats locked-in.)
//   6. Capability toolbar above the input: effort cycle button (only when
//      the model offers effort levels), Web toggle, Deep toggle (mutually
//      exclusive). Flags ride every WS send.
//
// State seeding: the icon's own persisted sandbox/model/provider (localStorage)
// seed the chat state, so a restart keeps the chat configured — the engine
// session is created lazily with the same values.
//
// Exposes: window.ChatPanel

(function () {
  'use strict';

  // Per-chat state registry. Keyed by chat ID.
  var chatStates = {};

  // Pretty labels + icons for sandbox types (the icon in the + Sandbox box
  // now reflects WHICH sandbox — v0.12 always showed ⚡).
  var SANDBOX_LABELS = { quick: 'Quick Chat', hf: 'Hugging Face', device: 'Another Device', terminal: 'Termux' };
  var SANDBOX_ICONS = { quick: '⚡', hf: '🤗', device: '🔗', terminal: '⌨️' };

  // Provider display labels, fetched once from the engine catalog.
  var providerLabels = {};
  var catalogPromise = null;
  function ensureCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch('/api/models').then(function (r) { return r.json(); }).then(function (d) {
      var provs = (d && d.providers) || {};
      for (var name in provs) providerLabels[name] = provs[name].label || name;
      return d;
    }).catch(function () { return {}; });
    return catalogPromise;
  }

  function providerLabel(name) {
    if (!name) return '';
    if (providerLabels[name]) return providerLabels[name];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function modelDetail(modelId) {
    var id = String(modelId || '');
    var slash = id.indexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
  }

  function getOrCreateState(chatId, sessionData, icon) {
    if (!chatStates[chatId]) {
      // Seed from the engine session when present, else from the ICON's own
      // persisted config (localStorage) — v0.12 restarted chats empty because
      // it only read sessionData (null until the first updateSession call).
      chatStates[chatId] = {
        id: chatId,
        sessionId: sessionData && sessionData.ID ? sessionData.ID : null,
        sandbox: (sessionData && (sessionData.Sandbox || sessionData.sandbox)) || (icon && icon.sandbox) || '',
        model: (sessionData && (sessionData.Model || sessionData.model)) || (icon && icon.model) || '',
        provider: (sessionData && (sessionData.Provider || sessionData.provider)) || (icon && icon.provider) || '',
        effort: (sessionData && (sessionData.Effort || sessionData.effort)) || 'med',
        webSearch: !!(sessionData && (sessionData.WebSearch || sessionData.web_search)),
        deepResearch: !!(sessionData && (sessionData.DeepResearch || sessionData.deep_research)),
        messages: [],
        isStreaming: false,
        draftText: '',
        client: null
      };
      if (icon) icon._sessionData = sessionData || null;
    }
    return chatStates[chatId];
  }

  // Render the panel body for a chat. Called by app.js when the panel opens.
  function render(bodyEl, icon, panel) {
    var state = getOrCreateState(icon.id, icon._sessionData, icon);

    if (!state.sandbox || !state.model) {
      renderEmptyState(bodyEl, icon, state, panel);
    } else {
      renderChatUI(bodyEl, icon, state, panel);
    }
  }

  // ── Empty state: 2 boxes ──────────────────────────────────────
  function renderEmptyState(bodyEl, icon, state, panel) {
    // Kick off (or reuse) the catalog fetch — re-render once when labels land.
    ensureCatalog().then(function () {
      if (state.provider && !providerLabels[state.provider] && bodyEl.isConnected) {
        render(bodyEl, icon, panel);
      }
    });

    var sandboxSelected = !!state.sandbox;
    var modelSelected = !!state.model;

    var sandboxTitle = sandboxSelected ? (SANDBOX_LABELS[state.sandbox] || state.sandbox) : '+ Sandbox';
    var sandboxSub = sandboxSelected ? '+ Sandbox' : 'Tap to connect';
    var sandboxIcon = sandboxSelected ? (SANDBOX_ICONS[state.sandbox] || '⚡') : '🔌';

    var modelTitle = modelSelected ? providerLabel(state.provider) : '+ Model';
    var modelSub = modelSelected ? '+ Model' : 'Tap to connect';
    var modelExtra = modelSelected ? '<span style="font-size:10px;color:#4a4a5e;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + modelDetail(state.model) + '</span>' : '';

    var heading = !sandboxSelected && !modelSelected
      ? 'Choose a model and sandbox and go!'
      : (sandboxSelected && !modelSelected ? 'One more thing — pick a model' : 'One more thing — pick a sandbox');
    var intro = !sandboxSelected && !modelSelected
      ? 'Pick a sandbox and a model to start chatting with ' + icon.name + '.'
      : 'Finish connecting to start chatting with ' + icon.name + '.';

    var boxStyle = function (selected) {
      return 'flex:1;background:' + (selected ? '#181820' : '#14141a') + ';border:2px ' + (selected ? 'solid #34344a' : 'dashed #2a2a35') + ';border-radius:16px;padding:24px 16px;text-align:center;cursor:pointer;transition:border-color 0.15s;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px';
    };

    bodyEl.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px">' +
      '<h3 style="font-size:16px;font-weight:600;color:#e0e0e8;margin:0 0 12px">' + heading + '</h3>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 24px;text-align:center">' + intro + '</p>' +
      '<div style="display:flex;gap:16px;width:100%;max-width:400px">' +
        '<div id="box-sandbox" style="' + boxStyle(sandboxSelected) + '">' +
          '<span style="font-size:28px">' + sandboxIcon + '</span>' +
          '<span style="font-size:14px;font-weight:600;color:#e0e0e8">' + sandboxTitle + '</span>' +
          '<span style="font-size:11px;color:' + (sandboxSelected ? '#34d399' : '#71717a') + '">' + sandboxSub + '</span>' +
        '</div>' +
        '<div id="box-model" style="' + boxStyle(modelSelected) + '">' +
          '<span style="font-size:28px">🤖</span>' +
          '<span style="font-size:14px;font-weight:600;color:#e0e0e8">' + modelTitle + '</span>' +
          '<span style="font-size:11px;color:' + (modelSelected ? '#34d399' : '#71717a') + '">' + modelSub + '</span>' +
          modelExtra +
        '</div>' +
      '</div>' +
      '</div>';

    var boxSandbox = bodyEl.querySelector('#box-sandbox');
    var boxModel = bodyEl.querySelector('#box-model');

    boxSandbox.addEventListener('mouseover', function () { this.style.borderColor = '#4a4a5e'; });
    boxSandbox.addEventListener('mouseout', function () { this.style.borderColor = sandboxSelected ? '#34344a' : '#2a2a35'; });
    boxModel.addEventListener('mouseover', function () { this.style.borderColor = '#4a4a5e'; });
    boxModel.addEventListener('mouseout', function () { this.style.borderColor = modelSelected ? '#34344a' : '#2a2a35'; });

    boxSandbox.addEventListener('click', function () {
      window.SandboxPicker.open(function (sandboxType) {
        applySandbox(icon, state, sandboxType, bodyEl, panel);
      });
    });

    boxModel.addEventListener('click', function () {
      openModelPicker(icon, state, bodyEl, panel);
    });
  }

  // Apply a sandbox selection: state + icon + session + re-render.
  function applySandbox(icon, state, sandboxType, bodyEl, panel) {
    state.sandbox = sandboxType;
    if (icon) {
      icon.sandbox = sandboxType;
      if (typeof icon.setSandbox === 'function') icon.setSandbox(sandboxType);
      if (typeof icon.save === 'function') icon.save();
    }
    updateSession(icon, state, { sandbox: sandboxType });
    render(bodyEl, icon, panel);
  }

  // Open the model picker with the unified (provider, modelId) callback —
  // the overlay chain (model picker → providers/local → key paste → auto
  // pick) lands back here and the chat reveals.
  function openModelPicker(icon, state, bodyEl, panel) {
    window.ModelPicker.open(function (provider, modelId) {
      state.model = modelId;
      state.provider = provider;
      if (icon) {
        icon.model = modelId;
        icon.provider = provider;
        if (typeof icon.save === 'function') icon.save();
      }
      updateSession(icon, state, { model: modelId, provider: provider });
      render(bodyEl, icon, panel);
    });
  }

  // ── Chat UI: the scroll-reveal layout ─────────────────────────
  //
  // ONE scroll container (the panel body):
  //   [config strip]  — compact tappable badges (sandbox + model), always
  //                     reachable by scrolling back up
  //   [chat section]  — flowing messages + sticky input bar
  // On fulfillment the panel smooth-scrolls to the chat section; new
  // messages keep it pinned to the bottom.
  function renderChatUI(bodyEl, icon, state, panel) {
    var justFulfilled = !bodyEl.querySelector('#chat-live');

    bodyEl.innerHTML =
      '<div id="chat-scroll" style="height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;display:flex;flex-direction:column">' +
        // ── Config strip (scrollable-away, tappable) ──
        '<div id="chat-config" style="flex-shrink:0;padding:10px 16px 12px;border-bottom:1px solid #1a1a22;background:#0e0e12">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<span id="badge-sandbox" style="font-size:11px;color:#34d399;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);padding:3px 9px;border-radius:6px;white-space:nowrap;cursor:pointer;touch-action:manipulation">' +
              (SANDBOX_ICONS[state.sandbox] || '⚡') + ' ' + (SANDBOX_LABELS[state.sandbox] || state.sandbox) + ' <span style="opacity:0.55">· change</span></span>' +
            '<span id="badge-model" style="font-size:11px;color:#a5b4fc;background:rgba(165,180,252,0.08);border:1px solid rgba(165,180,252,0.25);padding:3px 9px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%;cursor:pointer;touch-action:manipulation">' +
              providerLabel(state.provider) + ' · ' + modelDetail(state.model) + ' <span style="opacity:0.55">· change</span></span>' +
          '</div>' +
        '</div>' +
        // ── Chat section ──
        '<div id="chat-live" style="flex:1;display:flex;flex-direction:column;min-height:50%">' +
          '<div id="chat-messages" style="flex:1;padding:16px;display:flex;flex-direction:column;gap:12px">' +
            (state.messages.length === 0
              ? '<div style="text-align:center;color:#71717a;font-size:13px;padding:40px 20px">Say hi to ' + icon.name + '…</div>'
              : renderMessages(state.messages)
            ) +
          '</div>' +
          // ── Sticky input bar (stays visible while scrolled) ──
          '<div id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:#0e0e12;border-top:1px solid #1a1a22;padding:10px 16px 12px;z-index:2">' +
            '<div id="chat-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>' +
            '<div style="display:flex;gap:8px">' +
              '<textarea id="chat-input" placeholder="Message ' + icon.name + '…" style="flex:1;background:#14141a;border:1px solid #2a2a35;color:#e0e0e8;padding:10px 12px;border-radius:8px;font-size:14px;font-family:inherit;resize:none;outline:none;min-height:40px;max-height:120px;line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
              '<button id="chat-send" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:0 16px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;align-self:flex-start;height:40px">Send</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var scrollEl = bodyEl.querySelector('#chat-scroll');
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

    // Wire the config badges (changeable anytime — the design call).
    var badgeSandbox = bodyEl.querySelector('#badge-sandbox');
    var badgeModel = bodyEl.querySelector('#badge-model');
    badgeSandbox.addEventListener('click', function () {
      window.SandboxPicker.open(function (sandboxType) {
        applySandbox(icon, state, sandboxType, bodyEl, panel);
      });
    });
    badgeModel.addEventListener('click', function () {
      openModelPicker(icon, state, bodyEl, panel);
    });

    // The capability toolbar (effort / web / deep) — built async once the
    // catalog tells us the model's effort levels.
    buildToolbar(bodyEl, state, icon);

    // Auto-grow textarea
    input.addEventListener('input', function () {
      state.draftText = input.value;
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    });

    // Enter to send (Shift+Enter for newline)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    sendBtn.addEventListener('click', send);

    // Connect WS if not connected — but ONLY after the engine session
    // exists (the lazy create is async; connecting with session_id=null
    // 404s the WS handshake and can eat the first message).
    if (!state.client) {
      if (state.sessionId) {
        connectWS(bodyEl, state, msgContainer);
      } else {
        ensureSession(icon, state, function () {
          if (bodyEl.querySelector('#chat-input')) connectWS(bodyEl, state, msgContainer);
        });
      }
    } else {
      state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, bodyEl.querySelector('#chat-scroll')); };
    }

    // The reveal: on first fulfillment, smooth-scroll past the config strip
    // so the chat (greeting + input) is front and center. Scrolling back up
    // always reveals the sandbox/model badges again.
    if (justFulfilled) {
      setTimeout(function () {
        var live = bodyEl.querySelector('#chat-live');
        if (live && scrollEl) {
          scrollEl.scrollTo({ top: live.offsetTop - 6, behavior: 'smooth' });
        }
      }, 120);
    } else {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function send() {
      var text = input.value.trim();
      if (!text || state.isStreaming) return;
      if (!state.client && state.sessionId) connectWS(bodyEl, state, msgContainer);
      if (state.client && state.client.connected) {
        doSend(text);
        return;
      }
      // Engine still handshaking (or session still creating) — wait for the
      // EXISTING client, then send. v0.12 fix: never spawn a second client.
      sendBtn.textContent = '…';
      if (!state.client && !state.sessionId) {
        ensureSession(icon, state, function () { connectWS(bodyEl, state, msgContainer); });
      }
      var tries = 0;
      var check = setInterval(function () {
        tries++;
        if (state.client && state.client.connected) {
          clearInterval(check);
          if (!state.isStreaming) sendBtn.textContent = 'Send';
          doSend(text);
        } else if (tries > 150) {
          clearInterval(check);
          sendBtn.textContent = 'Send';
          var err = 'Still connecting to the engine — tap Send again in a moment.';
          state.messages.push({ role: 'error', text: err });
          appendMessage(msgContainer, scrollEl, { role: 'error', text: err });
        }
      }, 100);
    }

    function doSend(text) {
      state.messages.push({ role: 'user', text: text });
      appendMessage(msgContainer, scrollEl, { role: 'user', text: text });

      // v0.13: capability flags ride every send (per-message override).
      state.client.send(text, {
        effort: state.effort,
        web_search: !!state.webSearch,
        deep_research: !!state.deepResearch
      });

      input.value = '';
      state.draftText = '';
      input.style.height = 'auto';

      state.isStreaming = true;
      sendBtn.textContent = 'Stop';
      sendBtn.onclick = function () { state.client.stop(); };
    }
  }

  // ── The capability toolbar ────────────────────────────────────
  // effort button: cycles the model's OWN effort ladder (hidden when the
  // model has none). Web + Deep toggles, mutually exclusive.
  function buildToolbar(bodyEl, state, icon) {
    var bar = bodyEl.querySelector('#chat-toolbar');
    if (!bar) return;
    ensureCatalog().then(function (catalog) {
      if (!bar.isConnected) return;
      var levels = effortLevelsFor(catalog, state.provider, state.model);
      renderToolbar(bar, state, levels, icon, bodyEl);
    }).catch(function () {});
  }

  // Find the effort ladder for the selected model from the live catalog.
  function effortLevelsFor(catalog, provider, modelId) {
    if (!catalog) return null;
    var slot = (provider || '') + '/' + modelDetail(modelId);
    // groups → exact slot match
    var groups = catalog.groups || [];
    for (var g = 0; g < groups.length; g++) {
      var models = groups[g].models || [];
      for (var m = 0; m < models.length; m++) {
        if (models[m].id === slot) return models[m].effortLevels || null;
      }
    }
    // logical → the hosts' provider + modelId match
    var logical = catalog.logical || [];
    for (var l = 0; l < logical.length; l++) {
      var hosts = logical[l].hosts || [];
      for (var h = 0; h < hosts.length; h++) {
        if (hosts[h].provider === provider && hosts[h].modelId === modelDetail(modelId)) {
          var attr = logical[l].attributes || {};
          return attr.effortLevels || attr.effort_levels || null;
        }
      }
    }
    return null;
  }

  function renderToolbar(bar, state, levels, icon, bodyEl) {
    bar.innerHTML = '';
    var anyActive = state.webSearch || state.deepResearch;

    // Effort cycle button (only when the model offers levels).
    if (levels && levels.length > 0) {
      var curIdx = levels.indexOf(state.effort);
      var nextLabel = curIdx >= 0
        ? 'effort · ' + state.effort
        : 'effort';
      var eb = document.createElement('button');
      eb.textContent = nextLabel;
      eb.style.cssText = effortBtnStyle(curIdx >= 0);
      eb.addEventListener('click', function () {
        // Cycle: current → next → off (undefined) → first…
        var idx = levels.indexOf(state.effort);
        state.effort = idx < 0 ? levels[0] : (idx + 1 < levels.length ? levels[idx + 1] : '');
        persistCaps(state, icon);
        renderToolbar(bar, state, levels, icon, bodyEl);
      });
      bar.appendChild(eb);
    }

    // Web toggle.
    var wb = document.createElement('button');
    wb.textContent = '⌕ web';
    wb.style.cssText = capBtnStyle(state.webSearch, '#38bdf8');
    wb.addEventListener('click', function () {
      state.webSearch = !state.webSearch;
      if (state.webSearch) state.deepResearch = false; // mutually exclusive
      persistCaps(state, icon);
      renderToolbar(bar, state, levels, icon, bodyEl);
    });
    bar.appendChild(wb);

    // Deep toggle.
    var db = document.createElement('button');
    db.textContent = '⌖ deep research';
    db.style.cssText = capBtnStyle(state.deepResearch, '#a78bfa');
    db.addEventListener('click', function () {
      state.deepResearch = !state.deepResearch;
      if (state.deepResearch) state.webSearch = false;
      persistCaps(state, icon);
      renderToolbar(bar, state, levels, icon, bodyEl);
    });
    bar.appendChild(db);

    if (anyActive || (state.effort && state.effort !== 'med')) {
      var clear = document.createElement('button');
      clear.textContent = 'clear';
      clear.style.cssText = 'background:transparent;border:1px solid #2a2a35;color:#71717a;padding:4px 10px;border-radius:8px;font-size:11px;font-family:inherit;cursor:pointer;flex-shrink:0';
      clear.addEventListener('click', function () {
        state.effort = 'med';
        state.webSearch = false;
        state.deepResearch = false;
        persistCaps(state, icon);
        renderToolbar(bar, state, levels, icon, bodyEl);
      });
      bar.appendChild(clear);
    }
  }

  function effortBtnStyle(active) {
    return 'flex-shrink:0;background:' + (active ? 'rgba(249,115,22,0.15)' : 'transparent') + ';border:1px solid ' + (active ? 'rgba(249,115,22,0.5)' : '#2a2a35') + ';color:' + (active ? '#fb923c' : '#71717a') + ';padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer';
  }

  function capBtnStyle(active, color) {
    return 'flex-shrink:0;background:' + (active ? color + '22' : 'transparent') + ';border:1px solid ' + (active ? color + '88' : '#2a2a35') + ';color:' + (active ? color : '#71717a') + ';padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer';
  }

  // Persist capability flags on the engine session (survives restart).
  function persistCaps(state, icon) {
    if (!state.sessionId) {
      updateSession(icon, state, {});
      return;
    }
    fetch('/api/sessions/' + state.sessionId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        effort: state.effort,
        web_search: !!state.webSearch,
        deep_research: !!state.deepResearch
      })
    }).catch(function (e) { console.error('persist caps failed', e); });
  }

  // ── WebSocket connect ─────────────────────────────────────────
  function connectWS(bodyEl, state, msgContainer) {
    if (!state.sessionId) return; // never connect without a session (404s)
    var baseUrl = '';
    state.client = new window.ChatClient(baseUrl, state.sessionId, '');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl); };
    state.client.connect();
  }

  // ensureSession creates the engine session (if missing) and calls back
  // once the id lands — used by renderChatUI and send() so the WS never
  // handshakes with session_id=null.
  function ensureSession(icon, state, cb) {
    if (state.sessionId) { cb(); return; }
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: icon.name,
        sandbox: state.sandbox,
        model: state.model,
        provider: state.provider,
        effort: state.effort || 'med',
        web_search: !!state.webSearch,
        deep_research: !!state.deepResearch
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ID) {
        state.sessionId = data.ID;
        icon._sessionData = data;
        cb();
      }
    }).catch(function (e) { console.error('create session failed', e); });
  }

  // ── Handle a WS event ─────────────────────────────────────────
  function handleEvent(ev, state, msgContainer, scrollEl) {
    var type = ev.type;
    if (type === 'user') {
      return; // already added locally
    }
    if (type === 'assistant_delta' || type === 'assistant_complete') {
      if (ev.text) {
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.complete) {
          last = { role: 'assistant', text: '', complete: false, streaming: true };
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last);
        }
        last.text += ev.text;
        updateLastMessage(msgContainer, scrollEl, last);
      }
      if (type === 'assistant_complete') {
        var last2 = state.messages[state.messages.length - 1];
        if (last2) { last2.complete = true; last2.streaming = false; }
      }
    } else if (type === 'assistant') {
      // Full-reply event (persisted history replay / final fold) — skip if
      // the deltas already assembled it.
      var assembled = '';
      for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'assistant') assembled += state.messages[i].text;
      }
      if ((ev.text || '') && assembled.indexOf(ev.text) === -1 && ev.text.length > assembled.length + 40) {
        state.messages.push({ role: 'assistant', text: ev.text, complete: true });
        appendMessage(msgContainer, scrollEl, { role: 'assistant', text: ev.text, complete: true });
      }
    } else if (type === 'thinking') {
      // Streaming reasoning — a collapsible "Thinking" bubble (replace mode
      // when the model sends one big block, append for fragments).
      var lastThink = state.messages[state.messages.length - 1];
      if (!lastThink || lastThink.role !== 'thinking') {
        lastThink = { role: 'thinking', text: '', open: true };
        state.messages.push(lastThink);
        appendMessage(msgContainer, scrollEl, lastThink);
      }
      lastThink.text += ev.text;
      updateLastMessage(msgContainer, scrollEl, lastThink);
    } else if (type === 'tool_use') {
      state.messages.push({ role: 'tool', text: (ev.name || 'tool') + ': ' + (ev.summary || ''), tool: true });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
    } else if (type === 'tool_result') {
      state.messages.push({ role: 'tool', text: '↳ ' + ((ev.text || ev.name || '').slice(0, 240)), result: true });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
    } else if (type === 'sources') {
      var srcs = ev.sources || [];
      if (srcs.length) {
        state.messages.push({ role: 'sources', sources: srcs });
        appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
      }
    } else if (type === 'status') {
      if (ev.state === 'idle' || ev.state === 'error') {
        state.isStreaming = false;
        var btn = document.querySelector('#chat-send');
        if (btn) { btn.textContent = 'Send'; btn.onclick = null; }
        // research progress lines arrive as status.text
        if (ev.text && ev.state === 'running' && msgContainer) {
          state.messages.push({ role: 'tool', text: '· ' + (ev.message || ev.text), progress: true });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
        }
      } else if (ev.state === 'running' && (ev.text || ev.message)) {
        // Deep-research stage updates — transient progress lines.
        if (msgContainer) {
          state.messages.push({ role: 'tool', text: '· ' + (ev.message || ev.text), progress: true });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
        }
      }
    } else if (type === 'error') {
      state.isStreaming = false;
      state.messages.push({ role: 'error', text: ev.message || ev.error || 'Unknown error' });
      appendMessage(msgContainer, scrollEl, { role: 'error', text: ev.message || ev.error || 'Unknown error' });
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────
  function renderMessages(messages) {
    var html = '';
    for (var i = 0; i < messages.length; i++) {
      html += messageHTML(messages[i]);
    }
    return html;
  }

  function messageHTML(msg) {
    if (msg.role === 'user') {
      return '<div style="align-self:flex-end;background:#4a4a5e;color:#e0e0e8;padding:10px 14px;border-radius:14px 14px 4px 14px;max-width:80%;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word">' + esc(msg.text) + '</div>';
    } else if (msg.role === 'assistant') {
      return '<div style="align-self:flex-start;background:#14141a;color:#e0e0e8;padding:10px 14px;border-radius:14px 14px 14px 4px;max-width:80%;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word">' + esc(msg.text) + (msg.streaming ? '<span style="display:inline-block;width:6px;height:14px;background:#4a4a5e;margin-left:2px;vertical-align:middle;animation:blink 1s infinite"></span>' : '') + '</div>';
    } else if (msg.role === 'error') {
      return '<div style="align-self:center;color:#f87171;font-size:12px;padding:8px 12px;background:rgba(248,113,113,0.1);border-radius:8px;border:1px solid rgba(248,113,113,0.2);max-width:90%;word-break:break-word">' + esc(msg.text) + '</div>';
    } else if (msg.role === 'thinking') {
      // Collapsible reasoning bubble.
      return '<details style="align-self:stretch;max-width:95%;background:rgba(124,58,237,0.07);border:1px solid rgba(124,58,237,0.2);border-radius:10px;padding:8px 12px"' + (msg.open ? ' open' : '') + '>' +
        '<summary style="font-size:11px;color:#a78bfa;cursor:pointer;user-select:none">✻ thinking…</summary>' +
        '<div style="font-size:12px;color:#71717a;margin-top:6px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto">' + esc(msg.text) + '</div>' +
        '</details>';
    } else if (msg.role === 'tool') {
      // Tool/progress chip.
      var style = msg.progress
        ? 'color:#71717a;background:transparent;border:1px dashed #2a2a35'
        : (msg.result ? 'color:#34d399;background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.15)' : 'color:#38bdf8;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.2)');
      return '<div style="align-self:center;' + style + ';font-size:11px;padding:5px 10px;border-radius:8px;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(msg.text) + '</div>';
    } else if (msg.role === 'sources') {
      // Cited sources list.
      var items = '';
      for (var i = 0; i < msg.sources.length; i++) {
        var s = msg.sources[i];
        items += '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer" style="display:block;font-size:11px;color:#38bdf8;text-decoration:none;padding:3px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">[' + (i + 1) + '] ' + esc(s.title || s.url) + '</a>';
      }
      return '<div style="align-self:stretch;max-width:95%;background:#0a0a0e;border:1px solid #1a1a22;border-radius:10px;padding:8px 12px">' +
        '<div style="font-size:10px;color:#71717a;margin-bottom:4px;letter-spacing:0.4px">SOURCES</div>' + items + '</div>';
    }
    return '';
  }

  function appendMessage(container, scrollEl, msg) {
    var div = document.createElement('div');
    div.innerHTML = messageHTML(msg);
    var el = div.firstChild;
    container.appendChild(el);
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    else container.scrollTop = container.scrollHeight;
  }

  function updateLastMessage(container, scrollEl, msg) {
    var last = container.lastChild;
    if (!last) { appendMessage(container, scrollEl, msg); return; }
    last.innerHTML = messageHTML(msg);
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    else container.scrollTop = container.scrollHeight;
  }

  function esc(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  // ── Save session config to engine ─────────────────────────────
  function updateSession(icon, state, patch) {
    if (!state.sessionId) {
      // Create the session with everything we know (sandbox rides along —
      // v0.12 dropped it because the engine had no sandbox column).
      fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: icon.name,
          sandbox: state.sandbox,
          model: state.model,
          provider: state.provider,
          effort: state.effort || 'med',
          web_search: !!state.webSearch,
          deep_research: !!state.deepResearch
        })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.ID) {
          state.sessionId = data.ID;
          icon._sessionData = data;
        }
      }).catch(function (e) { console.error('create session failed', e); });
    } else {
      fetch('/api/sessions/' + state.sessionId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }).catch(function (e) { console.error('update session failed', e); });
    }
  }

  window.ChatPanel = { render: render, getState: function (id) { return chatStates[id]; } };
})();
