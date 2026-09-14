// chatpanel.js — v0.16 the GENERIC CHAT HOST.
//
// THE ARCHITECTURE (user spec, v0.16):
//   Everything chat-KIND-specific lives in a ChatType (chatframework.js —
//   QuickChat today; Termux + Hugging Face later). This host owns the
//   LAYOUT + STATE + PERSISTENCE and DELEGATES to the registered type:
//
//     ┌──────────────────────────────────────────────┐
//     │ ▸ ⚡ Quick Chat · NVIDIA · nemotron…  (pinned)│  ← collapsible header:
//     │ ┄┄┄ dropdown (hidden by default) ┄┄┄         │     tap the arrow to
//     │   [⚡ Quick Chat] [☁ NVIDIA]  (pills)        │     drop the pills down.
//     │   [⇩ export] [memory 40 ▾]     (utilities)  │     More pills ship per
//     └──────────────────────────────────────────────┘     chat type later.
//     ┌──────────────────────────────────────────────┐
//     │ do this quickly - setup the AI bot           │  ← THE GATELOCK: the
//     │ [ 🔌 + Sandbox ]  [ 🤖 + Model ]  (big boxes)│     start of the convo.
//     ├──────────────────────────────────────────────┤     NOT collapsible —
//     │  (chat + messages + toolbar + input appear   │     it scrolls with the
//     │   BELOW once the gate is fulfilled)          │     conversation.
//     └──────────────────────────────────────────────┘
//
// The gatelock heading + boxes are message-zero of the conversation: they
// never collapse (you scroll back to them), and once both boxes are filled
// the full chat overlay appears in the same flow.
//
// v0.15 carry-overs that still hold: per-turn session re-fetch (universal-401
// fix), absolute WS URLs, PM SDK bridge turns, idempotent event replay,
// sessionId→icon binding, per-message provider/model overrides.
//
// Exposes: window.ChatPanel

