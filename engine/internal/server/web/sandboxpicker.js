// sandboxpicker.js — the "+ Sandbox" picker.
//
// Opens as a blur-background overlay with 4 options:
//   1. Quick Chat      — no commands, no sandbox. Just talk. Has tool use,
//      default effort modes, web search, and custom templates.
//   2. HF Docker       — Docker container nested with bubblewrap for bash,
//      commands, and tool access. Requires HF login — we handle setup.
//   3. Another Device  — deferred (mesh setup, future)
//   4. Terminal/VM      — dynamic, device-dependent:
//      - Android APK → Termux (local terminal, local storage, local compile)
//      - Other       — "coming soon"
//
// Each option calls onPick(sandboxType) when selected. The caller (chatpanel.js)
// then configures the chat session with the chosen sandbox.
//
// Exposes: window.SandboxPicker

(function () {
  'use strict';

  function detectDevice() {
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var isAndroid = /android/i.test(ua) || /Android/.test(platform);
    var isIOS = /iPad|iPhone|iPod/.test(ua) || /iPad|iPhone/.test(platform);
    var isMac = /Mac/.test(platform) || /Macintosh/.test(ua);
    var isLinux = /Linux/.test(platform) || /X11/.test(ua);
    var isWindows = /Win/.test(platform) || /Windows/.test(ua);
    if (isAndroid) return 'android-apk';
    if (isIOS) return 'ios';
    if (isMac) return 'macos';
    if (isWindows) return 'windows';
    if (isLinux) return 'linux';
    return 'unknown';
  }

  function open(onPick) {
    var device = detectDevice();

    // Build the 4th option dynamically based on device.
    var terminalOption;
    if (device === 'android-apk') {
      terminalOption = optionCard(
        'terminal', '⌨️', 'Termux (Local)',
        'Local terminal with bash, file access, and local compilation. Full Python brain on your phone — runs entirely offline.',
        null  // no badge
      );
    } else if (device === 'macos' || device === 'linux' || device === 'windows') {
      terminalOption = optionCard(
        'terminal', '⌨️', 'Local Terminal',
        'Use your device\'s native terminal + Python. Full brain, full tools, local compile. Runs entirely on your device.',
        null
      );
    } else {
      terminalOption = optionCard(
        'terminal', '⌨️', 'Terminal / VM',
        'Device-specific terminal support. Detected: ' + device + '. Coming soon.',
        'coming soon', true
      );
    }

    var html =
      '<div style="padding:24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<h2 style="font-size:18px;font-weight:600;color:#e0e0e8;margin:0">Choose a model and sandbox and go!</h2>' +
      '<button id="sb-close" style="background:transparent;border:none;color:#71717a;font-size:22px;cursor:pointer;padding:4px 8px">✕</button>' +
      '</div>' +
      '<p style="font-size:13px;color:#71717a;margin:0 0 20px">Pick a runtime for this chat. Each sandbox has different capabilities.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        optionCard('quick', '⚡', 'Quick Chat',
          'No commands, no sandbox. Just talk. Has tool use, default effort modes, web search, and custom templates.',
          null) +
        optionCard('hf', '🤗', 'Hugging Face Space',
          'Docker container nested with bubblewrap for bash, commands, and tool access. Requires HF login — we handle everything else in the background.',
          null) +
        optionCard('device', '🔗', 'Another Device',
          'Connect to a remote engine (mesh setup). Deferred — coming in a future milestone.',
          'coming soon', true) +
        terminalOption +
      '</div>' +
      '<p style="font-size:11px;color:#3a3a45;margin:20px 0 0;text-align:center">Detected device: ' + device + '</p>' +
      '</div>';

    window.ConnectOverlay.open(html);

    // Wire up close + option clicks
    var contentEl = window.ConnectOverlay.getContentEl();
    var closeBtn = contentEl.querySelector('#sb-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.ConnectOverlay.close(); });

    contentEl.querySelectorAll('[data-sandbox]').forEach(function (card) {
      card.addEventListener('click', function () {
        var type = card.dataset.sandbox;
        if (card.dataset.disabled === 'true') return; // skip "coming soon"
        window.ConnectOverlay.close();
        if (onPick) onPick(type);
      });
    });
  }

  function optionCard(type, icon, title, desc, badge, disabled) {
    var opacity = disabled ? 'opacity:0.5;pointer-events:none' : 'cursor:pointer';
    var badgeHTML = badge ? '<span style="font-size:11px;color:#71717a;background:#3a3a45;padding:3px 8px;border-radius:6px">' + badge + '</span>' : '';
    return '<div data-sandbox="' + type + '" data-disabled="' + (disabled ? 'true' : 'false') + '"' +
      ' style="background:#14141a;border:1px solid #1a1a22;border-radius:12px;padding:16px;' +
      opacity + ';transition:border-color 0.15s"' +
      ' onmouseover="if(this.dataset.disabled!==\'true\')this.style.borderColor=\'#3a3a45\'"' +
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

  window.SandboxPicker = { open: open, detectDevice: detectDevice };
})();
