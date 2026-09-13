// modelpicker.js — the "+ Model" picker.
//
// Opens as a blur-background overlay with 3 options:
//   1. Browse All Models  → the v0.13 dynamic model browser (ported from
//      the HF space: provider view + model view, search, filters, sort —
//      every model from every provider you can see, live-synced)
//   2. Connect Cloud Provider → the providers screen (key paste flow)
//   3. Use Local Model        → the local model screen (Ollama detection)
//
// When the user picks an option, the overlay content is REPLACED smoothly
// (fade out → swap → fade in) instead of closing + reopening — no snappy jump.
//
// Exposes: window.ModelPicker

(function () {
  'use strict';

  function open(onPick) {
    renderPicker(onPick);
  }

  function renderPicker(onPick) {
    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Choose a model and sandbox and go!</h2>' +
      '<button id="mp-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
      '</div>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 20px">Pick how this chat will run AI. Cloud needs an API key; local runs on your device.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('browse', '✨', 'Browse All Models',
          'Every model from every provider — live-synced, searchable, filterable by capability. Providers you have keys for are one tap away.',
          'dynamic', false, 'browse') +
        optionCard('cloud', '☁️', 'Connect Cloud Provider',
          'Use a cloud LLM (OpenRouter, NVIDIA, Anthropic, etc.). Requires an API key. Free tiers available.',
          'recommended', false, 'cloud') +
        optionCard('local', '🖥️', 'Use Local Model',
          'Run a model on your device (Ollama). Private, offline, no API key. We recommend one based on your specs.',
          'private', false, 'local') +
      '</div>' +
      '</div>';

    window.ConnectOverlay.open(html);

    var contentEl = window.ConnectOverlay.getContentEl();
    var closeBtn = contentEl.querySelector('#mp-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.ConnectOverlay.close(); });

    contentEl.querySelectorAll('[data-model-type]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.modelType;
        // Don't close the overlay — replace its content smoothly.
        if (type === 'browse') {
          if (window.ModelBrowser) {
            window.ModelBrowser.open(onPick, { useReplaceContent: true });
          }
        } else if (type === 'cloud') {
          window.ProvidersScreen.open(onPick, { useReplaceContent: true });
        } else {
          window.LocalModelsScreen.open(onPick, { useReplaceContent: true });
        }
      });
    });
  }

  function optionCard(type, icon, title, desc, badge, disabled, dataId) {
    var opacity = disabled ? 'opacity:0.5;pointer-events:none' : 'cursor:pointer';
    var badgeHTML = badge ? '<span style="font-size:11px;color:#71717a;background:#4a4a5e;padding:3px 8px;border-radius:6px">' + badge + '</span>' : '';
    return '<div data-model-type="' + type + '"' +
      ' style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;padding:16px;' +
      opacity + ';transition:border-color 0.15s"' +
      ' onmouseover="this.style.borderColor=\'#3a3a45\'"' +
      ' onmouseout="this.style.borderColor=\'#1a1a22\'"' +
      '>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
      '<span style="font-size:24px">' + icon + '</span>' +
      '<span style="font-size:15px;font-weight:600;color:#e0e0e8;flex:1">' + title + '</span>' +
      badgeHTML +
      '</div>' +
      '<p style="font-size:12px;color:#71717a;margin:0;line-height:1.5">' + desc + '</p>' +
      '</div>';
  }

  window.ModelPicker = { open: open };
})();