(function () {
  'use strict';

  var H = window.ChatTypes.helpers;
  var SANDBOX_LABELS = H.SANDBOX_LABELS;
  var SANDBOX_ICONS = H.SANDBOX_ICONS;

  // Per-chat state registry. Keyed by chat ID.
  var chatStates = {};

  function getOrCreateState(chatId, sessionData, icon) {
    if (!chatStates[chatId]) {
      chatStates[chatId] = {
        id: chatId,
        sessionId: sessionData && sessionData.ID ? sessionData.ID : null,
        sandbox: (sessionData && (sessionData.Sandbox || sessionData.sandbox)) || (icon && icon.sandbox) || '',
        model: (sessionData && (sessionData.Model || sessionData.model)) || (icon && icon.model) || '',
        provider: (sessionData && (sessionData.Provider || sessionData.provider)) || (icon && icon.provider) || '',
        effort: (sessionData && (sessionData.Effort || sessionData.effort)) || 'med',
        webSearch: !!(sessionData && (sessionData.WebSearch || sessionData.web_search)),
        deepResearch: !!(sessionData && (sessionData.DeepResearch || sessionData.deep_research)),
        slidingWindow: (sessionData && (sessionData.SlidingWindow || sessionData.sliding_window)) || 40,
        messages: [],
        isStreaming: false,
        draftText: '',
        client: null,
        dropdownOpen: false,  // v0.16: pills hidden by default until the arrow
        fulfilled: false,     // gatelock passed?
        lastEventI: 0         // idempotent replay dedup
      };
      if (icon) icon._sessionData = sessionData || null;
    }
    return chatStates[chatId];
  }

  // ── Render entry: build the host layout + delegate to the ChatType ──
  function render(bodyEl, icon, panel) {
    var state = getOrCreateState(icon.id, icon._sessionData, icon);
    renderHost(bodyEl, icon, state, panel);
  }

  function renderHost(bodyEl, icon, state, panel) {
    var type = window.ChatTypes.get(state.sandbox || 'quick');

    // Labels may land async (catalog fetch). v0.16: register the re-render
    // callback ONLY while labels are still pending — a bare .then on the
    // cached promise re-fired on EVERY render → infinite re-render loop.
    if (!H.hasLabels()) {
      H.ensureCatalog().then(function () {
        if (bodyEl.isConnected && !state._labelsDone) {
          state._labelsDone = true; // exactly ONE post-labels re-render
          renderHost(bodyEl, icon, state, panel);
        }
      });
    }

    var complete = type.isFulfilled(state);
    var justFulfilled = complete && !state.fulfilled;
    if (complete) state.fulfilled = true;

    // The context object handed to every ChatType hook.
    var ctx = buildCtx(bodyEl, icon, state, panel, type);

    // ── PINNED header: arrow + summary; dropdown hidden by default ──
    var headerHTML = renderHeader(type, state, ctx);

    // ── THE GATELOCK (start of the convo — never collapsible) ──
    var gateHTML = renderGatelock(type, state, ctx, complete);

    // ── The chat (only once the gate is fulfilled) ──
    var chatHTML = complete
      ? '<div id="chat-live" style="flex:1 1 auto;display:flex;flex-direction:column;min-height:55%">' +
          '<div id="chat-messages" style="flex:1;padding:16px;display:flex;flex-direction:column;gap:12px">' +
            (state.messages.length === 0
              ? '<div id="chat-greeting" style="text-align:center;color:#71717a;font-size:13px;padding:32px 20px">' +
                  esc(type.greeting) + ' ' + esc(icon.name) + '…</div>'
              : renderMessages(state.messages)) +
          '</div>' +
          // Sticky input bar — stays visible while scrolled.
          '<div id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:#0e0e12;border-top:1px solid #1a1a22;padding:10px 16px 12px;z-index:2">' +
          '<div id="chat-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>' +
          '<div style="display:flex;gap:8px">' +
            '<textarea id="chat-input" placeholder="' + esc(type.placeholder) + '" style="flex:1;background:#14141a;border:1px solid #2a2a35;color:#e0e0e8;padding:10px 12px;border-radius:8px;font-size:14px;font-family:inherit;resize:none;outline:none;min-height:40px;max-height:120px;line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
            '<button id="chat-send" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:0 16px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;align-self:flex-start;height:40px">Send</button>' +
          '</div>' +
          '</div>' +
        '</div>'
      : '';

    bodyEl.innerHTML =
      '<div id="chat-root" style="height:100%;display:flex;flex-direction:column;overflow:hidden">' +
        headerHTML +
        '<div id="chat-scroll" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;display:flex;flex-direction:column">' +
        gateHTML +
        chatHTML +
        '</div>' +
      '</div>';

    var scrollEl = bodyEl.querySelector('#chat-scroll');
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

    ctx.scrollEl = scrollEl;
    ctx.msgContainer = msgContainer;

    wireHeader(bodyEl, icon, state, type, ctx);
    wireGatelock(bodyEl, ctx);
    updateHeaderBtn(state, icon, bodyEl, panel);

    if (input && sendBtn) {
      buildToolbar(bodyEl, state, icon, type);

      input.addEventListener('input', function () {
        state.draftText = input.value;
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      sendBtn.addEventListener('click', send);

      // Connect the WS — only after the engine session exists, and prefer
      // re-binding the icon's previously persisted engine session so a
      // restart replays the SAME conversation (v0.15).
      // v0.16 SINGLE-FLIGHT: a re-render while the (async) bind is in
      // flight used to spawn a SECOND ChatClient — its replay raced the
      // first into a detached container. One bind, one client; later
      // renders only re-point onEvent at the CURRENT containers.
      if (state.client) {
        state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl); };
        // Self-heal: state already holds history but this fresh render
        // shows the greeting (the replay landed on a detached DOM) —
        // re-render the messages NOW.
        if (state.messages.length > 0 && msgContainer && msgContainer.querySelector('#chat-greeting')) {
          msgContainer.innerHTML = renderMessages(state.messages);
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
      } else if (!state._wsBinding) {
        state._wsBinding = bindEngineSession(icon, state, function () {
          state._wsBinding = null;
          if (state.sessionId) {
            connectWS(bodyEl, state, msgContainer);
          } else {
            ensureSession(icon, state, function () {
              if (bodyEl.querySelector('#chat-input')) connectWS(bodyEl, state, msgContainer);
            });
          }
        });
      }
      // (a bind already in flight: its callback will connectWS with the
      // containers it captured — and any LATER render re-points onEvent
      // via the state.client branch above.)
    }

    // The reveal: on first fulfillment, smooth-scroll past the gate so the
    // chat (greeting + input) is front and center.
    if (justFulfilled) {
      setTimeout(function () {
        var live = bodyEl.querySelector('#chat-live');
        if (live && scrollEl) scrollEl.scrollTo({ top: live.offsetTop - 6, behavior: 'smooth' });
      }, 120);
    } else if (state.fulfilled && state.messages.length) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function send() {
      var text = input.value.trim();
      if (!text || state.isStreaming) return;
      doSend(text);
    }

    function doSend(text) {
      state.messages.push({ role: 'user', text: text, local: true });
      appendMessage(msgContainer, scrollEl, { role: 'user', text: text });

      input.value = '';
      state.draftText = '';
      input.style.height = 'auto';

      state.isStreaming = true;
      sendBtn.textContent = 'Stop';
      sendBtn.onclick = function () { type.stop(state, ctx); };

      // PrivateMode turns must never wait for the engine WS.
      if (state.provider !== 'privatemodeai' && !(state.client && state.client.connected)) {
        if (!state.client && !state.sessionId) {
          ensureSession(icon, state, function () { connectWS(bodyEl, state, msgContainer); });
        } else if (state.client && state.client.state !== 'connecting' && state.client.state !== 'open') {
          state.client.connect();
        }
        sendBtn.textContent = '…';
        var tries = 0;
        var check = setInterval(function () {
          tries++;
          if (state.client && state.client.connected) {
            clearInterval(check);
            if (!state.isStreaming) sendBtn.textContent = 'Send';
            type.send(text, state, ctx);
          } else if (tries > 100) {
            clearInterval(check);
            sendBtn.textContent = 'Send';
            var err = 'Still connecting to the engine — tap Send again in a moment.' +
              (state.client && state.client.lastError ? ' (' + state.client.lastError + ')' : '');
            state.messages.push({ role: 'error', text: err });
            appendMessage(msgContainer, scrollEl, { role: 'error', text: err });
            state.isStreaming = false;
          }
        }, 100);
        return;
      }

      type.send(text, state, ctx);
    }
  }

  // ── The pinned collapsible header (arrow + summary + dropdown) ─────
  function renderHeader(type, state, ctx, complete) {
    var open = !!state.dropdownOpen;
    var summary = type.summaryLine(state);
    return (
      '<div id="chat-header" style="flex-shrink:0;background:#0e0e12;border-bottom:1px solid #1a1a22;z-index:3">' +
        '<div id="chat-header-row" style="display:flex;align-items:center;gap:8px;padding:7px 12px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer">' +
          '<button id="header-chevron" aria-label="Show chat controls" style="flex-shrink:0;background:transparent;border:none;color:#71717a;font-size:11px;cursor:pointer;padding:5px 4px;transition:transform 0.2s;transform:rotate(' + (open ? '90deg' : '0deg') + ')">▶</button>' +
          '<div id="chat-header-summary" style="flex:1;min-width:0;font-size:11px;font-weight:600;color:' + (complete ? '#a1a1aa' : '#71717a') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(summary) + '</div>' +
        '</div>' +
        '<div id="chat-dropdown" style="' + (open ? '' : 'display:none;') + 'padding:2px 12px 10px;border-bottom:1px solid #13131a">' +
          '<div id="pill-row" style="display:flex;align-items:center;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:4px 0 2px"></div>' +
          '<div id="util-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px"></div>' +
        '</div>' +
      '</div>');
  }

  // ── THE GATELOCK — the start of the convo, never collapsible ─────
  function renderGatelock(type, state, ctx, complete) {
    var steps = type.gatelockSteps(ctx);
    var boxes = '';
    var boxStyle = function (filled) {
      return 'flex:1;background:' + (filled ? '#181820' : '#14141a') + ';border:2px ' + (filled ? 'solid #34344a' : 'dashed #2a2a35') + ';border-radius:16px;padding:22px 14px;text-align:center;cursor:pointer;transition:border-color 0.15s;min-height:132px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;touch-action:manipulation;-webkit-tap-highlight-color:transparent';
    };
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var filled = !!s.filled;
      boxes +=
        '<div id="gate-box-' + s.key + '" data-gate-key="' + s.key + '" style="' + boxStyle(filled) + '">' +
          '<span style="font-size:26px">' + s.icon + '</span>' +
          '<span style="font-size:13px;font-weight:600;color:#e0e0e8">' + esc(s.title) + '</span>' +
          '<span style="font-size:11px;color:' + (filled ? '#34d399' : '#71717a') + '">' + esc(s.sub) + '</span>' +
        '</div>';
    }
    return (
      '<div id="gatelock" style="padding:18px 16px 10px;flex-shrink:0">' +
        '<h3 id="gatelock-title" style="font-size:15px;font-weight:700;color:#e0e0e8;margin:0 0 6px">' + esc(type.gatelockTitle(state)) + '</h3>' +
        '<p id="gatelock-intro" style="font-size:12px;color:#71717a;margin:0 0 14px;line-height:1.5">' + esc(type.gatelockIntro(state)) + '</p>' +
        '<div style="display:flex;gap:14px;width:100%;max-width:420px">' + boxes + '</div>' +
      '</div>');
  }

  // ── Wire the header: arrow toggles the dropdown; pills + utilities ──
  function wireHeader(bodyEl, icon, state, type, ctx) {
    var chevron = bodyEl.querySelector('#header-chevron');
    var row = bodyEl.querySelector('#chat-header-row');
    var dropdown = bodyEl.querySelector('#chat-dropdown');
    var pillRow = bodyEl.querySelector('#pill-row');
    var utilRow = bodyEl.querySelector('#util-row');

    var toggle = function () {
      state.dropdownOpen = !state.dropdownOpen;
      if (dropdown) dropdown.style.display = state.dropdownOpen ? '' : 'none';
      if (chevron) chevron.style.transform = 'rotate(' + (state.dropdownOpen ? '90deg' : '0deg') + ')';
    };
    if (row) row.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#pill-row, #util-row')) return; // taps INSIDE the dropdown don't toggle
      toggle();
    });
    if (chevron) chevron.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

    // The type's pills (change method of chat / model anytime).
    if (pillRow) {
      pillRow.innerHTML = '';
      var pills = type.pills(ctx);
      for (var i = 0; i < pills.length; i++) {
        (function (p) {
          var b = document.createElement('button');
          b.id = p.id;
          b.textContent = p.label;
          b.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;min-width:0;max-width:46%;' +
            'background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.55);color:#34d399;' +
            'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
            'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2;' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          b.addEventListener('click', function (e) { e.stopPropagation(); p.onTap(); });
          pillRow.appendChild(b);
        })(pills[i]);
      }
    }

    // Host utilities (available to every chat type): export + memory window.
    if (utilRow) {
      utilRow.innerHTML = '';

      // Export — the chat log, 3 formats (engine renders from the event log).
      var exp = document.createElement('button');
      exp.textContent = '⇩ export chat';
      exp.style.cssText = utilBtnStyle();
      exp.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!state.sessionId) { flashUtil(exp, 'nothing to export yet'); return; }
        window.open('/api/sessions/' + state.sessionId + '/export.csv', '_blank');
        flashUtil(exp, 'exported csv · md/json too');
      });
      utilRow.appendChild(exp);

      var expMd = document.createElement('button');
      expMd.textContent = 'md';
      expMd.style.cssText = utilBtnStyle(true);
      expMd.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!state.sessionId) return;
        window.open('/api/sessions/' + state.sessionId + '/export.md', '_blank');
      });
      utilRow.appendChild(expMd);

      var expJson = document.createElement('button');
      expJson.textContent = 'json';
      expJson.style.cssText = utilBtnStyle(true);
      expJson.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!state.sessionId) return;
        window.open('/api/sessions/' + state.sessionId + '/export.json', '_blank');
      });
      utilRow.appendChild(expJson);

      // Memory — the sliding context window (msgs sent as history).
      var mem = document.createElement('div');
      mem.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:#71717a;flex-shrink:0';
      var memBtn = document.createElement('button');
      memBtn.textContent = 'memory ' + (state.slidingWindow || 40);
      memBtn.style.cssText = utilBtnStyle();
      memBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        // cycle 10 → 20 → 40 → 80 → 160 → 10…
        var ladder = [10, 20, 40, 80, 160];
        var cur = state.slidingWindow || 40;
        var idx = ladder.indexOf(cur);
        state.slidingWindow = ladder[(idx + 1) % ladder.length];
        memBtn.textContent = 'memory ' + state.slidingWindow;
        updateSession(icon, state, { sliding_window: state.slidingWindow });
        flashUtil(memBtn, 'sends last ' + state.slidingWindow);
      });
      mem.appendChild(memBtn);
      utilRow.appendChild(mem);
    }
  }

  function utilBtnStyle(small) {
    return 'flex-shrink:0;background:transparent;border:1px solid #2a2a35;color:#71717a;padding:' +
      (small ? '4px 8px' : '4px 10px') + ';border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer';
  }

  function flashUtil(btn, msg) {
    var old = btn.textContent;
    btn.textContent = msg;
    btn.style.color = '#34d399';
    setTimeout(function () {
      if (btn.isConnected) { btn.textContent = old; btn.style.color = ''; }
    }, 1600);
  }

  // ── Wire the gatelock boxes ─────────────────────────────────────
  function wireGatelock(bodyEl, ctx) {
    var boxes = bodyEl.querySelectorAll('[data-gate-key]');
    boxes.forEach(function (box) {
      box.addEventListener('click', function () {
        var key = box.dataset.gateKey;
        var steps = ctx.type.gatelockSteps(ctx);
        for (var i = 0; i < steps.length; i++) {
          if (steps[i].key === key) { steps[i].onTap(); return; }
        }
      });
    });
  }

  // ── The ctx object: everything a ChatType can drive in the host ──
  function buildCtx(bodyEl, icon, state, panel, type) {
    var ctx = {
      type: type,
      state: state,
      icon: icon,
      panel: panel,
      bodyEl: bodyEl,
      scrollEl: null,
      msgContainer: null,

      applySandbox: function (sandboxType) {
        state.sandbox = sandboxType;
        if (icon) {
          icon.sandbox = sandboxType;
          if (typeof icon.setSandbox === 'function') icon.setSandbox(sandboxType);
          if (typeof icon.save === 'function') icon.save();
        }
        updateSession(icon, state, { sandbox: sandboxType });
        renderHost(bodyEl, icon, state, panel);
      },

      openModelPicker: function () {
        window.ModelPicker.open(function (provider, modelId) {
          ctx.applyModel(provider, modelId);
        });
      },

      applyModel: function (provider, modelId) {
        state.model = modelId;
        state.provider = provider;
        if (icon) {
          icon.model = modelId;
          icon.provider = provider;
          if (typeof icon.save === 'function') icon.save();
        }
        updateSession(icon, state, { model: modelId, provider: provider });
        renderHost(bodyEl, icon, state, panel);
      },

      rerender: function () { renderHost(bodyEl, icon, state, panel); },

      // ── Transports (the host owns the plumbing, the type picks) ──
      runWSTurn: function (text) {
        state.client.send(text, {
          effort: state.effort,
          web_search: !!state.webSearch,
          deep_research: !!state.deepResearch,
          model: state.model,
          provider: state.provider
        });
      },

      runPMTurn: function (text) { return runPMTurn(text, state, bodyEl, icon); }
    };
    return ctx;
  }

  // ── A PrivateMode turn (SDK bridge, runs in the WebView) ──────────
  function runPMTurn(text, state, bodyEl, icon) {
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    var sendBtn = bodyEl.querySelector('#chat-send');
    var abort = new AbortController();
    state._pmAbort = abort;
    if (sendBtn) sendBtn.onclick = function () { abort.abort(); };

    var history = [];
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m.role === 'user') history.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant' && m.complete) history.push({ role: 'assistant', content: m.text });
    }
    var win = state.slidingWindow || 40;
    if (history.length > win) history = history.slice(-win);

    var model = String(state.model || '');
    if (model.indexOf('privatemodeai/') === 0) model = model.slice('privatemodeai/'.length);

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
      for (var j = state.messages.length - 1; j >= 0; j--) {
        if (state.messages[j].progress) { state.messages.splice(j, 1); break; }
      }
      hintEl = null;
    };

    showHint('establishing PrivateMode secure channel…');

    var streamMsg = null;
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
        if (saved && saved.id && saved.id > (state.lastEventI || 0)) {
          state.lastEventI = saved.id;
        }
      }).catch(function (e) { console.error('persist PM event failed', e); });
    };

    var finish = function (errText) {
      clearHint();
      state.isStreaming = false;
      if (sendBtn) { sendBtn.textContent = 'Send'; sendBtn.onclick = null; }
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

    persist('user', text);

    return window.PMBridge.streamChat({
      model: model,
      messages: history,
      signal: abort.signal,
      // v0.16: web search for PM too — the bridge's ReAct loop calls the
      // engine tool routes; deep research stays engine-only (WS turns).
      tools: !!state.webSearch && !state.deepResearch,
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
      onTool: function (ev) {
        // ReAct progress chips — same shape as WS tool events.
        if (ev.name === 'web_search' && ev.sources) {
          var srcs = ev.sources.map(function (s) {
            return { title: s.title, url: s.url, snippet: s.snippet };
          });
          state.messages.push({ role: 'sources', sources: srcs });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
          persist('sources', JSON.stringify(srcs));
        }
        var chip = { role: 'tool', text: '⌕ ' + (ev.summary || ''), tool: true };
        if (ev.result) chip = { role: 'tool', text: '↳ ' + String(ev.result).slice(0, 200), result: true };
        state.messages.push(chip);
        appendMessage(msgContainer, scrollEl, chip);
        persist(chip.result ? 'tool_result' : 'tool_use',
          JSON.stringify({ name: ev.name, summary: ev.summary || '', text: ev.result || '' }));
      },
      onStatus: function (st) {
        if (st === 'running') showHint('establishing PrivateMode secure channel…');
      }
    }).then(function (result) {
      finish(null);
      return result;
    }).catch(function (e) {
      finish(e && e.message ? e.message : 'PrivateMode turn failed');
      return null;
    });
  }

  // ── The capability toolbar (effort ladder + web/deep toggles) ────
  function buildToolbar(bodyEl, state, icon, type) {
    var bar = bodyEl.querySelector('#chat-toolbar');
    if (!bar) return;
    H.ensureCatalog().then(function (catalog) {
      if (!bar.isConnected) return;
      var levels = effortLevelsFor(catalog, state.provider, state.model);
      renderToolbar(bar, state, levels, icon, bodyEl);
    }).catch(function () {});
  }

  // Find the effort ladder for the selected model from the live catalog.
  function effortLevelsFor(catalog, provider, modelId) {
    if (!catalog) return null;
    var detail = H.modelDetail(modelId);
    var slot = (provider || '') + '/' + detail;
    var groups = catalog.groups || [];
    for (var g = 0; g < groups.length; g++) {
      var models = groups[g].models || [];
      for (var m = 0; m < models.length; m++) {
        if (models[m].id === slot) return models[m].effortLevels || null;
      }
    }
    var logical = catalog.logical || [];
    for (var l = 0; l < logical.length; l++) {
      var hosts = logical[l].hosts || [];
      for (var h = 0; h < hosts.length; h++) {
        if (hosts[h].provider === provider && hosts[h].modelId === detail) {
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

    if (levels && levels.length > 0) {
      var curIdx = levels.indexOf(state.effort);
      var eb = document.createElement('button');
      eb.textContent = curIdx >= 0 ? 'effort · ' + state.effort : 'effort';
      eb.style.cssText = effortBtnStyle(curIdx >= 0);
      eb.addEventListener('click', function () {
        var idx = levels.indexOf(state.effort);
        state.effort = idx < 0 ? levels[0] : (idx + 1 < levels.length ? levels[idx + 1] : '');
        persistCaps(state, icon);
        renderToolbar(bar, state, levels, icon, bodyEl);
      });
      bar.appendChild(eb);
    }

    var wb = document.createElement('button');
    wb.textContent = '⌕ web';
    wb.style.cssText = capBtnStyle(state.webSearch, '#38bdf8');
    wb.addEventListener('click', function () {
      state.webSearch = !state.webSearch;
      if (state.webSearch) state.deepResearch = false;
      persistCaps(state, icon);
      renderToolbar(bar, state, levels, icon, bodyEl);
    });
    bar.appendChild(wb);

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

  // Persist capability flags + memory window on the engine session.
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
        deep_research: !!state.deepResearch,
        sliding_window: state.slidingWindow || 40
      })
    }).catch(function (e) { console.error('persist caps failed', e); });
  }

  // ── WebSocket connect ─────────────────────────────────────────
  function connectWS(bodyEl, state, msgContainer) {
    if (!state.sessionId) return; // never connect without a session (404s)
    if (state.client) {           // v0.16 single-flight: rebind, don't re-spawn
      state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, bodyEl.querySelector('#chat-scroll')); };
      return;
    }
    state.client = new window.ChatClient('', state.sessionId, '');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl); };
    state.client.connect();
  }

  // ensureSession creates the engine session (if missing) and calls back.
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
        deep_research: !!state.deepResearch,
        sliding_window: state.slidingWindow || 40
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ID) {
        state.sessionId = data.ID;
        icon._sessionData = data;
        bindSessionToIcon(icon, data.ID);
        cb();
      }
    }).catch(function (e) { console.error('create session failed', e); });
  }

  // Reattach to the ENGINE session the icon was bound to — a restart
  // replays the SAME conversation instead of forking a new one.
  function bindEngineSession(icon, state, cb) {
    if (state.sessionId) { cb(); return 'sync'; }
    var sid = icon && icon.sessionId;
    if (!sid) { ensureSession(icon, state, cb); return; }
    fetch('/api/sessions/' + sid).then(function (r) {
      if (r.status === 404) {
        if (icon) icon.sessionId = ''; // engine lost it — recreate
        return null;
      }
      return r.json();
    }).then(function (data) {
      if (data && data.ID) {
        state.sessionId = data.ID;
        icon._sessionData = data;
        if (!state.sandbox && data.Sandbox) state.sandbox = data.Sandbox;
        if (!state.model && data.Model) state.model = data.Model;
        if (!state.provider && data.Provider) state.provider = data.Provider;
        if (data.SlidingWindow) state.slidingWindow = data.SlidingWindow;
        cb();
      } else {
        ensureSession(icon, state, cb);
      }
    }).catch(function () { ensureSession(icon, state, cb); });
  }

  function bindSessionToIcon(icon, sessionId) {
    if (!icon) return;
    icon.sessionId = sessionId;
    if (typeof icon.save === 'function') icon.save();
  }

  // ── Handle a WS event (idempotent replay, streaming, errors) ─────
  function handleEvent(ev, state, msgContainer, scrollEl) {
    var type = ev.type;
    if (ev.i !== undefined && ev.i !== null && !isNaN(ev.i)) {
      if (ev.i <= (state.lastEventI || 0)) return;
      state.lastEventI = ev.i;
    }
    if (type === 'user') {
      var last = state.messages[state.messages.length - 1];
      if (last && last.role === 'user' && last.local && last.text === (ev.text || '')) {
        delete last.local;
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
      var assembled = '';
      for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'assistant') assembled += state.messages[i].text;
      }
      if ((ev.text || '') && assembled.indexOf(ev.text) === -1) {
        state.messages.push({ role: 'assistant', text: ev.text, complete: true });
        appendMessage(msgContainer, scrollEl, { role: 'assistant', text: ev.text, complete: true });
      }
    } else if (type === 'thinking') {
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
        if (msgContainer) {
          state.messages.push({ role: 'tool', text: '· ' + (ev.message || ev.text), progress: true });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1]);
        }
      }
    } else if (type === 'error') {
      state.isStreaming = false;
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
      return '<details style="align-self:stretch;max-width:95%;background:rgba(124,58,237,0.07);border:1px solid rgba(124,58,237,0.2);border-radius:10px;padding:8px 12px"' + (msg.open ? ' open' : '') + '>' +
        '<summary style="font-size:11px;color:#a78bfa;cursor:pointer;user-select:none">✻ thinking…</summary>' +
        '<div style="font-size:12px;color:#71717a;margin-top:6px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto">' + esc(msg.text) + '</div>' +
        '</details>';
    } else if (msg.role === 'tool') {
      var style = msg.progress
        ? 'color:#71717a;background:transparent;border:1px dashed #2a2a35'
        : (msg.result ? 'color:#34d399;background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.15)' : 'color:#38bdf8;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.2)');
      return '<div style="align-self:center;' + style + ';font-size:11px;padding:5px 10px;border-radius:8px;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(msg.text) + '</div>';
    } else if (msg.role === 'sources') {
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
    var greeting = container && container.querySelector('#chat-greeting');
    if (greeting && greeting.parentNode) greeting.parentNode.removeChild(greeting);
    var div = document.createElement('div');
    div.innerHTML = messageHTML(msg);
    var el = div.firstChild;
    container.appendChild(el);
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    else container.scrollTop = container.scrollHeight;
    return el;
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
          deep_research: !!state.deepResearch,
          sliding_window: state.slidingWindow || 40
        })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.ID) {
          state.sessionId = data.ID;
          icon._sessionData = data;
          bindSessionToIcon(icon, data.ID);
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

  // ── The far-left panel-header model button ("model · provider") ──
  function updateHeaderBtn(state, icon, bodyEl, panel) {
    var btn = document.getElementById('panel-model-btn');
    if (!btn) return;
    if (!state.model) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = 'flex';
    btn.innerHTML =
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(H.modelDetail(state.model)) + '</span>' +
      '<span style="color:#71717a;flex-shrink:0">· ' + esc(H.providerLabel(state.provider)) + ' ▾</span>';
    btn.onclick = function () {
      if (!window.ModelBrowser) return;
      window.ModelBrowser.open(function (provider, modelId) {
        state.model = modelId;
        state.provider = provider;
        if (icon) {
          icon.model = modelId;
          icon.provider = provider;
          if (typeof icon.save === 'function') icon.save();
        }
        updateSession(icon, state, { model: modelId, provider: provider });
        renderHost(bodyEl, icon, state, panel);
      });
    };
  }

  window.ChatPanel = {
    render: render,
    getState: function (id) { return chatStates[id]; }
  };
})();
