// collabcore.js — v1.69.1 THE SHARED CANVAS (PLAN-V169 §v1.69.1): the
// PWA's pure op codec — the TWIN of engine/internal/collab (op.go +
// doc.go). One law, both sides: the same op sequence folds the same doc
// on the Go engine and in this file (the twin law, rig-pinned).
//
// THE MODEL (Figma's published multiplayer architecture, adapted):
//   - the DOC is the shared plane of a canvas — icons[], dots[],
//     currentFamily, worldSize — ID-addressed, property-level, merged
//     LWW per (id, property) with the SERVER's arrival seq as the one
//     clock (no client timestamps, ever);
//   - the VIEW (camera, the settings slice) is personal — never syncs;
//   - ops are explicit domain frames (icon.set / icon.add / icon.remove
//     / dot.* / doc.set) derived by diffing two docs (what saveNow's
//     content memo already does, promoted to the doc plane).
//
// THE REPLAY-SAFE LAWS (mirrors Go FoldOp exactly):
//   - icon.add for an existing id → no-op; set/remove for an absent id
//     → no-op; adds append at the END (the addEntity z-order law).
//
// Dual-environment (the worlds.js precedent): the pure core is
// node-requireable for the rig; window.DoomCollab is the PWA surface.
// This phase wires NOTHING into the live app yet — v1.69.2's store
// layer consumes it (solo canvases stay byte-identical to v1.67).
(function () {
  'use strict';

  // ── the doc projection ───────────────────────────────────────────
  // docOf(state) — the shared plane of a WorldState. Absent planes
  // normalize to empty arrays; worldSize normalizes to 0 (absent — the
  // pre-v1.69 saves; the app falls back to the personal setting).
  function docOf(state) {
    var st = state || {};
    return {
      icons: Array.isArray(st.icons) ? st.icons.slice() : [],
      dots: Array.isArray(st.dots) ? st.dots.slice() : [],
      currentFamily: st.currentFamily || '',
      worldSize: (typeof st.worldSize === 'number') ? st.worldSize : 0
    };
  }

  // ── op helpers ───────────────────────────────────────────────────
  function byId(list) {
    var m = {};
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it && typeof it === 'object' && it.id) m[it.id] = it;
    }
    return m;
  }

  function sameValue(a, b) {
    // the content memo's own law: JSON string equality (serialize()
    // builds stable key order, so this is exact for our shapes)
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  function diffProps(prev, next) {
    var out = null;
    for (var k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      if (k === 'id') continue;
      if (!prev || !sameValue(prev[k], next[k])) {
        if (!out) out = {};
        out[k] = next[k];
      }
    }
    return out; // null = no change
  }

  // ── diffDocs(prevDoc, nextDoc, nextOpId) → ops[] ──────────────────
  // The derivation law (what a saveNow diff emits, in order):
  //   1. icon ops walking NEXT in array order (sets for changed, adds
  //      for new — the add carries the FULL serialize());
  //   2. icon removes for ids gone from prev;
  //   3. dot ops, same law;
  //   4. doc.set for currentFamily / worldSize when they moved.
  // Deterministic: the same pair of docs always derives the same batch.
  function diffDocs(prevDoc, nextDoc, nextOpId) {
    var ops = [];
    var opId = nextOpId || (function () { var n = 0; return function () { return 'op:' + (++n); }; })();
    prevDoc = docOf(prevDoc);
    nextDoc = docOf(nextDoc);

    var prevIcons = byId(prevDoc.icons);
    for (var i = 0; i < nextDoc.icons.length; i++) {
      var ic = nextDoc.icons[i];
      if (!ic || !ic.id) continue;
      if (!prevIcons[ic.id]) {
        ops.push({ opId: opId(), kind: 'icon.add', id: ic.id, icon: ic });
      } else {
        var ch = diffProps(prevIcons[ic.id], ic);
        if (ch) ops.push({ opId: opId(), kind: 'icon.set', id: ic.id, props: ch });
      }
    }
    var nextIconIds = byId(nextDoc.icons);
    for (var j = 0; j < prevDoc.icons.length; j++) {
      var pic = prevDoc.icons[j];
      if (pic && pic.id && !nextIconIds[pic.id]) {
        ops.push({ opId: opId(), kind: 'icon.remove', id: pic.id });
      }
    }

    var prevDots = byId(prevDoc.dots);
    for (var k = 0; k < nextDoc.dots.length; k++) {
      var dt = nextDoc.dots[k];
      if (!dt || !dt.id) continue;
      if (!prevDots[dt.id]) {
        ops.push({ opId: opId(), kind: 'dot.add', id: dt.id, dot: dt });
      } else {
        var dch = diffProps(prevDots[dt.id], dt);
        if (dch) ops.push({ opId: opId(), kind: 'dot.set', id: dt.id, props: dch });
      }
    }
    var nextDotIds = byId(nextDoc.dots);
    for (var m = 0; m < prevDoc.dots.length; m++) {
      var pdt = prevDoc.dots[m];
      if (pdt && pdt.id && !nextDotIds[pdt.id]) {
        ops.push({ opId: opId(), kind: 'dot.remove', id: pdt.id });
      }
    }

    if (!sameValue(prevDoc.currentFamily, nextDoc.currentFamily)) {
      ops.push({ opId: opId(), kind: 'doc.set', id: '_', path: 'currentFamily', value: nextDoc.currentFamily });
    }
    if (!sameValue(prevDoc.worldSize, nextDoc.worldSize)) {
      ops.push({ opId: opId(), kind: 'doc.set', id: '_', path: 'worldSize', value: nextDoc.worldSize });
    }
    return ops;
  }

  // ── applyOpToDoc(doc, op) → doc ───────────────────────────────────
  // THE GO FoldOp TWIN — mutates the doc IN PLACE (clone first when
  // purity matters — the rig does; the live store applies to the real
  // world through its own paths). Same laws, same results, both sides.
  function applyOpToDoc(doc, op) {
    if (!doc || !op) return doc;
    var plane = null, payload = null;
    switch (op.kind) {
      case 'icon.set': plane = 'icons'; break;
      case 'icon.remove': plane = 'icons'; break;
      case 'icon.add': plane = 'icons'; payload = op.icon; break;
      case 'dot.set': plane = 'dots'; break;
      case 'dot.remove': plane = 'dots'; break;
      case 'dot.add': plane = 'dots'; payload = op.dot; break;
      case 'doc.set':
        if (op.path === 'currentFamily') doc.currentFamily = op.value;
        else if (op.path === 'worldSize') doc.worldSize = op.value;
        return doc;
      default: return doc;
    }
    if (!Array.isArray(doc[plane])) doc[plane] = [];
    var list = doc[plane];
    if (op.kind === 'icon.add' || op.kind === 'dot.add') {
      var id = payload && payload.id;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return doc; // replay-safe: never double-add
      }
      list.push(payload);
      return doc;
    }
    if (op.kind === 'icon.set' || op.kind === 'dot.set') {
      for (var s = 0; s < list.length; s++) {
        if (list[s] && list[s].id === op.id) {
          var target = list[s];
          for (var k in (op.props || {})) {
            if (Object.prototype.hasOwnProperty.call(op.props, k)) target[k] = op.props[k];
          }
          return doc;
        }
      }
      return doc; // absent id → no-op (a set can never resurrect)
    }
    // remove
    var out = [];
    for (var r = 0; r < list.length; r++) {
      if (!(list[r] && list[r].id === op.id)) out.push(list[r]);
    }
    doc[plane] = out;
    return doc;
  }

  function applyOpsBatch(doc, ops) {
    for (var i = 0; i < (ops || []).length; i++) applyOpToDoc(doc, ops[i]);
    return doc;
  }

  // ── the exports ──────────────────────────────────────────────────
  var DoomCollab = {
    docOf: docOf,
    diffDocs: diffDocs,
    applyOpToDoc: applyOpToDoc,
    applyOpsBatch: applyOpsBatch,
    // the derivation cap mirrors the server's MaxOpsPerBatch — a diff
    // over the cap means the doc moved too far for ops (a rebase takes
    // the snapshot path instead).
    MAX_OPS_PER_BATCH: 256
  };

  // ══ v1.69.2 THE ROOM (PLAN-V169 §v1.69.2) — the client half ════════
  // The OOP collaboration core: a dumb transport (one WS connection) +
  // the SharedDocSession (the smart layer — cursor, baseline, pending,
  // optimistic echo law, reconnect ladder, rebase-on-409). Both take
  // their environment through injected dependencies (the PWA passes the
  // real fetchers + the world adapter; the rig passes fakes) — no DOM
  // reach-ins, fully node-testable.

  // CollabTransport — ONE WebSocket connection (reconnects are the
  // session's policy; a transport never outlives its socket).
  // eslint-disable-next-line no-redeclare
  class CollabTransport {
    constructor(opts) {
      this.url = opts.url;                 // the full ws://…/api/collab/live?… URL
      this.onFrame = opts.onFrame || function () {};  // one parsed JSON frame
      this.onClose = opts.onClose || function () {};  // the socket died (the session reconnects)
      this.ws = null;
      this.closedByUs = false;
    }
    connect() {
      var self = this;
      return new Promise(function (resolve, reject) {
        var ws;
        try { ws = new WebSocket(self.url); }
        catch (e) { reject(e); return; }
        self.ws = ws;
        ws.onmessage = function (ev) {
          var f = null;
          try { f = JSON.parse(ev.data); } catch (e) { return; }
          if (f && f.t === 'hello') resolve(self);       // the join landed
          self.onFrame(f);
        };
        ws.onclose = function () { if (!self.closedByUs) self.onClose(); };
        ws.onerror = function () { /* onclose follows */ };
      });
    }
    send(frame) {
      if (this.ws && this.ws.readyState === 1) {
        try { this.ws.send(JSON.stringify(frame)); return true; } catch (e) { return false; }
      }
      return false;
    }
    close() {
      this.closedByUs = true;
      if (this.ws) { try { this.ws.close(); } catch (e) {} }
      this.ws = null;
    }
  }

  // SharedDocSession — the client-side half of the room:
  //   THE CURSOR: the highest server seq this client's world reflects;
  //   THE BASELINE: the server-known doc + my un-acked ops (the diff
  //     seed — what saveNow diffs against, so remote-applied changes
  //     never echo back as my ops);
  //   THE PENDING LAW (Figma's optimistic rule): my un-acked op on
  //     (id, prop) beats an incoming remote value for that (id, prop)
  //     until my ack lands — no flicker, my edit is the best prediction;
  //   THE ACK IS THE BROADCAST: my own frames come back stamped —
  //     pending clears by opId, the cursor advances, nothing re-applies;
  //   RECONNECT: jittered ladder (0.5s→30s cap), re-join with the
  //     cursor, the room replays the gap;
  //   REBASE (the 409 law): a stale whole-state PUT demands the missed
  //     ops — apply them, then the next local save re-derives my
  //     un-acked diff on top (Figma's "reapply offline edits").
  // eslint-disable-next-line no-redeclare
  class SharedDocSession {
    constructor(deps) {
      this.canvas = deps.canvas;
      this.device = deps.device || ('dev_' + Math.random().toString(36).slice(2, 10));
      this.name = deps.name || this.device;
      this.api = deps.api;         // {postOps, fetchOps, fetchDoc, wsURL}
      this.adapter = deps.adapter; // {applyOp(op), getDoc(), onMembers(m), onPresence(p), onStatus(s)}
      this.codec = deps.codec || DoomCollab;
      this.opCounter = 0;
      this.cursor = 0;
      this.baseline = null;        // the server-known doc + my un-acked ops
      this.pending = [];           // my un-acked ops [{op, id, props}] (the skip-law index)
      this.pendingById = {};       // opId → op
      this.transport = null;
      this.backoff = 0;
      this.alive = true;
      this.adopted = false;
      var self = this;
      this._onDocStale = function (ev) {
        var d = ev && ev.detail;
        if (d && d.id === self.canvas) self.rebase();
      };
    }

    // activate(): fetch the current doc → adopt (cursor + baseline) →
    // catch-up the local world → submit any local drift → connect live.
    activate() {
      var self = this;
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('doomalay:doc-stale', this._onDocStale);
      }
      return this.api.fetchDoc(this.canvas).then(function (res) {
        self.cursor = res.seq || 0;
        self.baseline = self.codec.docOf({ icons: res.doc.icons, dots: res.doc.dots, currentFamily: res.doc.currentFamily, worldSize: res.doc.worldSize });
        self.adopted = true;
        // catch-up: the local world may lag the durable truth (a row read
        // older than the journal) — the gap, as ops, rides the same
        // apply path a live frame does (no pending skip: nothing pending).
        var local = self.adapter.getDoc();
        var catchup = self.codec.diffDocs(local, self.baseline, function () { return 'adopt:' + (++self.opCounter); });
        for (var i = 0; i < catchup.length; i++) self.adapter.applyOp(catchup[i]);
        // my own un-synced drift (local edits the server never saw):
        var drift = self.codec.diffDocs(self.baseline, local, function () { return self.device + ':' + (++self.opCounter); });
        if (drift.length) self.submit(drift);
        return self.connect();
      });
    }

    connect() {
      var self = this;
      if (!this.alive) return Promise.resolve(false);
      var t = new CollabTransport({
        url: this.api.wsURL(this.canvas, this.cursor, this.device, this.name),
        onFrame: function (f) { self.handleFrame(f); },
        onClose: function () { self.scheduleReconnect(); }
      });
      this.transport = t;
      return t.connect().then(function () {
        self.backoff = 0; // a clean hello resets the ladder
        return true;
      }).catch(function () {
        return false;
      });
    }

    scheduleReconnect() {
      var self = this;
      this.transport = null;
      if (!this.alive) return;
      // THE LADDER: 0.5s base, ×1.7, cap 30s, with 0-500ms jitter (the
      // thundering-herd antidote the research mandated)
      this.backoff = this.backoff ? Math.min(30000, Math.round(this.backoff * 1.7)) : 500;
      var wait = this.backoff + Math.round(Math.random() * 500);
      setTimeout(function () { self.connect(); }, wait);
    }

    // capture(state) — the saveNow seam: derive the doc diff vs the
    // baseline and submit it. The baseline takes my ops immediately
    // (optimistic — the world already holds them).
    capture(state) {
      if (!this.adopted) return;
      var next = this.codec.docOf(state);
      var ops = this.codec.diffDocs(this.baseline, next, (function (self) {
        return function () { return self.device + ':' + (++self.opCounter); };
      })(this));
      if (!ops.length) return;
      this.baseline = next;
      for (var i = 0; i < ops.length; i++) this.pending.push(ops[i]);
      this.submit(ops);
    }

    submit(ops) {
      var self = this;
      var frame = { t: 'ops', ops: ops };
      for (var i = 0; i < ops.length; i++) this.pendingById[ops[i].opId] = ops[i];
      if (this.transport && this.transport.send(frame)) return;
      // the HTTP dependency path (WS down / not yet joined)
      this.api.postOps(this.canvas, this.device, ops).then(function (res) {
        // the HTTP ack carries the stamps — the same walk as a WS ack
        for (var j = 0; j < (res.ops || []).length; j++) self.ackFrame(res.ops[j]);
      }).catch(function () { /* the next save re-derives; the rebase heals */ });
    }

    handleFrame(frame) {
      if (!frame || !frame.t) return;
      switch (frame.t) {
        case 'ops':
          for (var i = 0; i < (frame.ops || []).length; i++) this.incoming(frame.ops[i]);
          break;
        case 'members':
          if (this.adapter.onMembers) this.adapter.onMembers(frame.members || []);
          break;
        case 'presence':
          if (this.adapter.onPresence) this.adapter.onPresence(frame);
          break;
        case 'error':
          if (frame.code === 400 || frame.code === 413) {
            // my batch was refused (a validation/size wall) — the pending
            // entries clear and the next save re-derives from the baseline
            // minus the refused ops… the honest recovery is the rebase.
            this.rebase();
          }
          break;
        case 'hello':
        case 'pong':
        default:
          break;
      }
    }

    // incoming(frame) — ONE stamped op. MY ack: clear pending, advance,
    // never re-apply. THEIR op: apply the parts my pending doesn't cover
    // (the optimistic law), baseline takes the whole op (the server
    // truth), cursor advances.
    incoming(fr) {
      if (typeof fr.seq === 'number' && fr.seq > this.cursor) this.cursor = fr.seq;
      if (fr.opId && this.pendingById[fr.opId]) {
        delete this.pendingById[fr.opId];
        this.pending = this.pending.filter(function (p) { return p.opId !== fr.opId; });
        return;
      }
      // the pending skip-law: my un-acked (id, prop) wins
      var op = this.remoteWithoutPending(fr);
      if (op) this.adapter.applyOp(op);
      // the baseline takes the WHOLE remote op (server truth) even when
      // my world skipped covered props — my ack will overwrite them
      this.codec.applyOpToDoc(this.baseline, fr);
    }

    remoteWithoutPending(fr) {
      if (!this.pending.length) return fr;
      var kind = fr.kind;
      if (kind === 'icon.add' || kind === 'dot.add' || kind === 'doc.set') {
        var plane = kind === 'dot.add' ? 'dot' : 'icon';
        for (var i = 0; i < this.pending.length; i++) {
          var p = this.pending[i];
          if (p.kind === kind) {
            if (kind === 'doc.set' && p.path === fr.path) return null; // mine pending
            var mineId = p[plane] && p[plane].id;
            var theirId = fr[plane] && fr[plane].id;
            if (mineId && mineId === theirId) return null; // my add pending
          }
        }
        return fr;
      }
      if (kind === 'icon.set' || kind === 'dot.set') {
        var covered = {};
        var anyCovered = false;
        for (var j = 0; j < this.pending.length; j++) {
          var q = this.pending[j];
          if (q.kind === kind && q.id === fr.id && q.props) {
            for (var k in q.props) {
              if (Object.prototype.hasOwnProperty.call(q.props, k)) { covered[k] = true; anyCovered = true; }
            }
          }
          if (q.kind === (kind === 'icon.set' ? 'icon.add' : 'dot.add')) {
            var addId = q[kind === 'icon.set' ? 'icon' : 'dot'];
            if (addId && addId.id === fr.id) return null; // my add pending — the whole set is moot
          }
        }
        if (!anyCovered) return fr;
        var props = {};
        var kept = false;
        for (var f in (fr.props || {})) {
          if (Object.prototype.hasOwnProperty.call(fr.props, f) && !covered[f]) { props[f] = fr.props[f]; kept = true; }
        }
        if (!kept) return null;
        return { kind: kind, id: fr.id, props: props };
      }
      if (kind === 'icon.remove' || kind === 'dot.remove') {
        for (var r = 0; r < this.pending.length; r++) {
          if (this.pending[r].kind === kind && this.pending[r].id === fr.id) return null; // mine pending
        }
        return fr;
      }
      return fr;
    }

    ackFrame(fr) {
      if (typeof fr.seq === 'number' && fr.seq > this.cursor) this.cursor = fr.seq;
      if (fr.opId && this.pendingById[fr.opId]) {
        delete this.pendingById[fr.opId];
        this.pending = this.pending.filter(function (p) { return p.opId !== fr.opId; });
      }
    }

    // rebase(): a 409 stale-doc (or a refused batch) — pull the missed
    // ops, apply them (the pending skip-law holds), and let the next
    // local save re-derive my un-acked drift on top of the fresh truth.
    rebase() {
      var self = this;
      if (!this.adopted) return;
      this.api.fetchOps(this.canvas, this.cursor).then(function (res) {
        if (res.snapshot) {
          // the journal can't serve the gap — adopt the current doc whole
          return self.api.fetchDoc(self.canvas).then(function (doc) {
            self.cursor = doc.seq || self.cursor;
            var local = self.adapter.getDoc();
            var serverDoc = self.codec.docOf({ icons: doc.doc.icons, dots: doc.doc.dots, currentFamily: doc.doc.currentFamily, worldSize: doc.doc.worldSize });
            self.baseline = serverDoc;
            var catchup = self.codec.diffDocs(local, serverDoc, function () { return 'rebase:' + (++self.opCounter); });
            for (var i = 0; i < catchup.length; i++) self.adapter.applyOp(catchup[i]);
          });
        }
        var ops = res.ops || [];
        for (var k = 0; k < ops.length; k++) self.incoming(ops[k]);
      }).then(function () {
        // my pending is gone (the 409's ops superseded); the fresh save
        // re-derives any still-desired local change against the new baseline
        self.pending = [];
        self.pendingById = {};
        if (self.adapter.afterRebase) self.adapter.afterRebase();
      }).catch(function () { /* offline — the reconnect ladder owns the retry */ });
    }

    close() {
      this.alive = false;
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('doomalay:doc-stale', this._onDocStale);
      }
      if (this.transport) this.transport.close();
      this.transport = null;
    }
  }

  DoomCollab.CollabTransport = CollabTransport;
  DoomCollab.SharedDocSession = SharedDocSession;

  if (typeof window !== 'undefined') {
    window.DoomCollab = DoomCollab;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = DoomCollab;
  }
})();
