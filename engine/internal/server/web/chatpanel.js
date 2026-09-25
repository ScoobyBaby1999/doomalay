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
//     │   [🗄 artifacts N] [⇩ export] [memory]        │     More pills ship per
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
//
// v0.42 THE SEND/QUEUE/STOP/RETRY BUTTON (user spec #4): the old text
//   "Send" button was a plain label the code mutated via textContent at
//   every turn boundary (and a Stopped mid-turn chat re-rendered it
//   wrong). It is now ONE mode machine — SendMode below — with an ICON
//   button (44px tap target, icon over a tiny label), four modes picked
//   automatically from {draft text, streaming, last-turn-failed}, and a
//   chevron mini-button that drops a manual-override menu (the override
//   sticks until it becomes impossible, then auto resumes). QUEUE:
//   follow-ups typed mid-reply park on state.queue as compact pills
//   above the composer and auto-send ONE per successful turn end (a
//   user STOP or a failure parks them — tap a pill to fire early).
//   RETRY: resends the last user text with the failed turn's engine
//   events masked (the regenerate machinery). Enter follows the live
//   mode: queue while streaming, send otherwise; Shift+Enter stays a
//   newline. v0.42 ALSO (spec #5): the in-chat search pill is GONE from
//   the header dropdown (find — local + global, with the new Aa / Exact
//   toggles — is the way forward; see globalsearch.js).
//
// v0.44 THE TEMPLATE PILL (user spec: "change the deep research pill
//   entirely to a template pill where user can select templates and
//   browse the library, with the deep research being one of the default
//   templates"): the ⌖ deep research toolbar button became ⧉ template —
//   it opens templatesheet.js (search / favorites / groups / the hub
//   library / publish). Selecting the pinned "deep research" row keeps
//   the OLD payload (deep_research: true — the engine-native pipeline);
//   any other template sets state.template {id, name, brief} (the brief
//   resolved client-side from the library entry) which rides every send
//   as template_id + template_brief and paints a removable ⧉ chip above
//   the composer. Persisted on the session (template column) + restored
//   on reload like the other caps.
//
// v0.44 INTERRUPT HARDENING (the "chat gets randomly interrupted and my
//   sent message lands back" report, root causes traced end-to-end):
//   · CAUSE #1 (engine restart mid-turn): the boot-heal status now
//     carries its message on the wire (store/events.go), and a LIVE
//     terminal status with a message renders a notice bubble here
//     (guarded by wasStreaming — replayed old heals never re-bubble).
//     Dead clients self-heal: renderHost/connectWS kick a reconnect on
//     a dead-but-present client, and ws_state 'failed' arms a 20s
//     background revive poll (a returning engine heals the chat without
//     the user having to send).
//   · CAUSE #2 (user-echo dedupe only checked the LAST message): a
//     mid-turn reconnect's gap replay re-pushed the sent message as a
//     duplicate. doSend now records _pendingSends; the 'user' handler
//     delegates to resolveUserEcho (pending match → tail-scan → push,
//     pure + unit-tested) and ONE adjacent-duplicate pass runs after a
//     reconnect replay (dropAdjacentUserDupes, also pure). The engine's
//     busy-reject now persists the user message + a terminal too (see
//     chat.go) — the optimistic bubble is never orphaned on reload.
//   · CAUSE #3 (isStreaming never re-armed): a live stream that arrives
//     WITHOUT a doSend (resumed mid-turn socket) re-arms streaming so
//     the busy lock can't desync — replayed events (chatclient's
//     connect-time _replay tag) never re-arm. PM turns set the client's
//     turnActive so their drops earn the long reconnect ladder.
//   · CAUSE #4 (late IME input): clearDraftLS stamps draftClearedAt;
//     saveDraftLS skips anything reported within 800ms of a send-clear
//     (stale composition state — the v0.42 timer-cancel only covered
//     saves armed BEFORE the clear).

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
        // v0.46: HF-chat routing (shared | own + repo) — session wins, icon
        // is the fallback for fresh chats.
        sandboxMode: (sessionData && (sessionData.SandboxMode || sessionData.sandbox_mode)) || (icon && icon.sandboxMode) || '',
        sandboxRepo: (sessionData && (sessionData.SandboxRepo || sessionData.sandbox_repo)) || (icon && icon.sandboxRepo) || '',
        model: (sessionData && (sessionData.Model || sessionData.model)) || (icon && icon.model) || '',
        provider: (sessionData && (sessionData.Provider || sessionData.provider)) || (icon && icon.provider) || '',
        effort: (sessionData && (sessionData.Effort || sessionData.effort)) || 'med',
        webSearch: !!(sessionData && (sessionData.WebSearch || sessionData.web_search)),
        deepResearch: !!(sessionData && (sessionData.DeepResearch || sessionData.deep_research)),
        // v0.44: the active method template (the template pill) —
        // {id, name, brief}; null = none. Deep research (one of the
        // default templates) keeps using deepResearch above.
        template: null,
        persona: (sessionData && (sessionData.Persona || sessionData.persona)) || '',
        // v0.26: multi-persona + placeholders + the chat's name ({name}).
        personas: null,
        placeholders: null,
        chatName: (icon && icon.name) || (sessionData && sessionData.Title) || '',
        slidingWindow: (sessionData && (sessionData.SlidingWindow || sessionData.sliding_window)) || 40,
        messages: [],
        isStreaming: false,
        draftText: '',
        // v0.42: the send/queue/stop/retry machine — queued follow-ups
        // + the manual mode override live on state (survive re-renders,
        // exactly like draftText). _holdQueue parks the auto-flush.
        queue: [],
        _sendModeOverride: null,
        _holdQueue: false,
        client: null,
        dropdownOpen: false,  // pills hidden by default until the arrow
        fulfilled: false,     // gatelock passed?
        lastEventI: 0,        // idempotent replay dedup
        artifactsCount: 0,
        artifactSaved: {},    // msg-index → true (avoid re-saving)
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

  // ── v0.40 PER-CHAT DRAFT PERSISTENCE ─────────────────────────────
  // The Google-Chat pattern (shipped there Sep 2026): an unsent half-
  // typed message survives app restarts, phone doze, and panel switches.
  // One JSON map in localStorage (same shape as the scroll memory):
  // keyed by session id, debounced 250ms writes on input, cleared on
  // send. state.draftText already carries the text within a session —
  // this makes it durable ACROSS sessions (process restarts).
  var DRAFT_KEY = 'doomalay.chatdraft.v1';
  function readDraftMap() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; }
    catch (e) { return {}; }
  }
  var draftSaveTimer = null;
  // v0.44 INTERRUPT FIX (CAUSE #4): sid → Date.now() of the last
  // send-clear. A mobile IME fires 'input' events AFTER Enter already
  // cleared the composer — stale composition state re-ran saveDraftLS
  // and resurrected the just-sent draft on the next re-render (the
  // v0.42 timer-cancel only covered saves ARMED before the clear).
  // Anything the IME reports within DRAFT_STALE_MS of a clear is stale;
  // real typing re-saves after that window.
  var draftClearedAt = {};
  // pure decision core (unit-tested in scripts/test_interrupt_fixes.js)
  function draftSaveStaleMs(clearedAtMs, nowMs) {
    return (nowMs - (clearedAtMs || 0)) < 800;
  }
  function saveDraftLS(sid, text) {
    // v0.44: the composer was just cleared by a send — skip the save
    // entirely (a late IME 'input' would otherwise re-arm the debounce
    // and write the stale text back 250ms later).
    if (sid && draftSaveStaleMs(draftClearedAt[sid], Date.now())) return;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(function () {
      try {
        var m = readDraftMap();
        if (text) m[sid] = text; else delete m[sid];
        var keys = Object.keys(m);
        // cap at the 60 most-recent chats (same budget as scroll memory)
        if (keys.length > 60) delete m[keys[0]];
        localStorage.setItem(DRAFT_KEY, JSON.stringify(m));
      } catch (e) {}
    }, 250);
  }
  function loadDraftLS(sid) {
    if (!sid) return '';
    try { return readDraftMap()[sid] || ''; } catch (e) { return ''; }
  }
  function clearDraftLS(sid) {
    if (!sid) return;
    // v0.44: stamp the clear so late IME input events can't resurrect
    // the draft (see draftClearedAt above).
    draftClearedAt[sid] = Date.now();
    // v0.42: cancel any pending debounced save FIRST — a send/queue whose
    // Enter followed the last keystroke by <250ms left the timer armed,
    // and it re-wrote the just-cleared draft a moment later (the text
    // then resurrected into the composer at the next re-render; live-
    // observed with agent-browser's back-to-back fill+Enter).
    clearTimeout(draftSaveTimer);
    try {
      var m = readDraftMap();
      if (m[sid] !== undefined) { delete m[sid]; localStorage.setItem(DRAFT_KEY, JSON.stringify(m)); }
    } catch (e) {}
  }
  // v0.40.1: drafts key by the CHAT ICON id (same as the scroll memory) —
  // state.sessionId binds asynchronously (WS bind), and the first cut keyed
  // drafts by session id, so a chip tap or send racing the bind no-op'd the
  // save/clear (live-observed flakes). The icon id is synchronous, stable,
  // and 1:1 with the chat.
  function draftId(state) {
    return (state && state._icon && state._icon.id) || (state && state.sessionId) || '';
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

  // ── v0.42 THE SEND MODE MACHINE (user spec #4) ───────────────────────
  // Four modes, ONE button. The auto mode is a pure function of
  // {draftText, isStreaming, lastTurnFailed}; a manual override (the
  // chevron dropdown) sticks until it becomes impossible, then auto
  // resumes. ONE entry point — SendMode.sync(bodyEl, state) — paints the
  // icon + label + actionable styling, and it replaces EVERY old
  // `btn.textContent = 'Send'/'Stop'/'…'` mutation site (the mode is
  // derived from state, never set by hand).
  // Icons: inline lucide-style SVG (stroke=currentColor, 20px box).

  function smSVG(inner, size) {
    var s = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var SEND_ICONS = {
    send: smSVG('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>'),
    stop: smSVG('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    queue: smSVG('<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M7 6h10"/><path d="M7 12h10"/><path d="M17 18h4"/><path d="M19 16v4"/>'),
    retry: smSVG('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    chev: smSVG('<path d="m6 9 6 6 6-6"/>', 14)
  };
  var SEND_MODES = {
    send:  { label: 'send',  aria: 'Send the message',      desc: 'Send now' },
    queue: { label: 'queue', aria: 'Queue until the reply finishes', desc: 'Queue until the reply finishes' },
    stop:  { label: 'stop',  aria: 'Stop the running turn', desc: 'Stop the running turn' },
    retry: { label: 'retry', aria: 'Retry the last message', desc: 'Retry the last message' }
  };

  // lastTurnFailed: the last non-deleted message is an error bubble
  // (engine 'error' events AND the connection-dropped error that
  // wireClientClose pushes — the retry affordance covers both).
  function lastTurnFailed(state) {
    if (!state || !state.messages || !state.messages.length) return false;
    return state.messages[state.messages.length - 1].role === 'error';
  }
  function lastUserText(state) {
    if (!state || !state.messages) return null;
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') return state.messages[i].text || '';
    }
    return null;
  }

  // The AUTO mode ladder (user spec #4):
  //   empty  + idle          → send   (ghost — nothing to send yet)
  //   empty  + streaming     → stop
  //   text   + streaming     → queue
  //   empty  + idle + failed → retry
  function autoSendMode(state) {
    var hasText = !!(state.draftText && state.draftText.trim());
    if (state.isStreaming) return hasText ? 'queue' : 'stop';
    if (!hasText && lastTurnFailed(state)) return 'retry';
    return 'send';
  }
  function sendModePossible(state, mode) {
    if (mode === 'queue' || mode === 'stop') return !!state.isStreaming;
    if (mode === 'retry') return !state.isStreaming && lastTurnFailed(state) && !!lastUserText(state);
    return true; // 'send' is always possible (it just does nothing with no text)
  }
  function sendModeActionable(state, mode) {
    var hasText = !!(state.draftText && state.draftText.trim());
    if (mode === 'stop') return !!state.isStreaming;
    if (mode === 'queue') return !!state.isStreaming && hasText;
    if (mode === 'retry') return sendModePossible(state, 'retry');
    return hasText;
  }

  // one injected stylesheet for the whole v0.42 UI (send cluster, mode
  // menu, queued pills + the find bar's Aa/Exact chips) — index.html
  // keeps its generic #chat-send / .chat-find rules.
  var smStyleEl = null;
  function ensureSendModeStyle() {
    if (smStyleEl && smStyleEl.isConnected) return;
    smStyleEl = document.createElement('style');
    smStyleEl.id = 'sendmode-style';
    smStyleEl.textContent = [
      '#send-cluster { display:flex; align-items:stretch; flex-shrink:0; align-self:flex-start; }',
      '#chat-send {',
      '  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;',
      '  min-width:56px; height:calc(44px * var(--chat-scale,1)); padding:2px 4px;',
      '  border:1px solid var(--border); border-radius:10px 0 0 10px; cursor:pointer; font-family:inherit;',
      '  background:transparent; color:var(--text-3);',
      '  transition: background .15s ease, color .15s ease, border-color .15s ease, opacity .15s ease; }',
      '#chat-send .sm-lab { font-size:9px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; line-height:1; }',
      '#chat-send.sm-on { background:rgba(var(--accent-rgb),0.16); border-color:rgba(var(--accent-rgb),0.55); color:var(--accent); }',
      '#chat-send.sm-on.sm-t-warn { background:rgba(var(--warn-rgb),0.15); border-color:rgba(var(--warn-rgb),0.5); color:var(--warn); }',
      '#chat-send.sm-on.sm-t-ok { background:rgba(var(--ok-rgb),0.15); border-color:rgba(var(--ok-rgb),0.5); color:var(--ok); }',
      '#chat-send.sm-ghost { background:var(--surface-2); border-color:var(--border); color:var(--text-3); }',
      '#chat-send.sm-busy svg { animation: sm-pulse 1s ease-in-out infinite; }',
      '@keyframes sm-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }',
      '#chat-send-more {',
      '  width:26px; border:1px solid var(--border); border-left:none; border-radius:0 10px 10px 0;',
      '  background:var(--surface-2); color:var(--text-3); cursor:pointer; font-family:inherit;',
      '  display:flex; align-items:center; justify-content:center;',
      '  transition: background .15s ease, color .15s ease, border-color .15s ease; }',
      '#chat-send-more:active { transform: scale(0.94); }',
      '#send-cluster.sm-cluster-on #chat-send-more { border-color:rgba(var(--accent-rgb),0.55); background:rgba(var(--accent-rgb),0.10); color:var(--accent); }',
      '#send-cluster.sm-cluster-warn #chat-send-more { border-color:rgba(var(--warn-rgb),0.5); background:rgba(var(--warn-rgb),0.09); color:var(--warn); }',
      '#send-cluster.sm-cluster-ok #chat-send-more { border-color:rgba(var(--ok-rgb),0.5); background:rgba(var(--ok-rgb),0.09); color:var(--ok); }',
      '#chat-send-more:focus-visible, .sm-row:focus-visible, .sq-x:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }',
      // the find bar's Aa / Exact chips (v0.42) — 32px min tap targets
      '.chat-find-chip {',
      '  min-width:38px; height:32px; padding:0 9px; margin:0 1px; flex-shrink:0;',
      '  font-family:inherit; font-size:12px; font-weight:700; line-height:1;',
      '  color:var(--text-3); background:var(--surface-2); border:1px solid var(--border);',
      '  border-radius:8px; cursor:pointer; letter-spacing:.02em;',
      '  transition:color .14s ease, border-color .14s ease, background .14s ease; }',
      '.chat-find-chip:active { transform:scale(0.94); }',
      '.chat-find-chip[aria-pressed="true"] {',
      '  color:var(--accent); border-color:rgba(var(--accent-rgb),0.55);',
      '  background:rgba(var(--accent-rgb),0.12); }',
      '.chat-find-chip:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }',
      // the queued-pills rail (inside the sticky composer)
      '#send-queue { display:flex; flex-direction:column; gap:4px; margin-bottom:8px; }',
      '.sq-row { display:flex; align-items:center; gap:8px; cursor:pointer; font-family:inherit;',
      '  background:rgba(var(--accent-rgb),0.07); border:1px dashed rgba(var(--accent-rgb),0.55);',
      '  color:var(--text-2); border-radius:9px; padding:4px 4px 4px 10px; text-align:left; width:100%;',
      '  transition: background .14s ease; }',
      '.sq-row:hover { background:rgba(var(--accent-rgb),0.13); }',
      '.sq-row .sq-text { flex:1; min-width:0; font-size:var(--ui-small-fs);',
      '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.sq-row .sq-tag { flex-shrink:0; font-size:var(--ui-micro-fs); font-weight:700; color:var(--accent);',
      '  text-transform:uppercase; letter-spacing:.06em; }',
      '.sq-x { width:32px; height:32px; flex-shrink:0; border:none; border-radius:7px;',
      '  background:transparent; color:var(--text-3); cursor:pointer; font-size:15px; font-family:inherit;',
      '  display:flex; align-items:center; justify-content:center; }',
      '.sq-x:active { transform: scale(0.9); background:var(--surface-3); }',
      // the manual-override dropdown (absolute inside #chat-root — the
      // panel's transform hijacks position:fixed; see openSendMenu)
      '#send-menu { position:absolute; z-index:2600; width:268px; padding:4px;',
      '  background-color:var(--surface-1); border:1px solid var(--border); border-radius:12px;',
      '  box-shadow:0 10px 30px rgba(0,0,0,.24);',
      '  opacity:0; transform:translateY(6px); transition:opacity .14s ease, transform .14s ease; }',
      '#send-menu.open { opacity:1; transform:translateY(0); }',
      '.sm-head { display:flex; align-items:center; justify-content:space-between; gap:8px;',
      '  padding:6px 10px 4px; font-size:var(--ui-micro-fs); font-weight:700; color:var(--text-3);',
      '  text-transform:uppercase; letter-spacing:.07em; }',
      '.sm-reset { border:none; background:transparent; color:var(--accent); cursor:pointer;',
      '  font:inherit; font-size:var(--ui-micro-fs); font-weight:700; padding:4px 6px; border-radius:6px;',
      '  text-transform:none; letter-spacing:0; }',
      '.sm-reset:active { background:rgba(var(--accent-rgb),0.14); }',
      '.sm-row { display:flex; align-items:center; gap:10px; width:100%; padding:7px 10px;',
      '  background:transparent; border:none; border-radius:9px; cursor:pointer; font-family:inherit;',
      '  color:var(--text-2); text-align:left; transition:background .13s ease; }',
      '.sm-row:hover:not([disabled]) { background:var(--surface-2); }',
      '.sm-row[disabled] { opacity:.4; cursor:default; }',
      '.sm-row.on { background:rgba(var(--accent-rgb),0.12); color:var(--accent); }',
      '.sm-row svg { flex-shrink:0; }',
      '.sm-rmeta { flex:1; min-width:0; }',
      '.sm-rname { display:block; font-size:var(--ui-small-fs); font-weight:700; line-height:1.25; }',
      '.sm-rdesc { display:block; font-size:var(--ui-micro-fs); color:var(--text-3); line-height:1.3; margin-top:1px; }',
      '.sm-row.on .sm-rdesc { color:inherit; opacity:.75; }',
      '.sm-auto { flex-shrink:0; font-size:var(--ui-micro-fs); font-weight:700; color:var(--text-3);',
      '  border:1px solid var(--border); border-radius:5px; padding:1px 5px; text-transform:uppercase; letter-spacing:.05em; }',
      '.sm-row.on .sm-auto { color:var(--accent); border-color:rgba(var(--accent-rgb),0.5); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  #chat-send.sm-busy svg, #send-menu, .sq-row { transition:none; animation:none; }',
      '}'
    ].join('\n');
    document.head.appendChild(smStyleEl);
  }

  var SendMode = {
    // the EFFECTIVE mode (override if possible, else auto). A stale
    // override that became impossible is cleared here — auto resumes.
    mode: function (state) {
      var auto = autoSendMode(state);
      var ov = state._sendModeOverride;
      if (ov && ov !== auto && sendModePossible(state, ov)) return ov;
      if (ov) state._sendModeOverride = null; // impossible → auto resumes
      return auto;
    },
    // manual override ('auto' clears it); repaints the owning chat.
    set: function (state, mode) {
      state._sendModeOverride = (mode === 'auto' || mode === autoSendMode(state)) ? null : mode;
      if (isOwner(state) && currentCtx && currentCtx.bodyEl) SendMode.sync(currentCtx.bodyEl, state);
    },
    // ONE painter. Owner-guarded (v0.35 isolation): only the chat that
    // owns the live DOM paints its button — stale closures resolve the
    // LIVE body first, exactly like appendMessage/handleEvent do.
    sync: function (bodyEl, state) {
      if (!state || !isOwner(state) || !currentCtx || !currentCtx.bodyEl) return;
      var live = currentCtx.bodyEl;
      var btn = live.querySelector('#chat-send');
      if (!btn) return;
      var mode = SendMode.mode(state);
      var M = SEND_MODES[mode];
      var on = sendModeActionable(state, mode);
      btn.setAttribute('data-mode', mode);
      btn.setAttribute('aria-label', M.aria);
      btn.innerHTML = SEND_ICONS[mode] + '<span class="sm-lab">' + M.label + '</span>';
      btn.classList.toggle('sm-on', on);
      btn.classList.toggle('sm-ghost', !on);
      btn.classList.toggle('sm-t-warn', on && mode === 'stop');
      btn.classList.toggle('sm-t-ok', on && mode === 'retry');
      btn.classList.remove('sm-busy'); // busy (connecting) is a doSend overlay
      var cluster = live.querySelector('#send-cluster');
      if (cluster) {
        cluster.classList.toggle('sm-cluster-on', on && (mode === 'send' || mode === 'queue'));
        cluster.classList.toggle('sm-cluster-warn', on && mode === 'stop');
        cluster.classList.toggle('sm-cluster-ok', on && mode === 'retry');
      }
    }
  };
  // the one-liner every turn-boundary site calls (replaces the old
  // `btn.textContent = 'Send' | 'Stop' | '…'` mutations, one by one).
  function syncSendButton(bodyEl, state) { SendMode.sync(bodyEl, state); }
  // the connecting overlay: pulse whatever mode is live ('…' in v0.41).
  function setSendBusy(bodyEl, on) {
    var btn = bodyEl && bodyEl.querySelector('#chat-send');
    if (btn) btn.classList.toggle('sm-busy', !!on);
  }

  // ── v0.42 THE QUEUE (follow-ups typed while a reply streams) ────────
  // state.queue lives on the chat's state (like draftText) so it survives
  // re-renders; the pills ride the sticky composer so they stay visible.
  // Flush policy: ONE queued message per SUCCESSFUL turn end (status
  // idle / PM finish). A user stop, an error, or a dropped connection
  // PARKS the queue (state._holdQueue) — "stop" must mean stop — and the
  // next manual send re-arms the auto-flush.

  function enqueueDraft(bodyEl, state, icon, panel) {
    var input = bodyEl ? bodyEl.querySelector('#chat-input') : null;
    var text = ((input ? input.value : state.draftText) || '').trim();
    if (!text || !state.isStreaming) return; // queueing only makes sense mid-turn
    if (!state.queue) state.queue = [];
    state.queue.push({ text: text, ts: Date.now() });
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    state.draftText = '';
    clearDraftLS(draftId(state)); // the draft left home with the queue
    renderSendQueue(bodyEl, state, icon, panel);
    syncSendButton(bodyEl, state); // input now empty → mode may flip
  }

  function renderSendQueue(bodyEl, state, icon, panel) {
    if (!bodyEl || !isOwner(state)) return;
    var live = currentCtx.bodyEl;
    var bar = live.querySelector('#chat-inputbar');
    if (!bar) return;
    var host = bar.querySelector('#send-queue');
    var q = state.queue || [];
    if (!q.length) {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = 'send-queue';
      bar.insertBefore(host, bar.firstChild); // above the toolbar, like the edit banner
    }
    host.innerHTML = '';
    for (var i = 0; i < q.length; i++) {
      (function (idx) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'sq-row';
        row.innerHTML =
          '<span class="sq-tag">queued</span>' +
          '<span class="sq-text">' + esc(q[idx].text) + '</span>' +
          '<span class="sq-x" role="button" aria-label="Remove queued message" title="Remove">✕</span>';
        row.title = state.isStreaming ? 'Tap to send now — stops the running reply' : 'Tap to send now';
        row.addEventListener('click', function (e) {
          if (e.target.closest && e.target.closest('.sq-x')) {
            state.queue.splice(idx, 1);
            renderSendQueue(bodyEl, state, icon, panel);
            return;
          }
          if (state.isStreaming) {
            // v0.42 "tap to send now": the tapped item jumps the queue and
            // the running turn STOPS for it — the stop-induced turn end
            // (status idle / PM finish) flushes THIS item first, so the
            // transports never see two turns at once.
            var tapped = state.queue.splice(idx, 1)[0];
            if (tapped) state.queue.unshift(tapped);
            state._holdQueue = false; // this stop exists FOR the flush
            renderSendQueue(bodyEl, state, icon, panel);
            try {
              (window.ChatTypes.get(state.sandbox || 'quick')).stop(state, (currentCtx && currentCtx.ctx) || {});
            } catch (eStop) { /* best-effort — the idle path still flushes */ }
            return;
          }
          var item = state.queue.splice(idx, 1)[0];
          renderSendQueue(bodyEl, state, icon, panel);
          if (item) doSend(item.text, live, icon, state, panel);
        });
        host.appendChild(row);
      })(i);
    }
  }

  function flushSendQueue(bodyEl, state) {
    if (!state || !state.queue || !state.queue.length) return;
    if (state.isStreaming || state._holdQueue) return;
    if (!isOwner(state) || !currentCtx || !currentCtx.bodyEl) return; // reopen path flushes
    var next = state.queue.shift();
    renderSendQueue(currentCtx.bodyEl, state, currentCtx.icon, currentCtx.panel);
    doSend(next.text, currentCtx.bodyEl, currentCtx.icon, state, currentCtx.panel);
  }

  // A chat reopened with a parked queue (the flush sites are owner-only,
  // so a background finish parked one). Wait for the WS + replay to
  // settle (no new event for ~600ms) so the flushed send never
  // interleaves with replayed history; PM chats have no WS — fire after
  // the first tick. Cap ~10s.
  function scheduleOpenFlush(bodyEl, state) {
    if (!state.queue || !state.queue.length || state.isStreaming || state._holdQueue) return;
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (!isOwner(state) || state.isStreaming || state._holdQueue ||
          !state.queue || !state.queue.length) { clearInterval(t); return; }
      var ready = (state.provider === 'privatemodeai') ||
        (state.client && state.client.connected &&
          (Date.now() - (state._lastEvAt || 0) > 600));
      if (ready || tries > 100) {
        clearInterval(t);
        flushSendQueue(bodyEl, state);
      }
    }, 100);
  }

  // ── v0.42 RETRY: re-send the last user message as a new turn ───────
  // The failed turn's engine events are masked first (the same
  // edit/regenerate machinery — emitHideEvents) so the retry doesn't see
  // the broken turn as live context, then doSend replays it as the
  // newest turn. No last user message → the button is disabled.
  function doRetrySend(bodyEl, icon, state, panel) {
    if (!state || state.isStreaming) return;
    var lastUser = null, lu = -1;
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') { lastUser = state.messages[i]; lu = i; break; }
    }
    if (!lastUser || !lastUser.text || lu < 0) return; // retry disabled
    if (state._editStash) { // same contract as doSend's edit path
      hideEditBanner(bodyEl, state, icon, panel, false);
      commitEditStash(state);
    }
    var ids = [];
    while (state.messages.length && state.messages[state.messages.length - 1].role !== 'user') {
      var popped = state.messages.pop();
      if (popped.ei) ids.push(popped.ei);
    }
    var poppedUser = state.messages.pop();
    if (poppedUser && poppedUser.ei) ids.push(poppedUser.ei);
    emitHideEvents(state, ids);
    var live = (isOwner(state) && currentCtx && currentCtx.bodyEl) ? currentCtx.bodyEl : bodyEl;
    var mc = live && live.querySelector('#chat-messages');
    if (mc) rebuildTranscript(mc, state);
    doSend(lastUser.text, live, icon, state, panel);
  }

  // ── v0.42 THE MODE DROPDOWN (the chevron mini-button) ──────────────
  // Manual override with one-line descriptions; impossible modes read
  // disabled. The override sticks until impossible (SendMode.mode
  // clears it); "auto" resets it by hand.
  function openSendMenu(bodyEl, state) {
    if (!isOwner(state) || !currentCtx || !currentCtx.bodyEl) return;
    var live = currentCtx.bodyEl;
    var existing = live.querySelector('#send-menu');
    if (existing) { closeSendMenu(live); return; } // chevron toggles
    var cluster = live.querySelector('#send-cluster');
    if (!cluster) return;
    ensureSendModeStyle();

    var el = document.createElement('div');
    el.id = 'send-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Send button mode');

    var head = document.createElement('div');
    head.className = 'sm-head';
    head.innerHTML = '<span>send button</span>';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'sm-reset';
    reset.textContent = 'auto';
    reset.title = 'Let the button pick the mode automatically';
    reset.addEventListener('click', function (e) {
      e.stopPropagation();
      SendMode.set(state, 'auto');
      closeSendMenu(live);
    });
    head.appendChild(reset);
    el.appendChild(head);

    var eff = SendMode.mode(state);
    var auto = autoSendMode(state);
    ['send', 'queue', 'stop', 'retry'].forEach(function (m) {
      var M = SEND_MODES[m];
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'sm-row' + (m === eff ? ' on' : '');
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', m === eff ? 'true' : 'false');
      var possible = sendModePossible(state, m);
      if (!possible) row.setAttribute('disabled', 'disabled');
      row.innerHTML = SEND_ICONS[m] +
        '<span class="sm-rmeta"><span class="sm-rname">' + M.label + '</span>' +
        '<span class="sm-rdesc">' + M.desc + '</span></span>' +
        (m === auto ? '<span class="sm-auto">auto</span>' : '');
      if (possible) row.addEventListener('click', function (e) {
        e.stopPropagation();
        SendMode.set(state, m);
        closeSendMenu(live);
      });
      el.appendChild(row);
    });

    live.querySelector('#chat-root').appendChild(el);
    // anchor above the composer, right-aligned to the cluster. ABSOLUTE
    // inside #chat-root with rect DIFFERENCES — the panel's translateY
    // transform makes position:fixed resolve against the transformed
    // box (measured live: a fixed menu landed 320px off-screen below),
    // while viewport-rect differences cancel any transform cleanly.
    var rootR = live.querySelector('#chat-root').getBoundingClientRect();
    var r = cluster.getBoundingClientRect();
    var w = 268;
    var left = Math.max(6, Math.min(r.right - rootR.left - w, rootR.width - w - 6));
    el.style.left = Math.round(left) + 'px';
    el.style.top = 'auto';
    el.style.bottom = Math.round(rootR.bottom - r.top + 8) + 'px';
    requestAnimationFrame(function () { el.classList.add('open'); });

    var dismiss = function (e) {
      // v0.42: a renderHost re-render nukes the menu with the old DOM —
      // self-retire here, or the capture listener leaks on document.
      if (!el.isConnected) { if (el._cleanup) el._cleanup(); return; }
      if (!(e.target.closest && e.target.closest('#send-menu, #send-cluster'))) {
        closeSendMenu(live);
      }
    };
    var onKey = function (e) {
      if (e.key === 'Escape') closeSendMenu(live);
    };
    document.addEventListener('click', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    el._cleanup = function () {
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
    };
    setTimeout(function () { try { el.querySelector('.sm-row:not([disabled])').focus(); } catch (e) {} }, 60);
  }
  function closeSendMenu(bodyEl) {
    var el = bodyEl && bodyEl.querySelector('#send-menu');
    if (!el) return;
    if (el._cleanup) el._cleanup();
    el.classList.remove('open');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 150);
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
    // v0.44: a template was activated while the sheet owned the panel —
    // the composer DOM was stashed, so repaint the toolbar + chip from
    // the (already-updated) state now that the root is visible again.
    if (c.state._tplPending) {
      c.state._tplPending = false;
      buildToolbar(c.bodyEl, c.state, c.icon, c.type);
    }
    if (c.state._labelsPending && !c.state._labelsDone &&
        window.H && window.H.hasLabels && window.H.hasLabels()) {
      c.state._labelsPending = false;
      c.state._labelsDone = true;
      renderHost(c.bodyEl, c.icon, c.state, c.panel);
    }
  });

  // ── v0.40 EMPTY-STATE STARTER CHIPS ────────────────────────────────
  // The empty transcript greeted with "Say hi Bot…" and a blinking cursor
  // gave a new chat a cold start. Now three themed starter chips sit under
  // the greeting — tapping one PREFILLS the composer (never auto-sends:
  // the user stays in control and can edit before sending).
  var CHAT_STARTERS = {
    quick: [
      { label: '✍️  Help me write', prompt: 'Help me write a short, friendly reply to a meeting invite.' },
      { label: '🧠  Explain simply', prompt: 'Explain how HTTPS keeps my data safe — in simple terms.' },
      { label: '⭐  What can you do?', prompt: 'What can you do? Give me a quick tour of your capabilities.' }
    ],
    research: [
      { label: '🔎  Research a topic', prompt: 'Research the current state of small language models — sources please.' },
      { label: '📊  Compare options', prompt: 'Compare the top renewable energy sources for home use, with trade-offs.' },
      { label: '⭐  What can you do?', prompt: 'What can you do? Give me a quick tour of your capabilities.' }
    ]
  };
  function startersFor(sandbox) {
    return CHAT_STARTERS[sandbox] || CHAT_STARTERS.quick;
  }
  function renderStarters(state, type) {
    if (state.messages.length > 0) return '';
    var list = startersFor(state.sandbox);
    var out = '<div id="chat-starters" class="chat-starters" role="group" aria-label="Starter prompts">';
    for (var i = 0; i < list.length; i++) {
      out += '<button class="starter-chip" data-starter="' + i + '">' + esc(list[i].label) + '</button>';
    }
    return out + '</div>';
  }

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

    // v0.40 DRAFT PERSISTENCE: hydrate the durable draft BEFORE the
    // composer template renders (it prints state.draftText). Only fills
    // an EMPTY in-memory draft — a mid-session state always wins over
    // the disk copy (the disk copy may be a hair stale mid-debounce).
    if (!state.draftText) {
      var savedDraft = loadDraftLS(draftId(state));
      if (savedDraft) state.draftText = savedDraft;
    }

    var ctx = buildCtx(bodyEl, icon, state, panel, type);
    currentCtx.ctx = ctx;

  // ── PINNED header: arrow + summary; dropdown hidden by default ──
    var headerHTML = renderHeader(type, state, ctx, complete);

    // ── THE GATELOCK (start of the convo — never collapsible) ──
    var gateHTML = renderGatelock(type, state, ctx, complete);

    // ── The chat (only once the gate is fulfilled) ──
    // v0.40: the starter chips render OUTSIDE #chat-messages (they are
    // empty-state chrome like the composer, not message rows — the
    // isolation tests count #chat-messages children, and message-row
    // semantics stay pure). appendMessage removes them with the greeting
    // when the first real message lands.
    var chatHTML = complete
      ? '<div id="chat-live" style="flex:1 1 auto;display:flex;flex-direction:column;min-height:55%">' +
          '<div id="chat-messages" style="flex:1;padding:calc(16px * var(--chat-scale,1));display:flex;flex-direction:column;gap:calc(12px * var(--chat-scale,1))">' +
            (state.messages.length === 0
              ? '<div id="chat-greeting" style="text-align:center;color:var(--text-3);font-size: calc(var(--ui-fs) - 1px);padding:32px 20px 12px">' +
                  esc(type.greeting) + ' ' + esc(icon.name) + '…</div>'
              : renderMessages(state.messages)) +
          '</div>' +
          (state.messages.length === 0 ? renderStarters(state, type) : '') +
          // Sticky input bar — stays visible while scrolled.
          // v0.34: the input rides the chat scale too (typing in the size
          // you read); the textarea grows to at most ~3× its min height.
          '<div id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:var(--surface-2);border-top:1px solid var(--surface-3);padding:calc(10px * var(--chat-scale,1)) 16px calc(12px * var(--chat-scale,1));z-index:2">' +
          '<div id="chat-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>' +
          '<div style="display:flex;gap:8px">' +
            '<textarea id="chat-input" placeholder="' + esc(type.placeholder) + '" style="flex:1;background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:calc(10px * var(--chat-scale,1)) calc(12px * var(--chat-scale,1));border-radius:8px;font-size:calc(var(--chat-fs,16px) - 1px);font-family:inherit;resize:none;outline:none;min-height:calc(40px * var(--chat-scale,1));max-height:calc(120px * var(--chat-scale,1));line-height:1.4" rows="1">' + (state.draftText || '') + '</textarea>' +
            // v0.42 THE SEND CLUSTER: the main #chat-send button (id kept —
            // other code queries it) is now an ICON over a tiny label, one
            // 44px tap target painted entirely by SendMode.sync; the chevron
            // mini-button at its right drops the manual-override menu.
            '<span id="send-cluster">' +
              '<button id="chat-send" type="button" aria-label="Send the message" data-mode="send"></button>' +
              '<button id="chat-send-more" type="button" aria-label="Choose send mode" title="Choose send mode">' + SEND_ICONS.chev + '</button>' +
            '</span>' +
          '</div>' +
          '</div>' +
        '</div>'
      : '';

    bodyEl.innerHTML =
      // v0.40: position:relative — #chat-jump (the jump-to-latest pill)
      // anchors HERE, to the VISIBLE panel box (inside the scroller its
      // absolute bottom would ride the CONTENT height and scroll away).
      '<div id="chat-root" style="position:relative;height:100%;display:flex;flex-direction:column;overflow:hidden">' +
        headerHTML +
        '<div id="chat-scroll" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;display:flex;flex-direction:column">' +
        gateHTML +
        chatHTML +
        '</div>' +
        // v0.40 JUMP TO LATEST: floats above the composer whenever the
        // reader is scrolled up (pairs with the v0.28 scroll-freeze —
        // mid-stream reading had no way back but a full drag).
        '<button id="chat-jump" class="chat-jump" aria-label="Jump to latest messages" title="Jump to latest">↓</button>' +
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
      // v0.40: THE JUMP-TO-LATEST PILL — the scroll handler now runs for
      // BOTH states (the old one bailed when idle, so reading history
      // while idle had no affordance either). The pill floats above the
      // composer whenever the reader is >1.5 screens above the bottom,
      // rides above the sticky inputbar, and pulses while a turn streams
      // below the fold (the freeze keeps the view parked — this is the
      // way back).
      var jumpBtn = bodyEl.querySelector('#chat-jump');
      var updateJump = function () {
        if (!jumpBtn || !jumpBtn.isConnected) return;
        var d = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        var far = d > Math.max(240, scrollEl.clientHeight * 1.5);
        var ib = bodyEl.querySelector('#chat-inputbar');
        if (far) {
          jumpBtn.style.bottom = ((ib ? ib.offsetHeight : 90) + 14) + 'px';
          jumpBtn.classList.add('show');
          if (state.isStreaming) jumpBtn.classList.add('live'); else jumpBtn.classList.remove('live');
        } else {
          jumpBtn.classList.remove('show', 'live');
        }
      };
      if (jumpBtn) {
        jumpBtn.addEventListener('click', function () {
          state._scrollFrozen = false; // re-engage the follow
          try { scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' }); }
          catch (e) { scrollEl.scrollTop = scrollEl.scrollHeight; }
          jumpBtn.classList.remove('show', 'live');
        });
        // open mid-turn (reopened while streaming): show it right away
        if (state.isStreaming) setTimeout(updateJump, 400);
      }
      scrollEl.addEventListener('scroll', function () {
        rememberScroll(state, scrollEl.scrollTop); // v0.34: where the user is
        updateJump(); // v0.40: pill visibility
        if (!state.isStreaming) { state._scrollFrozen = false; return; }
        var d = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        if (d < 80) state._scrollFrozen = false; // back at the bottom — follow again
        else if (d > 160) state._scrollFrozen = true; // reading above — freeze
      }, { passive: true });
    }

    // v0.40 STARTER CHIPS: tap → prefill the composer (never auto-send)
    var startersWrap = bodyEl.querySelector('#chat-starters');
    if (startersWrap) {
      startersWrap.addEventListener('click', function (e) {
        var chip = e.target.closest && e.target.closest('.starter-chip');
        if (!chip) return;
        var list = startersFor(state.sandbox);
        var item = list[parseInt(chip.getAttribute('data-starter'), 10)];
        if (!item) return;
        var ta = bodyEl.querySelector('#chat-input');
        if (ta) {
          ta.value = item.prompt;
          state.draftText = item.prompt;
          saveDraftLS(draftId(state), item.prompt);
          ta.style.height = 'auto';
          ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (err) {}
          syncSendButton(bodyEl, state); // v0.42: the draft landed — send turns actionable
        }
      });
    }

    wireHeader(bodyEl, icon, state, type, ctx);
    wireGatelock(bodyEl, ctx);
    updateHeaderBtn(state, icon, bodyEl, panel);
    // v0.27: a re-render while views are stacked would strand them over a
    // body that no longer holds their chat — discard the stack (the fresh
    // content below IS the new root; no restore).
    if (panel && panel.viewDepth && panel.viewDepth()) panel.dropViews();
    // v0.42: the in-chat search pill is GONE from the dropdown (spec #5a) —
    // find (local bar + global search) is the way forward. The dropdown is
    // pills + utilities only now.

    // artifacts session binding + badge
    if (state.sessionId) {
      window.Artifacts.setSession(state.sessionId, { name: icon.name });
      refreshArtifactCount(state, bodyEl);
    }

    // long-press message actions (copy / quote / regenerate / edit / delete)
    if (msgContainer) {
      // v0.40 MODEL-GONE ONE-TAP RECOVERY (delegated — survives transcript
      // rebuilds): a chip tap on a model-gone error switches this chat to
      // the suggested model, drops the resolved error bubble, toasts the
      // switch (never silent — the Hermes anti-pattern), and re-sends the
      // failed prompt after the model settle. One tap, full recovery.
      msgContainer.addEventListener('click', function (e) {
        var chip = e.target.closest && e.target.closest('.err-switch');
        if (!chip) return;
        var ctx = currentCtx;
        if (!ctx || !ctx.state || !ctx.bodyEl) return;
        var state = ctx.state, icon = state._icon, bodyEl2 = ctx.bodyEl, panel2 = ctx.panel;
        if (state.isStreaming) return;
        var prov = chip.getAttribute('data-provider') || state.provider;
        var mid = chip.getAttribute('data-model');
        if (!mid) return;
        // the failed prompt = the last user message
        var lastUser = null;
        for (var i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].role === 'user') { lastUser = state.messages[i]; break; }
        }
        applyModelChoice(prov, mid, state, icon, bodyEl2, panel2);
        // drop the resolved error bubble(s) with suggestions
        for (var j = state.messages.length - 1; j >= 0; j--) {
          if (state.messages[j].role === 'error' && state.messages[j].suggest) {
            state.messages.splice(j, 1);
          }
        }
        rebuildTranscript(bodyEl2.querySelector('#chat-messages'), state);
        if (window.Artifacts && window.Artifacts.toast) {
          window.Artifacts.toast('switched to ' + (chip.textContent || '').replace(/^⇄/, '').trim() + (lastUser ? ' — retrying' : ''));
        }
        if (lastUser) {
          setTimeout(function () {
            if (!state.isStreaming) doSend(lastUser.text, bodyEl2, icon, state, panel2);
          }, 400);
        }
      });
      window.MsgActions.wire(msgContainer, {
        onQuote: function (text) {
          var q = String(text).split('\n').map(function (l) { return '> ' + l; }).join('\n');
          var ta = bodyEl.querySelector('#chat-input');
          if (ta) {
            ta.value = q + '\n\n' + ta.value;
            state.draftText = ta.value;
            ta.focus();
            ta.scrollTop = ta.scrollHeight;
            syncSendButton(bodyEl, state); // v0.42: the quote prefill is a draft
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
          syncSendButton(bodyEl, state); // v0.42: the edit prefill is a draft
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
          syncSendButton(bodyEl, state); // v0.42: deleting the trailing error leaves send/retry
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
        // v0.40: durable per-chat draft (debounced; cleared on send)
        saveDraftLS(draftId(state), input.value);
        // v0.42: the mode follows the draft — typing mid-turn flips the
        // button to QUEUE, clearing it falls back to STOP/SEND.
        syncSendButton(bodyEl, state);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // v0.42: Enter follows the LIVE mode — queue while a turn
          // streams (queue-mode-active), send otherwise. Shift+Enter
          // stays a newline. Any text mid-turn QUEUES regardless of a
          // manual 'send' override (a plain send is impossible while
          // streaming — falling through would silently drop the
          // keystroke; enqueueDraft self-guards empty text).
          if (state.isStreaming) enqueueDraft(bodyEl, state, icon, panel);
          else send();
        }
      });
      // v0.42: ONE dispatcher — the button's behavior is its mode.
      // (The old pair — addEventListener(send) + a mid-turn
      // sendBtn.onclick=stop overwrite — is dead: sync() paints Stop
      // whenever state.isStreaming, and this tap reads the mode live,
      // so a chat reopened MID-TURN gets its stop affordance back too.)
      sendBtn.addEventListener('click', onSendTap);
      var sendMore = bodyEl.querySelector('#chat-send-more');
      if (sendMore) sendMore.addEventListener('click', function (e) {
        e.stopPropagation();
        openSendMenu(bodyEl, state);
      });
      // initial paint: icon + label + queued pills (state.queue survives
      // re-renders — it lives on state like draftText).
      ensureSendModeStyle();
      syncSendButton(bodyEl, state);
      renderSendQueue(bodyEl, state, icon, panel);
      scheduleOpenFlush(bodyEl, state);

      // Connect the WS — only after the engine session exists; rebind the
      // icon's persisted session so a restart replays the SAME conversation.
      // SINGLE-FLIGHT: one bind, one client; later renders re-point onEvent.
      if (state.client) {
        state.client.onEvent = function (ev) { handleEvent(ev, state, msgContainer, scrollEl, bodyEl, icon, panel); };
        // v0.44 INTERRUPT FIX (CAUSE #1): a re-render re-pointed the callback
        // on a client that may have DIED while the chat was backgrounded
        // (engine restart) — it sat silent until the next send. Kick the
        // reconnect (connect() no-ops while connecting/open).
        reviveClient(state);
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

    // v0.42: the button's behavior IS its mode — one tap dispatcher
    // (send / queue / stop / retry), replacing the old click=send +
    // mid-turn onclick=stop overwrite pair.
    function onSendTap() {
      var mode = SendMode.mode(state);
      if (mode === 'stop') {
        state._holdQueue = true; // a deliberate stop parks the queue
        var stype = window.ChatTypes.get(state.sandbox || 'quick');
        try { stype.stop(state, ctx || {}); } catch (eStop) { /* engine best-effort */ }
        return;
      }
      if (mode === 'queue' && state.isStreaming) { enqueueDraft(bodyEl, state, icon, panel); return; }
      if (mode === 'retry') { doRetrySend(bodyEl, icon, state, panel); return; }
      send(); // 'send' (guards empty text + streaming itself)
    }

    function send() {
      var text = input.value.trim();
      if (!text || state.isStreaming) return;
      doSend(text, bodyEl, icon, state, panel);
    }
  }

  // ── v0.56: chat metadata pill TONES ─────────────────────────────
  // The header pills used to ALL paint the same hardcoded green (--ok)
  // — "the pills of the chat metadata are all first color and don't
  // follow". Each pill now carries its OWN theme color (the pill id →
  // [color var, rgb-triplet var]): sandbox→accent, model→accent-2,
  // template→template tint, skills→persona tint; the dedicated pills
  // below keep their assigned accents.
  var PILL_TONES = [
    [/^pill-sandbox/, '--accent', '--accent-rgb'],
    [/^pill-model/, '--accent-2', '--accent-2-rgb'],
    [/^pill-template/, '--template-tint', '--template-rgb'],
    [/^pill-skills/, '--persona-tint', '--persona-rgb'],
    [/^pill-quick/, '--accent', '--accent-rgb']
  ];
  function pillToneFor(id) {
    for (var i = 0; i < PILL_TONES.length; i++) {
      if (PILL_TONES[i][0].test(String(id || ''))) return PILL_TONES[i];
    }
    return [null, '--accent', '--accent-rgb'];
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
      '<div id="chat-header" style="flex-shrink:0;border-bottom:1px solid var(--surface-2);z-index:3">' +
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
          '<span style="font-size: calc(var(--ui-small-fs) - 1px);color:' + (filled ? 'var(--accent)' : 'var(--text-3)') + '">' + esc(s.sub) + '</span>' +
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
      // v0.44: the +workspace pill re-binds when the session lands late
      // (the pill badge fetches the bound count for THIS session id).
      if (state._wsPill && window.Workspace && window.Workspace.setPillSession) {
        state._wsPill = window.Workspace.setPillSession(state._wsPill, state.sessionId);
      }
    };
    if (row) row.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#pill-row, #util-row, #chat-header-meters')) return;
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
          var tone = pillToneFor(p.id);
          var b = document.createElement('button');
          b.id = p.id;
          b.textContent = p.label;
          b.style.cssText = 'display:flex;align-items:center;gap:5px;flex-shrink:0;min-width:0;max-width:46%;' +
            // v0.57: 0.16 tint (was 0.07 — washed out invisible on bright
            // gradient bands; the sweep's finding) + the veil behind via the
            // surface-2 catcher keeps the tone readable anywhere.
            'background:rgba(' + tone[2] + ',0.16);border:1px solid rgba(' + tone[2] + ',0.5);color:var(' + tone[1] + ');' +
            'text-shadow:var(--text-shadow);' +
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

      // v0.46 (user edit A2): THE +WORKSPACE PILL MOVED after mind (was
      // second in the row). v0.46 fix: the pill takes a LIVE session
      // GETTER — the old captured-sid went stale when the session landed
      // after render, and connects then silently skipped the bind (the
      // "instantly disconnects" bug).
      if (window.Workspace && window.Workspace.pill) {
        var wspill = window.Workspace.pill(function () { return state.sessionId; });
        pillRow.appendChild(wspill);
        state._wsPill = wspill;
      }
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

  // ── v0.42 (spec #5a): the in-chat search pill — renderSearchbar +
  // highlightMatches + clearHighlights + the #chat-searchbar row — is
  // REMOVED. The find surface that stays is the composer's ⌕ find bar
  // (openFindBar) + the dock's global search (globalsearch.js), which
  // share the Aa / Exact toggles. (mark.chat-search-mark CSS stays in
  // index.html — dead but harmless; nothing emits that class anymore.)
  // The local find bar's own machinery (.find-hit pulse + computeMatches)
  // never used these helpers — verified before deleting.

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

      applySandbox: function (sandboxType, detail) {
        state.sandbox = sandboxType;
        // v0.46: the HF detail (mode + repo) rides the session + the icon
        // state so reloads restore the routing.
        if (sandboxType === 'hf' && detail && (detail.mode === 'shared' || detail.mode === 'own')) {
          state.sandboxMode = detail.mode;
          state.sandboxRepo = detail.mode === 'own' ? (detail.repo || '') : '';
        } else if (sandboxType !== 'hf') {
          state.sandboxMode = '';
          state.sandboxRepo = '';
        }
        if (icon) {
          icon.sandbox = sandboxType;
          icon.sandboxMode = state.sandboxMode || '';
          icon.sandboxRepo = state.sandboxRepo || '';
          if (typeof icon.setSandbox === 'function') icon.setSandbox(sandboxType);
          if (typeof icon.save === 'function') icon.save();
        }
        var patch = { sandbox: sandboxType };
        if (sandboxType === 'hf') {
          patch.sandbox_mode = state.sandboxMode || (detail && detail.mode) || 'shared';
          patch.sandbox_repo = state.sandboxRepo || (detail && detail.repo) || '';
        } else {
          patch.sandbox_mode = '';
          patch.sandbox_repo = '';
        }
        updateSession(icon, state, patch);
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
        var opts = {
          effort: state.effort,
          web_search: true,  // v0.45 ITEM 2: default-on (pill removed)
          deep_research: !!state.deepResearch,
          model: state.model,
          provider: state.provider
        };
        // v0.44 TEMPLATE PILL: the resolved brief rides every send (the
        // engine injects it as a METHOD TEMPLATE system block). Deep
        // research keeps the plain deep_research flag — its pipeline is
        // engine-native.
        if (state.template && state.template.brief) {
          opts.template_id = state.template.id || '';
          opts.template_brief = state.template.brief;
        }
        state.client.send(text, opts);
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
      (state.sandbox === 'hf'
        ? ", chatting inside the Doomalay app from your Hugging Face Space. Today is "
        : ", chatting inside the Doomalay app on the user's own device. Today is ") +
      new Date().toDateString() + '.';
    // v0.44 TEMPLATE PILL: PM turns compose the system message client-side
    // (they bypass the engine), so the METHOD TEMPLATE block is prepended
    // HERE — the same shape the engine injects on the WS path.
    if (state.template && state.template.brief) {
      head = 'METHOD TEMPLATE — ' + (state.template.id || 'custom') +
        "\nFollow this template's methodology for this task:\n" +
        String(state.template.brief).trim() + "\n\n" + head;
    }
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
      // v0.48 task 6: the default persona is mode-aware (quick vs HF)
      var defPersona = (window.Persona && window.Persona.defaultPersonaFor)
        ? window.Persona.defaultPersonaFor(state.sandbox)
        : DEFAULT_PERSONA;
      sys += (window.Persona && window.Persona.substituteAll)
        ? window.Persona.substituteAll(defPersona, state.chatName, model, state.provider)
        : substituteVars(DEFAULT_PERSONA, model, state.provider);
      return sys; // the default persona carries the artifact protocol
    }
    if (!/artifact/i.test(personaText)) sys += '\n\n' + ARTIFACT_PROMPT;
    return sys;
  }

  function runPMTurn(text, state, bodyEl, icon) {
    var msgContainer = bodyEl.querySelector('#chat-messages');
    var scrollEl = bodyEl.querySelector('#chat-scroll');
    var abort = new AbortController();
    state._pmAbort = abort;
    // v0.44 INTERRUPT FIX (CAUSE #3, PM path): PM chats keep a WS client
    // (event replay + hide channel), and the client's reconnect ladder
    // reads turnActive — but only client.send() ever set it, so a mid-PM-
    // turn socket drop only earned the SHORT ladder (3 tries ~5s) instead
    // of the long mid-turn one. Set it for the PM turn's lifetime; finish()
    // clears it on success/error alike.
    if (state.client) state.client.turnActive = true;
    // v0.42: no button wiring here — doSend already flipped the mode to
    // STOP (isStreaming), and the tap dispatcher stops through
    // type.stop → state._pmAbort.abort() (chatframework.js).

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
      if (state.client) state.client.turnActive = false; // v0.44 (CAUSE #3): the PM turn is over
      hideActivity(bodyEl, state);
      // v0.27: turn end — the header meters (ring + cost) refresh.
      refreshHeaderMeters(bodyEl, state);
      completeAllStreaming(bodyEl, state); // v0.25: every thinking bubble + cursor stops animating
      // v0.42: the mode machine paints whatever the turn left behind
      // (retry when the error bubble lands below, else send). A failed PM
      // turn parks the queue; a clean one flushes ONE queued follow-up.
      syncSendButton(bodyEl, state);
      if (errText) state._holdQueue = true;
      else flushSendQueue(bodyEl, state);
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
            syncSendButton(bodyEl, state); // v0.42: the failed turn → retry affordance
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
      tools: !state.deepResearch,  // v0.45 ITEM 2: web search default-on — only a template (deep research) suppresses it
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
    state._effortLevels = levels || null; // v0.44: the chip's re-render reuses the ladder
    var anyActive = state.deepResearch || !!state.template;

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

    // v0.45 ITEM 2: the `⌕ web` pill is REMOVED — web search is now
    // default-on and used dynamically when needed (the engine includes
    // web_search/fetch tools on every turn unless a template owns the
    // composer). See chatpanel.js ~L2289 (tools gate) + brain/agent.py
    // default flip.

    // v0.60 pt C.9: THE LIB PILL (replaces the template + skills pills):
    // the toolbar is [effort · x] + [🛠 lib | +]. TWO hotboxes:
    //   · the LABEL press toggles the chat's lib_auto gate (ON: the bot
    //     browses AND uses the library on the fly; OFF: it can still
    //     browse + recommend — downloads/loads refuse with the switch
    //     path, engine + brain both enforce).
    //   · the + press opens the PUBLIC LIBRARY with THIS chat connected
    //     (Hub.open(undefined, {chat}) — the whole library, any type).
    // The + is DYNAMIC: it shows the name of the template/skill in use
    // THIS turn (tool_use/tool_result events — see paintSegPlus), the
    // active manual template shows persistently, and an unused slot is
    // just '+'. The old whole-pill ⧉ template browse action is replaced
    // by the + (the sheet stays reachable via the library's Yours rows).
    bar.appendChild(libPill(bodyEl, state, icon));

    syncTemplateChip(bodyEl, state, icon);

    if (anyActive || (state.effort && state.effort !== 'med') ||
        state.libAuto || state.templateAuto || state.skillsAuto) {
      var clear = document.createElement('button');
      clear.textContent = 'clear';
      clear.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text-3);padding:4px 10px;border-radius:8px;font-size:11px;font-family:inherit;cursor:pointer;flex-shrink:0';
      clear.addEventListener('click', function () {
        // v0.26: reset to the model's OWN default (first level), not a
        // hardcoded 'med' that isn't in most ladders.
        state.effort = (levels && levels.length) ? levels[0] : 'med';
        state.webSearch = false;
        state.deepResearch = false;
        state.template = null; // v0.44: the active template clears with the rest
        state.templateAuto = false; // v0.60: the lib gate resets with the rest
        state.skillsAuto = false;
        state.libAuto = false;
        persistCaps(state, icon);
        renderToolbar(bar, state, levels, icon, bodyEl);
      });
      bar.appendChild(clear);
    }

    // v0.39 FIND IN CHAT: jump-to-match search over the transcript (the
    // chats grow long; finding "that thing it said about X" was scroll-hunt).
    // The button rides the toolbar's right edge; the bar mounts over the
    // composer when opened.
    // v0.44 (user spec): the pill is now JUST a search glyph — the "⌕ find"
    // label read as a wordy pill next to the other icon-only affordances;
    // the aria-label + title carry the meaning for a11y/tooltips.
    var fb = document.createElement('button');
    fb.id = 'chat-find-btn';
    fb.setAttribute('aria-label', 'Find in chat');
    fb.title = 'Find in chat';
    fb.innerHTML = '<span style="font-size:14px;line-height:1">🔍</span>';
    fb.style.cssText = 'flex-shrink:0;background:transparent;border:1px solid var(--border);color:var(--text-3);' +
      'width:32px;height:26px;display:flex;align-items:center;justify-content:center;' +
      'border-radius:8px;font-size:11px;font-family:inherit;cursor:pointer;margin-left:auto;padding:0';
    fb.addEventListener('click', function () {
      openFindBar(bodyEl, state);
    });
    bar.appendChild(fb);
  }

  // ── v0.39 FIND IN CHAT ────────────────────────────────────────────────
  // A compact find bar over the composer: live match count over the chat's
  // messages (user + assistant text), Enter/Shift+Enter to walk matches,
  // ↑/↓ buttons, Esc to close. Each jump scrolls the bubble into view and
  // flashes a themed highlight ring.
  function openFindBar(bodyEl, state) {
    var bar = bodyEl.querySelector('#chat-find');
    if (bar) {
      var existingInput = bar.querySelector('#chat-find-input');
      if (existingInput) { existingInput.focus(); existingInput.select(); }
      return;
    }
    var inputbar = bodyEl.querySelector('#chat-inputbar');
    if (!inputbar) return;

    var el = document.createElement('div');
    el.id = 'chat-find';
    el.className = 'chat-find';
    // v0.42: the Aa / Exact chips (the SHARED blob with the global search
    // — globalsearch.js findOpts) ride the input row.
    var fopts = (window.GlobalSearch && window.GlobalSearch.findOpts)
      ? window.GlobalSearch.findOpts() : { caseSensitive: false, exact: false };
    el.innerHTML =
      '<input id="chat-find-input" class="chat-find-input" placeholder="Find in chat…" autocomplete="off" spellcheck="false">' +
      '<button id="chat-find-aa" class="chat-find-chip" type="button" aria-pressed="' + (fopts.caseSensitive ? 'true' : 'false') + '" ' +
        'title="Case-sensitive matching" aria-label="Case-sensitive matching">Aa</button>' +
      '<button id="chat-find-exact" class="chat-find-chip" type="button" aria-pressed="' + (fopts.exact ? 'true' : 'false') + '" ' +
        'title="Whole-word exact match" aria-label="Whole-word exact match">Exact</button>' +
      '<span id="chat-find-count" class="chat-find-count"></span>' +
      '<button id="chat-find-prev" class="chat-find-btn" title="previous match (Shift+Enter)">↑</button>' +
      '<button id="chat-find-next" class="chat-find-btn" title="next match (Enter)">↓</button>' +
      '<button id="chat-find-close" class="chat-find-btn" title="close (Esc)">✕</button>';
    // v0.40 OVERLAP FIX: the bar now mounts INSIDE the sticky composer
    // (first child, above the toolbar). The v0.39 mount as a SIBLING before
    // #chat-inputbar put it in normal flow while the sticky composer
    // (z-index 2) shifted up past its flow position whenever the
    // transcript was scrolled — painting OVER the bar (measured: the
    // input's center point landed on the inputbar; the bar clipped to
    // ~13px). Inside the sticky context it rides WITH the composer —
    // overlap is structurally impossible.
    inputbar.insertBefore(el, inputbar.firstChild);
    // slide-in
    requestAnimationFrame(function () { el.classList.add('open'); });

    var input = el.querySelector('#chat-find-input');
    var countEl = el.querySelector('#chat-find-count');
    var matches = [];   // [{mi, idx}] message index + char index
    var pos = -1;       // current match cursor

    function searchable() {
      var out = [];
      for (var i = 0; i < state.messages.length; i++) {
        var m = state.messages[i];
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        out.push({ mi: i, text: String(m.text || '') });
      }
      return out;
    }

    function computeMatches(q) {
      matches = [];
      pos = -1;
      if (!q) return;
      // v0.42: the SHARED predicate (Aa / Exact) — the same one the global
      // search post-filters with, so both surfaces agree. Falls back to
      // the v0.39 case-insensitive scan if globalsearch.js is missing.
      var opts = (window.GlobalSearch && window.GlobalSearch.findOpts)
        ? window.GlobalSearch.findOpts() : null;
      var pool = searchable();
      for (var p = 0; p < pool.length; p++) {
        if (opts && window.GlobalSearch.findMatches) {
          var hits = window.GlobalSearch.findMatches(pool[p].text, q, opts);
          for (var h = 0; h < hits.length; h++) matches.push({ mi: pool[p].mi, idx: hits[h].idx });
          continue;
        }
        var ql = q.toLowerCase();
        var t = pool[p].text.toLowerCase();
        var from = 0;
        while (true) {
          var at = t.indexOf(ql, from);
          if (at < 0) break;
          matches.push({ mi: pool[p].mi, idx: at });
          from = at + Math.max(1, ql.length);
        }
      }
    }

    function clearHits() {
      var host = bodyEl.querySelector('#chat-messages');
      if (!host) return;
      var hits = host.querySelectorAll('.find-hit');
      for (var i = 0; i < hits.length; i++) hits[i].classList.remove('find-hit');
    }

    function jump(dir) {
      if (!matches.length) return;
      pos = pos + dir;
      if (pos < 0) pos = matches.length - 1;
      if (pos >= matches.length) pos = 0;
      var m = matches[pos];
      var host = bodyEl.querySelector('#chat-messages');
      if (!host) return;
      clearHits();
      // locate the DOM bubble by data-mi (user/assistant bubbles carry it;
      // the index is the transcript's message index — same key as edit/delete)
      var bubble = host.querySelector('[data-mi="' + m.mi + '"]');
      if (bubble) {
        bubble.scrollIntoView({ block: 'center', behavior: 'smooth' });
        bubble.classList.add('find-hit');
      }
      countEl.textContent = (pos + 1) + '/' + matches.length;
    }

    function refresh() {
      var q = (input.value || '').trim();
      computeMatches(q);
      if (!q) {
        clearHits();
        countEl.textContent = '';
        return;
      }
      if (matches.length) jump(1); else countEl.textContent = '0/0';
    }

    function close() {
      clearHits();
      el.classList.remove('open');
      document.removeEventListener('doomalay:find-opts', onOptsChange);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
      var ta = bodyEl.querySelector('#chat-input');
      if (ta) ta.focus();
    }

    // v0.42: the chips toggle the SHARED blob (globalsearch.js) and the
    // open bar re-computes — also when the other surface changed it.
    var aaBtn = el.querySelector('#chat-find-aa');
    var exBtn = el.querySelector('#chat-find-exact');
    function paintChips(o) {
      if (aaBtn) aaBtn.setAttribute('aria-pressed', o.caseSensitive ? 'true' : 'false');
      if (exBtn) exBtn.setAttribute('aria-pressed', o.exact ? 'true' : 'false');
    }
    function chipTap(key) {
      if (!window.GlobalSearch || !window.GlobalSearch.setFindOpts) return;
      var o = window.GlobalSearch.findOpts();
      o[key] = !o[key];
      paintChips(window.GlobalSearch.setFindOpts(o));
      refresh();
    }
    if (aaBtn) aaBtn.addEventListener('click', function () { chipTap('caseSensitive'); });
    if (exBtn) exBtn.addEventListener('click', function () { chipTap('exact'); });
    function onOptsChange(e) {
      paintChips(e && e.detail ? e.detail : {});
      refresh();
    }
    document.addEventListener('doomalay:find-opts', onOptsChange);

    el.querySelector('#chat-find-close').addEventListener('click', close);
    el.querySelector('#chat-find-next').addEventListener('click', function () { jump(1); });
    el.querySelector('#chat-find-prev').addEventListener('click', function () { jump(-1); });
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.focus();
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

  // ── v0.52 THE 3 PILLS — the segmented [label | +] builders ──────────
  // Two hotboxes per pill (user item 6):
  //   [⧉ template | +]   label press → toggle template_auto (the chat's
  //                       auto-search cap; ON lights the pill up)
  //                       + press     → the public library with THIS chat
  //                       connected (Hub.open('template', {chat}))
  //   [🛠 skills | +]     same shape for the skills library
  // The + label is DYNAMIC: the in-use template/skill name for the
  // current turn (state._turnTemplate/_turnSkill, fed by tool events),
  // the active manual template persistently, else just '+'.
  function segPlusLabel(state, kind) {
    if (kind === 'template') {
      if (state.template && state.template.name) return shortCap(state.template.name);
      if (state._turnTemplate) return shortCap(state._turnTemplate);
      return '+';
    }
    // v0.60 pt C.9: the lib pill's + — whatever is in use this turn.
    if (state._turnSkill) return shortCap(state._turnSkill);
    if (state._turnTemplate) return shortCap(state._turnTemplate);
    if (state.template && state.template.name) return shortCap(state.template.name);
    return '+';
  }

  function shortCap(name) {
    var s = String(name || '').trim();
    if (!s) return '+';
    if (s.length > 12) s = s.slice(0, 11) + '…';
    return s;
  }

  // v0.60 pt C.9: THE LIB PILL — one gatekeeping pill + a dynamic + that
  // opens the public library with this chat connected.
  function libPill(bodyEl, state, icon) {
    var active = !!(state.libAuto || state.templateAuto || state.skillsAuto ||
      state.template || state.deepResearch);
    var wrap = document.createElement('div');
    wrap.id = 'seg-lib';
    wrap.style.cssText = 'display:inline-flex;align-items:stretch;flex-shrink:0;' +
      'border:1px solid ' + (active ? 'rgba(var(--accent-rgb),0.55)' : 'var(--border)') + ';' +
      'background:' + (active ? 'rgba(var(--accent-rgb),0.12)' : 'transparent') + ';' +
      'border-radius:999px;overflow:hidden';

    var lab = document.createElement('button');
    lab.id = 'seg-lib-label';
    lab.textContent = '🛠 lib';
    lab.setAttribute('aria-pressed', active ? 'true' : 'false');
    lab.title = 'the library — ON: the bot browses AND uses the library on the fly; ' +
      'OFF: it can still browse + recommend (downloads need the switch back on)';
    lab.style.cssText = 'border:none;background:transparent;color:' +
      (active ? 'var(--accent)' : 'var(--text-3)') +
      ';padding:4px 8px 4px 10px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
      'white-space:nowrap;-webkit-tap-highlight-color:transparent';
    lab.addEventListener('click', function () {
      state.libAuto = !state.libAuto;
      // keep the legacy flags in lockstep (old engine payloads read them)
      state.templateAuto = state.libAuto;
      state.skillsAuto = state.libAuto;
      persistCaps(state, icon);
      renderToolbar(bodyEl.querySelector('#chat-toolbar'), state,
        state._effortLevels, icon, bodyEl);
    });

    var plus = document.createElement('button');
    plus.id = 'seg-lib-plus';
    plus.textContent = segPlusLabel(state, 'lib');
    plus.title = 'open the public library — every type, this chat connected';
    plus.setAttribute('aria-label', plus.title);
    plus.style.cssText = 'border:none;border-left:1px solid ' +
      (active ? 'rgba(var(--accent-rgb),0.45)' : 'var(--border)') + ';' +
      'background:transparent;color:' +
      ((state.template || state._turnTemplate || state._turnSkill) ? 'var(--accent)' : 'var(--text-3)') +
      ';padding:4px 10px 4px 8px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;' +
      'max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      '-webkit-tap-highlight-color:transparent';
    plus.addEventListener('click', function () {
      if (!window.Hub) {
        if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast('the library is not available');
        return;
      }
      var chat = null;
      var c = window.ChatPanel && window.ChatPanel.current();
      if (c && c.icon) {
        chat = {
          sessionId: state.sessionId || (c.icon && c.icon.sessionId) || '',
          title: c.icon.name || '',
          name: c.icon.name || '',
          avatarHTML: (c.icon && c.icon.getAvatarHTML) ? c.icon.getAvatarHTML() : ''
        };
      }
      window.Hub.open(undefined, { chat: chat });
    });

    wrap.appendChild(lab);
    wrap.appendChild(plus);
    return wrap;
  }

  function segPill(bodyEl, state, icon, kind) {
    var isTpl = kind === 'template';
    var active = isTpl ? !!(state.templateAuto || state.template || state.deepResearch)
                       : !!state.skillsAuto;
    var glyph = isTpl ? '⧉' : '🛠';
    var label = isTpl ? 'template' : 'skills';

    var wrap = document.createElement('div');
    wrap.id = 'seg-' + kind;
    wrap.style.cssText = 'display:inline-flex;align-items:stretch;flex-shrink:0;' +
      'border:1px solid ' + (active ? 'rgba(var(--accent-rgb),0.55)' : 'var(--border)') + ';' +
      'background:' + (active ? 'rgba(var(--accent-rgb),0.12)' : 'transparent') + ';' +
      'border-radius:999px;overflow:hidden';

    var lab = document.createElement('button');
    lab.id = 'seg-' + kind + '-label';
    lab.textContent = glyph + ' ' + label;
    lab.setAttribute('aria-pressed', active ? 'true' : 'false');
    lab.title = isTpl
      ? 'template auto-search — ON: the assistant browses + uses the template library by itself'
      : 'skills auto-search — ON: the assistant loads methodology skills by itself';
    lab.style.cssText = 'border:none;background:transparent;color:' +
      (active ? 'var(--accent)' : 'var(--text-3)') +
      ';padding:4px 8px 4px 10px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;' +
      'white-space:nowrap;-webkit-tap-highlight-color:transparent';
    lab.addEventListener('click', function () {
      if (isTpl) {
        state.templateAuto = !state.templateAuto;
      } else {
        state.skillsAuto = !state.skillsAuto;
      }
      persistCaps(state, icon);
      renderToolbar(bodyEl.querySelector('#chat-toolbar'), state,
        state._effortLevels, icon, bodyEl);
    });

    var plus = document.createElement('button');
    plus.id = 'seg-' + kind + '-plus';
    plus.textContent = segPlusLabel(state, kind);
    plus.title = isTpl
      ? 'open the template library — the public library, this chat connected'
      : 'open the skills library — the public library, this chat connected';
    plus.setAttribute('aria-label', plus.title);
    plus.style.cssText = 'border:none;border-left:1px solid ' +
      (active ? 'rgba(var(--accent-rgb),0.45)' : 'var(--border)') + ';' +
      'background:transparent;color:' +
      ((isTpl ? (state.template || state._turnTemplate) : state._turnSkill)
        ? 'var(--accent)' : 'var(--text-3)') +
      ';padding:4px 10px 4px 8px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;' +
      'max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      '-webkit-tap-highlight-color:transparent';
    plus.addEventListener('click', function () {
      if (!window.Hub) {
        if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast('the library is not available');
        return;
      }
      // the public library with THIS chat connected (user item 5+6): the
      // hub's chat pill reads `chat_1 · <bot name>` from the start.
      var chat = null;
      var c = window.ChatPanel && window.ChatPanel.current();
      if (c && c.icon) {
        chat = {
          sessionId: state.sessionId || (c.icon && c.icon.sessionId) || '',
          title: c.icon.name || '',
          name: c.icon.name || '',
          avatarHTML: (c.icon && c.icon.getAvatarHTML) ? c.icon.getAvatarHTML() : ''
        };
      }
      window.Hub.open(isTpl ? 'template' : 'skill', { chat: chat });
    });

    wrap.appendChild(lab);
    wrap.appendChild(plus);
    return wrap;
  }

  // paintSegPlus — the LIVE half of the dynamic +: tool events call this
  // to swap the + segment's text without re-rendering the toolbar (the
  // turn is streaming; a full re-render would drop it).
  function paintSegPlus(bodyEl, state) {
    if (!bodyEl || !state) return;
    var lp = bodyEl.querySelector('#seg-lib-plus');
    if (lp) {
      var nl = segPlusLabel(state, 'lib');
      if (lp.textContent !== nl) lp.textContent = nl;
      lp.style.color = (nl !== '+' &&
        (state.template || state._turnTemplate || state._turnSkill))
        ? 'var(--accent)' : 'var(--text-3)';
    }
  }

  // turnTemplateHint — feed the dynamic + from tool events (user item 6:
  // "the + icon should change dynamically to the name of the template/
  // skill that is currently being used. This updates dynamically as the
  // templates or skills being used that turn").
  //   template_show (direct)  → the summary IS the template id
  //   dtemplate (brain)       → the tool_result text names the template
  //   skills (brain)          → "=== SKILL LOADED: <name> ==="
  function turnTemplateHint(bodyEl, state, ev) {
    if (!state || !ev) return;
    var name = (ev.name || '').toLowerCase();
    var text = String(ev.text || ev.summary || '');
    var dirty = false;
    if (name === 'template_show') {
      var id = String(ev.summary || '').trim();
      if (id) { state._turnTemplate = id; dirty = true; }
    } else if (name === 'template_list' || name === 'templates') {
      // browsing alone doesn't count as using one
    } else if (name === 'dtemplate') {
      var m = text.match(/TEMPLATE\s+([\w.-]+)\s*\(/) || text.match(/template[\"']?\s*[:=]\s*[\"']?([\w.-]+)/i);
      if (m) { state._turnTemplate = m[1]; dirty = true; }
    } else if (name === 'skills' || name === 'skill') {
      var m2 = text.match(/SKILL LOADED:\s*([\w.-]+)/);
      if (m2) { state._turnSkill = m2[1]; dirty = true; }
    }
    if (dirty) paintSegPlus(bodyEl, state);
  }

  // applyTemplate — the public activation seam (v0.52): the hub's local
  // library rows (and any future surface) activate a method template in
  // the CURRENT chat through the exact path the old ⧉ pill used.
  function applyTemplate(tpl) {
    var c = currentCtx;
    if (!c || !c.state) {
      if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast('open a chat first');
      return;
    }
    var state = c.state, icon = c.icon;
    if (tpl && tpl.deepResearch) {
      state.deepResearch = true;
      state.template = null;
    } else if (tpl && tpl.brief) {
      state.template = { id: tpl.id, name: tpl.name, brief: tpl.brief };
      state.deepResearch = false;
      state.webSearch = false;
    } else {
      state.template = null;
      state.deepResearch = false;
    }
    persistCaps(state, icon);
    // v0.52 FIX: the old flow always came from the template SHEET (a
    // stacked view — its pop fired 'doomalay:root-restored', which
    // repaints the toolbar + chip). Called with NO view open (the hub's
    // activation while the chat root is showing), nothing fired and the
    // toolbar stayed stale until the next repaint. Repaint NOW when the
    // root is visible; otherwise the root-restored listener does it.
    if (c.panel && c.panel.viewDepth && c.panel.viewDepth() === 0) {
      state._tplPending = false;
      buildToolbar(c.bodyEl, state, icon, c.type);
      syncTemplateChip(c.bodyEl, state, icon);
    } else {
      state._tplPending = true;
    }
  }

  // ── v0.44 THE ACTIVE-TEMPLATE CHIP (inside the sticky input bar) ───
  // A one-line, removable '⧉ <name> ✕' banner pinned above the toolbar —
  // the edit-banner DOM mechanics (insert as the inputbar's first child,
  // slide-in) but its own element (the edit banner is NEVER touched).
  // Deep research shows no chip (its state is the pill's data-on itself).
  function syncTemplateChip(bodyEl, state, icon) {
    if (!bodyEl) return;
    var existing = bodyEl.querySelector('#tpl-chip');
    if (!state.template) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    var bar = bodyEl.querySelector('#chat-inputbar');
    if (!bar) return;
    var name = (state.template && state.template.name) || 'template';
    if (existing) {
      var label = existing.querySelector('.tpl-chip-text');
      if (label) label.textContent = '⧉ ' + name;
      return;
    }
    var b = document.createElement('div');
    b.id = 'tpl-chip';
    b.className = 'tpl-chip';
    b.setAttribute('role', 'status');
    b.innerHTML =
      '<span class="tpl-chip-ico" aria-hidden="true">⧉</span>' +
      '<span class="tpl-chip-text">' + esc('⧉ ' + name) + '</span>' +
      '<button class="tpl-chip-x" title="clear the template" aria-label="Clear the active template">✕</button>';
    b.querySelector('.tpl-chip-x').addEventListener('click', function () {
      state.template = null;
      persistCaps(state, icon);
      if (b.parentNode) b.parentNode.removeChild(b);
      var tb = bodyEl.querySelector('#chat-toolbar');
      if (tb && state._icon) {
        renderToolbar(tb, state, state._effortLevels || null, state._icon, bodyEl);
      }
    });
    bar.insertBefore(b, bar.firstChild);
    requestAnimationFrame(function () { b.classList.add('open'); });
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
        web_search: true,  // v0.45 ITEM 2: default-on (pill removed)
        deep_research: !!state.deepResearch,
        // v0.44: the active method template — the WHOLE resolved blob
        // {id, name, brief} so the reload restores it without re-fetching
        // (deep research is the deep_research flag above, not this).
        template: state.template ? JSON.stringify({
          id: state.template.id, name: state.template.name, brief: state.template.brief
        }) : '',
        // v0.60 pt C.9: THE LIB PILL — the single gatekeeping toggle (the
        // legacy flags ride in lockstep for old engine payloads).
        lib_auto: !!state.libAuto,
        template_auto: !!(state.libAuto || state.templateAuto),
        skills_auto: !!(state.libAuto || state.skillsAuto),
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
      // v0.44 INTERRUPT FIX (CAUSE #1): heal a client that died since the
      // last bind (engine restart mid-session) — the old path only
      // re-pointed the callback and relied on the next doSend to connect.
      reviveClient(state);
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
  // switches. v0.39 RECOVERY: this now fires ONLY after the client's
  // reconnect ladder is exhausted (~20s of retries, each announced as a
  // ws_state indicator) — by then the engine's persisted events carry the
  // truth, so the honest close-out lands in the OWNING chat only.
  function wireClientClose(bodyEl, state, msgContainer) {
    state.client.onClose = function () {
      if (!state.isStreaming) return;
      state.isStreaming = false;
      state._actText = null;
      // v0.44 (CAUSE #2): the turn died without its engine echo ever
      // arriving — the pending-send ledger is stale (the ws_state 'failed'
      // revive poll may still replay events, but a NEW send records a
      // fresh entry; the tail-scan catches stragglers either way).
      state._pendingSends = null;
      var msg = { role: 'error', text: 'Connection to the engine dropped mid-reply and could not be re-established — your messages and partial replies are saved. Tap Retry to resend.' };
      state.messages.push(msg);
      state._holdQueue = true; // v0.42: a dropped turn parks the queue (not a clean finish)
      if (isOwner(state)) {
        hideActivity(bodyEl, state);
        appendMessage(currentCtx.bodyEl.querySelector('#chat-messages'), null, msg, currentCtx.bodyEl, state._icon, state);
        // v0.42: the error bubble IS the last turn → the button reads RETRY
        // (the old reset-to-Send lost the one affordance that mattered).
        syncSendButton(currentCtx.bodyEl, state);
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
      // v0.46: HF-chat routing — the mode + own-space repo ride creation
      // (the PATCH in applySandbox covers later switches).
      sandbox_mode: state.sandbox === 'hf' ? (state.sandboxMode || 'shared') : '',
      sandbox_repo: state.sandbox === 'hf' ? (state.sandboxRepo || '') : '',
      model: state.model,
      provider: state.provider,
      effort: state.effort || 'med',
      web_search: true,  // v0.45 ITEM 2: default-on (pill removed)
      deep_research: !!state.deepResearch,
      // v0.60 pt C.9: the lib gate rides creation too (the PATCH in the
      // pill press covers later flips).
      lib_auto: !!state.libAuto,
      template_auto: !!(state.libAuto || state.templateAuto),
      skills_auto: !!(state.libAuto || state.skillsAuto),
      // v0.44: the active method template blob (see persistCaps).
      template: state.template ? JSON.stringify({
        id: state.template.id, name: state.template.name, brief: state.template.brief
      }) : '',
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
        // v0.46: restore the HF routing detail.
        if (data.SandboxMode && data.Sandbox === 'hf') state.sandboxMode = data.SandboxMode;
        if (data.SandboxRepo !== undefined && data.Sandbox === 'hf') state.sandboxRepo = data.SandboxRepo || '';
        if (!state.model && data.Model) state.model = data.Model;
        if (!state.provider && data.Provider) state.provider = data.Provider;
        if (data.SlidingWindow) state.slidingWindow = data.SlidingWindow;
        // v0.20 FIX: restore the FULL capability set from the engine
        // session — the old restore dropped web_search/deep_research/effort/
        // persona, so a PM chat with the web toggle ON silently lost its
        // tools after every reload (the state defaulted them to off).
        if (typeof data.WebSearch === 'boolean') state.webSearch = data.WebSearch;
        if (typeof data.DeepResearch === 'boolean') state.deepResearch = data.DeepResearch;
        // v0.60 pt C.9: restore the lib gate (the lib pill's state; the
        // legacy pill flags promote through the OR for old sessions).
        if (typeof data.LibAuto === 'boolean') state.libAuto = data.LibAuto;
        if (typeof data.TemplateAuto === 'boolean') state.templateAuto = data.TemplateAuto;
        if (typeof data.SkillsAuto === 'boolean') state.skillsAuto = data.SkillsAuto;
        if (typeof data.LibAuto !== 'boolean') {
          state.libAuto = !!(state.templateAuto || state.skillsAuto);
        }
        // v0.44: restore the active method template (the persisted blob
        // {id, name, brief} — engine column template_id, PATCHed by
        // persistCaps; deep research restores via the flag above).
        if (typeof data.TemplateID === 'string' && data.TemplateID) {
          try {
            var tpl = JSON.parse(data.TemplateID);
            if (tpl && tpl.id && tpl.brief) {
              state.template = { id: String(tpl.id), name: String(tpl.name || tpl.id), brief: String(tpl.brief) };
            }
          } catch (e) {}
        }
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

  // ── v0.44 INTERRUPT FIX (CAUSE #2): pure user-echo/dedupe helpers ──
  // Both are module-level + side-effect-free so the Node harness
  // (scripts/test_interrupt_fixes.js) exercises the exact logic the
  // 'user' handler runs. The handler applies whatever action object
  // they return.

  // Decide what an engine 'user' echo means for the local transcript.
  // The OLD handler only checked the LAST message — a mid-turn
  // reconnect's gap replay delivered the echo UNDER thinking/delta
  // bubbles and the handler PUSHED a duplicate of the message the user
  // had already sent (the "sent message lands back on my message box,
  // I have to delete it" report). Three layers, in order:
  //   1. _pendingSends — doSend records every optimistic send
  //      ({text, ts, mi}); a text match (with a 2-minute ts window when
  //      the event carries a ts) finds the message wherever it now
  //      lives (recorded mi when still valid, else a re-scan from the
  //      END for a local user message with the same text).
  //   2. tail-scan — ANY local (un-echoed) user message with the same
  //      text inside the trailing 6 messages gets stamped.
  //   3. push — genuinely new message, render a bubble.
  // Returns {kind:'stamp', mi:<messages idx>, pend:<pendingSends idx or -1>}
  // or {kind:'push'}.
  function resolveUserEcho(pendingSends, messages, ev) {
    var text = ev && ev.text != null ? String(ev.text) : '';
    if (!messages || !messages.length || text === '') return { kind: 'push' };
    var evMs = (ev && typeof ev.ts === 'number' && ev.ts > 0)
      ? Math.round(ev.ts * 1000) : 0;
    // 1. pending-send match
    if (pendingSends && pendingSends.length) {
      for (var p = 0; p < pendingSends.length; p++) {
        var entry = pendingSends[p];
        if (!entry || entry.text !== text) continue;
        if (evMs && entry.ts && Math.abs(evMs - entry.ts) >= 120000) continue; // stale entry
        var mi = -1;
        if (typeof entry.mi === 'number' && messages[entry.mi] &&
            messages[entry.mi].role === 'user' &&
            messages[entry.mi].text === text) {
          mi = entry.mi; // the recorded position still holds the message
        } else {
          for (var j = messages.length - 1; j >= 0; j--) {
            if (messages[j].role === 'user' && messages[j].local && messages[j].text === text) {
              mi = j; // it moved — find the local copy from the END
              break;
            }
          }
        }
        if (mi >= 0) return { kind: 'stamp', mi: mi, pend: p };
      }
    }
    // 2. tail-scan fallback (subsumes the old last-message-only check)
    for (var k = messages.length - 1, seen = 0; k >= 0 && seen < 6; k--, seen++) {
      var m = messages[k];
      if (m.role === 'user' && m.local && m.text === text && m.ei == null) {
        return { kind: 'stamp', mi: k, pend: -1 };
      }
    }
    return { kind: 'push' };
  }

  // Belt-and-braces for any duplicate that slipped past the echo match
  // (old-version logs replayed onto a fresh state, POST-persist/WS
  // seq desyncs): when TWO ADJACENT user messages have identical text,
  // one carries its engine echo (ei) and the other is still local, the
  // local one is the orphan optimistic copy — return a new array
  // without it, or null when there is nothing to drop. ONE drop per
  // call (the caller may re-run). Replayed-only transcripts never
  // match (nothing is `local` there), so a fresh open is a no-op.
  function dropAdjacentUserDupes(messages) {
    if (!messages || messages.length < 2) return null;
    for (var i = 0; i + 1 < messages.length; i++) {
      var a = messages[i], b = messages[i + 1];
      if (a.role !== 'user' || b.role !== 'user' || a.text !== b.text) continue;
      var aEi = a.ei != null, bEi = b.ei != null;
      if (aEi === bEi) continue; // both echoed or both local — not our orphan
      var dup = aEi ? b : a;    // the un-echoed twin is the orphan copy
      if (!dup.local) continue; // only optimistic (pending-echo) copies
      var dropIdx = aEi ? i + 1 : i;
      return messages.slice(0, dropIdx).concat(messages.slice(dropIdx + 1));
    }
    return null;
  }

  // v0.44 (CAUSE #2 bookkeeping): a reconnect replay is landing on a
  // transcript that may already hold part of it — remember it, run ONE
  // adjacent-duplicate pass once the burst drains (~1.5s quiet) or at
  // the next status event (whichever lands first).
  function markReplayGap(state) {
    if (!state) return;
    state._replayedGap = true;
    clearTimeout(state._gapPassTimer);
    state._gapPassTimer = setTimeout(function () { runAdjacentDupPass(state); }, 1500);
  }

  function runAdjacentDupPass(state) {
    if (!state || !state._replayedGap) return;
    state._replayedGap = false;
    clearTimeout(state._gapPassTimer);
    state._gapPassTimer = null;
    var cleaned = dropAdjacentUserDupes(state.messages);
    if (cleaned) {
      state.messages = cleaned;
      // v0.38 sandbox rule: only the chat that OWNS the live DOM rebuilds
      // (the hide-handler pattern); background chats keep state only.
      if (isOwner(state) && currentCtx && currentCtx.bodyEl) {
        var hc = currentCtx.bodyEl.querySelector('#chat-messages');
        if (hc) rebuildTranscript(hc, state);
      }
    }
  }

  // v0.44 INTERRUPT FIX (CAUSE #1): re-pointing onEvent on an EXISTING
  // client never revived a dead socket — a chat reopened after an
  // engine restart sat on a failed client (no replay, no events, a dead
  // transcript) until the next manual send forced a connect. Kick the
  // reconnect here; connect() itself no-ops while connecting/open.
  function reviveClient(state) {
    var c = state && state.client;
    if (!c || c.connected) return;
    if (c.state === 'connecting' || c.state === 'open') return;
    try { c.connect(); } catch (e) { console.error('ws revive failed', e); }
  }

  // v0.44 (CAUSE #1, belt and braces): the reconnect ladder gave up —
  // usually the engine DIED (Android watchdog kill / force-stop). Poll
  // a slow revive every 20s so a returning engine heals the chat on its
  // own (replay + heal events flow through handleEvent; the user does
  // not have to send 'continue'). Cleared on a successful 'open'.
  function startReviveTimer(state) {
    if (!state || state._reviveTimer) return;
    state._reviveTimer = setInterval(function () {
      var c = state.client;
      if (!c) { stopReviveTimer(state); return; }
      if (c.connected || c.state === 'connecting' || c.state === 'open') return;
      try { c.connect(); } catch (e) {}
    }, 20000);
  }
  function stopReviveTimer(state) {
    if (state && state._reviveTimer) {
      clearInterval(state._reviveTimer);
      state._reviveTimer = null;
    }
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
      if (ev.i <= (state.lastEventI || 0)) {
        // v0.44 (CAUSE #2): a duplicate id means the server is replaying
        // events this state already holds (a reconnect resume whose seq
        // cursor lagged the panel's POST-persisted ids, an overlap
        // replay) — the adjacent-duplicate pass runs once the burst
        // drains. Nothing else to do for the event itself.
        markReplayGap(state);
        return;
      }
      state.lastEventI = ev.i;
      // v0.42: last-arrival clock — scheduleOpenFlush waits for the
      // replay burst to go quiet before firing a parked queued message.
      state._lastEvAt = Date.now();
    }
    // v0.44 INTERRUPT FIX (CAUSE #3): a LIVE stream that arrives without
    // a doSend (the socket resumed mid-turn after a drop, a turn the
    // panel never saw start) re-arms the streaming state — otherwise
    // the button reads Send while the engine still holds the turn lock
    // and the next send hits the busy reject (the desync loop).
    // CRITICAL GUARD: REPLAYED events never re-arm — chatclient tags the
    // connect-time backlog burst with _replay:true, and a fresh open
    // replays old assistant_delta/thinking events that must not flip
    // the button to Stop forever.
    if (!state.isStreaming && !ev._replay && (
      type === 'assistant_delta' || type === 'thinking' ||
      type === 'tool_use' || type === 'tool_result' || type === 'sources' ||
      (type === 'status' && ev.state === 'running')
    )) {
      state.isStreaming = true;
      ensureActivityWatch(bodyEl, state);
      syncSendButton(bodyEl, state);
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
    // v0.39 RECOVERY: synthetic client-socket states (never persisted, no i).
    // 'reconnecting' keeps the turn ALIVE with an honest indicator — the
    // engine keeps the turn running and persisting; a resume (&since=)
    // picks the live stream back up. 'failed' means the ladder gave up:
    // the wireClientClose error bubble fires (the only terminal path).
    if (type === 'ws_state') {
      if (ev.state === 'reconnecting') {
        state._wsDropped = true;
        if (state.isStreaming) {
          setActivity(bodyEl, state, 'connection dropped — reconnecting… (' + ev.attempt + '/' + ev.of + ')');
        }
      } else if (ev.state === 'open') {
        state._wsDropped = false;
        // v0.44 (CAUSE #1): a landed connect ends the background revive
        // poll, and the replay burst that follows is flagged so the
        // adjacent-duplicate pass runs once it drains (fresh opens are a
        // no-op there — nothing is `local` after a pure replay).
        stopReviveTimer(state);
        markReplayGap(state);
        if (state.isStreaming) {
          // resumed mid-turn — the indicator falls back to the wait phase
          // (or the generic streaming state) until real events land.
          setActivity(bodyEl, state, state._waitPhase || 'reconnected — streaming…');
        }
      } else if (ev.state === 'failed') {
        state._wsDropped = false;
        // the ladder is exhausted → the terminal error path (wireClientClose)
        // v0.44 (CAUSE #1): ...AND a slow background revive — the engine
        // may just be restarting; when it comes back this poll heals the
        // chat (replay + heal events) without the user sending anything.
        startReviveTimer(state);
      }
      return;
    }
    if (type === 'user') {
      bumpActivity(state);
      // v0.44 INTERRUPT FIX (CAUSE #2): the engine echo of a message WE
      // sent must stamp the optimistic bubble wherever it now sits. The
      // old code only checked the LAST message — a mid-turn reconnect's
      // gap replay delivered the echo under thinking/delta bubbles and
      // re-PUSHED the sent message as a duplicate (the user report).
      // Pure decision (unit-tested), applied here:
      var ures = resolveUserEcho(state._pendingSends, state.messages, ev);
      if (ures.kind === 'stamp') {
        var tgt = state.messages[ures.mi];
        if (tgt) {
          delete tgt.local;
          // v0.37: the engine echo is authoritative for ts + ei — restamp the
          // optimistic local message so replayed ids line up for delete/edit.
          tgt.ts = evTsMs(ev);
          if (ev.i) tgt.ei = ev.i;
        }
        if (ures.pend >= 0 && state._pendingSends) state._pendingSends.splice(ures.pend, 1);
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
      // v0.52 THE 3 PILLS: the dynamic + tracks the template/skill the
      // model reaches for THIS turn (the tool_use half — template_show's
      // summary IS the id; the brain's tool_use has the name only, its
      // tool_result below carries the named markers).
      turnTemplateHint(bodyEl, state, pay);
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
      // v0.52 THE 3 PILLS: the brain's tool_result texts carry the named
      // markers ("=== SKILL LOADED: <name> ===", "TEMPLATE <id> (…)" —
      // the tool_use half had an empty summary there).
      turnTemplateHint(bodyEl, state, pay2);
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
    } else if (type === 'hublist') {
      // v0.52 dt_hublib: the bot browsed/downloaded the PUBLIC HUB — the
      // results land as a collapsible card box (the sources pattern): one
      // tappable row per item, each with a one-press ⤓ download button.
      // LIVE events carry {summary, items} top-level; REPLAYED ones carry
      // the same payload as JSON in text (the engine persists content=text)
      // — both shapes render identically (hubitem.js's PM-lift pattern).
      stampThinkEnd(state, evTsMs(ev));
      var hitems = ev.items || [];
      var hsum = ev.summary || '';
      if (!hitems.length && ev.text) {
        try {
          var hp = JSON.parse(ev.text);
          if (hp && hp.items) { hitems = hp.items; hsum = hsum || hp.summary || ''; }
        } catch (e3) {}
      }
      if (hitems.length) {
        var hubMsg = { role: 'hublist', items: hitems, summary: hsum, open: true, ts: evTsMs(ev) };
        if (ev.i) hubMsg.ei = ev.i;
        state.messages.push(hubMsg);
        appendMessage(msgContainer, scrollEl, hubMsg, bodyEl, state._icon, state);
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
        // v0.42: wasStreaming separates the LIVE end of THIS turn from
        // REPLAYED old idles (a fresh-open replay re-lands every historic
        // status event — those must never flush the queue).
        var wasStreaming = state.isStreaming;
        state.isStreaming = false;
        // v0.44 INTERRUPT FIX (CAUSE #1): a terminal status that arrives
        // while the turn was LIVE used to end it SILENTLY — isStreaming
        // drops, the activity hides, the button repaints, but NO bubble
        // ever renders (bubbles only came from type:'error' events), so
        // an engine-restart heal (or any status-error with no paired
        // error event) left the user staring at a dead chat with no
        // explanation. Render the notice here — the same emsg shape the
        // type:'error' handler builds, minus the suggest chips. The
        // message now survives the wire (store/events.go). wasStreaming
        // ONLY: a replayed old healed event must never re-bubble after a
        // fresh open.
        if (ev.state === 'error' && wasStreaming) {
          var she = {
            role: 'error',
            text: ev.message || 'the reply was interrupted — tap Retry',
            ts: evTsMs(ev)
          };
          if (ev.i) she.ei = ev.i;
          state.messages.push(she);
          appendMessage(msgContainer, scrollEl, she, bodyEl, state._icon, state);
          state._holdQueue = true; // an interrupted turn parks the queue — Retry is the way forward
        }
        // v0.44 (CAUSE #2): the turn is over — no engine echoes are
        // coming for its optimistic bubbles; drop the pending-send
        // ledger (the tail-scan still catches any late stragglers).
        state._pendingSends = null;
        // v0.44 (CAUSE #2): the first status after a reconnect is the
        // natural end of the gap replay — run the adjacent-duplicate
        // pass now instead of waiting out the quiet timer.
        if (state._replayedGap) runAdjacentDupPass(state);
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
        // v0.35: only the chat that OWNS the live panel may repaint its
        // send button — the old document.querySelector reset the FOREGROUND
        // chat's Stop button while it was still streaming. v0.42: the paint
        // itself is the mode machine (send | retry if the turn failed).
        syncSendButton(bodyEl, state);
        // v0.42 QUEUE FLUSH: ONE queued follow-up fires on a SUCCESSFUL,
        // LIVE turn end. 'error' parks the queue (something is broken);
        // replayed idles were filtered by wasStreaming above; a user stop
        // parked it via _holdQueue at tap time.
        if (ev.state === 'idle' && wasStreaming) flushSendQueue(bodyEl, state);
      } else if (ev.state === 'running' && (ev.text || ev.message)) {
        // v0.23: running-state messages ("network hiccup — retry 1/2",
        // research stages) now feed the activity indicator instead of
        // stacking throwaway progress pills into the message list.
        setActivity(bodyEl, state, ev.message || ev.text);
      }
    } else if (type === 'error') {
      // v0.40.1 REPLAY FIX: live error events carry parsed fields
      // (message/provider/model/suggest), but REPLAYED ones (the store's
      // wire shape) dump the whole payload as a JSON string in ev.text —
      // so a reopened chat rendered a raw-JSON bubble and lost the model-
      // gone chips. Parse the text back when it looks like our payload.
      var src = ev;
      if (typeof ev.text === 'string' && ev.text.charAt(0) === '{' && (!ev.message || !ev.suggest)) {
        try {
          var p = JSON.parse(ev.text);
          if (p && (p.message || p.error || p.suggest)) {
            src = {};
            for (var ek in ev) src[ek] = ev[ek];
            for (var pk in p) { if (p[pk] !== undefined && p[pk] !== null) src[pk] = p[pk]; }
          }
        } catch (e2) {}
      }
      state.isStreaming = false;
      hideActivity(bodyEl, state);
      var errText = friendlyError(src.message || src.error || src.text || 'Unknown error');
      if (src.provider) {
        errText += ' (via ' + src.provider + (src.model ? ' · ' + src.model : '') + ')';
      }
      // v0.37.1: ONE object for state + DOM (data-mi used to be -1 — the
      // push/append literal mismatch made error rows undeletable). ts + ei
      // ride along so errors get timestamps AND deletable engine ids.
      var emsg = { role: 'error', text: errText, ts: evTsMs(ev) };
      if (ev.i) emsg.ei = ev.i;
      // v0.40 MODEL-GONE ONE-TAP RECOVERY: the engine attaches the closest
      // available replacements (same provider, key-backed, family-ranked)
      // when the failure is the deprecation class — render them as
      // "Switch to X" chips that switch + auto-resend in one tap.
      if (Array.isArray(src.suggest) && src.suggest.length) {
        emsg.suggest = src.suggest.slice(0, 3);
      }
      state.messages.push(emsg);
      appendMessage(msgContainer, scrollEl, emsg, bodyEl, state._icon, state);
      state._holdQueue = true; // v0.42: the failed turn parks the queue — Retry is the way forward
      // v0.42: the error bubble is the LAST turn → the mode machine reads
      // RETRY (was: a hard reset to "Send" that threw the affordance away).
      syncSendButton(bodyEl, state);
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
    // v0.41: the engine event id rides the ROW — global search jumps
    // straight to [data-ei="..."] (data-mi is per-render-state and the
    // search result only knows the event id).
    var eiAttr = (msg.ei !== undefined && msg.ei !== null) ? ' data-ei="' + msg.ei + '"' : '';
    var tsAttr = msg.ts ? ' data-ts="' + msg.ts + '"' : '';
    if (msg.role === 'user') {
      return '<div class="msg-row msg-row-user"' + tsAttr + eiAttr + '>' +
        '<div class="msg-bubble msg-user" data-msg-role="user" data-msg-raw="' + escAttr(msg.text) + '"' + miAttr + tsAttr + '></div>' +
        (msg.ts ? '<div class="msg-time">' + esc(fmtTime(msg.ts)) + '</div>' : '') +
        '</div>';
    } else if (msg.role === 'assistant') {
      return '<div class="msg-row msg-row-assistant"' + tsAttr + eiAttr + '>' +
        '<div class="msg-bubble msg-assistant" data-msg-role="assistant" data-msg-raw="' + escAttr(msg.text) + '"' + miAttr + tsAttr + '></div>' +
        (msg.ts ? '<div class="msg-time">' + esc(fmtTime(msg.ts)) + '</div>' : '') +
        '</div>';
    } else if (msg.role === 'error') {
      // v0.40: model-gone errors carry one-tap replacement chips (the
      // engine's suggest array — same provider, key-backed, family-
      // ranked). Tapping a chip switches the chat's model and re-sends
      // the failed prompt (the delegated .err-switch handler below).
      var sugHtml = '';
      if (Array.isArray(msg.suggest) && msg.suggest.length) {
        sugHtml = '<div class="err-suggest" role="group" aria-label="Replacement models">';
        for (var si = 0; si < msg.suggest.length; si++) {
          var sg = msg.suggest[si];
          if (!sg || !sg.model) continue;
          sugHtml += '<button class="err-switch" data-provider="' + escAttr(sg.provider || '') + '" data-model="' + escAttr(sg.model) + '">' +
            '<span class="err-switch-ico">⇄</span>' + esc(sg.label || sg.model) + '</button>';
        }
        sugHtml += '</div>';
      }
      return '<div class="msg-bubble msg-error" data-msg-role="error"' + miAttr + '>' +
        '<div class="fmt fmt-plain">' + esc(msg.text) + '</div>' + sugHtml + '</div>';
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
    } else if (msg.role === 'hublist') {
      // v0.52 dt_hublib: the PUBLIC HUB card box — one row per found item
      // with a ONE-PRESS download button (⤓ → engine POST → "Yours" in the
      // template sheet). Tap a row (not the button) → the full hub item
      // panel (hubitem.js). The box rides the same collapsible pattern
      // as sources; open by default (a browse is a fresh result set).
      var hitems = msg.items || [];
      var hrows = '';
      for (var hI = 0; hI < hitems.length; hI++) {
        var hIt = hitems[hI] || {};
        var hDl = !!hIt.downloaded;
        var hTags = Array.isArray(hIt.tags) ? hIt.tags.join(' · ') : '';
        hrows +=
          '<div class="hmsg-card' + (hDl ? ' hmsg-card-dl' : '') + '" data-hub-card="1"' +
            ' data-hub-type="' + escAttr(hIt.type || '') + '"' +
            ' data-hub-repo="' + escAttr(hIt.repo || '') + '"' +
            ' data-hub-id="' + escAttr(hIt.id || '') + '"' +
            ' data-hub-name="' + escAttr(hIt.name || '') + '"' +
            ' role="button" tabindex="0" aria-label="open ' + escAttr(hIt.name || 'item') + ' in the hub"' +
          '>' +
            '<span class="hmsg-card-ico">' + (hIt.type === 'template' ? '🧩' : '🛠') + '</span>' +
            '<span class="hmsg-card-meta">' +
              '<span class="hmsg-card-title">' + esc(hIt.name || 'item') + (hDl ? ' <span class="hub-have">✓</span>' : '') + '</span>' +
              '<span class="hmsg-card-sub">' + esc(hIt.description || '') + '</span>' +
              '<span class="hmsg-card-stats">♥ ' + (hIt.hearts || 0) + ' · ⤓ ' + (hIt.downloads || 0) +
                (hTags ? ' · ' + esc(hTags) : '') + '</span>' +
            '</span>' +
            '<button class="hmsg-dl' + (hDl ? ' hmsg-dld' : '') + '" data-hub-dl="1"' +
              (hDl ? ' disabled title="already downloaded — find it in the ⧉ sheet under Yours"' :
                ' title="download" aria-label="download ' + escAttr(hIt.name || 'item') + '"') + '>' +
              (hDl ? '✓' : '⤓') +
            '</button>' +
          '</div>';
      }
      var hOpen = msg.open !== undefined ? !!msg.open : true;
      return '<details class="hub-wrap" data-mi="' + mi + '"' + (hOpen ? ' open' : '') + '>' +
        '<summary class="hub-wrap-label"><span>' + esc((msg.summary || 'PUBLIC HUB').toUpperCase()) + '</span>' +
        '<span class="hub-count">' + hitems.length + '</span><span class="hub-chev">▾</span></summary>' +
        '<div class="hub-list">' + hrows + '</div></details>';
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
    // v0.40: the starter chips ride out with the greeting (same lifecycle:
    // empty-state chrome). They live in #chat-live (outside the message
    // list), so look one level up from the transcript container.
    var startersEl = container && container.parentNode && container.parentNode.querySelector
      ? container.parentNode.querySelector('#chat-starters') : null;
    if (startersEl && startersEl.parentNode) startersEl.parentNode.removeChild(startersEl);
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
        // v0.46: remember the HF routing detail too.
        if (patch && patch.sandbox_mode) icon.sandboxMode = patch.sandbox_mode;
        if (patch && patch.sandbox_repo !== undefined) icon.sandboxRepo = patch.sandbox_repo;
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
    state._holdQueue = true; // v0.42: a deliberate interruption parks the queue
    syncSendButton(bodyEl, state); // v0.42: mode machine (was: hard "Send")
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
      if (ta) { ta.value = ''; state.draftText = ''; saveDraftLS(draftId(state), ''); }
      var mc = bodyEl.querySelector('#chat-messages');
      if (mc) rebuildTranscript(mc, state);
      syncSendButton(bodyEl, state); // v0.42: the restored tail may re-arm retry
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

    // v0.52 THE 3 PILLS: a fresh turn resets the dynamic + — the name
    // only shows while a template/skill is used THIS turn (turnTemplateHint
    // re-fills it from the tool events as the turn runs).
    state._turnTemplate = null;
    state._turnSkill = null;
    paintSegPlus(bodyEl, state);

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
    // v0.44 INTERRUPT FIX (CAUSE #2): record the optimistic send so the
    // engine's 'user' echo can find THIS message even when later bubbles
    // (thinking, deltas) bury it before the echo lands — the mid-turn
    // reconnect gap-replay duplicate. Consumed by resolveUserEcho.
    state._pendingSends = (state._pendingSends || []).concat([
      { text: text, ts: uMsg.ts, mi: state.messages.length - 1 }
    ]);
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
      // v0.40: the draft left home — clear the durable copy too
      clearDraftLS(draftId(state));
    }

    state.isStreaming = true;
    // v0.42: a fresh turn re-arms the queue auto-flush (a previous stop
    // or failure parked it) and paints STOP — the tap dispatcher reads
    // the mode, so no button handler is wired by hand anymore.
    state._holdQueue = false;
    // v0.23: start the no-silence watch the moment a turn begins (the
    // indicator covers the pre-first-token gap AND all tool phases).
    ensureActivityWatch(bodyEl, state);
    setActivity(bodyEl, state, 'sending…');
    syncSendButton(bodyEl, state);

    // PrivateMode turns must never wait for the engine WS.
    if (state.provider !== 'privatemodeai' && !(state.client && state.client.connected)) {
      if (!state.client && !state.sessionId) {
        ensureSession(icon, state, function () { connectWS(bodyEl, state, msgContainer); });
      } else if (state.client && state.client.state !== 'connecting' && state.client.state !== 'open') {
        state.client.connect();
      }
      setSendBusy(bodyEl, true); // v0.42: the '…' pulse while connecting
      var tries = 0;
      var check = setInterval(function () {
        tries++;
        if (state.client && state.client.connected) {
          clearInterval(check);
          setSendBusy(bodyEl, false);
          if (!state.isStreaming) syncSendButton(bodyEl, state); // the turn already ended (fast fail)
          type.send(text, state, ctx || makeCtxFallback(bodyEl, icon, state, panel, type));
        } else if (tries > 100) {
          clearInterval(check);
          setSendBusy(bodyEl, false);
          var err = 'Still connecting to the engine — tap Retry in a moment.' +
            (state.client && state.client.lastError ? ' (' + state.client.lastError + ')' : '');
          var connErr = { role: 'error', text: err };
          state.messages.push(connErr);
          appendMessage(msgContainer, null, connErr, bodyEl, icon, state);
          state.isStreaming = false;
          state._pendingSends = null; // v0.44 (CAUSE #2): the turn never started — no echo is coming
          syncSendButton(bodyEl, state); // v0.42: the error bubble → RETRY
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

  // ── v0.52 hub cards: one-press download + row tap → the hub item panel ──
  // (event delegation — fires for any live hublist box, replays included).
  // The ⤓ button POSTs the SAME download the hub panel's button does, then
  // lands the item in the local user-template library ("Yours" — skills and
  // templates both, the v0.48 rule) so it follows the user across devices.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button[data-hub-dl]');
    if (btn) {
      if (btn.disabled) return;
      var card = btn.closest('[data-hub-card]');
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      var type = card.getAttribute('data-hub-type');
      var repo = card.getAttribute('data-hub-repo');
      var itemId = card.getAttribute('data-hub-id');
      if (!type || !repo || !itemId) return;
      btn.disabled = true;
      btn.textContent = '·'; // busy dot
      fetch('/api/hub/' + encodeURIComponent(type) + '/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo, id: itemId })
      }).then(function (r) {
        return r.json().catch(function () { return {}; });
      }).then(function (d) {
        if (!d || d.error) throw new Error((d && d.error) || 'HTTP error');
        if (window.TemplateSheet && window.TemplateSheet.saveFromHub &&
            (type === 'template' || type === 'skill')) {
          window.TemplateSheet.saveFromHub(d.item || {}, d.payload);
        }
        if (window.Hub && window.Hub.markDownloaded) {
          window.Hub.markDownloaded(type, repo, itemId);
        }
        card.classList.add('hmsg-card-dl');
        btn.textContent = '✓';
        btn.classList.add('hmsg-dld');
        btn.setAttribute('title', 'already downloaded — find it in the ⧉ sheet under Yours');
        if (window.Hub && window.Hub.toast) window.Hub.toast('downloaded — ' + (card.getAttribute('data-hub-name') || 'item'));
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = '⤓';
        if (window.Hub && window.Hub.toast) window.Hub.toast(err.message || 'the download failed');
      });
      return;
    }
    // the card body (not the button) → the full hub item panel — the same
    // detail view the Public Library opens (PNG header, description, the
    // payload, endorse). The row is a [role=button] so keyboard users can
    // focus + Enter it too.
    var row = e.target.closest && e.target.closest('[data-hub-card]');
    if (row && !e.target.closest('a, button')) {
      var panel = window.ChatPanel && window.ChatPanel.current();
      if (!panel || !window.HubItem || !window.HubItem.open) return;
      var it = {
        type: row.getAttribute('data-hub-type') || '',
        repo: row.getAttribute('data-hub-repo') || '',
        id: row.getAttribute('data-hub-id') || '',
        name: row.getAttribute('data-hub-name') || ''
      };
      if (it.type && it.repo && it.id) window.HubItem.open(it.type, it);
    }
  });
  // keyboard parity: Enter/Space on a focused hub card row opens the panel
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest && e.target.closest('[data-hub-card]');
    if (!row || e.target.closest('button, a')) return;
    e.preventDefault();
    row.click();
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
    // v0.52: the public activation seam — the hub's local-library rows
    // (templatesheet) and any surface with a resolved template activate
    // it in the CURRENT chat through the exact path the old ⧉ pill used.
    applyTemplate: applyTemplate,
    render: render,
    getState: function (id) { return chatStates[id]; },
    current: function () { return currentCtx; },
    // v0.42: the global keyboard layer's Ctrl/Cmd+F hook — open the
    // LIVE chat's find bar. Only meaningful when the chat root is up
    // (a stacked view stashes the root DOM; find searches the live
    // transcript). Returns true when the bar opened.
    openFind: function () {
      if (!currentCtx || !currentCtx.bodyEl || !currentCtx.state) return false;
      var panel = currentCtx.panel;
      if (panel && panel.viewDepth && panel.viewDepth() > 0) return false;
      openFindBar(currentCtx.bodyEl, currentCtx.state);
      return true;
    },
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

  // v0.44: node test path (scripts/test_interrupt_fixes.js) — the pure
  // interrupt-hardening helpers + the draft functions, exported the same
  // way uikit.js/theme.js do (the browser never defines module).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      resolveUserEcho: resolveUserEcho,
      dropAdjacentUserDupes: dropAdjacentUserDupes,
      draftSaveStaleMs: draftSaveStaleMs,
      saveDraftLS: saveDraftLS,
      clearDraftLS: clearDraftLS,
      loadDraftLS: loadDraftLS
    };
  }
})();
