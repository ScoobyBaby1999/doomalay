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
        // v0.26: multi-persona + placeholders + the chat's name ({name}).
        personas: null,
        placeholders: null,
        chatName: (icon && icon.name) || (sessionData && sessionData.Title) || '',
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

  // v0.33: the deferred labels re-render — panel.js pokes this event
  // when the last view pops and the stashed root becomes visible again,
  // so the one-shot label repaint finally runs (it had to wait: it
  // can't clobber an open view by writing bodyEl directly).
  document.addEventListener('doomalay:root-restored', function () {
    var c = currentCtx;
    if (c && c.state && c.state._labelsPending && !c.state._labelsDone &&
        window.H && window.H.hasLabels && window.H.hasLabels()) {
      c.state._labelsPending = false;
      c.state._labelsDone = true;
      if (c.bodyEl && c.bodyEl.isConnected) {
        renderHost(c.bodyEl, c.icon, c.state, c.panel);
      }
    }
  });

  function renderHost(bodyEl, icon, state, panel) {
    var type = window.ChatTypes.get(state.sandbox || 'quick');
    currentCtx = { bodyEl: bodyEl, icon: icon, state: state, panel: panel, type: type };

    // Labels may land async (catalog fetch): exactly ONE post-labels re-render.
    if (!H.hasLabels()) {
      H.ensureCatalog().then(function () {
        if (bodyEl.isConnected && !state._labelsDone && currentCtx &&
            currentCtx.state === state) {
          // v0.33: a VIEW is stacked over the root (hub / publish /
          // tweaks…) — renderHost writes bodyEl directly and would
          // clobber the open view. Defer until the root is visible
          // again (panel.js pokes 'doomalay:root-restored').
          if (panel && typeof panel.viewDepth === 'function' && panel.viewDepth() > 0) {
            state._labelsPending = true;
            return;
          }
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
          '<div id="chat-messages" style="flex:1;padding:16px;display:flex;flex-direction:column;gap:12px">' +
            (state.messages.length === 0
              ? '<div id="chat-greeting" style="text-align:center;color:var(--text-3);font-size: calc(var(--ui-fs) - 1px);padding:32px 20px">' +
                  esc(type.greeting) + ' ' + esc(icon.name) + '…</div>'
              : renderMessages(state.messages)) +
          '</div>' +
          // Sticky input bar — stays visible while scrolled.
          '<div id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:var(--surface-1);border-top:1px solid var(--surface-2);padding:10px 16px 12px;z-index:2">' +
          '<div id="chat-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>' +
          '<div style="display:flex;gap:8px">' +
            '<textarea id="chat-input" placeholder="' + esc(type.placeholder) + '" style="flex:1;background:var(--surface-1);border:1px solid var(--border);color:var(--text-1);padding:10px 12px;border-radius:8px;font-size:14px;font-family:inherit;resize:none;outline:none;min-height:40px;max-height:120px;line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
            '<button id="chat-send" style="background:var(--border-strong);border:none;color:var(--text-1);padding:0 16px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;align-self:flex-start;height:40px">Send</button>' +
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

    // v0.30: THE PER-CHAT TWEAKS — this chat's own colors / text sizes /
    // background (overriding the global settings for this chat only).
    // The vars are written INLINE on #chat-root, so the CSS cascade gives
    // them to the chat subtree while everything else keeps the global
    // values — and the reference is kept on state because a stacked view
    // stashes the root DOM in a fragment (querySelector can't see it then,
    // but the live tweaks view still paints the detached node).
    state._chatRootEl = bodyEl.querySelector('#chat-root');
    if (window.ChatTweaks) window.ChatTweaks.attach(state);

    // v0.28 SMART SCROLL FREEZE (user spec): while the model generates, an
    // upward swipe (or a touch/hold on the transcript) freezes auto-scroll —
    // new text keeps streaming in BELOW the fold, off-screen, and the view
    // stays exactly where the reader parked it. Scrolling back to the
    // bottom (or sending the next message) re-engages the follow. The
    // listener rides this scrollEl node; a re-render replaces the DOM and
    // wires a fresh one (the flag itself lives on state, so it survives).
    if (scrollEl) {
      scrollEl.addEventListener('touchstart', function () {
        if (state.isStreaming) state._scrollFrozen = true; // touch during a turn = about to read
      }, { passive: true });
      scrollEl.addEventListener('touchend', function () {
        if (!state.isStreaming) return;
        var d = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        if (d < 80) state._scrollFrozen = false; // stayed at the bottom — keep following
      }, { passive: true });
      scrollEl.addEventListener('scroll', function () {
        if (!state.isStreaming) { state._scrollFrozen = false; return; }
        var d = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        if (d < 80) state._scrollFrozen = false; // back at the bottom — follow again
        else if (d > 160) state._scrollFrozen = true; // reading above — freeze
      }, { passive: true });
    }

    wireHeader(bodyEl, icon, state, type, ctx);
    wireGatelock(bodyEl, ctx);
    updateHeaderBtn(state, icon, bodyEl, panel);
    // v0.27: a re-render while views are stacked would strand them over a
    // body that no longer holds their chat — discard the stack (the fresh
    // content below IS the new root; no restore).
    if (panel && panel.viewDepth && panel.viewDepth()) panel.dropViews();
    // the search input mounts whenever the dropdown renders open
    if (state.dropdownOpen) renderSearchbar(bodyEl, state, icon, panel);

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
          // v0.27: the session landed (async) — the header meters can
          // wake up now even if no status event replays afterwards.
          refreshHeaderMeters(bodyEl, state);
          // v0.30: the session landed — the per-chat tweaks load now (a
          // chat opened before its bind showed the provisional global look)
          if (window.ChatTweaks) window.ChatTweaks.attach(state);
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

  // ── The pinned collapsible header (arrow + summary + meters + dropdown) ──
  // v0.27: the far right of the row carries the METERS — the context
  // ring (the usage panel's context bar, miniaturized: fills 0→100%, and
  // shifts primary → warn → err as it climbs to the compaction point) and
  // the per-chat cost next to it. Both open the usage view on tap.
  function renderHeader(type, state, ctx, complete) {
    var open = !!state.dropdownOpen;
    var summary = type.summaryLine(state);
    return (
      '<div id="chat-header" style="flex-shrink:0;background:var(--surface-1);border-bottom:1px solid var(--surface-2);z-index:3">' +
        '<div id="chat-header-row" style="display:flex;align-items:center;gap:8px;padding:7px 12px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer">' +
          '<button id="header-chevron" aria-label="Show chat controls" style="flex-shrink:0;background:transparent;border:none;color:var(--text-3);font-size: calc(var(--ui-small-fs) - 1px);cursor:pointer;padding:5px 4px;transition:transform 0.2s;transform:rotate(' + (open ? '90deg' : '0deg') + ')">▶</button>' +
          '<div id="chat-header-summary" style="flex:1;min-width:0;font-size: calc(var(--ui-small-fs) - 1px);font-weight:600;color:' + (complete ? 'var(--text-2)' : 'var(--text-3)') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(summary) + '</div>' +
          '<div id="chat-header-meters" style="display:none">' +
            '<button id="header-ctx-cost" class="ctx-cost" aria-label="Chat cost — open usage">—</button>' +
            '<button id="header-ctx-ring" class="ctx-ring-btn" aria-label="Context fill — open usage"><span class="ctx-ring"></span></button>' +
          '</div>' +
        '</div>' +
        '<div id="chat-dropdown" style="' + (open ? '' : 'display:none;') + 'padding:2px 12px 10px;border-bottom:1px solid var(--surface-2)">' +
          '<div id="pill-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;-webkit-overflow-scrolling:touch;padding:4px 0 2px"></div>' +
          '<div id="chat-searchbar"></div>' +
          '<div id="util-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px"></div>' +
        '</div>' +
      '</div>');
  }

  // ── THE GATELOCK — the start of the convo, never collapsible ─────
  function renderGatelock(type, state, ctx, complete) {
    var steps = type.gatelockSteps(ctx);
    var boxes = '';
    var boxStyle = function (filled) {
      return 'flex:1;background:' + (filled ? 'var(--surface-2)' : 'var(--surface-1)') + ';border:2px ' + (filled ? 'solid var(--border-strong)' : 'dashed var(--border)') + ';border-radius:16px;padding:22px 14px;text-align:center;cursor:pointer;transition:border-color 0.15s;min-height:132px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;touch-action:manipulation;-webkit-tap-highlight-color:transparent';
    };
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var filled = !!s.filled;
      boxes +=
        '<div id="gate-box-' + s.key + '" data-gate-key="' + s.key + '" style="' + boxStyle(filled) + '">' +
          '<span style="font-size:26px">' + s.icon + '</span>' +
          '<span style="font-size: calc(var(--ui-fs) - 1px);font-weight:600;color:var(--text-1)">' + esc(s.title) + '</span>' +
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:' + (filled ? 'var(--ok)' : 'var(--text-3)') + '">' + esc(s.sub) + '</span>' +
        '</div>';
    }
    return (
      '<div id="gatelock" style="padding:18px 16px 10px;flex-shrink:0">' +
        '<h3 id="gatelock-title" style="font-size: calc(var(--ui-fs) + 1px);font-weight:700;color:var(--text-1);margin:0 0 6px">' + esc(type.gatelockTitle(state)) + '</h3>' +
        '<p id="gatelock-intro" style="font-size: var(--ui-small-fs);color:var(--text-3);margin:0 0 14px;line-height:1.5">' + esc(type.gatelockIntro(state)) + '</p>' +
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
    var summaryEl = bodyEl.querySelector('#chat-header-summary');

    var toggle = function () {
      state.dropdownOpen = !state.dropdownOpen;
      if (dropdown) dropdown.style.display = state.dropdownOpen ? '' : 'none';
      if (chevron) chevron.style.transform = 'rotate(' + (state.dropdownOpen ? '90deg' : '0deg') + ')';
      // v0.26: the header reads the static expand/collapse metadata line.
      if (summaryEl) summaryEl.textContent = type.summaryLine(state);
      // v0.27: the search input lives IN the dropdown — mounted once the
      // dropdown exists, it keeps its query + matches across toggles.
      if (state.dropdownOpen) renderSearchbar(bodyEl, state, icon, ctx.panel);
    };
    if (row) row.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#pill-row, #util-row, #chat-searchbar, #chat-header-meters')) return;
      toggle();
    });
    if (chevron) chevron.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

    // v0.27: THE METERS (context ring + per-chat cost) — same data the
    // usage view reads, rendered as two tiny front-facing elements on
    // the far right of the metadata row. Both open the usage view.
    wireHeaderMeters(bodyEl, icon, state, ctx);

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
            'background:rgba(var(--ok-rgb),0.06);border:1px solid rgba(var(--ok-rgb),0.55);color:var(--ok);' +
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
      art.innerHTML = '🌳 <span id="pill-artifacts-count">' + (state.artifactsCount || 0) + '</span>';
      art.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
        'background:rgba(var(--accent-2-rgb),0.06);border:1px solid rgba(var(--accent-2-rgb),0.55);color:var(--accent-2);' +
        'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2';
      art.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.sessionId) window.Artifacts.openDrawer(state.sessionId, { name: icon.name });
        else window.Artifacts.toast('connect a model first');
      });
      pillRow.appendChild(art);

      // v0.19→v0.26: THE PERSONA PILL — opens the chat's persona LIST
      // (multi-persona Sheet: add / rename / delete / activation modes).
      var per = document.createElement('button');
      per.id = 'pill-persona';
      per.innerHTML = '🎭 persona';
      per.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
        'background:rgba(var(--accent-rgb),0.06);border:1px solid rgba(var(--accent-rgb),0.55);color:var(--accent);' +
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

      // v0.27 (user spec): THE MIND PILL — the context window / memory
      // got its own pill + panel (it was buried inside export until now).
      // It sizes the model's view of the past; export got "exported latest".
      var mind = document.createElement('button');
      mind.id = 'pill-mind';
      mind.innerHTML = '🧠 mind';
      mind.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;' +
        'background:rgba(var(--accent-3-rgb),0.06);border:1px solid rgba(var(--accent-3-rgb),0.55);color:var(--accent-3);' +
        'padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.2';
      mind.addEventListener('click', function (e) {
        e.stopPropagation();
        openMindView(ctx.panel, icon, state);
      });
      pillRow.appendChild(mind);
    }

    // Host utilities (v0.27: smaller, darker, stylized — same squared
    // matte language as the pills above, one shade darker): export/share
    // and usage, both opening views on the master panel.
    if (utilRow) {
      utilRow.innerHTML = '';

      var exp = document.createElement('button');
      exp.className = 'util-btn';
      exp.innerHTML = '⤓ export / share';
      exp.addEventListener('click', function (e) {
        e.stopPropagation();
        openExportView(ctx.panel, icon, state);
      });
      utilRow.appendChild(exp);

      // v0.30 (user spec): THE TWEAKS PILL — the per-chat settings panel
      // (colors, text size, background) on the same util row as export
      // + usage. It reuses the settings' own UI builders; the values it
      // writes override the GLOBAL settings for THIS chat only.
      var tweakBtn = document.createElement('button');
      tweakBtn.className = 'util-btn';
      tweakBtn.innerHTML = '✦ tweaks';
      tweakBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.ChatTweaks) window.ChatTweaks.open(ctx.panel, icon, state);
      });
      utilRow.appendChild(tweakBtn);

      // v0.21→v0.27: USAGE + COST — a view on the master panel (working
      // ‹ back + ✕, Android gestures, a fleet view that actually opens).
      var usageBtn = document.createElement('button');
      usageBtn.className = 'util-btn';
      usageBtn.innerHTML = '◔ usage';
      usageBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openUsageView(ctx.panel, icon, state, usageBtn);
      });
      utilRow.appendChild(usageBtn);
      // v0.31.2: the ◈ hub pill MOVED OUT of the util row — the hub now
      // opens from the canvas dock's library glyph (see app.js: the dock
      // strip left of the settings gear). Export + tweaks + usage remain.
    }
  }

  // ── v0.27: EXPORTED-LATEST (per-chat, persisted client-side) ─────
  // "exported latest: N" — export only the last N replies/messages.
  // The default (-1) means the full chat log. Engine endpoints take
  // ?latest=N; the client-side txt/html slice state.messages the same way.
  var EXPORT_LATEST_KEY = 'doomalay.exportlatest.v1';
  function readLatestMap() {
    try { return JSON.parse(localStorage.getItem(EXPORT_LATEST_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function exportLatestFor(state) {
    var m = readLatestMap();
    var v = state && state.sessionId ? m[state.sessionId] : undefined;
    return (typeof v === 'number' && v > 0) ? v : -1;
  }
  function setExportLatest(state, n) {
    if (!state || !state.sessionId) return;
    var m = readLatestMap();
    if (n > 0) m[state.sessionId] = n; else delete m[state.sessionId];
    try { localStorage.setItem(EXPORT_LATEST_KEY, JSON.stringify(m)); } catch (e) {}
  }

  // ── v0.27: THE EXPORT / SHARE VIEW (every format we can give, ordered
  // most→least common) — now with "exported latest" instead of the memory
  // window (which moved to its own 🧠 mind pill). ────────────────────
  function openExportView(panel, icon, state) {
    if (!panel) return;
    var sid = state.sessionId;
    var base = '/api/sessions/' + sid;
    var latest = exportLatestFor(state);
    var dl = function (url) { window.open(url, '_blank'); };
    var clientFile = function (name, mime, text) {
      var blob = new Blob([text], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
    };
    // the visible tail of the conversation (client-side formats render
    // from the messages on screen — same slice the engine applies)
    var visibleMessages = function () {
      var msgs = state.messages || [];
      if (latest > 0 && msgs.length > latest) msgs = msgs.slice(-latest);
      return msgs;
    };
    var txtTranscript = function () {
      var out = ['# ' + icon.name + ' — transcript\n'];
      visibleMessages().forEach(function (m) {
        if (m.role === 'user') out.push('You:\n' + m.text + '\n');
        else if (m.role === 'assistant') out.push((icon.name || 'Bot') + ':\n' + m.text + '\n');
        else if (m.role === 'tool') out.push('⚙ ' + m.text + '\n');
      });
      return out.join('\n');
    };
    var htmlTranscript = function () {
      var rows = visibleMessages().map(function (m) {
        if (m.role === 'user') return '<p class="u"><b>You:</b><br>' + esc(m.text) + '</p>';
        if (m.role === 'assistant') return '<p class="a"><b>' + esc(icon.name) + ':</b><br>' + esc(m.text) + '</p>';
        if (m.role === 'tool') return '<p class="t">⚙ ' + esc(m.text) + '</p>';
        return '';
      }).join('\n');
      return '<!doctype html><meta charset="utf-8"><title>' + esc(icon.name) + ' — transcript</title>' +
        '<style>body{font-family:system-ui;max-width:720px;margin:24px auto;padding:0 14px;line-height:1.5}' +
        'p{border:1px solid #ddd;border-radius:8px;padding:10px 14px;margin:8px 0;white-space:pre-wrap}' +
        '.u{background:#f4f6ff}.a{background:#f6fff8}.t{background:#faf6ff;font-size:0.9em}</style>' +
        '<h1>' + esc(icon.name) + ' — transcript</h1>\n' + rows;
    };
    var noSession = !sid;

    function build() {
      return {
        title: 'export / share · ' + icon.name,
        render: function () {
          // v0.28 (user spec): one merged subtitle for the whole group, no
          // per-row subs, no explainer paragraphs; "exported latest" is a
          // 0–500 SLIDER (0 = full log) instead of the tap-to-cycle
          // ladder; the CSV glyph reads white (var(--text-1)).
          function fmtRow(ico, title, attr, icoStyle) {
            return '<button class="pv-row" ' + attr + (noSession ? ' style="opacity:0.5"' : '') + '>' +
              '<span class="pv-row-ico"' + (icoStyle || '') + '>' + ico + '</span>' +
              '<span class="pv-row-meta"><span class="pv-row-title">' + title + '</span></span>' +
              '<span class="pv-row-chev">⇩</span></button>';
          }
          var qs = latest > 0 ? '?latest=' + latest : '';
          return (
            '<p class="pv-hint">the transcript as a file — md / csv / json from the engine\'s event log, txt / html from the screen</p>' +
            (noSession ? '<div class="art-loading" style="padding:14px">send a message first — nothing to export yet</div>' :
            fmtRow('📝', 'Markdown', 'data-x="md" data-url="' + base + '/export.md' + qs + '"') +
            fmtRow('▦', 'CSV', 'data-x="csv" data-url="' + base + '/export.csv' + qs + '"', ' style="color:var(--text-1)"') +
            fmtRow('🧾', 'JSON', 'data-x="json" data-url="' + base + '/export.json' + qs + '"') +
            fmtRow('📄', 'Plain text', 'data-x="txt"') +
            fmtRow('🌐', 'HTML', 'data-x="html"')) +
            '<div class="pv-sub-row">' +
              '<span class="pv-sub-label">exported latest</span>' +
              '<span class="pv-sub-value" id="ex-latest-val">' + (latest > 0 ? 'last ' + latest : 'full log') + '</span>' +
            '</div>' +
            // v0.30 (user spec): the left edge is -1 — "full log", the
            // exact default — mirroring the mind slider's "whole chat"
            // semantics instead of 0 doubling as full.
            '<input type="range" class="pv-range" min="-1" max="500" step="1" value="' + (latest > 0 ? latest : -1) + '"' +
              ' aria-label="export the last N messages"' + (noSession ? ' disabled' : '') + '>'
          );
        },
        onMount: function (el) {
          el.querySelectorAll('[data-x]').forEach(function (b) {
            b.addEventListener('click', function () {
              if (noSession) return;
              var x = b.getAttribute('data-x');
              if (x === 'md' || x === 'csv' || x === 'json') dl(b.getAttribute('data-url'));
              else if (x === 'txt') clientFile((icon.name || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.txt', 'text/plain', txtTranscript());
              else if (x === 'html') clientFile((icon.name || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.html', 'text/html', htmlTranscript());
            });
          });
          // v0.28→v0.30: the scope slider — -1 (the left edge, the
          // default) = full log, else the last N. Live label while
          // dragging; the row URLs (and the persisted value) update on
          // release — no re-render, so the drag never dies mid-gesture.
          var sl = el.querySelector('.pv-range');
          if (sl) {
            var val = el.querySelector('#ex-latest-val');
            var t = null;
            var commit = function () {
              var v = parseInt(sl.value, 10);
              if (v <= 0) v = -1; // 0 (a mid-drag position) reads as full
              latest = v;
              setExportLatest(state, latest);
              el.querySelectorAll('[data-url]').forEach(function (b) {
                b.setAttribute('data-url', b.getAttribute('data-url').split('?latest=')[0] + (latest > 0 ? '?latest=' + latest : ''));
              });
            };
            sl.addEventListener('input', function () {
              var v = parseInt(sl.value, 10);
              if (val) val.textContent = v <= 0 ? 'full log' : 'last ' + v;
              clearTimeout(t);
              t = setTimeout(commit, 300);
            });
          }
        }
      };
    }
    panel.pushView(build());
  }

  // ── v0.27: THE MIND PILL (user spec: the context window / memory gets
  // its own pill + panel — it was buried in export until now). Shows the
  // memory ladder AND the live context fill (same usage endpoint the ring
  // and the usage view read).
  // v0.28 REWORK (user spec): the fill BAR is GONE (the header ring +
  // usage view already carry it — one bar per app is plenty); the context
  // window is a SLIDER (min = whole chat, max 500) instead of the tap
  // ladder; and auto-compaction gained per-chat controls — an on/off
  // toggle + the arming threshold % (the engine PATCHes
  // compact_enabled / compact_threshold; the usage endpoint reports
  // them back). ───────────────────────────────────────────────────────
  function openMindView(panel, icon, state) {
    if (!panel) return;
    function build(st) {
      var w = st.slidingWindow || 40;
      return {
        title: 'mind · ' + icon.name,
        render: function () {
          // v0.29 (user spec): more breathing room between the groups
          // (roomy rows + taller hints), a warning when auto-compaction
          // is OFF, and the description that spells out the mechanism —
          // "a new chat is started with the generated summary of the key
          // points in the chat".
          return (
            '<div class="pv-sub-row roomy" style="margin-top:4px">' +
              '<span class="pv-sub-label">context window</span>' +
              '<span class="pv-sub-value" id="mind-w-val">' + (w < 0 ? 'whole chat' : w + ' messages') + '</span>' +
            '</div>' +
            '<input type="range" class="pv-range" min="-1" max="500" step="1" value="' + w + '" aria-label="context window messages">' +
            '<p class="pv-hint" style="margin:4px 2px 6px">drag to set the recent messages riding along every turn — the left edge keeps the whole chat.</p>' +
            '<div class="pv-sub-row roomy">' +
              '<span class="pv-sub-label">auto-compaction</span>' +
              '<span class="pv-sub-value" id="mind-compact-state">…</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-top:2px">' +
              '<button class="pv-btn" id="mind-compact-toggle" style="flex:0 0 92px">…</button>' +
              '<div style="flex:1;min-width:0">' +
                '<input type="range" class="pv-range" id="mind-compact-threshold" min="10" max="95" step="5" value="70" aria-label="compaction threshold percent">' +
                '<div class="pv-sub-value" id="mind-threshold-val" style="text-align:left">arms at 70% full</div>' +
              '</div>' +
            '</div>' +
            '<p class="pv-hint" id="mind-compact-desc" style="margin:8px 2px 6px">when the window crosses the threshold, the key points of the chat are summarized and a new chat is started from that summary — nothing overflows, and the original log keeps every message.</p>' +
            '<div id="mind-compact-warn" style="display:none;background:rgba(var(--warn-rgb),0.10);border:1px solid rgba(var(--warn-rgb),0.4);border-radius:10px;padding:10px 12px;margin:2px 2px 4px">' +
              '<span style="color:var(--warn);font-weight:700;font-size:var(--ui-small-fs)">⚠ compaction is off</span>' +
              '<span style="display:block;color:var(--text-2);font-size:calc(var(--ui-small-fs) - 0.5px);line-height:1.55;margin-top:4px">the sliding window still drops the oldest messages as new ones arrive — old context is silently overwritten by new data and no summary is kept. Only turn this off for short, throwaway chats.</span>' +
            '</div>'
          );
        },
        onMount: function (el) {
          var slider = el.querySelector('.pv-range[min="-1"]');
          var wval = el.querySelector('#mind-w-val');
          var t = null;
          if (slider) slider.addEventListener('input', function () {
            var v = parseInt(slider.value, 10);
            if (v === 0) v = 1; // 0 would mean "default 40" to the engine — skip it
            if (wval) wval.textContent = v < 0 ? 'whole chat' : v + ' messages';
            clearTimeout(t);
            t = setTimeout(function () {
              st.slidingWindow = v;
              updateSession(icon, st, { sliding_window: v });
            }, 250);
          });

          // per-chat compaction controls — read from the usage endpoint
          // (same source the ring reads), write via session PATCH.
          if (st.sessionId) {
            fetch('/api/sessions/' + st.sessionId + '/usage').then(function (r) { return r.json(); }).then(function (u) {
              var c = (u && u.context) || {};
              var on = c.compactEnabled !== false;
              var thr = Math.max(10, Math.min(95, c.compactThreshold || 70));
              var fill = Math.max(0, Math.min(100, c.fillPct || 0));
              var tgl = el.querySelector('#mind-compact-toggle');
              var ths = el.querySelector('#mind-compact-threshold');
              var stv = el.querySelector('#mind-compact-state');
              var thv = el.querySelector('#mind-threshold-val');
              function paint() {
                if (tgl) {
                  tgl.textContent = on ? '● on' : '○ off';
                  tgl.style.color = on ? 'var(--ok)' : 'var(--text-3)';
                  tgl.style.borderColor = on ? 'rgba(var(--ok-rgb),0.45)' : 'var(--border)';
                }
                if (ths) ths.value = thr;
                if (thv) thv.textContent = 'arms at ' + thr + '% full';
                if (stv) stv.textContent = on
                  ? (fill > 0 ? 'fill ' + fill + '% · armed at ' + thr + '%' : 'armed at ' + thr + '%')
                  : 'off';
                var warn = el.querySelector('#mind-compact-warn');
                if (warn) warn.style.display = on ? 'none' : 'block';
                var desc = el.querySelector('#mind-compact-desc');
                if (desc) desc.style.opacity = on ? '1' : '0.45';
                if (ths) ths.disabled = !on;
              }
              paint();
              if (tgl) tgl.addEventListener('click', function () {
                on = !on;
                paint();
                updateSession(icon, st, { compact_enabled: on });
                refreshMetersSoon(st);
              });
              if (ths) ths.addEventListener('input', function () {
                thr = parseInt(ths.value, 10);
                paint();
                clearTimeout(t);
                t = setTimeout(function () {
                  updateSession(icon, st, { compact_threshold: thr });
                  refreshMetersSoon(st);
                }, 350);
              });
            }).catch(function () {});
          }
        }
      };
    }
    panel.pushView(build(state));
  }

  // ── v0.27: shared USAGE opener (the util pill, the header ring and the
  // cost badge all land here — one fetch, one view). ──────────────────
  function openUsageView(panel, icon, state, btn) {
    if (!panel) return;
    if (!state.sessionId) { if (btn) flashUtil(btn, 'no session yet'); return; }
    var old = btn ? btn.innerHTML : '';
    if (btn) btn.innerHTML = '◔ …';
    fetch('/api/sessions/' + state.sessionId + '/usage').then(function (r) { return r.json(); }).then(function (u) {
      if (btn && btn.isConnected) btn.innerHTML = old;
      state._usage = u; // the header meters read this too
      if (window.UsagePanel) window.UsagePanel.open(panel, u, { name: icon.name, sessionId: state.sessionId });
    }).catch(function () {
      if (btn && btn.isConnected) btn.innerHTML = old;
      if (btn) flashUtil(btn, 'usage unavailable');
    });
  }

  // v0.30: the compaction controls changed — the header ring + every
  // front-facing meter follow (one method, UsagePanel.ctxColor). The
  // refresh rides a short delay so the session PATCH lands first; the
  // throttle is bypassed so the ring repaints NOW.
  function refreshMetersSoon(state) {
    setTimeout(function () {
      if (!state || !state.sessionId) return;
      state._metersAt = 0;
      refreshHeaderMeters((currentCtx && currentCtx.bodyEl) || document.body, state);
    }, 450);
  }

  // ── v0.27: THE HEADER METERS — the context ring + the per-chat cost,
  // on the far right of the expand/collapse metadata row. Same endpoint,
  // same numbers as the usage view (two front-facing elements, one
  // method). The ring fills 0→100% and shifts primary → warn → err as it
  // climbs toward the compaction point (70%). ─────────────────────────
  function wireHeaderMeters(bodyEl, icon, state, ctx) {
    var meters = bodyEl.querySelector('#chat-header-meters');
    var ring = bodyEl.querySelector('#header-ctx-ring');
    var cost = bodyEl.querySelector('#header-ctx-cost');
    if (!meters || !ring || !cost) return;
    // clicks are wired UNCONDITIONALLY — the session bind is async; the
    // meters stay hidden until applyMeters() has real numbers, but the
    // buttons must already work by then.
    ring.addEventListener('click', function (e) { e.stopPropagation(); openUsageView(ctx.panel, icon, state); });
    cost.addEventListener('click', function (e) { e.stopPropagation(); openUsageView(ctx.panel, icon, state); });
    if (state.sessionId) {
      meters.style.display = 'flex';
      refreshHeaderMeters(bodyEl, state);
    } else {
      meters.style.display = 'none'; // hidden until there's a session
    }
  }

  // throttled fetch + paint; call sites: header render, turn end (WS
  // status idle/error + PM finish), compact events.
  function refreshHeaderMeters(bodyEl, state) {
    if (!state || !state.sessionId) return;
    var now = Date.now();
    if (state._metersAt && now - state._metersAt < 2500) {
      if (state._usage) applyMeters(bodyEl, state, state._usage);
      return;
    }
    state._metersAt = now;
    fetch('/api/sessions/' + state.sessionId + '/usage').then(function (r) { return r.json(); }).then(function (u) {
      // a re-render may have swapped the DOM under us — re-resolve live
      state._usage = u;
      var be = bodyEl.isConnected ? bodyEl : (currentCtx && currentCtx.bodyEl);
      if (be) applyMeters(be, state, u);
    }).catch(function () {});
  }

  function applyMeters(bodyEl, state, u) {
    var ring = bodyEl.querySelector('#header-ctx-ring .ctx-ring');
    var cost = bodyEl.querySelector('#header-ctx-cost');
    var meters = bodyEl.querySelector('#chat-header-meters');
    // v0.30: while a view is stacked (mind / usage / tweaks…), the whole
    // chat root — ring included — sits stashed in a detached fragment.
    // state._chatRootEl still references that node and painting a detached
    // element works: its inline styles are exactly what shows the moment
    // the view pops and the chat is restored.
    if ((!ring || !cost || !meters) && state && state._chatRootEl) {
      var alt = state._chatRootEl;
      if (!ring) ring = alt.querySelector('#header-ctx-ring .ctx-ring');
      if (!cost) cost = alt.querySelector('#header-ctx-cost');
      if (!meters) meters = alt.querySelector('#chat-header-meters');
    }
    if (!ring || !cost || !meters) return;
    var c = (u && u.context) || {};
    var t = (u && u.totals) || {};
    var fill = Math.max(0, Math.min(100, c.fillPct || 0));
    ring.style.setProperty('--p', String(fill));
    // v0.30: the ring asks the ONE ladder (UsagePanel.ctxColor) and hands
    // it the chat's OWN compaction settings — the same values the mind
    // panel PATCHes — so a moved threshold or a turned-off compaction is
    // reflected here the moment the meters refresh.
    ring.style.setProperty('--ring', (window.UsagePanel && window.UsagePanel.ringColor)
      ? window.UsagePanel.ringColor(fill, c) : 'var(--accent)');
    var ringBtn = bodyEl.querySelector('#header-ctx-ring') ||
      (state && state._chatRootEl ? state._chatRootEl.querySelector('#header-ctx-ring') : null);
    if (ringBtn) ringBtn.title = fill + '% context' +
      (c.compactEnabled === false ? ' · compaction off' : '') +
      (c.compacted ? ' · auto-compacted' : '');
    if (t.hasCost) {
      var cc = Number(t.cost || 0);
      cost.textContent = (cc < 0.01 && cc > 0) ? '$' + cc.toFixed(4) : '$' + cc.toFixed(2);
      cost.classList.add('priced');
      cost.title = 'this chat\'s estimated cost — tap for usage';
    } else {
      cost.textContent = 'free';
      cost.classList.remove('priced');
      cost.title = 'no priced usage this chat — tap for usage';
    }
    meters.style.display = 'flex';
  }

  // ── the in-chat search (v0.27: the input IS the pill — it fills the
  // entire row; the ▲▼ jump arrows + the "current / total" counter sit
  // to its right; typing filters live, no toggle step). ────────────────
  function renderSearchbar(bodyEl, state, icon, panel) {
    var bar = bodyEl.querySelector('#chat-searchbar');
    if (!bar) return;
    if (!state.search) state.search = { q: '', idx: 0 };
    var search = state.search;
    bar.innerHTML =
      '<input id="chat-search-input" type="text" placeholder="search this conversation…" value="' + escAttr(search.q) + '" aria-label="Search this conversation">' +
      '<button id="chat-search-prev" class="chat-search-nav" aria-label="Previous match">▲</button>' +
      '<button id="chat-search-next" class="chat-search-nav" aria-label="Next match">▼</button>' +
      '<span class="chat-search-count" id="chat-search-count"></span>';
    var inp = bar.querySelector('#chat-search-input');
    var count = bar.querySelector('#chat-search-count');
    var prevBtn = bar.querySelector('#chat-search-prev');
    var nextBtn = bar.querySelector('#chat-search-next');

    function updateCounter() {
      var marks = bar.ownerDocument.querySelectorAll('mark.chat-search-mark');
      var n = marks.length;
      if (!search.q || n === 0) { count.textContent = search.q ? '0/0' : ''; return; }
      search.idx = Math.max(0, Math.min(search.idx, n - 1));
      count.textContent = (search.idx + 1) + '/' + n;
    }
    function focusCurrent() {
      var marks = bar.ownerDocument.querySelectorAll('mark.chat-search-mark');
      if (!marks.length) return;
      search.idx = ((search.idx % marks.length) + marks.length) % marks.length;
      marks.forEach(function (m, i) { m.classList.toggle('chat-search-current', i === search.idx); });
      marks[search.idx].scrollIntoView({ block: 'center' });
      updateCounter();
    }
    var run = function () {
      search.q = inp.value;
      search.idx = 0;
      var n = highlightMatches(bodyEl, state, search.q);
      if (n > 0) focusCurrent(); else updateCounter();
    };
    var deb = null;
    inp.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(run, 200);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
      if (e.key === 'Escape') { // clears the query + the marks, keeps the bar
        inp.value = ''; search.q = ''; search.idx = 0;
        clearHighlights(bodyEl); updateCounter();
      }
    });
    prevBtn.addEventListener('click', function () {
      var marks = bar.ownerDocument.querySelectorAll('mark.chat-search-mark');
      if (!marks.length) return;
      search.idx = ((search.idx - 1) + marks.length) % marks.length;
      focusCurrent();
    });
    nextBtn.addEventListener('click', function () {
      var marks = bar.ownerDocument.querySelectorAll('mark.chat-search-mark');
      if (!marks.length) return;
      search.idx = (search.idx + 1) % marks.length;
      focusCurrent();
    });
    if (search.q) run(); else updateCounter();
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
      // wrap the match in a <mark> (scrolling + the current-match
      // highlight are the search bar's job — focusCurrent)
      var range = document.createRange();
      range.setStart(n, idx); range.setEnd(n, idx + q.length);
      var mark = document.createElement('mark');
      mark.className = 'chat-search-mark';
      try { range.surroundContents(mark); } catch (e) {}
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

  function flashUtil(btn, msg) {
    var old = btn.innerHTML;
    btn.textContent = msg;
    btn.style.color = 'var(--ok)';
    setTimeout(function () {
      if (btn.isConnected) { btn.innerHTML = old; btn.style.color = ''; }
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
  // v0.26: multi-persona resolution + {name}/{skills}/custom keys —
  // mirrors engine personas.go (trigger > shuffle > always > legacy).
  function pmSystemMessage(state, model, metrics) {
    var displayName = prettyModel(model);
    var head = 'You are ' + (displayName || 'an AI assistant') +
      (state.provider ? ', hosted via ' + state.provider : '') +
      ", chatting inside the Doomalay app on the user's own device. Today is " +
      new Date().toDateString() + '.';
    var personaText;
    if (state.personas && state.personas.length && window.Persona && window.Persona.resolveActive) {
      window.Persona.setData(state.personas, state.persona || '', state.placeholders || {});
      // v0.29: live name/model/provider — {name}/{model}/{provider} are
      // trigger keys now, same as the engine's extended evaluation.
      var active = window.Persona.resolveActive(state.personas, state.persona || '', metrics || {}, {
        name: state.chatName, model: model, provider: state.provider
      });
      personaText = active && active.text && active.text.trim() ? active.text : '';
    } else {
      personaText = (state.persona || '').trim();
    }
    var sys = head + '\n\n';
    if (personaText) {
      sys += (window.Persona && window.Persona.substituteAll)
        ? window.Persona.substituteAll(personaText, state.chatName, model, state.provider)
        : substituteVars(personaText, model, state.provider);
    } else {
      sys += (window.Persona && window.Persona.substituteAll)
        ? window.Persona.substituteAll(window.Persona.DEFAULT_PERSONA, state.chatName, model, state.provider)
        : substituteVars(DEFAULT_PERSONA, model, state.provider);
      return sys; // the default persona carries the artifact protocol
    }
    if (!/artifact/i.test(personaText)) sys += '\n\n' + ARTIFACT_PROMPT;
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

    // v0.26: live metrics feed trigger personas (mirrors the engine).
    var userTurns = 0, msgs = 0;
    for (var mi = 0; mi < state.messages.length; mi++) {
      msgs++;
      if (state.messages[mi].role === 'user') userTurns++;
    }
    var history = [{ role: 'system', content: pmSystemMessage(state, model, { messages: msgs, turns: userTurns + 1 }) }]; // v0.19: persona + identity + artifact protocol
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m.role === 'user') history.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant' && m.complete) history.push({ role: 'assistant', content: m.text });
    }
    var win = state.slidingWindow || 40;
    if (history.length > win + 1) history = history.slice(0, 1).concat(history.slice(-(win)));

    var showHint = function (msg) {
      // v0.23: PM phase hints ride the activity indicator (five pulsing
      // dots) instead of stacking one-off pills into the message list.
      setActivity(bodyEl, state, msg);
    };
    var clearHint = function () {
      // drops ONLY the explicit phase text — the watchdog decides whether
      // the indicator itself stays (silence) or goes (deltas flowing).
      state._actText = null;
    };

    showHint('establishing PrivateMode secure channel…');
    ensureActivityWatch(bodyEl, state);

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

    var finish = function (errText, usage) {
      clearHint();
      state.isStreaming = false;
      hideActivity(bodyEl, state);
      // v0.27: turn end — the header meters (ring + cost) refresh.
      refreshHeaderMeters(bodyEl, state);
      completeAllStreaming(bodyEl, state); // v0.25: every thinking bubble + cursor stops animating
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
            return persist('status', JSON.stringify({ state: 'error', usage: usage || null }));
          });
        }
        return persist('status', JSON.stringify({ state: 'idle', usage: usage || null }));
      });
    };

    persist('user', text);

    return window.PMBridge.streamChat({
      model: model,
      messages: history,
      signal: abort.signal,
      sessionId: state.sessionId || '', // v0.22: file tools save into this chat
      tools: !!state.webSearch && !state.deepResearch,
      // v0.26: the PM effort toggle (on/off → chat_template_kwargs.thinking).
      effort: state.effort || '',
      // v0.22: throttled re-render (the WS path already used scheduleUpdate;
      // PM fired a FULL markdown+DOMPurify+Prism pass per token — the
      // "replies outside the thinking box don't stream smoothly" freeze).
      onThinking: function (t) {
        clearHint();
        bumpActivity(state);
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'thinking') {
          last = { role: 'thinking', text: '', open: true, streaming: true, startedAt: Date.now() };
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last, bodyEl, icon);
        }
        last.text += t;
        scheduleUpdate(bodyEl, last, false);
      },
      // v0.27.1: pmsdk fires this when the thinking phase ends (content
      // starts or the stream closes) — freeze the bubble's timer there
      // instead of letting it count tool time as "reasoning".
      onThinkingEnd: function () { stampThinkEnd(state); },
      onDelta: function (t) {
        clearHint();
        bumpActivity(state);
        var m2 = getStreamMsg();
        m2.text += t;
        scheduleUpdate(bodyEl, m2, false);
      },
      // v0.23 NO-SILENCE (PM path): the suppressed ACTION stream reports
      // "building X · 12.4 KB so far" from inside roundTripOnce — same
      // phases the engine emits for its ReAct loop.
      onProgress: function (p) {
        setActivity(bodyEl, state, p && p.text);
      },
      onReset: function () {
        // v0.22: a long preamble streamed, then turned out to be a tool
        // call — clear it so the tool pills render on a clean slate.
        if (streamMsg) {
          streamMsg.text = '';
          updateMessageEl(bodyEl, streamMsg, false);
        }
      },
      onTool: function (ev) {
        bumpActivity(state);
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
        // v0.22: file tools saved a binary — card + refresh the drawer count
        if (ev.artifact && ev.artifact.name) {
          state.messages.push({ role: 'artifact', artifact: ev.artifact });
          appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, icon);
          refreshArtifactCount(state, bodyEl);
          // v0.26: remember tool-saved names — the model sometimes ALSO
          // writes an artifact block for the same file (the double-
          // attachment report); finalizeArtifacts skips those.
          if (!state._toolArtifactNames) state._toolArtifactNames = {};
          state._toolArtifactNames[ev.artifact.name.toLowerCase()] = true;
        }
      },
      onStatus: function (st) {
        if (st === 'running') showHint('establishing PrivateMode secure channel…');
      }
    }).then(function (result) {
      finish(null, result && result.usage);
      return result;
    }).catch(function (e) {
      finish(friendlyError(e && e.message ? e.message : 'PrivateMode turn failed'));
      return null;
    });
  }

  // ── v0.24 friendly provider errors (both chat paths) ─────────────
  // The user's spec: "If the issue is 429, or some issue where the model is
  // at capacity, or taking too long, let the user know instead of just
  // displaying thinking... We can suggest a switch of models aswell."
  function friendlyError(raw) {
    var t = String(raw || '');
    if (/\b429\b|rate.?limit|too many requests/i.test(t)) {
      return 'the model is at capacity (429) — wait ~15s and try again, or switch models (each model has its own limit)';
    }
    if (/minimum client version|upgrade the proxy/i.test(t)) {
      return 'PrivateMode upgraded their encrypted protocol — the app\u2019s secure client needs an update to reach it';
    }
    if (/went silent|no data for|context deadline exceeded|timeout/i.test(t)) {
      return t + ' — the model may be overloaded; try again or switch models';
    }
    if (/\b404\b|not found for account/i.test(t)) {
      return 'this model is no longer available for your account — pick another model';
    }
    if (/\b5\d\d\b/.test(t) && !/:\s*5\d\d\s*:\s*5\d\d/.test(t)) {
      return t + ' — provider error (model may be at capacity); try again or switch models';
    }
    return t;
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
      // v0.26: scope by the PROVIDER GROUP first — the old code scanned every
      // group for an exact 'provider/last-segment' slot match, but model ids
      // carry org segments ("nvidia/moonshotai/kimi-k2.6" ≠ "nvidia/kimi-k2.6")
      // so most models missed and the effort bubble "rarely showed up".
      if ((groups[g].name || '') !== (provider || '')) continue;
      var models = groups[g].models || [];
      for (var m = 0; m < models.length; m++) {
        var idLast = String(models[m].id || '').split('/').pop();
        if (models[m].id === slot || idLast === detail) {
          return models[m].effortLevels || null;
        }
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
      // v0.26: snap the persisted level into THIS model's ladder — the
      // old code kept a stale level from a previous model (e.g. 'med' from
      // the default, or 'on' from a toggle model), so the bubble showed
      // nothing and tapping it "wasn't working as intended".
      var curIdx = levels.indexOf(state.effort);
      if (curIdx < 0) {
        state.effort = defaultLevelFor(levels);
        curIdx = levels.indexOf(state.effort);
        persistCaps(state, icon);
      }
      var eb = document.createElement('button');
      eb.textContent = 'effort · ' + state.effort;
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
    wb.style.cssText = capBtnStyle(state.webSearch, 'var(--accent-2)');
    wb.addEventListener('click', function () {
      state.webSearch = !state.webSearch;
      if (state.webSearch) state.deepResearch = false;
      persistCaps(state, icon);
      renderToolbar(bar, state, levels, icon, bodyEl);
    });
    bar.appendChild(wb);

    var db = document.createElement('button');
    db.textContent = '⌖ deep research';
    db.style.cssText = capBtnStyle(state.deepResearch, 'var(--accent)');
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
      clear.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text-3);padding:4px 10px;border-radius:8px;font-size:11px;font-family:inherit;cursor:pointer;flex-shrink:0';
      clear.addEventListener('click', function () {
        // v0.26: reset to the model's OWN default (first level), not a
        // hardcoded 'med' that isn't in most ladders.
        state.effort = (levels && levels.length) ? levels[0] : 'med';
        state.webSearch = false;
        state.deepResearch = false;
        persistCaps(state, icon);
        renderToolbar(bar, state, levels, icon, bodyEl);
      });
      bar.appendChild(clear);
    }
  }

  // v0.26: the sensible default per ladder shape (nvidia/pm on/off → on;
  // low..max ladders → the middle; none/high/max → high).
  function defaultLevelFor(levels) {
    if (!levels || !levels.length) return 'med';
    if (levels.indexOf('on') >= 0) return 'on';
    if (levels.indexOf('medium') >= 0) return 'medium';
    if (levels.indexOf('med') >= 0) return 'med';
    if (levels.indexOf('high') >= 0) return 'high';
    return levels[0];
  }

  function effortBtnStyle(active) {
    return 'flex-shrink:0;background:' + (active ? 'rgba(249,115,22,0.15)' : 'transparent') + ';border:1px solid ' + (active ? 'rgba(249,115,22,0.5)' : 'var(--border)') + ';color:' + (active ? '#fb923c' : 'var(--text-3)') + ';padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer';
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
        // v0.26: the multi-persona list + custom placeholders (the PM
        // path composes its system message client-side).
        if (typeof data.Personas === 'string' && data.Personas) {
          try { state.personas = JSON.parse(data.Personas) || []; } catch (e) {}
        }
        if (typeof data.Placeholders === 'string' && data.Placeholders) {
          try { state.placeholders = JSON.parse(data.Placeholders) || {}; } catch (e) {}
        }
        state.chatName = data.Title || state.chatName;
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

  // v0.27.1 — freeze the reasoning timer when the thinking phase ends.
  // The bubble's elapsed used to keep counting from startedAt straight
  // through tool execution + the rest of the turn (observed: "reasoning ·
  // 181s" rounds whose actual thinking was ~30s). endedAt is stamped the
  // moment the stream moves past thinking (content, a tool event, or turn
  // end) — both the WS engine path and the PM bridge report through here.
  function stampThinkEnd(state) {
    if (!state || !Array.isArray(state.messages)) return;
    var lt = state.messages[state.messages.length - 1];
    if (lt && lt.role === 'thinking' && !lt.endedAt) lt.endedAt = Date.now();
  }

  function container2(bodyEl, mi) {
    var c = bodyEl ? bodyEl.querySelector('#chat-messages') : null;
    return c ? c.querySelector('[data-mi="' + mi + '"]') : null;
  }

  // ── Handle a WS event (idempotent replay, streaming, errors) ─────
  function handleEvent(ev, state, msgContainer, scrollEl, bodyEl, _icon, _panel) {
    var type = ev.type;
    if (ev.i !== undefined && ev.i !== null && !isNaN(ev.i)) {
      if (ev.i <= (state.lastEventI || 0)) return;
      state.lastEventI = ev.i;
    }
    // v0.23 NO-SILENCE: ephemeral progress events (never persisted, no i)
    // drive the activity indicator — "building bundle.zip · 12.4 KB…".
    if (type === 'progress') {
      setActivity(bodyEl, state, ev.text || ev.message || 'working…');
      return;
    }
    if (type === 'user') {
      bumpActivity(state);
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
      bumpActivity(state);
      stampThinkEnd(state); // v0.27.1: content follows thinking → timer freezes
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
      stampThinkEnd(state); // v0.27.1
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
      bumpActivity(state);
      var lastThink = state.messages[state.messages.length - 1];
      if (!lastThink || lastThink.role !== 'thinking') {
        lastThink = { role: 'thinking', text: '', open: true, streaming: true, startedAt: Date.now() };
        state.messages.push(lastThink);
        appendMessage(msgContainer, scrollEl, lastThink, bodyEl, state._icon);
      }
      lastThink.text += ev.text;
      scheduleUpdate(bodyEl, lastThink, false);
    } else if (type === 'tool_use') {
      bumpActivity(state);
      stampThinkEnd(state); // v0.27.1: the model moved on to tools
      // v0.20: PM-persisted tool events carry their payload as a JSON text
      // (the engine's own events have name/summary top-level) — lift it.
      var pay = ev;
      if ((!pay.name || pay.summary === undefined) && pay.text) {
        try { pay = JSON.parse(pay.text); } catch (e) {}
      }
      state.messages.push({ role: 'tool', text: pay.summary || pay.name || 'tool', tool: true, payload: pay });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
    } else if (type === 'tool_result') {
      bumpActivity(state);
      stampThinkEnd(state); // v0.27.1
      var pay2 = ev;
      if ((!pay2.name || pay2.summary === undefined) && pay2.text) {
        try { pay2 = JSON.parse(pay2.text); } catch (e) {}
      }
      state.messages.push({ role: 'tool', text: pay2.summary || pay2.name || '', result: true, payload: pay2 });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
      // v0.22: file tools (docx/xlsx/zip) — a real download card follows the pill.
      if (ev.artifact && ev.artifact.name) {
        state.messages.push({ role: 'artifact', artifact: ev.artifact });
        appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
        // v0.26: same dedupe set as the WS path (see above).
        if (!state._toolArtifactNames) state._toolArtifactNames = {};
        state._toolArtifactNames[ev.artifact.name.toLowerCase()] = true;
      }
    } else if (type === 'sources') {
      stampThinkEnd(state); // v0.27.1
      var srcs = ev.sources || [];
      if (!srcs.length && ev.text) { try { srcs = JSON.parse(ev.text); } catch (e) {} }
      if (srcs.length) {
        state.messages.push({ role: 'sources', sources: srcs });
        appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
      }
    } else if (type === 'assistant_reset') {
      // v0.22: a long preamble streamed as if final, then turned out to be
      // a tool call — wipe the in-progress assistant message (the engine
      // also drops its persisted copy; the tool pill renders instead).
      for (var rk = state.messages.length - 1; rk >= 0; rk--) {
        var rm = state.messages[rk];
        if (rm.role === 'assistant') {
          if (!rm.complete && !rm.text) break;
          if (!rm.complete) {
            state.messages.splice(rk, 1);
            var rw = container2(bodyEl, rk);
            if (rw && rw.parentNode) rw.parentNode.removeChild(rw);
          }
          break;
        }
      }
    } else if (type === 'compact') {
      // v0.21: auto-compact — older turns were summarized into the
      // session's compact summary; the full history stays on disk.
      var cinfo = '';
      try {
        var cj = JSON.parse(ev.text || '{}');
        cinfo = 'older turns summarized (' + (cj.summaryTokens || 0) + ' tok notes' +
          (cj.contextLimit ? ', window ~' + Math.round(cj.contextLimit / 1000) + 'k' : '') + ')';
      } catch (e2) { cinfo = 'older turns summarized'; }
      state.messages.push({ role: 'tool', text: cinfo, compact: true, payload: ev });
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon);
    } else if (type === 'status') {
      if (ev.state === 'idle' || ev.state === 'error') {
        state.isStreaming = false;
        hideActivity(bodyEl, state);
        // v0.27: turn end — the header meters (ring + cost) refresh.
        refreshHeaderMeters(bodyEl, state);
        // v0.25: EVERY still-streaming message completes — thinking bubbles
        // included (the old loop only handled the last message, leaving
        // earlier thinking dots + cursors blinking forever after the turn).
        completeAllStreaming(bodyEl, state);
        // v0.17 belt-and-suspenders: status idle IS a completion signal —
        // finalize artifacts for every message the trailing 'assistant'
        // event may have missed.
        for (var k = state.messages.length - 1; k >= 0; k--) {
          var sm = state.messages[k];
          if (sm.role === 'assistant' && !state.artifactSaved[state.messages.indexOf(sm)]) {
            finalizeArtifacts(sm, state, bodyEl);
          }
        }
        var btn = document.querySelector('#chat-send');
        if (btn) { btn.textContent = 'Send'; btn.onclick = null; }
      } else if (ev.state === 'running' && (ev.text || ev.message)) {
        // v0.23: running-state messages ("network hiccup — retry 1/2",
        // research stages) now feed the activity indicator instead of
        // stacking throwaway progress pills into the message list.
        setActivity(bodyEl, state, ev.message || ev.text);
      }
    } else if (type === 'error') {
      state.isStreaming = false;
      hideActivity(bodyEl, state);
      var errText = friendlyError(ev.message || ev.error || ev.text || 'Unknown error');
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

  // ── v0.23 THE ACTIVITY INDICATOR (the no-silence guarantee) ──────
  //
  // User spec: "whenever we can, let's have building file.. a loading
  // bar.. or a message five dots ..... that keep animating — ideally NO
  // time where the chat freezes and does stuff in the background with no
  // UI feedback." One compact row at the end of the message list: five
  // pulsing dots + the live phase text ("building bundle.zip · 12.4 KB")
  // + elapsed seconds + a sweeping progress line. Fed by:
  //   · engine 'progress' events (ACTION-composition, delegate, tools)
  //   · PM onProgress callbacks (the same phases, client-side)
  //   · a silence watchdog — streaming + 1.5s without any visible
  //     event → "thinking…" fallback (covers round gaps + first token)
  function bumpActivity(state) {
    state._lastActAt = Date.now();
    state._actText = null; // visible movement — drop the stale phase text
  }

  function setActivity(bodyEl, state, text) {
    state._actText = String(text || 'working…');
    state._actAt = Date.now();
    renderActivity(bodyEl, state, true);
  }

  function renderActivity(bodyEl, state, scrollTo) {
    var container = bodyEl ? bodyEl.querySelector('#chat-messages') : null;
    if (!container) return;
    var row = container.querySelector('.chat-working');
    var text = state._actText;
    var silent = Date.now() - (state._lastActAt || 0);
    var show = state.isStreaming &&
      ((text && Date.now() - (state._actAt || 0) < 5000) || silent > 1500);
    if (!show) {
      if (row && row.parentNode) row.parentNode.removeChild(row);
      return;
    }
    var phase = text || (silent > 1500 ? 'thinking…' : 'working…');
    if (!row) {
      row = document.createElement('div');
      row.className = 'chat-working';
      row.innerHTML = '<span class="cwd"><i></i><i></i><i></i><i></i><i></i></span>' +
        '<span class="cwt"></span><span class="cwe"></span><i class="cwk-bar"></i>';
      container.appendChild(row);
      scrollTo = true;
    } else if (row.nextSibling) {
      container.appendChild(row); // keep it the LAST row
    }
    var tEl = row.querySelector('.cwt');
    if (tEl.textContent !== phase) {
      tEl.textContent = phase;
      scrollTo = true;
    }
    var elapsed = Math.max(0, Math.round(((state._actAt || state._lastActAt || Date.now()) - (state._turnStartAt || 0)) / 1000));
    if (elapsed >= 3) {
      row.querySelector('.cwe').textContent = elapsed + 's';
    }
    if (scrollTo) {
      var sc = bodyEl.querySelector('#chat-scroll');
      // v0.28 SMART SCROLL FREEZE: the working indicator is exactly the
      // auto-scroll the reader must be protected from while frozen.
      if (sc && !(state.isStreaming && state._scrollFrozen)) sc.scrollTop = sc.scrollHeight;
    }
  }

  function hideActivity(bodyEl, state) {
    state._actText = null;
    var container = bodyEl ? bodyEl.querySelector('#chat-messages') : null;
    if (container) {
      var row = container.querySelector('.chat-working');
      if (row && row.parentNode) row.parentNode.removeChild(row);
    }
  }

  // silence watchdog: while a turn runs, keep the indicator honest.
  function ensureActivityWatch(bodyEl, state) {
    state._turnStartAt = Date.now();
    if (state._actTimer) return;
    state._actTimer = setInterval(function () {
      if (!state.isStreaming) {
        clearInterval(state._actTimer);
        state._actTimer = null;
        hideActivity(currentCtx && currentCtx.bodyEl, state);
        return;
      }
      // find THIS chat's live DOM (panel may have re-rendered)
      var body = (currentCtx && currentCtx.state === state && currentCtx.bodyEl) || bodyEl;
      if (body && body.isConnected) {
        renderActivity(body, state, false);
        tickThinkingMeta(body, state); // v0.24: live reasoning stats even between trickles
      }
    }, 500);
  }

  // v0.24 — LIVE THINKING STATS. Reasoning models on slow providers
  // (kimi-k3 via NVIDIA observed: 139-151s between thinking flushes)
  // used to sit as a static "thinking…" — now the summary chip and the
  // stats line tick every 500ms (elapsed + chars), so the bubble itself
  // tells the user the app is alive.
  function tickThinkingMeta(bodyEl, state) {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var m = state.messages[i];
      if (m.role !== 'thinking') continue;
      if (!m.startedAt) break;
      var wrap = container2(bodyEl, i);
      if (!wrap) break;
      var secs = Math.max(0, Math.round(((m.endedAt || Date.now()) - m.startedAt) / 1000));
      var n = (m.text || '').length;
      var chars = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
      var chip = wrap.querySelector('.th-elapsed');
      if (chip && m.streaming) {
        chip.style.display = '';
        var t = ' · ' + (secs >= 90 ? Math.floor(secs / 60) + 'm ' + (secs % 60) + 's' : secs + 's');
        if (chip.textContent !== t) chip.textContent = t;
      }
      var stats = wrap.querySelector('.fmt-th-stats');
      if (stats) {
        var t2 = '✻ reasoning · ' + secs + 's · ' + chars;
        if (stats.textContent !== t2) stats.textContent = t2;
      }
      break;
    }
  }

  // v0.25 END-OF-TURN CLEANUP (the "flickering circle after the response
  // ends" report): clear the streaming flag on EVERY message — thinking
  // bubbles AND assistant text — and re-render each, so no blinking cursor
  // or live dot survives a finished turn. The old cleanup only handled the
  // LAST message, so earlier thinking bubbles kept their animated dot
  // forever.
  function completeAllStreaming(bodyEl, state) {
    if (!state || !Array.isArray(state.messages)) return;
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m && m.streaming) {
        m.streaming = false;
        if (m.role === 'assistant') m.complete = true;
        updateMessageEl(bodyEl, m, false);
      }
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
      // v0.26: skip blocks whose file a TOOL already saved this turn (the
      // model sometimes calls docx_create AND hand-writes an artifact
      // block for the same file — the double-attachment report, where the
      // hand-written copy even carried a glued "Hello_Word.docx.doc" name).
      var norm = String(art.file || '').toLowerCase()
        .replace(/\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)$/i, '.$1');
      if (state._toolArtifactNames && state._toolArtifactNames[norm]) return;
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
          '<span class="th-elapsed"' + (msg.streaming ? '' : ' style="display:none"') + '></span>' +
          '</summary>' +
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
    } else if (msg.role === 'artifact') {
      // v0.22: a file tool saved a binary — render the same card the
      // formatter builds (the .fmt-artifact click handler opens it).
      var a = msg.artifact || {};
      var FTc = window.FileTypes || {};
      var am = FTc.info ? FTc.info(a.name || '') : {};
      return '<div class="fmt-artifact" data-artifact-file="' + escAttr(a.name || 'file') + '" data-artifact-encoding="base64">' +
        '<span class="fmt-artifact-ico" style="color:' + (am.color || 'var(--fmt-a2)') + '">' + (am.icon || '📦') + '</span>' +
        '<span class="fmt-artifact-meta">' +
          '<span class="fmt-artifact-name">' + esc(a.name || 'file') + '</span>' +
          '<span class="fmt-artifact-sub">' + esc(am.label || 'file') + ' · saved · tap to open</span>' +
        '</span>' +
        '<button class="fmt-artifact-dl" data-artifact-dl="1">⇩</button>' +
      '</div>';
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
    // v0.28 SMART SCROLL FREEZE: while a turn streams and the reader has
    // scrolled up (frozen), every auto-scroll site funnels through here —
    // new content mounts below the fold, the view never jumps. Sending a
    // message or returning to the bottom clears the freeze (see the
    // scroll listener in render).
    var st = currentCtx && currentCtx.state;
    if (sc && !(st && st.isStreaming && st._scrollFrozen)) sc.scrollTop = sc.scrollHeight;
    else if (!sc && bodyEl && bodyEl.querySelector) {
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
      var elapsed = msg.startedAt ? Math.max(0, Math.round(((msg.endedAt || Date.now()) - msg.startedAt) / 1000)) : 0;
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
  // v0.32.3 F3: extracted — both the model pill and the ★ quick-switch
  // apply a choice through this one path.
  function applyModelChoice(provider, modelId, state, icon, bodyEl, panel) {
    state.model = canonicalModel(provider, modelId);
    state.provider = provider;
    if (icon) {
      icon.model = state.model;
      icon.provider = provider;
      if (typeof icon.save === 'function') icon.save();
    }
    updateSession(icon, state, { model: state.model, provider: provider });
    renderHost(bodyEl, icon, state, panel);
  }

  function updateHeaderBtn(state, icon, bodyEl, panel) {
    var btn = document.getElementById('panel-model-btn');
    if (!btn) return;
    if (!state.model) {
      btn.style.display = 'none';
      var sb0 = document.getElementById('panel-star-btn');
      if (sb0) sb0.style.display = 'none';
      return;
    }
    btn.style.display = 'flex';
    btn.innerHTML =
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(H.modelDetail(state.model)) + '</span>' +
      '<span style="color:var(--text-3);flex-shrink:0">· ' + esc(H.providerLabel(state.provider)) + ' ▾</span>';
    btn.onclick = function () {
      if (!window.ModelBrowser) return;
      window.ModelBrowser.open(function (provider, modelId) {
        applyModelChoice(provider, modelId, state, icon, bodyEl, panel);
      }, { current: { provider: state.provider, modelId: state.model } }); // v0.32.1 E: mark the chat's current model in the browser
    };

    // v0.32.3 F3: the ★ quick-switch — one-tap model switching without
    // opening the full browser. Shows the recent + starred lists in a
    // popup anchored to this button.
    var starBtn = document.getElementById('panel-star-btn');
    if (starBtn) {
      starBtn.style.display = 'flex';
      starBtn.onclick = function () {
        openQuickSwitch(starBtn, state, icon, bodyEl, panel);
      };
      // v0.32.7 F1: keep the starred-count badge honest on every header
      // render (the count can change while the panel is closed).
      if (window.ModelBrowser && window.ModelBrowser.updateStarBadge) window.ModelBrowser.updateStarBadge();
    }
  }

  // ── v0.32.3 F3: the ★ quick-switch popup ─────────────────────────
  // A small card with Recent + Starred rows; tapping a row calls
  // ModelBrowser.quickPick (best key-backed host, user's priority
  // order) and applies it via applyModelChoice. Esc / ✕ / outside
  // pointerdown closes it. Anchored above or below the ★ button by
  // available space; clamped to the viewport horizontally.
  function openQuickSwitch(anchorBtn, state, icon, bodyEl, panel) {
    closeQuickSwitch();
    if (!window.ModelBrowser || !window.ModelBrowser.quickEntries) return;

    var wrap = document.createElement('div');
    wrap.id = 'qs-popup';
    wrap.setAttribute('role', 'menu');
    wrap.setAttribute('aria-label', 'Quick model switch');

    // ── positioning (fixed, clamped) ──
    var r = anchorBtn.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var W = Math.min(300, vw - 16);
    var x = Math.max(8, Math.min(r.left, vw - W - 8));
    var estH = 300; // conservative estimate; final clamp after render
    var below = r.bottom + estH + 12 < vh;
    var y = below ? r.bottom + 8 : Math.max(8, r.top - estH - 12);
    wrap.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:' + W + 'px;' +
      'z-index:3500;background:var(--surface-1);border:1px solid rgba(255,255,255,0.14);' +
      'border-radius:12px;box-shadow:0 22px 60px rgba(0,0,0,0.5);' +
      'max-height:' + (vh - 32) + 'px;overflow-y:auto;overflow-x:hidden;' +
      'font-family:inherit;opacity:0;transform:scale(0.96) translateY(' + (below ? 6 : -6) + 'px);' +
      'transition:opacity 140ms cubic-bezier(0.32,0.72,0,1),transform 140ms cubic-bezier(0.32,0.72,0,1);';

    // loading shimmer while the catalog resolves
    if (!document.getElementById('qs-style')) {
      var st = document.createElement('style');
      st.id = 'qs-style';
      st.textContent = '@keyframes qs-spin{to{transform:rotate(360deg)}}' +
        '#qs-popup button:hover{background:rgba(128,128,140,0.10)}' +
        '#qs-popup button:active{background:rgba(128,128,140,0.16)}' +
        '#qs-popup button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}' +
        '@media (prefers-reduced-motion:reduce){#qs-popup{transition:none!important}}';
      document.head.appendChild(st);
    }
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:12px 14px;font-size:12px;color:var(--text-3)">' +
      '<span style="width:10px;height:10px;border:2px solid var(--border-strong);border-top-color:var(--accent);border-radius:50%;animation:qs-spin 0.7s linear infinite"></span>' +
      'loading models…</div>';
    document.body.appendChild(wrap);
    requestAnimationFrame(function () {
      wrap.style.opacity = '1';
      wrap.style.transform = 'scale(1) translateY(0)';
    });

    var onDocDown = function (e) {
      if (wrap.contains(e.target) || e.target === anchorBtn) return;
      closeQuickSwitch();
    };
    var onKey = function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeQuickSwitch(); }
    };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    wrap._qsCleanup = function () {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    };

    window.ModelBrowser.quickEntries(
      { current: { provider: state.provider, modelId: state.model } },
      function (entries) { renderQuickEntries(wrap, entries, state, icon, bodyEl, panel); }
    );
  }

  function closeQuickSwitch() {
    var old = document.getElementById('qs-popup');
    if (old) {
      if (old._qsCleanup) old._qsCleanup();
      old.remove();
    }
  }

  function qsSectionHeader(label, glyph, color) {
    // v0.32.3 (VLM round 4): generous breathing room around section
    // headers — cramped sections read as clutter.
    // v0.32.6: data-qs-section lets the ★ toggle drop a section header
    // when its last row goes away.
    return '<div data-qs-section="' + escAttr(label.toLowerCase()) + '" style="display:flex;align-items:center;gap:6px;padding:12px 14px 6px;font-size:10px;font-weight:700;' +
      'letter-spacing:0.08em;text-transform:uppercase;color:' + color + '">' +
      '<span style="font-size:12px">' + glyph + '</span>' + label + '</div>';
  }

  // v0.32.6 F1: rows carry a PRICE chip (best key-backed route) + a ★
  // toggle on the right. The row is a wrapper DIV holding the pick
  // button + the star button as siblings — buttons can't nest (the HTML
  // parser breaks them apart), so the pick stays a real <button>.
  // starredSet: {id:true} map for the star state of every visible entry.
  // v0.32.8 F2: `cheapest` marks the cheapest PAID row (green tag) when
  // every visible row is priced — free rows keep their "free" chip.
  function qsRowHtml(en, starredSet, cheapest) {
    var curChip = en.isCurrent
      ? '<span style="font-size:9px;font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.35);padding:1px 6px;border-radius:4px;flex-shrink:0">current</span>'
      : '';
    var prov = en.hasKey
      ? '<span style="font-size:10px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1">' + esc(en.providerLabel) + '</span>'
      : '<span style="font-size:10px;color:var(--warn);flex-shrink:0">no key</span>';
    // price chip: free (green) or "$X.XX/M" (amber, tabular) — only for
    // key-backed routes whose provider exposes pricing.
    var priceChip = '';
    if (en.hasKey && en.price) {
      priceChip = en.price === 'free'
        ? '<span style="font-size:9px;font-weight:700;color:#22c55e;background:rgba(34,197,94,0.12);padding:1px 6px;border-radius:4px;flex-shrink:0;font-variant-numeric:tabular-nums">free</span>'
        : '<span style="font-size:9px;font-weight:600;color:var(--warn);background:rgba(var(--warn-rgb),0.10);padding:1px 6px;border-radius:4px;flex-shrink:0;font-variant-numeric:tabular-nums">' + esc(en.price) + '</span>';
    }
    // v0.32.8 F2: the cheapest paid route gets a green tag so the price
    // decision is one glance, not mental math across rows.
    var cheapChip = (cheapest && en.hasKey && en.price && en.price !== 'free')
      ? '<span title="cheapest route among your recents & starred" style="font-size:9px;font-weight:700;color:var(--ok);background:rgba(var(--ok-rgb),0.12);border:1px solid rgba(var(--ok-rgb),0.35);padding:1px 6px;border-radius:4px;flex-shrink:0">cheapest</span>'
      : '';
    var glyph = starredSet[en.id]
      ? '<span style="color:#eab308;font-size:12px;flex-shrink:0;line-height:1">★</span>'
      : '<span style="color:var(--text-3);font-size:11px;flex-shrink:0;line-height:1">🕘</span>';
    var starBtn = '<button data-qs-star="' + escAttr(en.id) + '" aria-pressed="' + (starredSet[en.id] ? 'true' : 'false') + '" title="' + (starredSet[en.id] ? 'unstar this model' : 'star this model') + '" style="background:' + (starredSet[en.id] ? 'rgba(234,179,8,0.12)' : 'transparent') + ';border:1px solid ' + (starredSet[en.id] ? 'rgba(234,179,8,0.45)' : 'transparent') + ';color:' + (starredSet[en.id] ? '#eab308' : 'var(--border-strong)') + ';width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:8px;flex-shrink:0;cursor:pointer;font-size:13px;padding:0;line-height:1;font-family:inherit;touch-action:manipulation;margin:0 8px 0 2px">★</button>';
    return '<div style="display:flex;align-items:center;gap:2px;border-left:2px solid ' + (en.isCurrent ? 'rgba(var(--ok-rgb),0.6)' : 'transparent') + (en.hasKey ? '' : ';opacity:0.65') + '">' +
      '<button data-qs="' + escAttr(en.id) + '" role="menuitem" title="' + escAttr(en.name) + '"' +
      ' style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;box-sizing:border-box;background:transparent;border:none;' +
      'color:var(--text-1);font-family:inherit;font-size:calc(var(--ui-fs) - 1px);font-weight:600;padding:10px 4px 10px 10px;cursor:pointer;' +
      'touch-action:manipulation;text-align:left;transition:background 120ms">' +
      glyph +
      '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(en.name) + '</span>' +
      curChip + prov + priceChip + cheapChip +
      '</button>' +
      starBtn +
      '</div>';
  }

  function renderQuickEntries(wrap, entries, state, icon, bodyEl, panel) {
    if (!document.getElementById('qs-popup') || document.getElementById('qs-popup') !== wrap) return; // closed meanwhile
    var MB = window.ModelBrowser;

    var html = '';
    // v0.32.6 F1: star state of every visible entry (recents can be
    // starred too — the ★ button on their right is filled then).
    var starredSet = {};
    for (var s0 = 0; s0 < entries.starred.length; s0++) starredSet[entries.starred[s0].id] = true;
    // v0.32.8 F2: cheapest PAID route across every visible row (recents +
    // starred, one pool — the decision is cross-section). Free rows keep
    // their "free" chip and never wear the tag (free is trivially
    // cheapest). The tag only shows when there's a real choice: ≥2 paid
    // routes, otherwise a lone paid row labeled "cheapest" is noise.
    var qsAll = entries.recent.concat(entries.starred);
    var qsPaidMin = Infinity, qsPaidCount = 0;
    for (var c0 = 0; c0 < qsAll.length; c0++) {
      var en0 = qsAll[c0];
      if (en0.hasKey && en0.price && en0.price !== 'free') {
        var pm0 = String(en0.price).match(/\$([0-9]+(?:\.[0-9]+)?)/);
        if (pm0) {
          var pv0 = parseFloat(pm0[1]);
          if (pv0 < qsPaidMin) qsPaidMin = pv0;
          qsPaidCount++;
        }
      }
    }
    var qsCheapSet = {};
    if (qsPaidCount >= 2) {
      for (var c1 = 0; c1 < qsAll.length; c1++) {
        var en1 = qsAll[c1];
        if (en1.hasKey && en1.price && en1.price !== 'free') {
          var pm1 = String(en1.price).match(/\$([0-9]+(?:\.[0-9]+)?)/);
          if (pm1 && Math.abs(parseFloat(pm1[1]) - qsPaidMin) < 1e-9) qsCheapSet[en1.id] = true;
        }
      }
    }
    if (entries.recent.length) {
      html += qsSectionHeader('Recent', '🕘', 'var(--text-3)');
      for (var i = 0; i < entries.recent.length; i++) html += qsRowHtml(entries.recent[i], starredSet, !!qsCheapSet[entries.recent[i].id]);
    }
    if (entries.starred.length) {
      html += qsSectionHeader('Starred', '★', '#eab308');
      for (var j = 0; j < entries.starred.length; j++) html += qsRowHtml(entries.starred[j], starredSet, !!qsCheapSet[entries.starred[j].id]);
    }
    if (!html) {
      // friendly empty state
      html = '<div style="padding:18px 16px;text-align:center">' +
        '<div style="font-size:22px;color:#eab308;margin-bottom:6px">★</div>' +
        '<div style="font-size:calc(var(--ui-fs) - 1px);font-weight:600;color:var(--text-1);margin-bottom:4px">Nothing pinned yet</div>' +
        '<div style="font-size:11px;color:var(--text-3);line-height:1.5">Star your favorite models in the browser and they land here for one-tap switching. Recently used models appear too.</div>' +
        '</div>';
    }
    // footer: browse everything
    html += '<div style="border-top:1px solid var(--surface-2);margin-top:6px">' +
      '<button data-qs-browse style="display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;background:transparent;border:none;color:var(--accent);font-family:inherit;font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;padding:10px 14px;cursor:pointer;touch-action:manipulation;text-align:left">' +
      'Browse all models <span style="color:var(--text-3)">→</span></button></div>';
    // inline hint slot
    html += '<div data-qs-hint style="display:none"></div>';

    wrap.innerHTML = html;

    // clamp vertical position now that content has real height
    var r2 = wrap.getBoundingClientRect();
    var anchor = document.getElementById('panel-star-btn');
    if (anchor) {
      var ar = anchor.getBoundingClientRect();
      var vh = window.innerHeight;
      var below2 = ar.bottom + r2.height + 12 < vh;
      var y2 = below2 ? ar.bottom + 8 : Math.max(8, ar.top - r2.height - 12);
      if (Math.abs(y2 - r2.top) > 2) wrap.style.top = y2 + 'px';
    }

    function qsHint(text, isWarn) {
      var h = wrap.querySelector('[data-qs-hint]');
      if (!h) return;
      h.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 12px 12px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.4;' +
        (isWarn
          ? 'background:rgba(var(--warn-rgb),0.1);border:1px solid rgba(var(--warn-rgb),0.4);color:var(--warn)'
          : 'background:rgba(var(--ok-rgb),0.08);border:1px solid rgba(var(--ok-rgb),0.35);color:var(--ok)');
      h.innerHTML = '<span>' + (isWarn ? '⚠' : '✓') + '</span><span style="flex:1">' + esc(text) + '</span>';
    }

    wrap.querySelectorAll('[data-qs]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.dataset.qs;
        row.style.background = 'rgba(128,128,140,0.1)';
        MB.quickPick(id, function (provider, modelId, lm) {
          applyModelChoice(provider, modelId, state, icon, bodyEl, panel);
          qsHint('Switched to ' + (lm && (lm.displayName || lm.logical) ? lm.displayName || lm.logical : id) + ' via ' + provider);
          setTimeout(closeQuickSwitch, 350);
        }, function (reason, lm) {
          row.style.background = '';
          if (reason === 'nokey') {
            qsHint('No API key yet for any provider of ' + ((lm && (lm.displayName || lm.logical)) || id) + ' — add one in the model browser\'s Providers tab.', true);
          } else {
            qsHint('That model is no longer in the catalog.', true);
          }
        });
      });
    });

    // v0.32.6 F1: the ★ toggles. One id can appear in BOTH sections —
    // (Recent + Starred) — so an in-place restyle would leave the twin
    // row stale. The popup is tiny and the catalog is cached, so the
    // correct-and-simple move is: toggle, re-render both sections from
    // the fresh lists, then surface a hint on the re-rendered popup.
    wrap.querySelectorAll('[data-qs-star]').forEach(function (sbtn) {
      sbtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = sbtn.dataset.qsStar;
        var nowOn = MB.toggleStar ? MB.toggleStar(id) : false;
        // v0.32.7 F1: toggleStar already refreshed the ★ badge.
        MB.quickEntries({ current: { provider: state.provider, modelId: state.model } }, function (ent2) {
          if (document.getElementById('qs-popup') !== wrap) return; // closed meanwhile
          renderQuickEntries(wrap, ent2, state, icon, bodyEl, panel);
          // v0.32.7 F3: pop the FRESH star button for the toggled row —
          // the re-render replaced the one that was tapped.
          var fresh = wrap.querySelector('[data-qs-star="' + String(id).replace(/"/g, '&quot;') + '"]');
          if (fresh) {
            fresh.classList.remove('mb-star-pop');
            void fresh.offsetWidth;
            fresh.classList.add('mb-star-pop');
          }
          qsHint(nowOn
            ? 'Starred ' + id + ' — pinned in the ★ Starred section.'
            : 'Unstarred ' + id + ' — it stays in Recent until it ages out.');
        });
      });
    });

    var browse = wrap.querySelector('[data-qs-browse]');
    if (browse) {
      browse.addEventListener('click', function () {
        closeQuickSwitch();
        if (!window.ModelBrowser) return;
        window.ModelBrowser.open(function (provider, modelId) {
          applyModelChoice(provider, modelId, state, icon, bodyEl, panel);
        }, { current: { provider: state.provider, modelId: state.model } });
      });
    }
  }

  // ── doSend (shared by input + regenerate) ──────────────────────
  function doSend(text, bodyEl, icon, state, panel) {
    var type = window.ChatTypes.get(state.sandbox || 'quick');
    var ctx = currentCtx && currentCtx.ctx;
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

    state.messages.push({ role: 'user', text: text, local: true });
    // v0.28 SMART SCROLL FREEZE: the user's own send re-engages the
    // follow — their finger is back in the conversation's here-and-now.
    state._scrollFrozen = false;
    appendMessage(msgContainer, null, { role: 'user', text: text }, bodyEl, icon);
    // v0.19: no auto-title on the first message (user spec — the random
    // default name stays until a manual rename).

    if (input) {
      input.value = '';
      state.draftText = '';
      input.style.height = 'auto';
    }

    state.isStreaming = true;
    // v0.23: start the no-silence watch the moment a turn begins (the
    // indicator covers the pre-first-token gap AND all tool phases).
    ensureActivityWatch(bodyEl, state);
    setActivity(bodyEl, state, 'sending…');
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

  // ── v0.19→v0.26: persona edits (the persona Sheet) land in every open
  // chat's state so PM turns compose the system message from the LATEST
  // list (personas + placeholders; the legacy single-persona column
  // stays as the fallback).
  window.addEventListener('doomalay:persona-saved', function (e) {
    var sid = e.detail && e.detail.sessionId;
    if (!sid) return;
    var list = e.detail.personas || null;
    var ph = e.detail.placeholders || null;
    var legacy = (e.detail && e.detail.persona) || '';
    for (var k in chatStates) {
      var st = chatStates[k];
      if (st && st.sessionId === sid) {
        st.persona = legacy;
        if (list) st.personas = list;
        if (ph) st.placeholders = ph;
      }
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
    current: function () { return currentCtx; },
    // v0.30: exposed for the tweaks view — a tweak saved before the first
    // message (no session yet) creates the session so the chat's own
    // look persists from the very first customization (same creator the
    // send path uses — one session per chat, ever).
    ensureSession: function (state, cb) {
      var icon = state && state._icon;
      if (!icon || !state) return cb && cb();
      ensureSession(icon, state, cb || function () {});
    }
  };
})();
