// api.js — engine HTTP + WebSocket client (vanilla, no deps).
//
// Exposes: window.DoomalayAPI
//
// Talks to the engine on the SAME ORIGIN that served this page (the engine
// embeds the PWA, so /api/... is same-origin). On the Android APK the engine
// listens on 127.0.0.1 inside the device, and the WebView is pointed at it —
// so this "just works" with no configuration.
//
// Endpoints used (see engine/internal/server/):
//   GET  /api/health                 → {status, brain, mode, version}
//   GET  /api/models[?refresh=1]     → {providers, models, syncStatus, totalModels}
//   GET  /api/keys                   → {ENV_VAR: {provider, env_var, has_key, has_extra}}
//   POST /api/keys                   ← {provider, env_var, key, extra}
//   GET  /api/sessions               → {sessions: [...]}
//   POST /api/sessions               ← {title?, model?, provider?}  → session
//   PATCH /api/sessions/{id}         ← {model?, provider?, title?}
//   GET  /api/sessions/{id}          → session
//   GET  /api/sessions/{id}/events   → {events: [...]}
//   WS   /api/chat?session_id={id}   → send/stop, receive events

(function () {
  'use strict';

  async function req(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts || {}));
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = await res.text(); } catch (e) { /* keep statusText */ }
      throw new Error(res.status + ': ' + detail);
    }
    return res.json();
  }

  // The engine's store.Session marshals with Go's default field names
  // ("ID", "Title", "Model", "Provider" — capitalized). Normalize every
  // session object to lowercase so the rest of the app can use sess.id,
  // sess.model, etc.
  function normSession(s) {
    if (!s) return s;
    return {
      id: s.ID != null ? s.ID : s.id,
      title: s.Title != null ? s.Title : (s.title || 'New Chat'),
      model: s.Model != null ? s.Model : (s.model || ''),
      provider: s.Provider != null ? s.Provider : (s.provider || '')
    };
  }

  const API = {
    health: function () { return req('/api/health'); },
    capabilities: function () { return req('/api/capabilities'); },

    models: function (refresh) {
      return req('/api/models' + (refresh ? '?refresh=1' : ''));
    },
    listKeys: function () { return req('/api/keys'); },
    setKey: function (envVar, provider, key, extra) {
      return req('/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          env_var: envVar, provider: provider, key: key, extra: extra || ''
        })
      });
    },
    deleteKey: function (envVar) {
      return req('/api/keys/' + encodeURIComponent(envVar), { method: 'DELETE' });
    },

    listSessions: function () {
      return req('/api/sessions').then(function (d) {
        return (d.sessions || []).map(normSession);
      });
    },
    createSession: function (opts) {
      return req('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(opts || {})
      }).then(normSession);
    },
    getSession: function (id) { return req('/api/sessions/' + id).then(normSession); },
    updateSession: function (id, patch) {
      return req('/api/sessions/' + id, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      }).then(normSession);
    },
    deleteSession: function (id) {
      return req('/api/sessions/' + id, { method: 'DELETE' });
    },
    getEvents: function (id) {
      return req('/api/sessions/' + id + '/events').then(function (d) {
        return d.events || [];
      });
    },

    // Open the chat WebSocket for a session. The engine REPLAYS all events
    // since seq 0 on connect, so the caller just renders what arrives
    // (dedup by seq).
    chatWS: function (sessionId, onEvent, onClose, onError) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/api/chat?session_id=' +
                  encodeURIComponent(sessionId);
      const ws = new WebSocket(url);
      ws.onmessage = function (e) {
        try {
          const ev = JSON.parse(e.data);
          if (onEvent) onEvent(ev, ws);
        } catch (err) {
          console.error('ws parse error:', err);
        }
      };
      ws.onclose = function () { if (onClose) onClose(ws); };
      ws.onerror = function (err) { if (onError) onError(err, ws); };
      return ws;
    }
  };

  window.DoomalayAPI = API;
})();
