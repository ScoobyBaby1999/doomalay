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
// v0.39 RECOVERY (P8-FULL): the client now RESUMES instead of dying —
//   - every event's seq is tracked; a reconnect sends &since=<lastSeq> and
//     the server replays only the gap, then re-binds the LIVE feed
//     (the in-flight turn keeps streaming into the new socket).
//   - a dropped socket triggers the reconnect ladder: mid-turn drops get
//     6 attempts over ~20s (the turn is safe server-side — it survives
//     its socket); idle drops get 3 quick tries.
//   - synthetic {type:'ws_state'} events tell the UI what's happening
//     ('reconnecting' with attempt counts → 'open' on resume, 'failed'
//     when the ladder gives up — the UI then shows the honest error).
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
    this._closedByUser = false;
    // v0.39 resume state
    this.lastSeq = 0;           // highest seq seen (live or replayed)
    this.turnActive = false;    // a send is in flight (until status idle/error)
    this._attempt = 0;          // ladder position
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
    // v0.39 RESUME: send the last seq we hold — the server replays only the
    // gap and hands us the live feed. First-ever connect (lastSeq 0) does
    // the full replay exactly like before.
    if (this.lastSeq > 0) url += '&since=' + this.lastSeq;

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
      self._attempt = 0; // a landed connect resets the ladder
      // v0.39: tell the UI the stream resumed (it may be holding a
      // "reconnecting…" indicator over a still-running turn).
      if (self.onEvent) self.onEvent({ type: 'ws_state', state: 'open', resumed: self.lastSeq > 0 });
      // Flush queued messages
      while (self._eventQueue.length > 0) {
        self.ws.send(self._eventQueue.shift());
      }
    };

    this.ws.onmessage = function (e) {
      try {
        var ev = JSON.parse(e.data);
        // v0.39: track the seq cursor + turn activity for the ladder.
        if (ev && typeof ev.seq === 'number' && ev.seq > self.lastSeq) {
          self.lastSeq = ev.seq;
        }
        if (ev && ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error')) {
          self.turnActive = false;
        }
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
      // v0.39 LADDER: dropped mid-turn or mid-session → try to RESUME.
      // A mid-turn drop holds the turn (the server keeps it running and
      // persisting; a resume picks the live stream back up), so it earns
      // the long ladder. An idle drop gets the short one.
      if (self.turnActive || wasOpen) {
        self._scheduleReconnect();
        return;
      }
      if (!wasOpen && self._attempt === 0) {
        // Never got open — one automatic retry (the engine session may have
        // just been created, or a transient upgrade race).
        self._scheduleReconnect();
        return;
      }
      if (!wasOpen) {
        self.state = 'failed';
        self.lastError = 'connection closed before opening' +
          (ev && ev.reason ? ' (' + ev.reason + ')' : '');
        if (self.onEvent) {
          self.onEvent({ type: 'error', message: 'Engine connection failed — ' + self.lastError });
        }
      } else {
        self.state = 'idle';
      }
      if (self.onClose) self.onClose();
    };
  };

  // v0.39: the reconnect ladder. Mid-turn: 500ms → 1s → 2s → 4s → 4s → 8s
  // (~20s total). Idle: 3 quick tries. Each rung announces itself as a
  // synthetic ws_state event so the UI can show "reconnecting… (2/6)".
  // When the ladder gives up, ws_state failed fires and onClose runs
  // (the UI shows the honest error bubble then — and only then).
  ChatClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._closedByUser) return;
    var delays = this.turnActive ? [500, 1000, 2000, 4000, 4000, 8000] : [500, 1500, 3000];
    if (this._attempt >= delays.length) {
      this.state = 'failed';
      this.lastError = 'reconnect attempts exhausted';
      if (this.onEvent) this.onEvent({ type: 'ws_state', state: 'failed', turnActive: this.turnActive });
      this._attempt = 0;
      if (this.onClose) this.onClose();
      return;
    }
    var wait = delays[this._attempt];
    var n = this._attempt + 1;
    this._attempt++;
    this.state = 'connecting';
    if (this.onEvent) {
      this.onEvent({
        type: 'ws_state', state: 'reconnecting',
        attempt: n, of: delays.length, in: wait, turnActive: this.turnActive
      });
    }
    setTimeout(function () {
      if (!self._closedByUser) self.connect();
    }, wait);
  };

  ChatClient.prototype.send = function (text, opts) {
    // v0.13: opts carries capability flags (effort / web_search /
    // deep_research) — per-message overrides for the engine's chat turn.
    // v0.15: model + provider ride every send too — the engine re-fetches
    // the session per turn AND applies these overrides, so a turn can
    // never run through a stale provider (the universal-401 bug).
    var payload = { type: 'send', message: text };
    if (opts) {
      if (opts.effort !== undefined) payload.effort = opts.effort;
      if (opts.web_search !== undefined) payload.web_search = !!opts.web_search;
      if (opts.deep_research !== undefined) payload.deep_research = !!opts.deep_research;
      if (opts.model !== undefined && opts.model !== null && opts.model !== '') payload.model = opts.model;
      if (opts.provider !== undefined && opts.provider !== null && opts.provider !== '') payload.provider = opts.provider;
    }
    var msg = JSON.stringify(payload);
    this.turnActive = true; // v0.39: the ladder's long rung is earned from here
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      // If the socket is dead/failed, kick a reconnect so the queued
      // message actually goes somewhere.
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect();
      }
      this._eventQueue.push(msg);
    }
  };

  ChatClient.prototype.stop = function () {
    this.turnActive = false; // a user stop ends the turn even if the ack is lost
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
  };

  // v0.37: control frames beyond send/stop (hide — edit/delete/regenerate
  // masking). Same queueing semantics as send: if the socket is down, the
  // frame is dropped (the POST /events endpoint is the fallback path).
  ChatClient.prototype.sendRaw = function (payload) {
    var msg = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
      return true;
    }
    return false;
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
