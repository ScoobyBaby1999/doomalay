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
        '<h2 style="font-size: calc(var(--ui-fs) + 4px);font-weight:600;color:var(--text-1);margin:0">Local Models</h2>' +
        '<button id="lm-close" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
        '</div>' +
        '<p style="font-size: var(--ui-small-fs);color:var(--text-3);margin:0 0 16px">Run AI on your device. Private, offline, no API key.</p>' +
        '<div style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:8px;padding:10px;margin-bottom:16px;font-size: var(--ui-small-fs);color:var(--text-3)">' +
        '<div style="display:flex;justify-content:space-between">' +
        '<span>Device RAM (detected):</span><span style="color:var(--text-1)">' + ramGB + ' GB</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:4px">' +
        '<span>Ollama status:</span><span style="color:' + (ollamaRunning ? 'var(--ok)' : 'var(--err)') + '">' + (ollamaRunning ? '✓ Running' : '✕ Not detected') + '</span>' +
        '</div>' +
        '</div>';

      // Recommendation section
      if (rec.id) {
        html += '<div style="background:var(--surface-1);border:1px solid var(--text-3-dim);border-radius:12px;padding:14px;margin-bottom:16px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span style="font-size: calc(var(--ui-fs) + 2px)">⭐</span>' +
          '<span style="font-size: var(--ui-fs);font-weight:600;color:var(--text-1)">Recommended for your device</span>' +
          '</div>' +
          '<p style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-1);margin:0 0 4px">' + rec.label + '</p>' +
          (rec.note ? '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:0 0 10px">' + rec.note + '</p>' : '') +
          (ollamaRunning
            ? '<button data-model="' + rec.id + '" style="background:var(--accent);border:none;color:var(--on-accent,#fff);padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;width:100%">Use ' + rec.id + '</button>'
            : '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--err);margin:0">Install Ollama first (see below), then run: <code style="background:var(--bg-app);padding:2px 6px;border-radius:4px">ollama pull ' + rec.id + '</code></p>'
          ) +
          '</div>';
      }

      // Detected models (if Ollama running)
      if (ollamaRunning && models.length > 0) {
        html += '<h3 style="font-size: var(--ui-small-fs);font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">Installed Models</h3>' +
          '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          var sizeMB = m.size ? Math.round(m.size / 1048576) + ' MB' : '';
          html += '<div data-model="' + m.id + '" style="background:var(--surface-1);border:1px solid var(--surface-2);border-radius:8px;padding:12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between">' +
            '<div><div style="font-size: calc(var(--ui-fs) - 1px);color:var(--text-1)">' + m.id + '</div>' +
            (sizeMB ? '<div style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3)">' + sizeMB + '</div>' : '') + '</div>' +
            '<span style="font-size: var(--ui-fs);color:var(--text-3)">Use →</span>' +
            '</div>';
        }
        html += '</div>';
      }

      // Install instructions (if Ollama not running)
      if (!ollamaRunning) {
        html += '<div style="background:var(--bg-app);border:1px solid var(--surface-2);border-radius:8px;padding:14px;margin-bottom:16px">' +
          '<h3 style="font-size: var(--ui-small-fs);font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">Install Ollama</h3>' +
          '<p style="font-size: var(--ui-small-fs);color:var(--text-3);margin:0 0 8px">Download from <a href="https://ollama.com" target="_blank" style="color:var(--border-strong)">ollama.com</a>, then run:</p>' +
          '<pre style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--ok);background:var(--surface-1);padding:8px 10px;border-radius:6px;margin:0;overflow-x:auto">ollama pull ' + (rec.id || 'llama3.2:3b') + '</pre>' +
          '<p style="font-size: calc(var(--ui-small-fs) - 1px);color:var(--text-3);margin:8px 0 0">After installing, reopen this screen — we\'ll detect it automatically.</p>' +
          '</div>';
      }

      html += '</div>';

      // Wire close button + model rows AFTER the DOM swap — replaceContent
      // defers the swap by 150ms (fade-out); wiring synchronously attached
      // listeners to the OLD content (v0.10.1 dead-buttons bug).
      var wireUp = function () {
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
      };

      if (opts.useReplaceContent && window.ConnectOverlay.isOpen()) {
        window.ConnectOverlay.replaceContent(html, { onClose: opts.onClose, onSwap: wireUp });
      } else {
        window.ConnectOverlay.open(html, { onClose: opts.onClose, onSwap: wireUp });
      }
    }
  }

  window.LocalModelsScreen = { open: open, detectClientRAM: detectClientRAM };
})();
