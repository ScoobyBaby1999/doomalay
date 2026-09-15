// usagepanel.js — v0.21 the USAGE + COST panel (⧗ usage pill).
//
// Ports the HF space's metrics concept into the quick chat: the REAL
// token usage every provider reported (persisted in each turn's terminal
// status event), the context fill against the model's window, the
// auto-compact state, and list-price cost estimates per model —
// unpriced models show tokens without inventing dollars.
//
// Exposes: window.UsagePanel = { open }
(function () {
  'use strict';

  var overlayEl = null;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmtTokens(n) {
    n = Number(n || 0);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function fmtCost(u) {
    if (!u || !u.hasCost) return '';
    var c = Number(u.cost || 0);
    return c < 0.01 && c > 0 ? '$' + c.toFixed(4) : '$' + c.toFixed(2);
  }

  function close() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  function open(u, opts) {
    close();
    opts = opts || {};
    var t = (u && u.totals) || {};
    var ctx = (u && u.context) || {};
    var models = (u && u.models) || [];

    var modelRows = '';
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var cost = fmtCost(m);
      modelRows +=
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#14141a;border:1px solid #1a1a22;border-radius:10px">' +
          '<span style="flex:1;min-width:0;font-size:11.5px;color:#e0e0e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(String(m.model || '').split('/').pop()) + '</span>' +
          '<span style="font-size:10.5px;color:#71717a;flex-shrink:0">' + (m.turns || 0) + ' turns</span>' +
          '<span style="font-size:10.5px;color:#a1a1aa;flex-shrink:0">↑' + fmtTokens(m.tokensIn) + ' ↓' + fmtTokens(m.tokensOut) + '</span>' +
          (cost ? '<span style="font-size:10.5px;color:#E8B44A;flex-shrink:0">' + cost + '</span>' : '') +
        '</div>';
    }

    var fill = Math.max(0, Math.min(100, ctx.fillPct || 0));
    var fillColor = fill > 85 ? '#f87171' : fill > 65 ? '#E8B44A' : '#34d399';

    var html =
      '<div style="position:fixed;inset:0;z-index:3300;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px">' +
        '<div style="width:100%;max-width:420px;max-height:80vh;overflow-y:auto;background:#0e0e12;border:1px solid #1a1a22;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,0.6);-webkit-overflow-scrolling:touch">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #1a1a22;position:sticky;top:0;background:#0e0e12;z-index:1">' +
            '<div style="font-size:14px;font-weight:700;color:#e0e0e8">usage · ' + esc(opts.name || 'chat') + '</div>' +
            '<button id="usage-close" style="background:transparent;border:none;color:#71717a;font-size:20px;cursor:pointer;padding:4px 8px">✕</button>' +
          '</div>' +
          '<div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">' +
            // totals
            '<div style="display:flex;gap:8px">' +
              '<div style="flex:1;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:10px;text-align:center">' +
                '<div style="font-size:17px;font-weight:700;color:#e0e0e8">' + fmtTokens(t.tokensIn) + '</div>' +
                '<div style="font-size:10px;color:#71717a;margin-top:2px">tokens in</div>' +
              '</div>' +
              '<div style="flex:1;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:10px;text-align:center">' +
                '<div style="font-size:17px;font-weight:700;color:#e0e0e8">' + fmtTokens(t.tokensOut) + '</div>' +
                '<div style="font-size:10px;color:#71717a;margin-top:2px">tokens out</div>' +
              '</div>' +
              '<div style="flex:1;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:10px;text-align:center">' +
                '<div style="font-size:17px;font-weight:700;color:' + (t.hasCost ? '#E8B44A' : '#71717a') + '">' + (t.hasCost ? fmtCost(t) : '—') + '</div>' +
                '<div style="font-size:10px;color:#71717a;margin-top:2px">' + (t.hasCost ? 'est. cost' : 'unpriced') + '</div>' +
              '</div>' +
            '</div>' +
            // context fill
            '<div style="background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:12px">' +
              '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px">' +
                '<span style="font-size:11.5px;font-weight:600;color:#e0e0e8">context</span>' +
                '<span style="font-size:10.5px;color:#71717a">' + esc(String(ctx.model || '').split('/').pop() || '') + ' · ' + fmtTokens(ctx.usedTokens) + ' / ~' + fmtTokens(ctx.limit) + ' tok</span>' +
              '</div>' +
              '<div style="height:8px;background:#0a0a0e;border-radius:4px;overflow:hidden">' +
                '<div style="height:100%;width:' + fill + '%;background:' + fillColor + ';border-radius:4px;transition:width 0.4s ease"></div>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-top:6px">' +
                '<span style="font-size:10px;color:#71717a">' + fill + '% used</span>' +
                '<span style="font-size:10px;color:' + (ctx.compacted ? '#a78bfa' : '#71717a') + '">' + (ctx.compacted ? 'auto-compacted ✓' : 'auto-compact arms at 70%') + '</span>' +
              '</div>' +
            '</div>' +
            // per-model
            (modelRows ? '<div><div style="font-size:11px;font-weight:600;color:#e0e0e8;margin:2px 0 6px">by model</div>' +
              '<div style="display:flex;flex-direction:column;gap:6px">' + modelRows + '</div></div>' : '') +
            // fleet link
            '<button id="usage-fleet" style="background:transparent;border:1px solid #2a2a35;color:#71717a;padding:8px 12px;border-radius:8px;font-size:11px;font-family:inherit;cursor:pointer;width:100%">⧗ all chats (fleet totals)</button>' +
            '<div style="font-size:9.5px;color:#52525b;line-height:1.5;text-align:center">tokens are read from each provider\'s usage reports · costs are published list rates (NVIDIA dev tier is free) · estimates never replace real bills</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    overlayEl = document.createElement('div');
    overlayEl.id = 'usage-overlay';
    overlayEl.innerHTML = html;
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) close();
    });
    document.body.appendChild(overlayEl);

    overlayEl.querySelector('#usage-close').addEventListener('click', close);
    overlayEl.querySelector('#usage-fleet').addEventListener('click', function () {
      fetch('/api/usage').then(function (r) { return r.json(); }).then(function (fu) {
        openFleet(fu, opts);
      }).catch(function () {});
    });
  }

  function openFleet(fu, opts) {
    if (!fu) return;
    var t = fu.totals || {};
    var provs = fu.providers || {};
    var rows = '';
    Object.keys(provs).sort().forEach(function (k) {
      var p = provs[k];
      rows +=
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#14141a;border:1px solid #1a1a22;border-radius:10px">' +
          '<span style="flex:1;font-size:11.5px;color:#e0e0e8">' + esc(k) + '</span>' +
          '<span style="font-size:10.5px;color:#71717a">' + (p.turns || 0) + ' turns</span>' +
          '<span style="font-size:10.5px;color:#a1a1aa">↑' + fmtTokens(p.tokensIn) + ' ↓' + fmtTokens(p.tokensOut) + '</span>' +
          (p.hasCost ? '<span style="font-size:10.5px;color:#E8B44A">' + fmtCost(p) + '</span>' : '') +
        '</div>';
    });
    if (overlayEl) {
      var body = overlayEl.querySelector('div > div > div:nth-child(2)');
      if (body) {
        body.innerHTML =
          '<div style="display:flex;gap:8px;margin-bottom:12px">' +
            '<div style="flex:1;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:10px;text-align:center"><div style="font-size:17px;font-weight:700;color:#e0e0e8">' + fmtTokens(t.tokensIn) + '</div><div style="font-size:10px;color:#71717a">tokens in · all chats</div></div>' +
            '<div style="flex:1;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:10px;text-align:center"><div style="font-size:17px;font-weight:700;color:#e0e0e8">' + fmtTokens(t.tokensOut) + '</div><div style="font-size:10px;color:#71717a">tokens out</div></div>' +
            '<div style="flex:1;background:#14141a;border:1px solid #1a1a22;border-radius:10px;padding:10px;text-align:center"><div style="font-size:17px;font-weight:700;color:' + (t.hasCost ? '#E8B44A' : '#71717a') + '">' + (t.hasCost ? fmtCost(t) : '—') + '</div><div style="font-size:10px;color:#71717a">est. cost</div></div>' +
          '</div>' +
          '<div style="font-size:11px;font-weight:600;color:#e0e0e8;margin:2px 0 6px">' + (fu.sessions || 0) + ' chats · by provider</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px">' + rows + '</div>' +
          '<button id="usage-back" style="margin-top:12px;background:transparent;border:1px solid #2a2a35;color:#71717a;padding:8px 12px;border-radius:8px;font-size:11px;font-family:inherit;cursor:pointer;width:100%">‹ back to this chat</button>';
        overlayEl.querySelector('#usage-back').addEventListener('click', function () {
          fetch('/api/sessions/' + (opts.sessionId || '') + '/usage').then(function (r) { return r.json(); }).then(function (u) { open(u, opts); }).catch(function () {});
        });
      }
    }
  }

  window.UsagePanel = { open: open, close: close };
})();
