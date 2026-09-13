// chatclient.js — WebSocket client for the chat endpoint.
//
// Connects to /api/chat?session_id=X, sends messages, receives streaming events.
// Routes events to a callback. Handles reconnection (best-effort).
//
// v0.14 FIX (the "Still connecting to engine" bug): the URL is now always
// ABSOLUTE — `new WebSocket('/api/chat?…')` (a relative URL) throws
// SyntaxError on older Android WebViews, the client never connected, and
// every send died after 15s with "Still connecting". We build
// ws(s)://<location.host> explicitly, which works on every WebView.
//
// v0.14: also reports connect failures (onClose gets a reason), retries
// once automatically, and exposes a `state` for the UI ('idle' | 'connecting'
// | 'open' | 'failed').
//
// Exposes: window.ChatClient

(function () {
  'use strict';

  function ChatClient(baseUrl, sessionId, token) {
    this.baseUrl = baseUrl || '';
    this.sessionId = sessionId;
    this.token = token || '';
    this.ws = null;
    this.connected = false;
    this.state = 'idle';        // idle | connecting | open | failed
    this.lastError = '';
    this.onEvent = null;
    this.onClose = null;
    this._eventQueue = [];      // messages to send after connect
    this._retried = false;      // one automatic reconnect attempt
    this._closedByUser = false;
  }

  // v0.14: absolute WS base. baseUrl (when given) wins; otherwise derive
  // from location — ws:// for http, wss:// for https.
  ChatClient.prototype._wsBase = function () {
    if (this.baseUrl) return this.baseUrl.replace(/^http/, 'ws');
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  };

  ChatClient.prototype.connect = function () {
    var self = this;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return; // already connecting/open
    }
    this._closedByUser = false;
    var url = this._wsBase() + '/api/chat?session_id=' + encodeURIComponent(this.sessionId);
    if (this.token) url += '&token=' + encodeURIComponent(this.token);

    this.state = 'connecting';
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      // Constructor-level failure (bad URL / very old WebView). Surface it —
      // the silent version of this was the 15s "Still connecting" dead end.
      this.state = 'failed';
      this.lastError = 'WebSocket unavailable: ' + (e && e.message ? e.message : e);
      console.error('WS connect failed', e);
      return;
    }

    this.ws.onopen = function () {
      self.connected = true;
      self.state = 'open';
      self._retried = false;
      // Flush queued messages
      while (self._eventQueue.length > 0) {
        self.ws.send(self._eventQueue.shift());
      }
    };

    this.ws.onmessage = function (e) {
      try {
        var ev = JSON.parse(e.data);
        if (self.onEvent) self.onEvent(ev);
      } catch (err) {
        console.error('ws parse error', err);
      }
    };

    this.ws.onerror = function (e) {
      console.error('ws error', e);
    };

    this.ws.onclose = function (ev) {
      var wasOpen = self.connected;
      self.connected = false;
      if (self._closedByUser) {
        self.state = 'idle';
        return;
      }
      if (!wasOpen && !self._retried) {
        // Never got open — one automatic retry (the engine session may have
        // just been created, or a transient upgrade race).
        self._retried = true;
        self.state = 'connecting';
        setTimeout(function () { if (!self._closedByUser) self.connect(); }, 1200);
        return;
      }
      if (!wasOpen) {
        self.state = 'failed';
        self.lastError = 'connection closed before opening' +
          (ev && ev.reason ? ' (' + ev.reason + ')' : '');
        // Tell the UI instead of dying silently.
        if (self.onEvent) {
          self.onEvent({ type: 'error', message: 'Engine connection failed — ' + self.lastError });
        }
      } else {
        self.state = 'idle';
      }
      if (self.onClose) self.onClose();
    };
  };

  ChatClient.prototype.send = function (text, opts) {
    // v0.13: opts carries capability flags (effort / web_search /
    // deep_research) — per-message overrides for the engine's chat turn.
    var payload = { type: 'send', message: text };
    if (opts) {
      if (opts.effort !== undefined) payload.effort = opts.effort;
      if (opts.web_search !== undefined) payload.web_search = !!opts.web_search;
      if (opts.deep_research !== undefined) payload.deep_research = !!opts.deep_research;
    }
    var msg = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      // If the socket is dead/failed, kick a reconnect so the queued
      // message actually goes somewhere.
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this._retried = false;
        this.connect();
      }
      this._eventQueue.push(msg);
    }
  };

  ChatClient.prototype.stop = function () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
  };

  ChatClient.prototype.close = function () {
    this._closedByUser = true;
    if (this.ws) {
      this.ws.onclose = null; // suppress callback
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.state = 'idle';
  };

  window.ChatClient = ChatClient;
})();
