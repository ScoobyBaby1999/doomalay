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
    bodyEl.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px">' +
      '<h3 style="font-size:16px;font-weight:600;color:#e0e0e8;margin:0 0 24px">New Chat — ' + icon.name + '</h3>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 24px;text-align:center">Pick a sandbox and a model to start chatting.</p>' +
      '<div style="display:flex;gap:16px;width:100%;max-width:400px">' +
        '<div id="box-sandbox" style="flex:1;background:#14141a;border:2px dashed #2a2a35;border-radius:16px;padding:32px 16px;text-align:center;cursor:pointer;transition:border-color 0.15s;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">' +
          '<span style="font-size:32px">🔌</span>' +
          '<span style="font-size:14px;font-weight:600;color:#e0e0e8">+ Sandbox</span>' +
          '<span style="font-size:11px;color:#71717a">' + (state.sandbox ? '✓ ' + state.sandbox : 'Tap to connect') + '</span>' +
        '</div>' +
        '<div id="box-model" style="flex:1;background:#14141a;border:2px dashed #2a2a35;border-radius:16px;padding:32px 16px;text-align:center;cursor:pointer;transition:border-color 0.15s;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">' +
          '<span style="font-size:32px">🤖</span>' +
          '<span style="font-size:14px;font-weight:600;color:#e0e0e8">+ Model</span>' +
          '<span style="font-size:11px;color:#71717a">' + (state.model ? '✓ ' + state.model : 'Tap to connect') + '</span>' +
        '</div>' +
      '</div>' +
      '</div>';

    // Wire up the boxes
    var boxSandbox = bodyEl.querySelector('#box-sandbox');
    var boxModel = bodyEl.querySelector('#box-model');

    boxSandbox.addEventListener('mouseover', function () { this.style.borderColor = '#4a4a5e'; });
    boxSandbox.addEventListener('mouseout', function () { this.style.borderColor = '#2a2a35'; });
    boxModel.addEventListener('mouseover', function () { this.style.borderColor = '#4a4a5e'; });
    boxModel.addEventListener('mouseout', function () { this.style.borderColor = '#2a2a35'; });

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
      window.ModelPicker.open(function (modelType) {
        // modelType is 'cloud' or 'local'
        if (modelType === 'cloud') {
          window.ProvidersScreen.open(function (provider, modelId) {
            state.model = modelId;
            state.provider = provider;
            updateSession(icon, state, { model: modelId, provider: provider });
            render(bodyEl, icon, panel);
          });
        } else {
          // local
          window.LocalModelsScreen.open(function (provider, modelId) {
            state.model = modelId;
            state.provider = provider;
            updateSession(icon, state, { model: modelId, provider: provider });
            render(bodyEl, icon, panel);
          });
        }
      });
    });
  }

  // ── Chat UI: messages + input + streaming ──────────────────────
  function renderChatUI(bodyEl, icon, state, panel) {
    bodyEl.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%">' +
        // Header: model badge + sandbox badge
        '<div style="flex-shrink:0;padding:8px 16px;border-bottom:1px solid #1a1a22;display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:11px;color:#71717a;background:#1a1a22;padding:3px 8px;border-radius:6px">' + state.sandbox + '</span>' +
          '<span style="font-size:11px;color:#4a4a5e;background:#1a1a22;padding:3px 8px;border-radius:6px">' + state.model + '</span>' +
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
      if (!state.client || !state.client.connected) {
        connectWS(bodyEl, icon, state, msgContainer, function () {
          doSend(text);
        });
      } else {
        doSend(text);
      }
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
