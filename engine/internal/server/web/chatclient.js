// chatclient.js — WebSocket client for the chat endpoint.
//
// Connects to /api/chat?session_id=X, sends messages, receives streaming events.
// Routes events to a callback. Handles reconnection (best-effort).
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
    this.onEvent = null;
    this.onClose = null;
    this._eventQueue = [];  // messages to send after connect
  }

  ChatClient.prototype.connect = function () {
    var self = this;
    var wsBase = this.baseUrl.replace(/^http/, 'ws');
    var url = wsBase + '/api/chat?session_id=' + encodeURIComponent(this.sessionId);
    if (this.token) url += '&token=' + encodeURIComponent(this.token);

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('WS connect failed', e);
      return;
    }

    this.ws.onopen = function () {
      self.connected = true;
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

    this.ws.onclose = function () {
      self.connected = false;
      if (self.onClose) self.onClose();
    };
  };

  ChatClient.prototype.send = function (text) {
    var msg = JSON.stringify({ type: 'send', message: text });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this._eventQueue.push(msg);
    }
  };

  ChatClient.prototype.stop = function () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
  };

  ChatClient.prototype.close = function () {
    if (this.ws) {
      this.ws.onclose = null; // suppress callback
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  };

  window.ChatClient = ChatClient;
})();
