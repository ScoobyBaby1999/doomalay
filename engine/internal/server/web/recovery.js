// recovery.js — the never-white-screen guard (v0.15).
//
// THE BUG IT PREVENTS: after an on-device crash the app could reopen to a
// blank page with no way out — a JS exception during boot left the canvas
// empty and every tap dead. This module loads FIRST and watches for:
//   1. window.onerror / unhandledrejection storms (5+ errors)
//   2. a stalled boot (app.js must set window.__doomalayReady within 20s)
// and shows a recovery screen with Reload + Reset-app-data actions. The
// engine-side equivalent is the Android watchdog (EngineService restarts
// the Go process if it ever exits).
(function () {
  'use strict';

  var errorCount = 0;
  var overlayShown = false;

  function countError() {
    errorCount++;
    if (errorCount >= 5 && !overlayShown) showRecovery('The app hit repeated errors.');
  }

  window.addEventListener('error', function (e) {
    // Ignore resource hiccups (favicon, network blips) — script errors only.
    if (e && e.target && e.target !== window) return;
    countError();
  });
  window.addEventListener('unhandledrejection', countError);

  // Boot watchdog: app.js flips the flag when the canvas + UI are live.
  setTimeout(function () {
    if (!window.__doomalayReady && !overlayShown) {
      showRecovery('The app did not finish starting.');
    }
  }, 20000);

  function showRecovery(reason) {
    if (overlayShown) return;
    overlayShown = true;
    var el = document.createElement('div');
    el.id = 'doomalay-recovery';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:var(--bg-app);color:var(--text-1);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;' +
      'align-items:center;justify-content:center;padding:24px;';
    el.innerHTML =
      '<div style="max-width:340px;text-align:center">' +
        '<div style="font-size:34px;margin-bottom:12px">🛟</div>' +
        '<h2 style="font-size: calc(var(--ui-fs) + 3px);margin:0 0 6px">Doomalay hit a snag</h2>' +
        '<p style="font-size: calc(var(--ui-small-fs) + 0.5px);color:var(--text-3);margin:0 0 18px;line-height:1.5">' + reason +
        ' Your chats and keys are safe on this device — reload usually fixes it.</p>' +
        '<button id="rc-reload" style="background:var(--border-strong);border:none;color:var(--text-1);padding:10px 18px;' +
        'border-radius:9px;font-size:13.5px;font-family:inherit;cursor:pointer;margin:0 5px">Reload app</button>' +
        '<button id="rc-reset" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:10px 18px;' +
        'border-radius:9px;font-size:13.5px;font-family:inherit;cursor:pointer;margin:0 5px">Reset app data</button>' +
      '</div>';
    document.body ? document.body.appendChild(el) : document.documentElement.appendChild(el);
    document.getElementById('rc-reload').onclick = function () { location.reload(); };
    document.getElementById('rc-reset').onclick = function () {
      try { localStorage.clear(); } catch (e) { /* storage blocked */ }
      location.reload();
    };
  }
})();
