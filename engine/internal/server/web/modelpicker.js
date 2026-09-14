// modelpicker.js — the "+ Model" picker.
//
// v0.14 (user spec #6): the + Model menu offers ONLY the two ways a chat
// can be powered —
//   1. Connect Cloud Provider → the providers screen (key paste flow)
//   2. Use Local Model        → the local model screen (Ollama detection)
//
// "Browse All Models" was REMOVED from here: the full dynamic model browser
// (provider view + model view, search, filters, sort) now opens from the
// far-left panel-header model button ("model · provider") — the model can
// only be swapped once a source is connected.
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
      '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Pick a model source</h2>' +
      '<button id="mp-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
      '</div>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 20px">Cloud needs an API key; local runs on your device. You can swap the exact model later from the header.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('cloud', '☁️', 'Connect Cloud Provider',
          'Use a cloud LLM (OpenCode Zen, PrivateMode, NVIDIA, OpenRouter, …). Requires an API key. Free tiers available.',
          'recommended', 'cloud') +
        optionCard('local', '🖥️', 'Use Local Model',
          'Run a model on your device (Ollama). Private, offline, no API key. We recommend one based on your specs.',
          'private', 'local') +
      '</div>' +
      '</div>';

    window.ConnectOverlay.open(html);

    var contentEl = window.ConnectOverlay.getContentEl();
    var closeBtn = contentEl.querySelector('#mp-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.ConnectOverlay.close(); });

    contentEl.querySelectorAll('[data-model-type]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.modelType;
        if (type === 'cloud') {
          // v0.17 ONE-PRESS CONNECT (user spec): if the user already has
          // a cloud provider key, pressing this card instantly connects a
          // (provider, model) and unlocks the chat — no screen dance.
          // With fewer than 3 providers connected we ALSO pop the
          // providers GUI as a dismissible reminder (✕ or scrim tap
          // closes it; the chat is already usable underneath).
          // Zero keys → the full setup GUI (the original flow).
          window.ProvidersScreen.smartConnect(function (provider, modelId) {
            onPick(provider, modelId);
          }).then(function (res) {
            if (!res.connected) {
              window.ProvidersScreen.open(onPick, { useReplaceContent: true });
            } else if (res.connected < 3) {
              window.ProvidersScreen.open(onPick, { useReplaceContent: true, reminder: true });
            }
            // ≥3 connected: silent one-press unlock, no GUI
          });
        } else {
          window.LocalModelsScreen.open(onPick, { useReplaceContent: true });
        }
      });
    });
  }

  function optionCard(type, icon, title, desc, badge, dataId) {
    var badgeHTML = badge ? '<span style="font-size:11px;color:#71717a;background:#4a4a5e;padding:3px 8px;border-radius:6px">' + badge + '</span>' : '';
    return '<div data-model-type="' + type + '"' +
      ' style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;padding:16px;' +
      'cursor:pointer;transition:border-color 0.15s;touch-action:manipulation;-webkit-tap-highlight-color:transparent"' +
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
