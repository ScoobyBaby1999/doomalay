// chatpanel.js — v0.17 the GENERIC CHAT HOST (formatted + artifacts).
//
// THE ARCHITECTURE (unchanged since v0.16):
//   Everything chat-KIND-specific lives in a ChatType (chatframework.js —
//   QuickChat today; Termux + Hugging Face later). This host owns the
//   LAYOUT + STATE + PERSISTENCE and DELEGATES to the registered type.
//
//     ┌──────────────────────────────────────────────┐
//     │ ▸ ⚡ Quick Chat · NVIDIA · nemotron…  (pinned)│  ← collapsible header:
//     │ ┄┄┄ dropdown (hidden by default) ┄┄┄         │     tap the arrow to
//     │   [⚡ Quick Chat] [☁ NVIDIA]  (pills)        │     drop the pills down.
//     │   [🗄 artifacts N] [⇩ export] [⌕] [memory]   │     More pills ship per
//     └──────────────────────────────────────────────┘     chat type later.
//     ┌──────────────────────────────────────────────┐
//     │ do this quickly - setup the AI bot           │  ← THE GATELOCK: the
//     │ [ 🔌 + Sandbox ]  [ 🤖 + Model ]  (big boxes)│     start of the convo.
//     ├──────────────────────────────────────────────┤     NOT collapsible —
//     │  (formatted chat + artifacts + toolbar +     │     it scrolls with the
//     │   input appear BELOW once the gate is met)   │     conversation.
//     └──────────────────────────────────────────────┘
//
// v0.17 additions:
//   - EVERY message renders through window.Formatter (markdown + scheme
//     colors + Prism code cards + tappable links) — assistant, thinking
//     AND user bubbles.
//   - Artifact pipeline: complete ```artifact file=… blocks in assistant
//     replies → saved to the engine (per-session) → artifact cards in the
//     message + the 🗄 drawer pill in the header dropdown.
//   - Tool pills are TAPPABLE: expand to show the full query/result.
//   - Sources render as rich tappable cards.
//   - Long-press a message → copy / quote / regenerate action sheet.
//   - In-chat search pill (creative extra) + auto-title after the first
//     exchange + thinking stats while reasoning streams.
//
// v0.15/16 carry-overs that still hold: per-turn session re-fetch,
// absolute WS URLs, PM SDK bridge turns, idempotent event replay,
// sessionId→icon binding, per-message provider/model overrides,
// single-flight WS binding.

