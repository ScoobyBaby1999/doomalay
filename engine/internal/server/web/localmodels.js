// localmodels.js — the local model picker (Ollama detection + RAM recommendation).
//
// Opens as a blur-background overlay. Probes the engine's /api/local-models
// endpoint (which checks for Ollama at localhost:11434). Shows:
//   - Detected local models (if Ollama is running)
//   - RAM-based recommendation (if no Ollama)
//   - Install instructions
//
// Exposes: window.LocalModelsScreen

(function () {
  'use strict';

  function detectClientRAM() {
    // navigator.deviceMemory is Chrome-only (returns GB, approximate).
    if (navigator.deviceMemory) return navigator.deviceMemory;
    // Fallback: estimate from hardwareConcurrency (cores → rough RAM guess).
    var cores = navigator.hardwareConcurrency || 4;
    if (cores >= 8) return 8;
    if (cores >= 4) return 4;
    return 2;
  }

  function open(onPick, opts) {
    opts = opts || {};
    var clientRAM = detectClientRAM();

    // Fetch local models from the engine (which probes Ollama).
    fetch('/api/local-models?ram=' + clientRAM).then(function (r) { return r.json(); }).then(function (data) {
      render(data, clientRAM);
    }).catch(function (e) {
      console.error('local models fetch failed', e);
      render({ models: [], ollama_running: false, recommendation: {} }, clientRAM);
    });

    function render(data, ramGB) {
      var models = data.models || [];
      var ollamaRunning = data.ollama_running;
      var rec = data.recommendation || {};

      var html =
        '<div style="padding:20px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
        '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Local Models</h2>' +
        '<button id="lm-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
        '</div>' +
        '<p style="font-size:12px;color:#71717a;margin:0 0 16px">Run AI on your device. Private, offline, no API key.</p>' +
        '<div style="background:#14141a;border:1px solid #1a1a22;border-radius:8px;padding:10px;margin-bottom:16px;font-size:12px;color:#71717a">' +
        '<div style="display:flex;justify-content:space-between">' +
        '<span>Device RAM (detected):</span><span style="color:#e0e0e8">' + ramGB + ' GB</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:4px">' +
        '<span>Ollama status:</span><span style="color:' + (ollamaRunning ? '#34d399' : '#f87171') + '">' + (ollamaRunning ? '✓ Running' : '✕ Not detected') + '</span>' +
        '</div>' +
        '</div>';

      // Recommendation section
      if (rec.id) {
        html += '<div style="background:#14141a;border:1px solid #3a3a45;border-radius:12px;padding:14px;margin-bottom:16px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span style="font-size:16px">⭐</span>' +
          '<span style="font-size:14px;font-weight:600;color:#e0e0e8">Recommended for your device</span>' +
          '</div>' +
          '<p style="font-size:13px;color:#e0e0e8;margin:0 0 4px">' + rec.label + '</p>' +
          (rec.note ? '<p style="font-size:11px;color:#71717a;margin:0 0 10px">' + rec.note + '</p>' : '') +
          (ollamaRunning
            ? '<button data-model="' + rec.id + '" style="background:#4a4a5e;border:none;color:#e0e0e8;padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%">Use ' + rec.id + '</button>'
            : '<p style="font-size:11px;color:#f87171;margin:0">Install Ollama first (see below), then run: <code style="background:#0a0a0e;padding:2px 6px;border-radius:4px">ollama pull ' + rec.id + '</code></p>'
          ) +
          '</div>';
      }

      // Detected models (if Ollama running)
      if (ollamaRunning && models.length > 0) {
        html += '<h3 style="font-size:12px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">Installed Models</h3>' +
          '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          var sizeMB = m.size ? Math.round(m.size / 1048576) + ' MB' : '';
          html += '<div data-model="' + m.id + '" style="background:#14141a;border:1px solid #1a1a22;border-radius:8px;padding:12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between">' +
            '<div><div style="font-size:13px;color:#e0e0e8">' + m.id + '</div>' +
            (sizeMB ? '<div style="font-size:11px;color:#71717a">' + sizeMB + '</div>' : '') + '</div>' +
            '<span style="font-size:14px;color:#71717a">Use →</span>' +
            '</div>';
        }
        html += '</div>';
      }

      // Install instructions (if Ollama not running)
      if (!ollamaRunning) {
        html += '<div style="background:#0a0a0e;border:1px solid #1a1a22;border-radius:8px;padding:14px;margin-bottom:16px">' +
          '<h3 style="font-size:12px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">Install Ollama</h3>' +
          '<p style="font-size:12px;color:#71717a;margin:0 0 8px">Download from <a href="https://ollama.com" target="_blank" style="color:#4a4a5e">ollama.com</a>, then run:</p>' +
          '<pre style="font-size:11px;color:#34d399;background:#14141a;padding:8px 10px;border-radius:6px;margin:0;overflow-x:auto">ollama pull ' + (rec.id || 'llama3.2:3b') + '</pre>' +
          '<p style="font-size:11px;color:#71717a;margin:8px 0 0">After installing, reopen this screen — we\'ll detect it automatically.</p>' +
          '</div>';
      }

      html += '</div>';

      if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
        window.ConnectOverlay.replaceContent(html, { onClose: opts.onClose });
      } else {
        window.ConnectOverlay.open(html, { onClose: opts.onClose });
      }

      var contentEl = window.ConnectOverlay.getContentEl();
      var closeBtn = contentEl.querySelector('#lm-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { window.ConnectOverlay.close(); });

      // Wire up model selection
      contentEl.querySelectorAll('[data-model]').forEach(function (el) {
        el.addEventListener('click', function () {
          var modelId = el.dataset.model;
          window.ConnectOverlay.close();
          if (onPick) onPick('ollama', modelId);
        });
      });
    }
  }

  window.LocalModelsScreen = { open: open, detectClientRAM: detectClientRAM };
})();
