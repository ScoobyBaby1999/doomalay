// appearance.js — v0.24 the Colors / Sizing / General settings pages.
//
// USER SPEC (v0.24, the theme round):
//   "Currently we have chat colors, this is to be reworked to colors in
//    general, and chat colors and advanced formatting is included inside
//    the colors in general... The grid colors that we also have currently
//    should be moved into the general colors section aswell. Chat text
//    size and grid size should also merge, all resizing changes should
//    merge to one section aswell... change chat text size to text size
//    and offer a scale for chat text size, general text size, small text
//    size, ext."
//
// Pages:
//   🎨 Colors  — the app theme (10 palettes) · grid colors (theme-driven
//               until customized) · chat colors (markdown scheme presets
//               + per-slot advanced overrides)
//   📐 Sizing  — chat text · general text · small text · grid size
//   ⚙️ General — font family · default chatbot names · view reset
//
// All sections are collapsible (smooth grid-rows unfold) and collapsed by
// default. All changes apply live and persist to localStorage.

(function () {
  'use strict';

  const Settings = window.Settings;

  // ── theme picker ───────────────────────────────────────────────
  // A swatch card per theme: 3 accent dots on the theme's own surface
  // colors, so the picker previews the real feel.
  function themeSwatches() {
    var current = Settings.getState().theme || 'midnight';
    var themes = (window.DoomTheme && window.DoomTheme.themes) || {};
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:8px 0 4px">';
    Object.keys(themes).forEach(function (id) {
      var t = themes[id];
      var sel = id === current;
      html += '<button data-action="set-theme" data-theme="' + id + '" ' +
        'style="display:flex;flex-direction:column;gap:6px;align-items:flex-start;' +
        'background:var(--surface-2);border:1.5px solid ' + (sel ? 'var(--accent)' : 'var(--border)') + ';' +
        'border-radius:12px;padding:10px;cursor:pointer;font-family:inherit;color:inherit;' +
        (sel ? 'box-shadow:0 0 0 2px rgba(var(--accent-rgb),0.25);' : '') + '">' +
        '<span style="display:flex;width:100%">' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + t.accent + ';display:inline-block"></i>' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + t.accent2 + ';display:inline-block;margin-left:2px"></i>' +
          '<i style="flex:1;height:6px;border-radius:3px;background:' + t.accent3 + ';display:inline-block;margin-left:2px"></i>' +
        '</span>' +
        (t.light ? '<span style="font-size:calc(var(--ui-small-fs) - 3px);color:var(--text-3);font-weight:600">light</span>' : '') +
        '<span style="font-size:calc(var(--ui-small-fs) - 1px);font-weight:600;color:var(--text-1)">' + t.label + '</span>' +
        '</button>';
    });
    html += '</div>' +
      '<p class="hint" style="margin:2px 0 0">The theme retints the whole app — panels, pills, chat accents, grid. Each pairs with a matching chat scheme; pick a different one below if you like.</p>';
    return html;
  }

  // ── grid colors (theme-driven until the user customizes) ───────
  function gridColorRow(key, label, resolved) {
    return row(label,
      '<input type="color" data-setting-key="' + key + '" data-setting-event="input" value="' + resolved + '" ' +
      'style="width:40px;height:32px;border:1px solid var(--border);border-radius:6px;background:transparent;cursor:pointer">');
  }

  function gridSection() {
    var s = Settings.getState();
    var g = (window.DoomTheme && window.DoomTheme.effectiveGrid)
      ? window.DoomTheme.effectiveGrid(s) : s;
    return section('Grid Colors', '' +
      '<p class="hint">The infinite canvas behind the chats. Left at the theme\u2019s palette until you pick your own.</p>' +
      gridColorRow('bg', 'Background', g.bg) +
      gridColorRow('lineColor', 'Grid Lines', g.lineColor) +
      gridColorRow('dotColor', 'Dots', g.dotColor) +
      gridColorRow('originColor', 'Origin Marker', g.originColor) +
      '<button data-action="grid-colors-reset" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;border-radius:8px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer;margin-top:6px">follow theme again</button>'
    );
  }

  // ── chat colors (markdown scheme + advanced slots) ─────────────
  function schemeSwatches() {
    var current = Settings.getState().chatScheme || 'teal';
    var schemes = (window.Formatter && window.Formatter.schemes) || {};
    var html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px">';
    Object.keys(schemes).forEach(function (id) {
      var sc = schemes[id];
      var sel = id === current;
      html += '<button data-action="chat-scheme" data-scheme="' + id + '" ' +
        'style="display:flex;align-items:center;gap:6px;background:' +
        (sel ? 'var(--surface-3)' : 'transparent') + ';border:1px solid ' +
        (sel ? 'var(--border-strong)' : 'var(--border)') + ';border-radius:10px;padding:8px 12px;' +
        'cursor:pointer;font-family:inherit;color:' + (sel ? 'var(--text-1)' : 'var(--text-2)') + ';font-size:calc(var(--ui-small-fs) - 1px);font-weight:600">' +
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
    var val = ov[key] || preset[key] || '#22d3ee';
    return row(label + (hint ? ' <span style="font-size:calc(var(--ui-small-fs) - 2px);color:var(--text-3)">' + hint + '</span>' : ''),
      '<input type="color" data-setting-key="fmtA_' + key + '" data-custom="fmt" value="' + val + '" ' +
      'style="width:40px;height:32px;border:1px solid var(--border);border-radius:6px;background:transparent;cursor:pointer">');
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

  // ── sizing sliders ─────────────────────────────────────────────
  function sizeSlider(key, label, hint, def) {
    var s = Settings.getState();
    var v = (typeof s[key] === 'number') ? s[key] : (def || 50);
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" data-range-display="' + key + '" data-suffix="">' + v + '</span>' +
      '</div>' +
      '<input type="range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="0" max="100" step="1" value="' + v + '" ' +
      'style="width:100%;accent-color:var(--accent);height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }

  // ── register the three pages ───────────────────────────────────
  Settings.registerPage('appearance', {
    title: 'Colors',
    icon: '🎨',
    render: function (getState, setState) {
      const s = getState();
      return (
        section('Theme', '' +
          themeSwatches()
        ) +
        gridSection() +
        section('Chat Colors', '' +
          '<p class="hint">The markdown color scheme for messages — a family of 2–3 adjacent hues. Pick a preset, or fine-tune every slot below (all values are CSS variables).</p>' +
          schemeSwatches() +
          fmtColorRow('a1', 'Accent 1', 'headings · keywords') +
          fmtColorRow('a2', 'Accent 2', 'subheads · code') +
          fmtColorRow('a3', 'Accent 3', 'emphasis · links') +
          fmtColorRow('bright', 'Bright text', 'bold') +
          fmtColorRow('link', 'Links', '') +
          '<button data-action="chat-colors-reset" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;border-radius:8px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer;margin-top:6px">reset to preset defaults</button>'
        )
      );
    }
  });

  Settings.registerPage('sizing', {
    title: 'Sizing',
    icon: '📐',
    render: function (getState, setState) {
      return (
        section('Text Size', '' +
          '<p class="hint">Every piece of text in the app scales through one of three sizes — no more 30-variable tweakfests.</p>' +
          sizeSlider('chatTextSize', 'Chat text', 'Message bubbles · 0 = 12px · 100 = 24px (replies, questions).') +
          sizeSlider('uiTextSize', 'General text', 'Labels, buttons, headers, inputs · 0 = 12px · 100 = 17px.') +
          sizeSlider('smallTextSize', 'Small text', 'Pills, thinking bubbles, hints, meta, tool cards · 0 = 9.5px · 100 = 15px.')
        ) +
        section('Grid Size', '' +
          rangeRow('gridSize', 'Grid Spacing', getState().gridSize || 1, 1, 5, 0.5,
            'Scales the grid spacing. 1× = default (48px). 5× = largest (240px), fewer squares.')
        )
      );
    }
  });

  Settings.registerPage('general', {
    title: 'General',
    icon: '⚙️',
    render: function (getState, setState) {
      const s = getState();
      return (
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
          'style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);' +
          'padding:8px 10px;border-radius:6px;font-size:calc(var(--ui-fs) - 1px);font-family:inherit;' +
          'resize:vertical;min-height:120px;line-height:1.5">' +
          s.names.join('\n') + '</textarea>'
        ) +
        section('View', '' +
          '<button data-action="reset-view" style="background:var(--surface-2);border:1px solid var(--border);' +
          'color:var(--text-1);padding:10px 16px;border-radius:8px;font-size:var(--ui-fs);font-family:inherit;' +
          'cursor:pointer;width:100%">Reset View (zoom 1×, pan to origin)</button>'
        )
      );
    }
  });

  // theme + grid actions (dispatched via doomalay:action)
  window.addEventListener('doomalay:action', function (e) {
    var d = e.detail || {};
    if (d.action === 'set-theme' && d.data && d.data.theme) {
      Settings.setState({ theme: d.data.theme });
    } else if (d.action === 'chat-scheme' && d.data && d.data.scheme) {
      Settings.setState({ chatScheme: d.data.scheme, fmtOverrides: {} });
    } else if (d.action === 'chat-colors-reset') {
      Settings.setState({ chatScheme: 'teal', fmtOverrides: {} });
    } else if (d.action === 'grid-colors-reset') {
      // back to "follow the theme": wipe to the legacy defaults (which
      // effectiveGrid treats as never-customized)
      Settings.setState({ bg: 'var(--bg-app)', lineColor: 'var(--surface-2)', dotColor: '#2e2e3a', originColor: 'var(--border-strong)' });
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
  function selectRow(key, label, value, options) {
    let opts = '';
    for (const o of options) {
      const sel = o.value === value ? ' selected' : '';
      opts += '<option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
    }
    return row(label,
      '<select data-setting-key="' + key + '" data-setting-event="change" ' +
      'style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:6px 10px;border-radius:6px;font-size:calc(var(--ui-fs) - 1px);font-family:inherit">' +
      opts + '</select>');
  }
  // rangeRow — a slider with a value display + hint below.
  function rangeRow(key, label, value, min, max, step, hint) {
    return '<div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<label>' + label + '</label>' +
      '<span style="font-size:calc(var(--ui-small-fs) - 1px);color:var(--text-3);font-variant-numeric:tabular-nums" ' +
      'data-range-display="' + key + '">' + value + '×</span>' +
      '</div>' +
      '<input type="range" data-setting-key="' + key + '" data-setting-event="input" ' +
      'data-setting-transform="number" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" ' +
      'style="width:100%;accent-color:var(--accent);height:32px;cursor:pointer">' +
      (hint ? '<p class="hint" style="margin:0">' + hint + '</p>' : '') +
      '</div>';
  }
})();
