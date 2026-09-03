// appearance.js — the Appearance settings page.
//
// Registers an "Appearance" page with the Settings system. Exposes:
//   - Grid size (1x default, up to 5x — fewer/larger squares) — live
//   - Grid colors (background, grid lines, dots, origin marker) — live
//   - Font family (system default, serif, monospace)
//   - Default chatbot names (the list used to name new chatbots) — editable
//   - Reset View button (zoom 1x, pan to origin)
//
// All sections are collapsible (tap the header to expand/collapse) and
// collapsed by default. All changes apply live and persist to localStorage.

(function () {
  'use strict';

  const Settings = window.Settings;

  Settings.registerPage('appearance', {
    title: 'Appearance',
    icon: '🎨',
    render: function (getState, setState) {
      const s = getState();
      return (
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
