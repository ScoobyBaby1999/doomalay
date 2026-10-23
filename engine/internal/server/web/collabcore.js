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

  if (typeof window !== 'undefined') {
    window.DoomCollab = DoomCollab;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = DoomCollab;
  }
})();
