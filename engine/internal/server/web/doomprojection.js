// doomprojection.js — v1.04.2 THE DOOM PROJECTION — THE RESTORE
// (PLAN-V104 §2; the user order: "the current doom projection system u
// built from scratch honestly is entirely broken. May we please instead
// import the one that was replaced previously, port it or re-implement
// it, and port it to use our new variables dictating all colors").
//
// THE RESTORE: this module is the PORT of the pre-v1.01.5 viewport
// projection painter (last alive at git 1fb19f7e, theme.js — retired by
// v1.01.5 THE LOCAL LIGHT, replaced by the broken v1.03.6 canvas
// projector, now restored). The variable names already match (the SEL
// walk's regex /var\(--[a-z0-9-]*gradient/ covers the v0.99.4 field
// twins: --surface-1-gradient + --accent-gradient/-2/-3), so the port
// is architectural, not a rename.
//
// ══ THE MODEL (the old system, whole) ══════════════════════════════
// ONE viewport-sized gradient FIELD per variable; every consumer is a
// WINDOW on it — same-variable elements render one continuous shared
// gradient (the doom projection the user described). The projection
// has two legs:
//   · OUTSIDE transformed roots: CSS `background-attachment: fixed`
//     does the projection NATIVELY (the DOOM SHEET below mints it).
//   · INSIDE transformed roots (the always-tall panel sheet, the
//     overlay card): fixed resolves against the transformed
//     ancestor's box (css-transforms' containing-block rule — "the
//     panel splits up into two gradients", the v1.01.5 root cause),
//     so THE PAINTER re-anchors every window BY HAND:
//       background-size: <viewport>px <viewport>px
//       background-position: calc(var(--proj-tx) + Bpx) …
//       background-attachment: scroll (element-relative, deterministic)
//     which is mathematically identical to a fixed attachment — the
//     element displays exactly the viewport region it covers — and is
//     immune to transforms (the v0.67 transform-proof painter).
//   · THE MOTION (Track 2, v0.94.3): each window's gradient rides a
//     generated ::before LAYER (its own compositor layer,
//     will-change:transform) whose per-frame compensation consumes the
//     same --proj-tx/--proj-ty vars — ONE CSSOM var write per root per
//     frame, ZERO repaints during the panel glide.
//
// ══ THE TOGGLE (the v1.03.6 switch stays) ══════════════════════════
// OFF (the default): the v1.01.5 LOCAL LIGHT — every gradient paints
// local (the element's own border-box), zero JS, the module inert.
// ON: the DOOM SHEET mints `html[data-doom-proj] <sel> {
// background-attachment: fixed }` for EVERY stylesheet rule whose
// background-image carries a var(--*-gradient) (the index.html static
// rules + the GATES' minted windows + the [style*=] catchers + the
// module-injected styles — derived from the sheets, never hand-
// listed), then the painter boots (collect + paint + observers).
// The sheet mints PLAIN (no !important): the painter's inline bake
// (`scroll`) must WIN on baked elements (inline beats any author
// rule) — the html[attr] prefix out-specifies every base rule it
// derives from, which is all it needs (the base rules never declare
// attachment post-v1.01.5; the icon chrome's explicit scroll rules
// paint derived solids, never gradient twins — the walk skips them).
//
// ══ THE PORT'S ADAPTATIONS (vs 1fb19f7e) ═══════════════════════════
//   · The root registry: '#chat-panel, #connect-overlay' — the
//     .hub-sheet/.tpl-sheet family is gone (the v1.02 library wave
//     rides the panel/overlay pages now).
//   · The toggle shell: setEnabled()/teardown() — the old painter was
//     always-on at boot; this port turns it on/off with the state.
//   · The DOOM SHEET: new (the old system's fixed attachments lived
//     hardcoded in index.html + the GATES mint; the toggle needs them
//     derived, hence the walk).
//   · The icon chrome (v0.92.1): structurally moot — the v0.99.4 model
//     paints it derived SOLIDS (surface-2/rgba — never gradient
//     windows), but the orbit-noise filter stays (defense in depth).
(function () {
  'use strict';

  // the tracked transformed roots — the scopes the painter re-anchors.
  // v1.04.2: the hub/tpl sheets are gone; the panel + the connect
  // overlay (the two overlay surfaces) are the whole set. A future
  // transformed container is a one-line add here.
  var ROOT_SEL = '#chat-panel, #connect-overlay';
  // our own sheets — the observer ignores their injections (no loops)
  // and the walks skip them (they mirror what the base rules already
  // carry). The GATES sheet (#doom-derived-gates, theme.js) is NOT ours:
  // its rules carry the accent windows — the mint MUST cover them (the
  // gates' re-derive calls DoomProjection.repaint() on its own).
  var OWN_SHEET_IDS = { 'doom-proj-vars': 1, 'proj-layer-styles': 1, 'doom-proj-override': 1 };
  // the projection gradient families — THE ALLOW-LIST (v1.06.1 THE
  // SURFACE EXEMPTION): the three accents are the projected FIELDS —
  // the surface is NOT (the user's call, v1.06.0 post-ship: "let's have
  // everything doom project but the surface as that variable
  // specifically causes a lot of lag"). The surface-1 windows were the
  // projection's biggest + most-rebaked population: the panel body and
  // the overlay card are viewport-sized fields whose fixed attachment
  // (mobile's expensive leg — the v107 research) re-rasters on every
  // scroll/motion true-up. Out of the allow-list they render their
  // gradients LOCAL (the v1.01.5 local-light look) in both toggle
  // states, and the painter never touches them — no sheet mint, no
  // bake, no layer. (The [data-s1-grad] chrome windows in index.html —
  // the settings gear, the dock capsule — were already LOCAL by design;
  // they are unchanged.) The fmt text track (--fmt-*-gradient) JOINED
  // the allow-list in v1.06.2 THE TEXT FIELD (the user: "text doesn't
  // seem to doom project at all either" — it was LOCAL BY DESIGN at
  // v1.00.2). Text rides the LEGACY inline bake inside the roots (clip:
  // text fails L2.ok by design — the layer's oversized ::before can't
  // clip to glyphs) and the native fixed mint outside them (the v107
  // Blink probe proves fixed + background-clip:text coexist). The
  // surface-2/border-strong/bg-app/accent-4 families remain DERIVED
  // SOLIDS post-v0.99.4 (their catchers reference the vars but the
  // twins are never written — minting them would pollute the sheet for
  // dead rules).
  var PROJ_RE = /var\(--(?:accent|accent-2|accent-3|fmt-[a-z0-9]+)-gradient/;
  var STYLE_RE = PROJ_RE;

  var SEL = null;             // the compiled projection selector
  var POS_SEL = null;         // the descendant-position matcher (v0.98 C1)
  var painted = [];           // elements carrying painter styles
  var rootReg = [];           // tracked transformed roots: {el, key, rule}
  var varSheet = null;        // the CSSOM sheet holding the per-root var rules
  var doomSheet = null;       // the DOOM SHEET (the fixed-attachment override)
  var rootSet = null;
  var nextKey = 0;
  var dirty = false, movingRoot = 0, movingLayout = 0, rafId = 0;
  var coasting = false;
  var memoEpoch = 0;
  var writeEpoch = 0;
  var paintStamp = 0;
  var trackedScrollers = [];
  var stats = { paints: 0, motions: 0, rebakes: 0, baked: 0, yielded: 0, coasts: 0, deferred: 0 };
  var on = false;
  var obs = null, gatesObs = null;

  // v1.06.3 THE AUTHOR'S HANDS BACK — the L2 suppression REPLACES the
  // element's own inline background (an inline style holds ONE value per
  // property): the metadata pills' tint + gradient twin were overwritten
  // at bake time, so no amount of drop-time cleanup could bring them
  // back — the pill baked white forever after. Saving the author's
  // values when the suppression lands and restoring them on drop/strip
  // keeps the pill's self-paint alive through every bake cycle (the
  // [style*=] catchers re-match; the white pill cannot return).
  function restoreAuthorBg(el) {
    var a = el.__projAuthorBg;
    if (!a) return;
    try {
      if (a.image) el.style.setProperty('background-image', a.image, a.ip || '');
      else el.style.removeProperty('background-image');
      if (a.color) el.style.setProperty('background-color', a.color, a.cp || '');
      else el.style.removeProperty('background-color');
    } catch (e) {}
    el.__projAuthorBg = null;
  }

  // ── the root registry: keys + one CSSOM rule per root ──────────
  // The vars are written through CSSOM (styleEl.sheet rules), NOT
  // inline on the root: CSSOM mutations bypass the MutationObserver,
  // so the painter never re-triggers itself.
  function ensureVarSheet() {
    if (varSheet && varSheet.isConnected) return;
    varSheet = document.createElement('style');
    varSheet.id = 'doom-proj-vars';
    document.head.appendChild(varSheet);
    for (var i = 0; i < rootReg.length; i++) ensureRule(rootReg[i]);
  }
  function ensureRule(R) {
    if (R.rule) return;
    try {
      varSheet.sheet.insertRule('[data-proj-root="' + R.key + '"]{' +
        '--proj-tx:0px;--proj-ty:0px;}', varSheet.sheet.cssRules.length);
      R.rule = varSheet.sheet.cssRules[varSheet.sheet.cssRules.length - 1];
    } catch (e) { R.rule = null; }
  }
  function syncRoots() {
    ensureVarSheet();
    var found = [];
    // v0.92.1 THE ORBIT REST (kept as defense in depth): .chatbot stays
    // OUT of the root registry — the icon chrome is derived solids in
    // the v0.99.4 model (nothing inside a .chatbot carries a projected
    // window), so an icon's per-frame transform drift must not open
    // motion windows (each window close fired a settle paint — the
    // measured self-sustaining ~30 paints/s while a tab group orbited).
    var els = document.querySelectorAll(ROOT_SEL);
    var keep = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = '';
      try { t = getComputedStyle(el).transform; } catch (e) {}
      if (!t || t === 'none') continue;   // untransformed: CSS fixed attachment already works
      found.push(el);
      var R = null;
      for (var r = 0; r < rootReg.length; r++) {
        if (rootReg[r].el === el) { R = rootReg[r]; break; }
      }
      if (!R) {
        R = { el: el, key: nextKey++, rule: null };
        el.setAttribute('data-proj-root', String(R.key));
        ensureRule(R);
      }
      R.el.__projTracked = true;
      keep.push(R);
    }
    // roots that lost their transform/spot: drop the attribute + rule
    for (var d = 0; d < rootReg.length; d++) {
      if (found.indexOf(rootReg[d].el) === -1) {
        rootReg[d].el.removeAttribute('data-proj-root');
        rootReg[d].el.__projTracked = false;
      }
    }
    rootReg = keep;
  }

  // readMatrix — the computed transform as {tx, ty, translateOnly}
  function readMatrix(el) {
    var t = '';
    try { t = getComputedStyle(el).transform; } catch (e) {}
    if (!t || t === 'none') return { tx: 0, ty: 0, translateOnly: true };
    var m = /matrix3d\(([^)]+)\)/.exec(t);
    if (m) {
      var v3 = m[1].split(',').map(parseFloat);
      if (v3.length === 16 &&
          v3[0] === 1 && v3[1] === 0 && v3[4] === 0 && v3[5] === 1) {
        return { tx: v3[12], ty: v3[13], translateOnly: true };
      }
      return { tx: 0, ty: 0, translateOnly: false };
    }
    m = /matrix\(([^)]+)\)/.exec(t);
    if (m) {
      var v = m[1].split(',').map(parseFloat);
      if (v[0] === 1 && v[1] === 0 && v[2] === 0 && v[3] === 1) {
        return { tx: v[4], ty: v[5], translateOnly: true };
      }
      return { tx: 0, ty: 0, translateOnly: false };
    }
    return { tx: 0, ty: 0, translateOnly: false };
  }

  function setVars(R, x, y) {
    if (!R.rule) return;
    // v1.09.1 THE DRIFT COAST — same-value guard: a no-op var write still
    // sweeps the root's inheritance subtree for computed styles (the
    // glide's measured tax). Only real deltas cross the CSSOM.
    var xs = x + 'px', ys = y + 'px';
    if (R.__tx === xs && R.__ty === ys) return;
    R.__tx = xs; R.__ty = ys;
    try {
      R.rule.style.setProperty('--proj-tx', xs);
      R.rule.style.setProperty('--proj-ty', ys);
    } catch (e) {}
  }

  // motionTick — the CHEAP path: one CSSOM var write per root + the
  // tracked scrollers' silent-anchoring true-up (v0.78.3c).
  function motionTick() {
    // v1.09.1 THE DRIFT COAST — while the motion window coasts, the root
    // vars FREEZE: the L2 transforms hold their last (rest) compensation,
    // so every window rides the content rigidly — the exact drift
    // contract the text coast shipped ("a bounded drift from the viewport
    // field, invisible on a smooth gradient"). The per-frame var writes
    // were the glide's remaining whole-subtree style-recalc sweep (two
    // inheritance walks per frame with --panel-vis-h). The settle paint
    // un-coasts and its trailing motionTick() lands the vars current
    // (the line-959 contract) — the geometry is never stranded. The
    // per-root computed matrix reads skip with the writes (nothing
    // consumes them frozen; the settle re-reads at rest).
    if (coasting) return;
    for (var i = 0; i < rootReg.length; i++) {
      var R = rootReg[i];
      var M = readMatrix(R.el);
      if (M.translateOnly) setVars(R, -M.tx, -M.ty);
      else { setVars(R, 0, 0); dirty = true; }
    }
    for (var si = 0; si < trackedScrollers.length; si++) {
      var tsc = trackedScrollers[si];
      if (!tsc || !tsc.isConnected) continue;
      var nowS2 = tsc.scrollTop || 0;
      var lastS2 = tsc.__projSy || 0;
      if (nowS2 !== lastS2) {
        tsc.__projSy = nowS2;
        scrollRebake(tsc, nowS2 - lastS2);
      }
    }
  }

  // ── the selector collection (from the stylesheets — never drifts) ──
  function collect() {
    var sels = [];
    var posSels = [];
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sheet = document.styleSheets[s];
        if (sheet.ownerNode && OWN_SHEET_IDS[sheet.ownerNode.id]) continue;
        var rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        (function walk(rs) {
          for (var i = 0; i < rs.length; i++) {
            var r = rs[i];
            // modern Chromium gives EVERY CSSStyleRule a cssRules list
            // (CSS nesting) — only recurse when it has children, never
            // skip the rule itself.
            if (r.cssRules && r.cssRules.length) walk(r.cssRules);
            if (!r.style || !r.selectorText) continue;
            var att = r.style.getPropertyValue('background-attachment');
            var img = r.style.getPropertyValue('background-image') || '';
            if ((att && att.indexOf('fixed') !== -1) || PROJ_RE.test(img)) {
              // drop pseudo-elements (::after etc) — they never match
              sels.push(r.selectorText.replace(/::[a-z-]+/g, ''));
            }
            // v0.98 C1: POSITIONED rules — L2.ok()'s descendant gate
            // rides ONE native querySelector sweep over these.
            var pos = r.style.getPropertyValue('position');
            if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') {
              var ps = r.selectorText.replace(/::[a-z-]+/g, '');
              if (posSels.indexOf(ps) < 0 && posSels.length < 400) posSels.push(ps);
            }
          }
        })(rules);
      }
    } catch (e) { /* a locked sheet is simply skipped */ }
    SEL = sels.length ? sels.join(',') : null;
    POS_SEL = posSels.length
      ? posSels.join(',') + ',[style*="position:absolute"],[style*="position:fixed"],[style*="position:sticky"]'
      : '[style*="position:absolute"],[style*="position:fixed"],[style*="position:sticky"]';
  }

  function num(v) { return (Math.round(v * 10) / 10); }
  function fmtCalc(varName, b) {
    return 'calc(var(' + varName + ', 0px) ' + (b < 0 ? '- ' : '+ ') +
      Math.abs(num(b)) + 'px)';
  }
  function fmtCalcY(b) {
    return 'calc(var(--proj-ty, 0px) ' + (b < 0 ? '- ' : '+ ') +
      Math.abs(num(b)) + 'px)';
  }
  // BOTTOM-ANCHORED elements (the input zone below the flex:1 scroller)
  // track the panel WINDOW, not the sheet — the live --panel-vis-h
  // compensates during the stretch (identical at rest; the var cancels).
  function fmtCalcYVis(b) {
    return 'calc(var(--proj-ty, 0px) ' + (b < 0 ? '- ' : '+ ') +
      Math.abs(num(b)) + 'px - var(--panel-vis-h, 0px))';
  }

  // ══ v0.94.3 TRACK 2 — THE TRANSFORM-CARRIED GRADIENT LAYERS ═════
  // Each window's gradient moves to a generated ::before LAYER (its
  // own compositor layer via will-change:transform) whose per-frame
  // compensation rides a TRANSFORM consuming the same --proj-tx/--proj-ty
  // vars: style recalc still happens (the vars cascade), but every
  // consumer resolves to a compositor transform — ZERO repaints, ZERO
  // rasters during panel motion. Geometry is IDENTICAL to the legacy
  // bake: the transform carries the var with the SAME sign — the layer
  // inherits the root's translate, so +var cancels it exactly.
  // FALLBACK: elements that already use ::before/::after, paint with
  // background-clip:text, or are static WITH positioned descendants
  // keep the inline bake — both paths coexist.
  var L2 = (function () {
    var sheetEl = null, sheet = null;
    var nextId = 1;
    // the device-class escape hatch (low-memory WebViews bail to the
    // legacy bake — oversized composited layers cost GPU memory)
    var L2_ON = (window.__doomalayL2 !== false);
    function ensure() {
      if (sheetEl && sheetEl.isConnected) return true;
      try {
        sheetEl = document.createElement('style');
        sheetEl.id = 'proj-layer-styles';
        document.head.appendChild(sheetEl);
        sheet = sheetEl.sheet;
        return !!sheet;
      } catch (e) { return false; }
    }
    // eligibility — memoized (el.__projL2ok: 2|1|0; 2 = ::after rider,
    // 1 = ::before rider, 0 = fallback).
    function ok(el, snap) {
      if (!L2_ON) return (el.__projL2ok = 0);
      if (el.__projL2ok !== undefined) return el.__projL2ok;
      var good = 0;
      try {
        var beforeFree = getComputedStyle(el, '::before').content === 'none';
        var afterFree = getComputedStyle(el, '::after').content === 'none';
        if (!beforeFree && !afterFree) return (el.__projL2ok = 0);
        if (snap.clip === 'text') return (el.__projL2ok = 0);
        if (snap.shadow && snap.shadow !== 'none') return (el.__projL2ok = 0);
        if (snap.clipPath && snap.clipPath !== 'none') return (el.__projL2ok = 0);
        if (snap.position === 'static') {
          // position:relative is only safe without positioned descendants
          // (v0.98 C1: ONE native querySelector sweep over POS_SEL).
          if (POS_SEL) {
            try { if (el.querySelector(POS_SEL)) return (el.__projL2ok = 0); } catch (e2) {}
          } else {
            var kids = el.querySelectorAll('*');
            for (var k = 0; k < kids.length; k++) {
              var kp = getComputedStyle(kids[k]).position;
              if (kp === 'absolute' || kp === 'fixed') return (el.__projL2ok = 0);
            }
          }
        }
        good = beforeFree ? 1 : 2;   // prefer ::before; ::after when taken
      } catch (e) { good = 0; }
      return (el.__projL2ok = good);
    }
    // the read phase's extra computed reads for layer candidates.
    // v0.94.4: THE LIFT-READ-RESTORE — an element already riding its
    // layer carries OUR suppression on its base rule; a plain read would
    // snapshot 'none' and the epoch re-mint would paint a DEAD layer
    // over a suppressed element (the v0.94.3 "stacking bug" — actually
    // self-cannibalization). The suppression lifts for the read and
    // restores right after (CSSOM writes on OUR OWN rule — the observer
    // never sees them).
    function snapshot(el) {
      var L = el.__projL2, lift = false;
      try {
        if (L && L.base) {
          try {
            // stamp FIRST — the lift's own attr mutation reads as
            // painter-owned even if this element was quiet last paint
            el.__projWriteEpoch = writeEpoch;
            L.base.style.removeProperty('background-image');
            el.style.removeProperty('background-image');
            // v1.08.2: the COLOR lifts too — the [style*=] catchers key on
            // the author's background-color spelling; without the lift the
            // reads below would evaluate a catcher-less element (the
            // ownership test would misread every suppressed window).
            el.style.removeProperty('background-color');
            lift = true;
          } catch (e0) {}
        }
        var cs = getComputedStyle(el);
        var out = {
          position: cs.position,
          image: cs.backgroundImage,
          color: cs.backgroundColor,
          repeat: cs.backgroundRepeat,
          radius: cs.borderRadius,
          clip: cs.backgroundClip,
          shadow: cs.boxShadow,
          clipPath: cs.clipPath,
          attachment: cs.backgroundAttachment,
          ovfX: cs.overflowX,
          bt: parseFloat(cs.borderTopWidth) || 0,
          br: parseFloat(cs.borderRightWidth) || 0,
          bb: parseFloat(cs.borderBottomWidth) || 0,
          bl: parseFloat(cs.borderLeftWidth) || 0
        };
        if (lift) {
          L.base.style.setProperty('background-image', 'none', 'important');
          el.style.setProperty('background-image', 'none', 'important');
          el.style.setProperty('background-color', 'transparent', 'important');
        }
        return out;
      } catch (e) {
        try {
          if (lift && L && L.base) {
            L.base.style.setProperty('background-image', 'none', 'important');
            el.style.setProperty('background-image', 'none', 'important');
            el.style.setProperty('background-color', 'transparent', 'important');
          }
        } catch (e1) {}
        return null;
      }
    }
    // bake/patch — returns true when the element rides the layer path.
    function bake(el, snap, bx, by, size, vis, epoch, pseudo) {
      if (!ensure()) return false;
      var L = el.__projL2;
      var fresh = !L, stale = !!L && el.__projL2Epoch !== epoch;
      if ((fresh || stale) && !snap) return false;
      if (fresh || stale) {
        if (fresh) {
          var ps = (pseudo === 2) ? '::after' : '::before';
          var id = 'pl' + (nextId++);
          try { el.setAttribute('data-proj', id); } catch (e) { return false; }
          var i1, i2;
          try {
            i1 = sheet.insertRule('[data-proj="' + id + '"]' + ps + ' {}', sheet.cssRules.length);
            i2 = sheet.insertRule('[data-proj="' + id + '"] {}', sheet.cssRules.length);
          } catch (e) { try { el.removeAttribute('data-proj'); } catch (e2) {} return false; }
          var br = sheet.cssRules[i1], base = sheet.cssRules[i2];
          L = el.__projL2 = { id: id, br: br, base: base, pos: null, size: null, vis: null, bl: snap.bl, bt: snap.bt };
          // base — the suppression + the geometry contract
          var bs = base.style;
          bs.isolation = 'isolate';          // keeps z-index:-1 above the parent's paint
          if (snap.position === 'static') bs.position = 'relative';
          // !important — the gradient TWIN rules (index.html's
          // [style*="background:var(--surface-2)"] etc.) carry their own
          // !important image declarations; a plain 'none' lost to them.
          bs.setProperty('background-image', 'none', 'important');
          bs.setProperty('background-color', 'transparent', 'important');
          // the INLINE SUPPRESSION — the gate twins reach (0,2,0)+
          // specificity with their own !important gradients and NO
          // attribute rule of ours can out-specify an ID-matched twin.
          // The element's inline style + !important beats EVERY selector
          // at any specificity. Cleared on drop().
          try {
            // v1.06.3: SAVE the author's own inline values FIRST — the
            // suppression REPLACES them (one value per property); the
            // drop/strip path restores them (restoreAuthorBg).
            el.__projAuthorBg = {
              image: el.style.getPropertyValue('background-image'),
              ip: el.style.getPropertyPriority('background-image'),
              color: el.style.getPropertyValue('background-color'),
              cp: el.style.getPropertyPriority('background-color')
            };
            el.style.setProperty('background-image', 'none', 'important');
            el.style.setProperty('background-color', 'transparent', 'important');
            el.__projSuppressed = true;   // v1.06.3: painter-written — the strip's proof
            el.__projWriteEpoch = writeEpoch;   // painter-owned — the observer skips it
          } catch (e3) {}
          // paint containment — the oversized pseudo would otherwise
          // extend every scrollable ancestor's scrollHeight (the rig
          // measured the transcript scroller at 3511px vs 3029 — a 482px
          // void the auto-scroll drowned in). ONLY for overflow:visible
          // bases (the v0.94.4 regression: isolating a container the
          // panel stretch animates re-layouts it expensively).
          if (snap.ovfX === 'visible') bs.contain = 'paint';
          // THE OVERSIZE GEOMETRY — the pseudo's box must STILL COVER the
          // element's box at every panel translate: the transform slides
          // the whole box by var(-T), so the box extends 110vh UP and a
          // 20px skirt sideways; the element clips it with clip-path
          // (paint-only — no layout, no scroll side effects).
          bs.clipPath = 'inset(0' +
            (snap.radius && snap.radius !== 'none' ? ' round ' + snap.radius : '') + ')';
          // the layer itself — oversized, viewport-anchored field
          var s = br.style;
          s.setProperty('content', '""');
          s.position = 'absolute';
          s.top = 'calc(-110vh - ' + snap.bt + 'px)';
          s.left = 'calc(-40px - ' + snap.bl + 'px)';
          s.right = 'calc(-40px - ' + snap.br + 'px)';
          s.bottom = 'calc(-90vh - 20px - ' + snap.bb + 'px)';
          s.zIndex = '-1';
          s.pointerEvents = 'none';
        }
        // (re)mint the decorative props (first mint + every epoch/theme flip)
        var d = L.br.style;
        d.backgroundImage = snap.image;
        d.backgroundColor = snap.color;
        d.backgroundRepeat = snap.repeat;
        el.__projL2Epoch = epoch;
      }
      if (L.vis !== vis) {
        L.vis = vis;
        L.br.style.transform = 'translate3d(calc(var(--proj-tx, 0px)),' +
          ' calc(var(--proj-ty, 0px)' + (vis ? ' - var(--panel-vis-h, 0px)' : '') + '), 0)';
        L.br.style.willChange = 'transform';
      }
      if (L.size !== size) { L.size = size; L.br.style.backgroundSize = size; }
      // the field is anchored to the VIEWPORT ORIGIN inside the
      // OVERSIZED box: pos = the TOP/LEFT margins + border + the legacy
      // constant — invariant under the transform.
      var posX = 'calc(40px ' + ((L.bl + (bx || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bl + (bx || 0)) * 100) / 100) + 'px)';
      var posY = 'calc(110vh ' + ((L.bt + (by || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bt + (by || 0)) * 100) / 100) + 'px)';
      var pos = posX + ' ' + posY;
      if (L.pos !== pos) { L.pos = pos; L.br.style.backgroundPosition = pos; }
      return true;
    }
    // scrollRebake's arithmetic write — the rule position, not inline
    function rebake(el) {
      var L = el.__projL2;
      if (!L) return false;
      var posX = 'calc(40px ' + ((L.bl + (el.__projBx || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bl + (el.__projBx || 0)) * 100) / 100) + 'px)';
      var posY = 'calc(110vh ' + ((L.bt + (el.__projBy || 0)) < 0 ? '- ' : '+ ') + Math.abs(Math.round((L.bt + (el.__projBy || 0)) * 100) / 100) + 'px)';
      var pos = posX + ' ' + posY;
      if (L.pos !== pos) { L.pos = pos; L.br.style.backgroundPosition = pos; }
      return true;
    }
    function drop(el) {
      var L = el.__projL2;
      if (!L) return false;
      try {
        var rules = sheet.cssRules;
        var needle = '[data-proj="' + L.id + '"]';
        for (var i = rules.length - 1; i >= 0; i--) {
          if ((rules[i].selectorText || '').indexOf(needle) !== -1) sheet.deleteRule(i);
        }
        el.removeAttribute('data-proj');
      } catch (e) {}
      // clear the INLINE suppression — the CSS state owns the element
      // again (byte-identical to the no-gradient look). The suppression
      // is PAINTER-WRITTEN (flagged) and the AUTHOR'S OWN values come
      // back with it (restoreAuthorBg — the white-pill law).
      try {
        restoreAuthorBg(el);
        el.__projSuppressed = false;
        el.__projWriteEpoch = writeEpoch;   // painter-owned removal
      } catch (e4) {}
      el.__projL2 = undefined;
      return true;
    }
    function resizeAll(size) {
      if (!sheet) return;
      try {
        var rules = sheet.cssRules;
        for (var i = 0; i < rules.length; i++) {
          var sel = rules[i].selectorText || '';
          if (sel.indexOf('::before') !== -1) rules[i].style.backgroundSize = size;
        }
      } catch (e) {}
    }
    function dropAll() {
      try {
        if (sheet && sheet.cssRules) {
          while (sheet.cssRules.length) sheet.deleteRule(0);
        }
      } catch (e) {}
    }
    return { ok: ok, snapshot: snapshot, bake: bake, rebake: rebake, drop: drop, resizeAll: resizeAll, dropAll: dropAll };
  })();

  // ── the scroller tracking (v0.78.3) ─────────────────────────────
  function findScroller(el, stopAt) {
    var p = el.parentElement;
    while (p && p !== stopAt) {
      if (p.nodeType === 1 && p.scrollHeight > p.clientHeight + 1) return p;
      p = p.parentElement;
    }
    return null;
  }
  var scrollRules = [];
  function scrollerRule(el) {
    for (var i = 0; i < scrollRules.length; i++) {
      if (scrollRules[i].el === el) return scrollRules[i];
    }
    ensureVarSheet();
    var rec = { el: el, rule: null };
    try {
      var idx = varSheet.sheet.insertRule(
        '[data-proj-sy="' + scrollRules.length + '"] { --proj-sy: 0px; }',
        varSheet.sheet.cssRules.length);
      rec.rule = varSheet.sheet.cssRules[idx];
      el.setAttribute('data-proj-sy', String(scrollRules.length));
    } catch (e) {}
    scrollRules.push(rec);
    return rec;
  }

  // ══ THE PAINT — the batched read/write phases ═══════════════════
  function paint() {
    coasting = false;   // v1.08.5: the settle un-coasts (the read phase
                        // re-anchors every coasted text window)
    if (!SEL) collect();
    if (!SEL) return;
    syncRoots();
    var vw = window.innerWidth, vh = window.innerHeight;
    var size = vw + 'px ' + vh + 'px';
    var epoch = memoEpoch;
    stats.paints++;
    for (var rr = 0; rr < rootReg.length; rr++) rootReg[rr].bRect = undefined;
    // ── READ PHASE (batched — no writes between reads) ────────
    // v1.08.2 THE STEADY HAND: the per-element body is a closure — the
    // qSA sweep AND the steady-hand pass (below) feed the same pipeline.
    var stamp = ++paintStamp;
    var reads = [];
    var readOne = function (el, R, M, st) {
      if (!el || el.__projStamp === st) return;
      el.__projStamp = st;
      {
        if (!el.__projPainted) {
          // memoized-solid skip — no getComputedStyle for the (majority)
          // solid twins on every paint; the epoch clears the memo on
          // repaint/theme swaps.
          if (el.__projNoneEpoch === epoch) return;
          // ONE computed read, BOTH properties (the old two-call probe
          // forced two style flushes per element per first-encounter
          // paint — the panel-open long tasks).
          var pcs = getComputedStyle(el);
          var img = pcs.backgroundImage;
          if (!img || img === 'none') { el.__projNoneEpoch = epoch; return; }
          // v0.92.1: the projection model is FIXED-ATTACHMENT windows
          // only. An element whose computed attachment carries no
          // 'fixed' opted out (a local gradient). Memoized with the
          // same epoch (a theme flip bumps memoEpoch + re-collects).
          // v1.04.2: the painter's OWN bake (inline scroll — which
          // BEATS the plain DOOM SHEET by design, unlike the old
          // !important gates) or an existing layer is NOT an opt-out —
          // a dropped-then-returning window must re-enter the set.
          if (pcs.backgroundAttachment.indexOf('fixed') === -1 &&
              !el.__projL2 && el.__projPos == null) { el.__projNoneEpoch = epoch; return; }
          el.__projPainted = true;
        }
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < -60 || r.top > vh + 60) {
          // OFFSCREEN elements stay PAINTED (carry, no re-bake — the
          // "for an instant paints the full gradient into a single
          // pill" flash fix). Their numeric constants still TRUE-UP
          // (content-visibility un-rendering shifts far-offscreen rows
          // silently; arithmetic-from-rot was the misplaced-gradient
          // flash reborn).
          // v1.08.5 THE COAST — the carry path is where the transcript's
          // offscreen text lives: the clip flag MUST be decided HERE (the
          // rig caught the storm — un-flagged carries took the var-form
          // true-up write on every paint). One cheap computed read, once
          // per element; the flag sticks from then on.
          if (el.__projClip === undefined) {
            try {
              var csc = getComputedStyle(el);
              el.__projClip = ((csc.webkitBackgroundClip || csc.backgroundClip) === 'text') ? 1 : 0;
            } catch (eC) { el.__projClip = 0; }
          }
          el.__projR = R;
          el.__projCarry = true;
          reads.push({ el: el, R: R, carry: true,
            zero: (r.width < 1 && r.height < 1),   // v1.06.3: display:none — constants only
            bx: M.translateOnly ? (-r.left + M.tx) : -r.left,
            by: M.translateOnly ? (-r.top + M.ty) : -r.top });
          return;
        }
        // bake FLAT (the current viewport position) — the scroll path
        // re-bakes constants incrementally (scrollRebake) on scroll
        // events AND on silent scroll-anchoring drift (motionTick's
        // true-up). Paint-time: discover + track this element's owner
        // scroller so the true-up covers fresh panels.
        var sco = el.__projScOwner;
        if (sco === undefined) {
          sco = findScroller(el, R.el.parentElement);
          el.__projScOwner = sco;
        }
        if (sco && trackedScrollers.length < 12) {
          var knownSc = false;
          for (var k = 0; k < trackedScrollers.length; k++) {
            if (trackedScrollers[k] === sco) { knownSc = true; break; }
          }
          if (!knownSc) trackedScrollers.push(sco);
        }
        var sTop = 0;
        // bottom-anchored detection — not inside a scroller, but hugging
        // the panel window's bottom edge (the input zone + activity row
        // under the flex:1 scroller): (a) outside any scroller + hugging
        // the body bottom, or (b) inside a NON-body scroller with slack,
        // or (c) absolute + non-auto bottom whose offset parent's bottom
        // edge IS the body bottom.
        var visForm = false;
        if (R.bodyEl === undefined) {
          R.bodyEl = R.el.querySelector('.panel-body') || null;
        }
        var inChildScroller = !!(sco && R.bodyEl && sco !== R.bodyEl);
        if (!sco || (inChildScroller && sco.scrollHeight <= sco.clientHeight + 1)) {
          if (R.bodyEl) {
            var br2 = R.bodyEl.getBoundingClientRect();
            if (br2.bottom > -1e9 && br2.bottom - r.bottom < 48) visForm = true;
          }
        }
        if (!visForm) {
          var absBot = el.__projAbsBot;
          if (absBot === undefined) {
            try {
              var pcs2 = getComputedStyle(el);
              absBot = (pcs2.position === 'absolute' && pcs2.bottom !== 'auto') ? 1 : 0;
            } catch (perr) { absBot = 0; }
            el.__projAbsBot = absBot;
          }
          if (absBot && R.bodyEl && (!sco || inChildScroller)) {
            var opr = null;
            try { opr = el.offsetParent ? el.offsetParent.getBoundingClientRect() : null; } catch (oerr) {}
            if (opr && R.bRect === undefined) {
              R.bRect = R.bodyEl.getBoundingClientRect();
            }
            if (opr && R.bRect && Math.abs(opr.bottom - R.bRect.bottom) < 2) visForm = true;
          }
        }
        // the translation-invariant base: strip the root's CURRENT
        // translation so the per-frame vars can re-add it
        var flatBy = M.translateOnly ? (-r.top + M.ty - sTop) : (-r.top - sTop);
        var yB = flatBy, yCalc = fmtCalcY(flatBy);
        if (visForm) {
          // compensate: runtime = var(--proj-ty) + (flatB + V0) - var(--panel-vis-h)
          // v1.05.1: V0's source — gesture.js (THE GLASS WINDOW) now writes
          // the --panel-vis-h var on the root ONLY while the projection is
          // enabled (the element-scoped body height replaced the per-frame
          // var write for everyone else). Enabling mid-session therefore
          // reads an UNSET var (0) — fall back to the body's inline height,
          // which gesture.js writes at every rest AND motion frame (at rest
          // the two are identical: the rest window height).
          var v0 = R.visH0;
          if (v0 === undefined) {
            var hv = '';
            try { hv = getComputedStyle(R.el).getPropertyValue('--panel-vis-h'); } catch (herr) {}
            v0 = parseFloat(hv) || 0;
            if (!v0 && R.bodyEl) {
              try { v0 = parseFloat(R.bodyEl.style.height) || 0; } catch (bherr) {}
            }
            R.visH0 = v0;
          }
          yB = flatBy + v0;
          yCalc = fmtCalcYVis(yB);
        }
        // the Track-2 candidate snapshot — computed reads stay in the
        // READ phase (batched, layout-clean); the MINT DECISION computes
        // here too (v0.98 C2 — the write phase used to call L2.ok()
        // between mint writes, forcing a style recalc per cycle).
        var _snap = (el.__projL2ok === 0) ? null :
          ((el.__projL2 && el.__projL2Epoch === epoch) ? null : L2.snapshot(el));
        // v1.00.3: THE PHANTOM PURGE — an un-minted painted element that
        // resolves 'none' at any stable snapshot LEAVES the painted set.
        if (_snap && (!_snap.image || _snap.image === 'none')) {
          el.__projPainted = false;
          return;
        }
        // v1.08.2 THE OWNERSHIP TEST — a suppressed element the CSS has
        // claimed LOCALLY (the §2 gate windows' attachment:local — the
        // snapshot's lift makes the catcher visible again so the computed
        // attachment is the truth) yields: the layer drops (the author's
        // values came back with it) and the first-encounter probe
        // memoizes the local look on the next paint. Legacy bakes are
        // untouched — their inline scroll IS the bake.
        if (_snap && el.__projSuppressed && _snap.attachment &&
            _snap.attachment.indexOf('fixed') === -1) {
          L2.drop(el);
          el.__projPainted = false;
          el.__projPos = null;
          el.__projCarry = false;
          stats.yielded++;
          return;
        }
        var _okv = _snap ? L2.ok(el, _snap) : 0;
        // v1.08.5 THE COAST — text windows (background-clip:text) ride the
        // LEGACY inline bake, and they are the population the scroll/motion
        // re-anchor writes traverse. Flagged here (the snapshot's clip),
        // consumed by scrollRebake (skip) and coastText (the motion
        // disconnect). THE FLAG STICKS: on steady paints the snapshot is
        // memoized away (null) — resetting there would un-flag every text
        // window one paint after its first bake (the rig caught exactly
        // that: clip=0 write storms). visForm text (the bottom-anchored
        // input zone) stays var-carried — its --panel-vis-h term must
        // keep compensating.
        if (_snap) el.__projClip = (_snap.clip === 'text') ? 1 : 0;
        if (_snap) el.__projVisForm = visForm ? 1 : 0;
        reads.push({ el: el, R: R,
          bx: M.translateOnly ? (-r.left + M.tx) : -r.left,
          by: yB,
          pos: fmtCalc('--proj-tx', M.translateOnly ? (-r.left + M.tx) : -r.left) + ' ' + yCalc,
          vis: visForm,
          snap: _snap, okv: _okv });
        el.__projR = R;
      }
    };
    for (var ri = 0; ri < rootReg.length; ri++) {
      var R = rootReg[ri];
      var els;
      try { els = R.el.querySelectorAll(SEL); } catch (e) { SEL = null; POS_SEL = null; return; }
      var M = readMatrix(R.el);
      for (var i = 0; i < els.length; i++) readOne(els[i], R, M, stamp);
    }
    // v1.08.2 THE STEADY HAND — the second read source: suppressed windows
    // the qSA sweep can no longer see (the L2 suppression rewrote the
    // inline background-color, BREAKING the [style*=] catcher that matched
    // the element into SEL). Without this pass: paint N bakes+suppresses →
    // paint N+1 drops (no match → the author values restore) → paint N+2
    // re-bakes — the projected↔local oscillation the user reports as pills
    // "switching to non doom projection randomly for a bit". A suppressed
    // element is a painter asset: it re-enters the read list regardless of
    // the live attribute match; it leaves only via the ownership test
    // (CSS claimed it locally) or the drop loop (DOM/geometry loss).
    for (var ps = 0; ps < painted.length; ps++) {
      var pEl = painted[ps];
      if (!pEl || !pEl.isConnected || !pEl.__projSuppressed) continue;
      if (pEl.__projStamp === stamp) continue;
      var pR = pEl.__projR;
      if (!pR || rootReg.indexOf(pR) === -1) continue;
      readOne(pEl, pR, readMatrix(pR.el), stamp);
    }
    // ── WRITE PHASE (only what changed — a no-op bake writes
    //    nothing, fires no MutationObserver, settles at once) ──
    // writeEpoch — elements this paint touched carry it; the observer
    // skips THEIR style mutations (the painter's own writes re-triggering
    // the observer was a self-sustaining paint loop).
    var wep = ++writeEpoch;
    var keep = [];
    for (var w = 0; w < reads.length; w++) {
      var it = reads[w];
      if (it.carry) {
        if (it.bx !== undefined) {
          it.el.__projBx = it.bx;
          it.el.__projBy = it.by;
          if (it.el.__projL2 && L2.rebake(it.el)) {
            /* layered carry — constants trued, rule patched */
          } else if (!it.zero && !it.el.__projClip) {
            // v1.06.3: a ZERO-RECT element (display:none — the header
            // pills' closed dropdown) takes the constants only: a bake
            // here anchored nothing visible AND its unconditional
            // image/color strip deleted the element's OWN inline paint
            // (the white-pill root cause). Real-rect carries (scrolled-
            // offscreen windows) keep the full true-up write.
            // v1.08.5 THE COAST: text carries skip the true-up — their
            // constants go stale by design (they coast with the content);
            // landing on-screen routes them through bakeNewcomers (a
            // fresh, correct anchor at first sight).
            var cpos = fmtCalc('--proj-tx', it.bx) + ' ' + fmtCalcY(it.by);
            if (it.el.__projPos !== cpos || !it.el.style.backgroundSize) {
              it.el.style.backgroundPosition = cpos;
              it.el.style.backgroundSize = size;
              it.el.style.backgroundAttachment = 'scroll';
              if (it.el.__projSuppressed) {
                restoreAuthorBg(it.el);   // v1.06.3: the author's values come back
                it.el.__projSuppressed = false;
              }
              try { it.el.setAttribute('data-proj-bake', '1'); } catch (eB1) {}   // v1.05.2: the teardown sweep's marker
              it.el.__projPos = cpos;
              it.el.__projWriteEpoch = wep;   // painter-owned — the observer skips it
            }
          }
        }
        keep.push(it.el);
        continue;
      }
      // TRACK 2 FIRST — the transform-carried layer path (falls back to
      // the legacy inline bake for conflicted elements). An element
      // that already rides its layer (fresh epoch) patches its rule
      // position from the fresh constants — it NEVER falls through to
      // the legacy inline write (the fallthrough left the layer stale
      // by the scroll/motion delta).
      var layered = false;
      it.el.__projBx = it.bx;
      it.el.__projBy = it.by;
      if (it.el.__projL2 && it.el.__projL2Epoch === epoch) {
        layered = true;
        L2.rebake(it.el);
      } else if (it.snap && it.okv) {
        layered = L2.bake(it.el, it.snap, it.bx, it.by, size, it.vis, epoch, it.okv);
      }
      if (layered) {
        // clear any legacy inline bake this element carried
        if (it.el.__projPos !== undefined || it.el.hasAttribute('data-proj-bake')) {
          it.el.style.removeProperty('background-position');
          it.el.style.removeProperty('background-size');
          it.el.style.removeProperty('background-attachment');
          try { it.el.removeAttribute('data-proj-bake'); } catch (eB2) {}   // v1.05.2: layered now — the legacy marker is dead
          it.el.__projPos = undefined;
          it.el.__projWriteEpoch = wep;
        }
      } else {
        // the legacy fallthrough — clear any stale INLINE suppression
        // first (it would blank the element's own gradient). v1.06.3:
        // the removal is PAINTER-SCOPED — only the L2-written
        // suppression comes off; the element's own inline background
        // (the pills' tint) is never the painter's to remove.
        if (it.el.__projSuppressed) {
          restoreAuthorBg(it.el);   // v1.06.3: the author's values come back
          it.el.__projSuppressed = false;
        }
        if (it.el.__projPos !== it.pos) {
          it.el.style.backgroundPosition = it.pos;
          it.el.__projPos = it.pos;
        }
        if (it.el.style.backgroundSize !== size) it.el.style.backgroundSize = size;
        if (it.el.style.backgroundAttachment !== 'scroll') it.el.style.backgroundAttachment = 'scroll';
        try { it.el.setAttribute('data-proj-bake', '1'); } catch (eB3) {}   // v1.05.2: the teardown sweep's marker
        it.el.__projWriteEpoch = wep;
      }
      it.el.__projCarry = false;
      keep.push(it.el);
    }
    // clear every previously-painted element that lost its anchor this
    // pass — it left the transformed scopes or was removed from the DOM
    // (offscreen elements are CARRIED, never stripped). The CSS state
    // owns the dropped ones again.
    // v1.05.2: DISCONNECTED elements are STRIPPED, not skipped — the
    // Panel's view-stack stash/restore (panel.js) detaches + re-attaches
    // the root DOM; a baked element resurrected OUTSIDE the painted
    // registry was never re-anchored again ("doesn't update as it
    // should") and was invisible to teardown (it SURVIVED the toggle
    // off). Stripping at detach time means the restore comes back clean
    // and the next paint re-bakes it.
    for (var p = 0; p < painted.length; p++) {
      var el2 = painted[p];
      if (keep.indexOf(el2) !== -1) continue;
      if (!el2.isConnected) {
        // leaving the DOM — strip everything so a later re-attachment
        // carries no painter state
        if (el2.__projL2) L2.drop(el2);
        else stripInlineBake(el2);
        el2.__projPainted = false;
        el2.__projPos = null;
        el2.__projScOwner = undefined;
        el2.__projAbsBot = undefined;
        el2.__projCarry = false;
        continue;
      }
      if (L2.drop(el2)) continue;
      stripInlineBake(el2);
      el2.__projPainted = false;
      el2.__projPos = null;
      el2.__projScOwner = undefined;
      el2.__projAbsBot = undefined;
    }
    painted = keep;
    motionTick();   // the vars land current right after the bake
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(run);
  }
  function run() {
    rafId = 0;
    var hadRoot = movingRoot > 0;
    // v1.09.1 THE DRIFT COAST — the gesture-fresh probe (the same 200ms
    // window the observer's gate uses).
    var gestFresh = !!(window.__doomalayGestureAt &&
      performance.now() - window.__doomalayGestureAt < 200);
    if (dirty || movingLayout > 0) {
      if (movingRoot > 0 && gestFresh) {
        // THE DEFER — a full paint while the motion window is open would
        // un-coast every window mid-glide (the var-form re-anchor re-arms
        // the per-frame glyph rasters the coast just disconnected). The
        // dirty/movingLayout state stays PENDING; the paint lands one
        // frame after the window closes (the settle: un-coast +
        // re-anchor + the trailing vars sync). A real content change
        // during a ≤300ms glide waits that long — invisible.
        stats.deferred++;   // v1.09.1 instrument: mid-glide paints held
      } else {
        paint();
        dirty = false;
        if (movingLayout > 0) movingLayout--;
      }
    } else if (movingRoot > 0) {
      motionTick();
    }
    if (movingRoot > 0) movingRoot--;
    // settle: when a motion window closes, one final full paint
    // re-validates every anchor at rest. NOT during a live gesture
    // (a drag's smoothing loop pauses between pointer moves, and every
    // such micro-pause fired a full settle paint — the mid-drag paint
    // storm). One deferred retry lands the settle after the gesture
    // truly ends.
    if (hadRoot && movingRoot === 0 && !dirty && movingLayout === 0) {
      if (window.__doomalayGestureAt &&
          performance.now() - window.__doomalayGestureAt < 200) {
        if (!gestRetry) gestRetry = setTimeout(gestRetryFn, 240);
      } else {
        paint();
      }
    }
    if (dirty || movingRoot > 0 || movingLayout > 0) schedule();
  }
  var gestRetry = 0;
  function gestRetryFn() {
    gestRetry = 0;
    if (window.__doomalayGestureAt &&
        performance.now() - window.__doomalayGestureAt < 200) {
      gestRetry = setTimeout(gestRetryFn, 240);   // still gesturing — wait
    } else {
      mark();   // the gesture truly ended — the ONE settle paint
    }
  }
  function mark() { dirty = true; schedule(); }
  // v1.08.5 THE COAST — the motion-window edge disconnects every painted
  // LEGACY window from the per-frame root vars: its background-position
  // is rewritten ONCE to the currently-resolved constant, so the per-frame
  // --proj-tx/--proj-ty writes stop touching it (no style recalc, no
  // viewport-sized glyph re-raster per frame — the measured cost of
  // projected text during the panel glide). The gradient then rides the
  // content rigidly (a bounded drift from the viewport field — invisible
  // on a smooth gradient), and the settle paint re-anchors everything.
  // v1.09.1 THE DRIFT COAST — the coast covers EVERY legacy window now
  // (text incl. the bottom-anchored vis form, and the rare non-L2
  // fallback population): with the root vars frozen (motionTick's coast
  // gate), the L2 transforms hold their rest compensation by themselves —
  // nothing to rewrite there — and constants make the legacy leg immune
  // to any residual var wobble. One write per window at the motion edge.
  // RESEARCH: the layout-thrashing literature (read/write interleaving
  // forces synchronous layout) and Chrome's own Android scroll work both
  // point the same way — per-frame main-thread writes defeat the
  // compositor; no OSS 'gradient text' library changes the math (they all
  // ship background-clip:text). docs/RESEARCH-V109-TEXT-AND-PANEL-PERF.md.
  function coastText() {
    if (coasting) return;
    coasting = true;
    stats.coasts++;   // v1.09.1 instrument: the motion-edge disconnects
    var wep = ++writeEpoch;
    var matrixCache = null;   // one computed read per root per coast edge
    for (var i = 0; i < painted.length; i++) {
      var el = painted[i];
      // v1.09.1 THE DRIFT COAST — every LEGACY window coasts (text incl.
      // the vis form + the non-L2 fallbacks): the constant rewrite makes
      // the inline bake immune to any var wobble while the motion window
      // is open. L2 layers are skipped — their transform compensation
      // freezes WITH the root vars (motionTick's coast gate); nothing to
      // rewrite there.
      if (el.__projL2 || !el.__projPos || !el.isConnected) continue;
      var R = el.__projR;
      if (!R) continue;
      if (!matrixCache || matrixCache.el !== R.el) {
        matrixCache = { el: R.el, M: readMatrix(R.el) };
      }
      var M = matrixCache.M;
      var px = (el.__projBx || 0) - (M.translateOnly ? M.tx : 0);
      var py = (el.__projBy || 0) - (M.translateOnly ? M.ty : 0);
      var pos = num(px) + 'px ' + num(py) + 'px';
      el.style.backgroundPosition = pos;
      el.__projPos = pos;              // the coasted constant — the settle
      el.__projWriteEpoch = wep;       // paint's diff-check rewrites the var form
    }
  }
  function motion() { coastText(); movingRoot = 3; schedule(); stats.motions++; }
  // the LAYOUT window: any transition on a property that can move
  // element boxes repaints per frame while it animates; cosmetic
  // transitions only mark once.
  var MOVER_RE = /^(transform|all|grid-template-rows|grid-template-columns|height|max-height|min-height|width|max-width|min-width|top|left|right|bottom|margin[^ ]*|padding[^ ]*|flex-basis|font-size|inset[^ ]*|translate)$/;

  // ── v0.79.1: THE VALUE-VAR FILTER ───────────────────────────────
  // A style-attribute diff on the THEME ROOTS that touches ONLY
  // non-layout CUSTOM PROPERTIES is a theme/fmt VALUE write — colors
  // and background images cannot move a box, so the projection anchors
  // (geometry facts) stay valid and the SEL set (a stylesheet fact) is
  // unchanged. The layout-affecting custom props (the text sizes) still
  // paint.
  var LAYOUT_CP = { '--chat-fs': 1, '--chat-scale': 1, '--ui-fs': 1, '--ui-small-fs': 1 };
  function parseStyleAttrFor(s, out) {
    var parts = String(s || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].indexOf(':');
      if (c < 0) continue;
      var k = parts[i].slice(0, c).replace(/^\s+|\s+$/g, '');
      if (k) out[k] = parts[i].slice(c + 1).replace(/^\s+|\s+$/g, '');
    }
  }
  function styleDiffOnlyValueVars(oldS, newS) {
    if (oldS === newS) return true;
    var a = {}, b = {};
    parseStyleAttrFor(oldS, a);
    parseStyleAttrFor(newS, b);
    for (var k in a) {
      if (!(k in b) || a[k] !== b[k]) {
        if (!(k.charAt(0) === '-' && !LAYOUT_CP[k])) return false;
      }
    }
    for (var k2 in b) {
      if (!(k2 in a) || a[k2] !== b[k2]) {
        if (!(k2.charAt(0) === '-' && !LAYOUT_CP[k2])) return false;
      }
    }
    return true;
  }

  // ══ THE DOOM SHEET — the toggle's fixed-attachment override ══════
  // Every stylesheet rule whose background-image carries a projected
  // gradient var gets a prefixed copy minting the FIXED attachment
  // (the native viewport projection for consumers OUTSIDE transformed
  // roots — the painter bakes the rest to scroll + explicit
  // re-anchoring). PLAIN declarations (no !important): the painter's
  // inline bake must WIN on baked elements (inline beats any author
  // rule), and the html[attr] prefix out-specifies every base rule it
  // derives from.
  //   · THE GATE MERGE (v1.04.2, rig-caught): the GATES set their attrs on
  // <html> — a prefixed `html[data-doom-proj] [data-s1-grad] #x` NEVER
  // matches (the [data-s1-grad] would have to be a DESCENDANT of
  // html; it IS html). Root-gate-led selectors MERGE into the prefix:
  // `html[data-doom-proj][data-s1-grad] #x`. The [style*=] catchers
  // and every other leading compound take the space prefix (their
  // compounds live on the consumers, not the root).
  //   · v1.06.2: the fmt text rules are gate-led too ([data-fmt-grad~=…]
  // on :root, formatter.js) — the same merge law covers them, value
  // forms and all.
  var ROOT_GATE_RE = /^\[(data-fmt-grad[^\]]*|data-s1-grad|data-a1-grad|data-a2-grad|data-a3-grad)\]/;
  function prefixSelector(sel) {
    var m = ROOT_GATE_RE.exec(sel);
    if (m) return 'html[data-doom-proj]' + m[0] + ' ' + sel.slice(m[0].length).trim();
    return 'html[data-doom-proj] ' + sel;
  }
  function mintDoomSheet() {
    var parts = [];
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sheetEl = document.styleSheets[s];
        if (sheetEl.ownerNode && OWN_SHEET_IDS[sheetEl.ownerNode.id]) continue;
        var rules;
        try { rules = sheetEl.cssRules; } catch (e) { continue; }
        (function walk(rs) {
          for (var i = 0; i < rs.length; i++) {
            var r = rs[i];
            if (r.cssRules && r.cssRules.length) walk(r.cssRules);
            if (!r.style || !r.selectorText) continue;
            var img = r.style.getPropertyValue('background-image') || '';
            if (!PROJ_RE.test(img)) continue;
            var sels = String(r.selectorText).split(',').map(function (x) { return x.trim(); });
            for (var q = 0; q < sels.length; q++) {
              if (!sels[q]) continue;
              var prefixed = prefixSelector(sels[q]);
              if (parts.indexOf(prefixed) < 0) parts.push(prefixed);
            }
          }
        })(rules);
      }
    } catch (e) { /* a locked sheet is simply skipped */ }
    var css = parts.length
      ? parts.join(',\n') + ' { background-attachment: fixed; }\n'
      : '';
    if (!doomSheet) {
      doomSheet = document.createElement('style');
      doomSheet.id = 'doom-proj-override';
      document.head.appendChild(doomSheet);
    }
    doomSheet.textContent = css;
  }
  function dropDoomSheet() {
    if (doomSheet && doomSheet.parentNode) doomSheet.parentNode.removeChild(doomSheet);
    doomSheet = null;
  }

  // ── the triggers (the observer family) ─────────────────────────
  function wireObservers() {
    if (obs) return;
    obs = new MutationObserver(function (muts) {
      if (!on) return;
      // a new stylesheet re-derives the projection selector set AND
      // the DOOM SHEET (a module-injected <style> may carry new
      // gradient rules)
      var sheetChange = false;
      for (var i = 0; i < muts.length; i++) {
        var mm = muts[i];
        if (mm.type !== 'childList') continue;
        for (var j = 0; j < mm.addedNodes.length; j++) {
          var nn = mm.addedNodes[j];
          if (nn.nodeType === 1 && (nn.tagName === 'STYLE' || nn.tagName === 'LINK') &&
              !OWN_SHEET_IDS[nn.id]) {
            SEL = null;
            POS_SEL = null;
            sheetChange = true;
          }
        }
      }
      if (sheetChange) { mintDoomSheet(); mark(); return; }
      // VALUE NOISE, filtered FIRST (theme/fmt VALUE writes on the
      // theme roots touch only non-layout custom properties).
      var kept = [];
      for (var vi = 0; vi < muts.length; vi++) {
        var vm = muts[vi];
        if (vm.type === 'attributes' && vm.attributeName === 'style' &&
            vm.target && (vm.target === document.documentElement ||
                          vm.target.id === 'chat-root') &&
            styleDiffOnlyValueVars(vm.oldValue || '',
              vm.target.getAttribute('style') || '')) {
          continue;   // a value-only custom-prop write — nothing moved
        }
        // flagged COSMETIC chrome (the editor's preview bars) — the
        // painter stays deaf to it.
        if (vm.type === 'attributes' && vm.attributeName === 'style' &&
            vm.target && vm.target.__projCosmetic === true) {
          continue;
        }
        if (vm.type === 'childList' && vm.target &&
            vm.target.__projCosmetic === true) {
          continue;
        }
        kept.push(vm);
      }
      if (!kept.length) return;         // pure value noise — done
      muts = kept;
      var gest = window.__doomalayGestureAt &&
        (performance.now() - window.__doomalayGestureAt < 200);
      var full = true;
      if (muts.length && rootReg.length) {
        full = false;
        // v0.92.1: motionWorthy — only the mutations that genuinely
        // need the motion window (the tracked-root transform writes,
        // the gesture cascade). A batch whose every mutation was SKIPPED
        // needs NOTHING (the old else-motion kept a 90/s window alive
        // from pure orbit noise).
        var motionWorthy = 0;
        for (var i2 = 0; i2 < muts.length; i2++) {
          var m = muts[i2];
          if (gest && m.type === 'attributes' && m.attributeName === 'style') {
            motionWorthy++;
            continue;   // gesture cascade — rides motion()
          }
          if (m.type === 'attributes' && m.attributeName === 'style' &&
              m.target && m.target.__projWriteEpoch === writeEpoch) {
            continue;   // the painter's OWN write — never self-trigger
          }
          // v0.92.1 ORBIT NOISE: a style write on an element that is
          // NEITHER a tracked projection root NOR a painted window,
          // whose old→new diff is PURE transform/translate, cannot move
          // any box but its own and holds no window to re-anchor —
          // provably inert. Skip entirely.
          if (m.type === 'attributes' && m.attributeName === 'style' &&
              m.target && m.target.__projTracked !== true &&
              m.target.__projPainted !== true) {
            var on92 = m.target.getAttribute('style') || '';
            var oo92 = m.oldValue || '';
            var inert92 = function (s) {
              return s.replace(/(^|;)\s*(transform|translate)\s*:[^;]*/g, ';');
            };
            if (inert92(on92) === inert92(oo92)) {
              continue;   // pure transform on an inert element — skip
            }
          }
          if (m.type !== 'attributes' || m.attributeName !== 'style' ||
              !m.target || m.target.__projTracked !== true) { full = true; break; }
          motionWorthy++;
          var now = m.target.getAttribute('style') || '';
          var old = m.oldValue || '';
          var strip = function (s) {
            // --panel-vis-h joins the motion set — the drag/spring/
            // duck stretch writes it per frame on the panel root.
            return s.replace(/(^|;)\s*(transform|translate|--panel-vis-h)\s*:[^;]*/g, ';');
          };
          if (strip(now) !== strip(old)) { full = true; break; }
        }
        if (!full && !motionWorthy) return;   // pure inert noise — nothing
      }
      if (full) mark(); else motion();
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class'], attributeOldValue: true
    });
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('doomalay:theme-applied', onTheme);
  }
  function unwireObservers() {
    if (obs) { try { obs.disconnect(); } catch (e) {} obs = null; }
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('doomalay:theme-applied', onTheme);
  }
  function onScroll(e) {
    var t = e.target;
    if (t && t.nodeType === 1) {
      var known = false;
      for (var ti = 0; ti < trackedScrollers.length; ti++) {
        if (trackedScrollers[ti] === t) { known = true; break; }
      }
      if (!known && trackedScrollers.length < 12) trackedScrollers.push(t);
    }
    if (!t || t.nodeType !== 1) { mark(); scrollSettle(); return; }
    var nowS = t.scrollTop || 0;
    var lastS = t.__projSy || 0;
    t.__projSy = nowS;
    if (nowS !== lastS) scrollRebake(t, nowS - lastS);
    scrollSettle();
  }
  function onResize() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(function () {
      resizeTimer = 0;
      L2.resizeAll(window.innerWidth + 'px ' + window.innerHeight + 'px');
      mark();
    }, 150);
  }
  function onTheme() {
    // the 120ms trailing theme event — a value flip re-derives the
    // gates (which call repaint on their own) + re-mints the sheet
    SEL = null; POS_SEL = null; memoEpoch++;
    mintDoomSheet();
    mark();
  }

  // ── the scroll path (v0.78.3c): an INCREMENTAL re-bake ──────────
  function scrollRebake(sc, dS) {
    if (!painted.length || !dS) return;
    // v1.09.1 THE DRIFT COAST — during a motion window the anchors go
    // stale BY DESIGN (everything rides rigidly; the settle true-ups).
    // The shrinking slide's scroller clamp fired this per frame — one
    // write per painted window per frame mid-glide. Skipped while
    // coasting; the settle re-anchors.
    if (coasting) return;
    var wep = ++writeEpoch;
    // NEWCOMERS — carried elements that were never baked on-screen.
    // Scrolling them into view raw was the full-gradient-in-a-pill
    // flash; they get a targeted on-the-spot bake (bounded).
    var fresh = [];
    for (var i = 0; i < painted.length; i++) {
      var el = painted[i];
      if (!el.isConnected || !sc.contains(el)) continue;
      if (el.__projBy === undefined || el.__projCarry === true) { fresh.push(el); continue; }
      // v1.08.5 THE COAST — baked text windows ride the content: zero
      // per-scroll-event re-anchor writes (the write storm that made
      // projected text 'extreme lag'). Newcomers still take the targeted
      // on-the-spot bake above (a correct anchor at first sight); the
      // settle paint re-anchors everything.
      if (el.__projClip) continue;
      // sticky/fixed descendants DON'T move with the scroll content
      var pos_ = el.__projPosType;
      if (pos_ === undefined) {
        try { pos_ = getComputedStyle(el).position; } catch (pe) { pos_ = 'static'; }
        el.__projPosType = pos_;
      }
      if (pos_ === 'sticky' || pos_ === 'fixed') continue;
      el.__projBy += dS;
      // the layer path patches its RULE — no inline style
      if (el.__projL2 && L2.rebake(el)) continue;
      var pos = fmtCalc('--proj-tx', el.__projBx) + ' ' + fmtCalcY(el.__projBy);
      if (el.__projPos !== pos) {
        if (el.__projSuppressed) {   // v1.06.3: painter-scoped (the white-pill law)
          restoreAuthorBg(el);       // the author's values come back
          el.__projSuppressed = false;
        }
        el.style.backgroundPosition = pos;
        try { el.setAttribute('data-proj-bake', '1'); } catch (eB4) {}   // v1.05.2: the sweep's marker
        el.__projPos = pos;
        el.__projWriteEpoch = wep;   // painter-owned — the observer skips it
      }
    }
    if (fresh.length) {
      stats.rebakes += fresh.length;
      bakeNewcomers(fresh, wep);
    }
  }
  // the targeted newcomer bake — the same math paint() uses, for the
  // elements that just scrolled into view unbaked.
  function bakeNewcomers(list, wep) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var size = vw + 'px ' + vh + 'px';
    var matrixCache = {};
    var n = 0;
    for (var i = 0; i < list.length && n < 400; i++) {
      var el = list[i];
      if (!el.isConnected) continue;
      el.__projCarry = false;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < -60 || r.top > vh + 60) continue;
      var R = el.__projR;
      if (!R || !rootReg || rootReg.indexOf(R) === -1) continue;
      var M = matrixCache[R.key];
      if (!M) { M = matrixCache[R.key] = readMatrix(R.el); }
      var bx = M.translateOnly ? (-r.left + M.tx) : -r.left;
      var by = M.translateOnly ? (-r.top + M.ty) : -r.top;
      el.__projBx = bx; el.__projBy = by;
      var snapN = (el.__projL2ok === 0) ? null :
        ((el.__projL2 && el.__projL2Epoch === memoEpoch) ? null : L2.snapshot(el));
      if (snapN) el.__projClip = (snapN.clip === 'text') ? 1 : 0;
      if (el.__projL2 && el.__projL2Epoch === memoEpoch) {
        L2.rebake(el);
        el.__projR = R;
        n++;
        continue;
      }
      if (snapN && L2.ok(el, snapN) && L2.bake(el, snapN, bx, by, size, false, memoEpoch, el.__projL2ok)) {
        if (el.__projPos !== undefined) {
          el.style.removeProperty('background-position');
          el.style.removeProperty('background-size');
          el.style.removeProperty('background-attachment');
          el.__projPos = undefined;
          el.__projWriteEpoch = wep;
        }
        el.__projR = R;
        n++;
        continue;
      }
      var pos = fmtCalc('--proj-tx', bx) + ' ' + fmtCalcY(by);
      if (el.__projSuppressed) {   // v1.06.3: painter-scoped (the white-pill law)
        restoreAuthorBg(el);       // the author's values come back
        el.__projSuppressed = false;
      }
      if (el.__projPos !== pos) {
        el.style.backgroundPosition = pos;
        el.__projPos = pos;
        el.__projWriteEpoch = wep;
      }
      if (el.style.backgroundSize !== size) el.style.backgroundSize = size;
      if (el.style.backgroundAttachment !== 'scroll') el.style.backgroundAttachment = 'scroll';
      try { el.setAttribute('data-proj-bake', '1'); } catch (eB5) {}   // v1.05.2: the sweep's marker
      el.__projWriteEpoch = wep;
      el.__projR = R;
      n++;
    }
    stats.baked += n;
  }
  var settleTimer = 0;
  function scrollSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(function () { settleTimer = 0; mark(); }, 150);
  }
  var resizeTimer = 0;

  // CSS transitions don't fire attribute mutations — the transform
  // rides need explicit tracking.
  function onTransition(e) {
    var pn = (e.propertyName || '');
    var onRoot = e.target && e.target.__projTracked === true;
    if (MOVER_RE.test(pn)) {
      if (onRoot && (pn === 'transform' || pn === 'all' || pn === 'translate')) {
        motion();
      } else {
        movingLayout = 5; mark();   // a layout animation — full repaints per frame
      }
    }
  }
  function onTransitionEnd(e) {
    // background-position is the PAINTER'S OWN property — painter-owned
    // noise never re-anchors. COSMETIC transition ends never re-anchor
    // (anchors are GEOMETRY facts). Only GEOMETRY movers still settle.
    if (/^background-position/.test(e.propertyName || '')) return;
    if (!MOVER_RE.test(e.propertyName || '')) return;
    if (window.__doomalayGestureAt &&
        performance.now() - window.__doomalayGestureAt < 200) return;
    mark();
  }

  // ── THE TEARDOWN — the toggle-off restores the local light ─────
  // v1.05.2: STAGE-GUARDED (each stage try/caught — one failure can no
  // longer stop the stages after it and leave a half-torn world) and
  // REGISTRY-INDEPENDENT at the end (the orphan sweep): bakes that left
  // the `painted` registry — the Panel's view-stack stash/restore
  // DETACHES and RE-ATTACHES root DOM (panel.js), resurrecting windows
  // outside every list — die with the toggle too. L2 layers are found
  // by their [data-proj] attributes; legacy inline bakes by the
  // [data-proj-bake] marker minted at bake time.
  function stripInlineBake(el) {
    try {
      el.style.removeProperty('background-position');
      el.style.removeProperty('background-size');
      el.style.removeProperty('background-attachment');
      // v1.06.3 THE PAINTER'S OWN HANDS ONLY — the painter removes what
      // THE PAINTER wrote. The L2 suppression (image/color none
      // !important) is painter-written and flagged (__projSuppressed);
      // an element's OWN inline background (the metadata pills' tint +
      // gradient twin — the [style*=] catchers match its exact spelling)
      // is NOT: the unconditional strip deleted it, the catchers never
      // matched again, and every header pill painted the UA's bare
      // buttonface gray (the white-pill report — rig-reproduced).
      if (el.__projSuppressed) {
        restoreAuthorBg(el);   // v1.06.3: the author's own values come back
        el.__projSuppressed = false;
      }
      el.removeAttribute('data-proj-bake');
    } catch (e) {}
  }
  function teardown() {
    // stage 1 — the painted registry's windows
    try {
      for (var p = 0; p < painted.length; p++) {
        var el = painted[p];
        if (!el) continue;
        if (el.__projL2) {
          L2.drop(el);
        } else {
          stripInlineBake(el);
        }
        el.__projPainted = false;
        el.__projPos = null;
        el.__projScOwner = undefined;
        el.__projAbsBot = undefined;
        el.__projCarry = false;
        el.__projL2ok = undefined;
        el.__projWriteEpoch = ++writeEpoch;   // the teardown's own writes are painter-owned
      }
    } catch (eS1) {}
    painted = [];
    // stage 2 — every remaining L2 layer + the layer sheet
    try {
      var strays = document.querySelectorAll('[data-proj]');
      for (var si = 0; si < strays.length; si++) {
        var sEl = strays[si];
        try { L2.drop(sEl); } catch (eD) {}
        sEl.__projPainted = false;
        sEl.__projL2ok = undefined;
      }
    } catch (eS2) {}
    try { L2.dropAll(); } catch (eS3) {}
    // stage 3 — any legacy inline bake orphaned outside the registry
    try {
      var bakes = document.querySelectorAll('[data-proj-bake]');
      for (var bi = 0; bi < bakes.length; bi++) stripInlineBake(bakes[bi]);
    } catch (eS4) {}
    // stage 4 — the roots: drop the attributes + the var rules
    try {
      for (var r = 0; r < rootReg.length; r++) {
        try { rootReg[r].el.removeAttribute('data-proj-root'); } catch (eR) {}
        rootReg[r].el.__projTracked = false;
      }
    } catch (eS5) {}
    rootReg = [];
    // stage 5 — our sheets
    try { if (varSheet && varSheet.parentNode) varSheet.parentNode.removeChild(varSheet); } catch (eS6) {}
    varSheet = null;
    scrollRules = [];
    trackedScrollers = [];
    try { dropDoomSheet(); } catch (eS7) {}
    // stage 6 — the vis-var residue (gesture.js re-seeds it when the
    // projection returns; the height rule rides the body's inline style)
    try {
      var pEl = document.getElementById('chat-panel');
      if (pEl) pEl.style.removeProperty('--panel-vis-h');
    } catch (eS8) {}
    SEL = null; POS_SEL = null;
    dirty = false; movingRoot = 0; movingLayout = 0; coasting = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (gestRetry) { clearTimeout(gestRetry); gestRetry = 0; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
  }

  // ── v1.05.1 support: the vis-var SEED ────────────────────────────
  // gesture.js (THE GLASS WINDOW) writes --panel-vis-h on the root only
  // while the projection is enabled — the element-scoped body height
  // replaced the per-frame var write for everyone else. Enabling
  // mid-session therefore starts from an UNSET var, and every bottom-
  // anchored window's math (runtime = --proj-ty + flatB + V0 − var)
  // needs var ≡ V0 to cancel. Seed it from the body's inline height —
  // gesture.js's own rest write, IDENTICAL at rest — so the very first
  // bake is anchored; gesture.js overwrites it live during motion.
  // V0 and the var now move in lockstep (V0 = the rest value, the var =
  // the live value; at rest they are the same number by construction).
  function seedVisVar() {
    try {
      var p = document.getElementById('chat-panel');
      var b = p && p.querySelector('.panel-body');
      var h = (b && parseFloat(b.style.height)) || 0;
      if (h > 0) p.style.setProperty('--panel-vis-h', h + 'px');
    } catch (e) {}
  }

  // ── enable / disable ─────────────────────────────────────────────
  // v1.05.2 THE STUCK SWITCH — the old state machine wedged: the enable
  // path set the attribute + minted the sheet + wired observers BEFORE
  // `on = true`, so any throw between them left the VISUALS on with the
  // module believing OFF — and the OFF tap then hit the `want === on`
  // early-return FOREVER ("sometimes does not toggle back off"). And a
  // throw inside teardown() stopped it mid-strip, leaving a half-torn
  // world behind. The new contract:
  //   · COMMIT FIRST — `on` flips before the risky work; a thrown enable
  //     ROLLS BACK (attr off, observers off, teardown) so no half-applied
  //     state survives a single call;
  //   · THE DISABLE PATH NEVER EARLY-RETURNS on DOM traces — if the
  //     attr, the sheets, the observer or the painted set exist, teardown
  //     runs EVEN WHEN `on` already says false (the self-heal);
  //   · teardown() is stage-guarded internally (each stage try/caught)
  //     and always completes the remaining stages.
  function domTraces() {
    return document.documentElement.hasAttribute('data-doom-proj') ||
      painted.length > 0 || obs !== null ||
      !!(varSheet && varSheet.isConnected) ||
      !!(doomSheet && doomSheet.isConnected);
  }
  function setEnabled(v) {
    var want = !!v;
    if (want === on && !domTraces()) return on;
    if (want) {
      on = true;                       // COMMIT FIRST — every guard below stays coherent
      try {
        document.documentElement.setAttribute('data-doom-proj', 'on');
        seedVisVar();
        mintDoomSheet();
        SEL = null; POS_SEL = null; memoEpoch++;
        if (!obs) wireObservers();
        paint();   // the synchronous first bake (the split-flash window is one frame at most)
      } catch (e) {
        console.error('doom projection', e);
        // ROLLBACK — never leave the visuals on with a wedged switch
        try {
          document.documentElement.removeAttribute('data-doom-proj');
          unwireObservers();
          teardown();
        } catch (e2) {}
        on = false;
      }
      return on;
    }
    on = false;
    try { document.documentElement.removeAttribute('data-doom-proj'); } catch (e0) {}
    try { unwireObservers(); } catch (e1) {}
    try { teardown(); } catch (e2) { console.error('doom projection teardown', e2); }
    return on;
  }

  // the boot: honor the stored toggle once the DOM is ready + follow
  // every state change (the Colors-tab switch writes doomProjection)
  function syncFromState() {
    try {
      var s = (window.Settings && window.Settings.getState()) || {};
      var want = !!s.doomProjection;
      if (want !== on) setEnabled(want);
    } catch (e) {}
  }
  function boot() {
    syncFromState();
    try {
      if (window.Settings && window.Settings.onChange) window.Settings.onChange(syncFromState);
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else boot();

  // the API (the legacy names stay — theme.js's GATES call repaint()
  // after every derive; the rigs read stats)
  window.DoomProjection = {
    setEnabled: function (v) { return setEnabled(v); },
    enabled: function () { return on; },
    // v1.09.1 THE DRIFT COAST — the motion window's coast state (the rigs'
    // glide proof reads it per frame; writeVis-style consumers may gate on
    // it later).
    isCoasting: function () { return coasting; },
    repaint: function () {
      if (!on) return;
      SEL = null; POS_SEL = null; memoEpoch++;
      mintDoomSheet();
      paint();
    },
    poke: function () { if (on) mark(); },
    motion: function () { if (on) motion(); },
    paint: function () { if (on) paint(); },
    stats: function () {
      return { on: on, painted: painted.length, roots: rootReg.length };
    },
    // the legacy counter surface (the perf rigs)
    counters: stats
  };
})();
