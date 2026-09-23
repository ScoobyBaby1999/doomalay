// lookio.js — v0.52 THE LOOK BUNDLE (user spec item 8).
//
// "Let's add a method to export and import the global settings
//  (everything in the settings panel) as a file type and have the app be
//  able to recognize that formatting and file type, like a ini file or
//  Json file or env file or something, so a user may export their
//  settings, send it via email to their friend, their friend imports
//  that settings and now both their apps look visually the same. This
//  includes custom photos and bump maps the user uses. If the user
//  exports the setting it should contain the images aswell in a bundle
//  I guess so we can have the app port 1:1 settings wise visually."
//
// THE FORMAT: a .doomtheme file is JSON (so it stays human-readable and
// email-friendly) with a magic field:
//
//   { "format": "doomalay-look", "version": 1,
//     "exportedAt": "2026-09-23T…", "app": "doomalay",
//     "scope": "global",            // or "chat" (a single chatbot's look)
//     "state": { …the ENTIRE Settings state… },
//     "chat":  { …the per-chat tweaks blob (scope=chat only)… } }
//
// The images (custom photos, bump maps / textures) are dataURLs INSIDE
// the gradient specs the state already carries — so the bundle ports the
// look 1:1 with zero extra parts. Imports validate the magic + a 24MB
// cap before touching anything; a bad file never harms the running look.
//
// Exposes: window.LookIO = { exportLook, exportChatLook, pickImport,
//                            bundle, BUNDLE_MAGIC }
(function () {
  'use strict';

  var BUNDLE_MAGIC = 'doomalay-look';
  var BUNDLE_VERSION = 1;
  var MAX_BUNDLE_BYTES = 24 * 1024 * 1024;   // dataURL images add up; 24MB is generous

  function nowIso() { return new Date().toISOString(); }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ── the bundle builders ───────────────────────────────────────────
  // bundle() — the global look: the ENTIRE Settings state (theme,
  // themeOverrides with every gradient spec + texture dataURL, chat
  // formatting, sizes, grid colors + effects, font, names).
  function bundle() {
    var st = window.Settings ? window.Settings.getState() : {};
    return {
      format: BUNDLE_MAGIC,
      version: BUNDLE_VERSION,
      app: 'doomalay',
      exportedAt: nowIso(),
      scope: 'global',
      state: JSON.parse(JSON.stringify(st))   // a clean copy
    };
  }

  // bundleChat() — ONE chatbot's look (user spec item 9: "local themes
  // that change just one chatbot… Chatbot themes include everything in
  // the tweaks"): the chat's tweaks blob rides `chat`; the engine-stored
  // background image + bump-map texture bytes are fetched and inlined as
  // dataURLs (`chatBg` / `chatTex`) so the bundle ports the chat 1:1.
  function bundleChat() {
    var b = bundle();
    b.scope = 'chat';
    var tw = {};
    var sid = '';
    try {
      var c = window.ChatPanel && window.ChatPanel.current();
      var state = c && c.state;
      if (state) {
        sid = state.sessionId || '';
        if (state._tweaks) tw = JSON.parse(JSON.stringify(state._tweaks));
      }
    } catch (e) { tw = {}; }
    b.chat = tw;
    b.chatAssets = {};
    if (!sid) return Promise.resolve(b);
    var grabs = [];
    if (tw.bg && tw.bg.type === 'image') {
      grabs.push(fetchBytesAsDataURL('/api/sessions/' + encodeURIComponent(sid) + '/background')
        .then(function (d) { b.chatAssets.background = d; })
        .catch(function () {}));
    }
    if (tw.bg && tw.bg.texRev) {
      grabs.push(fetchBytesAsDataURL('/api/sessions/' + encodeURIComponent(sid) + '/texture')
        .then(function (d) { b.chatAssets.texture = d; })
        .catch(function () {}));
    }
    // v0.52: the custom chat icon rides too — a chat look ports 1:1
    if (tw.iconCustom) {
      grabs.push(fetchBytesAsDataURL('/api/sessions/' + encodeURIComponent(sid) + '/icon')
        .then(function (d) { b.chatAssets.icon = d; })
        .catch(function () {}));
    }
    return Promise.all(grabs).then(function () { return b; });
  }

  // fetchBytesAsDataURL — grab the engine-stored image bytes and re-encode
  // as a dataURL (base64 rides the JSON bundle).
  function fetchBytesAsDataURL(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error('read failed')); };
        fr.readAsDataURL(blob);
      });
    });
  }

  // ── export (download) ─────────────────────────────────────────────
  function stampName(scope) {
    var d = new Date();
    var day = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    var theme = (window.Settings && window.Settings.getState().theme) || 'look';
    return 'doomalay-' + scope + '-' + theme + '-' + day + '.doomtheme';
  }

  function download(obj, scope) {
    var json = JSON.stringify(obj, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = stampName(scope);
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 400);
  }

  function exportLook() {
    download(bundle(), 'global');
    toast('look exported — send the .doomtheme file to a friend');
  }

  function exportChatLook() {
    bundleChat().then(function (b) {
      download(b, 'chat');
      toast('chat look exported as a .doomtheme bundle');
    });
  }

  // ── import ────────────────────────────────────────────────────────
  // parse+validate; resolves {ok, bundle} or {ok:false, why}
  // v0.52 MULTI-BOT TOLERANCE: the interrupted bot's published themes on
  // HF (ScoobyBaby1999/doomalay-themes) carry format "doomalay.settings"
  // with the state under "settings" — both magics and both state keys
  // are accepted so the LIVE library items apply cleanly.
  function validate(text) {
    var b = null;
    try { b = JSON.parse(text); } catch (e) { return { ok: false, why: 'not valid JSON' }; }
    if (!b || typeof b !== 'object') return { ok: false, why: 'not a look bundle' };
    if (b.format !== BUNDLE_MAGIC && b.format !== 'doomalay.settings') {
      return { ok: false, why: 'not a doomalay look (missing the magic field)' };
    }
    if (b.version > BUNDLE_VERSION) return { ok: false, why: 'a newer bundle version — update the app first' };
    var st = b.state || b.settings;
    if (!st || typeof st !== 'object') return { ok: false, why: 'the bundle carries no state' };
    if (!b.state && b.settings) b.state = b.settings;   // normalize
    return { ok: true, bundle: b };
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('no file')); return; }
      if (file.size > MAX_BUNDLE_BYTES) { reject(new Error('too large (24MB cap)')); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('could not read the file')); };
      fr.readAsText(file);
    });
  }

  // applyBundle — global scope: REPLACE the settings state (the whole
  // point: the friend's app now looks 1:1 like the sender's). Names
  // merge-guarded the same way loadState is.
  function applyGlobal(b) {
    var st = JSON.parse(JSON.stringify(b.state));
    if (!Array.isArray(st.names)) delete st.names;
    window.Settings.setState(st);
    if (window.Settings.rerender) window.Settings.rerender();
  }

  // applyChat — chat scope: PUT the image + texture bytes back (fresh
  // revs), re-point the blob's revs, then PUT the tweaks blob and reload
  // the chat's look (ChatTweaks.attach = load + apply).
  function applyChat(b) {
    var tw = b.chat || {};
    var c = window.ChatPanel && window.ChatPanel.current();
    var state = c && c.state;
    if (!state || !state.sessionId) { toast('open a chat first — a chat look lands in the open chatbot'); return Promise.resolve(false); }
    var sid = state.sessionId;
    var assets = b.chatAssets || {};
    var steps = Promise.resolve();

    function putDataURL(url, dataUrl) {
      var m = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''));
      if (!m) return Promise.resolve();
      var raw = atob(m[2]);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return fetch('/api/sessions/' + encodeURIComponent(sid) + url, {
        method: 'PUT',
        headers: { 'Content-Type': m[1] },
        body: bytes
      }).then(function (r) { return r.ok ? r.json() : null; });
    }

    if (assets.background && tw.bg) {
      steps = steps.then(function () {
        return putDataURL('/background', assets.background).then(function (d) {
          if (d && d.rev) tw.bg.rev = d.rev;
        });
      });
    }
    if (assets.texture && tw.bg) {
      steps = steps.then(function () {
        return putDataURL('/texture', assets.texture).then(function (d) {
          if (d && d.rev) tw.bg.texRev = d.rev;
        });
      });
    }
    // v0.52: restore the custom chat icon (fresh rev → blob flags →
    // the live ChatIcon instance + its canvas node repaint)
    if (assets.icon && tw.iconCustom) {
      steps = steps.then(function () {
        return putDataURL('/icon', assets.icon).then(function (d) {
          if (d && d.rev) tw.iconRev = d.rev;
        });
      });
    }

    return steps
      .then(function () {
        return fetch('/api/sessions/' + encodeURIComponent(sid) + '/tweaks', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tw)
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (window.ChatTweaks && window.ChatTweaks.attach) window.ChatTweaks.attach(state);
        // v0.52: the icon flags may have changed (a bundle carrying a
        // custom icon) — repaint the live instance + its canvas node
        try {
          var cc = window.ChatPanel && window.ChatPanel.current();
          var ic = cc && cc.icon;
          if (ic && ic.setCustomIcon && tw.iconCustom && tw.iconRev) {
            ic.setCustomIcon(tw.iconRev);
          }
        } catch (e) { /* the attach reload repaints anyway */ }
        toast('chat look imported — this chatbot now wears the bundle');
        return true;
      })
      .catch(function (e) {
        toast('the chat look import failed: ' + (e.message || e));
        return false;
      });
  }

  function importFile(file) {
    return readFile(file)
      .then(function (text) { return importText(text); })
      .catch(function (e) { toast(e.message || 'the import failed'); return false; });
  }

  // importText(text) — apply a bundle that is ALREADY in hand (the hub's
  // theme downloads hand the payload straight over; no file picker).
  // Same validation + scope routing as a picked file.
  function importText(text) {
    var v = validate(String(text == null ? '' : text));
    if (!v.ok) { toast(v.why); return Promise.resolve(false); }
    var b = v.bundle;
    if (b.scope === 'chat') return applyChat(b);
    applyGlobal(b);
    toast('look imported — your app now wears ' +
      esc((b.state && b.state.theme) || 'the bundle'));
    return Promise.resolve(true);
  }

  // pickImport(scopeHint) — the file input flow (accepts .doomtheme +
  // plain .json bundles; the magic field decides global vs chat).
  function pickImport() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.doomtheme,.json,application/json';
    inp.style.display = 'none';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (f) importFile(f);
      document.body.removeChild(inp);
    });
    document.body.appendChild(inp);
    inp.click();
  }

  // ── toast (the house pattern) ─────────────────────────────────────
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('lookio-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'lookio-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
        'border-radius:10px;font-size:var(--ui-small-fs);z-index:3450;opacity:0;transition:opacity 0.2s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 2400);
  }

  window.LookIO = {
    BUNDLE_MAGIC: BUNDLE_MAGIC,
    bundle: bundle,
    bundleChat: bundleChat,
    exportLook: exportLook,
    exportChatLook: exportChatLook,
    importFile: importFile,
    importText: importText,
    pickImport: pickImport
  };
})();
