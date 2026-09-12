// chatpanel.js — the chat panel UI for a ChatIcon.
//
// Two states:
//   1. UNCONFIGURED (no sandbox + no model): shows 2 boxes (+ Sandbox, + Model)
//   2. CONFIGURED: shows the chat UI (messages, input, streaming)
//
// The panel renders into the body element provided by the Panel system.
// Each ChatIcon has its own session, model, sandbox — fully isolated.
//
// Exposes: window.ChatPanel

(function () {
  'use strict';

  // Per-chat state registry. Keyed by chat ID.
  var chatStates = {};

  // Pretty labels for sandbox types (the picker values are terse ids —
  // the UI should speak human).
  var SANDBOX_LABELS = { quick: 'Quick Chat', hf: 'Hugging Face', device: 'Another Device', terminal: 'Termux' };

  // Provider display labels ("openrouter" → "OpenRouter"), fetched once
  // from the engine catalog and cached for every chat panel.
  var providerLabels = {};
  var catalogPromise = null;
  function ensureCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch('/api/models').then(function (r) { return r.json(); }).then(function (d) {
      var provs = (d && d.providers) || {};
      for (var name in provs) providerLabels[name] = provs[name].label || name;
      return provs;
    }).catch(function () { return {}; });
    return catalogPromise;
  }

  function providerLabel(name) {
    if (!name) return '';
    if (providerLabels[name]) return providerLabels[name];
    // Fallback: prettify the id ("privatemodeai" → "Privatemodeai").
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function modelDetail(modelId) {
    // Strip the provider prefix from "provider/model-id" for display.
    var id = String(modelId || '');
    var slash = id.indexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
  }

  function getOrCreateState(chatId, sessionData) {
    if (!chatStates[chatId]) {
      chatStates[chatId] = {
        id: chatId,
        sessionId: sessionData && sessionData.ID ? sessionData.ID : null,
        sandbox: sessionData && sessionData.sandbox ? sessionData.sandbox : '',
        model: sessionData && sessionData.Model ? sessionData.Model : '',
        provider: sessionData && sessionData.Provider ? sessionData.Provider : '',
        messages: [],
        isStreaming: false,
        draftText: '',
        client: null
      };
    }
    return chatStates[chatId];
  }

  // Render the panel body for a chat. Called by app.js when the panel opens.
  // `bodyEl` is the Panel's body DOM element. `icon` is the ChatIcon.
  function render(bodyEl, icon, panel) {
    var state = getOrCreateState(icon.id, icon._sessionData);

    if (!state.sandbox || !state.model) {
      renderEmptyState(bodyEl, icon, state, panel);
    } else {
      renderChatUI(bodyEl, icon, state, panel);
    }
  }

  // ── Empty state: 2 boxes ──────────────────────────────────────
  function renderEmptyState(bodyEl, icon, state, panel) {
    // Kick off (or reuse) the catalog fetch — when labels arrive we
    // re-render once so the model box shows the proper provider label.
    ensureCatalog().then(function () {
      if (state.provider && !providerLabels[state.provider] && bodyEl.isConnected) {
        render(bodyEl, icon, panel);
      }
    });

    // v0.12 title/subtitle FLIP: once a sandbox or provider is selected, the
    // selected item becomes the MAIN title and the "+ Sandbox" / "+ Model"
    // selector label becomes the SUBTITLE — e.g. "Quick Chat" over
    // "+ Sandbox", "OpenRouter" over "+ Model".
    var sandboxSelected = !!state.sandbox;
    var modelSelected = !!state.model;

    var sandboxTitle = sandboxSelected ? (SANDBOX_LABELS[state.sandbox] || state.sandbox) : '+ Sandbox';
    var sandboxSub = sandboxSelected ? '+ Sandbox' : 'Tap to connect';

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
          '<span style="font-size:28px">' + (sandboxSelected ? '⚡' : '🔌') + '</span>' +
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

    // Wire up the boxes
    var boxSandbox = bodyEl.querySelector('#box-sandbox');
    var boxModel = bodyEl.querySelector('#box-model');

    boxSandbox.addEventListener('mouseover', function () { this.style.borderColor = '#4a4a5e'; });
    boxSandbox.addEventListener('mouseout', function () { this.style.borderColor = sandboxSelected ? '#34344a' : '#2a2a35'; });
    boxModel.addEventListener('mouseover', function () { this.style.borderColor = '#4a4a5e'; });
    boxModel.addEventListener('mouseout', function () { this.style.borderColor = modelSelected ? '#34344a' : '#2a2a35'; });

    boxSandbox.addEventListener('click', function () {
      window.SandboxPicker.open(function (sandboxType) {
        // Sandbox picked — save to session, update state
        state.sandbox = sandboxType;
        updateSession(icon, state, { sandbox: sandboxType });
        // Re-render
        render(bodyEl, icon, panel);
      });
    });

    boxModel.addEventListener('click', function () {
      // ModelPicker navigates to the providers / local-models screens itself
      // (smooth content replace) and calls us back ONCE with the final
      // (provider, modelId). v0.10.1 bug: we passed an intermediate
      // modelType callback here, but ModelPicker forwarded it verbatim to
      // ProvidersScreen — which invoked it as (provider, modelId), the
      // 'cloud' branch never matched, and nothing happened after picking.
      window.ModelPicker.open(function (provider, modelId) {
        state.model = modelId;
        state.provider = provider;
        updateSession(icon, state, { model: modelId, provider: provider });
        render(bodyEl, icon, panel);
      });
    });
  }

  // ── Chat UI: messages + input + streaming ──────────────────────
  function renderChatUI(bodyEl, icon, state, panel) {
    bodyEl.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%">' +
        // Header: sandbox badge + model badge (pretty labels, not raw ids)
        '<div style="flex-shrink:0;padding:8px 16px;border-bottom:1px solid #1a1a22;display:flex;align-items:center;gap:8px;overflow:hidden">' +
          '<span style="font-size:11px;color:#71717a;background:#1a1a22;padding:3px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%">' + (SANDBOX_LABELS[state.sandbox] || state.sandbox) + '</span>' +
          '<span style="font-size:11px;color:#4a4a5e;background:#1a1a22;padding:3px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%">' + (state.provider ? providerLabel(state.provider) + ' · ' + modelDetail(state.model) : state.model) + '</span>' +
        '</div>' +
        // Messages
        '<div id="chat-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;-webkit-overflow-scrolling:touch">' +
          (state.messages.length === 0
            ? '<div style="text-align:center;color:#71717a;font-size:13px;padding:40px 20px">Say hi to ' + icon.name + '…</div>'
            : renderMessages(state.messages)
          ) +
        '</div>' +
        // Input
        '<div style="flex-shrink:0;padding:12px 16px;border-top:1px solid #1a1a22;display:flex;gap:8px">' +
          '<textarea id="chat-input" placeholder="Message ' + icon.name + '…" style="flex:1;background:#14141a;border:1px solid #2a2a35;color:#e0e0e8;padding:10px 12px;border-radius:8px;font-size:14px;font-family:inherit;resize:none;outline:none;min-height:40px;max-height:120px;line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
          '<button id="chat-send" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:0 16px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;align-self:flex-start;height:40px">Send</button>' +
        '</div>' +
      '</div>';

    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

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

    // Connect WS if not connected
    if (!state.client) {
      connectWS(bodyEl, icon, state, msgContainer);
    } else {
      // Re-route events to the new container
      state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer); };
    }

    function send() {
      var text = input.value.trim();
      if (!text || state.isStreaming) return;
      if (!state.client) connectWS(bodyEl, icon, state, msgContainer);
      if (state.client && state.client.connected) {
        doSend(text);
        return;
      }
      // Engine still handshaking — wait for the EXISTING client (never spawn
      // a second one), up to 15s, then send. v0.12 fix: the old code created
      // a duplicate WS client here and silently dropped the message when its
      // 5s poll timed out — typing fast right after opening the chat ate the
      // first message.
      sendBtn.textContent = '…';
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
          appendMessage(msgContainer, { role: 'error', text: err });
        }
      }, 100);
    }

    function doSend(text) {
      // Add user message to UI
      state.messages.push({ role: 'user', text: text });
      appendMessage(msgContainer, { role: 'user', text: text });

      // Send via WS
      state.client.send(text);

      // Clear input
      input.value = '';
      state.draftText = '';
      input.style.height = 'auto';

      // Start streaming state
      state.isStreaming = true;
      sendBtn.textContent = 'Stop';
      sendBtn.onclick = function () { state.client.stop(); };
    }
  }

  // ── WebSocket connect ─────────────────────────────────────────
  function connectWS(bodyEl, icon, state, msgContainer, onConnected) {
    var baseUrl = '';
    state.client = new window.ChatClient(baseUrl, state.sessionId, '');
    state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer); };
    state.client.connect();
    if (onConnected) {
      // Wait for connection
      var check = setInterval(function () {
        if (state.client.connected) {
          clearInterval(check);
          onConnected();
        }
      }, 100);
      setTimeout(function () { clearInterval(check); }, 5000); // timeout
    }
  }

  // ── Handle a WS event ─────────────────────────────────────────
  function handleEvent(ev, state, msgContainer) {
    // ev types: user, thinking, assistant_delta, assistant_complete, tool_use, tool_result, status, error, title
    if (ev.type === 'user') {
      // Already added locally — skip (idempotent)
      return;
    }
    if (ev.type === 'assistant_delta' || ev.type === 'assistant_complete') {
      if (ev.text) {
        // Find the last assistant message or create a new one
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.complete) {
          last = { role: 'assistant', text: '', complete: false, streaming: true };
          state.messages.push(last);
          appendMessage(msgContainer, last);
        }
        last.text += ev.text;
        updateLastMessage(msgContainer, last);
      }
      if (ev.type === 'assistant_complete') {
        var last2 = state.messages[state.messages.length - 1];
        if (last2) { last2.complete = true; last2.streaming = false; }
      }
    } else if (ev.type === 'status') {
      if (ev.state === 'idle' || ev.state === 'error') {
        state.isStreaming = false;
        // Reset send button
        var btn = document.querySelector('#chat-send');
        if (btn) { btn.textContent = 'Send'; btn.onclick = null; }
      }
    } else if (ev.type === 'error') {
      state.isStreaming = false;
      state.messages.push({ role: 'error', text: ev.message || ev.error || 'Unknown error' });
      appendMessage(msgContainer, { role: 'error', text: ev.message || ev.error || 'Unknown error' });
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
      return '<div style="align-self:flex-start;background:#14141a;color:#e0e0e8;padding:10px 14px;border-radius:14px 14px 14px 4px;max-width:80%;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:word-wrap">' + esc(msg.text) + (msg.streaming ? '<span style="display:inline-block;width:6px;height:14px;background:#4a4a5e;margin-left:2px;vertical-align:middle;animation:blink 1s infinite"></span>' : '') + '</div>';
    } else if (msg.role === 'error') {
      return '<div style="align-self:center;color:#f87171;font-size:12px;padding:8px;background:rgba(248,113,113,0.1);border-radius:8px;border:1px solid rgba(248,113,113,0.2)">' + esc(msg.text) + '</div>';
    }
    return '';
  }

  function appendMessage(container, msg) {
    var div = document.createElement('div');
    div.innerHTML = messageHTML(msg);
    var el = div.firstChild;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function updateLastMessage(container, msg) {
    var last = container.lastChild;
    if (!last) { appendMessage(container, msg); return; }
    last.innerHTML = esc(msg.text) + (msg.streaming ? '<span style="display:inline-block;width:6px;height:14px;background:#4a4a5e;margin-left:2px;vertical-align:middle;animation:blink 1s infinite"></span>' : '');
    container.scrollTop = container.scrollHeight;
  }

  function esc(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  // ── Save session config to engine ─────────────────────────────
  function updateSession(icon, state, patch) {
    if (!state.sessionId) {
      // Create session first
      fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: icon.name, model: state.model, provider: state.provider })
      }).then(function (r) { return r.json(); }).then(function (data) {
        state.sessionId = data.ID;
        icon._sessionData = data;
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
