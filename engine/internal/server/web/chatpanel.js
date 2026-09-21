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

  // v0.38: when the master panel closes, NO chat owns the live DOM
  // anymore. panel.close() dispatches 'doomalay:panel-closed'; clearing
  // currentCtx here means a still-streaming background chat's closures
  // can't paint into the hidden panel (they flip to data-only mode).
  document.addEventListener('doomalay:panel-closed', function () {
    currentCtx = null;
  });

  // v0.38 PER-CHAT BOX DEFAULTS: thinking / sources / pills remember the
  // user's expanded/collapsed preference PER CHAT (tweaks blob uiState).
  function uiPref(state, key, dflt) {
    var ui = window.ChatTweaks && window.ChatTweaks.uiStateOf
      ? window.ChatTweaks.uiStateOf(state) : null;
    if (ui && typeof ui[key] === 'boolean') return ui[key];
    return dflt;
  }
  function saveUiPref(state, key, v) {
    if (window.ChatTweaks && window.ChatTweaks.setUiState) window.ChatTweaks.setUiState(state, key, v);
  }

  // v0.35 CHAT ISOLATION (the cross-chat leak): the panel body is ONE
  // shared DOM node — when chat B renders, it re-owns bodyEl and chat A's
  // event closures still hold the SAME node. Every render path below must
  // verify ownership ("am I the chat currently shown?") before touching
  // the live DOM. A background chat streaming or finishing must NEVER
  // paint its activity row, thinking bubbles, header meters, or send-button
  // state into the foreground chat's DOM.
  function isOwner(state) {
    return !!(currentCtx && currentCtx.state === state && currentCtx.bodyEl);
  }

  // ── v0.37 MESSAGE PRESENCE — timestamps + day separators ────────
  // The engine has ALWAYS persisted created_at per event (chat_events
  // .created_at rides the WS wire as ev.ts, Unix seconds) — the frontend
  // just dropped it. These helpers stamp + format it:
  //   evTsMs(ev)  engine seconds → local ms (fallback: now)
  //   fmtTime(ms) "14:32" (24h, locale hour12 respected via Intl)
  //   fmtDay(ms)  "Today" / "Yesterday" / "Mon, Mar 3" / "Mar 3, 2024"
  //   dayKey(ms)  local YYYY-MM-DD — the day-divider boundary key
  function evTsMs(ev) {
    var t = ev && ev.ts;
    if (typeof t === 'number' && t > 0) return Math.round(t * 1000);
    return Date.now();
  }
  function fmtTime(ms) {
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch (e) {
      var d = new Date(ms);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
  }
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function fmtDay(ms) {
    var d = new Date(ms);
    var today = new Date();
    var yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    var sameDay = function (a, b) { return dayKey(a.getTime()) === dayKey(b.getTime()); };
    if (sameDay(d, today)) return 'Today';
    if (sameDay(d, yest)) return 'Yesterday';
    var opts = (d.getFullYear() === today.getFullYear())
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    try { return new Intl.DateTimeFormat(undefined, opts).format(d); } catch (e) { return d.toDateString(); }
  }
  // The day divider html (a centered, hairline-flanked label).
  function dayDividerHTML(ms) {
    return '<div class="msg-day" data-day="' + dayKey(ms) + '"><span>' + esc(fmtDay(ms)) + '</span></div>';
  }
  // Does `ms` start a NEW calendar day vs the container's last rendered
  // ts? (appendMessage path — reads the live DOM, works for streaming.)
  // v0.37.1 FIX: the old querySelector('[data-ts]:last-of-type') broke the
  // moment a non-row DIV (a .msg-day divider, the .chat-working indicator)
  // sat after the last ts-bearing row — :last-of-type matched NOTHING, the
  // "no previous" branch fired, and stray day dividers landed mid-day.
  // A reverse walk is immune: find the LAST child that carries data-ts
  // (a ts row) or data-day (a divider — its day IS the day in effect).
  function needsDayDivider(container, ms) {
    if (!container || !container.children || !container.children.length) return false;
    var kids = container.children;
    for (var i = kids.length - 1; i >= 0; i--) {
      var k = kids[i];
      if (!k.getAttribute) continue;
      var ts = k.getAttribute('data-ts');
      if (ts) {
        var prevTs = parseInt(ts, 10);
        if (!prevTs || isNaN(prevTs)) return true;
        return dayKey(prevTs) !== dayKey(ms);
      }
      var day = k.getAttribute('data-day');
      if (day) return String(day) !== String(dayKey(ms));
    }
    return false; // no ts-bearing row yet → first message: no divider
  }

  // v0.35 (user spec #9): friendly provider names for the activity row's
  // silence fallback — "waiting on Nvidia…" instead of a bare "thinking…".
  var PROVIDER_LABELS = {
    nvidia: 'Nvidia', opencode: 'OpenCode', privatemodeai: 'PrivateMode',
    openrouter: 'OpenRouter', cloudflare: 'Cloudflare', groq: 'Groq',
    together: 'Together', mistral: 'Mistral', anthropic: 'Anthropic',
    openai: 'OpenAI', deepseek: 'DeepSeek'
  };

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

  // v0.34 PER-CHAT SCROLL MEMORY (user spec): "each chatbot must remember
  // the user's scroll position (where they were last at in the chatbot
  // view)". The scroller is #chat-scroll (inside the panel body); every
  // scroll records the position on the chat's state (plus a debounced
  // localStorage write so it survives reloads), renderHost RESTORES it
  // instead of jumping to the bottom, and panel.js's root-restored poke
  // re-applies it after a stacked view pops (detaching the DOM into the
  // stash fragment resets an element's scrollTop — the reported "back to
  // the top" bug).
  var SCROLL_KEY = 'doomalay.chatscroll.v1';
  function readScrollMap() {
    try { return JSON.parse(localStorage.getItem(SCROLL_KEY)) || {}; }
    catch (e) { return {}; }
  }
  var scrollSaveTimer = null;
  function saveScrollLS(id, pos) {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(function () {
      try {
        var m = readScrollMap();
        m[id] = pos;
        var keys = Object.keys(m);
        // cap the map at the 60 most-recent chats
        if (keys.length > 60) {
          delete m[keys[0]];
        }
        localStorage.setItem(SCROLL_KEY, JSON.stringify(m));
      } catch (e) {}
    }, 600);
  }
  function rememberScroll(state, pos) {
    state._scrollPos = pos;
    if (state._icon && state._icon.id) saveScrollLS(state._icon.id, pos);
  }
  function restoreChatScroll(scrollEl, state) {
    if (!scrollEl || !state) return;
    var pos = state._scrollPos;
    if (pos == null || isNaN(pos)) {
      scrollEl.scrollTop = scrollEl.scrollHeight; // first open — land on the now
      return;
    }
    var max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    scrollEl.scrollTop = Math.max(0, Math.min(pos, max));
  }

  // v0.33: the deferred labels re-render — panel.js pokes this event
  // when the last view pops and the stashed root becomes visible again,
  // so the one-shot label repaint finally runs (it had to wait: it
  // can't clobber an open view by writing bodyEl directly).
  // v0.34: the poke ALSO re-applies the chat's remembered scroll — the
  // stash round-trip resets the detached scroller to 0.
  document.addEventListener('doomalay:root-restored', function () {
    var c = currentCtx;
    if (!c || !c.state || !c.bodyEl || !c.bodyEl.isConnected) return;
    var sc = c.bodyEl.querySelector('#chat-scroll');
    if (sc && c.state._scrollPos != null) restoreChatScroll(sc, c.state);
    if (c.state._labelsPending && !c.state._labelsDone &&
        window.H && window.H.hasLabels && window.H.hasLabels()) {
      c.state._labelsPending = false;
      c.state._labelsDone = true;
      renderHost(c.bodyEl, c.icon, c.state, c.panel);
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
          '<div id="chat-messages" style="flex:1;padding:calc(16px * var(--chat-scale,1));display:flex;flex-direction:column;gap:calc(12px * var(--chat-scale,1))">' +
            (state.messages.length === 0
              ? '<div id="chat-greeting" style="text-align:center;color:var(--text-3);font-size: calc(var(--ui-fs) - 1px);padding:32px 20px">' +
                  esc(type.greeting) + ' ' + esc(icon.name) + '…</div>'
              : renderMessages(state.messages)) +
          '</div>' +
          // Sticky input bar — stays visible while scrolled.
          // v0.34: the input rides the chat scale too (typing in the size
          // you read); the textarea grows to at most ~3× its min height.
          '<div id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:var(--surface-1);border-top:1px solid var(--surface-2);padding:calc(10px * var(--chat-scale,1)) 16px calc(12px * var(--chat-scale,1));z-index:2">' +
          '<div id="chat-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>' +
          '<div style="display:flex;gap:8px">' +
            '<textarea id="chat-input" placeholder="' + esc(type.placeholder) + '" style="flex:1;background:var(--surface-1);border:1px solid var(--border);color:var(--text-1);padding:calc(10px * var(--chat-scale,1)) calc(12px * var(--chat-scale,1));border-radius:8px;font-size:calc(var(--chat-fs,16px) - 1px);font-family:inherit;resize:none;outline:none;min-height:calc(40px * var(--chat-scale,1));max-height:calc(120px * var(--chat-scale,1));line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
            '<button id="chat-send" style="background:var(--border-strong);border:none;color:var(--text-1);padding:0 calc(16px * var(--chat-scale,1));border-radius:8px;font-size:calc(var(--chat-fs,16px) - 1px);cursor:pointer;font-family:inherit;align-self:flex-start;height:calc(40px * var(--chat-scale,1))">Send</button>' +
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
    // v0.34: the same scroll event records WHERE the user is (the per-chat
    // scroll memory — see rememberScroll above).
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
        rememberScroll(state, scrollEl.scrollTop); // v0.34: where the user is
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

    // long-press message actions (copy / quote / regenerate / edit / delete)
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
          // v0.37: remember the popped tail's engine ids — the regenerate
          // re-sends, so the old assistant turn must not linger in the
          // engine's LLM context as a duplicate answer.
          var regenIds = [];
          while (state.messages.length && state.messages[state.messages.length - 1].role !== 'user') {
            var popped = state.messages.pop();
            if (popped.ei) regenIds.push(popped.ei);
          }
          // v0.37.1: pop the last USER message too — doSend re-adds it (the
          // engine dedupes its own echo). The old flow kept the original
          // user row AND added a duplicate via doSend, so the transcript
          // rendered the same text twice after every regenerate.
          var poppedUser = state.messages.pop();
          if (poppedUser && poppedUser.ei) regenIds.push(poppedUser.ei);
          emitHideEvents(state, regenIds);
          rebuildTranscript(msgContainer, state);
          doSend(lastUser.text, bodyEl, icon, state, panel);
        },
        // v0.37 — EDIT: truncate from the tapped user message, prefill the
        // input with its text, and pin an "editing…" banner over the input.
        // Cancel restores the stashed tail untouched; the actual send is a
        // normal doSend (the engine receives the edited text as the newest
        // turn; the replaced messages are masked via hide events).
        onEdit: function (mi) {
          if (state.isStreaming) return;
          var miN = parseInt(mi, 10);
          if (isNaN(miN) || miN < 0 || miN >= state.messages.length) return;
          if (state.messages[miN].role !== 'user') return;
          var ta = bodyEl.querySelector('#chat-input');
          if (!ta) return;
          // stash + truncate
          state._editStash = state.messages.splice(miN);
          var editText = state._editStash[0].text;
          ta.value = editText;
          state.draftText = editText;
          rebuildTranscript(msgContainer, state);
          showEditBanner(bodyEl, state, icon, panel);
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
        },
        // v0.37 — DELETE: drop the tapped message from the transcript and
        // mask its engine event (buildHistory + replay skip it everywhere).
        onDelete: function (mi) {
          if (state.isStreaming) return;
          var miN = parseInt(mi, 10);
          if (isNaN(miN) || miN < 0 || miN >= state.messages.length) return;
          var victim = state.messages[miN];
          if (!victim || (victim.role !== 'user' && victim.role !== 'assistant' && victim.role !== 'error')) return;
          state.messages.splice(miN, 1);
          if (victim.ei) emitHideEvents(state, [victim.ei]);
          rebuildTranscript(msgContainer, state);
          if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast('message deleted');
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
      // v0.35: reopening a chat MID-TURN used to render a plain "Send"
      // button — the stop affordance was lost until the turn ended. If this
      // chat is still streaming, restore Stop + its handler right away.
      if (state.isStreaming) {
        var stype = window.ChatTypes.get(state.sandbox || 'quick');
        sendBtn.textContent = 'Stop';
        sendBtn.onclick = function () { stype.stop(state, ctx || {}); };
      }

      // Connect the WS — only after the engine session exists; rebind the
      // icon's persisted session so a restart replays the SAME conversation.
      // SINGLE-FLIGHT: one bind, one client; later renders re-point onEvent.
      if (state.client) {
        state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl, bodyEl, icon, panel); };
        if (state.messages.length > 0 && msgContainer && msgContainer.querySelector('#chat-greeting')) {
          rebuildTranscript(msgContainer, state);
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
      // v0.34: back where the user left off (first open — no memory yet —
      // lands at the bottom, the familiar behavior). Coming back to a
      // chat they were reading mid-history stays mid-history now.
      if (state._scrollPos == null) {
        var m = readScrollMap();
        if (m && typeof m[icon.id] === 'number') state._scrollPos = m[icon.id];
      }
      restoreChatScroll(scrollEl, state);
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
      if (window.UsagePanel) window.UsagePanel.open(panel, u, { name: icon.name, sessionId: state.sessionId, state: state });
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
      if (state._usage && isOwner(state)) applyMeters(currentCtx.bodyEl, state, state._usage);
      return;
    }
    state._metersAt = now;
    fetch('/api/sessions/' + state.sessionId + '/usage').then(function (r) { return r.json(); }).then(function (u) {
      // v0.35 ISOLATION: usage meters paint ONLY into the chat that owns
      // the live DOM — the old fallback painted a background chat's turn
      // cost/context into the FOREGROUND chat's header.
      state._usage = u;
      if (isOwner(state)) applyMeters(currentCtx.bodyEl, state, u);
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
    // v0.38: the compaction POINT rides the ring — the solid zone runs
    // 0→threshold when auto-compaction is ON; OFF means no zone (the whole
    // circle is the runway, tick parked at the top, 0deg).
    var thr = 100;
    if (c.compactEnabled !== false) {
      thr = Math.max(10, Math.min(95, Number(c.compactThreshold) || 70));
    }
    ring.style.setProperty('--thr', String(thr));
    ring.style.setProperty('--zone', c.compactEnabled === false ? 'transparent' : 'rgba(var(--accent-rgb), 0.16)');
    ring.style.setProperty('--tick-op', c.compactEnabled === false ? '0' : '.95');
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
        // v0.37: mid-turn switches must end the running turn first (same
        // honest stop as the Stop button) — no orphaned stream fragments.
        stopTurnIfStreaming(state, bodyEl);
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
        streamMsg = { role: 'assistant', text: '', complete: false, streaming: true, ts: Date.now() };
        state.messages.push(streamMsg);
        appendMessage(msgContainer, scrollEl, streamMsg, bodyEl, icon);
      }
      return streamMsg;
    };

    var persist = function (type, payload, stampMsg) {
      if (!state.sessionId) return Promise.resolve();
      return fetch('/api/sessions/' + state.sessionId + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, text: payload })
      }).then(function (r) { return r.json(); }).then(function (saved) {
        if (saved && saved.id && saved.id > (state.lastEventI || 0)) {
          state.lastEventI = saved.id;
        }
        // v0.37: capture the engine event id on the local message so
        // delete/edit can mask it later (PM messages have no WS echo).
        if (saved && saved.id && stampMsg) {
          stampMsg.ei = saved.id;
          if (!stampMsg.ts) stampMsg.ts = Date.now();
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
        updateMessageEl(bodyEl, streamMsg, true, state);
        finalizeArtifacts(streamMsg, state, bodyEl); // v0.17
      }
      // v0.20: CHAIN the persists — the old fire-and-forget raced the
      // assistant + status fetches, and the status could land in the log
      // BEFORE the assistant text (replayed histories read out of order).
      var p = streamMsg && streamMsg.text ? persist('assistant', streamMsg.text, streamMsg) : Promise.resolve();
      p.then(function () {
        if (errText) {
          return persist('error', errText).then(function () {
            var epm = { role: 'error', text: errText };
            state.messages.push(epm);
            appendMessage(msgContainer, scrollEl, epm, bodyEl, icon);
            return persist('status', JSON.stringify({ state: 'error', usage: usage || null }));
          });
        }
        return persist('status', JSON.stringify({ state: 'idle', usage: usage || null }));
      });
    };

    // v0.37: stamp the doSend-pushed user message (the last one in state)
    // with its engine event id so PM-path user messages are deletable too.
    var lastUserMsg = null;
    for (var lu = state.messages.length - 1; lu >= 0; lu--) {
      if (state.messages[lu].role === 'user') { lastUserMsg = state.messages[lu]; break; }
    }
    persist('user', text, lastUserMsg);

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
          last = { role: 'thinking', text: '', open: true, streaming: true, startedAt: Date.now(), ts: Date.now() };
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last, bodyEl, icon);
        }
        last.text += t;
        scheduleUpdate(bodyEl, last, false, state);
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
        scheduleUpdate(bodyEl, m2, false, state);
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
          updateMessageEl(bodyEl, streamMsg, false, state);
        }
      },
      onTool: function (ev) {
        bumpActivity(state);
        if (ev.name === 'web_search' && ev.sources) {
          var srcs = ev.sources.map(function (s) {
            return { title: s.title, url: s.url, snippet: s.snippet };
          });
          var pmSrc = { role: 'sources', sources: srcs, ts: Date.now() };
          state.messages.push(pmSrc);
          appendMessage(msgContainer, scrollEl, pmSrc, bodyEl, icon);
          persist('sources', JSON.stringify(srcs));
        }
        var chip = { role: 'tool', text: ev.summary || '', tool: true, payload: ev, ts: Date.now() };
        if (ev.result) chip = { role: 'tool', text: ev.summary || '', result: true, payload: ev, ts: Date.now() };
        state.messages.push(chip);
        appendMessage(msgContainer, scrollEl, chip, bodyEl, icon);
        persist(chip.result ? 'tool_result' : 'tool_use',
          JSON.stringify({ name: ev.name, summary: ev.summary || '', text: ev.result || '' }), chip);
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

  // v0.38: effort follows the theme's notice tone (was hardcoded orange).
  function effortBtnStyle(active) {
    return 'flex-shrink:0;background:' + (active ? 'rgba(var(--notice-rgb, 251,146,60),0.15)' : 'transparent') +
      ';border:1px solid ' + (active ? 'rgba(var(--notice-rgb, 251,146,60),0.5)' : 'var(--border)') +
      ';color:' + (active ? 'var(--notice)' : 'var(--text-3)') +
      ';padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer';
  }

  // v0.38: the old builder appended hex-alpha to a var() ("var(--accent-2)22"
  // is INVALID CSS) — active web/deep-research buttons lost their tinted
  // background/border in every theme. Theme vars + rgba composition instead.
  function capBtnStyle(active, color) {
    var rgb = (color === 'var(--accent-2)') ? 'var(--accent-2-rgb)' : 'var(--accent-rgb)';
    return 'flex-shrink:0;background:' + (active ? 'rgba(' + rgb + ',0.16)' : 'transparent') +
      ';border:1px solid ' + (active ? 'rgba(' + rgb + ',0.55)' : 'var(--border)') +
      ';color:' + (active ? color : 'var(--text-3)') +
      ';padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer';
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
      wireClientClose(bodyEl, state, msgContainer);
      return;
    }
    state.client = new window.ChatClient('', state.sessionId, '');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl, bodyEl, null, null); };
    wireClientClose(bodyEl, state, msgContainer);
    state.client.connect();
  }

  // v0.35 (user spec #9): a WS drop mid-turn used to leave isStreaming=true
  // FOREVER — the bubble thought endlessly and leaked its state across chat
  // switches. Now the drop ends the turn with an honest error bubble in the
  // OWNING chat only; the engine's persisted events replay on reopen.
  function wireClientClose(bodyEl, state, msgContainer) {
    state.client.onClose = function () {
      if (!state.isStreaming) return;
      state.isStreaming = false;
      state._actText = null;
      var msg = { role: 'error', text: 'Connection to the engine dropped mid-reply — your messages are safe. Tap Send to retry.' };
      state.messages.push(msg);
      if (isOwner(state)) {
        hideActivity(bodyEl, state);
        appendMessage(currentCtx.bodyEl.querySelector('#chat-messages'), null, msg, currentCtx.bodyEl, state._icon, state);
        var btn = currentCtx.bodyEl.querySelector('#chat-send');
        if (btn) { btn.textContent = 'Send'; btn.onclick = null; }
        completeAllStreaming(currentCtx.bodyEl, state);
      }
    };
  }

  // ensureSession creates the engine session (if missing) and calls back.
  // v0.35 RACE FIX: the render path AND the send path can BOTH call this
  // for the same fresh chat (quick-chat + cloud provider repro) — two POSTs
  // raced, the WS bound session #1 while state.sessionId landed on #2, and
  // histories crossed after reload. One in-flight creation, queued cbs.
  function ensureSession(icon, state, cb) {
    if (state.sessionId) { cb(); return; }
    if (state._ensureQ) { state._ensureQ.push(cb); return; }
    state._ensureQ = [cb];
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionBody(icon, state))
    }).then(function (r) { return r.json(); }).then(function (data) {
      var q = state._ensureQ || [];
      state._ensureQ = null;
      if (data && data.ID) {
        state.sessionId = data.ID;
        icon._sessionData = data;
        bindSessionToIcon(icon, data.ID);
        q.forEach(function (c) { try { c(); } catch (e) { console.error(e); } });
      }
    }).catch(function (e) {
      state._ensureQ = null; // failed creation — next send retries fresh
      console.error('create session failed', e);
    });
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
  function stampThinkEnd(state, tsMs) {
    if (!state || !Array.isArray(state.messages)) return;
    var lt = state.messages[state.messages.length - 1];
    // v0.38: prefer the SERVER timestamp of the event that ended the
    // thinking phase (ev.ts rides every persisted event) — arrival time
    // lies on replays (whole turns land in one burst → "0s") and on
    // post-completion bursts.
    if (lt && lt.role === 'thinking' && !lt.endedAt) lt.endedAt = tsMs || Date.now();
  }

  function container2(bodyEl, mi) {
    var c = bodyEl ? bodyEl.querySelector('#chat-messages') : null;
    return c ? c.querySelector('[data-mi="' + mi + '"]') : null;
  }

  // ── Handle a WS event (idempotent replay, streaming, errors) ─────
  // v0.38 THE SANDBOX RULE (the chat-leak fix, for real): there is exactly
  // ONE live chat DOM — the FOREGROUND chat's projection of its state.
  // A background chat's events update its OWN state.messages (its
  // sandbox) and never touch any DOM: the panel's single bodyEl is shared,
  // and its #chat-messages resolves to whichever chat is on screen — the
  // root cause of every leak symptom (thought bubbles appearing in the
  // new chat, responses flashing in then vanishing on the next rebuild,
  // reasoning text overwriting another chat's bubble by index collision).
  // renderHost rebuilds the full transcript from state on reopen, so
  // data-only updates lose nothing.
  function handleEvent(ev, state, msgContainer, scrollEl, bodyEl, _icon, _panel) {
    var type = ev.type;
    // v0.38 BELT-AND-SUSPENDERS: every engine event carries session_id —
    // if it ever mismatches this chat's session, it is not ours to render
    // (guards against any future engine-side routing change).
    if (ev.session_id && state.sessionId && ev.session_id !== state.sessionId) return;
    if (isOwner(state) && currentCtx && currentCtx.bodyEl) {
      // owner → resolve the LIVE targets (stale closure inputs are ignored)
      var liveC = currentCtx.bodyEl.querySelector('#chat-messages');
      var liveS = currentCtx.bodyEl.querySelector('#chat-scroll');
      if (liveC) msgContainer = liveC;
      if (liveS) scrollEl = liveS;
      bodyEl = currentCtx.bodyEl;
    } else {
      // background chat → data-only sandbox mode
      msgContainer = null;
      scrollEl = null;
      bodyEl = null;
    }
    if (ev.i !== undefined && ev.i !== null && !isNaN(ev.i)) {
      if (ev.i <= (state.lastEventI || 0)) return;
      state.lastEventI = ev.i;
    }
    // v0.23 NO-SILENCE: ephemeral progress events (never persisted, no i)
    // drive the activity indicator — "building bundle.zip · 12.4 KB…".
    if (type === 'progress') {
      // v0.35: remember the latest provider/wait phase — renderActivity now
      // keeps it on screen for the whole turn (user spec #9) instead of
      // decaying to "thinking…" after 5s while NVIDIA queues the request.
      state._waitPhase = ev.text || ev.message || null;
      setActivity(bodyEl, state, ev.text || ev.message || 'working…');
      return;
    }
    if (type === 'user') {
      bumpActivity(state);
      var last = state.messages[state.messages.length - 1];
      if (last && last.role === 'user' && last.local && last.text === (ev.text || '')) {
        delete last.local;
        // v0.37: the engine echo is authoritative for ts + ei — restamp the
        // optimistic local message so replayed ids line up for delete/edit.
        last.ts = evTsMs(ev);
        if (ev.i) last.ei = ev.i;
        return;
      }
      var uMsg = { role: 'user', text: ev.text || '', ts: evTsMs(ev) };
      if (ev.i) uMsg.ei = ev.i;
      state.messages.push(uMsg);
      appendMessage(msgContainer, scrollEl, uMsg, bodyEl, state._icon, state);
      // v0.19: NO auto-title — the chat keeps its default random name from
      // the list until the user renames it themselves (tap the name in the
      // panel header).
      return;
    }
    if (type === 'assistant_delta' || type === 'assistant_complete') {
      bumpActivity(state);
      stampThinkEnd(state, evTsMs(ev)); // v0.27.1: content follows thinking → timer freezes
      if (ev.text) {
        var last = state.messages[state.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.complete) {
          last = { role: 'assistant', text: '', complete: false, streaming: true, ts: evTsMs(ev) };
          if (ev.i) last.ei = ev.i;
          state.messages.push(last);
          appendMessage(msgContainer, scrollEl, last, bodyEl, state._icon, state);
        }
        last.text += ev.text;
        scheduleUpdate(bodyEl, last, false, state);
      }
      if (type === 'assistant_complete') {
        var last2 = state.messages[state.messages.length - 1];
        if (last2) {
          last2.complete = true;
          last2.streaming = false;
          updateMessageEl(bodyEl, last2, true, state);
          finalizeArtifacts(last2, state, bodyEl);
        }
      }
    } else if (type === 'assistant') {
      stampThinkEnd(state, evTsMs(ev)); // v0.27.1
      var assembled = '';
      for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'assistant') assembled += state.messages[i].text;
      }
      if ((ev.text || '') && assembled.indexOf(ev.text) === -1) {
        var full = { role: 'assistant', text: ev.text, complete: true, ts: evTsMs(ev) };
        if (ev.i) full.ei = ev.i;
        state.messages.push(full);
        appendMessage(msgContainer, scrollEl, full, bodyEl, state._icon, state);
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
              updateMessageEl(bodyEl, state.messages[j], true, state);
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
        // v0.38: open is DERIVED at render time from the per-chat pref (a
        // tweaks fetch can race the replay; freezing it here staled it).
        lastThink = { role: 'thinking', text: '', streaming: true, startedAt: evTsMs(ev), ts: evTsMs(ev) };
        if (ev.i) lastThink.ei = ev.i;
        state.messages.push(lastThink);
        appendMessage(msgContainer, scrollEl, lastThink, bodyEl, state._icon, state);
      }
      lastThink.text += ev.text;
      scheduleUpdate(bodyEl, lastThink, false, state);
    } else if (type === 'tool_use') {
      bumpActivity(state);
      stampThinkEnd(state, evTsMs(ev)); // v0.27.1: the model moved on to tools
      // v0.20: PM-persisted tool events carry their payload as a JSON text
      // (the engine's own events have name/summary top-level) — lift it.
      var pay = ev;
      if ((!pay.name || pay.summary === undefined) && pay.text) {
        try { pay = JSON.parse(pay.text); } catch (e) {}
      }
      var tuMsg = { role: 'tool', text: pay.summary || pay.name || 'tool', tool: true, payload: pay, ts: evTsMs(ev) };
      if (ev.i) tuMsg.ei = ev.i;
      state.messages.push(tuMsg);
      appendMessage(msgContainer, scrollEl, tuMsg, bodyEl, state._icon, state);
    } else if (type === 'tool_result') {
      bumpActivity(state);
      stampThinkEnd(state, evTsMs(ev)); // v0.27.1
      var pay2 = ev;
      if ((!pay2.name || pay2.summary === undefined) && pay2.text) {
        try { pay2 = JSON.parse(pay2.text); } catch (e) {}
      }
      var trMsg = { role: 'tool', text: pay2.summary || pay2.name || '', result: true, payload: pay2, ts: evTsMs(ev) };
      if (ev.i) trMsg.ei = ev.i;
      state.messages.push(trMsg);
      appendMessage(msgContainer, scrollEl, trMsg, bodyEl, state._icon, state);
      // v0.22: file tools (docx/xlsx/zip) — a real download card follows the pill.
      if (ev.artifact && ev.artifact.name) {
        state.messages.push({ role: 'artifact', artifact: ev.artifact });
        appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon, state);
        // v0.26: same dedupe set as the WS path (see above).
        if (!state._toolArtifactNames) state._toolArtifactNames = {};
        state._toolArtifactNames[ev.artifact.name.toLowerCase()] = true;
      }
    } else if (type === 'sources') {
      stampThinkEnd(state, evTsMs(ev)); // v0.27.1
      var srcs = ev.sources || [];
      if (!srcs.length && ev.text) { try { srcs = JSON.parse(ev.text); } catch (e) {} }
      if (srcs.length) {
        var srcMsg = { role: 'sources', sources: srcs, open: uiPref(state, 'sourcesOpen', true), ts: evTsMs(ev) };
        if (ev.i) srcMsg.ei = ev.i;
        state.messages.push(srcMsg);
        appendMessage(msgContainer, scrollEl, srcMsg, bodyEl, state._icon, state);
      }
    } else if (type === 'hide') {
      // v0.37: an edit/delete/regenerate (this device or another) masked
      // engine events. Drop the matching messages from the local view —
      // the append-only log keeps everything, the transcript just skips.
      var hideIds = ev.ids || [];
      if (ev.text) { try { hideIds = JSON.parse(ev.text) || hideIds; } catch (e2) {} }
      var hideSet = {};
      for (var hi = 0; hi < hideIds.length; hi++) hideSet[hideIds[hi]] = true;
      var droppedAny = false;
      for (var hj = state.messages.length - 1; hj >= 0; hj--) {
        if (state.messages[hj].ei && hideSet[state.messages[hj].ei]) {
          state.messages.splice(hj, 1);
          droppedAny = true;
        }
      }
      if (droppedAny) {
        var hc = bodyEl && bodyEl.querySelector('#chat-messages');
        if (hc && isOwner(state)) rebuildTranscript(hc, state);
      }
    } else if (type === 'assistant_reset') {
      // v0.22: a long preamble streamed as if final, then turned out to be
      // a tool call — wipe the in-progress assistant message (the engine
      // also drops its persisted copy; the tool pill renders instead).
      // v0.38: the DOM row removal is OWNER-only — a background chat used
      // to resolve the shared bodyEl and DELETE a row from the foreground
      // chat (the "message vanished" flavor of the leak).
      for (var rk = state.messages.length - 1; rk >= 0; rk--) {
        var rm = state.messages[rk];
        if (rm.role === 'assistant') {
          if (!rm.complete && !rm.text) break;
          if (!rm.complete) {
            state.messages.splice(rk, 1);
            var rw = (isOwner(state) && currentCtx && currentCtx.bodyEl)
              ? container2(currentCtx.bodyEl, rk) : null;
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
      appendMessage(msgContainer, scrollEl, state.messages[state.messages.length - 1], bodyEl, state._icon, state);
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
        var btn = isOwner(state) ? bodyEl.querySelector('#chat-send') : null;
        // v0.35: only the chat that OWNS the live panel may reset its Send
        // button — the old document.querySelector reset the FOREGROUND
        // chat's Stop button while it was still streaming.
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
      // v0.37.1: ONE object for state + DOM (data-mi used to be -1 — the
      // push/append literal mismatch made error rows undeletable). ts + ei
      // ride along so errors get timestamps AND deletable engine ids.
      var emsg = { role: 'error', text: errText, ts: evTsMs(ev) };
      if (ev.i) emsg.ei = ev.i;
      state.messages.push(emsg);
      appendMessage(msgContainer, scrollEl, emsg, bodyEl, state._icon, state);
      var btn2 = isOwner(state) ? bodyEl.querySelector('#chat-send') : null;
      if (btn2) { btn2.textContent = 'Send'; btn2.onclick = null; }
    }
  }

  // throttled re-render for streaming (markdown every ~180ms, not per delta)
  // v0.35: ownerState rides along so background chats never index their
  // bubbles against the foreground chat.
  function scheduleUpdate(bodyEl, msg, immediate, ownerState) {
    if (immediate) { updateMessageEl(bodyEl, msg, true, ownerState); return; }
    msg._renderTimer = msg._renderTimer || 0;
    var now = Date.now();
    if (now - msg._renderTimer > 180) {
      msg._renderTimer = now;
      updateMessageEl(bodyEl, msg, false, ownerState);
    } else if (!msg._renderPending) {
      msg._renderPending = setTimeout(function () {
        msg._renderPending = null;
        msg._renderTimer = Date.now();
        updateMessageEl(bodyEl, msg, false, ownerState);
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
    // v0.35: only the chat that OWNS the live DOM may render its activity
    // row. Previously a background chat's closures wrote "waiting for
    // kimi-k3…" into whichever chat was on screen (the leak).
    if (!isOwner(state)) return;
    var container = currentCtx.bodyEl.querySelector('#chat-messages');
    if (!container) return;
    var row = container.querySelector('.chat-working');
    var text = state._actText;
    var silent = Date.now() - (state._lastActAt || 0);
    var show = state.isStreaming;
    if (!show) {
      if (row && row.parentNode) row.parentNode.removeChild(row);
      return;
    }
    // v0.35 (user spec #9): the engine's wait-notices ("waiting on Nvidia · Ns",
    // "…may be at capacity") must STAY on screen while the turn streams —
    // the old 5s decay fell back to a plain "thinking…" exactly during the
    // long NVIDIA pre-first-token queue (~30s measured live), hiding the
    // one text that told the user it was the provider, not the app. And
    // after ~8s of silence with no notice yet, the fallback names the
    // PROVIDER — the thing the user actually picked.
    var fallback = 'thinking…';
    if (silent > 8000 && state.provider) {
      fallback = 'waiting on ' + (PROVIDER_LABELS[state.provider] || state.provider) + '…';
    }
    var phase = text || (silent > 1500 ? (state._waitPhase || fallback) : 'working…');
    // v0.36 STALL ESCALATION (user spec: "the app should constantly check
    // if the stream/connection broke … surface errors"): after 120s of
    // TOTAL silence (no token, no progress event — covers both the
    // pre-first-token queue AND a mid-stream drop), the indicator
    // escalates: warn styling + an honest "may be stuck" line + a ⇄
    // switch-model chip so the user can act without losing the turn.
    // The silence clock starts at the LAST relevant activity OR the turn
    // start, whichever is later — a stale _lastActAt from a PREVIOUS turn
    // must not make a brand-new turn look stalled from its first second.
    var lastRelevant = Math.max(state._lastActAt || 0, state._turnStartAt || 0);
    var stallMs = Date.now() - lastRelevant;
    var stalled = state.isStreaming && stallMs >= 120000;
    if (stalled) {
      var who = (PROVIDER_LABELS[state.provider] || state.provider || 'the model');
      var mins = Math.floor(stallMs / 60000);
      phase = 'no response from ' + who + ' for ' + (mins >= 1 ? mins + 'm' : Math.round(stallMs / 1000) + 's') +
        ' — it may be stuck or rate-limited';
    }
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
    // v0.36: the stalled look + the ⇄ chip manage the SAME row element —
    // after the create/ensure block above (row can be null before it).
    if (row.classList.contains('chat-working-stalled') !== stalled) {
      row.classList.toggle('chat-working-stalled', stalled);
      scrollTo = true;
    }
    var chip = row.querySelector('.cw-switch');
    if (stalled && !chip) {
      // v0.36: the suggestion chip — opens the model browser bound to THIS
      // chat's pick handler; picking swaps the model for the NEXT turn
      // while the stuck one keeps its timeout backstop.
      chip = document.createElement('button');
      chip.className = 'cw-switch';
      chip.type = 'button';
      chip.textContent = '⇄ switch model';
      chip.setAttribute('aria-label', 'Switch to a different model');
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (!currentCtx || !currentCtx.ctx || !window.ModelBrowser) return;
        window.ModelBrowser.open(function (provider, modelId) {
          if (currentCtx && currentCtx.ctx) currentCtx.ctx.applyModel(provider, modelId);
        }, { current: { provider: state.provider, modelId: state.model } });
      });
      row.appendChild(chip);
      scrollTo = true;
    } else if (!stalled && chip && chip.parentNode) {
      chip.parentNode.removeChild(chip); // tokens resumed — stand down
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
    // v0.35: a background chat finishing its turn must not remove the
    // FOREGROUND chat's activity row (the old code did — that removal was
    // also why the leaked indicator "healed itself" when the old chat's
    // reply finally completed).
    if (!isOwner(state)) return;
    var container = currentCtx.bodyEl.querySelector('#chat-messages');
    if (container) {
      var row = container.querySelector('.chat-working');
      if (row && row.parentNode) row.parentNode.removeChild(row);
    }
  }

  // silence watchdog: while a turn runs, keep the indicator honest.
  function ensureActivityWatch(bodyEl, state) {
    state._turnStartAt = Date.now();
    // v0.36: a fresh turn resets the silence clock — a stale _lastActAt
    // from the PREVIOUS turn made both the "waiting on X…" fallback and
    // the 120s stall escalation fire instantly on a brand-new turn.
    state._lastActAt = Date.now();
    if (state._actTimer) return;
    state._actTimer = setInterval(function () {
      if (!state.isStreaming) {
        clearInterval(state._actTimer);
        state._actTimer = null;
        hideActivity(currentCtx && currentCtx.bodyEl, state);
        return;
      }
      // v0.35 ISOLATION: only render when THIS chat owns the live DOM. The
      // old `|| bodyEl` fallback resolved to the shared panel node and kept
      // a leaked "waiting on kimi-k3…" row ticking inside the foreground
      // chat even after it switched models/providers.
      var body = isOwner(state) ? currentCtx.bodyEl : null;
      if (body) {
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
        updateMessageEl(bodyEl, m, false, state);
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
    updateMessageEl(bodyEl, msg, true, state); // re-render → artifact cards appear
  }

  function refreshArtifactCount(state, bodyEl) {
    if (!state || !state.sessionId) return;
    window.Artifacts.list(state.sessionId).then(function (items) {
      state.artifactsCount = items.length;
      // v0.38: the artifacts badge paints only into the chat that owns the
      // live DOM — a background chat's count used to overwrite the
      // FOREGROUND chat's badge via the document fallback.
      if (!isOwner(state) || !currentCtx || !currentCtx.bodyEl) return;
      var badge = currentCtx.bodyEl.querySelector('#pill-artifacts-count');
      if (badge) badge.textContent = String(items.length);
    }).catch(function () {});
  }

  // ── THE MESSAGE RENDERER (everything formatted) ────────────────
  function renderMessages(messages) {
    var html = '';
    var prevTs = 0;
    for (var i = 0; i < messages.length; i++) {
      // v0.37: a centered day divider opens each new calendar day (and the
      // very first message — the Telegram/iMessage orientation pattern).
      if (messages[i].ts && dayKey(messages[i].ts) !== dayKey(prevTs || messages[i].ts)) {
        html += dayDividerHTML(messages[i].ts);
      }
      if (messages[i].ts) prevTs = messages[i].ts;
      html += messageHTML(messages[i], i);
    }
    return html;
  }

  // The bubble wrapper + Formatter content. Long-press handlers read
  // data-msg-role / data-msg-raw. data-mi = message index (streaming
  // updates re-find the bubble by it).
  //
  // v0.37: user/assistant bubbles ride inside a .msg-row (flex column)
  // with a .msg-time chip under the bubble — the chip must live OUTSIDE
  // the bubble because Formatter.renderInto REPLACES the bubble's
  // innerHTML on every streaming update (an in-bubble chip would be
  // wiped per delta). The row carries data-ts; the bubble carries
  // data-ts too (the long-press sheet reads it for its timestamp line).
  function messageHTML(msg, mi) {
    mi = (mi === undefined || mi === null) ? -1 : mi;
    var miAttr = ' data-mi="' + mi + '"';
    var tsAttr = msg.ts ? ' data-ts="' + msg.ts + '"' : '';
    if (msg.role === 'user') {
      return '<div class="msg-row msg-row-user"' + tsAttr + '>' +
        '<div class="msg-bubble msg-user" data-msg-role="user" data-msg-raw="' + escAttr(msg.text) + '"' + miAttr + tsAttr + '></div>' +
        (msg.ts ? '<div class="msg-time">' + esc(fmtTime(msg.ts)) + '</div>' : '') +
        '</div>';
    } else if (msg.role === 'assistant') {
      return '<div class="msg-row msg-row-assistant"' + tsAttr + '>' +
        '<div class="msg-bubble msg-assistant" data-msg-role="assistant" data-msg-raw="' + escAttr(msg.text) + '"' + miAttr + tsAttr + '></div>' +
        (msg.ts ? '<div class="msg-time">' + esc(fmtTime(msg.ts)) + '</div>' : '') +
        '</div>';
    } else if (msg.role === 'error') {
      return '<div class="msg-bubble msg-error" data-msg-role="error"' + miAttr + '>' +
        '<div class="fmt fmt-plain">' + esc(msg.text) + '</div></div>';
    } else if (msg.role === 'thinking') {
      // v0.38: per-chat thinkOpen pref drives the default (msg.open wins
      // only when explicitly set — the delegated toggle handler).
      var thinkOpen = msg.open !== undefined ? !!msg.open : uiPref(currentCtx && currentCtx.state, 'thinkOpen', true);
      return '<details class="msg-think"' + miAttr + ' ' + (thinkOpen ? ' open' : '') + '>' +
        '<summary class="msg-think-summary"><span class="msg-think-dot">✻</span> thinking' +
          '<span class="th-elapsed"' + (msg.streaming ? '' : ' style="display:none"') + '></span>' +
          '</summary>' +
        '<div class="msg-bubble msg-think-body" data-msg-role="thinking"></div>' +
        '</details>';
    } else if (msg.role === 'tool') {
      // TAPPABLE TOOL PILL — expands to the full payload (query / result).
      var payload = msg.payload || null;
      var hasDetail = !!(payload && ((payload.query || payload.name && (payload.result || payload.text || payload.summary)) || (payload.sources && payload.sources.length)));
      // v0.38: per-chat pills default (uiPref) unless this pill was toggled
      var expanded = hasDetail && (msg.expanded !== undefined ? !!msg.expanded : uiPref(currentCtx && currentCtx.state, 'pillsOpen', false));
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
      // v0.38: the sources box is COLLAPSIBLE (user spec) — a summary row
      // carries the count; the per-chat sourcesOpen pref drives the default.
      var srcOpen = msg.open !== undefined ? !!msg.open : uiPref(currentCtx && currentCtx.state, 'sourcesOpen', true);
      return '<details class="src-wrap" data-mi="' + mi + '"' + (srcOpen ? ' open' : '') + '>' +
        '<summary class="src-wrap-label"><span>SOURCES</span><span class="src-count">' + msg.sources.length + '</span><span class="src-chev">▾</span></summary>' +
        '<div class="src-list">' + items + '</div></details>';
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
  // v0.35 ISOLATION: ownerState (6th arg) is the chat the message BELONGS
  // to. When a background chat streams into its detached closure container,
  // we skip DOM work entirely — state.messages stays the source of truth and
  // renderHost rebuilds the transcript the moment the user reopens the chat.
  // The old code indexed background messages against the FOREGROUND chat's
  // array (mi=-1) and scrolled the foreground chat's view on every append.
  function appendMessage(container, scrollEl, msg, bodyEl, icon, ownerState) {
    // v0.38 SANDBOX RULE: a null container means the event belongs to a
    // BACKGROUND chat — state.messages already carries it; the DOM is the
    // foreground chat's alone. (Also guards nulls from callers that pass
    // no container.)
    if (!container) return null;
    var st = ownerState || (currentCtx && currentCtx.state);
    // v0.37 STALE-CLOSURE HARDENING: events processed by an earlier
    // renderHost's closure carried a DETACHED container (the panel has
    // since re-rendered) — appends into it silently vanished while later
    // events hit the live container, producing transcripts with random
    // missing rows. If this chat owns the live panel, ALWAYS target the
    // live container (the v0.35 ownership philosophy, mirrored).
    if (st && isOwner(st) && currentCtx.bodyEl) {
      var liveC = currentCtx.bodyEl.querySelector('#chat-messages');
      if (liveC && liveC !== container) container = liveC;
    }
    var greeting = container && container.querySelector('#chat-greeting');
    if (greeting && greeting.parentNode) greeting.parentNode.removeChild(greeting);
    var mi = st ? st.messages.indexOf(msg) : -1;
    // v0.37: a fresh calendar day gets its divider before the row.
    if (msg.ts && needsDayDivider(container, msg.ts)) {
      var ddiv = document.createElement('div');
      ddiv.innerHTML = dayDividerHTML(msg.ts);
      container.appendChild(ddiv.firstChild);
    }
    var div = document.createElement('div');
    div.innerHTML = messageHTML(msg, mi);
    var el = div.firstChild;
    container.appendChild(el);
    // The formatting target is the BUBBLE (rows wrap user/assistant only;
    // every other role is still its own top-level element).
    var bubble = el.classList && el.classList.contains('msg-bubble') ? el : (el.querySelector ? el.querySelector('.msg-bubble') : el);
    mountFormatting(bubble, msg);
    // v0.37: live appends get a one-shot entrance animation (a full
    // renderMessages rebuild — regenerate/edit/delete — must NOT re-
    // animate the whole transcript, so the class is added ONLY here).
    if (el.classList) {
      el.classList.add('msg-new');
      setTimeout(function () { if (el.classList) el.classList.remove('msg-new'); }, 400);
    }
    if (!ownerState || isOwner(ownerState)) scrollBottom(bodyEl || container);
    return bubble || el;
  }

  // re-format an existing message's bubble (found via data-mi)
  // v0.38 SANDBOX RULE: updates paint ONLY when this chat's state OWNS the
  // live DOM. Background chats keep their state.messages current (the
  // caller already mutated it) and the transcript is rebuilt from state on
  // reopen. The old code resolved #chat-messages off the SHARED bodyEl for
  // background chats — i.e. the FOREGROUND chat's container — then either
  // overwrote a foreign bubble by index collision or appended foreign
  // rows that vanished on the next rebuild. THE leak.
  function updateMessageEl(bodyEl, msg, final, ownerState) {
    var st = ownerState || (currentCtx && currentCtx.state);
    if (!st || !isOwner(st) || !currentCtx || !currentCtx.bodyEl) return;
    var container = currentCtx.bodyEl.querySelector('#chat-messages');
    if (!container) return;
    var mi = st.messages.indexOf(msg);
    if (mi < 0) return;
    var wrapper = container.querySelector('[data-mi="' + mi + '"]');
    if (!wrapper) {
      // not mounted yet (rare race) — append it (owner-only path)
      appendMessage(container, null, msg, currentCtx.bodyEl, null, ownerState);
      return;
    }
    var el = wrapper.classList.contains('msg-bubble') ? wrapper : wrapper.querySelector('.msg-bubble');
    mountFormatting(el, msg, final);
    if (final || msg.role === 'user') {
      scrollBottom(currentCtx.bodyEl);
    } else if (nearBottom(container)) {
      scrollBottom(currentCtx.bodyEl);
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

  // v0.37.1: rebuild the transcript from state AND format every bubble.
  // renderMessages emits EMPTY shells (the Formatter fills them) — every
  // rebuild path that skipped mountAllFormatting (regenerate since v0.26,
  // the new hide/edit/delete/restore paths) rendered blank bubbles.
  function rebuildTranscript(container, state) {
    if (!container) return;
    container.innerHTML = renderMessages(state.messages);
    mountAllFormatting(container, state);
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
  // v0.37: switching models MID-TURN left the running turn orphaned — its
  // stream kept going into the transcript as an "ACTIONS~" fragment and
  // the new model's turn collided with it. Both apply paths stop the
  // running turn FIRST (same path as the Stop button — abort + honest end).
  function stopTurnIfStreaming(state, bodyEl) {
    if (!state.isStreaming) return;
    try {
      var curType = window.ChatTypes.get(state.sandbox || 'quick');
      var curCtx = currentCtx && currentCtx.ctx;
      curType.stop(state, curCtx || {});
    } catch (eStop) { /* the swap proceeds regardless */ }
    state.isStreaming = false;
    var sBtn = bodyEl && bodyEl.querySelector('#chat-send');
    if (sBtn) { sBtn.textContent = 'Send'; sBtn.onclick = null; }
    hideActivity(bodyEl, state);
    completeAllStreaming(bodyEl, state);
  }

  function applyModelChoice(provider, modelId, state, icon, bodyEl, panel) {
    stopTurnIfStreaming(state, bodyEl);
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
    // v0.34 (user spec): the ★ quick-switch button is GONE from the chat
    // header — favorites now live in the model browser's own ★ tab (the
    // recents it showed survive as the "Recently used" sort). The browser
    // itself opens from the model button right here.
  }

  // ── doSend (shared by input + regenerate) ──────────────────────
  // v0.37: an EDIT that was committed (the user edited a message, we
  // truncated + stashed its tail) — mask the replaced engine events so
  // the resent text doesn't see the old turn as live context.
  function commitEditStash(state) {
    if (!state._editStash) return;
    var ids = [];
    for (var i = 0; i < state._editStash.length; i++) {
      if (state._editStash[i].ei) ids.push(state._editStash[i].ei);
    }
    emitHideEvents(state, ids);
    state._editStash = null;
  }

  // Mask engine events (edit/delete/regenerate) on BOTH chat paths:
  // WS sessions send a hide control frame; PrivateMode sessions POST
  // the same shape to the events endpoint. The engine persists ONE
  // 'hide' event carrying the ids — buildHistory + replay skip them.
  function emitHideEvents(state, ids) {
    if (!ids || !ids.length || !state.sessionId) return;
    if (state.provider === 'privatemodeai') {
      fetch('/api/sessions/' + state.sessionId + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'hide', text: JSON.stringify(ids) })
      }).catch(function (e) { console.error('hide persist failed', e); });
    } else if (state.client && state.client.sendRaw) {
      state.client.sendRaw({ type: 'hide', ids: ids });
    } else if (state.provider !== 'privatemodeai' && state.sessionId) {
      // no live WS (rare — session closed): the POST endpoint covers it.
      fetch('/api/sessions/' + state.sessionId + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'hide', text: JSON.stringify(ids) })
      }).catch(function (e) { console.error('hide persist failed', e); });
    }
  }

  // ── v0.37 EDITING BANNER (inside the sticky input bar) ─────────
  function showEditBanner(bodyEl, state, icon, panel) {
    if (!bodyEl) return;
    var existing = bodyEl.querySelector('#edit-banner');
    if (existing) return; // already editing
    var bar = bodyEl.querySelector('#chat-inputbar');
    if (!bar) return;
    var b = document.createElement('div');
    b.id = 'edit-banner';
    b.innerHTML =
      '<span class="eb-ico">✎</span>' +
      '<span class="eb-text">editing message</span>' +
      '<button class="eb-cancel" title="cancel and restore">cancel</button>';
    b.querySelector('.eb-cancel').addEventListener('click', function () {
      hideEditBanner(bodyEl, state, icon, panel, true);
    });
    bar.insertBefore(b, bar.firstChild);
    // slide-in
    requestAnimationFrame(function () { b.classList.add('open'); });
  }

  function hideEditBanner(bodyEl, state, icon, panel, restore) {
    var b = bodyEl && bodyEl.querySelector('#edit-banner');
    if (restore && state._editStash) {
      // cancel: put the stashed tail back, clear the input prefill
      for (var i = 0; i < state._editStash.length; i++) state.messages.push(state._editStash[i]);
      state._editStash = null;
      var ta = bodyEl.querySelector('#chat-input');
      if (ta) { ta.value = ''; state.draftText = ''; }
      var mc = bodyEl.querySelector('#chat-messages');
      if (mc) rebuildTranscript(mc, state);
    }
    if (b) {
      b.classList.remove('open');
      setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 200);
    }
  }

  function doSend(text, bodyEl, icon, state, panel) {
    var type = window.ChatTypes.get(state.sandbox || 'quick');
    var ctx = currentCtx && currentCtx.ctx;
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var input = bodyEl.querySelector('#chat-input');
    var sendBtn = bodyEl.querySelector('#chat-send');

    // v0.37: an edit was committed — drop the banner WITHOUT restoring,
    // mask the replaced events, then proceed as a normal send.
    if (state._editStash) {
      hideEditBanner(bodyEl, state, icon, panel, false);
      commitEditStash(state);
    }
    // v0.37: ONE object for state + DOM — the appended bubble's data-mi is a
    // real index (was -1: doSend used to append a *different* literal than
    // the pushed one, so edit/delete couldn't target user messages).
    var uMsg = { role: 'user', text: text, local: true, ts: Date.now() };
    state.messages.push(uMsg);
    // v0.28 SMART SCROLL FREEZE: the user's own send re-engages the
    // follow — their finger is back in the conversation's here-and-now.
    state._scrollFrozen = false;
    appendMessage(msgContainer, null, uMsg, bodyEl, icon, state);
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
          var connErr = { role: 'error', text: err };
          state.messages.push(connErr);
          appendMessage(msgContainer, null, connErr, bodyEl, icon, state);
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
    // v0.38: the per-chat pills default follows the user's last choice
    saveUiPref(st, 'pillsOpen', !!st.messages[msgIdx].expanded);
    // re-render just this pill in place
    var tmp = document.createElement('div');
    tmp.innerHTML = messageHTML(st.messages[msgIdx], msgIdx);
    var fresh = tmp.firstChild;
    pill.replaceWith(fresh);
  });

  // v0.38: the thinking + sources boxes remember their expanded/collapsed
  // state as the chat's DEFAULT (delegated — fires for any live message).
  document.addEventListener('toggle', function (e) {
    var el = e.target;
    if (!el || !el.classList) return;
    var st = currentCtx && currentCtx.state;
    if (!st) return;
    if (el.classList.contains('msg-think')) {
      // ignore programmatic open during render (user events only — a
      // fresh <details open> fires toggle on insert in some engines)
      if (el._toggling) return;
      el._toggling = true; setTimeout(function () { el._toggling = false; }, 0);
      saveUiPref(st, 'thinkOpen', !!el.open);
    } else if (el.classList.contains('src-wrap')) {
      if (el._toggling) return;
      el._toggling = true; setTimeout(function () { el._toggling = false; }, 0);
      var idx = el.getAttribute('data-mi');
      if (idx !== null && st.messages[idx]) st.messages[idx].open = !!el.open;
      saveUiPref(st, 'sourcesOpen', !!el.open);
    }
  }, true);

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
