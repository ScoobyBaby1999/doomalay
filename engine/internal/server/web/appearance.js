// appearance.js — the Appearance settings page.
//
// Registers an "Appearance" page with the Settings system. Exposes:
//   - Grid size (1x default, up to 5x — fewer/larger squares) — live
//   - Grid colors (background, grid lines, dots, origin marker) — live
//   - Font family (system default, serif, monospace)
//   - v0.17 CHAT COLORS: the markdown color scheme (presets of 2–3
//     adjacent hues + per-slot overrides — every value is a CSS
//     variable) — live
//   - v0.17 CHAT TEXT SIZE: 0–100 slider scaling message text (bubbles
//     + pills adapt; word-break guards against mid-word splices)
//   - Default chatbot names (the list used to name new chatbots)
//   - Reset View button (zoom 1x, pan to origin)
//
// All sections are collapsible (tap the header to expand/collapse) and
// collapsed by default. All changes apply live and persist to localStorage.

(function () {
  'use strict';

  const Settings = window.Settings;

  // ── v0.17: chat color scheme + text size — applied live ─────────
  function applyChatAppearance(s) {
    if (window.Formatter) {
      window.Formatter.applyScheme(s.chatScheme || 'teal', s.fmtOverrides || null);
    }
    var size = (typeof s.chatTextSize === 'number') ? s.chatTextSize : 50;
    // 0 → 12px … 100 → 24px (default 50 → 16px)
    var px = (12 + (size / 100) * 12).toFixed(1) + 'px';
    document.documentElement.style.setProperty('--chat-fs', px);
  }

  Settings.onChange(function (s) { applyChatAppearance(s); });
  applyChatAppearance(Settings.getState()); // boot with persisted values

  // scheme preset buttons + reset (dispatched via doomalay:action)
  window.addEventListener('doomalay:action', function (e) {
    var d = e.detail || {};
    if (d.action === 'chat-scheme' && d.data && d.data.scheme) {
      Settings.setState({ chatScheme: d.data.scheme, fmtOverrides: {} });
    } else if (d.action === 'chat-colors-reset') {
      Settings.setState({ chatScheme: 'teal', fmtOverrides: {} });
    }
  });

  function schemeSwatches() {
    var current = Settings.getState().chatScheme || 'teal';
    var schemes = (window.Formatter && window.Formatter.schemes) || {};
    var html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px">';
    Object.keys(schemes).forEach(function (id) {
      var sc = schemes[id];
      var sel = id === current;
      html += '<button data-action="chat-scheme" data-scheme="' + id + '" ' +
        'style="display:flex;align-items:center;gap:6px;background:' +
        (sel ? '#1e1e28' : 'transparent') + ';border:1px solid ' +
        (sel ? '#34344a' : '#2a2a35') + ';border-radius:10px;padding:8px 12px;' +
        'cursor:pointer;font-family:inherit;color:' + (sel ? '#e0e0e8' : '#a8a8b4') + ';font-size:12px;font-weight:600">' +
        '<span style="display:flex">' +
          '<i style="width:12px;height:12px;border-radius:50%;background:' + sc.a1 + ';display:inline-block"></i>' +
          '<i style="width:12px;height:12px;border-radius:50%;background:' + sc.a2 + ';display:inline-block;margin-left:-3px"></i>' +
          '<i style="width:12px;height:12px;border-radius:50%;background:' + sc.a3 + ';display:inline-block;margin-left:-3px"></i>' +
        '</span>' + sc.label + '</button>';
    });
    html += '</div>';
    return html;
  }

  function fmtColorRow(key, label, hint) {
    var s = Settings.getState();
    var ov = s.fmtOverrides || {};
    var preset = (window.Formatter && window.Formatter.schemes[s.chatScheme || 'teal']) || {};
    var val = ov[key] || preset[key === 'a1' ? 'a1' : key === 'a2' ? 'a2' : key === 'a3' ? 'a3' : key === 'bright' ? 'bright' : 'link'] || '#22d3ee';
    return row(label + (hint ? ' <span style="font-size:10px;color:#71717a">' + hint + '</span>' : ''),
      '<input type="color" data-setting-key="fmtA_' + key + '" data-custom="fmt" value="' + val + '" ' +
      'style="width:40px;height:32px;border:1px solid #2a2a35;border-radius:6px;background:transparent;cursor:pointer">');
  }

  // intercept fmt color inputs (they nest under fmtOverrides, not flat)
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || el.getAttribute('data-custom') !== 'fmt') return;
    var keyMap = { fmtA_a1: 'a1', fmtA_a2: 'a2', fmtA_a3: 'a3', fmtA_bright: 'bright', fmtA_link: 'link' };
    var slot = keyMap[el.getAttribute('data-setting-key')];
    if (!slot) return;
    var s = Settings.getState();
    var ov = Object.assign({}, s.fmtOverrides || {});
    ov[slot] = el.value;
    Settings.setState({ fmtOverrides: ov });
  }, true);

  Settings.registerPage('appearance', {
    title: 'Appearance',
    icon: '🎨',
    render: function (getState, setState) {
      const s = getState();
      return (
        section('Chat Colors', '' +
          '<p class="hint">The markdown color scheme for messages — a family of 2–3 adjacent hues. Pick a preset, or fine-tune every slot below (all values are CSS variables).</p>' +
          schemeSwatches() +
          fmtColorRow('a1', 'Accent 1', 'headings · keywords') +
          fmtColorRow('a2', 'Accent 2', 'subheads · code') +
          fmtColorRow('a3', 'Accent 3', 'emphasis · links') +
          fmtColorRow('bright', 'Bright text', 'bold') +
          fmtColorRow('link', 'Links', '') +
          '<button data-action="chat-colors-reset" style="background:transparent;border:1px solid #2a2a35;color:#71717a;padding:8px 14px;border-radius:8px;font-size:12px;font-family:inherit;cursor:pointer;margin-top:6px">reset to preset defaults</button>'
        ) +
        section('Chat Text Size', '' +
          '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<label>Message text size</label>' +
          '<span style="font-size:13px;color:#71717a;font-variant-numeric:tabular-nums" data-range-display="chatTextSize" data-suffix="">' +
            (typeof s.chatTextSize === 'number' ? s.chatTextSize : 50) + '</span>' +
          '</div>' +
          '<input type="range" data-setting-key="chatTextSize" data-setting-event="input" ' +
          'data-setting-transform="number" min="0" max="100" step="1" value="' +
            (typeof s.chatTextSize === 'number' ? s.chatTextSize : 50) + '" ' +
          'style="width:100%;accent-color:var(--fmt-a1);height:32px;cursor:pointer">' +
          '<p class="hint" style="margin:0">0 = smallest (12px) · 100 = largest (24px). Bubbles and pills adapt; long words wrap without splicing.</p>' +
          '</div>'
        ) +
        section('Grid', '' +
          rangeRow('gridSize', 'Grid Size', s.gridSize || 1, 1, 5, 0.5,
            'Scales the grid spacing. 1× = default (48px). 5× = largest (240px), fewer squares.') +
          colorRow('bg', 'Background', s.bg) +
          colorRow('lineColor', 'Grid Lines', s.lineColor) +
          colorRow('dotColor', 'Dots', s.dotColor) +
          colorRow('originColor', 'Origin Marker', s.originColor)
        ) +
        section('Text', '' +
          selectRow('fontFamily', 'Font', s.fontFamily, [
            { value: 'system', label: 'System Default' },
            { value: 'serif', label: 'Serif' },
            { value: 'monospace', label: 'Monospace' }
          ])
        ) +
        section('Default Chat Names', '' +
          '<p class="hint">Names used when creating new chatbots. One per line.</p>' +
          '<textarea data-setting-key="names" data-setting-transform="lines" rows="8" ' +
          'style="width:100%;background:#1a1a22;border:1px solid #2a2a35;color:#e0e0e8;' +
          'padding:8px 10px;border-radius:6px;font-size:13px;font-family:inherit;' +
          'resize:vertical;min-height:120px;line-height:1.5">' +
          s.names.join('\n') + '</textarea>'
        ) +
        section('View', '' +
          '<button data-action="reset-view" style="background:#1a1a22;border:1px solid #2a2a35;' +
          'color:#e0e0e8;padding:10px 16px;border-radius:8px;font-size:13px;font-family:inherit;' +
          'cursor:pointer;width:100%">Reset View (zoom 1×, pan to origin)</button>'
        )
      );
    }
  });

  // ── HTML helpers ──────────────────────────────────────────────
  // Sections are collapsible — collapsed by default. The header has a
  // chevron that rotates when expanded. settings.js wires the toggle.
  function section(title, inner) {
    return '<div class="settings-section">' +
      '<h3 data-section-toggle><span>' + title + '</span><span class="chevron">▶</span></h3>' +
      '<div class="section-body">' + inner + '</div>' +
      '</div>';
  }
  function row(label, control) {
    return '<div class="setting-row">' +
      '<label>' + label + '</label>' +
      '<div class="control">' + control + '</div>' +
      '</div>';
  }
  function colorRow(key, label, value) {
    return row(label,
      '<input type="color" data-setting-key="' + key + '" data-setting-event="input" value="' + value + '" ' +
      'style="width:40px;height:32px;border:1px solid #2a2a35;border-radius:6px;background:transparent;cursor:pointer">');
  }
  function selectRow(key, label, value, options) {
    let opts = '';
    for (const o of options) {
      const sel = o.value === value ? ' selected' : '';
      opts += '<option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
    }
    return row(label,
      '<select data-setting-key="' + key + '" data-setting-event="change" ' +
      'style="background:#1a1a22;border:1px solid #2a2a35;color:#e0e0e8;padding:6px 10px;border-radius:6px;font-size:13px;font-family:inherit">' +
      opts + '</select>');
  }
  // rangeRow — a slider with a value display + hint below.
  function rangeRow(key, label, value, min, max, step, hint) {
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:13px;color:#71717a;font-variant-numeric:tabular-nums" ' +
      'data-range-display="' + key + '">' + value + '×</span>' +
      '</div>' +
      '<input type="range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" ' +
      'style="width:100%;accent-color:#4a4a5e;height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }
})();
