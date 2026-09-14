// chatframework.js — v0.16 the object-oriented CHAT-TYPE system.
//
// WHY: every chat kind (Quick Chat today; Termux + Hugging Face later) is a
// different product surface — its own header pills, its own setup gate, its
// own send pipeline, its own metadata. The user's spec:
//
//   "Everything should be inherited, object oriented, moldable,
//    compartmentalized. Redesign the system and how we initiate and handle
//    chats completely if they don't meet this strict standard."
//
// THE CONTRACT (ChatType base class — subclass and override):
//
//   .id / .label / .icon / .description   identity (registry key)
//   .gatelockTitle(state)                 "do this quickly - setup the AI bot"
//   .gatelockSteps(state)   → [{key,title,sub,icon,onTap}]  the big setup boxes
//   .isFulfilled(state)     → bool        gate open → chat reveals
//   .pills(state)           → [{id,label,icon,tone,onTap}] header dropdown rows
//   .summaryLine(state)     → string      tiny text on the collapsed header
//   .toolbar(state)         → [{id,label,active,onTap,style}] capability pills
//   .send(text, state, ctx)               one turn (WS / SDK / terminal…)
//   .stop(state, ctx)                     abort a running turn
//   .onEvent(ev, state, ctx)              type-specific WS event handling
//   .extraSessionFields(state)            persisted metadata for this type
//
// The HOST (chatpanel.js) owns: layout, state registry, DOM pipeline,
// session persistence, event replay — and DELEGATES everything
// chat-kind-specific to the registered ChatType.
//
// Extending later = new file, `class TermuxChat extends ChatType`,
// `ChatTypes.register(new TermuxChat())` — the host never changes.
//
// Exposes: window.ChatTypes

