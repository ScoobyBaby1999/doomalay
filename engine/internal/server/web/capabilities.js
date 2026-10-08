// capabilities.js — v1.17.1 THE PIVOT: the capability library.
//
// Born from the sandbox picker's slot (PLAN-V117 §v1.17.1): the user's
// directive — "Instead of having quick chat, HF chat, and all these. We
// only have quick chat… pressing the +sandbox should instead act as a
// +capabilities overlay screen… the user can stack them".
//
// Renders THE CAPABILITY LIBRARY page on the reusable ConnectOverlay
// (THE CONTAINER LAW — one of the two legal surfaces). A compact
// scrollable list of SMALL-ICON rows (the future "port capabilities +
// list them" library — rows, NOT big cards):
//
//   toggles (bound to the chat session's existing fields — flips ride
//   the EXISTING persistCaps session-PATCH machinery, never a new path):
//     🔍 Web search    web_search   (default ON — the v0.45 default-on)
//     🔬 Deep research deep_research
//     🛠 Library       lib_auto     (the master gate — locksteps the
//                                    legacy template/skills flags, the
//                                    exact semantics of the 🛠 lib pill)
//     ✨ Skills        skills_auto
//     📄 Templates     template_auto
//
//   action rows (open their EXISTING pickers):
//     🎭 Persona       → window.Persona.open (the persona pill's call)
//     ▣ Workspaces     → window.Workspace.openPicker (the +workspace
//                        pill's call; the badge shows the bound count)
//
//   ⌨ Termux — APK builds only (window.__doomalayKotlin present):
//     GET /api/termux/status — a failed fetch or {available:false}
//     renders NO row at all (desktop honesty). When available: the chip
//     reads the setup state (ready → accent; otherwise a tappable
//     "set up…" hint — v1.17.3 wired the row to THE SETUP page), the
//     toggle only arms when ready, and tapping an unready row opens
//     window.TermuxSetup (the three-tap ladder overlay). The capability
//     is inert by default until the device is ready.
//
// Theme vars only, everywhere (the ON chip rides the accent family; the
// OFF chip the surface/text-3 muted family — zero hardcoded colors).
//
// Exposes: window.Capabilities { open, rowsFor, chipFor }
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    if (window.DoomToast) { window.DoomToast(msg); return; }
    if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast(msg);
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  // ── the row list builder (pure — the node rig tests this) ────────────
  // extras: { personaName, wsCount, termux: {available, ready} | null }
  function rowsFor(st, extras) {
    st = st || {};
    extras = extras || {};
    var rows = [
      {
        key: 'web_search', icon: '🔍', name: 'Web search', kind: 'toggle',
        on: st.webSearch !== false, sub: 'live web results in turns'
      },
      {
        key: 'deep_research', icon: '🔬', name: 'Deep research', kind: 'toggle',
        on: !!st.deepResearch, sub: 'multi-source research pipeline'
      },
      {
        key: 'lib_auto', icon: '🛠', name: 'Library', kind: 'toggle',
        on: !!st.libAuto, sub: 'the bot browses + uses the library'
      },
      {
        key: 'skills_auto', icon: '✨', name: 'Skills', kind: 'toggle',
        on: !!st.skillsAuto, sub: 'methodology skills load on their own'
      },
      {
        key: 'template_auto', icon: '📄', name: 'Templates', kind: 'toggle',
        on: !!st.templateAuto, sub: 'the bot browses + applies templates'
      },
      {
        key: 'persona', icon: '🎭', name: 'Persona', kind: 'action',
        sub: extras.personaName ? ('active · ' + extras.personaName) : 'the default prompt',
        chip: { cls: extras.personaName ? 'on' : 'off', text: extras.personaName ? 'set' : 'pick' }
      },
      {
        key: 'workspaces', icon: '▣', name: 'Workspaces', kind: 'action',
        sub: 'cloud repos bound to this chat',
        chip: { cls: (extras.wsCount || 0) > 0 ? 'on' : 'off',
                text: (extras.wsCount == null ? '—' : String(extras.wsCount)) + ' bound' }
      }
    ];
    var ts = extras.termux;
    if (ts && ts.available) {
      rows.push({
        key: 'termux', icon: '⌨', name: 'Termux', kind: 'termux',
        on: !!st.termux, ready: !!ts.ready,
        sub: st.termux ? 'stacked on this chat · tap to remove'
          : (ts.ready ? 'tap to stack on this chat' : 'three taps to a real Linux shell'),
        chip: { cls: ts.ready ? 'on' : 'setup', text: ts.ready ? 'ready' : 'set up…' }
      });
    }
    return rows;
  }

  // chipFor — the ON/OFF chip a toggle row renders (pure).
  function chipFor(row) {
    if (row.kind === 'toggle') {
      return row.on
        ? { cls: 'on', text: 'on' }
        : { cls: 'off', text: 'off' };
    }
    return row.chip || { cls: 'off', text: '—' };
  }

  // termuxRowState — the desktop-honesty gate (pure): a failed fetch, a
  // malformed/empty status, or {available:false} → NO row at all; only an
  // explicit available:true renders (ready drives the gated toggle).
  function termuxRowState(status, st) {
    if (!status || status.available !== true) return null;
    return { available: true, ready: !!status.ready, on: !!st.termux };
  }

  // ── row markup (theme vars only) ─────────────────────────────────────
  function chipHTML(row) {
    var c = chipFor(row);
    return '<span class="cap-chip ' + c.cls + '" id="cap-chip-' + row.key + '">' +
      esc(c.text) + '</span>';
  }

  function rowHTML(row) {
    return '<div class="cap-row" data-cap="' + row.key + '" role="button" tabindex="0" ' +
      'aria-label="' + esc(row.name) + ' capability">' +
      '<span class="cap-ico">' + row.icon + '</span>' +
      '<span class="cap-mid">' +
        '<span class="cap-name">' + esc(row.name) + '</span>' +
        '<span class="cap-desc" id="cap-sub-' + row.key + '">' + esc(row.sub) + '</span>' +
      '</span>' +
      chipHTML(row) +
    '</div>';
  }

  function pageHTML(st, extras) {
    var rows = rowsFor(st, extras);
    return '<div class="cap-page">' +
      '<div class="cap-head">' +
        '<span class="cap-title">Capabilities</span>' +
        '<span class="cap-sub">stack what this chat can do</span>' +
      '</div>' +
      '<div class="cap-list" id="cap-list">' +
        rows.map(rowHTML).join('') +
      '</div>' +
      '<div class="cap-foot">toggles persist on this chat — stack only what you need</div>' +
    '</div>';
  }

  // ── the active persona name (the persona pill's own resolver) ────────
  function activePersonaName(ctx) {
    var st = ctx && ctx.state;
    try {
      if (window.Persona && window.Persona.resolveActive) {
        var act = window.Persona.resolveActive(st.personas || [], st.persona || '', {},
          { name: (ctx.icon && ctx.icon.name) || '' });
        return (act && act.name) || '';
      }
    } catch (e) { /* resolver absent — the default prompt shape */ }
    return '';
  }

  // ── persistence: the EXISTING session-PATCH machinery ────────────────
  // persistCaps (the caps PATCH the toolbar pills always used) + the
  // host re-render so the underlying pills/toolbar follow the flip.
  function persist(ctx) {
    if (window.ChatPanel && window.ChatPanel.persistCaps) {
      try { window.ChatPanel.persistCaps(ctx.state); } catch (e) { console.error(e); }
    }
    if (ctx.rerender) { try { ctx.rerender(); } catch (e) { console.error(e); } }
  }

  // flipToggle — flips the boolean on the chat state exactly the way the
  // toolbar's own pills do (the lib gate locksteps the legacy flags).
  function flipToggle(st, key) {
    if (key === 'web_search') st.webSearch = !st.webSearch;
    else if (key === 'deep_research') st.deepResearch = !st.deepResearch;
    else if (key === 'lib_auto') {
      st.libAuto = !st.libAuto;
      // keep the legacy flags in lockstep (the 🛠 lib pill's semantics)
      st.templateAuto = st.libAuto;
      st.skillsAuto = st.libAuto;
      // ONE SETTING, TWO VIEWS — the ✦ tweaks Bot Library switch follows
      if (window.ChatTweaks && window.ChatTweaks.syncLibPill) {
        window.ChatTweaks.syncLibPill(st, st.libAuto);
      }
    }
    else if (key === 'skills_auto') st.skillsAuto = !st.skillsAuto;
    else if (key === 'template_auto') st.templateAuto = !st.templateAuto;
  }

  // ── action rows ──────────────────────────────────────────────────────
  // Persona: the exact call the chat's 🎭 persona pill makes (the picker
  // rides the MASTER PANEL's view stack — close this overlay first so it
  // isn't hidden underneath).
  function openPersona(ctx) {
    var st = ctx.state, icon = ctx.icon;
    if (st.sessionId && window.Persona) {
      window.ConnectOverlay.close();
      window.Persona.open(st.sessionId, {
        name: (icon && icon.name) || '', model: st.model, provider: st.provider
      });
    } else {
      toast('connect a model first');
    }
  }

  // Workspaces: the exact call the +workspace pill makes (a live session
  // getter — the session can land after this overlay opened).
  function openWorkspaces(ctx) {
    if (window.Workspace && window.Workspace.openPicker) {
      window.Workspace.openPicker(function () {
        return (ctx.state && ctx.state.sessionId) || null;
      }, null);
    } else {
      toast('workspaces are not available');
    }
  }

  // Termux: ready → the gated toggle stacks the capability onto the
  // chat (session.termux, the existing PATCH machinery); unready →
  // THE SETUP page (v1.17.3's window.TermuxSetup, nested on this
  // overlay — the Android back gesture pops back to the library, and
  // the row re-probes into its ready state through onExit).
  function onTermuxTap(ctx, extras) {
    var st = ctx.state;
    var ts = termuxRowState(extras.termux, st);
    if (!ts || !ts.ready) {
      openTermuxSetup(ctx, extras);
      return;
    }
    st.termux = !st.termux;
    persist(ctx);
    repaintTermuxRow(ctx, extras);
  }

  // openTermuxSetup — the v1.17.3 setup overlay (the "set up…" chip and
  // the unready row both land here). onExit fires when the setup page
  // dies (close / back-pop) → force a fresh status probe so the row
  // flips to its ready state the moment the bridge confirms it.
  function openTermuxSetup(ctx, extras) {
    if (window.TermuxSetup && window.TermuxSetup.open) {
      window.TermuxSetup.open(ctx, {
        onExit: function () { probeTermux(ctx, extras, true); }
      });
    } else {
      toast('Termux needs setup first');
    }
  }

  // ── chip/sub repaint (optimistic, in place — the page never rebuilds) ─
  function repaintAll(ctx, extras) {
    var rows = rowsFor(ctx.state, extras);
    for (var i = 0; i < rows.length; i++) {
      repaintRow(rows[i]);
    }
  }

  function repaintRow(row) {
    var chipEl = document.getElementById('cap-chip-' + row.key);
    if (chipEl) {
      var c = chipFor(row);
      chipEl.className = 'cap-chip ' + c.cls;
      chipEl.textContent = c.text;
    }
    var subEl = document.getElementById('cap-sub-' + row.key);
    if (subEl) subEl.textContent = row.sub;
  }

  function repaintTermuxRow(ctx, extras) {
    var rows = rowsFor(ctx.state, extras);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === 'termux') repaintRow(rows[i]);
    }
  }

  // ── the page wiring (onSwap contract) ────────────────────────────────
  function wire(ctx, extras) {
    var contentEl = window.ConnectOverlay.getContentEl();
    contentEl.querySelectorAll('.cap-row').forEach(function (row) {
      var tap = function () {
        var key = row.getAttribute('data-cap');
        var st = ctx.state;
        if (key === 'persona') { openPersona(ctx); return; }
        if (key === 'workspaces') { openWorkspaces(ctx); return; }
        if (key === 'termux') { onTermuxTap(ctx, extras); return; }
        flipToggle(st, key);
        repaintAll(ctx, extras);
        persist(ctx);
      };
      row.addEventListener('click', tap);
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(); }
      });
    });
  }

  // ── the Termux status probe (APK only — lazily, only when visible) ───
  // force=true rides ?refresh=1 (the post-setup re-probe: the engine's
  // probe cache must not hold the stale not-ready answer).
  // v1.17.5 redteam seam (the ONE sanctioned dev/test hook): the APK gate
  // also accepts a ?apk=1 URL param so a desktop browser E2E can exercise
  // the row — the row still requires /api/termux/status available:true,
  // so without a live bridge nothing renders.
  function apkGate() {
    if (window.__doomalayKotlin) return true;
    try {
      return /[?&]apk=1(?![a-z0-9])/i.test(String((window.location && window.location.search) || ''));
    } catch (e) { return false; }
  }

  function probeTermux(ctx, extras, force) {
    if (!apkGate()) return;   // the APK marker — desktop never asks
    getJSON('/api/termux/status' + (force ? '?refresh=1' : '')).then(function (status) {
      var ts = termuxRowState(status, ctx.state);
      // failed probe / {available:false} → NO row at all (desktop honesty)
      if (!ts) return;
      extras.termux = ts;
      if (!window.ConnectOverlay.isOpen()) return;
      var listEl = document.getElementById('cap-list');
      if (!listEl) return;
      var old = listEl.querySelector('[data-cap="termux"]');
      if (old) old.parentNode.removeChild(old);
      var holder = document.createElement('div');
      holder.innerHTML = rowHTML(rowsFor(ctx.state, extras).filter(function (r) {
        return r.key === 'termux';
      })[0]);
      listEl.appendChild(holder.firstChild);
      var row = listEl.querySelector('[data-cap="termux"]');
      if (!row) return;
      var tap = function () { onTermuxTap(ctx, extras); };
      row.addEventListener('click', tap);
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(); }
      });
    }).catch(function () { /* no bridge → no row */ });
  }

  // ── the bound-workspace count (the +workspace badge's own fetch) ─────
  function probeWorkspaceCount(ctx, extras) {
    var st = ctx.state;
    if (!st.sessionId) return;
    fetch('/api/sessions/' + encodeURIComponent(st.sessionId) + '/workspaces')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        extras.wsCount = (d && d.workspaces || []).length;
        if (!window.ConnectOverlay.isOpen()) return;
        var rows = rowsFor(st, extras);
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].key === 'workspaces') repaintRow(rows[i]);
        }
      }).catch(function () { /* count stays unknown */ });
  }

  // ── open(ctx) — THE CAPABILITY LIBRARY on the ConnectOverlay ────────
  // ctx: the chatpanel context (the same shape the gatelock/pills hold).
  function open(ctx, opts) {
    if (!ctx || !ctx.state) return;
    ensureStyles();
    var extras = { personaName: activePersonaName(ctx), wsCount: null, termux: null };
    window.ConnectOverlay.open(pageHTML(ctx.state, extras), {
      onSwap: function () { wire(ctx, extras); }
    });
    probeWorkspaceCount(ctx, extras);
    probeTermux(ctx, extras);
  }

  // ── styles (injected once — theme vars only, the wsx row idioms) ─────
  function ensureStyles() {
    if (typeof document === 'undefined' || !document.getElementById || !document.head) return;
    if (document.getElementById('cap-v1171-styles')) return;
    var s = document.createElement('style');
    s.id = 'cap-v1171-styles';
    s.textContent =
      '.cap-page{font-size:var(--ui-fs);color:var(--text-1);padding-bottom:8px}' +
      // the header keeps the top-right 44px clear of the static ✕
      '.cap-head{display:flex;flex-direction:column;gap:2px;padding:16px 48px 10px 16px;' +
        'border-bottom:1px solid var(--surface-2)}' +
      '.cap-title{font-size:calc(var(--ui-fs) + 1px);font-weight:700;color:var(--text-1)}' +
      '.cap-sub{font-size:var(--ui-small-fs);color:var(--text-3)}' +
      // the compact scrollable list (thin themed scrollbar — the
      // #chat-scroll / #mb-list pattern)
      '.cap-list{max-height:56vh;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
        'touch-action:pan-y;padding:8px 10px 4px;scrollbar-width:thin;' +
        'scrollbar-color:var(--border-strong) transparent}' +
      '.cap-list::-webkit-scrollbar{width:5px}' +
      '.cap-list::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:3px}' +
      '.cap-list::-webkit-scrollbar-track{background:transparent}' +
      // the small-icon rows (compact — the future capability library)
      '.cap-row{display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 10px;' +
        'margin-bottom:6px;border-radius:12px;border:1px solid var(--surface-2);' +
        'background:var(--surface-1);cursor:pointer;-webkit-tap-highlight-color:transparent;' +
        'touch-action:manipulation;transition:border-color 0.15s}' +
      '.cap-row:active{border-color:rgba(var(--accent-rgb),0.55)}' +
      '.cap-ico{flex-shrink:0;width:26px;height:26px;border-radius:8px;display:flex;' +
        'align-items:center;justify-content:center;font-size:14px;' +
        'background:rgba(var(--accent-rgb),0.08);border:1px solid rgba(var(--accent-rgb),0.25)}' +
      '.cap-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}' +
      '.cap-name{font-weight:600;font-size:var(--ui-small-fs);color:var(--text-1);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.cap-desc{font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      // the state chip — ON/ready rides the accent family, OFF stays muted
      '.cap-chip{flex-shrink:0;max-width:40%;font-size:calc(var(--ui-small-fs) - 2px);' +
        'font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.cap-chip.on{color:var(--accent);border-color:rgba(var(--accent-rgb),0.45);' +
        'background:rgba(var(--accent-rgb),0.15)}' +
      // v1.17.3: the unready Termux chip is a tappable "set up…" hint —
      // a lighter accent tint (actionable, not yet achieved)
      '.cap-chip.setup{color:var(--accent);border-color:rgba(var(--accent-rgb),0.35);' +
        'background:rgba(var(--accent-rgb),0.08)}' +
      '.cap-chip.off{color:var(--text-3);border-color:var(--border);background:var(--surface-2)}' +
      '.cap-foot{font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3-dim);' +
        'padding:2px 16px 10px;text-align:center}';
    document.head.appendChild(s);
  }
  if (typeof document !== 'undefined' && document.getElementById && document.head) {
    ensureStyles();
  }

  if (typeof window !== 'undefined') {
    window.Capabilities = { open: open, rowsFor: rowsFor, chipFor: chipFor, termuxRowState: termuxRowState };
  }

  // v1.17.1: the node test path (scripts/v1171-pivot-test.js) — the pure
  // row builders, exported the same way chatpanel.js does.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { rowsFor: rowsFor, chipFor: chipFor, termuxRowState: termuxRowState };
  }
})();
