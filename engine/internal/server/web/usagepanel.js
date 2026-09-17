// usagepanel.js — v0.21→v0.27 the USAGE + COST view, on the master
// panel's view stack (was: the broken standalone overlay → the v0.26
// Sheet → now the one true panel).
//
// The user's original spec (v0.26) still holds — a real title bar, a
// working close, Android gestures, a fleet view that opens — it's just
// that the master panel provides all of that natively now: ‹ back pops
// to the chat, ✕ drops every view, drag/fling closes the panel, and the
// back gesture pops one view at a time.
//
// The context bar here and the RING + COST meters in the chat header
// (chatpanel.js renderHeader) read the same endpoint —
// GET /api/sessions/{id}/usage — two front-facing elements, one method.
//
// Exposes: window.UsagePanel = { open, close }
(function () {
  'use strict';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmtTokens(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function fmtCost(u) {
    if (!u || !u.hasCost) return '';
    var c = Number(u.cost || 0);
    return c < 0.01 && c > 0 ? '$' + c.toFixed(4) : '$' + c.toFixed(2);
  }

  function statCell(val, label, color) {
    return '<div style="flex:1;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:10px;text-align:center;min-width:0">' +
      '<div style="font-size:calc(var(--ui-fs) + 3px);font-weight:700;color:' + (color || 'var(--text-1)') + '">' + val + '</div>' +
      '<div style="font-size:var(--ui-micro-fs);color:var(--text-3);margin-top:2px">' + label + '</div>' +
    '</div>';
  }
  function modelRow(m) {
    var cost = fmtCost(m);
    return '<div style="display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px">' +
        '<span style="flex:1;min-width:0;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(String(m.model || '').split('/').pop()) + '</span>' +
        '<span style="font-size:var(--ui-micro-fs);color:var(--text-3);flex-shrink:0">' + (m.turns || 0) + ' turns</span>' +
        '<span style="font-size:var(--ui-micro-fs);color:var(--text-2);flex-shrink:0">↑' + fmtTokens(m.tokensIn) + ' ↓' + fmtTokens(m.tokensOut) + '</span>' +
        (cost ? '<span style="font-size:var(--ui-micro-fs);color:var(--warn);flex-shrink:0">' + cost + '</span>' : '') +
      '</div>';
  }

  // the context-fill color ladder — shared by the bar here AND the header
  // ring (same method, two UI elements; the ring shifts one band earlier
  // so it warns as it CLIMBS toward the compaction point at 70%).
  function barColor(fill) {
    return fill > 85 ? 'var(--err)' : fill > 65 ? 'var(--warn)' : 'var(--ok)';
  }
  function ringColor(fill) {
    return fill >= 70 ? 'var(--err)' : fill >= 50 ? 'var(--warn)' : 'var(--accent)';
  }

  function open(panel, u, opts) {
    if (!panel) return;
    opts = opts || {};
    var t = (u && u.totals) || {};
    var ctx = (u && u.context) || {};
    var models = (u && u.models) || [];

    var modelRows = models.map(modelRow).join('');

    var fill = Math.max(0, Math.min(100, ctx.fillPct || 0));
    var fillColor = barColor(fill);

    panel.pushView({
      title: 'usage · ' + (opts.name || 'chat'),
      render: function () {
        return (
          '<div style="display:flex;gap:8px">' +
            statCell(fmtTokens(t.tokensIn), 'tokens in') +
            statCell(fmtTokens(t.tokensOut), 'tokens out') +
            statCell(t.hasCost ? fmtCost(t) : '—', t.hasCost ? 'est. cost' : 'unpriced', t.hasCost ? 'var(--warn)' : 'var(--text-3)') +
          '</div>' +
          '<div style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:12px;margin-top:12px">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px;gap:8px">' +
              '<span style="font-size:calc(var(--ui-small-fs) - 0.5px);font-weight:600;color:var(--text-1);flex-shrink:0">context</span>' +
              '<span style="font-size:var(--ui-micro-fs);color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(String(ctx.model || '').split('/').pop() || '') + ' · ' + fmtTokens(ctx.usedTokens) + ' / ~' + fmtTokens(ctx.limit) + ' tok</span>' +
            '</div>' +
            '<div style="height:8px;background:var(--bg-app);border-radius:4px;overflow:hidden">' +
              '<div style="height:100%;width:' + fill + '%;background:' + fillColor + ';border-radius:4px;transition:width 0.4s ease"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;margin-top:6px">' +
              '<span style="font-size:var(--ui-micro-fs);color:var(--text-3)">' + fill + '% used</span>' +
              '<span style="font-size:var(--ui-micro-fs);color:' + (ctx.compacted ? 'var(--accent)' : 'var(--text-3)') + '">' + (ctx.compacted ? 'auto-compacted ✓' : 'auto-compact arms at 70%') + '</span>' +
            '</div>' +
          '</div>' +
          (modelRows ? '<div class="pv-section-label">by model</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px">' + modelRows + '</div>' : '') +
          '<button id="usage-fleet" class="pv-btn" style="width:100%;margin-top:14px">⧗ all chats (fleet totals)</button>' +
          '<p style="font-size:var(--ui-micro-fs);color:var(--text-3-dim);line-height:1.5;text-align:center;margin-top:10px">tokens are read from each provider\'s usage reports · costs are published list rates (NVIDIA dev tier is free) · estimates never replace real bills</p>'
        );
      },
      onMount: function (el) {
        var fleet = el.querySelector('#usage-fleet');
        if (fleet) fleet.addEventListener('click', function () {
          fleet.textContent = '⧗ loading…';
          fetch('/api/usage').then(function (r) { return r.json(); }).then(function (fu) {
            openFleet(panel, fu, opts);
          }).catch(function () { fleet.textContent = '⧗ fleet unavailable'; });
        });
      }
    });
  }

  function openFleet(panel, fu, opts) {
    if (!fu) return;
    var t = fu.totals || {};
    var provs = fu.providers || {};
    var rows = '';
    Object.keys(provs).sort().forEach(function (k) {
      var p = provs[k];
      rows +=
        '<div style="display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px">' +
          '<span style="flex:1;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-1)">' + esc(k) + '</span>' +
          '<span style="font-size:var(--ui-micro-fs);color:var(--text-3)">' + (p.turns || 0) + ' turns</span>' +
          '<span style="font-size:var(--ui-micro-fs);color:var(--text-2)">↑' + fmtTokens(p.tokensIn) + ' ↓' + fmtTokens(p.tokensOut) + '</span>' +
          (p.hasCost ? '<span style="font-size:var(--ui-micro-fs);color:var(--warn)">' + fmtCost(p) + '</span>' : '') +
        '</div>';
    });
    panel.pushView({
      title: 'fleet · all chats',
      render: function () {
        return (
          '<div style="display:flex;gap:8px">' +
            statCell(fmtTokens(t.tokensIn), 'tokens in · all chats') +
            statCell(fmtTokens(t.tokensOut), 'tokens out') +
            statCell(t.hasCost ? fmtCost(t) : '—', 'est. cost', t.hasCost ? 'var(--warn)' : 'var(--text-3)') +
          '</div>' +
          '<div class="pv-section-label">' + (fu.sessions || 0) + ' chats · by provider</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px">' + (rows || '<div class="art-loading" style="padding:14px">no usage recorded yet</div>') + '</div>'
        );
      }
    });
  }

  // ringColor is exported for the header meters (chatpanel.js) so the
  // ring and the bar always agree on the ladder.
  window.UsagePanel = {
    open: open,
    ringColor: ringColor,
    close: function () {
      var c = window.ChatPanel && window.ChatPanel.current();
      if (c && c.panel) c.panel.closeViews();
    }
  };
})();