(function () {
  'use strict';

  // ── The base class ─────────────────────────────────────────────
  //
  // Subclasses override the methods they care about; everything has a
  // working default so a minimal new chat type is ~20 lines.
  class ChatType {
    constructor(opts) {
      this.id = opts.id || 'unknown';             // sandbox key ('quick')
      this.label = opts.label || 'Chat';          // human name
      this.icon = opts.icon || '⚡';
      this.description = opts.description || '';
      this.placeholder = opts.placeholder || 'Message…';
      this.greeting = opts.greeting || 'Say hi…';
    }

    // The gate title. Default per user spec v0.16.
    gatelockTitle() { return 'do this quickly - setup the AI bot'; }
    gatelockIntro(state) {
      return 'Two steps and the chat opens below.';
    }

    // The setup boxes. Override. [{key,title,sub,icon,onTap}]
    gatelockSteps() { return []; }

    // Is the setup gate satisfied? (chat reveals when true)
    isFulfilled(state) { return true; }

    // Header dropdown pills. Override. [{id,label,icon,onTap}]
    pills() { return []; }

    // Collapsed-header summary ("⚡ Quick Chat · NVIDIA").
    summaryLine(state) { return this.icon + ' ' + this.label; }

    // Toolbar above the input (capabilities).
    toolbar() { return []; }

    // One turn. Override (super.send returns a rejected-ish noop).
    send() { return Promise.reject(new Error('chat type has no send()')); }
    stop() {}

    // Type-specific WS event hook (default: none — host handles the core).
    onEvent() { return false; }

    // Persisted metadata fields for the engine session.
    extraSessionFields() { return {}; }
  }

  // ── QUICK CHAT (the v0.15 behavior, expressed as a ChatType) ─────
  //
  // Sandbox 'quick': cloud provider or local model. Capabilities:
  // effort ladder + web search + deep research. Transport: engine WS
  // (Go direct proxy) or — for PrivateMode — the official SDK bridge
  // running in this WebView.
  class QuickChatType extends ChatType {
    constructor() {
      super({
        id: 'quick',
        label: 'Quick Chat',
        icon: '⚡',
        description: 'No commands, no sandbox. Just talk — with effort modes, web search and deep research.',
        placeholder: 'Message…',
        greeting: 'Say hi'
      });
    }

    // Two setup boxes: the sandbox (= chat type, i.e. THIS registry) and
    // the model source. The sandbox box lets you switch chat kinds.
    gatelockSteps(ctx) {
      var self = this;
      var st = ctx.state;
      return [
        {
          key: 'sandbox',
          filled: !!st.sandbox,
          title: st.sandbox ? (SANDBOX_LABELS[st.sandbox] || st.sandbox) : '+ Sandbox',
          sub: st.sandbox ? 'tap to change' : 'tap to connect',
          icon: st.sandbox ? (SANDBOX_ICONS[st.sandbox] || '⚡') : '🔌',
          onTap: function () {
            window.SandboxPicker.open(function (t) { ctx.applySandbox(t); });
          }
        },
        {
          key: 'model',
          filled: !!st.model,
          title: st.provider ? providerLabel(st.provider) : '+ Model',
          sub: st.model ? '+ model' : 'tap to connect',
          icon: '🤖',
          onTap: function () { ctx.openModelPicker(); }
        }
      ];
    }

    isFulfilled(state) { return !!(state.sandbox && state.model); }

    pills(ctx) {
      return [
        {
          id: 'pill-sandbox',
          label: (SANDBOX_ICONS[ctx.state.sandbox] || '⚡') + ' ' +
                 (SANDBOX_LABELS[ctx.state.sandbox] || ctx.state.sandbox || 'Sandbox'),
          onTap: function () {
            window.SandboxPicker.open(function (t) { ctx.applySandbox(t); });
          }
        },
        {
          id: 'pill-model',
          label: ctx.state.provider
            ? providerLabel(ctx.state.provider)
            : '+ Model',
          onTap: function () { ctx.openModelPicker(); }
        }
      ];
    }

    summaryLine(state) {
      var bits = [this.icon + ' ' + this.label];
      if (state.provider) bits.push(providerLabel(state.provider));
      if (state.model) bits.push(modelDetail(state.model));
      return bits.join(' · ');
    }

    // The capability toolbar (effort ladder + web/deep toggles + export).
    toolbar(ctx) { return []; } // built imperatively by the host (needs catalog)

    // THE TURN. Quick chat transports: PrivateMode → SDK bridge in this
    // WebView; everything else → the engine WebSocket.
    send(text, state, ctx) {
      if (state.provider === 'privatemodeai') {
        return ctx.runPMTurn(text);
      }
      return ctx.runWSTurn(text);
    }

    stop(state, ctx) {
      if (state.provider === 'privatemodeai') {
        if (state._pmAbort) state._pmAbort.abort(); // v0.17 fix: was ctx.pmAbort (never set)
      } else if (state.client) {
        state.client.stop();
      }
    }
  }

  // ── Registry ───────────────────────────────────────────────────
  var types = {};
  function register(type) { types[type.id] = type; }
  function get(id) { return types[id] || types.quick; }
  function list() { return Object.keys(types).map(function (k) { return types[k]; }); }

  // Shared pretty-label helpers (the host + types both use these).
  var SANDBOX_LABELS = { quick: 'Quick Chat', hf: 'Hugging Face', device: 'Another Device', terminal: 'Termux' };
  var SANDBOX_ICONS = { quick: '⚡', hf: '🤗', device: '🔗', terminal: '⌨️' };
  var providerLabels = {};
  var catalogPromise = null;
  var labelsLoaded = false;   // v0.16: settled — callers can avoid re-render loops
  function ensureCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch('/api/models').then(function (r) { return r.json(); }).then(function (d) {
      var provs = (d && d.providers) || {};
      for (var name in provs) providerLabels[name] = provs[name].label || name;
      labelsLoaded = true;
      return d;
    }).catch(function () { labelsLoaded = true; return {}; });
    return catalogPromise;
  }
  function hasLabels() { return labelsLoaded; }
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

  // Register the shipped chat types.
  register(new QuickChatType());

  // ── Public API ─────────────────────────────────────────────────
  window.ChatTypes = {
    register: register,
    get: get,
    list: list,
    ChatType: ChatType,          // subclass me
    helpers: {
      SANDBOX_LABELS: SANDBOX_LABELS,
      SANDBOX_ICONS: SANDBOX_ICONS,
      providerLabel: providerLabel,
    hasLabels: hasLabels,
      modelDetail: modelDetail,
      ensureCatalog: ensureCatalog
    }
  };
})();
