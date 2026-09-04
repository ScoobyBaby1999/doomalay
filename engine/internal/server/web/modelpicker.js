// modelpicker.js — the "+ Model" picker.
//
// Opens as a blur-background overlay with 2 options:
//   1. Connect Cloud Provider → opens the providers screen (ported from HF)
//   2. Use Local Model        → opens the local model screen (Ollama detection)
//
// Exposes: window.ModelPicker

(function () {
  'use strict';

  function open(onPick) {
    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">' +
      '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Connect Model</h2>' +
      '<button id="mp-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
      '</div>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 20px">Pick how this chat will run AI. Cloud needs an API key; local runs on your device.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('cloud', '☁️', 'Connect Cloud Provider',
          'Use a cloud LLM (OpenRouter, NVIDIA, Anthropic, etc.). Requires an API key. Free tiers available.',
          'recommended') +
        optionCard('local', '🖥️', 'Use Local Model',
          'Run a model on your device (Ollama). Private, offline, no API key. We recommend one based on your specs.',
          'private') +
      '</div>' +
      '</div>';

    window.ConnectOverlay.open(html);

    var contentEl = window.ConnectOverlay.getContentEl();
    contentEl.querySelector('#mp-close').addEventListener('click', window.ConnectOverlay.close);

    contentEl.querySelectorAll('[data-model-type]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.modelType;
        window.ConnectOverlay.close();
        if (onPick) onPick(type);
      });
    });
  }

  function optionCard(type, icon, title, desc, badge) {
    return '<div data-model-type="' + type + '"' +
      ' style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;padding:16px;cursor:pointer;transition:border-color 0.15s"' +
      ' onmouseover="this.style.borderColor=\'#3a3a45\'"' +
      ' onmouseout="this.style.borderColor=\'#1a1a22\'"' +
      '>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
      '<span style="font-size:24px">' + icon + '</span>' +
      '<span style="font-size:15px;font-weight:600;color:#e0e0e8;flex:1">' + title + '</span>' +
      '<span style="font-size:11px;color:#71717a;background:#4a4a5e;padding:3px 8px;border-radius:6px">' + badge + '</span>' +
      '</div>' +
      '<p style="font-size:12px;color:#71717a;margin:0;line-height:1.5">' + desc + '</p>' +
      '</div>';
  }

  window.ModelPicker = { open: open };
})();
