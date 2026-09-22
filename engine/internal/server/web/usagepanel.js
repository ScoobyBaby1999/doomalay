// usagepanel.js — v0.21→v0.27 the USAGE + COST view, on the master
// panel's view stack (was: the broken standalone overlay → the v0.26
// Sheet → now the one true panel).
//
// v0.34 LIVE NUMBERS (user spec): "the usage screen should update even
// when the user is on it — the numbers inside should update while the
// user looks at the screen as usage is consumed dynamically." The view
// now polls its endpoint every 2.5s while mounted and patches the DOM
// in place (totals cells, context bar, per-model rows) — no re-render,
// no scroll jump, nothing flickers. The poll dies with the view: the
// panel's onClose hook fires on pop / ✕ / panel close, and each tick
// also bails if the root got detached some other way.
//
// The context bar here and the RING + COST meters in the chat header
// (chatpanel.js renderHeader) read the same endpoint —
// GET /api/sessions/{id}/usage — two front-facing elements, one method.
//
// Exposes: window.UsagePanel = { open, close }
(function () {
  'use strict';

  var POLL_MS = 2500;

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

  function statCell(val, label, color, id) {
    return '<div style="flex:1;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:10px;text-align:center;min-width:0">' +
      '<div' + (id ? ' id="' + id + '"' : '') + ' style="font-size:calc(var(--ui-fs) + 3px);font-weight:700;color:' + (color || 'var(--text-1)') + '">' + val + '</div>' +
      '<div style="font-size:var(--ui-micro-fs);color:var(--text-3);margin-top:2px">' + label + '</div>' +
    '</div>';
  }
  function modelRow(m) {
    var cost = fmtCost(m);
    return '<div data-usmodel="' + esc(String(m.model || '')) + '" style="display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px">' +
        '<span style="flex:1;min-width:0;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(String(m.model || '').split('/').pop()) + '</span>' +
        '<span style="font-size:var(--ui-micro-fs);color:var(--text-3);flex-shrink:0">' + (m.turns || 0) + ' turns</span>' +
        '<span style="font-size:var(--ui-micro-fs);color:var(--text-2);flex-shrink:0">↑' + fmtTokens(m.tokensIn) + ' ↓' + fmtTokens(m.tokensOut) + '</span>' +
        (cost ? '<span style="font-size:var(--ui-micro-fs);color:var(--warn);flex-shrink:0">' + cost + '</span>' : '') +
      '</div>';
  }

  // THE ONE CONTEXT-COLOR LADDER (v0.30 user spec) — every front-facing
  // element that shows the compaction progress asks THIS function: the
  // context bar here, the header RING (chatpanel.js applyMeters), the
  // ring's tooltip. It reads the chat's OWN compaction settings (the same
  // values the mind panel PATCHes — compactThreshold / compactEnabled from
  // the usage endpoint), so a threshold moved to 80% or compaction turned
  // off shows up everywhere at once, from one method.
  function ctxColor(fill, ctx) {
    var thr = (ctx && typeof ctx.compactThreshold === 'number')
      ? Math.max(10, Math.min(95, ctx.compactThreshold)) : 70;
    if (ctx && ctx.compactEnabled === false) {
      return fill >= 85 ? 'var(--notice)' : fill >= 50 ? 'var(--warn)' : 'var(--accent)';
    }
    return fill >= thr ? 'var(--err)'
      : fill >= Math.max(20, thr - 20) ? 'var(--warn)'
      : 'var(--accent)';
  }
  function ringColor(fill, ctx) { return ctxColor(fill, ctx); }

  // ── v0.34: the LIVE patcher ─────────────────────────────────────────
  // Applies a fresh usage payload to the OPEN view without re-rendering:
  // stat cells, the context bar + its lines, and the model rows (the row
  // set is keyed by model name — an unchanged set updates its numbers in
  // place; a new/removed model rebuilds only that inner container).
  function patchUsageView(el, u) {
    if (!el || !el.isConnected) return;
    var t = (u && u.totals) || {};
    var ctx = (u && u.context) || {};

    var set = function (id, val) {
      var n = el.querySelector('#' + id);
      if (n && n.textContent !== val) n.textContent = val;
    };
    set('us-in', fmtTokens(t.tokensIn));
    set('us-out', fmtTokens(t.tokensOut));
    set('us-cost', t.hasCost ? fmtCost(t) : '—');

    var fill = Math.max(0, Math.min(100, ctx.fillPct || 0));
    var bar = el.querySelector('#us-ctx-fill');
    if (bar) {
      bar.style.width = fill + '%';
      bar.style.background = ctxColor(fill, ctx);
    }
    set('us-ctx-model', esc(String(ctx.model || '').split('/').pop() || '') + ' · ' +
      fmtTokens(ctx.usedTokens) + ' / ~' + fmtTokens(ctx.limit) + ' tok');
    set('us-ctx-pct', fill + '% used');
    var note = el.querySelector('#us-ctx-note');
    if (note) {
      var compactOff = ctx.compactEnabled === false;
      var compactThr = (typeof ctx.compactThreshold === 'number')
        ? Math.max(10, Math.min(95, ctx.compactThreshold)) : 70;
      var txt = (ctx.compacted ? 'auto-compacted ✓' :
        compactOff ? 'auto-compact off — context fills unchecked' :
        'auto-compact arms at ' + compactThr + '%');
      if (note.textContent !== txt) {
        note.textContent = txt;
        note.style.color = (ctx.compacted ? 'var(--accent)' :
          compactOff ? 'var(--notice)' : 'var(--text-3)');
      }
    }

    var list = el.querySelector('#us-models');
    if (list) {
      var models = (u && u.models) || [];
      var keys = models.map(function (m) { return String(m.model || ''); }).join('\u0001');
      if (list.getAttribute('data-uskeys') !== keys) {
        list.setAttribute('data-uskeys', keys);
        list.innerHTML = models.map(modelRow).join('') ||
          '<div class="art-loading" style="padding:14px">no usage recorded yet</div>';
      } else {
        // same model set — refresh each row's numbers in place
        models.forEach(function (m) {
          var row = list.querySelector('[data-usmodel="' + esc(String(m.model || '')) + '"]');
          if (!row) return;
          var spans = row.querySelectorAll('span');
          if (spans.length >= 3) {
            var s1 = (m.turns || 0) + ' turns';
            var s2 = '↑' + fmtTokens(m.tokensIn) + ' ↓' + fmtTokens(m.tokensOut);
            if (spans[1].textContent !== s1) spans[1].textContent = s1;
            if (spans[2].textContent !== s2) spans[2].textContent = s2;
          }
        });
      }
    }
  }

  // The poll: one interval per open view, tied to the view's lifetime via
  // onClose (the panel fires it on pop / ✕ / close) + an isConnected bail
  // so nothing can leak past the DOM.
  function startPoll(el, url, onFetch) {
    var timer = setInterval(function () {
      if (!el || !el.isConnected) {
        clearInterval(timer);
        return;
      }
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        if (!el.isConnected) { clearInterval(timer); return; }
        onFetch(d || {});
      }).catch(function () { /* transient — next tick retries */ });
    }, POLL_MS);
    return function stop() { clearInterval(timer); };
  }

  function open(panel, u, opts) {
    if (!panel) return;
    opts = opts || {};
    var t = (u && u.totals) || {};
    var ctx = (u && u.context) || {};
    var models = (u && u.models) || [];
    var modelRows = models.map(modelRow).join('');

    var fill = Math.max(0, Math.min(100, ctx.fillPct || 0));
    var fillColor = ctxColor(fill, ctx);
    // v0.30: the compaction line mirrors the chat's OWN settings (the
    // mind panel's toggle + threshold) — same endpoint, same numbers.
    var compactOff = ctx.compactEnabled === false;
    var compactThr = (typeof ctx.compactThreshold === 'number')
      ? Math.max(10, Math.min(95, ctx.compactThreshold)) : 70;

    var stopPoll = null;
    panel.pushView({
      title: 'usage · ' + (opts.name || 'chat'),
      render: function () {
        return (
          '<div style="display:flex;gap:8px">' +
            statCell(fmtTokens(t.tokensIn), 'tokens in', null, 'us-in') +
            statCell(fmtTokens(t.tokensOut), 'tokens out', null, 'us-out') +
            statCell(t.hasCost ? fmtCost(t) : '—', t.hasCost ? 'est. cost' : 'unpriced', t.hasCost ? 'var(--warn)' : 'var(--text-3)', 'us-cost') +
          '</div>' +
          '<div style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px;padding:12px;margin-top:12px">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px;gap:8px">' +
              '<span style="font-size:calc(var(--ui-small-fs) - 0.5px);font-weight:600;color:var(--text-1);flex-shrink:0">context</span>' +
              '<span id="us-ctx-model" style="font-size:var(--ui-micro-fs);color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(String(ctx.model || '').split('/').pop() || '') + ' · ' + fmtTokens(ctx.usedTokens) + ' / ~' + fmtTokens(ctx.limit) + ' tok</span>' +
            '</div>' +
            '<div style="height:8px;background:var(--bg-app);border-radius:4px;overflow:hidden">' +
              '<div id="us-ctx-fill" style="height:100%;width:' + fill + '%;background:' + fillColor + ';border-radius:4px;transition:width 0.4s ease"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;margin-top:6px">' +
              '<span id="us-ctx-pct" style="font-size:var(--ui-micro-fs);color:var(--text-3)">' + fill + '% used</span>' +
              '<span id="us-ctx-note" style="font-size:var(--ui-micro-fs);color:' + (ctx.compacted ? 'var(--accent)' : compactOff ? 'var(--notice)' : 'var(--text-3)') + '">' +
                (ctx.compacted ? 'auto-compacted ✓' :
                 compactOff ? 'auto-compact off — context fills unchecked' :
                 'auto-compact arms at ' + compactThr + '%') +
              '</span>' +
            '</div>' +
          '</div>' +
          (modelRows ? '<div class="pv-section-label">by model</div>' +
            '<div id="us-models" style="display:flex;flex-direction:column;gap:6px">' + modelRows + '</div>' : '') +
          '<button id="usage-fleet" class="pv-btn" style="width:100%;margin-top:14px">⧗ all chats (fleet totals)</button>' +
          '<p style="font-size:var(--ui-micro-fs);color:var(--text-3-dim);line-height:1.5;text-align:center;margin-top:10px">live · refreshes every few seconds · tokens are read from each provider\'s usage reports · costs are published list rates · estimates never replace real bills</p>'
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
        // v0.34: the LIVE poll — the numbers refresh while the user
        // watches. opts.state (the chat's state object) gets the fresh
        // payload too, so the header meters stay in sync when they return.
        if (opts.sessionId) {
          stopPoll = startPoll(el, '/api/sessions/' + opts.sessionId + '/usage', function (d) {
            patchUsageView(el, d);
            if (opts.state) opts.state._usage = d;
          });
        }
      },
      onClose: function () {
        if (stopPoll) { stopPoll(); stopPoll = null; }
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
        '<div data-usprov="' + esc(k) + '" style="display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px">' +
          '<span style="flex:1;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-1)">' + esc(k) + '</span>' +
          '<span style="font-size:var(--ui-micro-fs);color:var(--text-3)">' + (p.turns || 0) + ' turns</span>' +
          '<span style="font-size:var(--ui-micro-fs);color:var(--text-2)">↑' + fmtTokens(p.tokensIn) + ' ↓' + fmtTokens(p.tokensOut) + '</span>' +
          (p.hasCost ? '<span style="font-size:var(--ui-micro-fs);color:var(--warn)">' + fmtCost(p) + '</span>' : '') +
        '</div>';
    });

    var stopPoll = null;
    panel.pushView({
      title: 'fleet · all chats',
      render: function () {
        return (
          '<div style="display:flex;gap:8px">' +
            statCell(fmtTokens(t.tokensIn), 'tokens in · all chats', null, 'usf-in') +
            statCell(fmtTokens(t.tokensOut), 'tokens out', null, 'usf-out') +
            statCell(t.hasCost ? fmtCost(t) : '—', 'est. cost', t.hasCost ? 'var(--warn)' : 'var(--text-3)', 'usf-cost') +
          '</div>' +
          '<div class="pv-section-label">' + (fu.sessions || 0) + ' chats · by provider</div>' +
          '<div id="usf-provs" style="display:flex;flex-direction:column;gap:6px">' + (rows || '<div class="art-loading" style="padding:14px">no usage recorded yet</div>') + '</div>'
        );
      },
      onMount: function (el) {
        // v0.34: the fleet polls too — usage lands here from OTHER chats
        // while the user reads (this view has no session of its own).
        stopPoll = startPoll(el, '/api/usage', function (d) {
          var nt = d.totals || {};
          var set = function (id, val) {
            var n = el.querySelector('#' + id);
            if (n && n.textContent !== val) n.textContent = val;
          };
          set('usf-in', fmtTokens(nt.tokensIn));
          set('usf-out', fmtTokens(nt.tokensOut));
          set('usf-cost', nt.hasCost ? fmtCost(nt) : '—');
          var list = el.querySelector('#usf-provs');
          if (!list) return;
          var keys = Object.keys(d.providers || {}).sort().join('\u0001');
          if (list.getAttribute('data-uskeys') !== keys) {
            list.setAttribute('data-uskeys', keys);
            var nr = '';
            keys.split('\u0001').forEach(function (k) {
              if (!k) return;
              var p = (d.providers || {})[k];
              nr +=
                '<div style="display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--surface-1);border:1px solid var(--surface-2);border-radius:10px">' +
                  '<span style="flex:1;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-1)">' + esc(k) + '</span>' +
                  '<span style="font-size:var(--ui-micro-fs);color:var(--text-3)">' + (p.turns || 0) + ' turns</span>' +
                  '<span style="font-size:var(--ui-micro-fs);color:var(--text-2)">↑' + fmtTokens(p.tokensIn) + ' ↓' + fmtTokens(p.tokensOut) + '</span>' +
                  (p.hasCost ? '<span style="font-size:var(--ui-micro-fs);color:var(--warn)">' + fmtCost(p) + '</span>' : '') +
                '</div>';
            });
            list.innerHTML = nr || '<div class="art-loading" style="padding:14px">no usage recorded yet</div>';
          } else {
            keys.split('\u0001').forEach(function (k) {
              if (!k) return;
              var p = (d.providers || {})[k];
              var row = list.querySelector('[data-usprov="' + esc(k) + '"]');
              if (!row) return;
              var spans = row.querySelectorAll('span');
              if (spans.length >= 3) {
                var s1 = (p.turns || 0) + ' turns';
                var s2 = '↑' + fmtTokens(p.tokensIn) + ' ↓' + fmtTokens(p.tokensOut);
                if (spans[1].textContent !== s1) spans[1].textContent = s1;
                if (spans[2].textContent !== s2) spans[2].textContent = s2;
              }
            });
          }
        });
      },
      onClose: function () {
        if (stopPoll) { stopPoll(); stopPoll = null; }
      }
    });
  }

  // ringColor/ctxColor are exported for the header meters (chatpanel.js)
  // so the ring and the bar always agree on the ladder — one method,
  // every front-facing compaction element.
  window.UsagePanel = {
    open: open,
    ctxColor: ctxColor,
    ringColor: ringColor,
    close: function () {
      var c = window.ChatPanel && window.ChatPanel.current();
      if (c && c.panel) c.panel.closeViews();
    }
  };
})();
