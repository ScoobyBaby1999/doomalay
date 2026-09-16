// persona.js — v0.19 the per-chat PERSONA system.
//
// USER SPEC:
//   "Have a new pill in the header of every chat labeled persona, opening
//    it should open up the editor panel for that chat's own persona. So
//    whatever our default prompt currently is for the chatbots should act
//    as the default persona. A user can then change it whenever they want
//    to something else. In the persona, allow for the chatbot to know its
//    own identity. Do so by telling the chatbot what model it is. A user
//    may download, save, and alter any chatbot's persona and have that
//    chatbot act differently — this may be done using our editor."
//
// HOW IT WORKS:
//   • Every chat's persona lives on its engine session (persona column).
//     Empty persona = the app's DEFAULT prompt (the prefill below).
//   • The engine composes the system message EVERY turn as:
//       [identity: "You are <model> via <provider>. Today is <date>."]
//       + [persona | default]
//       + [artifact protocol, if the persona doesn't carry it]
//     The identity line is ALWAYS fresh — switching models mid-convo
//     instantly changes who the bot believes it is. The stored persona
//     never goes stale.
//   • The editor (this module) reuses the artifacts-editor pattern:
//     full-screen overlay, CodeMirror (markdown mode), save (PATCH),
//     download (.md file), reset-to-default, Android-safe unsaved guard.
//
// Exposes: window.Persona = { open, close, DEFAULT_PERSONA, isOpen }
(function () {
  'use strict';

  // The DEFAULT persona (v0.20) = the app's default prompt MERGED with the
  // old HF space's system-prompt style (direct/concise, explicit model
  // identity, tool discipline). {model} and {provider} are placeholders —
  // the engine substitutes the live values into EVERY turn (client-side
  // for PrivateMode turns), so the persona keeps working after model
  // switches and users can reference them in their own personas.
  var DEFAULT_PERSONA =
    '## Identity\n' +
    'You are {model} (served via {provider}), chatting inside the Doomalay app on the user\'s own device. ' +
    'If the user asks which model you are, tell them exactly that — never guess and never claim to be a different model. ' +
    'This identity updates automatically when the user switches your model mid-conversation; trust it over any prior assumption.\n\n' +
    '## Style\n' +
    'Be direct and concise; lead with the outcome, not the process. ' +
    'Use markdown freely — headings, lists, bold, links and fenced code blocks all render nicely in this app. ' +
    'When a live fact matters and web search is enabled, search rather than guess. ' +
    'When you don\'t know something, say so.\n\n' +
    '## Tools\n' +
    'When the app\'s tool protocol is active, invoke tools ONLY through the protocol\'s ACTION line format — never as plain text. ' +
    'Cite search sources inline as [1], [2] matching the result numbering, and never fabricate URLs.\n\n' +
    '## Artifacts\n' +
    'You are chatting inside the Doomalay app, which has an artifact system.\n' +
    'When the user asks for a file, document, dataset, or any standalone deliverable — or when you produce a substantial complete artifact-like output — attach it as an ARTIFACT in addition to (or instead of) your normal answer.\n' +
    'Artifact format (a fenced code block whose info string starts with "artifact"):\n' +
    '  ```artifact file=<filename.ext>\n  <the complete file content as plain text>\n  ```\n' +
    'For binary file types (e.g. .docx, .xlsx, .pdf, .zip, images) provide the bytes base64-encoded instead:\n' +
    '  ```artifact file=<filename> encoding=base64\n  <base64 payload>\n  ```\n' +
    'Rules:\n' +
    '- Prefer text formats when the user has no strong preference (.md, .txt, .json, .csv, .html, code files, config files).\n' +
    '- Use a real, descriptive filename with the correct extension.\n' +
    '- The artifact block must contain the COMPLETE file, never truncated.\n' +
    '- Keep the spoken answer short and mention the attached file name.\n' +
    '- Regular markdown (headings, lists, bold, links, code blocks) is rendered nicely — use it freely.';

  var overlayEl = null;
  var cm = null;
  var dirty = false;
  var current = null; // { sessionId, name, model, provider }
  var saveTimer = null;

  // lazy loaders (same pattern as artifacts.js)
  var loaded = {};
  function ensureScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { delete loaded[src]; reject(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  function ensureCSS(href) {
    if (loaded[href]) return loaded[href];
    loaded[href] = new Promise(function (resolve) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = resolve; l.onerror = resolve;
      document.head.appendChild(l);
    });
    return loaded[href];
  }

  // v0.18 lesson: resized WebViews leave CodeMirror at stale metrics.
  window.addEventListener('resize', function () {
    if (cm && cm.refresh) { try { cm.refresh(); } catch (e) {} }
  });

  function isOpen() {
    return !!(overlayEl && overlayEl.style.display !== 'none' && overlayEl.classList.contains('open'));
  }

  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'persona-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;z-index:3200;display:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function openOverlay(html) {
    var el = ensureOverlay();
    el.innerHTML = html;
    el.style.display = 'block';
    el._openedAt = performance.now();
    requestAnimationFrame(function () { el.classList.add('open'); });
    return el;
  }
  function closeOverlay() {
    if (!overlayEl) return;
    cm = null;
    overlayEl.classList.remove('open');
    var el = overlayEl;
    setTimeout(function () {
      if (!el.classList.contains('open')) { el.style.display = 'none'; el.innerHTML = ''; }
    }, 240);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }

  // ── THE EDITOR ───────────────────────────────────────────────────
  function open(sessionId, opts) {
    if (!sessionId) return;
    current = {
      sessionId: sessionId,
      name: (opts && opts.name) || 'chat',
      model: (opts && opts.model) || '',
      provider: (opts && opts.provider) || ''
    };
    dirty = false;
    cm = null;

    var html =
      '<div class="art-scrim"></div>' +
      '<div class="art-panel art-panel-editor">' +
        '<div class="art-head">' +
          '<button class="art-back" id="pe-back">‹</button>' +
          '<span class="art-title">persona</span>' +
          '<span class="art-count" id="pe-meta">…</span>' +
          '<button class="art-close" id="pe-close">✕</button>' +
        '</div>' +
        '<div class="art-ed-actions">' +
          '<button id="pe-save" class="art-ed-btn" disabled>save</button>' +
          '<button id="pe-reset" class="art-ed-btn">↺ default</button>' +
          '<button id="pe-dl" class="art-ed-btn">⇩ download</button>' +
        '</div>' +
        '<div class="pe-identity" id="pe-identity"></div>' +
        '<div class="art-ed-body" id="pe-body"><div class="art-loading">loading persona…</div></div>' +
        '<div class="art-unsaved" id="pe-unsaved">' +
          '<span class="art-unsaved-text">unsaved changes</span>' +
          '<button class="art-unsaved-discard" id="pe-unsaved-discard">discard</button>' +
          '<button class="art-unsaved-stay" id="pe-unsaved-stay">keep editing</button>' +
        '</div>' +
      '</div>';
    var root = openOverlay(html);

    var metaEl = root.querySelector('#pe-meta');
    var saveBtn = root.querySelector('#pe-save');
    var unsavedEl = root.querySelector('#pe-unsaved');
    var identityEl = root.querySelector('#pe-identity');
    var pendingExit = null;

    // the identity strip: what the engine prepends EVERY turn (live).
    // v0.20: {model}/{provider} are LIVE placeholders — substituted into
    // every turn with the chat's current model + provider.
    var pretty = String(current.model || '').split('/').pop();
    identityEl.innerHTML =
      '<span class="pe-identity-k">always active</span>' +
      '<span class="pe-identity-v" id="pe-identity-v">You are ' + esc(pretty || '…') +
      (current.provider ? (', hosted via ' + esc(current.provider)) : '') +
      ' · Doomalay app · [today\'s date]</span>' +
      '<span class="pe-identity-hint">{model} and {provider} in the text below are live — they always resolve to this chat\'s current model + provider.</span>';

    function hideUnsaved() {
      pendingExit = null;
      if (unsavedEl) unsavedEl.classList.remove('show');
    }
    function guard() {
      if (!dirty) return true;
      pendingExit = 'close';
      if (unsavedEl) {
        unsavedEl.classList.add('show');
        var d = unsavedEl.querySelector('.art-unsaved-discard');
        if (d) d.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      return false;
    }

    // close paths (all guarded by unsaved changes)
    var scrim = root.querySelector('.art-scrim');
    if (scrim) scrim.addEventListener('click', function (e) {
      if (e.target !== scrim) return;
      if (performance.now() - (overlayEl._openedAt || 0) < 400) return; // ghost tap
      if (guard()) closeOverlay();
    });
    var x = root.querySelector('#pe-close');
    if (x) x.addEventListener('click', function () {
      if (performance.now() - (overlayEl._openedAt || 0) < 400) return;
      if (guard()) closeOverlay();
    });
    var back = root.querySelector('#pe-back');
    if (back) back.addEventListener('click', function () {
      if (performance.now() - (overlayEl._openedAt || 0) < 400) return;
      if (guard()) closeOverlay();
    });
    var discard = root.querySelector('#pe-unsaved-discard');
    if (discard) discard.addEventListener('click', function () {
      hideUnsaved();
      dirty = false;
      closeOverlay();
    });
    var stay = root.querySelector('#pe-unsaved-stay');
    if (stay) stay.addEventListener('click', hideUnsaved);

    function markDirty() {
      dirty = true;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.add('dirty'); }
    }
    function markClean(label) {
      dirty = false;
      if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.remove('dirty'); }
      if (label && metaEl) metaEl.textContent = label;
    }

    // Load the current persona (empty → the default prefill).
    fetch('/api/sessions/' + sessionId).then(function (r) { return r.json(); }).then(function (sess) {
      if (!root.isConnected) return;
      var persona = (sess && sess.Persona) || '';
      var usingDefault = !persona.trim();
      var text = usingDefault ? DEFAULT_PERSONA : persona;
      if (metaEl) metaEl.textContent = usingDefault ? 'default' : 'custom';

      // CodeMirror with the markdown mode (the artifacts-editor stack).
      var coreP = ensureCSS('/vendor/editor/codemirror.css')
        .then(function () { return ensureScript('/vendor/editor/codemirror.min.js'); })
        .then(function () { return ensureScript('/vendor/editor/mode-markdown.min.js'); });
      coreP.then(function () {
        var bodyEl = root.querySelector('#pe-body');
        if (!bodyEl || !window.CodeMirror) return;
        bodyEl.innerHTML = '';
        var host = document.createElement('div');
        host.className = 'art-cm-host';
        bodyEl.appendChild(host);
        cm = CodeMirror(host, {
          value: text,
          mode: 'markdown',
          lineNumbers: true,
          lineWrapping: true,
          theme: 'doomalay',
          viewportMargin: 60
        });
        cm.on('change', function () {
          if (!saveBtn.disabled) return;
          markDirty();
        });
        cm.refresh();
      }).catch(function (e) {
        var bodyEl = root.querySelector('#pe-body');
        if (bodyEl) bodyEl.innerHTML = '<div class="art-loading">editor failed to load — ' + esc(String(e.message || e)) + '</div>';
      });
    }).catch(function (e) {
      var bodyEl = root.querySelector('#pe-body');
      if (bodyEl) bodyEl.innerHTML = '<div class="art-loading">could not load the session — ' + esc(String(e.message || e)) + '</div>';
    });

    // SAVE → PATCH the session's persona.
    if (saveBtn) saveBtn.addEventListener('click', function () {
      if (!cm || !current) return;
      var text = cm.getValue();
      saveBtn.textContent = 'saving…';
      fetch('/api/sessions/' + current.sessionId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: text })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        markClean(text.trim() && text.trim() !== DEFAULT_PERSONA.trim() ? 'custom · saved' : 'default · saved');
        saveBtn.textContent = 'save';
        toast('persona saved');
        // tell the open chats (PM turns compose the system message
        // client-side — they need the fresh text).
        try {
          window.dispatchEvent(new CustomEvent('doomalay:persona-saved', {
            detail: { sessionId: current.sessionId, persona: text }
          }));
        } catch (e) {}
      }).catch(function (e) {
        saveBtn.textContent = 'save';
        toast('save failed — ' + (e.message || e));
      });
    });

    // RESET → back to the default persona.
    var resetBtn = root.querySelector('#pe-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (!cm) return;
      cm.setValue(DEFAULT_PERSONA);
      markDirty();
      if (metaEl) metaEl.textContent = 'default (unsaved)';
    });

    // DOWNLOAD the persona as a .md file (works from the editor text).
    var dlBtn = root.querySelector('#pe-dl');
    if (dlBtn) dlBtn.addEventListener('click', function () {
      var text = cm ? cm.getValue() : DEFAULT_PERSONA;
      var safe = (current.name || 'chat').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      var blob = new Blob([text], { type: 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = safe + '-persona.md';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        a.remove();
      }, 400);
    });
  }

  // Android back support: app.js handleBack calls this. Returns false when
  // the unsaved guard blocked the close.
  function backClose() {
    if (!isOpen()) return 'closed';
    var unsavedEl = overlayEl.querySelector('#pe-unsaved');
    if (dirty) {
      if (unsavedEl) {
        unsavedEl.classList.add('show');
        var d = unsavedEl.querySelector('.art-unsaved-discard');
        if (d) d.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      return false;
    }
    closeOverlay();
    return 'closed';
  }

  // tiny toast (mirrors artifacts.js)
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('persona-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'persona-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
        'border-radius:10px;font-size: var(--ui-small-fs);z-index:3400;opacity:0;transition:opacity 0.2s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1600);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  window.Persona = {
    open: open,
    close: function () { closeOverlay(); },
    backClose: backClose,
    isOpen: isOpen,
    DEFAULT_PERSONA: DEFAULT_PERSONA
  };
})();
