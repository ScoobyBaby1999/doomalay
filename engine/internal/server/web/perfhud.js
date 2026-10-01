// perfhud.js — v0.85.1 THE PERF HUD (renderer-path Phase 1, item one:
// "a perf HUD behind Settings (fps, frame ms, cache hit-rate, DOM node
// count, compositor layer count) so EVERY future claim is measured, not
// felt" — PLAN-V085 §A).
//
// THE INSTRUMENT (window.DoomalayPerf):
//   · display fps + frame ms (avg/max over the last 60 frames) — measured
//     by a rAF meter that runs ONLY while the HUD chip or the Performance
//     page is visible (a resting canvas reports 0 paints/s — the cheap-
//     frame discipline working, not a dead meter);
//   · long tasks (PerformanceObserver 'longtask', buffered, always on —
//     the main-thread jank counter: count + worst duration);
//   · canvas paints/s + atom frames/s — app.js increments the counters,
//     the HUD computes the rate over its sampling window;
//   · lattice cache hit-rate + paint batches — published per paint by
//     app.js (the v0.85.1 batcher's own twin);
//   · DOM node count + compositor-layer ESTIMATE (icons + promoted chrome
//     — labeled est., there is no layer-count API) — sampled every 2s.
//
// THE SURFACE:
//   · a Settings 'Performance' page (read-only meters, live-updating value
//     spans — no full rerender per tick, inputs never flicker);
//   · the HUD toggle (settings key perfHud, default false): a tiny fixed
//     chip (theme tokens only) with fps + frame ms, 2 updates/s.
//
// v0.85.2/.3 extend this page in place: the Painter row (worker/main) and
// the World layer row (pixi/dom) append below — the page renders whatever
// window.DoomalayPerf carries, missing rows simply don't render.
//
// Exposes: window.DoomalayPerf, window.PerfHUD = { page, setHud, tick }
(function () {
  'use strict';

  var P = {
    fps: 0, frameMs: 0, frameMsMax: 0,
    longTasks: 0, longTaskWorst: 0,
    paints: 0, atomFrames: 0,          // lifetime counters (app.js bumps)
    lastPaints: 0, lastAtomFrames: 0, paintRate: 0, atomRate: 0,
    cacheHits: 0, cacheMisses: 0,      // lifetime (app.js bumps)
    batches: 0, buckets: 0, paintMs: 0,
    nodes: 0, layers: 0,
    painter: '', world: '',            // v0.85.2/.3 fill these
    watchers: 0, hudOn: false          // v0.88: the honest instrument — the
                                       // meter's refcount + chip state (the
                                       // rig proves setHud's idempotence)
  };
  window.DoomalayPerf = P;

  // ── the long-task observer (always on — the jank ledger) ──────────
  try {
    if (typeof PerformanceObserver === 'function') {
      var po = new PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          P.longTasks++;
          if (es[i].duration > P.longTaskWorst) P.longTaskWorst = es[i].duration;
        }
      });
      po.observe({ type: 'longtask', buffered: true });
    }
  } catch (e) { /* older WebViews: no longtask support — the counter stays 0 */ }

  // ── the rAF meter (runs only while something watches) ─────────────
  var meterRAF = 0, lastT = 0, frames = 0, msSum = 0;
  var watchers = 0;   // HUD chip + perf page each hold a watch
  function meterLoop(t) {
    if (lastT) {
      var d = t - lastT;
      if (d > 0 && d < 1000) {          // ignore tab-hidden gaps
        frames++; msSum += d;
        if (d > P.frameMsMax) P.frameMsMax = d;
      }
    }
    lastT = t;
    if (watchers > 0) meterRAF = requestAnimationFrame(meterLoop);
    else meterRAF = 0;
  }
  function watch(on) {
    watchers = Math.max(0, watchers + (on ? 1 : -1));
    P.watchers = watchers;             // v0.88: the honest instrument
    if (watchers > 0 && !meterRAF) {
      lastT = 0; frames = 0; msSum = 0; P.frameMsMax = 0;
      meterRAF = requestAnimationFrame(meterLoop);
    } else if (watchers === 0 && meterRAF) {
      cancelAnimationFrame(meterRAF); meterRAF = 0;
    }
  }

  // ── the periodic sampler (rates + nodes/layers; 500ms cadence) ────
  var sampler = 0;
  function sample() {
    var now = performance.now();
    // rates over the window since the last sample
    var dp = P.paints - P.lastPaints, da = P.atomFrames - P.lastAtomFrames;
    var win = (now - (sample.last || now - 500)) / 1000;
    if (win > 0.05) {
      P.paintRate = Math.round(dp / win);
      P.atomRate = Math.round(da / win);
    }
    P.lastPaints = P.paints; P.lastAtomFrames = P.atomFrames;
    sample.last = now;
    // the rolling fps + frame ms over the last window
    if (frames > 0) {
      P.fps = Math.round(frames / Math.max(0.001, (now - (sample.fpsT || now - 500)) / 1000));
      P.frameMs = Math.round((msSum / frames) * 10) / 10;
      frames = 0; msSum = 0; sample.fpsT = now;
    }
    // nodes + est. layers (only while someone watches — a full-tree walk)
    if (watchers > 0) {
      try {
        P.nodes = document.querySelectorAll('*').length;
        var bots = document.querySelectorAll('.chatbot').length;
        P.layers = bots + document.querySelectorAll(
          '#chat-panel.open, .chatbot.dragging, #menu:not(.hidden)').length;
      } catch (e) {}
    }
  }

  // ── the HUD chip ───────────────────────────────────────────────────
  var chip = null;
  function ensureChip() {
    if (chip) return chip;
    chip = document.createElement('div');
    chip.id = 'perf-hud-chip';
    chip.setAttribute('aria-hidden', 'true');
    // v0.88: the chip's textContent rewrites are COSMETIC to the
    // projection painter (2/s) — flag it so the theme observer's
    // childList filter skips them (each used to trigger a FULL paint).
    chip.__projCosmetic = true;
    document.body.appendChild(chip);
    return chip;
  }
  var lastChipTxt = '';
  function paintChip() {
    if (!chip) return;
    var fpsTxt = P.paints > 0 || P.paintRate > 0
      ? (P.fps + ' fps · ' + P.frameMs + ' ms')
      : (P.fps + ' fps · canvas resting');
    var txt = fpsTxt + ' · ' + P.paintRate + ' paints/s';
    if (txt === lastChipTxt) return;   // v0.88: value-change gate — identical text writes nothing
    lastChipTxt = txt;
    chip.textContent = txt;
  }
  // v0.88: setHud is IDEMPOTENT — the boot listener + the settings
  // onChange listener both call it, and the old non-idempotent version
  // incremented the watch() refcount PER SETTINGS EVENT (the watcher
  // leak: the meter never stopped, and every color-drag event ran
  // sample() + a chip write + the observer paint on top).
  var hudOn = false;
  function setHud(on) {
    on = !!on;
    if (on === hudOn && (on ? !!chip : true)) return;
    hudOn = on;
    P.hudOn = on;                      // v0.88: the honest instrument
    if (on) {
      ensureChip();
      chip.classList.add('on');
      watch(true);
      if (!sampler) { sampler = setInterval(sample, 500); sample.last = performance.now(); sample.fpsT = sample.last; }
      sample();
      paintChip();
    } else {
      if (chip) chip.classList.remove('on');
      watch(false);
      maybeStopSampler();
    }
  }
  function maybeStopSampler() {
    if (watchers === 0 && sampler) {
      // keep the sampler only if the perf page is open (its own watch)
      if (!pageOpen) { clearInterval(sampler); sampler = 0; }
    }
  }

  // ── the Settings page ──────────────────────────────────────────────
  var pageOpen = false, pageTimer = 0;
  function row(id, label, hint) {
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-2)">' + label +
        (hint ? ' <span style="color:var(--text-3-dim)">· ' + hint + '</span>' : '') + '</span>' +
      '<span id="' + id + '" style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-1);font-variant-numeric:tabular-nums;white-space:nowrap">—</span></div>';
  }
  function pageRender(getState, setState) {
    var s = getState();
    setTimeout(function () { pageOpen = true; watch(true);
      if (!sampler) { sampler = setInterval(sample, 500); sample.last = performance.now(); sample.fpsT = sample.last; }
      refreshPage();
    }, 0);
    return (
      '<div style="padding:2px 0 8px">' +
      row('pf-fps', 'Display fps', 'rAF meter') +
      row('pf-ms', 'Frame ms', 'avg / worst') +
      row('pf-lt', 'Long tasks', '>50ms on the main thread') +
      row('pf-paints', 'Canvas paints', 'lattice frames per second') +
      row('pf-atoms', 'Atom frames', 'star-layer frames per second') +
      row('pf-cache', 'Lattice cache', 'hit-rate') +
      row('pf-batches', 'Paint batches', 'buckets → fills per frame') +
      row('pf-nodes', 'DOM nodes', '') +
      row('pf-layers', 'Est. layers', 'icons + promoted chrome') +
      (P.painter ? row('pf-painter', 'Painter', 'the canvas owner') : '') +
      (P.world ? row('pf-world', 'World layer', 'icons renderer') : '') +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:10px;padding:10px 2px;cursor:pointer">' +
        '<input type="checkbox" data-setting-key="perfHud" ' + (s.perfHud ? 'checked' : '') + ' style="accent-color:var(--accent);width:16px;height:16px">' +
        '<span style="font-size:var(--ui-small-fs);color:var(--text-1)">Show the perf HUD chip on the canvas</span>' +
      '</label>' +
      // v0.85.4: the renderer-path controls — the world layer gate (live:
      // auto/on/off) + the paint worker toggle (boot-time — a change
      // reloads so the canvas transfer settles cleanly).
      '<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;flex-wrap:wrap">' +
        '<span style="font-size:var(--ui-small-fs);color:var(--text-1)">World layer (icons as GPU sprites)</span>' +
        '<select data-setting-key="worldLayer" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:4px 8px;border-radius:6px;font-size:var(--ui-small-fs);font-family:inherit">' +
          '<option value="auto"' + (s.worldLayer === 'auto' ? ' selected' : '') + '>auto (≥ 60 chats)</option>' +
          '<option value="on"' + (s.worldLayer === 'on' ? ' selected' : '') + '>always on</option>' +
          '<option value="off"' + (s.worldLayer === 'off' ? ' selected' : '') + '>off (dom icons)</option>' +
        '</select>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:10px;padding:8px 2px;cursor:pointer">' +
        '<input type="checkbox" id="pf-worker" ' + (s.workerPaint ? 'checked' : '') + ' style="accent-color:var(--accent);width:16px;height:16px">' +
        '<span style="font-size:var(--ui-small-fs);color:var(--text-1)">Paint the grid in a worker <span style="color:var(--text-3-dim)">(applies on reload)</span></span>' +
      '</label>' +
      '<p style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim);margin:8px 0 0;line-height:1.45">' +
        'The chip and this page are the honest instruments — every perf claim is measured here, never felt. ' +
        'A resting canvas paints 0 frames per second by design (the cheap-frame discipline); fps counts display frames while a meter is watching.</p>'
    );
  }
  function refreshPage() {
    if (pageTimer) { clearTimeout(pageTimer); pageTimer = 0; }
    // the settings tab switched away (or the panel closed) — pf-fps is
    // the page's own span; gone → stop the loop + release the watch
    if (!document.getElementById('pf-fps')) {
      if (pageOpen) { pageOpen = false; watch(false); maybeStopSampler(); }
      return;
    }
    var doc = document;
    function set(id, txt) {
      var el = doc.getElementById(id);
      if (el) {
        if (el.textContent !== txt) el.textContent = txt;   // v0.88: value-change gate
        if (!el.__projCosmetic) el.__projCosmetic = true;   // v0.88: cosmetic to the projection painter
      }
    }
    set('pf-fps', P.fps || '—');
    set('pf-ms', P.frameMs ? (P.frameMs + ' / ' + Math.round(P.frameMsMax) ) : '—');
    set('pf-lt', P.longTasks + (P.longTaskWorst ? ' · worst ' + Math.round(P.longTaskWorst) + 'ms' : ''));
    set('pf-paints', P.paintRate + '/s');
    set('pf-atoms', P.atomRate + '/s');
    var tot = P.cacheHits + P.cacheMisses;
    set('pf-cache', tot ? (Math.round(100 * P.cacheHits / tot) + '% · ' + tot + ' ops') : '—');
    set('pf-batches', P.batches + ' fills · ' + P.buckets + ' buckets');
    set('pf-nodes', P.nodes || '—');
    set('pf-layers', (P.layers || '—') + ' est.');
    if (doc.getElementById('pf-painter')) set('pf-painter', P.painter || 'main thread');
    if (doc.getElementById('pf-world')) set('pf-world', P.world || 'dom icons');
    if (pageOpen) pageTimer = setTimeout(refreshPage, 1000);
  }
  // the panel body swap ends the page — the span check self-heals, this
  // just stops the timer promptly (MutationObserver-free, cheap)
  document.addEventListener('doomalay:panel-closed', function () { pageOpen = false; watch(false); maybeStopSampler(); });
  try {
    window.addEventListener('beforeunload', function () { pageOpen = false; });
  } catch (e) {}

  function onPageHidden() { pageOpen = false; watch(false); maybeStopSampler(); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') onPageHidden();
  });

  // ── boot: the settings key + the page + the chip if enabled ────────
  function boot() {
    if (window.Settings && window.Settings.registerPage) {
      window.Settings.registerPage('performance', {
        title: 'Performance',
        icon: '📈',
        render: pageRender
      });
      // the page-open watcher rides the settings panel's open (the render
      // IS the mount hook — appearance.js's pattern)
    }
    applySetting();
    window.Settings.onChange(function (st) {
      // v0.88: the VALUE-CHANGE GATE — perfHud untouched means no
      // re-entry (the old listener re-ran setHud per settings event,
      // leaking a watch() ref each time).
      if (st && typeof st.perfHud !== 'undefined' && !!st.perfHud !== hudOn) applySetting(st);
    });
    // v0.85.2: the paint-worker toggle lives HERE (not data-setting-key —
    // a change needs a reload for the canvas transfer to settle, so it
    // commits the setting + reloads on a confirm-free 300ms grace)
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (el && el.id === 'pf-worker') {
        window.Settings.setState({ workerPaint: !!el.checked });
        setTimeout(function () { try { location.reload(); } catch (err) {} }, 300);
      }
    });
    // v0.85.4: the world row lights up once the layer reports itself
    try { if (window.DoomalayPerf && !window.DoomalayPerf.world) window.DoomalayPerf.world = 'dom icons'; } catch (e) {}
  }
  function applySetting(st) {
    var s = st || (window.Settings && window.Settings.getState()) || {};
    setHud(!!s.perfHud);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();

  window.PerfHUD = {
    setHud: setHud,
    // the rig hook: force one sample + read (the honest instrument)
    sample: function () { sample(); return P; }
  };
})();