(function () {
  'use strict';

  var H = window.ChatTypes.helpers;
  var SANDBOX_LABELS = H.SANDBOX_LABELS;
  var SANDBOX_ICONS = H.SANDBOX_ICONS;

  // Per-chat state registry. Keyed by chat ID.
  var chatStates = {};
  var currentCtx = null; // the chat currently shown in the panel

  // The DEFAULT persona (v0.20): our artifact protocol MERGED with the old
  // HF space's system-prompt style (direct/concise, explicit model identity,
  // tool discipline). {model} and {provider} are substituted at composition
  // time — client-side for PM turns (pmSystemMessage), server-side for
  // engine turns (chat.go's defaultPersona) — so the persona always knows
  // exactly which model it currently is, even after mid-convo switches.
  var DEFAULT_PERSONA =
    '## Identity\n' +
    'You are {model} (served via {provider}), chatting inside the Doomalay app on the user\'s own device. ' +
    'If the user asks which model you are, tell them exactly that — never guess and never claim to be a different model. ' +
    'This identity updates automatically when the user switches your model mid-conversation; trust it over any prior assumption.\n\n' +
    '## Style\n' +
    'Be direct and concise; lead with the outcome, not the process. ' +
    'Use markdown freely — headings, lists, bold, links and fenced code blocks all render nicely in this app. ' +
    'When a live fact matters and web search is enabled, search rather than guess. ' +
    'When you don\'t know something, say so.\n\n' +
    '## Tools\n' +
    'When the app\'s tool protocol is active, invoke tools ONLY through the protocol\'s ACTION line format — never as plain text. ' +
    'Cite search sources inline as [1], [2] matching the result numbering, and never fabricate URLs.\n\n' +
    '## Artifacts\n' +
    'You are chatting inside the Doomalay app, which has an artifact system.\n' +
    'When the user asks for a file, document, dataset, or any standalone deliverable — or when you produce a substantial complete artifact-like output — attach it as an ARTIFACT in addition to (or instead of) your normal answer.\n' +
    'Artifact format (a fenced code block whose info string starts with "artifact"):\n' +
    '  ```artifact file=<filename.ext>\n  <the complete file content as plain text>\n  ```\n' +
    'For binary file types (e.g. .docx, .xlsx, .pdf, .zip, images) provide the bytes base64-encoded instead:\n' +
    '  ```artifact file=<filename> encoding=base64\n  <base64 payload>\n  ```\n' +
    'Rules:\n' +
    '- Prefer text formats when the user has no strong preference (.md, .txt, .json, .csv, .html, code files, config files).\n' +
    '- Use a real, descriptive filename with the correct extension.\n' +
    '- The artifact block must contain the COMPLETE file, never truncated.\n' +
    '- Keep the spoken answer short and mention the attached file name.\n' +
    '- Regular markdown (headings, lists, bold, links, code blocks) is rendered nicely — use it freely.';

  // The artifact protocol ALONE — appended to custom personas that lack it.
  var ARTIFACT_PROMPT = DEFAULT_PERSONA.slice(DEFAULT_PERSONA.indexOf('## Artifacts'));

  // v0.20: pretty model display name — "privatemodeai/kimi-k2.6" →
  // "kimi-k2.6" (mirrors the engine's prettyModelName).
  function prettyModel(slot) {
    var s = String(slot || '').trim();
    if (!s) return '';
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // v0.20: {model}/{provider} substitution for persona texts (client-side
  // — PM turns compose the system message here, engine turns in Go).
  function substituteVars(text, model, provider) {
    if (!text) return text;
    var m = prettyModel(model) || 'an AI assistant';
    var p = String(provider || '').trim() || 'an unknown provider';
    return String(text)
      .split('{model}').join(m)
      .split('{provider}').join(p);
  }

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
        persona: (sessionData && (sessionData.Persona || sessionData.persona)) || '',
        slidingWindow: (sessionData && (sessionData.SlidingWindow || sessionData.sliding_window)) || 40,
        messages: [],
        isStreaming: false,
        draftText: '',
        client: null,
        dropdownOpen: false,  // pills hidden by default until the arrow
        fulfilled: false,     // gatelock passed?
        lastEventI: 0,        // idempotent replay dedup
        artifactsCount: 0,
        artifactSaved: {},    // msg-index → true (avoid re-saving)
        search: null,         // in-chat search state {q, matches}
        _icon: icon
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
    currentCtx = { bodyEl: bodyEl, icon: icon, state: state, panel: panel, type: type };

    // Labels may land async (catalog fetch): exactly ONE post-labels re-render.
    if (!H.hasLabels()) {
      H.ensureCatalog().then(function () {
        if (bodyEl.isConnected && !state._labelsDone && currentCtx &&
            currentCtx.state === state) {
          state._labelsDone = true;
          renderHost(bodyEl, icon, state, panel);
        }
      });
    }

    var complete = type.isFulfilled(state);
    var justFulfilled = complete && !state.fulfilled;
    if (complete) state.fulfilled = true;

    var ctx = buildCtx(bodyEl, icon, state, panel, type);
    currentCtx.ctx = ctx;

    // ── PINNED header: arrow + summary; dropdown hidden by default ──
    var headerHTML = renderHeader(type, state, ctx, complete);

    // ── THE GATELOCK (start of the convo — never collapsible) ──
    var gateHTML = renderGatelock(type, state, ctx, complete);

    // ── The chat (only once the gate is fulfilled) ──
    var chatHTML = complete
      ? '<div id="chat-live" style="flex:1 1 auto;display:flex;flex-direction:column;min-height:55%">' +
          '<div id="chat-searchbar" style="display:none;padding:6px 16px"></div>' +
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

    // mount formatting into every rendered bubble (renderMessages emits
    // empty shells; the Formatter fills user/assistant/thinking)
    mountAllFormatting(msgContainer, state);

    ctx.scrollEl = scrollEl;
    ctx.msgContainer = msgContainer;

    wireHeader(bodyEl, icon, state, type, ctx);
    wireGatelock(bodyEl, ctx);
    updateHeaderBtn(state, icon, bodyEl, panel);

    // artifacts session binding + badge
    if (state.sessionId) {
      window.Artifacts.setSession(state.sessionId, { name: icon.name });
      refreshArtifactCount(state, bodyEl);
    }

    // long-press message actions (copy / quote / regenerate)
    if (msgContainer) {
      window.MsgActions.wire(msgContainer, {
        onQuote: function (text) {
          var q = String(text).split('\n').map(function (l) { return '> ' + l; }).join('\n');
          var ta = bodyEl.querySelector('#chat-input');
          if (ta) {
            ta.value = q + '\n\n' + ta.value;
            state.draftText = ta.value;
            ta.focus();
            ta.scrollTop = ta.scrollHeight;
          }
        },
        onRegenerate: function () {
          if (state.isStreaming) return;
          // drop trailing assistant messages, resend the last user text
          var lastUser = null;
          for (var i = state.messages.length - 1; i >= 0; i--) {
            if (state.messages[i].role === 'user') { lastUser = state.messages[i]; break; }
          }
          if (!lastUser) return;
          while (state.messages.length && state.messages[state.messages.length - 1].role !== 'user') {
            state.messages.pop();
          }
          if (msgContainer) msgContainer.innerHTML = renderMessages(state.messages);
          doSend(lastUser.text, bodyEl, icon, state, panel);
        }
      });
    }

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

      // Connect the WS — only after the engine session exists; rebind the
      // icon's persisted session so a restart replays the SAME conversation.
      // SINGLE-FLIGHT: one bind, one client; later renders re-point onEvent.
      if (state.client) {
        state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl, bodyEl, icon, panel); };
        if (state.messages.length > 0 && msgContainer && msgContainer.querySelector('#chat-greeting')) {
          msgContainer.innerHTML = renderMessages(state.messages);
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
      } else if (!state._wsBinding) {
        state._wsBinding = bindEngineSession(icon, state, function () {
          state._wsBinding = null;
          if (state.sessionId) {
            window.Artifacts.setSession(state.sessionId, { name: icon.name });
            refreshArtifactCount(state, bodyEl);
            connectWS(bodyEl, state, msgContainer);
          } else {
            ensureSession(icon, state, function () {
              if (state.sessionId) window.Artifacts.setSession(state.sessionId, { name: icon.name });
              refreshArtifactCount(state, bodyEl);
              if (bodyEl.querySelector('#chat-input')) connectWS(bodyEl, state, msgContainer);
            });
          }
        });
      }
    }

    // The reveal: on first fulfillment, smooth-scroll past the gate.
    if (justFulfilled) {
      setTimeout(function () {
        var live = bodyEl.querySelector('#chat-live');
        if (live && scrollEl) scrollEl.scrollTo({ top: live.offsetTop - 6, behavior: 'smooth' });
      }, 120);
    } else if (state.fulfilled && state.messages.length) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    if (state.search && state.search.q) renderSearchbar(bodyEl, state, icon, panel);

    function send() {
      var text = input.value.trim();
      if (!text || state.isStreaming) return;
      doSend(text, bodyEl, icon, state, panel);
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
      if (e.target.closest && e.target.closest('#pill-row, #util-row')) return;
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

      // v0.17: THE ARTIFACT DRAWER PILL (per user spec: in the collapsible
      // header dropdown). Badge shows this chat's artifact count.
      var art = document.createElement('button');
      art.id = 'pill-artifacts';
      art.className = 'pill-artifacts';
      art.innerHTML = '🗄 <span id="pill-artifacts-count">' + (state.artifactsCount || 0) + '</span>';
      art.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
        'background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.55);color:#38bdf8;' +
        'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2';
      art.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.sessionId) window.Artifacts.openDrawer(state.sessionId, { name: icon.name });
        else window.Artifacts.toast('connect a model first');
      });
      pillRow.appendChild(art);

      // v0.19: THE PERSONA PILL — opens this chat's persona editor (its
      // editable system prompt + the live identity line the engine
      // prepends every turn).
      var per = document.createElement('button');
      per.id = 'pill-persona';
      per.innerHTML = '🎭 persona';
      per.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
        'background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.55);color:#a78bfa;' +
        'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2';
      per.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.sessionId && window.Persona) {
          window.Persona.open(state.sessionId, { name: icon.name, model: state.model, provider: state.provider });
        } else if (window.Artifacts) {
          window.Artifacts.toast('connect a model first');
        }
      });
      pillRow.appendChild(per);
    }

    // Host utilities: export + memory window + in-chat search.
    if (utilRow) {
      utilRow.innerHTML = '';

      // In-chat search (creative extra) — filter + highlight messages.
      var search = document.createElement('button');
      search.textContent = '⌕ search';
      search.style.cssText = utilBtnStyle();
      search.addEventListener('click', function (e) {
        e.stopPropagation();
        state.search = state.search && state.search.open ? null : { open: true, q: '' };
        renderSearchbar(bodyEl, state, icon, ctx.panel);
      });
      utilRow.appendChild(search);

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

      // Memory — the sliding context window.
      var mem = document.createElement('div');
      mem.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:#71717a;flex-shrink:0';
      var memBtn = document.createElement('button');
      memBtn.textContent = 'memory ' + (state.slidingWindow || 40);
      memBtn.style.cssText = utilBtnStyle();
      memBtn.addEventListener('click', function (e) {
        e.stopPropagation();
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

  // ── the in-chat search bar ─────────────────────────────────────
  function renderSearchbar(bodyEl, state, icon, panel) {
    var bar = bodyEl.querySelector('#chat-searchbar');
    if (!bar) return;
    var search = state.search;
    if (!search || !search.open) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.innerHTML =
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input id="chat-search-input" type="text" placeholder="search this conversation…" value="' + escAttr(search.q) + '" ' +
          'style="flex:1;background:#14141a;border:1px solid #2a2a35;color:#e0e0e8;padding:8px 12px;border-radius:8px;font-size:13px;font-family:inherit;outline:none">' +
        '<button id="chat-search-close" style="background:transparent;border:none;color:#71717a;font-size:18px;cursor:pointer;padding:4px 8px">✕</button>' +
      '</div>' +
      '<div id="chat-search-info" style="font-size:11px;color:#71717a;margin-top:4px"></div>';
    var inp = bar.querySelector('#chat-search-input');
    var info = bar.querySelector('#chat-search-info');
    var closeBtn = bar.querySelector('#chat-search-close');

    var run = function () {
      search.q = inp.value;
      var n = highlightMatches(bodyEl, state, search.q);
      info.textContent = search.q ? (n ? n + ' match' + (n > 1 ? 'es' : '') : 'no matches') : '';
    };
    var deb = null;
    inp.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(run, 200);
    });
    closeBtn.addEventListener('click', function () {
      state.search = null;
      clearHighlights(bodyEl);
      bar.style.display = 'none';
      var msgC = bodyEl.querySelector('#chat-messages');
      if (msgC) { msgC.innerHTML = renderMessages(state.messages); scrollBottom(bodyEl); }
    });
    if (search.q) run();
  }

  function highlightMatches(bodyEl, state, q) {
    clearHighlights(bodyEl);
    if (!q || q.length < 2) return 0;
    var count = 0;
    var walker = document.createTreeWalker(bodyEl.querySelector('#chat-messages'), NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      if (!n.nodeValue || n.parentNode.closest('.fmt-codecard, script, style, textarea')) return;
      var idx = n.nodeValue.toLowerCase().indexOf(q.toLowerCase());
      if (idx < 0) return;
      count++;
      // wrap the match in a <mark>
      var range = document.createRange();
      range.setStart(n, idx); range.setEnd(n, idx + q.length);
      var mark = document.createElement('mark');
      mark.className = 'chat-search-mark';
      try { range.surroundContents(mark); } catch (e) {}
      var target = mark.closest('.msg-bubble') || mark;
      if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
    });
    return count;
  }
  function clearHighlights(bodyEl) {
    bodyEl.querySelectorAll('mark.chat-search-mark').forEach(function (m) {
      var p = m.parentNode;
      if (!p) return;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    });
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

  // v0.19: canonicalize a picked model to the SLOT format —
  // 'provider/' + the id the provider's own API expects. The provider view
  // passes raw ids ('nvidia/nemotron-…'), one-press passes slots
  // ('nvidia/nvidia/nemotron-…') — both normalize to the same thing, and the
  // engine strips exactly ONE provider prefix per turn. This WAS the
  // "switched the model mid convo and the new model doesn't reply" bug:
  // raw NVIDIA ids lost their org prefix in ResolveModel → NIM 404.
  function canonicalModel(provider, modelId) {
    var mid = String(modelId || '');
    if (provider && mid && mid.indexOf(provider + '/') !== 0) {
      mid = provider + '/' + mid;
    }
    return mid;
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
        // v0.17: picking a model from THIS chat type's gatelock implies
        // the type itself (one-press connect: no separate sandbox step
        // needed when the user goes straight for a cloud provider).
        if (!state.sandbox) state.sandbox = type.id;
        state.model = canonicalModel(provider, modelId);
        state.provider = provider;
        if (icon) {
          icon.model = state.model;
          icon.provider = provider;
          icon.sandbox = state.sandbox;
          if (typeof icon.setSandbox === 'function') icon.setSandbox(state.sandbox);
          if (typeof icon.save === 'function') icon.save();
        }
        updateSession(icon, state, { model: state.model, provider: provider, sandbox: state.sandbox });
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

  // v0.19: the PM system message mirrors the engine's systemPromptFor —
  // a live identity line + the chat's persona (or the default persona) +
  // the artifact protocol when the persona doesn't carry it. PM turns
  // bypass the engine, so the composition lives client-side.
  // v0.20 FIX: this used to receive `model` BEFORE it was defined (a
  // hoisted var) — every PM turn told the bot it was "an AI assistant
  // hosted via privatemodeai" with NO model name. The model is now
  // resolved before composition, and {model}/{provider} placeholders
  // inside the persona are substituted with the live values.
  function pmSystemMessage(state, model) {
    var displayName = prettyModel(model);
    var head = 'You are ' + (displayName || 'an AI assistant') +
      (state.provider ? ', hosted via ' + state.provider : '') +
      ", chatting inside the Doomalay app on the user's own device. Today is " +
      new Date().toDateString() + '.';
    var persona = (state.persona || '').trim();
    var sys = head + '\n\n' + (substituteVars(persona || DEFAULT_PERSONA, model, state.provider));
    if (persona && !/artifact/i.test(persona)) sys += '\n\n' + ARTIFACT_PROMPT;
    return sys;
  }

  function runPMTurn(text, state, bodyEl, icon) {
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    var sendBtn = bodyEl.querySelector('#chat-send');
    var abort = new AbortController();
    state._pmAbort = abort;
    if (sendBtn) sendBtn.onclick = function () { abort.abort(); };

    // v0.20 FIX: resolve the model BEFORE composing the history — the old
    // order called pmSystemMessage(state, model) while `model` was still
    // an undefined hoisted var, so PM bots never knew their own model.
    var model = String(state.model || '');
    if (model.indexOf('privatemodeai/') === 0) model = model.slice('privatemodeai/'.length);

    var history = [{ role: 'system', content: pmSystemMessage(state, model) }]; // v0.19: persona + identity + artifact protocol
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m.role === 'user') history.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant' && m.complete) history.push({ role: 'assistant', content: m.text });
    }
    var win = state.slidingWindow || 40;
    if (history.length > win + 1) history = history.slice(0, 1).concat(history.slice(-(win)));

    var hintEl = null;
    var showHint = function (msg) {
      if (!hintEl) {
        var hint = { role: 'tool', text: '· ' + msg, progress: true };
        state.messages.push(hint);
        hintEl = appendMessage(msgContainer, scrollEl, hint, bodyEl, icon);
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
        appendMessage(msgContainer, scrollEl, streamMsg, bodyEl, icon);
      }
      return streamMsg;
    };

    var persist = function (type, payload) {
      if (!state.sessionId) return Promise.resolve();
      return fetch('/api/sessions/' + state.sessionId + '/events', {
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
        updateMessageEl(bodyEl, streamMsg, true);
        finalizeArtifacts(streamMsg, state, bodyEl); // v0.17
      }
      // v0.20: CHAIN the persists — the old fire-and-forget raced the
      // assistant + status fetches, and the status could land in the log
      // BEFORE the assistant text (replayed histories read out of order).
      var p = streamMsg && streamMsg.text ? persist('assistant', streamMsg.text) : Promise.resolve();
      p.then(function () {
        if (errText) {
          return persist('error', errText).then(function () {
            state.messages.push({ role: 'error', text: errText });
            appendMessage(msgContainer, scrollEl, { role: 'error', text: errText }, bodyEl, icon);
            return persist('status', JSON.stringify({ state: 'error', usage: null }));
          });
        }
        return persist('status', JSON.stringify({ state: 'idle', usage: null }));
      });
    };

    persist('user', text);

    return window.PMBridge.streamChat({
      model: model,
      messages: history,
      signal: abort.signal,
      tools: !!state.webSearch && !state.deepResearch,
      onThinking: function (t) {
        clearHint();
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'thinking') {
          last = { role: 'thinking', text: '', open: true, startedAt: Date.now() };
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last, bodyEl, icon);
        }
        last.text += t;
        updateMessageEl(bodyEl, last, false);
      },
      onDelta: function (t) {
        clearHint();
        var m2 = getStreamMsg();
        m2.text += t;
        updateMessageEl(bodyEl, m2, false);
      },
      onTool: function (ev) {
        if (ev.name === 'web_search' && ev.sources) {
          var srcs = ev.sources.map(function (s) {
            return { title: s.title, url: s.url, snippet: s.snippet };
          });
          state.messages.push({ role: 'sources', sources: srcs });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, icon);
          persist('sources', JSON.stringify(srcs));
        }
        var chip = { role: 'tool', text: ev.summary || '', tool: true, payload: ev };
        if (ev.result) chip = { role: 'tool', text: ev.summary || '', result: true, payload: ev };
        state.messages.push(chip);
        appendMessage(msgContainer, scrollEl, chip, bodyEl, icon);
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
    if (!state.sessionId) return;
    if (state.client) {
      state.client.onEvent = function (ev) {
        handleEvent(ev, state, msgContainer, bodyEl.querySelector('#chat-scroll'), bodyEl, null, null);
      };
      return;
    }
    state.client = new window.ChatClient('', state.sessionId, '');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl, bodyEl, null, null); };
    state.client.connect();
  }

  // ensureSession creates the engine session (if missing) and calls back.
  function ensureSession(icon, state, cb) {
    if (state.sessionId) { cb(); return; }
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionBody(icon, state))
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ID) {
        state.sessionId = data.ID;
        icon._sessionData = data;
        bindSessionToIcon(icon, data.ID);
        cb();
      }
    }).catch(function (e) { console.error('create session failed', e); });
  }

  function sessionBody(icon, state) {
    return {
      title: icon.name,
      sandbox: state.sandbox,
      model: state.model,
      provider: state.provider,
      effort: state.effort || 'med',
      web_search: !!state.webSearch,
      deep_research: !!state.deepResearch,
      sliding_window: state.slidingWindow || 40
    };
  }

  // Reattach to the ENGINE session the icon was bound to.
  function bindEngineSession(icon, state, cb) {
    if (state.sessionId) { cb(); return 'sync'; }
    var sid = icon && icon.sessionId;
    if (!sid) { ensureSession(icon, state, cb); return; }
    fetch('/api/sessions/' + sid).then(function (r) {
      if (r.status === 404) {
        if (icon) icon.sessionId = '';
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
        // v0.20 FIX: restore the FULL capability set from the engine
        // session — the old restore dropped web_search/deep_research/effort/
        // persona, so a PM chat with the web toggle ON silently lost its
        // tools after every reload (the state defaulted them to off).
        if (typeof data.WebSearch === 'boolean') state.webSearch = data.WebSearch;
        if (typeof data.DeepResearch === 'boolean') state.deepResearch = data.DeepResearch;
        if (data.Effort) state.effort = data.Effort;
        if (typeof data.Persona === 'string' && data.Persona) state.persona = data.Persona;
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
  function handleEvent(ev, state, msgContainer, scrollEl, bodyEl, _icon, _panel) {
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
      appendMessage(msgContainer, scrollEl, { role: 'user', text: ev.text || '' }, bodyEl, state._icon);
      // v0.19: NO auto-title — the chat keeps its default random name from
      // the list until the user renames it themselves (tap the name in the
      // panel header).
      return;
    }
    if (type === 'assistant_delta' || type === 'assistant_complete') {
      if (ev.text) {
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.complete) {
          last = { role: 'assistant', text: '', complete: false, streaming: true };
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last, bodyEl, state._icon);
        }
        last.text += ev.text;
        scheduleUpdate(bodyEl, last, false);
      }
      if (type === 'assistant_complete') {
        var last2 = state.messages[state.messages.length - 1];
        if (last2) {
          last2.complete = true;
          last2.streaming = false;
          updateMessageEl(bodyEl, last2, true);
          finalizeArtifacts(last2, state, bodyEl);
        }
      }
    } else if (type === 'assistant') {
      var assembled = '';
      for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'assistant') assembled += state.messages[i].text;
      }
      if ((ev.text || '') && assembled.indexOf(ev.text) === -1) {
        var full = { role: 'assistant', text: ev.text, complete: true };
        state.messages.push(full);
        appendMessage(msgContainer, scrollEl, full, bodyEl, state._icon);
        finalizeArtifacts(full, state, bodyEl);
      } else if (ev.text) {
        // v0.17: the trailing full-reply event confirms the streamed text
        // (the engine has NO assistant_complete event — THIS + status idle
        // are the completion signals). Mark the streaming message done and
        // finalize artifacts.
        for (var j = state.messages.length - 1; j >= 0; j--) {
          if (state.messages[j].role === 'assistant') {
            if (!state.messages[j].complete) {
              state.messages[j].complete = true;
              state.messages[j].streaming = false;
              updateMessageEl(bodyEl, state.messages[j], true);
              finalizeArtifacts(state.messages[j], state, bodyEl);
            }
            break;
          }
        }
      }
    } else if (type === 'thinking') {
      var lastThink = state.messages[state.messages.length - 1];
      if (!lastThink || lastThink.role !== 'thinking') {
        lastThink = { role: 'thinking', text: '', open: true, startedAt: Date.now() };
        state.messages.push(lastThink);
        appendMessage(msgContainer, scrollEl, lastThink, bodyEl, state._icon);
      }
      lastThink.text += ev.text;
      scheduleUpdate(bodyEl, lastThink, false);
    } else if (type === 'tool_use') {
      // v0.20: PM-persisted tool events carry their payload as a JSON text
      // (the engine's own events have name/summary top-level) — lift it.
      var pay = ev;
      if ((!pay.name || pay.summary === undefined) && pay.text) {
        try { pay = JSON.parse(pay.text); } catch (e) {}
      }
      state.messages.push({ role: 'tool', text: pay.summary || pay.name || 'tool', tool: true, payload: pay });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
    } else if (type === 'tool_result') {
      var pay2 = ev;
      if ((!pay2.name || pay2.summary === undefined) && pay2.text) {
        try { pay2 = JSON.parse(pay2.text); } catch (e) {}
      }
      state.messages.push({ role: 'tool', text: pay2.summary || pay2.name || '', result: true, payload: pay2 });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
    } else if (type === 'sources') {
      var srcs = ev.sources || [];
      if (!srcs.length && ev.text) { try { srcs = JSON.parse(ev.text); } catch (e) {} }
      if (srcs.length) {
        state.messages.push({ role: 'sources', sources: srcs });
        appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
      }
    } else if (type === 'status') {
      if (ev.state === 'idle' || ev.state === 'error') {
        state.isStreaming = false;
        // v0.17 belt-and-suspenders: status idle IS a completion signal —
        // mark any still-streaming message done + finalize artifacts (the
        // trailing 'assistant' event normally does this; some providers
        // skip or reorder it).
        for (var k = state.messages.length - 1; k >= 0; k--) {
          var sm = state.messages[k];
          if (sm.role === 'assistant' || sm.role === 'thinking') {
            if (!sm.complete && sm.role === 'assistant') {
              sm.complete = true;
              sm.streaming = false;
              updateMessageEl(bodyEl, sm, true);
              finalizeArtifacts(sm, state, bodyEl);
            } else if (sm.role === 'thinking' && sm.streaming) {
              sm.streaming = false;
              updateMessageEl(bodyEl, sm, true);
            }
            break;
          }
        }
        var btn = document.querySelector('#chat-send');
        if (btn) { btn.textContent = 'Send'; btn.onclick = null; }
      } else if (ev.state === 'running' && (ev.text || ev.message)) {
        if (msgContainer) {
          state.messages.push({ role: 'tool', text: ev.message || ev.text, progress: true });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
        }
      }
    } else if (type === 'error') {
      state.isStreaming = false;
      var errText = ev.message || ev.error || ev.text || 'Unknown error';
      if (ev.provider) {
        errText += ' (via ' + ev.provider + (ev.model ? ' · ' + ev.model : '') + ')';
      }
      state.messages.push({ role: 'error', text: errText });
      appendMessage(msgContainer, scrollEl, { role: 'error', text: errText }, bodyEl, state._icon);
      var btn2 = document.querySelector('#chat-send');
      if (btn2) { btn2.textContent = 'Send'; btn2.onclick = null; }
    }
  }

  // throttled re-render for streaming (markdown every ~180ms, not per delta)
  function scheduleUpdate(bodyEl, msg, immediate) {
    if (immediate) { updateMessageEl(bodyEl, msg, true); return; }
    msg._renderTimer = msg._renderTimer || 0;
    var now = Date.now();
    if (now - msg._renderTimer > 180) {
      msg._renderTimer = now;
      updateMessageEl(bodyEl, msg, false);
    } else if (!msg._renderPending) {
      msg._renderPending = setTimeout(function () {
        msg._renderPending = null;
        msg._renderTimer = Date.now();
        updateMessageEl(bodyEl, msg, false);
      }, 180);
    }
  }

  // ── v0.17: artifact finalize (extract + save + refresh badge) ───
  function finalizeArtifacts(msg, state, bodyEl) {
    if (!msg || !msg.text || !state.sessionId) return;
    var key = state.messages.indexOf(msg);
    if (state.artifactSaved[key]) return;
    var ex = window.Formatter.extractArtifacts(msg.text);
    if (!ex.artifacts.length) { state.artifactSaved[key] = true; return; }
    state.artifactSaved[key] = true;
    ex.artifacts.forEach(function (art) {
      window.Artifacts.saveFromMessage(state.sessionId, art).then(function () {
        refreshArtifactCount(state, bodyEl);
      }).catch(function (e) { console.error('artifact save failed', e); });
    });
    updateMessageEl(bodyEl, msg, true); // re-render → artifact cards appear
  }

  function refreshArtifactCount(state, bodyEl) {
    if (!state.sessionId) return;
    window.Artifacts.list(state.sessionId).then(function (items) {
      state.artifactsCount = items.length;
      var badge = (bodyEl || document).querySelector('#pill-artifacts-count');
      if (badge) badge.textContent = String(items.length);
    }).catch(function () {});
  }

  // ── THE MESSAGE RENDERER (everything formatted) ────────────────
  function renderMessages(messages) {
    var html = '';
    for (var i = 0; i < messages.length; i++) {
      html += messageHTML(messages[i], i);
    }
    return html;
  }

  // The bubble wrapper + Formatter content. Long-press handlers read
  // data-msg-role / data-msg-raw. data-mi = message index (streaming
  // updates re-find the bubble by it).
  function messageHTML(msg, mi) {
    mi = (mi === undefined || mi === null) ? -1 : mi;
    var miAttr = ' data-mi="' + mi + '"';
    if (msg.role === 'user') {
      return '<div class="msg-bubble msg-user" data-msg-role="user" data-msg-raw="' + escAttr(msg.text) + '"' + miAttr + '></div>';
    } else if (msg.role === 'assistant') {
      return '<div class="msg-bubble msg-assistant" data-msg-role="assistant" data-msg-raw="' + escAttr(msg.text) + '"' + miAttr + '></div>';
    } else if (msg.role === 'error') {
      return '<div class="msg-bubble msg-error" data-msg-role="error"' + miAttr + '>' +
        '<div class="fmt fmt-plain">' + esc(msg.text) + '</div></div>';
    } else if (msg.role === 'thinking') {
      return '<details class="msg-think"' + miAttr + ' ' + (msg.open ? ' open' : '') + '>' +
        '<summary class="msg-think-summary"><span class="msg-think-dot">✻</span> thinking' +
          (msg.streaming ? '<span class="msg-think-live"></span>' : '') + '</summary>' +
        '<div class="msg-bubble msg-think-body" data-msg-role="thinking"></div>' +
        '</details>';
    } else if (msg.role === 'tool') {
      // TAPPABLE TOOL PILL — expands to the full payload (query / result).
      var payload = msg.payload || null;
      var hasDetail = !!(payload && ((payload.query || payload.name && (payload.result || payload.text || payload.summary)) || (payload.sources && payload.sources.length)));
      var expanded = !!msg.expanded && hasDetail;
      var cls = msg.progress ? 'tool-pill tool-pill-progress' :
        (msg.result ? 'tool-pill tool-pill-result' : 'tool-pill tool-pill-use');
      var head =
        '<div class="tool-pill-head">' +
          '<span class="tool-pill-ico">' + (msg.result ? '↳' : (msg.progress ? '·' : '⌕')) + '</span>' +
          '<span class="tool-pill-text">' + esc(msg.text) + '</span>' +
          (hasDetail ? '<span class="tool-pill-chev">' + (expanded ? '▾' : '▸') + '</span>' : '') +
        '</div>';
      var detail = '';
      if (expanded) {
        detail = '<div class="tool-pill-detail">' + toolDetailHTML(msg) + '</div>';
      }
      return '<div class="' + cls + '" data-msg-role="tool" data-mi="' + mi + '" data-expanded="' + (expanded ? '1' : '') + '">' +
        head + detail + '</div>';
    } else if (msg.role === 'sources') {
      var items = '';
      for (var i = 0; i < msg.sources.length; i++) {
        var s = msg.sources[i];
        var domain = '';
        try { domain = new URL(s.url).hostname.replace(/^www\./, ''); } catch (e) { domain = s.url; }
        items +=
          '<a class="src-card" href="' + escAttr(s.url) + '" target="_blank" rel="noopener noreferrer">' +
            '<span class="src-card-dom">' + esc((domain || '?').charAt(0).toUpperCase()) + '</span>' +
            '<span class="src-card-meta">' +
              '<span class="src-card-title">' + esc(s.title || s.url) + '</span>' +
              '<span class="src-card-sub">' + esc(domain) + ' · tap to open ↗</span>' +
            '</span>' +
          '</a>';
      }
      return '<div class="src-wrap">' +
        '<div class="src-wrap-label">SOURCES</div>' + items + '</div>';
    }
    return '';
  }

  function toolDetailHTML(msg) {
    var p = msg.payload || {};
    var html = '';
    if (p.name) html += '<div class="tool-pill-row"><span class="tool-pill-k">tool</span><span>' + esc(p.name) + '</span></div>';
    if (p.summary) html += '<div class="tool-pill-row"><span class="tool-pill-k">query</span><span>' + esc(p.summary) + '</span></div>';
    if (p.query) html += '<div class="tool-pill-row"><span class="tool-pill-k">query</span><span>' + esc(p.query) + '</span></div>';
    var resultText = p.result || p.text || '';
    if (resultText && !p.sources) {
      html += '<div class="tool-pill-row"><span class="tool-pill-k">result</span><span class="tool-pill-pre">' +
        esc(String(resultText).slice(0, 2000)) + '</span></div>';
    }
    if (p.sources && p.sources.length) {
      html += '<div class="tool-pill-row"><span class="tool-pill-k">links</span><span>' +
        p.sources.map(function (s, i) {
          return '<a class="tool-pill-link" href="' + escAttr(s.url) + '" target="_blank" rel="noopener noreferrer">[' + (i + 1) + '] ' + esc(s.title || s.url) + '</a>';
        }).join('') + '</span></div>';
    }
    return html || '<div class="tool-pill-row">' + esc(JSON.stringify(p).slice(0, 600)) + '</div>';
  }

  // ── DOM: mount a message + run the Formatter into its bubble ────
  function appendMessage(container, scrollEl, msg, bodyEl, icon) {
    var greeting = container && container.querySelector('#chat-greeting');
    if (greeting && greeting.parentNode) greeting.parentNode.removeChild(greeting);
    var st = currentCtx && currentCtx.state;
    var mi = st ? st.messages.indexOf(msg) : -1;
    var div = document.createElement('div');
    div.innerHTML = messageHTML(msg, mi);
    var el = div.firstChild;
    container.appendChild(el);
    mountFormatting(el, msg);
    scrollBottom(bodyEl || container);
    return el;
  }

  // re-format an existing message's bubble (found via data-mi)
  function updateMessageEl(bodyEl, msg, final) {
    var container = bodyEl.querySelector('#chat-messages');
    if (!container) return;
    var st = currentCtx && currentCtx.state;
    if (!st) return;
    var mi = st.messages.indexOf(msg);
    if (mi < 0) return;
    var wrapper = container.querySelector('[data-mi="' + mi + '"]');
    if (!wrapper) {
      // not mounted yet (rare race) — append it
      appendMessage(container, null, msg, bodyEl, null);
      return;
    }
    var el = wrapper.classList.contains('msg-bubble') ? wrapper : wrapper.querySelector('.msg-bubble');
    mountFormatting(el, msg, final);
    if (final || msg.role === 'user') {
      scrollBottom(bodyEl);
    } else if (nearBottom(container)) {
      scrollBottom(bodyEl);
    }
  }

  function nearBottom(container) {
    if (!container) return true;
    var sc = container.closest ? container.closest('#chat-scroll') : null;
    if (!sc) return true;
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
  }

  function scrollBottom(bodyEl) {
    var sc = (bodyEl && bodyEl.querySelector('#chat-scroll')) || (bodyEl && bodyEl.querySelector('#chat-messages'));
    if (sc) sc.scrollTop = sc.scrollHeight;
    else if (bodyEl && bodyEl.querySelector) {
      var c = bodyEl.querySelector('#chat-messages');
      if (c) c.scrollTop = c.scrollHeight;
    }
  }

  // mount formatting for ALL messages in a fresh container (no scroll)
  function mountAllFormatting(container, state) {
    if (!container || !state) return;
    for (var i = 0; i < state.messages.length; i++) {
      var msg = state.messages[i];
      if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'thinking') continue;
      var wrapper = container.querySelector('[data-mi="' + i + '"]');
      if (!wrapper) continue;
      var el = wrapper.classList.contains('msg-bubble') ? wrapper : wrapper.querySelector('.msg-bubble');
      mountFormatting(el, msg, true);
    }
  }

  // run Formatter into a mounted bubble (user/assistant/thinking)
  function mountFormatting(el, msg, final) {
    if (!el) return;
    if (msg.role === 'user') {
      window.Formatter.renderInto(el, msg.text, { mode: 'user' });
    } else if (msg.role === 'assistant') {
      window.Formatter.renderInto(el, msg.text, {
        mode: 'full',
        streaming: !!msg.streaming && !final
      });
    } else if (msg.role === 'thinking' && el.classList.contains('msg-think-body')) {
      var elapsed = msg.startedAt ? Math.max(0, Math.round((Date.now() - msg.startedAt) / 1000)) : 0;
      window.Formatter.renderInto(el, msg.text, {
        mode: 'thinking',
        streaming: !!msg.streaming && !final,
        thinkingMeta: { elapsed: elapsed, chars: (msg.text || '').length }
      });
    }
  }
  function esc(text) {
    var d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }
  function escAttr(text) {
    return esc(text).replace(/"/g, '&quot;');
  }

  // ── Save session config to engine ─────────────────────────────
  // v0.19: this is a PATCH helper — it NEVER creates sessions anymore.
  // The old POST-when-missing raced the WS-binding's ensureSession
  // (applyModel fired BOTH): two sessions got created, and whichever
  // response landed LAST stomped state.sessionId + icon.sessionId while
  // the WebSocket was already binding the other one — a session SPLIT
  // (history loss on reopen, double user events). The send path's
  // ensureSession is now the ONLY session creator.
  function updateSession(icon, state, patch) {
    if (!state.sessionId) {
      // No session yet — the WS binding (bindEngineSession → ensureSession)
      // will create it and carry these fields on creation. Just remember
      // them on the icon so a reload restores them.
      if (icon) {
        if (patch && patch.model) icon.model = patch.model;
        if (patch && patch.provider) icon.provider = patch.provider;
        if (patch && patch.sandbox) icon.sandbox = patch.sandbox;
        if (typeof icon.save === 'function') icon.save();
      }
      return;
    }
    fetch('/api/sessions/' + state.sessionId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).catch(function (e) { console.error('update session failed', e); });
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
        state.model = canonicalModel(provider, modelId);
        state.provider = provider;
        if (icon) {
          icon.model = state.model;
          icon.provider = provider;
          if (typeof icon.save === 'function') icon.save();
        }
        updateSession(icon, state, { model: state.model, provider: provider });
        renderHost(bodyEl, icon, state, panel);
      });
    };
  }

  // ── doSend (shared by input + regenerate) ──────────────────────
  function doSend(text, bodyEl, icon, state, panel) {
    var type = window.ChatTypes.get(state.sandbox || 'quick');
    var ctx = currentCtx && currentCtx.ctx;
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

    state.messages.push({ role: 'user', text: text, local: true });
    appendMessage(msgContainer, null, { role: 'user', text: text }, bodyEl, icon);
    // v0.19: no auto-title on the first message (user spec — the random
    // default name stays until a manual rename).

    if (input) {
      input.value = '';
      state.draftText = '';
      input.style.height = 'auto';
    }

    state.isStreaming = true;
    if (sendBtn) {
      sendBtn.textContent = 'Stop';
      sendBtn.onclick = function () { type.stop(state, ctx || {}); };
    }

    // PrivateMode turns must never wait for the engine WS.
    if (state.provider !== 'privatemodeai' && !(state.client && state.client.connected)) {
      if (!state.client && !state.sessionId) {
        ensureSession(icon, state, function () { connectWS(bodyEl, state, msgContainer); });
      } else if (state.client && state.client.state !== 'connecting' && state.client.state !== 'open') {
        state.client.connect();
      }
      if (sendBtn) sendBtn.textContent = '…';
      var tries = 0;
      var check = setInterval(function () {
        tries++;
        if (state.client && state.client.connected) {
          clearInterval(check);
          if (!state.isStreaming && sendBtn) sendBtn.textContent = 'Send';
          type.send(text, state, ctx || makeCtxFallback(bodyEl, icon, state, panel, type));
        } else if (tries > 100) {
          clearInterval(check);
          if (sendBtn) sendBtn.textContent = 'Send';
          var err = 'Still connecting to the engine — tap Send again in a moment.' +
            (state.client && state.client.lastError ? ' (' + state.client.lastError + ')' : '');
          state.messages.push({ role: 'error', text: err });
          appendMessage(msgContainer, null, { role: 'error', text: err }, bodyEl, icon);
          state.isStreaming = false;
        }
      }, 100);
      return;
    }

    type.send(text, state, ctx || makeCtxFallback(bodyEl, icon, state, panel, type));
  }

  function makeCtxFallback(bodyEl, icon, state, panel, type) {
    return buildCtx(bodyEl, icon, state, panel, type);
  }

  // ── v0.19: persona edits (the persona editor) land in every open chat's
  // state so PM turns compose the system message from the LATEST text.
  window.addEventListener('doomalay:persona-saved', function (e) {
    var sid = e.detail && e.detail.sessionId;
    var persona = (e.detail && e.detail.persona) || '';
    if (!sid) return;
    for (var k in chatStates) {
      if (chatStates[k] && chatStates[k].sessionId === sid) chatStates[k].persona = persona;
    }
  });

  // ── v0.17: code-card "⇩ file" → save snippet as artifact ────────
  window.addEventListener('doomalay:save-code-artifact', function (e) {
    var st = currentCtx && currentCtx.state;
    if (!st || !st.sessionId) {
      if (window.Artifacts) window.Artifacts.toast('connect a model first');
      return;
    }
    window.Artifacts.saveCodeBlock(st.sessionId, e.detail.language, e.detail.code)
      .then(function (m) {
        if (m) refreshArtifactCount(st, currentCtx.bodyEl);
      })
      .catch(function (err) { window.Artifacts.toast(err.message); });
  });

  // ── v0.17: in-message artifact cards — tap opens, ⇩ downloads ───
  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.fmt-artifact');
    if (!card) return;
    var st = currentCtx && currentCtx.state;
    if (!st || !st.sessionId) { window.Artifacts.toast('connect a model first'); return; }
    var file = card.getAttribute('data-artifact-file');
    var isDl = e.target.closest && e.target.closest('[data-artifact-dl]');
    e.stopPropagation();
    window.Artifacts.list(st.sessionId).then(function (items) {
      var hit = items.find(function (m) { return m.name === file; });
      if (!hit) { window.Artifacts.toast('artifact still saving — try again in a second'); return; }
      if (isDl) {
        window.open('/api/sessions/' + st.sessionId + '/artifacts/' + hit.id + '/download', '_blank');
      } else {
        window.Artifacts.openEditor(st.sessionId, hit.id);
      }
    }).catch(function (err) { window.Artifacts.toast(err.message); });
  });

  // ── tool pill tap → expand/collapse (event delegation) ──────────
  document.addEventListener('click', function (e) {
    var pill = e.target.closest && e.target.closest('.tool-pill');
    if (!pill) return;
    if (e.target.closest('a')) return; // links inside detail work normally
    var hasChev = pill.querySelector('.tool-pill-chev');
    if (!hasChev) return;
    var container = pill.closest('#chat-messages');
    if (!container) return;
    // map the pill back to its message object
    var st = currentCtx && currentCtx.state;
    if (!st) return;
    var pills = Array.prototype.slice.call(container.querySelectorAll('.tool-pill'));
    var pillIdx = pills.indexOf(pill);
    var msgIdx = -1, seen = 0;
    for (var i = 0; i < st.messages.length; i++) {
      if (st.messages[i].role === 'tool') {
        if (seen === pillIdx) { msgIdx = i; break; }
        seen++;
      }
    }
    if (msgIdx < 0) return;
    st.messages[msgIdx].expanded = !st.messages[msgIdx].expanded;
    // re-render just this pill in place
    var tmp = document.createElement('div');
    tmp.innerHTML = messageHTML(st.messages[msgIdx], msgIdx);
    var fresh = tmp.firstChild;
    pill.replaceWith(fresh);
  });

  window.ChatPanel = {
    render: render,
    getState: function (id) { return chatStates[id]; },
    current: function () { return currentCtx; }
  };
})();
