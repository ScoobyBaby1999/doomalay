// holes.js — v1.42.6 THE SINGULARITY (PLAN-V142 §3.3 W3): black holes
// are simple two-way portals. One mode, one job: fall through. A hole
// holds a REFERENCE to another canvas, exactly like a browser tab
// holds a URL — no attractor mode, no gravity, no caps (REV 2).
//
// THE PAIR LAW: creating a portal A→B atomically ensures the return
// portal exists in B (auto-created at the target's arrival point, one
// shared pairId). Deleting a world leaves its inbound holes "lost" —
// a re-target state, never a crash. Cycles are fine (A→B→A is two
// hops); refs need no containment logic.
//
// THE TRANSITION (the user's spec): DIVE (press → the camera zooms
// INTO the portal, ease-in ~700ms; any canvas gesture CANCELS — ease
// back, nothing swapped) → SWAP (under the veil: the normal switchTo
// — v1.42.5's ONE path; a failure zooms back + toasts) → EMERGE (zoom
// OUT from the paired hole ~700ms to the target's saved camera).
//
// THE BUDGET LAW: a hole at rest is a STATIC DOM icon (a themed CSS
// ring — zero per-frame JS, zero canvas passes; the plan's "baked
// sprites only" is about avoiding per-frame filters — a static ring is
// cheaper still). stepPortalTransition is a 2-line early-out when
// idle. The veil is a themed DOM overlay.
//
// Theme law: zero literal colors — everything composes from var(--…).
//
// Exposes: window.Holes = { createPair, openPanel, transition, probe,
// isTransitioning } (app.js consumes; the rigs probe).
(function () {
  'use strict';

  // ── the entity ───────────────────────────────────────────────────

  var STYLES = ['solid', 'twin', 'halo'];        // the ring styles
  var PALETTES = ['accent', 'ok', 'warn'];       // theme-token palettes

  function ringCSS(style, palette) {
    // the palette maps to themed color vars — never a literal
    var c = 'var(--' + palette + ')';
    var rgb = 'var(--' + palette + '-rgb)';
    if (style === 'twin') {
      return 'background:radial-gradient(circle at 50% 50%, var(--surface-1) 0 26%, rgba(' + rgb + ',0.05) 27% 38%, rgba(' + rgb + ',0.35) 39% 46%, var(--field-canvas) 47% 100%);' +
        'border:2px solid ' + c + ';' +
        'box-shadow:0 0 0 3px rgba(' + rgb + ',0.18), inset 0 0 18px rgba(' + rgb + ',0.25);';
    }
    if (style === 'halo') {
      return 'background:radial-gradient(circle at 50% 50%, var(--field-canvas) 0 30%, var(--surface-1) 31% 44%, rgba(' + rgb + ',0.3) 45% 52%, transparent 53% 100%);' +
        'border:2px solid rgba(' + rgb + ',0.55);' +
        'box-shadow:0 0 14px rgba(' + rgb + ',0.4);';
    }
    return 'background:radial-gradient(circle at 50% 50%, var(--field-canvas) 0 40%, var(--surface-1) 41% 62%, rgba(' + rgb + ',0.45) 63% 78%, var(--surface-2) 79% 100%);' +
      'border:2px solid ' + c + ';';
  }

  // the ChatIcon pattern (chatbot.js:19,73): ES6 extends — a class
  // constructor cannot be .call()ed; the first rig run convicted the
  // .call() shape ("Class constructor cannot be invoked without 'new'")
  var GridIconClass = window.GridIcon.GridIcon;
  class HoleIcon extends GridIconClass {
    constructor(d) {
      d = d || {};
      super({ id: d.id, type: 'hole', x: d.x, y: d.y, radius: d.radius || 30 });
      this.targetWorldId = d.targetWorldId || '';
      this.pairId = d.pairId || '';
      this.label = d.label || '';
      this.holeStyle = STYLES.indexOf(d.holeStyle) >= 0 ? d.holeStyle : 'solid';
      this.holePalette = PALETTES.indexOf(d.holePalette) >= 0 ? d.holePalette : 'accent';
      this.lost = false;      // set live: the target row is gone (render + refuse)
      this._renderHole();
    }
    _renderHole() {
    var el = this.el;
    el.innerHTML = '';
    var ring = document.createElement('div');
    ring.className = 'hole-ring';
    var size = Math.round((this.radius || 30) * 2);
    ring.setAttribute('style',
      'width:' + size + 'px;height:' + size + 'px;border-radius:50%;flex:none;position:relative;transition:opacity 0.2s;' +
      (this.lost ? 'opacity:0.35;' : '') + ringCSS(this.holeStyle, this.holePalette));
    el.appendChild(ring);
    // the label: the hole's name under the ring (the .chatbot class's
    // name styles — the shared icon chrome)
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = this.label || 'portal';
    if (this.lost) name.textContent = (this.label ? this.label + ' ' : '') + '· lost';
    el.appendChild(name);
  };
    setLost(lost) {
    if (this.lost === !!lost) return;
    this.lost = !!lost;
    this._renderHole();
  };
    serialize() {
    var base = super.serialize();
    base.targetWorldId = this.targetWorldId;
    base.pairId = this.pairId;
    base.label = this.label;
    base.holeStyle = this.holeStyle;
    base.holePalette = this.holePalette;
    return base;
  };
    getPanelTitle() { return this.label || 'Portal'; };
    getPanelSubtitle() {
    return this.lost ? 'the target world is gone' : 'a way through';
  };
    getAvatarHTML() {
    return '<span style="display:inline-block;width:22px;height:22px;border-radius:50%;' + ringCSS(this.holeStyle, this.holePalette) + '"></span>';
  };
    getPanelBodyHTML() {
    // the static shell — the live wiring rides openPanel()
    return '<div id="hole-panel" style="padding:16px;display:flex;flex-direction:column;gap:14px">' +
      '<div id="hole-body">…</div>' +
      '</div>';
  };
    static deserialize(data) { return new HoleIcon(data); }
  }

  if (window.GridIcon && window.GridIcon.register) {
    window.GridIcon.register('hole', function (data) { return HoleIcon.deserialize(data); });
  }

  // ── helpers ──────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status);
      return r.json();
    });
  }
  function activeId() {
    return (window.Worlds && window.Worlds.activeId) ? window.Worlds.activeId() : 'default';
  }
  function toast(txt) {
    if (window.Artifacts && window.Artifacts.toast) { try { window.Artifacts.toast(txt); } catch (e) {} }
    else console.log('holes: ' + txt);
  }

  // holeIcons() — the live world's holes (the lost-heal + the probe)
  function holeIcons(world) {
    var w = world || (window.doomalay && window.doomalay.world);
    var out = [];
    if (!w || !w.entities) return out;
    for (var i = 0; i < w.entities.length; i++) {
      if (w.entities[i].type === 'hole') out.push(w.entities[i]);
    }
    return out;
  }

  // healLost() — on restore/switch: mark holes whose target row is gone
  // (cheap: one list fetch per call, boot + switch only — never per-frame)
  var knownIds = null;
  function healLost() {
    if (!(window.Worlds && window.Worlds.CanvasStore)) return Promise.resolve(0);
    return window.Worlds.CanvasStore.list().then(function (rows) {
      knownIds = {};
      for (var i = 0; i < rows.length; i++) knownIds[rows[i].id] = true;
      var holes = holeIcons();
      var nLost = 0;
      for (var j = 0; j < holes.length; j++) {
        var lost = !(holes[j].targetWorldId && knownIds[holes[j].targetWorldId]);
        if (lost) nLost++;
        holes[j].setLost(lost);
      }
      return nLost;
    }).catch(function () { return 0; });
  }

  // ── the pair law ─────────────────────────────────────────────────

  // createPair(at, targetWorldId, label) — the local hole appears at
  // `at` (world point); the RETURN hole lands in the target's row at
  // its saved camera center (the arrival point), same pairId. Both
  // rows PUT their new state. Re-target law: if a pair already links
  // the two worlds, it is refreshed (no duplicate holes).
  function genId() { return 'hole_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1000); }

  function createPair(at, targetWorldId, label) {
    var from = activeId();
    if (!targetWorldId || targetWorldId === from) return Promise.reject(new Error('a portal needs a different world'));
    var pairId = 'pair_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1000);
    var mine = new HoleIcon({ x: at.x, y: at.y, targetWorldId: targetWorldId, pairId: pairId, label: label || '' });
    // 1. the local hole (the live world — app.js owns add/save)
    if (window.doomalay && window.doomalay.addEntity) window.doomalay.addEntity(mine);
    if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
    // 2. the return hole in the target's row (GET → append at its saved
    //    camera center → PUT; single-user engine, sequential is atomic
    //    enough — a torn PUT heals at the next save)
    return api('GET', '/api/canvases/' + encodeURIComponent(targetWorldId)).then(function (d) {
      var st = d && d.canvas && d.canvas.state;
      if (!st || typeof st !== 'object') st = { icons: [], dots: [], savedAt: Date.now(), offset: { x: 0, y: 0 }, scale: 1 };
      if (!Array.isArray(st.icons)) st.icons = [];
      // the arrival point: the target's saved camera center (world coords)
      // — screen = (world − offset) × scale, so world = offset + screen/scale
      // (the first walk convicted the stray *2: the hole landed at exactly
      // ¼ of the viewport, half of half)
      var cx = ((st.offset && st.offset.x) || 0) + (window.innerWidth || 800) / 2 / (st.scale || 1);
      var cy = ((st.offset && st.offset.y) || 0) + (window.innerHeight || 600) / 2 / (st.scale || 1);
      var back = new HoleIcon({ x: cx, y: cy, targetWorldId: from, pairId: pairId, label: label || '' });
      st.icons.push(back.serialize());
      st.savedAt = Date.now();
      return api('PUT', '/api/canvases/' + encodeURIComponent(targetWorldId), { state: st });
    }).then(function () {
      return { ok: true, pairId: pairId, hole: mine };
    }).catch(function (e) {
      // the honest failure: the local hole DIES (a one-way door is a
      // wall with a handle — better to refuse the whole pair)
      if (window.doomalay && window.doomalay.removeEntity) { try { window.doomalay.removeEntity(mine); } catch (e2) {} }
      if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
      throw e;
    });
  }

  // deletePair(pairId) — BOTH holes die: the local one live, the far
  // one from its row's state.
  function deletePair(pairId) {
    var local = holeIcons().filter(function (h) { return h.pairId === pairId; });
    local.forEach(function (h) {
      if (window.doomalay && window.doomalay.removeEntity) { try { window.doomalay.removeEntity(h); } catch (e) {} }
    });
    if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
    // the far holes: scan every other row for the pairId
    if (!(window.Worlds && window.Worlds.CanvasStore)) return Promise.resolve(true);
    return window.Worlds.CanvasStore.list().then(function (rows) {
      var chain = Promise.resolve();
      rows.forEach(function (row) {
        if (row.id === activeId()) return;
        chain = chain.then(function () {
          return api('GET', '/api/canvases/' + encodeURIComponent(row.id)).then(function (d) {
            var st = d && d.canvas && d.canvas.state;
            if (!st || !Array.isArray(st.icons)) return;
            var before = st.icons.length;
            st.icons = st.icons.filter(function (ic) { return !(ic && ic.type === 'hole' && ic.pairId === pairId); });
            if (st.icons.length === before) return;
            st.savedAt = Date.now();
            return api('PUT', '/api/canvases/' + encodeURIComponent(row.id), { state: st });
          }).catch(function () {});
        });
      });
      return chain.then(function () { return true; });
    });
  }

  // ── the panel ────────────────────────────────────────────────────

  var currentHole = null;
  var panelHost = null;   // app.js's panel instance (passed at open)
  function openPanel(icon, host) {
    currentHole = icon;
    panelHost = host || panelHost;
    if (!panelHost) return;
    panelHost.open({
      title: icon.getPanelTitle(),
      subtitle: icon.getPanelSubtitle(),
      avatarHTML: icon.getAvatarHTML(),
      bodyHTML: icon.getPanelBodyHTML(),
      context: icon
    });
    wirePanel(panelHost.bodyEl, icon);
  }

  function wirePanel(bodyEl, icon) {
    var host = bodyEl.querySelector('#hole-body');
    if (!host) return;
    var lost = icon.lost;
    function paint(msg) {
      var palettes = PALETTES.map(function (p) {
        return '<button data-pal="' + p + '" style="width:26px;height:26px;border-radius:50%;border:2px solid ' + (icon.holePalette === p ? 'var(--text-1)' : 'var(--border)') + ';background:var(--' + p + ');cursor:pointer"></button>';
      }).join('');
      var styles = STYLES.map(function (s) {
        return '<button data-sty="' + s + '" style="background:var(--surface-2);color:' + (icon.holeStyle === s ? 'var(--accent)' : 'var(--text-2)') + ';border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:var(--ui-small-fs);cursor:pointer">' + s + '</button>';
      }).join('');
      host.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<label style="display:flex;flex-direction:column;gap:6px;color:var(--text-2);font-size:var(--ui-small-fs)">' +
          'name<input id="hole-name" value="' + esc(icon.label) + '" maxlength="40" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--text-1);padding:8px 10px;font-size:var(--ui-small-fs)" />' +
        '</label>' +
        '<div style="display:flex;align-items:center;gap:10px"><span style="color:var(--text-2);font-size:var(--ui-small-fs)">ring</span>' + palettes + '</div>' +
        '<div style="display:flex;align-items:center;gap:10px"><span style="color:var(--text-2);font-size:var(--ui-small-fs)">style</span>' + styles + '</div>' +
        '<button id="hole-dive" style="background:rgba(var(--accent-rgb),0.14);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.32);border-radius:10px;padding:12px 14px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer">' +
          (lost ? 'the target world is gone' : '⤓ fall through') + '</button>' +
        '<div id="hole-retarget" style="color:var(--text-3);font-size:var(--ui-tiny-fs)"></div>' +
        '<button id="hole-del" style="background:rgba(var(--warn-rgb),0.14);color:var(--text-1);border:1px solid var(--border);border-radius:10px;padding:10px 14px;font-size:var(--ui-small-fs);cursor:pointer">delete the pair (both sides)</button>' +
        (msg ? '<div style="color:var(--text-3);font-size:var(--ui-tiny-fs)">' + esc(msg) + '</div>' : '') +
        '</div>';
      // the retarget list (every OTHER world)
      if (window.Worlds && window.Worlds.CanvasStore) {
        window.Worlds.CanvasStore.list().then(function (rows) {
          var rt = host.querySelector('#hole-retarget');
          if (!rt) return;
          var others = rows.filter(function (r) { return r.id !== activeId(); });
          // v1.42.7 THE MANAGER: the map behind the quick buttons — the
          // worlds overlay opened in portal context (tap a world there =
          // re-target + fall through; the create row wires a fresh pair).
          var mapBtn = (window.WorldsManager)
            ? '<button id="hole-wm" style="display:block;width:100%;margin-top:6px;background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font-size:var(--ui-tiny-fs);cursor:pointer">⊞ all worlds…</button>'
            : '';
          if (!others.length) {
            rt.innerHTML = mapBtn;
          } else {
            rt.innerHTML = 're-target: ' + others.map(function (r) {
              return '<button data-rt="' + esc(r.id) + '" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);border-radius:8px;padding:5px 9px;font-size:var(--ui-tiny-fs);cursor:pointer;margin:2px">' + esc(r.name || r.id) + '</button>';
            }).join('') + mapBtn;
          }
          var wm = rt.querySelector('#hole-wm');
          if (wm) wm.addEventListener('click', function () {
            if (window.WorldsManager) window.WorldsManager.open({ fromPortal: icon });
          });
          others.forEach(function (r) {
            var b = rt.querySelector('[data-rt="' + r.id + '"]');
            if (b) b.addEventListener('click', function () {
              // re-target = delete the old pair + create the new one here
              var oldPair = icon.pairId;
              deletePair(oldPair).then(function () {
                return createPair({ x: icon.x, y: icon.y }, r.id, icon.label);
              }).then(function (res) {
                toast('re-targeted');
                if (panelHost && panelHost.close) panelHost.close();
                void res;
              }).catch(function (e) { paint('re-target failed — ' + (e && e.message)); });
            });
          });
        }).catch(function () {});
      }
      var nameIn = host.querySelector('#hole-name');
      if (nameIn) nameIn.addEventListener('change', function () {
        icon.label = (nameIn.value || '').trim();
        icon._renderHole();
        if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
      });
      host.querySelectorAll('[data-pal]').forEach(function (b) {
        b.addEventListener('click', function () {
          icon.holePalette = b.getAttribute('data-pal');
          icon._renderHole();
          if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
          paint();
        });
      });
      host.querySelectorAll('[data-sty]').forEach(function (b) {
        b.addEventListener('click', function () {
          icon.holeStyle = b.getAttribute('data-sty');
          icon._renderHole();
          if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
          paint();
        });
      });
      var dive = host.querySelector('#hole-dive');
      if (dive) dive.addEventListener('click', function () {
        if (lost) { paint('pick a new target below — or delete the pair'); return; }
        if (panelHost && panelHost.close) panelHost.close();
        transition(icon);
      });
      var del = host.querySelector('#hole-del');
      if (del) del.addEventListener('click', function () {
        deletePair(icon.pairId).then(function () {
          toast('the pair is gone');
          if (panelHost && panelHost.close) panelHost.close();
        });
      });
    }
    paint();
  }

  // ── the transition (the user's spec) ─────────────────────────────

  // the camera math rides app.js's own pipeline: we WRITE offsetX/
  // offsetY/scale through window.doomalay's camera hooks; the veil is
  // a themed DOM overlay. step() is called from app.js's tick.
  var T = {
    phase: 'idle',        // idle | dive | swap | emerge | cancel
    hole: null,           // the dive's hole
    t0: 0,
    origX: 0, origY: 0, origS: 1,   // the PRE-DIVE camera (the cancel's destination — never overwritten)
    fromX: 0, fromY: 0, fromS: 1,
    toX: 0, toY: 0, toS: 1,
    targetId: '',
    veil: null
  };
  var DIVE_MS = 700, EMERGE_MS = 700, CANCEL_MS = 260;
  // the dive's max zoom: enough that the ring consumes the view
  var DIVE_SCALE = 14;

  function ensureVeil() {
    // the STATIC #hole-veil (index.html — the B1 discipline: no body
    // appenders; the overlay is born in the document like #menu). If a
    // host lacks it the veil is simply skipped (the transition still
    // runs — never a crash, never an appender).
    if (T.veil && document.getElementById('hole-veil')) return T.veil;
    var v = document.getElementById('hole-veil');
    if (!v) return null;
    v.style.background = 'radial-gradient(circle at 50% 50%, var(--field-canvas) 0%, var(--field-canvas) 100%)';
    v.style.display = '';
    T.veil = v;
    return v;
  }
  function veilOpacity(o) {
    // pure per-frame writes — the step's own easing interpolates the
    // value; a CSS transition here would fight the rAF ramp.
    var v = ensureVeil();
    if (!v) return;
    if (o <= 0) { v.style.opacity = '0'; v.style.display = 'none'; return; }
    v.style.display = '';
    v.style.opacity = String(Math.max(0, Math.min(1, o)));
  }

  function cam() { return window.doomalay.cameraProbe(); }
  function setCam(x, y, s) {
    if (window.doomalay && window.doomalay.setCamera) window.doomalay.setCamera(x, y, s);
  }

  function transition(hole) {
    if (T.phase !== 'idle') return Promise.resolve({ ok: false, error: 'a transition is already in flight' });
    if (!hole || hole.type !== 'hole' || !hole.targetWorldId || hole.lost) {
      return Promise.resolve({ ok: false, error: 'this portal leads nowhere' });
    }
    var c = cam();
    T.phase = 'dive';
    T.hole = hole;
    T.t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    T.fromX = c.x; T.fromY = c.y; T.fromS = c.scale;
    T.origX = c.x; T.origY = c.y; T.origS = c.scale;   // the pre-dive home (the cancel's destination)
    // the dive's destination: the hole centered, deep-zoomed
    var w = window.innerWidth || 800, h = window.innerHeight || 600;
    // the dive's zoom: deep, but at the app's OWN cap (setCamera clamps
    // to MAX_SCALE — computing the destination at an uncapped 14× would
    // mis-center the hole at the capped zoom; the veil owns the rest of
    // the "aperture consumes the view" effect)
    T.toS = Math.min(c.scale * DIVE_SCALE, c.maxScale || c.scale * DIVE_SCALE);
    T.toX = hole.x - (w / 2) / T.toS;
    T.toY = hole.y - (h / 2) / T.toS;
    T.targetId = hole.targetWorldId;
    veilOpacity(0);
    if (window.doomalay && window.doomalay.startAnimation) window.doomalay.startAnimation();
    try { window.dispatchEvent(new CustomEvent('doomalay:portal-dive', { detail: { id: T.targetId, pairId: hole.pairId } })); } catch (e) {}
    return new Promise(function (resolve) { T._resolve = resolve; });
  }

  function cancelDive() {
    if (T.phase !== 'dive') return false;
    T.phase = 'cancel';
    T.t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    // fly from the CURRENT (mid-dive) camera BACK to the pre-dive home —
    // T.toX/T.toY/T.toS still aim at the hole; the cancel re-points them.
    var c = cam();
    T.fromX = c.x; T.fromY = c.y; T.fromS = c.scale;
    T.toX = T.origX; T.toY = T.origY; T.toS = T.origS;
    veilOpacity(0);
    return true;
  }

  // step(now) — app.js's tick calls this every frame; a 2-line early-out
  // when idle (the budget law: zero per-frame cost at rest).
  function step(now) {
    if (T.phase === 'idle') return false;
    var ease;
    if (T.phase === 'dive') {
      ease = Math.min(1, (now - T.t0) / DIVE_MS);
      var k = ease * ease;   // ease-in quad: slow start, the plunge
      setCam(T.fromX + (T.toX - T.fromX) * k, T.fromY + (T.toY - T.fromY) * k, T.fromS + (T.toS - T.fromS) * k);
      veilOpacity(Math.min(1, ease * 1.4));
      if (ease >= 1) {
        // SWAP under the veil (v1.42.5's ONE path)
        T.phase = 'swap';
        if (window.doomalay && window.doomalay.switchTo) {
          window.doomalay.switchTo(T.targetId).then(function (res) {
            if (!res || !res.ok) {
              // the graceful refusal: zoom back to the pre-dive home + the
              // honest toast (the current world SURVIVED — the teardown
              // never ran)
              T.phase = 'cancel';
              T.t0 = (window.performance && performance.now) ? performance.now() : Date.now();
              var c = cam();
              T.fromX = c.x; T.fromY = c.y; T.fromS = c.scale;
              T.toX = T.origX; T.toY = T.origY; T.toS = T.origS;
              veilOpacity(0);
              if (window.doomalay && window.doomalay.startAnimation) window.doomalay.startAnimation();   // re-pump (the swap parked the tick)
              toast('that world would not open — ' + ((res && res.error) || 'unknown'));
              return;
            }
            // EMERGE: from the RETURN hole (the pair's far side), zoom
            // out to the new world's saved camera
            var back = holeIcons().filter(function (h) { return h.pairId === T.hole.pairId; })[0];
            var c2 = cam();
            var w = window.innerWidth || 800, h2 = window.innerHeight || 600;
            var diveS = Math.min(c2.scale * DIVE_SCALE, c2.maxScale || c2.scale * DIVE_SCALE);
            T.phase = 'emerge';
            T.t0 = (window.performance && performance.now) ? performance.now() : Date.now();
            T.fromX = back ? (back.x - (w / 2) / diveS) : c2.x;
            T.fromY = back ? (back.y - (h2 / 2) / diveS) : c2.y;
            T.fromS = diveS;
            T.toX = c2.x; T.toY = c2.y; T.toS = c2.scale;
            setCam(T.fromX, T.fromY, T.fromS);
            veilOpacity(1);
            if (window.doomalay && window.doomalay.startAnimation) window.doomalay.startAnimation();   // the swap may have parked the tick — re-pump
            try { window.dispatchEvent(new CustomEvent('doomalay:portal-emerge', { detail: { id: T.targetId } })); } catch (e) {}
            healLost();
          });
        } else {
          T.phase = 'idle';
          veilOpacity(0);
        }
      }
      return true;
    }
    if (T.phase === 'emerge') {
      ease = Math.min(1, (now - T.t0) / EMERGE_MS);
      var k2 = 1 - Math.pow(1 - ease, 3);   // ease-out cubic: the arrival settles
      setCam(T.fromX + (T.toX - T.fromX) * k2, T.fromY + (T.toY - T.fromY) * k2, T.fromS + (T.toS - T.fromS) * k2);
      veilOpacity(1 - ease);
      if (ease >= 1) finishTransition({ ok: true, id: T.targetId });
      return true;
    }
    if (T.phase === 'cancel') {
      ease = Math.min(1, (now - T.t0) / CANCEL_MS);
      var k3 = 1 - Math.pow(1 - ease, 3);
      setCam(T.fromX + (T.toX - T.fromX) * k3, T.fromY + (T.toY - T.fromY) * k3, T.fromS + (T.toS - T.fromS) * k3);
      if (ease >= 1) finishTransition({ ok: false, canceled: true });
      return true;
    }
    return false;
  }
  function finishTransition(res) {
    veilOpacity(0);
    if (T.veil) { T.veil = null; }
    T.phase = 'idle';
    T.hole = null;
    if (window.doomalay && window.doomalay.saveNow) window.doomalay.saveNow();
    try { window.dispatchEvent(new CustomEvent('doomalay:portal-done', { detail: res })); } catch (e) {}
    if (T._resolve) { var r = T._resolve; T._resolve = null; r(res); }
  }

  // ── the exports ──────────────────────────────────────────────────

  // closeHostPanel() — v1.42.7 THE MANAGER's portal context closes the
  // hosting panel before the dive (the dive button's own law, exposed
  // for the manager's retarget+dive path).
  function closeHostPanel() {
    if (panelHost && panelHost.close) { try { panelHost.close(); } catch (e) {} }
  }

  window.Holes = {
    createPair: createPair,
    deletePair: deletePair,
    openPanel: openPanel,
    transition: transition,
    cancelDive: cancelDive,
    closeHostPanel: closeHostPanel,
    step: step,
    healLost: healLost,
    isTransitioning: function () { return T.phase !== 'idle'; },
    probe: function () {
      return {
        phase: T.phase,
        target: T.targetId || null,
        holes: holeIcons().map(function (h) {
          return { id: h.id, pair: h.pairId, target: h.targetWorldId, lost: h.lost, label: h.label };
        })
      };
    }
  };
})();
