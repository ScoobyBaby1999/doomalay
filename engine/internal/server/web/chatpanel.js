// chatpanel.js — the chat panel UI for a ChatIcon.
//
// v0.14 WORKFLOW (user-specified, same-screen scroll reveal):
//   1. New chat icon → tap → panel shows the setup section: the two big
//      boxes (+ Sandbox / + Model) — expanded.
//   2. Pick a sandbox → pick a model (cloud provider / local). If extra
//      steps are needed (key paste etc.) the overlay chain handles it and
//      RETURNS here — the callback lands, both boxes fill.
//   3. THE SCREEN NEVER CHANGES: the chat ("Say hi to X", messages, sticky
//      input) appears BELOW the setup section in the same scroll container.
//      The panel smooth-scrolls down to it; scrolling back up reveals the
//      sandbox/model boxes again, exactly as before.
//   4. The setup section COLLAPSES under its header once the chat is live
//      (the user doesn't need the boxes while chatting). Tap the header /
//      chevron to expand and change sandbox or model on the fly.
//   5. + Model box shows the PROVIDER (like + Sandbox → "Quick Chat").
//      The MODEL itself lives in the far-left panel-header button
//      ("model · provider") — THAT button opens the dynamic model browser.
//   6. Capability toolbar above the input: effort cycle (model's own
//      ladder), Web + Deep toggles (mutually exclusive). Flags ride every
//      WS send.
//
// v0.14 WS FIX: the client now builds an ABSOLUTE ws:// URL (relative URLs
// throw on older Android WebViews → the 15s "Still connecting to engine"
// dead end), retries once, and reports failures instead of dying silently.
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
  // reflects WHICH sandbox — v0.12 always showed ⚡).
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
    // Ollama + unknown → prettify.
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
        client: null,
        setupOpen: true,      // v0.14: collapsible setup section
        fulfilled: false,     // sandbox + model both chosen?
        lastEventI: 0         // v0.15: max event id seen (replay dedup)
      };
      if (icon) icon._sessionData = sessionData || null;
    }
    return chatStates[chatId];
  }

  // ── Render: ONE unified layout for setup + chat ───────────────
  function render(bodyEl, icon, panel) {
    var state = getOrCreateState(icon.id, icon._sessionData, icon);
    renderUnified(bodyEl, icon, state, panel);
  }

  function renderUnified(bodyEl, icon, state, panel) {
    // Kick off (or reuse) the catalog fetch — re-render once labels land.
    ensureCatalog().then(function () {
      if (state.provider && !providerLabels[state.provider] && bodyEl.isConnected) {
        renderUnified(bodyEl, icon, state, panel);
      }
    });

    var sandboxSelected = !!state.sandbox;
    var modelSelected = !!state.model;
    var complete = sandboxSelected && modelSelected;
    var justFulfilled = complete && !state.fulfilled;
    if (complete) state.fulfilled = true;

    // On first fulfillment, collapse the setup (the chat takes over below)
    // — the user can always tap the pills row chevron to expand again.
    if (justFulfilled) state.setupOpen = false;

    // v0.15 (#2): the pills row is PINNED — it never scrolls off screen.
    // The setup boxes + intro text live INSIDE the scrollable flow (they
    // scroll away like the initial message they are).
    var pillsHTML = renderPills(state, sandboxSelected, modelSelected);
    var setupHTML = renderSetup(icon, state, sandboxSelected, modelSelected);

    // ── The chat section ──
    var chatHTML =
      '<div id="chat-live" style="flex:1 1 auto;display:flex;flex-direction:column;min-height:55%">' +
        '<div id="chat-messages" style="flex:1;padding:16px;display:flex;flex-direction:column;gap:12px">' +
          (complete
            ? (state.messages.length === 0
                ? '<div style="text-align:center;color:#71717a;font-size:13px;padding:40px 20px">Say hi to ' + esc(icon.name) + '…</div>'
                : renderMessages(state.messages))
            : '<div style="text-align:center;color:#4a4a5e;font-size:13px;padding:32px 20px;line-height:1.6">' +
                'Finish connecting above to start chatting with ' + esc(icon.name) + '.' +
              '</div>') +
        '</div>' +
        (complete
          ? // ── Sticky input bar (stays visible while scrolled) ──
            '<div id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:#0e0e12;border-top:1px solid #1a1a22;padding:10px 16px 12px;z-index:2">' +
            '<div id="chat-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>' +
            '<div style="display:flex;gap:8px">' +
              '<textarea id="chat-input" placeholder="Message ' + esc(icon.name) + '…" style="flex:1;background:#14141a;border:1px solid #2a2a35;color:#e0e0e8;padding:10px 12px;border-radius:8px;font-size:14px;font-family:inherit;resize:none;outline:none;min-height:40px;max-height:120px;line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
              '<button id="chat-send" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:0 16px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;align-self:flex-start;height:40px">Send</button>' +
            '</div>' +
            '</div>'
          : '') +
      '</div>';

    bodyEl.innerHTML =
      '<div id="chat-root" style="height:100%;display:flex;flex-direction:column;overflow:hidden">' +
        pillsHTML +
        '<div id="chat-scroll" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;display:flex;flex-direction:column">' +
        setupHTML +
        chatHTML +
        '</div>' +
      '</div>';

    var scrollEl = bodyEl.querySelector('#chat-scroll');
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

    wireSetup(bodyEl, icon, state, panel);
    updateHeaderBtn(state, icon, bodyEl, panel);

    if (input && sendBtn) {
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
      // 404s the WS handshake and can eat the first message). v0.15: first
      // re-bind the icon to its previously persisted engine session so a
      // restart replays the SAME conversation instead of forking a new one.
      if (!state.client) {
        bindEngineSession(icon, state, function () {
          if (state.sessionId) {
            connectWS(bodyEl, state, msgContainer);
          } else {
            ensureSession(icon, state, function () {
              if (bodyEl.querySelector('#chat-input')) connectWS(bodyEl, state, msgContainer);
            });
          }
        });
      } else {
        state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl); };
      }
    }

    // The reveal: on first fulfillment, smooth-scroll past the setup so the
    // chat (greeting + input) is front and center. Scrolling back up always
    // reveals the sandbox/model boxes again.
    if (justFulfilled) {
      setTimeout(function () {
        var live = bodyEl.querySelector('#chat-live');
        if (live && scrollEl) {
          scrollEl.scrollTo({ top: live.offsetTop - 6, behavior: 'smooth' });
        }
      }, 120);
    } else if (state.fulfilled && state.messages.length) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function send() {
      var text = input.value.trim();
      if (!text || state.isStreaming) return;
      // v0.15: PrivateMode turns run through the SDK bridge — they do NOT
      // need the engine WS, so never wait for it.
      if (state.provider === 'privatemodeai') {
        doSend(text);
        return;
      }
      if (state.client && state.client.connected) {
        doSend(text);
        return;
      }
      // Engine still handshaking (or session still creating) — wait for the
      // EXISTING client, then send. Never spawn a second client.
      if (!state.client && !state.sessionId) {
        ensureSession(icon, state, function () { connectWS(bodyEl, state, msgContainer); });
      } else if (state.client && state.client.state !== 'connecting' && state.client.state !== 'open') {
        // Dead/failed client — kick a reconnect (v0.14: ChatClient retries
        // once by itself; this covers the case after that).
        state.client.connect();
      }
      sendBtn.textContent = '…';
      var tries = 0;
      var check = setInterval(function () {
        tries++;
        if (state.client && state.client.connected) {
          clearInterval(check);
          if (!state.isStreaming) sendBtn.textContent = 'Send';
          doSend(text);
        } else if (tries > 100) {
          clearInterval(check);
          sendBtn.textContent = 'Send';
          var err = 'Still connecting to the engine — tap Send again in a moment.' +
            (state.client && state.client.lastError ? ' (' + state.client.lastError + ')' : '');
          state.messages.push({ role: 'error', text: err });
          appendMessage(msgContainer, scrollEl, { role: 'error', text: err });
        }
      }, 100);
    }

    function doSend(text) {
      state.messages.push({ role: 'user', text: text, local: true });
      appendMessage(msgContainer, scrollEl, { role: 'user', text: text });

      input.value = '';
      state.draftText = '';
      input.style.height = 'auto';

      state.isStreaming = true;
      sendBtn.textContent = 'Stop';

      // v0.15: PrivateMode turns run through the official SDK bridge IN THE
      // WEBVIEW — PM's chat API requires their E2E-encryption protocol
      // (attestation + WASM crypto) which the Go engine cannot speak.
      if (state.provider === 'privatemodeai') {
        if (window.PMBridge && window.PMBridge.available && window.PMBridge.available()) {
          runPMTurn(text, state, msgContainer, scrollEl, sendBtn);
          return;
        }
        state.isStreaming = false;
        sendBtn.textContent = 'Send';
        sendBtn.onclick = null;
        var pmErr = 'PrivateMode needs the secure-channel module (still loading — try again in a moment).';
        state.messages.push({ role: 'error', text: pmErr });
        appendMessage(msgContainer, scrollEl, { role: 'error', text: pmErr });
        return;
      }

      // v0.13: capability flags ride every send (per-message override).
      // v0.15: model + provider ride too — the engine re-fetches the
      // session per turn AND honors these overrides, so the turn can
      // never run through a stale provider again (the universal-401 bug).
      state.client.send(text, {
        effort: state.effort,
        web_search: !!state.webSearch,
        deep_research: !!state.deepResearch,
        model: state.model,
        provider: state.provider
      });

      sendBtn.onclick = function () { state.client.stop(); };
    }
  }

  // ── v0.15: a PrivateMode turn (SDK bridge, runs in the WebView) ──────
  // Streams through PM's encrypted channel, feeds the same message
  // pipeline as WS turns, and persists user/assistant/status events via
  // the engine's REST append endpoint so replay + reload stay exact.
  function runPMTurn(text, state, msgContainer, scrollEl, sendBtn) {
    var abort = new AbortController();
    sendBtn.onclick = function () { abort.abort(); };

    // History: user + complete assistant messages, last 40 (same window
    // as the engine's buildHistory).
    var history = [];
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m.role === 'user') history.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant' && m.complete) history.push({ role: 'assistant', content: m.text });
    }
    if (history.length > 40) history = history.slice(-40);

    var model = String(state.model || '');
    if (model.indexOf('privatemodeai/') === 0) model = model.slice('privatemodeai/'.length);

    // First-turn progress hint (attestation takes a few seconds).
    var hintEl = null;
    var showHint = function (msg) {
      if (!hintEl) {
        var hint = { role: 'tool', text: '· ' + msg, progress: true };
        state.messages.push(hint);
        hintEl = appendMessage(msgContainer, scrollEl, hint);
      }
    };
    var clearHint = function () {
      if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
      // Drop from state too.
      for (var j = state.messages.length - 1; j >= 0; j--) {
        if (state.messages[j].progress) { state.messages.splice(j, 1); break; }
      }
      hintEl = null;
    };

    showHint('establishing PrivateMode secure channel…');

    var streamMsg = null; // the assistant message being streamed
    var getStreamMsg = function () {
      if (!streamMsg) {
        streamMsg = { role: 'assistant', text: '', complete: false, streaming: true };
        state.messages.push(streamMsg);
        appendMessage(msgContainer, scrollEl, streamMsg);
      }
      return streamMsg;
    };

    var persist = function (type, payload) {
      if (!state.sessionId) return;
      fetch('/api/sessions/' + state.sessionId + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, text: payload })
      }).then(function (r) { return r.json(); }).then(function (saved) {
        // v0.15: track the id so a later WS replay stays idempotent.
        if (saved && saved.id && saved.id > (state.lastEventI || 0)) {
          state.lastEventI = saved.id;
        }
      }).catch(function (e) { console.error('persist PM event failed', e); });
    };

    var finish = function (errText) {
      clearHint();
      state.isStreaming = false;
      sendBtn.textContent = 'Send';
      sendBtn.onclick = null;
      if (streamMsg) {
        streamMsg.complete = true;
        streamMsg.streaming = false;
        if (streamMsg.text) persist('assistant', streamMsg.text);
        updateLastMessage(msgContainer, scrollEl, streamMsg);
      }
      if (errText) {
        persist('error', errText);
        state.messages.push({ role: 'error', text: errText });
        appendMessage(msgContainer, scrollEl, { role: 'error', text: errText });
        persist('status', JSON.stringify({ state: 'error', usage: null }));
      } else {
        persist('status', JSON.stringify({ state: 'idle', usage: null }));
      }
    };

    // Persist the user message through the engine (same as WS turns).
    persist('user', text);

    window.PMBridge.streamChat({
      model: model,
      messages: history,
      signal: abort.signal,
      onThinking: function (t) {
        clearHint();
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'thinking') {
          last = { role: 'thinking', text: '', open: true };
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last);
        }
        last.text += t;
        updateLastMessage(msgContainer, scrollEl, last);
      },
      onDelta: function (t) {
        clearHint();
        var m2 = getStreamMsg();
        m2.text += t;
        updateLastMessage(msgContainer, scrollEl, m2);
      },
      onStatus: function (st) {
        if (st === 'running') showHint('establishing PrivateMode secure channel…');
      }
    }).then(function (result) {
      if (result && result.aborted) {
        finish(null);
        return;
      }
      finish(null);
    }).catch(function (e) {
      finish(e && e.message ? e.message : 'PrivateMode turn failed');
    });
  }

  // ── v0.15 (#2): the PINNED pills row — tiny, always-visible controls ──
  // sandbox pill + model pill + chevron. Never scrolls off screen.
  function renderPills(state, sandboxSelected, modelSelected) {
    var sumSandbox = sandboxSelected
      ? (SANDBOX_ICONS[state.sandbox] || '⚡') + ' ' + (SANDBOX_LABELS[state.sandbox] || state.sandbox)
      : '+ Sandbox';
    var sumModel = modelSelected ? providerLabel(state.provider) : '+ Model';
    var open = state.setupOpen || !(sandboxSelected && modelSelected);
    var pill = function (id, label, selected, color) {
      return '<button id="' + id + '" style="display:flex;align-items:center;gap:5px;min-width:0;flex-shrink:1;' +
        'background:' + (selected ? 'rgba(52,211,153,0.10)' : 'rgba(52,211,153,0.06)') + ';' +
        'border:1px solid ' + (selected ? 'rgba(52,211,153,0.35)' : 'rgba(52,211,153,0.55)') + ';' +
        'color:' + (selected ? '#e0e0e8' : color) + ';' +
        'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(label) + '</button>';
    };
    return '<div id="chat-pills" style="flex-shrink:0;display:flex;align-items:center;gap:6px;padding:8px 12px;background:#0e0e12;border-bottom:1px solid #1a1a22;z-index:3">' +
      pill('pill-sandbox', sumSandbox, sandboxSelected, '#34d399') +
      pill('pill-model', sumModel, modelSelected, '#34d399') +
      '<button id="pill-chevron" aria-label="Toggle setup" style="flex-shrink:0;margin-left:auto;background:transparent;border:none;color:#71717a;font-size:11px;cursor:pointer;padding:5px 6px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform 0.2s;transform:rotate(' + (open ? '90deg' : '0deg') + ')">▶</button>' +
      '</div>';
  }

  // ── The setup section: the two big boxes, INSIDE the scroll flow ──
  // (v0.15 #2: the "One more thing — pick a model" heading + intro text are
  // part of the initial conversation flow — they scroll off like messages.)
  function renderSetup(icon, state, sandboxSelected, modelSelected) {
    var open = state.setupOpen || !(sandboxSelected && modelSelected);

    var sandboxTitle = sandboxSelected ? (SANDBOX_LABELS[state.sandbox] || state.sandbox) : '+ Sandbox';
    var sandboxSub = sandboxSelected ? '+ Sandbox' : 'Tap to connect';
    var sandboxIcon = sandboxSelected ? (SANDBOX_ICONS[state.sandbox] || '⚡') : '🔌';

    // v0.14 (#5): the + Model box shows the PROVIDER only — mirroring how
    // + Sandbox → "Quick Chat". The model itself shows in the far-left
    // panel-header button ("model · provider").
    var modelTitle = modelSelected ? providerLabel(state.provider) : '+ Model';
    var modelSub = modelSelected ? '+ Model' : 'Tap to connect';

    var heading = !sandboxSelected && !modelSelected
      ? 'Choose a model and sandbox and go!'
      : 'One more thing — ' + (!sandboxSelected ? 'pick a sandbox' : 'pick a model');
    var intro = 'Pick a sandbox and a model to start chatting with ' + icon.name + '.';

    var boxStyle = function (selected) {
      return 'flex:1;background:' + (selected ? '#181820' : '#14141a') + ';border:2px ' + (selected ? 'solid #34344a' : 'dashed #2a2a35') + ';border-radius:16px;padding:24px 16px;text-align:center;cursor:pointer;transition:border-color 0.15s;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;touch-action:manipulation;-webkit-tap-highlight-color:transparent';
    };

    var bodyHTML =
      '<div id="setup-body" style="' + (open ? '' : 'display:none;') + 'padding:16px 16px 8px;flex-shrink:0">' +
        '<h3 style="font-size:16px;font-weight:600;color:#e0e0e8;margin:0 0 8px">' + heading + '</h3>' +
        '<p style="font-size:13px;color:#71717a;margin:0 0 16px">' + intro + '</p>' +
        '<div style="display:flex;gap:16px;width:100%;max-width:400px">' +
          '<div id="box-sandbox" style="' + boxStyle(sandboxSelected) + '">' +
            '<span style="font-size:28px">' + sandboxIcon + '</span>' +
            '<span style="font-size:14px;font-weight:600;color:#e0e0e8">' + esc(sandboxTitle) + '</span>' +
            '<span style="font-size:11px;color:' + (sandboxSelected ? '#34d399' : '#71717a') + '">' + sandboxSub + '</span>' +
          '</div>' +
          '<div id="box-model" style="' + boxStyle(modelSelected) + '">' +
            '<span style="font-size:28px">🤖</span>' +
            '<span style="font-size:14px;font-weight:600;color:#e0e0e8">' + esc(modelTitle) + '</span>' +
            '<span style="font-size:11px;color:' + (modelSelected ? '#34d399' : '#71717a') + '">' + modelSub + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';

    return bodyHTML;
  }

  function wireSetup(bodyEl, icon, state, panel) {
    var body = bodyEl.querySelector('#setup-body');
    var chevron = bodyEl.querySelector('#pill-chevron');
    var pillsRow = bodyEl.querySelector('#chat-pills');

    // v0.15 (#2): the chevron (and a tap on the pills row's empty space)
    // toggles the setup section INSIDE the scroll flow. The pills
    // themselves are direct change-buttons.
    var toggleSetup = function () {
      state.setupOpen = !state.setupOpen;
      var open = state.setupOpen || !(state.sandbox && state.model);
      if (body) body.style.display = open ? '' : 'none';
      if (chevron) chevron.style.transform = 'rotate(' + (open ? '90deg' : '0deg') + ')';
      // Scroll back up so the setup boxes are visible when expanding.
      if (open) {
        var scrollEl = bodyEl.querySelector('#chat-scroll');
        if (scrollEl) scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
    if (chevron) chevron.addEventListener('click', function (e) { e.stopPropagation(); toggleSetup(); });
    if (pillsRow) {
      pillsRow.addEventListener('click', function (e) {
        // Only toggle when the tap hit the row itself (not a pill button).
        if (e.target === pillsRow) toggleSetup();
      });
    }

    // v0.15: the PILLS are direct change-buttons (usable while the setup
    // section is collapsed); the big boxes do the same when visible.
    var wirePicker = function (sel, fn) {
      var el = bodyEl.querySelector(sel);
      if (el) el.addEventListener('click', fn);
    };
    wirePicker('#pill-sandbox', function () {
      window.SandboxPicker.open(function (sandboxType) {
        applySandbox(icon, state, sandboxType, bodyEl, panel);
      });
    });
    wirePicker('#pill-model', function () { openModelPicker(icon, state, bodyEl, panel); });
    wirePicker('#box-sandbox', function () {
      window.SandboxPicker.open(function (sandboxType) {
        applySandbox(icon, state, sandboxType, bodyEl, panel);
      });
    });
    wirePicker('#box-model', function () { openModelPicker(icon, state, bodyEl, panel); });
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
    renderUnified(bodyEl, icon, state, panel);
  }

  // Open the model picker with the unified (provider, modelId) callback —
  // the overlay chain (providers/local → key paste → auto pick) lands back
  // here and the chat reveals.
  function openModelPicker(icon, state, bodyEl, panel) {
    window.ModelPicker.open(function (provider, modelId) {
      applyModel(icon, state, provider, modelId, bodyEl, panel);
    });
  }

  // v0.14: shared apply-model (used by BOTH the + Model box and the
  // far-left header button's model browser).
  function applyModel(icon, state, provider, modelId, bodyEl, panel) {
    state.model = modelId;
    state.provider = provider;
    if (icon) {
      icon.model = modelId;
      icon.provider = provider;
      if (typeof icon.save === 'function') icon.save();
    }
    updateSession(icon, state, { model: modelId, provider: provider });
    renderUnified(bodyEl, icon, state, panel);
  }

  // ── The far-left panel-header model button (#5): "model · provider",
  // tappable → the dynamic model browser. Lives in index.html's
  // .panel-header; ChatPanel owns its visibility + content.
  function updateHeaderBtn(state, icon, bodyEl, panel) {
    var btn = document.getElementById('panel-model-btn');
    if (!btn) return;
    if (!state.model) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = 'flex';
    btn.innerHTML =
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(modelDetail(state.model)) + '</span>' +
      '<span style="color:#71717a;flex-shrink:0">· ' + esc(providerLabel(state.provider)) + ' ▾</span>';
    // Rebind: the button is persistent across renders.
    btn.onclick = function () {
      if (!window.ModelBrowser) return;
      window.ModelBrowser.open(function (provider, modelId) {
        applyModel(icon, state, provider, modelId, bodyEl, panel);
      });
    };
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
  // once the id lands — used by renderUnified and send() so the WS never
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
        bindSessionToIcon(icon, data.ID); // v0.15: persist the binding
        cb();
      }
    }).catch(function (e) { console.error('create session failed', e); });
  }

  // v0.15: reattach to the ENGINE session the icon was bound to (persisted
  // in localStorage via icon.sessionId) — a restart now replays the SAME
  // conversation instead of silently forking a new, empty session.
  function bindEngineSession(icon, state, cb) {
    if (state.sessionId) { cb(); return; }
    var sid = icon && icon.sessionId;
    if (!sid) { ensureSession(icon, state, cb); return; }
    fetch('/api/sessions/' + sid).then(function (r) {
      if (r.status === 404) {
        if (icon) icon.sessionId = ''; // engine lost it (fresh data dir) — recreate
        return null;
      }
      return r.json();
    }).then(function (data) {
      if (data && data.ID) {
        state.sessionId = data.ID;
        icon._sessionData = data;
        // Seed any config the icon lost (the session is the source of truth).
        if (!state.sandbox && data.Sandbox) state.sandbox = data.Sandbox;
        if (!state.model && data.Model) state.model = data.Model;
        if (!state.provider && data.Provider) state.provider = data.Provider;
        cb();
      } else {
        ensureSession(icon, state, cb);
      }
    }).catch(function () { ensureSession(icon, state, cb); });
  }

  // v0.15: persist the session binding on the icon (survives app restarts).
  function bindSessionToIcon(icon, sessionId) {
    if (!icon) return;
    icon.sessionId = sessionId;
    if (typeof icon.save === 'function') icon.save();
  }

  // ── Handle a WS event ─────────────────────────────────────────
  function handleEvent(ev, state, msgContainer, scrollEl) {
    var type = ev.type;
    // v0.15: idempotent replay — the engine re-sends every event on
    // (re)connect; skip anything already seen (same id). PM-turn events
    // persisted via REST update lastEventI from the append response.
    if (ev.i !== undefined && ev.i !== null && !isNaN(ev.i)) {
      if (ev.i <= (state.lastEventI || 0)) return;
      state.lastEventI = ev.i;
    }
    if (type === 'user') {
      // v0.15: REPLAYED user events must restore the conversation; the
      // live-turn echo is already rendered locally (doSend pushed it with
      // local:true) — skip only that exact echo.
      var last = state.messages[state.messages.length - 1];
      if (last && last.role === 'user' && last.local && last.text === (ev.text || '')) {
        delete last.local; // the echo arrived — clear the marker
        return;
      }
      state.messages.push({ role: 'user', text: ev.text || '' });
      appendMessage(msgContainer, scrollEl, { role: 'user', text: ev.text || '' });
      return;
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
      // the deltas already assembled it (live turn), add on replay.
      var assembled = '';
      for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'assistant') assembled += state.messages[i].text;
      }
      if ((ev.text || '') && assembled.indexOf(ev.text) === -1) {
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
      } else if (ev.state === 'running' && (ev.text || ev.message)) {
        // Deep-research stage updates — transient progress lines.
        if (msgContainer) {
          state.messages.push({ role: 'tool', text: '· ' + (ev.message || ev.text), progress: true });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
        }
      }
    } else if (type === 'error') {
      state.isStreaming = false;
      // v0.15: error events carry the provider + model the engine ACTUALLY
      // used — show them so any desync is instantly visible.
      var errText = ev.message || ev.error || ev.text || 'Unknown error';
      if (ev.provider) {
        errText += ' (via ' + ev.provider + (ev.model ? ' · ' + ev.model : '') + ')';
      }
      state.messages.push({ role: 'error', text: errText });
      appendMessage(msgContainer, scrollEl, { role: 'error', text: errText });
      var btn2 = document.querySelector('#chat-send');
      if (btn2) { btn2.textContent = 'Send'; btn2.onclick = null; }
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
    return el; // v0.15: PM turns track the hint element for removal
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
    d.textContent = text == null ? '' : String(text);
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
          bindSessionToIcon(icon, data.ID); // v0.15: persist the binding
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
