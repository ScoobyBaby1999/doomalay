// ota.js — v1.17.4 THE LIVE UPDATE: the PWA-side delta OTA banner
// (PLAN-V117 §v1.17.4). Download only what changed, never the whole APK.
//
// The engine owns the truth: GET /api/ota/status answers one honest state
// out of current | update_available | engine_update_required |
// unreachable | disabled. This module polls on boot + every 5 minutes and
// renders ONE small themed banner when there is something to DO:
//
//   · update_available → "Update available · N files · ~KB" + an Update
//     action → POST /api/ota/download (the button shows a busy state; on
//     ok the banner flips to "applied — reload" and the PWA reloads after
//     800ms — the engine's ota-first static overlay serves the patched
//     bytes on the very next load, no engine restart).
//   · engine_update_required → "full app update needed" + the GitHub
//     releases link (THE ENGINE BINARY IS NEVER HOT-PATCHED — the only
//     path is the full APK; the engine says so itself via min_engine).
//
// Never spam: one banner at a time (a module singleton); when the state
// returns to current the banner clears. The dismiss ✕ hides it for the
// session only (sessionStorage); the persistent opt-out is the localStorage
// flag `doomalay-ota-optout`, checked BEFORE any render. unreachable and
// disabled render nothing (honest states, but not the user's problem to
// act on here — the engine's log already says why).
//
// Theme vars only — zero hardcoded colors. The banner sits at the bottom,
// z-index 2900 — BELOW the ConnectOverlay (3000) and the toast (3450).
//
// Exposes: window.Ota { poll, _render, _fmtKb } + the node module path
// for the v1174 rig (the pure state→banner mapping).
(function () {
  'use strict';

  var OPTOUT_KEY = 'doomalay-ota-optout';   // localStorage — persistent opt-out
  var DISMISS_KEY = 'doomalay-ota-dismissed'; // sessionStorage — this session only
  var RELEASES_URL = 'https://github.com/ScoobyBaby1999/doomalay/releases/latest';
  var POLL_MS = 5 * 60 * 1000;              // the 5-minute heartbeat

  // storage guards (private-mode WebViews throw on access — a banner
  // never takes the app down)
  function lsGet(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function ssGet(k) { try { return window.sessionStorage ? window.sessionStorage.getItem(k) : null; } catch (e) { return null; } }
  function ssSet(k, v) { try { if (window.sessionStorage) window.sessionStorage.setItem(k, v); } catch (e) {} }

  function toast(msg) {
    if (window.DoomToast) { window.DoomToast(msg); return; }
    if (window.Artifacts && window.Artifacts.toast) window.Artifacts.toast(msg);
  }

  // ── the pure half (node-rig testable) ───────────────────────────────

  // _fmtKb renders a byte total for the banner text: 14321 → "~14 KB",
  // 400 → "~0.4 KB", 0 → "~0 KB" (a delta under a KB is still honest —
  // "~0.4 KB" reads better than a bare "0").
  function _fmtKb(bytes) {
    var kb = (bytes || 0) / 1024;
    if (kb >= 10) return '~' + Math.round(kb) + ' KB';
    if (kb >= 1) return '~' + Math.round(kb) + ' KB';
    return '~' + (Math.round(kb * 10) / 10) + ' KB';
  }

  // _render maps an /api/ota/status payload to the banner spec — the
  // PURE state→banner mapping the rig pins:
  //   {show, kind, text, action, dismissible}
  //     kind 'update'  → action 'Update' (POST /api/ota/download)
  //     kind 'engine'  → action 'Get the app update' (the releases link)
  //     kind 'none'    → no banner (current / unreachable / disabled /
  //                      anything malformed — never a lie, never a guess)
  function _render(st) {
    st = st || {};
    var state = st.state;
    if (state === 'update_available') {
      var man = st.manifest || {};
      var n = man.changed || 0;
      var text = 'Update available · ' + n + (n === 1 ? ' file' : ' files') + ' · ' + _fmtKb(man.changed_bytes || 0);
      return { show: true, kind: 'update', text: text, action: 'Update', dismissible: true };
    }
    if (state === 'engine_update_required') {
      return { show: true, kind: 'engine', text: 'full app update needed', action: 'Get the app update', dismissible: true };
    }
    return { show: false, kind: 'none', text: '', action: null, dismissible: false };
  }

  // ── the DOM half ────────────────────────────────────────────────────

  var el = null;      // the singleton banner (one at a time — never spam)
  var busy = false;   // a download is in flight — don't touch the banner
  var lastKey = '';   // the currently shown banner's identity (kind+text)

  function ensureEl() {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.id = 'doomalay-ota-banner';
    el.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);' +
      'max-width:calc(100vw - 28px);box-sizing:border-box;display:none;align-items:center;gap:10px;' +
      'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);' +
      'padding:8px 8px 8px 14px;border-radius:12px;font-size:var(--ui-small-fs);z-index:2900;';
    var txt = document.createElement('span');
    txt.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    txt.id = 'doomalay-ota-banner-text';
    var act = document.createElement('button');
    act.id = 'doomalay-ota-banner-action';
    act.style.cssText = 'flex:none;background:rgba(var(--accent-rgb),0.14);color:var(--accent);' +
      'border:1px solid rgba(var(--accent-rgb),0.32);border-radius:9px;padding:7px 12px;' +
      'font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation';
    act.setAttribute('aria-label', 'apply the update');
    var x = document.createElement('button');
    x.id = 'doomalay-ota-banner-dismiss';
    x.textContent = '✕';
    x.style.cssText = 'flex:none;background:none;color:var(--text-3);border:none;' +
      'padding:7px 8px;font-size:var(--ui-small-fs);cursor:pointer;touch-action:manipulation';
    x.setAttribute('aria-label', 'dismiss the update banner');
    el.appendChild(txt); el.appendChild(act); el.appendChild(x);
    document.body.appendChild(el);
    return el;
  }

  function hideBanner() {
    if (el) el.style.display = 'none';
    lastKey = '';
  }

  function render(spec) {
    var e = ensureEl();
    var txt = e.querySelector('#doomalay-ota-banner-text');
    var act = e.querySelector('#doomalay-ota-banner-action');
    var x = e.querySelector('#doomalay-ota-banner-dismiss');
    txt.textContent = spec.text;
    act.textContent = spec.action;
    act.disabled = false;
    act.style.display = '';
    x.style.display = spec.dismissible ? '' : 'none';
    e.style.display = 'flex';
    e.dataset.kind = spec.kind;
    lastKey = spec.kind + '|' + spec.text;
  }

  // ── the actions ─────────────────────────────────────────────────────

  function onAction(kind) {
    if (busy) return;
    if (kind === 'engine') {
      // The external-link pattern (chatpanel's window.open — the same
      // way the PWA opens every external URL).
      window.open(RELEASES_URL, '_blank');
      return;
    }
    // kind === 'update' — POST /api/ota/download with a busy button.
    busy = true;
    var act = el ? el.querySelector('#doomalay-ota-banner-action') : null;
    var txt = el ? el.querySelector('#doomalay-ota-banner-text') : null;
    if (act) { act.disabled = true; act.textContent = 'updating…'; }
    fetch('/api/ota/download', { method: 'POST' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (res) {
        if (res && res.ok) {
          // APPLIED — the overlay is already serving the new bytes; flip
          // the banner and reload so the WebView picks them up.
          if (txt) txt.textContent = 'applied — reload';
          if (act) act.style.display = 'none';
          if (el) el.querySelector('#doomalay-ota-banner-dismiss').style.display = 'none';
          setTimeout(function () { window.location.reload(); }, 800);
        } else {
          busy = false;
          if (act) { act.disabled = false; act.textContent = 'Update'; }
          toast('update failed — ' + ((res && res.error) || 'the engine could not apply it'));
        }
      });
    }).catch(function () {
      busy = false;
      if (act) { act.disabled = false; act.textContent = 'Update'; }
      toast('update failed — the engine is unreachable');
    });
  }

  function onDismiss() {
    ssSet(DISMISS_KEY, '1');
    hideBanner();
  }

  // ── the poll loop ───────────────────────────────────────────────────

  function apply(st) {
    if (lsGet(OPTOUT_KEY)) return;               // persistent opt-out — checked before rendering
    var spec = _render(st);
    if (!spec.show) {
      // state returned to current (or an honest non-actionable state):
      // the banner clears, and a session-dismiss is forgiven so the
      // NEXT update can announce itself.
      hideBanner();
      if (ssGet(DISMISS_KEY)) ssSet(DISMISS_KEY, '');
      return;
    }
    if (ssGet(DISMISS_KEY)) return;              // dismissed this session
    if (busy) return;                            // a download is in flight — never re-render under it
    var key = spec.kind + '|' + spec.text;
    if (key === lastKey && el && el.style.display !== 'none') return; // same banner — never spam
    render(spec);
  }

  function poll() {
    return fetch('/api/ota/status').then(function (r) {
      return r.json().catch(function () { return null; }).then(function (st) {
        if (st) apply(st);
        // a malformed/failed poll renders nothing — honest silence, the
        // next 5-minute tick retries
      });
    }).catch(function () { /* the engine is unreachable — not an OTA state */ });
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    poll();
    setInterval(poll, POLL_MS); // the 5-minute heartbeat
  }

  // ── exports ─────────────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    window.Ota = { poll: poll, _render: _render, _fmtKb: _fmtKb };
    // Boot: this script rides at the very END of index.html's script list
    // (after app.js) — the body exists; the banner DOM is lazy anyway.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  } else if (typeof module !== 'undefined' && module.exports) {
    // the node rig path (scripts/v1174-ota-test.js) — the pure mapping only
    module.exports = { _render: _render, _fmtKb: _fmtKb };
  }
})();
